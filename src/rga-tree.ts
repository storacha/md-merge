/**
 * RGA-backed mdast tree.
 *
 * Every ordered `children` array in the mdast tree is replaced with an RGA,
 * giving us CRDT merge semantics at every level.
 */

import type {
  Root, RootContent, Parent, Node,
} from 'mdast'
import { RGA, type RGANodeId, type RGAEvent, type EventComparator } from './crdt/rga.js'
import { fingerprint } from './parse.js'
import { diff as mdastDiff } from './diff.js'
import type { Change } from './types.js'

// ---- RGA Tree Node Types ----

export type RGATreeNode<E extends RGAEvent = RGAEvent> = RGAParentNode<E> | RGALeafNode

export type RGALeafNode = Exclude<RootContent, Parent>

export interface RGAParentNode<E extends RGAEvent = RGAEvent> {
  type: string
  children: RGA<RGATreeNode<E>, E>
  [key: string]: unknown
}

export interface RGATreeRoot<E extends RGAEvent = RGAEvent> {
  type: 'root'
  children: RGA<RGATreeNode<E>, E>
}

// ---- Helpers ----

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray((node as Parent).children)
}

function fpNode<E extends RGAEvent>(node: RGATreeNode<E>): string {
  if (isRGAParent(node)) {
    const { children, ...rest } = node
    return JSON.stringify(rest)
  }
  return fingerprint(node as RootContent)
}

function isRGAParent<E extends RGAEvent>(node: RGATreeNode<E>): node is RGAParentNode<E> {
  return 'children' in node && node.children instanceof RGA
}

// ---- Conversion: mdast → RGA Tree ----

export function toRGATree<E extends RGAEvent>(root: Root, event: E, compareEvents: EventComparator<E>): RGATreeRoot<E> {
  return {
    type: 'root',
    children: childrenToRGA(root.children as Node[], event, compareEvents),
  }
}

function childrenToRGA<E extends RGAEvent>(children: Node[], event: E, compareEvents: EventComparator<E>): RGA<RGATreeNode<E>, E> {
  const converted: RGATreeNode<E>[] = children.map(child => convertNode(child, event, compareEvents))
  return RGA.fromArray(converted, event, (n: RGATreeNode<E>) => fpNode(n), compareEvents)
}

function convertNode<E extends RGAEvent>(node: Node, event: E, compareEvents: EventComparator<E>): RGATreeNode<E> {
  if (!isParent(node)) {
    return node as RGALeafNode
  }
  const { children, ...rest } = node as Parent & Record<string, unknown>
  return {
    ...rest,
    children: childrenToRGA(children as Node[], event, compareEvents),
  } as RGAParentNode<E>
}

// ---- Conversion: RGA Tree → mdast ----

export function toMdast<E extends RGAEvent>(rgaRoot: RGATreeRoot<E>): Root {
  return {
    type: 'root',
    children: rgaToChildren(rgaRoot.children) as RootContent[],
  }
}

function rgaToChildren<E extends RGAEvent>(rga: RGA<RGATreeNode<E>, E>): Node[] {
  return rga.toArray().map(revertNode)
}

function revertNode<E extends RGAEvent>(node: RGATreeNode<E>): Node {
  if (!isRGAParent(node)) {
    return node as Node
  }
  const { children, ...rest } = node
  return {
    ...rest,
    children: rgaToChildren(children),
  } as Node
}

// ---- Apply new mdast to existing RGA tree ----

/**
 * Apply a new mdast document to an existing RGA tree, preserving existing
 * RGA node IDs where nodes haven't changed.
 *
 * 1. Serialize existing RGA tree back to plain mdast
 * 2. Diff old mdast vs new mdast to get index-based changes
 * 3. Map index-based changes to RGA operations using idAtIndex
 * 4. Apply operations to produce updated RGA tree
 */
