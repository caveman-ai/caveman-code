// What the app says of Cloud, on fixture rows through the production screens: Settings > Computers in every state it
// has (the person's Macs, Cloud and its projects, a start that is held up or failed, the plan used up, signed out,
// turned off, deleting a project, and what happens when this Mac sleeps). No runtime and no Cloud: a fixture client
// answers the calls the screen makes.
// It checks what it draws, and prints PASS or what is missing. What a browser window opens on is web-window.browser.html.
// /src/shell/cloud-computers.browser.html?view=<state> (?light for the light theme). States: list | open | paused |
// held | failed | signed-out | off | unreachable | delete | delete-refused | lid-on | lid-exceptions | lid-off.
import type { CloudComputerRow, EngineDescriptor, Settings } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ComputersSettings } from "../routes/settings/Computers.tsx";
import { forgetConnects } from "../routes/settings/Connections.tsx";
import type { LidSummary } from "../routes/settings/lid-summary.ts";
import { SettingsPage } from "../routes/settings/rows.tsx";
import { CLOUD_FAILED, CLOUD_HELD_UP } from "../state/cloud.ts";
import type { WorkspaceView } from "../state/model.ts";
import {
  ComputersCloudContext,
  RuntimeFixture,
  type RuntimeContextValue,
} from "../state/runtime.tsx";
import type { CloudApi } from "../state/sync/cloud-api.ts";
import "../styles.css";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "list";
if (query.has("light")) document.documentElement.classList.remove("dark");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const computer = (
  id: string,
  name: string,
  over: Partial<CloudComputerRow> = {},
): CloudComputerRow => ({
  id,
  name,
  driver: "boat",
  size: "4cpu-16gb",
  desired_state: "running",
  observed_state: "running",
  observed_reason: "",
  updated_at: ago(HOUR),
  ...over,
});
const ASLEEP = { desired_state: "suspended", observed_state: "suspended" } as const;
/** What a driver wrote about a start: never on a row, only behind Details. */
const DRIVER = "0/3 nodes are available: 3 Insufficient memory.";

const chat = (
  id: string,
  title: string,
  engine: readonly [string, string],
  computer: WorkspaceView["computer"],
  over: Partial<WorkspaceView> = {},
): WorkspaceView =>
  ({
    id,
    title,
    repo: "acme/acme-web",
    repoRef: { url: "https://github.com/acme/acme-web" },
    branch: null,
    state: "idle",
    asleep: false,
    detail: null,
    engine: { id: engine[0], label: engine[1] },
    computer,
    parentId: null,
    sessionId: `s-${id}`,
    projectId: "p-web",
    createdAt: ago(HOUR),
    updatedAt: ago(HOUR),
    unread: false,
    ...over,
  }) as WorkspaceView;
const CLAUDE = ["claude-agent", "Claude Agent"] as const;
const CODEX = ["codex", "Codex"] as const;
const CAVEMAN = ["caveman", "Caveman"] as const;
const HERE = { kind: "this_mac", label: "This Mac" } as const;
const inCloud = (id: string) => ({ kind: "caveman_cloud", label: "Cloud", id }) as const;

const PROJECTS = [
  {
    id: "p-web",
    name: "acme-web",
    path: "/Users/ada/acme-web",
    repository: { host: "github.com", full_name: "acme/acme-web" },
  },
  {
    id: "p-api",
    name: "billing-api",
    path: "/Users/ada/billing-api",
    repository: { host: "github.com", full_name: "acme/billing-api" },
  },
  {
    id: "p-docs",
    name: "docs-site",
    path: "/Users/ada/docs-site",
    repository: { host: "github.com", full_name: "acme/docs-site" },
  },
  { id: "p-notes", name: "notes", path: "/Users/ada/notes", no_git: true },
];

/** This Mac's chats, one on another Mac of the person's, and the ones in Cloud. */
const CHATS: ReadonlyArray<WorkspaceView> = [
  chat("1", "Fix the login redirect", CLAUDE, HERE),
  chat("2", "Port settings to flat rows", CODEX, HERE),
  chat("3", "Weekly notes", CAVEMAN, HERE, { projectId: "p-notes", repo: "/Users/ada/notes" }),
  chat("4", "Tidy the release script", CLAUDE, {
    kind: "laptop",
    label: "Studio",
    id: "mac-studio",
  }),
  chat("9", "Speed up CI", CLAUDE, HERE),
  chat("5", "Refactor auth", CLAUDE, inCloud("c-web")),
  chat("6", "Upgrade the router", CODEX, inCloud("c-web")),
  chat("7", "Invoice rounding", CLAUDE, inCloud("c-api"), {
    projectId: "p-api",
    repo: "acme/billing-api",
  }),
  chat("8", "Rewrite the quickstart", CLAUDE, inCloud("c-docs"), {
    projectId: "p-docs",
    repo: "acme/docs-site",
  }),
];

