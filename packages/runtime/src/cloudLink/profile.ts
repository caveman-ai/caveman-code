// The profile This Mac syncs to Caveman Cloud and a Cloud computer applies:
// git marketplaces, every install of mine, hook trust, personal MCP server
// definitions and home skills (docs/,
// Profile v2). Git marketplaces still go as v1 spaces: a space whose plugins
// are all on except `disabled`, ids `<plugin>@<space id>`; the computer's
// runtime migrates them back (plugins/marketplaces.ts migrateSpaces). v2 adds
// `installed` (the catalog's by id and version, a remote entry's by url and
// commit, a folder's named mac_only) and `trustedHooks` ({id, digest}).
// Settings and
// skill text only: never a credential value. A server or space whose command
// line or URL holds one is left out (personal.ts holdsCredential, setup.scan's
// rule), skill files are scanned with the runtime's secret detector, and key
// or env files are never read. Every left-out item says why.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginServer, PluginSettings } from "@caveman-app/protocol";
import { containsKnownSecret, detectSecrets, type Scrubber } from "@caveman-app/session-protocol";

import { holdsCredential, serverProblem } from "../plugins/personal.ts";
import { MARKETPLACE_FILES } from "../plugins/load.ts";
import { COMMIT, spaceIdFor } from "../plugins/spaces.ts";
import type { SetupHomes } from "../session-protocol/setupScan.ts";

export type CloudRun = "runs" | "needs_runtime" | "mac_only";

export interface ProfileServer extends PluginServer {
  readonly cloud: CloudRun;
  readonly cloudReason?: string;
}

export interface ProfileSpace {
  readonly url: string;
  readonly commit: string;
  readonly ref?: string;
  readonly enabled: boolean;
}

export interface ProfileSkill {
  readonly name: string;
  readonly source: "claude-home" | "agents-home" | "codex-home" | "imported";
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

/** One of my installs (v2): the catalog's or a marketplace's by id, a remote entry's with its url and commit, a folder's mac_only. */
export interface ProfileInstall {
  readonly id: string;
  readonly version?: string;
  readonly url?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly enabled?: boolean;
  readonly cloud: CloudRun;
  readonly cloudReason?: string;
}

export interface Profile {
  /** 3: written by a computer that merges (profileMerge.ts), with its lineage; Cloud then takes only conditional writes. */
  readonly version: 1 | 2 | 3;
  /** v3: the history this profile belongs to. Another lineage (or none) is a profile this computer has no common past with. */
  readonly lineage?: string;
  readonly plugins: {
    readonly spaces: ReadonlyArray<ProfileSpace>;
    readonly disabled: ReadonlyArray<string>;
    /** v1 only: plugin ids. v2 trusts by digest (`trustedHooks`). */
    readonly trusted?: ReadonlyArray<string>;
    readonly servers: ReadonlyArray<ProfileServer>;
    readonly installed?: ReadonlyArray<ProfileInstall>;
    readonly trustedHooks?: ReadonlyArray<{ readonly id: string; readonly digest: string }>;
  };
  readonly skills: ReadonlyArray<ProfileSkill>;
}

/** One line of cloud.profile.status: what syncs, where it runs, or why it was left out. */
export interface ProfileItem {
  readonly kind: "marketplace" | "plugin" | "server" | "skill";
  readonly id: string;
  readonly cloud: CloudRun | "skipped";
  readonly reason?: string;
  /** A server's keys are opted in for Cloud computers. */
  readonly available?: boolean;
  /** A home skill: its SKILL.md's real path, as skill.list names it, so each folder of a shared name has its own line. */
  readonly path?: string;
}

// Caveman Cloud's caps and checks (profiles.go): an item Cloud would refuse is left out here with its
// reason, so one item never stops the whole profile.
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_SKILLS = 200;
const MAX_SKILL_FILES = 500;
/** The PUT body's cap (2 MiB) less room for the digest and framing. */
export const MAX_PROFILE_BYTES = 2 * 1024 * 1024 - 4096;
export const MAX_ITEMS = 200;
export const MAX_NAMES = 1000;
const MAX_TEXT = 4096;
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Text Cloud stores: 1 to 4 KiB, no NUL. */
export const text = (value: string) => value !== "" && Buffer.byteLength(value) <= MAX_TEXT && !value.includes("\0");

// ------------------------------------------------------------ canonical JSON

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
};

/** Keys sorted at every level, no whitespace: the bytes the digest covers. */
export const canonicalJson = (value: unknown) => JSON.stringify(sortKeys(value));
export const profileDigest = (profile: Profile) => createHash("sha256").update(canonicalJson(profile)).digest("hex");

// ------------------------------------------------------------ servers

