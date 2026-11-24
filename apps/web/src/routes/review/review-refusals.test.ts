// A Resolve the host refuses, a "Fix with agent" or a guide stop's question whose agent does not start: the person is
// told why where they pressed it, and nothing escapes as an unhandled rejection.
import { alerts, buttons, click, render } from "../dom.test-support.ts";
import type { PrDetail, PrDiscussionItem, PrGuideResult } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, expect, test } from "vitest";
import { NO_ENGINE } from "../../state/engines.ts";
import { ThreadCard } from "./Discussion.tsx";
import { Guide } from "./Guide.tsx";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
afterAll(() => void process.off("unhandledRejection", onUnhandled));
afterEach(() => void (unhandled.length = 0));
const escaped = () => unhandled.map((e) => (e instanceof Error ? e.message : String(e)));

type Thread = Extract<PrDiscussionItem, { type: "thread" }>;
const thread: Thread = {
  type: "thread",
  id: "t1",
  path: "src/app.ts",
  line: 12,
  side: "new",
  resolved: false,
  outdated: false,
  comments: [
    {
      id: "c1",
      author: { login: "reviewer" },
      body: "This leaks the handle.",
      at: "2026-11-05T10:00:00.000Z",
    },
  ],
};

async function threadCard(onResolve: () => Promise<unknown>, onFix: () => Promise<unknown>) {
  return render(
    createElement(ThreadCard, {
      t: thread,
      url: "https://github.com/acme/app/pull/42",
      now: Date.parse("2026-11-06T10:00:00.000Z"),
      canComment: true,
      onReply: async () => undefined,
      onResolve,
      onFix,
    }),
  );
}

test("a Resolve the host refuses says why on the thread", async () => {
  const card = await threadCard(
    () => Promise.reject(new Error("Resource not accessible by integration")),
    async () => undefined,
  );
  await click(buttons(card.host, "Resolve")[0]);
  expect(escaped()).toEqual([]);
  expect(alerts(card.host)).toEqual(["Resource not accessible by integration"]);
  expect(buttons(card.host, "Resolve")[0]?.disabled).toBe(false);
  await card.unmount();
});

test("a Fix with agent that does not start says why on the thread, and the button offers it again", async () => {
  const card = await threadCard(
    async () => undefined,
    () => Promise.reject(new Error(NO_ENGINE)),
  );
  await click(buttons(card.host, "Fix with agent")[0]);
  expect(escaped()).toEqual([]);
  expect(alerts(card.host)).toEqual([NO_ENGINE]);
  expect(buttons(card.host, "Fix with agent")[0]?.disabled).toBe(false);
  await card.unmount();
});

const detail: PrDetail = {
  project_id: "p1",
  repo: "acme/app",
  host: "github.com",
  number: 42,
  title: "Close the handle",
  url: "https://github.com/acme/app/pull/42",
  head_branch: "fix/handle",
  base_branch: "main",
  state: "open",
  additions: 3,
  deletions: 1,
  created_at: "2026-11-05T09:00:00.000Z",
  updated_at: "2026-11-05T10:00:00.000Z",
  review_requested: true,
  mine: false,
  body: "",
  head_sha: "abc",
  mergeable: "clean",
  checks_list: [],
  reviewers: [],
  commits: 1,
  files: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1, viewed: false }],
  can: { merge: false, review: true, comment: true, merge_methods: [], ready: false },
};
const tour: PrGuideResult = {
  running: false,
  head_sha: "abc",
  guide: {
    head_sha: "abc",
    generated_at: "2026-11-05T10:05:00.000Z",
    depth: "tour",
    stops: [
      {
        title: "Closes the handle",
        summary: "The handle closes on every path.",
        attention: null,
        excerpts: [],
        files: [],
        notes: [],
        questions: ["Why not close it in finally?"],
      },
    ],
  },
};

test("a guide stop's question whose agent does not start says why under the stop", async () => {
  const asked: string[] = [];
  const guide = await render(
    createElement(
      MemoryRouter,
      null,
      createElement(Guide, {
        detail,
        guide: tour,
        guideError: undefined,
        files: new Map(),
        diffLoading: false,
        read: new Set<number>(),
        onRead: () => undefined,
        onGenerate: () => undefined,
        onPost: async () => undefined,
        onOpenFile: () => undefined,
        onAsk: (_passage, question) => (
          asked.push(question),
          Promise.reject(new Error("This pull request's project isn't on this computer."))
        ),
        depth: "tour",
        lines: 4,
        limit: 1,
        diff: null,
        onWriteTour: () => undefined,
        tourAsked: false,
      }),
    ),
  );
  await click(buttons(guide.host, /Why not close it in finally\?/)[0]);
  expect(asked).toEqual(["Why not close it in finally?"]);
  expect(escaped()).toEqual([]);
  expect(alerts(guide.host)).toEqual(["This pull request's project isn't on this computer."]);
  await guide.unmount();
});
