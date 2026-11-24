// What This Mac keeps in step with Caveman Cloud while signed in, and what a
// Cloud computer takes from it (docs/,
// TRUST + SECURITY).
//
// - The profile (profile.ts: settings, server definitions, skill text, no
//   values) is one for every computer the person uses, and syncs by itself:
//   each Mac merges its side into Cloud's (profileMerge.ts) and takes the other
//   computers' changes (profileSync.ts), on sign-in, two seconds after a change
//   to Settings or a home skill folder, when a look every 20 s finds Cloud's
//   changed, and every five minutes; retried with backoff; never in the way of
//   anything else. A Cloud without shared writes gets merges from each Mac and
//   writes nothing into any.
// - Secret values never leave by themselves. A repository's secrets go only
//   once the person turned "Available on Cloud computers" on for it
//   (cloud.secrets.set_available), and then follow every change; a personal
//   server's granted keys go only once it is turned on for that server
//   (cloud.server.set_available, its cloudConsent). Turning either off deletes
//   the Cloud copies at once. A repository that is not opted in is never
//   named in any request to Cloud.
// - A Cloud computer pulls the profile and the org's Spaces before its first
//   session, every minute and at each session start, and keeps the last good
//   one when a pull fails.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isReservedEnvName, type SecretEntry } from "@caveman-app/session-protocol";
import type { PluginServer, PluginSettings } from "@caveman-app/protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { CLOUD_SERVERS_REPOSITORY, cloudCredentialName, CredentialBroker } from "../plugins/CredentialBroker.ts";
import { PERSONAL_SPACE_URL, serverCredentials } from "../plugins/personal.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { PluginSettingsLock, ServerSettingsService } from "../serverSettings.ts";
import { setupHomes } from "../session-protocol/setupScan.ts";
import { call } from "./computers.ts";
import type { AccountConnector, AccountCredential, ResolvedSecret } from "./accountCredentials.ts";
import { connectionLabel } from "./connections.ts";
import { isEngineKeyName } from "./engineKeys.ts";
import { CloudError, readIdentity, refused, type Identity } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf, type LinkState } from "./index.ts";
import { applyProfile, canonicalJson, onPathOf, profileDigest, profileSkillsDir, skillRoots, writeProfileSkills, type Profile, type ProfileItem } from "./profile.ts";
import { itemsOf, merge, type Base } from "./profileMerge.ts";
import { applySkillTake, blockedHere, LINEAGE, listsOf, localSide, newLineage, pruneTrash, readSyncFile, settingsWith, trashDir, withHeldSpaces, writeSyncFile, type SyncMode } from "./profileSync.ts";

export interface ProfileStatus {
  state: "off" | "pending" | "ok" | "error" | "paused";
  /** two_way: this Mac sends and takes the profile every computer shares; push_only: an older Cloud, so it only sends. */
  mode?: "two_way" | "push_only";
  /** Where what a sync replaced or removed here is kept (30 days). */
  trash?: string;
  /** The last sync that brought another computer's changes here, and how many. */
  received_at?: string;
  received?: number;
  /** Opted-in server keys that did not go to Cloud, and why. */
  keys_error?: string;
  /** Commands beside the MCP servers can read their keys (session-protocol/cloudSync.ts serverKeysShared). */
  server_keys_shared?: true;
  synced_at?: string;
  error?: string;
  digest?: string;
  items: ReadonlyArray<ProfileItem>;
}

/** The sync's state, shared by its loop and the Session Protocol handlers (one per runtime, like CloudLinkState). */
export interface SyncState {
  status: ProfileStatus;
  /** Push or pull now (the loop is running). */
  wake?: (() => void) | undefined;
  /** On a Cloud computer: the first pull (bounded), and a fresh pull for each later session. */
  beforeSession?: (() => Promise<void>) | undefined;
  /** This Mac's one sync (macSync): the loop and the Session Protocol handlers share it. */
  mac?: unknown;
  /** The plugin registry's own removals (they revoke what was granted), set by the registry; settings alone without one. */
  removals?: { readonly marketplace: (name: string) => Effect.Effect<void, unknown>; readonly server: (name: string) => Effect.Effect<void, unknown> };
}
export class CloudSyncState extends Context.Reference<SyncState>("caveman/cloudLink/SyncState", {
  defaultValue: () => ({ status: { state: "off", items: [] } }),
}) {}

// ------------------------------------------------------------ This Mac's choices (names only)

/** Which repositories and whether server keys are opted in: names, never values, beside the link. */
interface Choices {
  /** Whose yes these are (ownerOf): another account, org or Cloud starts from no. */
  owner?: string;
  repositories: string[];
  /** Repositories only some of whose names are opted in (Add from this Mac), and those names. */
  names?: Record<string, string[]>;
  /** Server keys were uploaded and may still be in Cloud. */
  serverKeys?: boolean;
  /** The person removed the profile from Cloud: it stays off until cloud.profile.sync. */
  paused?: boolean;
}
const choicesFile = (stateDir: string) => path.join(stateDir, "cloud-sync.json");
export const readChoices = (stateDir: string): Choices => {
  try {
    const raw = JSON.parse(fs.readFileSync(choicesFile(stateDir), "utf8")) as Partial<Choices>;
    const names = Object.fromEntries(
      Object.entries(typeof raw.names === "object" && raw.names !== null ? raw.names : {}).map(([repo, list]) => [repo, Array.isArray(list) ? list.filter((n) => typeof n === "string") : []]),
    );
    return {
      ...(typeof raw.owner === "string" ? { owner: raw.owner } : {}),
      repositories: Array.isArray(raw.repositories) ? raw.repositories.filter((r) => typeof r === "string") : [],
      names,
      serverKeys: raw.serverKeys === true,
      paused: raw.paused === true,
    };
  } catch {
    return { repositories: [] };
  }
};
/** Every repository with something opted in, whole or by name. */
export const optedIn = (choices: Choices) => [...new Set([...choices.repositories, ...Object.keys(choices.names ?? {}).filter((r) => (choices.names?.[r]?.length ?? 0) > 0)])];
/** What of `repository` goes to Cloud: every name, the names opted in one by one, or none. */
const wanted = (choices: Choices, repository: string): "all" | ReadonlySet<string> =>
  choices.repositories.includes(repository) ? "all" : new Set(choices.names?.[repository] ?? []);
