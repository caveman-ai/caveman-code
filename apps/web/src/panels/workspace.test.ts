// A side panel's surfaces read the chat their pane shows, not only what this window's runtime holds.
import type { Workspace } from "@caveman-app/session-protocol";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The panel's own stores and a chat's session and artifacts have no server snapshot: a static render reads the panel
// as one open tab (`showing`) and records which sessions a surface reads.
const at = vi.hoisted(() => ({
  showing: "",
  params: {} as object,
  sessions: [] as Array<string | null>,
}));
vi.mock("./store.ts", async (real) => ({
  ...(await real<object>()),
  usePanel: () => ({
    open: true,
    maximized: false,
    active: "T-1",
    tabs: [{ id: "T-1", kind: at.showing, params: at.params, reveal: 0 }],
    width: null,
  }),
}));
vi.mock("./live/float.ts", async (real) => ({ ...(await real<object>()), useInUse: () => false }));
// The window's pane layout reads `window` as it loads (Computer's Cloud setup reaches it through the transcript).
vi.mock("../panes/drag.ts", () => ({}));
vi.mock("../panes/store.ts", () => ({ panes: {} }));
vi.mock("../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSession: (sessionId: string | null) => (
    at.sessions.push(sessionId),
    { view: null, model: null, historyVersion: 0, feed: null }
  ),
}));
vi.mock("../components/artifacts/store.ts", async (real) => ({
  ...(await real<object>()),
  useArtifacts: (sessionId: string | null) => (at.sessions.push(sessionId), []),
}));

import "../components/artifacts/surface.tsx";
import { PaneCards } from "../components/pane/cards/index.tsx";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import AgentsSurface from "./agents/AgentsSurface.tsx";
import BrowserSurface from "./browser/BrowserSurface.tsx";
import DiffSurface from "./diff/DiffSurface.tsx";
import FileSurface from "./files/FileSurface.tsx";
import ComputerSurface from "./live/ComputerSurface.tsx";
import { useLocalServers } from "./NewTabSurface.tsx";
import { defineSurface, surfaceDef, type SurfaceProps } from "./registry.ts";
import { SidePanel } from "./SidePanel.tsx";
import { defaultBackend, usePanelWorkspace } from "./workspace.ts";

const chat = (
  id: string,
  computer: Workspace["computer"],
  more: Partial<Workspace> = {},
): Workspace =>
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
    ...more,
  }) as Workspace;
const here = { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" } as const;
const cloud = {
  id: "cc-1",
  kind: "caveman_cloud",
  label: "Cloud computer",
  status: "online",
} as const;
// markMovedAway for a move to another of the person's Macs (handlers.ts): this Mac's parked record, the other Mac's id.
const studio = { id: "mac-studio", kind: "this_mac", label: "Studio", status: "online" } as const;
// chatWorkspace (sync/chats-view.ts): Cloud's list shows a chat on another Mac as a "pool" computer.
const studioViaCloud = { ...studio, kind: "pool" } as const;

let read: Workspace | undefined | "not rendered" = "not rendered";
let servers: ReadonlyArray<{ name: string; url: string }> = [];
// The real surfaces, mounted directly (the built-in kinds load lazily, which a static render never waits for).
type Surface = ComponentType<SurfaceProps<never>>;
const kinds = new Map<Surface, string>();
const kindOf = (component: Surface): string => {
  const known = kinds.get(component);
  if (known) return known;
  // Files reads its own kind (a file, or the tree).
  const kind = component === (FileSurface as Surface) ? "file" : `test-${kinds.size}`;
  defineSurface({
    kind: kind as never,
    label: kind,
    icon: () => null,
    title: () => kind,
    component: component as never,
  });
  kinds.set(component, kind);
  return kind;
};
// oxlint-disable-next-line react/globals -- a test probe: it hands what the hook read out to the test.
const Probe = () => ((read = usePanelWorkspace()), null);
// oxlint-disable-next-line react/globals -- a test probe: it hands what the hook read out to the test.
const Servers = ({ workspaceId }: SurfaceProps) => ((servers = useLocalServers(workspaceId)), null);
const Overview = ({ workspaceId }: SurfaceProps) => createElement(PaneCards, { workspaceId });
// Registered by its module, not lazily: the tab itself.
const Artifacts = surfaceDef("artifact")!.component as Surface;
// The chat's own computer, through the sync hub: it never answers here.
const client = {
  call: () => new Promise(() => undefined),
  on: () => () => undefined,
  subscribe: () => () => undefined,
};

/** The side panel the pane mounts for the chat it shows (`shown`) with one `surface` tab, this window's own list `raw`. */
function inPanel(
  shown: Workspace,
  raw: ReadonlyArray<Workspace>,
  surface: Surface = Probe,
  params: object = {},
): string {
  at.showing = kindOf(surface);
  at.params = params;
  const value = {
    status: "connected",
    client,
    connection: 0,
    workspaces: [],
    raw: new Map(raw.map((w) => [w.id, w])),
    projects: [],
    engines: [],
    settings: null,
  } as unknown as RuntimeContextValue;
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(SidePanel, { workspace: shown }),
      }),
    ),
  );
}

