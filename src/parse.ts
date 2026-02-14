import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { Root, RootContent } from 'mdast'

const parser = unified().use(remarkParse)
const stringifier = unified().use(remarkStringify)

/** Parse markdown string into mdast Root */
export function parse(markdown: string): Root {
  return parser.parse(markdown)
}

/** Stringify an mdast Root back to markdown */
export function stringify(root: Root): string {
  return stringifier.stringify(root)
}

/** Stringify a single mdast node by wrapping in a temporary root */
export function stringifyNode(node: RootContent): string {
  const tempRoot: Root = { type: 'root', children: [node] }
  return stringify(tempRoot).trim()
}

/** Fingerprint a top-level mdast node by stringifying it */
export function fingerprint(node: RootContent): string {
  return stringifyNode(node)
}
