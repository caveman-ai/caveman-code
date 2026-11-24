// A chat this Mac moved to another computer (a lid-close move, Move to Cloud): its earlier turns ran here and name
// files by this Mac's checkout path. The pane shows it as Cloud's list has it (chatWorkspace), with no root_path or
// ports of this Mac's, yet those earlier paths still read and open relative to the chat's folder: the moved branch has
// the same files there. Nothing copies this Mac's old path. The real SessionPane, transcript and StepDiff.
import { container, settle } from "../../lib/dom.test-support.ts";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { useArtifacts } from "../artifacts/store.ts";
import { StepDiff } from "../../panels/diff/StepDiff.tsx";
import { getPanel, resetPanels } from "../../panels/store.ts";
import { PanelWorkspace } from "../../panels/workspace.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { chatWorkspace, whereOf } from "../../state/sync/chats-view.ts";
import { runtime, summary } from "../../state/sync/fakes.test-support.ts";
import type { Artifact } from "../../state/transcript-model.ts";
import { SessionPane } from "./PaneFrame.tsx";

/** This Mac's checkout of the chat, where its earlier turns ran. */
const HERE = "/Users/dev/.caveman/worktrees/app-fix-login";

// markMovedAway's parked record: this Mac's worktree and the ports it allocated there stay on it.
const parked: Workspace = {
  id: "w1",
  title: "Fix login",
  repo: { url: "https://github.com/acme/app" },
  base_ref: "main",
  branch: "fix-login",
  engine: "caveman",
  computer: { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" },
  session_id: "s1",
  status: "parked",
  root_path: HERE,
  ports: { web: 4310 },
  project_id: "p1",
  created_at: "2026-10-21T10:00:00.000Z",
  updated_at: "2026-10-21T11:00:00.000Z",
};
const runtimes = new Map(
  [runtime("rt-cloud-1"), runtime("rt-studio", { kind: "laptop" })].map((r) => [r.runtime_id, r]),
);
const destinations = [
  [
    "a Cloud computer",
    summary("s1", { workspace_id: "w1", runtime_id: "rt-cloud-1", status: "idle" }),
  ],
  [
    "another Mac",
    summary("s1", {
      workspace_id: "w1",
      runtime_id: "rt-studio",
      where: { kind: "laptop", name: "Studio" },
      status: "idle",
    }),
  ],
] as const;
/** The pane's workspace for the moved chat, as PaneFrame builds it from Cloud's list over the parked record. */
const moved = (chat: (typeof destinations)[number][1]) =>
  chatWorkspace(chat, whereOf(chat, runtimes, "rt-mac"), parked);

let cursor = 0;
const ev = (
  type: SessionEvent["type"],
  payload: unknown,
  extra: Partial<SessionEvent> = {},
): SessionEvent =>
  ({
    session_id: "s1",
    cursor: ++cursor,
    at: "2026-10-21T10:30:00.000Z",
    type,
    payload,
    ...extra,
  }) as SessionEvent;
/** The turn this Mac ran before the move: an edit and an answer that name the file by this Mac's path. */
const earlierTurn = (): SessionEvent[] => {
  cursor = 0;
  return [
    ev("message.done", { role: "user", text: "fix the login" }, { item_id: "u1" }),
    ev("turn.started", { engine: "caveman" }),
    ev(
      "tool.started",
      {
        name: "Edit",
        title: `${HERE}/src/login.ts`,
        kind: "edit",
        input: { file_path: `${HERE}/src/login.ts`, old_string: "a", new_string: "b" },
      },
      { item_id: "t1" },
    ),
    ev(
      "tool.done",
      { status: "completed", result: { additions: 1, deletions: 1 } },
      { item_id: "t1" },
    ),
    ev(
      "message.done",
      {
        role: "assistant",
        text: `Fixed it in [login.ts](${HERE}/src/login.ts#L12). The session check is in \`${HERE}/src/session.ts\`.`,
      },
      { item_id: "a1" },
    ),
    ev("turn.done", { status: "completed" }),
  ];
};

/** The chat's computer, through the sync hub: it replays the chat's journal and reads its files. */
const chatComputer = (events: ReadonlyArray<SessionEvent>) => ({
  call: (method: string) => {
    if (method === "queue.list") return Promise.resolve({ turns: [] });
    if (method === "editor.list") return Promise.resolve({ editors: [], reveal: false });
    if (method === "fs.list")
      return Promise.resolve({
        entries: [
          { path: "src/login.ts", type: "file" },
          { path: "src/session.ts", type: "file" },
        ],
      });
    if (method === "tool.diff")
      return Promise.resolve({ path: `${HERE}/src/login.ts`, diff: "@@ -1 +1 @@\n-a\n+b\n" });
    return Promise.resolve({});
  },
  on: () => () => undefined,
  subscribe: () => () => undefined,
  attach: async (sessionId: string, _cursor: number, onEvent: (e: SessionEvent) => void) => {
    queueMicrotask(() => events.forEach(onEvent));
    return {
      session: {
        id: sessionId,
        workspace_id: "w1",
        engine: "caveman",
        state: "live",
        head: events.length,
      },
      cursor: () => events.length,
      detach: async () => undefined,
    };
  },
});

let unmount = async () => undefined;
afterEach(async () => {
  await unmount();
  resetPanels();
});

async function render(children: ReactNode, client: unknown) {
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [],
    // This window's runtime keeps the parked record; the pane shows the chat where it runs now.
    raw: new Map([[parked.id, parked]]),
    projects: [],
    engines: [
      { id: "caveman", label: "Caveman", auth: { state: "api_key" }, capabilities: {}, models: [] },
    ],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
    adopt: () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(MemoryRouter, null, createElement(RuntimeFixture, { value, children })),
      ),
    ),
  );
  for (let i = 0; i < 5; i++) await settle();
  unmount = async () => {
    unmount = async () => undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

const contextMenu = (el: Element) =>
  act(
    async () =>
      void el.dispatchEvent(
        Object.assign(new Event("contextmenu", { bubbles: true, cancelable: true }), {
          clientX: 10,
          clientY: 10,
        }),
      ),
  );

test.each(destinations)(
  "a chat this Mac moved to %s: its earlier turn's paths read and open relative to the chat's folder, and none copies this Mac's",
  async (_, chat) => {
    const workspace = moved(chat);
    expect(workspace).not.toHaveProperty("root_path");
    let artifacts: ReadonlyArray<Artifact> = [];
    const Artifacts = () => ((artifacts = useArtifacts("s1")), null);
    const host = await render(
      [
        createElement(SessionPane, {
          key: "pane",
          pane: null,
          workspace,
          client: chatComputer(earlierTurn()) as never,
          focused: true,
          canSplit: false,
        }),
        createElement(Artifacts, { key: "artifacts" }),
      ],
      chatComputer(earlierTurn()),
    );
    // The answer, the edit's line and the code span name the files as the chat's folder has them.
    const transcript = host.querySelector(".pane-conversation")!;
    expect(transcript.textContent).toContain("Fixed it in");
    expect(transcript.textContent).not.toContain(HERE);
    // The side panel's Artifacts reads the edited file from the chat's folder, not as one outside it.
    expect(
      artifacts.filter((a) => a.kind === "file").map((a) => a.kind === "file" && a.path),
    ).toEqual(["src/login.ts"]);

    // The answer's link opens the file in the side panel, at the line it names.
    const link = [...transcript.querySelectorAll("a")].find((a) => a.textContent === "login.ts");
    await act(
      async () =>
        void link!.dispatchEvent(
          Object.assign(new Event("click", { bubbles: true, cancelable: true }), { button: 0 }),
        ),
    );
    await settle();
    expect(getPanel("w1").tabs.map((t) => [t.kind, t.params])).toContainEqual([
      "file",
      { path: "src/login.ts", line: 12 },
    ]);

    // The code span is a file chip whose menu copies the path in the chat's folder, never this Mac's full path.
    const chip = [...transcript.querySelectorAll("button")].find(
      (b) => b.textContent === "session.ts",
    );
    await contextMenu(chip!);
    const items = [...document.querySelectorAll("[role='menuitem']")].map((m) =>
      m.textContent?.trim(),
    );
    expect(items).toContain("Copy path");
    expect(items).not.toContain("Copy full path");
  },
);

test.each(destinations)(
  "a chat this Mac moved to %s: one edit's own diff names the file as the chat's folder has it",
  async (_, chat) => {
    const workspace = moved(chat);
    const host = await render(
      createElement(
        PanelWorkspace.Provider,
        { value: workspace },
        createElement(StepDiff, { workspaceId: "w1", item: "t1" }),
      ),
      chatComputer([]),
    );
    const bar = host.querySelector("[title]");
    expect(bar?.textContent).toBe("src/login.ts");
  },
);
