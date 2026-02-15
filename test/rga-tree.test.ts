import { describe, it, expect } from 'vitest'
import { parse, stringify } from '../src/parse.js'
import { toRGATree, toMdast, type RGATreeRoot, type RGAParentNode } from '../src/rga-tree.js'
import { RGA, type ReplicaId } from '../src/crdt/rga.js'

const r1 = 'r1' as ReplicaId

describe('RGA Tree', () => {
  it('converts a simple document and back', () => {
    const md = '# Hello\n\nThis is a paragraph.\n\n- item 1\n- item 2\n'
    const root = parse(md)
    const rgaTree = toRGATree(root, r1)

    // Root children should be an RGA
    expect(rgaTree.children).toBeInstanceOf(RGA)
    expect(rgaTree.children.toArray()).toHaveLength(3) // heading, paragraph, list

    // Round-trip back to mdast
    const back = toMdast(rgaTree)
    expect(stringify(back).trim()).toBe(stringify(root).trim())
  })

  it('converts nested structures (list items)', () => {
    const md = '- item 1\n- item 2\n- item 3\n'
    const root = parse(md)
    const rgaTree = toRGATree(root, r1)

    // Root -> list -> list items
    const list = rgaTree.children.toArray()[0] as RGAParentNode
    expect(list.type).toBe('list')
    expect(list.children).toBeInstanceOf(RGA)
    expect(list.children.toArray()).toHaveLength(3)

    // Each list item's children should also be RGA
    const item = list.children.toArray()[0] as RGAParentNode
    expect(item.type).toBe('listItem')
    expect(item.children).toBeInstanceOf(RGA)

    // Round-trip
    const back = toMdast(rgaTree)
    expect(stringify(back).trim()).toBe(stringify(root).trim())
  })

  it('converts deeply nested structures (blockquote > paragraph > inline)', () => {
    const md = '> This has **bold** and *italic* text.\n'
    const root = parse(md)
    const rgaTree = toRGATree(root, r1)

    // blockquote > paragraph > [text, strong, text, emphasis, text]
    const bq = rgaTree.children.toArray()[0] as RGAParentNode
    expect(bq.type).toBe('blockquote')
    const para = bq.children.toArray()[0] as RGAParentNode
    expect(para.type).toBe('paragraph')
    expect(para.children).toBeInstanceOf(RGA)

    const back = toMdast(rgaTree)
    expect(stringify(back).trim()).toBe(stringify(root).trim())
  })

  it('handles a complex document', () => {
    const md = `# Title

First paragraph with **bold** and [a link](https://example.com).

## Section 2

- item a
- item b
  - nested 1
  - nested 2

> A blockquote with *emphasis*.

| col1 | col2 |
| ---- | ---- |
| a    | b    |
| c    | d    |
`
    const root = parse(md)
    const rgaTree = toRGATree(root, r1)
    const back = toMdast(rgaTree)
    expect(stringify(back).trim()).toBe(stringify(root).trim())
  })

  it('preserves node properties (heading depth, link url, etc.)', () => {
    const md = '## Heading 2\n\n[link text](https://example.com)\n'
    const root = parse(md)
    const rgaTree = toRGATree(root, r1)

    const heading = rgaTree.children.toArray()[0] as RGAParentNode
    expect(heading.type).toBe('heading')
    expect(heading.depth).toBe(2)

    const para = rgaTree.children.toArray()[1] as RGAParentNode
    const link = para.children.toArray()[0] as RGAParentNode
    expect(link.type).toBe('link')
    expect(link.url).toBe('https://example.com')

    const back = toMdast(rgaTree)
    expect(stringify(back).trim()).toBe(stringify(root).trim())
  })
})
