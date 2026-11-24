// For the tests beside it only (nothing the app runs imports this): Cloud's Review answers as the web's fixture page
// scripts them (apps/web/src/shell/review-cloud.browser.tsx), and a stand-in Cloud that answers them and records what
// it was asked.
import type { PrDetail, PrDiscussionItem, PrSummary } from "@caveman-app/session-protocol";

import { CloudError, type PhoneCloud, type PullDiff, type ReviewList } from "../live/cloud";

export const NOW = Date.parse("2026-11-10T12:00:00.000Z");
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
export const HEAD = "0123456789abcdef0123456789abcdef01234567";

export const summary = (
  over: Partial<PrSummary> & Pick<PrSummary, "number" | "title" | "repo">,
): PrSummary => ({
  project_id: "p-cloud",
  host: "github.com",
  url: `https://github.com/${over.repo}/pull/${over.number}`,
  author: { login: "bob" },
  head_branch: "fix-login",
  base_branch: "main",
  state: "open",
  additions: 12,
  deletions: 3,
  created_at: ago(26 * 60),
  updated_at: ago(40),
  review_requested: false,
  mine: false,
  ...over,
});

export const PRS: PrSummary[] = [
  summary({
    number: 7,
    title: "Stop the login redirect loop",
    repo: "acme/api",
    review_requested: true,
    checks: "failing",
  }),
  summary({
    number: 12,
    title: "Rate limit the password reset",
    repo: "acme/api",
    author: { login: "carol" },
    head_branch: "reset-limit",
    updated_at: ago(180),
    review_requested: true,
    checks: "passing",
  }),
  summary({
    number: 8,
    title: "Document the session cookie",
    repo: "acme/api",
    author: { login: "ada" },
    head_branch: "ada-docs",
    mine: true,
    updated_at: ago(60 * 20),
  }),
  summary({
    number: 31,
    title: "Move the settings rows to the new kit",
    repo: "acme/web",
    author: { login: "dan" },
    head_branch: "settings-rows",
    state: "draft",
    updated_at: ago(60 * 5),
  }),
  summary({
    number: 40,
    title: "Bump the linter",
    repo: "acme/web",
    author: { login: "dan" },
    head_branch: "lint",
    updated_at: ago(60 * 9),
  }),
];

export const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  ...PRS[0]!,
  body: "A session that expired between the redirect and the callback sent the browser round the login page forever.",
  head_sha: HEAD,
  mergeable: "clean",
  checks_list: [
    { name: "test", status: "failed" },
    { name: "lint", status: "passed" },
    { name: "typecheck", status: "passed" },
  ],
  reviewers: [{ login: "carol", state: "commented" }],
  commits: 2,
  files: [
    { path: "src/auth/login.ts", status: "modified", additions: 4, deletions: 2, viewed: false },
    { path: "src/auth/next.ts", status: "added", additions: 5, deletions: 0, viewed: false },
  ],
  can: {
    merge: true,
    review: true,
    comment: true,
    merge_methods: ["squash", "merge"],
    ready: false,
  },
  ...over,
});

export const TALK: PrDiscussionItem[] = [
  {
    type: "comment",
    id: "51",
    author: { login: "bob" },
    body: "Ready for a look. The second file is new.",
    at: ago(25 * 60),
  },
  {
    type: "comment",
    id: "review-91",
    author: { login: "carol" },
    body: "Looks close. One question on the redirect.",
    at: ago(24 * 60),
    verdict: "commented",
  },
  {
    type: "thread",
    id: "61",
    path: "src/auth/login.ts",
    line: 14,
    side: "new",
    resolved: false,
    outdated: false,
    comments: [
      {
        id: "61",
        author: { login: "carol" },
        body: "Should `next` be checked here too?",
        at: ago(24 * 60),
      },
    ],
  },
];

export const DIFF: PullDiff = {
  head_sha: HEAD,
  files: [
    {
      path: "src/auth/login.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "diff --git a/src/auth/login.ts b/src/auth/login.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    },
  ],
  omitted: ["src/auth/next.ts"],
};

/** Cloud's refusals as the phone's client throws them (live/cloud.ts failure). */
export const refusal = {
  github: (words: string) => new CloudError(409, words, "cave_code_github_refused"),
  notConnected: (connect = "/cave-agent/code") =>
    new CloudError(
      409,
      "Connect GitHub to review pull requests here.",
      "cave_code_github_not_connected",
      { connect_url: connect },
    ),
  notFound: () => new CloudError(404, "cave_not_found", "cave_not_found"),
  busy: () => new CloudError(503, "Caveman answered 503."),
  /** What fetch itself throws when nothing was reached. */
  offline: () => new TypeError("Failed to fetch"),
};

type Review = Pick<
  PhoneCloud,
  | "url"
  | "reviews"
  | "pull"
  | "pullDiff"
  | "pullDiscussion"
  | "reviewPull"
  | "commentOnPull"
  | "mergePull"
>;

/**
 * A Cloud that answers the seven calls from what it holds and records each one. `fail` rejects the next call of that
 * name once (or every time, with `always`).
 */
export function standIn(
  start: {
    list?: ReviewList | null;
    detail?: PrDetail;
    talk?: PrDiscussionItem[];
    diff?: PullDiff;
  } = {},
) {
  const held = {
    list:
      start.list === undefined
        ? ({ prs: PRS, errors: [], github: "connected" } as ReviewList | null)
        : start.list,
    detail: start.detail ?? detail(),
    talk: start.talk ?? TALK,
    diff: start.diff ?? DIFF,
  };
  const calls: Array<{ call: keyof Review; args: unknown[] }> = [];
  const failing = new Map<keyof Review, { error: unknown; always: boolean }>();
  const answer = async <T>(call: keyof Review, args: unknown[], value: () => T): Promise<T> => {
    calls.push({ call, args });
    const fail = failing.get(call);
    if (fail) {
      if (!fail.always) failing.delete(call);
      throw fail.error;
    }
    return value();
  };
  const cloud: Review = {
    url: "https://cloud.test",
    reviews: () => answer("reviews", [], () => held.list),
    pull: (...args) => answer("pull", args, () => held.detail),
    pullDiff: (...args) => answer("pullDiff", args, () => held.diff),
    pullDiscussion: (...args) => answer("pullDiscussion", args, () => held.talk),
    reviewPull: (...args) => answer("reviewPull", args, () => undefined),
    commentOnPull: (...args) => answer("commentOnPull", args, () => undefined),
    mergePull: (...args) =>
      answer("mergePull", args, () => {
        // GitHub merged it: what Cloud says of it from now on.
        held.detail = {
          ...held.detail,
          state: "merged",
          can: { ...held.detail.can, merge: false, review: false },
        };
      }),
  };
  return {
    cloud,
    held,
    calls,
    named: (call: keyof Review) => calls.filter((c) => c.call === call),
    fail: (call: keyof Review, error: unknown, always = false) =>
      void failing.set(call, { error, always }),
  };
}
