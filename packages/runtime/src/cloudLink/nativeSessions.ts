// Moves for Claude Agent and Codex chats (Caveman Cloud the spec, amended 2026-10-21): the chat travels with the
// file its CLI keeps the conversation in, so the computer it lands on resumes that conversation natively.
//
// Only named files are read, at paths derived here from the engine's config dir, the chat's working directory and
// the session id: Claude's `<config dir>/projects/<cwd key>/<id>.jsonl` and the subagent files beside it, Codex's
// rollout for the thread under `$CODEX_HOME/sessions`. Never a credentials file, a settings file or anything else in
// those folders. Session files are append-only, so a copy carries only the lines added since the last one (`known`).
// Each line is scrubbed like the rest of a copy, with two exceptions: Claude's `thinking` and `redacted_thinking`
// blocks are dropped (they are signed, and a scrubbed one would no longer verify), and Codex's `encrypted_content`
// travels as it is (opaque; only the account that wrote it can read it, so a Codex chat on another account hands over
// its context instead), and only where Codex keeps it: a reasoning or compaction item's own field, base64-shaped. A line
// still being written (no newline yet) waits for the next copy; a line that is not JSON never travels. Files are read
// and written without following symlinks, and written whole (a temporary file renamed into place).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Scrubber } from "@caveman-app/session-protocol";

import { openNoFollow } from "../openNoFollow.ts";
import { runBytes } from "./tools.ts";

export type NativeKind = "claude" | "codex";

/** One file of an engine's own session, as one copy carries it. */
export interface NativeFile {
  /** Where it sits: Claude `<id>.jsonl` or `<id>/subagents/<name>.jsonl`; Codex `YYYY/MM/DD/rollout-<time>-<id>.jsonl`. */
  readonly path: string;
  /** How many of its lines the copies before this one carried; these lines follow them. 0: the file from its start. */
  readonly from: number;
  readonly lines: ReadonlyArray<string>;
}

/** An engine's own session in a copy (MoveBundle `engine.native`). */
export interface NativeCopy {
  readonly kind: NativeKind;
  /** Claude's session id, Codex's thread id. */
  readonly id: string;
  /** Claude: the message the conversation resumes at (the SDK's resumeSessionAt); null for Codex. */
  readonly head: string | null;
  /** The working directory it ran in: lines naming it name the one it lands in instead. */
  readonly cwd: string;
  readonly files: ReadonlyArray<NativeFile>;
}

/**
 * What the copies so far carried of each file: the lines read and their sha256 (as read), and how many lines went out
 * (fewer when entries were left out); and the Claude entries left out.
 */
export interface NativeKnown {
  readonly files: Readonly<Record<string, { readonly lines: number; readonly sha: string; readonly kept: number }>>;
  /** Claude entries dropped whole (only thinking): their uuid and their parent's, so a child points past them. */
  readonly dropped?: Readonly<Record<string, string | null>>;
}

/** File access where the engine runs: this process's own on This Mac, the tools container's on a Cloud computer. */
export interface NativeIo {
  /** The file's bytes, or undefined when there is none, or when it is not a regular file (a symlink is never followed). */
  readonly read: (file: string) => Promise<Uint8Array | undefined>;
  /** The names in a directory; none when it is missing. */
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>;
  /** Writes the file whole (owner-only, through a temporary file renamed into place), making its directory; never through a symlink. */
  readonly write: (file: string, bytes: Uint8Array) => Promise<void>;
  /** Whether anything (a file, or a symlink) is at the path. */
  readonly exists: (file: string) => Promise<boolean>;
  /** The directory as the engine's process sees it (symlinks resolved), which is what Claude keys projects by. */
  readonly realpath: (dir: string) => Promise<string>;
  /** HOME, CLAUDE_CONFIG_DIR and CODEX_HOME as the engine's process sees them. */
  readonly env: () => Promise<{ readonly home: string; readonly claudeConfigDir?: string; readonly codexHome?: string }>;
}

