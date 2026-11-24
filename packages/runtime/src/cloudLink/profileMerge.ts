// One profile for every computer a person uses. Each Mac reads its own side (skills,
// installs, marketplaces, personal servers, hook trust) and Cloud's, and merges them one item at a time against what
// it last agreed with Cloud, the way VS Code's Settings Sync does. Nothing here touches a disk or the network.
//
// For every item the merge knows two bases: what this computer had (`l`) and what Cloud had (`r`) the last time they
// agreed. A side that differs from its base changed:
//
// - only here: it goes to Cloud (a removal too);
// - only in Cloud: this computer takes it (a removal too), unless it cannot hold it (a linked skill folder, a plugin
//   in a folder on another Mac), when it keeps its own and says why;
// - in both, the same way: nothing to do;
// - in both, differently: an edit beats a removal; two edits keep Cloud's, as the person's other settings do (Caveman
//   Cloud an edit made while another device changed the key loses to that change), and the one replaced
//   here goes to the sync trash.
//
// With no common past (a first sync, another account, a profile of another lineage or from an older app) nothing is
// a removal: both sides are added together, and where both have an item with other content, a skill or a server
// stays as each has it (files and definitions the person wrote are never replaced unasked); for the rest Cloud's wins.
//
// A computer that only sends (Cloud without conditional writes: two computers could write at once, so a removal in
// Cloud may be one computer's write lost to another's) takes nothing and puts back what it still has.
import { createHash } from "node:crypto";
import * as path from "node:path";

import { holdsCredential, serverProblem } from "../plugins/personal.ts";
import { COMMIT } from "../plugins/spaces.ts";
import {
  canonicalJson,
  GIT_URL,
  KEY_FILE,
  MAX_ITEMS,
  MAX_NAMES,
  MAX_PROFILE_BYTES,
  MAX_SKILLS,
  SKILL_NAME,
  text,
  type Profile,
  type ProfileInstall,
  type ProfileServer,
  type ProfileSkill,
  type ProfileSpace,
} from "./profile.ts";

export type SyncKind = "skill" | "install" | "space" | "server" | "trust" | "disabled" | "consent";

/** One item of a profile: its kind and id, a digest of what syncs (never a field derived from where it is), and its profile entry. */
export interface SyncItem {
  readonly key: string;
  readonly kind: SyncKind;
  readonly id: string;
  readonly digest: string;
  readonly value: unknown;
}

/** This computer's side of an item. `held`: it is here but cannot go to Cloud as it is (the merge keeps Cloud's). */
export interface LocalItem extends SyncItem {
  readonly held?: string;
}

/**
 * What this computer (`l`) and Cloud (`r`) had when they last agreed on the item. `x`: they disagree on purpose (a
 * same-named skill or server each wrote, a linked folder): neither side's change crosses until both hold the same.
 */
export interface Base {
  readonly l?: string;
  readonly r?: string;
  readonly x?: true;
}

/** Cloud's version of an item to write here: `to` undefined removes it. */
export interface Take {
  readonly key: string;
  readonly to: SyncItem | undefined;
  readonly from: LocalItem | undefined;
  /** It replaces an edit made here (two edits at once): what is here goes to the trash and the person is told. */
  readonly conflict: boolean;
}

export const keyOf = (kind: SyncKind, id: string) => `${kind}:${id}`;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const isString = (v: unknown): v is string => typeof v === "string";
const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// ------------------------------------------------------------ items

/** What of a server syncs: its definition, without where it runs (derived) or this computer's consent (its own). */
export const serverCore = (server: Partial<ProfileServer>) => {
  const { cloud: _cloud, cloudReason: _reason, cloudConsent: _consent, ...core } = server;
  // Cloud keeps no `cursor` source (profiles.go serverSources): an import from Cursor syncs as one added by hand.
  return {
    ...core,
    source: core.source === undefined || core.source === "cursor" ? "manual" : core.source,
    enabled: core.enabled !== false,
  };
};

