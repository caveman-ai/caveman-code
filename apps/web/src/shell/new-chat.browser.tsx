// Starting a chat, in every state the app shows it, on fixture data through the production screens: New chat with
// each place it can run (this Mac, another Mac, Cloud; Cloud without a folder, setting up, setup failed, off, signed
// out, not on GitHub, with no plan connected) and its runs, the page a Cloud start goes from (sent while setup builds or after it failed, starting, failed, started), and the
// Cloud side of a start (the link's question, a start that failed), and New chat in a browser window, which has no
// computer of its own (a first visit on a repository in Cloud, its repositories, places and models (the plan's own,
// Claude and Codex greyed until connected, everything greyed on a Free account or with no place), no repository
// yet, a message sent and waiting, a Mac picked, Cloud off). No runtime and no Cloud: a fixture client answers the
// calls the screens make, and a browser window's calls to Cloud are answered here too. The page fills the window, so
// a narrow window is a narrow New chat.
// /src/shell/new-chat.browser.html?view=<state> (?light for the light theme). It checks what it draws, and prints PASS
// or what is missing.
import "./harness-host.ts";
import type {
  EngineDescriptor,
  Environment,
  EnvironmentBuild,
  Project,
  ProjectSource,
} from "@caveman-app/session-protocol";
import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { CloudStartRoute, type CloudStartState } from "../routes/CloudStart.tsx";
import { NewChatRoute } from "../routes/NewChat.tsx";
import { NewChatBar } from "../routes/new-chat-bar.tsx";
import offerFixture from "../routes/settings/code-plans-offer.fixture.json";
import type { PendingStart } from "../state/cloud.ts";
import {
  ConnectionsCloudContext,
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import type { CloudConnection, CloudConnections } from "../state/sync/model-connections.ts";
import { CLOUD_OFF_LINE, MAC_HERE_LINE, type ChatPlace } from "../state/sync/web-window.ts";
import "../styles.css";
import { NoPlace } from "./AppShell.tsx";
import { CloudWaitLine } from "./CloudWaitLine.tsx";
import { FailedStart, StartConfirm } from "./PendingCloudStart.tsx";

const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "this-mac";
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
const WEB: ProjectSource = { kind: "repo", name: "web", repository: link("acme/web") };
const NOTES: ProjectSource = {
  kind: "folder",
  name: "notes",
  path: "/Users/ada/Documents/billing-notes",
};
const CREATED = { created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" };
/** One project in three: two repositories on GitHub and a folder on this Mac. */
const ACME: Project = {
  id: "p-acme",
  name: "acme",
  path: API.path!,
  repository: API.repository!,
  sources: [API, WEB, NOTES],
  ...CREATED,
};
/** One repository. */
const SOLO: Project = {
  id: "p-solo",
  name: "handbook",
  path: "/Users/ada/code/handbook",
  repository: link("acme/handbook"),
  ...CREATED,
};
/** A repository with no GitHub link. */
const LOCAL: Project = {
  id: "p-local",
  name: "scratch",
  path: "/Users/ada/code/scratch",
  ...CREATED,
};

// ------------------------------------------------------------------ Cloud's setup, as environment.get answers

const steps = (statuses: ReadonlyArray<EnvironmentBuild["steps"][number]["status"]>) =>
  ["clone", "services", "setup", "check", "snapshot", "restore_check"].map((name, i) => ({
    name,
    status: statuses[i] ?? "pending",
  }));
const build = (over: Partial<EnvironmentBuild> = {}): EnvironmentBuild => ({
  id: "b1",
  status: "running",
  steps: steps(["done", "skipped", "done", "running"]),
  log_tail: "",
  failure: null,
  gaps: [],
  started_at: new Date(Date.now() - 95_000).toISOString(),
  finished_at: null,
  ...over,
});
const env = (over: Partial<Environment> = {}): Environment =>
  ({
    repo: "acme/api",
    branch: "main",
    state: "ready",
    source: "cloud",
    config: '[setup]\nrun = ["pnpm install"]\ncheck = ["pnpm test"]\n',
    updated_by: null,
    updated_at: null,
    secret_names: [],
    sizes: ["4x16"],
    max_size: "4x16",
    services: {},
    snapshot: null,
    build: null,
    ...over,
  }) as Environment;
const READY = { available: true, environment: env() };
const SETTING_UP = { available: true, environment: env({ state: "setting_up", build: build() }) };
const SETUP_FAILED = {
  available: true,
  environment: env({
    state: "failed",
    build: build({
      status: "failed",
      steps: steps(["done", "done", "failed"]),
      failure: { kind: "command", step: "setup", message: "pnpm install exited 1" },
      finished_at: new Date().toISOString(),
    }),
  }),
};

// ------------------------------------------------------------------ the agents

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
const agent = (
  id: string,
  label: string,
  models: ReadonlyArray<readonly [string, string]>,
  auth: Record<string, unknown>,
): EngineDescriptor =>
  ({
    id,
    label,
    capabilities: CAPABILITIES,
    access_modes: ["ask", "auto"],
    models: models.map(([m, name]) => ({
      id: m,
      label: name,
      efforts: ["low", "medium", "high"],
      default_effort: "medium",
    })),
    auth: { state: "signed_in", accounts: [], ...auth },
  }) as unknown as EngineDescriptor;
const OWN_LOGIN = {
  id: "claudeAgent:default",
  label: "ada@acme.dev",
  kind: "login",
  active: true,
  where: "this_mac",
};
const PLAN = {
  id: "connection:c1",
  label: "Claude plan",
  kind: "login",
  active: true,
  where: "everywhere",
  connection: { kind: "claude_plan", status: "ready" },
};
/** Claude Agent with its plan connected for every computer, and with only this Mac's own login. */
const CLAUDE = agent("claude-agent", "Claude Agent", [["fable-5-2", "Fable 5.2"]], {
  accounts: [PLAN, OWN_LOGIN],
  everywhere: "available",
});
const CLAUDE_HERE_ONLY = agent("claude-agent", "Claude Agent", [["fable-5-2", "Fable 5.2"]], {
  accounts: [OWN_LOGIN],
  everywhere: "available",
});
const CURSOR = agent("cursor", "Cursor", [["composer-2", "Composer 2"]], {});

// ------------------------------------------------------------------ the cases

const START: CloudStartState = {
  project_id: ACME.id,
  text: "Rename GET /v1/billing/usage to /v1/billing/statements, in the API and the dashboard.",
  engine: "claude-agent",
  sources: ["api", "web"],
};
const LINKED: PendingStart = {
  computer_id: "c1",
  workspace_id: "0b6f2c1e-7a55-4d0e-9d2a-3f1c2b4a5d6e",
  repo: "acme/api",
  engine: "claude-agent",
  task: START.text,
  options: { model: "fable-5-2", effort: "medium" },
  from_link: true,
};

interface Case {
  /** new: New chat. start: the page a Cloud start waits on. confirm, failed-there: the Cloud side's cards. bar: the box's foot alone, with another Mac. */
  readonly kind: "new" | "start" | "confirm" | "failed-there" | "bar";
  readonly project?: Project;
  readonly engines?: ReadonlyArray<EngineDescriptor>;
  /** environment.get's answer for the project. */
  readonly cloud?: unknown;
  /** Settings > Computers' "Keep chats going in Cloud" is on. */
  readonly keepsGoing?: boolean;
  /** cloud.workspace.create: "waits" (Cloud is making the chat's place), or refused in these words. */
  readonly create?: "waits" | "busy" | "raw" | "ok";
  /**
   * A browser window Caveman Cloud serves instead of the desktop app: whether Cloud is on, the Macs on line, the
   * repositories Cloud sees, and `runtime` when the window is on a computer (a Mac picked, or one it quietly uses).
   */
  readonly web?: {
    readonly cloud?: boolean;
    readonly macs?: ReadonlyArray<string>;
    readonly repos?: ReadonlyArray<string>;
    readonly runtime?: boolean;
    /** A Free account: nothing runs in Cloud until a plan lands. */
    readonly free?: boolean;
    /** The plans and keys Cloud holds for the person; none unless named. */
    readonly connections?: ReadonlyArray<CloudConnection>;
  };
  /** Done in turn once the page is up. `>name`: press the control with that accessible name or words. `text=…`: type a message. `send`: press Send. */
  readonly does?: ReadonlyArray<string>;
  readonly says: ReadonlyArray<string>;
  readonly never?: ReadonlyArray<string>;
}

const CLOUD = [">Runs on This Mac", ">Cloud"];
/** A Claude plan Cloud holds for the person, ready everywhere. */
const CLAUDE_PLAN: CloudConnection = {
  id: "c-claude",
  kind: "claude_plan",
  provider: "anthropic",
  label: "Claude Max",
  position: 0,
  status: "ready",
  serves: ["claude-agent"],
};
/** What the plan serves, as GET /api/v1/code/credits/models answers it. */
const PLAN_MODELS = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "moonshot/kimi-k3",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-flash",
];
const REPOS = ["acme/api", "acme/web", "acme/docs"];
/** What a browser window never says: a dead end, or a computer it does not have. */
const WEB_NEVER = ["Add a project", "Choose a model", "This Mac", "this Mac", "Set up an"];
const NEVER = [
  "A worktree",
  "All sources",
  "sandbox",
  "bare computer",
  "snapshot",
  "with gaps",
  "Cloud computer",
  "workspace",
  "computers",
  "acme-web",
  // Nobody picks a number of agents before a chat starts: no field, no estimate.
  "Builders",
  "builders",
  "at once",
  "Estimating",
];
const CASES: Record<string, Case> = {
  // This Mac, one repository: the question names the project; the box's foot is its branch, where it runs and the
  // runs. Nothing asks how many agents: the chat's agent splits the work as it goes.
  "this-mac": {
    kind: "new",
    project: SOLO,
    says: ["handbook", "main", "This Mac", "×1"],
  },
  // The run-on rows are bare: no descriptions, no machine names, no sizes.
  "run-on": {
    kind: "new",
    project: SOLO,
    does: [">Runs on This Mac"],
    says: ["This Mac", "Cloud"],
    never: ["next to your", "sleeps when idle", "Run on"],
  },
  // Another Mac of the person's that can take a chat, by its name.
  "other-mac": { kind: "bar", does: [">Runs on This Mac"], says: ["This Mac", "Studio", "Cloud"] },
  cloud: {
    kind: "new",
    project: SOLO,
    does: CLOUD,
    says: ["Cloud"],
    never: ["Cloud ·", "isn't connected"],
  },
  // A folder is ticked: Cloud is still pickable, leaves the folder out and says so on the pill.
  "cloud-without": {
    kind: "new",
    project: ACME,
    does: CLOUD,
    says: ["Cloud · without notes", "api, web"],
    never: ["Untick", "stays here", "api, web, notes"],
  },
  // The repositories menu: the project's own is plain text; what Cloud left out says why beside it.
  repositories: {
    kind: "new",
    project: ACME,
    does: [...CLOUD, ">Works in api, web"],
    says: ["Works in", "acme/api", "acme/web", "Folder · stays on this Mac"],
  },
  "repositories-mac": {
    kind: "new",
    project: ACME,
    does: [">Works in api, web, notes"],
    says: ["api, web, notes", "Works in", "acme/web", "Folder"],
    never: ["stays on"],
  },
  "cloud-setting-up": {
    kind: "new",
    project: SOLO,
    cloud: SETTING_UP,
    does: CLOUD,
    says: ["Cloud · setting up 3/5"],
    never: ["Your first message waits"],
  },
  "cloud-setup-failed": {
    kind: "new",
    project: SOLO,
    cloud: SETUP_FAILED,
    does: CLOUD,
    says: ["Cloud · setup failed", "See why"],
  },
  // Cloud is off for the organization: the row is drawn as its reason, and cannot be picked.
  "cloud-off": {
    kind: "new",
    project: SOLO,
    cloud: { available: false, environment: null, reason: "Cloud computers are off for Acme." },
    does: [">Runs on This Mac"],
    says: ["Cloud is off. Ask your admin."],
    never: ["Cloud computers are off"],
  },
  "cloud-signed-out": {
    kind: "new",
    project: SOLO,
    cloud: {
      available: false,
      environment: null,
      reason: "Sign in to Caveman to set up Cloud computers (Settings, Remote control).",
    },
    does: [">Runs on This Mac"],
    says: ["Sign in to use Cloud (Settings > Account)."],
    never: ["Remote control"],
  },
  "cloud-not-on-github": {
    kind: "new",
    project: LOCAL,
    cloud: { available: true, environment: null },
    does: [">Runs on This Mac"],
    says: ["Cloud needs this project on GitHub."],
  },
  // Cloud picked for an agent with no plan or key that works there: one line with its button, before Send.
  "not-connected": {
    kind: "new",
    project: SOLO,
    engines: [CLAUDE_HERE_ONLY],
    does: CLOUD,
    says: ["Claude isn't connected for Cloud.", "Connect Claude"],
    never: ["Nothing connected", "Settings > Models"],
  },
  "agent-not-in-cloud": {
    kind: "new",
    project: SOLO,
    engines: [CURSOR],
    does: CLOUD,
    says: ["Cursor doesn't run in Cloud. Pick Claude Agent, Codex or Caveman."],
  },
  // Chats keep going in Cloud, and a second repository is ticked: said before Send, in the move menu's words.
  "several-stay": {
    kind: "new",
    project: ACME,
    keepsGoing: true,
    says: ["Chats in several repositories stay on this Mac."],
  },
  runs: { kind: "new", project: SOLO, does: [">Runs: 1"], says: ["1 run", "2 runs", "4 runs"] },
  // The message never waits for the project's setup: sent while it still builds, Cloud is asked at once.
  "sent-setting-up": {
    kind: "start",
    cloud: SETTING_UP,
    create: "waits",
    says: ["Waking Cloud…"],
    never: [
      "Setting up",
      "runs when it's ready",
      "Start now",
      "Getting a computer ready",
      "is queued",
    ],
  },
  // Sent with a setup that failed: the chat starts without it, and says so.
  "sent-setup-failed": {
    kind: "start",
    cloud: SETUP_FAILED,
    create: "ok",
    says: ["Started in Cloud without setup. Setup carries on for the next chat.", "Open"],
    never: ["Your message is kept", "Start now", "Couldn't get a computer ready"],
  },
  // Cloud is asked for the chat: one line, with the seconds.
  "wait-starting": {
    kind: "start",
    cloud: READY,
    create: "waits",
    says: ["Waking Cloud…"],
    never: ["Getting a computer ready", "Starting", "Cancel"],
  },
  // A start that failed: our sentence, Try again and Discard. Cloud being full is "busy", and names no choice.
  "start-failed": {
    kind: "start",
    cloud: READY,
    create: "busy",
    says: ["The chat didn't start: Cloud is busy. Trying again.", "Try again", "Discard"],
    never: ["Archive one", "is full"],
  },
  // What a driver said stays behind Details.
  "start-failed-raw": {
    kind: "start",
    cloud: READY,
    create: "raw",
    says: ["The chat didn't start: Cloud couldn't start it.", "Try again", "Discard", "Details"],
    never: ["EHOSTUNREACH", "boat-eu-2"],
  },
  started: {
    kind: "start",
    cloud: READY,
    create: "ok",
    says: ["Started in Cloud.", "Open"],
    never: ["Cloud computer"],
  },
  // The Cloud side: a message that came in a link waits for the person.
  confirm: {
    kind: "confirm",
    says: ["Start this chat?", "Agent", "Claude Agent", "Message"],
    never: ["Computer", "Engine", "workspace"],
  },
  "failed-there": {
    kind: "failed-there",
    says: ["The chat on acme/api didn't start: Cloud is busy. Trying again.", "Open", "Discard"],
    never: ["Open Cloud", "box-a"],
  },
  // A browser window, first visit: a repository Cloud sees, running in Cloud, on Caveman's own pick of model. No dead end.
  "web-first": {
    kind: "new",
    web: { repos: REPOS },
    says: ["acme/api", "Cloud", "Auto", "×1"],
    never: [...WEB_NEVER, "main"],
  },
  // The repository is the question's: its name there opens Cloud's list.
  "web-repositories": {
    kind: "new",
    web: { repos: REPOS },
    does: [">acme/api"],
    says: ["Repository", "acme/api", "acme/web", "acme/docs", "Connect another repository"],
    never: WEB_NEVER,
  },
  // Cloud sees no repository yet: where one is connected, in place of a dead "Add a project".
  "web-no-repository": {
    kind: "new",
    web: { repos: [] },
    says: ["Connect a repository to start", "Cloud"],
    never: WEB_NEVER,
  },
  // The places: Cloud, and each Mac on line by its name. Never "This Mac": a browser is on none.
  "web-places": {
    kind: "new",
    web: { repos: REPOS, macs: ["Studio"] },
    does: [">Runs in Cloud"],
    says: ["Cloud", "Studio"],
    never: WEB_NEVER,
  },
  // The model picker is the real one: Caveman's Auto and the models the plan serves, as Cloud lists them.
  "web-models": {
    kind: "new",
    web: { repos: REPOS, connections: [CLAUDE_PLAN] },
    does: [">Model: Auto, Caveman"],
    says: [
      "Auto",
      "Opus 5.5",
      "Sonnet 5.5",
      "GPT-6.1 Sol",
      "Kimi K3",
      "GLM 5.3 Flash",
      "DeepSeek Flash",
    ],
    never: [...WEB_NEVER, "come with a plan", "Unlock"],
  },
  // A model picked is the chat's: the box names it.
  "web-model-picked": {
    kind: "new",
    web: { repos: REPOS },
    does: [">Model: Auto, Caveman", ">Kimi K3"],
    says: ["Kimi K3"],
    never: WEB_NEVER,
  },
  // Claude with no plan connected for Cloud: its tile is there, its model greyed, over what connects it.
  "web-models-connect": {
    kind: "new",
    web: { repos: REPOS },
    does: [">Model: Auto, Caveman", ">Claude Agent"],
    says: [
      "Default model",
      "Connect your Claude plan to use Claude Agent in Cloud.",
      "Connect Claude",
    ],
    never: WEB_NEVER,
  },
  // Connected: Claude Agent's model picks as any other.
  "web-models-connected": {
    kind: "new",
    web: { repos: REPOS, connections: [CLAUDE_PLAN] },
    does: [">Model: Auto, Caveman", ">Claude Agent"],
    says: ["Default model"],
    never: [...WEB_NEVER, "Connect Claude"],
  },
  // A Free account: the plan's models are listed, greyed, over Unlock.
  "web-models-free": {
    kind: "new",
    web: { repos: REPOS, free: true },
    does: [">Model: Auto, Caveman"],
    says: ["Opus 5.5", "Kimi K3", "Caveman's models come with a plan.", "Unlock"],
    never: WEB_NEVER,
  },
  // Sent: Cloud placed the chat, and the window waits for its place in one line at the head of the page.
  "web-sent": {
    kind: "new",
    web: { repos: REPOS },
    does: [`text=${START.text}`, "send"],
    says: ["Waking Cloud…", "Cancel"],
    never: [...WEB_NEVER, "Starting", "didn't start"],
  },
  // The quiet runtime lends no project or branch: with one behind the window, New chat is still Cloud's repositories
  // and the agents Cloud runs. (A Cloud computer's own list of their models is the picker's, once it is opened.)
  "web-quiet-runtime": {
    kind: "new",
    web: { repos: REPOS, runtime: true },
    says: ["acme/api", "Cloud", "Auto"],
    never: [...WEB_NEVER, "handbook", "main", "Fable"],
  },
  // A Mac picked: the window is on it, and its project, branch and models are New chat's.
  "web-on-mac": {
    kind: "new",
    project: SOLO,
    web: { repos: REPOS, macs: ["Studio"], runtime: true },
    does: [">Runs in Cloud", ">Studio"],
    says: ["handbook", "main", "Studio", "Fable 5.2"],
    never: [...WEB_NEVER, "acme/api"],
  },
  // Cloud is off for the organization, a Mac is on line: New chat opens on the Mac, and the Cloud row says why.
  "web-cloud-off": {
    kind: "new",
    project: SOLO,
    web: { cloud: false, macs: ["Studio"], runtime: true },
    does: [">Runs on Studio"],
    says: ["Studio", "Cloud is off. Ask your admin."],
    never: WEB_NEVER,
  },
  // No place at all: the shell's line says why, the page offers the one step this browser can take, and the picker
  // lists everything greyed over that same step.
  "web-no-place": {
    kind: "new",
    web: { cloud: false },
    does: [">Model: Auto, Caveman"],
    says: [CLOUD_OFF_LINE, MAC_HERE_LINE, "Download for Mac", "Get Caveman Code for Mac"],
    never: [...WEB_NEVER, "Caveman need"],
  },
};
const picked = CASES[view] ?? CASES["this-mac"]!;

// ------------------------------------------------------------------ the runtime

const BUSY = "Cloud is busy. Trying again.";
const RAW =
  "create failed: boat-eu-2: EHOSTUNREACH 10.4.2.17:7443 (vm 4f2a, rootfs)\n    at provision (/srv/boat/driver.js:412:19)";
const project = picked.project ?? ACME;

const client = {
  on: () => () => undefined,
  subscribe: () => () => undefined,
  close: () => undefined,
  call: async (method: string) => {
    if (method.startsWith("chief."))
      throw new SessionProtocolError({ code: -32601, message: "method not found" });
    switch (method) {
      case "project.branches":
        return {
          checkout: "main",
          branches: [{ name: "main", current: true, default: true }],
          more: false,
        };
      case "environment.get":
        return { setup_chat: null, fix: null, ...((picked.cloud as object | undefined) ?? READY) };
      case "cloud.status":
        return {
          status: "connected",
          runtime_id: "rt-mac",
          cloud_url: "https://caveman.example",
          account: { organization_name: "Acme" },
        };
      case "secret.list":
        return { repository: "acme/api", secrets: [], cloud_available: true };
      case "secret.env_files":
        return { files: [] };
      case "project.discover":
        return { candidates: [], clone_dir: "/Users/ada/code" };
      case "cloud.workspace.create":
        if (picked.create === "waits") return new Promise(() => undefined);
        if (picked.create === "busy") throw new Error(BUSY);
        if (picked.create === "raw") throw new Error(RAW);
        return {
          workspace_id: "0b6f2c1e-7a55-4d0e-9d2a-3f1c2b4a5d6e",
          computer_id: "c1",
          open_url: "about:blank",
        };
      case "workspace.create":
        return new Promise(() => undefined);
      default:
        return {};
    }
  },
} as unknown as Client;

const noRuntime = picked.web !== undefined && picked.web.runtime !== true;
const runtime = (noRuntime
  ? {
      status: "unconfigured",
      error: null,
      client: null,
      connection: 0,
      identity: {
        orgName: "Acme",
        computerName: "Cloud",
        computerWord: "Cloud",
        computerOnline: false,
        userName: "Ada",
        plan: null,
      },
      engines: [],
      settings: null,
      workspaces: [],
      raw: new Map(),
      projects: [],
      refresh: async () => undefined,
      markSeen: () => undefined,
    }
  : {
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
      engines: picked.engines ?? [CLAUDE],
      settings: {
        default_engine: (picked.engines ?? [CLAUDE])[0]!.id,
        engines: {},
        model_defaults: {},
        ...(picked.keepsGoing ? { sync_chats: true, move_to_cloud: true } : {}),
      },
      workspaces: [],
      raw: new Map(),
      projects: [project],
      refresh: async () => undefined,
      markSeen: () => undefined,
    }) as unknown as RuntimeContextValue;

// ------------------------------------------------------------------ a browser window

const macPlaces = (picked.web?.macs ?? []).map((name): ChatPlace => ({
  kind: "mac",
  name,
  runtimeId: `rt-${name.toLowerCase()}`,
  computerId: `cmp-${name.toLowerCase()}`,
}));
const cloudOn = picked.web?.cloud !== false;
const places: ReadonlyArray<ChatPlace> = [
  ...(cloudOn ? [{ kind: "cloud", name: "Cloud" } as const] : []),
  ...macPlaces,
];
const web: WebWindowValue | null = picked.web
  ? {
      window: { kind: "app", failed: false, nothingYet: true },
      places: {
        places,
        cloud: cloudOn ? "on" : "off",
        lines: places.length === 0 ? [CLOUD_OFF_LINE, MAC_HERE_LINE] : [],
      },
      home: picked.web.runtime
        ? {
            kind: cloudOn ? "cloud" : "mac",
            name: cloudOn ? "Cloud" : (macPlaces[0]?.name ?? "Studio"),
          }
        : null,
      mac: { kind: "none" as const },
      // The fixture's window is on the Mac the case's runtime stands for from the first paint.
      usePlace: () => undefined,
    }
  : null;
if (picked.web) {
  // What a browser window asks Cloud itself: the person's repositories, a place for a chat, and what is on line.
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url === "/api/v1/code/workspaces")
      return json({ id: "0b6f2c1e-7a55-4d0e-9d2a-3f1c2b4a5d6e", computer_id: "c1" });
    if (url === "/api/v1/code/workspaces")
      return json({
        workspaces: (picked.web?.repos ?? []).map((repo, i) => ({
          repo,
          updated_at: new Date(Date.now() - i * 3_600_000).toISOString(),
        })),
      });
    if (url === "/api/v1/code/credits/models")
      return json({
        basis: "list_price",
        models: PLAN_MODELS.map((model) => ({ model, included: true })),
      });
    // Who is signed in and what they hold: a plan, or nothing with plans on offer (a Free account).
    if (url === "/api/v1/auth/me") return json({ user: { email: "ada@acme.dev", role: "owner" } });
    if (url === "/api/v1/code/credits")
      return json(
        picked.web?.free
          ? { plan: "free", balance_micros: 0 }
          : { plan: "pro", balance_micros: 0, subscription: { status: "active", plan: "pro" } },
      );
    if (url === "/api/v1/code/plans") return json(offerFixture);
    if (url === "/api/v1/projects") return json({ data: [] });
    if (url === "/api/v1/code/environments/all") return json({ environments: [] });
    if (url === "/api/v1/code/runtimes") return json({ runtimes: [] });
    if (url.startsWith("/api/v1/code/computers"))
      return json({ cloud_computers: true, computers: [] });
    return json({ error: { message: "not here" } }, 404);
  };
  // The window is on the Mac the case's runtime stands for.
  localStorage.removeItem("caveman.cloud.runtime");
  for (const key of ["caveman.new-chat.repo", "caveman.new-chat.agent", "caveman.new-chat.model"])
    localStorage.removeItem(key);
}
/** Cloud's list of the person's plans and keys, as a browser window reads it. */
const connectionsApi: CloudConnections = {
  list: async () => ({ connections: picked.web?.connections ?? [], kinds: {} }),
  addClaudePlan: async () => ({ connections: [] }),
  moveToTop: async () => ({ connections: [] }),
  remove: async () => ({ connections: [] }),
};

