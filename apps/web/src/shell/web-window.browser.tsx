// What a browser window Caveman Cloud serves opens on, through the production shell, on fixture state: no runtime and
// no Cloud. The web has no front door: signed in, it is the app with every chat the person has, on a Mac and in Cloud,
// and nothing asks which computer. It checks what it draws, and prints PASS or what is missing.
// /src/shell/web-window.browser.html?view=<state> (?light for the light theme). States: signed-out | nothing-yet |
// chats | waking | couldnt-start | cloud-off | list-failed, and the person's Mac as this browser stands with it:
// no-mac | mac-asleep | mac-ask | mac-waiting, each on a page the Mac answers (Plugins, the Chief, Automations), and
// chief-in-cloud: the Chief's page in a window that uses a Cloud computer, where no Chief is made.
// &path=/settings/account opens the shell on another page (Settings with no runtime to ask), with the state's checks
// still run.
import "./harness-host.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SignedOut } from "../routes/FirstRun.tsx";
import { NewChatRoute } from "../routes/NewChat.tsx";
import { holdPendingStart } from "../state/cloud.ts";
import { CLOUD_FAILED_LINE } from "../state/cloud-wait.ts";
import {
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import { chatView } from "../state/sync/chats-view.ts";
import {
  chatPlaces,
  CLOUD_OFF_LINE,
  LIST_FAILED_LINE,
  MAC_HERE_LINE,
  macHere,
  SIGN_IN_LINE,
  webWindow,
  type MacAnswer,
} from "../state/sync/web-window.ts";
import type { CallState, ChatSummary, RuntimeState } from "../state/sync/wire.ts";
import "../styles.css";
import { AppShell } from "./AppShell.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "chats";
if (query.has("light")) document.documentElement.classList.remove("dark");

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const runtime = (runtime_id: string, over: Partial<RuntimeState> = {}): RuntimeState => ({
  runtime_id,
  computer_id: `c-${runtime_id}`,
  kind: "cloud",
  name: runtime_id,
  online: true,
  last_seen_at: ago(5_000),
  ...over,
});
const STUDIO = runtime("rt-studio", { kind: "laptop", name: "Studio" });
// Cloud computers by the names Cloud gives them: none of these may ever reach the page.
const WEB_BOX = runtime("rt-web", { name: "box-web-7f3", computer_state: "running" });
const API_BOX = runtime("rt-api", {
  name: "box-api-2c1",
  online: false,
  computer_state: "suspended",
});
const DOCS_BOX = runtime("rt-docs", {
  name: "box-docs-9aa",
  online: false,
  computer_state: "suspended",
});
const MACHINES = ["box-web-7f3", "box-api-2c1", "box-docs-9aa"];

const queued: CallState = {
  id: "call-1",
  request_id: "r-1",
  method: "turn.submit",
  status: "queued",
  created_at: ago(4_000),
};
const chat = (
  session_id: string,
  title: string,
  on: RuntimeState,
  over: Partial<ChatSummary> = {},
): ChatSummary => ({
  session_id,
  workspace_id: `w-${session_id}`,
  runtime_id: on.runtime_id,
  computer_id: on.computer_id,
  where: { kind: on.kind, name: on.name },
  title,
  engine: "claude-agent",
  repo: "acme/web",
  branch: "main",
  kind: "chat",
  status: "idle",
  last_activity_at: ago(30 * MIN),
  epoch: 1,
  head: 4,
  synced_through: 4,
  archived: false,
  person: { seen_cursor: 4, pinned: false },
  calls: [],
  seq: 1,
  ...over,
});
const CHATS: ChatSummary[] = [
  chat("s1", "Make the checkout retry idempotent", STUDIO, {
    status: "working",
    last_activity_at: ago(2 * MIN),
  }),
  chat("s2", "Why does the login page flash on load", WEB_BOX, {
    status: "needs_you",
    needs_you: { kind: "approval", summary: "Run pnpm test?" },
    last_activity_at: ago(4 * MIN),
  }),
  chat("s3", "Move the settings rows to the new kit", WEB_BOX, {
    last_activity_at: ago(40 * MIN),
    head: 9,
    person: { seen_cursor: 4, pinned: false },
  }),
  chat("s4", "Add rate limits to the invoices API", API_BOX, {
    repo: "acme/billing-api",
    last_activity_at: ago(3 * 60 * MIN),
  }),
  chat("s5", "Rewrite the quickstart for v2", DOCS_BOX, {
    repo: "acme/docs",
    last_activity_at: ago(26 * 60 * MIN),
    calls: [queued],
  }),
  chat("s6", "Triage the flaky e2e run", STUDIO, {
    repo: "acme/billing-api",
    last_activity_at: ago(5 * 60 * MIN),
  }),
];

interface Case {
  readonly signedIn: boolean;
  readonly chats: ReadonlyArray<ChatSummary>;
  readonly runtimes: ReadonlyArray<RuntimeState>;
  /** Whether Cloud runs computers for this organization. */
  readonly cloud: boolean;
  /** Cloud's list cannot be read now. */
  readonly failed?: boolean;
  /** A chat started in Cloud from this window, on its way: how long it has waited, and why Cloud says its place failed. */
  readonly wait?: { readonly ms: number; readonly failed?: string };
  /** Opens "See why" on the wait's line. */
  readonly why?: boolean;
  /** The page the window opens on; New chat unless named. */
  readonly path?: string;
  /** The window uses a Cloud computer (a fixture client answers it); unset, it has no runtime at all. */
  readonly home?: "cloud";
  /** What Studio last said about this browser; unsaid, it let it in before. */
  readonly studio?: MacAnswer | "never-asked";
  /** What the page must say, and how many times. */
  readonly says: ReadonlyArray<readonly [string | RegExp, number]>;
  readonly never?: ReadonlyArray<string>;
}

const EVERY = [STUDIO, WEB_BOX, API_BOX, DOCS_BOX];
/** What the front door said, and what no screen here may say: a machine to pick, wake or open. */
const DOOR = [
  "Pick a computer",
  "Where should your agents work",
  "New Cloud computer",
  "Cloud computers",
  "Macs with Remote control",
  "sign-ins made there",
  "Caveman need",
  "Wake",
  ...MACHINES,
];
const REASON = "create instance: quota exceeded in ams-1 (boat 503)";

const CASES: Record<string, Case> = {
  // Nobody signed in: one line and one button, in the app's plain voice.
  "signed-out": {
    signedIn: false,
    chats: [],
    runtimes: [],
    cloud: true,
    says: [
      [SIGN_IN_LINE, 1],
      ["Sign in", 2],
    ],
    never: [...DOOR, "New chat"],
  },
  // A first visit, nothing anywhere: the app, on New chat. Not a question about where agents should work.
  "nothing-yet": {
    signedIn: true,
    chats: [],
    runtimes: [],
    cloud: true,
    says: [
      ["New chat", 2],
      ["No chats yet", 1],
    ],
    never: [...DOOR, CLOUD_OFF_LINE],
  },
  // Chats on a Mac and in Cloud, one row each: a cloud mark for Cloud, the Mac by its own name, Asleep and Waking where so.
  chats: {
    signedIn: true,
    chats: CHATS,
    runtimes: EVERY,
    cloud: true,
    says: [
      ["Make the checkout retry idempotent", 1],
      ["Add rate limits to the invoices API", 1],
      ["Rewrite the quickstart for v2", 1],
    ],
    never: DOOR,
  },
  // A chat started in Cloud waits for its place: one line, with its seconds, and Cancel.
  waking: {
    signedIn: true,
    chats: CHATS,
    runtimes: EVERY,
    cloud: true,
    wait: { ms: 8_000 },
    says: [
      [/Waking Cloud… \d+s/g, 1],
      ["Cancel", 1],
    ],
    never: [...DOOR, "Starting", "Getting a computer ready"],
  },
  // The place cannot start: our sentence, the raw reason behind a click, and it is asked for again by itself.
  "couldnt-start": {
    signedIn: true,
    chats: CHATS,
    runtimes: EVERY,
    cloud: true,
    wait: { ms: 95_000, failed: REASON },
    why: true,
    says: [
      [CLOUD_FAILED_LINE, 1],
      [REASON, 1],
      ["See why", 1],
      ["Cancel", 1],
    ],
    never: [...DOOR, "Failed:", "Try again"],
  },
  // Cloud is off for the organization and no Mac is on line: one sentence each on that and on what to do.
  "cloud-off": {
    signedIn: true,
    chats: [],
    runtimes: [{ ...STUDIO, online: false }],
    cloud: false,
    says: [
      [CLOUD_OFF_LINE, 1],
      [MAC_HERE_LINE, 1],
    ],
    never: DOOR,
  },
  // No Mac of the person's is signed in: Plugins is still in the sidebar, and its page says where plugins live and
  // the one step this browser can take, with the three steps to a Mac at the sidebar's foot.
  "no-mac": {
    signedIn: true,
    chats: [],
    runtimes: [],
    cloud: true,
    path: "/plugins",
    says: [
      ["Your plugins are on your Mac", 1],
      ["Download for Mac", 1],
      // The card's name, and its Hide button's.
      ["Connect your Mac", 2],
      // The page's line and the card's step.
      ["Get Caveman Code for Mac", 2],
      ["Allow this browser", 1],
    ],
    never: DOOR,
  },
  // Their Mac is signed in and not on line: the Chief's page names it and says to open the app there.
  "mac-asleep": {
    signedIn: true,
    chats: CHATS.filter((c) => c.where.kind === "cloud"),
    runtimes: [{ ...STUDIO, online: false }, WEB_BOX, API_BOX, DOCS_BOX],
    cloud: true,
    path: "/chief",
    says: [
      ["Your Chief is on your Mac", 1],
      ["Studio isn't on line. Open Caveman Code there and keep sync on.", 1],
      ["Open it on Studio", 1],
    ],
    never: [...DOOR, "Download for Mac"],
  },
  // On line, and never asked about this browser: one button connects, and the Mac then asks.
  "mac-ask": {
    signedIn: true,
    chats: [],
    runtimes: [STUDIO],
    cloud: true,
    path: "/automations",
    studio: "never-asked",
    says: [
      ["Your automations are on your Mac", 1],
      ["Studio asks you once to allow this browser.", 1],
      ["Connect to Studio", 2],
    ],
    never: [...DOOR, "Download for Mac"],
  },
  // The Mac's screen is asking: what to do there, with this browser's code.
  "mac-waiting": {
    signedIn: true,
    chats: [],
    runtimes: [STUDIO],
    cloud: true,
    path: "/plugins",
    studio: { status: "pending", code: "TQ4-K9P" },
    says: [["On Studio, choose Allow, and check it shows TQ4-K9P. You only do this once.", 1]],
    never: [...DOOR, "Download for Mac", "Connect to Studio"],
  },
  // The window uses a Cloud computer, where no Chief is made: the Chief's page shows the Mac's step all the same,
  // never a line that only says to open the app, and no box to write to a Chief that is not there.
  "chief-in-cloud": {
    signedIn: true,
    chats: CHATS.filter((c) => c.where.kind === "cloud"),
    runtimes: [STUDIO, WEB_BOX, API_BOX, DOCS_BOX],
    cloud: true,
    home: "cloud",
    path: "/chief",
    studio: "never-asked",
    says: [
      ["Your Chief is on your Mac", 1],
      ["Studio asks you once to allow this browser.", 1],
      ["Connect to Studio", 1],
    ],
    never: [...DOOR, "Download for Mac", "which has no Chief", "Talk to it on"],
  },
  // Cloud cannot be reached: the app stays on what this device kept, and says it is trying again.
  "list-failed": {
    signedIn: true,
    chats: CHATS,
    runtimes: EVERY,
    cloud: true,
    failed: true,
    says: [
      [LIST_FAILED_LINE, 1],
      ["Make the checkout retry idempotent", 1],
    ],
    never: [...DOOR, "Could not load"],
  },
};

const picked = CASES[view] ?? CASES.chats!;

// A chat started in Cloud from this window, as New chat leaves it (state/cloud.ts): the shell's own wait reads it, and
// a fixture Cloud answers what that wait asks (the runtimes it may reach, its computers, and "run it again").
sessionStorage.clear();
localStorage.removeItem("caveman.cloud.runtime");
const asked: string[] = [];
if (picked.wait) {
  holdPendingStart(sessionStorage, {
    computer_id: "c-rt-docs",
    repo: "acme/docs",
    engine: "claude-agent",
    task: "Rewrite the quickstart for v2",
  });
  sessionStorage.setItem(
    "caveman.cloud.wait",
    JSON.stringify({ computer_id: "c-rt-docs", since: NOW - picked.wait.ms }),
  );
  const row = {
    id: "c-rt-docs",
    name: "box-docs-9aa",
    driver: "boat",
    size: "4cpu-16gb",
    desired_state: "running",
    observed_state: picked.wait.failed ? "failed" : "starting",
    observed_reason: picked.wait.failed ?? "booting",
    updated_at: ago(5_000),
  };
  window.fetch = async (input, init) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/code/runtimes") return Response.json({ runtimes: [] });
    if (url.startsWith("/api/v1/code/computers?"))
      return Response.json({ cloud_computers: true, computers: [row] });
    if (init?.method === "POST" && url.endsWith("/resume")) return Response.json(row);
    return Response.json({ error: { message: "not here" } }, { status: 404 });
  };
}
const runtimes = new Map(picked.runtimes.map((r) => [r.runtime_id, r]));
const LABEL: Record<string, string> = {
  "claude-agent": "Claude Agent",
  codex: "Codex",
  caveman: "Caveman",
};
// The rows as the real window makes them: Cloud's list through chats-view.ts, with no runtime of the window's own.
const workspaces = picked.chats.map((c) =>
  chatView(c, runtimes, null, LABEL[c.engine] ?? c.engine),
);

