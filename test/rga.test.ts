import { describe, it, expect } from 'vitest'
import { RGA, ROOT } from '../src/crdt/rga.js'

const strFp = (s: string) => s

describe('RGA basic operations', () => {
  it('inserts elements in order', () => {
    const rga = new RGA<string>(strFp)
    const id1 = rga.insert(ROOT, 'a', 'r1')
    const id2 = rga.insert(id1, 'b', 'r1')
    const id3 = rga.insert(id2, 'c', 'r1')
    expect(rga.toArray()).toEqual(['a', 'b', 'c'])
  })

  it('deletes elements (tombstone)', () => {
    const rga = new RGA<string>(strFp)
    const id1 = rga.insert(ROOT, 'a', 'r1')
    const id2 = rga.insert(id1, 'b', 'r1')
    rga.insert(id2, 'c', 'r1')
    rga.delete(id2)
    expect(rga.toArray()).toEqual(['a', 'c'])
  })

  it('fromArray creates correct sequence', () => {
    const rga = RGA.fromArray(['x', 'y', 'z'], 'r1', strFp)
    expect(rga.toArray()).toEqual(['x', 'y', 'z'])
  })

  it('insert is idempotent', () => {
    const rga = new RGA<string>(strFp)
    const id1 = rga.insert(ROOT, 'a', 'r1')
    const id2 = rga.insert(ROOT, 'a', 'r1')
    expect(id1).toBe(id2)
    expect(rga.toArray()).toEqual(['a'])
  })
})

describe('RGA merge', () => {
  it('merges concurrent inserts at same position — all elements present', () => {
    const base = RGA.fromArray(['a', 'c'], 'base', strFp)

    const r1 = new RGA<string>(strFp)
    for (const n of base.nodes.values()) r1.nodes.set(n.id, { ...n })
    const aId = r1.toNodes()[0].id
    r1.insert(aId, 'b1', 'r1')

    const r2 = new RGA<string>(strFp)
    for (const n of base.nodes.values()) r2.nodes.set(n.id, { ...n })
    r2.insert(aId, 'b2', 'r2')

    r1.merge(r2)
    const result = r1.toArray()
    expect(result).toContain('a')
    expect(result).toContain('b1')
    expect(result).toContain('b2')
    expect(result).toContain('c')
    expect(result.length).toBe(4)
    // 'a' should be first
    expect(result[0]).toBe('a')
    // Order of b1, b2, c is deterministic (by ID tiebreak) but all present
  })

  it('merge is commutative', () => {
    const base = RGA.fromArray(['a', 'c'], 'base', strFp)

    const makeReplica = () => {
      const r = new RGA<string>(strFp)
      for (const n of base.nodes.values()) r.nodes.set(n.id, { ...n })
      return r
    }

    const r1a = makeReplica()
    const r1b = makeReplica()
    const aId = r1a.toNodes()[0].id
    r1a.insert(aId, 'b1', 'r1')
    r1b.insert(aId, 'b1', 'r1')

    const r2a = makeReplica()
    const r2b = makeReplica()
    r2a.insert(aId, 'b2', 'r2')
    r2b.insert(aId, 'b2', 'r2')

    // r1 merges r2
    r1a.merge(r2a)
    // r2 merges r1
    r2b.merge(r1b)

    expect(r1a.toArray()).toEqual(r2b.toArray())
  })

  it('merges concurrent insert + delete', () => {
    const base = RGA.fromArray(['a', 'b', 'c'], 'base', strFp)
    const bId = base.toNodes()[1].id

    const r1 = new RGA<string>(strFp)
    for (const n of base.nodes.values()) r1.nodes.set(n.id, { ...n })
    r1.delete(bId)

    const r2 = new RGA<string>(strFp)
    for (const n of base.nodes.values()) r2.nodes.set(n.id, { ...n })
    r2.insert(bId, 'x', 'r2')

    r1.merge(r2)
    const result = r1.toArray()
    expect(result).toContain('a')
    expect(result).not.toContain('b')
    expect(result).toContain('x')
    expect(result).toContain('c')
  })
})