const WEB = computer("c-web", "cc-7f3a9e", {});
const API = computer("c-api", "cc-19be02", { size: "8cpu-32gb" });
const DOCS = computer("c-docs", "cc-55d0c1", ASLEEP);
const RUNNING = [WEB, API, DOCS];
const USED_UP = { ...ASLEEP, sleep_reason: "usage" } as const;

const lid = (
  id: string,
  outcome: LidSummary["chats"][number]["outcome"],
  reason?: string,
): LidSummary["chats"][number] => ({
  session_id: `s-${id}`,
  outcome,
  ...(reason ? { reason } : {}),
  gaps: [],
});

interface Case {
  readonly computers: ReadonlyArray<CloudComputerRow>;
  /** cloud.status and cloud.computers answer as: signed out of Caveman, Cloud turned off, or not at all. */
  readonly cloud?: "signed_out" | "off" | "unreachable";
  /** The lid's settings; absent: never chosen. */
  readonly settings?: Partial<Settings>;
  /** cloud.lid.summary's chats. */
  readonly lid?: LidSummary["chats"];
  /** Deleting a project is refused. */
  readonly refuseDelete?: boolean;
  /** Buttons pressed in turn once the list is up, by their name; "menu:<name>" opens a row's menu. */
  readonly press?: ReadonlyArray<string>;
  /** What the page must say, and how many times. */
  readonly says: ReadonlyArray<readonly [string, number]>;
  readonly never?: ReadonlyArray<string>;
}

/** What Settings > Computers never says, whatever the state: a machine's name or size, a driver's words, a button to wake or sleep one. */
const NEVER = [
  "cc-7f3a9e",
  "cc-19be02",
  "CPU",
  " GB",
  "4cpu",
  "Wake",
  "Sleep now",
  "Open",
  "workspace",
  DRIVER,
  "updates when it next wakes",
];

