// A project with several sources, in every state the app shows it, on fixture data through the production components:
// a chat in one source (unchanged), in two and in three (one a plain folder), with and without pull requests; its
// title menu and adding a source (and the runtime's refusal); the Overview after Create PR; New chat's repositories
// control (all, picked, Cloud leaving a folder out); Settings > Projects; and the queue's rows. No runtime and no
// Cloud: a fixture client answers the calls the screens make and plays each chat's one finished turn.
// /src/shell/several-repositories.browser.html?view=<state> (?light for the light theme). States: one | two | three |
// menu-two | menu-one-of-several | added | refused | overview | new-all | new-picked | new-cloud | settings | rows |
// queue. (Every other state of New chat: new-chat.browser.html.)
import {
  ErrorCodes,
  type Project,
  type ProjectSource,
  type Session,
  type SessionEvent,
  type Workspace,
} from "@caveman-app/session-protocol";
import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { PaneFrame } from "../components/pane/PaneFrame.tsx";
import { openSurface, resetPanels } from "../panels/store.ts";
import { NewChatRoute } from "../routes/NewChat.tsx";
import { ProjectsSettings } from "../routes/settings/Projects.tsx";
import { SettingsPage } from "../routes/settings/rows.tsx";
import { RuntimeFixture, workspaceView, type RuntimeContextValue } from "../state/runtime.tsx";
import "../styles.css";
import { Sidebar } from "./Sidebar.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "two";
if (query.has("light")) document.documentElement.classList.remove("dark");

// ------------------------------------------------------------------ the projects

