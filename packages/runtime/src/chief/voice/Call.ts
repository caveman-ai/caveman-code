// Calls with a Chief, any of them (docs/chief.md "Calls"): one at a time per runtime. Each call is with one Chief:
// its transcript holds the call, its board and projects are what the voice knows, and what is said lands on its
// board; a ring back comes from the Chief whose item it is. The client holds the voice engine's
// connection, so the person's audio goes to the engine, never here (through Caveman Cloud's relay when Caveman
// credits pay, keys.ts voicePayment); every JSON message the engine sends comes here
// (chief.voice.signal), and this is where a call is decided: what the person said, what goes to the Chief as a
// note (their words only, never the voice's), what the voice says back as the Chief's work lands, the board it
// keeps current, when it hangs up, what it costs, and ringing back when handed-off work is ready.
import { randomUUID } from "node:crypto";

import type { ChiefBoard, ChiefItem, ChiefVoice, SessionEvent, Settings, VoiceCall, VoiceConnect, VoiceShowing } from "@caveman-app/session-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";

import type { DraftEvent } from "../../session-protocol/projector.ts";
import type { SessionStore, WorkspaceRecord } from "../../session-protocol/store.ts";
import type * as Board from "../Board.ts";
import type { OneChief } from "../profiles.ts";
import { VoiceEngineError, type Heard, type VoiceAction, type VoiceCredential, type VoiceEngine, type VoiceSetup } from "./engine.ts";
import { keytermsOf } from "./Dictation.ts";
import { keyHint, plausibleKey, voicePayment, type VoiceCreditsState } from "./keys.ts";
import * as Prompt from "./prompt.ts";

/** Nobody spoke for this long and the Chief holds nothing for the call: it says goodbye. */
export const QUIET_MS = 45_000;
/** A turn the person started holds the quiet goodbye off until its words come back, this long at most (a cough sends none). */
export const OPEN_TURN_MS = 3 * 60_000;
/** A call wraps up here, and hangs up at MAX_MS. */
export const WRAP_MS = 28 * 60_000;
export const MAX_MS = 30 * 60_000;
/** The person hears the Chief pick up when its first words play, or this long after the line opens (the client's fallback). */
const ANSWER_MS = 2_500;
/** A client that never connects gives the call up after this. */
const CONNECT_MS = 20_000;
/** After a goodbye starts playing, the call hangs up at the latest this much later. */
const GOODBYE_MS = 12_000;
/** The person's last words show in the transcript at most this late when the voice has not answered yet. */
const TURN_FLUSH_MS = 1_500;
/** A spoken update waits until the person has been quiet this long. */
const AFTER_PERSON_MS = 900;
/** Board changes the voice should know, gathered this long. */
const KNOW_DEBOUNCE_MS = 3_000;
/** Notes handed off on calls ring back for this long. */
const RING_WINDOW_MS = 24 * 3_600_000;
/** The call's last turns a note carries to the Chief. */
const CALL_TURNS = 6;
/**
 * A handoff's words wait this long for more before they become a note, so a thought the engine cut at a pause
 * joins the same note when the rest arrives (2026-10-20: "...Yeah. I don't know." and, 2.4 s later, "go for some
 * smart ways to do that." were two notes). By the call's patience; longer when the words sound unfinished.
 */
export const SETTLE_MS = { quick: 1_500, normal: 2_500, patient: 4_000 } as const;
export const UNFINISHED_SETTLE_MS = { quick: 4_000, normal: 6_000, patient: 9_000 } as const;
/** The Chief has been at a note this long with nothing landed to say: the voice says it is still on it, once. */
export const WORKING_MS = 6_000;

const ITEMS_KEY = "chief.voice.items";
const LAST_END_KEY = "chief.voice.last_end";
const LIVE_KEY = "chief.voice.live";

/** What the voice sends to clients (session-protocol/server.ts turns them into notifications). */
export type VoiceOut =
  | { readonly kind: "updated"; readonly call: VoiceCall }
  | { readonly kind: "send"; readonly connectionId: string; readonly call_id: string; readonly messages: ReadonlyArray<unknown> }
  | { readonly kind: "ringing"; readonly item_id: string; readonly title: string; readonly state: "review" | "done" | "needs_you"; readonly line: string; readonly chief_id?: string; readonly muted: boolean };

/** Rings are muted at `nowMs`: turned off until further notice, or muted until a time still ahead. */
export const ringMuted = (settings: Pick<Settings, "chief_voice_ring_back" | "chief_voice_ring_muted_until">, nowMs: number) =>
  settings.chief_voice_ring_back === false || (typeof settings.chief_voice_ring_muted_until === "string" && Date.parse(settings.chief_voice_ring_muted_until) > nowMs);

