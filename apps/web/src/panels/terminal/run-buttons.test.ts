// The Run button on a shell block, in a document the side panel reads and in a reply: pressed again once the command
// has finished, it runs the command again rather than bringing back the finished run. Mounted beside the real
// SidePanel with effects running (linkedom); xterm draws nothing here, and the chat's computer is a client that
// starts and ends terminals.
import { document as doc } from "../../testing/dom.ts";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

// The strip takes tabs dragged onto it (#69); no drag happens here.
vi.mock("../../panes/drag.ts", () => ({ registerDropTarget: () => () => undefined }));
vi.mock("../../panes/store.ts", () => ({ panes: {}, announce: () => undefined }));
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
const { RuntimeFixture } = await import("../../state/runtime.tsx");
const { SessionModel } = await import("../../state/transcript.ts");
const { Transcript } = await import("../../components/Transcript.tsx");
const { FileView } = await import("../files/FileView.tsx");
const { SidePanel } = await import("../SidePanel.tsx");
const { getPanel, resetPanels } = await import("../store.ts");
// The tab loads its surface on first show: loaded here, it arrives within a tick.
await import("./TerminalSurface.tsx");

const COMMAND = "pnpm test";
const BLOCK = `Run the tests:\n\n\`\`\`sh\n${COMMAND}\n\`\`\`\n`;
const chat = {
  id: "W-run",
  session_id: "S-run",
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

// The chat's computer: term.open starts T1, T2, …; the test ends them.
const opened: string[] = [];
const closed: string[] = [];
const exited = new Set<string>();
const listeners = new Map<string, Set<(p: unknown) => void>>();
const client = {
  call: async (method: string, p: { command?: string; terminal_id?: string }) => {
    if (method === "term.open") return { terminal_id: `T${opened.push(p.command ?? "")}` };
    if (method === "term.close") closed.push(p.terminal_id ?? "");
    if (method === "term.attach")
      return { scrollback: "", cols: 120, rows: 30, exited: exited.has(p.terminal_id ?? "") };
    if (method === "term.list")
      return {
        terminals: opened.map((_, i) => ({
          terminal_id: `T${i + 1}`,
          cwd: ".",
          exited: exited.has(`T${i + 1}`),
          exit_code: 0,
        })),
      };
    if (method.startsWith("term.")) return {};
    return new Promise(() => undefined);
  },
  on: (event: string, listener: (p: unknown) => void) => {
    const set = listeners.get(event) ?? listeners.set(event, new Set()).get(event)!;
    set.add(listener);
    return () => void set.delete(listener);
  },
  subscribe: () => () => undefined,
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
let unmount = async () => undefined;
afterEach(async () => {
  await unmount();
  resetPanels();
  opened.length = 0;
  closed.length = 0;
  exited.clear();
});

/** Mounts `view` beside the chat's side panel, presses its Run button, lets the run finish, and presses it again. */
async function pressAgainAfterItEnds(view: ReactNode) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => {
    unmount = async () => undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  const pane = createElement(
    TooltipProvider,
    null,
    view,
    createElement(SidePanel, { workspace: chat }),
  );
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeFixture, { value: runtime as never, children: pane }),
      ),
    ),
  );
  await settle();
  const press = async () => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Run in a terminal"]')!.click(),
    );
    await settle();
  };
  const shows = () => ({
    terminal: (
      getPanel(chat.id).tabs.find((t) => t.kind === "terminal")?.params as
        | { terminalId?: string }
        | undefined
    )?.terminalId,
    ended: host.textContent!.includes("Exited with code 0"),
  });
  await press();
  const first = shows();
  exited.add("T1");
  await act(async () =>
    listeners
      .get("term.exit")
      ?.forEach((listener) => listener({ terminal_id: "T1", exit_code: 0 })),
  );
  await settle();
  const ended = shows();
  await press();
  return { first, ended, again: shows(), opened: [...opened], closed: [...closed] };
}

const RAN_AGAIN = {
  first: { terminal: "T1", ended: false },
  ended: { terminal: "T1", ended: true },
  again: { terminal: "T2", ended: false },
  opened: [COMMAND, COMMAND],
  closed: ["T1"],
};

test("Run on a shell block in a document, pressed again after the run ended, runs the command anew", async () => {
  const file = {
    path: "README.md",
    content: BLOCK,
    encoding: "utf8",
    size: BLOCK.length,
    truncated: false,
  };
  const view = createElement(FileView, {
    workspaceId: chat.id,
    root: undefined,
    path: "README.md",
    state: { status: "ready", file } as never,
    mode: "preview",
    wrap: false,
    revealLine: undefined,
    onLink: () => undefined,
    onRetry: () => undefined,
    version: null,
  });
  expect(await pressAgainAfterItEnds(view)).toEqual(RAN_AGAIN);
});

test("Run on a shell block in a reply, pressed again after the run ended, runs the command anew", async () => {
  const model = new SessionModel();
  const at = "2026-11-06T10:00:00.000Z";
  for (const [cursor, type, payload] of [
    [1, "message.done", { role: "user", text: "How do I test it?" }],
    [2, "message.done", { role: "assistant", text: BLOCK }],
  ] as const)
    model.apply({
      session_id: chat.session_id,
      cursor,
      at,
      type,
      payload,
      item_id: `m${cursor}`,
    } as unknown as SessionEvent);
  const v = model.snapshot();
  const view = createElement(Transcript, {
    items: v.items,
    engineLabel: "Claude Agent",
    engine: "claude-agent",
    engineIsCaveman: false,
    running: false,
    onAnswer: () => undefined,
    cavemanVersion: null,
    workspaceId: chat.id,
  });
  expect(await pressAgainAfterItEnds(view)).toEqual(RAN_AGAIN);
});
