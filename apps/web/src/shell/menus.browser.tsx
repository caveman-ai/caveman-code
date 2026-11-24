// ⌘K and the composer's + and / menus at their size, on fixture data through the production components: ⌘K empty
// (the launcher, its filter strip on All), typed ("fix"), and on its Actions filter; the + menu; the / menu. No
// runtime: a fixture client answers the calls ⌘K makes.
// /src/shell/menus.browser.html?view=<palette|typed|actions|add|slash> (?light for the light theme). It checks the
// sizes it draws (the menu row of STYLE.md section 5: 32px, 13px words, a 16px mark) and prints PASS or what is off.
import type { Client } from "@caveman-app/session-protocol/client";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import {
  Attachment01Icon,
  FireIcon,
  Image01Icon,
  NoteAddIcon,
  PuzzleIcon,
  Target02Icon,
} from "@caveman-app/ui/icons/huge";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  ComposerAddMenu,
  filterAddMenu,
  type AddRow,
  type AddSection,
} from "../components/ComposerAddMenu.tsx";
import { COMMANDS } from "../components/composer-complete.ts";
import type { WorkspaceView } from "../state/model.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";
import { GoTo } from "./GoTo.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "palette";
if (query.has("light")) document.documentElement.classList.remove("dark");

// ------------------------------------------------------------------ the chats

const HOUR = 3_600_000;
const chat = (
  id: string,
  title: string,
  engine: readonly [string, string],
  projectId: string,
  hoursAgo: number,
): WorkspaceView => ({
  id,
  title,
  repo: projectId === "p-api" ? "acme/api" : "acme/web",
  repoRef: { path: `/Users/ada/code/${projectId.slice(2)}` },
  branch: `caveman/${id}`,
  state: "completed",
  asleep: false,
  detail: null,
  engine: { id: engine[0], label: engine[1] },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: `s-${id}`,
  projectId,
  createdAt: new Date(Date.now() - (hoursAgo + 1) * HOUR).toISOString(),
  updatedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  unread: false,
});
const CLAUDE = ["claude-agent", "Claude Agent"] as const;
const CODEX = ["codex", "Codex"] as const;
const CAVEMAN = ["caveman", "Caveman"] as const;
const WORKSPACES: ReadonlyArray<WorkspaceView> = [
  chat("w1", "Fix the flaky billing webhook test", CLAUDE, "p-api", 0.2),
  chat("w2", "Rename usage to statements in the dashboard", CODEX, "p-web", 1),
  chat("w3", "Why the deploy preview is blank on Safari", CAVEMAN, "p-web", 3),
  chat("w4", "Fix pagination on the invoices list", CLAUDE, "p-api", 5),
  chat("w5", "Add rate limits to the public API", CODEX, "p-api", 26),
  chat("w6", "Move the settings page to the new layout", CLAUDE, "p-web", 50),
  chat("w7", "Draft the November release notes", CAVEMAN, "p-web", 80),
];
const PROJECTS = [
  {
    id: "p-api",
    name: "api",
    path: "/Users/ada/code/api",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
  },
  {
    id: "p-web",
    name: "web",
    path: "/Users/ada/code/web",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
  },
];

const client = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  call: async (method: string) => {
    // No Chiefs here: ⌘K lists the Chief page instead.
    if (method.startsWith("chief."))
      throw new SessionProtocolError({ code: -32601, message: "method not found" });
    if (method === "chat.search") return { chats: [] };
    return {};
  },
} as unknown as Client;

const runtime = {
  status: "connected",
  error: null,
  client,
  connection: 1,
  identity: {
    orgName: "Acme",
    computerName: "This Mac",
    computerWord: "this Mac",
    computerOnline: true,
    userName: "Ada",
    plan: null,
  },
  engines: [],
  settings: { theme: "dark", text_size: "default", engines: {}, model_defaults: {} },
  workspaces: WORKSPACES,
  raw: new Map(),
  projects: PROJECTS,
  refresh: async () => undefined,
  markSeen: () => undefined,
} as unknown as RuntimeContextValue;

// ------------------------------------------------------------------ the composer's menus

