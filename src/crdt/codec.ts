/**
 * DAG-CBOR serialization for plain RGA instances.
 */

import { encode, decode } from 'multiformats/block'
import { sha256 } from 'multiformats/hashes/sha2'
import * as cbor from '@ipld/dag-cbor'
import { RGA, type RGANodeId, type RGAEvent, type EventComparator } from './rga.js'

/** Recursively strip `undefined` values (not IPLD-compatible). */
export function stripUndefined(obj: unknown): unknown {
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

// ---- Serializable shapes ----

export interface SerializedNodeId {
  uuid: string
  event: string
}

export interface SerializedRGANode<V = unknown> {
  id: SerializedNodeId
  value: V
  afterId: SerializedNodeId | null
  tombstone: boolean
}

export interface SerializedRGA<V = unknown> {
  nodes: SerializedRGANode<V>[]
}

// ---- Helpers ----

export function serializeNodeId<E extends RGAEvent>(id: RGANodeId<E>): SerializedNodeId {
  return { uuid: id.uuid, event: id.event.toString() }
}

export function deserializeNodeId<E extends RGAEvent>(
  raw: SerializedNodeId,
  parseEvent: (s: string) => E,
): RGANodeId<E> {
  return { uuid: raw.uuid, event: parseEvent(raw.event) }
}

// ---- Serialize / Deserialize ----

export function serializeRGA<T, E extends RGAEvent>(
  rga: RGA<T, E>,
  serializeValue: (v: T) => unknown = (v) => v,
): SerializedRGA {
  const nodes: SerializedRGANode[] = []
  for (const node of rga.nodes.values()) {
    nodes.push({
      id: serializeNodeId(node.id),
      value: serializeValue(node.value),
      afterId: node.afterId ? serializeNodeId(node.afterId) : null,
      tombstone: node.tombstone,
    })
  }
  return { nodes }
}

export function deserializeRGA<T, E extends RGAEvent>(
  raw: SerializedRGA,
  parseEvent: (s: string) => E,
  deserializeValue: (v: unknown) => T,
  compareEvents: EventComparator<E>,
): RGA<T, E> {
  const rga = new RGA<T, E>(compareEvents)
  for (const rawNode of raw.nodes) {
    const id = deserializeNodeId(rawNode.id, parseEvent)
    const afterId = rawNode.afterId ? deserializeNodeId(rawNode.afterId, parseEvent) : undefined
    const value = deserializeValue(rawNode.value)
    const key = `${id.uuid}:${id.event.toString()}`
    rga.nodes.set(key, { id, value, afterId, tombstone: rawNode.tombstone })
  }
  return rga
}

// ---- Public API: encode/decode to DAG-CBOR blocks ----

/**
 * Encode a plain RGA as a DAG-CBOR block.
 */
export async function encodeRGA<T, E extends RGAEvent>(
  rga: RGA<T, E>,
  serializeValue: (v: T) => unknown = (v) => v,
) {
  const value = stripUndefined(serializeRGA(rga, serializeValue))
  return encode({ value, codec: cbor, hasher: sha256 })
}

/**
 * Decode a plain RGA from a DAG-CBOR block.
 */
export async function decodeRGA<T, E extends RGAEvent>(
  block: { bytes: Uint8Array },
  parseEvent: (s: string) => E,
  deserializeValue: (v: unknown) => T,
  compareEvents: EventComparator<E>,
): Promise<RGA<T, E>> {
  const decoded = await decode({ bytes: block.bytes, codec: cbor, hasher: sha256 })
  return deserializeRGA(decoded.value as SerializedRGA, parseEvent, deserializeValue, compareEvents)
}
