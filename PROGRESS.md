# @storacha/md-ucn — Progress

## Status: ✅ Working

- **tsc --noEmit**: passes cleanly
- **vitest**: 8/8 tests pass

## What's built

| File | Purpose |
|------|---------|
| `src/types.ts` | Core types: MdChangeOp, ChangeSet, Change |
| `src/parse.ts` | remark parse/stringify, node fingerprinting |
| `src/diff.ts` | LCS-based mdast block-level diffing + applyChangeSet |
| `src/merge.ts` | Three-way merge with LWW conflict resolution |
| `src/ucn.ts` | UCN integration helpers (createOp, computeChangeSet, applyToMarkdown) |
| `src/index.ts` | Public API re-exports |
| `test/diff.test.ts` | Tests for parse, diff, apply, merge, string API |

## Architecture decisions

- **Block-level diffing**: Diffs operate on top-level mdast children (paragraphs, headings, lists). Each block is fingerprinted by stringifying back to markdown, then LCS finds the alignment.
- **Modify detection**: Adjacent delete+insert pairs in the LCS diff are collapsed into "modify" changes for cleaner changesets.
- **Three-way merge**: Non-conflicting changes from both sides are applied. Conflicts (same index) resolved by timestamp (last-writer-wins).
- **UCN integration**: Typed but not wired to actual blockstore. `createOp()` produces `MdChangeOp` with a CID reference to a stored ChangeSet block. The docstring in `ucn.ts` shows the full Revision workflow.

## Next steps

- Wire up actual `@storacha/ucn/base` Revision creation (needs blockstore)
- Store ChangeSet blocks as DAG-CBOR
- Handle sub-block (inline) diffs for finer granularity
- Operational transform for index shifting in concurrent merges