/** Ids as Claude (a UUID) and Codex (a UUID) mint them: anything else could name a path. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;
const ROLLOUT_DATE = /^\d{4}\/\d{2}\/\d{2}$/;
/** Claude keys a project by its directory with every other character a dash, cut with a hash past this length. */
const CLAUDE_KEY_MAX = 200;
/** A copy never carries a session file past this (a segment holds 8 MiB packed): such a chat hands over its context instead. */
export const NATIVE_MAX_BYTES = 48 * 1024 * 1024;

export const isSessionId = (id: string) => SESSION_ID.test(id);

/** The folder name Claude keeps a working directory's sessions under, or undefined past the length it hashes. */
export function claudeProjectKey(cwd: string): string | undefined {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return key.length <= CLAUDE_KEY_MAX ? key : undefined;
}

/** The config dir Claude runs with: the instance's own (an account of its own), else CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (configured: string | undefined, env: { readonly home: string; readonly claudeConfigDir?: string | undefined }) =>
  configured?.trim() ? path.resolve(env.home, configured.trim().replace(/^~(?=$|\/)/, env.home)) : env.claudeConfigDir?.trim() || path.join(env.home, ".claude");

/** Likewise CODEX_HOME: the instance's own, else the environment's, else ~/.codex. */
export const codexHome = (configured: string | undefined, env: { readonly home: string; readonly codexHome?: string | undefined }) =>
  configured?.trim() ? path.resolve(env.home, configured.trim().replace(/^~(?=$|\/)/, env.home)) : env.codexHome?.trim() || path.join(env.home, ".codex");

const sha = (lines: ReadonlyArray<string>) => {
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line).update("\n");
  return hash.digest("hex");
};

/** The complete lines of a file (a last line without its newline is still being written). */
const completeLines = (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString("utf8");
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n");
};

