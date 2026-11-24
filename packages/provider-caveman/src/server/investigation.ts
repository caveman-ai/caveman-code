/**
 * The tools a Caveman engine text run investigates a checkout with (a review guide that reads the change): read_file
 * and grep, confined to the checkout, and git's read commands. Harness tools the app owns (the general loadout has none
 * of its own), each run in this process: files read with the file system, rg (else grep) and git started with their
 * arguments as argv, never through a shell. Nothing that writes: the same set Claude's investigation is allowed
 * (ClaudeTextGeneration.ts).
 *
 * The checkout is the change's head, so its content is the author's: a symlink out of it, `..` and an absolute path
 * elsewhere reach nothing, and `.git` is never read as files (its config can hold a remote's credentials; history is
 * the git tool's).
 *
 * @module provider-caveman/server/investigation
 */
import { execFile } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type * as Harness from "@caveman-ai/harness";

/** Git's commands an investigation may run: each only reads. */
const READ_ONLY_GIT = new Set(["diff", "log", "show"]);

/** As the classic engine capped them: a large file is read a range at a time, a large diff a path at a time. */
const READ_OUTPUT_CAP = 24_000;
const GREP_OUTPUT_CAP = 16_000;
const GREP_MAX_MATCHES = 200;
const GIT_OUTPUT_CAP = 24_000;
/** A file past this is not loaded at all: grep finds the lines worth reading. */
const READ_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DIRECTORY_MAX_ENTRIES = 500;
const SEARCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;

/**
 * Why `args` cannot run here, or undefined when it can. `--output` (and `-o`) make diff, log and show write a file
 * anywhere, so they are refused, as Claude's investigation denies them; `--no-index` makes diff read any two paths on
 * this computer, outside the checkout.
 */
export function refuseGitArgs(args: ReadonlyArray<string>): string | undefined {
  const [command, ...rest] = args;
  if (command === undefined || !READ_ONLY_GIT.has(command)) return "Only git diff, git log and git show run here.";
  if (rest.some((arg) => arg.startsWith("--output") || arg.startsWith("-o"))) return "--output writes a file and is not allowed here.";
  if (rest.includes("--no-index")) return "--no-index reads files outside the checkout and is not allowed here.";
  return undefined;
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** The head of `body` within `cap` bytes, cut at a line, with what was left out said. */
function capped(body: string, cap: number, more: (shownLines: number) => string): string {
  if (Buffer.byteLength(body, "utf8") <= cap) return body;
  const lines = body.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (used + size > cap) break;
    kept.push(line);
    used += size;
  }
  // A first line longer than the cap: its head, cut at a character.
  if (kept.length === 0) kept.push(Buffer.from(lines[0] ?? "", "utf8").subarray(0, cap).toString("utf8").replace(/�$/, ""));
  return `${kept.join("\n")}\n${more(kept.length)}`;
}

const outside = (relative: string) => relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative);

/**
 * `path` in the checkout `root` as its real location, or a refusal: relative paths are from the checkout's root, and
 * what a symlink points to decides where a path is.
 */