test("a chat on a Cloud computer this window's runtime never held: its panel sees it, so Browser opens the agent's", () => {
  const onCloud = chat("W-cloud", cloud);
  inPanel(onCloud, []);
  expect(read).toBe(onCloud);
  expect(defaultBackend(onCloud)).toBe("agent");
});

test("a chat this Mac moved to another Mac: the panel sees where it runs now, and never loads this device's localhost", () => {
  const parked = chat("W-moved", studio);
  const there = chat("W-moved", studioViaCloud);
  inPanel(there, [parked]);
  expect(read).toBe(there);
  // Without Cloud's list the pane shows the parked record: it still doesn't live here.
  expect(defaultBackend(parked)).toBe("agent");
});

test("a chat on this Mac loads pages here", () => {
  const mine = chat("W-here", here);
  inPanel(mine, [mine]);
  expect(read).toBe(mine);
  expect(defaultBackend(mine)).toBe("local");
  expect(defaultBackend(undefined)).toBeNull();
});

// Changes, Files and an HTML preview re-read on the agent's edits (its diff version); Agents lists its subagents;
// Overview shows its cards, Artifacts what it made.
test.each([
  ["Changes", DiffSurface, {}],
  ["Files", FileSurface, { path: "README.md" }],
  ["an HTML preview", BrowserSurface, { path: "/work/report.html" }],
  ["Agents", AgentsSurface, {}],
  ["Overview", Overview, {}],
  ["Artifacts", Artifacts, {}],
] as const)(
  "%s in a chat on a Cloud computer this window never held follows that chat's session",
  (_, surface, params) => {
    at.sessions = [];
    const html = inPanel(chat("W-cloud", cloud), [], surface as Surface, params);
    expect(at.sessions).toContain("S-W-cloud");
    expect(html).not.toContain("not on this runtime");
  },
);

test("Computer names the computer the chat runs on, and a chat on another Mac gets no streamed desktop", () => {
  const onCloud = inPanel(chat("W-cloud", cloud), [], ComputerSurface);
  expect(onCloud).toContain("Cloud computer");
  // Another Mac's desktop is not streamed here; the tab says so and shows the repo's Cloud setup. This Mac's own
  // chats show the app its agent uses (computer use), which ComputerSurface's ThisMac covers.
  for (const [shown, raw] of [[chat("W-studio", studioViaCloud), []]] as const) {
    const html = inPanel(shown, raw, ComputerSurface);
    expect(html).toContain(shown.computer.label);
    expect(html).toContain("The desktop is on Cloud computers");
  }
});

test("an archived chat opened from search (not in this window's list) lists its configured servers", () => {
  inPanel(chat("W-archived", here, { status: "archived", ports: { web: 5173 } }), [], Servers);
  expect(servers).toEqual([{ name: "web", url: "http://localhost:5173" }]);
});
