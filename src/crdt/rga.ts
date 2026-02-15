import { randomUUID } from 'node:crypto'

/** Interface for event types used in RGA node IDs */
export interface RGAEvent {
  toString(): string
}

/** Structured identifier for RGA nodes */
export interface RGANodeId<E extends RGAEvent> {
  uuid: string
  event: E
}

/** Serialize an RGANodeId for use as a Map key */
function serializeId<E extends RGAEvent>(id: RGANodeId<E>): string {
  return `${id.uuid}:${id.event.toString()}`
}

/** An element in the RGA */
export interface RGANode<T, E extends RGAEvent> {
  id: RGANodeId<E>
  value: T
  afterId: RGANodeId<E> | undefined
  tombstone: boolean
}

/** Comparator for events — determines precedence for concurrent inserts */
export type EventComparator<E extends RGAEvent> = (a: E, b: E) => number

/**
 * RGA (Replicated Growable Array) — a CRDT for ordered sequences.
 *
 * Each element has a unique ID (UUID + Event) and a pointer to its predecessor.
 * Concurrent inserts after the same predecessor are ordered by event comparator (then uuid).
 * Deletes are tombstoned.
 */
export class RGA<T, E extends RGAEvent = RGAEvent> {
  nodes: Map<string, RGANode<T, E>> = new Map()
  private fingerprintFn: (value: T) => string
  private compareEvents: EventComparator<E>

  constructor(fingerprintFn: (value: T) => string, compareEvents: EventComparator<E>) {
    this.fingerprintFn = fingerprintFn
    this.compareEvents = compareEvents
  }

  /** Compare two node IDs: primary by event, secondary by uuid */
  private compareIds(a: RGANodeId<E>, b: RGANodeId<E>): number {
    const cmp = this.compareEvents(a.event, b.event)
    if (cmp !== 0) return cmp
    if (a.uuid < b.uuid) return -1
    if (a.uuid > b.uuid) return 1
    return 0
  }

  /** Insert a new element after the given predecessor. Returns the new node's ID. */
  insert(afterId: RGANodeId<E> | undefined, value: T, event: E): RGANodeId<E> {
    const id: RGANodeId<E> = { uuid: randomUUID(), event }
    this.nodes.set(serializeId(id), { id, value, afterId, tombstone: false })
    return id
  }

  /** Mark an element as deleted (tombstone). */
  delete(id: RGANodeId<E>): void {
    const node = this.nodes.get(serializeId(id))
    if (node) node.tombstone = true
  }

  /** Rebuild the ordered array from the graph, excluding tombstones. */
  toArray(): T[] {
    return this.toNodes().map(n => n.value)
  }

  /** Rebuild ordered nodes (including tombstones for internal use). */
  private allOrdered(): RGANode<T, E>[] {
    const ROOT_KEY = '__ROOT__'
    const children = new Map<string, RGANode<T, E>[]>()
    for (const node of this.nodes.values()) {
      const key = node.afterId ? serializeId(node.afterId) : ROOT_KEY
      let list = children.get(key)
      if (!list) {
        list = []
        children.set(key, list)
      }
      list.push(node)
    }
    for (const list of children.values()) {
      list.sort((a, b) => this.compareIds(a.id, b.id))
    }
    const result: RGANode<T, E>[] = []
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
  toNodes(): RGANode<T, E>[] {
    return this.allOrdered().filter(n => !n.tombstone)
  }

  /** Get all ordered nodes including tombstones. */
  toAllNodes(): RGANode<T, E>[] {
    return this.allOrdered()
  }

  /** Merge another RGA into this one. Union of all nodes; tombstones win. */
  merge(other: RGA<T, E>): void {
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
  static fromArray<T, E extends RGAEvent>(
    items: T[],
    event: E,
    fingerprintFn: (value: T) => string,
    compareEvents: EventComparator<E>,
  ): RGA<T, E> {
    const rga = new RGA<T, E>(fingerprintFn, compareEvents)
    let afterId: RGANodeId<E> | undefined = undefined
    for (const item of items) {
      afterId = rga.insert(afterId, item, event)
    }
    return rga
  }

  /** Get the node ID at a given index (among non-tombstoned nodes). */
  idAtIndex(index: number): RGANodeId<E> | undefined {
    const nodes = this.toNodes()
    return index < nodes.length ? nodes[index].id : undefined
  }

  /** Get the afterId for inserting at a given index. */
  predecessorForIndex(index: number): RGANodeId<E> | undefined {
    const nodes = this.toNodes()
    if (index <= 0) return undefined
    return nodes[index - 1].id
  }
}