async function insideCheckout(root: string, path: string): Promise<{ readonly real: string; readonly relative: string }> {
  const realRoot = await NodeFS.promises.realpath(root);
  let real: string;
  try {
    real = await NodeFS.promises.realpath(NodePath.resolve(realRoot, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${path}: no such file or directory in the checkout.`, { cause: error });
    throw error;
  }
  const relative = NodePath.relative(realRoot, real);
  if (outside(relative)) throw new Error(`${path} is outside the checkout; only files inside it can be read.`);
  if (relative.split(NodePath.sep)[0] === ".git") throw new Error(`${path}: .git is not read here; use the git tool for history.`);
  return { real, relative };
}

const asInteger = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined);

/** read_file: a file's lines, numbered, a range at a time; a directory's entries. */
export const readFileTool = (root: string): Harness.HarnessTool => ({
  name: "read_file",
  label: "read_file",
  description:
    "Read a UTF-8 file in the checkout, read-only. Optional offset (the first line, 1-based) and limit (how many lines) read a range. " +
    "Each returned line starts with its 1-based line number and a tab; those prefixes are not file content. " +
    `Output is capped at ${READ_OUTPUT_CAP} bytes; read on with offset. A directory lists its entries.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "A path in the checkout, relative to its root." },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(_id: string, params: { path?: unknown; offset?: unknown; limit?: unknown }) {
    const path = String(params.path ?? "");
    const { real, relative } = await insideCheckout(root, path);
    const stat = await NodeFS.promises.stat(real);
    if (stat.isDirectory()) {
      const entries = (await NodeFS.promises.readdir(real, { withFileTypes: true }))
        .filter((entry) => !(relative === "" && entry.name === ".git"))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      const shown = entries.slice(0, DIRECTORY_MAX_ENTRIES);
      return text(entries.length === 0 ? `${path} is empty.` : `${shown.join("\n")}${entries.length > shown.length ? `\n[${entries.length - shown.length} more entries]` : ""}`);
    }
    if (!stat.isFile()) throw new Error(`${path} is not a file.`);
    if (stat.size > READ_FILE_MAX_BYTES) throw new Error(`${path} is ${stat.size} bytes, too large to read; grep it for the lines you need.`);
    const data = await NodeFS.promises.readFile(real);
    if (data.subarray(0, 8_000).includes(0)) return text(`${path} is a binary file (${stat.size} bytes); not shown.`);
    const content = data.toString("utf8");
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    const offset = Math.max(1, asInteger(params.offset) ?? 1);
    const limit = Math.max(1, asInteger(params.limit) ?? lines.length);
    if (offset > lines.length) return text(lines.length === 0 ? `${path} is empty.` : `${path} has ${lines.length} lines; offset ${offset} is past its end.`);
    const numbered = lines
      .slice(offset - 1, offset - 1 + limit)
      .map((line, index) => `${offset + index}\t${line}`)
      .join("\n");
    return text(capped(numbered, READ_OUTPUT_CAP, (shown) => `[cut at ${READ_OUTPUT_CAP} bytes: lines ${offset}-${offset + shown - 1} of ${lines.length} shown; read on with offset ${offset + shown}]`));
  },
});

/**
 * The environment rg and git start with: this process's, less what would point git at another repository (GIT_DIR,
 * GIT_WORK_TREE, ...) or give rg flags of its own, and with git told never to prompt or take the index lock.
 */
const toolEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_") && name !== "RIPGREP_CONFIG_PATH") env[name] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" };
};

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  /** null: it ran and exited with a status; else why it did not finish. */
  readonly failure: NodeJS.ErrnoException | null;
  readonly code: number | null;
}

/** `file` with `args` as argv, in `cwd`: no shell ever sees them. */
const run = (file: string, args: ReadonlyArray<string>, cwd: string, timeoutMs: number, signal: AbortSignal | undefined) =>
  new Promise<Ran>((resolve) => {
    execFile(
      file,
      [...args],
      { cwd, env: toolEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...(signal === undefined ? {} : { signal }) },
      (error, stdout, stderr) => {
        const code = typeof (error as { code?: unknown } | null)?.code === "number" ? ((error as { code: number }).code) : error === null ? 0 : null;
        resolve({ stdout: String(stdout), stderr: String(stderr), failure: error !== null && code === null ? (error as NodeJS.ErrnoException) : null, code });
      },
    );
  });

/** The first `max` lines of `body`, saying so when there were more. */
const firstLines = (body: string, max: number) => {
  const lines = body.split("\n");
  return lines.length <= max ? body : `${lines.slice(0, max).join("\n")}\n[matches limited to the first ${max}; narrow the pattern or the path]`;
};

