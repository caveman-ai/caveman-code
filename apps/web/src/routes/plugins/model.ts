// What Plugins shows: the marketplace's tabs and sections, what each plugin
// brings, how it is contained, whose it is (Me, Project, Team) and which
// engines each thing reaches.
import type { Result } from "@caveman-app/session-protocol";
import type { InstallPolicy, InstallScope, MarketplaceInfo, PluginIncludes, PluginSummary } from "./api.ts";
import { sourcePath, TEAM } from "./browse-model.ts";

export type PluginInfo = Result<"plugin.list">["plugins"][number];

/** One kind of thing a plugin brings, by name. */
export interface Brings {
  readonly kind: "tools" | "connectors" | "mcp_servers" | "skills" | "commands" | "agents" | "hooks" | "lsp_servers" | "monitors";
  readonly label: string;
  readonly names: ReadonlyArray<string>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a plugin brings, in the order people care about; kinds it has none of are left out. */
export function pluginBrings(plugin: PluginInfo): ReadonlyArray<Brings> {
  const all: Array<Brings> = [
    { kind: "tools", label: plural((plugin.tools ?? []).length, "tool", "tools"), names: (plugin.tools ?? []).map((t) => t.title ?? t.name) },
    { kind: "connectors", label: plural((plugin.connectors ?? []).length, "connector", "connectors"), names: (plugin.connectors ?? []).map((c) => c.title) },
    { kind: "mcp_servers", label: plural(plugin.mcp_servers.length, "MCP server", "MCP servers"), names: plugin.mcp_servers },
    { kind: "skills", label: plural(plugin.skills.length, "skill", "skills"), names: plugin.skills },
    { kind: "commands", label: plural(plugin.commands.length, "command", "commands"), names: plugin.commands },
    { kind: "agents", label: plural(plugin.agents.length, "agent", "agents"), names: plugin.agents },
    { kind: "hooks", label: plural(plugin.hooks.length, "hook", "hooks"), names: plugin.hooks },
    { kind: "lsp_servers", label: plural(plugin.lsp_servers?.length ?? 0, "language server", "language servers"), names: plugin.lsp_servers ?? [] },
    { kind: "monitors", label: plural(plugin.monitors?.length ?? 0, "monitor", "monitors"), names: plugin.monitors ?? [] },
  ];
  return all.filter((b) => b.names.length > 0);
}

/** How the runtime keeps a plugin's processes away from your files, in words. */
export function containmentText(containment: PluginInfo["containment"]): { readonly label: string; readonly strong: boolean } {
  switch (containment) {
    // Honest wording (packages/runtime/src/plugins/README.md): writes go only to the worktree, the
    // shared plugin cache, and for hooks Claude's plugin data and session-env dirs (CLAUDE_ENV_FILE
    // runs in the agent's shell, outside the sandbox); no signals out. Reads stay broad: only common
    // credential files and Caveman's state are blocked, on macOS other processes' environments
    // (KERN_PROCARGS2) are readable, and a keychain item with a permissive ACL can be read.
    case "macos_sandbox":
      return {
        label:
          "macOS sandbox: writes only to the workspace, the shared plugin cache and Claude's plugin data and session-env folders (code a hook puts there runs in the agent's shell), and cannot signal other processes. It can read other programs' environment and your other files, except common credential files (SSH, cloud CLIs, other agents' logins) and Caveman's state.",
        strong: true,
      };
    case "bubblewrap":
      return {
        label:
          "bubblewrap sandbox: writes only to the workspace, the shared plugin cache and Claude's plugin data and session-env folders (code a hook puts there runs in the agent's shell), and sees no other processes. It can read your other files, except common credential files (SSH, cloud CLIs, other agents' logins) and Caveman's state.",
        strong: true,
      };
    case "env_filter":
      return { label: "Environment filter only: this computer has no file sandbox for plugins", strong: false };
    default:
      return { label: "Containment unknown", strong: false };
  }
}

export type Scope = "me" | "project" | "team";
export const SCOPE_TITLE: Record<Scope, string> = {
  me: "Yours, on this computer: every project's chats load it",
  project: "One project's: only that project's chats load it",
  team: "Your team's: everyone in your org gets it",
};

export type EngineKey = "caveman" | "claude-agent" | "codex" | "acp";
export const ENGINE_LABEL: Record<EngineKey, string> = { caveman: "Caveman", "claude-agent": "Claude Agent", codex: "Codex", acp: "ACP agents" };
const ENGINE_ORDER: ReadonlyArray<EngineKey> = ["caveman", "claude-agent", "codex", "acp"];
const inOrder = (set: ReadonlySet<string>) => ENGINE_ORDER.filter((e) => set.has(e));

/** Every engine: MCP servers reach all four (servers that sign in, through the runtime's hub). */
export const ALL_ENGINES: ReadonlyArray<EngineKey> = ENGINE_ORDER;
/** An SSE server: Codex and the Caveman engine have no SSE client, so only Claude Agent and ACP agents reach it. */
export const SSE_ENGINES: ReadonlyArray<EngineKey> = ["claude-agent", "acp"];
/** The engines one of a plugin's MCP servers reaches. */
export const serverEngines = (plugin: PluginInfo, server: string): ReadonlyArray<EngineKey> => ((plugin.sse_servers ?? []).includes(server) ? SSE_ENGINES : ALL_ENGINES);
/** A trusted plugin's hooks: Claude Agent runs them, the runtime runs them for the Caveman engine, Codex gets SessionStart only. */
export const HOOK_ENGINES: ReadonlyArray<EngineKey> = ["caveman", "claude-agent", "codex"];

/** The events the runtime runs for the Caveman engine (packages/runtime/src/plugins/hooks.ts); Claude Agent runs every event itself. */
const RUNTIME_HOOK_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "UserPromptSubmit", "Stop"]);

