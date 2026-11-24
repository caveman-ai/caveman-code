/**
 * MemoryCopy: the markdown copy each session works on, and the brief
 * (docs/memory.md "How agents meet it", "Copies and the commit path", "The
 * brief").
 *
 * The copy is Claude Code's trained auto-memory format: one note per file
 * (front matter `name`, `description`, `metadata.type`), and MEMORY.md as an
 * index of one line per note. Claude Agent loads it as its own memory
 * directory; Codex and the Caveman engine get the same lines as the brief.
 *
 * Ingest takes only a tool event's own change, applied to the session's
 * base for that file; the turn-end sweep commits anything else that differs
 * as quarantined drafts and restores the base.
 *
 * @module memory/MemoryCopy
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { openNoFollowSync } from "../openNoFollow.ts";
import {
  canonical,
  metaOf,
  type CommitResult,
  type MemoryStore,
  type NoteRow,
  type Operation,
  scope,
  type SessionBrief,
  type WriterContext,
} from "./MemoryStore.ts";

/** Brief header: byte-stable, it sits in cached prefixes (docs/memory.md "Maintaining it"). */
export const BRIEF_HEADER =
  "Notes from earlier sessions with this user, on any engine, one file per note in this folder. What the user says now and this repo's instruction files win; newer beats older.";
export const SAVE_PARAGRAPH =
  "Save a note as its own file here when the user states a preference or corrects you, or when something cost real time and the code won't tell the next session: the exact command or error that worked, after it worked. repo/ is this repo; user/ only for what holds everywhere. If a note was wrong or you worked around it, fix it before you finish. Skip task progress and anything the repo or git already says.";
/** Subagents get a pointer and no write access. */
export const SUBAGENT_POINTER = (dir: string) =>
  `This user's memory is in ${dir}; read MEMORY.md if relevant. Don't write memory; report what you learned to your caller.`;
/** The brief's cap and per-tier shares (docs/memory.md "The brief"). */
export const BRIEF_MAX_TOKENS = 1500;
const TIERS = [
  ["told", "## Told (the user said these; follow them)", 400],
  ["team", "## Team (reviewed by your team)", 400],
  ["learned", "## Learned (from past sessions; check before relying on them)", 500],
] as const;

/** What a render needs about the session. */
export interface RenderContext extends WriterContext {
  readonly repoId: string;
  /** The repo's instruction files (AGENTS.md, CLAUDE.md) as one text: learned notes restating them are dropped. */
  readonly instructionFiles: string;
  /** Whether a cited repo file still exists; absent skips the check. */
  readonly fileExists?: (relativePath: string) => boolean;
  /** The copy's path as the brief names it. */
  readonly copyLabel?: string;
  /** Claude gets the index without the save paragraph: its own prompt teaches saving. */
  readonly engine?: "claude" | "codex" | "caveman";
}

export interface Rendered {
  readonly files: Record<string, string>;
  readonly base: Map<string, { content: string; notes: NoteRow[] }>;
  readonly brief: string;
  /** The notes the brief's index lists, as `store:id`. */
  readonly briefed: ReadonlyArray<string>;
}

