/**
 * Pushes (docs/memory.md "Pushes"): a note reaches the agent at the moment it
 * matters, matched without a model:
 *
 * - **file**: the agent read or edited a file the note names;
 * - **failure**: a command failed the way the note describes;
 * - **prompt**: the person's message names what the note is about (engines
 *   without their own per-turn recall: Codex and the Caveman engine);
 * - **compact**: after compaction, the notes this session saved or was shown,
 *   which the summary may have dropped.
 *
 * Agents almost never look memory up on their own, so notes go to them. A
 * push is at most PUSH_MAX notes, each note once per agent context, and at
 * most PUSH_SESSION_MAX notes a session: few, so they stay relevant.
 *
 * @module memory/MemoryPush
 */
import * as path from "node:path";

import { alive, contentWords, metaOf, type NoteRow, type SessionBrief } from "./MemoryStore.ts";

export type PushTrigger = "file" | "failure" | "prompt" | "compact";

/** Notes in one push. */
export const PUSH_MAX = 3;
/** Notes a session is pushed in all (about 30 tokens each). */
export const PUSH_SESSION_MAX = 24;
/** Notes re-sent after a compaction, newest first. */
export const COMPACT_MAX = 10;

/** File names too common to anchor a note on their own: they match only at the repository root. */
const GENERIC = new Set(
  "index.ts index.tsx index.js index.mjs index.cjs index.d.ts index.html main.ts main.js main.go main.py main.rs lib.rs mod.rs __init__.py package.json readme.md tsconfig.json cargo.toml go.mod makefile dockerfile setup.py pyproject.toml .env".split(
    " ",
  ),
);
/** Upper-case words that are not error names. */
const NOT_ERRORS = new Set("TODO FIXME NOTE README JSON YAML HTML HTTP HTTPS POST PATCH DELETE ASCII UTF8 UUID".split(" "));
/**
 * Programs whose file arguments a shell command reads: Claude Code pushes nested rules on these too
 * (and needed two fixes for missing some, 2.1.288 and 2.1.293). `ls`, `tree` and `find` look at a
 * folder: a note anchored on that folder applies.
 */
const READERS = new Set([
  "cat", "head", "tail", "sed", "awk", "less", "more", "bat", "nl", "wc", "grep", "rg", "diff", "vim", "nano", "code",
  "jq", "yq", "xxd", "hexdump", "od", "strings", "ls", "tree", "find",
]);
/** Of those, the ones whose first non-flag argument is a script or pattern, not a file. */
const SCRIPT_FIRST = new Set(["sed", "awk", "grep", "rg", "jq", "yq"]);
/** git subcommands that show a file's content or history: `git show HEAD:src/a.ts`, `git diff -- src/a.ts`, `git blame src/a.ts`. */
const GIT_READS = new Set(["show", "diff", "log", "blame", "annotate", "cat-file"]);
/** git's options before the subcommand that take a value: `git -C sub diff`, `git -c core.pager=cat log`. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** The files and folders a `git show/diff/log/blame` reads, resolved against `cwd` (or its `-C`). */
function gitReads(words: ReadonlyArray<string>, cwd: string): string[] {
  let at = 1;
  let dir = cwd;
  while (at < words.length && words[at]!.startsWith("-")) {
    const flag = words[at]!;
    if (GIT_VALUED.has(flag)) {
      if (flag === "-C" && words[at + 1] !== undefined) dir = path.resolve(dir, words[at + 1]!);
      at += 2;
    } else at += 1;
  }
  const sub = words[at];
  if (sub === undefined || !GIT_READS.has(sub)) return [];
  const rest = words.slice(at + 1);
  const dashes = rest.indexOf("--");
  const files: string[] = [];
  rest.forEach((word, i) => {
    if (word === "--" || word.startsWith("-")) return;
    // `HEAD:src/a.ts` and `:src/a.ts` name a file at a revision; a range (`main..topic`) names none.
    const named = /^[^:\s/]*:(.+)$/.exec(word)?.[1] ?? word;
    if (named.includes("..") && !named.startsWith("../")) return;
    if (i > dashes && dashes >= 0) files.push(path.resolve(dir, named));
    else if (pathLike(named) !== undefined || named.includes("/")) files.push(path.resolve(dir, named));
  });
  return files;
}

