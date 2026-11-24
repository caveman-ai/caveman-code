import type { PrSummary } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../../panels/diff/parsePatch.ts";
import { agentTask, asksYou, excerptRows, fileKind, groupByRepo, groupQueue, guideDepth, guideLines, isShortChange, needsYou, prDestination, prFromUrl, prPath, readableBody } from "./model.ts";

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

describe("groupQueue", () => {
  it("puts each pull request in its first matching group and drops empty groups", () => {
    const groups = groupQueue([
      pr({ number: 1, review_requested: true }),
      pr({ number: 2, mine: true, review_requested: true }),
      pr({ number: 3, state: "draft", review_requested: true }),
      pr({ number: 4, state: "merged", mine: true }),
      pr({ number: 5, mine: true, guide_ready: true }),
      pr({ number: 6, review_requested: true, guide_ready: true }),
    ]);
    expect(groups.map((g) => [g.id, g.prs.map((p) => p.number)])).toEqual([
      ["needs_you", [1, 6]],
      ["guides_ready", [5]],
      ["yours", [2]],
      ["drafts", [3]],
      ["closed", [4]],
    ]);
    expect(needsYou(groups.flatMap((g) => g.prs))).toBe(2);
  });
});

describe("excerptRows", () => {
  const rows = parsePatch(["@@ -10,4 +10,5 @@", " a", "-b", "+B", "+C", " d", " e"].join("\n"));
  it("keeps the removed rows between the new-side lines it shows", () => {
    expect(excerptRows(rows, "new", 11, 12).map((r) => `${r.kind}:${r.text}`)).toEqual(["add:B", "add:C"]);
    expect(excerptRows(rows, "new", 10, 12).map((r) => `${r.kind}:${r.text}`)).toEqual(["ctx:a", "del:b", "add:B", "add:C"]);
  });
  it("reads old-side numbers for an old excerpt and is empty outside the hunk", () => {
    expect(excerptRows(rows, "old", 11, 11).map((r) => r.text)).toEqual(["b"]);
    expect(excerptRows(rows, "new", 40, 50)).toEqual([]);
  });
});

describe("fileKind", () => {
  it("folds tests and generated files", () => {
    expect(fileKind("apps/web/src/a.tsx")).toBe("code");
    expect(fileKind("apps/web/src/a.test.ts")).toBe("test");
    expect(fileKind("pkg/x_test.go")).toBe("test");
    expect(fileKind("pnpm-lock.yaml")).toBe("generated");
    expect(fileKind("packages/session-protocol/schema/session-protocol.v1.json")).toBe("generated");
 // upstream #26563: evals are tests, and _generated/ or __generated__/ folders are generated.
    expect(fileKind("src/ranking.eval.ts")).toBe("test");
    expect(fileKind("evals/ranking.ts")).toBe("test");
    expect(fileKind("convex/_generated/api.d.ts")).toBe("generated");
    expect(fileKind("src/__generated__/graphql.ts")).toBe("generated");
    expect(fileKind("src/evaluate.ts")).toBe("code");
  });
});

describe("agentTask", () => {
  it("names the pull request, the passage and the ask, and nothing else", () => {
    const text = agentTask({ pr: pr({ number: 7, title: "Gate merge", head_branch: "gate" }), mode: "fix", passage: { where: "src/a.ts:3-4", quote: "x\ny" }, text: " use the rollup " });
    expect(text).toContain("#7 “Gate merge”");
    expect(text).toContain("`gate`");
    expect(text).toContain("From src/a.ts:3-4:\n> x\n> y");
    expect(text.endsWith("use the rollup")).toBe(true);
  });
});

describe("readableBody", () => {
  it("drops a bot's HTML comments and badge tags, keeping its words", () => {
    expect(readableBody('<!-- devin-review-comment {"id": 1} -->\n\n**Bug** here\n<a href="x"><picture><img src="y"></picture>Open in Devin</a>')).toBe("**Bug** here\nOpen in Devin");
  });
});

describe("prPath", () => {
  it("is the project's page, with another repository on the host in the query", () => {
    expect(prPath({ project_id: "p 1", number: 12 })).toBe("/review/p%201/12");
    expect(prPath({ project_id: "p", number: 3, repo: "acme/other", host: "github.com" })).toBe("/review/p/3?repo=acme%2Fother&host=github.com");
  });
});

describe("prDestination", () => {
  it("opens beside the chat it was clicked in, else on the Review page", () => {
    expect(prDestination("w1", { project_id: "p", number: 4 })).toEqual({ kind: "panel", workspaceId: "w1" });
    expect(prDestination(null, { project_id: "p", number: 4 })).toEqual({ kind: "page", path: "/review/p/4" });
    expect(prDestination(undefined, { project_id: "p", number: 4, repo: "a/b", host: "github.com" })).toEqual({ kind: "page", path: "/review/p/4?repo=a%2Fb&host=github.com" });
  });
});

