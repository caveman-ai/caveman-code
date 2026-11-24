// One-click install of `caveman-code mcp` into the MCP clients on this computer (Settings > Caveman MCP,
// outside_agent.install; docs/ §1): whether each client is here, whether its
// config holds the `caveman-code` server, and adding it there. Claude Code adds it through its own CLI, and VS Code
// through its own except on Windows; Codex, Grok Build and Cursor, and VS Code on Windows, get it written into their
// config file, everything else in the file kept.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { withoutRuntimeEnv } from "@caveman-app/engine-core/server/instanceEnvironment";
import type { McpClientId, McpClientStatus } from "@caveman-app/session-protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution, type ResolvedSpawnCommand } from "@caveman-app/shared/shell";
import * as Effect from "effect/Effect";

import { withoutParentClaudeSession } from "../provider/Drivers/ClaudeHome.ts";
import { ProtocolError } from "./handlers.ts";

/** The server's name in every client's config. */
export const SERVER = "caveman-code";
/** Every client outside_agent.install knows, in McpClientId's order. */
export const MCP_CLIENTS: ReadonlyArray<McpClientId> = ["claude-code", "codex", "grok", "cursor", "vscode", "grok-bot"];
const LABEL: Record<McpClientId, string> = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok Build", cursor: "Cursor", vscode: "VS Code", "grok-bot": "Grok Bot" };
/**
 * bot (Anysphere's desktop bot app, `com.anysphere.sand`) keeps its MCP servers in the person's account, behind
 * its own sign-in, which Caveman Code never touches. So its one click opens bot where custom MCP servers are added
 * (its `grokbot://app/v1/...` links; `plugin/add` takes only a marketplace plugin's id), and the page copies the server
 * to paste there. It runs a local stdio server through its local exec daemon.
 */
export const GROK_BOT_LINK = "grokbot://app/v1/marketplace?tab=plugins";
/** A client's CLI that hasn't answered by then is stopped, and the install fails saying so. */
const TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 5_000;

/** What the clients are looked up in: this computer, or a test's temp home and fake binaries. */
export interface Host {
  /** The person's home (os.homedir()): every client's config lives under it. */
  readonly home: string;
  /** Where a client's binary is looked for: the runtime's PATH, which it read from the login shell at start. */
  readonly path: string;
  /** The clients' CLIs run with it: the host's own, HOME the person's, never the runtime's variables. */
  readonly env: NodeJS.ProcessEnv;
  /** Where macOS apps are installed. */
  readonly applications: string;
  readonly platform: NodeJS.Platform;
 /** What opens a link in its app (macOS `open`): bot one click. */
  readonly opener?: string;
}

export const thisHost = (): Host => {
  const home = os.homedir();
  return {
    home,
    path: process.env.PATH ?? "",
    env: { ...withoutRuntimeEnv(withoutParentClaudeSession(process.env)), HOME: home },
    applications: "/Applications",
    platform: process.platform,
  };
};

/** Why an install didn't happen, in words the page shows as they are. */
export class InstallRefused extends Error {}
/** Why a config file can't be rewritten, said after its path: "isn't plain JSON (a comment, or a typo)". */
export class ConfigRefused extends Error {}

// ------------------------------------------------------------------ the host

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/**
 * The executable `command` names, through shared/shell's resolver (the one spawns use): a full path as it is, a bare
 * name the first on the host's PATH, its relative entries skipped. On Windows only a file with one of PATHEXT's
 * extensions, which it adds: `claude` is npm's `claude.cmd` or a native `claude.exe`, `code` is `code.cmd`, never the
 * extensionless sh scripts beside them.
 */
export function which(command: string, host: Host): string | undefined {
  const { delimiter, isAbsolute } = host.platform === "win32" ? path.win32 : path.posix;
  const searchPath = host.path
    .split(delimiter)
    .filter((dir) => isAbsolute(dir.trim().replace(/^"(.*)"$/, "$1")))
    .join(delimiter);
  return SpawnExecutableResolution.defaultValue()(command, host.platform, { ...host.env, PATH: searchPath });
}