/** What a note names, for matching. */
export interface Anchors {
  /** Paths and directories, repository-relative as written (`src/db.ts`, `packages/session-protocol/`). */
  readonly paths: ReadonlyArray<string>;
  /** Backticked code: commands, flags, values. */
  readonly spans: ReadonlyArray<string>;
  /** Error names (`ECONNREFUSED`, `SQLITE_BUSY`, `ERR_PNPM_OUTDATED_LOCKFILE`). */
  readonly errors: ReadonlyArray<string>;
  /** Content words of the note's name and description. */
  readonly title: ReadonlySet<string>;
  readonly text: string;
}

const pathLike = (token: string) => {
  const t = token.replace(/^[('"[{<]+|[)'"\]}>.,;:!?]+$/g, "").replace(/(?::\d+){1,2}$/, "").replace(/^\.\//, "");
  if (t.length < 3 || t.includes("://") || t.startsWith("-") || /\s/.test(t)) return undefined;
  if (t.includes("/")) return /^[\w@.~-]+(?:\/[\w@.~-]*)+$/.test(t) && /[a-z]/i.test(t) && !t.startsWith("~") ? t : undefined;
  return /^[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,7}$/i.test(t) && !/^\d/.test(t) ? t : undefined;
};

/** The paths, code and error names a note's text and citations name. */
export function anchorsOf(row: Pick<NoteRow, "text" | "meta" | "path">): Anchors {
  const meta = metaOf(row);
  const spans = [...row.text.matchAll(/`([^`\n]{2,200})`/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const cites = Array.isArray(meta.cites) ? (meta.cites as unknown[]).map(String) : [];
  const tokens = [...row.text.split(/[\s`]+/), ...spans.flatMap((s) => s.split(/\s+/)), ...cites];
  const paths = [...new Set(tokens.map(pathLike).filter((p): p is string => p !== undefined))];
  const errors = [
    ...new Set(
      [...`${row.text} ${spans.join(" ")}`.matchAll(/\b(?:E[A-Z]{4,}|[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|[A-Z]{6,})\b/g)].map((m) => m[0]).filter((e) => !NOT_ERRORS.has(e)),
    ),
  ];
  const name = typeof meta.name === "string" ? meta.name : path.basename(row.path, ".md").replaceAll("-", " ");
  const description = typeof meta.description === "string" ? meta.description : "";
  const title = new Set([...contentWords(`${name} ${description}`)].filter((w) => w.length >= 4));
  return { paths, spans, errors, title, text: row.text };
}

/** Does a note's path or directory name this repository-relative file? */
export function names(anchor: string, file: string): boolean {
  const a = anchor.replace(/\/+$/, "");
  if (a === "" || a === ".") return false;
  if (a === file) return true;
  if (a.includes("/") || anchor.endsWith("/")) return file.startsWith(`${a}/`) || (a.includes("/") && file.endsWith(`/${a}`));
  return !GENERIC.has(a.toLowerCase()) && file.split("/").at(-1) === a;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** A span specific enough to match a command: two words, or a path, flag or assignment. */
const specific = (span: string) => span.length >= 4 && (/\s/.test(span) || /[/=.:]/.test(span) || span.startsWith("-"));

/** A note's score for a trigger; 0 means it doesn't apply. */
export function score(anchors: Anchors, trigger: Exclude<PushTrigger, "compact">, input: { readonly file?: string; readonly command?: string; readonly output?: string; readonly prompt?: string }): number {
  if (trigger === "file") return input.file !== undefined && anchors.paths.some((p) => names(p, input.file!)) ? 2 : 0;
  if (trigger === "failure") {
    const command = squash(input.command ?? "");
    const output = input.output ?? "";
    let s = 0;
    if (anchors.spans.some((span) => specific(span) && command.includes(squash(span)))) s += 2;
    if (anchors.errors.some((e) => output.includes(e) || command.includes(e))) s += 2;
    else if (anchors.spans.some((span) => span.length >= 12 && output.includes(span))) s += 2;
    if (anchors.paths.some((p) => p.includes("/") && command.includes(p.replace(/\/+$/, "")))) s += 2;
    // The command's own name (`pnpm test`, `go test`) in the note: a hint, never enough alone.
    const head = command.split(" ").slice(0, 2).join(" ");
    if (head.includes(" ") && anchors.text.includes(head)) s += 1;
    return s >= 2 ? s : 0;
  }
  const prompt = input.prompt ?? "";
  const lower = prompt.toLowerCase();
  let strong = 0;
  if (anchors.paths.some((p) => p.includes("/") || p.includes(".") ? lower.includes(p.replace(/\/+$/, "").toLowerCase()) : false)) strong += 2;
  if (anchors.spans.some((span) => specific(span) && prompt.includes(squash(span)))) strong += 2;
  const words = contentWords(prompt);
  const shared = [...anchors.title].filter((w) => words.has(w)).length;
  if (anchors.title.size > 0 && shared === anchors.title.size && shared >= 2) strong += 2;
  return strong >= 2 ? strong + Math.min(shared, 2) : 0;
}

/** A command's file arguments that a reader program reads (`cat a.ts`, `sed -n 1,20p b.ts`), resolved against `cwd`. */
export function readsOf(command: string, cwd: string): string[] {
  const files: string[] = [];
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
    while (words.length > 0 && /^\w+=/.test(words[0]!)) words.shift();
    const program = path.basename(words[0] ?? "");
    if (program === "git") {
      files.push(...gitReads(words, cwd));
      continue;
    }
    if (!READERS.has(program)) continue;
    let args = words.slice(1);
    // find's paths come before its expression (`find src/db -name '*.ts'`).
    if (program === "find") {
      const end = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
      args = end < 0 ? args : args.slice(0, end);
    }
    const scripted = args.some((a) => a === "-e" || a === "-f" || a === "--regexp" || a === "--file");
    args = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[A-Za-z]*[nmABCe]$/.test(args[i - 1]!) && /^[\d,]+$/.test(a)));
    if (SCRIPT_FIRST.has(program) && !scripted) args = args.slice(1);
    for (const a of args) if (pathLike(a) !== undefined || a.includes("/")) files.push(path.resolve(cwd, a));
  }
  return files;
}

