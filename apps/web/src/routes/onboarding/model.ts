// What the first run shows, worked out from what the runtime answers: the logins it found, what can be brought over
// from Claude Code, Codex and Cursor, and what setting a project up found. Pure, so the screens stay thin
// (docs/).

import type { EngineDescriptor, Result } from "@caveman-app/session-protocol";
import { engineReady } from "../../state/engines.ts";
import { agentStatus } from "../settings/connections-model.ts";
import type { ConnectionStatus } from "../../state/runtime.tsx";

/** Claude Code, Codex or Cursor on this computer, as import.scan answers. */
export type ImportSource = Result<"import.scan">["sources"][number];

// ------------------------------------------------------------------ whether it shows

/**
 * Whether the window shows the first run (FirstRun.tsx). The runtime's answer decides: no chats yet. Before it
 * answers, the desktop decides from what it kept of its last launch (`chats` is its snapshot's): nothing kept is a
 * first run, shown from the first paint while the runtime starts (seconds; tens of them on a cold Windows laptop),
 * never the empty shell. Once shown on the runtime's answer (`begun`) it runs to its end; `done` once finished here.
 */
export function showsFirstRun(input: { status: ConnectionStatus; desktop: boolean; chats: number; begun: boolean; done: boolean }): boolean {
  if (input.done) return false;
  if (input.begun) return true;
  if (input.status === "connected") return input.chats === 0;
  return input.desktop && input.status !== "unconfigured" && input.chats === 0;
}

// ------------------------------------------------------------------ your setup

/** A login or key Caveman Code can run on, as the setup step lists it. */
export type Found = { readonly engine: EngineDescriptor["id"]; readonly label: string; readonly detail: string };

const RUNS: Record<string, string> = {
  caveman: "Runs the Caveman engine",
  "claude-agent": "Runs Claude Agent",
  codex: "Runs Codex",
};

/** "Claude Ultra Subscription" reads "Claude Ultra"; a label with nothing to trim stays. */
export function planName(label: string): string {
  const trimmed = label.replace(/\s+subscription$/i, "").trim();
  return trimmed.length > 0 && trimmed !== label && /\s/.test(trimmed) ? trimmed : label;
}

/** Every login and key the engines answered with, one row each, in the engines' order. */
export function foundLogins(engines: ReadonlyArray<EngineDescriptor>): Found[] {
  return engines.filter(engineReady).flatMap((e) => {
    const runs = RUNS[e.id] ?? `Runs ${e.label}`;
    if (e.auth.accounts.length === 0) return [{ engine: e.id, label: e.label, detail: runs }];
    return e.auth.accounts.map((a) => ({ engine: e.id, label: planName(a.label), detail: runs }));
  });
}

/**
 * "Use them in Cloud too": the agents whose plan runs on this Mac's own login and can run chats in Cloud after one
 * approval in the browser (the same offer as Settings > Models & keys' Use everywhere), and whose approval it is.
 */
export function cloudToo(engines: ReadonlyArray<EngineDescriptor>, now: number): ReadonlyArray<{ readonly engine: EngineDescriptor["id"]; readonly approve: string }> {
  return engines
    .filter((e) => agentStatus(e, now).action === "use_everywhere")
    .map((e) => ({ engine: e.id, approve: e.id === "claude-agent" ? "Claude" : e.id === "codex" ? "ChatGPT" : e.label }));
}

/** The engines that answered without a login, by name: the quiet "Not found" line. */
export function notFound(engines: ReadonlyArray<EngineDescriptor>): string[] {
  return engines.filter((e) => !engineReady(e) && e.auth.state !== "checking").map((e) => e.label);
}

/** What "Bring your setup" brings, counted by kind ("14 skills, 6 MCP servers"); things read in place don't count. */
export function importSummary(sources: ReadonlyArray<ImportSource>): { readonly count: number; readonly parts: string[]; readonly from: string[] } {
  const items = sources.flatMap((s) => s.items).filter((i) => i.action !== "available" && i.action !== "skip");
  const by = (kind: string) => items.filter((i) => i.kind === kind).length;
  const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    by("skill") ? word(by("skill"), "skill", "skills") : null,
    by("mcp_server") ? word(by("mcp_server"), "MCP server", "MCP servers") : null,
    by("plugin") ? word(by("plugin"), "plugin", "plugins") : null,
    by("marketplace") ? word(by("marketplace"), "marketplace", "marketplaces") : null,
    by("instructions") ? word(by("instructions"), "rule", "rules") : null,
  ].filter((p): p is string => p !== null);
  const NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
  const from = sources.filter((s) => s.items.some((i) => i.action !== "available" && i.action !== "skip")).map((s) => NAMES[s.from]);
  return { count: items.length, parts, from };
}