interface Ran {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How a client's CLI (`file`, a full path) starts with `args`, through shared/shell's resolveSpawnCommand for the
 * host's platform. Off Windows: itself with the argv. On Windows an `.exe` the same; an npm shim that only starts an
 * `.exe` (Claude Code's `claude.cmd`) is passed for that `.exe`; any other `.cmd` runs through cmd.exe, which alone
 * can, as one line with every argument escaped.
 */
export const spawnCommand = (file: string, args: ReadonlyArray<string>, host: Host): Promise<ResolvedSpawnCommand> =>
  Effect.runPromise(resolveSpawnCommand(file, args, { env: host.env, bypassNpmShim: true }).pipe(Effect.provideService(HostProcess.Platform, host.platform)));

/** A client's CLI (spawnCommand: an argv, never a shell but Windows' for a `.cmd`), from the home, stopped after `timeoutMs`. */
const run = async (file: string, args: ReadonlyArray<string>, host: Host, timeoutMs = TIMEOUT_MS): Promise<Ran> => {
  const spawn = await spawnCommand(file, args, host);
  return new Promise((resolve) => {
    const child = execFile(
      spawn.command,
      [...spawn.args],
      { shell: spawn.shell, cwd: host.home, env: host.env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ ok: error === null, timedOut: error !== null && (error as { killed?: boolean }).killed === true, stdout, stderr }),
    );
    child.stdin?.end();
  });
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A failed CLI in one line: what it printed first on stderr (else stdout), else that it failed. */
const failure = (what: string, ran: Ran): string => {
  if (ran.timedOut) return `${what} didn't finish in ${TIMEOUT_MS / 1000} s.`;
  const line = `${ran.stderr}\n${ran.stdout}`
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? `${what} failed: ${line}` : `${what} failed.`;
};

const here = (host: Host) => (host.platform === "darwin" ? "this Mac" : "this computer");

// ------------------------------------------------------------- the clients

const claudeJson = (host: Host) => path.join(host.env.CLAUDE_CONFIG_DIR?.trim() || host.home, ".claude.json");
/** Codex's home: $CODEX_HOME when the person set one, else ~/.codex. */
const codexHome = (host: Host) => host.env.CODEX_HOME?.trim() || path.join(host.home, ".codex");
const grokConfig = (host: Host) => path.join(host.home, ".grok", "config.toml");
const cursorMcp = (host: Host) => path.join(host.home, ".cursor", "mcp.json");
/** Windows' roaming app data (%APPDATA%), where VS Code keeps its settings. */
const appData = (host: Host) => host.env.APPDATA?.trim() || path.join(host.home, "AppData", "Roaming");
/** VS Code's own folder: its User folder holds its settings, mcp.json among them. */
const vscodeData = (host: Host) =>
  host.platform === "darwin"
    ? path.join(host.home, "Library", "Application Support", "Code")
    : host.platform === "win32"
      ? path.join(appData(host), "Code")
      : path.join(host.home, ".config", "Code");
const vscodeMcp = (host: Host) => path.join(vscodeData(host), "User", "mcp.json");

/** `claude` on the PATH, else where Claude Code's own installers put it (on Windows the native one's `claude.exe`). */
function claudeBin(host: Host): string | undefined {
  for (const command of ["claude", path.join(host.home, ".local", "bin", "claude"), path.join(host.home, ".claude", "local", "claude")]) {
    const found = which(command, host);
    if (found) return found;
  }
  return undefined;
}

/** `code` on the PATH, else the one inside the VS Code app. */
function codeBin(host: Host): string | undefined {
  const found = which("code", host);
  if (found || host.platform !== "darwin") return found;
  return which(path.join(host.applications, "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"), host);
}

/** A `grok` that answers `--version`: another tool may go by the name. Kept per binary until it changes. */
const grokAnswers = new Map<string, boolean>();
async function grokBin(host: Host): Promise<string | undefined> {
  const found = which("grok", host);
  if (!found) return undefined;
  const stat = await fs.stat(found).catch(() => undefined);
  const key = `${found}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
  let ok = grokAnswers.get(key);
  if (ok === undefined) {
    ok = (await run(found, ["--version"], host, VERSION_TIMEOUT_MS)).ok;
    grokAnswers.set(key, ok);
  }
  return ok ? found : undefined;
}

/** Whether a client is on this computer. */
async function found(id: McpClientId, host: Host): Promise<boolean> {
  switch (id) {
    case "claude-code":
      return claudeBin(host) !== undefined;
    case "codex":
      return which("codex", host) !== undefined || (await exists(codexHome(host)));
    case "grok":
      return (await grokBin(host)) !== undefined || (await exists(path.join(host.home, ".grok")));
    case "cursor":
      return (await exists(path.join(host.home, ".cursor"))) || (host.platform === "darwin" && (await exists(path.join(host.applications, "Cursor.app"))));
    case "vscode":
      // On Windows its folder too: Caveman Code writes there, and `code` is on the PATH only if the installer put it.
      return codeBin(host) !== undefined || (host.platform === "win32" && (await exists(vscodeData(host))));
    case "grok-bot":
      return (
        (await exists(path.join(host.home, ".grokbot"))) ||
        (host.platform === "darwin" && ((await exists(path.join(host.applications, "Grok Bot.app"))) || (await exists(path.join(host.home, "Applications", "Grok Bot.app")))))
      );
  }
}

/** What a config file says, kept until the file changes: ~/.claude.json runs to megabytes, and the list is read often. */
const seen = new Map<string, { readonly stamp: string; readonly holds: boolean }>();
async function holds(file: string, test: (text: string | undefined) => boolean): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat === undefined) return test(undefined);
  const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const known = seen.get(file);
  if (known?.stamp === stamp) return known.holds;
  const answer = test(await fs.readFile(file, "utf8"));
  seen.set(file, { stamp, holds: answer });
  return answer;
}

/** Whether a client's config already holds the server. A config that can't be read holds nothing. */
async function installed(id: McpClientId, host: Host): Promise<boolean> {
  const json = (key: string) => (text: string | undefined) => jsonHasServer(text, key, SERVER);
  const toml = (text: string | undefined) => tomlHasServer(text ?? "", SERVER);
  try {
    switch (id) {
      case "claude-code":
        return await holds(claudeJson(host), json("mcpServers"));
      case "codex":
        return await holds(path.join(codexHome(host), "config.toml"), toml);
      case "grok":
        return await holds(grokConfig(host), toml);
      case "cursor":
        return await holds(cursorMcp(host), json("mcpServers"));
      case "vscode":
        return await holds(vscodeMcp(host), json("servers"));
      case "grok-bot":
 // In the person's bot account: the page tells by bot having connected.
        return false;
    }
  } catch {
    return false;
  }
}

export const status = async (id: McpClientId, host: Host = thisHost()): Promise<McpClientStatus> => {
  const [isFound, isInstalled] = await Promise.all([found(id, host), installed(id, host)]);
  // A config that holds it means the client was here, whatever the PATH says now.
  return { id, found: isFound || isInstalled, installed: isInstalled };
};

/** Every client's status, for outside_agent.list. */
export const detect = (host: Host = thisHost()): Promise<ReadonlyArray<McpClientStatus>> => Promise.all(MCP_CLIENTS.map((id) => status(id, host)));

/**
 * Adds the server (`command`: connectCommand's argv) to one client, replacing one already there under the name, and
 * answers its status after. Throws InstallRefused with the reason the page shows.
 */
export async function install(id: McpClientId, command: ReadonlyArray<string>, host: Host = thisHost()): Promise<McpClientStatus> {
  const [bin, ...args] = command;
  if (bin === undefined) throw new InstallRefused("Caveman Code doesn't know the command that starts it yet.");
  switch (id) {
    case "claude-code": {
      const claude = claudeBin(host);
      if (claude === undefined) throw new InstallRefused(`Claude Code isn't on ${here(host)}'s PATH.`);
      // `add` refuses a name that is already there: an earlier install, maybe with an old path.
      await run(claude, ["mcp", "remove", "--scope", "user", SERVER], host);
      const added = await run(claude, ["mcp", "add", "--scope", "user", SERVER, "--", ...command], host);
      if (!added.ok) throw new InstallRefused(failure("claude mcp add", added));
      break;
    }
    case "vscode": {
      const server = { type: "stdio", command: bin, args };
      if (host.platform === "win32") {
        // `code` is `code.cmd` there, and cmd.exe mangles a JSON argument's quotes, so its user mcp.json gets the
        // server written as `code --add-mcp` would write it. A link out of %APPDATA% is refused.
        if (!(await found(id, host))) throw new InstallRefused(`VS Code isn't on ${here(host)}.`);
        await rewrite(vscodeMcp(host), appData(host), host, (text) => upsertJsonServer(text, "servers", SERVER, server));
        break;
      }
      const code = codeBin(host);
      if (code === undefined) throw new InstallRefused(`VS Code isn't on ${here(host)}.`);
      const added = await run(code, ["--add-mcp", JSON.stringify({ name: SERVER, ...server })], host);
      if (!added.ok) throw new InstallRefused(failure("code --add-mcp", added));
      break;
    }
    case "codex": {
      // Codex asks before every MCP call otherwise, and `codex exec` can't ask at all: the level the person gives Codex
      // in Caveman Code is the boundary.
      const dir = codexHome(host);
      await rewrite(path.join(dir, "config.toml"), host.env.CODEX_HOME?.trim() ? dir : host.home, host, (text) =>
        upsertTomlServer(text ?? "", SERVER, tomlServer(command, { default_tools_approval_mode: "approve" })),
      );
      break;
    }
    case "grok":
      await rewrite(grokConfig(host), host.home, host, (text) => upsertTomlServer(text ?? "", SERVER, tomlServer(command)));
      break;
    case "cursor":
      await rewrite(cursorMcp(host), host.home, host, (text) => upsertJsonServer(text, "mcpServers", SERVER, { command: bin, args }));
      break;
    case "grok-bot": {
      if (host.platform !== "darwin" || !(await found("grok-bot", host))) throw new InstallRefused(`Grok Bot isn't on ${here(host)}.`);
      const opened = await run(host.opener ?? "/usr/bin/open", [GROK_BOT_LINK], host);
      if (!opened.ok) throw new InstallRefused(failure("open Grok Bot", opened));
      break;
    }
  }
  return status(id, host);
}

