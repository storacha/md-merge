import { describe, it, expect } from "vitest";
import { parse, stringify } from "../src/parse.js";
import { toRGATree, toMdast, applyMdastToRGATree } from "../src/rga-tree.js";
import {
  RGA,
  type RGAEvent,
  type EventComparator,
  type RGAParentNode,
} from "../src/types.js";

class TestEvent implements RGAEvent {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

const cmp: EventComparator<TestEvent> = (a, b) => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

const r1 = new TestEvent("r1");

describe("RGA Tree", () => {
  it("converts a simple document and back", () => {
    const md = "# Hello\n\nThis is a paragraph.\n\n- item 1\n- item 2\n";
    const root = parse(md);
    const rgaTree = toRGATree(root, r1, cmp);

    expect(rgaTree.children).toBeInstanceOf(RGA);
    expect(rgaTree.children.toArray()).toHaveLength(3);

    const back = toMdast(rgaTree);
    expect(stringify(back).trim()).toBe(stringify(root).trim());
  });

  it("converts nested structures (list items)", () => {
    const md = "- item 1\n- item 2\n- item 3\n";
    const root = parse(md);
    const rgaTree = toRGATree(root, r1, cmp);

    const list = rgaTree.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(list.type).toBe("list");
    expect(list.children).toBeInstanceOf(RGA);
    expect(list.children.toArray()).toHaveLength(3);

    const item = list.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(item.type).toBe("listItem");
    expect(item.children).toBeInstanceOf(RGA);

    const back = toMdast(rgaTree);
    expect(stringify(back).trim()).toBe(stringify(root).trim());
  });

  it("converts deeply nested structures (blockquote > paragraph > inline)", () => {
    const md = "> This has **bold** and *italic* text.\n";
    const root = parse(md);
    const rgaTree = toRGATree(root, r1, cmp);

    const bq = rgaTree.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(bq.type).toBe("blockquote");
    const para = bq.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(para.type).toBe("paragraph");
    expect(para.children).toBeInstanceOf(RGA);

    const back = toMdast(rgaTree);
    expect(stringify(back).trim()).toBe(stringify(root).trim());
  });

  it("handles a complex document", () => {
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
`;
    const root = parse(md);
    const rgaTree = toRGATree(root, r1, cmp);
    const back = toMdast(rgaTree);
    expect(stringify(back).trim()).toBe(stringify(root).trim());
  });

  it("preserves node properties (heading depth, link url, etc.)", () => {
    const md = "## Heading 2\n\n[link text](https://example.com)\n";
    const root = parse(md);
    const rgaTree = toRGATree(root, r1, cmp);

    const heading = rgaTree.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(heading.type).toBe("heading");
    expect(heading.depth).toBe(2);

    const para = rgaTree.children.toArray()[1] as RGAParentNode<TestEvent>;
    const link = para.children.toArray()[0] as RGAParentNode<TestEvent>;
    expect(link.type).toBe("link");
    expect(link.url).toBe("https://example.com");

    const back = toMdast(rgaTree);
    expect(stringify(back).trim()).toBe(stringify(root).trim());
  });
});

describe("applyMdast", () => {
  it("preserves IDs for unchanged nodes", () => {
    const md = "# Hello\n\nParagraph one.\n\nParagraph two.\n";
    const root = parse(md);
    const tree = toRGATree(root, r1, cmp);

    // Get original node IDs
    const origIds = tree.children.toNodes().map((n) => n.id);

    // Apply identical document — all IDs should be preserved
    const updated = applyMdastToRGATree(tree, root, r1, cmp);
    const newIds = updated.children.toNodes().map((n) => n.id);
    expect(newIds).toEqual(origIds);
  });

  it("preserves IDs for unchanged nodes when adding a paragraph", () => {
    const oldMd = "# Hello\n\nParagraph one.\n";
    const newMd = "# Hello\n\nParagraph one.\n\nParagraph two.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const tree = toRGATree(oldRoot, r1, cmp);

    const origIds = tree.children.toNodes().map((n) => n.id);

    const r2 = new TestEvent("r2");
    const updated = applyMdastToRGATree(tree, newRoot, r2, cmp);
    const newNodes = updated.children.toNodes();

    // Original nodes should keep their IDs
    expect(newNodes[0].id).toEqual(origIds[0]); // heading
    expect(newNodes[1].id).toEqual(origIds[1]); // paragraph one

    // New node should have the new event
    expect(newNodes[2].id.event.name).toBe("r2");

    // Round-trip back to markdown
    const result = toMdast(updated);
    expect(stringify(result).trim()).toBe(stringify(newRoot).trim());
  });

  it("preserves IDs when deleting a paragraph", () => {
    const oldMd = "# Hello\n\nParagraph one.\n\nParagraph two.\n";
    const newMd = "# Hello\n\nParagraph two.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const tree = toRGATree(oldRoot, r1, cmp);

    const origNodes = tree.children.toNodes();

    const r2 = new TestEvent("r2");
    const updated = applyMdastToRGATree(tree, newRoot, r2, cmp);
    const newNodes = updated.children.toNodes();

    // Heading and paragraph two should keep IDs
    expect(newNodes[0].id).toEqual(origNodes[0].id); // heading
    expect(newNodes[1].id).toEqual(origNodes[2].id); // paragraph two (was index 2)

    const result = toMdast(updated);
    expect(stringify(result).trim()).toBe(stringify(newRoot).trim());
  });

  it("handles nested changes (adding a list item)", () => {
    const oldMd = "- item 1\n- item 2\n";
    const newMd = "- item 1\n- item 2\n- item 3\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const tree = toRGATree(oldRoot, r1, cmp);

    const r2 = new TestEvent("r2");
    const updated = applyMdastToRGATree(tree, newRoot, r2, cmp);

    const result = toMdast(updated);
    expect(stringify(result).trim()).toBe(stringify(newRoot).trim());
  });

  it("round-trips a modify operation", () => {
    const oldMd = "# Hello\n\nOld text.\n";
    const newMd = "# Hello\n\nNew text.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const tree = toRGATree(oldRoot, r1, cmp);

    const origHeadingId = tree.children.toNodes()[0].id;

    const r2 = new TestEvent("r2");
    const updated = applyMdastToRGATree(tree, newRoot, r2, cmp);
    const newNodes = updated.children.toNodes();

    // Heading should be preserved
    expect(newNodes[0].id).toEqual(origHeadingId);

    const result = toMdast(updated);
    expect(stringify(result).trim()).toBe(stringify(newRoot).trim());
  });
});
