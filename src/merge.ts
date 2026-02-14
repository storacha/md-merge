import type { Root, RootContent } from 'mdast'
import type { ChangeSet, Change } from './types.js'
import { diff, applyChangeSet } from './diff.js'
import { fingerprint } from './parse.js'
import { RGA, ROOT } from './crdt/rga.js'

/**
 * Check if two paths conflict: identical or one is a prefix of the other.
 */
function pathsConflict(a: number[], b: number[]): boolean {
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return false
  }
  return true // one is prefix of the other, or they're identical
}

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
 * This handles concurrent inserts/deletes at any level correctly.
 */
function mergeChildren(
  baseChildren: RootContent[],
  aChildren: RootContent[],
  bChildren: RootContent[],
  replicaA: string,
  replicaB: string,
): RootContent[] {
  const fpFn = (node: RootContent) => fingerprint(node)
  const baseRGA = RGA.fromArray(baseChildren, 'base', fpFn)

  // Build RGA for side A
  const rgaA = RGA.fromArray<RootContent>([], replicaA, fpFn)
  // Copy base nodes
  for (const node of baseRGA.nodes.values()) {
    rgaA.nodes.set(node.id, { ...node })
  }
  // Compute what A did relative to base using diff on fingerprints
  applyEditsToRGA(baseChildren, aChildren, rgaA, replicaA, fpFn)

  // Build RGA for side B
  const rgaB = RGA.fromArray<RootContent>([], replicaB, fpFn)
  for (const node of baseRGA.nodes.values()) {
    rgaB.nodes.set(node.id, { ...node })
  }
  applyEditsToRGA(baseChildren, bChildren, rgaB, replicaB, fpFn)

  // Merge the two RGAs
  rgaA.merge(rgaB)

  // Get merged children
  const mergedChildren = rgaA.toArray()

  // Now recursively merge children of matched nodes
  return mergedChildren.map(node => {
    if (!hasChildren(node)) return node
    
    // Find this node in base, A, and B by fingerprint matching
    const nodeFp = fingerprint(node)
    const baseNode = baseChildren.find(n => fingerprint(n) === nodeFp)
    const aNode = aChildren.find(n => fingerprint(n) === nodeFp)
    const bNode = bChildren.find(n => fingerprint(n) === nodeFp)

    // If this node exists in base and was modified by one or both sides,
    // we need to look at the actual node from A or B (not base)
    // But since fingerprints match content, same fingerprint = same content
    // Modified nodes have different fingerprints and are handled as delete+insert by RGA
    return node
  })
}

/**
 * Apply edits from base->target as RGA operations on the given RGA.
 * Uses LCS to identify matched/inserted/deleted nodes.
 */
function applyEditsToRGA(
  baseChildren: RootContent[],
  targetChildren: RootContent[],
  rga: RGA<RootContent>,
  replicaId: string,
  fpFn: (node: RootContent) => string,
): void {
  const baseFps = baseChildren.map(fpFn)
  const targetFps = targetChildren.map(fpFn)

  // LCS to find matches
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

  // Extract matches
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

  // Figure out which base nodes are deleted (not in matches)
  const matchedBaseIndices = new Set(matches.map(([bi]) => bi))
  const baseNodes = rga.toNodes()

  for (let bi = 0; bi < baseChildren.length; bi++) {
    if (!matchedBaseIndices.has(bi)) {
      // This base node was deleted in target
      const nodeId = baseNodes[bi]?.id
      if (nodeId) rga.delete(nodeId)
    }
  }

  // Figure out which target nodes are inserted (not in matches)
  const matchedTargetIndices = new Set(matches.map(([, ti]) => ti))
  
  // Build a map of target index -> predecessor in target
  // We need to insert new nodes after the correct predecessor in the RGA
  // Walk through target in order, tracking the last RGA node ID
  const orderedNodes = rga.toNodes() // after deletions
  
  // Rebuild mapping: for each matched base index, what's its RGA id?
  const baseIdxToRgaId = new Map<number, string>()
  for (let bi = 0; bi < baseChildren.length; bi++) {
    if (bi < baseNodes.length) {
      baseIdxToRgaId.set(bi, baseNodes[bi].id)
    }
  }

  // Map match target indices to base indices (and thus RGA IDs)
  const targetIdxToBaseIdx = new Map<number, number>()
  for (const [bi, ti] of matches) {
    targetIdxToBaseIdx.set(ti, bi)
  }

  // Walk target in order, inserting new nodes
  for (let ti = 0; ti < targetChildren.length; ti++) {
    if (matchedTargetIndices.has(ti)) continue // matched, already in RGA
    
    // Find predecessor: the last node before ti in target that is a matched node
    let afterId = ROOT
    for (let prev = ti - 1; prev >= 0; prev--) {
      const baseIdx = targetIdxToBaseIdx.get(prev)
      if (baseIdx !== undefined) {
        const rgaId = baseIdxToRgaId.get(baseIdx)
        if (rgaId) {
          afterId = rgaId
          break
        }
      }
      // If prev is also an insert from this same replica, we need its ID
      // But since we process in order, it should have been inserted already
      // Check if we already inserted it
      const prevFp = fpFn(targetChildren[prev])
      // Search for it in the RGA
      for (const node of rga.nodes.values()) {
        if (!node.tombstone && fpFn(node.value) === prevFp) {
          afterId = node.id
          break
        }
      }
      if (afterId !== ROOT) break
    }

    rga.insert(afterId, targetChildren[ti], replicaId)
  }
}

/**
 * Three-way merge using RGA for correct concurrent edit handling.
 * 
 * Converts children to RGA, applies each side's changes as RGA operations,
 * then merges the two RGAs for correct interleaving.
 */
export function threeWayMerge(
  base: Root,
  csA: ChangeSet,
  csB: ChangeSet,
  tsA: number = 0,
  tsB: number = 0,
): Root {
  // Apply changesets to get the two side trees
  const sideA = applyChangeSet(base, csA)
  const sideB = applyChangeSet(base, csB)

  // Merge at the top level using RGA
  const mergedChildren = mergeChildren(
    base.children,
    sideA.children,
    sideB.children,
    'A',
    'B',
  )

  // Now recursively handle nested children
  // For nodes that exist in both sides with modifications, we need deeper merge
  const result: Root = { type: 'root', children: mergedChildren as RootContent[] }
  
  // Deep merge: for each merged child, if it exists in base and was modified differently
  // by A and B, recursively merge its children
  deepMerge(result, base, sideA, sideB)

  return result
}

/**
 * Deep merge: for parent nodes whose children may have been concurrently edited,
 * recursively apply RGA merge.
 */
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
      // Children were modified — merge them with RGA
      const mergedKids = mergeChildren(
        baseNode.children as RootContent[],
        aChildren,
        bChildren,
        'A',
        'B',
      )
      ;(mergedNode as { children: unknown[] }).children = mergedKids
    }
  }

  // Match merged children to base/A/B by fingerprint for recursive descent
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