const list = {
  status: picked.failed ? ("reconnecting" as const) : ("live" as const),
  ready: true,
  chats: { size: picked.chats.length },
};
const web: WebWindowValue = {
  window: webWindow(picked.signedIn, list),
  places: chatPlaces({ runtimes }, picked.cloud),
  home: picked.home === "cloud" ? { kind: "cloud", name: "Cloud" } : null,
  mac: macHere(
    { runtimes },
    () => (typeof picked.studio === "object" ? picked.studio : undefined),
    () => picked.studio === undefined,
  ),
  usePlace: () => undefined,
};

/** The Cloud computer a window uses, as far as the shell asks it: nothing set up there, and no Chief to read. */
const called: string[] = [];
const cloudClient = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  call: async (method: string) => {
    called.push(method);
    if (method === "plugin.list") return { plugins: [] };
    if (method === "automation.list") return { automations: [] };
    if (method === "device.list") return { required: true, devices: [], requests: [], blocked: [] };
    throw new Error(`not here: ${method}`);
  },
} as unknown as Client;

/** A window with no runtime: nothing to call, nothing a computer answered. One on a Cloud computer has its client. */
const value = {
  status: picked.home ? "connected" : "unconfigured",
  error: null,
  client: picked.home ? cloudClient : null,
  connection: picked.home ? 1 : 0,
  chiefHere: false,
  identity: {
    orgName: "Caveman Code",
    computerName: "Cloud",
    computerWord: "Cloud",
    computerOnline: true,
    userName: "Ada",
    plan: null,
  },
  workspaces,
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
  markSeen: () => undefined,
} as unknown as RuntimeContextValue;

