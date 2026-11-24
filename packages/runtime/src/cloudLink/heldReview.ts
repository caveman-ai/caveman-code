// What a return from Cloud held back on This Mac, as the person reviews it before applying it (AUDIT-W4-EARLY A-8):
// each file this Mac's version against Cloud's, as a bounded unified diff, and the commands Cloud's version would have
// an agent, a tool or git run here that this Mac's does not. Nothing here is ever run or followed: links are shown by
// their target, Cloud's bytes are read from the held commit, and the diff is git's, made between two temporary files.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { HELD_DIFF_MAX, HELD_DIFFS_MAX, HELD_RUNS_MAX, type HeldFile } from "@caveman-app/session-protocol";
import { parse as parseToml } from "smol-toml";
import { parseAllDocuments } from "yaml";

import { secretShapedPath } from "../session-protocol/lifecycle.ts";

/** One side of a held-back file: a file's bytes (`executable`: git runs it as a hook, a tool as a script), a link's or submodule's target, a folder, none, or past what a review reads. */
export type HeldSide =
  | { readonly kind: "file"; readonly bytes: Buffer; readonly executable: boolean }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "submodule"; readonly commit: string }
  | { readonly kind: "folder" }
  | { readonly kind: "none" }
  | { readonly kind: "too_big"; readonly size: number };

/** The most of one side a review reads. */
export const HELD_READ_MAX = 1024 * 1024;
/**
 * The most of a YAML or TOML side a review parses. Their parsers are not linear in what Cloud can write (yaml looks each
 * alias up among every anchor before it; smol-toml looks for a dot from each key to the end of the text, seconds for a
 * 1 MiB config.toml), and they run on the runtime's own thread. Past this a side is shown, but its commands are not
 * all read, so it is not applied from the review. Real hook and tool configs are a few KiB.
 */
export const HELD_PARSE_MAX = 32 * 1024;
/**
 * The most characters of commands one file's review names (as many as HELD_RUNS_MAX commands of 300). A command is
 * named whole or not at all: cut, its harmless start would stand for what it runs.
 */
const RUNS_MAX_CHARS = 6_000;

const binary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);
const textOf = (side: HeldSide) =>
  side.kind === "file" && !binary(side.bytes) ? side.bytes.toString("utf8") : side.kind === "link" ? `link -> ${side.target}\n` : side.kind === "submodule" ? `submodule at ${side.commit}\n` : undefined;

/** Keys of a JSON settings file whose value is a command something runs: hooks, MCP servers, a status line, Claude's helpers, a dev container's lifecycle commands. */
const COMMAND_KEY = /(command|helper)$|^(awsAuthRefresh|awsCredentialExport)$/i;
/** Keys of TOML or YAML config whose value is a command or its words (Codex MCP servers, pre-commit, lefthook). */
const CONFIG_KEY = /^(command|run|entry|args)$/i;
/** A line's key, bare or quoted (a list item's too), and the rest of the line after its `:` or `=`; each part matches one way, so a long line is one pass. */
const KEY_LINE = /^\s*(?:-\s*)?(?:"([^"\\]*)"|([A-Za-z_][\w-]*))\s*[:=]([^\n]*)/;

/** A script's lines as its shell reads them, blank lines and comments left out, a NUL shown as ␀. */
const scriptLines = (text: string) =>
  text
    .replace(/\0/g, "␀")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/**
 * JSONC (VS Code's tasks and launch files, a dev container's) as JSON: comments out and a comma before a closing
 * bracket dropped, never inside a string ("/*" in a string is the string's). One pass: Cloud wrote the text, and a
 * backtracking pattern over a file of unclosed comments stalls the runtime.
 */
const jsonOfJsonc = (text: string): string => {
  let out = "";
  let comma = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") out += c;
    else {
      // A comma waits for what follows it.
      if (comma && c !== "}" && c !== "]") out += ",";
      comma = c === ",";
      if (c === '"') {
        let end = i + 1;
        while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        out += text.slice(i, end + 1);
        i = end;
      } else if (!comma) out += c;
    }
  }
  return comma ? `${out},` : out;
};

/** A word of a JSON command as its line shows it: a string as itself, anything else (VS Code's `{value, quoting}`) as JSON. */
const jsonWord = (word: unknown) => (typeof word === "string" ? word : JSON.stringify(word));