/** The digest of an item's synced content. Two computers that hold the same thing compute the same one. */
export function digestOf(kind: SyncKind, value: unknown): string {
  switch (kind) {
    case "skill": {
      const files = [...((value as ProfileSkill).files ?? [])].map((f) => ({
        path: f.path,
        content: f.content,
      }));
      return hash({
        files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      });
    }
    case "install": {
      const i = value as ProfileInstall;
      return hash({
        id: i.id,
        version: i.version,
        url: i.url,
        commit: i.commit,
        path: i.path,
        enabled: i.enabled !== false,
        folder: i.cloud === "mac_only",
      });
    }
    case "space": {
      const s = value as ProfileSpace;
      return hash({ url: s.url, commit: s.commit, ref: s.ref });
    }
    case "server":
      return hash(serverCore(value as ProfileServer));
    case "trust":
      return hash(value);
    case "disabled":
    case "consent":
      return "on";
  }
}

const item = (kind: SyncKind, id: string, value: unknown): SyncItem => ({
  key: keyOf(kind, id),
  kind,
  id,
  digest: digestOf(kind, value),
  value,
});

/** A skill a computer may write: a name Cloud keeps, a SKILL.md, and relative paths that stay inside it. */
export function skillProblem(skill: Partial<ProfileSkill>): string | undefined {
  if (!isString(skill.name) || !SKILL_NAME.test(skill.name) || skill.name.includes(".."))
    return "its name is not a skill name";
  const files: ReadonlyArray<Partial<{ path: unknown; content: unknown }> | undefined> =
    Array.isArray(skill.files) ? skill.files : [];
  if (!files.some((f) => f?.path === "SKILL.md")) return "it has no SKILL.md";
  const bad = files.find((f) => {
    if (!isString(f?.path) || !isString(f.content)) return true;
    const p = f.path;
    // Never a repository's own folder or installed packages: a `.git/config` or hook written there could run a command.
    return (
      path.posix.isAbsolute(p) ||
      p.includes("\\") ||
      p.includes("\0") ||
      p
        .split("/")
        .some(
          (s: string) =>
            s === ".." || s === "" || s === "." || s === ".git" || s === "node_modules",
        )
    );
  });
  return bad === undefined ? undefined : "a file's path leaves the skill";
}

/**
 * A profile as items, one per synced thing. What Cloud sent is checked again: an entry a computer could not hold (a
 * URL with a credential, a skill path that leaves its folder) is left out, as applyProfile does.
 */
export function itemsOf(profile: Profile | undefined): Map<string, SyncItem> {
  const out = new Map<string, SyncItem>();
  const add = (entry: SyncItem) => {
    if (!out.has(entry.key)) out.set(entry.key, entry);
  };
  const p = profile?.plugins;
  for (const space of (Array.isArray(p?.spaces) ? p.spaces : []) as ReadonlyArray<
    Partial<ProfileSpace>
  >) {
    if (
      !isString(space?.url) ||
      !GIT_URL.test(space.url) ||
      !text(space.url) ||
      !isString(space.commit) ||
      !COMMIT.test(space.commit) ||
      holdsCredential([space.url])
    )
      continue;
    add(
      item("space", space.url, {
        url: space.url,
        commit: space.commit,
        ...(isString(space.ref) && space.ref !== "" ? { ref: space.ref } : {}),
        enabled: true,
      }),
    );
  }
  for (const raw of (Array.isArray(p?.installed) ? p.installed : []) as ReadonlyArray<
    Partial<ProfileInstall>
  >) {
    if (
      !isString(raw?.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.id)
    )
      continue;
    if (raw.cloud === "mac_only") {
      add(
        item("install", raw.id, {
          id: raw.id,
          cloud: "mac_only",
          cloudReason: isString(raw.cloudReason) ? raw.cloudReason : undefined,
        }),
      );
      continue;
    }
    const remote = isString(raw.url) && isString(raw.commit);
    if (
      remote &&
      (!GIT_URL.test(raw.url!) || !COMMIT.test(raw.commit!) || holdsCredential([raw.url!]))
    )
      continue;
    if (
      isString(raw.path) &&
      (path.posix.isAbsolute(raw.path) || raw.path.split("/").some((s) => s === ".." || s === ""))
    )
      continue;
    const install: ProfileInstall = {
      id: raw.id,
      ...(isString(raw.version) ? { version: raw.version } : {}),
      ...(remote
        ? { url: raw.url!, commit: raw.commit!, ...(isString(raw.path) ? { path: raw.path } : {}) }
        : {}),
      enabled: raw.enabled !== false,
      cloud: "runs",
    };
    add(item("install", raw.id, install));
  }
  for (const t of (Array.isArray(p?.trustedHooks) ? p.trustedHooks : []) as ReadonlyArray<{
    id?: unknown;
    digest?: unknown;
  }>) {
    if (
      !isString(t?.id) ||
      !isString(t.digest) ||
      !/^[0-9a-f]{64}$/.test(t.digest) ||
      t.id.includes("#")
    )
      continue;
    add(item("trust", t.id, { id: t.id, digest: t.digest }));
  }
  for (const id of (Array.isArray(p?.disabled) ? p.disabled : []) as ReadonlyArray<unknown>)
    if (isString(id) && text(id)) add(item("disabled", id, id));
  for (const raw of (Array.isArray(p?.servers) ? p.servers : []) as ReadonlyArray<
    Partial<ProfileServer>
  >) {
    if (!isString(raw?.name)) continue;
    const server = raw as ProfileServer;
    const argv = [
      ...(isString(server.command) ? [server.command] : []),
      ...(Array.isArray(server.args) ? server.args.filter(isString) : []),
      ...(isString(server.url) ? [server.url] : []),
    ];
    if (serverProblem(server) !== undefined || holdsCredential(argv)) continue;
    const { cloudConsent, ...rest } = server;
    add(item("server", server.name, rest));
    if (cloudConsent === true) add(item("consent", server.name, server.name));
  }
  for (const skill of (Array.isArray(profile?.skills) ? profile.skills : []) as ReadonlyArray<
    Partial<ProfileSkill>
  >) {
    if (skillProblem(skill) !== undefined) continue;
    const files = skill.files!.map((f) => ({ path: f.path, content: f.content }));
    add(item("skill", skill.name!, { name: skill.name, source: skill.source, files }));
  }
  return out;
}

