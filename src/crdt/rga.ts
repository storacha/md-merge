import { createHash } from 'node:crypto'

/** An element in the RGA */
export interface RGANode<T> {
  id: string
  value: T
  afterId: string
  tombstone: boolean
}

const ROOT = 'ROOT'

function makeId(replicaId: string, afterId: string, valueFingerprint: string): string {
  const hash = createHash('sha256')
  hash.update(replicaId)
  hash.update(afterId)
  hash.update(valueFingerprint)
  return hash.digest('hex').slice(0, 16)
}

/**
 * RGA (Replicated Growable Array) — a CRDT for ordered sequences.
 * 
 * Each element has a unique ID and a pointer to its predecessor.
 * Concurrent inserts after the same predecessor are ordered by ID (lexicographic tiebreak).
 * Deletes are tombstoned.
 */
export class RGA<T> {
  nodes: Map<string, RGANode<T>> = new Map()
  private fingerprintFn: (value: T) => string

  constructor(fingerprintFn: (value: T) => string) {
    this.fingerprintFn = fingerprintFn
  }

  /** Insert a new element after the given predecessor ID. Returns the new node's ID. */
  insert(afterId: string, value: T, replicaId: string): string {
    const fp = this.fingerprintFn(value)
    const id = makeId(replicaId, afterId, fp)
    if (this.nodes.has(id)) return id // idempotent
    this.nodes.set(id, { id, value, afterId, tombstone: false })
    return id
  }

  /** Mark an element as deleted (tombstone). */
  delete(id: string): void {
    const node = this.nodes.get(id)
    if (node) node.tombstone = true
  }

  /** Rebuild the ordered array from the graph, excluding tombstones. */
  toArray(): T[] {
    return this.toNodes().map(n => n.value)
  }

  /** Rebuild ordered nodes (including tombstones for internal use). */
  private allOrdered(): RGANode<T>[] {
    // Build children map: afterId -> list of nodes inserted after it
    const children = new Map<string, RGANode<T>[]>()
    for (const node of this.nodes.values()) {
      let list = children.get(node.afterId)
      if (!list) {
        list = []
        children.set(node.afterId, list)
      }
      list.push(node)
    }
    // Sort children by ID (lexicographic) for deterministic tiebreaking
    for (const list of children.values()) {
      list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }
    // DFS from ROOT
    const result: RGANode<T>[] = []
    const stack: string[] = [ROOT]
    while (stack.length > 0) {
      const parentId = stack.pop()!
      const kids = children.get(parentId)
      if (!kids) continue
      // Push in reverse order so first child is processed first
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i].id)
        result.push(kids[i])
      }
    }
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
    for (const node of other.nodes.values()) {
      const existing = this.nodes.get(node.id)
      if (!existing) {
        this.nodes.set(node.id, { ...node })
      } else if (node.tombstone) {
        existing.tombstone = true
      }
    }
  }

  /** Create an RGA from an array of items. Each item is inserted sequentially. */
  static fromArray<T>(items: T[], replicaId: string, fingerprintFn: (value: T) => string): RGA<T> {
    const rga = new RGA<T>(fingerprintFn)
    let afterId = ROOT
    for (const item of items) {
      afterId = rga.insert(afterId, item, replicaId)
    }
    return rga
  }

  /** Get the node ID at a given index (among non-tombstoned nodes). */
  idAtIndex(index: number): string | null {
    const nodes = this.toNodes()
    return index < nodes.length ? nodes[index].id : null
  }

  /** Get the afterId for inserting at a given index (before the element currently at that index). */
  predecessorForIndex(index: number): string {
    const nodes = this.toNodes()
    if (index <= 0) return ROOT
    return nodes[index - 1].id
  }
}

export { ROOT }
