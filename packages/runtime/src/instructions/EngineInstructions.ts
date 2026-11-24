/**
 * EngineInstructions: what an engine session is told beyond its own system
 * prompt, composed in one place and in a cache-stable order (most stable
 * first, so a change late in the list keeps the prompt cache for everything
 * before it):
 *
 * 1. the repository's instruction files (AGENTS.md, else CLAUDE.md), one per
 *    directory from the checkout root down to the session's cwd, the way
 *    Codex walks project docs, a CLAUDE.md with its `@path` imports as Claude
 *    Code reads them. Only for the Caveman engine: Claude Agent and Codex read
 *    their own files natively;
 * 2. team rules from the thread's spaces;
 * 3. the runtime's own text (the user's project instructions, Caveman's
 *    attribution, hidden paths);
 * 4. extra sources, in the order given (the extension point, e.g. a memory
 *    brief): provide `InstructionSources` to add one.
 *
 * @module instructions/EngineInstructions
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { InstructionSection } from "@caveman-app/engine-core/server/SessionPlugins";
import type { ThreadId } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { MAX_ALL_RULES_BYTES } from "../plugins/resolve.ts";

export type { InstructionSection };

export type InstructionEngine = "caveman" | "claude-agent" | "codex";

/** One extra section, read per session. Return "" to add nothing (for this thread or engine). */
export interface InstructionSource {
  readonly title: string;
  readonly read: (threadId: ThreadId, engine: InstructionEngine) => Effect.Effect<string>;
}

/** Extra sources after the runtime's own sections. None by default. */
export class InstructionSources extends Context.Reference<ReadonlyArray<InstructionSource>>(
  "caveman/instructions/InstructionSources",
  { defaultValue: () => [] },
) {}

