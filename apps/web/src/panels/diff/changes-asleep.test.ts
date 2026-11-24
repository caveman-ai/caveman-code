// A Cloud chat's Changes opened while its Cloud computer sleeps (job 9): the opening wakes it, the panel shows one line
// with its seconds and nothing else, and the changes load by themselves once it answers. The Changes tab is the real
// one in the real SidePanel (linkedom); the sync hub is the real one over a fake Cloud.
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import {
  fakeCloud,
  idbOrderedKv,
  runtime,
  summary,
  until,
} from "../../state/sync/fakes.test-support.ts";
import { asleepLine, SyncHub } from "../../state/sync/hub.ts";
import { memoryKv } from "../../state/sync/kv.ts";
import { onlyPage } from "../../state/sync/pages.ts";
import { openWaitLine } from "../../state/sync/web-window.ts";

const at = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock("../../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSession: () => ({
    view: { diffVersion: 0, checkpoints: [] },
    model: null,
    historyVersion: 0,
    feed: null,
  }),
  useSyncHub: () => at.hub,
}));

const { RuntimeFixture } = await import("../../state/runtime.tsx");
const { SidePanel } = await import("../SidePanel.tsx");
const { openSurface, resetPanels } = await import("../store.ts");
await import("./DiffSurface.tsx");

const noop = () => undefined;
const chat = {
  id: "w-s1",
  session_id: "s1",
  title: "Port settings",
  status: "idle",
  engine: "caveman",
  repo: { url: "" },
  base_ref: "",
  branch: "",
  created_at: "",
  updated_at: "",
  computer: { id: "c-box", kind: "caveman_cloud", label: "Cloud", status: "suspended" },
} as Workspace;
const ALL = {
  from: "main",
  to: "WORKTREE",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch:
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+y\n",
    },
  ],
};
/** The chat's client: the fs.diff calls it was asked, answered at once (the computer, once it answers). */
const asked: string[] = [];
const client = {
  call: (method: string) => (
    asked.push(method),
    method === "fs.diff" ? Promise.resolve(ALL) : new Promise(noop)
  ),
  on: () => noop,
  subscribe: () => noop,
};
const value = {
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

const hubs: SyncHub[] = [];
let unmount = noop as () => Promise<void> | void;
afterEach(async () => {
  await unmount();
  resetPanels();
  for (const h of hubs.splice(0)) h.stop();
  asked.length = 0;
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
};

test("Changes of a sleeping Cloud chat wake it, say so in one line with seconds, then load by themselves", async () => {
  const cloud = fakeCloud();
  cloud.runtime(
    runtime("rt-box", { computer_id: "c-box", online: false, computer_state: "suspended" }),
  );
  cloud.put(
    summary("s1", {
      runtime_id: "rt-box",
      computer_id: "c-box",
      where: { kind: "cloud", name: "acme-web" },
    }),
  );
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: idbOrderedKv(memoryKv()),
    home: () => ({ runtimeId: "rt-mac", client: null }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  at.hub = hub;

  const host = doc.createElement("div");
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
          value: value as never,
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

  // The opening woke it, once; nothing was read from a computer that sleeps.
  expect(cloud.wakeHints).toEqual([{ computerId: "c-box", reason: "open" }]);
  expect(asked.filter((m) => m === "fs.diff")).toEqual([]);
  const text = host.textContent ?? "";
  expect(text).toMatch(/Waking Cloud… \d+s/);
  expect(text).not.toContain("Couldn't load the changes");
  expect(text).not.toContain("Retry");
  expect(text).not.toContain("acme-web");
  expect(text).not.toContain("asleep");
  // Nothing to press that could only wait.
  expect(host.querySelector('button[aria-label="Refresh"]')).toBeNull();

  // Cloud answers: the changes load by themselves, and the line goes.
  await act(async () =>
    cloud.runtime(
      runtime("rt-box", { computer_id: "c-box", online: true, computer_state: "running" }),
    ),
  );
  await until(() => asked.includes("fs.diff"));
  await settle();
  expect(host.querySelector('[data-diff-path="src/a.ts"]')).not.toBeNull();
  expect(host.textContent).not.toMatch(/Waking Cloud/);
  expect(hub.openWait("s1")).toBeNull();
  // Awake, the panel never asks to wake it again.
  expect(cloud.wakeHints).toHaveLength(1);
});

test("what an opening's wait says: its seconds, Cloud's refusal, no network; never a computer's name or a retry", () => {
  expect(openWaitLine({ since: 1_000, failed: false }, 5_400)).toBe("Waking Cloud… 4s");
  expect(openWaitLine({ since: 1_000, failed: true }, 5_400)).toBe(
    "Cloud couldn't wake. Trying again.",
  );
  expect(openWaitLine({ since: 1_000, failed: false }, 5_400, false)).toBe("Waking Cloud… 4s");
  expect(openWaitLine({ since: 1_000, failed: false }, 12_000, false)).toBe(
    "No network. Opens when you're back online.",
  );
  // What anything else that needs the place says while it sleeps.
  expect(asleepLine({ where: { kind: "cloud", name: "acme-web" } })).toBe(
    "Cloud is asleep. This works once it's awake.",
  );
  expect(asleepLine({ where: { kind: "laptop", name: "Studio" } })).toBe(
    "Studio is asleep. This works once it's awake.",
  );
});

test("an opening Cloud refuses to wake for says so, and the opening's wait is counted in the chat's waking line", async () => {
  const cloud = fakeCloud();
  cloud.api.wakeHint = async () => {
    throw new Error("limit");
  };
  cloud.runtime(
    runtime("rt-box", { computer_id: "c-box", online: false, computer_state: "suspended" }),
  );
  cloud.put(summary("s1", { runtime_id: "rt-box", computer_id: "c-box" }));
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: idbOrderedKv(memoryKv()),
    home: () => ({ runtimeId: null, client: null }),
    endpoint: () => null,
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  const before = Date.now();
  expect(hub.openWait("s1")).toBeNull();
  expect(hub.wake("s1", "open")).toBe(true);
  expect(hub.wakingSince("s1")).toBeGreaterThanOrEqual(before);
  await until(() => hub.openWait("s1")?.failed === true);
});
