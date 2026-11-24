// This Mac's side of the one profile every computer shares (profileMerge.ts): what it has,
// what it remembers agreeing with Cloud, and how Cloud's changes are written here.
//
// - What it remembers is `<state>/profile-sync.json`: whose profile, how it syncs, the lineage and each item's two
//   bases. It moves only once Cloud took the write (or had nothing to take), so a crash between the two re-merges.
// - Cloud's changes are written after Cloud accepted the merged profile, never before: a refused write leaves this
//   Mac as it was. A skill is changed in place (its other files, like a .env, stay) or removed whole; what it was
//   goes to `<state>/profile-sync/trash` first, kept 30 days. Nothing is written through a link, nor into a folder of
//   the same name in another case. Plugin settings go through Settings as the Plugins page's own changes do.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PluginInstall, PluginServer, PluginSettings } from "@caveman-app/protocol";
import type { Scrubber } from "@caveman-app/session-protocol";

import {
  EXECUTABLE_MANIFEST,
  executableFiles,
  readLocalProfile,
  readSkill,
  skillRoots,
  type ProfileInput,
  type ProfileInstall,
  type ProfileItem,
  type ProfileServer,
  type ProfileSkill,
  type ProfileSpace,
  type SkillFolder,
} from "./profile.ts";
import { spaceIdFor } from "../plugins/spaces.ts";
import {
  heldItem,
  itemsOf,
  serverCore,
  writableSkillFile,
  type Base,
  type LocalItem,
  type SyncItem,
  type Take,
} from "./profileMerge.ts";

// ------------------------------------------------------------ what this Mac remembers

export type SyncMode = "two_way" | "push_only";

export interface SyncFile {
  /** Whose profile (cloudSync.ts ownerOf): another account starts with no common past. */
  readonly owner: string;
  readonly mode: SyncMode;
  /** two_way: the lineage the bases belong to. */
  readonly lineage?: string;
  readonly bases: Readonly<Record<string, Base>>;
}

const syncFile = (stateDir: string) => path.join(stateDir, "profile-sync.json");
export const trashDir = (stateDir: string) => path.join(stateDir, "profile-sync", "trash");
export const LINEAGE = /^[0-9a-f]{32}$/;
export const newLineage = () => randomBytes(16).toString("hex");

export function readSyncFile(stateDir: string): SyncFile | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(syncFile(stateDir), "utf8")) as Partial<SyncFile>;
    if (typeof raw.owner !== "string" || (raw.mode !== "two_way" && raw.mode !== "push_only"))
      return undefined;
    const bases: Record<string, Base> = {};
    for (const [key, b] of Object.entries(
      typeof raw.bases === "object" && raw.bases !== null ? raw.bases : {},
    )) {
      const base = b as Partial<Base>;
      bases[key] = {
        ...(typeof base.l === "string" ? { l: base.l } : {}),
        ...(typeof base.r === "string" ? { r: base.r } : {}),
        ...(base.x === true ? { x: true as const } : {}),
      };
    }
    return {
      owner: raw.owner,
      mode: raw.mode,
      ...(typeof raw.lineage === "string" && LINEAGE.test(raw.lineage)
        ? { lineage: raw.lineage }
        : {}),
      bases,
    };
  } catch {
    return undefined;
  }
}