/** A call refused, as the handlers turn it into a ProtocolError. */
export class VoiceRefused extends Error {
  readonly reason: "forbidden" | "invalid_state" | "invalid_params" | "not_found" | "engine_unavailable" | "key_refused";
  constructor(reason: VoiceRefused["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The engine's failure as a refused start: `not_offered:` (invalid_state) while Cloud doesn't offer voice on credits,
 * so the client points to a key; engine_unavailable, in the engine's words, otherwise.
 */
// Refused (credits ran out, a key revoked) is the person's to fix; unavailable is the engine's or Cloud's.
const refusedBy = (e: VoiceEngineError) =>
  e.kind === "not_offered"
    ? new VoiceRefused("invalid_state", `not_offered: ${e.message}`)
    : new VoiceRefused(e.kind === "refused" ? "key_refused" : "engine_unavailable", e.message);

export interface VoiceDeps {
  readonly engine: VoiceEngine;
  readonly store: SessionStore["Service"];
  /**
   * The Chief a call talks to: `chiefId`'s, else the one with the latest activity (Chief.ts resolve; the first is made
   * when there is none). Its session holds the call's transcript; it fails for a Chief that is not there.
   */
  readonly chief: (chiefId?: string) => Effect.Effect<OneChief, unknown>;
  /** One Chief's items; `boardChanges` says when the shared board changed (they are read again then). */
  readonly items: (chiefId: string) => Effect.Effect<ReadonlyArray<Board.Item>>;
  /** Every Chief's items: rings come from any Chief's, and a chat any Chief started is never one of the "other chats". */
  readonly allItems: Effect.Effect<ReadonlyArray<Board.Item>>;
  readonly boardChanges: PubSub.PubSub<ChiefBoard>;
  /** A spoken note onto that Chief's board and to it, with the call's last turns. */
  readonly capture: (chiefId: string, text: string, call: string) => Effect.Effect<Board.Item, unknown>;
  /** The Chief can think now (a key or credits): without, notes only wait on the board. */
  readonly canThink: (chiefId: string) => Effect.Effect<boolean>;
  /** Today's limit is reached: no new calls, and a call on now wraps up. */
  readonly overCap: Effect.Effect<boolean>;
  /** Today's limit in dollars (0: none) and what the Chief spent today, for a call's running cost against it. */
  readonly capRoom: Effect.Effect<number | undefined>;
  readonly settings: Effect.Effect<Settings>;
  readonly projects: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>>;
  /** A chat's state and its last answer (watch.ts digest). */
  readonly digest: (record: WorkspaceRecord) => Effect.Effect<{ readonly latest?: string } | undefined>;
  /** The voice engines' sealed keys (keys.ts), on the runtime's secret store: Settings shows and changes them. */
  readonly keys: {
    readonly read: Effect.Effect<Readonly<Record<string, string>>>;
    readonly write: (engine: string, key: string | null) => Effect.Effect<void, Error>;
    /**
     * Whether a key may be kept on this computer: fails with the refusal where the person's credentials stay outside
     * it (session-protocol/insideComputer.ts), as the protocol error the handlers pass on.
     */
    readonly takes: Effect.Effect<void, Error>;
  };
  /** Caveman credits, which pay when there is no key of the person's own (keys.ts voicePayment); absent while they are off. */
  readonly credits: Effect.Effect<VoiceCreditsState>;
  /** A spend row for the Chief: the call's minutes at what a minute cost on what paid. */
  readonly recordSpend: (record: WorkspaceRecord, usd: number, durationMs: number, paid: VoiceCredential["kind"]) => Effect.Effect<void>;
  readonly now?: () => number;
}

interface Turn {
  readonly role: "person" | "voice";
  readonly text: string;
}

interface Live {
  call: VoiceCall;
  /** The Chief on the call: its transcript holds the call, its board and projects are what the call knows. */
  readonly chief: OneChief;
  readonly connectionId: string;
  readonly setup: VoiceSetup;
  /** What pays for the call, and what one of its minutes costs there. */
  readonly paid: VoiceCredential["kind"];
  readonly usdPerMinute: number;
  readonly startedMs: number;
  liveMs: number | undefined;
  /** When the Chief first spoke: the call's length as the person saw it counts from here. */
  answeredMs: number | undefined;
  /** The next signal to take, and the ones that came early. */
  seq: number;
  readonly early: Map<number, Deferred.Deferred<void>>;
  readonly turns: Array<Turn>;
  /** How many of `turns` were before the last handoff: a note carries the person's words after it. */
  handedAt: number;
  /** The person's newest words, not in the transcript yet (a handoff may still claim them). */
  heldTurn: { readonly text: string; readonly at: number } | undefined;
  /** Words handed off, waiting (SETTLE_MS) for more before they become one note. */
  pending: { readonly text: string; readonly at: number } | undefined;
  /** The board item being walked through: what `show` puts on screen. */
  subject: string | undefined;
  /** Notes this call made: their exact text, to find the Chief turn that took each. */
  readonly notes: Map<string, string>;
  /**
   * Chief turns working on this call's notes: their tools, whether a result was spoken, whether a filler was, when
   * they started, the results after the first (said as one "Also" line at the end, never stacked), the last text.
   */
  readonly turnsFor: Map<string, { spoke: boolean; filled: boolean; readonly since: number; readonly also: Array<string>; text: string; readonly tools: Map<string, { name: string; input: Record<string, unknown> }> }>;
  /** Lines waiting to be spoken. */
  readonly toSay: Array<string>;
  /** The Chief's own replies, read out as they are: its message already shows them, so said they write no line of their own. */
  readonly relayed: Set<string>;
  /** What was sent to say last, put back when the engine refuses it, and when. */
  saying: string | undefined;
  sayingMs: number;
  personSpeaking: boolean;
  personMs: number;
  /** The person started a turn whose words have not come back yet. */
  personOpen: boolean;
  voiceSpeaking: boolean;
  voiceDoneMs: number;
  lastActivityMs: number;
  promptChars: number;
  /** Quiet context gathered for the next send. */
  readonly knowing: Array<string>;
  knowTimer: ReturnType<typeof setTimeout> | undefined;
  /** It said goodbye and hangs up once that is spoken. */
  goodbye: { readonly reason: NonNullable<VoiceCall["end_reason"]>; readonly at: number } | undefined;
  wrapped: boolean;
  /** Board states as this call last saw them. */
  readonly states: Map<string, ChiefItem["state"]>;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A Chief tool's answer: JSON text for objects, words for refusals; MCP content blocks on a Claude plan. */
const toolAnswer = (result: unknown): unknown => {
  const blocks = Array.isArray(result) ? result : Array.isArray(record(result).content) ? (record(result).content as unknown[]) : undefined;
  const text = typeof result === "string" ? result : blocks?.map((b) => String(record(b).text ?? "")).join("\n");
  if (text === undefined) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
const toolName = (name: string) => name.split(/__|\.|:/).pop() ?? name;

/**
 * Nobody spoke for QUIET_MS at `t`. Deepgram sends nothing between a person's start of speech and their words, so
 * a turn still open is speaking: a ramble longer than QUIET_MS is not silence.
 */
export const quietAt = (l: { readonly lastActivityMs: number; readonly personOpen: boolean; readonly personMs: number }, t: number) =>
  !(l.personOpen && t - l.personMs < OPEN_TURN_MS) && t - l.lastActivityMs > QUIET_MS;

export const makeVoice = (deps: VoiceDeps) =>
  Effect.gen(function* () {
    const { engine, store } = deps;
    const now = deps.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    const out = yield* PubSub.unbounded<VoiceOut>();
    const lock = yield* Semaphore.make(1);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let live: Live | undefined;
    /** Each handed-off item's state as last seen, so a ring goes once per change. */
    const ringState = new Map<string, ChiefItem["state"]>();

    const storedKey = deps.keys.read.pipe(Effect.map((keys) => keys[engine.id]));
    const publish = (message: VoiceOut) => PubSub.publish(out, message).pipe(Effect.asVoid);
    const updated = (l: Live) => publish({ kind: "updated", call: l.call });
    /** Messages for the engine, between signals: only to the client holding the call. */
    const sendNow = (l: Live, actions: ReadonlyArray<VoiceAction>) =>
      actions.length === 0 ? Effect.void : publish({ kind: "send", connectionId: l.connectionId, call_id: l.call.id, messages: actions.flatMap(engine.encode) });

    /** Lines in the transcript of the Chief on the call. */
    const appendToChief = (chief: WorkspaceRecord, events: ReadonlyArray<DraftEvent>) =>
      store.append(chief.session.id, () => Effect.succeed({ events, value: undefined })).pipe(Effect.catchCause((cause) => Effect.logWarning("chief voice: a transcript line was not written", cause)));
    const turnEvent = (l: Live, role: "person" | "voice", text: string, handoff?: { readonly item_id: string; readonly text: string }) =>
      appendToChief(l.chief.record, [{ at: iso(), type: "voice.turn", payload: { call_id: l.call.id, role, text, ...(handoff ? { handoff } : {}) } } as DraftEvent]);
    /** The call's Chief's items. */
    const itemsOf = (l: Pick<Live, "chief">) => deps.items(l.chief.profile.id);

    // ---------------------------------------------------------------- what the voice knows

    /** A project as the voice says it (never its id-like name as is); nothing with one project only, since there is nothing to tell apart. */
    const projectNames = deps.projects.pipe(
      Effect.map((projects) => (id: string) => {
        const name = projects.length > 1 ? projects.find((p) => p.id === id)?.name : undefined;
        return name === undefined ? undefined : Prompt.projectSaid(name);
      }),
    );

    /** Handed off on a call, and when: these ring back and lead the next call when ready. */
    const callItems = store.kvGet(ITEMS_KEY).pipe(
      Effect.map((raw) => {
        const parsed = record(raw === undefined ? {} : (JSON.parse(raw) as unknown));
        const cutoff = now() - RING_WINDOW_MS;
        return new Map(Object.entries(parsed).flatMap(([id, at]) => (typeof at === "number" && at >= cutoff ? [[id, at] as const] : [])));
      }),
      Effect.orElseSucceed(() => new Map<string, number>()),
    );
    const rememberItem = (itemId: string) =>
      callItems.pipe(Effect.flatMap((items) => store.kvSet(ITEMS_KEY, JSON.stringify(Object.fromEntries([...items, [itemId, now()]])))));

    /** The finished work a call can walk through: the chat's report and the files it changed. */
    const readyOf = (item: Board.Item) =>
      Effect.gen(function* () {
        const names = yield* projectNames;
        let report = "";
        for (const id of item.workspace_ids.slice(-2)) {
          const chat = yield* store.getWorkspace(id);
          if (chat === undefined) continue;
          const digest = yield* deps.digest(chat).pipe(Effect.orElseSucceed(() => undefined));
          if (digest?.latest) report = digest.latest;
        }
        const state = item.state === "needs_you" ? "needs_you" : item.state === "review" ? "review" : "done";
        const project = item.project_ids.map(names).find((n) => n !== undefined);
        return {
          item_id: item.id,
          title: item.title ?? Prompt.spoken(item.text, 1),
          ...(project ? { project } : {}),
          state,
          report,
          ...(item.detail ? { detail: item.detail } : {}),
        } satisfies Prompt.Ready;
      });

    /**
     * Puts an item's work on the person's screens (every device: the call's state carries it): its pull request's
     * Review page, else its chat's changes (`file`: one of them), or the chat itself. Undefined when it has no chat.
     */
    const showItem = (l: Live, itemId: string, what: "work" | "files" | "chat", file?: string) =>
      Effect.gen(function* () {
        const item = (yield* itemsOf(l)).find((i) => i.id === itemId);
        const wsId = item?.workspace_ids.at(-1);
        const ws = wsId === undefined ? undefined : yield* store.getWorkspace(wsId);
        if (item === undefined || ws === undefined) return undefined;
        const title = item.title ?? Prompt.spoken(item.text, 1);
        const pr = ws.workspace.pull_request;
        const kind: VoiceShowing["kind"] = what === "chat" ? "chat" : what === "files" || pr === undefined ? "diff" : "pr";
        const name = file?.split("/").pop();
        const caption = kind === "chat" ? `The chat on ${title}` : kind === "pr" ? `The pull request for ${title}${name ? `: ${name}` : ""}` : name ? `${name}, changed for ${title}` : `What changed for ${title}`;
        const showing: VoiceShowing = {
          kind,
          item_id: item.id,
          workspace_id: ws.workspace.id,
          title,
          ...(ws.workspace.project_id ? { project_id: ws.workspace.project_id } : {}),
          ...(kind === "pr" && pr ? { pr_number: pr.number } : {}),
          ...(file && kind !== "chat" ? { path: file } : {}),
          caption,
        };
        l.subject = item.id;
        l.call = { ...l.call, showing };
        yield* updated(l);
        return showing;
      });

    /** Chats no Chief started, running in the call's Chief's project. */
    const otherChats = (chief: OneChief) =>
      Effect.gen(function* () {
        const names = yield* projectNames;
        const linked = new Set((yield* deps.allItems).flatMap((i) => i.workspace_ids));
        const mine = (projectId: string | undefined) => projectId !== undefined && projectId === chief.profile.project_id;
        return (yield* store.listWorkspaces())
          .filter((r) => r.workspace.kind !== "chief" && r.workspace.kind !== "setup" && r.workspace.parent_workspace_id === undefined && !linked.has(r.workspace.id) && mine(r.workspace.project_id))
          .filter((r) => ["starting", "working", "needs_input"].includes(r.workspace.status))
          .slice(0, 8)
          .map((r): Prompt.VoiceChat => ({ title: r.workspace.title, status: r.workspace.status, ...(r.workspace.project_id ? { project: names(r.workspace.project_id) ?? "" } : {}) }));
      });

    /** The Chief's last typed exchanges, so "that thing from earlier" means something. */
    const recentExchanges = (chief: WorkspaceRecord) =>
      Effect.gen(function* () {
        const head = (yield* store.getBySession(chief.session.id))?.session.head ?? 0;
        const events = yield* store.readEvents(chief.session.id, Math.max(0, head - 400), head);
        return events
          .flatMap((e) => (e.type === "message.done" && e.payload.from === undefined && e.payload.text.trim() !== "" ? [{ role: e.payload.role === "user" ? ("person" as const) : ("chief" as const), text: e.payload.text }] : []))
          .slice(-6);
      }).pipe(Effect.orElseSucceed(() => []));

    // ---------------------------------------------------------------- status

    const voiceOf = (settings: Settings) => engine.voices.find((v) => v.id === settings.chief_voice_name) ?? engine.voices[0]!;
    const status = Effect.gen(function* () {
      const key = yield* storedKey;
      const hint = key === undefined ? undefined : keyHint(key);
      // Read without asking Cloud anything: a Cloud computer's credits key is fetched when a call starts.
      const credits = key === undefined ? yield* deps.credits : undefined;
      // Credits Cloud doesn't offer voice on can't pay: no_key, and Settings says why.
      const state: ChiefVoice["state"] = key === undefined && typeof credits !== "function" ? "no_key" : (yield* deps.overCap) ? "cap" : "ready";
      return {
        state,
        engine: engine.id,
        engine_label: engine.label,
        key_url: engine.keyUrl,
        key_help: engine.keyHelp,
        voices: engine.voices.map((v) => ({ ...v })),
        ...(hint ? { key_hint: hint } : {}),
        // What pays now: the person's own key, else credits Cloud offers voice on.
        ...(key !== undefined ? { paid_by: "key" as const } : typeof credits === "function" ? { paid_by: "credits" as const } : {}),
        ...(credits === undefined ? {} : { credits: credits === "unavailable" ? ("unavailable" as const) : ("on" as const) }),
        ...(live ? { call: live.call } : {}),
      } satisfies ChiefVoice;
    });

    // ---------------------------------------------------------------- speaking

    /** Speaks the next waiting line when nobody is mid-turn. */
    const trySay = (l: Live): ReadonlyArray<VoiceAction> => {
      if (l.toSay.length === 0 || l.saying !== undefined || l.personSpeaking || now() - l.personMs < AFTER_PERSON_MS || l.call.state !== "live") return [];
      const line = l.toSay.shift()!;
      l.saying = line;
      l.sayingMs = now();
      return [{ type: "say", text: line }];
    };
    /** A line waits its turn to be said; false once the call said goodbye. */
    const queue = (l: Live, line: string) => {
      // After a goodbye nothing else is said: a line landing then would hold the hang-up and talk over it.
      if (l.goodbye !== undefined) return false;
      if (!l.toSay.includes(line)) l.toSay.push(line);
      return true;
    };
    const say = (l: Live, line: string) => (queue(l, line) ? trySay(l) : []);
    /** Quiet context, gathered for a few seconds, then sent; renewed whole when appends would overflow the prompt. */
    const know = (l: Live, line: string) => {
      l.knowing.push(line);
      if (l.knowTimer !== undefined) return;
      l.knowTimer = setTimeout(() => {
        l.knowTimer = undefined;
        runFork(lock.withPermits(1)(Effect.suspend(() => (live === l ? flushKnow(l) : Effect.void))));
      }, KNOW_DEBOUNCE_MS);
    };
    const flushKnow = (l: Live) =>
      Effect.gen(function* () {
        if (l.knowing.length === 0) return;
        const text = l.knowing.splice(0).map((line) => `Update: ${line}`).join("\n");
        if (l.promptChars + text.length <= engine.promptLimit) {
          l.promptChars += text.length + 2;
          return yield* sendNow(l, [{ type: "know", text }]);
        }
        // Out of room: the whole prompt again, fresh, with these lines folded in.
        const prompt = yield* opening(l.chief, l.call.about_item_id).pipe(Effect.map((o) => o.setup.prompt));
        l.promptChars = prompt.length;
        yield* sendNow(l, [{ type: "renew", prompt }]);
      });

    // ---------------------------------------------------------------- the call's opening

    /** What the call opens with, from the call's Chief: its board, its project, its last exchanges. */
    const opening = (chief: OneChief, answer: string | undefined) =>
      Effect.gen(function* () {
        const settings = yield* deps.settings;
        const items = yield* deps.items(chief.profile.id);
        const names = yield* projectNames;
        const projects = (yield* deps.projects).filter((p) => p.id === chief.profile.project_id);
        const lastEnd = Date.parse((yield* store.kvGet(LAST_END_KEY)) ?? "") || 0;
        const handed = yield* callItems;
        // What the person handed off on a call and is ready since the last one, the one they answered first.
        const readyItems = items
          .filter((i) => (i.id === answer || (handed.has(i.id) && Date.parse(i.updated_at) > lastEnd)) && ["review", "done", "needs_you"].includes(i.state))
          .sort((a, b) => (a.id === answer ? -1 : b.id === answer ? 1 : b.updated_at.localeCompare(a.updated_at)))
          .slice(0, 3);
        const ready = yield* Effect.forEach(readyItems, readyOf);
        const board = Prompt.boardText(items, yield* otherChats(chief), names);
        const prompt = Prompt.openingPrompt({ board, recent: yield* recentExchanges(chief.record), ready, projects: projects.map((p) => p.name), now: new Date(now()) });
        // Dictation's rule (Dictation.ts keytermsOf): each name once, trimmed, 3 to 40 characters, no control characters, 30 at most.
        const keyterms = keytermsOf([...projects.map((p) => p.name), ...items.filter((i) => i.title && !["done", "dropped"].includes(i.state)).map((i) => i.title!)]);
        const needsYou = items.filter((i) => i.state === "needs_you" || i.state === "proposed").length;
        const setup = {
          prompt,
          greeting: Prompt.greeting({ ready, needsYou, hour: new Date(now()).getHours(), seed: randomUUID() }),
          voice: voiceOf(settings).id,
          keyterms,
          patience: settings.chief_voice_patience ?? "normal",
        } satisfies VoiceSetup;
        // What a walkthrough would show first: the item the call opened on, else the newest ready one.
        return { setup, subject: readyItems[0]?.id };
      });

    // ---------------------------------------------------------------- start and end

    /**
     * A call to `chiefId`'s Chief (absent: the one with the latest activity); answering a ring back (`answer`) calls the Chief whose item
     * rang, unless another is named. One call at a time on this runtime, whichever Chief it is with.
     */
    const start = (input: { readonly device: string; readonly answer?: string; readonly connectionId: string; readonly chiefId?: string }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (live !== undefined) {
            // A client that never connected gives way, and so does one its own connection left ringing: a client calls
            // only with no call of its own, and ends an abandoned start only once that start answers, after a redial
            // queued here. A call that is on is never taken over.
            const stale = now() - live.startedMs > CONNECT_MS;
            if (live.call.state === "connecting" && (stale || live.connectionId === input.connectionId)) yield* endLocked(live, stale ? "connection_lost" : "person");
            else return yield* Effect.fail(new VoiceRefused("invalid_state", `busy: on a call on ${live.call.device}`));
          }
          const payment = voicePayment(yield* storedKey, yield* deps.credits);
          if (payment === undefined) return yield* Effect.fail(new VoiceRefused("invalid_state", `no_key: calls need a Caveman plan or credits, or a ${engine.label} key (Settings > Chief > Calls)`));
          if (yield* deps.overCap) return yield* Effect.fail(new VoiceRefused("invalid_state", "cap: today's limit for the Chief is reached"));
          const credential = yield* payment.pipe(Effect.mapError(refusedBy));
          const rang = input.answer === undefined || input.chiefId !== undefined ? undefined : (yield* deps.allItems).find((i) => i.id === input.answer)?.chief_id;
          const chief = yield* deps.chief(input.chiefId ?? rang).pipe(
            Effect.mapError((error) => (error instanceof VoiceRefused ? error : new VoiceRefused("not_found", error instanceof Error ? error.message : String(error)))),
          );
          const { setup, subject } = yield* opening(chief, input.answer);
          // On credits the minutes are the Chief's chat's, as its typed turns are.
          const paying = credential.kind === "credits" ? { ...credential, session: chief.record.workspace.id } : credential;
          const minted = yield* engine.connect(paying, setup).pipe(Effect.mapError(refusedBy));
          const connect: VoiceConnect = minted.connect;
          const call: VoiceCall = {
            id: `vc-${randomUUID().slice(0, 8)}`,
            state: "connecting",
            engine: engine.id,
            started_at: iso(),
            device: input.device.slice(0, 60),
            muted: false,
            ...(input.answer ? { about_item_id: input.answer } : {}),
            chief_id: chief.profile.id,
          };
          const items = yield* deps.items(chief.profile.id);
          live = {
            call,
            chief,
            connectionId: input.connectionId,
            setup,
            paid: credential.kind,
            usdPerMinute: minted.usdPerMinute,
            startedMs: now(),
            liveMs: undefined,
            answeredMs: undefined,
            heldTurn: undefined,
            pending: undefined,
            subject,
            saying: undefined,
            knowTimer: undefined,
            goodbye: undefined,
            seq: 0,
            early: new Map(),
            turns: [],
            handedAt: 0,
            notes: new Map(),
            turnsFor: new Map(),
            toSay: [],
            relayed: new Set(),
            personSpeaking: false,
            personMs: 0,
            personOpen: false,
            voiceSpeaking: false,
            voiceDoneMs: 0,
            sayingMs: 0,
            lastActivityMs: now(),
            promptChars: setup.prompt.length,
            knowing: [],
            wrapped: false,
            states: new Map(items.map((i) => [i.id, i.state])),
          };
          yield* updated(live);
          return { call, connect };
        }),
      );

    /** Ends the call (under the lock): its spend, its transcript line, every client told. */
    const endLocked = (l: Live, reason: NonNullable<VoiceCall["end_reason"]>) =>
      Effect.gen(function* () {
        if (live !== l) return l.call;
        live = undefined;
        if (l.knowTimer !== undefined) clearTimeout(l.knowTimer);
        for (const waiting of l.early.values()) yield* Deferred.succeed(waiting, undefined);
        // Words handed off and still waiting for more go to the Chief now: the call is over, nothing more is coming.
        yield* capturePending(l);
        yield* flushHeld(l);
        const at = now();
        // Over: nothing stays on screen.
        const { showing: _showing, ...rest } = l.call;
        l.call = { ...rest, state: "ended", ended_at: iso(), end_reason: reason };
        if (l.liveMs !== undefined) {
          // Billed from the open line; the transcript shows the length the person saw on the call's timer.
          const duration = at - l.liveMs;
          const shown = Math.max(0, at - Math.min(l.answeredMs ?? Infinity, l.liveMs + ANSWER_MS));
          yield* deps.recordSpend(l.chief.record, (duration / 60_000) * l.usdPerMinute, duration, l.paid).pipe(Effect.catchCause((cause) => Effect.logWarning("chief voice: spend not recorded", cause)));
          yield* appendToChief(l.chief.record, [{ at: iso(), type: "voice.call", payload: { call_id: l.call.id, state: "ended", duration_ms: shown, reason } } as DraftEvent]);
          yield* store.kvSet(LAST_END_KEY, iso()).pipe(Effect.ignore);
        }
        yield* store.kvSet(LIVE_KEY, "").pipe(Effect.ignore);
        yield* updated(l);
        return l.call;
      });

    const callFor = (callId: string) => (live !== undefined && live.call.id === callId ? Effect.succeed(live) : Effect.fail(new VoiceRefused("not_found", `No call ${callId} on now.`)));

    const end = (callId: string, reason: NonNullable<VoiceCall["end_reason"]>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (live === undefined || live.call.id !== callId) return yield* Effect.fail(new VoiceRefused("not_found", `No call ${callId} on now.`));
          return yield* endLocked(live, reason);
        }),
      );

    const setMuted = (callId: string, muted: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const l = yield* callFor(callId);
          if (l.call.muted === muted) return l.call;
          l.call = { ...l.call, muted };
          l.lastActivityMs = now();
          yield* sendNow(l, [{ type: "know", text: muted ? "Update: they muted their mic. Don't wait on them; they'll unmute to talk." : "Update: they unmuted." }]);
          yield* updated(l);
          return l.call;
        }),
      );

