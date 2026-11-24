import { describe, expect, it } from "vitest";
import { matchFields, matchWord, merge, pieces } from "./fuzzy.ts";

describe("matchWord", () => {
  it("a substring hits, best at a word start, and says where", () => {
    expect(matchWord("slack", "Slack")).toEqual({ score: 100, ranges: [[0, 5]] });
    expect(matchWord("draft", "Read and draft messages")!.ranges).toEqual([[9, 14]]);
    expect(matchWord("draft", "Read and draft messages")!.score).toBeGreaterThan(matchWord("raft", "Read and draft messages")!.score);
  });
  it("letters in order hit, three or more of them, with the gaps marked", () => {
    expect(matchWord("slk", "Slack")).toEqual({ score: 30 - 4 - 2, ranges: [[0, 2], [4, 5]] });
    expect(matchWord("sk", "Slack")).toBeNull();
    expect(matchWord("xyz", "Slack")).toBeNull();
  });
  it("the tightest run wins over the leftmost one", () => {
    expect(matchWord("isue", "Jira issues and Confluence pages")!.ranges).toEqual([[5, 7], [8, 10]]);
  });
  it("letters spread too far apart are no hit; an empty word hits nothing", () => {
    expect(matchWord("rem", "Read and draft messages")).toBeNull();
    expect(matchWord("", "Slack")).toBeNull();
  });
});

describe("matchFields", () => {
  const fields = [
    { text: "Slack", weight: 1 },
    { text: "Read and draft messages", weight: 0.8 },
    { text: "Salesforce", weight: 0.6 },
  ];
  it("no query matches everything with nothing to mark", () => {
    expect(matchFields("  ", fields)).toEqual({ score: 0, ranges: [[], [], []] });
  });
  it("every word must hit some field", () => {
    expect(matchFields("slack draft", fields)).not.toBeNull();
    expect(matchFields("salesforce", fields)).not.toBeNull();
    expect(matchFields("slack linear", fields)).toBeNull();
  });
  it("marks each field where it hit", () => {
    const m = matchFields("sla mess", fields)!;
    expect(m.ranges).toEqual([[[0, 3]], [[15, 19]], []]);
  });
  it("a hit in the first field outranks the second, which outranks the third", () => {
    const first = matchFields("deploy", [{ text: "Deploy kit", weight: 1 }, { text: "x", weight: 0.8 }])!.score;
    const second = matchFields("deploy", [{ text: "Ship", weight: 1 }, { text: "deploy fast", weight: 0.8 }])!.score;
    const third = matchFields("deploy", [{ text: "Other", weight: 1 }, { text: "Something", weight: 0.8 }, { text: "Deploy Inc", weight: 0.6 }])!.score;
    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(third);
  });
});

describe("merge and pieces", () => {
  it("joins overlapping ranges in order", () => {
    expect(merge([[5, 8], [0, 3], [2, 4], [8, 9]])).toEqual([[0, 4], [5, 9]]);
  });
  it("cuts text into plain and hit pieces", () => {
    expect(pieces("Slack", [[1, 3]])).toEqual([{ text: "S", hit: false }, { text: "la", hit: true }, { text: "ck", hit: false }]);
    expect(pieces("Slack", [])).toEqual([{ text: "Slack", hit: false }]);
    expect(pieces("Slack", [[0, 5]])).toEqual([{ text: "Slack", hit: true }]);
  });
});
