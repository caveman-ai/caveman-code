import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestReviewGuide,
} from "@caveman-app/protocol";

import {
  excerptRows,
  GUIDE_COMMENT_LIMIT,
  guideWorthPosting,
  isGuideComment,
  readGuideComment,
  renderGuideComment,
} from "./pullRequestReviewGuideComment.ts";
import { guideComments } from "./PullRequestReviewGuideService.ts";

const HEAD = "4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b";
const URL = "https://github.com/acme/app/pull/7";

const PATCH = [
  "diff --git a/src/gate.ts b/src/gate.ts",
  "index 1111111..2222222 100644",
  "--- a/src/gate.ts",
  "+++ b/src/gate.ts",
  "@@ -10,6 +10,8 @@ export function canMerge(pr: Pr) {",
  "   const checks = pr.checks;",
  "-  return true;",
  '+  const red = checks.filter((c) => c.status === "failed");',
  "+  if (red.length > 0) return { ok: false, why: red[0].name };",
  "+  return { ok: true };",
  " }",
  " ",
  " export const x = 1;",
  "",
].join("\n");

const guide = (overrides: Partial<PullRequestReviewGuide> = {}): PullRequestReviewGuide => ({
  headSha: HEAD,
  generatedAt: "2026-11-05T10:00:00.000Z",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude-account-julius"),
    model: "claude-haiku-5-5",
  },
  writer: { tier: "single-pass" },
  depth: "tour",
  threadId: ThreadId.make("thread-secret"),
  tldr: "Merge button locks on red CI and says which check failed.",
  overview: "Merging used to ignore CI.\nNow a failed check blocks it.",
  beforeAfter: {
    title: "Pressing Merge",
    rows: [
      { op: " ", depth: 0, text: "press Merge" },
      { op: "-", depth: 1, text: "merges whatever CI says" },
      { op: "+", depth: 1, text: "refuses while a check is red", stop: 1 },
    ],
  },
  stops: [
    {
      title: "Gate refuses red checks",
      summary: "canMerge returns why, not a bare boolean.",
      attention: {
        kind: "contract",
        note: "canMerge's return type changes; callers outside this repo break.",
      },
      excerpts: [{ path: "src/gate.ts", side: "new", start: 11, end: 13, caption: "the gate" }],
      files: [],
      notes: [
        {
          path: "src/gate.ts",
          line: 12,
          title: "First red check wins",
          body: "One reason is enough to act on.",
        },
      ],
      questions: ["Should warnings block too?"],
    },
    {
      title: "Other files",
      summary: "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: [{ path: "pnpm-lock.yaml" }],
      notes: [],
      questions: [],
    },
  ],
  ...overrides,
});

const context = {
  url: URL,
  label: "Claude Haiku 5.5 · single pass",
  patches: new Map([["src/gate.ts", PATCH]]),
};

