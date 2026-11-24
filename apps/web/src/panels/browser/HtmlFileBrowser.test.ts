// An HTML preview re-read for an agent's edit to another file, or for a reconnect, keeps the page the person is using.
// The real SidePanel and session store, mounted with their effects running (linkedom).
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterAll, expect, test } from "vitest";
import { RuntimeFixture } from "../../state/runtime.tsx";
import { SidePanel } from "../SidePanel.tsx";
import { openSurface } from "../store.ts";
// The tab loads its surface on first show: loaded here, it arrives within a tick.
import "./BrowserSurface.tsx";

const noop = () => undefined;
const PATH = "/work/report.html";
const HTML = "<h1>Report</h1><form><input name='q'></form>";

// The blob URLs the preview makes and releases (the web path: no desktop bridge).
const made: string[] = [];
const revoked: string[] = [];
const { createObjectURL, revokeObjectURL } = URL;
URL.createObjectURL = (blob: Blob) => {
  const url = createObjectURL(blob);
  made.push(url);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  revoked.push(url);
  revokeObjectURL(url);
};
afterAll(() => Object.assign(URL, { createObjectURL, revokeObjectURL }));

// The chat's computer: each read of the file waits for the test to answer it, and its feed is pushed by hand.
const reads: Array<(html: string) => void> = [];
let push: (event: unknown) => void = noop;
const client = {
  call: (method: string) =>
    method === "browser.readFile"
      ? new Promise((resolve) => reads.push((html) => resolve({ html })))
      : new Promise(noop),
  on: () => noop,
  subscribe: () => noop,
  attach: async (session_id: string, _cursor: number, onEvent: (event: unknown) => void) => {
    push = onEvent;
    // The backlog up to the head: the agent wrote the report earlier in the chat.
    onEvent({
      cursor: 1,
      type: "diff.changed",
      at: "2026-11-06T09:59:00Z",
      payload: { files: [{ path: "report.html", status: "added", additions: 1, deletions: 0 }] },
    });
    return {
      session: { id: session_id, head: 1, state: "live", mode: "default" },
      epoch: () => 1,
      detach: async () => undefined,
    };
  },
};
const chat = {
  id: "W-report",
  session_id: "S-report",
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
const runtime = (connection: number) => ({
  status: "connected",
  error: null,
  client,
  identity: {},
  connection,
  workspaces: [],
  raw: new Map([[chat.id, chat]]),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 2)));
};

test("an agent edit to another file and a reconnect re-read the HTML without reloading the page; Reload starts over", async () => {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  // The app's router: the strip goes to the window tab a dragged tab becomes (#69).
  const render = (connection: number) =>
    act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(RuntimeFixture, {
            value: runtime(connection) as never,
            children: createElement(SidePanel, { workspace: chat }),
          }),
        ),
      ),
    );
  openSurface(chat.id, "browser", { path: PATH });
  await render(1);
  await settle();
  await act(async () => reads.shift()!(HTML));
  await settle();
  const first = host.querySelector("iframe");
  expect(first?.getAttribute("src")).toMatch(/^blob:/);
  const shown = () => {
    const frame = host.querySelector("iframe");
    return {
      loading: host.textContent!.includes("Loading HTML"),
      page:
        frame === first && frame?.getAttribute("src") === first?.getAttribute("src")
          ? "the same"
          : frame
            ? "another"
            : "none",
    };
  };
  /** What shows while the file is read again, and once the same bytes are back. */
  const reread = async (cause: () => Promise<unknown>) => {
    await cause();
    await settle();
    const reading = { asked: reads.length, ...shown() };
    await act(async () => reads.shift()!(HTML));
    await settle();
    return { reading, read: shown() };
  };
  const inPlace = {
    reading: { asked: 1, loading: false, page: "the same" },
    read: { loading: false, page: "the same" },
  };

  const edit = {
    cursor: 2,
    type: "diff.changed",
    at: "2026-11-06T10:00:00Z",
    payload: { files: [{ path: "src/other.ts", status: "modified", additions: 1, deletions: 0 }] },
  };
  expect(await reread(() => act(async () => push(edit)))).toEqual(inPlace);
  expect(await reread(() => render(2))).toEqual(inPlace);
  expect({ made: made.length, revoked: revoked.length }).toEqual({ made: 1, revoked: 0 });

  // Reload is the person asking for the file anew.
  const reload = host.querySelector<HTMLButtonElement>('button[aria-label="Reload"]')!;
  await act(async () => reload.click());
  await settle();
  expect({ asked: reads.length, ...shown() }).toEqual({ asked: 1, loading: true, page: "none" });
  await act(async () => root.unmount());
});