const codeTokens = (text: string) => text.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
/** A learned note whose backticked tokens all appear in the instruction files restates them. */
export function restates(ctx: Pick<RenderContext, "instructionFiles">, row: Pick<NoteRow, "text" | "authority">) {
  const tokens = [...row.text.matchAll(/`([^`]+)`/g)].flatMap((m) => codeTokens(m[1]!));
  const instructions = new Set(codeTokens(ctx.instructionFiles));
  return row.authority === "learned" && tokens.length > 0 && tokens.every((t) => instructions.has(t));
}

/** In the brief: what the user said (told), team notes, and notes the user pinned. Never a tainted note; an agent's own draft stays out. */
export function eligible(row: Pick<NoteRow, "tainted" | "meta" | "authority">) {
  return !row.tainted && (metaOf(row).pinned === true || row.authority === "told" || row.authority === "team");
}

export const noteName = (row: Pick<NoteRow, "meta" | "path">) =>
  (metaOf(row).name as string | undefined) ?? row.path.split("/").at(-1)!.replace(/\.md$/, "").replaceAll("-", " ");
const hook = (row: Pick<NoteRow, "meta" | "text">) => (metaOf(row).description as string | undefined) ?? row.text;

/** A note as Claude's trained file: front matter, the text (or a file's facts), then optional Why and How to apply lines. */
export function noteFile(row: NoteRow, body = row.text) {
  const meta = metaOf(row);
  const type = (meta.type as string | undefined) ?? (row.path.startsWith("user/") ? "user" : "project");
  return `---\nname: ${JSON.stringify(noteName(row))}\ndescription: ${JSON.stringify(hook(row))}\nmetadata:\n  type: ${type}\n${row.authority === "draft" ? "status: draft\n" : ""}---\n\n${body}\n${meta.why ? `\n**Why:** ${meta.why}\n` : ""}${meta.how ? `\n**How to apply:** ${meta.how}\n` : ""}`;
}

/** A note file back into front matter and facts (separate paragraphs or bullets are separate facts). */
export function parseNote(content: string): { meta: Record<string, unknown>; facts: string[] } {
  if (!content.trim()) return { meta: {}, facts: [] };
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const meta: Record<string, unknown> = {};
  if (front) {
    for (const field of ["name", "description", "status"]) {
      const value = front[1]!.match(new RegExp(`^${field}:\\s*(.*)$`, "m"))?.[1];
      if (value !== undefined) {
        try {
          meta[field] = value.startsWith('"') ? JSON.parse(value) : value;
        } catch {
          meta[field] = value;
        }
      }
    }
    // Claude Code writes `metadata:` with node_type, type, originSessionId and modified under it, in any order.
    const type = front[1]!.match(/^[ \t]*type:\s*["']?(user|feedback|project|reference)["']?\s*$/m)?.[1];
    if (type) meta.type = type;
  }
  let body = front ? content.slice(front[0].length) : content;
  for (const [label, key] of [
    ["Why", "why"],
    ["How to apply", "how"],
  ] as const) {
    const pattern = new RegExp(`^\\*\\*${label}:\\*\\* (.*)$`, "m");
    const match = body.match(pattern);
    if (match) {
      meta[key] = match[1];
      body = body.replace(pattern, "");
    }
  }
  const facts = body
    .trim()
    .split(/\n\s*\n|\n(?=\s*[-*] )/)
    .map((s) => s.replace(/^\s*[-*] /, "").trim().replace(/\r?\n/g, " "))
    .filter(Boolean);
  return { meta, facts };
}

/** Where a store row sits in the copy: this repo's notes under repo/, team notes under team/<drive>/. */
export const copyPath = (ctx: Pick<RenderContext, "repoId">, row: Pick<NoteRow, "store" | "path">) =>
  row.store.startsWith("team:") ? `team/${row.store.slice(5)}/${row.path}` : row.path.replace(`repos/${ctx.repoId.toLowerCase()}/`, "repo/");

/**
 * The file a frozen index links for each note it lists, as `store:id`: its note lines are in the order its notes were
 * briefed. Only a path the note would still render at (its copy path, or that with a `-N`) counts: a note moved since
 * belongs elsewhere now.
 */
function frozenPaths(ctx: Pick<RenderContext, "repoId">, frozen: Pick<SessionBrief, "index" | "notes">, notes: ReadonlyArray<NoteRow>) {
  const lines = frozen.index.split("\n").filter((line) => line.startsWith("- ["));
  const keep = new Map<string, string>();
  const reserved = new Set<string>();
  if (frozen.notes?.length !== lines.length) return { keep, reserved };
  const byKey = new Map(notes.map((r) => [`${r.store}:${r.id}`, r]));
  frozen.notes.forEach((key, i) => {
    const p = lines[i]!.match(/\]\(([\w./-]+\.md)\) — /)?.[1];
    if (p === undefined || p === "MEMORY.md") return;
    reserved.add(p);
    const row = byKey.get(key);
    const stem = row && copyPath(ctx, row).slice(0, -3);
    if (stem !== undefined && (p === `${stem}.md` || (p.startsWith(`${stem}-`) && /^\d+\.md$/.test(p.slice(stem.length + 1))))) keep.set(key, p);
  });
  return { keep, reserved };
}

/**
 * The session's copy (files and their bases) and its brief, from the store's current notes. With `frozen`, the brief a
 * resumed session keeps, each note it lists stays at the file its index links, and no other note takes one of those.
 */
export function render(store: MemoryStore, ctx: RenderContext, frozen?: Pick<SessionBrief, "index" | "notes">): Rendered {
  const files: Record<string, string> = {};
  const base = new Map<string, { content: string; notes: NoteRow[] }>();
  const selected: NoteRow[] = [];
  const repoPrefix = `repos/${ctx.repoId.toLowerCase()}/`;
  for (let row of store.current(ctx) as NoteRow[]) {
    if (row.tainted || (row.store === "me" && !row.path.startsWith("user/") && !row.path.startsWith(repoPrefix))) continue;
    const cites = (metaOf(row).cites as string[] | undefined) ?? [];
    const dead = ctx.fileExists !== undefined && cites.some((c) => !ctx.fileExists!(String(c).replace(/:\d+$/, "")));
    if (dead && metaOf(row).suspect !== "cited file gone") {
      // The runtime adds a diagnostic, keeping authority and every other field.
      const updated = store.commit({ ...ctx, kind: "live" }, [
        { id: row.id, store: row.store, baseVid: row.vid, meta: { ...metaOf(row), suspect: "cited file gone" } },
      ]).saved[0];
      if (updated) row = updated;
    }
    if (restates(ctx, row) || (dead && row.authority === "learned")) continue;
    selected.push(row);
  }
  selected.sort((a, b) => b.added.localeCompare(a.added) || b.vid.localeCompare(a.vid));
  const paths = new Map<string, string>();
  const place = (row: NoteRow, p: string) => {
    paths.set(row.id, p);
    files[p] = noteFile(row);
    base.set(p, { content: files[p]!, notes: [row] });
  };
  const { keep, reserved } = frozen ? frozenPaths(ctx, frozen, selected) : { keep: new Map<string, string>(), reserved: new Set<string>() };
  for (const row of selected) {
    const p = keep.get(`${row.store}:${row.id}`);
    if (p !== undefined) place(row, p);
  }
  for (const row of selected) {
    if (paths.has(row.id)) continue;
    const original = copyPath(ctx, row);
    let p = original;
    let occurrence = 1;
    while (Object.hasOwn(files, p) || reserved.has(p)) p = original.replace(/\.md$/, `-${++occurrence}.md`);
    place(row, p);
  }
  let index = "";
  const briefed: string[] = [];
  // A conservative character proxy for tokens (4 characters each), not a tokenizer.
  // A pinned draft is a claim the user wants loaded: it sits with the learned notes (an older runtime's, pinned).
  const tierOf = (r: NoteRow) => (r.authority === "draft" ? "learned" : r.authority);
  for (const [tier, title, share] of TIERS) {
    const notes = selected.filter((r) => tierOf(r) === tier && eligible(r));
    // An empty tier is left out: a heading over nothing costs every request of every chat.
    if (notes.length === 0) continue;
    for (let n = notes.length; n >= 0; n--) {
      const more = n < notes.length ? `+${notes.length - n} more in ${tier === "team" ? "team/" : "./"}\n` : "";
      const lines = notes
        .slice(0, n)
        .map((r) => `- [${noteName(r)}](${paths.get(r.id)}) — ${hook(r)} (${r.added})\n`)
        .join("");
      if ((title.length + lines.length + more.length) / 4 <= share) {
        index += `${title}\n${lines}${more}`;
        briefed.push(...notes.slice(0, n).map((r) => `${r.store}:${r.id}`));
        break;
      }
    }
  }
  files["MEMORY.md"] = index;
  base.set("MEMORY.md", { content: index, notes: [] });
  const brief = `<memory dir="${ctx.copyLabel ?? "{copy}"}">\n${BRIEF_HEADER}\n${index}${ctx.engine === "claude" ? "" : `${SAVE_PARAGRAPH}\n`}</memory>\n`;
  if (brief.length / 4 > BRIEF_MAX_TOKENS) throw new Error("brief exceeds its budget");
  return { files, base, brief, briefed };
}

/** The brief frozen at a session's start: resume reads the stored bytes; a fork reuses its parent's. */
export function sessionBrief(store: MemoryStore, ctx: RenderContext, forkFrom?: string) {
  const saved = store.sessionBrief(ctx.session);
  if (saved) return saved;
  const parent = forkFrom === undefined ? undefined : store.sessionBrief(forkFrom);
  if (parent) return store.saveSessionBrief(ctx.session, parent);
  const rendered = render(store, ctx);
  return store.saveSessionBrief(ctx.session, { text: rendered.brief, index: rendered.files["MEMORY.md"]!, notes: rendered.briefed });
}

// ------------------------------------------------------------------ the copy

/** A live session's copy: its directory, its bases, and the context it writes with. */
export interface CopySession {
  /** Replaced before each ingest with the session's latest user messages and taint. */
  ctx: RenderContext;
  readonly copyDir: string;
  base: Map<string, { content: string; notes: NoteRow[] }>;
  /** What was written at the start. */
  readonly files: Readonly<Record<string, string>>;
}

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
// Windows has none of these.
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

const notePath = (file: string) => {
  if (!/^[\w./-]+\.md$/.test(file) || file.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("invalid copy path");
  return file.split("/");
};
const linkRefused = () => new Error("copy symlink refused");
/** A note is a regular file with no other name: a hard link is also a file outside the copy, and a pipe blocks a read. */
const ownFile = (st: fs.Stats) => st.isFile() && st.nlink === 1;

/** A copy-relative note path on disk; refuses traversal, symlinks inside the copy and a note that is not a file of its own. */
export function diskPath(copyDir: string, file: string) {
  let p = copyDir;
  let found: fs.Stats | undefined;
  for (const part of notePath(file)) {
    p = path.join(p, part);
    // lstat, not existsSync: existsSync follows the link, so a dangling one would pass.
    found = fs.lstatSync(p, { throwIfNoEntry: false });
    if (found?.isSymbolicLink()) throw linkRefused();
  }
  if (found && !ownFile(found)) throw new Error("copy file refused: not a file of its own");
  return p;
}

/**
 * A command the agent left running in the copy (Codex's writable root) can swap one of its folders for a link to
 * anywhere between the runtime's check of a path and its write, and the runtime runs in no sandbox. So the runtime
 * goes through the copy's folders open, naming each by what it is rather than by its path: Linux by its descriptor,
 * macOS by its file id. A name under that path is looked up in that folder, wherever it has been moved and whatever
 * is at its old path now. Windows can name a folder only by its path, checked on the way, which a swap right after the
 * check still beats.
 */
const pinned = process.platform === "linux" || process.platform === "darwin";
function enter(folder: string, opened: number[]) {
  if (!pinned) return folder;
  const fd = fs.openSync(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  opened.push(fd);
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  const { dev, ino } = fs.fstatSync(fd, { bigint: true });
  return `/.vol/${dev}/${ino}`;
}

/**
 * `use` with the path of `file` in the copy, through its folders entered as above. Where a folder should be, a link is
 * refused; with `clear` it counts, like anything else but a folder, as no folder. No folder means no file (`use` gets
 * undefined), or with `make` a new folder in place of what was there.
 */
function throughCopy<T>(copyDir: string, file: string, how: { readonly clear: boolean; readonly make: boolean }, use: (p: string | undefined) => T): T {
  const parts = notePath(file);
  const name = parts.pop()!;
  const opened: number[] = [];
  try {
    if (!fs.existsSync(copyDir)) {
      if (!how.make) return use(undefined);
      fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
    }
    let folder = enter(copyDir, opened);
    for (const part of parts) {
      const at = path.join(folder, part);
      const found = fs.lstatSync(at, { throwIfNoEntry: false });
      if (found?.isSymbolicLink() && !how.clear) throw linkRefused();
      if (!found?.isDirectory()) {
        if (!how.make) return use(undefined);
        if (found && how.clear) fs.unlinkSync(at);
        fs.mkdirSync(at);
      }
      folder = enter(at, opened);
    }
    return use(path.join(folder, name));
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
}

/** Removes a folder of the copy with everything in it, entering each folder as `throughCopy` does. */
function removeFolder(at: string) {
  if (!pinned) return fs.rmSync(at, { recursive: true });
  const opened: number[] = [];
  try {
    const folder = enter(at, opened);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) removeFolder(path.join(folder, entry.name));
      else fs.unlinkSync(path.join(folder, entry.name));
    }
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
  fs.rmdirSync(at);
}

/**
 * A note file's text in the copy: "" when there is none, null when something no read should take is on its path (a
 * folder, a pipe, whose open waits for a writer, a file another name shares, which may be any file outside the copy,
 * or a file the runtime can't read). A link is refused, or with `clear` counts as no file.
 */
function readCopy(copyDir: string, file: string, clear = false): string | null {
  return throughCopy(copyDir, file, { clear, make: false }, (p) => {
    if (p === undefined) return "";
    const found = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!found) return "";
    if (found.isSymbolicLink() && !clear) throw linkRefused();
    if (!ownFile(found)) return null;
    let fd: number;
    try {
      // Neither following a link nor waiting on a pipe swapped in since the lstat.
      fd = openNoFollowSync(p, O_RDONLY | O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "";
      if (code === "ELOOP" && !clear) throw linkRefused();
      if (code === "ELOOP" || code === "EACCES" || code === "EPERM") return null;
      throw error;
    }
    try {
      // A second name linked in since the lstat is checked on what was opened.
      return ownFile(fs.fstatSync(fd)) ? fs.readFileSync(fd, "utf8") : null;
    } finally {
      fs.closeSync(fd);
    }
  });
}

/**
 * Writes `content` to a note file in the copy, or with null removes it. Always as a new file: never through a link
 * swapped in, into a pipe that would hold the write until a reader came, or into a file that is also named elsewhere.
 * A link on the way is refused, or with `clear` removed with a folder or anything else in the way.
 */
export function writeCopy(copyDir: string, file: string, content: string | null, clear = false) {
  throughCopy(copyDir, file, { clear, make: content !== null }, (p) => {
    if (p === undefined) return;
    const found = fs.lstatSync(p, { throwIfNoEntry: false });
    if (found?.isSymbolicLink() && !clear) throw linkRefused();
    if (found?.isDirectory()) {
      if (!clear) throw new Error("copy path is a folder");
      removeFolder(p);
    } else if (found) fs.unlinkSync(p);
    if (content === null) return;
    const fd = fs.openSync(p, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
    try {
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  });
}

/** Render the session's copy into `copyDir` (replacing what was there), its MEMORY.md the frozen index. */
export function startSession(store: MemoryStore, ctx: RenderContext, copyDir: string, forkFrom?: string): CopySession {
  const frozen = sessionBrief(store, ctx, forkFrom);
  const rendered = render(store, ctx, frozen);
  rendered.files["MEMORY.md"] = frozen.index;
  rendered.base.set("MEMORY.md", { content: frozen.index, notes: [] });
  // A command left running in the old copy can still be at work in it, and put things in the new one: they give way.
  const found = fs.lstatSync(copyDir, { throwIfNoEntry: false });
  if (found?.isDirectory()) removeFolder(copyDir);
  else if (found) fs.unlinkSync(copyDir);
  fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
  for (const [file, content] of Object.entries(rendered.files)) writeCopy(copyDir, file, content, true);
  return { ctx, copyDir, base: rendered.base, files: rendered.files };
}

/** A write to the copy as an engine's tool reported it. */
export interface CopyEvent {
  readonly tool: "Edit" | "Write" | "fileChange" | "Delete";
  /** Copy-relative path. */
  readonly file: string;
  readonly content?: string;
  readonly old_string?: string;
  readonly new_string?: string;
  readonly replace_all?: boolean;
  readonly diff?: string;
  readonly agent_id?: string;
  readonly subagent?: boolean;
}

/** Subagents and automations never write memory. */
export function preToolUse(ctx: Pick<WriterContext, "subagent" | "agent_id" | "automation">, event: Pick<CopyEvent, "tool" | "agent_id" | "subagent">) {
  const writes = ["Edit", "Write", "fileChange", "Delete"].includes(event.tool);
  return writes && (ctx.subagent || ctx.agent_id || ctx.automation || event.agent_id || event.subagent) ? "deny" : "allow";
}

/** A small unified-diff subset: exact context, several hunks, no renames or binary files. */
export function applyDiff(content: string, diff: string) {
  const input = content.split("\n");
  if (input.at(-1) === "") input.pop();
  const lines = diff.split("\n");
  const output: string[] = [];
  let cursor = 0;
  let sawHunk = false;
  for (let i = 0; i < lines.length; ) {
    if (/^(---|\+\+\+) /.test(lines[i]!) || !lines[i]) {
      i++;
      continue;
    }
    const hunk = lines[i++]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (!hunk) throw new Error("unsupported unified diff");
    sawHunk = true;
    const start = Number(hunk[1]) === 0 ? 0 : Number(hunk[1]) - 1;
    if (start < cursor || start > input.length) throw new Error("diff position mismatch");
    output.push(...input.slice(cursor, start));
    cursor = start;
    let removed = 0;
    let added = 0;
    while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
      const line = lines[i++]!;
      if (!line || line.startsWith("\\ No newline")) continue;
      if (line[0] === " " || line[0] === "-") {
        if (input[cursor++] !== line.slice(1)) throw new Error("diff context mismatch");
        removed++;
      }
      if (line[0] === " " || line[0] === "+") {
        output.push(line.slice(1));
        added++;
      }
      if (![" ", "+", "-"].includes(line[0]!)) throw new Error("unsupported diff line");
    }
    if (removed !== Number(hunk[2] ?? 1) || added !== Number(hunk[4] ?? 1)) throw new Error("diff count mismatch");
  }
  if (!sawHunk) throw new Error("missing diff hunk");
  output.push(...input.slice(cursor));
  return output.length ? `${output.join("\n")}\n` : "";
}

/** The file's content after the event's own change, applied to `base`. */
export function eventContent(base: string, event: CopyEvent) {
  if (event.tool === "Write") return event.content ?? "";
  if (event.tool === "Delete") return "";
  if (event.tool === "fileChange") return applyDiff(base, event.diff ?? "");
  if (!event.old_string || !base.includes(event.old_string)) throw new Error("Edit does not match base");
  if (!event.replace_all && base.split(event.old_string).length !== 2) throw new Error("ambiguous Edit");
  return event.replace_all ? base.split(event.old_string).join(event.new_string ?? "") : base.replace(event.old_string, event.new_string ?? "");
}

/** The operations a file's new content means, paired with its prior notes by position. */
export function fileOps(session: CopySession, file: string, content: string, quarantineOnly = false): Operation[] {
  const { ctx } = session;
  const prior = session.base.get(file);
  if (prior?.content === content) return [];
  const parsed = parseNote(content);
  const before = prior?.notes ?? [];
  const priorMeta = parseNote(prior?.content ?? "").meta;
  const type = parsed.meta.type as string | undefined;
  const routed = file.startsWith("team/")
    ? file
    : `${type ? (["user", "feedback"].includes(type) ? "user" : "repo") : file.startsWith("user/") ? "user" : "repo"}/${file.replace(/^(?:repo|user)\//, "")}`;
  const operations: Operation[] = [];
  // Positional pairing is deliberate: matching equal text first loses edits on swaps.
  for (let i = 0; i < Math.max(before.length, parsed.facts.length); i++) {
    const old = before[i];
    const text = parsed.facts[i] ?? "";
    const meta: Record<string, unknown> = old ? { ...metaOf(old) } : { ...parsed.meta };
    if (old)
      for (const key of new Set([...Object.keys(priorMeta), ...Object.keys(parsed.meta)])) {
        if (canonical(priorMeta[key]) === canonical(parsed.meta[key])) continue;
        if (Object.hasOwn(parsed.meta, key)) meta[key] = parsed.meta[key];
        else delete meta[key];
      }
    delete meta.status;
    if (old?.text === text && canonical(metaOf(old)) === canonical(meta) && (!type || scope(ctx, routed, old.store) === old.path)) continue;
    if (quarantineOnly) {
      operations.push({
        path: routed.startsWith("team/") ? "repo/quarantined-team.md" : routed,
        text: text || old?.text || "Copy file removed",
        meta: { ...meta, suspect: "out-of-band copy change" },
      });
    } else
      operations.push({
        id: old?.id,
        baseVid: old?.vid,
        path: routed,
        text,
        meta,
        ...(file.startsWith("team/") ? { type: "proposal" as const, store: `team:${file.split("/")[1]}`, target: old?.id ?? null } : {}),
      });
  }
  return operations;
}

const EMPTY: CommitResult = { saved: [], proposals: [], rejected: [], conflicts: [], similar: [] };

/** Commit a tool event's own change to the copy. Edits to MEMORY.md are ignored: it is re-rendered every session. */
export function ingest(store: MemoryStore, session: CopySession, event: CopyEvent): CommitResult {
  if (preToolUse(session.ctx, event) === "deny") throw new Error("copy write denied");
  diskPath(session.copyDir, event.file);
  if (event.file === "MEMORY.md") return EMPTY;
  const prior = session.base.get(event.file) ?? { content: "", notes: [] };
  const content = eventContent(prior.content, event);
  const result = store.commit(session.ctx, fileOps(session, event.file, content));
  const refused = result.rejected.length > 0 || result.conflicts.length > 0;
  const saved = new Map(result.saved.map((r) => [r.id, r]));
  // Another writer's version (what a conflict means) comes in as a new session's render would show it: never tainted,
  // and only while the note is still at this file's path. Kept here once moved, the next write of the file would move
  // it back.
  const held = (r: NoteRow) => {
    const head = store.head(r.store, r.id);
    if (head?.path !== r.path) return undefined;
    return head.vid === r.vid || !head.tainted ? head : undefined;
  };
  const added = result.saved.filter((r) => !prior.notes.some((old) => old.id === r.id));
  const kept = prior.notes.map((r) => saved.get(r.id) ?? (refused ? held(r) : r));
  const notes = [...kept, ...added].filter((r): r is NoteRow => !!r?.text);
  if (!refused) session.base.set(event.file, { content, notes });
  // The store saves each fact on its own, so part of a write can be saved and the rest refused, and a conflict means
  // another writer moved a note. The base is then the notes the store holds, so the next write pairs with them, and
  // the sweep puts the refused rest back.
  else if (notes.length !== prior.notes.length || notes.some((r, i) => r.vid !== prior.notes[i]!.vid)) {
    const next = notes.length ? noteFile(notes[0]!, notes.map((r) => r.text).join("\n\n")) : "";
    session.base.set(event.file, { content: next, notes });
    // A version this session never wrote is in the copy before anything can pair with it: a write made from a reread
    // then carries the other writer's change, where one made from the copy as it was would overwrite it unseen.
    if (kept.some((r, i) => !saved.has(prior.notes[i]!.id) && r?.vid !== prior.notes[i]!.vid)) writeCopy(session.copyDir, event.file, next);
  }
  return result;
}

/** The tool runs on disk, then its own change is ingested (tests and the Caveman engine's copy tools). */
export function runCopyTool(store: MemoryStore, session: CopySession, event: CopyEvent): CommitResult | { decision: "deny" } {
  if (preToolUse(session.ctx, event) === "deny") return { decision: "deny" };
  const actual = readCopy(session.copyDir, event.file);
  if (actual === null) throw new Error("not a note file");
  writeCopy(session.copyDir, event.file, eventContent(actual, event));
  return ingest(store, session, event);
}

/**
 * After ingest, anything still differing from the base becomes quarantined drafts, and the file goes back to its base.
 * `scrubber` hides the project's secrets in what it commits, as ingest's caller does for a tool's write.
 */
export function turnEndSweep(store: MemoryStore, session: CopySession, scrubber?: { readonly scrub: (text: string) => string }): NoteRow[] {
  const files = new Set(session.base.keys());
  const walk = (dir: string, prefix = "") => {
    const opened: number[] = [];
    try {
      // Entered, so a folder swapped for a link since its parent was listed is not listed: through a link to / the walk
      // would list the whole disk.
      const folder = enter(dir, opened);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(path.join(folder, entry.name), `${relative}/`);
        else if (entry.isFile() && relative.endsWith(".md")) files.add(relative);
      }
    } catch (error) {
      // Gone, something else now, or shut to the runtime since it was listed: the rest of the copy is still swept.
      if (!["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally {
      for (const fd of opened) fs.closeSync(fd);
    }
  };
  walk(session.copyDir);
  const result: NoteRow[] = [];
  // Deepest first: the note files in a folder a command put on a note file's path are swept before the folder goes.
  for (const file of [...files].sort((a, b) => b.split("/").length - a.split("/").length)) {
    let actual: string | null;
    try {
      // A symlink planted on a base file's path counts as the file gone: the base is put back as a file inside the copy.
      actual = readCopy(session.copyDir, file, session.base.has(file));
    } catch {
      continue;
    }
    const base = session.base.get(file)?.content ?? "";
    if (actual === base) continue;
    // Anything but a readable file on the path counts as the file removed, and is replaced below.
    // fileOps compares the scrubbed text with the base: ingest keeps a tool's write there scrubbed, while the disk still holds the value.
    const seen = scrubber ? scrubber.scrub(actual ?? "") : (actual ?? "");
    if (file !== "MEMORY.md") result.push(...store.commit({ ...session.ctx, quarantine: true }, fileOps(session, file, seen, true)).saved);
    writeCopy(session.copyDir, file, session.base.has(file) ? base : null, true);
  }
  return result;
}
