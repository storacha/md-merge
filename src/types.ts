import type { RootContent, Root, Parent } from "mdast";
import {
  RGA,
  type RGANodeId,
  type RGAEvent,
  type EventComparator,
} from "./crdt/rga.js";
export { RGA, type RGANodeId, type RGAEvent, type EventComparator };

/** A changeset describing diffs between two mdast versions */
export interface ChangeSet {
  changes: Change[];
}

/** A single change at any depth in the mdast tree */
export interface Change {
  type: "insert" | "delete" | "modify";
  /** Path into the tree, e.g. [2, 1, 0] = root.children[2].children[1].children[0] */
  path: number[];
  /** For insert/modify: the new mdast node(s) */
  nodes?: RootContent[];
  /** For modify: what it was before (for conflict detection) */
  before?: RootContent[];
}

/** An RGA-addressed changeset — uses node IDs instead of indices */
export interface RGAChangeSet<E extends RGAEvent = RGAEvent> {
  event: E;
  changes: RGAChange<E>[];
}

/** A single RGA-addressed change at any depth in the RGA tree */
export interface RGAChange<E extends RGAEvent = RGAEvent> {
  type: "insert" | "delete" | "modify";
  /** Path of RGA node IDs from root to the parent containing this change (empty = root level) */
  parentPath: RGANodeId<E>[];
  /** For delete/modify: the target node to act on */
  targetId?: RGANodeId<E>;
  /** For insert/modify: insert after this node (undefined = insert at start) */
  afterId?: RGANodeId<E>;
  /** For insert/modify: the new mdast node(s) */
  nodes?: RootContent[];
  /** For modify: what it was before (for conflict detection) */
  before?: RootContent[];
}

// ---- RGA Tree Node Types ----

export type RGATreeNode<E extends RGAEvent = RGAEvent> =
  | RGAParentNode<E>
  | RGALeafNode;

export type RGALeafNode = Exclude<RootContent, Parent>;

export interface RGAParentNode<E extends RGAEvent = RGAEvent> {
  type: string;
  children: RGA<RGATreeNode<E>, E>;
  [key: string]: unknown;
}

export interface RGATreeRoot<E extends RGAEvent = RGAEvent> {
  type: "root";
  children: RGA<RGATreeNode<E>, E>;
}
