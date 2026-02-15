/**
 * RGA-backed mdast tree.
 *
 * Every ordered `children` array in the mdast tree is replaced with an RGA,
 * giving us CRDT merge semantics at every level.
 */
import type {
  RGAChangeSet,
  RGAChange,
  RGAEvent,
  RGATreeNode,
  RGAParentNode,
  RGATreeRoot,
  RGALeafNode,
  RGANodeId,
} from "./types.js";
import { RGA } from "./types.js";
import type { Root, RootContent, Parent, Node } from "mdast";
import { type EventComparator } from "./crdt/rga.js";
import { fingerprint } from "./parse.js";
import { diff as mdastDiff } from "./diff.js";

// ---- Helpers ----

function isParent(node: Node): node is Parent {
  return "children" in node && Array.isArray((node as Parent).children);
}

function fpNode<E extends RGAEvent>(node: RGATreeNode<E>): string {
  if (isRGAParent(node)) {
    const { children, ...rest } = node;
    return JSON.stringify(rest);
  }
  return fingerprint(node as RootContent);
}

function isRGAParent<E extends RGAEvent>(
  node: RGATreeNode<E>,
): node is RGAParentNode<E> {
  return "children" in node && node.children instanceof RGA;
}

// ---- Conversion: mdast → RGA Tree ----

export function toRGATree<E extends RGAEvent>(
  root: Root,
  event: E,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  return {
    type: "root",
    children: childrenToRGA(root.children as Node[], event, compareEvents),
  };
}

function childrenToRGA<E extends RGAEvent>(
  children: Node[],
  event: E,
  compareEvents: EventComparator<E>,
): RGA<RGATreeNode<E>, E> {
  const converted: RGATreeNode<E>[] = children.map((child) =>
    convertNode(child, event, compareEvents),
  );
  return RGA.fromArray(
    converted,
    event,
    (n: RGATreeNode<E>) => fpNode(n),
    compareEvents,
  );
}

function convertNode<E extends RGAEvent>(
  node: Node,
  event: E,
  compareEvents: EventComparator<E>,
): RGATreeNode<E> {
  if (!isParent(node)) {
    return node as RGALeafNode;
  }
  const { children, ...rest } = node as Parent & Record<string, unknown>;
  return {
    ...rest,
    children: childrenToRGA(children as Node[], event, compareEvents),
  } as RGAParentNode<E>;
}

// ---- Conversion: RGA Tree → mdast ----

export function toMdast<E extends RGAEvent>(rgaRoot: RGATreeRoot<E>): Root {
  return {
    type: "root",
    children: rgaToChildren(rgaRoot.children) as RootContent[],
  };
}

function rgaToChildren<E extends RGAEvent>(
  rga: RGA<RGATreeNode<E>, E>,
): Node[] {
  return rga.toArray().map(revertNode);
}

function revertNode<E extends RGAEvent>(node: RGATreeNode<E>): Node {
  if (!isRGAParent(node)) {
    return node as Node;
  }
  const { children, ...rest } = node;
  return {
    ...rest,
    children: rgaToChildren(children),
  } as Node;
}

// ---- Apply new mdast to existing RGA tree ----

/**
 * Apply a new mdast document to an existing RGA tree, preserving existing
 * RGA node IDs where nodes haven't changed.
 *
 * Generates an RGAChangeSet from the diff, then applies it.
 */
export function applyMdastToRGATree<E extends RGAEvent>(
  existing: RGATreeRoot<E>,
  newRoot: Root,
  event: E,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  const changeset = generateRGAChangeSet(existing, newRoot, event);
  return applyRGAChangeSet(existing, changeset, compareEvents);
}

/**
 * Deep clone an RGA and all nested RGA children.
 */
function cloneRGA<E extends RGAEvent>(
  rga: RGA<RGATreeNode<E>, E>,
): RGA<RGATreeNode<E>, E> {
  const clone = new RGA<RGATreeNode<E>, E>(
    rga.fingerprintFn,
    rga.compareEvents,
  );
  for (const [key, node] of rga.nodes) {
    clone.nodes.set(key, {
      ...node,
      value: isRGAParent(node.value)
        ? ({
            ...node.value,
            children: cloneRGA(node.value.children),
          } as RGATreeNode<E>)
        : node.value,
    });
  }
  return clone;
}

// ---- Generate RGA ChangeSet from mdast ----