    /** The client holding the call went away. */
    const closeConnection = (connectionId: string) =>
      lock.withPermits(1)(Effect.suspend(() => (live !== undefined && live.connectionId === connectionId ? endLocked(live, "connection_lost").pipe(Effect.asVoid) : Effect.void)));

    /** Starts the goodbye: say it, then hang up once it is spoken (or GOODBYE_MS at the latest). */
    const wrapUp = (l: Live, line: string, reason: NonNullable<VoiceCall["end_reason"]>): ReadonlyArray<VoiceAction> => {
      if (l.wrapped) return [];
      l.wrapped = true;
      l.goodbye = { reason, at: now() };
      l.toSay.length = 0;
      l.saying = undefined;
      l.toSay.push(line);
      return trySay(l);
    };

    // ---------------------------------------------------------------- what the engine heard

    /** The person's held words go into the transcript (optionally as handed off). */
    const flushHeld = (l: Live, handoff?: { readonly item_id: string; readonly text: string }) =>
      Effect.suspend(() => {
        const held = l.heldTurn;
        if (held === undefined) return handoff ? turnEvent(l, "person", "", handoff) : Effect.void;
        l.heldTurn = undefined;
        return turnEvent(l, "person", held.text, handoff);
      });

    /**
     * A handoff: the person's words since the last one wait as `pending` for more (a continuation joins them as one
     * note; capturePending sends them once they settle). The voice is answered now, so it acknowledges at once.
     */
    const handoff = (l: Live, id: string, name: string): Effect.Effect<ReadonlyArray<VoiceAction>, unknown> =>
      Effect.gen(function* () {
        const words = l.turns
          .slice(l.handedAt)
          .filter((t) => t.role === "person")
          .map((t) => t.text.trim())
          .filter((t) => t !== "");
        if (words.length === 0) return [{ type: "answer", id, name, text: Prompt.HANDOFF_AGAIN }];
        l.handedAt = l.turns.length;
        const text = words.join(" ");
        if (l.pending !== undefined) {
          l.pending = { text: `${l.pending.text} ${text}`, at: now() };
          return [{ type: "answer", id, name, text: Prompt.HANDOFF_MORE }];
        }
        l.pending = { text, at: now() };
        const thinking = yield* deps.canThink(l.chief.profile.id);
        return [{ type: "answer", id, name, text: thinking ? Prompt.HANDOFF_ANSWER : "It's on the board, but the Chief can't act on it until a model is connected. Say that, briefly." }];
      });
    /** Pending words have waited long enough with the person quiet (longer when they sound unfinished). */
    const settled = (l: Live, t: number) => l.pending !== undefined && !l.personSpeaking && t - l.pending.at >= (Prompt.unfinished(l.pending.text) ? UNFINISHED_SETTLE_MS : SETTLE_MS)[l.setup.patience];
    /** The pending words onto the board and to the Chief, as one note with the call's last turns. */
    const capturePending = (l: Live) =>
      Effect.gen(function* () {
        const pending = l.pending;
        if (pending === undefined) return;
        l.pending = undefined;
        const item = yield* deps.capture(l.chief.profile.id, pending.text, Prompt.callBlock(l.turns.slice(-CALL_TURNS), l.call.showing)).pipe(Effect.option);
        if (item._tag === "None") {
          l.toSay.push("Hmm, that didn't reach the Chief. Worth saying again in a moment.");
          return;
        }
        l.notes.set(item.value.id, pending.text);
        // The state it starts in, as a ring back compares against: the board loop may next look at it only once its chat
        // is done (a busy runtime), and an item first seen ready would otherwise never ring.
        ringState.set(item.value.id, item.value.state);
        yield* rememberItem(item.value.id).pipe(Effect.ignore);
        yield* flushHeld(l, { item_id: item.value.id, text: pending.text });
      });

