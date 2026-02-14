import { describe, it, expect } from 'vitest'
import { parse, stringify, diff, applyChangeSet, threeWayMerge, computeChangeSet, applyToMarkdown } from '../src/index.js'

describe('parse', () => {
  it('parses markdown to AST and back', () => {
    const md = '# Hello\n\nThis is a paragraph.\n\n- item 1\n- item 2\n'
    const root = parse(md)
    expect(root.type).toBe('root')
    expect(root.children.length).toBe(3) // heading, paragraph, list
    const out = stringify(root)
    expect(out).toContain('# Hello')
    expect(out).toContain('This is a paragraph.')
  })
})

describe('diff', () => {
  it('detects no changes for identical docs', () => {
    const md = '# Hello\n\nParagraph.\n'
    const a = parse(md)
    const b = parse(md)
    const cs = diff(a, b)
    expect(cs.changes).toHaveLength(0)
  })

  it('detects an inserted paragraph', () => {
    const old = parse('# Hello\n\nParagraph one.\n')
    const new_ = parse('# Hello\n\nNew paragraph.\n\nParagraph one.\n')
    const cs = diff(old, new_)
    expect(cs.changes.length).toBeGreaterThan(0)
    const inserts = cs.changes.filter(c => c.type === 'insert')
    expect(inserts.length).toBeGreaterThan(0)
  })

  it('detects a deleted paragraph', () => {
    const old = parse('# Hello\n\nParagraph one.\n\nParagraph two.\n')
    const new_ = parse('# Hello\n\nParagraph two.\n')
    const cs = diff(old, new_)
    const deletes = cs.changes.filter(c => c.type === 'delete')
    expect(deletes.length).toBeGreaterThan(0)
  })

  it('detects text edit within a paragraph recursively', () => {
    const old = parse('# Hello\n\nOld text.\n')
    const new_ = parse('# Hello\n\nNew text.\n')
    const cs = diff(old, new_)
    // Should have changes at depth > 1 (inside the paragraph)
    expect(cs.changes.length).toBeGreaterThan(0)
    // The change should be within paragraph's children, path length >= 2
    const deepChanges = cs.changes.filter(c => c.path.length >= 2)
    expect(deepChanges.length).toBeGreaterThan(0)
  })

  it('detects adding an item to a list', () => {
    const old = parse('- item 1\n- item 2\n')
    const new_ = parse('- item 1\n- item 2\n- item 3\n')
    const cs = diff(old, new_)
    expect(cs.changes.length).toBeGreaterThan(0)
    // Change should be within the list node (path[0] = 0 for the list)
    const inserts = cs.changes.filter(c => c.type === 'insert')
    expect(inserts.length).toBeGreaterThan(0)
    // Path should start with 0 (the list) and have depth >= 2
    expect(inserts.some(c => c.path.length >= 2 && c.path[0] === 0)).toBe(true)
  })

  it('detects modifying a link text inside a paragraph', () => {
    const old = parse('Check out [old link](https://example.com) here.\n')
    const new_ = parse('Check out [new link](https://example.com) here.\n')
    const cs = diff(old, new_)
    expect(cs.changes.length).toBeGreaterThan(0)
    // Changes should be deep (inside paragraph > link > text)
    const deepChanges = cs.changes.filter(c => c.path.length >= 3)
    expect(deepChanges.length).toBeGreaterThan(0)
  })

  it('detects editing inside a blockquote', () => {
    const old = parse('> Old quote text.\n')
    const new_ = parse('> New quote text.\n')
    const cs = diff(old, new_)
    expect(cs.changes.length).toBeGreaterThan(0)
    // Should recurse into blockquote > paragraph > text
    const deepChanges = cs.changes.filter(c => c.path.length >= 3)
    expect(deepChanges.length).toBeGreaterThan(0)
  })
})

describe('applyChangeSet', () => {
  it('round-trips: apply(diff(a,b), a) == b', () => {
    const oldMd = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n'
    const newMd = '# Title\n\nModified paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n'
    const result = applyToMarkdown(oldMd, computeChangeSet(oldMd, newMd))
    const resultRoot = parse(result)
    const expectedRoot = parse(newMd)
    expect(resultRoot.children.length).toBe(expectedRoot.children.length)
  })

  it('round-trips with nested edits', () => {
    const oldMd = '- item 1\n- item 2\n'
    const newMd = '- item 1\n- item 2\n- item 3\n'
    const oldRoot = parse(oldMd)
    const newRoot = parse(newMd)
    const cs = diff(oldRoot, newRoot)
    const applied = applyChangeSet(oldRoot, cs)
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim())
  })

  it('round-trips text changes within paragraphs', () => {
    const oldMd = '# Hello\n\nOld text here.\n\nKeep this.\n'
    const newMd = '# Hello\n\nNew text here.\n\nKeep this.\n'
    const oldRoot = parse(oldMd)
    const newRoot = parse(newMd)
    const cs = diff(oldRoot, newRoot)
    const applied = applyChangeSet(oldRoot, cs)
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim())
  })

  it('round-trips blockquote edits', () => {
    const oldMd = '> Old quote.\n'
    const newMd = '> New quote.\n'
    const oldRoot = parse(oldMd)
    const newRoot = parse(newMd)
    const cs = diff(oldRoot, newRoot)
    const applied = applyChangeSet(oldRoot, cs)
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim())
  })
})

describe('three-way merge', () => {
  it('merges non-conflicting concurrent edits', () => {
    const base = parse('# Title\n\nParagraph A.\n\nParagraph B.\n')
    const alice = parse('# Title\n\nAlice changed A.\n\nParagraph B.\n')
    const bob = parse('# Title\n\nParagraph A.\n\nParagraph B.\n\nBob added C.\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('Alice changed A')
    expect(md).toContain('Bob added C')
  })

  it('merges concurrent edits to different list items', () => {
    const base = parse('- item A\n- item B\n- item C\n')
    const alice = parse('- item A modified\n- item B\n- item C\n')
    const bob = parse('- item A\n- item B\n- item C modified\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('item A modified')
    expect(md).toContain('item C modified')
  })

  it('merges concurrent edits to different paragraphs', () => {
    const base = parse('Paragraph one.\n\nParagraph two.\n\nParagraph three.\n')
    const alice = parse('Alice one.\n\nParagraph two.\n\nParagraph three.\n')
    const bob = parse('Paragraph one.\n\nParagraph two.\n\nBob three.\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('Alice one')
    expect(md).toContain('Bob three')
  })
})

describe('computeChangeSet / applyToMarkdown', () => {
  it('works with string API', () => {
    const old = '# Doc\n\nHello world.\n'
    const new_ = '# Doc\n\nHello world.\n\nNew section.\n'
    const cs = computeChangeSet(old, new_)
    expect(cs.changes.length).toBeGreaterThan(0)
    const result = applyToMarkdown(old, cs)
    expect(result).toContain('New section')
  })
})
