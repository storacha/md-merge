import { describe, it, expect } from 'vitest'
import { parse, stringify } from '../src/parse.js'
import { toRGATree, toMdast, generateRGAChangeSet, applyRGAChangeSet } from '../src/rga-tree.js'
import { encodeTree, decodeTree, encodeChangeSet, decodeChangeSet } from '../src/codec.js'
import { type RGAEvent, type EventComparator } from '../src/types.js'
import { fingerprint } from '../src/parse.js'
import type { RGATreeNode } from '../src/types.js'

class TestEvent implements RGAEvent {
  constructor(readonly name: string) {}
  toString(): string { return this.name }
}

const cmp: EventComparator<TestEvent> = (a, b) => {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

const parseEvent = (s: string) => new TestEvent(s)


const r1 = new TestEvent('r1')
const r2 = new TestEvent('r2')

describe('codec: RGATree', () => {
  it('round-trips a simple document', async () => {
    const md = '# Hello\n\nThis is a paragraph.\n\n- item 1\n- item 2\n'
    const root = parse(md)
    const tree = toRGATree(root, r1, cmp)

    const block = await encodeTree(tree)
    const decoded = await decodeTree({ bytes: block.bytes }, parseEvent, cmp)

    const result = stringify(toMdast(decoded))
    expect(result).toBe(stringify(root))
  })

  it('round-trips a document with nested structure', async () => {
    const md = '> A quote with **bold** text.\n\n1. First\n2. Second\n'
    const root = parse(md)
    const tree = toRGATree(root, r1, cmp)

    const block = await encodeTree(tree)
    const decoded = await decodeTree({ bytes: block.bytes }, parseEvent, cmp)

    expect(stringify(toMdast(decoded))).toBe(stringify(root))
  })

  it('preserves RGA node IDs through round-trip', async () => {
    const md = '# Title\n\nParagraph.\n'
    const tree = toRGATree(parse(md), r1, cmp)

    const originalNodes = tree.children.toNodes()
    const block = await encodeTree(tree)
    const decoded = await decodeTree({ bytes: block.bytes }, parseEvent, cmp)
    const decodedNodes = decoded.children.toNodes()

    expect(decodedNodes.length).toBe(originalNodes.length)
    for (let i = 0; i < originalNodes.length; i++) {
      expect(decodedNodes[i].id.uuid).toBe(originalNodes[i].id.uuid)
      expect(decodedNodes[i].id.event.toString()).toBe(originalNodes[i].id.event.toString())
    }
  })

  it('preserves tombstones through round-trip', async () => {
    const md = '# Title\n\nParagraph.\n\nRemove me.\n'
    const tree = toRGATree(parse(md), r1, cmp)

    // Delete the last node
    const lastId = tree.children.idAtIndex(2)!
    tree.children.delete(lastId)

    const block = await encodeTree(tree)
    const decoded = await decodeTree({ bytes: block.bytes }, parseEvent, cmp)

    // Should have 2 live nodes, but the tombstone is preserved internally
    expect(decoded.children.toNodes().length).toBe(2)
    expect(decoded.children.toAllNodes().length).toBe(3)
    expect(stringify(toMdast(decoded))).toBe(stringify(toMdast(tree)))
  })
})

describe('codec: RGAChangeSet', () => {
  it('round-trips a changeset with inserts', async () => {
    const tree = toRGATree(parse('# Hello\n\nWorld.\n'), r1, cmp)
    const newRoot = parse('# Hello\n\nWorld.\n\nNew paragraph.\n')
    const cs = generateRGAChangeSet(tree, newRoot, r2)

    const block = await encodeChangeSet(cs)
    const decoded = await decodeChangeSet({ bytes: block.bytes }, parseEvent)

    expect(decoded.event.toString()).toBe('r2')
    expect(decoded.changes.length).toBe(cs.changes.length)
    expect(decoded.changes[0].type).toBe(cs.changes[0].type)
  })

  it('round-trips a changeset with deletes', async () => {
    const tree = toRGATree(parse('# Hello\n\nFirst.\n\nSecond.\n'), r1, cmp)
    const newRoot = parse('# Hello\n\nSecond.\n')
    const cs = generateRGAChangeSet(tree, newRoot, r2)

    const block = await encodeChangeSet(cs)
    const decoded = await decodeChangeSet({ bytes: block.bytes }, parseEvent)

    expect(decoded.changes.length).toBe(cs.changes.length)
    const del = decoded.changes.find(c => c.type === 'delete')!
    expect(del.targetId).toBeDefined()
    expect(del.targetId!.uuid).toBe(cs.changes.find(c => c.type === 'delete')!.targetId!.uuid)
  })

  it('round-trips a changeset with modifies', async () => {
    const tree = toRGATree(parse('# Hello\n\nOld text.\n'), r1, cmp)
    const newRoot = parse('# Hello\n\nNew text.\n')
    const cs = generateRGAChangeSet(tree, newRoot, r2)

    const block = await encodeChangeSet(cs)
    const decoded = await decodeChangeSet({ bytes: block.bytes }, parseEvent)

    expect(decoded.changes.length).toBe(cs.changes.length)
  })

  it('decoded changeset applies correctly', async () => {
    const md = '# Doc\n\nParagraph A.\n\nParagraph B.\n'
    const tree = toRGATree(parse(md), r1, cmp)
    const newMd = '# Doc\n\nParagraph A.\n\nParagraph B.\n\nParagraph C.\n'
    const newRoot = parse(newMd)
    const cs = generateRGAChangeSet(tree, newRoot, r2)

    // Encode, decode, then apply
    const block = await encodeChangeSet(cs)
    const decoded = await decodeChangeSet({ bytes: block.bytes }, parseEvent)
    const updated = applyRGAChangeSet(tree, decoded, cmp)

    expect(stringify(toMdast(updated))).toBe(stringify(newRoot))
  })

  it('preserves parentPath IDs through round-trip', async () => {
    const md = '- item 1\n- item 2\n'
    const tree = toRGATree(parse(md), r1, cmp)
    const newRoot = parse('- item 1\n- item 2\n- item 3\n')
    const cs = generateRGAChangeSet(tree, newRoot, r2)

    const block = await encodeChangeSet(cs)
    const decoded = await decodeChangeSet({ bytes: block.bytes }, parseEvent)

    for (let i = 0; i < cs.changes.length; i++) {
      expect(decoded.changes[i].parentPath.length).toBe(cs.changes[i].parentPath.length)
      for (let j = 0; j < cs.changes[i].parentPath.length; j++) {
        expect(decoded.changes[i].parentPath[j].uuid).toBe(cs.changes[i].parentPath[j].uuid)
      }
    }
  })
})