/** Repository instruction files per directory, AGENTS.md first. */
export const REPOSITORY_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Codex's project_doc_max_bytes default: the repository files together stay under it. */
export const REPOSITORY_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const readFile = (file: string): string | undefined => {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

/** The checkout's top level above `cwd` (a `.git` dir, or file in a worktree); `cwd` itself outside a checkout. */
function checkoutRoot(cwd: string): string {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}

/** Claude Code follows a CLAUDE.md's imports this many hops deep (docs: "a maximum depth of four hops"). */
export const IMPORT_MAX_HOPS = 4;

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character (which would end in U+FFFD). */
export function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * The `@path` imports in a CLAUDE.md, in order, as Claude Code parses them: an `@` at the start of a line
 * or after a space, never inside a code span or fenced block, a space written `\ `, and a quoted path not
 * an import at all.
 */
export function importsOf(text: string): string[] {
  const found: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const prose = line.replace(/(`+)[^`]*?\1/g, " ");
    for (const match of prose.matchAll(/(?:^|\s)@((?:\\ |[^\s"'`])+)/g)) found.push(match[1]!.replaceAll("\\ ", " "));
  }
  return found;
}

/**
 * Where an import leads, or undefined when it is not a file inside the checkout. Claude Code asks before it
 * loads an import from outside the project ("external imports"); the Caveman engine has no one to ask, so it
 * never follows one (`~/…`, `/etc/…`, `../../…`), nor into `.git` or an `.env` file. A trailing period or
 * comma after the path is prose.
 */
function importTarget(root: string, importer: string, target: string): string | undefined {
  if (target.startsWith("~")) return undefined;
  const realRoot = fs.realpathSync.native(root);
  for (const candidate of [target, target.replace(/[.,;:!?)\]]+$/, "")]) {
    if (candidate === "") continue;
    let real: string;
    try {
      real = fs.realpathSync.native(path.resolve(path.dirname(importer), candidate));
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    const relative = path.relative(realRoot, real);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const parts = relative.split(path.sep);
    if (parts.includes(".git") || /^\.env(?:\.|$)/.test(parts.at(-1)!)) return undefined;
    return real;
  }
  return undefined;
}

/** The repository's instruction files from the checkout root down to `cwd`, titled by their path in the checkout. */
export function repositorySections(cwd: string): ReadonlyArray<InstructionSection> {
  const resolved = path.resolve(cwd);
  const root = checkoutRoot(resolved);
  const relative = path.relative(root, resolved);
  const dirs = [root, ...(relative === "" ? [] : relative.split(path.sep).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1))))];
  const sections: InstructionSection[] = [];
  let budget = REPOSITORY_INSTRUCTIONS_MAX_BYTES;
  const realRoot = fs.realpathSync.native(root);
  const loaded = new Set<string>();
  const keep = (title: string, text: string) => {
    if (text === "" || budget <= 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    sections.push({ title, text: bytes <= budget ? text : `${cutUtf8(text, budget)}\n[truncated]` });
    budget -= Math.min(bytes, budget);
  };
  // A CLAUDE.md first, then what it imports (depth first, each file once), so its own words win the budget.
  const withImports = (file: string, title: string, text: string, hops: number) => {
    keep(title, text);
    if (hops >= IMPORT_MAX_HOPS) return;
    for (const target of importsOf(text)) {
      const real = importTarget(root, file, target);
      if (real === undefined || loaded.has(real)) continue;
      loaded.add(real);
      const imported = readFile(real)?.trim();
      if (imported !== undefined) withImports(real, path.relative(realRoot, real), imported, hops + 1);
    }
  };
  for (const dir of dirs) {
    for (const name of REPOSITORY_INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      const text = readFile(file)?.trim();
      if (text === undefined) continue;
      loaded.add(fs.realpathSync.native(file));
      if (name === "CLAUDE.md") withImports(file, path.relative(root, file), text, 0);
      else keep(path.relative(root, file), text);
      break;
    }
  }
  return sections;
}

/**
 * Plugins' rules as one section, each under its own heading naming the plugin
 * it came from (a plugin is not the team), at most MAX_ALL_RULES_BYTES.
 */
export function teamRulesSection(
  rules: ReadonlyArray<{ readonly plugin: string; readonly name: string; readonly text: string }>,
): InstructionSection {
  let bytes = 0;
  const kept = rules
    .map((rule) => `## ${rule.name} (plugin rules from ${rule.plugin})\n\n${rule.text.trim()}`)
    .filter((text) => (bytes += Buffer.byteLength(text, "utf8")) <= MAX_ALL_RULES_BYTES);
  return { title: "Plugin rules", text: kept.join("\n\n") };
}

/** The extra sources' sections for one engine session, empty ones left out. */
export const extraSections = (threadId: ThreadId, engine: InstructionEngine) =>
  Effect.gen(function* () {
    const sources = yield* InstructionSources;
    const texts = yield* Effect.forEach(sources, (source) => source.read(threadId, engine));
    return sources.flatMap((source, index) => (texts[index]!.trim() === "" ? [] : [{ title: source.title, text: texts[index]! }]));
  });

/** The same sections as one block of text, for engines that take a single appended prompt. */
export const renderSections = (sections: ReadonlyArray<InstructionSection>): string =>
  sections.map((section) => `# ${section.title}\n\n${section.text.trim()}`).join("\n\n");

/** Everything the Caveman engine is told, in order. Empty sections are left out. */
export const cavemanSections = (input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly rules: ReadonlyArray<{ readonly plugin: string; readonly name: string; readonly text: string }>;
  /** The runtime's own text (SessionPlugins.instructions). */
  readonly runtime: string;
}) =>
  extraSections(input.threadId, "caveman").pipe(
    Effect.map((extra) =>
      [
        ...repositorySections(input.cwd),
        ...(input.rules.length === 0 ? [] : [teamRulesSection(input.rules)]),
        { title: "Caveman Code", text: input.runtime },
        ...extra,
      ].filter((section) => section.text.trim() !== ""),
    ),
  );