const MAC_ONLY = new Set(["docker", "open", "osascript", "pbcopy", "pbpaste", "say", "defaults", "launchctl", "security", "xcrun", "xcodebuild", "swift", "brew", "mdfind", "screencapture", "shortcuts"]);
/** What the Cloud computer image has on PATH (cloud/runner/code/Dockerfile): This Mac's guess; a computer asks its own PATH. */
const ON_IMAGE = /^(npx|node|uvx|uv|python3?(\.[0-9]+)?)$/;
const LOCAL_PATH = /^(~\/|\/Users\/|\/Volumes\/|\/private\/|\/opt\/homebrew\/|\/Applications\/)/;
/** A bin folder a package manager puts launchers in (/opt/homebrew/bin, ~/.nvm/versions/node/v24/bin, ~/.asdf/shims). */
const BIN_DIR = /\/(bin|shims)$/;

/** An absolute path to a launcher the image has too (/opt/homebrew/bin/npx) as its bare name; anything else as it is. */
export const portableCommand = (command: string | undefined) =>
  command !== undefined && path.isAbsolute(command) && BIN_DIR.test(path.dirname(command)) && ON_IMAGE.test(path.basename(command)) ? path.basename(command) : command;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;
/** Where a URL's host is, seen from This Mac: its own loopback, its own network, or neither (undefined). */
function hostReach(host: string): "loopback" | "network" | undefined {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || h === "::" || /^127\./.test(h) || /^::ffff:127\./.test(h)) return "loopback";
  const v4 = IPV4.exec(h);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    // RFC 1918, link-local and shared (CGNAT, tailnets) addresses.
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ? "network" : undefined;
  }
  if (h.includes(":")) return /^f[cd]|^fe[89ab]/.test(h) ? "network" : undefined;
  // A name with no dot, or one only a local network or tailnet resolves.
  return !h.includes(".") || /\.(local|lan|home|internal|intranet|corp|home\.arpa|ts\.net)$/.test(h) ? "network" : undefined;
}

/** Interpreters: an argument named like a script is a file they run. */
const INTERPRETER = /^(node|nodejs|bun|deno|tsx|ts-node|python[0-9.]*|ruby|perl|php|sh|bash|zsh|java)$/;
const SCRIPT = /\.([cm]?[jt]sx?|py|rb|pl|php|sh|bash|jar|lua)$/i;
/** A file named relative to the folder the server starts in: `./server.js`, `../x`, or an interpreter's `dist/index.js`. */
const relativeFile = (arg: string, interpreter: boolean) =>
  !arg.startsWith("-") && !path.isAbsolute(arg) && !/^[a-z][a-z0-9+.-]*:/i.test(arg) && !/\s/.test(arg) && (/^\.\.?[\\/]/.test(arg) || (interpreter && !arg.startsWith("@") && SCRIPT.test(arg)));

/**
 * Where a server can run on a Cloud computer. `onPath` says whether a command
 * is on the computer's PATH, asked on the computer, which trusts only that;
 * without it (This Mac) the image's known launchers are assumed. `runs` means
 * the definition goes there and its launcher is there, never that it started:
 * only an MCP initialize and tool list on the computer itself shows that
 * (mcp.tools there, which the person asks for).
 */
export function classifyServer(server: PluginServer, onPath?: (command: string) => boolean, home?: string): { cloud: CloudRun; cloudReason?: string } {
  if (server.url !== undefined) {
    let host: string;
    try {
      host = new URL(server.url).hostname;
    } catch {
      return { cloud: "runs" };
    }
    const reach = hostReach(host);
    // A loopback service is This Mac's own; on a computer that address is the computer.
    if (reach === "loopback") return { cloud: "mac_only", cloudReason: `it reaches ${host}, a service on This Mac` };
    if (reach === "network") return { cloud: "needs_runtime", cloudReason: `it reaches ${host} on your own network, which a Cloud computer reaches only if its network can` };
    return { cloud: "runs" };
  }
  const command = onPath === undefined ? (portableCommand(server.command) ?? "") : (server.command ?? "");
  if (/^[~./]/.test(command)) return { cloud: "mac_only", cloudReason: `it runs ${command}, a file on This Mac` };
  const base = path.basename(command);
  if (MAC_ONLY.has(base)) return { cloud: "mac_only", cloudReason: `${base} runs only on This Mac` };
  const local = (server.args ?? []).find((arg) => LOCAL_PATH.test(arg) || (home !== undefined && home !== "/" && arg.startsWith(`${home}/`)));
  if (local !== undefined) return { cloud: "mac_only", cloudReason: `it reads ${local} on This Mac` };
  if (!(onPath === undefined ? ON_IMAGE.test(base) : onPath(base))) return { cloud: "needs_runtime", cloudReason: `${base} is not installed on Cloud computers` };
  // Relative to where the server starts: on a computer, the tools container's own folder (cloudLink/tools.ts
  // toolsCommand without a cwd), so it is there only if the computer has that file too. Never looked for here.
  const script = (server.args ?? []).find((arg) => relativeFile(arg, INTERPRETER.test(base)));
  if (script !== undefined) return { cloud: "needs_runtime", cloudReason: `it runs ${script} from the folder it starts in, so a Cloud computer needs that file too` };
  return { cloud: "runs" };
}