const CASES: Record<string, Case> = {
  // The whole screen: this Mac, the person's other Macs by name, Cloud, and the one setting under them, never chosen.
  list: {
    computers: RUNNING,
    says: [
      ["This Mac", 1],
      ["4 chats", 2],
      ["Studio", 1],
      ["1 chat", 1],
      ["Asleep", 1],
      ["MacBook Air", 1],
      ["0 chats", 1],
      ["Online", 2],
      ["Cloud", 1],
      ["2 running · 12% of this month's plan", 1],
      ["When this Mac sleeps", 1],
      ["Pause them", 1],
    ],
    never: [...NEVER, "Keep chats going in Cloud", "acme-web"],
  },
  // Cloud opened: one line per project, by the project's name, with its chats and its state.
  open: {
    // The last has no chat this window knows: it goes by Cloud's own name for it.
    computers: [
      ...RUNNING,
      computer("c-land", "landing", { observed_state: "starting", observed_reason: "booting" }),
    ],
    press: ["Cloud"],
    says: [
      ["acme-web", 1],
      ["2 chats", 1],
      ["billing-api", 1],
      ["docs-site", 1],
      ["landing", 1],
      ["Running", 2],
      ["Asleep", 2],
      ["Waking…", 1],
      ["2 running · 12% of this month's plan", 1],
    ],
    never: NEVER,
  },
  // The plan is used up: Cloud is paused until it resets, and nothing here offers to wake it.
  paused: {
    computers: [
      computer("c-web", "cc-7f3a9e", USED_UP),
      computer("c-api", "cc-19be02", USED_UP),
      computer("c-docs", "cc-55d0c1", USED_UP),
    ],
    press: ["Cloud"],
    says: [
      ["Paused until", 4],
      ["plan used up", 4],
    ],
    never: NEVER,
  },
  // A start that is held up: one sentence, and what Cloud's own service wrote only behind Details.
  held: {
    computers: [
      WEB,
      computer("c-api", "cc-19be02", { observed_state: "starting", observed_reason: DRIVER }),
      DOCS,
    ],
    press: ["Cloud"],
    says: [
      [CLOUD_HELD_UP, 2],
      ["Details", 2],
    ],
    never: NEVER,
  },
  // A start that failed for good: what to do is in the sentence.
  failed: {
    computers: [
      WEB,
      computer("c-api", "cc-19be02", { observed_state: "failed", observed_reason: DRIVER }),
      DOCS,
    ],
    press: ["Cloud", "Details"],
    says: [
      [CLOUD_FAILED, 2],
      [DRIVER, 1],
      ["Hide details", 1],
    ],
    never: NEVER.filter((text) => text !== DRIVER),
  },
  "signed-out": {
    computers: [],
    cloud: "signed_out",
    says: [
      ["Not signed in", 1],
      ["Sign in", 1],
    ],
    never: [...NEVER, "When this Mac sleeps"],
  },
  off: {
    computers: [],
    cloud: "off",
    says: [["Turned off by your admin", 1]],
    never: [...NEVER, "Sign in", "When this Mac sleeps"],
  },
  unreachable: {
    computers: [],
    cloud: "unreachable",
    says: [
      ["Can't reach Caveman. Trying again.", 1],
      ["Details", 1],
    ],
    never: [...NEVER, "ECONNREFUSED"],
  },
  // Deleting a project: the one question on the screen, with what it archives by name.
  delete: {
    computers: RUNNING,
    press: ["Cloud", "menu:acme-web in Cloud: options", "Delete…"],
    says: [
      ["Delete acme-web from Cloud?", 1],
      [
        "Archives 2 chats: Refactor auth, Upgrade the router. Uncommitted work there is lost. Chat history is kept.",
        1,
      ],
    ],
    never: NEVER,
  },
  // A delete Cloud refuses: its line says why, under the project it was pressed on.
  "delete-refused": {
    computers: RUNNING,
    refuseDelete: true,
    press: ["Cloud", "menu:acme-web in Cloud: options", "Delete…", "Delete"],
    says: [
      ["Caveman had a problem. Try again.", 1],
      ["acme-web", 1],
    ],
    never: NEVER,
  },
  // Chats keep going in Cloud and every one of them will: nothing is listed, and nothing says all is well.
  "lid-on": {
    computers: RUNNING,
    settings: { sync_chats: true, move_to_cloud: true },
    lid: [lid("1", "continues"), lid("2", "continues")],
    says: [["Keep chats going in Cloud", 1]],
    never: [...NEVER, "Pauses", "Stays here", "Every chat", "Fix the login redirect"],
  },
  // Only the chats that will not carry on, each with why in a few words and its button.
  "lid-exceptions": {
    computers: RUNNING,
    settings: { sync_chats: true, move_to_cloud: true },
    lid: [
      lid("1", "pauses", "Claude Agent needs a login on Cloud"),
      lid("2", "pauses", "Codex chats stay on this Mac when the lid closes"),
      lid("3", "continues"),
      lid("9", "pauses", "Neither your plan nor your credits: neither can pay now"),
    ],
    says: [
      ["Pauses · Claude isn't connected", 1],
      ["Connect Claude", 1],
      ["Pauses · Codex chats turned off", 1],
      ["Turn on", 1],
      ["Stays here · folder project", 1],
      ["Pauses · plan used up", 1],
      ["See plans", 1],
    ],
    never: NEVER,
  },
  "lid-off": {
    computers: RUNNING,
    settings: { sync_chats: true, move_to_cloud: false },
    lid: [lid("1", "pauses", "Claude Agent needs a login on Cloud")],
    says: [["Pause them", 1]],
    never: [...NEVER, "Pauses ·", "Connect Claude"],
  },
};

const picked = CASES[view] ?? CASES.list!;

/** Cloud's list as the page reads it now: a deleted project leaves it. */
let listed = [...picked.computers];
/** The first of next month, when a monthly plan starts over. */
const nextMonth = () => {
  const at = new Date();
  return new Date(at.getFullYear(), at.getMonth() + 1, 1, 12).toISOString();
};

