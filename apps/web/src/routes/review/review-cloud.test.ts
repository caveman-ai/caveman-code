// The Review page in a browser window with no Mac (source.ts): it reads Cloud's Review routes, not the runtime the
// window quietly uses, so a Cloud computer's "Review pull requests on your Mac (Review)…" is never what it shows; a
// person with no GitHub link Cloud keeps is shown Connect GitHub with its button; and what Cloud cannot do (Resolve)
// is not drawn.
import { buttons, click, render, settle } from "../dom.test-support.ts";
import type { PrDiscussionItem, PrSummary } from "@caveman-app/session-protocol";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeFixture, WebWindowFixture } from "../../state/runtime.tsx";
import { ThreadCard } from "./Discussion.tsx";
import { ReviewQueue } from "./Queue.tsx";
import { CLOUD_OFFERS, MAC_OFFERS, ReviewSourceFixture } from "./source.ts";

const OUTSIDE =
  "Review pull requests on your Mac (Review). A chat in Cloud still opens its own and shows its checks.";
const row: PrSummary = {
  project_id: "p-cloud",
  repo: "acme/api",
  host: "github.com",
  number: 7,
  title: "Fix the login loop",
  url: "https://github.com/acme/api/pull/7",
  author: { login: "bob" },
  head_branch: "fix-login",
  base_branch: "main",
  state: "open",
  additions: 12,
  deletions: 3,
  created_at: "2026-11-09T10:00:00Z",
  updated_at: "2026-11-10T09:00:00Z",
  review_requested: true,
  mine: false,
  checks: "failing",
};

/** What Cloud answers GET /api/v1/code/reviews with, per test; every path Cloud was asked. */
let queue: unknown = null;
const asked: string[] = [];
vi.stubGlobal("fetch", async (url: string) => {
  asked.push(url);
  return new Response(JSON.stringify(queue), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
afterEach(() => void (asked.length = 0));

/** The runtime the window uses is a Cloud computer's, which refuses the Review page as it always has. */
const runtimeAsked: string[] = [];
const cloudComputer = {
  call: (method: string) => {
    runtimeAsked.push(method);
    return method === "pr.list"
      ? Promise.resolve({ prs: [], viewers: {}, errors: [], unavailable: OUTSIDE })
      : new Promise(() => undefined);
  },
  on: () => () => undefined,
};
const runtime = {
  status: "connected",
  client: cloudComputer,
  connection: 1,
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
};

const inWebWindow = (home: { kind: "mac" | "cloud"; name: string } | null, node: ReactNode) =>
  createElement(
    MemoryRouter,
    null,
    createElement(RuntimeFixture, {
      value: runtime as never,
      children: createElement(WebWindowFixture, {
        value: {
          home,
          mac: { kind: "none" },
          window: {} as never,
          places: {} as never,
          usePlace: () => undefined,
        },
        children: node,
      }),
    }),
  );

const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ");

test("a browser window with no Mac reads the queue from Cloud, never the Cloud computer's refusal", async () => {
  queue = {
    prs: [row],
    viewers: { "github.com": "ada" },
    errors: [
      {
        project_id: "p-web",
        repo: "acme/web",
        message: "Connect GitHub to see its pull requests.",
      },
    ],
    github: "connected",
  };
  const page = await render(
    inWebWindow({ kind: "cloud", name: "Cloud" }, createElement(ReviewQueue)),
  );
  await settle(3);
  expect(asked).toContain("/api/v1/code/reviews");
  expect(runtimeAsked).not.toContain("pr.list");
  expect(text(page.host)).toContain("Fix the login loop");
  expect(text(page.host)).toContain(
    "Could not read acme/web: Connect GitHub to see its pull requests.",
  );
  expect(text(page.host)).not.toContain("on your Mac (Review)");
  await page.unmount();
});

test("with no GitHub link Cloud keeps, the queue says so with Connect GitHub, which opens Cloud's own page", async () => {
  queue = {
    prs: [],
    viewers: {},
    errors: [],
    unavailable: "Connect GitHub to review pull requests here.",
    github: "not_connected",
    connect_url: "https://app.cave.test/cave-agent/code",
  };
  const opened: unknown[] = [];
  const open = (window as unknown as { open?: unknown }).open;
  (window as unknown as { open: unknown }).open = (...args: unknown[]) => void opened.push(args);
  // A window whose Cloud queue was read before keeps it a minute: this one starts from Cloud's answer now.
  const page = await render(inWebWindow(null, createElement(ReviewQueue)));
  await settle(3);
  await click(page.host.querySelector("button[aria-label='Refresh']"));
  await settle(3);
  expect(text(page.host)).toContain("GitHub isn't connected");
  expect(text(page.host)).toContain("Connect GitHub to review pull requests here.");
  expect(text(page.host)).not.toContain("gh auth login");
  await click(buttons(page.host, "Connect GitHub")[0]);
  expect(opened).toEqual([["https://app.cave.test/cave-agent/code", "_blank", "noopener"]]);
  (window as unknown as { open: unknown }).open = open;
  await page.unmount();
});

test("a Mac's window reads its Mac, as before", async () => {
  runtimeAsked.length = 0;
  const page = await render(
    inWebWindow({ kind: "mac", name: "Studio" }, createElement(ReviewQueue)),
  );
  await settle(3);
  expect(runtimeAsked).toContain("pr.list");
  expect(asked).not.toContain("/api/v1/code/reviews");
  await page.unmount();
});

type Thread = Extract<PrDiscussionItem, { type: "thread" }>;
const thread: Thread = {
  type: "thread",
  id: "61",
  path: "src/login.ts",
  line: 3,
  side: "new",
  resolved: false,
  outdated: false,
  comments: [
    { id: "61", author: { login: "carol" }, body: "Why two?", at: "2026-11-09T12:01:00Z" },
  ],
};
const card = (offers: typeof CLOUD_OFFERS) =>
  createElement(ReviewSourceFixture, {
    value: { client: null, from: offers === CLOUD_OFFERS ? "cloud" : "mac", offers },
    children: createElement(ThreadCard, {
      t: thread,
      url: row.url,
      now: Date.parse("2026-11-10T10:00:00Z"),
      canComment: true,
      onReply: async () => undefined,
      onResolve: async () => undefined,
      onFix: async () => undefined,
    }),
  });

test("from Cloud a thread offers Fix with agent and no Resolve, which GitHub keeps in GraphQL only", async () => {
  const fromCloud = await render(card(CLOUD_OFFERS));
  expect(buttons(fromCloud.host, "Resolve")).toEqual([]);
  expect(buttons(fromCloud.host, "Fix with agent").length).toBe(1);
  await fromCloud.unmount();
  const fromMac = await render(card(MAC_OFFERS));
  expect(buttons(fromMac.host, "Resolve").length).toBe(1);
  await fromMac.unmount();
});
