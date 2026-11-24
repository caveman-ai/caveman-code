// What the scripted runtime (session-peer.ts) starts with: a returning person on This Mac with one project, the
// Caveman engine signed in, a few chats. Every value is wire-shaped Session Protocol; the peer checks each against the
// protocol's schemas as it serves it. Builders take overrides so a test states only what it is about.
import type {
  ChiefBoard,
  ChiefProfile,
  EngineCommand,
  EngineDescriptor,
  Project,
  Result,
  Settings,
  Workspace,
} from "@caveman-app/session-protocol";
import type { EventDraft } from "./session-peer.ts";

export const AT = "2026-11-09T09:00:00.000Z";
const earlier = (minutes: number) => new Date(Date.parse(AT) - minutes * 60_000).toISOString();

export interface RuntimeFixture {
  workspaces: Workspace[];
  /** Each chat's journal at the start, by workspace id. */
  events?: Record<string, EventDraft[]>;
  engines: EngineDescriptor[];
  settings: Settings;
  projects: Project[];
  /** The engine's slash commands (engine.commands: the composer's `/` menu). */
  commands?: EngineCommand[];
  /** The checkout's files (fs.search: the composer's `@` menu). */
  files?: string[];
  /** The person's Chiefs (chief.list); absent: a runtime from before several Chiefs, so the sidebar shows its one. */
  chiefs?: ChiefProfile[];
  /** Every Chief's items (chief.get's board), when `chiefs` are listed; absent: an empty board. */
  board?: ChiefBoard;
  /** automation.list's automations; absent: a runtime that answers none of automation.*. */
  automations?: Array<Result<"automation.list">["automations"][number]>;
}

export const PROJECT: Project = {
  id: "p-app",
  name: "app",
  path: "/Users/test/code/app",
  created_at: earlier(600),
  updated_at: earlier(600),
};

export const ENGINE: EngineDescriptor = {
  id: "caveman",
  label: "Caveman",
  capabilities: {
    structured: true,
    fork: true,
    steer: true,
    interrupt: true,
    tool_hooks: true,
    resume_across_machines: true,
    approvals: true,
    plans: true,
    subagents: true,
    images: true,
    mcp: true,
  },
  models: [
    { id: "auto", label: "Auto", efforts: ["low", "medium", "high"], default_effort: "medium" },
  ],
  default_model: "auto",
  auth: {
    state: "api_key",
    accounts: [
      {
        id: "acct-1",
        label: "Anthropic API key",
        kind: "api_key",
        active: true,
        provider: "anthropic",
      },
    ],
  },
};

export const SETTINGS: Settings = {
  default_engine: "caveman",
  default_engine_chosen: true,
  default_computer_id: "this-mac",
  engines: {},
  theme: "dark",
  notifications: { needs_input: false, turn_done: false },
};

/** A chat on This Mac in PROJECT, idle; `id` also names its session (`s-<id>`). */
export function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    title: `Chat ${id}`,
    repo: { path: PROJECT.path },
    base_ref: "main",
    branch: `caveman/${id}`,
    engine: "caveman",
    computer: { id: "this-mac", kind: "this_mac", label: "This Mac", status: "online" },
    session_id: `s-${id}`,
    status: "idle",
    project_id: PROJECT.id,
    created_at: earlier(120),
    updated_at: earlier(60),
    ...over,
  };
}

export const COMMANDS: EngineCommand[] = [
  { name: "review", description: "Review the current changes" },
  { name: "compact", description: "Compact the conversation" },
];

export const FILES = ["src/login.ts", "src/login.test.ts", "src/session.ts", "README.md"];

/** A Chief named `name`, seeing every project, at the app's defaults; the first is the home one. */
export function chief(id: string, name: string, over: Partial<ChiefProfile> = {}): ChiefProfile {
  return {
    id,
    name,
    avatar: { character: "caveman", tone: "medium" },
    model: null,
    access: null,
    project_ids: [],
    soul: "",
    home: false,
    created_at: earlier(300),
    updated_at: earlier(300),
    ...over,
  };
}

export function runtimeFixture(over: Partial<RuntimeFixture> = {}): RuntimeFixture {
  return {
    workspaces: [workspace("ws-1", { title: "Fix the login redirect" })],
    engines: [ENGINE],
    settings: SETTINGS,
    projects: [PROJECT],
    commands: COMMANDS,
    files: FILES,
    ...over,
  };
}

// ------------------------------------------------------------------ a chat's journal, as an engine writes it

/** One finished exchange: the person's message, the agent's answer, the turn's end. */
export function exchange(turn: string, ask: string, answer: string): EventDraft[] {
  return [
    { type: "turn.started", turn_id: turn, payload: { engine: "caveman" } },
    {
      type: "message.done",
      turn_id: turn,
      item_id: `${turn}-ask`,
      payload: { role: "user", text: ask },
    },
    {
      type: "message.done",
      turn_id: turn,
      item_id: `${turn}-answer`,
      payload: { role: "assistant", text: answer },
    },
    { type: "turn.done", turn_id: turn, payload: { status: "completed" } },
  ];
}

/** `turns` finished exchanges with long answers: a thread that scrolls. */
export function longThread(turns: number): EventDraft[] {
  const paragraph =
    "This paragraph stands in for a long answer, so the thread is taller than the window and has to scroll.";
  return Array.from({ length: turns }, (_, i) =>
    exchange(
      `t${i + 1}`,
      `Question ${i + 1}`,
      `Answer ${i + 1}.\n\n${Array(4).fill(paragraph).join("\n\n")}`,
    ),
  ).flat();
}
