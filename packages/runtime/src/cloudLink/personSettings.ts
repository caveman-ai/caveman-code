// A person's settings on every computer (Caveman Cloud the spec). The runtime is the only sync client: it holds the
// settings its chats start from, and every window reads them from it (settings.get, polled). Cloud keeps one row per
// key, numbered with the person's chat changes.
//
// For each key the loop knows the value Cloud last held and its number (`keys`). A value here that differs from it is
// an edit not yet pushed: Cloud's newer rows never overwrite it, and the push names the number it replaces (base_seq),
// so an edit made while another device changed the key loses to that change and this computer takes it. A row at or
// below the known number is this computer's own write coming back. Cloud's null is the app's default.
//
// At first contact, and when a Cloud computer starts acting for another person, Cloud's values win: everything is
// read and taken before anything is pushed, and a value equal to the app's default is no choice, so a new computer's
// defaults never replace the person's choices. Between pushes the loop holds Cloud's 25 s wait, cut short by a change
// here, and takes what another device changed through settings.set, one key at a time, so its effects run as for a
// change made here and a value this computer cannot hold (a newer app's) is refused alone.
//
// Only the person's choices sync (PERSON_KEYS): the look, new chats' engine and models, the Chiefs' limits and calls,
// delegated agents, memory, the inbox and review guides' limits. What belongs to one computer stays: its Cloud, Remote
// control, moves, keep-awake, the default computer, the engine account a model runs on (an engine's, a pinned role's, task kind's
// or review guide's: a pin syncs as its agent, model and effort, and runs on each computer's own account), its
// OS shortcut, its voices, whether it writes review guides, and each Chief's profile, which
// lives with the runtime that runs that Chief.
//
// A Cloud computer whose person's credentials stay outside it (credentialRule.ts) only reads: Cloud takes no setting
// from inside such a computer (its agent is root there, and a person's settings reach every device they own), so the
// loop sends none. A setting changed there holds on that computer, for the chats it runs, until the person changes it
// from a device of their own; then theirs is taken, as every row of Cloud's is.
import { SettingsPatch, type Settings } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { instanceForEngine } from "../session-protocol/projector.ts";
import { CALL_TIMEOUT_MS, withRuntimeToken } from "./computers.ts";
import { ruleOf } from "./credentialRule.ts";
import { cloudFailure, CloudError, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** The settings that are the person's, not one computer's. */
export const PERSON_KEYS = [
  "default_engine",
  "engines",
  "default_access",
  "theme",
  "notifications",
  "favorite_models",
  "home_models",
  "model_defaults",
  "git_co_author",
  "text_size",
  "mono_font",
  "density",
  "send_shortcut",
  "color_theme",
  "custom_themes",
  // The Chiefs' shared limits and calls (every Chief's own profile stays with the runtime that runs it).
  "chief_autonomy",
  "chief_updates",
  "chief_max_concurrent",
  "chief_daily_cap_usd",
  "chief_daily_turns",
  "chief_ask_above_chats",
  "chief_ask_wait_minutes",
  "chief_voice_ring_back",
  "chief_voice_patience",
  // Delegated agents, memory, the inbox and review guides.
  "subagent_max_depth",
  "subagent_max_concurrent",
  "subagent_default_model",
  "subagent_role_pins",
  "subagent_task_pins",
  "new_chat_by_task",
  "subagent_tree_token_ceiling",
  "memory_enabled",
  "inbox_done_on_merge",
  "inbox_done_after_days",
  "inbox_keep_pull_requests",
  "inbox_archive_done_after_days",
  "claude_idle_compaction",
  "review_prewarm",
  "review_short_lines",
  "review_chat_tldr",
  "review_post",
  "review_step_up",
  "review_single_pass_kb",
  "review_prewarm_daily",
  "review_prewarm_plan_percent",
  "review_prewarm_idle_minutes",
  "review_instructions",
] as const satisfies ReadonlyArray<keyof Settings>;
export type PersonKey = (typeof PERSON_KEYS)[number];
type PersonValues = Record<PersonKey, unknown>;

/** Cloud's wait (it caps it at 25 s); a wait that answered sooner with nothing is held to WAIT_FLOOR_MS. */
export const WAIT_MS = 25_000;
const WAIT_FLOOR_MS = 1_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A Cloud without these routes: ask again this much later. */
const IDLE_MS = 5 * 60_000;
/** A computer that acts for nobody yet: soon, so a Cloud computer's first workspace starts on its person's settings. */
const UNBOUND_MS = 15_000;
/** The kv key this loop keeps its place under. */
export const SYNC_KEY = "settings_sync";

export interface CloudSetting {
  readonly key: string;
  readonly value: unknown;
  readonly seq: number;
}

/** What the loop remembers: whose settings, how far it read, and each key's number and value as Cloud holds them. */
export interface SyncPlace {
  readonly owner: string;
  /** Empty until it met Cloud: its first round reads before it pushes. */
  readonly person: string;
  readonly seq: number;
  readonly keys: Readonly<Record<string, { readonly seq: number; readonly value: string }>>;
  /** Values Cloud refused, or this computer could not take, as they are here: not sent again until they change. */
  readonly refused: Readonly<Record<string, string>>;
}

export const canonical = (value: unknown): string =>
  value === undefined
    ? "null"
    : JSON.stringify(value, (_k, v: unknown) =>
        v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
      );

/** The person's settings as Cloud keeps them: an engine's model and effort without this computer's account. */
export function toCloud(settings: Settings): PersonValues {
  const out = {} as PersonValues;
  for (const key of PERSON_KEYS) out[key] = settings[key];
  out.default_engine = settings.default_engine_chosen === true ? settings.default_engine : undefined;
  // An engine with neither set is the engine's default; none set at all is the default too.
  const engines = Object.entries(settings.engines ?? {}).flatMap(([engine, { model, effort }]) =>
    model === undefined && effort === undefined ? [] : [[engine, { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }] as const],
  );
  out.engines = engines.length === 0 ? undefined : Object.fromEntries(engines);
  out.subagent_role_pins = pinsToCloud(settings.subagent_role_pins);
  out.subagent_task_pins = pinsToCloud(settings.subagent_task_pins);
  return out;
}

type Pin = { readonly engine: string; readonly instance_id: string; readonly model: string; readonly effort?: string; readonly always?: boolean };
type CloudPin = Omit<Pin, "instance_id">;

/** A role's or task kind's pins (Settings > Subagents) without the account each runs on here; none pinned is none at all. */
function pinsToCloud(pins: Readonly<Record<string, Pin | null | undefined>> | undefined) {
  const kept = Object.entries(pins ?? {}).flatMap(([key, pin]) =>
    pin === null || pin === undefined
      ? []
      : [[key, { engine: pin.engine, model: pin.model, ...(pin.effort === undefined ? {} : { effort: pin.effort }), ...(pin.always ? { always: true } : {}) }] as const],
  );
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * Each pin as Cloud holds it, on this computer's own account for that agent: the one the key was pinned to here when
 * it is the same agent, else the agent's own. A key Cloud holds no pin for is cleared (null).
 */
function pinsFromCloud(local: Readonly<Record<string, Pin | null | undefined>> | undefined, value: unknown) {
  const here = local ?? {};
  const cloud = (value ?? {}) as Readonly<Record<string, CloudPin | null | undefined>>;
  return Object.fromEntries(
    [...new Set([...Object.keys(here), ...Object.keys(cloud)])].map((key) => {
      const pin = cloud[key];
      if (pin === null || pin === undefined) return [key, null];
      const mine = here[key];
      return [key, { ...pin, instance_id: mine?.engine === pin.engine ? mine.instance_id : instanceForEngine(pin.engine) }];
    }),
  );
}

/**
 * What makes `key` Cloud's `value` here: a settings.set patch, or `unset` for a default that is no value at all (an
 * optional key settings.set can only replace). Each engine keeps the account it runs on here; null is the app's
 * default (`defaults`), except a default engine nobody chose, which stays this computer's own (undefined).
 */
export function fromCloud(key: PersonKey, value: unknown, settings: Settings, defaults: Settings): Partial<Settings> | "unset" | undefined {
  if (key === "engines") {
    const local = settings.engines ?? {};
    const cloud = (value ?? {}) as Settings["engines"];
    return {
      engines: Object.fromEntries(
        [...new Set([...Object.keys(local), ...Object.keys(cloud)])].map((engine) => {
          const account = local[engine]?.account_id;
          return [engine, { ...cloud[engine], ...(account === undefined ? {} : { account_id: account }) }];
        }),
      ),
    };
  }
  if (key === "subagent_role_pins" || key === "subagent_task_pins") {
    return { [key]: pinsFromCloud(settings[key], value) } as Partial<Settings>;
  }
  if (value === null || value === undefined) {
    if (key === "default_engine") return undefined;
    return defaults[key] === undefined ? "unset" : ({ [key]: defaults[key] } as Partial<Settings>);
  }
  return { [key]: value } as Partial<Settings>;
}

/** Whether a value here is the one Cloud holds: Cloud's null (or nothing) is the app's default. */
const holds = (here: string, cloud: string | undefined, fallback: string) => here === (cloud ?? "null") || ((cloud ?? "null") === "null" && (here === "null" || here === fallback));

/**
 * The keys whose value here differs from the one Cloud was last known to hold, and was not refused as it is. A key
 * Cloud holds nothing for goes only when it is a choice: a value equal to the app's default is none.
 */
export function changedHere(local: PersonValues, place: SyncPlace, defaults: PersonValues): Array<{ key: PersonKey; value: unknown; text: string }> {
  return PERSON_KEYS.flatMap((key) => {
    const text = canonical(local[key]);
    return holds(text, place.keys[key]?.value, canonical(defaults[key])) || place.refused[key] === text ? [] : [{ key, value: local[key] ?? null, text }];
  });
}

const fresh = (owner: string): SyncPlace => ({ owner, person: "", seq: 0, keys: {}, refused: {} });

/** The account a runtime's identity names: another one (signed in elsewhere) starts from nothing. */
const ownerOf = (id: Identity) => [id.cloudUrl, id.organizationId, id.runtimeId].join("\0");

/** A Cloud refusal that sending the same again cannot change (a 401 or 403 is the runtime's, not the value's). */
const final = (error: unknown) => error instanceof CloudError && error.status >= 400 && error.status < 500 && ![401, 403, 404, 408, 429].includes(error.status);

async function cloud<T>(identity: Identity, link: LinkState, method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const send = (token: string) =>
    fetch(`${identity.cloudUrl}/api/v1/code/runtime/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  const response = await withRuntimeToken(identity, link, fetch, send);
  if (!response.ok) throw await cloudFailure(response);
  return (await response.json()) as T;
}

type Page = { readonly settings: ReadonlyArray<CloudSetting>; readonly seq: number; readonly person: string };
type Written = { readonly settings: ReadonlyArray<CloudSetting>; readonly conflicts: ReadonlyArray<string> };

export interface SettingsSync {
  /** Settings changed here (settings.set): push now, and stop waiting on Cloud to do it. */
  readonly changed: () => void;
  /** The loop, for the runtime's life. */
  readonly run: Effect.Effect<never>;
}

export const makeSettingsSync = (input: {
  readonly identity: () => Identity | undefined;
  readonly link: LinkState;
  readonly get: Effect.Effect<Settings>;
  /** The app's defaults (settings.get with nothing saved): a value equal to one is no choice of the person's. */
  readonly defaults: Effect.Effect<Settings>;
  readonly set: (patch: Partial<Settings>) => Effect.Effect<unknown, unknown>;
  /** Removes saved keys, so they read as the app's defaults (an optional key settings.set can only replace). */
  readonly unset: (keys: ReadonlyArray<PersonKey>) => Effect.Effect<unknown, unknown>;
  readonly load: Effect.Effect<string | undefined>;
  readonly save: (value: string) => Effect.Effect<void>;
}): SettingsSync => {
  let wake: AbortController | undefined;
  let dirty = false;
  const changed = () => {
    dirty = true;
    wake?.abort();
  };
  const tryCloud = <A>(promise: () => Promise<A>) => Effect.tryPromise({ try: promise, catch: (error) => error });
  /** This runtime's credential rule: where it applies, this computer reads the person's settings and writes none. */
  const rule = ruleOf(input.link);
  const decodePatch = Schema.decodeUnknownExit(SettingsPatch);
  const pending = Effect.gen(function* () {
    return { local: toCloud(yield* input.get), defaults: toCloud(yield* input.defaults) };
  });

  const loadPlace = (owner: string) =>
    input.load.pipe(
      Effect.map((raw) => {
        try {
          const place = raw === undefined ? undefined : (JSON.parse(raw) as SyncPlace);
          return place?.owner === owner && typeof place.seq === "number" && place.keys && place.refused ? place : fresh(owner);
        } catch {
          return fresh(owner);
        }
      }),
    );

  /**
   * Takes Cloud's rows here, one key at a time, and answers the place that names them. A row at or below the number
   * already known is this computer's own write; a key with an edit here not yet pushed is left to the push, unless the
   * push just lost it to this row (`won`). A value this computer cannot hold (the protocol refuses it, or settings.set
   * does) is marked refused as it is here, so it is never pushed over the person's newer one.
   */
  const take = (place: SyncPlace, rows: ReadonlyArray<CloudSetting>, won = false) =>
    Effect.gen(function* () {
      const keys = { ...place.keys };
      const refused = { ...place.refused };
      const defaults = yield* input.defaults;
      const fallback = toCloud(defaults);
      for (const row of rows) {
        const key = row.key as PersonKey;
        const known = keys[key];
        if (!(PERSON_KEYS as ReadonlyArray<string>).includes(key) || (known !== undefined && row.seq <= known.seq)) continue;
        const settings = yield* input.get;
        const here = canonical(toCloud(settings)[key]);
        const def = canonical(fallback[key]);
        if (!won && known !== undefined && !holds(here, known.value, def)) continue;
        keys[key] = { seq: row.seq, value: canonical(row.value) };
        if (holds(here, canonical(row.value), def)) continue;
        const patch = fromCloud(key, row.value, settings, defaults);
        if (patch === undefined) continue;
        const ok =
          patch === "unset"
            ? yield* input.unset([key]).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
            : Exit.isSuccess(decodePatch(patch)) && (yield* input.set(patch).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false))));
        if (!ok) {
          refused[key] = here;
          yield* Effect.logWarning(`settings: this computer cannot take Caveman Cloud's ${key}; it keeps its own`);
        }
      }
      return { ...place, keys, refused };
    });

  /** Pushes the keys changed here together, else one at a time when Cloud refuses the batch; a newer value is taken. */
  const push = (identity: Identity, place: SyncPlace) =>
    Effect.gen(function* () {
      const { local, defaults } = yield* pending;
      const changes = changedHere(local, place, defaults);
      if (changes.length === 0) return place;
      const refused = { ...place.refused };
      const send = (batch: typeof changes) =>
        tryCloud(() =>
          cloud<Written>(identity, input.link, "PATCH", "settings", { changes: batch.map(({ key, value }) => ({ key, value, base_seq: place.keys[key]?.seq ?? 0 })) }, CALL_TIMEOUT_MS),
        );
      const all = yield* send(changes).pipe(Effect.catch((error) => (final(error) ? Effect.succeed(undefined) : Effect.fail(error))));
      const written: Array<Written> = all === undefined ? [] : [all];
      if (all === undefined)
        for (const one of changes) {
          const sent = yield* send([one]).pipe(
            Effect.catch((error) =>
              final(error)
                ? Effect.logWarning(`settings: Caveman Cloud keeps no ${one.key} as it is here: ${(error as Error).message}`).pipe(Effect.andThen(Effect.sync(() => void (refused[one.key] = one.text))))
                : Effect.fail(error),
            ),
          );
          if (sent) written.push(sent);
        }
      const keys = { ...place.keys };
      const won: Array<CloudSetting> = [];
      for (const w of written)
        for (const s of w.settings) {
          if (w.conflicts.includes(s.key)) won.push(s);
          else keys[s.key] = { seq: s.seq, value: canonical(s.value) };
        }
      // Another device's newer value beat an edit here: this computer takes it.
      return yield* take({ ...place, keys, refused }, won, true);
    });

  /** Reads Cloud's rows after the place's number, waiting up to `wait` ms for one; undefined when a change here cut it short. */
  const read = (identity: Identity, place: SyncPlace, wait: number) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      wake = controller;
      // A change that came before the controller existed would otherwise wait out the whole 25 s.
      if (dirty && wait > 0) controller.abort();
      return yield* tryCloud(() => cloud<Page>(identity, input.link, "GET", `settings?after=${place.seq}&wait_ms=${wait}`, undefined, wait + CALL_TIMEOUT_MS, controller.signal)).pipe(
        Effect.catch((error) => (controller.signal.aborted ? Effect.succeed(undefined) : Effect.fail(error))),
        Effect.ensuring(Effect.sync(() => void (wake === controller && (wake = undefined)))),
      );
    });

  /**
   * Another person's settings now (a Cloud computer running someone else's workspace): this computer's person keys go
   * back to the app's defaults, so nothing of the last person reaches the next, and the place starts over.
   */
  const switchPerson = (owner: string) =>
    Effect.gen(function* () {
      const defaults = yield* input.defaults;
      const back = toCloud(defaults);
      const unset: Array<PersonKey> = [];
      for (const key of PERSON_KEYS) {
        const settings = yield* input.get;
        if (canonical(toCloud(settings)[key]) === canonical(back[key])) continue;
        // The default engine too: the next person's is theirs, or this computer's own until they choose one.
        const patch = key === "default_engine" ? "unset" : fromCloud(key, null, settings, defaults);
        if (patch === "unset") unset.push(key);
        else if (patch !== undefined) yield* input.set(patch).pipe(Effect.ignore);
      }
      if (unset.length > 0) yield* input.unset(unset).pipe(Effect.ignore);
      yield* input.save(JSON.stringify(fresh(owner)));
    });

  /**
   * Takes a page, unless it is another person's; answers the place after it, or undefined when it started over. On a
   * computer that only reads (`readOnly`) no edit here waits for a push, so Cloud's row always wins.
   */
  const takePage = (place: SyncPlace, page: Page, readOnly = false) =>
    Effect.gen(function* () {
      if (place.person !== "" && page.person !== place.person) {
        yield* switchPerson(place.owner);
        return undefined;
      }
      const next = { ...(yield* take(place, page.settings, readOnly)), person: page.person, seq: Math.max(place.seq, page.seq) };
      if (page.settings.length > 0 || next.person !== place.person) yield* input.save(JSON.stringify(next));
      return next;
    });

  /**
   * One round. First contact (or a new person): read and take everything, push nothing. Otherwise, with edits here, a
   * read that does not wait comes first (it says whose settings these are and brings what changed elsewhere), then the
   * push; then the wait. A computer that only reads never pushes: it waits, and takes.
   */
  const round = (identity: Identity) =>
    Effect.gen(function* () {
      // Asked before anything is sent: when Cloud cannot say, the round fails and is tried again like any other.
      const readOnly = yield* tryCloud(() => rule.outside());
      let place = yield* loadPlace(ownerOf(identity));
      dirty = false;
      if (place.person === "") {
        const page = yield* read(identity, place, 0);
        if (page !== undefined) yield* takePage(place, page, readOnly);
        return;
      }
      const { local, defaults } = yield* pending;
      if (!readOnly && changedHere(local, place, defaults).length > 0) {
        const page = yield* read(identity, place, 0);
        const current = page === undefined ? place : yield* takePage(place, page);
        if (current === undefined) return;
        place = yield* push(identity, current);
        yield* input.save(JSON.stringify(place));
      }
      const asked = Date.now();
      const page = yield* read(identity, place, WAIT_MS);
      if (page === undefined) return;
      yield* takePage(place, page, readOnly);
      const left = WAIT_FLOOR_MS - (Date.now() - asked);
      if (page.settings.length === 0 && !dirty && left > 0) yield* Effect.sleep(left);
    });

  const run = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const identity = input.identity();
      if (identity === undefined) {
        yield* Effect.sleep(30_000);
        continue;
      }
      // A defect (a store that threw) is waited out like a failure: the loop never stops for the runtime's life.
      const result = yield* round(identity).pipe(
        Effect.catchDefect((defect) => Effect.fail(defect)),
        Effect.result,
      );
      if (result._tag === "Success") {
        failures = 0;
        continue;
      }
      const error = result.failure;
      // Cloud refusing the write says the rule applies here (it came on while this computer ran): the next round
      // only reads, and nothing is sent again.
      if (rule.refusedBy(error) && rule.known() === true) continue;
      if (error instanceof CloudError && (error.status === 404 || error.status === 403)) {
        yield* Effect.sleep(error.status === 404 ? IDLE_MS : UNBOUND_MS);
        continue;
      }
      failures++;
      yield* Effect.logWarning(`settings: a round with Caveman Cloud did not finish (${String(error)})`);
      yield* Effect.sleep(Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS) * (0.5 + Math.random() / 2));
    }
  });

  return { changed, run };
};
