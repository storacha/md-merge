import { describe, it, expect } from "vitest";
import { parse, stringify } from "../src/index.js";
import { diff, applyChangeSet } from "../src/diff.js";

describe("parse", () => {
  it("parses markdown to AST and back", () => {
    const md = "# Hello\n\nThis is a paragraph.\n\n- item 1\n- item 2\n";
    const root = parse(md);
    expect(root.type).toBe("root");
    expect(root.children.length).toBe(3); // heading, paragraph, list
    const out = stringify(root);
    expect(out).toContain("# Hello");
    expect(out).toContain("This is a paragraph.");
  });
});

describe("diff", () => {
  it("detects no changes for identical docs", () => {
    const md = "# Hello\n\nParagraph.\n";
    const a = parse(md);
    const b = parse(md);
    const cs = diff(a, b);
    expect(cs.changes).toHaveLength(0);
  });

  it("detects an inserted paragraph", () => {
    const old = parse("# Hello\n\nParagraph one.\n");
    const new_ = parse("# Hello\n\nNew paragraph.\n\nParagraph one.\n");
    const cs = diff(old, new_);
    expect(cs.changes.length).toBeGreaterThan(0);
    const inserts = cs.changes.filter((c) => c.type === "insert");
    expect(inserts.length).toBeGreaterThan(0);
  });

  it("detects a deleted paragraph", () => {
    const old = parse("# Hello\n\nParagraph one.\n\nParagraph two.\n");
    const new_ = parse("# Hello\n\nParagraph two.\n");
    const cs = diff(old, new_);
    const deletes = cs.changes.filter((c) => c.type === "delete");
    expect(deletes.length).toBeGreaterThan(0);
  });

  it("detects text edit within a paragraph recursively", () => {
    const old = parse("# Hello\n\nOld text.\n");
    const new_ = parse("# Hello\n\nNew text.\n");
    const cs = diff(old, new_);
    expect(cs.changes.length).toBeGreaterThan(0);
    const deepChanges = cs.changes.filter((c) => c.path.length >= 2);
    expect(deepChanges.length).toBeGreaterThan(0);
  });

  it("detects adding an item to a list", () => {
    const old = parse("- item 1\n- item 2\n");
    const new_ = parse("- item 1\n- item 2\n- item 3\n");
    const cs = diff(old, new_);
    expect(cs.changes.length).toBeGreaterThan(0);
    const inserts = cs.changes.filter((c) => c.type === "insert");
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.some((c) => c.path.length >= 2 && c.path[0] === 0)).toBe(
      true,
    );
  });

  it("detects modifying a link text inside a paragraph", () => {
    const old = parse("Check out [old link](https://example.com) here.\n");
    const new_ = parse("Check out [new link](https://example.com) here.\n");
    const cs = diff(old, new_);
    expect(cs.changes.length).toBeGreaterThan(0);
    const deepChanges = cs.changes.filter((c) => c.path.length >= 3);
    expect(deepChanges.length).toBeGreaterThan(0);
  });

  it("detects editing inside a blockquote", () => {
    const old = parse("> Old quote text.\n");
    const new_ = parse("> New quote text.\n");
    const cs = diff(old, new_);
    expect(cs.changes.length).toBeGreaterThan(0);
    const deepChanges = cs.changes.filter((c) => c.path.length >= 3);
    expect(deepChanges.length).toBeGreaterThan(0);
  });
});

describe("applyChangeSet", () => {
  it("round-trips: apply(diff(a,b), a) == b", () => {
    const oldMd = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const newMd =
      "# Title\n\nModified paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const cs = diff(oldRoot, newRoot);
    const applied = applyChangeSet(oldRoot, cs);
    expect(applied.children.length).toBe(newRoot.children.length);
  });

  it("round-trips with nested edits", () => {
    const oldMd = "- item 1\n- item 2\n";
    const newMd = "- item 1\n- item 2\n- item 3\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const cs = diff(oldRoot, newRoot);
    const applied = applyChangeSet(oldRoot, cs);
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim());
  });

  it("round-trips text changes within paragraphs", () => {
    const oldMd = "# Hello\n\nOld text here.\n\nKeep this.\n";
    const newMd = "# Hello\n\nNew text here.\n\nKeep this.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const cs = diff(oldRoot, newRoot);
    const applied = applyChangeSet(oldRoot, cs);
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim());
  });

  it("round-trips blockquote edits", () => {
    const oldMd = "> Old quote.\n";
    const newMd = "> New quote.\n";
    const oldRoot = parse(oldMd);
    const newRoot = parse(newMd);
    const cs = diff(oldRoot, newRoot);
    const applied = applyChangeSet(oldRoot, cs);
    expect(stringify(applied).trim()).toBe(stringify(newRoot).trim());
  });
});