/** The engines that run a trusted hook on `event`: Claude Agent always, the Caveman engine for the runtime's six, Codex SessionStart only. */
export function hookEngines(event: string): ReadonlyArray<EngineKey> {
  const set = new Set<string>(["claude-agent"]);
  if (RUNTIME_HOOK_EVENTS.has(event)) set.add("caveman");
  if (event === "SessionStart") set.add("codex");
  return inOrder(set);
}

/** A hook event in words, for the Hooks tab's groups. */
export const HOOK_EVENT_LABEL: Record<string, string> = {
  PreToolUse: "Before a tool call",
  PostToolUse: "After a tool call",
  PostToolUseFailure: "After a tool call fails",
  UserPromptSubmit: "When you send a prompt",
  SessionStart: "When a session starts",
  SessionEnd: "When a session ends",
  Stop: "When the agent stops",
  SubagentStart: "When a subagent starts",
  SubagentStop: "When a subagent stops",
  PermissionRequest: "When a tool asks for permission",
  Notification: "On a notification",
  PreCompact: "Before the history is compacted",
};

/** The engines skill.list says load a skill, in the hub's order. */
export const skillEngines = (engines: ReadonlyArray<string>): ReadonlyArray<EngineKey> => inOrder(new Set(engines.map((e) => (e.startsWith("acp:") ? "acp" : e))));

/**
 * Which engines a plugin's parts reach, as the runtime projects them
 * (plugins/resolve.ts): MCP servers everywhere (SSE ones to Claude Agent and ACP only); skills and
 * commands (their text, plugins/commands.ts) to Claude Agent, Codex and the Caveman engine; agents,
 * language servers and monitors to Claude Agent only; hooks only once trusted.
 */
export function pluginEngines(plugin: PluginInfo): ReadonlyArray<EngineKey> {
  const set = new Set<EngineKey>();
  const add = (list: ReadonlyArray<EngineKey>) => list.forEach((e) => set.add(e));
  plugin.mcp_servers.forEach((server) => add(serverEngines(plugin, server)));
  if (plugin.skills.length + plugin.commands.length > 0) add(["caveman", "claude-agent", "codex"]);
  if (plugin.agents.length + (plugin.lsp_servers?.length ?? 0) + (plugin.monitors?.length ?? 0) > 0) add(["claude-agent"]);
  if (plugin.hooks.length > 0 && plugin.trusted === true) add(HOOK_ENGINES);
  return inOrder(set);
}

