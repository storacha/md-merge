import type { RootContent, Root } from 'mdast'
import type { CID } from 'multiformats'

/** A change operation on a markdown document */
export interface MdChangeOp {
  type: 'apply'
  ts: number
  apply: CID
}

/** A changeset describing diffs between two mdast versions */
export interface ChangeSet {
  changes: Change[]
}

/** A single change at any depth in the mdast tree */
export interface Change {
  type: 'insert' | 'delete' | 'modify'
  /** Path into the tree, e.g. [2, 1, 0] = root.children[2].children[1].children[0] */
  path: number[]
  /** For insert/modify: the new mdast node(s) */
  nodes?: RootContent[]
  /** For modify: what it was before (for conflict detection) */
  before?: RootContent[]
}

/** A fingerprinted block — a top-level mdast node with its markdown string */
export interface FingerprintedBlock {
  node: RootContent
  fingerprint: string
}

/** Document state: an ordered list of top-level mdast blocks */
export interface DocState {
  root: Root
}
