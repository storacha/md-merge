import type { Root, RootContent } from 'mdast'
import type { ChangeSet, Change } from './types.js'
import { diff, applyChangeSet } from './diff.js'
import { fingerprint } from './parse.js'
import { RGA, type RGANodeId, type RGAEvent, type EventComparator } from './crdt/rga.js'

/** Simple string event for merge operations */
class MergeEvent implements RGAEvent {
  constructor(readonly name: string) {}
  toString(): string { return this.name }
}

const compareMergeEvents: EventComparator<MergeEvent> = (a, b) => {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

const BASE_EVENT = new MergeEvent('base')
const EVENT_A = new MergeEvent('A')
const EVENT_B = new MergeEvent('B')

/** Check if a node has children */
function hasChildren(node: unknown): node is { type: string; children: unknown[] } {
  return (
    node != null &&
    typeof node === 'object' &&
    'children' in node &&
    Array.isArray((node as Record<string, unknown>).children)
  )
}

/**
 * Recursively merge two trees against a common base using RGA for children ordering.
 */
function mergeChildren(
  baseChildren: RootContent[],
  aChildren: RootContent[],
  bChildren: RootContent[],
): RootContent[] {
  const fpFn = (node: RootContent) => fingerprint(node)
  const baseRGA = RGA.fromArray(baseChildren, BASE_EVENT, fpFn, compareMergeEvents)

  const rgaA = new RGA<RootContent, MergeEvent>(fpFn, compareMergeEvents)
  for (const [key, node] of baseRGA.nodes) {
    rgaA.nodes.set(key, { ...node })
  }
  applyEditsToRGA(baseChildren, aChildren, rgaA, EVENT_A, fpFn)

  const rgaB = new RGA<RootContent, MergeEvent>(fpFn, compareMergeEvents)
  for (const [key, node] of baseRGA.nodes) {
    rgaB.nodes.set(key, { ...node })
  }
  applyEditsToRGA(baseChildren, bChildren, rgaB, EVENT_B, fpFn)

  rgaA.merge(rgaB)
  return rgaA.toArray()
}

/**
 * Apply edits from base->target as RGA operations.
 */
function applyEditsToRGA(
  baseChildren: RootContent[],
  targetChildren: RootContent[],
  rga: RGA<RootContent, MergeEvent>,
  event: MergeEvent,
  fpFn: (node: RootContent) => string,
): void {
  const baseFps = baseChildren.map(fpFn)
  const targetFps = targetChildren.map(fpFn)

  const m = baseFps.length
  const n = targetFps.length
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseFps[i - 1] === targetFps[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1])
      }
    }
  }

  const matches: Array<[number, number]> = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (baseFps[i - 1] === targetFps[j - 1]) {
      matches.push([i - 1, j - 1])
      i--; j--
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  matches.reverse()

  const matchedBaseIndices = new Set(matches.map(([bi]) => bi))
  const baseNodes = rga.toNodes()
  for (let bi = 0; bi < baseChildren.length; bi++) {
    if (!matchedBaseIndices.has(bi)) {
      const nodeId = baseNodes[bi]?.id
      if (nodeId) rga.delete(nodeId)
    }
  }

  const matchedTargetIndices = new Set(matches.map(([, ti]) => ti))

  const baseIdxToRgaId = new Map<number, RGANodeId<MergeEvent>>()
  for (let bi = 0; bi < baseChildren.length; bi++) {
    if (bi < baseNodes.length) {
      baseIdxToRgaId.set(bi, baseNodes[bi].id)
    }
  }

  const targetIdxToBaseIdx = new Map<number, number>()
  for (const [bi, ti] of matches) {
    targetIdxToBaseIdx.set(ti, bi)
  }

  for (let ti = 0; ti < targetChildren.length; ti++) {
    if (matchedTargetIndices.has(ti)) continue

    let afterId: RGANodeId<MergeEvent> | undefined = undefined
    for (let prev = ti - 1; prev >= 0; prev--) {
      const baseIdx = targetIdxToBaseIdx.get(prev)
      if (baseIdx !== undefined) {
        const rgaId = baseIdxToRgaId.get(baseIdx)
        if (rgaId) { afterId = rgaId; break }
      }
      const prevFp = fpFn(targetChildren[prev])
      for (const node of rga.nodes.values()) {
        if (!node.tombstone && fpFn(node.value) === prevFp) {
          afterId = node.id; break
        }
      }
      if (afterId !== undefined) break
    }

    rga.insert(afterId, targetChildren[ti], event)
  }
}

/**
 * Three-way merge using RGA for correct concurrent edit handling.
 */
export function threeWayMerge(
  base: Root,
  csA: ChangeSet,
  csB: ChangeSet,
  tsA: number = 0,
  tsB: number = 0,
): Root {
  const sideA = applyChangeSet(base, csA)
  const sideB = applyChangeSet(base, csB)

  const mergedChildren = mergeChildren(
    base.children,
    sideA.children,
    sideB.children,
  )

  const result: Root = { type: 'root', children: mergedChildren as RootContent[] }
  deepMerge(result, base, sideA, sideB)
  return result
}

function deepMerge(merged: Root, base: Root, sideA: Root, sideB: Root): void {
  const fpFn = (node: RootContent) => fingerprint(node)

  function mergeNode(mergedNode: RootContent, baseNode: RootContent | undefined, aNode: RootContent | undefined, bNode: RootContent | undefined): void {
    if (!hasChildren(mergedNode)) return
    if (!baseNode || !hasChildren(baseNode)) return

    const aChildren = aNode && hasChildren(aNode) ? aNode.children as RootContent[] : baseNode.children as RootContent[]
    const bChildren = bNode && hasChildren(bNode) ? bNode.children as RootContent[] : baseNode.children as RootContent[]

    const baseFp = (baseNode.children as RootContent[]).map(fpFn).join('|')
    const aFp = aChildren.map(fpFn).join('|')
    const bFp = bChildren.map(fpFn).join('|')

    if (aFp !== baseFp || bFp !== baseFp) {
      const mergedKids = mergeChildren(
        baseNode.children as RootContent[],
        aChildren,
        bChildren,
      )
      ;(mergedNode as { children: unknown[] }).children = mergedKids
    }
  }

  for (const child of merged.children) {
    if (!hasChildren(child)) continue
    const fp = fpFn(child)
    const baseChild = base.children.find(c => fpFn(c) === fp)
    const aChild = sideA.children.find(c => fpFn(c) === fp)
    const bChild = sideB.children.find(c => fpFn(c) === fp)
    if (baseChild) {
      mergeNode(child, baseChild, aChild || baseChild, bChild || baseChild)
    }
  }
}

/**
 * Merge multiple concurrent changesets against a common base.
 */
export function mergeMultiple(
  base: Root,
  changesets: Array<{ cs: ChangeSet; ts: number }>,
): Root {
  if (changesets.length === 0) return base
  if (changesets.length === 1) return applyChangeSet(base, changesets[0].cs)

  const sorted = [...changesets].sort((a, b) => a.ts - b.ts)
  let result = base
  for (const { cs } of sorted) {
    result = applyChangeSet(result, cs)
  }
  return result
}
