import type { PrSummary } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";
import type { Filters } from "../../lib/facets.ts";
import { asksOf, filterPrs, matchPrText, prChips } from "./filter.ts";

const pr = (over: Partial<PrSummary>): PrSummary => ({
  project_id: "p",
  repo: "o/r",
  host: "github.com",
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  head_branch: "h",
  base_branch: "main",
  state: "open",
  additions: 0,
  deletions: 0,
  created_at: "2026-10-19T00:00:00Z",
  updated_at: "2026-10-19T00:00:00Z",
  review_requested: false,
  mine: false,
  ...over,
});

const prs = [
  pr({ number: 1, title: "Fix the merge gate", head_branch: "fix/merge-gate", review_requested: true, checks: "failing", author: { login: "dana" }, updated_at: "2026-10-19T03:00:00Z", additions: 10, deletions: 2 }),
  pr({ number: 2, title: "Review guide writer", head_branch: "feat/guide", mine: true, checks: "passing", review: "approved", author: { login: "me" }, labels: [{ name: "docs" }], updated_at: "2026-10-19T02:00:00Z", additions: 300, deletions: 40 }),
  pr({ number: 3, title: "Draft: plugin filter bar", head_branch: "caveman/filter", state: "draft", workspace_id: "w1", author: { login: "dana" }, repo: "o/other", updated_at: "2026-10-19T01:00:00Z", created_at: "2026-10-19T01:00:00Z" }),
];
const none: Filters = { query: "", picked: {}, sort: "updated" };
const ids = (f: Partial<Filters>) => filterPrs(prs, { ...none, ...f }).map((s) => s.pr.number);

describe("asksOf", () => {
  it("says what a pull request asks of you", () => {
    expect(prs.map(asksOf)).toEqual([["needs_you"], ["mine"], ["draft", "chat"]]);
    expect(asksOf(pr({ review_requested: true, mine: true }))).toEqual(["mine"]);
  });
});

describe("matchPrText", () => {
  it("reads title, branch, number, author, repository and labels; marks title and branch", () => {
    expect(matchPrText(prs[0]!, "merge gate")!.ranges[0]).toEqual([[8, 13], [14, 18]]);
    expect(matchPrText(prs[0]!, "fix/merge")!.ranges[1]).toEqual([[0, 9]]);
    expect(matchPrText(prs[0]!, "#1")).not.toBeNull();
    expect(matchPrText(prs[0]!, "dana")).not.toBeNull();
    expect(matchPrText(prs[2]!, "other")).not.toBeNull();
    expect(matchPrText(prs[1]!, "docs")).not.toBeNull();
    expect(matchPrText(prs[1]!, "docs zzz")).toBeNull();
  });
});

describe("prChips", () => {
  it("offers the facets that split the queue, with counts", () => {
    const g = prChips(prs, none);
    expect(g.map((x) => [x.key, x.chips.map((c) => [c.label, c.count])])).toEqual([
      ["ask", [["Needs you", 1], ["Yours", 1], ["Draft", 1], ["Has a chat", 1]]],
      ["checks", [["Passing", 1], ["Failing", 1]]],
      ["review", [["Approved", 1]]],
      ["repo", [["o/r", 2], ["o/other", 1]]],
      ["author", [["dana", 2], ["me", 1]]],
      ["label", [["docs", 1]]],
    ]);
  });
});

describe("filterPrs", () => {
  it("nothing set keeps everything, last updated first", () => {
    expect(ids({})).toEqual([1, 2, 3]);
  });
  it("facets combine; chips within a facet are any-of", () => {
    expect(ids({ picked: { author: ["dana"] } })).toEqual([1, 3]);
    expect(ids({ picked: { author: ["dana"], ask: ["draft", "mine"] } })).toEqual([3]);
    expect(ids({ picked: { checks: ["passing"] }, query: "guide" })).toEqual([2]);
  });
  it("sorts as asked; a query puts the best match first", () => {
    expect(ids({ sort: "title" })).toEqual([3, 1, 2]);
    expect(ids({ sort: "size" })).toEqual([2, 1, 3]);
    expect(ids({ sort: "created" })).toEqual([3, 1, 2]);
    expect(ids({ query: "guide" })).toEqual([2]);
    expect(ids({ query: "fi" })).toEqual([1, 3]);
  });
});

it("orders by the instant a host wrote, across offsets and fractions of a second (T3's #23588)", () => {
  const list = [pr({ number: 1, updated_at: "2026-07-05T01:00:00+02:00" }), pr({ number: 2, updated_at: "2026-07-05T00:30:00Z" }), pr({ number: 3, updated_at: "2026-07-05T00:30:00.5Z" })];
  expect(filterPrs(list, { ...none, sort: "updated" }).map((s) => s.pr.number)).toEqual([3, 2, 1]);
  const made = [pr({ number: 1, created_at: "2026-07-05T01:00:00+02:00" }), pr({ number: 2, created_at: "2026-07-05T00:30:00Z" })];
  expect(filterPrs(made, { ...none, sort: "created" }).map((s) => s.pr.number)).toEqual([2, 1]);
});