/** A held item's digest: its content's when known, so the same thing held here and pushed elsewhere agree. */
export const heldItem = (
  kind: SyncKind,
  id: string,
  reason: string,
  content: unknown,
  fingerprint?: string,
): LocalItem => ({
  key: keyOf(kind, id),
  kind,
  id,
  digest: content === undefined ? `held:${fingerprint ?? ""}` : digestOf(kind, content),
  value: content,
  held: reason,
});

/** The items as a profile: every list sorted by id, so equal items are equal bytes on every computer. */
export function assemble(
  items: ReadonlyMap<string, SyncItem>,
  lineage: string | undefined,
): Profile {
  const of = (kind: SyncKind) => [...items.values()].filter((i) => i.kind === kind).sort(byId);
  const consent = new Set(of("consent").map((i) => i.id));
  return {
    version: lineage === undefined ? 2 : 3,
    ...(lineage === undefined ? {} : { lineage }),
    plugins: {
      spaces: of("space").map((i) => i.value as ProfileSpace),
      disabled: of("disabled").map((i) => i.id),
      servers: of("server").map((i) => ({
        ...(i.value as ProfileServer),
        ...(consent.has(i.id) ? { cloudConsent: true } : {}),
      })),
      installed: of("install").map((i) => i.value as ProfileInstall),
      trustedHooks: of("trust").map((i) => i.value as { id: string; digest: string }),
    },
    skills: of("skill").map((i) => i.value as ProfileSkill),
  };
}

// ------------------------------------------------------------ merge

export interface MergeInput {
  readonly local: ReadonlyMap<string, LocalItem>;
  readonly remote: ReadonlyMap<string, SyncItem>;
  readonly bases: ReadonlyMap<string, Base>;
  /** No common past with Cloud's profile: nothing is a removal. */
  readonly fresh: boolean;
  /** This computer takes Cloud's changes; otherwise it only sends (and puts back what Cloud lost). */
  readonly apply: boolean;
  /** Why Cloud's version cannot be written here; undefined when it can. */
  readonly blocked: (
    remote: SyncItem | undefined,
    local: LocalItem | undefined,
  ) => string | undefined;
  /** The merged profile's lineage (v3); undefined writes v2. */
  readonly lineage: string | undefined;
  /** Cloud's caps; tests make them small. */
  readonly maxBytes?: number;
}

