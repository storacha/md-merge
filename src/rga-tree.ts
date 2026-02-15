/**
 * RGA-backed mdast tree.
 *
 * Every ordered `children` array in the mdast tree is replaced with an RGA,
 * giving us CRDT merge semantics at every level.
 */

import type {
  Root, RootContent, Parent, Node,
  Blockquote, Delete, Emphasis, FootnoteDefinition,
  Heading, Link, List, ListItem, Paragraph, Strong,
  Table, TableCell, TableRow,
} from 'mdast'
import { RGA, type RGANodeId, type ReplicaId } from './crdt/rga.js'
import { fingerprint } from './parse.js'

// ---- RGA Tree Node Types ----

/** 
 * A node in the RGA tree. Either a leaf (no children) or a parent
 * whose children array has been replaced with an RGA.
 */
export type RGATreeNode = RGAParentNode | RGALeafNode

/** Leaf nodes — no children array */
export type RGALeafNode = Exclude<RootContent, Parent>

/** 
 * A parent node with children converted to RGA.
 * Preserves all original properties except children becomes RGA<RGATreeNode>.
 */
export interface RGAParentNode {
  type: string
  children: RGA<RGATreeNode>
  /** Preserve any extra mdast properties (url, depth, ordered, etc.) */
  [key: string]: unknown
}

/** Root of an RGA tree */
export interface RGATreeRoot {
  type: 'root'
  children: RGA<RGATreeNode>
}

// ---- Conversion: mdast → RGA Tree ----

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray((node as Parent).children)
}

/** Fingerprint a tree node for RGA */
function fpNode(node: RGATreeNode): string {
  // For parent nodes, fingerprint by type + shallow properties (not children)
  if (isRGAParent(node)) {
    const { children, ...rest } = node
    return JSON.stringify(rest)
  }
  // For leaf nodes, use the existing fingerprint
  return fingerprint(node as RootContent)
}

function isRGAParent(node: RGATreeNode): node is RGAParentNode {
  return 'children' in node && node.children instanceof RGA
}

/**
 * Convert an mdast Root to an RGA tree.
 * Recursively replaces every children array with an RGA.
 */
export function toRGATree(root: Root, replicaId: ReplicaId): RGATreeRoot {
  return {
    type: 'root',
    children: childrenToRGA(root.children as Node[], replicaId),
  }
}

function childrenToRGA(children: Node[], replicaId: ReplicaId): RGA<RGATreeNode> {
  const converted: RGATreeNode[] = children.map(child => convertNode(child, replicaId))
  return RGA.fromArray(converted, replicaId, fpNode)
}

function convertNode(node: Node, replicaId: ReplicaId): RGATreeNode {
  if (!isParent(node)) {
    // Leaf node — return as-is
    return node as RGALeafNode
  }

  // Parent node — convert children to RGA, preserve all other properties
  const { children, ...rest } = node as Parent & Record<string, unknown>
  return {
    ...rest,
    children: childrenToRGA(children as Node[], replicaId),
  } as RGAParentNode
}

// ---- Conversion: RGA Tree → mdast ----

/**
 * Convert an RGA tree back to a standard mdast Root.
 * Recursively converts all RGA children back to arrays.
 */
export function toMdast(rgaRoot: RGATreeRoot): Root {
  return {
    type: 'root',
    children: rgaToChildren(rgaRoot.children) as RootContent[],
  }
}

function rgaToChildren(rga: RGA<RGATreeNode>): Node[] {
  return rga.toArray().map(revertNode)
}

function revertNode(node: RGATreeNode): Node {
  if (!isRGAParent(node)) {
    return node as Node
  }

  const { children, ...rest } = node
  return {
    ...rest,
    children: rgaToChildren(children),
  } as Node
}