describe("prFromUrl", () => {
  const projects = [
    { id: "none" },
    { id: "widgets", repository: { host: "github.com", full_name: "acme/widgets" } },
    { id: "gadgets", repository: { host: "github.com", full_name: "acme/gadgets" } },
    { id: "lab", repository: { host: "gitlab.example.com", full_name: "lab/thing" } },
  ];
  it("opens a project's own pull request through that project", () => {
    expect(prFromUrl("https://github.com/acme/gadgets/pull/7", projects)).toEqual({ project_id: "gadgets", number: 7 });
    // Case and trailing parts don't matter: GitHub links are case-insensitive and often point at a tab.
    expect(prFromUrl("https://github.com/Acme/Widgets/pull/12/files#diff-abc", projects)).toEqual({ project_id: "widgets", number: 12 });
    expect(prFromUrl(" https://github.com/acme/widgets/pull/12?x=1 ", projects)).toEqual({ project_id: "widgets", number: 12 });
  });
  it("reads another repository on a known host through the first project on that host", () => {
    expect(prFromUrl("https://github.com/other/repo/pull/2", projects)).toEqual({ project_id: "widgets", number: 2, repo: "other/repo", host: "github.com" });
  });
  it("leaves a host no project is on, and anything that is not a pull request, to the browser", () => {
    expect(prFromUrl("https://codeberg.org/a/b/pull/1", projects)).toBeNull();
    expect(prFromUrl("https://github.com/acme/widgets/issues/12", projects)).toBeNull();
    expect(prFromUrl("https://github.com/acme/widgets/pull/", projects)).toBeNull();
    expect(prFromUrl("https://github.com/acme/widgets/pulls", projects)).toBeNull();
    expect(prFromUrl("https://github.com/acme/widgets/pull/12", [{ id: "none" }])).toBeNull();
  });
});

describe("guideLines", () => {
  it("counts code and tests, never lockfiles, generated files or snapshots", () => {
    const files = [
      { path: "src/upload.ts", additions: 6, deletions: 1 },
      { path: "src/upload.test.ts", additions: 2, deletions: 1 },
      { path: "pnpm-lock.yaml", additions: 900, deletions: 400 },
      { path: "src/__snapshots__/upload.test.ts.snap", additions: 40, deletions: 0 },
      { path: "api/schema/v1.json", additions: 30, deletions: 2 },
    ];
    expect(guideLines(files)).toBe(10);
  });
});

describe("isShortChange", () => {
  it("is short at or under the limit, never for an empty change or a limit of 0", () => {
    expect(isShortChange(10, 30)).toBe(true);
    expect(isShortChange(30, 30)).toBe(true);
    expect(isShortChange(31, 30)).toBe(false);
    expect(isShortChange(0, 30)).toBe(false);
    expect(isShortChange(5, 0)).toBe(false);
  });
});

describe("guideDepth", () => {
  it("keeps a written tour, whatever the size", () => {
    expect(guideDepth({ depth: "tour" }, true)).toBe("tour");
    // A guide from before depth existed is a tour.
    expect(guideDepth({}, true)).toBe("tour");
  });
  it("lets the size decide before a guide and over a TL;DR", () => {
    expect(guideDepth(null, true)).toBe("tldr");
    expect(guideDepth(undefined, false)).toBe("tour");
    expect(guideDepth({ depth: "tldr" }, true)).toBe("tldr");
    // A long change with only its chat's TL;DR so far: the tour is on its way.
    expect(guideDepth({ depth: "tldr" }, false)).toBe("tour");
  });
});

describe("groupByRepo", () => {
  it("puts repositories waiting on you first, then the one updated last, keeping each section's row order", () => {
    const groups = groupByRepo([
      pr({ number: 1, repo: "o/quiet", updated_at: "2026-10-22T00:00:00Z" }),
      pr({ number: 2, repo: "o/busy", review_requested: true, checks: "failing", updated_at: "2026-10-20T00:00:00Z" }),
      pr({ number: 3, repo: "o/fresh", updated_at: "2026-10-23T00:00:00Z" }),
      pr({ number: 4, repo: "o/busy", updated_at: "2026-10-21T00:00:00Z" }),
      pr({ number: 5, repo: "o/busy", review_requested: true, mine: true }),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(["o/busy", "o/fresh", "o/quiet"]);
    expect(groups[0]!.prs.map((p) => p.number)).toEqual([2, 4, 5]);
    expect(groups[0]).toMatchObject({ owner: "o", name: "busy", needsYou: 1, failing: 1 });
  });
  it("keeps two hosts' repositories of the same name apart", () => {
    expect(groupByRepo([pr({ repo: "o/r", host: "github.com" }), pr({ repo: "o/r", host: "gitlab.com" })])).toHaveLength(2);
  });
});

describe("asksYou", () => {
  it("is an open pull request asking for your review that is not yours", () => {
    expect(asksYou(pr({ review_requested: true }))).toBe(true);
    expect(asksYou(pr({ review_requested: true, mine: true }))).toBe(false);
    expect(asksYou(pr({ review_requested: true, state: "draft" }))).toBe(false);
  });
});