const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const API: ProjectSource = {
  kind: "repo",
  name: "api",
  repository: link("acme/api"),
  path: "/Users/ada/code/api",
};
const WEB: ProjectSource = {
  kind: "repo",
  name: "web",
  repository: link("acme/web"),
  focus: "apps/dashboard",
};
const NOTES: ProjectSource = {
  kind: "folder",
  name: "notes",
  path: "/Users/ada/Documents/billing-notes",
};
const CREATED = { created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" };
const ACME: Project = {
  id: "p-acme",
  name: "acme",
  path: API.path!,
  repository: API.repository!,
  sources: [API, WEB, NOTES],
  ...CREATED,
};
const SOLO: Project = {
  id: "p-solo",
  name: "handbook",
  path: "/Users/ada/code/handbook",
  repository: link("acme/handbook"),
  ...CREATED,
};

// ------------------------------------------------------------------ the chats

const pr = (repo: string, number: number, state: "open" | "draft" | "merged") => ({
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  state,
});
const MAC = {
  id: "this_mac",
  kind: "this_mac",
  label: "This Mac",
  status: "online",
} as Workspace["computer"];
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const chat = (id: string, title: string, over: Partial<Workspace>): Workspace =>
  ({
    id,
    session_id: `s-${id}`,
    title,
    status: "idle",
    engine: "claude-agent",
    repo: { path: API.path! },
    base_ref: "main",
    branch: "caveman/rename-billing-endpoint",
    project_id: ACME.id,
    created_at: at(40),
    updated_at: at(3),
    computer: MAC,
    unmerged: { files: 2, commits: 1 },
    ...over,
  }) as Workspace;
const WEB_CHECKOUT = {
  name: "web",
  repo: { url: WEB.repository!.clone_url },
  repository: WEB.repository!,
  base_ref: "main",
  branch: "caveman/rename-billing-endpoint",
};
const NOTES_CHECKOUT = {
  name: "notes",
  repo: { path: NOTES.path! },
  base_ref: "",
  branch: "",
  folder: true as const,
};

const ONE = chat("one", "Tidy the handbook's setup page", {
  project_id: SOLO.id,
  repo: { path: SOLO.path },
  branch: "caveman/tidy-setup-page",
  pull_request: pr("acme/handbook", 31, "open"),
  // The line under its title in the queue (the others say what waits to land).
  activity: {
    last_reply:
      "The setup page now starts with the one command that installs everything, and the old Homebrew steps moved to a footnote.",
  },
});
const TWO = chat("two", "Rename the billing endpoint", {
  source: "api",
  activity: {
    last_reply:
      "Renamed /charges to /payments in both apps. The web client still calls the old path behind a redirect until #57 lands.",
  },
  pull_request: pr("acme/api", 128, "open"),
  checkouts: [
    {
      ...WEB_CHECKOUT,
      pull_request: pr("acme/web", 57, "draft"),
      unmerged: { files: 0, commits: 2 },
    },
  ],
});
const THREE = chat("three", "Document the webhook retries", {
  source: "api",
  branch: "caveman/webhook-retries",
  checkouts: [
    { ...WEB_CHECKOUT, branch: "caveman/webhook-retries", unmerged: { files: 1, commits: 0 } },
    NOTES_CHECKOUT,
  ],
});
const ONE_OF_SEVERAL = chat("alone", "Speed up the invoice query", {
  branch: "caveman/invoice-query",
});
const CHATS = [ONE, TWO, THREE, ONE_OF_SEVERAL];

// What each chat's one finished turn changed: every path of a chat in several sources starts with its source's name.
interface Changed {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly lines: ReadonlyArray<string>;
}
const changed = (
  path: string,
  lines: ReadonlyArray<string>,
  status: Changed["status"] = "modified",
): Changed => ({ path, status, lines });
const FILES: Record<string, ReadonlyArray<Changed>> = {
  one: [
    changed("docs/setup.md", [
      " ## Setup",
      "-Run `npm install`, then `npm start`.",
      "+Run `pnpm install`, then `pnpm dev`.",
      " ",
    ]),
    changed("README.md", [" # Handbook", "+See docs/setup.md to run it."]),
  ],
  two: [
    changed("api/src/routes/billing.ts", [
      ' import { router } from "../router";',
      '-router.get("/v1/billing/usage", usage);',
      '+router.get("/v1/billing/statements", statements);',
      " ",
    ]),
    changed("api/src/routes/billing.test.ts", [
      '-  const res = await get("/v1/billing/usage");',
      '+  const res = await get("/v1/billing/statements");',
    ]),
    changed("web/apps/dashboard/src/api/billing.ts", [
      '-export const usage = () => get("/v1/billing/usage");',
      '+export const statements = () => get("/v1/billing/statements");',
    ]),
    changed("web/apps/dashboard/src/pages/Billing.tsx", [
      '-import { usage } from "../api/billing";',
      '+import { statements } from "../api/billing";',
      " ",
      "-  const data = useQuery(usage);",
      "+  const data = useQuery(statements);",
    ]),
  ],
  three: [
    changed("api/src/webhooks/retry.ts", [
      " export const RETRIES = 5;",
      "+/** Backs off 2s, 4s, 8s, 16s, 32s, then gives up and marks the delivery failed. */",
      " export function schedule(attempt: number) {",
    ]),
    changed("web/apps/dashboard/src/pages/Webhooks.tsx", [
      "-      <p>Deliveries are retried.</p>",
      "+      <p>Deliveries are retried five times, backing off from 2 to 32 seconds.</p>",
    ]),
    changed(
      "notes/webhooks.md",
      ["+# Webhook retries", "+", "+Five attempts, backing off from 2 to 32 seconds."],
      "added",
    ),
  ],
  alone: [
    changed("src/invoices/query.ts", [
      "-  return db.invoices.findMany({ where });",
      "+  return db.invoices.findMany({ where, select: LIST_FIELDS });",
    ]),
  ],
};
const counts = (f: Changed) => ({
  additions: f.lines.filter((l) => l.startsWith("+")).length,
  deletions: f.lines.filter((l) => l.startsWith("-")).length,
});
const patchOf = (f: Changed) =>
  `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,${f.lines.filter((l) => !l.startsWith("+")).length} +1,${f.lines.filter((l) => !l.startsWith("-")).length} @@\n${f.lines.join("\n")}\n`;
const SAID: Record<string, readonly [string, string]> = {
  one: [
    "The setup page still says npm. Make it pnpm.",
    "The setup page and the README now say pnpm.",
  ],
  two: [
    "Rename GET /v1/billing/usage to /v1/billing/statements, in the API and the dashboard.",
    "Renamed in both: the route and its test in api, the client and the Billing page in web. Each has its own pull request.",
  ],
  three: [
    "Write down how webhook retries work: in the code, on the dashboard and in my notes.",
    "Documented in all three: a comment on the schedule in api, the sentence on the dashboard, and a new page in your notes.",
  ],
  alone: [
    "The invoice list is slow.",
    "It read every column. It now selects only what the list shows.",
  ],
};

/** A chat's journal: the person's message, the answer, the checkpoint its turn ended at, its context use, and the turn's end. */
function journal(w: Workspace): SessionEvent[] {
  const [asked, answered] = SAID[w.id] ?? SAID.two!;
  const events: Array<
    Pick<SessionEvent, "type"> & { payload: unknown; item_id?: string; turn_id?: string }
  > = [
    { type: "message.done", payload: { role: "user", text: asked }, item_id: "u1" },
    { type: "turn.started", payload: { engine: w.engine }, turn_id: "t1" },
    {
      type: "message.done",
      payload: { role: "assistant", text: answered },
      item_id: "a1",
      turn_id: "t1",
    },
    {
      type: "diff.changed",
      payload: {
        files: (FILES[w.id] ?? []).map((f) => ({ path: f.path, status: f.status, ...counts(f) })),
      },
      turn_id: "t1",
    },
    {
      type: "checkpoint.created",
      payload: {
        checkpoint_id: "checkpoint:1",
        ref: "refs/caveman/1",
        files: (FILES[w.id] ?? []).map((f) => ({ path: f.path, ...counts(f) })),
      },
      turn_id: "t1",
    },
    // What the turn used of its window: the ring at the end of the box's foot.
    {
      type: "context.updated",
      payload: { used_tokens: 38_400, window_tokens: 200_000 },
      turn_id: "t1",
    },
    { type: "turn.done", payload: { status: "completed" }, turn_id: "t1" },
  ];
  return events.map(
    (e, i) => ({ session_id: w.session_id, cursor: i + 1, at: at(4), ...e }) as SessionEvent,
  );
}

// ------------------------------------------------------------------ the cases

interface Case {
  readonly kind: "chat" | "new" | "settings" | "rows";
  /** The chat shown. */
  readonly chat?: Workspace;
  /** The side panel's tab beside it. */
  readonly panel?: "diff" | "overview";
  /** Clicked in turn once the page is up: a button or menu row by its words (`>` first: by its accessible name). */
  readonly press?: ReadonlyArray<string>;
  /** workspace.add_source is refused, in these words. */
  readonly refuse?: string;
  /** New chat: the sources left out last time, and where it was asked to run. */
  readonly leftOut?: ReadonlyArray<string>;
  /** What the page must say. */
  readonly says: ReadonlyArray<string>;
  readonly never?: ReadonlyArray<string>;
}

const REFUSAL =
  "Stop this chat's turn first: adding a source to a chat that works in one source restarts its agent in the chat's folder.";
const CASES: Record<string, Case> = {
  // One source: nothing of sources shows. Its pull request is the one glyph beside the title, its files as they are.
  one: {
    kind: "chat",
    chat: ONE,
    panel: "diff",
    says: ["Changed 2 files", "docs/setup.md", "setup.md"],
    never: ["Chat's folder", "handbook caveman"],
  },
  two: {
    kind: "chat",
    chat: TWO,
    panel: "diff",
    says: [
      "Changed 4 files",
      "src/routes/billing.ts",
      "apps/dashboard/src/api/billing.ts",
      "4 files",
    ],
    never: ["api/src/routes", "web/apps/dashboard"],
  },
  three: {
    kind: "chat",
    chat: THREE,
    panel: "diff",
    says: ["Changed 3 files", "src/webhooks/retry.ts", "webhooks.md", "Folder"],
    never: ["notes/webhooks.md"],
  },
  "menu-two": {
    kind: "chat",
    chat: TWO,
    press: [`>${TWO.title}`],
    says: ["This Mac", "caveman/rename-billing-endpoint", "Add notes", "Folder"],
    never: ["Add a source", "Add web"],
  },
  "menu-one-of-several": {
    kind: "chat",
    chat: ONE_OF_SEVERAL,
    press: [`>${ONE_OF_SEVERAL.title}`, "Add a source"],
    says: ["Add a source", "acme/web", "Folder"],
  },
  added: {
    kind: "chat",
    chat: TWO,
    press: [`>${TWO.title}`, "Add notes", `>${TWO.title}`],
    says: ["notes"],
    never: ["Add notes", "Add a source"],
  },
  refused: {
    kind: "chat",
    chat: ONE_OF_SEVERAL,
    press: [`>${ONE_OF_SEVERAL.title}`, "Add a source", "web"],
    refuse: REFUSAL,
    says: [REFUSAL],
  },
  overview: {
    kind: "chat",
    chat: TWO,
    panel: "overview",
    press: ["Create PR"],
    says: ["acme/api", "acme/web", "#128", "#57"],
    never: ["View PR"],
  },
  // The pill names what the chat works in; the project's own is plain text in the menu, the rest are ticks.
  "new-all": {
    kind: "new",
    press: [">Works in api, web, notes"],
    says: ["api, web, notes", "Works in", "acme/api", "acme/web", "Folder"],
    never: ["All sources"],
  },
  "new-picked": {
    kind: "new",
    leftOut: ["notes"],
    press: [">Works in api, web"],
    says: ["api, web", "Works in"],
    never: ["All sources", "api, web, notes"],
  },
  // Cloud is pickable with the folder ticked: it is left out there, and the pill says so. Nothing says to untick.
  "new-cloud": {
    kind: "new",
    press: [">Runs on This Mac", ">Cloud"],
    says: ["Cloud · without notes", "api, web"],
    never: ["Untick", "stays here"],
  },
  settings: {
    kind: "settings",
    says: [
      "Its sources",
      "acme/api · ~/code/api",
      "acme/web · Not on this Mac yet: cloned when a chat first works in it · Focus on apps/dashboard",
      "Folder · ~/Documents/billing-notes",
      "Add a source",
    ],
  },
  rows: { kind: "rows", says: [TWO.title, THREE.title, ONE.title] },
  queue: {
    kind: "rows",
    says: [TWO.title, THREE.title, ONE.title, "Ready for review", "3 files, 1 commit"],
  },
};
const picked = CASES[view] ?? CASES.two!;

// ------------------------------------------------------------------ the runtime

const CAPABILITIES = {
  structured: true,
  resume_across_machines: true,
  steer: true,
  fork: true,
  restore: true,
  approvals: true,
  plans: true,
  subagents: true,
  images: true,
  mcp: true,
  tool_hooks: true,
};
const ENGINES = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    capabilities: CAPABILITIES,
    access_modes: ["ask", "auto"],
    models: [
      {
        id: "fable-5-2",
        label: "Fable 5.2",
        efforts: ["low", "medium", "high"],
        default_effort: "medium",
      },
    ],
    auth: { state: "signed_in", accounts: [] },
  },
];

