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

// ---- RGA Tree Node Types ----

/** 
 * A node in the RGA tree. Either a leaf (no children) or a parent
 * whose children array has been replaced with an RGA.
 */
export type RGATreeNode<E extends RGAEvent = RGAEvent> = RGAParentNode<E> | RGALeafNode

/** Leaf nodes — no children array */
export type RGALeafNode = Exclude<RootContent, Parent>

/** 
 * A parent node with children converted to RGA.
 * Preserves all original properties except children becomes RGA.
 */
export interface RGAParentNode<E extends RGAEvent = RGAEvent> {
  type: string
  children: RGA<RGATreeNode<E>, E>
  [key: string]: unknown
}

/** Root of an RGA tree */
export interface RGATreeRoot<E extends RGAEvent = RGAEvent> {
  type: 'root'
  children: RGA<RGATreeNode<E>, E>
}

// ---- Conversion: mdast → RGA Tree ----

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

/**
 * Convert an mdast Root to an RGA tree.
 */
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

/**
 * Convert an RGA tree back to a standard mdast Root.
 */
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