/** An idle-cost estimate as the hub shows it; undefined until something was measured. */
export function tokenLabel(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  return tokens < 1000 ? `~${tokens} tokens` : `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}

/** Names typed as a list: commas or spaces between them. */
export const nameList = (text: string): Array<string> => text.split(/[\s,]+/).filter(Boolean);

/**
 * A command line as a shell splits it into words: spaces separate, single and double quotes keep a word together
 * (`"/Applications/My App/mcp" --stdio`), a backslash escapes the next character outside single quotes.
 */
export function splitCommand(text: string): Array<string> {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** What a pasted server is: a URL to reach, or a command to run. */
export const serverKind = (text: string): "url" | "command" => (/^https?:\/\//i.test(text.trim()) ? "url" : "command");

/**
 * A name for a server from what was pasted, as its tools will be called (`mcp__<name>__…`): a URL's service
 * (`https://mcp.linear.app/mcp` is linear), a package's (`npx -y @acme/search-mcp` is search), a program's.
 */
export function suggestServerName(text: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48);
  const strip = (s: string) => s.replace(/(^|[-_])(mcp|server|mcp-server|server-mcp)(?=$|[-_])/g, "$1").replace(/[-_]{2,}/g, "-");
  const t = text.trim();
  if (serverKind(t) === "url") {
    try {
      const host = new URL(t).hostname.split(".").filter((part) => !["mcp", "api", "www", "app", "com", "dev", "io", "ai", "net", "org", "co", "sh"].includes(part));
      return clean(host[host.length - 1] ?? "");
    } catch {
      return "";
    }
  }
  const words = splitCommand(t);
  const runners = new Set(["npx", "bunx", "pnpx", "uvx", "pipx", "node", "python", "python3", "deno", "bun", "docker", "run", "mcp", "serve", "start", "stdio"]);
  // A package or image names the server best, then the first plain word, then the program itself.
  const later = words.slice(1);
  const candidates = [later.find((w) => !w.startsWith("-") && /[/@]/.test(w)), later.find((w) => !w.startsWith("-") && !runners.has(w)), words[0]];
  for (const candidate of candidates) {
    // From the last part back: `@playwright/mcp` is playwright, `ghcr.io/github/github-mcp-server` is github.
    const parts = (candidate ?? "").replace(/(.)@[^/@]*$/, "$1").split("/").reverse();
    for (const part of parts) {
      const name = clean(strip(clean(part.replace(/^@/, "").replace(/\.(m?[jt]s|py|sh|exe)$/i, ""))));
      if (name !== "") return name;
    }
  }
  return "";
}


// ------------------------------------------------------------ marketplace

export interface Section {
  readonly title: string;
  readonly plugins: ReadonlyArray<PluginSummary>;
}

/** A category with fewer plugins than this gets no section of its own: a heading over one or two rows reads as clutter. */
const SECTION_MIN = 4;

/** The marketplace's picks for Recommended: the featured ids in their order, up to `n`; an id it does not list is skipped. */
export function recommended(plugins: ReadonlyArray<PluginSummary>, featured: ReadonlyArray<string>, n: number): ReadonlyArray<PluginSummary> {
  return featured
    .map((id) => plugins.find((p) => p.id === id))
    .filter((p): p is PluginSummary => p !== undefined)
    .slice(0, n);
}

/**
 * One section per category in `categories`' order, then any other category, then "More": the categories too small
 * for a section of their own (SECTION_MIN), in that same order, and the plugins with none. Within a section, the
 * catalog's own order. When More is all there is, it is "All plugins". The picks above (Recommended) are listed here
 * too, under their category: this is the whole marketplace.
 */
