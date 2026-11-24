// Plugins and what every engine loads, as the desktop's page reads them from the runtime (apps/web/src/routes/plugins/
// model.ts): the marketplace's plugins, and the skills, MCP servers, hooks and rule files on this computer, whatever
// brought them. The prototype has no runtime, so these stand in.
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import type { BrandName } from "../../components/ui/BrandMark";
import { keep } from "./keep";

export type Scope = "me" | "project" | "team";

/** Who loads a thing: the harnesses by their own names (plugins/model.ts ENGINE_LABEL). Words say Claude Agent. */
export type EngineKey = "caveman" | "claude-agent" | "codex" | "acp";
export const ENGINE_LABEL: Record<EngineKey, string> = { caveman: "Caveman", "claude-agent": "Claude Agent", codex: "Codex", acp: "ACP agents" };

/** A plugin's logo: a vendor's mark, a pixel drawing for Caveman's own, or its initial on its brand colour. */
export type Logo = { brand: BrandName } | { pixel: PixelIconName } | { initial: string; color: string };

export interface Hook {
  event: string;
  matcher?: string;
  command: string;
}

export interface Plugin {
  id: string;
  name: string;
  /** One line under its name (its short description). */
  line: string;
  about: string;
  developer: string;
  category: string;
  logo: Logo;
  featured?: boolean;
  installed: boolean;
  enabled: boolean;
  /** Your team requires it: it can't be turned off. */
  required?: boolean;
  /** On, but a server it needs has no working sign-in. */
  needsConnect?: boolean;
  scope?: Scope;
  skills: readonly string[];
  servers: readonly string[];
  hooks: readonly Hook[];
  /** Its hooks run: you trusted them. */
  trusted?: boolean;
  prompts?: readonly string[];
}

export const STARTING_PLUGINS: readonly Plugin[] = [
  {
    id: "grill-me",
    name: "Grill me",
    line: "Questions before code, until the plan holds",
    about: "Before any code, it asks about the plan one question at a time, until every branch of it is decided. Turn it on for a chat with Grill mode in the composer's + menu.",
    developer: "Caveman",
    category: "Workflow",
    logo: { pixel: "grill-mode" },
    featured: true,
    installed: true,
    enabled: true,
    scope: "me",
    skills: ["grill-me"],
    servers: [],
    hooks: [],
    prompts: ["Grill me on the plan for auto-archive"],
  },
  {
    id: "release-notes",
    name: "Release notes",
    line: "What changed, written for the people using it",
    about: "Reads the pull requests merged since the last release and writes what changed for the people using the app, in plain words.",
    developer: "Caveman",
    category: "Writing",
    logo: { pixel: "record-skill" },
    featured: true,
    installed: false,
    enabled: false,
    skills: ["release-notes"],
    servers: [],
    hooks: [],
    prompts: ["Write the notes for 0.42"],
  },
  {
    id: "github",
    name: "GitHub",
    line: "Pull requests, issues and checks in every chat",
    about: "Reads and writes pull requests, issues and checks through your Mac's GitHub login.",
    developer: "GitHub",
    category: "Code",
    logo: { brand: "github" },
    featured: true,
    installed: true,
    enabled: true,
    scope: "me",
    skills: [],
    servers: ["github"],
    hooks: [],
  },
  {
    id: "security-review",
    name: "Security review",
    line: "Checks each command for secrets and unsafe calls",
    about: "Before a command runs, it checks it for secrets, injection and calls that reach outside the project.",
    developer: "Your team",
    category: "Code",
    logo: { pixel: "approve" },
    installed: true,
    enabled: true,
    required: true,
    scope: "team",
    skills: ["security-review"],
    servers: [],
    hooks: [{ event: "PreToolUse", matcher: "Bash", command: "node scripts/check-command.js" }],
    trusted: true,
  },
  {
    id: "prettier",
    name: "Prettier on edit",
    line: "Formats each file an agent edits",
    about: "After an agent edits a file, it runs Prettier on it, so every change lands formatted.",
    developer: "Caveman",
    category: "Code",
    logo: { brand: "prettier" },
    installed: true,
    enabled: true,
    scope: "project",
    skills: [],
    servers: [],
    hooks: [{ event: "PostToolUse", matcher: "Edit", command: "npx prettier --write $FILE" }],
    trusted: false,
  },
  {
    id: "linear",
    name: "Linear",
    line: "Issues in and out of chats",
    about: "Starts a chat from an issue, and moves the issue along as the chat does.",
    developer: "Linear",
    category: "Planning",
    logo: { brand: "linear" },
    installed: true,
    enabled: true,
    needsConnect: true,
    scope: "me",
    skills: [],
    servers: ["linear"],
    hooks: [],
  },
  {
    id: "sentry",
    name: "Sentry",
    line: "An error as the start of a chat",
    about: "Opens a chat from an error, with its stack, its release and the events around it.",
    developer: "Sentry",
    category: "Monitoring",
    logo: { brand: "sentry" },
    installed: false,
    enabled: false,
    skills: [],
    servers: ["sentry"],
    hooks: [],
  },
  {
    id: "figma",
    name: "Figma",
    line: "Frames and comments as context",
    about: "Brings a frame, its layers and its comments into a chat, so an agent builds what was drawn.",
    developer: "Figma",
    category: "Design",
    logo: { brand: "figma" },
    installed: false,
    enabled: false,
    skills: [],
    servers: ["figma"],
    hooks: [],
  },
];

export interface Server {
  name: string;
  /** Where it came from: "Added by you", "Connector", or the plugin that brings it. */
  source: string;
  plugin?: string;
  /** Its command or address. */
  detail: string;
  status?: "connected" | "needs_sign_in";
  enabled: boolean;
  tools: readonly string[];
}

export const SERVERS: readonly Server[] = [
  { name: "postgres-staging", source: "Added by you", detail: "npx @modelcontextprotocol/server-postgres $STAGING_URL", enabled: true, tools: ["query", "list_tables", "describe_table"] },
  { name: "browser", source: "Connector", detail: "https://mcp.caveman.dev/browser", status: "connected", enabled: true, tools: ["open", "click", "type", "screenshot"] },
];

/**
 * The plugins and your own MCP servers, kept while the app runs (keep.ts): one list for the Plugins page and the
 * composer's `+`, which offers the plugins installed and on, so turning one off there drops it from `+` at once.
 */
export const pluginStore = keep(() => ({ plugins: STARTING_PLUGINS, servers: SERVERS }));

/** When each hook fires, in words (plugins/model.ts HOOK_EVENT_LABEL). */
export const HOOK_EVENT_LABEL: Record<string, string> = {
  PreToolUse: "Before a tool call",
  PostToolUse: "After a tool call",
  UserPromptSubmit: "When you send a prompt",
  SessionStart: "When a session starts",
  Stop: "When the agent stops",
};