/** "Claude Code, Codex and Cursor". */
export function andList(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ------------------------------------------------------------------ setting a project up

/** What environment.draft found, in the words of the setup rows. */
export type Setup = {
  readonly stack: string[];
  readonly install: string | null;
  readonly checks: string[];
  /** Secret names the code reads that nothing here sets. */
  readonly secrets: string[];
  readonly moreSecrets: number;
};

/** A TOML string array under `key` (`run = ["a", "b"]`, one line or several). */
export function tomlArray(config: string, key: string): string[] {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(config);
  if (!m) return [];
  return [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\"/g, '"'));
}

/** The draft's [setup] run, check and secrets, and its evidence's tool versions ("Node 24", "pnpm 10.14.0"). */
export function readDraft(draft: { readonly config: string; readonly evidence: ReadonlyArray<{ readonly note: string }>; readonly secret_names: ReadonlyArray<string> }): Setup {
  const run = tomlArray(draft.config, "run");
  // Tool pins (`mise use -g node@24`) come before the install; the install is what is left.
  const install = run.filter((c) => !/^mise\s+use\b/.test(c)).at(-1) ?? null;
  const stack = [
    ...new Set(
      draft.evidence
        .map((e) => /^([A-Za-z][\w.+-]*(?:\s[A-Za-z][\w.+-]*)?)\s+v?(\d[\w.]*)\b\s+from\b/.exec(e.note))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => `${m[1]} ${m[2]}`),
    ),
  ];
  const more = draft.evidence.map((e) => /reads (\d+) more secret-looking names?/.exec(e.note)).find((m) => m !== null);
  return { stack, install, checks: tomlArray(draft.config, "check"), secrets: [...draft.secret_names], moreSecrets: more ? Number(more[1]) : 0 };
}

// ------------------------------------------------------------------ bringing the setup over, in the background

/** What import.apply takes back: everything "Bring your setup" counts (importSummary). */
export function importRefs(sources: ReadonlyArray<ImportSource>): Array<{ from: ImportSource["from"]; kind: ImportSource["items"][number]["kind"]; name: string }> {
  return sources
    .flatMap((s) => s.items)
    .filter((i) => i.action !== "available" && i.action !== "skip")
    .map((i) => ({ from: i.from, kind: i.kind, name: i.name }));
}

/**
 * The setup coming over while the person picks a project: started by the setup step's Continue, which no longer
 * waits for it (a big Claude Code setup took over 30 seconds behind a "Saving…").
 */
export type Bringing =
  | { readonly state: "running"; readonly parts: ReadonlyArray<string> }
  | { readonly state: "done"; readonly parts: ReadonlyArray<string>; readonly imported: number; readonly failed: ReadonlyArray<string> }
  | { readonly state: "failed"; readonly error: string }
  /** Started, and the app closed (or the page reloaded) before it answered: some of it may be missing. */
  | { readonly state: "interrupted"; readonly parts: ReadonlyArray<string> };

/** Whether a run left something to bring over again (Plugins offers it). */
export const bringingUnfinished = (b: Bringing | null): boolean =>
  b !== null && (b.state === "failed" || b.state === "interrupted" || (b.state === "done" && b.failed.length > 0));

/** The footer's line for it: what is coming while it runs, then what came and what didn't. */
export function bringingLine(b: Bringing): string {
  if (b.state === "failed") return `Your setup didn't come over (${b.error}). Bring it from Plugins any time.`;
  if (b.state === "interrupted") return "Your setup didn't finish coming over. Bring the rest from Plugins.";
  const what = andList([...b.parts]);
  if (b.state === "running") return `Bringing over ${what}…`;
  if (b.failed.length === 0) return `Brought over ${what}`;
  const names = b.failed.length > 2 ? `${b.failed.slice(0, 2).join(", ")} and ${b.failed.length - 2} more` : andList([...b.failed]);
  return `Brought over ${b.imported}; ${names} couldn't come. Try again from Plugins.`;
}

// ------------------------------------------------------------------ where a reload picks up

/** The step a reload goes back to: the one the person was on, if this first run still has it. */
export function resumeStep<S extends string>(saved: string | null, steps: ReadonlyArray<S>): S {
  return steps.find((s) => s === saved) ?? steps[0]!;
}

/**
 * How a first run ends, and so where the app opens: the first task's chat when one was started, else the project it
 * set up (its Chief, under the tour), else null when the person skipped adding a project (New chat: a Chief needs one).
 */
export type FirstRunEnd = { readonly chat: string } | { readonly project: string } | null;

/**
 * Where the app opens after a first run that ended at `end`: the chat; the project's Chief at `chief` (its page, from
 * chief.get project_id), else the Chief page, which finds one itself; New chat with no project, since a Chief needs one.
 */
export function firstRunPath(end: FirstRunEnd, chief?: string): string {
  if (end === null) return "/new";
  if ("chat" in end) return `/w/${end.chat}`;
  return chief ?? "/chief";
}
