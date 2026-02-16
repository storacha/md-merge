/**
 * DAG-CBOR serialization for RGATree and RGAChangeSet.
 *
 * Tree-specific serialization wraps the generic RGA codec from crdt/codec.ts,
 * adding recursive handling of nested RGA children in tree nodes.
 */

import { encode, decode } from 'multiformats/block'
import { sha256 } from 'multiformats/hashes/sha2'
import * as cbor from '@ipld/dag-cbor'
import { RGA, type RGAEvent, type EventComparator } from './crdt/rga.js'
import {
  stripUndefined,
  serializeNodeId,
  deserializeNodeId,
  serializeRGA,
  deserializeRGA,
  type SerializedRGA,
  type SerializedNodeId,
} from './crdt/codec.js'
import type { RGATreeRoot, RGATreeNode, RGAParentNode } from './types.js'
import type { RGAChangeSet, RGAChange } from './types.js'

// Re-export plain RGA codec
export { encodeRGA, decodeRGA } from './crdt/codec.js'

// ---- Tree-specific helpers ----

function isRGAParentSerialized(node: unknown): node is { type: string; children: SerializedRGA } {
  return (
    node != null &&
    typeof node === 'object' &&
    'children' in node &&
    typeof (node as Record<string, unknown>).children === 'object' &&
    (node as Record<string, unknown>).children !== null &&
    'nodes' in ((node as Record<string, unknown>).children as Record<string, unknown>)
  )
}

function isRGAParentNode<E extends RGAEvent>(node: RGATreeNode<E>): node is RGAParentNode<E> {
  return 'children' in node && node.children instanceof RGA
}

// ---- RGATree serialization ----

function serializeTreeNodeValue<E extends RGAEvent>(node: RGATreeNode<E>): unknown {
  if (isRGAParentNode(node)) {
    const { children, ...rest } = node
    return { ...rest, children: serializeRGA(children, (n: RGATreeNode<E>) => serializeTreeNodeValue(n)) }
  }
  return node
}

function serializeTree<E extends RGAEvent>(root: RGATreeRoot<E>): unknown {
  return {
    type: 'root',
    children: serializeRGA(root.children, (n: RGATreeNode<E>) => serializeTreeNodeValue(n)),
  }
}

function deserializeTreeNodeValue<E extends RGAEvent>(
  raw: unknown,
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): RGATreeNode<E> {
  if (isRGAParentSerialized(raw)) {
    const { children, ...rest } = raw
    return {
      ...rest,
      children: deserializeTreeRGA(children, parseEvent, fingerprintFn, compareEvents),
    } as RGAParentNode<E>
  }
  return raw as RGATreeNode<E>
}

function deserializeTreeRGA<E extends RGAEvent>(
  raw: SerializedRGA,
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): RGA<RGATreeNode<E>, E> {
  return deserializeRGA<RGATreeNode<E>, E>(
    raw,
    parseEvent,
    (v) => deserializeTreeNodeValue(v, parseEvent, fingerprintFn, compareEvents),
    fingerprintFn,
    compareEvents,
  )
}

function deserializeTree<E extends RGAEvent>(
  raw: { type: string; children: SerializedRGA },
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  return {
    type: 'root',
    children: deserializeTreeRGA(raw.children, parseEvent, fingerprintFn, compareEvents),
  }
}

// ---- RGAChangeSet serialization ----

interface SerializedRGAChangeSet {
  event: string
  changes: SerializedRGAChange[]
}

interface SerializedRGAChange {
  type: 'insert' | 'delete' | 'modify'
  parentPath: SerializedNodeId[]
  targetId?: SerializedNodeId | null
  afterId?: SerializedNodeId | null
  nodes?: unknown[]
  before?: unknown[]
}

function serializeChangeSet<E extends RGAEvent>(cs: RGAChangeSet<E>): SerializedRGAChangeSet {
  return {
    event: cs.event.toString(),
    changes: cs.changes.map(c => ({
      type: c.type,
      parentPath: c.parentPath.map(serializeNodeId),
      targetId: c.targetId ? serializeNodeId(c.targetId) : null,
      afterId: c.afterId ? serializeNodeId(c.afterId) : null,
      nodes: c.nodes,
      before: c.before,
    })),
  }
}

function deserializeChangeSet<E extends RGAEvent>(
  raw: SerializedRGAChangeSet,
  parseEvent: (s: string) => E,
): RGAChangeSet<E> {
  return {
    event: parseEvent(raw.event),
    changes: raw.changes.map(c => {
      const change: RGAChange<E> = {
        type: c.type,
        parentPath: c.parentPath.map(id => deserializeNodeId(id, parseEvent)),
      }
      if (c.targetId) change.targetId = deserializeNodeId(c.targetId, parseEvent)
      if (c.afterId) change.afterId = deserializeNodeId(c.afterId, parseEvent)
      if (c.nodes) change.nodes = c.nodes as any
      if (c.before) change.before = c.before as any
      return change
    }),
  }
}

// ---- Public API: encode/decode to DAG-CBOR blocks ----

export async function encodeTree<E extends RGAEvent>(root: RGATreeRoot<E>) {
  const value = stripUndefined(serializeTree(root))
  return encode({ value, codec: cbor, hasher: sha256 })
}

export async function decodeTree<E extends RGAEvent>(
  block: { bytes: Uint8Array },
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): Promise<RGATreeRoot<E>> {
  const decoded = await decode({ bytes: block.bytes, codec: cbor, hasher: sha256 })
  return deserializeTree(decoded.value as { type: string; children: SerializedRGA }, parseEvent, fingerprintFn, compareEvents)
}

export async function encodeChangeSet<E extends RGAEvent>(cs: RGAChangeSet<E>) {
  const value = stripUndefined(serializeChangeSet(cs))
  return encode({ value, codec: cbor, hasher: sha256 })
}

export async function decodeChangeSet<E extends RGAEvent>(
  block: { bytes: Uint8Array },
  parseEvent: (s: string) => E,
): Promise<RGAChangeSet<E>> {
  const decoded = await decode({ bytes: block.bytes, codec: cbor, hasher: sha256 })
  return deserializeChangeSet(decoded.value as SerializedRGAChangeSet, parseEvent)
}