const parseObject = (line: string) => {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const THINKING = new Set(["thinking", "redacted_thinking"]);

/**
 * A Claude session line for a copy: thinking blocks gone, scrubbed. undefined when the entry was only thinking: it is
 * left out, and `dropped` notes it so the entries after it point to its parent instead.
 */
export function claudeLineForCopy(line: string, scrubber: Pick<Scrubber, "scrub" | "scrubDeep">, dropped: Map<string, string | null>): string | undefined {
  const entry = parseObject(line);
  // A line the CLI did not write as an entry carries nothing it resumes from.
  if (entry === undefined) return undefined;
  let out: Record<string, unknown> = entry;
  const message = entry.message as { content?: unknown } | undefined;
  if (message && typeof message === "object" && Array.isArray(message.content)) {
    const content = (message.content as ReadonlyArray<{ type?: unknown }>).filter((block) => !(block && typeof block === "object" && THINKING.has(String(block.type))));
    if (content.length !== message.content.length) {
      if (content.length === 0) {
        if (typeof entry.uuid === "string") dropped.set(entry.uuid, typeof entry.parentUuid === "string" ? entry.parentUuid : null);
        return undefined;
      }
      out = { ...entry, message: { ...message, content } };
    }
  }
  // An entry whose parent was left out points to the nearest one kept.
  let parent = out.parentUuid;
  for (let hops = 0; typeof parent === "string" && dropped.has(parent) && hops < 10_000; hops++) parent = dropped.get(parent)!;
  if (parent !== out.parentUuid) out = { ...out, parentUuid: parent ?? null };
  return JSON.stringify(scrubber.scrubDeep(out));
}

/** Codex's sealed reasoning: base64 or base64url, as OpenAI returns it. */
const SEALED_SHAPE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
/** The items whose own `encrypted_content` Codex keeps sealed (a reasoning item; a compaction's summary). */
const SEALED_ITEMS = new Set(["reasoning", "compaction", "compaction_summary"]);

/**
 * A Codex rollout line for a copy: scrubbed, except a reasoning or compaction item's own `payload.encrypted_content`
 * when it is base64-shaped (sealed by OpenAI; scrubbing it would break it, and no secret reads as it). The same key
 * anywhere else, or holding anything else, is scrubbed like every other string.
 */
export function codexLineForCopy(line: string, scrubber: Pick<Scrubber, "scrub" | "scrubDeep">): string | undefined {
  const entry = parseObject(line);
  if (entry === undefined) return undefined;
  const payload = entry.payload as { type?: unknown; encrypted_content?: unknown } | undefined;
  const sealed =
    payload !== null && typeof payload === "object" && SEALED_ITEMS.has(String(payload.type)) && typeof payload.encrypted_content === "string" && SEALED_SHAPE.test(payload.encrypted_content)
      ? payload.encrypted_content
      : undefined;
  if (sealed === undefined) return JSON.stringify(scrubber.scrubDeep(entry));
  const { encrypted_content: _sealed, ...rest } = payload as Record<string, unknown>;
  const scrubbed = scrubber.scrubDeep({ ...entry, payload: rest }) as Record<string, unknown>;
  return JSON.stringify({ ...scrubbed, payload: { ...(scrubbed.payload as Record<string, unknown>), encrypted_content: sealed } });
}

/**
 * Where a copied Claude session resumes (the SDK's resumeSessionAt): its last message entry that leaves nothing open,
 * so a copy made mid-turn never resumes on a tool call whose result it lacks. Thinking-only entries are not copied, so
 * never the point.
 */
export function claudeResumePoint(lines: ReadonlyArray<string>): string | undefined {
  for (const line of lines.toReversed()) {
    const entry = parseObject(line);
    if (typeof entry?.uuid !== "string" || (entry.type !== "assistant" && entry.type !== "user") || entry.isSidechain === true) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(content) ? (content as ReadonlyArray<{ type?: unknown }>) : [];
    if (blocks.some((b) => b?.type === "tool_use")) continue;
    if (blocks.length > 0 && blocks.every((b) => THINKING.has(String(b?.type)))) continue;
    return entry.uuid;
  }
  return undefined;
}

/** The files a copy reads, by the name the copy gives each, at paths derived from the session id only. */
async function claudeFiles(io: NativeIo, base: string, id: string) {
  const files = new Map<string, string>([[`${id}.jsonl`, path.join(base, `${id}.jsonl`)]]);
  for (const name of await io.list(path.join(base, id, "subagents"))) {
    if (SUBAGENT_FILE.test(name)) files.set(`${id}/subagents/${name}`, path.join(base, id, "subagents", name));
  }
  return files;
}

/** The rollout of a Codex thread: `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, newest day first, as Codex looks. */
export async function findCodexRollout(io: NativeIo, home: string, id: string): Promise<string | undefined> {
  if (!isSessionId(id)) return undefined;
  const sessions = path.join(home, "sessions");
  const digits = (n: number) => (name: string) => new RegExp(`^\\d{${n}}$`).test(name);
  const newest = (names: ReadonlyArray<string>, n: number) => names.filter(digits(n)).toSorted().toReversed();
  // ponytail: walks every day folder until it finds the thread; a person with years of daily Codex use pays a few hundred lists once per copy.
  for (const year of newest(await io.list(sessions), 4)) {
    for (const month of newest(await io.list(path.join(sessions, year)), 2)) {
      for (const day of newest(await io.list(path.join(sessions, year, month)), 2)) {
        if (!rolloutDayOk(`${year}/${month}/${day}`)) continue;
        const name = (await io.list(path.join(sessions, year, month, day))).find((n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`));
        if (name) return `${year}/${month}/${day}/${name}`;
      }
    }
  }
  return undefined;
}

export interface ReadNativeInput {
  readonly kind: NativeKind;
  readonly id: string;
  /** Claude: the config dir the chat's login runs with; Codex: its CODEX_HOME. */
  readonly home: string;
  /** The chat's working directory (Claude keys its sessions by it). */
  readonly cwd: string;
  readonly known?: NativeKnown;
  readonly scrubber: Pick<Scrubber, "scrub" | "scrubDeep">;
}

/** The session's files by the name a copy gives them (NativeFile.path), and where each sits; undefined when it has none. */
async function sessionFiles(io: NativeIo, input: { readonly kind: NativeKind; readonly id: string; readonly home: string; readonly cwd: string }) {
  if (!isSessionId(input.id)) return undefined;
  if (input.kind === "claude") {
    const key = claudeProjectKey(input.cwd);
    return key === undefined ? undefined : await claudeFiles(io, path.join(input.home, "projects", key), input.id);
  }
  const rollout = await findCodexRollout(io, input.home, input.id);
  return rollout === undefined ? undefined : new Map([[rollout, path.join(input.home, "sessions", rollout)]]);
}

/**
 * The engine's session as one copy carries it: every file's lines after the ones `known` says were carried (all of a
 * file whose start changed), and what the next copy builds on. undefined when there is no session file to carry (the
 * chat then hands over its context where it lands), or when it is past NATIVE_MAX_BYTES.
 */
export async function readNativeCopy(io: NativeIo, input: ReadNativeInput): Promise<{ readonly copy: NativeCopy; readonly known: NativeKnown; readonly changed: boolean } | undefined> {
  const cwd = await io.realpath(input.cwd);
  const files = await sessionFiles(io, { ...input, cwd });
  if (files === undefined) return undefined;
  const dropped = new Map(Object.entries(input.known?.dropped ?? {}));
  const known: Record<string, { lines: number; sha: string; kept: number }> = {};
  const out: Array<NativeFile> = [];
  let size = 0;
  let head: string | null = null;
  for (const [name, file] of files) {
    const bytes = await io.read(file);
    if (bytes === undefined) {
      if (name === `${input.id}.jsonl` || input.kind === "codex") return undefined;
      continue;
    }
    size += bytes.length;
    if (size > NATIVE_MAX_BYTES) return undefined;
    const lines = completeLines(bytes);
    const before = input.known?.files[name];
    // Carried before and unchanged since: only what follows goes. A file whose start changed goes whole again.
    const kept = before !== undefined && before.lines <= lines.length && sha(lines.slice(0, before.lines)) === before.sha ? before : undefined;
    if (input.kind === "claude" && name === `${input.id}.jsonl`) head = claudeResumePoint(lines) ?? head;
    const added = lines.slice(kept?.lines ?? 0).flatMap((line) => {
      const copied = input.kind === "claude" ? claudeLineForCopy(line, input.scrubber, dropped) : codexLineForCopy(line, input.scrubber);
      return copied === undefined ? [] : [copied];
    });
    known[name] = { lines: lines.length, sha: sha(lines), kept: (kept?.kept ?? 0) + added.length };
    if (kept !== undefined && added.length === 0) continue;
    out.push({ path: name, from: kept?.kept ?? 0, lines: added });
  }
  // Only the most recent drops matter to lines still to come.
  const recent = [...dropped].slice(-512);
  return {
    copy: { kind: input.kind, id: input.id, head, cwd, files: out },
    known: { files: known, ...(recent.length > 0 ? { dropped: Object.fromEntries(recent) } : {}) },
    changed: out.length > 0,
  };
}

/**
 * Whether the session is still exactly what the copies so far carried (`known`, as readNativeCopy left it): the same
 * files, each with the lines read then and nothing after, not even a line still being written. A file that changed,
 * grew, appeared or went says no (K15: a chat back on This Mac carries on in it only when it is as it left).
 */
export async function nativeAsKnown(io: NativeIo, input: { readonly kind: NativeKind; readonly id: string; readonly home: string; readonly cwd: string; readonly known: NativeKnown }): Promise<boolean> {
  const files = await sessionFiles(io, { ...input, cwd: await io.realpath(input.cwd) });
  if (files === undefined || files.size !== Object.keys(input.known.files).length) return false;
  for (const [name, file] of files) {
    const was = input.known.files[name];
    const bytes = was === undefined ? undefined : await io.read(file);
    if (was === undefined || bytes === undefined) return false;
    const lines = completeLines(bytes);
    const whole = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
    if (!whole || lines.length !== was.lines || sha(lines) !== was.sha) return false;
  }
  return true;
}

/**
 * The session file a copy carries for the chat it names: only when the file is the chat's own native thread (the id
 * its record carries), never another conversation's.
 */
export const nativeOfChat = (engine: { readonly native_thread_id: string; readonly native?: NativeCopy } | null | undefined): NativeCopy | undefined =>
  engine?.native !== undefined && engine.native.id === engine.native_thread_id && isSessionId(engine.native.id) ? engine.native : undefined;

/** Segments' native copies as one: each file whole, in order. Fails on a gap (a copy the earlier ones do not lead to). */
export function mergeNative(copies: ReadonlyArray<NativeCopy>): NativeCopy | undefined {
  const last = copies.at(-1);
  if (last === undefined) return undefined;
  const files = new Map<string, Array<string>>();
  // Files with a part whose start the copy lacks (two computers' deltas crossed, a session handed over mid-chain),
  // until a later part sends them whole again.
  const broken = new Set<string>();
  let previous: NativeCopy | undefined;
  for (const copy of copies) {
    // Another session (an engine switch, a handover): its file starts over.
    if (previous !== undefined && (copy.kind !== previous.kind || copy.id !== previous.id)) {
      files.clear();
      broken.clear();
    }
    previous = copy;
    for (const file of copy.files) {
      const lines = files.get(file.path) ?? [];
      if (file.from === 0) broken.delete(file.path);
      if (file.from > lines.length || broken.has(file.path)) {
        broken.add(file.path);
        continue;
      }
      files.set(file.path, [...lines.slice(0, file.from), ...file.lines]);
    }
  }
  // Not whole: none of it travels, and the chat hands over its context where it lands (K8).
  if (broken.size > 0) return undefined;
  return { ...last, files: [...files].map(([name, lines]) => ({ path: name, from: 0, lines })) };
}

/** A line with the working directory it names (Claude's `cwd`, Codex's `payload.cwd`) re-pointed to `cwd`. */
function relocated(kind: NativeKind, line: string, from: string, cwd: string) {
  const entry = parseObject(line);
  if (entry === undefined) return line;
  if (kind === "claude") return entry.cwd === from ? JSON.stringify({ ...entry, cwd }) : line;
  const payload = entry.payload as { cwd?: unknown } | undefined;
  return payload && typeof payload === "object" && payload.cwd === from ? JSON.stringify({ ...entry, payload: { ...payload, cwd } }) : line;
}

/** A rollout's day folder as Codex names it, never later than tomorrow (a later one would sort first and shadow the real one). */
export function rolloutDayOk(folder: string, now = Date.now()): boolean {
  if (!ROLLOUT_DATE.test(folder)) return false;
  const [y, m, d] = folder.split("/").map(Number) as [number, number, number];
  const day = Date.UTC(y, m - 1, d);
  const back = new Date(day);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d && y >= 2020 && day <= now + 24 * 60 * 60 * 1000;
}

/**
 * Writes a merged native copy where the engine on this computer looks for it: Claude under `home`'s project folder for
 * `cwd`, Codex under `home`/sessions. A file already there is replaced only when `mayReplace` says this chat placed it
 * (another conversation's history is never overwritten). Answers the session file's path and every file written;
 * throws when it cannot place it.
 */
export async function writeNativeCopy(
  io: NativeIo,
  copy: NativeCopy,
  target: { readonly home: string; readonly cwd: string; readonly mayReplace?: (file: string) => boolean },
): Promise<string> {
  if (!isSessionId(copy.id)) throw new Error("the engine's session id is not one it mints");
  const cwd = await io.realpath(target.cwd);
  let base: string;
  if (copy.kind === "claude") {
    const key = claudeProjectKey(cwd);
    if (key === undefined) throw new Error("this checkout's path is too long for Claude Agent to keep its session under");
    base = path.join(target.home, "projects", key);
  } else base = path.join(target.home, "sessions");
  let main: string | undefined;
  for (const file of copy.files) {
    const allowed =
      copy.kind === "claude"
        ? file.path === `${copy.id}.jsonl` || (file.path.startsWith(`${copy.id}/subagents/`) && SUBAGENT_FILE.test(file.path.slice(`${copy.id}/subagents/`.length)))
        : rolloutDayOk(path.posix.dirname(file.path)) && /^rollout-[A-Za-z0-9T:._-]+\.jsonl$/.test(path.posix.basename(file.path)) && file.path.endsWith(`-${copy.id}.jsonl`);
    if (!allowed) throw new Error(`the copy names a file the engine never writes: ${file.path}`);
    const destination = path.join(base, ...file.path.split("/"));
    if ((await io.exists(destination)) && !(target.mayReplace?.(destination) ?? false)) throw new Error(`a session file this chat did not place is already at ${destination}`);
    const text = file.lines.map((line) => relocated(copy.kind, line, copy.cwd, cwd)).join("\n");
    await io.write(destination, Buffer.from(text.length > 0 ? `${text}\n` : "", "utf8"));
    if (copy.kind === "codex" || file.path === `${copy.id}.jsonl`) main = destination;
  }
  if (main === undefined) throw new Error("the copy has no session file");
  return main;
}

/** This process's own files (This Mac, where the engine runs as this user). */
export const localNativeIo: NativeIo = {
  read: async (file) => {
    let handle: fs.promises.FileHandle;
    try {
      handle = await openNoFollow(file, fs.constants.O_RDONLY);
    } catch (error) {
      // Missing, or a symlink (ELOOP): nothing to carry.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP" || code === "EMLINK") return undefined;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  },
  list: (dir) => fs.promises.readdir(dir).catch(() => []),
  write: async (file, bytes) => {
    const dir = path.dirname(file);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = await fs.promises.lstat(file).catch(() => undefined);
    if (existing !== undefined && !existing.isFile()) throw new Error(`${file} is not a regular file`);
    const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, file).catch(async (error: unknown) => {
      await fs.promises.rm(temp, { force: true });
      throw error;
    });
  },
  exists: (file) => fs.promises.lstat(file).then(() => true, () => false),
  realpath: (dir) => fs.promises.realpath(dir).catch(() => path.resolve(dir)),
  env: async () => ({
    home: os.homedir(),
    ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } : {}),
    ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
  }),
};

/** The tools container's files, as the tools user (a Cloud computer: the engines run there, and own their homes). */
export const toolsNativeIo = (socket: string): NativeIo => {
  const sh = (script: string, args: ReadonlyArray<string>, stdin?: Uint8Array) => runBytes(socket, "/", ["sh", "-c", script, "sh", ...args], stdin);
  return {
    read: async (file) => {
      const out = await sh('[ -L "$1" ] && exit 3; [ -f "$1" ] || exit 3; cat -- "$1"', [file]);
      if (out.code === 3) return undefined;
      if (out.code !== 0) throw new Error(`reading the engine's session file failed: ${out.stderr.trim().slice(0, 200)}`);
      return new Uint8Array(out.stdout);
    },
    list: async (dir) => {
      const out = await sh('[ -d "$1" ] || exit 0; ls -1A -- "$1"', [dir]);
      return out.code === 0 ? out.stdout.toString("utf8").split("\n").filter((n) => n !== "") : [];
    },
    write: async (file, bytes) => {
      const out = await sh(
        'umask 077 && d=$(dirname -- "$1") && mkdir -p -- "$d" && { [ ! -e "$1" ] || { [ -f "$1" ] && [ ! -L "$1" ]; } || exit 4; } && t=$(mktemp "$d/.caveman-session.XXXXXX") && cat > "$t" && mv -f -- "$t" "$1"',
        [file],
        bytes,
      );
      if (out.code === 4) throw new Error(`${file} is not a regular file`);
      if (out.code !== 0) throw new Error(`writing the engine's session file failed: ${out.stderr.trim().slice(0, 200)}`);
    },
    exists: async (file) => (await sh('[ -e "$1" ] || [ -L "$1" ]', [file])).code === 0,
    realpath: async (dir) => {
      const out = await sh('cd -- "$1" 2>/dev/null && pwd -P || printf %s "$1"', [dir]);
      return out.stdout.toString("utf8").trim() || dir;
    },
    env: async () => {
      const out = await sh('printf "%s\\n%s\\n%s" "$HOME" "${CLAUDE_CONFIG_DIR:-}" "${CODEX_HOME:-}"', []);
      const [home = "/", claude = "", codex = ""] = out.stdout.toString("utf8").split("\n");
      return { home, ...(claude ? { claudeConfigDir: claude } : {}), ...(codex ? { codexHome: codex } : {}) };
    },
  };
};