const CAPABILITIES = {
  structured: true,
  resume_across_machines: true,
  steer: true,
  fork: true,
  approvals: true,
  plans: true,
  subagents: true,
  images: true,
  mcp: true,
  tool_hooks: true,
};
const engine = (
  id: string,
  label: string,
  models: ReadonlyArray<string>,
  auth: Partial<EngineDescriptor["auth"]> = {},
): EngineDescriptor =>
  ({
    id,
    label,
    capabilities: CAPABILITIES,
    access_modes: ["ask", "auto"],
    models: models.map((m) => ({
      id: m,
      label: m,
      efforts: ["low", "medium", "high"],
      default_effort: "medium",
    })),
    auth: { state: "signed_in", accounts: [], ...auth },
  }) as unknown as EngineDescriptor;
// Claude Agent runs on this Mac's own login, which one approval carries to Cloud: what the lid's Connect Claude starts.
const ENGINES = [
  engine("claude-agent", "Claude Agent", ["Fable 5.2", "Opus 5.5"], {
    everywhere: "available",
    accounts: [
      {
        id: "claudeAgent:default",
        label: "ada@analytical.test",
        kind: "login",
        active: true,
        where: "this_mac",
      },
    ],
  }),
  engine("codex", "Codex", ["GPT-6 Luna"], { everywhere: "available" }),
];

/** A runtime signed in to Caveman that lists the case's computers, and takes the settings the page saves. */
function clientOf(save: (patch: Partial<Settings>) => void) {
  return {
    on: () => () => undefined,
    call: async (
      method: string,
      params: { settings?: Partial<Settings>; computer_id?: string },
    ) => {
      if (method === "cloud.status")
        return picked.cloud === "signed_out"
          ? { status: "signed_out" }
          : {
              status: "connected",
              runtime_id: "rt-mac",
              cloud_url: "https://caveman.example",
              capabilities: { pull_requests: true, compression: false },
            };
      if (method === "cloud.computers") {
        if (picked.cloud === "unreachable") throw new Error("connect ECONNREFUSED 10.2.0.4:443");
        return { available: picked.cloud !== "off", computers: listed };
      }
      if (method === "cloud.computer.delete") {
        if (picked.refuseDelete) throw new Error("Caveman had a problem. Try again.");
        listed = listed.filter((c) => c.id !== params.computer_id);
        return {};
      }
      if (method === "cloud.lid.summary") return { chats: picked.lid ?? [] };
      if (method === "account.get")
        return {
          signed_in: true,
          credits: {
            plan: "pro",
            seats: 1,
            windows: [
              {
                window: "week",
                used_pct: 58,
                resets_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
              },
              { window: "month", used_pct: 47, resets_at: nextMonth() },
            ],
            balance_micros: 0,
            grants: [],
            use_balance: true,
            computers: {
              kept: 3,
              kept_limit: 10,
              awake_gib: 32,
              awake_gib_limit: 160,
              max_size: "4x16",
              used_pct: 12,
            },
          },
        };
      if (method === "settings.set") return (save(params.settings ?? {}), {});
      // A sign-in opens its page and is never approved.
      if (method === "engine.account.add")
        return {
          accounts: [],
          sign_in: { command: "", message: "", url: "https://claude.ai/oauth/authorize" },
        };
      if (method === "engine.account.complete") return new Promise(() => undefined);
      return {};
    },
  };
}

/** Cloud's own list of the person's chats and Macs: another Mac asleep, one online, and the chats a delete archives. */
const cloudApi = {
  list: async (archived?: boolean) => ({
    chats: archived
      ? []
      : CHATS.filter((w) => w.computer.kind === "caveman_cloud").map((w) => ({
          session_id: w.sessionId,
          computer_id: w.computer.id,
          title: w.title,
          kind: "chat",
          archived: false,
        })),
    runtimes: [
      {
        runtime_id: "rt-mac",
        computer_id: "mac-here",
        kind: "laptop",
        name: "Ada's MacBook Pro",
        online: true,
        last_seen_at: ago(5_000),
      },
      {
        runtime_id: "rt-studio",
        computer_id: "mac-studio",
        kind: "laptop",
        name: "Studio",
        online: false,
        last_seen_at: ago(9 * HOUR),
      },
      {
        runtime_id: "rt-air",
        computer_id: "mac-air",
        kind: "laptop",
        name: "MacBook Air",
        online: true,
        last_seen_at: ago(20_000),
      },
    ],
    seq: 1,
  }),
} as unknown as CloudApi;