const router = createMemoryRouter(
  [
    {
      element: <AppShell />,
      children: [
        { path: "new", Component: NewChatRoute },
        {
          path: "chief",
          lazy: () => import("../routes/Chief.tsx").then((m) => ({ Component: m.ChiefRoute })),
        },
        {
          path: "settings/:section",
          lazy: () =>
            import("../routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })),
        },
        {
          path: "settings",
          lazy: () =>
            import("../routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })),
        },
        { path: "*", Component: () => null },
      ],
    },
  ],
  { initialEntries: [query.get("path") ?? picked.path ?? "/new"] },
);

const host = document.getElementById("web-window")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <RuntimeFixture value={value}>
      <WebWindowFixture value={web}>
        <TooltipProvider>
          <div data-case={view} className="h-full">
            {web.window.kind === "signed_out" ? <SignedOut /> : <RouterProvider router={router} />}
          </div>
        </TooltipProvider>
      </WebWindowFixture>
    </RuntimeFixture>,
  ),
);

/** What a person reads and what a screen reader says: text, accessible names and tooltips (once where they agree); never this page's own result line. */
const said = () => {
  const text = (document.body.textContent ?? "").replace(result.textContent ?? "", "");
  const named = [...document.querySelectorAll("[aria-label], [title]")].map((el) => {
    const label = el.getAttribute("aria-label") ?? "";
    const title = el.getAttribute("title") ?? "";
    return title === label ? label : `${label} | ${title}`;
  });
  return `${text} | ${named.join(" | ")}`.replace(/\s+/g, " ");
};
const count = (text: string | RegExp) =>
  typeof text === "string" ? said().split(text).length - 1 : (said().match(text) ?? []).length;