/** Whether `command` is an executable on `PATH` (a Cloud computer's runtime and tools share one image). */
export const onPathOf = (envPath: string | undefined) => (command: string) =>
  (envPath ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

// ------------------------------------------------------------ skills

/** Files never read into a profile: env files and keys, by name. */
export const KEY_FILE = /^\.env|\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|asc|der|crt|cer)$|^id_(rsa|dsa|ecdsa|ed25519)|credentials|\.netrc$/i;

/** Text a skill file must not carry: a known credential, a value stored as a secret here, or an env file's shape. */
export const holdsSecret = (scrubber: Scrubber, text: string) =>
  containsKnownSecret(text) || scrubber.scrub(text) !== text || detectSecrets(text).kind === "env";

const inside = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);

/**
 * A skill's helper scripts that run by themselves (`scripts/check.sh` called directly): the one file of a
 * profile skill that is not the skill's own. Cloud keeps skill files as path and text only (profiles.go
 * rejects any other field), so the execute bit travels as this list, written here from the folder's modes
 * and honoured on a computer only for the text helpers it names (writeProfileSkills). Never written to disk.
 */
export const EXECUTABLE_MANIFEST = ".caveman-skill.json";

/** A text helper that runs by itself: executable here and starting with `#!`. Anything else stays data (0644). */
const isHelper = (content: string, mode: number) => (mode & 0o111) !== 0 && content.startsWith("#!");

/** One skill folder as profile files, or why it was left out. Reads only files that really live inside the folder. */
export function readSkill(dir: string, scrubber: Scrubber): { files: Array<{ path: string; content: string }>; skipped: string[] } | string {
  const root = fs.realpathSync(dir);
  const files: Array<{ path: string; content: string }> = [];
  const executable: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const walk = (rel: string): string | undefined => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const problem = walk(name);
        if (problem) return problem;
        continue;
      }
      if (name.includes("\\") || !text(name)) {
        skipped.push(`${name} (its name is not a portable path)`);
        continue;
      }
      if (name === EXECUTABLE_MANIFEST) {
        skipped.push(`${name} (Caveman Code keeps that name for itself)`);
        continue;
      }
      const real = fs.realpathSync(path.join(root, name));
      if (!inside(root, real) || !fs.statSync(real).isFile()) {
        skipped.push(`${name} (outside the skill)`);
        continue;
      }
      if (KEY_FILE.test(entry.name)) {
        skipped.push(`${name} (a key or env file)`);
        continue;
      }
      const raw = fs.readFileSync(real);
      if (raw.includes(0)) {
        skipped.push(`${name} (a binary file: only text syncs)`);
        continue;
      }
      const content = raw.toString("utf8");
      if (holdsSecret(scrubber, content)) {
        skipped.push(`${name} (looks like it holds a secret)`);
        continue;
      }
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_SKILL_BYTES) return "it is over 256 KiB";
      if (files.length >= MAX_SKILL_FILES) return `it has over ${MAX_SKILL_FILES} files`;
      files.push({ path: name, content });
      if (isHelper(content, fs.statSync(real).mode)) executable.push(name);
    }
    return undefined;
  };
  const problem = walk("");
  if (problem) return problem;
  if (!files.some((f) => f.path === "SKILL.md")) return skipped.find((s) => s.startsWith("SKILL.md")) ? "its SKILL.md looks like it holds a secret" : "it has no SKILL.md";
  if (executable.length > 0) {
    const manifest = JSON.stringify({ executable });
    if (bytes + Buffer.byteLength(manifest) > MAX_SKILL_BYTES) return "it is over 256 KiB";
    if (files.length >= MAX_SKILL_FILES) return `it has over ${MAX_SKILL_FILES} files`;
    files.push({ path: EXECUTABLE_MANIFEST, content: manifest });
  }
  return { files, skipped };
}

/** The helpers a profile skill's manifest names that a computer may make executable: its own text files starting with `#!`. */
export function executableFiles(skill: ProfileSkill): ReadonlySet<string> {
  const manifest = skill.files.find((f) => f.path === EXECUTABLE_MANIFEST);
  if (manifest === undefined) return new Set();
  let listed: unknown;
  try {
    listed = (JSON.parse(manifest.content) as { executable?: unknown }).executable;
  } catch {
    return new Set();
  }
  if (!Array.isArray(listed)) return new Set();
  const helpers = new Map(skill.files.filter((f) => f.path !== EXECUTABLE_MANIFEST && f.content.startsWith("#!") && !KEY_FILE.test(path.posix.basename(f.path))).map((f) => [f.path, f]));
  return new Set(listed.filter((p): p is string => typeof p === "string" && helpers.has(p)));
}

/** The three home skill roots, Claude's first: where a skill of each source lives on This Mac. */
export const skillRoots = (homes: SetupHomes, home: string): ReadonlyArray<{ readonly dir: string; readonly source: ProfileSkill["source"] }> => [
  { dir: path.join(homes.claudeDir, "skills"), source: "claude-home" },
  { dir: path.join(home, ".agents", "skills"), source: "agents-home" },
  { dir: path.join(homes.codexHome, "skills"), source: "codex-home" },
];

