// The Browser tab's backend comes from the chat its pane shows: the real SidePanel, mounted with its effects running
// (linkedom), opens a Browser tab the way the + menu does ({}) or a local-server row does ({ url }).
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { ChatClientScope, RuntimeFixture } from "../../state/runtime.tsx";
import { SidePanel } from "../SidePanel.tsx";
import { getPanel, openSurface, resetPanels } from "../store.ts";
// The tab loads its surface on first show: loaded here, it arrives within a tick.
import "./BrowserSurface.tsx";

const noop = () => undefined;
// This Mac's page loads probe the address first: every address this device asked for.
const probed: string[] = [];
globalThis.fetch = (async (url: string) => (
  probed.push(String(url)),
  new Response(null, { status: 200 })
)) as typeof fetch;

const chat = (id: string, computer: Workspace["computer"]): Workspace =>
  ({
    id,
    session_id: `S-${id}`,
    title: "Chat",
    status: "idle",
    engine: "caveman",
    repo: { url: "" },
    base_ref: "",
    branch: "",
    created_at: "",
    updated_at: "",
    computer,
  }) as Workspace;
const here = { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" } as const;
const cloud = {
  id: "cc-1",
  kind: "caveman_cloud",
  label: "Cloud computer",
  status: "online",
} as const;
// A move to another of the person's Macs (handlers.ts, markMovedAway with the target's kind): this Mac keeps the chat
// as a parked "this_mac" record carrying the other Mac's id.
const studio = { id: "mac-studio", kind: "this_mac", label: "Studio", status: "online" } as const;
// chatWorkspace (sync/chats-view.ts): Cloud's list shows a chat on another Mac as a "pool" computer.
const studioViaCloud = { ...studio, kind: "pool" } as const;

// Runtimes that never answer: this window's own, and the chat's own computer through the sync hub (PaneFrame's
// ChatClientScope), which records the addresses its agent's browser is sent to.
const silent = () => ({
  call: (_: string, _params: unknown) => new Promise(noop),
  on: () => noop,
  subscribe: () => noop,
  attach: () => new Promise(noop),
});
const windowRuntime = silent();
const sentThere: string[] = [];
const chatComputer = {
  ...silent(),
  call: (method: string, params: { url?: string }) => (
    method === "browser.navigate" && sentThere.push(params.url ?? ""),
    new Promise(noop)
  ),
};

let unmount = async () => undefined;
afterEach(async () => {
  await unmount();
  resetPanels();
  probed.length = 0;
  sentThere.length = 0;
});

/** The pane showing `shown` in a window whose runtime holds `raw`, with a Browser tab opened on `params`. */
async function browserTab(
  shown: Workspace,
  raw: ReadonlyArray<Workspace>,
  params: { url?: string },
) {
  openSurface(shown.id, "browser", params);
  const value = {
    status: "connected",
    error: null,
    client: windowRuntime,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(raw.map((r) => [r.id, r])),
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
  };
  const host = doc.createElement("div");
  host.setAttribute("data-pane", "");
  doc.body.appendChild(host);
  const root = createRoot(host);
  // PaneFrame: <ChatClientScope client={remote}><SessionPane/></ChatClientScope>; SessionPane: <SidePanel workspace={workspace}/>.
  const pane = createElement(ChatClientScope, {
    client: chatComputer as never,
    children: createElement(SidePanel, { workspace: shown }),
  });
  // The app's router: the strip goes to the window tab a dragged tab becomes (#69).
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeFixture, { value: value as never, children: pane }),
      ),
    ),
  );
  // The surface arrives a tick after the tab shows; a bare open becomes the agent's tab in an effect.
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
  unmount = async () => {
    unmount = async () => undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  return {
    backends: getPanel(shown.id).tabs.map(
      (t) => (t.params as { backend?: string }).backend ?? "(none)",
    ),
    agentsBrowser: host.querySelector('[aria-label="Take over"]') !== null,
    sentThere: [...sentThere],
    probedHere: [...probed],
    framedHere: [...host.querySelectorAll("iframe, webview")].map((el) => el.getAttribute("src")),
  };
}

const LOCAL_SERVER = "http://localhost:5173/";
const opens = [
  ["from the + menu", {}, []],
  ["on a local server's address", { url: LOCAL_SERVER }, [LOCAL_SERVER]],
] as const;
const agents = (sent: ReadonlyArray<string>) => ({
  backends: ["agent"],
  agentsBrowser: true,
  sentThere: sent,
  probedHere: [],
  framedHere: [],
});

test.each(opens)(
  "Browser %s in a chat on a Cloud computer this window's runtime never held opens the agent's browser there",
  async (_, params, sent) => {
    expect(await browserTab(chat("W-cloud", cloud), [], params)).toEqual(agents(sent));
  },
);

test.each(opens)(
  "Browser %s in a chat this Mac moved to another Mac opens the agent's browser there, never this device's localhost",
  async (_, params, sent) => {
    const parked = chat("W-moved", studio);
    // As Cloud's list shows it.
    expect(await browserTab(chat("W-moved", studioViaCloud), [parked], params)).toEqual(
      agents(sent),
    );
    await unmount();
    resetPanels();
    sentThere.length = 0;
    // As the parked record shows it, with no Cloud list: still not this Mac's.
    expect(await browserTab(parked, [parked], params)).toEqual(agents(sent));
  },
);

test("a local server in a chat on this Mac loads here", async () => {
  const mine = chat("W-here", here);
  expect(await browserTab(mine, [mine], { url: LOCAL_SERVER })).toEqual({
    backends: ["(none)"],
    agentsBrowser: false,
    sentThere: [],
    probedHere: [LOCAL_SERVER],
    framedHere: [LOCAL_SERVER],
  });
});