/** The runtime the screens read, with settings the page can change (the lid's dropdown, Turn on). */
function Runtime({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Partial<Settings>>({
    default_engine: "claude-agent",
    engines: {},
    ...picked.settings,
  });
  const client = useMemo(
    () => clientOf((patch) => setSettings((now) => ({ ...now, ...patch }))),
    [],
  );
  const runtime = {
    status: "connected",
    client,
    connection: 1,
    engines: ENGINES,
    settings,
    workspaces: CHATS,
    projects: PROJECTS,
    raw: new Map(),
    editors: [],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  return <RuntimeFixture value={runtime}>{children}</RuntimeFixture>;
}

/**
 * Settings' own pane as routes/Settings.tsx draws a list page: the bar that names it, then the page across the pane.
 * It follows the window: as wide as Settings' pane beside its sidebar in a wide one, the whole window in a narrow one.
 */
const SettingsPane = ({ children }: { children: ReactNode }) => (
  <section className="w-full max-w-[1032px] overflow-hidden rounded-xl border-[0.5px] border-border bg-background shadow-[var(--shadow-frame)] max-md:rounded-none max-md:border-0 max-md:shadow-none">
    <header className="flex h-12 items-center gap-1.5 border-b border-border px-5 text-[15px] max-md:px-4">
      <span className="text-muted-foreground max-md:hidden">Settings</span>
      <span className="text-[hsl(var(--subtle-foreground))] max-md:hidden">/</span>
      <h1 className="font-medium">Computers</h1>
    </header>
    <div className="px-8 pt-4 max-md:px-4 max-md:pt-2">
      <SettingsPage title="Computers" wide>
        {children}
      </SettingsPage>
    </div>
  </section>
);

forgetConnects();
const host = document.getElementById("cloud-computers")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter>
      <Runtime>
        {/* Signed out of Caveman, this device reads none of Cloud's lists. */}
        <ComputersCloudContext.Provider value={picked.cloud !== "signed_out" ? cloudApi : null}>
          <TooltipProvider>
            <main data-case={view} className="p-5 text-foreground max-md:p-0">
              <SettingsPane>
                <ComputersSettings />
              </SettingsPane>
            </main>
          </TooltipProvider>
        </ComputersCloudContext.Provider>
      </Runtime>
    </MemoryRouter>,
  ),
);

// A dialog is a portal on the body: what the page says is everything but this page's own result line.
const said = () =>
  (document.body.textContent ?? "").replace(result.textContent ?? "", "").replace(/\s+/g, " ");
const count = (text: string) => said().split(text).length - 1;
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const named = (b: Element, label: string | RegExp) =>
  typeof label === "string"
    ? b.getAttribute("aria-label") === label || b.textContent?.trim() === label
    : label.test(b.textContent ?? "");
const button = (label: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll("button, [role='menuitem']")].find((b) => named(b, label)) as
    | HTMLButtonElement
    | undefined;

/** Presses the case's buttons in turn; a menu opens the way a pointer opens it. */
async function press(problems: string[]) {
  for (const name of picked.press ?? []) {
    const menu = name.startsWith("menu:");
    const label = menu ? name.slice(5) : name;
    // The newest layer first: a dialog, then an open menu, then the page.
    const layer =
      document.querySelector("[role='alertdialog'], [role='dialog']") ??
      document.querySelector("[role='menu']") ??
      document;
    let found: HTMLButtonElement | undefined;
    for (let i = 0; i < 40 && !(found = button(label, layer) ?? button(label)); i++) await tick();
    if (!found || found.disabled) {
      for (let i = 0; i < 40 && found?.disabled; i++) await tick();
      if (!found || found.disabled) {
        problems.push(`no button ${label}`);
        continue;
      }
    }
    if (menu)
      found.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: "mouse",
        }),
      );
    else found.click();
    await tick(120);
  }
}

async function run() {
  const problems: string[] = [];
  // The lists are read from the client: wait for Cloud's row to say what it found, then press.
  for (let i = 0; i < 50 && said().includes("Loading…"); i++) await tick();
  await tick(200);
  await press(problems);
  await tick(300);
  for (const [text, times] of picked.says)
    if (count(text) !== times) problems.push(`"${text}" shows ${count(text)} times, not ${times}`);
  for (const text of picked.never ?? [])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // Spend never shows here, and Claude's engine is never called Claude Code.
  if (/[$€£]\s?\d/.test(said())) problems.push("an amount of money is on the page");
  if (said().includes("Claude Code")) problems.push("says Claude Code");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
}
void run();