/** The folder that holds a skill's name on This Mac: the one that syncs, else the first seen and why it cannot. */
export interface SkillFolder {
  /** As listed in its root (a link is not followed). */
  readonly folder: string;
  /** The folder it is: itself, or the one in another home skill root it links to (`npx skills` links Claude's to ~/.agents'). */
  readonly real: string;
  readonly root: string;
  readonly source: ProfileSkill["source"];
  /** A link to a folder outside the home skill roots (a repository, say): changes from other computers are never written through it. */
  readonly linked: boolean;
  /** Why it does not go to Cloud from here. */
  readonly held?: string;
}

const skillDigest = (files: ReadonlyArray<{ readonly path: string; readonly content: string }>) =>
  createHash("sha256").update(canonicalJson(files.map((f) => ({ path: f.path, content: f.content })))).digest("hex");

/**
 * Home skill folders, Claude's first, then ~/.agents and Codex's, each with a SKILL.md. One real folder
 * (linked into several roots) is one skill. Cloud keeps one skill per name, so of several folders with one
 * name the first that can sync goes: one with the same files is the same skill; one with other files stays
 * here and its line says so, as does the one that goes (H09: nothing is replaced without saying).
 */
export function readHomeSkills(
  homes: SetupHomes,
  home: string,
  scrubber: Scrubber,
): { skills: ProfileSkill[]; items: ProfileItem[]; folders: Map<string, SkillFolder> } {
  const roots = skillRoots(homes, home);
  const shown = (folder: string) => (home !== "/" && inside(home, folder) && folder !== home ? `~/${path.relative(home, folder).split(path.sep).join("/")}` : folder);
  const skills: ProfileSkill[] = [];
  const items: ProfileItem[] = [];
  const realSeen = new Set<string>();
  const folders = new Map<string, SkillFolder>();
  const realRoots = roots.flatMap(({ dir }) => (fs.existsSync(dir) ? [fs.realpathSync(dir)] : []));
  /** Per name: what went (folder shown, its files' digest, its line), and the folders of that name with other files. */
  const went = new Map<string, { folder: string; digest: string; item: number; others: string[] }>();
  for (const { dir, source } of roots) {
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const within = [home, path.dirname(dir)].filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const folder = path.join(dir, entry.name);
      const real = fs.existsSync(path.join(folder, "SKILL.md")) ? fs.realpathSync(folder) : undefined;
      if (real === undefined || realSeen.has(real)) continue;
      realSeen.add(real);
      const line = { kind: "skill" as const, id: entry.name, path: path.join(real, "SKILL.md") };
      if (!SKILL_NAME.test(entry.name) || entry.name.includes("..")) {
        items.push({ ...line, cloud: "skipped", reason: "its folder name is not a skill name" });
        continue;
      }
      // The folder that holds this name here: the first seen, until one of its name syncs.
      const here: SkillFolder = { folder, real, root: dir, source, linked: !realRoots.some((root) => real === path.join(root, entry.name)) };
      if (!folders.has(entry.name)) folders.set(entry.name, here);
      const skip = (reason: string) => {
        items.push({ ...line, cloud: "skipped", reason });
        const held = folders.get(entry.name);
        if (held?.folder === folder) folders.set(entry.name, { ...held, held: reason });
      };
      if (!within.some((root) => inside(root, real))) {
        skip("it links outside your home");
        continue;
      }
      const first = went.get(entry.name);
      if (first === undefined && skills.length >= MAX_SKILLS) {
        skip(`only the first ${MAX_SKILLS} skills sync`);
        continue;
      }
      const read = readSkill(folder, scrubber);
      if (typeof read === "string") {
        skip(read);
        continue;
      }
      const digest = skillDigest(read.files);
      const leftOut = read.skipped.length ? `left out: ${read.skipped.join(", ")}` : undefined;
      if (first !== undefined) {
        if (first.digest === digest) items.push({ ...line, cloud: "runs", ...(leftOut ? { reason: leftOut } : {}) });
        else {
          first.others.push(shown(folder));
          skip(`${first.folder} has a skill of the same name with other files, and Cloud keeps one per name: rename this folder to sync it too`);
        }
        continue;
      }
      skills.push({ name: entry.name, source, files: read.files });
      folders.set(entry.name, here);
      went.set(entry.name, { folder: shown(folder), digest, item: items.length, others: [] });
      items.push({ ...line, cloud: "runs", ...(leftOut ? { reason: leftOut } : {}) });
    }
  }
  for (const { item, others } of went.values()) {
    if (others.length === 0) continue;
    const kept = `${others.join(" and ")}, named the same with other files, ${others.length === 1 ? "stays" : "stay"} on This Mac`;
    const at = items[item]!;
    items[item] = { ...at, reason: at.reason === undefined ? kept : `${at.reason}; ${kept}` };
  }
  return { skills, items, folders };
}

// ------------------------------------------------------------ build

/** git URLs only (https, ssh); a local folder means nothing on a Cloud computer. */
export const GIT_URL = /^(https:\/\/|ssh:\/\/|git@[^:/]+:)/;
/** Why an install of mine stays on This Mac: its plugin is in a folder here. */
export const MAC_ONLY_PLUGIN = "only on This Mac: it is in a folder here";