/**
 * Generate an RGA-addressed changeset by diffing an existing RGA tree against
 * a new mdast document.
 *
 * 1. Convert RGA tree → plain mdast
 * 2. Diff old mdast vs new mdast → index-based ChangeSet
 * 3. Convert each index-based Change to an RGAChange by resolving indices
 *    to RGA node IDs via idAtIndex / predecessorForIndex
 */
export function generateRGAChangeSet<E extends RGAEvent>(
  existing: RGATreeRoot<E>,
  newRoot: Root,
  event: E,
): RGAChangeSet<E> {
  const oldMdast = toMdast(existing);
  const changeset = mdastDiff(oldMdast, newRoot);

  const rgaChanges: RGAChange<E>[] = [];

  for (const change of changeset.changes) {
    const path = change.path;
    // path = [...parentIndices, targetIndex]
    // parentIndices navigate into nested RGAs, targetIndex is the operation target
    const parentIndices = path.slice(0, -1);
    const targetIndex = path[path.length - 1];

    // Walk the RGA tree to resolve parent path to node IDs and find the target RGA
    const parentIds: RGANodeId<E>[] = [];
    let currentRGA: RGA<RGATreeNode<E>, E> = existing.children;

    let valid = true;
    for (const idx of parentIndices) {
      const nodeId = currentRGA.idAtIndex(idx);
      if (!nodeId) {
        valid = false;
        break;
      }
      parentIds.push(nodeId);

      // Navigate into this node's children RGA
      const nodeKey = `${nodeId.uuid}:${nodeId.event.toString()}`;
      const node = currentRGA.nodes.get(nodeKey);
      if (!node || !isRGAParent(node.value)) {
        valid = false;
        break;
      }
      currentRGA = node.value.children;
    }

    if (!valid) continue;

    // Now currentRGA is the RGA where the operation happens, resolve target/after IDs
    switch (change.type) {
      case "delete": {
        const targetId = currentRGA.idAtIndex(targetIndex);
        if (targetId) {
          rgaChanges.push({
            type: "delete",
            parentPath: parentIds,
            targetId,
          });
        }
        break;
      }
      case "insert": {
        const afterId = currentRGA.predecessorForIndex(targetIndex);
        rgaChanges.push({
          type: "insert",
          parentPath: parentIds,
          afterId,
          nodes: change.nodes,
        });
        break;
      }
      case "modify": {
        const targetId = currentRGA.idAtIndex(targetIndex);
        const afterId = currentRGA.predecessorForIndex(targetIndex);
        if (targetId) {
          rgaChanges.push({
            type: "modify",
            parentPath: parentIds,
            targetId,
            afterId,
            nodes: change.nodes,
            before: change.before,
          });
        }
        break;
      }
    }
  }

  return { event, changes: rgaChanges };
}

/**
 * Apply an RGA-addressed changeset to an RGA tree.
 * Navigates by node IDs at every level — no index dependency.
 */
export function applyRGAChangeSet<E extends RGAEvent>(
  root: RGATreeRoot<E>,
  changeset: RGAChangeSet<E>,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  const updatedChildren = cloneRGA(root.children);

  for (const change of changeset.changes) {
    // Navigate to the target RGA using parentPath node IDs
    let currentRGA: RGA<RGATreeNode<E>, E> = updatedChildren;

    let valid = true;
    for (const parentId of change.parentPath) {
      const nodeKey = `${parentId.uuid}:${parentId.event.toString()}`;
      const node = currentRGA.nodes.get(nodeKey);
      if (!node || !isRGAParent(node.value)) {
        valid = false;
        break;
      }
      currentRGA = node.value.children;
    }
    if (!valid) continue;

    switch (change.type) {
      case "delete": {
        if (change.targetId) currentRGA.delete(change.targetId);
        break;
      }
      case "insert": {
        for (const node of change.nodes ?? []) {
          const rgaNode = convertNode(
            node as Node,
            changeset.event,
            compareEvents,
          );
          currentRGA.insert(change.afterId, rgaNode, changeset.event);
        }
        break;
      }
      case "modify": {
        if (change.targetId) currentRGA.delete(change.targetId);
        for (const node of change.nodes ?? []) {
          const rgaNode = convertNode(
            node as Node,
            changeset.event,
            compareEvents,
          );
          currentRGA.insert(change.afterId, rgaNode, changeset.event);
        }
        break;
      }
    }
  }

  return { type: "root", children: updatedChildren };
}
