import { describe, expect, it } from "vitest";
import { chipGroups, type Facet, type Filters, isFiltering, offered, parseFilters, passes, toggled } from "./facets.ts";

interface Item {
  readonly id: string;
  readonly kind: string;
  readonly tags: ReadonlyArray<string>;
  readonly hot: boolean;
}
const items: ReadonlyArray<Item> = [
  { id: "a", kind: "x", tags: ["t1", "t2"], hot: true },
  { id: "b", kind: "x", tags: ["t1"], hot: false },
  { id: "c", kind: "y", tags: [], hot: false },
  { id: "d", kind: "y", tags: ["t3"], hot: true },
];
const FACETS: ReadonlyArray<Facet<Item>> = [
  { key: "kind", label: "Kind", values: (i) => [i.kind], order: ["y", "x"], labelOf: (v) => v.toUpperCase() },
  { key: "tag", label: "Tag", values: (i) => i.tags, max: 2 },
  { key: "hot", label: "Hot", values: (i) => (i.hot ? ["hot"] : []) },
];
const none: Filters = { query: "", picked: {}, sort: "a" };
const with_ = (picked: Filters["picked"], query = ""): Filters => ({ ...none, picked, query });
const all = () => true;

describe("chipGroups", () => {
  it("counts each chip against the other facets and the search, in the facet's order, with labels", () => {
    const g = chipGroups(items, FACETS, {}, all);
    expect(g.map((x) => [x.key, x.chips.map((c) => [c.label, c.count])])).toEqual([
      ["kind", [["Y", 2], ["X", 2]]],
      ["tag", [["t1", 2], ["t2", 1]]],
      ["hot", [["hot", 2]]],
    ]);
  });
  it("a chip's count ignores its own facet, so a second pick in the same facet still shows what it adds", () => {
    const g = chipGroups(items, FACETS, { kind: ["x"], hot: ["hot"] }, all);
    expect(g.find((x) => x.key === "kind")!.chips.map((c) => c.count)).toEqual([1, 1]);
    expect(g.find((x) => x.key === "tag")!.chips.map((c) => c.count)).toEqual([1, 1]);
    expect(g.find((x) => x.key === "hot")!.chips.map((c) => c.count)).toEqual([1]);
  });
  it("the search narrows the counts but never which chips are offered", () => {
    const g = chipGroups(items, FACETS, {}, (i) => i.id === "c");
    expect(g.map((x) => [x.key, x.chips.map((c) => c.count)])).toEqual([
      ["kind", [1, 0]],
      ["tag", [0, 0]],
      ["hot", [0]],
    ]);
  });
  it("a chip every item has, or none has, is not offered; a facet with no chips left is dropped", () => {
    const same = items.map((i) => ({ ...i, kind: "x", hot: true }));
    expect(chipGroups(same, FACETS, {}, all).map((g) => g.key)).toEqual(["tag"]);
  });
  it("max keeps the most common chips", () => {
    const g = chipGroups(items, [{ key: "tag", label: "Tag", values: (i) => i.tags, max: 1 }], {}, all);
    expect(g[0]!.chips.map((c) => c.value)).toEqual(["t1"]);
  });
});

describe("passes and toggled", () => {
  it("any-of within a facet, all facets together, one facet skipped on request", () => {
    const picked = { kind: ["x"], tag: ["t2", "t3"] };
    expect(items.filter((i) => passes(FACETS, picked, i)).map((i) => i.id)).toEqual(["a"]);
    expect(items.filter((i) => passes(FACETS, picked, i, "kind")).map((i) => i.id)).toEqual(["a", "d"]);
  });
  it("toggles a value on and off, dropping an empty facet", () => {
    const on = toggled(none, "kind", "x");
    expect(on.picked).toEqual({ kind: ["x"] });
    expect(toggled(on, "kind", "y").picked).toEqual({ kind: ["x", "y"] });
    expect(toggled(on, "kind", "x").picked).toEqual({});
  });
});

describe("offered", () => {
  it("drops picks the page does not show, keeps the ones it does, zero counts included", () => {
    const groups = chipGroups(items, FACETS, {}, (i) => i.id === "c");
    const f = with_({ kind: ["x", "zzz"], tag: ["t3"], nope: ["1"] }, "q");
    expect(offered(f, groups)).toEqual(with_({ kind: ["x"] }, "q"));
  });
});

describe("filter state", () => {
  it("knows when it narrows the list", () => {
    expect(isFiltering(none)).toBe(false);
    expect(isFiltering({ ...none, sort: "b" })).toBe(false);
    expect(isFiltering(with_({}, " x"))).toBe(true);
    expect(isFiltering(with_({ kind: ["x"] }))).toBe(true);
  });
  it("reads itself back from storage and shrugs off junk", () => {
    const f: Filters = { query: "sl", picked: { kind: ["x"] }, sort: "b" };
    expect(parseFilters(JSON.stringify(f), ["a", "b"])).toEqual(f);
    expect(parseFilters(null, ["a"])).toEqual(none);
    expect(parseFilters("{nope", ["a"])).toEqual(none);
    expect(parseFilters(JSON.stringify({ query: 3, picked: { kind: ["x", 4], tag: [] }, sort: "zzz" }), ["a"])).toEqual(with_({ kind: ["x"] }));
  });
});