/** The plugin names a checkout's marketplace lists, or its one plugin's; undefined when it cannot be read. */
function pluginNamesAt(dir: string): string[] | undefined {
  const json = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { name?: unknown; plugins?: Array<{ name?: unknown }> };
    } catch {
      return undefined;
    }
  };
  for (const file of MARKETPLACE_FILES) {
    const market = json(file);
    if (market !== undefined) return (market.plugins ?? []).flatMap((p) => (typeof p.name === "string" ? [p.name] : []));
  }
  for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const name = json(file)?.name;
    if (typeof name === "string") return [name];
  }
  return undefined;
}

/** Why Cloud would refuse this space, or undefined (profiles.go checkSpaceURL and the pin). */
function spaceProblem(space: PluginSettings["spaces"][number]): string | undefined {
  if (!GIT_URL.test(space.url)) return "it is a folder on This Mac, not a git URL";
  if (holdsCredential([space.url])) return "its URL holds a credential";
  if (!text(space.url)) return "its URL is too long";
  if (!COMMIT.test(space.commit)) return "it is not checked out at a commit yet";
  if (space.ref !== undefined && (!text(space.ref) || space.ref.startsWith("-"))) return "its ref is not a branch, tag or commit";
  return undefined;
}

/** Why Cloud would refuse this server's definition, or undefined (profiles.go ProfileInput.check). */
function serverCloudProblem(server: PluginServer): string | undefined {
  if (serverProblem(server) !== undefined) return serverProblem(server);
  if (server.command !== undefined && !text(server.command)) return "its command is too long";
  if (server.url !== undefined && !text(server.url)) return "its URL is too long";
  if ((server.args ?? []).length > MAX_NAMES) return `it has over ${MAX_NAMES} arguments`;
  if ((server.args ?? []).some((a) => Buffer.byteLength(a) > MAX_TEXT || a.includes("\0"))) return "an argument is over 4 KiB";
  if ((server.env ?? []).some((n) => !ENV_NAME.test(n) || !text(n)) || (server.env ?? []).length > MAX_NAMES) return "a variable it needs is not an environment variable name";
  // Caveman Cloud's profile takes header names of letters, digits and - (control-api profiles.go headerNameRE); the
  // app takes any HTTP header name. One it would refuse stays on This Mac rather than failing the whole profile.
  const header = (server.headers ?? []).find((h) => !CLOUD_HEADER_NAME.test(h));
  if (header !== undefined) return `Caveman Cloud does not take its header ${header} yet, so it stays on This Mac`;
  return undefined;
}

const CLOUD_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** What This Mac reads its profile from. */
export interface ProfileInput {
  readonly plugins: PluginSettings;
  readonly homes: SetupHomes;
  readonly home: string;
  readonly scrubber: Scrubber;
  /** Where git marketplaces are checked out (`<state>/spaces`). */
  readonly spacesDir: string;
}

/**
 * Something This Mac has that does not go to Cloud as it is (a skill with a secret in its SKILL.md, a space not
 * checked out yet, a server whose command line holds a key). A merge keeps Cloud's version of it and never takes
 * its absence from the profile for a removal made here.
 */
export interface HeldItem {
  readonly kind: "space" | "server" | "skill";
  readonly id: string;
  readonly reason: string;
  /** What it is here when that is known (a space's pin, a server's definition): a change to it is a change made here. */
  readonly content?: unknown;
}

/** This Mac's profile from Settings and the home skill folders, with what each item does in Cloud. */
export function buildProfile(input: ProfileInput): { profile: Profile; items: ProfileItem[] } {
  const { profile, items } = readLocalProfile(input);
  return fitProfile(profile, items);
}

/**
 * This Mac's whole profile before Cloud's 2 MiB cap, what it holds back (`held`), and the folder that holds each
 * home skill's name: what a merge (profileMerge.ts) reads as this computer's side.
 */