const withoutNames = (names: Choices["names"], repository: string) => Object.fromEntries(Object.entries(names ?? {}).filter(([r]) => r !== repository));
/** The Cloud account a yes was given to: Cloud, org and person (the runtime when Cloud named no person). */
export const ownerOf = (id: Identity) => [id.cloudUrl, id.organizationId, id.userId ?? id.runtimeId].join("\0");
/** The choices made for `id`'s account; none for another account (or when signed out). */
export const choicesFor = (stateDir: string, id: Identity | undefined): Choices => {
  const choices = readChoices(stateDir);
  return id !== undefined && choices.owner === ownerOf(id) ? choices : { repositories: [] };
};

export const writeChoices = (stateDir: string, change: (choices: Choices) => Choices) => {
  const next = change(readChoices(stateDir));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(`${choicesFile(stateDir)}.tmp`, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(`${choicesFile(stateDir)}.tmp`, choicesFile(stateDir));
  return next;
};

// ------------------------------------------------------------ Cloud calls

const q = encodeURIComponent;
export const listNames = (id: Identity, link: LinkState, repository: string) =>
  call<{ secrets?: Array<{ name: string; updated_at?: string }> }>(id, link, "GET", `secrets?repository=${q(repository)}`).then((out) => out?.secrets ?? []);
const putValues = async (id: Identity, link: LinkState, repository: string, entries: ReadonlyArray<SecretEntry>) => {
  // Cloud takes at most 200 names a request.
  for (let i = 0; i < entries.length; i += 200) await call(id, link, "PUT", "secrets", { repository, secrets: entries.slice(i, i + 200) });
};
const deleteName = (id: Identity, link: LinkState, repository: string, name: string) =>
  call(id, link, "DELETE", `secrets/${q(name)}?repository=${q(repository)}`).catch((error) => {
    if (!(error instanceof CloudError && error.status === 404)) throw error;
  });
/** A computer's resolve: values for the bound person, never cached on disk. */
export const resolveValues = (id: Identity, link: LinkState, repository: string) =>
  call<{ secrets?: SecretEntry[] }>(id, link, "POST", `secrets/resolve?repository=${q(repository)}`, {}).then((out) => out?.secrets ?? []);
/**
 * The same resolve with all it answers: on a service account's computer, `hosts` on a variable and its credentials,
 * or, where its credentials stay outside the computer, only their names (`connectors`, accountCredentials.ts).
 */
export const resolveAll = (id: Identity, link: LinkState, repository: string) =>
  call<{ secrets?: ResolvedSecret[]; credentials?: AccountCredential[]; connectors?: AccountConnector[] }>(id, link, "POST", `secrets/resolve?repository=${q(repository)}`, {}).then((out) => ({
    secrets: out?.secrets ?? [],
    credentials: out?.credentials ?? [],
    connectors: Array.isArray(out?.connectors) ? out.connectors : [],
  }));
type StoredProfile = { profile: Profile; digest: string; updated_at: string };
/**
 * The stored profile; undefined when there is none. With `known` (the digest held now) Cloud answers 304
 * when it is unchanged, and then writes no access-log row: that answers `known` itself.
 */
const getProfile = (id: Identity, link: LinkState, known?: StoredProfile) =>
  call<StoredProfile | undefined>(id, link, "GET", "profile", undefined, fetch, known ? { "if-none-match": `"${known.digest}"` } : {}).then(
    (out) => out ?? known,
    (error) => {
      if (error instanceof CloudError && error.status === 404) return undefined;
      throw error;
    },
  );
const tolerate404 = <T>(promise: Promise<T>, fallback: T) =>
  promise.catch((error) => {
    if (error instanceof CloudError && error.status === 404) return fallback;
    throw error;
  });

/**
 * Makes Cloud's copy of `repository` exactly `entries`: puts every value, deletes the names no longer here.
 * An engine key a Cloud computer keeps under the server keys (engineKeys.ts) is never This Mac's to delete.
 */
async function mirror(id: Identity, link: LinkState, repository: string, entries: ReadonlyArray<SecretEntry>) {
  const there = await listNames(id, link, repository);
  if (entries.length > 0) await putValues(id, link, repository, entries);
  const here = new Set(entries.map((e) => e.name));
  for (const { name } of there) if (!here.has(name) && !(repository === CLOUD_SERVERS_REPOSITORY && isEngineKeyName(name))) await deleteName(id, link, repository, name);
}

/** Deletes every name Cloud holds for `repository`. */
async function dropAll(id: Identity, link: LinkState, repository: string) {
  for (const { name } of await listNames(id, link, repository)) await deleteName(id, link, repository, name);
}

// ------------------------------------------------------------ This Mac

/** Cloud refusals in the words the UI shows; anything else as it came. */
const REASONS: Record<string, string> = {
  cave_code_computer_shared: "this computer also runs another person's work, so it gets no one's settings or secrets",
  cave_code_computer_idle: "this computer has no active workspace yet",
  cave_code_computer_asleep: "this computer is asleep or stopped",
  cave_code_profile_read_only: "a Cloud computer reads your settings; only This Mac changes them",
};
export const errorText = (error: unknown) =>
  error instanceof CloudError && error.code !== undefined && REASONS[error.code] !== undefined
    ? `Caveman refused: ${REASONS[error.code]}`
    : error instanceof Error
      ? error.message
      : String(error);

/** Cloud's names for server keys: an upper-case variable (secrets.go serverSecretName), never a reserved one. */
const CLOUD_VAR = /^[A-Z_][A-Z0-9_]{0,255}$/;
/** How Cloud's GET /runtime/holdings answers (names only). */
interface CloudHoldings {
  readonly profile?: { readonly digest: string; readonly updated_at: string; readonly paused_at?: string } | null;
  readonly repositories?: ReadonlyArray<{ readonly repository: string; readonly names: ReadonlyArray<string>; readonly updated_at?: string }>;
  readonly server_keys?: { readonly names: ReadonlyArray<string>; readonly updated_at?: string } | null;
  readonly connections?: ReadonlyArray<{ readonly connection_id: string; readonly resource?: string; readonly provider?: string; readonly status?: string; readonly updated_at?: string }>;
  readonly github_linked?: boolean;
}
type Holding = { kind: "profile" | "repository_secrets" | "server_keys" | "connection"; id: string; label: string; names: string[]; updated_at?: string };
const PAUSED = "cave_code_profile_paused";
/** A Cloud from before shared profiles refusing v3 (profiles.go's own words): this Mac then only sends. Any other 400 is a refusal. */
const olderCloud = (error: unknown) => error instanceof CloudError && error.status === 400 && /profile\.version is 1 or 2|unknown field "lineage"/.test(error.message);
/** How often This Mac looks whether another computer changed the profile. */
const LOOK_MS = 20_000;

/** Status lines with what a sync has to say about them (a conflict, something kept here), by kind and id. */
function withNotes(lines: ReadonlyArray<ProfileItem>, notes: ReadonlyMap<string, string>): ProfileItem[] {
  const kinds: Partial<Record<string, ProfileItem["kind"]>> = { skill: "skill", install: "plugin", server: "server" };
  return lines.map((line) => {
    for (const [key, note] of notes) {
      const at = key.indexOf(":");
      if (kinds[key.slice(0, at)] !== line.kind || key.slice(at + 1) !== line.id || line.reason?.includes(note)) continue;
      line = { ...line, reason: line.reason === undefined ? note : `${line.reason}; ${note}` };
    }
    return line;
  });
}

/** The Mac side: services the push, the mirrors and the handlers share. One per runtime (CloudSyncState.mac). */
export const macSync = Effect.gen(function* () {
  const sync = yield* CloudSyncState;
  if (sync.mac !== undefined) return sync.mac as MacSync;
  const side = yield* makeMacSync;
  sync.mac = side;
  return side;
});
export type MacSync = Effect.Success<typeof makeMacSync>;

const makeMacSync = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const link = yield* CloudLinkState;
  const sync = yield* CloudSyncState;
  const settings = yield* ServerSettingsService;
  const secrets = yield* ProjectSecrets;
  const broker = yield* CredentialBroker;
  const settingsLock = yield* PluginSettingsLock;
  // The loop and the person's own changes (opt in or out, remove, sign out) take turns: a removal never races a push.
  const busy = yield* Semaphore.make(1);
  const turn = <A, E, R>(effect: Effect.Effect<A, E, R>) => busy.withPermits(1)(effect);
  const linkDir = linkDirOf(config.stateDir);
  const identity = () => readIdentity(linkDir);
  const home = os.homedir();
  const homes = setupHomes(process.env, home);
  const run = <A>(promise: () => Promise<A>) => Effect.tryPromise({ try: promise, catch: (error) => (error instanceof Error ? error : new Error(String(error))) });
  const servers = settings.getSettings.pipe(Effect.orDie, Effect.map((s) => s.plugins.servers));
  const setServers = (change: (list: ReadonlyArray<PluginServer>) => ReadonlyArray<PluginServer>) =>
    settingsLock.withPermits(1)(
      Effect.gen(function* () {
        yield* settings.updateSettings({ plugins: { servers: [...change(yield* servers)] } }).pipe(Effect.orDie);
      }),
    );

  let keysMirrored: string | undefined;
  /**
   * The choices for this account. Signed in to another account, org or Cloud than the one that said yes:
   * every yes is forgotten (repositories, server keys, each server's consent) before anything is sent.
   */
  const bind = (id: Identity) =>
    Effect.gen(function* () {
      const owner = ownerOf(id);
      const choices = readChoices(config.stateDir);
      if (choices.owner === owner) return choices;
      if ((yield* servers).some((s) => s.cloudConsent !== undefined)) yield* setServers((list) => list.map(({ cloudConsent: _c, ...s }) => s));
      keysMirrored = undefined;
      cloudCopy = undefined;
      return writeChoices(config.stateDir, () => ({ owner, repositories: [] }));
    });

  /** The profile Cloud held when this Mac last read or wrote it: a read sends its digest, and Cloud answers 304 while it still holds it. */
  let cloudCopy: StoredProfile | undefined;
  /** Cloud keeps v3 profiles (conditional writes), so this Mac takes Cloud's changes too. False: an older Cloud, asked again after `twoWayAgainAt`. */
  let twoWay: boolean | undefined;
  let twoWayAgainAt = 0;
  const spacesDir = path.join(config.stateDir, "spaces");

  /**
   * One sync of the profile every computer shares (profileMerge.ts): Cloud's copy is read, merged with this Mac's
   * side against what they last agreed, written back only if Cloud still holds what was read (a change meanwhile
   * reads and merges again), and then Cloud's changes are written here. `force` reads Cloud afresh and writes even
   * an equal profile; `resume`: the person asked to sync again after removing it.
   */
  const pushProfile = (force = false, resume = false) =>
    Effect.gen(function* () {
      const id = identity();
      const scrubber = yield* secrets.scrubber;
      const pluginsNow = settings.getSettings.pipe(Effect.orDie, Effect.map((s) => s.plugins));
      const read = (plugins: PluginSettings) => localSide({ plugins, homes, home, scrubber, spacesDir });
      if (id === undefined) {
        sync.status = { state: "off", items: read(yield* pluginsNow).lines };
        cloudCopy = undefined;
        return;
      }
      const choices = yield* bind(id);
      if (choices.paused && !resume) {
        sync.status = { state: "paused", items: read(yield* pluginsNow).lines };
        return;
      }
      const owner = ownerOf(id);
      pruneTrash(config.stateDir);
      for (let attempt = 0; ; attempt++) {
        if (attempt > 5) return yield* Effect.fail(new Error("your settings kept changing on another computer while this Mac merged them"));
        const remote = yield* run(() => getProfile(id, link, force || attempt > 0 ? undefined : cloudCopy));
        const readFrom = yield* pluginsNow;
        const side = read(readFrom);
        const lineageThere = remote?.profile?.version === 3 && typeof remote.profile.lineage === "string" && LINEAGE.test(remote.profile.lineage) ? remote.profile.lineage : undefined;
        // Only a Cloud that takes conditional writes can hold a v3 profile.
        if (lineageThere !== undefined) twoWay = true;
        const both = twoWay !== false || Date.now() >= twoWayAgainAt;
        const mode: SyncMode = both ? "two_way" : "push_only";
        const file = readSyncFile(config.stateDir);
        const lineage = both ? (lineageThere ?? newLineage()) : undefined;
        // No common past: another account, another way of syncing, or a profile of another lineage (or an older app's).
        const fresh = file === undefined || file.owner !== owner || file.mode !== mode || (both && (lineageThere === undefined || file.lineage !== lineageThere));
        const remoteItems = itemsOf(remote?.profile);
        const result = merge({
          local: withHeldSpaces(side.local, remoteItems),
          remote: remoteItems,
          bases: new Map(Object.entries(fresh ? {} : file!.bases)),
          fresh,
          apply: both,
          blocked: blockedHere(side, homes, home),
          lineage,
        });
        const digest = profileDigest(result.profile);
        let held = remote;
        if (force || resume || digest !== remote?.digest) {
          // Written only over the profile that was read: another computer's write meanwhile is read and merged first.
          const precondition: Record<string, string> = remote === undefined ? { "if-none-match": "*" } : { "if-match": `"${remote.digest}"` };
          const put = (body: Record<string, unknown>) => run(() => call(id, link, "PUT", "profile", body, fetch, precondition));
          const sent = yield* put({ profile: result.profile, digest, ...(resume ? { resume: true } : {}) }).pipe(
            // A Cloud from before profile tombstones knows no `resume`: it has none to lift.
            Effect.catch((error) => (resume && error instanceof CloudError && error.status === 400 && /resume/.test(error.message) ? put({ profile: result.profile, digest }) : Effect.fail(error))),
            Effect.as("sent" as const),
            Effect.catch((error) =>
              error instanceof CloudError && error.code === PAUSED
                ? Effect.succeed("paused" as const)
                : error instanceof CloudError && error.status === 412
                  ? Effect.succeed("changed" as const)
                  : both && lineageThere === undefined && olderCloud(error)
                    ? Effect.succeed("older" as const)
                    : Effect.fail(error),
            ),
          );
          if (sent === "paused") {
            // Removed from Cloud (on the web, or another computer): stays off here until the person syncs again.
            writeChoices(config.stateDir, (c) => ({ ...c, paused: true }));
            cloudCopy = undefined;
            sync.status = { state: "paused", items: side.lines };
            return;
          }
          if (sent === "changed") {
            cloudCopy = undefined;
            continue;
          }
          if (sent === "older") {
            // A Cloud without conditional writes: this Mac only sends (and never takes) until it is asked again in an hour.
            twoWay = false;
            twoWayAgainAt = Date.now() + 3600_000;
            continue;
          }
          if (!both) {
            // An older Cloud wrote without the precondition: only a read that still finds this write proves it held.
            const check = yield* run(() => getProfile(id, link, { profile: result.profile, digest, updated_at: "" }));
            if (check?.digest !== digest) {
              cloudCopy = undefined;
              sync.status = { state: "ok", synced_at: new Date().toISOString(), digest, items: side.lines, mode, ...keysNote() };
              return;
            }
          }
          if (choices.paused) writeChoices(config.stateDir, (c) => ({ ...c, paused: false }));
          held = { profile: result.profile, digest, updated_at: new Date().toISOString() };
          if (both) twoWay = true;
        }
        cloudCopy = held;

        // Cloud now holds the merged profile: its changes are written here.
        const failed = new Map<string, string>();
        const trash: string[] = [];
        for (const take of result.takes) {
          if ((take.to ?? take.from)!.kind !== "skill") continue;
          try {
            const kept = applySkillTake({ take, folders: side.skillFolders, homes, home, stateDir: config.stateDir, scrubber });
            if (kept !== undefined) trash.push(kept);
          } catch (error) {
            failed.set(take.key, error instanceof Error ? error.message : String(error));
          }
        }
        // A plugin list changed here since this sync read it: its takes wait for the next sync, which merges that change.
        const settledNow = yield* pluginsNow;
        const pluginTakes = result.takes.filter((t) => {
          const kind = (t.to ?? t.from)!.kind;
          if (kind === "skill") return false;
          if (canonicalJson(listsOf(kind, settledNow)) === canonicalJson(listsOf(kind, readFrom))) return true;
          failed.set(t.key, "it changed here meanwhile; the next sync merges both");
          return false;
        });
        if (pluginTakes.length > 0) {
          const removals = sync.removals;
          // The registry's removals take the settings lock themselves, so they go first.
          for (const r of settingsWith(yield* pluginsNow, pluginTakes).remove) {
            if (removals === undefined) break;
            yield* (r.kind === "marketplace" ? removals.marketplace(r.name) : removals.server(r.name)).pipe(
              Effect.catch((error) => Effect.sync(() => void failed.set(r.key, error instanceof Error ? error.message : String(error)))),
            );
          }
          yield* settingsLock.withPermits(1)(
            Effect.gen(function* () {
              const next = settingsWith(yield* pluginsNow, pluginTakes);
              let plugins = next.plugins;
              for (const r of removals === undefined ? next.remove : []) {
                plugins =
                  r.kind === "server"
                    ? { ...plugins, servers: plugins.servers.filter((s) => s.name !== r.name) }
                    : {
                        ...plugins,
                        marketplaces: plugins.marketplaces.filter((m) => m.name !== r.name),
                        spaces: plugins.spaces.filter((sp) => sp.url !== r.url),
                        installed: plugins.installed.filter((i) => !i.id.endsWith(`@${r.name}`)),
                      };
              }
              yield* settings.updateSettings({ plugins }).pipe(Effect.orDie);
            }),
          );
        }
        // What this Mac has now: a take's base is what it reads back (a file its own scrubber holds back stays out
        // of it, and is never pushed back as a change); a failed take keeps its old bases, so it is tried again.
        const after = result.takes.length > 0 ? read(yield* pluginsNow) : side;
        const bases: Record<string, Base> = {};
        const taken = new Set(result.takes.map((t) => t.key));
        for (const [key, b] of result.bases) {
          const was = fresh ? {} : (file!.bases[key] ?? {});
          const next = failed.has(key) ? { ...(side.local.get(key) ? { l: side.local.get(key)!.digest } : {}), ...(was.r === undefined ? {} : { r: was.r }) } : taken.has(key) ? { ...(after.local.get(key) ? { l: after.local.get(key)!.digest } : {}), ...(b.r === undefined ? {} : { r: b.r }) } : b;
          if (next.l !== undefined || next.r !== undefined) bases[key] = next;
        }
        writeSyncFile(config.stateDir, { owner, mode, ...(lineage === undefined ? {} : { lineage }), bases });
        const notes = new Map(result.notes);
        for (const [key, why] of failed) notes.set(key, `could not take your other computer's change here: ${why}`);
        sync.status = {
          state: "ok",
          synced_at: new Date().toISOString(),
          digest: cloudCopy?.digest ?? digest,
          items: withNotes(after.lines, notes),
          mode,
          ...(trash.length > 0 || fs.existsSync(trashDir(config.stateDir)) ? { trash: trashDir(config.stateDir) } : {}),
          ...(result.takes.length > failed.size ? { received_at: new Date().toISOString(), received: result.takes.length - failed.size } : sync.status.received_at ? { received_at: sync.status.received_at, received: sync.status.received } : {}),
          ...keysNote(),
        };
        return;
      }
    }).pipe(Effect.tapError((error) => Effect.sync(() => (sync.status = { ...sync.status, state: "error", error: errorText(error) }))));

  /** Whether Cloud changed since this Mac last read it (a 304 says no): the loop's cheap look between syncs. */
  const cloudChanged = Effect.gen(function* () {
    const id = identity();
    // Only a Mac that takes Cloud's changes has a reason to look; one that lost its copy (a failed sync) syncs again.
    if (id === undefined || twoWay !== true) return false;
    if (cloudCopy === undefined) return true;
    const now = yield* run(() => getProfile(id, link, cloudCopy));
    return now?.digest !== cloudCopy.digest;
  });

  /** Why some opted-in keys did not go (names Cloud cannot keep, or a failed upload); shown beside the profile status. */
  let keysProblem: string | undefined;
  const keysNote = () => (keysProblem === undefined ? {} : { keys_error: keysProblem });

  /** The granted keys of servers opted in, by their Cloud names; names Cloud cannot keep are left out and named. */
  const wantedKeys = Effect.gen(function* () {
    const out = new Map<string, string>();
    const skipped: string[] = [];
    for (const server of (yield* servers).filter((s) => s.cloudConsent === true)) {
      for (const name of serverCredentials(server)) {
        if (!CLOUD_VAR.test(name) || isReservedEnvName(name, "process")) {
          skipped.push(`${server.name}'s ${name}`);
          continue;
        }
        const value = yield* broker.resolve({ plugin: "my-servers@personal", space: { url: PERSONAL_SPACE_URL, commit: "" }, server: server.name, destination: server.url ?? server.command ?? "", name });
        // Personal servers share one grant per variable here, so two servers that both need it share one name.
        if (Option.isSome(value)) out.set(cloudCredentialName(PERSONAL_SPACE_URL, name), Redacted.value(value.value));
      }
    }
    return { entries: [...out].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)), skipped };
  });
  /** Mirrors opted-in server keys when they changed; nothing at all while none was ever opted in. */
  const syncServerKeys = (force = false) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return;
      const choices = yield* bind(id);
      const { entries, skipped } = yield* wantedKeys;
      keysProblem = skipped.length === 0 ? undefined : `Stay on This Mac (Cloud keeps upper-case variable names only, never reserved ones): ${skipped.join(", ")}`;
      const fingerprint = `${id.runtimeId}:${createHash("sha256").update(canonicalJson(entries)).digest("hex")}`;
      if (!force && fingerprint === keysMirrored) return;
      if (entries.length === 0 && !choices.serverKeys) {
        keysMirrored = fingerprint;
        return;
      }
      yield* run(() => mirror(id, link, CLOUD_SERVERS_REPOSITORY, entries)).pipe(
        Effect.tapError((error) => Effect.sync(() => (keysProblem = `Your servers' keys did not reach Caveman: ${errorText(error)}`))),
      );
      writeChoices(config.stateDir, (c) => ({ ...c, serverKeys: entries.length > 0 }));
      keysMirrored = fingerprint;
    }).pipe(Effect.ensuring(Effect.sync(() => (sync.status = { ...(({ keys_error: _k, ...rest }) => rest)(sync.status), ...keysNote() }))));

  /** Mirrors one opted-in repository's values (only its opted-in names, when it is in by name); one not opted in is never sent. */
  const syncRepository = (repository: string) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return;
      const want = wanted(yield* bind(id), repository);
      if (want !== "all" && want.size === 0) return;
      const entries = yield* secrets.resolve(repository);
      yield* run(() => mirror(id, link, repository, want === "all" ? entries : entries.filter((e) => want.has(e.name))));
    });

  /** The repository's switch; with `names`, only those names go (and the switch stays as it was). Answers the names available now. */
  const setRepositoryNow = (repository: string, available: boolean, names?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return yield* Effect.fail(new Error("Sign in to Caveman first"));
      const before = yield* bind(id);
      // A first upload that fails takes the yes back: the switch never shows on while Cloud holds nothing.
      const takeBack = () =>
        writeChoices(config.stateDir, (c) => ({
          ...c,
          repositories: before.repositories.includes(repository) ? c.repositories : c.repositories.filter((r) => r !== repository),
          names: before.names?.[repository] === undefined ? withoutNames(c.names, repository) : { ...c.names, [repository]: before.names[repository]! },
        }));
      if (available && names !== undefined) {
        writeChoices(config.stateDir, (c) =>
          c.repositories.includes(repository) ? c : { ...c, names: { ...c.names, [repository]: [...new Set([...(c.names?.[repository] ?? []), ...names])].sort() } },
        );
        yield* syncRepository(repository).pipe(Effect.tapError(() => Effect.sync(takeBack)));
      } else if (available) {
        writeChoices(config.stateDir, (c) => ({ ...c, repositories: [...new Set([...c.repositories, repository])], names: withoutNames(c.names, repository) }));
        yield* syncRepository(repository).pipe(Effect.tapError(() => Effect.sync(takeBack)));
      } else {
        yield* run(() => dropAll(id, link, repository));
        writeChoices(config.stateDir, (c) => ({ ...c, repositories: c.repositories.filter((r) => r !== repository), names: withoutNames(c.names, repository) }));
      }
      const want = wanted(readChoices(config.stateDir), repository);
      return (yield* secrets.list(repository)).map((s) => s.name).filter((name) => want === "all" || want.has(name));
    });

  const setServerNow = (name: string, available: boolean) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return yield* Effect.fail(new Error("Sign in to Caveman first"));
      yield* bind(id);
      const server = (yield* servers).find((s) => s.name === name);
      if (server === undefined) return yield* Effect.fail(new Error(`no server ${name}`));
      yield* setServers((list) => list.map((s) => (s.name !== name ? s : available ? { ...s, cloudConsent: true } : (({ cloudConsent: _c, ...rest }) => rest)(s))));
      yield* syncServerKeys(true);
      yield* pushProfile();
      return [...serverCredentials(server)];
    });

  /** Cloud's own list of what it holds for this person (every repository, from any Mac, the web or a computer); undefined from a Cloud without it. */
  const cloudHoldings = (id: Identity) =>
    run(() => call<CloudHoldings>(id, link, "GET", "holdings")).pipe(
      Effect.map((out) => out as CloudHoldings | undefined),
      Effect.catch((error) => (error instanceof CloudError && error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error))),
    );

  /** Names Cloud holds for this person, per class. */
  const holdings = Effect.gen(function* () {
    const id = identity();
    if (id === undefined) return [];
    const held = yield* cloudHoldings(id);
    if (held !== undefined) {
      const items: Holding[] = [];
      if (held.profile && !held.profile.paused_at) items.push({ kind: "profile", id: "profile", label: "Settings, marketplaces, server definitions and skills (no values)", names: [], updated_at: held.profile.updated_at });
      for (const r of held.repositories ?? []) items.push({ kind: "repository_secrets", id: r.repository, label: `Secrets of ${r.repository}`, names: [...r.names], ...(r.updated_at ? { updated_at: r.updated_at } : {}) });
      if (held.server_keys && held.server_keys.names.length > 0) {
        const engineKey = held.server_keys.names.some((n) => isEngineKeyName(n));
        items.push({ kind: "server_keys", id: CLOUD_SERVERS_REPOSITORY, label: engineKey ? "Keys of your MCP servers, and Claude Agent's API key" : "Keys of your MCP servers", names: held.server_keys.names.map((n) => n.replace(/^[0-9a-f]{16}\./, "")), ...(held.server_keys.updated_at ? { updated_at: held.server_keys.updated_at } : {}) });
      }
      const connections = [...(held.connections ?? [])];
      if (held.github_linked === true && !connections.some((c) => c.connection_id === "github")) connections.push({ connection_id: "github", provider: "github" });
      for (const c of connections) items.push({ kind: "connection", id: c.connection_id, label: connectionLabel(c), names: [], ...(c.updated_at ? { updated_at: c.updated_at } : {}) });
      return items;
    }
    // A Cloud from before /runtime/holdings: what this Mac opted in, and the connections list.
    const items: Holding[] = [];
    const choices = yield* bind(id);
    const profile = yield* run(() => getProfile(id, link));
    if (profile !== undefined) {
      const p = profile.profile?.plugins;
      items.push({
        kind: "profile",
        id: "profile",
        label: "Settings, marketplaces, server definitions and skills (no values)",
        names: [...(p?.servers ?? []).map((s) => s.name), ...(profile.profile?.skills ?? []).map((s) => s.name), ...(p?.spaces ?? []).map((s) => s.url)],
        updated_at: profile.updated_at,
      });
    }
    for (const repository of optedIn(choices)) {
      const names = yield* run(() => listNames(id, link, repository));
      items.push({ kind: "repository_secrets", id: repository, label: `Secrets of ${repository}`, names: names.map((n) => n.name) });
    }
    // Server keys go from This Mac; Claude Agent's API key from a Cloud computer, so it is always asked about.
    const keyNames = yield* run(() => listNames(id, link, CLOUD_SERVERS_REPOSITORY));
    if (keyNames.length > 0 || choices.serverKeys) {
      const engineKey = keyNames.some((n) => isEngineKeyName(n.name));
      items.push({
        kind: "server_keys",
        id: CLOUD_SERVERS_REPOSITORY,
        label: engineKey ? "Keys of your MCP servers, and Claude Agent's API key" : "Keys of your MCP servers",
        names: keyNames.map((n) => n.name.replace(/^[0-9a-f]{16}\./, "")),
      });
    }
    for (const c of yield* connectionsOf(id)) items.push({ kind: "connection", id: c.connection_id, label: connectionLabel(c), names: [], ...(c.updated_at ? { updated_at: c.updated_at } : {}) });
    return items;
  });
  const connectionsOf = (id: Identity) =>
    run(() => tolerate404(call<unknown>(id, link, "GET", "connections"), [])).pipe(
      Effect.map((raw) => (Array.isArray(raw) ? raw : ((raw as { connections?: unknown[] })?.connections ?? [])) as Array<{ connection_id: string; resource?: string; provider?: string; updated_at?: string }>),
    );

  /**
   * Removes one item, or everything, from Cloud: driven by what Cloud says it holds (holdings), so a
   * repository opted in on the web or another Mac goes too. Each failure is named; the rest still goes.
   * The profile stays off until cloud.profile.sync.
   */
  const removeNow = (what: { readonly all?: boolean; readonly kind?: string; readonly id?: string }) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return 0;
      yield* bind(id);
      let removed = 0;
      const failed: string[] = [];
      const attempt = (label: string, effect: Effect.Effect<unknown, unknown>) =>
        effect.pipe(
          Effect.tap(() => Effect.sync(() => removed++)),
          Effect.catch((error) => Effect.sync(() => void failed.push(`${label} (${errorText(error)})`))),
        );
      const wants = (kind: string, itemId?: string) => what.all === true || (what.kind === kind && (what.id === undefined || itemId === undefined || what.id === itemId));
      const held = yield* holdings;
      if (wants("profile")) {
        writeChoices(config.stateDir, (c) => ({ ...c, paused: true }));
        cloudCopy = undefined;
        sync.status = { ...sync.status, state: "paused" };
        yield* attempt("your settings", run(() => tolerate404(call(id, link, "DELETE", "profile"), undefined)));
      }
      for (const item of held) {
        if (item.kind === "repository_secrets" && wants("repository_secrets", item.id)) {
          yield* attempt(item.label, run(() => dropAll(id, link, item.id)));
          writeChoices(config.stateDir, (c) => ({ ...c, repositories: c.repositories.filter((r) => r !== item.id), names: withoutNames(c.names, item.id) }));
        }
      }
      if (wants("server_keys")) {
        yield* setServers((list) => list.map(({ cloudConsent: _c, ...s }) => s));
        yield* attempt("your servers' keys", run(() => dropAll(id, link, CLOUD_SERVERS_REPOSITORY)));
        writeChoices(config.stateDir, (c) => ({ ...c, serverKeys: false }));
        keysMirrored = undefined;
      }
      for (const item of held) {
        // A 404 here is not "gone": a Cloud that cannot delete it (GitHub before it could) says so the same way.
        if (item.kind === "connection" && wants("connection", item.id)) yield* attempt(item.label, run(() => call(id, link, "DELETE", `connections/${q(item.id)}`)));
      }
      if (failed.length > 0) return yield* Effect.fail(new Error(`Removed ${removed} from Caveman; still there: ${failed.join("; ")}`));
      return removed;
    });

  const accessLog = (limit: number) =>
    Effect.gen(function* () {
      const id = identity();
      if (id === undefined) return [];
      const out = yield* run(() => tolerate404(call<{ entries?: unknown[] }>(id, link, "GET", `access-log?limit=${limit}`), { entries: [] }));
      return (out?.entries ?? []).flatMap((raw) => {
        const e = raw as Record<string, unknown>;
        if (typeof e.at !== "string" || typeof e.action !== "string") return [];
        const str = (key: string) => (typeof e[key] === "string" ? { [key]: e[key] as string } : {});
        return [{ at: e.at, action: e.action, names: Array.isArray(e.names) ? e.names.filter((n): n is string => typeof n === "string") : [], ...str("kind"), ...str("repository"), ...str("reader"), ...str("computer_id"), ...str("workspace_id"), ...str("workspace_title"), ...str("actor_type"), ...str("actor_id") }];
      });
    });

  /** The loop: profile and server keys on change, opted-in repositories on each of their changes, each with its own backoff. */
  const loop = Effect.gen(function* () {
    let dirtyAt: number | undefined = 0;
    let nextForced = 0;
    /** When to look whether another computer changed the profile (a 304 while nothing did). */
    let nextLook = 0;
    let failures = 0;
    let retryAt = 0;
    const repos = new Set<string>();
    const repoRetry = new Map<string, { failures: number; at: number }>();
    const poke = () => (dirtyAt ??= Date.now());
    let wake: (() => void) | undefined;
    sync.wake = () => {
      dirtyAt = 0;
      retryAt = 0;
      wake?.();
    };
    yield* settings.streamChanges.pipe(Stream.runForEach(() => Effect.sync(poke)), Effect.forkScoped);
    yield* secrets.changes.pipe(
      Stream.runForEach((change) => Effect.sync(() => optedIn(choicesFor(config.stateDir, identity())).includes(change.repository) && repos.add(change.repository))),
      Effect.forkScoped,
    );
    // ponytail: fs.watch on the three skill roots (recursive where the OS has it); a five-minute rebuild catches what it misses.
    const watchers: fs.FSWatcher[] = [];
    for (const { dir } of skillRoots(homes, home)) {
      try {
        watchers.push(fs.watch(dir, { recursive: process.platform === "darwin" }, poke));
      } catch {
        // Not there (yet): the forced rebuild covers a folder made later.
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => watchers.forEach((w) => w.close())));
    let linked = false;
    for (;;) {
      yield* turn(
        Effect.gen(function* () {
          const now = Date.now();
          const id = identity();
          if (id === undefined) {
            linked = false;
            sync.status = { state: "off", items: sync.status.items };
            return;
          }
          // Just signed in (or the runtime started): push now, and bring every opted-in repository up to date.
          if (!linked) {
            dirtyAt = 0;
            for (const repository of optedIn(choicesFor(config.stateDir, id))) repos.add(repository);
          }
          linked = true;
          if (sync.status.state === "off") sync.status = { ...sync.status, state: "pending" };
          // Another computer's change arrives within LOOK_MS: a cheap read that Cloud answers 304 while nothing changed.
          if (now >= nextLook && now >= retryAt && dirtyAt === undefined) {
            nextLook = now + LOOK_MS;
            const changed = yield* Effect.exit(cloudChanged);
            if (changed._tag === "Success" && changed.value) dirtyAt = 0;
          }
          const due = (dirtyAt !== undefined && now - dirtyAt >= 2_000) || now >= nextForced;
          if (due && now >= retryAt) {
            // Taken before the push reads the profile: a change made while it is in flight marks it dirty again.
            const was = dirtyAt;
            dirtyAt = undefined;
            const result = yield* Effect.exit(pushProfile().pipe(Effect.andThen(syncServerKeys())));
            if (result._tag === "Success") {
              nextForced = now + 5 * 60_000;
              failures = 0;
            } else {
              dirtyAt = was ?? dirtyAt;
              failures++;
              retryAt = now + Math.min(5 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 6));
              yield* Effect.logWarning("Could not sync settings to Caveman Cloud; trying again", sync.status.error);
            }
          }
          for (const repository of [...repos]) {
            const retry = repoRetry.get(repository);
            if (retry !== undefined && retry.at > now) continue;
            repos.delete(repository);
            const result = yield* Effect.exit(syncRepository(repository));
            if (result._tag === "Success") repoRetry.delete(repository);
            else {
              // A refusal that will not change (a name Cloud does not take) waits longer each time, up to five minutes.
              const n = (retry?.failures ?? 0) + 1;
              repoRetry.set(repository, { failures: n, at: now + Math.min(5 * 60_000, 5_000 * 2 ** Math.min(n - 1, 6)) });
              repos.add(repository);
              yield* Effect.logWarning(`Could not update ${repository}'s secrets in Caveman Cloud; trying again`, result.cause);
            }
          }
        }),
      );
      yield* Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), 1_000);
        wake = () => {
          clearTimeout(timer);
          resume(Effect.void);
        };
        return Effect.sync(() => clearTimeout(timer));
      });
      wake = undefined;
    }
  });

  return {
    pushProfile,
    syncServerKeys,
    syncRepository,
    /** The person's own changes wait for the loop's turn and the loop waits for them. */
    setRepository: (repository: string, available: boolean, names?: ReadonlyArray<string>) => turn(setRepositoryNow(repository, available, names)),
    setServer: (name: string, available: boolean) => turn(setServerNow(name, available)),
    /** cloud.profile.sync: push now, lifting a removal from Cloud. */
    resume: turn(pushProfile(true, true)),
    holdings,
    remove: (what: { readonly all?: boolean; readonly kind?: string; readonly id?: string }) => turn(removeNow(what)),
    /** Before sign-out: everything Cloud holds goes, and no yes outlives the account it was given to. */
    signOut: turn(
      removeNow({ all: true }).pipe(Effect.ensuring(Effect.sync(() => writeChoices(config.stateDir, () => ({ repositories: [], paused: true }))))),
    ),
    accessLog,
    loop,
    identity,
  };
});