const has = (text: string | RegExp) => count(text) > 0;
const tick = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

async function run() {
  const problems: string[] = [];
  for (let i = 0; i < 80 && !has(picked.says[0]![0]); i++) await tick();
  // The list's failure waits a moment before it says so (a stream that drops and reopens says nothing).
  if (picked.failed)
    for (let i = 0; i < 120 && !said().includes(LIST_FAILED_LINE); i++) await tick();
  if (picked.why) {
    button("See why")?.click();
    await tick();
  }
  for (const [text, times] of picked.says)
    if (count(text) !== times) problems.push(`"${text}" shows ${count(text)} times, not ${times}`);
  // No button that cannot work: with no runtime to add a project to, the sidebar offers none.
  if ((document.querySelector("[data-sidebar]")?.textContent ?? "").includes("Add a project"))
    problems.push("the sidebar offers Add a project with no runtime to add it to");
  // A place that failed is asked for again by the app, never by the person; one that is only on its way is left alone.
  const ran = asked.filter((a) => a.startsWith("POST")).length;
  if (picked.wait && ran !== (picked.wait.failed ? 1 : 0))
    problems.push(`asked Cloud to run the place ${ran} times`);
  for (const text of picked.never ?? [])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // A Cloud computer is never asked for a Chief: asking would make one there.
  const chief = called.filter((m) => m.startsWith("chief."));
  if (chief.length > 0) problems.push(`asked the Cloud computer for a Chief: ${chief.join(", ")}`);
  if (picked.chats.length > 0 && web.window.kind === "app") {
    // Where each chat runs is on its row: a cloud for Cloud, the Mac by its own name; a place asleep or waking says so.
    for (const [name, times] of [
      ["In Cloud", picked.chats.filter((c) => c.where.kind === "cloud").length],
      ["On Studio", picked.chats.filter((c) => c.where.kind === "laptop").length],
    ] as const)
      if (count(name) !== times) problems.push(`"${name}" marks ${count(name)} rows, not ${times}`);
    if (count("Asleep") !== 1) problems.push(`"Asleep" marks ${count("Asleep")} rows, not 1`);
    if (count("Waking…") !== 1) problems.push(`"Waking…" marks ${count("Waking…")} rows, not 1`);
  }
  // Spend never shows here, Claude's agent is never called Claude Code, and nothing is in caveman voice.
  if (/[$€£]\s?\d/.test(said())) problems.push("an amount of money is on the page");
  if (said().includes("Claude Code")) problems.push("says Claude Code");
  // The places stay in the sidebar with no runtime: Review reads Cloud, and the rest say where they are and what
  // brings them here. Nothing is hidden because a computer is missing.
  if (web.window.kind === "app")
    for (const place of ["Review", "Plugins", "Automations", "Chief"])
      if (
        ![...document.querySelectorAll("[data-sidebar] a")].some(
          (a) => a.textContent?.trim() === place,
        )
      )
        problems.push(`the sidebar has no ${place}`);
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
  document.title = result.textContent.split("\n")[0]!;
}
void run();