export interface MergeResult {
  readonly profile: Profile;
  readonly merged: ReadonlyMap<string, SyncItem>;
  readonly takes: ReadonlyArray<Take>;
  /** What the person is told, per key: a conflict, something kept here, something held back. */
  readonly notes: ReadonlyMap<string, string>;
  /** The bases once every take is written here and Cloud holds `profile`. */
  readonly bases: ReadonlyMap<string, Base>;
}

/** Kinds that are this computer's own or derived here: Cloud's version of them is never written here. */
const NEVER_TAKEN = new Set<SyncKind>(["disabled", "consent"]);
/** Kinds whose differing content stays as each side has it at a first sync: what the person wrote. */
const AUTHORED = new Set<SyncKind>(["skill", "server"]);
const APART =
  "another of your computers has one of this name with other content; each keeps its own until they match or you rename one";
/** More removals of skills than this in one sync wait for the person (a wiped folder on one Mac never empties the others). */
export const MAX_SKILL_REMOVALS = 10;

export function merge(input: MergeInput): MergeResult {
  const merged = new Map<string, SyncItem>();
  const takes: Take[] = [];
  const notes = new Map<string, string>();
  const bases = new Map<string, Base>();
  /** Keys whose merged value is this computer's: what the caps may hold back. */
  const ours = new Set<string>();
  const keys = [
    ...new Set([
      ...input.local.keys(),
      ...input.remote.keys(),
      ...(input.fresh ? [] : input.bases.keys()),
    ]),
  ].sort();
  const base = (key: string): Base => (input.fresh ? {} : (input.bases.get(key) ?? {}));
  const keep = (
    key: string,
    R: SyncItem | undefined,
    L: LocalItem | undefined,
    note?: string,
    apart = false,
  ) => {
    if (R !== undefined) merged.set(key, R);
    bases.set(key, {
      ...(L ? { l: L.digest } : {}),
      ...(R ? { r: R.digest } : {}),
      ...(apart && L !== undefined && R !== undefined && L.digest !== R.digest
        ? { x: true as const }
        : {}),
    });
    if (note !== undefined) notes.set(key, note);
  };
  const push = (key: string, R: SyncItem | undefined, L: LocalItem | undefined) => {
    if (L?.held !== undefined) return keep(key, R, L, L.held);
    if (L !== undefined) {
      merged.set(key, L);
      ours.add(key);
    }
    bases.set(key, L ? { l: L.digest, r: L.digest } : {});
  };
  const take = (
    key: string,
    R: SyncItem | undefined,
    L: LocalItem | undefined,
    conflict: boolean,
    note?: string,
  ) => {
    const kind = (R ?? L)!.kind;
    const why = NEVER_TAKEN.has(kind) ? "" : input.apply ? input.blocked(R, L) : "";
    // Cloud's cannot be written here: each side keeps its own, and neither's later change crosses until they match.
    if (why !== undefined)
      return keep(key, R, L, why === "" ? undefined : `kept as it is here: ${why}`, why !== "");
    if (R !== undefined) merged.set(key, R);
    takes.push({ key, to: R, from: L, conflict });
    bases.set(key, R ? { l: R.digest, r: R.digest } : {});
    if (note !== undefined) notes.set(key, note);
  };
  for (const key of keys) {
    const L = input.local.get(key);
    const R = input.remote.get(key);
    const b = base(key);
    const lc = L?.digest !== b.l;
    const rc = R?.digest !== b.r;
    const kind = (R ?? L)?.kind;
    if (kind === undefined) continue;
    if (
      !input.fresh &&
      b.x === true &&
      L !== undefined &&
      R !== undefined &&
      L.digest !== R.digest
    ) {
      // Apart on purpose: each keeps its own until both hold the same (or one side's goes).
      const why = input.apply ? input.blocked(R, L) : undefined;
      keep(key, R, L, why !== undefined ? `kept as it is here: ${why}` : APART, true);
    } else if (!input.fresh && b.x === true) {
      // Back in step, or one side's copy went: from here on as any other item. Cloud's went: this Mac's goes up.
      if (R === undefined && L !== undefined) push(key, R, L);
      else keep(key, R, L);
    } else if (!lc && !rc) {
      keep(key, R, L);
    } else if (lc && !rc) {
      push(key, R, L);
    } else if (!lc && rc) {
      if (L?.digest === R?.digest) keep(key, R, L);
      // Only sending: a removal in Cloud may be another computer's write that lost this one's, so what is here goes back.
      else if (!input.apply && R === undefined && L !== undefined) push(key, R, L);
      else if (!input.apply) keep(key, R, L);
      else take(key, R, L, false);
    } else if (L?.digest === R?.digest) {
      keep(key, R, L);
    } else if (L?.held !== undefined && input.fresh) {
      keep(key, R, L, L.held);
    } else if (input.fresh) {
      // Both sides have it, with other content, and no common past.
      if (AUTHORED.has(kind)) keep(key, R, L, APART, true);
      else take(key, R, L, false);
    } else if (L === undefined) {
      // Removed here, changed elsewhere: the change wins.
      take(
        key,
        R,
        L,
        false,
        "changed on another of your computers after you removed it here, so it is back",
      );
    } else if (R === undefined) {
      push(key, R, L);
    } else {
      take(
        key,
        R,
        L,
        true,
        kind === "skill"
          ? "changed here and on another of your computers at once: kept the other computer's, and this Mac's is in the sync trash"
          : "changed here and on another of your computers at once: kept the other computer's",
      );
    }
  }

  // A wiped skills folder on one computer never empties the others: many removals at once wait for the person.
  const removals = takes.filter((t) => t.to === undefined && t.from?.kind === "skill");
  const skillsHere = [...input.local.values()].filter((i) => i.kind === "skill").length;
  if (
    removals.length > MAX_SKILL_REMOVALS ||
    (removals.length > 3 && removals.length * 2 > skillsHere)
  ) {
    for (const t of removals) {
      takes.splice(takes.indexOf(t), 1);
      keep(
        t.key,
        undefined,
        t.from,
        `${removals.length} skills were removed on another of your computers at once, so this Mac kept them: remove them here too if you meant to`,
      );
    }
  }

  // Cloud's caps: what this computer adds or changes is held back first, the largest skill first; Cloud's stays.
  const capped = (key: string, why: string) => {
    const R = input.remote.get(key);
    if (R === undefined) merged.delete(key);
    else merged.set(key, R);
    ours.delete(key);
    // Its base stays where it was, so it goes once there is room.
    const b = base(key);
    bases.set(key, { ...(b.l === undefined ? {} : { l: b.l }), ...(R ? { r: R.digest } : {}) });
    notes.set(key, why);
  };
  const countOver = (kind: SyncKind, max: number, why: string) => {
    const all = [...merged.values()].filter((i) => i.kind === kind);
    let over = all.length - max;
    for (const i of all
      .filter((x) => ours.has(x.key) && !input.remote.has(x.key))
      .sort(byId)
      .reverse()) {
      if (over <= 0) break;
      capped(i.key, why);
      over--;
    }
  };
  countOver("skill", MAX_SKILLS, `only ${MAX_SKILLS} skills sync`);
  countOver("space", MAX_ITEMS, `only ${MAX_ITEMS} marketplaces sync`);
  countOver("server", MAX_ITEMS, `only ${MAX_ITEMS} servers sync`);
  for (const kind of ["install", "trust", "disabled"] as const)
    countOver(kind, MAX_NAMES, `only ${MAX_NAMES} sync`);
  const max = input.maxBytes ?? MAX_PROFILE_BYTES;
  let profile = assemble(merged, input.lineage);
  let size = Buffer.byteLength(JSON.stringify(profile));
  if (size > max) {
    const bytes = (i: SyncItem) => Buffer.byteLength(JSON.stringify(i.value)) + 1;
    const mine = [...merged.values()]
      .filter((i) => i.kind === "skill" && ours.has(i.key))
      .sort((a, b) => bytes(b) - bytes(a) || byId(b, a));
    for (const i of mine) {
      if (size <= max) break;
      const R = input.remote.get(i.key);
      size -= bytes(i) - (R === undefined ? 0 : bytes(R));
      capped(i.key, "over the 2 MiB profile cap: the largest skills are left out first");
    }
    profile = assemble(merged, input.lineage);
  }
  return { profile, merged, takes, notes, bases };
}

/** A take is a skill file a computer writes only under these rules: never a key file, never the manifest. */
export const writableSkillFile = (file: string) => !KEY_FILE.test(path.posix.basename(file));