    const hear = (l: Live, heard: Heard): Effect.Effect<ReadonlyArray<VoiceAction>, unknown> =>
      Effect.gen(function* () {
        switch (heard.type) {
          case "ready": {
            if (l.call.state !== "connecting") return [];
            l.liveMs = now();
            l.lastActivityMs = now();
            l.call = { ...l.call, state: "live", live_at: iso() };
            // With its Chief: a restart ends it in that Chief's transcript.
            yield* store.kvSet(LIVE_KEY, JSON.stringify({ call_id: l.call.id, chief_id: l.chief.profile.id })).pipe(Effect.ignore);
            yield* appendToChief(l.chief.record, [{ at: iso(), type: "voice.call", payload: { call_id: l.call.id, state: "started" } } as DraftEvent]);
            yield* updated(l);
            // A ring back answered: the work it rang about is on screen as the call opens.
            if (l.call.about_item_id !== undefined) yield* showItem(l, l.call.about_item_id, "work");
            // The board may have moved after opening() while the client connected.
            // Reconcile against the start snapshot now, before those changes are lost.
            yield* onBoard(yield* deps.allItems);
            return [];
          }
          case "show": {
            const target = l.subject ?? l.call.about_item_id;
            const showing = target === undefined ? undefined : yield* showItem(l, target, heard.what, heard.file);
            l.lastActivityMs = now();
            return [
              {
                type: "answer",
                id: heard.id,
                name: heard.name,
                text:
                  showing === undefined
                    ? "Nothing is being walked through, so there's nothing to show. Say so in a few words."
                    : `On their screen now: ${showing.caption}. Say one short line about what they're looking at, as a caption, and nothing more.`,
              },
            ];
          }
          case "turn": {
            l.turns.push({ role: heard.role, text: heard.text });
            l.lastActivityMs = now();
            if (heard.role === "person") {
              l.personSpeaking = false;
              l.personOpen = false;
              l.personMs = now();
              // Two person turns in a row: the first is theirs alone, the second may still be handed off.
              yield* flushHeld(l);
              l.heldTurn = { text: heard.text, at: now() };
              return [];
            }
            // An update it was asked to say came back as its own words: it was spoken.
            if (l.saying !== undefined && heard.text.trim() === l.saying.trim()) l.saying = undefined;
            yield* flushHeld(l);
            if (!l.relayed.delete(heard.text.trim())) yield* turnEvent(l, "voice", heard.text);
            return [];
          }
          case "person_speaking":
            l.personSpeaking = true;
            l.personOpen = true;
            l.personMs = now();
            l.lastActivityMs = now();
            return [];
          case "voice_speaking":
            l.voiceSpeaking = true;
            l.answeredMs ??= now();
            return [];
          case "voice_done":
            l.voiceSpeaking = false;
            l.voiceDoneMs = now();
            l.lastActivityMs = now();
            l.saying = undefined;
            return trySay(l);
          case "handoff":
            l.lastActivityMs = now();
            return yield* handoff(l, heard.id, heard.name);
          case "goodbye":
            l.wrapped = true;
            l.goodbye ??= { reason: "goodbye", at: now() };
            // The voice says its own goodbye; lines still waiting would only delay the hang-up.
            l.toSay.length = 0;
            // Nothing more is coming: what they handed off goes to the Chief now.
            yield* capturePending(l);
            return [{ type: "answer", id: heard.id, name: heard.name, text: Prompt.GOODBYE_ANSWER }];
          case "cancelled":
            // A handoff already captured stands: the person said those words.
            return [];
          case "refused":
            if (l.saying !== undefined) l.toSay.unshift(l.saying);
            l.saying = undefined;
            return [];
          case "error":
            if (heard.fatal) yield* endLocked(l, "provider");
            else yield* Effect.logWarning("chief voice: the engine reported", { message: heard.message });
            return [];
        }
      });

