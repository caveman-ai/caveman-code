// browser.ts when the tab a window streams closes, on fake preview services so the races are deterministic (the real
// headless browser is in browser.test.ts): a remaining tab that won't attach still tells the window its browser is
// empty and leaves it waiting, a tab revealed while the close is being followed streams to the window, and following
// never opens a blank tab of its own, nor streams a window that stopped its screencast meanwhile.
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { expect, test } from "vitest";

import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { makeBrowser } from "./browser.ts";

const W = "w1";
const T = "caveman:w1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
};
const snapshot = (tabId: string, reveal?: string) => ({
  threadId: T,
  tabId,
  runtime: "server",
  navStatus: { _tag: "Success", url: `http://127.0.0.1/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  ...(reveal ? { revealRequest: { id: reveal } } : {}),
});

async function harness() {
  const events = await Effect.runPromise(PubSub.unbounded<unknown>());
  const activity = await Effect.runPromise(PubSub.unbounded<{ threadId: string; tabId: string }>());
  /** The manager's sessions, newest last. */
  const sessions: Array<ReturnType<typeof snapshot>> = [];
  /** Set to hold the next list call: it answers with the sessions as they were when called, once released. */
  let hold: { called: boolean; release: () => void; released: Promise<void> } | null = null;
  /** Answers the next list call instead of `sessions`: a tab listed once that is gone by the next lookup. */
  let listOnce: Array<ReturnType<typeof snapshot>> | null = null;
  /** Tabs the browser opened on its own; following a closed tab never opens one. */
  let opened = 0;
  /** workspaceOfThread calls: a reveal makes two, its own and its resumeWaiting's, which reads the waiting list next. */
  let lookups = 0;
  const attachable = new Set<string>();
  const attached: Array<string> = [];
  const outputs = new Map<string, Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>>();
  const manager = {
    list: () =>
      Effect.promise(async () => {
        const now = listOnce ?? [...sessions];
        listOnce = null;
        const held = hold;
        hold = null;
        if (held) {
          held.called = true;
          await held.released;
        }
        return { sessions: now, serverEpoch: "e", revision: 0 };
      }),
    open: () => {
      opened++;
      return Effect.fail(new Error("this test never opens a tab"));
    },
    close: () => Effect.void,
    subscribeEvents: PubSub.subscribe(events),
  };
  const browser = {
    agentActivity: activity,
    attachViewer: (input: { threadId: string; tabId: string }) =>
      Effect.gen(function* () {
        if (!attachable.has(input.tabId))
          return yield* Effect.fail(
            new ServerBrowser.ServerBrowserTabNotFoundError({
              threadId: input.threadId,
              tabId: input.tabId,
            }),
          );
        const output = yield* Queue.unbounded<ServerBrowser.ServerBrowserViewerOutput>();
        outputs.set(input.tabId, output);
        attached.push(input.tabId);
        return { output, input: () => Effect.void, controlling: () => false };
      }),
  };
  const told: Array<{ method: string; params: { url?: string } }> = [];
  const connection = { id: "c1", outbox: { size: () => 0 } };
  const record = { workspace: { id: W, status: "active" }, internal: { threadId: T } };
  const scope = await Effect.runPromise(Scope.make());
  const sp = await Effect.runPromise(
    makeBrowser({
      recordByWorkspace: () => Effect.succeed(record as never),
      workspaceOfThread: (threadId) =>
        Effect.sync(() => (lookups++, threadId === T ? W : undefined)),
      notify: (_connection, method, params) =>
        told.push({ method, params: params as { url?: string } }),
      connections: () => [connection],
    }).pipe(
      Effect.provideService(ServerBrowser.ServerBrowser, browser as never),
      Effect.provideService(PreviewManager.PreviewManager, manager as never),
      Scope.provide(scope),
    ),
  );
  const states = () => told.filter((t) => t.method === "browser.state").map((t) => t.params.url);
  return {
    sessions,
    attachable,
    attached,
    states,
    opened: () => opened,
    lookups: () => lookups,
    listOnce: (tabs: Array<ReturnType<typeof snapshot>>) => {
      listOnce = tabs;
    },
    holdNextList: () => {
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      const held = { called: false, release, released };
      hold = held;
      return held;
    },
    screencast: (enabled = true) =>
      Effect.runPromise(
        sp.handlers["browser.screencast"]({ workspace_id: W, enabled }, connection),
      ),
    /** The tab closes under its viewer, as ServerBrowser's dropTab tells it. */
    close: async (tabId: string) => {
      sessions.splice(
        sessions.findIndex((s) => s.tabId === tabId),
        1,
      );
      await Effect.runPromise(Queue.offer(outputs.get(tabId)!, { _tag: "gone" } as never));
    },
    publish: (tabId: string, reveal?: string) =>
      Effect.runPromise(
        PubSub.publish(events, {
          type: "updated",
          threadId: T,
          tabId,
          snapshot: snapshot(tabId, reveal),
        }),
      ),
    end: () => Effect.runPromise(Scope.close(scope, Effect.void as never)),
  };
}

test("a window whose tab closes, and whose remaining tab won't attach, hears its browser is empty and streams the next tab that does", async () => {
  const h = await harness();
  try {
    h.sessions.push(snapshot("a"));
    h.attachable.add("a");
    await h.screencast();
    expect(h.attached).toEqual(["a"]);

    // Tab b is listed but its page is gone (or its browser down): attaching it fails.
    h.sessions.push(snapshot("b"));
    await h.close("a");
    await until(() => h.states().at(-1) === "about:blank");

    // Once b can attach, its next event streams it to the waiting window.
    h.attachable.add("b");
    await h.publish("b");
    await until(() => h.attached.includes("b") && h.states().at(-1) === "http://127.0.0.1/b");
    expect(h.opened()).toBe(0);
  } finally {
    await h.end();
  }
});

test("a tab revealed while a window follows its closed tab streams to that window", async () => {
  const h = await harness();
  try {
    h.sessions.push(snapshot("a"));
    h.attachable.add("a");
    await h.screencast();

    // The window looks for a tab left once a closes, and its lookup sees none yet...
    const held = h.holdNextList();
    await h.close("a");
    await until(() => held.called);
    // ...while the agent opens b and shows it. Its reveal waits on the window's attach, then streams b to it.
    h.sessions.push(snapshot("b"));
    h.attachable.add("b");
    const before = h.lookups();
    await h.publish("b", "reveal-1");
    // The reveal's resumeWaiting has read the waiting list before the window's lookup answers.
    await until(() => h.lookups() >= before + 2);
    await sleep(50);
    held.release();
    await until(() => h.attached.includes("b") && h.states().at(-1) === "http://127.0.0.1/b");
    await sleep(100);
    expect(h.states().at(-1)).toBe("http://127.0.0.1/b");
    expect(h.opened()).toBe(0);
  } finally {
    await h.end();
  }
});

test("a window whose remaining tab closes before it attaches waits for the next tab, and never opens a blank one", async () => {
  const h = await harness();
  try {
    h.sessions.push(snapshot("a"));
    h.attachable.add("a");
    await h.screencast();

    // Tab b is listed by the window's first lookup once a closes, and gone (the idle sweep) by any later one.
    h.listOnce([snapshot("b")]);
    await h.close("a");
    await until(() => h.states().at(-1) === "about:blank");
    await sleep(100);
    expect(h.opened()).toBe(0);
    expect(h.attached).toEqual(["a"]);
  } finally {
    await h.end();
  }
});

test("a window that stops its screencast while following a closed tab is not streamed the tab that is left", async () => {
  const h = await harness();
  try {
    h.sessions.push(snapshot("a"));
    h.attachable.add("a");
    await h.screencast();

    // Tab b is left once a closes; the window's lookup for it waits while the person closes the live view.
    h.sessions.push(snapshot("b"));
    h.attachable.add("b");
    const held = h.holdNextList();
    await h.close("a");
    await until(() => held.called);
    await h.screencast(false);
    held.release();
    await sleep(100);

    expect(h.states()).not.toContain("http://127.0.0.1/b");
    expect(h.opened()).toBe(0);
  } finally {
    await h.end();
  }
});