export function applyMdast<E extends RGAEvent>(
  existing: RGATreeRoot<E>,
  newRoot: Root,
  event: E,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  const oldMdast = toMdast(existing)
  const changeset = mdastDiff(oldMdast, newRoot)

  // Clone the existing RGA tree (deep copy of the root children RGA)
  const updatedChildren = cloneRGA(existing.children)

  // Apply changes at depth, grouped by their parent path
  applyChangesAtDepth(updatedChildren, changeset.changes, [], event, compareEvents)

  return { type: 'root', children: updatedChildren }
}

/**
 * Deep clone an RGA and all nested RGA children.
 */
function cloneRGA<E extends RGAEvent>(rga: RGA<RGATreeNode<E>, E>): RGA<RGATreeNode<E>, E> {
  const clone = new RGA<RGATreeNode<E>, E>(rga.fingerprintFn, rga.compareEvents)
  for (const [key, node] of rga.nodes) {
    clone.nodes.set(key, {
      ...node,
      value: isRGAParent(node.value)
        ? { ...node.value, children: cloneRGA(node.value.children) } as RGATreeNode<E>
        : node.value,
    })
  }
  return clone
}

/**
 * Apply changes to an RGA at the appropriate depth.
 * Changes have paths like [2, 1, 0] meaning root.children[2].children[1].children[0].
 * 
 * We process changes level by level:
 * - path.length === 1: change applies directly to this RGA
 * - path.length > 1: navigate into the child at path[0], recurse
 */
function applyChangesAtDepth<E extends RGAEvent>(
  rga: RGA<RGATreeNode<E>, E>,
  changes: Change[],
  prefix: number[],
  event: E,
  compareEvents: EventComparator<E>,
): void {
  // Separate changes at this level vs deeper
  const thisLevel: Change[] = []
  const deeper = new Map<number, Change[]>()

  for (const change of changes) {
    const relPath = change.path.slice(prefix.length)
    if (relPath.length === 1) {
      thisLevel.push(change)
    } else if (relPath.length > 1) {
      const childIdx = relPath[0]
      let list = deeper.get(childIdx)
      if (!list) { list = []; deeper.set(childIdx, list) }
      list.push(change)
    }
  }

  // Process deeper changes first (recurse into children)
  // Do this before this-level changes so indices are still valid
  for (const [childIdx, childChanges] of deeper) {
    const childNode = rga.idAtIndex(childIdx)
    if (!childNode) continue
    const nodeKey = `${childNode.uuid}:${childNode.event.toString()}`
    const node = rga.nodes.get(nodeKey)
    if (!node || !isRGAParent(node.value)) continue
    applyChangesAtDepth(
      node.value.children,
      childChanges,
      [...prefix, childIdx],
      event,
      compareEvents,
    )
  }

  // Apply this-level changes: sort deepest index first to avoid shifting
  const sorted = [...thisLevel].sort((a, b) => {
    const aIdx = a.path[a.path.length - 1]
    const bIdx = b.path[b.path.length - 1]
    return bIdx - aIdx // highest index first
  })

  for (const change of sorted) {
    const idx = change.path[change.path.length - 1]

    switch (change.type) {
      case 'delete': {
        const nodeId = rga.idAtIndex(idx)
        if (nodeId) rga.delete(nodeId)
        break
      }
      case 'insert': {
        // Insert after the predecessor (node at idx-1, or undefined for start)
        const afterId = idx > 0 ? rga.idAtIndex(idx - 1) : undefined
        for (const node of (change.nodes ?? [])) {
          const rgaNode = convertNode(node as Node, event, compareEvents)
          // For multiple inserts at same position, chain them
          const insertedId = rga.insert(afterId, rgaNode, event)
        }
        break
      }
      case 'modify': {
        // Delete old, insert new at same position
        const nodeId = rga.idAtIndex(idx)
        const afterId = idx > 0 ? rga.idAtIndex(idx - 1) : undefined
        if (nodeId) rga.delete(nodeId)
        for (const node of (change.nodes ?? [])) {
          const rgaNode = convertNode(node as Node, event, compareEvents)
          rga.insert(afterId, rgaNode, event)
        }
        break
      }
    }
  }
}