// ------------------------------------------------------------------ the page

// Every state starts from every repository ticked, on the project the case names.
localStorage.removeItem("caveman.newChat.sourcesLeftOut");
localStorage.setItem("caveman.lastProject", project.id);
// A start page's mark of an earlier start belongs to an earlier load.
for (const key of Object.keys(sessionStorage))
  if (key.startsWith("caveman.cloud.")) sessionStorage.removeItem(key);
// A started chat opens in the Cloud-hosted client: the fixture opens nothing.
window.open = () => null;

function Page() {
  if (picked.kind === "confirm")
    return (
      <StartConfirm
        start={LINKED}
        engine={CLAUDE}
        onDiscard={() => undefined}
        onStart={() => undefined}
      />
    );
  if (picked.kind === "failed-there")
    return (
      <FailedStart
        start={{ ...LINKED, failed: BUSY }}
        computer="box-a"
        onOpen={() => undefined}
        onDiscard={() => undefined}
      />
    );
  if (picked.kind === "bar") {
    return (
      <div className="mt-auto px-4 pb-4">
        <NewChatBar
          project={SOLO}
          base={null}
          onBase={() => undefined}
          where="this_mac"
          onWhere={() => undefined}
          computerName="This Mac"
          macs={[{ id: "rt-studio", name: "Studio" }]}
          cloud={{ chip: "Cloud", tone: "ok" }}
          runs={{ value: 1, onChange: () => undefined }}
        />
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/new" element={<NewChatRoute />} />
      <Route path="/cloud/start" element={<CloudStartRoute />} />
      <Route path="*" element={null} />
    </Routes>
  );
}

const host = document.getElementById("new-chat")!;
const result = document.getElementById("result")!;
flushSync(() =>
  createRoot(host).render(
    <MemoryRouter
      initialEntries={[
        picked.kind === "start"
          ? { pathname: "/cloud/start", state: START }
          : `/new?project=${project.id}`,
      ]}
    >
      <RuntimeFixture value={runtime}>
        <TooltipProvider>
          {/* The window is the frame: as wide and as tall as it is, less the result line above. */}
          <main
            data-case={view}
            style={{ height: "calc(100vh - 26px)" }}
            className="flex min-h-0 flex-col bg-background text-foreground"
          >
            {web ? (
              // As the shell has it in a browser window: its line when no place takes a chat, the one-line wait, the page.
              <WebWindowFixture value={web}>
                <ConnectionsCloudContext.Provider value={connectionsApi}>
                  {web.places.lines.length > 0 ? <NoPlace lines={web.places.lines} /> : null}
                  <CloudWaitLine />
                  <div className="min-h-0 flex-1">
                    <Page />
                  </div>
                </ConnectionsCloudContext.Provider>
              </WebWindowFixture>
            ) : (
              <Page />
            )}
          </main>
        </TooltipProvider>
      </RuntimeFixture>
    </MemoryRouter>,
  ),
);

const tick = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const said = () =>
  (document.body.textContent ?? "").replace(result.textContent ?? "", "").replace(/\s+/g, " ");
/** A press as a pointer makes it: Radix opens a menu on pointerdown, a row picks on click. */
function pressOn(el: Element) {
  const at = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" };
  el.dispatchEvent(new PointerEvent("pointerdown", at));
  el.dispatchEvent(new PointerEvent("pointerup", at));
  (el as HTMLElement).click();
}
const clickable = () => [
  ...document.querySelectorAll<HTMLElement>(
    "button, a, [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option']",
  ),
];
/** Types as a keystroke would: through the value setter React watches, then `input`. */
function type(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field) as object, "value")!.set!.call(
    field,
    text,
  );
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function run() {
  const problems: string[] = [];
  await tick(500);
  for (const step of picked.does ?? []) {
    if (step.startsWith("text=")) {
      const box = document.querySelector<HTMLTextAreaElement>("textarea");
      if (box) type(box, step.slice("text=".length));
      else problems.push("no message box");
    } else if (step === "send") {
      const send = document.querySelector<HTMLElement>("button[aria-label='Send']");
      if (send) pressOn(send);
      else problems.push("no Send button");
    } else if (step.startsWith(">")) {
      const name = step.slice(1);
      const target = clickable().findLast(
        (b) =>
          b.getAttribute("aria-label") === name ||
          b.textContent?.trim() === name ||
          // A model's row also carries what a screen reader hears: its name is the words it shows.
          (b.getAttribute("role") === "option" &&
            b.querySelector(".truncate")?.textContent?.trim() === name),
      );
      if (target) pressOn(target);
      else problems.push(`nothing to press: ${name}`);
    }
    await tick(450);
  }
  // A start's first answers come a moment after the page.
  await tick(700);
  for (const text of picked.says) if (!said().includes(text)) problems.push(`missing: ${text}`);
  for (const text of [...NEVER, ...(picked.never ?? [])])
    if (said().includes(text)) problems.push(`must not say: ${text}`);
  // Send is always on the page and inside the window, however narrow; so is every control of the box's foot.
  if (picked.kind === "new") {
    const send = document.querySelector<HTMLElement>("button[aria-label='Send']");
    const box = send?.getBoundingClientRect();
    if (!box) problems.push("no Send button");
    else if (box.right > window.innerWidth || box.left < 0 || box.bottom > window.innerHeight)
      problems.push(
        `Send is off screen (${Math.round(box.left)}..${Math.round(box.right)} of ${window.innerWidth})`,
      );
    for (const chip of document.querySelectorAll<HTMLElement>(
      "[aria-label='Where the chat starts'] :is(button, label, a)",
    )) {
      const at = chip.getBoundingClientRect();
      if (at.right > window.innerWidth + 0.5 || at.left < -0.5)
        problems.push(`"${chip.textContent?.trim()}" is off screen`);
    }
  }
  if (document.documentElement.scrollWidth > window.innerWidth)
    problems.push(
      `the page scrolls sideways (${document.documentElement.scrollWidth} of ${window.innerWidth})`,
    );
  // Spend never shows here, and Claude's agent is never called Claude Code. A model's list price in the picker's own
  // rows is the picker's (STYLE.md 11, "Smarts and cost"), as it is on a Mac.
  const picker =
    document.querySelector("[role='listbox']")?.closest("[data-radix-popper-content-wrapper]")
      ?.textContent ?? "";
  if (/[$€£]\s?\d/.test(said().replace(picker.replace(/\s+/g, " "), "")))
    problems.push("an amount of money is on the page");
  if (said().includes("Claude Code")) problems.push("says Claude Code");
  result.textContent =
    problems.length === 0 ? `PASS ${view}` : `FAIL ${view}\n${problems.join("\n")}`;
}
void run();