// ------------------------------------------------------------ Cloud computer

/**
 * Pulls the profile and applies it. Cloud unreachable: the last good one stays. Cloud refused (401
 * revoked, 403 shared, asleep, idle): nothing of the person's stays, an empty profile is applied. Settings
 * are written only when what would be applied changed, so a pull that brings nothing new writes nothing,
 * and an edit made on this computer stays until This Mac's profile changes.
 */
export const computerSync = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const computer = yield* CloudComputer;
  const link = yield* CloudLinkState;
  const sync = yield* CloudSyncState;
  const settings = yield* ServerSettingsService;
  const lock = yield* PluginSettingsLock;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const linkDir = computer?.linkDir ?? linkDirOf(config.stateDir);
  const onPath = onPathOf(process.env.PATH);

  let last: StoredProfile | undefined;
  /** What was last written to Settings, and for which profile the skills on disk are ("" = none). */
  let applied: string | undefined;
  let skillsOf: string | undefined;
  let skillItems: ProfileItem[] = [];
  const apply = (profile: StoredProfile | undefined) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* settings.getSettings.pipe(Effect.orDie)).plugins;
        const { plugins, items } = applyProfile({ profile: profile?.profile, onPath, current });
        const key = canonicalJson(plugins);
        if (key !== applied) {
          yield* settings.updateSettings({ plugins: { ...plugins, envAllowlist: current.envAllowlist } }).pipe(Effect.orDie);
          applied = key;
        }
        // Rewritten only when the profile changed: a running engine may be reading them.
        if ((profile?.digest ?? "") !== skillsOf) {
          skillItems = writeProfileSkills(profileSkillsDir(config.stateDir), profile?.profile?.skills ?? []);
          skillsOf = profile?.digest ?? "";
        }
        return [...items, ...skillItems];
      }),
    );

  const pull = Effect.gen(function* () {
    const id = readIdentity(linkDir);
    if (id === undefined) return;
    const fetched = yield* Effect.tryPromise({
      try: () => getProfile(id, link, last),
      catch: (error) => error,
    }).pipe(Effect.exit);
    if (fetched._tag === "Failure") {
      const error = Cause.squash(fetched.cause);
      if (!refused(error)) {
        sync.status = { ...sync.status, state: "error", error: `${errorText(error)}; the last profile pulled stays in use` };
        return;
      }
      // Revoked, shared with someone else's work, asleep: none of the person's settings, servers or skills stay.
      last = undefined;
      const items = yield* apply(undefined);
      sync.status = { state: "error", error: `${errorText(error)}; none of your settings are used here`, items };
      return;
    }
    const profile = fetched.value;
    const items = yield* apply(profile);
    last = profile;
    sync.status = { state: profile === undefined ? "pending" : "ok", synced_at: new Date().toISOString(), ...(profile ? { digest: profile.digest } : {}), items };
  });

  let inFlight: Promise<unknown> | undefined;
  let first: Promise<unknown> | undefined;
  const pullNow = () => (inFlight ??= runPromise(Effect.exit(pull)).finally(() => (inFlight = undefined)));
  const bounded = (promise: Promise<unknown>, ms: number) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]).then(() => undefined);
  sync.wake = () => void pullNow();
  sync.beforeSession = () => {
    // The first session waits for the first pull (at most 15 s); later ones start one and go on at once.
    if (first === undefined) return bounded((first = pullNow()), 15_000);
    void pullNow();
    return Promise.resolve();
  };
  return {
    pullNow,
    loop: Effect.forever(Effect.promise(() => sync.beforeSession!()).pipe(Effect.andThen(Effect.promise(() => pullNow())), Effect.andThen(Effect.sleep("60 seconds")))),
  };
});

/** Runs the side this runtime is: a Cloud computer pulls, This Mac pushes. A host without Settings (some tests) syncs nothing. */
export const run = Effect.gen(function* () {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const broker = yield* Effect.serviceOption(CredentialBroker);
  if (Option.isNone(settings)) return;
  if (yield* CloudComputer) {
    const side = yield* computerSync.pipe(Effect.provideService(ServerSettingsService, settings.value));
    return yield* side.loop;
  }
  if (Option.isNone(broker)) return;
  const side = yield* macSync.pipe(Effect.provideService(ServerSettingsService, settings.value), Effect.provideService(CredentialBroker, broker.value));
  return yield* side.loop.pipe(Effect.provideService(ServerSettingsService, settings.value));
}).pipe(Effect.scoped);