let chats = new Map(CHATS.map((w) => [w.id, w]));
let project = ACME;

const client = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  attach: async (id: string, cursor: number, onEvent: (event: SessionEvent) => void) => {
    const w = [...chats.values()].find((c) => c.session_id === id)!;
    const events = journal(w);
    setTimeout(() => events.filter((e) => e.cursor > cursor).forEach(onEvent), 0);
    return {
      session: { id, head: events.length, engine: w.engine } as unknown as Session,
      cursor: () => events.length,
      epoch: () => 1,
      detach: async () => undefined,
    };
  },
  call: async (method: string, params: Record<string, unknown> = {}) => {
    const w = typeof params.workspace_id === "string" ? chats.get(params.workspace_id) : undefined;
    // A runtime with no Chief: the sidebar shows chats only.
    if (method.startsWith("chief."))
      throw new SessionProtocolError({ code: -32601, message: "method not found" });
    switch (method) {
      case "queue.list":
        return { turns: [] };
      case "editor.list":
        return { editors: [], reveal: false };
      case "session.move.held":
        return { paths: [] };
      case "actions.list":
        return { actions: [] };
      case "term.list":
        return { terminals: [] };
      case "plugin.list":
        return { plugins: [] };
      case "cloud.status":
        return { state: "off" };
      case "cloud.computers":
        return { available: false, computers: [] };
      case "secret.list":
        return { repository: "acme/api", secrets: [], cloud_available: false };
      case "secret.env_files":
        return { files: [] };
      case "project.discover":
        return { candidates: [], clone_dir: "/Users/ada/code" };
      case "project.branches":
        return {
          checkout: "main",
          branches: [{ name: "main", current: true, default: true }],
          more: false,
        };
      case "environment.get":
        return {
          available: true,
          environment: {
            state: "ready",
            build: null,
            secret_names: [],
            repo: "acme/api",
            config: "",
            source: "cloud",
            snapshot: null,
          },
          setup_chat: null,
          fix: null,
        };
      case "fs.diff":
        return {
          from: "main",
          to: "WORKTREE",
          files: (FILES[w?.id ?? ""] ?? []).map((f) => ({
            path: f.path,
            status: f.status,
            ...counts(f),
            patch: patchOf(f),
          })),
        };
      case "git.pr":
        return {
          ...pr("acme/api", 128, "open"),
          pull_requests: [
            { source: "api", ...pr("acme/api", 128, "open") },
            { source: "web", ...pr("acme/web", 57, "open") },
          ],
        };
      case "workspace.add_source": {
        if (picked.refuse)
          throw new SessionProtocolError({
            code: ErrorCodes.invalid_state,
            message: picked.refuse,
            data: { reason: "invalid_state" },
          });
        const added =
          params.source === "notes" ? NOTES_CHECKOUT : { ...WEB_CHECKOUT, branch: w!.branch };
        return { ...w!, source: w!.source ?? "api", checkouts: [...(w!.checkouts ?? []), added] };
      }
      case "project.add_source": {
        const typed = String(params.repository ?? params.path);
        const name = typed.replace(/\/+$/, "").split("/").pop()!;
        const source: ProjectSource = params.path
          ? { kind: "folder", name, path: typed.replace(/^~/, "/Users/ada") }
          : { kind: "repo", name, repository: link(typed.replace(/^https:\/\/github\.com\//, "")) };
        return (project = { ...project, sources: [...project.sources!, source] });
      }
      case "project.remove_source":
        return (project = {
          ...project,
          sources: project.sources!.filter((s) => s.name !== params.name),
        });
      default:
        return {};
    }
  },
} as unknown as Client;

/** The runtime's value now; a workspace a call answered (adopt) or a project a call changed (refresh) draws it again. */
function runtime(): RuntimeContextValue {
  const raw = new Map([...chats.values()].map((w) => [w.id, w]));
  return {
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
    engines: ENGINES,
    settings: { default_engine: "claude-agent", engines: {}, model_defaults: {} },
    workspaces: [...raw.values()].map((w) => workspaceView(w, "Claude Agent")),
    raw,
    projects: [project, SOLO],
    refresh: async () => draw(),
    markSeen: () => undefined,
    adopt: (w: Workspace) => {
      chats = new Map(chats).set(w.id, w);
      draw();
    },
  } as unknown as RuntimeContextValue;
}

// ------------------------------------------------------------------ the page

/** The window a chat's pane sits in: wide enough for the side panel beside the chat. */
const Window = ({
  children,
  width = 1240,
  height = 660,
}: {
  children: ReactNode;
  width?: number;
  height?: number;
}) => (
  <div
    data-case={view}
    style={{ width, height }}
    className="relative overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)]"
  >
    {children}
  </div>
);

function Page() {
  if (picked.kind === "settings") {
    return (
      // Settings' own frame: its width, and the page's title as Settings gives it.
      <section
        data-case={view}
        className="h-[600px] w-[832px] overflow-hidden rounded-xl border-[0.5px] border-border bg-background px-8 pt-10 shadow-[var(--shadow-frame)]"
      >
        <SettingsPage title="Projects">
          <ProjectsSettings />
        </SettingsPage>
      </section>
    );
  }
  if (picked.kind === "new") {
    return (
      // New chat fills the window it is in: as wide as the page, so a narrow window is a narrow New chat.
      <div
        data-case={view}
        className="relative h-[620px] w-full overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)]"
      >
        <Routes>
          <Route path="/new" element={<NewChatRoute />} />
          <Route path="*" element={null} />
        </Routes>
      </div>
    );
  }
  if (picked.kind === "rows") {
    return (
      <Window width={300} height={620}>
        <Sidebar />
      </Window>
    );
  }
  return (
    <Window>
      <PaneFrame
        pane={{ kind: "pane", id: "p1", workspaceId: picked.chat!.id } as never}
        focused
        canSplit={false}
      />
    </Window>
  );
}

if (picked.leftOut)
  localStorage.setItem(
    "caveman.newChat.sourcesLeftOut",
    JSON.stringify({ [ACME.id]: picked.leftOut }),
  );
else localStorage.removeItem("caveman.newChat.sourcesLeftOut");
localStorage.setItem("caveman.lastProject", ACME.id);
// The sidebar keeps its view: by project for `rows`, the queue for `queue`.
localStorage.setItem("caveman.sidebarQueue", view === "queue" ? "1" : "0");
localStorage.setItem("caveman.diff.files", "1");
// The file list beside a side panel's diffs is the person's to open: open in the chat in three sources.
localStorage.setItem("caveman.diff.files.narrow", view === "three" ? "1" : "0");
// The side panel remembers its tabs per chat: each state starts from none.
localStorage.removeItem("caveman.panels.v1");
resetPanels();
if (picked.chat && picked.panel) openSurface(picked.chat.id, picked.panel, {});

const host = document.getElementById("several-repositories")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
function draw() {
  flushSync(() =>
    root.render(
      <MemoryRouter initialEntries={[picked.kind === "new" ? `/new?project=${ACME.id}` : "/"]}>
        <RuntimeFixture value={runtime()}>
          <TooltipProvider>
            <main className="p-5 text-foreground">
              <Page />
            </main>
          </TooltipProvider>
        </RuntimeFixture>
      </MemoryRouter>,
    ),
  );
}
draw();

const tick = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const said = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
/** A press as a pointer makes it: Radix opens a menu on pointerdown, a row picks on click. */
function pressOn(el: Element) {
  const at = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" };
  el.dispatchEvent(new PointerEvent("pointerdown", at));
  el.dispatchEvent(new PointerEvent("pointerup", at));
  (el as HTMLElement).click();
}
const clickable = () => [
  ...document.querySelectorAll<HTMLElement>("button, [role='menuitem'], [role='menuitemcheckbox']"),
];

async function run() {
  const problems: string[] = [];
  // The chat's history and its side panel arrive a moment after the pane.
  await tick(600);
  for (const name of picked.press ?? []) {
    const target = name.startsWith(">")
      ? clickable().find(
          (b) =>
            b.getAttribute("aria-label") === name.slice(1) ||
            b.textContent?.trim() === name.slice(1) ||
            b.textContent?.trim().startsWith(name.slice(1)),
        )
      : clickable().findLast(
          (b) => b.textContent?.trim() === name || b.textContent?.trim().startsWith(name),
        );
    if (target) pressOn(target);
    else problems.push(`nothing to press: ${name}`);
    await tick(350);
  }
  await tick(300);
  for (const text of picked.says) if (!said().includes(text)) problems.push(`missing: ${text}`);
  for (const text of picked.never ?? [])
    if (said().replace("Running…", "").includes(text)) problems.push(`must not say: ${text}`);
  // Spend never shows in a chat, and Claude's engine is never called Claude Code.
  if (/\$\d/.test(said())) problems.push("a dollar amount is on the page");
  if (said().includes("Claude Code")) problems.push("says Claude Code");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
}
void run();
