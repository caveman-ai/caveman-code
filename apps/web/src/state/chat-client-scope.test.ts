// A pane showing a chat on another computer talks to it through the sync hub's pooled connection (PaneFrame's
// ChatClientScope), not the window's own. What its surfaces set up on that connection (a command's live output, the
// Computer view's screencast, a terminal's attach) is gone when it drops; they set it up again when `connection`
// changes. The real SyncHub, runtime pool, ChatClientScope and surface hooks; the box's socket is a fake.
import type { ConnectionState } from "@caveman-app/session-protocol/client";
import { createElement, Fragment, useMemo } from "react";
import { afterEach, expect, test } from "vitest";
import { useLiveCommandOutput } from "../components/transcript/LiveOutput.tsx";
import { useLive } from "../panels/live/LiveView.tsx";
import { computerSource } from "../panels/live/source.ts";
import { mount } from "./dom.test-support.ts";
import {
  ChatClientScope,
  chatClientFor,
  RuntimeFixture,
  useRuntimeClient,
  type RuntimeContextValue,
} from "./runtime.tsx";
import {
  fakeCloud,
  fakeRuntimeClient,
  runtime,
  summary,
  until,
} from "./sync/fakes.test-support.ts";
import { SyncHub } from "./sync/hub.ts";
import { memoryKv } from "./sync/kv.ts";
import { onlyPage } from "./sync/pages.ts";

// A page's animation frames, which node has none of: LiveOutput renders a command's output once per frame.
Object.assign(globalThis, {
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: clearTimeout,
});

const hubs: SyncHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
});

/** A window on This Mac with a chat that runs on a Cloud computer, open in a pane: the box's socket, as the pool holds it. */
async function paneOnTheBox() {
  const cloud = fakeCloud();
  const home = fakeRuntimeClient();
  const box = fakeRuntimeClient();
  let socket: ((state: ConnectionState, error?: Error) => void) | undefined;
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: memoryKv(),
    home: () => ({ runtimeId: "rt-mac", client: home.client }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "t" }),
    connect: ((
      _url: string,
      _token: unknown,
      onState?: (state: ConnectionState, error?: Error) => void,
    ) => {
      socket = onState;
      queueMicrotask(() => onState?.("open"));
      return box.client;
    }) as never,
  });
  hubs.push(hub);
  hub.start();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box", workspace_id: "w1" }));
  await until(() => hub.summary("s1") !== undefined);
  // The pane's transcript reads the chat from the box, holding its connection (useSession, hub.openFeed).
  hub.openFeed("s1", { reset: () => undefined, apply: () => undefined }, () => undefined);
  await until(() => hub.pool.link("rt-box") === "open");

  const Watch = () => (useLiveCommandOutput("w1", "item-1", true), null);
  const Screen = () => {
    const { client, connection } = useRuntimeClient();
    const source = useMemo(() => (client ? computerSource(client, "w1") : null), [client]);
    useLive(source, true, connection);
    return null;
  };
  // The window's own runtime stays up throughout: its reconnect counter never moves.
  const window = {
    status: "connected",
    client: home.client,
    connection: 1,
  } as unknown as RuntimeContextValue;
  const page = await mount(null);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  const surfaces = createElement(Fragment, null, createElement(Watch), createElement(Screen));
  await page.render(
    createElement(RuntimeFixture, {
      value: window,
      children: createElement(ChatClientScope, {
        client: chatClientFor(hub, "s1"),
        children: surfaces,
      }),
    }),
  );
  await page.settle();
  const count = (method: string) =>
    box.calls.filter(
      (c) => c.method === method && (c.params as { enabled?: boolean }).enabled !== false,
    ).length;
  return {
    socket: (state: ConnectionState, error?: Error) => socket!(state, error),
    page,
    watches: () => count("tool.watch"),
    screencasts: () => count("computer.screencast"),
  };
}

test("a chat on another computer: its live command output and Computer view come back after that computer's connection drops", async () => {
  const pane = await paneOnTheBox();
  expect({ watches: pane.watches(), screencasts: pane.screencasts() }).toEqual({
    watches: 1,
    screencasts: 1,
  });

  // The relay link to the box blips and reconnects: the runtime forgot this connection's watch and screencast.
  pane.socket("connecting");
  pane.socket("open");
  await pane.page.settle();
  expect({ watches: pane.watches(), screencasts: pane.screencasts() }).toEqual({
    watches: 2,
    screencasts: 2,
  });
});

test("a chat on another computer: a path that went under its connection, which says open again, sets them up again too", async () => {
  const pane = await paneOnTheBox();
  // connectDirect: the relay went while the direct channel carried the calls, so what was set up on it is gone.
  pane.socket("open");
  await pane.page.settle();
  expect({ watches: pane.watches(), screencasts: pane.screencasts() }).toEqual({
    watches: 2,
    screencasts: 2,
  });
});
