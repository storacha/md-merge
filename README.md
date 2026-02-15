# md-merge

CRDT-based markdown merging using RGA-backed mdast trees.

Every `children` array in a markdown AST is replaced with an [RGA](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type#Sequence_CRDTs) (Replicated Growable Array), giving deterministic merge semantics at every nesting level — paragraphs, list items, inline formatting, everything.

No three-way merge needed. The RGA *is* the history.

## How it works

1. **Parse** markdown to an [mdast](https://github.com/syntax-tree/mdast) tree
2. **Convert** to an RGA-backed tree (`RGATree`) — each `children` array becomes an RGA with unique node IDs and causal ordering
3. **Edit** by generating `RGAChangeSet`s from new markdown — diffs are resolved to RGA node IDs, not array indices
4. **Merge** by applying each peer's changesets — RGA semantics handle concurrent inserts/deletes deterministically
5. **Serialize** trees and changesets to DAG-CBOR for storage and exchange

## Install

```
npm install md-merge
```

## Usage

### Bootstrap a tree from markdown

```typescript
import { parse, toRGATree, toMdast, stringify } from 'md-merge'
import type { RGAEvent, EventComparator } from 'md-merge'

// Define your event type (identifies who made each edit)
class MyEvent implements RGAEvent {
  constructor(readonly name: string) {}
  toString() { return this.name }
}

const compare: EventComparator<MyEvent> = (a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

// Create an RGA tree
const tree = toRGATree(parse('# Hello\n\nWorld.\n'), new MyEvent('alice'), compare)

// Convert back to markdown
stringify(toMdast(tree)) // '# Hello\n\nWorld.\n'
```

### Generate and apply changesets

```typescript
import { generateRGAChangeSet, applyRGAChangeSet } from 'md-merge'

const aliceEdit = new MyEvent('alice-v2')
const newDoc = parse('# Hello\n\nWorld.\n\nNew paragraph.\n')

// Generate an RGA-addressed changeset (uses node IDs, not indices)
const changeset = generateRGAChangeSet(tree, newDoc, aliceEdit)

// Apply it
const updated = applyRGAChangeSet(tree, changeset, compare)
stringify(toMdast(updated)) // '# Hello\n\nWorld.\n\nNew paragraph.\n'
```

### Merge concurrent edits

```typescript
// Alice and Bob both start from the same tree
// Alice adds a paragraph, Bob deletes one — each generates a changeset

const aliceCS = generateRGAChangeSet(tree, aliceNewDoc, aliceEvent)
const bobCS = generateRGAChangeSet(tree, bobNewDoc, bobEvent)

// Apply both — order doesn't matter, result converges
let merged = applyRGAChangeSet(tree, aliceCS, compare)
merged = applyRGAChangeSet(merged, bobCS, compare)

// Or the other way — same result
let merged2 = applyRGAChangeSet(tree, bobCS, compare)
merged2 = applyRGAChangeSet(merged2, aliceCS, compare)
```

### Serialize to DAG-CBOR

```typescript
import { encodeTree, decodeTree, encodeChangeSet, decodeChangeSet } from 'md-merge'

// Encode a tree to a content-addressed block
const block = await encodeTree(tree)
block.cid    // CID of the block
block.bytes  // Uint8Array of DAG-CBOR

// Decode it back (provide event parser + fingerprint fn + comparator)
const decoded = await decodeTree(
  { bytes: block.bytes },
  s => new MyEvent(s),    // parseEvent
  fingerprintFn,           // node fingerprint function
  compare,
)

// Same for changesets
const csBlock = await encodeChangeSet(changeset)
const decodedCS = await decodeChangeSet({ bytes: csBlock.bytes }, s => new MyEvent(s))
```

## Architecture

```
markdown string
    ↓ parse()
  mdast Root
    ↓ toRGATree(root, event, compare)
  RGATreeRoot ← every children[] is now an RGA
    ↓ generateRGAChangeSet(tree, newMdast, event)
  RGAChangeSet ← ID-addressed ops (no array indices)
    ↓ applyRGAChangeSet(tree, changeset, compare)
  RGATreeRoot (updated)
    ↓ toMdast(tree)
  mdast Root
    ↓ stringify()
markdown string
```

### Key types

| Type | Description |
|------|-------------|
| `RGATreeRoot<E>` | Root node with RGA-backed children |
| `RGAChangeSet<E>` | Set of ID-addressed changes + the event that produced them |
| `RGAChange<E>` | Single op: insert/delete/modify with `parentPath`, `targetId`, `afterId` |
| `RGA<T, E>` | Replicated Growable Array — ordered CRDT sequence |
| `RGANodeId<E>` | `{ uuid, event }` — unique ID for each node |
| `RGAEvent` | Interface for event types (just needs `toString()`) |

### Why no three-way merge?

Traditional text merge needs a common ancestor to figure out what changed on each side. With RGA, every node carries its causal history (who inserted it, after which predecessor). Two RGA trees can be merged by applying each other's operations — concurrent inserts land deterministically based on event ordering, and tombstoned deletes are idempotent.

## API Reference

### Parsing
- `parse(markdown: string): Root` — parse markdown to mdast
- `stringify(root: Root): string` — serialize mdast to markdown
- `fingerprint(node: RootContent): string` — content hash of a node

### Diffing (index-based, internal)
- `diff(oldRoot, newRoot): ChangeSet` — LCS-based mdast diff
- `applyChangeSet(root, changeset): Root` — apply index-based changes

### RGA Tree
- `toRGATree(root, event, compare): RGATreeRoot` — convert mdast to RGA tree
- `toMdast(rgaRoot): Root` — convert RGA tree back to mdast
- `applyMdastToRGATree(existing, newRoot, event, compare): RGATreeRoot` — shorthand for generate + apply
- `generateRGAChangeSet(existing, newRoot, event): RGAChangeSet` — diff and resolve to RGA IDs
- `applyRGAChangeSet(root, changeset, compare): RGATreeRoot` — apply ID-addressed changes

### Codec (DAG-CBOR)
- `encodeTree(root): Promise<Block>` — serialize RGA tree
- `decodeTree(block, parseEvent, fpFn, compare): Promise<RGATreeRoot>` — deserialize
- `encodeChangeSet(cs): Promise<Block>` — serialize changeset
- `decodeChangeSet(block, parseEvent): Promise<RGAChangeSet>` — deserialize

## License

MIT — see [LICENSE.md](./LICENSE.md)