describe("renderGuideComment", () => {
  it("leads with the TL;DR and the calls, then the before/after and the folded stops", () => {
    const body = renderGuideComment(guide(), context);
    const order = [
      "### Review guide",
      "**Merge button locks on red CI and says which check failed.**",
      "> [!IMPORTANT]",
      "**Before → after** · Pressing Merge",
      "<details>",
    ].map((text) => body.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain(
      "> **Contract** · canMerge's return type changes; callers outside this repo break.\n> <sub>Stop 1, Gate refuses red checks</sub>",
    );
    expect(body).toContain(
      "```diff\n  press Merge\n-   merges whatever CI says\n+   refuses while a check is red\n```",
    );
    expect(body).toContain(
      "<summary><strong>1. Gate refuses red checks</strong> · <em>Contract</em></summary>",
    );
    // Inside a fold GitHub reads `[!IMPORTANT]` as text, so the stop's call is a plain quote.
    const stop = body.slice(body.indexOf("<details>"), body.indexOf("</details>"));
    expect(stop).toContain(
      "> **Contract** · canMerge's return type changes; callers outside this repo break.",
    );
    expect(stop).not.toContain("[!");
    expect(body).toContain("<summary><strong>Other files</strong> · 1 file</summary>");
    expect(body).toContain("**Read it in this order** · 1 stop");
    // A stop of files alone before the end is still a numbered stop, and counted.
    const filesOnly = { ...guide().stops[1]!, title: "Plumbing" };
    const counted = renderGuideComment(
      guide({ stops: [guide().stops[0]!, filesOnly, guide().stops[1]!] }),
      context,
    );
    expect(counted).toContain("**Read it in this order** · 2 stops");
    expect(counted).toContain("<summary><strong>2. Plumbing</strong> · 1 file</summary>");
  });

  it("shows an excerpt as the diff's own lines, linked to them on the Files tab, with its notes", () => {
    const body = renderGuideComment(guide(), context);
    const anchor = `${URL}/files#diff-${createHash("sha256").update("src/gate.ts").digest("hex")}`;
    expect(body).toContain(`\`src/gate.ts\` [L11–13](${anchor}R11-R13) · the gate`);
    expect(body).toContain(
      [
        "```diff",
        "-  return true;",
        '+  const red = checks.filter((c) => c.status === "failed");',
        "+  if (red.length > 0) return { ok: false, why: red[0].name };",
        "+  return { ok: true };",
        "```",
      ].join("\n"),
    );
    expect(body).toContain(
      `- [L12](${anchor}R12) **First red check wins** · One reason is enough to act on.`,
    );
    expect(body).toContain(
      `<sub>Written for [\`4f3c2b1\`](https://github.com/acme/app/commit/${HEAD}) by Claude Haiku 5.5 · single pass · Made with [Caveman Code](https://caveman.so)</sub>`,
    );
  });

  it("carries the guide in its marker, without the writer's account or chat", () => {
    const body = renderGuideComment(guide(), context);
    expect(isGuideComment(body)).toBe(true);
    expect(body).not.toContain("claude-account-julius");
    expect(body).not.toContain("thread-secret");
    const read = readGuideComment(body);
    expect(read).toMatchObject({
      v: 1,
      headSha: HEAD,
      label: "Claude Haiku 5.5 · single pass",
      model: "claude-haiku-5-5",
      tldr: guide().tldr,
    });
    expect(read?.stops).toEqual(guide().stops);
  });

  it("makes model text inert: no mentions, HTML, links or images, and nothing closes its marker", () => {
    const hostile = guide({
      tldr: "Ping @octocat <img src=x onerror=alert(1)> ![x](https://evil.test/p.png) [win](https://evil.test) --> `@kept <b>`",
      stops: [
        {
          ...guide().stops[0]!,
          title: "Ask @team <script>",
          summary: "# not a heading\n> not a quote",
        },
      ],
    });
    const body = renderGuideComment(hostile, context);
    const visible = body.slice(0, body.indexOf("<!-- caveman:review-guide"));
    expect(body).not.toMatch(/@octocat|@team/);
    expect(body).toContain("@​octocat");
    expect(body).not.toContain("<img");
    expect(visible).toContain("&lt;img");
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(visible).not.toMatch(/(?<!\\)\]\(https:\/\/evil/);
    expect(visible).toContain("!\\[x\\](https://evil.test/p.png)");
    expect(body).toContain("`@kept <b>`");
    expect(body).toContain("\\# not a heading\n&gt; not a quote");
    expect(
      renderGuideComment(guide({ overview: "what: adds a gate\nwhy: red CI merged" }), context),
    ).toContain("**What:** adds a gate\n**Why:** red CI merged");
    // The one `-->` in the body is the marker's own end.
    const marker = body.indexOf("<!-- caveman:review-guide");
    expect(body.indexOf("-->", marker)).toBe(body.lastIndexOf("-->"));
    expect(readGuideComment(body)?.tldr).toBe(hostile.tldr);
  });

  it("lists several calls with their stops, and shows all-new code as its language", () => {
    const second = {
      ...guide().stops[0]!,
      title: "New file",
      attention: { kind: "risk" as const, note: "No tests yet." },
      excerpts: [{ path: "src/new.ts", side: "new" as const, start: 1, end: 2, caption: "" }],
      notes: [],
    };
    const added = [
      "diff --git a/src/new.ts b/src/new.ts",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const a = 1;",
      "+export const b = 2;",
      "",
    ].join("\n");
    const body = renderGuideComment(guide({ stops: [guide().stops[0]!, second] }), {
      ...context,
      patches: new Map([...context.patches, ["src/new.ts", added]]),
    });
    expect(body).toContain("> **2 calls for you**\n> - **Contract** (stop 1) · canMerge's");
    expect(body).toContain("> - **Risk taken** (stop 2) · No tests yet.");
    expect(body).toContain("```ts\nexport const a = 1;\nexport const b = 2;\n```");
  });

  it("drops the code, then the marker's guide, to stay under GitHub's limit", () => {
    const line = "+".concat("x".repeat(118));
    const big = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -0,0 +1,25 @@",
      ...Array.from({ length: 25 }, () => line),
      "",
    ].join("\n");
    const stops = Array.from({ length: 30 }, (_, i) => ({
      ...guide().stops[0]!,
      title: `Stop ${i}`,
      excerpts: [{ path: "big.ts", side: "new" as const, start: 1, end: 25, caption: "" }],
      notes: [],
    }));
    const body = renderGuideComment(guide({ stops }), {
      ...context,
      patches: new Map([["big.ts", big]]),
    });
    expect(body.length).toBeLessThanOrEqual(GUIDE_COMMENT_LIMIT);
    expect(body).not.toContain("```ts\nxxx");
    expect(body).toContain("The code is left out to fit");
    expect(readGuideComment(body)?.stops).toHaveLength(30);
  });

  it("writes a short change's call without a tour", () => {
    const { beforeAfter: _ba, overview: _ov, ...rest } = guide();
    const short: PullRequestReviewGuide = {
      ...rest,
      depth: "tldr",
      stops: [],
      attention: { kind: "risk", note: "No migration for old rows." },
    };
    const body = renderGuideComment(short, context);
    expect(body).toContain("> [!WARNING]\n> **Risk taken** · No migration for old rows.");
    expect(body).not.toContain("<details>");
  });
});