    /**
     * The engine's messages from the client, in its order: `seq` counts from 0, and one that comes early waits for
     * those before it (3 s at most, then goes anyway).
     */
    const signal = (callId: string, seq: number, events: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const first = yield* lock.withPermits(1)(callFor(callId));
        if (seq > first.seq) {
          const turn = yield* Deferred.make<void>();
          first.early.set(seq, turn);
          yield* Deferred.await(turn).pipe(Effect.timeoutOption("3 seconds"));
          first.early.delete(seq);
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const l = yield* callFor(callId);
            if (seq < l.seq) return { send: [] };
            l.seq = seq + 1;
            const actions: Array<VoiceAction> = [];
            for (const event of events) {
              for (const heard of engine.decode(event)) {
                actions.push(...(yield* hear(l, heard)));
                // A fatal engine event ends this call. Later events in the same
                // client batch must not write notes or answer on its dead socket.
                if (live !== l) return { send: [] };
              }
            }
            const next = l.early.get(l.seq);
            if (next !== undefined) yield* Deferred.succeed(next, undefined);
            return { send: actions.flatMap(engine.encode) };
          }),
        );
      });

    // ---------------------------------------------------------------- the Chief's work, as it lands

    /** Chief session events while a call is on: the turns that took this call's notes, spoken as they act. */
    const onChiefEvent = (event: SessionEvent) =>
      Effect.gen(function* () {
        const l = live;
        if (l === undefined || l.call.state !== "live") return;
        if (event.session_id !== l.chief.record.session.id || event.turn_id === undefined) return;
        const turnId = event.turn_id;
        if (event.type === "message.done" && event.payload.role === "user") {
          // The Chief took one of this call's notes: its actions in this turn are the call's to say.
          if (event.payload.from === undefined && [...l.notes.values()].includes(event.payload.text) && !l.turnsFor.has(turnId)) l.turnsFor.set(turnId, { spoke: false, filled: false, since: now(), also: [], text: "", tools: new Map() });
          return;
        }
        const turn = l.turnsFor.get(turnId);
        if (turn === undefined) return;
        const titles = new Map((yield* store.listWorkspaces()).map((r) => [r.workspace.id, r.workspace.title]));
        const names = { project: yield* projectNames, chat: (id: string) => titles.get(id) };
        const actions: Array<VoiceAction> = [];
        if (event.type === "tool.started") {
          turn.tools.set(event.item_id ?? "", { name: toolName(event.payload.name), input: record(event.payload.input) });
        } else if (event.type === "tool.done") {
          const tool = turn.tools.get(event.item_id ?? "");
          if (tool === undefined) return;
          const run = { name: tool.name, input: tool.input, result: toolAnswer(event.payload.result ?? event.payload.error), failed: event.payload.status !== "completed" };
          const line = Prompt.resultLine(run, names);
          if (line === undefined) return;
          // The first result of a turn is said as it lands, and a question always; the rest fold into one line at the end.
          if (!turn.spoke || tool.name === "ask") {
            turn.spoke = true;
            actions.push(...say(l, line));
          } else {
            const stub = Prompt.resultStub(run, names);
            if (stub !== undefined) turn.also.push(stub);
            know(l, line);
          }
        } else if (event.type === "message.done" && event.payload.role === "assistant") {
          turn.text = event.payload.text;
        } else if (event.type === "turn.done") {
          l.turnsFor.delete(turnId);
          const words = Prompt.spoken(turn.text, 2);
          if (turn.also.length > 0) actions.push(...say(l, Prompt.alsoLine(turn.also)));
          if (event.payload.status === "failed") actions.push(...say(l, "The Chief hit a problem with that. It's on the board."));
          else if (!turn.spoke && words !== "") {
            l.relayed.add(words.trim());
            actions.push(...say(l, words));
          }
          else if (words !== "") know(l, `the Chief added: ${Prompt.spoken(turn.text, 3)}`);
        }
        yield* sendNow(l, actions);
      });

    /** The board moved: the voice knows it, says what needs the person or is ready from this call, or rings back. */
    const onBoard = (items: ReadonlyArray<ChiefItem>) =>
      Effect.gen(function* () {
        const l = live;
        const handed = yield* callItems;
        const settings = yield* deps.settings;
        if (l === undefined || l.call.state === "ended") {
          // No call on: work handed off on one rings back once it is ready, or stuck. Muted, it arrives quietly instead:
          // the same message with `muted`, so nothing is lost and the person sees what would have rung.
          const muted = ringMuted(settings, now());
          for (const item of items) {
            if (!handed.has(item.id) || item.state === ringState.get(item.id)) continue;
            const was = ringState.get(item.id);
            ringState.set(item.id, item.state);
            if (was === undefined) continue;
            if (item.state !== "review" && item.state !== "done" && item.state !== "needs_you") continue;
            const title = item.title ?? Prompt.spoken(item.text, 1);
            // The Chief whose item it is rings: answering calls it.
            yield* publish({ kind: "ringing", item_id: item.id, title, state: item.state, line: Prompt.updateLine(title, item.state, item.detail), muted, ...(item.chief_id === undefined ? {} : { chief_id: item.chief_id }) });
          }
          return;
        }
        if (l.call.state !== "live") return;
        const actions: Array<VoiceAction> = [];
        // A call hears its own Chief's board: another Chief's work is not its to tell.
        for (const item of items.filter((i) => i.chief_id === l.chief.profile.id)) {
          const was = l.states.get(item.id);
          l.states.set(item.id, item.state);
          ringState.set(item.id, item.state);
          if (was === item.state) continue;
          const title = item.title ?? Prompt.spoken(item.text, 1);
          const mine = l.notes.has(item.id) || handed.has(item.id);
          if (item.state === "needs_you" || ((item.state === "review" || item.state === "done") && mine && was !== undefined && was !== "unsorted")) {
            if (item.state !== "needs_you") {
              // The report first, so a "yes, walk me through it" has something to walk through; and the work on screen.
              const full = (yield* itemsOf(l)).find((i) => i.id === item.id);
              if (full !== undefined) l.knowing.push(Prompt.readyText(yield* readyOf(full)));
              yield* flushKnow(l);
              yield* showItem(l, item.id, "work");
            }
            actions.push(...say(l, Prompt.updateLine(title, item.state === "needs_you" ? "needs_you" : item.state, item.detail)));
          } else if (was !== undefined) {
            know(l, `"${title}" is now ${item.state.replace("_", " ")}.`);
          } else {
            know(l, `new on the board: "${title}" (${item.state}).`);
          }
        }
        yield* sendNow(l, actions);
      });
    /** Once a second while a call is on: held words, waiting lines, the quiet and length limits, the cap. */
    let capCheckedMs = 0;
    const tick = lock.withPermits(1)(
      Effect.gen(function* () {
        const l = live;
        if (l === undefined) return;
        const t = now();
        if (l.call.state === "connecting") {
          if (t - l.startedMs > CONNECT_MS) yield* endLocked(l, "connection_lost");
          return;
        }
        if (l.heldTurn !== undefined && t - l.heldTurn.at > TURN_FLUSH_MS) yield* flushHeld(l);
        // A start of speech with no words after it (a cough, a door) stops holding the lines back.
        if (l.personSpeaking && t - l.personMs > 6_000) l.personSpeaking = false;
        if (settled(l, t)) yield* capturePending(l);
        // The Chief is still at a note with nothing landed to say: once, that it's working on it.
        for (const [turnId, turn] of l.turnsFor) {
          if (turn.spoke || turn.filled || t - turn.since < WORKING_MS) continue;
          turn.filled = true;
          queue(l, Prompt.workingLine(turnId));
        }
        // A line the engine took but never finished saying no longer holds the next one back.
        if (l.saying !== undefined && t - l.sayingMs > 15_000) l.saying = undefined;
        const actions: Array<VoiceAction> = [...trySay(l)];
        if (l.goodbye !== undefined) {
          // Hung up once the goodbye was sent and played out (the client lets its last audio finish too).
          const said = l.saying === undefined && l.toSay.length === 0 && !l.voiceSpeaking && t - l.voiceDoneMs > 1_200;
          if ((said && t - l.goodbye.at > 1_500) || t - l.goodbye.at > GOODBYE_MS) {
            yield* endLocked(l, l.goodbye.reason);
            return;
          }
        } else if (l.liveMs !== undefined && t - l.liveMs > MAX_MS) {
          yield* endLocked(l, "max_length");
          return;
        } else if (l.liveMs !== undefined && t - l.liveMs > WRAP_MS) {
          actions.push(...wrapUp(l, Prompt.MAX_LENGTH_GOODBYE, "max_length"));
        } else if (!l.personSpeaking && !l.voiceSpeaking && l.turnsFor.size === 0 && l.toSay.length === 0 && l.saying === undefined && l.pending === undefined && quietAt(l, t)) {
          const ring = !ringMuted(yield* deps.settings, t) && l.notes.size > 0;
          actions.push(...wrapUp(l, ring ? Prompt.QUIET_GOODBYE : Prompt.QUIET_GOODBYE_NO_RING, "quiet"));
        } else if (t - capCheckedMs > 30_000) {
          capCheckedMs = t;
          const room = yield* deps.capRoom;
          if (room !== undefined && l.liveMs !== undefined && ((t - l.liveMs) / 60_000) * l.usdPerMinute >= room) actions.push(...wrapUp(l, Prompt.CAP_GOODBYE, "cap"));
        }
        yield* sendNow(l, actions);
      }),
    );

    /** A call the runtime was on when it stopped: over, with what it can still say. */
    const recover = Effect.gen(function* () {
      const raw = yield* store.kvGet(LIVE_KEY);
      if (raw === undefined || raw === "") return;
      yield* store.kvSet(LIVE_KEY, "");
      // Its call id and Chief; a bare id is from before there were several Chiefs: the Chief with the latest activity takes the line.
      const parsed = (() => {
        try {
          return record(JSON.parse(raw) as unknown);
        } catch {
          return { call_id: raw };
        }
      })();
      const callId = String(parsed.call_id ?? raw);
      const chief = yield* deps.chief(typeof parsed.chief_id === "string" ? parsed.chief_id : undefined);
      yield* appendToChief(chief.record, [{ at: iso(), type: "voice.call", payload: { call_id: callId, state: "ended", reason: "runtime_restart" } } as DraftEvent]);
    }).pipe(Effect.ignore);

    /** Fork it once: it runs for the route's life. */
    const watch = Effect.gen(function* () {
      yield* recover;
      for (const item of yield* deps.allItems) ringState.set(item.id, item.state);
      const events = yield* PubSub.subscribe(store.events);
      const board = yield* PubSub.subscribe(deps.boardChanges);
      const loop = <A>(take: Effect.Effect<A>, handle: (a: A) => Effect.Effect<void, unknown>) =>
        Effect.forever(take.pipe(Effect.flatMap((a) => lock.withPermits(1)(handle(a)).pipe(Effect.catchCause((cause) => Effect.logWarning("chief voice: an update was not handled", cause))))));
      yield* Effect.all(
        [
          loop(PubSub.take(events), onChiefEvent),
          // Every Chief's items: rings come from any Chief, and a call on now hears its own Chief's (onBoard).
          loop(PubSub.take(board), () => deps.allItems.pipe(Effect.flatMap(onBoard))),
          Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(tick), Effect.catchCause((cause) => Effect.logWarning("chief voice: tick failed", cause)))),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.scoped);

    /** Checks the key with the engine, then keeps it sealed (null removes it). A refused key is never kept; one it could not check (offline) is, as model keys are. */
    const setKey = (engineId: string, raw: string | null) =>
      Effect.gen(function* () {
        if (engineId !== engine.id) return yield* Effect.fail(new VoiceRefused("invalid_params", `No voice engine ${engineId}.`));
        if (raw !== null) {
          // Before the engine is asked about it: a key this computer may not keep is sent nowhere. Removing one stays.
          yield* deps.keys.takes;
          const key = plausibleKey(raw);
          if (key === undefined) return yield* Effect.fail(new VoiceRefused("invalid_params", `That is not a ${engine.label} API key.`));
          const checked = yield* engine.check(key).pipe(Effect.result);
          if (checked._tag === "Failure" && checked.failure.kind === "refused") return yield* Effect.fail(new VoiceRefused("key_refused", checked.failure.message));
          yield* deps.keys.write(engine.id, key).pipe(Effect.mapError((e) => new VoiceRefused("invalid_state", e.message)));
        } else yield* deps.keys.write(engine.id, null).pipe(Effect.mapError((e) => new VoiceRefused("invalid_state", e.message)));
        return yield* status;
      });

    return { out, status, start, signal, setMuted, end, closeConnection, setKey, watch, engine };
  });

export type Voice = Effect.Success<ReturnType<typeof makeVoice>>;
export { VoiceEngineError };
