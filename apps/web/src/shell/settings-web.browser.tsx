// Settings in a browser window Caveman Cloud serves, through the production route: what it lists and opens on with no
// computer behind it (signed in, every place asleep), where each page reads Cloud itself, and whose a computer's pages
// are while the window uses one. No runtime and no Cloud: the window's own state is a fixture, and a fixture Cloud
// answers what the pages ask of it. It checks what it draws, and prints PASS or what is missing.
// /src/shell/settings-web.browser.html?view=<state> (?light for the light theme). States: opens | computers | general |
// account | plan | models | models-open | models-empty | on-studio.
import type { AccountSummary } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { SettingsRoute } from "../routes/Settings.tsx";
import type { WorkspaceView } from "../state/model.ts";
import {
  ComputersCloudContext,
  ConnectionsCloudContext,
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import type { CloudApi } from "../state/sync/cloud-api.ts";
import type { CloudConnection, CloudConnections } from "../state/sync/model-connections.ts";
import { chatPlaces, webWindow } from "../state/sync/web-window.ts";
import offerFixture from "../routes/settings/code-plans-offer.fixture.json";
import "../styles.css";

const query = new URLSearchParams(location.search);
if (query.has("light")) document.documentElement.classList.remove("dark");
const view = query.get("view") ?? "opens";
const result = document.querySelector<HTMLElement>("#result")!;

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const tonight = () => {
  const at = new Date();
  at.setHours(23, 8, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.toISOString();
};

interface Case {
  /** Where the window is: Settings' own address. */
  readonly path: string;
  /** The computer the window uses; null: none, every place asleep. */
  readonly home?: WebWindowValue["home"];
  /** What Cloud holds for the person's agents. */
  readonly connections?: ReadonlyArray<CloudConnection>;
  readonly press?: ReadonlyArray<string>;
  /** The address the window must end on. */
  readonly lands: string;
  readonly says: ReadonlyArray<string>;
  readonly never?: ReadonlyArray<string>;
}

const CLAUDE_PLAN: CloudConnection = {
  id: "c1",
  kind: "claude_plan",
  provider: "anthropic",
  label: "Claude plan",
  position: 0,
  status: "ready",
  serves: ["claude-agent"],
};
const ANTHROPIC_KEY: CloudConnection = {
  id: "k1",
  kind: "api_key",
  provider: "anthropic",
  label: "Anthropic key",
  position: 1,
  status: "ready",
  serves: ["claude-agent", "caveman"],
};
/** A computer's pages, by their names in the list: none of them shows with no computer behind the window. */
const A_COMPUTERS = [
  "General",
  "Appearance",
  "Keyboard",
  "Chiefs",
  "Projects",
  "Memory",
  "Environments",
];
/** What no page here says: this window is no Mac, and nothing in it signs in or is refused. */
const NEVER = [
  "This Mac",
  "this Mac",
  "Not signed in to Caveman",
  "Sign in to Caveman",
  "Add local subscriptions",
  "New chats start on",
  "Loading…",
  "cc-7f3a9e",
  " GB",
];

const CASES: Record<string, Case> = {
  // Settings opened in a browser, signed in, every place asleep: it lists only Cloud's pages, and opens on Computers
  // (a phone shows the list first).
  opens: {
    path: "/settings",
    lands: "/settings/computers",
    says: ["Account", "Plan", "Models & keys", "Computers"],
    never: [...NEVER, ...A_COMPUTERS],
  },
  // Computers: the person's Macs by name and Cloud, from Cloud alone. No lid setting: this window is no Mac.
  computers: {
    path: "/settings/computers",
    lands: "/settings/computers",
    says: ["Studio", "1 chat", "Asleep", "Cloud", "3 chats", "Asleep · 12% of this month's plan"],
    never: [...NEVER, ...A_COMPUTERS, "When", "Online", "Running"],
  },
  // A link to a computer's page (the command bar's Settings goes to General) lands where Settings opens.
  general: {
    path: "/settings/general",
    lands: "/settings/computers",
    says: ["Computers", "Studio"],
    never: [...NEVER, ...A_COMPUTERS],
  },
  // Account: who they are and their plan, from Cloud itself; nothing to sign in to, and no computer to sign out.
  account: {
    path: "/settings/account",
    lands: "/settings/account",
    says: ["ada@analytical.test", "Owner", "Pro"],
    never: [...NEVER, "Not signed in", "Sign out", "Held by Caveman"],
  },
  // Plan: each limit's percent and reset, Cloud's share, the plans on sale; credits are one button away.
  plan: {
    path: "/settings/plan",
    lands: "/settings/plan",
    says: ["Pro", "58%", "47%", "12% of this month", "Open billing"],
    never: [...NEVER, "Use credits", "Not signed in", "Give a free month"],
  },
  // Models & keys: what Cloud holds, by agent. Claude Agent runs everywhere; Codex says where it is connected.
  models: {
    path: "/settings/models",
    connections: [CLAUDE_PLAN, ANTHROPIC_KEY],
    lands: "/settings/models",
    says: ["Claude Agent", "Everywhere", "Codex", "Not signed in · connect from the desktop app"],
    never: [...NEVER, "Sign in", "Set up", "Use everywhere", "Caveman"],
  },
  // The agent's row opened: its plans and keys in the order they are tried, each with its one menu.
  "models-open": {
    path: "/settings/models",
    connections: [{ ...CLAUDE_PLAN, status: "used_up", used_up_until: tonight() }, ANTHROPIC_KEY],
    press: ["Claude Agent"],
    lands: "/settings/models",
    says: ["Used up until", "now on your Anthropic key", "Claude plan", "Anthropic key"],
    never: [...NEVER, "Compact idle chats", "Use everywhere"],
  },
  // Nothing connected: both agents say where, and a Claude plan can be pasted under No Mac?.
  "models-empty": {
    path: "/settings/models",
    connections: [],
    press: ["Claude Agent", "No Mac?"],
    lands: "/settings/models",
    says: [
      "Not signed in · connect from the desktop app",
      "Connect from the desktop app",
      "claude setup-token",
    ],
    never: [...NEVER, "Sign in", "Use everywhere"],
  },
  // The window uses a Mac of theirs: that Mac's pages are listed, under its name.
  "on-studio": {
    path: "/settings",
    home: { kind: "mac", name: "Studio" },
    lands: "/settings/computers",
    says: ["On Studio", "General", "Appearance", "Projects", "Computers"],
    never: ["This Mac"],
  },
};

const found = CASES[view];
if (!found)
  throw new Error(
    `settings-web.browser: unknown view "${view}". Views: ${Object.keys(CASES).join(", ")}.`,
  );
const picked: Case = found;
const home = picked.home ?? null;

// The person's chats as Cloud lists them: one on their Mac, three in Cloud, nothing running.
const chat = (id: string, title: string, computer: WorkspaceView["computer"]): WorkspaceView =>
  ({
    id,
    title,
    repo: "acme/acme-web",
    repoRef: { url: "https://github.com/acme/acme-web" },
    branch: null,
    state: "idle",
    asleep: true,
    detail: null,
    engine: { id: "claude-agent", label: "Claude Agent" },
    computer,
    parentId: null,
    sessionId: `s-${id}`,
    projectId: null,
    updatedAt: ago(9 * HOUR),
  }) as unknown as WorkspaceView;
const CLOUD = { kind: "caveman_cloud", label: "Cloud", id: "c-web" } as const;
const STUDIO = { kind: "laptop", label: "Studio", id: "mac-studio" } as const;
const CHATS: ReadonlyArray<WorkspaceView> = [
  chat("w1", "Refactor auth", CLOUD),
  chat("w2", "Upgrade the router", CLOUD),
  chat("w3", "Fix flaky checkout test", CLOUD),
  chat("w4", "Tidy the release notes", STUDIO),
];

/** The first of next month, when a monthly plan starts over. */
const nextMonth = () => {
  const at = new Date();
  return new Date(at.getFullYear(), at.getMonth() + 1, 1, 12).toISOString();
};
const CREDITS: NonNullable<AccountSummary["credits"]> = {
  plan: "pro",
  seats: 1,
  windows: [
    { window: "week", used_pct: 58, resets_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString() },
    { window: "month", used_pct: 47, resets_at: nextMonth() },
  ],
  balance_micros: 0,
  grants: [],
  use_balance: true,
  customer_linked: true,
  subscription: {
    plan: "pro",
    seats: 1,
    status: "active",
    interval: "month",
    current_period_end: nextMonth(),
    cancel_at_period_end: false,
    pending_update: false,
  },
  computers: {
    kept: 3,
    kept_limit: 10,
    awake_gib: 0,
    awake_gib_limit: 160,
    max_size: "4x16",
    used_pct: 12,
  },
};

// Cloud on this origin, as a browser window with no computer asks it: who they are, the plan, their computers.
const asked: string[] = [];
window.fetch = async (input, init) => {
  const url = String(input);
  asked.push(`${init?.method ?? "GET"} ${url}`);
  if (url === "/api/v1/auth/me")
    return Response.json({ user: { email: "ada@analytical.test", role: "owner" } });
  if (url === "/api/v1/code/credits") return Response.json(CREDITS);
  if (url === "/api/v1/code/plans") return Response.json(offerFixture);
  if (url.startsWith("/api/v1/code/computers?"))
    return Response.json({
      cloud_computers: true,
      computers: [
        {
          id: "c-web",
          name: "cc-7f3a9e",
          driver: "boat",
          size: "4cpu-16gb",
          desired_state: "suspended",
          observed_state: "suspended",
          created_at: ago(40 * HOUR),
          updated_at: ago(9 * HOUR),
        },
      ],
    });
  return Response.json({ error: { message: "not here" } }, { status: 404 });
};
const computersApi = {
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
        runtime_id: "rt-studio",
        computer_id: "mac-studio",
        kind: "laptop",
        name: "Studio",
        online: false,
        last_seen_at: ago(9 * HOUR),
      },
    ],
    seq: 1,
  }),
} as unknown as CloudApi;
let held = [...(picked.connections ?? [])];
const listNow = () => ({ connections: held, kinds: {} });
const connectionsApi: CloudConnections = {
  list: async () => listNow(),
  addClaudePlan: async () => ((held = [...held, CLAUDE_PLAN]), listNow()),
  moveToTop: async (id) => (
    (held = [...held]
      .sort((a, b) => Number(b.id === id) - Number(a.id === id))
      .map((c, position) => ({ ...c, position }))),
    listNow()
  ),
  remove: async (id) => ((held = held.filter((c) => c.id !== id)), listNow()),
};