export function browseSections(plugins: ReadonlyArray<PluginSummary>, categories: ReadonlyArray<string>): ReadonlyArray<Section> {
  // Claude Code's marketplaces write categories in lower case ("security"): one section per category in any case,
  // headed with a capital.
  const key = (c: string) => c.toLowerCase();
  const seen = [...new Map(plugins.flatMap((p) => (p.interface.category ? [[key(p.interface.category), p.interface.category] as const] : []))).values()];
  const order = [...categories.filter((c) => seen.some((s) => key(s) === key(c))), ...seen.filter((s) => !categories.some((c) => key(c) === key(s)))];
  const byCategory = order.map((category) => ({
    title: category.charAt(0).toUpperCase() + category.slice(1),
    plugins: plugins.filter((p) => p.interface.category !== undefined && key(p.interface.category) === key(category)),
  }));
  const own = byCategory.filter((s) => s.plugins.length >= SECTION_MIN);
  const more = [...byCategory.filter((s) => s.plugins.length < SECTION_MIN).flatMap((s) => s.plugins), ...plugins.filter((p) => !p.interface.category)];
  return [...own, { title: own.length > 0 ? "More" : "All plugins", plugins: more }].filter((s) => s.plugins.length > 0);
}

/** A row's right-hand mark. */
export const rowState = (p: PluginSummary): "required" | "installed" | "available" => (p.required ? "required" : p.installed ? "installed" : "available");

/** On, but a server it needs has no working sign-in (Connect skipped at install, or lapsed): its row says so. */
export const notConnected = (p: PluginSummary): boolean => rowState(p) !== "available" && p.enabled && p.needs_connect;

/** The name people see. */
export const displayName = (p: Pick<PluginSummary, "name" | "interface">) => p.interface.display_name ?? p.name;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "4 skills · Slack MCP server · 1 hook": what a plugin brings, as its detail page heads it. A single MCP
 * server is named (the detail knows it); otherwise counts.
 */
