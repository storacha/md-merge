/**
 * DAG-CBOR serialization for RGATree and RGAChangeSet.
 *
 * Converts RGA class instances (with Maps, nested RGAs) to plain
 * CBOR-friendly objects and back.
 */

import { encode, decode } from 'multiformats/block'
import { sha256 } from 'multiformats/hashes/sha2'
import * as cbor from '@ipld/dag-cbor'
import { RGA, type RGANodeId, type RGANode, type RGAEvent, type EventComparator } from './crdt/rga.js'
import type { RGATreeRoot, RGATreeNode, RGAParentNode } from './types.js'
import type { RGAChangeSet, RGAChange } from './types.js'


/** Recursively strip `undefined` values (not IPLD-compatible). */
function stripUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null
  if (Array.isArray(obj)) return obj.map(stripUndefined)
  if (typeof obj === 'object') {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== undefined) clean[k] = stripUndefined(v)
    }
    return clean
  }
  return obj
}

// ---- Serializable shapes (plain objects, no class instances) ----

interface SerializedRGANode {
  id: { uuid: string; event: string }
  value: unknown
  afterId: { uuid: string; event: string } | null
  tombstone: boolean
}

interface SerializedRGA {
  nodes: SerializedRGANode[]
}

interface SerializedRGATreeRoot {
  type: 'root'
  children: SerializedRGA
}

interface SerializedRGAChangeSet {
  event: string
  changes: SerializedRGAChange[]
}

interface SerializedRGAChange {
  type: 'insert' | 'delete' | 'modify'
  parentPath: Array<{ uuid: string; event: string }>
  targetId?: { uuid: string; event: string } | null
  afterId?: { uuid: string; event: string } | null
  nodes?: unknown[]
  before?: unknown[]
}

// ---- Helpers ----

function serializeNodeId<E extends RGAEvent>(id: RGANodeId<E>): { uuid: string; event: string } {
  return { uuid: id.uuid, event: id.event.toString() }
}

function deserializeNodeId<E extends RGAEvent>(
  raw: { uuid: string; event: string },
  parseEvent: (s: string) => E,
): RGANodeId<E> {
  return { uuid: raw.uuid, event: parseEvent(raw.event) }
}

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

function serializeRGA<E extends RGAEvent>(rga: RGA<RGATreeNode<E>, E>): SerializedRGA {
  const nodes: SerializedRGANode[] = []
  for (const node of rga.nodes.values()) {
    nodes.push({
      id: serializeNodeId(node.id),
      value: serializeTreeNodeValue(node.value),
      afterId: node.afterId ? serializeNodeId(node.afterId) : null,
      tombstone: node.tombstone,
    })
  }
  return { nodes }
}

function serializeTreeNodeValue<E extends RGAEvent>(node: RGATreeNode<E>): unknown {
  if (isRGAParentNode(node)) {
    const { children, ...rest } = node
    return { ...rest, children: serializeRGA(children) }
  }
  return node
}

function serializeTree<E extends RGAEvent>(root: RGATreeRoot<E>): SerializedRGATreeRoot {
  return {
    type: 'root',
    children: serializeRGA(root.children),
  }
}

function deserializeRGA<E extends RGAEvent>(
  raw: SerializedRGA,
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): RGA<RGATreeNode<E>, E> {
  const rga = new RGA<RGATreeNode<E>, E>(fingerprintFn, compareEvents)
  for (const rawNode of raw.nodes) {
    const id = deserializeNodeId(rawNode.id, parseEvent)
    const afterId = rawNode.afterId ? deserializeNodeId(rawNode.afterId, parseEvent) : undefined
    const value = deserializeTreeNodeValue(rawNode.value, parseEvent, fingerprintFn, compareEvents)
    const key = `${id.uuid}:${id.event.toString()}`
    rga.nodes.set(key, { id, value, afterId, tombstone: rawNode.tombstone })
  }
  return rga
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
      children: deserializeRGA(children, parseEvent, fingerprintFn, compareEvents),
    } as RGAParentNode<E>
  }
  return raw as RGATreeNode<E>
}

function deserializeTree<E extends RGAEvent>(
  raw: SerializedRGATreeRoot,
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): RGATreeRoot<E> {
  return {
    type: 'root',
    children: deserializeRGA(raw.children, parseEvent, fingerprintFn, compareEvents),
  }
}

// ---- RGAChangeSet serialization ----

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

/**
 * Encode an RGATree as a DAG-CBOR block.
 */
export async function encodeTree<E extends RGAEvent>(
  root: RGATreeRoot<E>,
) {
  const value = stripUndefined(serializeTree(root)) as SerializedRGATreeRoot
  return encode({ value, codec: cbor, hasher: sha256 })
}

/**
 * Decode an RGATree from a DAG-CBOR block.
 */
export async function decodeTree<E extends RGAEvent>(
  block: { bytes: Uint8Array },
  parseEvent: (s: string) => E,
  fingerprintFn: (value: RGATreeNode<E>) => string,
  compareEvents: EventComparator<E>,
): Promise<RGATreeRoot<E>> {
  const decoded = await decode({ bytes: block.bytes, codec: cbor, hasher: sha256 })
  return deserializeTree(decoded.value as SerializedRGATreeRoot, parseEvent, fingerprintFn, compareEvents)
}

/**
 * Encode an RGAChangeSet as a DAG-CBOR block.
 */
export async function encodeChangeSet<E extends RGAEvent>(
  cs: RGAChangeSet<E>,
) {
  const value = stripUndefined(serializeChangeSet(cs)) as SerializedRGAChangeSet
  return encode({ value, codec: cbor, hasher: sha256 })
}

/**
 * Decode an RGAChangeSet from a DAG-CBOR block.
 */
export async function decodeChangeSet<E extends RGAEvent>(
  block: { bytes: Uint8Array },
  parseEvent: (s: string) => E,
): Promise<RGAChangeSet<E>> {
  const decoded = await decode({ bytes: block.bytes, codec: cbor, hasher: sha256 })
  return deserializeChangeSet(decoded.value as SerializedRGAChangeSet, parseEvent)
}