/** grep: a regular expression over the checkout with ripgrep (grep where rg is missing), its matches by file and line. */
export const grepTool = (root: string): Harness.HarnessTool => ({
  name: "grep",
  label: "grep",
  description:
    "Search the checkout for a regular expression with ripgrep (grep fallback), read-only. Optional path narrows it to a file or directory, " +
    `glob to file names (for example "*.ts"). Returns path:line:text, at most ${GREP_MAX_MATCHES} matches, capped at ${GREP_OUTPUT_CAP} bytes.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1 },
      path: { type: "string", description: "A file or directory in the checkout, relative to its root." },
      glob: { type: "string" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(_id: string, params: { pattern?: unknown; path?: unknown; glob?: unknown; ignore_case?: unknown }, signal?: AbortSignal) {
    const pattern = String(params.pattern ?? "");
    if (pattern === "") throw new Error("grep needs a pattern.");
    const realRoot = await NodeFS.promises.realpath(root);
    const scope = params.path === undefined || params.path === "" || params.path === "." ? "." : (await insideCheckout(root, String(params.path))).relative || ".";
    const glob = typeof params.glob === "string" && params.glob !== "" ? params.glob : undefined;
    const ignoreCase = params.ignore_case === true;
    // Hidden files too (.github is part of a change), never .git: its glob last, so a glob of the model's cannot let it back in.
    // Paths with forward slashes on Windows too, as read_file takes them.
    let ran = await run(
      "rg",
      [
        "--no-config", "--line-number", "--no-heading", "--color", "never", "--max-count", String(GREP_MAX_MATCHES), "--hidden", "--path-separator", "/",
        ...(ignoreCase ? ["--ignore-case"] : []),
        ...(glob === undefined ? [] : ["--glob", glob]),
        "--glob", "!.git",
        "--regexp", pattern, "--", scope,
      ],
      realRoot,
      SEARCH_TIMEOUT_MS,
      signal,
    );
    if (ran.failure?.code === "ENOENT") {
      ran = await run(
        "grep",
        ["-rnIE", "-m", String(GREP_MAX_MATCHES), "--exclude-dir=.git", ...(ignoreCase ? ["-i"] : []), ...(glob === undefined ? [] : [`--include=${glob}`]), "-e", pattern, "--", scope],
        realRoot,
        SEARCH_TIMEOUT_MS,
        signal,
      );
      if (ran.failure?.code === "ENOENT") throw new Error("Neither rg nor grep is available on this computer.");
    }
    if (ran.failure !== null) throw new Error(`grep did not finish: ${ran.failure.message}`);
    // Both exit 1 for no match and 2 for an error (a bad expression, a missing path).
    if (ran.code !== 0 && ran.code !== 1) throw new Error(ran.stderr.trim() || `grep failed (exit ${ran.code}).`);
    // Paths from the checkout's root, as read_file takes them (a search of "." prints them under "./").
    const body = ran.stdout.trimEnd().replace(/^\.\//gm, "");
    if (body === "") return text("no matches");
    return text(capped(firstLines(body, GREP_MAX_MATCHES), GREP_OUTPUT_CAP, () => `[cut at ${GREP_OUTPUT_CAP} bytes: narrow the pattern or the path]`));
  },
});

/** git: its read commands in the checkout, argv straight to git, never through a shell. */
export const readOnlyGitTool = (root: string): Harness.HarnessTool => ({
  name: "git",
  label: "git",
  description:
    'Run git diff, git log or git show in the checkout, read-only. Pass the subcommand and each argument as separate strings, for example ["diff", "--stat", "abc123...HEAD"].',
  parameters: {
    type: "object",
    properties: { args: { type: "array", items: { type: "string" }, minItems: 1 } },
    required: ["args"],
    additionalProperties: false,
  },
  async execute(_id: string, params: { args?: unknown }, signal?: AbortSignal) {
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const refused = refuseGitArgs(args);
    if (refused !== undefined) throw new Error(refused);
    const ran = await run("git", ["--no-pager", "-c", "core.quotePath=false", ...args], root, GIT_TIMEOUT_MS, signal);
    if (ran.failure !== null) throw new Error(`git did not finish: ${ran.failure.message}`);
    // A bad revision or path: git's own words, as the model would read them in a terminal.
    const body = ran.code === 0 ? ran.stdout : `${ran.stdout}${ran.stderr || `git exited ${ran.code}`}`;
    return text(body.length > GIT_OUTPUT_CAP ? `${body.slice(0, GIT_OUTPUT_CAP)}\n[cut at ${GIT_OUTPUT_CAP} characters: narrow it to a path]` : body);
  },
});

/** Everything an investigation of the checkout `root` may use. */
export const investigationTools = (root: string): Harness.HarnessTool[] => [readFileTool(root), grepTool(root), readOnlyGitTool(root)];