export function readLocalProfile(input: ProfileInput): { profile: Profile; items: ProfileItem[]; held: HeldItem[]; skillFolders: Map<string, SkillFolder> } {
  const items: ProfileItem[] = [];
  const held: HeldItem[] = [];
  const spaces: ProfileSpace[] = [];
  const disabled: string[] = [];
  const seenUrls = new Set<string>();
  const pin = (url: string, commit: string, ref: string | undefined) => ({ url, commit, ...(ref === undefined ? {} : { ref }) });
  for (const market of input.plugins.marketplaces) {
    const id = market.name;
    if (market.source.kind === "folder") {
      items.push({ kind: "marketplace", id, cloud: "skipped", reason: "it is a folder on This Mac, not a git URL" });
      continue;
    }
    const { url, commit, ref } = market.source;
    seenUrls.add(url);
    const problem = spaces.length >= MAX_ITEMS ? `only the first ${MAX_ITEMS} marketplaces sync` : spaceProblem({ url, commit, ...(ref === undefined ? {} : { ref }), enabled: true });
    const names = problem === undefined ? pluginNamesAt(path.join(input.spacesDir, spaceIdFor(url), commit)) : undefined;
    const hold = (reason: string) => {
      items.push({ kind: "marketplace", id, cloud: "skipped", reason });
      if (GIT_URL.test(url)) held.push({ kind: "space", id: url, reason, content: pin(url, commit, ref) });
    };
    if (problem !== undefined) hold(problem);
    else if (names === undefined) hold("it is not checked out on This Mac yet");
    else {
      spaces.push({ url, commit, ...(ref === undefined ? {} : { ref }), enabled: true });
      items.push({ kind: "marketplace", id, cloud: "runs" });
      // Profile v1 ids: a plugin I have not installed (or turned off) is a turned-off space plugin.
      for (const name of names) {
        const pluginId = `${name}@${id}`;
        const on = input.plugins.installed.some((i) => i.id === pluginId && i.enabled) && !input.plugins.disabled.includes(pluginId);
        if (!on) disabled.push(`${name}@${spaceIdFor(url)}`);
      }
    }
  }
  // A space another computer added that the registry has not checked out yet (plugins/marketplaces.ts migrateSpaces).
  for (const space of input.plugins.spaces) {
    if (seenUrls.has(space.url) || !GIT_URL.test(space.url)) continue;
    seenUrls.add(space.url);
    held.push({ kind: "space", id: space.url, reason: "it is not checked out on This Mac yet", content: pin(space.url, space.commit, space.ref) });
  }
  // Every install of mine: a computer has the catalog and the team's marketplaces itself, a git marketplace through
  // its space; a remote entry goes with its repository and commit. A folder is only on This Mac.
  const installed: ProfileInstall[] = [];
  const folders = new Set(input.plugins.marketplaces.flatMap((m) => (m.source.kind === "folder" || !GIT_URL.test(m.source.url) ? [m.name] : [])));
  for (const install of input.plugins.installed) {
    const market = install.id.slice(install.id.lastIndexOf("@") + 1);
    const remote = install.source !== undefined && install.commit !== undefined;
    const enabled = install.enabled && !input.plugins.disabled.includes(install.id);
    if (folders.has(market) || (remote && (!GIT_URL.test(install.source!.url) || holdsCredential([install.source!.url])))) {
      installed.push({ id: install.id, cloud: "mac_only", cloudReason: MAC_ONLY_PLUGIN });
      items.push({ kind: "plugin", id: install.id, cloud: "mac_only", reason: MAC_ONLY_PLUGIN });
      continue;
    }
    installed.push({
      id: install.id,
      ...(install.version === undefined ? {} : { version: install.version }),
      ...(remote ? { url: install.source!.url, commit: install.commit!, ...(install.source!.path === undefined ? {} : { path: install.source!.path }) } : {}),
      enabled,
      cloud: "runs",
    });
    items.push({ kind: "plugin", id: install.id, cloud: "runs" });
  }
  // Trust by digest: a computer with the same files (same commit, same catalog) computes the same one.
  const trustedHooks = input.plugins.trusted.flatMap((entry) => {
    const [id, digest] = entry.split("#");
    return digest !== undefined && /^[0-9a-f]{64}$/.test(digest) && !folders.has(id!.slice(id!.lastIndexOf("@") + 1)) ? [{ id: id!, digest }] : [];
  });
  const servers: ProfileServer[] = [];
  for (const original of input.plugins.servers) {
    const command = portableCommand(original.command);
    const server = command === original.command ? original : { ...original, command: command! };
    const argv = [...(server.command === undefined ? [] : [server.command]), ...(server.args ?? []), ...(server.url === undefined ? [] : [server.url])];
    const skip = (reason: string) => {
      items.push({ kind: "server", id: server.name, cloud: "skipped", reason });
      held.push({ kind: "server", id: server.name, reason, content: (({ cloudConsent: _c, ...rest }) => rest)(server) });
    };
    if (holdsCredential(argv)) {
      skip("its command line or URL holds a credential; grant it as a key instead");
      continue;
    }
    const problem = servers.length >= MAX_ITEMS ? `only the first ${MAX_ITEMS} servers sync` : serverCloudProblem(server);
    if (problem !== undefined) {
      skip(problem);
      continue;
    }
    const where = classifyServer(server, undefined, input.home);
    const { cloudConsent, ...rest } = server;
    // Cloud keeps no `cursor` source (profiles.go serverSources) and refuses the whole profile for one: it syncs as added by hand.
    servers.push({ ...rest, ...(rest.source === "cursor" ? { source: "manual" as const } : {}), ...(cloudConsent === true ? { cloudConsent: true } : {}), ...where });
    items.push({ kind: "server", id: server.name, cloud: where.cloud, ...(where.cloudReason ? { reason: where.cloudReason } : {}), available: cloudConsent === true });
  }
  const { skills, items: skillItems, folders: skillFolders } = readHomeSkills(input.homes, input.home, input.scrubber);
  for (const [name, folder] of skillFolders) if (folder.held !== undefined) held.push({ kind: "skill", id: name, reason: folder.held });
  const names = (list: ReadonlyArray<string>) => list.filter(text).slice(0, MAX_NAMES);
  const profile: Profile = { version: 2, plugins: { spaces, disabled: names(disabled), servers, installed: installed.slice(0, MAX_NAMES), trustedHooks: trustedHooks.slice(0, MAX_NAMES) }, skills };
  return { profile, items: [...items, ...skillItems], held, skillFolders };
}

