/**
 * UCN integration — types and helpers for using md-merge with @storacha/ucn.
 *
 * Operations are stored as RGAChangeSets (RGA-addressed, index-free) so they
 * compose via CRDT merge rather than requiring three-way diff.
 */

import type { RGAChangeSet, RGATreeRoot } from "./types.js";
import type { RGAEvent, EventComparator } from "./crdt/rga.js";
import { parse, stringify } from "./parse.js";
import {
  toRGATree,
  toMdast,
  generateRGAChangeSet,
  applyRGAChangeSet,
} from "./rga-tree.js";

// Re-exports
export { parse, stringify, stringifyNode, fingerprint } from "./parse.js";
export { diff, applyChangeSet } from "./diff.js";
export {
  toRGATree,
  toMdast,
  applyMdastToRGATree,
  generateRGAChangeSet,
  applyRGAChangeSet,
} from "./rga-tree.js";
export {
  encodeTree,
  decodeTree,
  encodeChangeSet,
  decodeChangeSet,
  encodeRGA,
  decodeRGA,
} from "./codec.js";
export type {
  ChangeSet,
  Change,
  RGAChangeSet,
  RGAChange,
  RGATreeRoot,
  RGATreeNode,
  RGAParentNode,
  RGALeafNode,
} from "./types.js";
export {
  RGA,
  type RGAEvent,
  type RGANodeId,
  type EventComparator,
} from "./types.js";

/**
 * Compute an RGA-addressed changeset between an existing RGA tree and new markdown.
 */
export function computeChangeSet<E extends RGAEvent>(
  existing: RGATreeRoot<E>,
  newMarkdown: string,
  event: E,
): RGAChangeSet<E> {
  const newRoot = parse(newMarkdown);
  return generateRGAChangeSet(existing, newRoot, event);
}

/**
 * Apply an RGA changeset to an RGA tree, returning updated tree + markdown.
 */
export function applyToTree<E extends RGAEvent>(
  tree: RGATreeRoot<E>,
  changeset: RGAChangeSet<E>,
  compareEvents: EventComparator<E>,
): { tree: RGATreeRoot<E>; markdown: string } {
  const updated = applyRGAChangeSet(tree, changeset, compareEvents);
  return { tree: updated, markdown: stringify(toMdast(updated)) };
}

/**
 * Apply an RGA changeset and return just the markdown string.
 */
export function applyToMarkdown<E extends RGAEvent>(
  tree: RGATreeRoot<E>,
  changeset: RGAChangeSet<E>,
  compareEvents: EventComparator<E>,
): string {
  return applyToTree(tree, changeset, compareEvents).markdown;
}

/**
 * Bootstrap: create an RGA tree from a markdown string.
 */
export function fromMarkdown<E extends RGAEvent>(
  markdown: string,
  event: E,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  const root = parse(markdown);
  return toRGATree(root, event, compareEvents);
}
