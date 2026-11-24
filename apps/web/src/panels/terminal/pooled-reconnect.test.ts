// A terminal in a pane for a chat on another computer attaches through the sync hub's pooled connection to that
// computer (PaneFrame's ChatClientScope). The runtime forgets a dropped connection's attachments, so the terminal
// attaches again each time that connection opens, while the window's own runtime never blinks. The real SyncHub,
// runtime pool, ChatClientScope and TerminalSurface; xterm draws nothing here, and the computer's socket is a fake.
import { document as doc } from "../../testing/dom.ts";
import type { ConnectionState } from "@caveman-app/session-protocol/client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 120;
    rows = 30;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    open() {}
    focus() {}
    dispose() {}
    reset() {}
    clear() {}
    write(_: string, done?: () => void) {
      done?.();
    }
    getSelectionPosition() {
      return undefined;
    }
    select() {}
  },
}));

const { TooltipProvider } = await import("@caveman-app/ui/components/tooltip");
const { ChatClientScope, chatClientFor, RuntimeFixture } = await import("../../state/runtime.tsx");
const { fakeCloud, fakeRuntimeClient, runtime, summary, until } =
  await import("../../state/sync/fakes.test-support.ts");
const { SyncHub } = await import("../../state/sync/hub.ts");
const { memoryKv } = await import("../../state/sync/kv.ts");
const { onlyPage } = await import("../../state/sync/pages.ts");
const { default: TerminalSurface } = await import("./TerminalSurface.tsx");

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a terminal in a chat on another computer attaches again after that computer's connection drops and reopens", async () => {
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
  cleanups.push(() => hub.stop());
  hub.start();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box", workspace_id: "w1" }));
  await until(() => hub.summary("s1") !== undefined);
  // The pane's transcript reads the chat from the box, holding its connection (useSession, hub.openFeed).
  hub.openFeed("s1", { reset: () => undefined, apply: () => undefined }, () => undefined);
  await until(() => hub.pool.link("rt-box") === "open");

  // The window's own runtime stays up throughout: its reconnect counter never moves.
  const window = { status: "connected", client: home.client, connection: 1 } as never;
  const tab = { id: "T-1", kind: "terminal", params: { terminalId: "term-1" }, reveal: 0 } as never;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const terminal = createElement(TerminalSurface, { workspaceId: "w1", tab, active: true });
  const pane = createElement(ChatClientScope, {
    client: chatClientFor(hub, "s1"),
    children: createElement(TooltipProvider, null, terminal),
  });
  await act(async () =>
    root.render(createElement(RuntimeFixture, { value: window, children: pane })),
  );
  await settle();
  const attaches = () =>
    box.calls.filter(
      (c) =>
        c.method === "term.attach" &&
        (c.params as { terminal_id: string }).terminal_id === "term-1",
    ).length;
  expect(attaches()).toBe(1);

  // The relay link to the box blips and reconnects: the runtime forgot this connection's attachment.
  await act(async () => {
    socket!("connecting");
    socket!("open");
  });
  await settle();
  expect(attaches()).toBe(2);
});