describe("excerptRows", () => {
  it("reads either side by its own line numbers", () => {
    expect(excerptRows(PATCH, "old", 11, 11)).toEqual([
      "-  return true;",
      '+  const red = checks.filter((c) => c.status === "failed");',
      "+  if (red.length > 0) return { ok: false, why: red[0].name };",
      "+  return { ok: true };",
    ]);
    expect(excerptRows(PATCH, "new", 14, 15)).toEqual([" }", " "]);
    expect(excerptRows(PATCH, "new", 90, 95)).toEqual([]);
    expect(excerptRows(undefined, "new", 1, 2)).toEqual([]);
  });
});

describe("guideWorthPosting", () => {
  it("posts a tour or a call, never a bare TL;DR or a template", () => {
    expect(guideWorthPosting(guide())).toBe(true);
    expect(guideWorthPosting(guide({ depth: "tldr", stops: [] }))).toBe(false);
    expect(
      guideWorthPosting(
        guide({ depth: "tldr", stops: [], attention: { kind: "product", note: "Copy changes." } }),
      ),
    ).toBe(true);
    expect(guideWorthPosting(guide({ writer: { tier: "template" } }))).toBe(false);
    expect(guideWorthPosting(guide({ stops: [guide().stops[1]!] }))).toBe(false);
  });
});

describe("guideComments", () => {
  const comment = (
    login: string,
    body: string,
    extra: Partial<PullRequestComment> = {},
  ): PullRequestComment => ({
    id: `${login}-${body.length}`,
    kind: "issue-comment",
    author: { login, name: null, avatarUrl: null },
    body,
    createdAt: "2026-11-05T10:00:00.000Z",
    url: `${URL}#issuecomment-${login}`,
    path: null,
    reviewState: null,
    ...extra,
  });
  const activity = (comments: ReadonlyArray<PullRequestComment>): PullRequestActivity => ({
    comments,
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
  });
  const detail = {
    viewer: "bob",
    author: { login: "Alice", name: null, avatarUrl: null },
  } as PullRequestDetail;
  const posted = renderGuideComment(guide(), context);

  it("keeps this person's own, trusts the author's, and only shows anyone else's", () => {
    const mine = comment("Bob", posted);
    const authors = comment("alice", posted);
    const strangers = comment("mallory", posted);
    expect(guideComments(detail, activity([strangers, authors, mine]))).toEqual({
      mine,
      trusted: mine,
      any: mine,
    });
    expect(guideComments(detail, activity([strangers, authors, comment("bob", "LGTM")]))).toEqual({
      mine: undefined,
      trusted: authors,
      any: authors,
    });
    expect(guideComments(detail, activity([strangers]))).toEqual({
      mine: undefined,
      trusted: undefined,
      any: strangers,
    });
  });

  it("never trusts a bot or a line comment", () => {
    const bot = comment("alice", posted, {
      author: { login: "alice", name: null, avatarUrl: null, isBot: true },
    });
    const line = comment("alice", posted, { kind: "review-comment" });
    expect(guideComments(detail, activity([bot, line])).trusted).toBeUndefined();
  });
});
