/**
 * UCN integration — types and helpers for using md-ucn with @storacha/ucn/base.
 * 
 * The actual UCN Revision APIs require a blockstore and network context,
 * so this module provides the type-level integration and helper functions
 * for creating operations compatible with the UCN CRDT framework.
 */

import type { CID } from 'multiformats'
import type { MdChangeOp, ChangeSet } from './types.js'
import type { Root } from 'mdast'
import { diff, applyChangeSet } from './diff.js'
import { parse, stringify } from './parse.js'

/**
 * Create an MdChangeOp from a ChangeSet CID.
 * The ChangeSet itself should be stored as a DAG-CBOR block in the blockstore.
 */
export function createOp(changeSetCid: CID, timestamp?: number): MdChangeOp {
  return {
    type: 'apply',
    ts: timestamp ?? Date.now(),
    apply: changeSetCid,
  }
}

/**
 * Compute a changeset between two markdown strings.
 */
export function computeChangeSet(oldMarkdown: string, newMarkdown: string): ChangeSet {
  const oldRoot = parse(oldMarkdown)
  const newRoot = parse(newMarkdown)
  return diff(oldRoot, newRoot)
}

/**
 * Apply a changeset to a markdown string, returning new markdown.
 */
export function applyToMarkdown(markdown: string, changeset: ChangeSet): string {
  const root = parse(markdown)
  const newRoot = applyChangeSet(root, changeset)
  return stringify(newRoot)
}

/**
 * Example of how UCN integration would work (type-level illustration):
 * 
 * ```ts
 * import { Revision } from '@storacha/ucn/base'
 * import * as dagCbor from '@ipld/dag-cbor'
 * 
 * // Store changeset as a block
 * const csBytes = dagCbor.encode(changeset)
 * const csCid = await blockstore.put(csBytes)
 * 
 * // Create UCN revision
 * const op: MdChangeOp = createOp(csCid)
 * const rev = Revision.v0<MdChangeOp>(op)
 * 
 * // Increment
 * const nextOp: MdChangeOp = createOp(nextCsCid)
 * const rev2 = Revision.increment<MdChangeOp>(rev, nextOp)
 * ```
 */