/** One of Codex's parsed command actions (commandExecution.commandActions): read, listFiles, search or unknown. */
export interface CodexCommandAction {
  readonly type: string;
  readonly command?: string;
  readonly path?: string | null;
  readonly [field: string]: unknown;
}

/**
 * The files and folders a Codex command read, resolved against its `cwd`. Codex parses
 * `cat`, `sed -n`, `ls` and `rg` itself; what it leaves "unknown" (`git show HEAD:a.ts`,
 * `jq`, `xxd`) is read here, by the same rules as a Claude Bash command.
 */
export function codexReads(actions: ReadonlyArray<CodexCommandAction>, cwd: string): string[] {
  return actions.flatMap((action) => {
    const at = typeof action.path === "string" ? action.path : undefined;
    if (action.type === "read" && at !== undefined) return [path.resolve(cwd, at)];
    // A listing or search names a folder (or a file) the same way readsOf takes one.
    if ((action.type === "listFiles" || action.type === "search") && at !== undefined && (pathLike(at) !== undefined || at.includes("/"))) return [path.resolve(cwd, at)];
    if (action.type === "unknown" && typeof action.command === "string") return readsOf(action.command, cwd);
    return [];
  });
}

/** A file as the repository names it, or undefined outside the worktree (or inside an excluded directory, like the memory copy). */
export function repoRelative(worktree: string, file: string, exclude: ReadonlyArray<string> = []): string | undefined {
  const absolute = path.resolve(worktree, file);
  if (exclude.some((dir) => absolute === dir || absolute.startsWith(`${dir}${path.sep}`))) return undefined;
  const relative = path.relative(worktree, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/** A failed command's output as matching reads it: the start and the end, where errors print. */
export const outputTail = (output: string) => (output.length <= 6000 ? output : `${output.slice(0, 1500)}\n${output.slice(-4500)}`);

const HEADERS: Record<PushTrigger, string> = {
  file: "notes about this file",
  failure: "notes about this failure",
  prompt: "notes that may apply",
  compact: "notes this session saved or was shown before its context was compacted",
};

/**
 * Byte-stable text: the agent reads the note, its date, whether anyone confirmed it, and for a file note
 * whether that file was committed to after the note was written (`changed`: the file, as the repo names it).
 */
export function renderPush(trigger: PushTrigger, notes: ReadonlyArray<Pick<NoteRow, "text" | "added" | "authority"> & { readonly changed?: string }>): string {
  return `memory · ${HEADERS[trigger]}:\n${notes
    .map((n) => `- ${n.text} (${n.added}${n.authority === "told" || n.authority === "team" ? "" : ", unconfirmed: check it"}${n.changed === undefined ? "" : `, ${n.changed} changed since`})`)
    .join("\n")}`;
}

/** Files listed after a compaction at most; the rest are counted. */
export const COMPACT_FILES_MAX = 40;

/**
 * After a compaction, the files the chat changed: what compaction summaries keep worst (Factory's compaction
 * eval: every method weakest on files touched). From git, so no model and no guess.
 */
export function renderChangedFiles(files: ReadonlyArray<string>, base: string | undefined): string | undefined {
  if (files.length === 0) return undefined;
  const shown = files.slice(0, COMPACT_FILES_MAX);
  const more = files.length - shown.length;
  return `files changed in this checkout (git, against ${base ?? "HEAD"}):\n${shown.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- and ${more} more` : ""}`;
}

/** Was `file` committed to after `since` (a note's ISO time)? `lastCommit` is git's `%cI` for the file, if any. */
export const changedSince = (since: string, lastCommit: string | undefined) => {
  if (lastCommit === undefined) return false;
  const [at, last] = [Date.parse(since), Date.parse(lastCommit)];
  return Number.isFinite(at) && Number.isFinite(last) && last > at;
};

/** An explicit ask to keep something past this chat. Narrower than a memory statement: "always" and "never" alone are how people describe bugs. */
const KEEP_ASK = /\b(?:remember(?!\s+(?:when|how|what|why|if|whether|to)\b)|don'?t\s+forget(?!\s+to\b)|from now on|going forward|in (?:the )?future)\b/i;
/** "Remember to bench the Codex arm": a reminder for this task, kept only when it says it holds every time. */
const REMINDER = /\b(?:remember|don'?t\s+forget)\s+to\b/i;
const EVERY_TIME = /\b(?:always|never|every\s+time|each\s+time|whenever)\b/i;
/** "Do you remember…": asking about the past, not asking to keep. */
const RECALL_QUESTION = /\b(?:do|did|can|could|will|would)\s+you\s+remember\b/i;

/**
 * The sentence of the person's message that asks the agent to keep something
 * ("Remember: we deploy on Fridays.", "From now on, use pnpm."), or undefined.
 * Never a question. Split as MemoryStore's statedQuote splits, so the note the
 * agent saves in these words is told.
 */
export function keepAsk(message: string): string | undefined {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .find((s) => (KEEP_ASK.test(s) || (REMINDER.test(s) && EVERY_TIME.test(s))) && !s.endsWith("?") && !RECALL_QUESTION.test(s));
}

/**
 * In front of a message with a keepAsk, for engines with no trained memory of
 * their own (Codex, the Caveman engine): their brief's save paragraph sits far
 * from the turn, and Codex saved nothing on "Remember: …" in two live runs
 * (2026-10-17). The agent still writes the note; the runtime makes it told
 * when it restates the person's sentence.
 */
export const renderKeep = (dir: string) =>
  `memory · the user asked you to keep something past this chat. Save it now as its own note file in ${dir} (repo/ for this repo, user/ only if it holds everywhere), in their words.`;

interface Candidate {
  readonly row: NoteRow;
  readonly anchors: Anchors;
}

/**
 * One session's pushes: which notes each agent context (the session, or a
 * subagent by its id) has already been shown, and the session's total.
 */
export class PushLedger {
  private readonly sent = new Map<string, Set<string>>();
  private total = 0;
  /** Notes the session itself was shown, newest last: re-sent after a compaction. */
  readonly shown: NoteRow[] = [];

  /** The notes to push now: unsent in this context, best first, within both caps. Marks them sent. */
  take(context: string, scored: ReadonlyArray<{ readonly row: NoteRow; readonly score: number }>): NoteRow[] {
    const sent = this.sent.get(context) ?? new Set<string>();
    this.sent.set(context, sent);
    const picked = [...scored]
      .filter((s) => s.score > 0 && !sent.has(`${s.row.store}:${s.row.id}`))
      .sort((a, b) => b.score - a.score || b.row.added.localeCompare(a.row.added) || b.row.vid.localeCompare(a.row.vid))
      .slice(0, Math.max(0, Math.min(PUSH_MAX, PUSH_SESSION_MAX - this.total)))
      .map((s) => s.row);
    for (const row of picked) sent.add(`${row.store}:${row.id}`);
    this.total += picked.length;
    if (context === "session") this.shown.push(...picked);
    return picked;
  }
}

/**
 * The notes a session may be pushed, with their anchors: this repository's and
 * the account's own (and mounted team notes), never tainted, never one the
 * session's brief already carries, never one the session wrote itself (it has
 * it in context; compaction re-sends those).
 */
export class PushIndex {
  private cache: { revision: string; candidates: Candidate[] } | undefined;
  private readonly anchors = new Map<string, Anchors>();

  private readonly scope: { readonly repoId: string; readonly session: string; readonly brief: Pick<SessionBrief, "index" | "notes"> | undefined };
  private readonly rows: () => { readonly revision: string; readonly rows: ReadonlyArray<NoteRow> };
  private readonly briefed: ReadonlySet<string> | undefined;

  /** `brief` is the one the session froze; a subagent, which never saw it, has none. */
  constructor(
    scope: { readonly repoId: string; readonly session: string; readonly brief: Pick<SessionBrief, "index" | "notes"> | undefined },
    rows: () => { readonly revision: string; readonly rows: ReadonlyArray<NoteRow> },
  ) {
    this.scope = scope;
    this.rows = rows;
    this.briefed = scope.brief?.notes === undefined ? undefined : new Set(scope.brief.notes);
  }

  candidates(): Candidate[] {
    const { revision, rows } = this.rows();
    if (this.cache?.revision === revision) return this.cache.candidates;
    const repo = `repos/${this.scope.repoId.toLowerCase()}/`;
    const candidates = rows
      .filter((r) => alive(r) && !r.tainted && r.by !== this.scope.session)
      .filter((r) => r.store !== "me" || r.path.startsWith("user/") || r.path.startsWith(repo))
      .filter((r) => !this.inBrief(r, repo))
      .map((row) => {
        let anchors = this.anchors.get(row.vid);
        if (!anchors) this.anchors.set(row.vid, (anchors = anchorsOf(row)));
        return { row, anchors };
      });
    this.cache = { revision, candidates };
    return candidates;
  }

  /** Scored candidates for a trigger. */
  match(trigger: Exclude<PushTrigger, "compact">, input: Parameters<typeof score>[2]) {
    return this.candidates().map((c) => ({ row: c.row, score: score(c.anchors, trigger, input) }));
  }

  private inBrief(row: NoteRow, repo: string) {
    if (this.briefed !== undefined) return this.briefed.has(`${row.store}:${row.id}`);
    // A brief an older runtime froze has only its index, which names a note by the path render gave it: right while one note has its store path.
    const copy = row.store.startsWith("team:") ? `team/${row.store.slice(5)}/${row.path}` : row.path.replace(repo, "repo/");
    return (this.scope.brief?.index ?? "").includes(`](${copy})`);
  }
}

/** What compaction re-sends: the notes the session saved (still alive and untainted), then the ones it was shown, newest first. */
export function compactNotes(saved: ReadonlyArray<NoteRow>, shown: ReadonlyArray<NoteRow>): NoteRow[] {
  const seen = new Set<string>();
  const out: NoteRow[] = [];
  for (const row of [...saved].sort((a, b) => b.vid.localeCompare(a.vid)).concat([...shown].reverse())) {
    const key = `${row.store}:${row.id}`;
    if (seen.has(key) || !alive(row) || row.tainted) continue;
    seen.add(key);
    out.push(row);
  }
  return out.slice(0, COMPACT_MAX);
}