/** A command written as a string, a number or a list of words, with `args` after it; undefined for anything else. */
const commandLine = (item: unknown, args: ReadonlyArray<unknown> = []) => {
  if (typeof item !== "string" && typeof item !== "number" && !Array.isArray(item)) return undefined;
  const words = Array.isArray(item) ? item : [item];
  return words.length > 0 ? [...words, ...args].map(jsonWord).join(" ") : undefined;
};

/**
 * Every command a JSON value names, as written: a string or list under a command key, `command` with its `args`, and
 * each value of an object under a command key (a dev container runs every one, in parallel).
 */
const jsonCommands = (value: unknown, out: Array<string>) => {
  if (Array.isArray(value)) {
    for (const item of value) jsonCommands(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(object)) {
    if (!COMMAND_KEY.test(key)) jsonCommands(item, out);
    else if (typeof item === "string" || typeof item === "number" || Array.isArray(item)) {
      const line = commandLine(item, key === "command" && Array.isArray(object.args) ? object.args : []);
      if (line !== undefined) out.push(line);
    } else if (item !== null && typeof item === "object")
      for (const each of Object.values(item)) {
        const line = commandLine(each);
        if (line !== undefined) out.push(line);
        else jsonCommands(each, out);
      }
  }
};

/** A plain mapping, as JSON, YAML and TOML give one. */
const isMapping = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A YAML or TOML scalar as the text its tool runs: a string, a number, YAML's !!binary as the text it encodes (lefthook's reader decodes it so). */
const scalarText = (value: unknown) =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;

/**
 * Every command a YAML or TOML value names: a string under a command key line by line (a `run: |` script), a list on
 * one line as such a list is written (`["sh", "-c", "make"]`), however many lines it took; YAML's !!omap and !!set are
 * looked into as the mapping and list they are. False when a command holds what the review cannot name (a date, a list
 * of lists): what would run there is unknown.
 */
const configCommands = (value: unknown, out: Array<string>): boolean => {
  let named = true;
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) named = configCommands(item, out) && named;
    return named;
  }
  const entries = value instanceof Map ? [...value].map(([key, item]) => [String(key), item] as const) : isMapping(value) ? Object.entries(value) : [];
  for (const [key, item] of entries) named = (CONFIG_KEY.test(key) || COMMAND_KEY.test(key) ? configCommand(item, out) : configCommands(item, out)) && named;
  return named;
};

/** One word of a YAML or TOML command list as such a list is written: text quoted, anything else bare; undefined for what the review cannot name. */
const configWord = (word: unknown) =>
  typeof word === "string" || word instanceof Uint8Array ? JSON.stringify(scalarText(word)) : typeof word === "number" || typeof word === "bigint" || typeof word === "boolean" || word === null ? String(word) : undefined;

/** The command one value under a command key names (configCommands); false when it is none the review can name. */
const configCommand = (item: unknown, out: Array<string>): boolean => {
  const text = scalarText(item);
  if (text !== undefined) out.push(...scriptLines(text));
  else if (Array.isArray(item) || item instanceof Set) {
    const words = [...item].map(configWord);
    if (words.includes(undefined)) return false;
    out.push(`[${words.join(", ")}]`);
  } else if (item instanceof Map || isMapping(item)) return configCommands(item, out);
  // No value, or a yes or no, names nothing to run.
  else return item === null || item === undefined || typeof item === "boolean";
  return true;
};

/**
 * The commands a JSON(C), YAML or TOML file names, read as its tool reads it; undefined when it does not parse as one
 * (yaml past its alias limit included), or names a command the review cannot.
 */
const parsedCommands = (file: string, text: string): ReadonlyArray<string> | undefined => {
  const out: Array<string> = [];
  try {
    if (/\.jsonc?$/i.test(file)) {
      const json = jsonOfJsonc(text);
      // A file that is empty, or only comments, names nothing: VS Code reads it as `{}`.
      if (json.trim() !== "") jsonCommands(JSON.parse(json), out);
    } else if (/\.ya?ml$/i.test(file)) {
      // A key given twice is read as its last, as the tools that accept one do. Checking each key against every one
      // before it took minutes for a 256 KiB file.
      for (const doc of parseAllDocuments(text, { uniqueKeys: false })) if (doc.errors.length > 0 || !configCommands(doc.toJS(), out)) return undefined;
    } else if (!/\.toml$/i.test(file) || !configCommands(parseToml(text), out)) return undefined;
  } catch {
    return undefined;
  }
  return out;
};

