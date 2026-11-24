// Who an outside agent is and what its level lets it ask for (docs/ §2.5,
// §3 "Access when left out", §4 "Levels, said plainly"). Plain functions: the tools and their tests share them.
import type { AccessMode, EngineDescriptor, OutsideAgentLevel } from "@caveman-app/session-protocol";

/** The MCP client's own name, mapped to how people say it. Unknown names pass through as the client sent them. */
const CLIENT_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude[-_ ]?code/i, "Claude Code"],
  [/^codex/i, "Codex"],
 // bot runs a local stdio server through its local exec daemon, which names itself sand-local-exec-daemon.
  [/^(sand[-_ ]|grok[-_ ]?bot)/i, "Grok Bot"],
  [/^grok/i, "Grok"],
  [/^cursor/i, "Cursor"],
  [/^opencode/i, "OpenCode"],
  [/^goose/i, "Goose"],
];

/** The protocol's cap on `outside_agent.become`'s name; the runtime itself keeps 40 characters. */
const NAME_MAX = 200;

/**
 * The name this process becomes: `--name` when given, else the MCP client's `clientInfo.name` mapped
 * (`claude-code` → Claude Code, `codex-mcp-client` → Codex, `grok*` → Grok, `cursor*` → Cursor, `opencode` →
 * OpenCode, `goose` → Goose). The runtime strips control characters and caps it; this only keeps it non-empty.
 */
export function agentName(flag: string | undefined, clientName: string | undefined): string {
  const given = flag?.trim();
  if (given) return given.slice(0, NAME_MAX);
  const raw = clientName?.trim() ?? "";
  for (const [pattern, name] of CLIENT_NAMES) if (pattern.test(raw)) return name;
  return (raw || "Outside agent").slice(0, NAME_MAX);
}

/** Codex gives a tool call about 60 s, so chat_wait answers sooner for it (SPEC §3 chat_wait). */
export const isCodexClient = (clientName: string | undefined): boolean => /^codex/i.test(clientName?.trim() ?? "");

export const LEVEL_LABEL: Record<OutsideAgentLevel, string> = { read: "Read only", supervised: "Supervised", full: "Full access" };

/** SPEC §4's plain words for each level, the ones Settings uses. */
export const LEVEL_MEANS: Record<OutsideAgentLevel, string> = {
  read: "you can look at chats, not start or change them",
  supervised:
    "its chats can read any file your user can and run commands they already allowed; other commands and every edit wait for them",
  full: "its chats run commands on this computer as your user",
};

const ACCESS_RANK: Record<AccessMode, number> = { ask: 0, auto: 1, review: 2, full: 3 };
export const ACCESS_LABEL: Record<AccessMode, string> = { ask: "Supervised", auto: "Auto-accept edits", review: "Auto", full: "Full access" };

/** The highest access a chat this agent starts or messages may run at: Supervised means `ask` only (SPEC §4). */
export const accessCeiling = (level: OutsideAgentLevel): AccessMode | undefined =>
  level === "full" ? "full" : level === "supervised" ? "ask" : undefined;

export type AccessChoice =
  | { readonly ok: true; readonly access: AccessMode | undefined }
  | { readonly ok: false; readonly text: string };

/**
 * The access a new chat or turn asks for. Left out: the lower of the project's or the person's default and the
 * agent's level, which for a Supervised agent is always `ask`, and for a Full one is the default itself (left out, so
 * the runtime applies it). Asked for explicitly above the level: refused, with what to do instead.
 */
export function accessFor(level: OutsideAgentLevel, name: string, asked: AccessMode | undefined): AccessChoice {
  const ceiling = accessCeiling(level);
  if (ceiling === undefined) return { ok: false, text: levelRefusal(level, name, "start or message chats") };
  if (asked === undefined) return { ok: true, access: level === "full" ? undefined : ceiling };
  if (ACCESS_RANK[asked] <= ACCESS_RANK[ceiling]) return { ok: true, access: asked };
  return {
    ok: false,
    text: [
      `access "${asked}" (${ACCESS_LABEL[asked]}) is above your level, ${LEVEL_LABEL[level]}: ${LEVEL_MEANS[level]}.`,
      `Leave access out (your chats run at "${ceiling}"), or tell your user they can raise ${name} in Caveman Code > Settings > Caveman MCP.`,
    ].join("\n"),
  };
}

/** A tool this agent's level doesn't reach, said as what to do next. */
export function levelRefusal(level: OutsideAgentLevel, name: string, what: string): string {
  return [
    `Your level in Caveman Code is ${LEVEL_LABEL[level]}: ${LEVEL_MEANS[level]}. It doesn't let you ${what}.`,
    `Tell your user they can raise ${name} in Caveman Code > Settings > Caveman MCP.`,
  ].join("\n");
}

/** Access modes an engine honours: absent means every mode (EngineDescriptor.access_modes). */
export const engineHonours = (engine: EngineDescriptor, access: AccessMode): boolean =>
  engine.access_modes === undefined || engine.access_modes.includes(access);

/** An engine with a working sign-in or key: one a chat can start on. */
export const isConnected = (engine: EngineDescriptor): boolean => engine.auth.state === "signed_in" || engine.auth.state === "api_key";

/** Whether this agent can start a chat on `engine` at its level (SPEC §3 `engines`, `chat_start`). */
export const canStartOn = (engine: EngineDescriptor, level: OutsideAgentLevel): boolean => {
  const ceiling = accessCeiling(level);
  return ceiling !== undefined && isConnected(engine) && (level === "full" || engineHonours(engine, ceiling));
};

/**
 * The engine a chat_start with no engine runs on: the default engine when it honours the agent's level, else the
 * first connected engine that does. Undefined: leave it to the runtime (a Full agent, or nothing better known).
 */
export function defaultEngineFor(
  engines: ReadonlyArray<EngineDescriptor>,
  level: OutsideAgentLevel,
  preferred: string | undefined,
): EngineDescriptor | undefined {
  const usable = engines.filter((engine) => canStartOn(engine, level));
  return usable.find((engine) => engine.id === preferred) ?? usable[0];
}

/** An engine by its id or label, in any case; then a unique id or label containing what was given. */
export function findEngine(engines: ReadonlyArray<EngineDescriptor>, wanted: string): EngineDescriptor | undefined {
  const key = wanted.trim().toLowerCase();
  if (!key) return undefined;
  const exact = engines.find((engine) => engine.id.toLowerCase() === key || engine.label.toLowerCase() === key);
  if (exact) return exact;
  const partial = engines.filter((engine) => engine.id.toLowerCase().includes(key) || engine.label.toLowerCase().includes(key));
  return partial.length === 1 ? partial[0] : undefined;
}