const ADD: AddSection[] = [
  {
    title: "Add",
    items: [
      {
        id: "files",
        icon: Attachment01Icon,
        label: "Files",
        description: "Attach files from your computer",
      },
      {
        id: "images",
        icon: Image01Icon,
        label: "Images",
        description: "Screenshots and pictures, or paste one",
      },
      { id: "goal", icon: Target02Icon, label: "Goal", description: "Set a goal to keep pursuing" },
      {
        id: "grill",
        icon: FireIcon,
        label: "Grill mode",
        description: "Answer its questions first, then build",
      },
      {
        id: "skill",
        icon: NoteAddIcon,
        label: "Record a skill",
        description: "Turn what you do next into a skill",
      },
    ],
  },
  {
    title: "Plugins",
    items: [
      {
        id: "p1",
        icon: PuzzleIcon,
        label: "acme-backend",
        description: "Migration skill, Datadog and Linear MCP",
      },
      {
        id: "p2",
        icon: PuzzleIcon,
        label: "release-notes",
        description: "Draft release notes from merged PRs",
      },
    ],
  },
  {
    title: "Chats",
    items: WORKSPACES.slice(0, 5).map((w) => ({
      id: `chat:${w.id}`,
      engine: w.engine.id,
      label: w.title,
      description: w.repo,
    })),
  },
];
// A bare "/": the commands as the composer lists them (Composer.tsx commandRows), each name with its other names below.
const SLASH: AddRow[] = COMMANDS.map((c) => {
  const others = c.names.slice(1);
  return {
    section: "Commands",
    item: {
      id: `cmd:${c.id}`,
      icon: c.icon,
      label: `/${c.names[0]}`,
      description: c.description,
      ...(c.args?.required ? { hint: c.args.hint } : {}),
      ...(others.length ? { detail: `also ${others.map((n) => `/${n}`).join("  ")}` } : {}),
    },
  };
});

/** The composer under its menu, as the chat shows it: the menu opens upward over the box. */
function Composer({ text }: { text: string }) {
  const menu =
    view === "slash" ? (
      <ComposerAddMenu
        id="menu"
        rows={SLASH}
        active={0}
        query=""
        onHover={() => undefined}
        onPick={() => undefined}
        label="Commands and skills"
        keys={[
          ["↵", "run"],
          ["⇥", "complete"],
          ["esc", ""],
        ]}
        column
      />
    ) : (
      <ComposerAddMenu
        id="menu"
        rows={filterAddMenu(ADD, "")}
        active={0}
        query=""
        onHover={() => undefined}
        onPick={() => undefined}
        search="Files, plugins, chats and more"
      />
    );
  return (
    <div className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-end px-6 pb-6">
      <div className="relative">
        {menu}
        <div className="composer-card rounded-2xl px-[11px] pb-2 pt-2.5">
          <div className="min-h-[66px] px-1 text-[14px] leading-[22px] text-foreground">{text}</div>
        </div>
      </div>
    </div>
  );
}

const host = document.getElementById("menus")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter initialEntries={["/"]}>
      <RuntimeFixture value={runtime}>
        <TooltipProvider>
          <main
            data-case={view}
            style={{ height: "calc(100vh - 26px)" }}
            className="flex min-h-0 flex-col bg-background text-foreground"
          >
            {view === "add" || view === "slash" ? (
              <Composer text={view === "slash" ? "/" : "@"} />
            ) : (
              <GoTo open onOpenChange={() => undefined} onCloseAutoFocus={() => undefined} />
            )}
          </main>
        </TooltipProvider>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

// ------------------------------------------------------------------ the checks

const tick = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const px = (el: Element | null, prop: "fontSize" | "height" | "maxHeight") =>
  el ? Math.round(parseFloat(getComputedStyle(el)[prop]) * 10) / 10 : NaN;
/** Types into ⌘K's field as a person does: React reads the native value setter and an input event. */
function type(field: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function check(): Promise<string[]> {
  const off: string[] = [];
  const want = (what: string, got: number, expected: number) =>
    got !== expected && off.push(`${what}: ${got}px, want ${expected}px`);
  await tick();
  if (view === "add" || view === "slash") {
    const list = document.getElementById("menu")!;
    const row = list.querySelector('[role="option"]');
    want("row height", px(row, "height"), 32);
    want("row text", px(row, "fontSize"), 13);
    want("list height at most", px(list, "maxHeight"), 252);
    want("mark", px(row?.querySelector("svg") ?? null, "height"), 16);
    return off;
  }
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  if (view === "typed") type(field, "fix");
  // Two presses of → in the empty field, a moment apart as a person makes them: All, Chats, Actions.
  for (let i = 0; view === "actions" && i < 2; i++) {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick(50);
  }
  await tick(300);
  want("field text", px(field, "fontSize"), 15);
  const row = document.querySelector('#goto-list [role="option"]');
  if (!row) return [...off, "no rows"];
  want("row height", px(row, "height"), 32);
  want("row text", px(row, "fontSize"), 13);
  const tab = document.querySelector('[role="tab"][aria-selected="true"]');
  const chosen = { palette: "All", typed: "All", actions: "Actions" }[view];
  if (tab?.textContent !== chosen)
    off.push(`filter: ${tab?.textContent ?? "none"}, want ${chosen}`);
  return off;
}

void check().then(
  (off) => (result.textContent = off.length ? `FAIL ${view}\n${off.join("\n")}` : `PASS ${view}`),
  (error: unknown) => (result.textContent = `FAIL ${view}\n${String(error)}`),
);