/** Under Cloud's 2 MiB cap: the largest skills are left out first, each saying so. */
export function fitProfile(profile: Profile, items: ReadonlyArray<ProfileItem>, max = MAX_PROFILE_BYTES): { profile: Profile; items: ProfileItem[] } {
  let size = Buffer.byteLength(JSON.stringify(profile));
  if (size <= max) return { profile, items: [...items] };
  const bytes = (skill: ProfileSkill) => Buffer.byteLength(JSON.stringify(skill)) + 1;
  const dropped = new Set<string>();
  for (const skill of [...profile.skills].sort((a, b) => bytes(b) - bytes(a) || a.name.localeCompare(b.name))) {
    if (size <= max) break;
    dropped.add(skill.name);
    size -= bytes(skill);
  }
  return {
    profile: { ...profile, skills: profile.skills.filter((s) => !dropped.has(s.name)) },
    items: items.map((i) =>
      i.kind === "skill" && i.cloud === "runs" && dropped.has(i.id) ? { ...i, cloud: "skipped" as const, reason: "over the 2 MiB profile cap: the largest skills are left out first" } : i,
    ),
  };
}

// ------------------------------------------------------------ apply (Cloud computer)

/**
 * Where a computer keeps the profile's skills: a stable folder (the tools container mounts it) holding
 * `gen-<digest>` folders and a `current` link to the one in use, swapped atomically. PluginRegistry loads
 * `current` as the `my-skills@profile` plugin; engines read through it.
 */
export const profileSkillsDir = (stateDir: string) => path.join(stateDir, "profile-skills");
export const currentProfileSkills = (stateDir: string) => path.join(profileSkillsDir(stateDir), "current");

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * The plugin settings a computer runs from a profile: its spaces (migrated to
 * marketplaces by the registry, from scratch on every pull, so the computer
 * mirrors This Mac); This Mac's installs, marked `profile` so the next pull
 * replaces them, beside the computer's own (kept, unless from a git
 * marketplace the pull resets); hook trust by digest; servers re-classified
 * here, mac_only ones kept but off. Team marketplaces and installs come from
 * Cloud directly. What Cloud sent is checked again; anything malformed is
 * left out. A git marketplace this computer granted credentials keeps them.
 */
export function applyProfile(input: {
  readonly profile: Profile | undefined;
  readonly onPath: (command: string) => boolean;
  /** The computer's plugin settings now: its own installs stay, and its grants. */
  readonly current?: Pick<PluginSettings, "installed" | "marketplaces"> & Partial<Pick<PluginSettings, "spaces">>;
}): { plugins: Pick<PluginSettings, "marketplaces" | "installed" | "spaces" | "servers" | "disabled" | "trusted">; items: ProfileItem[] } {
  const p = input.profile?.plugins;
  const items: ProfileItem[] = [];
  const spaces: Array<PluginSettings["spaces"][number]> = [];
  const ids = new Set<string>();
  for (const space of p?.spaces ?? []) {
    if (!isString(space.url) || !GIT_URL.test(space.url) || !isString(space.commit) || !COMMIT.test(space.commit) || holdsCredential([space.url])) continue;
    const id = spaceIdFor(space.url);
    if (ids.has(id)) continue;
    ids.add(id);
    const granted =
      input.current?.marketplaces.find((m) => m.source.kind === "git" && m.source.url === space.url)?.granted ?? input.current?.spaces?.find((c) => c.url === space.url)?.granted;
    spaces.push({ url: space.url, commit: space.commit, ...(isString(space.ref) && space.ref !== "" ? { ref: space.ref } : {}), enabled: space.enabled !== false, ...(granted === undefined ? {} : { granted }) });
    items.push({ kind: "marketplace", id, cloud: "runs" });
  }
  const servers: PluginServer[] = [];
  for (const raw of p?.servers ?? []) {
    const { cloud: _cloud, cloudReason: _reason, ...server } = raw;
    const argv = [...(server.command === undefined ? [] : [server.command]), ...(server.args ?? []), ...(server.url === undefined ? [] : [server.url])];
    if (!isString(server.name) || serverProblem(server) !== undefined || holdsCredential(argv)) continue;
    const where = classifyServer(server, input.onPath);
    servers.push({ ...server, enabled: server.enabled !== false && where.cloud !== "mac_only" });
    items.push({ kind: "server", id: server.name, cloud: where.cloud, ...(where.cloudReason ? { reason: where.cloudReason } : {}), available: server.cloudConsent === true });
  }
  const installed: Array<PluginSettings["installed"][number]> = [];
  for (const raw of (Array.isArray(p?.installed) ? p.installed : []) as ReadonlyArray<Partial<ProfileInstall>>) {
    const remote = isString(raw.url) && isString(raw.commit);
    if (!isString(raw.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.id) || installed.some((i) => i.id === raw.id)) continue;
    if (raw.cloud === "mac_only") {
      items.push({ kind: "plugin", id: raw.id, cloud: "mac_only", reason: isString(raw.cloudReason) ? raw.cloudReason : MAC_ONLY_PLUGIN });
      continue;
    }
    if (remote && (!GIT_URL.test(raw.url!) || !COMMIT.test(raw.commit!) || holdsCredential([raw.url!]))) continue;
    if (isString(raw.path) && (path.isAbsolute(raw.path) || raw.path.split("/").some((s) => s === ".." || s === ""))) continue;
    installed.push({
      id: raw.id,
      ...(isString(raw.version) ? { version: raw.version } : {}),
      ...(remote ? { source: { url: raw.url!, ...(isString(raw.path) ? { path: raw.path } : {}) }, commit: raw.commit! } : {}),
      enabled: raw.enabled !== false,
      profile: true,
    });
    items.push({ kind: "plugin", id: raw.id, cloud: "runs" });
  }
  // The computer's own installs stay; one from a git marketplace (which this pull resets) or that This Mac also has does not.
  const gitMarkets = new Set((input.current?.marketplaces ?? []).flatMap((m) => (m.source.kind === "git" ? [m.name] : [])));
  const own = (input.current?.installed ?? []).filter(
    (i) => i.profile !== true && !installed.some((m) => m.id === i.id) && !gitMarkets.has(i.id.slice(i.id.lastIndexOf("@") + 1)),
  );
  const trusted =
    p?.trustedHooks !== undefined
      ? p.trustedHooks.flatMap((t) => (isString(t.id) && isString(t.digest) && /^[0-9a-f]{64}$/.test(t.digest) ? [`${t.id}#${t.digest}`] : []))
      : (p?.trusted ?? []).filter(isString);
  return {
    plugins: { marketplaces: [], installed: [...own, ...installed], spaces, servers, disabled: (p?.disabled ?? []).filter(isString), trusted },
    items,
  };
}