export function includesLine(includes: PluginIncludes, servers?: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<{ readonly kind: keyof PluginIncludes; readonly label: string }> {
  const parts: Array<{ kind: keyof PluginIncludes; label: string }> = [];
  if (includes.skills) parts.push({ kind: "skills", label: count(includes.skills, "skill") });
  if (includes.mcp_servers)
    parts.push({ kind: "mcp_servers", label: includes.mcp_servers === 1 && servers?.length === 1 ? `${titleCase(servers[0]!.name)} MCP server` : count(includes.mcp_servers, "MCP server") });
  if (includes.hooks) parts.push({ kind: "hooks", label: count(includes.hooks, "hook") });
  if (includes.commands) parts.push({ kind: "commands", label: count(includes.commands, "command") });
  if (includes.agents) parts.push({ kind: "agents", label: count(includes.agents, "agent") });
  if (includes.rules) parts.push({ kind: "rules", label: count(includes.rules, "rule") });
  return parts;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a link from before the Installed and Browse lists lands: an old tab of Plugins, Customize or Spaces. */
export function oldTabTarget(tab: string | undefined): string {
  if (tab === "memory") return "/settings/memory";
  if (tab === "automations") return "/automations";
  if (tab === "caveman" || tab === "marketplace") return "/plugins/browse";
  if (tab === "team") return sourcePath(TEAM);
  if (tab === "yours" || tab === "sources") return "/plugins/browse";
  return "/plugins";
}

/** Whose an installed plugin is: Me, Project or Team, from plugin.list's scope; a runtime without scopes has only mine. */
export const pluginScope = (p: object | undefined): Scope => {
  const scope = (p as { scope?: unknown } | undefined)?.scope;
  return scope === "project" || scope === "team" ? scope : "me";
};

// ------------------------------------------------------------ install

/**
 * Whether a project or team install of a plugin from `market` reaches teammates (MarketplaceInfo.shareable):
 * `ok`, `add_to_team` (an admin adds the marketplace to the team as part of the install), or `no` with the line
 * the dialog shows instead. A runtime that does not say is taken as ok; Cloud and the runtime still refuse.
 */
export function teamReach(market: Pick<MarketplaceInfo, "shareable"> | undefined, admin: boolean): { readonly ok: true; readonly addToTeam: boolean } | { readonly ok: false; readonly line: string } {
  switch (market?.shareable) {
    case "no":
      return { ok: false, line: "Only you: it comes from a folder on this computer" };
    case "add_to_team":
      return admin ? { ok: true, addToTeam: true } : { ok: false, line: "Ask an admin to add this marketplace to the team" };
    default:
      return { ok: true, addToTeam: false };
  }
}

/** The policies a project or team install offers this person: what turns on for everyone (Default, Required) only for admins. */
export function policyChoices(admin: boolean): ReadonlyArray<{ readonly value: InstallPolicy; readonly label: string }> {
  return [
    { value: "available", label: "Available" },
    ...(admin ? [{ value: "default" as const, label: "On by default" }, { value: "required" as const, label: "Required" }] : []),
  ];
}

export const POLICY_LINE: Record<InstallPolicy, string> = {
  available: "Listed; each person installs it",
  default: "On; anyone can turn it off",
  required: "On; nobody can turn it off",
};

/** plugin.install's params, request_id aside: policy and sign-in only beyond Me, add_to_team only when the reach needs it. */
export function installParams(o: {
  id: string;
  scope: InstallScope;
  projectId: string | null;
  policy: InstallPolicy;
  shared: boolean;
  signsIn: boolean;
  addToTeam: boolean;
  cwd?: string | undefined;
}) {
  const wide = o.scope !== "me";
  return {
    id: o.id,
    scope: o.scope,
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.scope === "project" && o.projectId ? { project_id: o.projectId } : {}),
    ...(wide ? { policy: o.policy } : {}),
    ...(wide && o.signsIn ? { connection: o.shared ? ("shared" as const) : ("personal" as const) } : {}),
    ...(wide && o.addToTeam ? { add_to_team: true } : {}),
  };
}

/** The shared-account line: who uses whose account, and what reaches their computers. */
export const sharedLine = (where: string, service: string) => `Everyone on ${where} will use your ${service} account; their computers receive a short-lived token.`;

/** Where a working sign-in is held, as a connected server says it. */
export const connectedLine = (heldBy: "cloud" | "this_computer" | undefined) =>
  heldBy === "cloud" ? "Connected through Caveman" : heldBy === "this_computer" ? "Connected on this computer" : "Connected";

/** "Uses Dana's account": a shared server's sign-in, as the people using it see it. */
export const sharedByLine = (by: string | undefined) => `Uses ${by ? `${by}'s` : "the team's"} account`;

/**
 * A hook command that names a file outside its plugin: a home or absolute path (system tool folders aside) or
 * one above the plugin's folder. Hook trust covers the plugin's own files only, so such a file can change unseen.
 */
export function runsOutside(h: { readonly command?: string | undefined; readonly args?: ReadonlyArray<string> | undefined }): boolean {
  const text = [h.command ?? "", ...(h.args ?? [])].join(" ");
  return /(?:^|[\s"'=:(])(?:~\/|\$\{?HOME\b|\$\{?CLAUDE_PLUGIN_ROOT\}?\/\.\.(?:\/|$|\s)|\/(?!(?:usr|bin|sbin|dev|opt\/homebrew)\/)[\w.-])/.test(text);
}

/** WCAG relative luminance of a `#rgb` or `#rrggbb` colour; undefined for anything else. */
function luminance(color: string): number | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (hex === undefined) return undefined;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether white reads better than black on a colour (an initial on its brand tile); white when the colour is unknown. */
export function whiteOn(color: string): boolean {
  const l = luminance(color);
  return l === undefined || 1.05 / (l + 0.05) >= (l + 0.05) / 0.05;
}

type SignInStatus = "connected" | "needs_sign_in" | "signing_in" | "error";
const SIGN_IN: Record<SignInStatus, { readonly label: string; readonly tone: "green" | "yellow" | "red" | "neutral" }> = {
  connected: { label: "Signed in", tone: "green" },
  needs_sign_in: { label: "Needs sign-in", tone: "neutral" },
  signing_in: { label: "Signing in…", tone: "yellow" },
  error: { label: "Sign-in failed", tone: "red" },
};

/** A server's sign-in tag. One whose sign-in stopped working (needs sign-in, with why) says so, beside its Reconnect button. */
export function signInTag(s: { readonly status: SignInStatus; readonly problem?: string | undefined }): { readonly label: string; readonly tone: "green" | "yellow" | "red" | "neutral" } {
  if (s.status === "needs_sign_in" && s.problem) return { label: "Sign-in expired", tone: "yellow" };
  return SIGN_IN[s.status];
}
