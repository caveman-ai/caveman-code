// The Changes tab in the real SidePanel, mounted with its effects running (linkedom): what it shows across a scope
// switch whose fs.diff is slow or fails, and what saving and removing line comments keeps. Each file's diff is a
// marker carrying the tab's review callbacks; the chat's session is a fixed view with four turns.
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Review } from "./FileDiff.tsx";

const at = vi.hoisted(() => ({ review: null as Review | null }));
vi.mock("../../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSession: () => ({
    view: {
      diffVersion: 0,
      checkpoints: [1, 2, 3, 4].map((n) => ({ id: `checkpoint:${n}`, own: true })),
    },
    model: null,
    historyVersion: 0,
    feed: null,
  }),
}));
vi.mock("./FileDiff.tsx", async (real) => {
  const { createElement } = await import("react");
  return {
    ...(await real<object>()),
    FileDiff: ({ file, review }: { file: { path: string }; review: Review }) => (
      (at.review = review),
      createElement("section", { "data-diff-path": file.path })
    ),
  };
});

const { RuntimeFixture } = await import("../../state/runtime.tsx");
const { SidePanel } = await import("../SidePanel.tsx");
const { openSurface, resetPanels } = await import("../store.ts");
const { keepComments, keptComments } = await import("./comments.ts");
// The tab loads its surface on first show: loaded here, it arrives within a tick.
await import("./DiffSurface.tsx");

const noop = () => undefined;
const chat = {
  id: "W-diff",
  session_id: "S-diff",
  title: "Chat",
  status: "idle",
  engine: "caveman",
  repo: { url: "" },
  base_ref: "",
  branch: "",
  created_at: "",
  updated_at: "",
  computer: { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" },
} as Workspace;
const file = (path: string) => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n x\n+y\n`,
});
const ALL = {
  from: "main",
  to: "WORKTREE",
  files: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
};

// The chat's computer: each fs.diff waits for the test to answer it.
const asked: Array<{
  range: string;
  answer: (diff: typeof ALL) => void;
  fail: (why: string) => void;
}> = [];
const client = {
  call: (method: string, params: { from?: string; to?: string }) =>
    method === "fs.diff"
      ? new Promise((resolve, reject) =>
          asked.push({
            range: params.to ? `${params.from}..${params.to}` : "all",
            answer: resolve,
            fail: (why) => reject(new Error(why)),
          }),
        )
      : new Promise(noop),
  on: () => noop,
  subscribe: () => noop,
};
const runtime = {
  status: "connected",
  error: null,
  client,
  identity: {},
  connection: 1,
  workspaces: [],
  raw: new Map([[chat.id, chat]]),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
};
let host: HTMLElement;
let unmount = noop as () => Promise<void> | void;
beforeEach(async () => {
  host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  openSurface(chat.id, "diff", {});
  // The app's router: the strip goes to the window tab a dragged tab becomes (#69).
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeFixture, {
          value: runtime as never,
          children: createElement(SidePanel, { workspace: chat }),
        }),
      ),
    ),
  );
  await settle();
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
});
afterEach(async () => {
  await unmount();
  resetPanels();
  keepComments(chat.id, []);
  asked.length = 0;
  at.review = null;
});

/** The next fs.diff the tab asked for, answered or failed, then what it shows. */
const reply = async (how: (next: (typeof asked)[number]) => void) => {
  const next = asked.shift()!;
  await act(async () => how(next));
  await settle();
  return next.range;
};
const shown = () => ({
  scope: host.querySelector('[aria-label^="Changes: "]')?.getAttribute("aria-label"),
  files: [...host.querySelectorAll("[data-diff-path]")].map((el) =>
    el.getAttribute("data-diff-path"),
  ),
  failed: host.textContent!.includes("Couldn't load the changes"),
  refresh: host
    .querySelector('button[aria-label="Refresh"], button[aria-label^="Couldn\'t refresh"]')
    ?.getAttribute("aria-label"),
});
const pick = async (turn?: string) => {
  // ScopeMenu's pick.
  await act(async () => void openSurface(chat.id, "diff", turn ? { turn } : {}));
  await settle();
};

test("after a scope switch the scope before's files never show under the new one's name, loading or failed", async () => {
  expect(await reply((d) => d.answer(ALL))).toBe("all");
  const all = {
    scope: "Changes: Changes",
    files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    failed: false,
    refresh: "Refresh",
  };
  expect(shown()).toEqual(all);

  await pick("checkpoint:3");
  expect(shown()).toEqual({
    scope: "Changes: Turn 3",
    files: [],
    failed: false,
    refresh: "Refresh",
  });
  expect(await reply((d) => d.fail("checkpoint not readable"))).toBe("checkpoint:2..checkpoint:3");
  expect(shown()).toEqual({
    scope: "Changes: Turn 3",
    files: [],
    failed: true,
    refresh: "Refresh",
  });

  // And back: Turn 3's failure isn't All changes'.
  await pick(undefined);
  expect(shown()).toEqual({ ...all, files: [] });
  expect(await reply((d) => d.answer(ALL))).toBe("all");
  expect(shown()).toEqual(all);
});

test("a failed Refresh of the scope shown keeps its files and says why on the Refresh button", async () => {
  await reply((d) => d.answer(ALL));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click(),
  );
  await settle();
  expect(await reply((d) => d.fail("relay lost"))).toBe("all");
  expect(shown()).toEqual({
    scope: "Changes: Changes",
    files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    failed: false,
    refresh: "Couldn't refresh: relay lost",
  });
});

test("a second comment on a line keeps the first, and Remove takes away only the one beside it", async () => {
  await reply((d) => d.answer(ALL));
  const line = { path: "src/a.ts", side: "new", line: 2, code: "y" } as const;
  const comment = async (text: string) => {
    await act(async () => at.review!.onStart(line));
    await act(async () => at.review!.onSave(line, text));
  };
  await comment("rename this");
  // + on the same line again: its comment shows above an empty box.
  await comment("and add a test");
  expect(keptComments(chat.id).map((c) => c.text)).toEqual(["rename this", "and add a test"]);
  expect(host.querySelector('[aria-label="Line comments"]')?.textContent).toContain(
    "2 comments on the changes",
  );

  await act(async () => at.review!.onRemove!(at.review!.comments[0]!));
  expect(keptComments(chat.id).map((c) => c.text)).toEqual(["and add a test"]);
});