export function writeSyncFile(stateDir: string, file: SyncFile) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${syncFile(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  fs.renameSync(tmp, syncFile(stateDir));
}

// ------------------------------------------------------------ this Mac's side

/** A folder's files as a fingerprint (path, size, time): a change to a skill that cannot sync still shows as a change. */
function fingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 8 || parts.length > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(name, depth + 1);
      else {
        try {
          const st = fs.statSync(path.join(dir, name));
          parts.push(`${name}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
        } catch {
          parts.push(name);
        }
      }
    }
  };
  walk("", 0);
  return parts.join("\n");
}

export interface LocalSide {
  readonly local: Map<string, LocalItem>;
  /** cloud.profile.status lines: what of this Mac's goes to Cloud and how it runs there. */
  readonly lines: ProfileItem[];
  readonly skillFolders: ReadonlyMap<string, SkillFolder>;
}

/** This Mac's side: every item it has, the ones it cannot send marked held (so their absence from Cloud never reads as a removal). */
/**
 * While a marketplace is held here (not checked out at its pin yet), which of its plugins are off is Cloud's to
 * say: this Mac cannot read its plugin list, and taking the list's absence for removals would turn every one on.
 */
export function withHeldSpaces(
  local: ReadonlyMap<string, LocalItem>,
  remote: ReadonlyMap<string, SyncItem>,
): Map<string, LocalItem> {
  const held = new Set(
    [...local.values()]
      .filter((i) => i.kind === "space" && i.held !== undefined)
      .map((i) => spaceIdFor(i.id)),
  );
  const out = new Map(local);
  if (held.size === 0) return out;
  const ofHeld = (i: SyncItem) =>
    i.kind === "disabled" && held.has(i.id.slice(i.id.lastIndexOf("@") + 1));
  for (const [key, i] of local) if (ofHeld(i)) out.delete(key);
  for (const [key, i] of remote) if (ofHeld(i)) out.set(key, i);
  return out;
}

export function localSide(input: ProfileInput): LocalSide {
  const { profile, items, held, skillFolders } = readLocalProfile(input);
  const local = itemsOf(profile) as Map<string, LocalItem>;
  for (const h of held) {
    const entry = heldItem(
      h.kind,
      h.id,
      h.reason,
      h.content,
      h.kind === "skill" ? fingerprint(skillFolders.get(h.id)?.folder ?? "") : undefined,
    );
    if (!local.has(entry.key)) local.set(entry.key, entry);
  }
  return { local, lines: items, skillFolders };
}

/** Why Cloud's version of an item cannot be written on this Mac; undefined when it can. */
export function blockedHere(
  side: Pick<LocalSide, "skillFolders">,
  homes: ProfileInput["homes"],
  home: string,
) {
  return (remote: SyncItem | undefined, local: LocalItem | undefined): string | undefined => {
    const item = remote ?? local;
    if (item === undefined) return undefined;
    if (item.kind === "skill") {
      const folder = side.skillFolders.get(item.id);
      if (folder?.linked)
        return `${shownPath(folder.folder, home)} is a link to a folder elsewhere, so changes from your other computers are not written into it`;
      if (folder === undefined && remote !== undefined) {
        const root = rootFor((remote.value as ProfileSkill).source, homes, home);
        const other = listNames(root).find(
          (n) => n !== item.id && n.toLowerCase() === item.id.toLowerCase(),
        );
        if (other !== undefined)
          return `${shownPath(path.join(root, other), home)} is here already, named the same in other case`;
      }
    }
    // A server whose definition here holds a key cannot go to Cloud, and Cloud's would lose that key for good.
    if (item.kind === "server" && local?.held !== undefined)
      return "its definition here holds a key, so it stays as it is";
    if (item.kind === "install") {
      if ((remote?.value as ProfileInstall | undefined)?.cloud === "mac_only")
        return "it is in a folder on another of your computers";
      if ((local?.value as ProfileInstall | undefined)?.cloud === "mac_only")
        return "it is in a folder on this Mac";
    }
    return undefined;
  };
}

/** A folder's files by path, without .git or node_modules: what a copy in the trash keeps. */
const filesIn = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) out.push(name);
    }
  };
  try {
    walk("");
  } catch {
    // Unreadable: nothing more to keep.
  }
  return out;
};

const shownPath = (file: string, home: string) =>
  home !== "/" && file.startsWith(`${home}${path.sep}`)
    ? `~/${path.relative(home, file).split(path.sep).join("/")}`
    : file;
const listNames = (dir: string) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Where a skill of `source` lives here: the root its computer had it in (an import goes to ~/.agents/skills). */
function rootFor(
  source: ProfileSkill["source"] | undefined,
  homes: ProfileInput["homes"],
  home: string,
): string {
  const roots = skillRoots(homes, home);
  return (roots.find((r) => r.source === source) ?? roots.find((r) => r.source === "agents-home"))!
    .dir;
}

// ------------------------------------------------------------ writing Cloud's changes here

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Keeps a copy of `files` (paths inside `folder`) in the trash; answers where. */
function keepCopy(
  stateDir: string,
  folder: string,
  name: string,
  files: ReadonlyArray<string>,
): string {
  const into = path.join(trashDir(stateDir), `${stamp()}-${name}`);
  for (const rel of files) {
    const from = path.join(folder, ...rel.split("/"));
    const to = path.join(into, ...rel.split("/"));
    try {
      if (!fs.lstatSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to);
    } catch {
      // A file that went meanwhile has nothing to keep.
    }
  }
  return into;
}

/** Moves a whole folder (or the link that names it) to the trash; answers where. */
function moveToTrash(stateDir: string, folder: string, name: string): string {
  const into = path.join(trashDir(stateDir), `${stamp()}-${name}`);
  fs.mkdirSync(path.dirname(into), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(folder, into);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(folder, into, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return into;
}

/** Writes `content` at `rel` inside `root` without following a link anywhere on the way; a temp file renamed in place. */
function writeInside(root: string, rel: string, content: string, mode: number) {
  const parts = rel.split("/");
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(at);
    } catch {
      st = undefined;
    }
    if (st === undefined) fs.mkdirSync(at, { mode: 0o755 });
    else if (!st.isDirectory()) throw new Error(`${rel}: ${part} is not a folder here`);
  }
  const target = path.join(at, parts.at(-1)!);
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error(`${rel} is not a plain file here`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = path.join(at, `.${parts.at(-1)}.caveman-sync-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, content, { mode, flag: "wx" });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

const writeSkill = (folder: string, skill: ProfileSkill) => {
  const helpers = executableFiles(skill);
  for (const file of skill.files) {
    if (file.path === EXECUTABLE_MANIFEST || !writableSkillFile(file.path)) continue;
    writeInside(folder, file.path, file.content, helpers.has(file.path) ? 0o755 : 0o644);
  }
};

/**
 * Writes one skill take: a new folder in its source's root (made aside, then renamed in), a change in place (only
 * the files that sync are replaced or removed; the rest stay), or a removal of the whole folder. What was here goes
 * to the trash first. Answers where the trash copy is, if any.
 */
export function applySkillTake(input: {
  take: Take;
  folders: ReadonlyMap<string, SkillFolder>;
  homes: ProfileInput["homes"];
  home: string;
  stateDir: string;
  scrubber: Scrubber;
}): string | undefined {
  const { take } = input;
  const name = (take.to ?? take.from)!.id;
  const folder = input.folders.get(name);
  if (take.to === undefined) {
    if (folder === undefined) return undefined;
    // A link to the folder in another home root (npx skills' layout): the folder goes, then the link.
    const kept = moveToTrash(input.stateDir, folder.real, name);
    if (folder.real !== folder.folder) fs.rmSync(folder.folder, { force: true });
    return kept;
  }
  const skill = take.to.value as ProfileSkill;
  if (folder === undefined) {
    const root = rootFor(skill.source, input.homes, input.home);
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, name);
    let there: fs.Stats | undefined;
    try {
      there = fs.lstatSync(target);
    } catch {
      there = undefined;
    }
    if (there !== undefined && !there.isDirectory())
      throw new Error(
        `${shownPath(target, input.home)} is a link or a file here, so nothing is written there`,
      );
    if (there !== undefined) {
      // A folder of that name without a SKILL.md: written into, what it had kept.
      const kept = keepCopy(input.stateDir, target, name, filesIn(target));
      writeSkill(target, skill);
      return kept;
    }
    const aside = path.join(root, `.${name}.caveman-sync-${process.pid}`);
    fs.rmSync(aside, { recursive: true, force: true });
    fs.mkdirSync(aside, { mode: 0o755 });
    writeSkill(aside, skill);
    fs.renameSync(aside, target);
    return undefined;
  }
  // The folder itself, never a link (blockedHere keeps Cloud's out of one that leads outside the home skill roots).
  const dir = folder.real;
  const read = readSkill(dir, input.scrubber);
  const synced =
    typeof read === "string"
      ? []
      : read.files.map((f) => f.path).filter((p) => p !== EXECUTABLE_MANIFEST);
  const kept = keepCopy(
    input.stateDir,
    dir,
    name,
    typeof read === "string" ? filesIn(dir) : synced,
  );
  const next = new Set(skill.files.map((f) => f.path));
  for (const rel of synced) {
    if (next.has(rel)) continue;
    const file = path.join(dir, ...rel.split("/"));
    try {
      if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    } catch {
      // Gone already.
    }
  }
  writeSkill(dir, skill);
  return kept;
}

/** Trash older than 30 days goes. */
export function pruneTrash(stateDir: string, now = Date.now()) {
  const dir = trashDir(stateDir);
  for (const entry of listNames(dir)) {
    try {
      if (now - fs.lstatSync(path.join(dir, entry)).mtimeMs > 30 * 24 * 3600_000)
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/** A marketplace or server another computer removed: the registry removes it here (and revokes what was granted to it). */
export interface Removal {
  readonly kind: "marketplace" | "server";
  readonly name: string;
  readonly key: string;
  readonly url?: string;
}

/** The settings lists an item of `kind` lives in: a change to them since a sync read them is a change made here meanwhile. */
export const listsOf = (
  kind: SyncItem["kind"],
  plugins: Pick<
    PluginSettings,
    "installed" | "marketplaces" | "spaces" | "servers" | "trusted" | "disabled"
  >,
): unknown =>
  kind === "install"
    ? [plugins.installed, plugins.disabled]
    : kind === "space"
      ? [plugins.marketplaces, plugins.spaces]
      : kind === "server"
        ? plugins.servers
        : kind === "trust"
          ? plugins.trusted
          : undefined;

/**
 * Plugin settings with Cloud's installs, marketplaces, servers and trust written in. A marketplace another computer
 * added comes as a space the registry checks out (migrateSpaces), off, so it installs nothing by itself: the installs
 * come as their own items. A server keeps this Mac's own consent. Removals of marketplaces and servers are left to
 * `remove` (the registry revokes what was granted to them).
 */
export function settingsWith(
  plugins: Pick<
    PluginSettings,
    "installed" | "marketplaces" | "spaces" | "servers" | "trusted" | "disabled"
  >,
  takes: ReadonlyArray<Take>,
): {
  readonly plugins: Pick<
    PluginSettings,
    "installed" | "marketplaces" | "spaces" | "servers" | "trusted" | "disabled"
  >;
  readonly remove: ReadonlyArray<Removal>;
} {
  let { installed, marketplaces, spaces, servers, trusted, disabled } = plugins;
  const remove: Removal[] = [];
  for (const take of takes) {
    const id = (take.to ?? take.from)!.id;
    switch ((take.to ?? take.from)!.kind) {
      case "install": {
        const to = take.to?.value as ProfileInstall | undefined;
        if (to === undefined) {
          installed = installed.filter((i) => i.id !== id);
          break;
        }
        const next: PluginInstall = {
          id,
          ...(to.version === undefined ? {} : { version: to.version }),
          ...(to.url !== undefined && to.commit !== undefined
            ? {
                source: { url: to.url, ...(to.path === undefined ? {} : { path: to.path }) },
                commit: to.commit,
              }
            : {}),
          enabled: to.enabled !== false,
        };
        installed = installed.some((i) => i.id === id)
          ? installed.map((i) => (i.id === id ? next : i))
          : [...installed, next];
        if (next.enabled) disabled = disabled.filter((d) => d !== id);
        break;
      }
      case "space": {
        const to = take.to?.value as ProfileSpace | undefined;
        const market = marketplaces.find((m) => m.source.kind === "git" && m.source.url === id);
        if (to === undefined) {
          // The registry's removal either way (it takes a space not checked out yet by its id): grants go with it.
          if (market !== undefined)
            remove.push({ kind: "marketplace", name: market.name, key: take.key, url: id });
          else if (spaces.some((s) => s.url === id))
            remove.push({ kind: "marketplace", name: spaceIdFor(id), key: take.key, url: id });
          break;
        }
        const ref = to.ref === undefined ? {} : { ref: to.ref };
        if (market !== undefined && market.source.kind === "git") {
          const { ref: _ref, ...source } = market.source;
          marketplaces = marketplaces.map((m) =>
            m === market ? { ...m, source: { ...source, ...ref, commit: to.commit } } : m,
          );
        } else if (spaces.some((s) => s.url === id))
          spaces = spaces.map((s) =>
            s.url === id
              ? {
                  url: id,
                  commit: to.commit,
                  ...ref,
                  enabled: false,
                  ...(s.granted ? { granted: s.granted } : {}),
                }
              : s,
          );
        else spaces = [...spaces, { url: id, commit: to.commit, ...ref, enabled: false }];
        break;
      }
      case "server": {
        const to = take.to?.value as ProfileServer | undefined;
        if (to === undefined) {
          remove.push({ kind: "server", name: id, key: take.key });
          break;
        }
        const own = servers.find((s) => s.name === id);
        const next = {
          ...serverCore(to),
          ...(own?.cloudConsent === true ? { cloudConsent: true } : {}),
        } as PluginServer;
        servers =
          own === undefined ? [...servers, next] : servers.map((s) => (s === own ? next : s));
        break;
      }
      case "trust": {
        const to = take.to?.value as { id: string; digest: string } | undefined;
        trusted = [
          ...trusted.filter((e) => e.split("#")[0] !== id),
          ...(to === undefined ? [] : [`${id}#${to.digest}`]),
        ];
        break;
      }
      default:
        break;
    }
  }
  return { plugins: { installed, marketplaces, spaces, servers, trusted, disabled }, remove };
}
