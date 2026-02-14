import { describe, it, expect } from 'vitest'
import { parse, stringify, diff } from '../src/index.js'
import { threeWayMerge } from '../src/merge.js'

describe('three-way merge with RGA (concurrent operations)', () => {
  it('merges concurrent list item additions', () => {
    const base = parse('- item 1\n- item 2\n')
    const alice = parse('- item 1\n- item 1.5 alice\n- item 2\n')
    const bob = parse('- item 1\n- item 2\n- item 3 bob\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('item 1')
    expect(md).toContain('item 1.5 alice')
    expect(md).toContain('item 2')
    expect(md).toContain('item 3 bob')
  })

  it('merges concurrent paragraph insertions at same location', () => {
    const base = parse('# Title\n\nExisting paragraph.\n')
    const alice = parse('# Title\n\nAlice added this.\n\nExisting paragraph.\n')
    const bob = parse('# Title\n\nBob added this.\n\nExisting paragraph.\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('Title')
    expect(md).toContain('Alice added this')
    expect(md).toContain('Bob added this')
    expect(md).toContain('Existing paragraph')
  })

  it('merges concurrent additions at end of document', () => {
    const base = parse('# Doc\n\nBase content.\n')
    const alice = parse('# Doc\n\nBase content.\n\nAlice ending.\n')
    const bob = parse('# Doc\n\nBase content.\n\nBob ending.\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('Base content')
    expect(md).toContain('Alice ending')
    expect(md).toContain('Bob ending')
  })

  it('handles one side inserting and the other deleting different items', () => {
    const base = parse('# Title\n\nPara A.\n\nPara B.\n\nPara C.\n')
    // Alice deletes Para B
    const alice = parse('# Title\n\nPara A.\n\nPara C.\n')
    // Bob adds Para D after C
    const bob = parse('# Title\n\nPara A.\n\nPara B.\n\nPara C.\n\nPara D.\n')

    const csA = diff(base, alice)
    const csB = diff(base, bob)
    const merged = threeWayMerge(base, csA, csB, 1, 2)

    const md = stringify(merged)
    expect(md).toContain('Para A')
    expect(md).not.toContain('Para B')
    expect(md).toContain('Para C')
    expect(md).toContain('Para D')
  })

  // Existing tests should still work through new merge path
  it('merges non-conflicting concurrent edits (existing behavior)', () => {
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
})
