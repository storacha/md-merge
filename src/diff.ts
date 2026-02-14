import type { Root, RootContent } from 'mdast'
import type { ChangeSet, Change } from './types.js'
import { fingerprint } from './parse.js'

/** Check if a node has children */
function hasChildren(node: unknown): node is { type: string; children: unknown[] } {
  return (
    node != null &&
    typeof node === 'object' &&
    'children' in node &&
    Array.isArray((node as Record<string, unknown>).children)
  )
}

function nodeType(node: unknown): string {
  return (node as { type: string }).type
}

/**
 * Compute LCS table for two string arrays.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1])
      }
    }
  }
  return table
}

/**
 * Extract LCS matches from the table.
 * Returns array of [oldIndex, newIndex] pairs.
 */
function lcsMatches(aFp: string[], bFp: string[], table: number[][]): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  let i = aFp.length
  let j = bFp.length
  while (i > 0 && j > 0) {
    if (aFp[i - 1] === bFp[j - 1]) {
      matches.push([i - 1, j - 1])
      i--
      j--
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  matches.reverse()
  return matches
}

function fpChild(node: unknown): string {
  return fingerprint(node as RootContent)
}

/**
 * Diff the gap between LCS matches: unmatched old/new nodes.
 * Pairs same-type nodes for recursive descent; remainder are insert/delete.
 */
function diffGap(
  oldNodes: unknown[],
  newNodes: unknown[],
  oldStartIdx: number,
  newStartIdx: number,
  pathPrefix: number[],
): Change[] {
  const changes: Change[] = []

  // Try to pair same-type nodes sequentially for recursive diffing
  let oi = 0
  let ni = 0
  while (oi < oldNodes.length && ni < newNodes.length) {
    const oldNode = oldNodes[oi]
    const newNode = newNodes[ni]
    if (nodeType(oldNode) === nodeType(newNode) && hasChildren(oldNode) && hasChildren(newNode)) {
      // Same type with children — recurse
      const childChanges = diffChildren(
        oldNode.children,
        newNode.children,
        [...pathPrefix, newStartIdx + ni],
      )
      changes.push(...childChanges)
      oi++
      ni++
    } else if (nodeType(oldNode) === nodeType(newNode)) {
      // Same type leaf but different content — modify
      changes.push({
        type: 'modify',
        path: [...pathPrefix, newStartIdx + ni],
        nodes: [newNode as RootContent],
        before: [oldNode as RootContent],
      })
      oi++
      ni++
    } else {
      // Different types — delete old, insert new
      changes.push({
        type: 'delete',
        path: [...pathPrefix, oldStartIdx + oi],
        nodes: [oldNode as RootContent],
      })
      oi++
    }
  }
  // Remaining old = deletes
  while (oi < oldNodes.length) {
    changes.push({
      type: 'delete',
      path: [...pathPrefix, oldStartIdx + oi],
      nodes: [oldNodes[oi] as RootContent],
    })
    oi++
  }
  // Remaining new = inserts
  while (ni < newNodes.length) {
    changes.push({
      type: 'insert',
      path: [...pathPrefix, newStartIdx + ni],
      nodes: [newNodes[ni] as RootContent],
    })
    ni++
  }
  return changes
}

/**
 * Recursively diff two arrays of child nodes at a given path prefix.
 */
function diffChildren(
  oldChildren: unknown[],
  newChildren: unknown[],
  pathPrefix: number[],
): Change[] {
  const oldFp = oldChildren.map(fpChild)
  const newFp = newChildren.map(fpChild)
  const table = lcsTable(oldFp, newFp)
  const matches = lcsMatches(oldFp, newFp, table)

  const changes: Change[] = []

  // Process gaps between matches
  let prevOld = 0
  let prevNew = 0

  for (const [oi, ni] of matches) {
    // Gap before this match
    if (oi > prevOld || ni > prevNew) {
      const oldGap = oldChildren.slice(prevOld, oi)
      const newGap = newChildren.slice(prevNew, ni)
      changes.push(...diffGap(oldGap, newGap, prevOld, prevNew, pathPrefix))
    }
    // Matched node — identical fingerprints, no changes needed
    prevOld = oi + 1
    prevNew = ni + 1
  }

  // Trailing gap after last match
  if (prevOld < oldChildren.length || prevNew < newChildren.length) {
    const oldGap = oldChildren.slice(prevOld)
    const newGap = newChildren.slice(prevNew)
    changes.push(...diffGap(oldGap, newGap, prevOld, prevNew, pathPrefix))
  }

  return changes
}

/**
 * Diff two mdast Root nodes recursively.
 */
export function diff(oldRoot: Root, newRoot: Root): ChangeSet {
  const changes = diffChildren(oldRoot.children, newRoot.children, [])
  return { changes }
}

function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

function navigateToParent(root: Root, path: number[]): { siblings: unknown[]; index: number } | null {
  if (path.length === 0) return null
  let current: unknown = root
  for (let i = 0; i < path.length - 1; i++) {
    if (!hasChildren(current)) return null
    current = (current as { children: unknown[] }).children[path[i]]
  }
  if (!hasChildren(current)) return null
  return { siblings: (current as { children: unknown[] }).children, index: path[path.length - 1] }
}

/**
 * Apply a changeset to a root, producing a new root.
 * Deep-clones the tree, then applies changes deepest-first to avoid index shifting.
 */
export function applyChangeSet(root: Root, changeset: ChangeSet): Root {
  const newRoot: Root = JSON.parse(JSON.stringify(root))

  // Sort: deepest first, then higher indices first to avoid shifting
  const sorted = [...changeset.changes].sort((a, b) => {
    if (a.path.length !== b.path.length) return b.path.length - a.path.length
    return -comparePaths(a.path, b.path)
  })

  for (const change of sorted) {
    const nav = navigateToParent(newRoot, change.path)
    if (!nav) continue
    const { siblings, index } = nav

    switch (change.type) {
      case 'insert':
        siblings.splice(index, 0, ...(change.nodes ?? []))
        break
      case 'delete':
        siblings.splice(index, 1)
        break
      case 'modify':
        siblings.splice(index, 1, ...(change.nodes ?? []))
        break
    }
  }

  return newRoot
}