/** The value of each line whose key names a command, as written; a YAML block (`run: |`) by the lines indented under it. */
const lineCommands = (text: string) => {
  const lines = text.split(/\r?\n/);
  const out: Array<string> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = KEY_LINE.exec(lines[i]!);
    const key = match?.[1] ?? match?.[2];
    if (key === undefined || (!CONFIG_KEY.test(key) && !COMMAND_KEY.test(key))) continue;
    const value = match![3]!.trim().replace(/^(["'])(.*)\1,?$/, "$2");
    if (/^[|>][-+1-9]*(\s+#.*)?$/.test(value)) {
      const indent = lines[i]!.length - lines[i]!.trimStart().length;
      for (; i + 1 < lines.length && (lines[i + 1]!.trim() === "" || lines[i + 1]!.length - lines[i + 1]!.trimStart().length > indent); i++) out.push(...scriptLines(lines[i + 1]!));
    } else if (value !== "") out.push(value);
  }
  return out;
};

/** Whether git or a tool runs the whole file as a script: a hook (in a hooks folder, husky's), direnv's .envrc, or an executable one. */
const script = (file: string, side: HeldSide, hooksDir: string | undefined) => {
  const parts = file.split("/");
  const base = parts.at(-1) ?? "";
  return (
    base === ".envrc" ||
    parts.includes(".husky") ||
    parts.slice(0, -1).some((part) => /^\.git[-_]?hooks$/i.test(part)) ||
    (hooksDir !== undefined && file.startsWith(`${hooksDir}/`)) ||
    (side.kind === "file" && side.executable)
  );
};

/** A config file its tool parses: JSON (JSONC too), YAML or TOML. */
const PARSED = /\.(jsonc?|ya?ml|toml)$/i;

/** A file whose lines are all a review needs to read: Markdown an agent reads as text, a file shaped like a secret (data), git's ignore list. */
const readByLines = (file: string) => /\.(md|mdc|markdown)$/i.test(file) || secretShapedPath(file) || /(^|\/)\.git(ignore|keep)$/.test(file);

/**
 * The commands one side of a held-back file would have something on This Mac run, as written, and whether they are all
 * of them. A hook or an executable file is a script whatever bytes it holds: a NUL in a comment makes it "binary" to a
 * diff, never to the shell that runs the line after it (F-4), so its lines are read with any NUL shown as ␀. JSON
 * (JSONC too), YAML and TOML are read as their tools read them, a value over many lines included; Markdown, secrets and
 * ignore lists by their lines whose key names a command. A config that does not parse, names a command the review
 * cannot, or is past HELD_PARSE_MAX, and a file of any other format (a JetBrains file watcher's XML, a hook script its
 * interpreter runs), is read by its lines too, and is not `whole`: Cloud writes it, and its tool may run what they miss.
 */
function readCommands(file: string, side: HeldSide, hooksDir: string | undefined): { readonly commands: ReadonlyArray<string>; readonly whole: boolean } {
  if (side.kind !== "file") return { commands: [], whole: true };
  if (script(file, side, hooksDir)) return { commands: scriptLines(side.bytes.toString("utf8")), whole: true };
  const text = textOf(side);
  if (text === undefined) return { commands: [], whole: true };
  if (!PARSED.test(file)) return { commands: lineCommands(text), whole: readByLines(file) };
  const parsed = side.bytes.length > HELD_PARSE_MAX && /\.(ya?ml|toml)$/i.test(file) ? undefined : parsedCommands(file, text);
  return parsed !== undefined ? { commands: parsed, whole: true } : { commands: lineCommands(text), whole: false };
}

/** The commands one side of a held-back file would have something on This Mac run, as written (readCommands). */
export function commandsOf(file: string, side: HeldSide, hooksDir?: string): ReadonlyArray<string> {
  return readCommands(file, side, hooksDir).commands;
}

/**
 * What Cloud's version would run that this Mac's does not, in Cloud's order: the first HELD_RUNS_MAX, each whole, as
 * many as fit in RUNS_MAX_CHARS, and how many more. `unread` when Cloud's version is not read whole: there may be more
 * than its lines show. A version of this Mac's read only by its lines is no measure of what Cloud's, read whole, adds:
 * then everything Cloud's would run counts as new.
 */
export function newRuns(file: string, mine: HeldSide, cloud: HeldSide, hooksDir?: string): { readonly runs: ReadonlyArray<string>; readonly more: number; readonly unread?: true } {
  const ours = readCommands(file, mine, hooksDir);
  const theirs = readCommands(file, cloud, hooksDir);
  const had = new Set(ours.whole || !theirs.whole ? ours.commands : []);
  const added = [...new Set(theirs.commands)].filter((command) => !had.has(command));
  const runs: Array<string> = [];
  let room = RUNS_MAX_CHARS;
  for (const command of added) {
    if (runs.length === HELD_RUNS_MAX || command.length > room) break;
    runs.push(command);
    room -= command.length;
  }
  return {
    runs,
    more: added.length - runs.length,
    ...(theirs.whole ? {} : { unread: true as const }),
  };
}

/** What Cloud did to the file, against this Mac's version. */
export function changeOf(mine: HeldSide, cloud: HeldSide): HeldFile["change"] {
  if (mine.kind === "too_big" || cloud.kind === "too_big") return "too_big";
  if (mine.kind === "link" || cloud.kind === "link") return "link";
  if (mine.kind === "submodule" || cloud.kind === "submodule") return "submodule";
  if ((mine.kind === "file" && binary(mine.bytes)) || (cloud.kind === "file" && binary(cloud.bytes))) return "binary";
  if (mine.kind === "none" || mine.kind === "folder") return "added";
  if (cloud.kind === "none" || cloud.kind === "folder") return "removed";
  return "changed";
}

/** A side of `rel` in `worktree` as it stands, never followed through a link (a link on its way reads as none). */
export function macSide(worktree: string, rel: string): HeldSide {
  const parts = rel.split("/");
  let dir = worktree;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st === undefined || !st.isDirectory()) return { kind: "none" };
  }
  const full = path.join(dir, parts.at(-1)!);
  const st = fs.lstatSync(full, { throwIfNoEntry: false });
  if (st === undefined) return { kind: "none" };
  if (st.isSymbolicLink()) return { kind: "link", target: fs.readlinkSync(full) };
  if (st.isDirectory()) return { kind: "folder" };
  if (!st.isFile()) return { kind: "none" };
  if (st.size > HELD_READ_MAX) return { kind: "too_big", size: st.size };
  return { kind: "file", bytes: fs.readFileSync(full), executable: (st.mode & 0o111) !== 0 };
}

/** git's unified diff of two texts, labelled this-mac/<rel> and cloud/<rel>; `run` runs git in a folder. */
async function unified(rel: string, mine: string | undefined, cloud: string | undefined, run: (cwd: string, args: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly stdout: Buffer }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-held-"));
  try {
    const place = (side: string, text: string | undefined) => {
      if (text === undefined) return "/dev/null";
      const at = path.join(side, rel);
      fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true });
      fs.writeFileSync(path.join(dir, at), text);
      return at;
    };
    const out = await run(dir, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-prefix", "-U3", "--", place("this-mac", mine), place("cloud", cloud)]);
    return out.code === 0 || out.code === 1 ? out.stdout.toString("utf8") : "";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Each held-back file as the person reviews it: what changed, the diff (each at most HELD_DIFF_MAX, all of them at most
 * HELD_DIFFS_MAX: past that a file says `truncated`), and what Cloud's version would run here.
 */
export async function heldReview(
  files: ReadonlyArray<{ readonly path: string; readonly mine: HeldSide; readonly cloud: HeldSide }>,
  run: (cwd: string, args: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly stdout: Buffer }>,
  hooksDir?: string,
): Promise<ReadonlyArray<HeldFile>> {
  let left = HELD_DIFFS_MAX;
  const out: Array<HeldFile> = [];
  for (const file of files) {
    const change = changeOf(file.mine, file.cloud);
    const { runs, more, unread } = newRuns(file.path, file.mine, file.cloud, hooksDir);
    const whole = change === "binary" || change === "too_big" ? "" : await unified(file.path, file.mine.kind === "none" || file.mine.kind === "folder" ? undefined : textOf(file.mine), file.cloud.kind === "none" || file.cloud.kind === "folder" ? undefined : textOf(file.cloud), run);
    const room = Math.min(HELD_DIFF_MAX, left);
    const bytes = Buffer.from(whole, "utf8");
    const cut = bytes.length > room;
    const diff = cut ? bytes.subarray(0, room).toString("utf8").replace(/�$/, "") : whole;
    left -= Buffer.byteLength(diff, "utf8");
    out.push({ path: file.path, change, diff, ...(cut ? { truncated: true } : {}), ...(runs.length > 0 ? { runs } : {}), ...(more > 0 ? { more_runs: more } : {}), ...(unread ? { runs_unread: true } : {}), ...(secretShapedPath(file.path) ? { secret: true } : {}) });
  }
  return out;
}