/**
 * outside_agent.install for a connection: only the person on this computer's own screen; a refusal or a failure is
 * `unavailable`, its message the page's. The caller says the list changed.
 */
export const installFor = (principal: string, id: McpClientId, command: ReadonlyArray<string>, host?: Host): Effect.Effect<McpClientStatus, ProtocolError> =>
  principal !== "local"
    ? Effect.fail(new ProtocolError({ reason: "forbidden", message: "MCP clients are set up only on this computer's own screen." }))
    : Effect.tryPromise({
        try: () => install(id, command, host),
        catch: (error) =>
          new ProtocolError({
            reason: "unavailable",
            message: error instanceof InstallRefused ? error.message : `Couldn't add Caveman Code to ${LABEL[id]}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });

// ------------------------------------------------------------ config files

/** One rewrite at a time per file: two clicks never interleave their read and write. */
const writing = new Map<string, Promise<unknown>>();

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const tilde = (file: string, host: Host) => (inside(file, host.home) ? path.join("~", path.relative(host.home, file)) : file);

/**
 * Reads `file`, rewrites it with `change`, and puts it back atomically: a temp file in the same folder renamed over it,
 * with the mode it had (0600 when new). Never through a link: a config that is a symlink, or a folder that resolves
 * outside `root` (the home, or the CODEX_HOME the person set), is refused and nothing is written.
 */
async function rewrite(file: string, root: string, host: Host, change: (text: string | undefined) => string): Promise<void> {
  const refused = (what: string, reason: string) => new InstallRefused(`${tilde(what, host)} ${reason}, so Caveman Code didn't change it.`);
  const previous = writing.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const dir = path.dirname(file);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const [realDir, realRoot] = await Promise.all([fs.realpath(dir), fs.realpath(root).catch(() => root)]);
      if (!inside(realDir, realRoot)) throw refused(dir, "leads outside your home folder");
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw refused(file, "is a link to another file");
      if (stat && !stat.isFile()) throw refused(file, "isn't a file");
      const mode = stat ? stat.mode & 0o777 : 0o600;
      let contents: string;
      try {
        contents = change(stat ? await fs.readFile(file, "utf8") : undefined);
      } catch (error) {
        throw error instanceof ConfigRefused ? refused(file, error.message) : error;
      }
      const temp = path.join(dir, `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
      try {
        await fs.writeFile(temp, contents, { mode, flag: "wx" });
        await fs.chmod(temp, mode);
        await fs.rename(temp, file);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
    });
  writing.set(file, next);
  try {
    await next;
  } finally {
    if (writing.get(file) === next) writing.delete(file);
  }
}

// -------------------------------------------------------------------- JSON

/** JSON with comments and trailing commas (VS Code's mcp.json): parsed, or undefined. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Comments or trailing commas: strip them below.
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      out += " ";
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a client's JSON config (comments allowed) holds `name` under `key` ("mcpServers", VS Code's "servers"). */
export function jsonHasServer(text: string | undefined, key: string, name: string): boolean {
  if (text === undefined) return false;
  const root = parseJsonc(text);
  return isObject(root) && isObject(root[key]) && Object.hasOwn(root[key], name);
}

/** The indent a JSON file uses, from its first indented line; two spaces when it has none. */
const indentOf = (text: string): string | number => /\n([ \t]+)\S/.exec(text)?.[1] ?? 2;

/**
 * A JSON config with `entry` as `root[key][name]`, replacing what was there under the name; every other key kept in
 * its place. A missing or empty file starts as `{}`. A file that isn't plain JSON (comments too) is refused: rewriting
 * it would lose what it holds.
 */
export function upsertJsonServer(text: string | undefined, key: string, name: string, entry: Record<string, unknown>): string {
  const blank = text === undefined || text.trim() === "";
  let root: unknown = {};
  if (!blank) {
    try {
      root = JSON.parse(text);
    } catch {
      throw new ConfigRefused("isn't plain JSON (a comment, or a typo)");
    }
  }
  if (!isObject(root)) throw new ConfigRefused("isn't a JSON object");
  const servers = root[key] ?? {};
  if (!isObject(servers)) throw new ConfigRefused(`has a "${key}" that isn't an object`);
  const next = { ...root, [key]: { ...servers, [name]: entry } };
  const eol = !blank && text.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(next, null, blank ? 2 : indentOf(text)).replaceAll("\n", eol) + eol;
}

// -------------------------------------------------------------------- TOML

/** A TOML basic string: JSON's escapes, plus DEL, which TOML wants escaped too. */
export const tomlString = (value: string) => JSON.stringify(value).replaceAll("\u007f", "\\u007F");

/** The server's table: `[mcp_servers.<name>]` with its command, args and any extra string keys. */
export function tomlServer(command: ReadonlyArray<string>, extra: Readonly<Record<string, string>> = {}): ReadonlyArray<string> {
  const [bin = "", ...args] = command;
  return [`command = ${tomlString(bin)}`, `args = [${args.map(tomlString).join(", ")}]`, ...Object.entries(extra).map(([k, v]) => `${k} = ${tomlString(v)}`)];
}

/** A dotted TOML key (`mcp_servers."caveman-code".env`) as its parts; undefined when it isn't one. */
function keyPath(source: string): ReadonlyArray<string> | undefined {
  const parts: Array<string> = [];
  let i = 0;
  const space = () => {
    while (source[i] === " " || source[i] === "\t") i++;
  };
  for (;;) {
    space();
    const c = source[i];
    if (c === '"') {
      let j = i + 1;
      for (; j < source.length && source[j] !== '"'; j++) if (source[j] === "\\") j++;
      if (j >= source.length) return undefined;
      try {
        parts.push(JSON.parse(source.slice(i, j + 1)) as string);
      } catch {
        parts.push(source.slice(i + 1, j));
      }
      i = j + 1;
    } else if (c === "'") {
      const j = source.indexOf("'", i + 1);
      if (j === -1) return undefined;
      parts.push(source.slice(i + 1, j));
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(i));
      if (!bare) return undefined;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    space();
    if (source[i] !== ".") break;
    i++;
  }
  return i === source.length ? parts : undefined;
}

interface TomlLine {
  /** The line, its line break included. */
  readonly text: string;
  /** `[table]` or `[[array]]`: its key path. */
  readonly header?: ReadonlyArray<string>;
  /** `key = value`: its full key path, the table's included. */
  readonly key?: ReadonlyArray<string>;
  /** Blank, or only a comment. */
  readonly quiet: boolean;
}

/**
 * A TOML file as lines, each a header, a key, or neither, read only where a line starts outside a multi-line string or
 * array (so a `[` inside one is no header). Enough to find a table and its keys, not a TOML parser. `unclosed`: the
 * file ends inside a string or an array.
 */
function tomlLines(text: string): { readonly lines: ReadonlyArray<TomlLine>; readonly unclosed: boolean } {
  const lines: Array<TomlLine> = [];
  let table: ReadonlyArray<string> = [];
  let open: '"""' | "'''" | undefined;
  /** Brackets and braces open across lines: a multi-line array (or a TOML 1.1 inline table). */
  let depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const startsFree = open === undefined && depth === 0;
    // Where the line leaves a multi-line string or array open, for the next one.
    for (let i = 0; i < line.length; i++) {
      if (open !== undefined) {
        if (open === '"""' && line[i] === "\\") i++;
        else if (line.startsWith(open, i)) {
          i += 2;
          // Up to two more quotes end the string's content.
          while (line[i + 1] === open[0]) i++;
          open = undefined;
        }
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        open = line.slice(i, i + 3) as '"""' | "'''";
        i += 2;
      } else if (c === '"' || c === "'") {
        for (i++; i < line.length && line[i] !== c && line[i] !== "\n"; i++) if (c === '"' && line[i] === "\\") i++;
      } else if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
    }
    const body = line.trim();
    if (!startsFree) {
      lines.push({ text: line, quiet: false });
      continue;
    }
    const header = /^\[\[?(.*?)\]\]?\s*(?:#.*)?$/.exec(body);
    const headerKeys = header ? keyPath(header[1]!) : undefined;
    if (headerKeys) {
      table = headerKeys;
      lines.push({ text: line, header: headerKeys, quiet: false });
      continue;
    }
    const assignment = /^((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/.exec(body);
    const key = assignment ? keyPath(assignment[1]!) : undefined;
    lines.push({ text: line, ...(key ? { key: [...table, ...key] } : {}), quiet: body === "" || body.startsWith("#") });
  }
  return { lines, unclosed: open !== undefined || depth !== 0 };
}

const startsWith = (keys: ReadonlyArray<string>, prefix: ReadonlyArray<string>) => keys.length >= prefix.length && prefix.every((k, i) => keys[i] === k);

/** Whether a TOML config defines `mcp_servers.<name>`, as a table or as keys. */
export function tomlHasServer(text: string, name: string): boolean {
  const ours = ["mcp_servers", name];
  return tomlLines(text).lines.some((l) => (l.header && startsWith(l.header, ours)) || (l.key && startsWith(l.key, ours)));
}

/**
 * The config with `[mcp_servers.<name>]` holding `body` (its key lines), at the end. A table already there under the
 * name goes first (`[mcp_servers.<name>]`, quoted or not, with every `[mcp_servers.<name>.*]` under it, up to the next
 * other header; comments right above that header stay with it); every other byte stays as it was. A config that
 * defines the server another way (an inline table, dotted keys), which a new table would clash with, is refused.
 */
export function upsertTomlServer(text: string, name: string, body: ReadonlyArray<string>): string {
  const ours = ["mcp_servers", name];
  const { lines, unclosed } = tomlLines(text);
  if (unclosed) throw new ConfigRefused("ends inside a string or a list, which isn't valid TOML");
  const drop = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i]!.header && startsWith(lines[i]!.header!, ours))) continue;
    let end = i + 1;
    while (end < lines.length && lines[end]!.header === undefined) end++;
    // Comments and blank lines right above the next header are that header's.
    while (end > i + 1 && lines[end - 1]!.quiet) end--;
    // Where the table was, one blank line, not two (and none at the top of the file).
    let prev = i - 1;
    while (prev >= 0 && drop.has(prev)) prev--;
    for (let j = i; j < end; j++) drop.add(j);
    if (end < lines.length && lines[end]!.text.trim() === "" && (prev < 0 || lines[prev]!.text.trim() === "")) drop.add(end);
  }
  const clash = lines.find((l, i) => !drop.has(i) && l.key !== undefined && ((l.key.length === 1 && l.key[0] === "mcp_servers") || startsWith(l.key, ours)));
  if (clash) throw new ConfigRefused(`already defines ${name} another way (${clash.text.trim()})`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let kept = lines
    .filter((_, i) => !drop.has(i))
    .map((l) => l.text)
    .join("");
  if (kept.trim() === "") kept = "";
  else {
    if (!kept.endsWith("\n")) kept += eol;
    if (!/\r?\n\r?\n$/.test(kept)) kept += eol;
  }
  const header = /^[A-Za-z0-9_-]+$/.test(name) ? `[mcp_servers.${name}]` : `[mcp_servers.${tomlString(name)}]`;
  return kept + [header, ...body].join(eol) + eol;
}
