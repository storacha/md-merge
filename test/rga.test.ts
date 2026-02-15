import { describe, it, expect } from "vitest";
import { RGA, type RGAEvent, type EventComparator } from "../src/crdt/rga.js";

const strFp = (s: string) => s;

/** Simple string event for tests */
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
const r2 = new TestEvent("r2");
const base = new TestEvent("base");

describe("RGA basic operations", () => {
  it("inserts elements in order", () => {
    const rga = new RGA<string, TestEvent>(strFp, cmp);
    const id1 = rga.insert(undefined, "a", r1);
    const id2 = rga.insert(id1, "b", r1);
    rga.insert(id2, "c", r1);
    expect(rga.toArray()).toEqual(["a", "b", "c"]);
  });

  it("deletes elements (tombstone)", () => {
    const rga = new RGA<string, TestEvent>(strFp, cmp);
    const id1 = rga.insert(undefined, "a", r1);
    const id2 = rga.insert(id1, "b", r1);
    rga.insert(id2, "c", r1);
    rga.delete(id2);
    expect(rga.toArray()).toEqual(["a", "c"]);
  });

  it("fromArray creates correct sequence", () => {
    const rga = RGA.fromArray(["x", "y", "z"], r1, strFp, cmp);
    expect(rga.toArray()).toEqual(["x", "y", "z"]);
  });

  it("each insert gets a unique ID", () => {
    const rga = new RGA<string, TestEvent>(strFp, cmp);
    const id1 = rga.insert(undefined, "a", r1);
    const id2 = rga.insert(undefined, "a", r1);
    expect(id1.uuid).not.toBe(id2.uuid);
    expect(rga.toArray()).toHaveLength(2);
  });

  it("IDs contain the event", () => {
    const rga = new RGA<string, TestEvent>(strFp, cmp);
    const id = rga.insert(undefined, "a", r1);
    expect(id.event).toBe(r1);
    expect(id.event.name).toBe("r1");
  });
});

describe("RGA merge", () => {
  it("concurrent inserts tiebreak by event", () => {
    const b = RGA.fromArray(["a", "c"], base, strFp, cmp);
    const aId = b.toNodes()[0].id;

    const rep1 = new RGA<string, TestEvent>(strFp, cmp);
    for (const [k, n] of b.nodes) rep1.nodes.set(k, { ...n });
    rep1.insert(aId, "from-r1", r1);

    const rep2 = new RGA<string, TestEvent>(strFp, cmp);
    for (const [k, n] of b.nodes) rep2.nodes.set(k, { ...n });
    rep2.insert(aId, "from-r2", r2);

    rep1.merge(rep2);
    const result = rep1.toArray();
    expect(result).toContain("a");
    expect(result).toContain("from-r1");
    expect(result).toContain("from-r2");
    expect(result).toContain("c");
    expect(result.length).toBe(4);
    expect(result[0]).toBe("a");
    expect(result.indexOf("from-r1")).toBeLessThan(result.indexOf("from-r2"));
  });

  it("merge is commutative", () => {
    const b = RGA.fromArray(["a", "c"], base, strFp, cmp);
    const aId = b.toNodes()[0].id;

    const makeReplica = () => {
      const r = new RGA<string, TestEvent>(strFp, cmp);
      for (const [k, n] of b.nodes) r.nodes.set(k, { ...n });
      return r;
    };

    const rep1 = makeReplica();
    const b1Id = rep1.insert(aId, "b1", r1);

    const rep2 = makeReplica();
    const b2Id = rep2.insert(aId, "b2", r2);

    const m1 = makeReplica();
    m1.nodes.set(
      `${b1Id.uuid}:${b1Id.event}`,
      rep1.nodes.get(`${b1Id.uuid}:${b1Id.event}`)!,
    );
    m1.nodes.set(
      `${b2Id.uuid}:${b2Id.event}`,
      rep2.nodes.get(`${b2Id.uuid}:${b2Id.event}`)!,
    );

    const m2 = makeReplica();
    m2.nodes.set(
      `${b2Id.uuid}:${b2Id.event}`,
      rep2.nodes.get(`${b2Id.uuid}:${b2Id.event}`)!,
    );
    m2.nodes.set(
      `${b1Id.uuid}:${b1Id.event}`,
      rep1.nodes.get(`${b1Id.uuid}:${b1Id.event}`)!,
    );

    expect(m1.toArray()).toEqual(m2.toArray());
  });

  it("merges concurrent insert + delete", () => {
    const b = RGA.fromArray(["a", "b", "c"], base, strFp, cmp);
    const bId = b.toNodes()[1].id;

    const rep1 = new RGA<string, TestEvent>(strFp, cmp);
    for (const [k, n] of b.nodes) rep1.nodes.set(k, { ...n });
    rep1.delete(bId);

    const rep2 = new RGA<string, TestEvent>(strFp, cmp);
    for (const [k, n] of b.nodes) rep2.nodes.set(k, { ...n });
    rep2.insert(bId, "x", r2);

    rep1.merge(rep2);
    const result = rep1.toArray();
    expect(result).toContain("a");
    expect(result).not.toContain("b");
    expect(result).toContain("x");
    expect(result).toContain("c");
  });
});