/**
 * Writes the profile's skills as `<dir>/gen-<digest>` and points `<dir>/current` at it (a relative link
 * renamed over the old one, so a reader sees one whole generation or the other). `dir` itself is never
 * replaced: the tools container's bind mount of it keeps seeing new generations. The one before stays for
 * sessions still reading it; older ones go. A file path that leaves its skill is refused.
 */
export function writeProfileSkills(dir: string, skills: ReadonlyArray<ProfileSkill>): ProfileItem[] {
  const items: ProfileItem[] = [];
  const accepted: ProfileSkill[] = [];
  const names = new Set<string>();
  for (const skill of skills.slice(0, MAX_SKILLS)) {
    const files: ProfileSkill["files"] = Array.isArray(skill.files) ? skill.files : [];
    const ok =
      isString(skill.name) &&
      SKILL_NAME.test(skill.name) &&
      !skill.name.includes("..") &&
      !names.has(skill.name) &&
      files.some((f) => f.path === "SKILL.md") &&
      files.every((f) => isString(f.path) && isString(f.content) && !path.isAbsolute(f.path) && !f.path.includes("\\") && !f.path.split("/").some((s) => s === ".." || s === "" || s === "."));
    if (!ok) {
      items.push({ kind: "skill", id: String(skill.name), cloud: "skipped", reason: "its files are not a skill" });
      continue;
    }
    names.add(skill.name);
    accepted.push(skill);
    items.push({ kind: "skill", id: skill.name, cloud: "runs" });
  }
  // Layout 2 sets helpers' modes: a generation an older runtime wrote for the same skills is written again.
  const layout = { layout: 2, skills: accepted.map((s) => ({ name: s.name, files: s.files.map((f) => ({ path: f.path, content: f.content })) })) };
  const digest = createHash("sha256").update(canonicalJson(layout)).digest("hex").slice(0, 16);
  const gen = `gen-${digest}`;
  // An older layout (the skills right in `dir`): its folders go, `dir` stays.
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  let previous: string | undefined;
  try {
    previous = fs.readlinkSync(path.join(dir, "current"));
  } catch {
    previous = undefined;
  }
  if (!fs.existsSync(path.join(dir, gen))) {
    const next = path.join(dir, `.${gen}.part-${process.pid}`);
    fs.rmSync(next, { recursive: true, force: true });
    fs.mkdirSync(next, { mode: 0o755 });
    for (const skill of accepted) {
      const helpers = executableFiles(skill);
      for (const file of skill.files) {
        if (file.path === EXECUTABLE_MANIFEST) continue;
        const target = path.join(next, skill.name, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Only a text helper This Mac had executable runs by itself here; every other file stays data.
        fs.writeFileSync(target, file.content, { mode: helpers.has(file.path) ? 0o755 : 0o644 });
      }
    }
    fs.renameSync(next, path.join(dir, gen));
  }
  if (previous !== gen) {
    const link = path.join(dir, `.current.${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(gen, link);
    fs.renameSync(link, path.join(dir, "current"));
  }
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "current" || entry === gen || entry === previous) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return items;
}