// No computer behind the window: no client, no engines, no settings; the chats are Cloud's list.
const runtime = {
  status: home ? "connected" : "connecting",
  client: null,
  connection: 0,
  engines: [],
  settings: null,
  workspaces: CHATS,
  projects: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const web: WebWindowValue = {
  window: webWindow(true, null),
  places: chatPlaces(null, true),
  home,
  mac: { kind: "none" },
  usePlace: () => undefined,
};

/** Where the window is: Where writes it after each render, the check reads it. */
const at = { path: picked.path };
function Where() {
  const path = useLocation().pathname;
  useLayoutEffect(() => {
    at.path = path;
  }, [path]);
  return null;
}

flushSync(() =>
  createRoot(document.querySelector("#settings-web")!).render(
    <MemoryRouter initialEntries={[picked.path]}>
      <RuntimeFixture value={runtime}>
        <WebWindowFixture value={web}>
          <ComputersCloudContext.Provider value={computersApi}>
            <ConnectionsCloudContext.Provider value={connectionsApi}>
              <TooltipProvider>
                <main
                  data-case={view}
                  className="h-[640px] overflow-hidden text-foreground max-md:h-[720px]"
                >
                  <Where />
                  <Routes>
                    <Route path="/settings/:section?" element={<SettingsRoute />} />
                  </Routes>
                </main>
              </TooltipProvider>
            </ConnectionsCloudContext.Provider>
          </ComputersCloudContext.Provider>
        </WebWindowFixture>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

const said = () =>
  (document.body.textContent ?? "").replace(result.textContent ?? "", "").replace(/\s+/g, " ");
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
  [...document.querySelectorAll("main button, main a")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  ) as HTMLElement | undefined;

async function run() {
  const problems: string[] = [];
  for (
    let i = 0;
    i < 50 &&
    (said().includes("Loading…") || !picked.says.every((text) => said().includes(text))) &&
    !picked.press;
    i++
  )
    await tick();
  await tick(300);
  for (const label of picked.press ?? []) {
    let found: HTMLElement | undefined;
    for (let i = 0; i < 40 && !(found = button(label)); i++) await tick();
    if (!found) problems.push(`no button ${label}`);
    else found.click();
    await tick(200);
  }
  await tick(300);
  // A phone shows the list of pages first; a wider window opens the first of them beside it.
  const lands =
    picked.path === "/settings" && matchMedia("(max-width: 767px)").matches
      ? "/settings"
      : picked.lands;
  if (at.path !== lands) problems.push(`the window is on ${at.path}, not ${lands}`);
  for (const text of picked.says)
    if (!said().includes(text)) problems.push(`does not say: ${text}`);
  for (const text of picked.never ?? [])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // No control that would be refused: nothing here is disabled, but a form's own button while its field is empty.
  const off = [
    ...document.querySelectorAll(
      "main button:disabled:not([type='submit']), main [role='switch'][aria-disabled='true']",
    ),
  ].map((b) => b.textContent?.trim() || b.getAttribute("aria-label"));
  if (off.length > 0) problems.push(`disabled: ${off.join(", ")}`);
  // Nothing was asked of a runtime; Cloud was asked only what these pages read.
  if (asked.some((call) => call.includes("404")))
    problems.push("asked Cloud something it does not have");
  if (said().includes("Claude Code")) problems.push("says Claude Code");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
}
void run();
