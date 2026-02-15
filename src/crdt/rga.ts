import { randomUUID } from 'node:crypto'

/** Branded type for replica identifiers */
export type ReplicaId = string & { readonly __brand: unique symbol }

/** Structured identifier for RGA nodes */
export interface RGANodeId {
  uuid: string
  replicaId: ReplicaId
}

/** Serialize an RGANodeId for use as a Map key */
function serializeId(id: RGANodeId): string {
  return `${id.uuid}:${id.replicaId}`
}

/** Compare two RGANodeIds: primary by replicaId, secondary by uuid */
function compareIds(a: RGANodeId, b: RGANodeId): number {
  if (a.replicaId < b.replicaId) return -1
  if (a.replicaId > b.replicaId) return 1
  if (a.uuid < b.uuid) return -1
  if (a.uuid > b.uuid) return 1
  return 0
}

/** An element in the RGA */
export interface RGANode<T> {
  id: RGANodeId
  value: T
  afterId: RGANodeId | undefined
  tombstone: boolean
}

/**
 * RGA (Replicated Growable Array) — a CRDT for ordered sequences.
 *
 * Each element has a unique ID (UUID + ReplicaId) and a pointer to its predecessor.
 * Concurrent inserts after the same predecessor are ordered by replicaId (then uuid).
 * Deletes are tombstoned.
 */
export class RGA<T> {
  nodes: Map<string, RGANode<T>> = new Map()
  private fingerprintFn: (value: T) => string

  constructor(fingerprintFn: (value: T) => string) {
    this.fingerprintFn = fingerprintFn
  }

  /** Insert a new element after the given predecessor. Returns the new node's ID. */
  insert(afterId: RGANodeId | undefined, value: T, replicaId: ReplicaId): RGANodeId {
    const id: RGANodeId = { uuid: randomUUID(), replicaId }
    this.nodes.set(serializeId(id), { id, value, afterId, tombstone: false })
    return id
  }

  /** Mark an element as deleted (tombstone). */
  delete(id: RGANodeId): void {
    const node = this.nodes.get(serializeId(id))
    if (node) node.tombstone = true
  }

  /** Rebuild the ordered array from the graph, excluding tombstones. */
  toArray(): T[] {
    return this.toNodes().map(n => n.value)
  }

  /** Rebuild ordered nodes (including tombstones for internal use). */
  private allOrdered(): RGANode<T>[] {
    // Build children map: serialized afterId -> list of nodes inserted after it
    const ROOT_KEY = '__ROOT__'
    const children = new Map<string, RGANode<T>[]>()
    for (const node of this.nodes.values()) {
      const key = node.afterId ? serializeId(node.afterId) : ROOT_KEY
      let list = children.get(key)
      if (!list) {
        list = []
        children.set(key, list)
      }
      list.push(node)
    }
    // Sort children by ID for deterministic tiebreaking
    for (const list of children.values()) {
      list.sort((a, b) => compareIds(a.id, b.id))
    }
    // Walk tree from root in sorted order
    const result: RGANode<T>[] = []
    const visit = (parentKey: string) => {
      const kids = children.get(parentKey)
      if (!kids) return
      for (const kid of kids) {
        result.push(kid)
        visit(serializeId(kid.id))
      }
    }
    visit(ROOT_KEY)
    return result
  }

  /** Get ordered non-tombstoned nodes. */
  toNodes(): RGANode<T>[] {
    return this.allOrdered().filter(n => !n.tombstone)
  }

  /** Get all ordered nodes including tombstones. */
  toAllNodes(): RGANode<T>[] {
    return this.allOrdered()
  }

  /** Merge another RGA into this one. Union of all nodes; tombstones win. */
  merge(other: RGA<T>): void {
    for (const [key, node] of other.nodes) {
      const existing = this.nodes.get(key)
      if (!existing) {
        this.nodes.set(key, { ...node })
      } else if (node.tombstone) {
        existing.tombstone = true
      }
    }
  }

  /** Create an RGA from an array of items. Each item is inserted sequentially. */
  static fromArray<T>(items: T[], replicaId: ReplicaId, fingerprintFn: (value: T) => string): RGA<T> {
    const rga = new RGA<T>(fingerprintFn)
    let afterId: RGANodeId | undefined = undefined
    for (const item of items) {
      afterId = rga.insert(afterId, item, replicaId)
    }
    return rga
  }

  /** Get the node ID at a given index (among non-tombstoned nodes). */
  idAtIndex(index: number): RGANodeId | undefined {
    const nodes = this.toNodes()
    return index < nodes.length ? nodes[index].id : undefined
  }

  /** Get the afterId for inserting at a given index. */
  predecessorForIndex(index: number): RGANodeId | undefined {
    const nodes = this.toNodes()
    if (index <= 0) return undefined
    return nodes[index - 1].id
  }
}
