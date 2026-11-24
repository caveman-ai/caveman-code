// Turn telemetry (docs/): each finished turn, folded from the session
// journal after the fact, as the anonymous fact the desktop sends when the person has telemetry on. Pure and
// synchronous; turnTelemetry.ts reads the journal, looks chats up and keeps this state between asks.
//
// A turn's fact is held from its turn.done until it is settled, so it can say what the person did next: the chat's
// next turn starts (and its prompt arrives), or SETTLE_MS pass. Nothing here leaves the computer except the Fact:
// prompt hashes, real ids and paths stay in the state.
import { createHash } from "node:crypto";

import type { SessionEvent, TurnFact } from "@caveman-app/session-protocol";

/** A turn's fact as the fold fills it in (the wire's TurnFact without its outbox seq). */
export type Fact = { -readonly [K in keyof Omit<TurnFact, "seq">]: TurnFact[K] };
type Origin = Fact["origin"];
type RunnerPick = NonNullable<Fact["pick"]>;

/** A finished turn waits this long for the chat's next turn; after it, its `next` is "none". */
export const SETTLE_MS = 30 * 60_000;
/** Chats remembered between asks, newest first; one with a running or held turn is never dropped. */
const MAX_CHATS = 300;
/** Ids of turns already counted: a journal rewritten by a move or an adopt brings them back. */
const MAX_EMITTED = 500;

/**
 * Model, engine and effort names as the receiver takes them (Cloud's cli_telemetry_turn.go codeTurnToken): a letter or
 * digit, then up to 79 of these, and never a path to someone's files (a drive letter, or a Users or home folder).
 */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$/;
const pathLike = (value: string): boolean => {
  const segments = value.split("/");
  if (segments.length < 2) return false;
  if (/^[A-Za-z]:$/.test(segments[0]!)) return true;
  return segments.slice(0, -1).some((segment) => /^(users|home)$/i.test(segment));
};
export const token = (value: unknown): string => (typeof value === "string" && TOKEN.test(value) && !pathLike(value) ? value : "other");

const ENGINES = new Set(["caveman", "claude-agent", "codex", "cursor", "opencode", "muse", "grok", "pi", "antigravity"]);
/** An engine the receiver knows, or an ACP agent by its name; anything else is "other". */
export const engineToken = (value: unknown): string => {
  const name = token(value);
  return ENGINES.has(name) || (name.startsWith("acp:") && name.length > 4) ? name : "other";
};
const optionalToken = (value: unknown): string | undefined => (value === undefined || value === null || value === "" ? undefined : token(value));

/** A length, rounded down to a power of two: the prompt's size, never something to match it by. */
export const powerOfTwo = (n: number): number => (n < 1 ? 0 : 2 ** Math.floor(Math.log2(n)));

const hash = (...parts: ReadonlyArray<string>) => createHash("sha256").update(parts.join("\0")).digest("hex");

/** What the fold needs to know about a chat the first time it meets it (turnTelemetry.ts looks it up). */
export interface ChatInfo {
  readonly origin: Origin;
  readonly pick?: RunnerPick | undefined;
  /** A fork: its events up to this cursor are copies of its source's, counted there. */
  readonly copiedThrough?: number | undefined;
  /** Turns it had before the event the fold met it at. */
  readonly turns: number;
  /** Its context fill before that event. */
  readonly context?: readonly [used: number, window: number] | undefined;
}

type Choice = Pick<Fact, "engine" | "model" | "effort" | "speed">;

/** A turn as far as the journal has told it. Plain data: it is kept as JSON between asks. */
interface Turn {
  /** The journal's turn id: never leaves. */
  readonly key: string;
  readonly cursor: number;
  readonly startedAt: number;
  /** Started before `since`, or counted already: its events are read and ignored. */
  skip?: true;
  fact: Fact;
  /** The prompt's hash, to tell when the next turn sends it again. */
  prompt?: string;
  /** Open top-level tools and open asks, by item (when each started, epoch ms). */
  tools: Record<string, number>;
  asks: Record<string, number>;
  /** When the time so far was last shared out between waiting and tools (tick). */
  mark?: number;
  /** An open approval's options that deny. */
  denies: Record<string, ReadonlyArray<string>>;
  doneAt?: number;
  checkpoint?: string;
  /** The chat's next turn started: what it ran with, waiting for its prompt to settle this one. */
  next?: Choice & { readonly at: number };
}

/** A person's (or a sender's) message that starts a turn, as the fold keeps it: a hash and sizes, never its words. */
interface Prompt {
  readonly hash: string;
  readonly chars: number;
  readonly images: number;
  readonly files: number;
  readonly queued: boolean;
  readonly origin?: "scheduled" | "agent" | undefined;
}

const promptOf = (message: Extract<SessionEvent, { type: "message.done" }>["payload"]): Prompt => {
  const text = typeof message.text === "string" ? message.text : "";
  const attachments = message.attachments ?? [];
  return {
    hash: hash("prompt", text),
    chars: powerOfTwo(text.length),
    images: attachments.filter((a) => a.type === "image").length,
    files: attachments.filter((a) => a.type !== "image").length,
    queued: message.delivery === "queue",
    origin: message.scheduled_task !== undefined ? "scheduled" : message.from !== undefined ? "agent" : undefined,
  };
};

interface Chat {
  /** The newest event's time (epoch ms): which chats to forget first. */
  at: number;
  /** A chat's first message is journaled before its turn starts, with no turn id: it waits here for that turn. */
  waiting?: Prompt | undefined;
  turns: number;
  context?: readonly [number, number] | undefined;
  origin: Origin;
  pick?: RunnerPick | undefined;
  copiedThrough?: number | undefined;
  /** The highest cursor read, and the newest event time: a rewritten journal's replayed events are at or below both. */
  through?: number | undefined;
  lastAt?: string | undefined;
  versions: Record<string, string>;
  run?: Turn | undefined;
  held?: Turn | undefined;
}

export interface FoldState {
  chats: Record<string, Chat>;
  emitted: Array<string>;
}

export const emptyFoldState = (): FoldState => ({ chats: {}, emitted: [] });

export interface FoldInput {
  /** Turns that started before this (the disclosure's moment) are never counted. */
  readonly since: string;
  /** Never leaves this computer: the opaque ids are hashed with it. */
  readonly salt: string;
  /** The chat's info, for one the state has not met (turnTelemetry.ts looked them all up before the fold). */
  readonly info: (sessionId: string) => ChatInfo | undefined;
}

/** The chats the state has not met among these events, with each one's first cursor (for turnTelemetry's lookups). */
export function unmet(state: FoldState, events: ReadonlyArray<SessionEvent>): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) if (state.chats[event.session_id] === undefined && !out.has(event.session_id)) out.set(event.session_id, event.cursor);
  return out;
}

const blank = (input: {
  readonly id: string;
  readonly session: string;
  readonly startedAt: string;
  readonly index: number;
  readonly origin: Origin;
}): Fact => ({
  id: input.id,
  session: input.session,
  started_at: input.startedAt,
  index: input.index,
  engine: "other",
  model: "other",
  mode: "default",
  origin: input.origin,
  queued: false,
  prompt_chars: 0,
  images: 0,
  files: 0,
  status: "completed",
  moved: false,
  retries: 0,
  rate_limited: false,
  duration_ms: 0,
  wait_ms: 0,
  tool_ms: 0,
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  compactions: 0,
  compactions_failed: 0,
  tools: 0,
  tools_failed: 0,
  tools_declined: 0,
  tool_command: 0,
  tool_read: 0,
  tool_edit: 0,
  tool_search: 0,
  tool_web: 0,
  tool_mcp: 0,
  tool_browser: 0,
  tool_other: 0,
  subagents: 0,
  subagents_failed: 0,
  approvals: 0,
  approvals_denied: 0,
  questions: 0,
  steers: 0,
  todos: 0,
  todos_done: 0,
  files_changed: 0,
  lines_added: 0,
  lines_removed: 0,
  next: "none",
  next_same_prompt: false,
  undone: false,
  kept: false,
  restored: false,
});

const TOOL_KINDS = {
  command: "tool_command",
  read: "tool_read",
  edit: "tool_edit",
  search: "tool_search",
  web: "tool_web",
  mcp: "tool_mcp",
  browser: "tool_browser",
  other: "tool_other",
} as const;

const ms = (n: number) => Math.max(0, Math.round(n));
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * Two significant figures (exact below 100): close enough to compare models, too coarse to line a turn up with one row
 * of the signed-in usage reports (cloudLink/usageReporter.ts), which carry exact counts and times.
 */
export const roughly = (n: number): number => {
  if (n < 100) return n;
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / step) * step;
};
const toHour = (iso: string): string => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const hour = new Date(time);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
};
const roughlyOptional = (n: number | undefined) => (n === undefined ? {} : { value: roughly(n) });

/** The fact as it leaves: its start to the hour, and its times and token counts to two significant figures. */
const coarse = (fact: Fact): Fact => {
  const out: Fact = {
    ...fact,
    started_at: toHour(fact.started_at),
    input_tokens: roughly(fact.input_tokens),
    output_tokens: roughly(fact.output_tokens),
    cache_read_tokens: roughly(fact.cache_read_tokens),
    cache_write_tokens: roughly(fact.cache_write_tokens),
    duration_ms: roughly(fact.duration_ms),
    wait_ms: roughly(fact.wait_ms),
    tool_ms: roughly(fact.tool_ms),
  };
  for (const key of ["ttft_ms", "next_gap_ms", "context_tokens", "context_end_tokens"] as const) {
    const rounded = roughlyOptional(fact[key]);
    if ("value" in rounded) out[key] = rounded.value;
  }
  return out;
};

/**
 * Shares the time since the turn's last mark: to waiting while an ask is open (several at once count once), else to
 * tools while a top-level tool runs (parallel ones count once). What is left of the turn is the model's.
 */
const tick = (turn: Turn, at: number) => {
  if (!Number.isFinite(at)) return;
  if (turn.mark !== undefined) {
    const elapsed = ms(at - turn.mark);
    if (Object.keys(turn.asks).length > 0) turn.fact.wait_ms += elapsed;
    else if (Object.keys(turn.tools).length > 0) turn.fact.tool_ms += elapsed;
  }
  turn.mark = at;
};

/** The first of engine, model, effort and speed the next turn changed. */
const switched = (from: Fact, to: Choice): Fact["next_switch"] =>
  from.engine !== to.engine ? "engine" : from.model !== to.model ? "model" : from.effort !== to.effort ? "effort" : from.speed !== to.speed ? "speed" : undefined;

/** The held turn's fact, with what came next: the next turn (and whether it sent the same prompt), or nothing. */
function settled(turn: Turn, next: { readonly choice: Choice & { readonly at: number }; readonly prompt: string | undefined } | undefined): Fact {
  const fact: Fact = { ...turn.fact };
  if (next === undefined) return coarse({ ...fact, next: "none" });
  const change = switched(fact, next.choice);
  return coarse({
    ...fact,
    next: "followup",
    next_gap_ms: ms(next.choice.at - (turn.doneAt ?? next.choice.at)),
    ...(change === undefined ? {} : { next_switch: change }),
    next_same_prompt: turn.prompt !== undefined && turn.prompt === next.prompt,
  });
}

/**
 * Folds journal events (in journal order; heavy payloads may be stripped, see turnTelemetry.ts) into `state`, and
 * returns the facts of the turns that settled. Mutates `state`.
 */
export function fold(state: FoldState, events: ReadonlyArray<SessionEvent>, input: FoldInput): Array<Fact> {
  const out: Array<Fact> = [];
  const emitted = new Set(state.emitted);
  const emit = (fact: Fact) => {
    if (emitted.has(fact.id)) return;
    emitted.add(fact.id);
    out.push(fact);
  };
  const settleHeld = (chat: Chat, prompt: string | undefined) => {
    const held = chat.held;
    if (held === undefined) return;
    chat.held = undefined;
    if (!held.skip) emit(settled(held, held.next === undefined ? undefined : { choice: held.next, prompt }));
  };
  /** The turn's prompt arrived: its sizes and sender, and the turn before settles on it (was it the same again?). */
  const prompted = (chat: Chat, run: Turn, prompt: Prompt) => {
    run.prompt = prompt.hash;
    if (!run.skip) {
      run.fact.prompt_chars = prompt.chars;
      run.fact.images = prompt.images;
      run.fact.files = prompt.files;
      run.fact.queued = prompt.queued;
      if (run.fact.origin === "person" && prompt.origin !== undefined) run.fact.origin = prompt.origin;
    }
    if (chat.held?.next !== undefined) settleHeld(chat, prompt.hash);
  };

  for (const event of events) {
    let chat = state.chats[event.session_id];
    if (chat === undefined) {
      const info = input.info(event.session_id) ?? { origin: "person", turns: 0 };
      chat = state.chats[event.session_id] = {
        at: 0,
        turns: info.turns,
        context: info.context,
        origin: info.origin,
        pick: info.pick,
        copiedThrough: info.copiedThrough,
        versions: {},
      };
    }
    // A fork's copies of its source's events were counted with the source.
    if (chat.copiedThrough !== undefined && event.cursor <= chat.copiedThrough) continue;
    // A journal rewritten since the fold read it (a chat moved back, adopted, rebuilt from Cloud's copy) holds the
    // events it read again, at new rowids: no newer than any it read, by cursor and by time. Read once, they settle
    // nothing twice. A new epoch's own events are newer than every old one.
    if (chat.through !== undefined && chat.lastAt !== undefined && event.cursor <= chat.through && event.at <= chat.lastAt) continue;
    chat.through = Math.max(chat.through ?? 0, event.cursor);
    if (chat.lastAt === undefined || event.at > chat.lastAt) chat.lastAt = event.at;
    // An event of a shape the fold does not expect is skipped: one odd row never stops turn stats.
    try {
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) chat.at = Math.max(chat.at, at);
      const turnId = event.turn_id;
      const target: Turn | undefined =
        turnId === undefined ? chat.run : chat.run?.key === turnId ? chat.run : chat.held?.key === turnId ? chat.held : undefined;
      const live = target !== undefined && !target.skip ? target : undefined;
      const fact = live?.fact;
      const topLevel = event.parent_item_id === undefined;

      switch (event.type) {
        case "turn.started": {
          if (turnId === undefined) break;
          chat.turns += 1;
          const payload = event.payload;
          const choice: Choice = {
            engine: engineToken(payload.engine),
            model: token(payload.model),
            ...(optionalToken(payload.effort) === undefined ? {} : { effort: optionalToken(payload.effort)! }),
            ...(optionalToken(payload.speed) === undefined ? {} : { speed: optionalToken(payload.speed)! }),
          };
          // A turn that never ended (the runtime died under it, and nothing closed it) says nothing reliable.
          chat.run = undefined;
          if (chat.held !== undefined) {
            if (chat.held.doneAt !== undefined && at - chat.held.doneAt > SETTLE_MS) settleHeld(chat, undefined);
            else if (chat.held.next === undefined) chat.held.next = { ...choice, at };
            else settleHeld(chat, undefined); // a second turn before the first one's prompt: settle on what is known
          }
          const id = hash(input.salt, "turn", event.session_id, turnId).slice(0, 32);
          const turn: Turn = {
            key: turnId,
            cursor: event.cursor,
            startedAt: at,
            fact: {
              ...blank({
                id,
                session: hash(input.salt, "session", event.session_id).slice(0, 32),
                startedAt: event.at,
                index: chat.turns,
                origin: chat.origin,
              }),
              ...choice,
              mode: payload.mode === "grill" ? "grill" : "default",
              ...(payload.access === undefined ? {} : { access: payload.access }),
              ...(chat.pick === undefined ? {} : { pick: chat.pick }),
              ...(chat.versions[payload.engine] === undefined ? {} : { engine_version: chat.versions[payload.engine]! }),
              ...(chat.context === undefined ? {} : { context_tokens: count(chat.context[0]), context_window: count(chat.context[1]) }),
            },
            tools: {},
            asks: {},
            denies: {},
          };
          if (event.at < input.since || emitted.has(id)) turn.skip = true;
          chat.run = turn;
          if (chat.waiting !== undefined) {
            prompted(chat, turn, chat.waiting);
            chat.waiting = undefined;
          }
          break;
        }
        case "message.done": {
          if (event.payload.role !== "user") break;
          const run = chat.run;
          // Before any turn of its own started (a new chat's first message): it waits for that turn.
          if (turnId === undefined && run === undefined) {
            chat.waiting = promptOf(event.payload);
            break;
          }
          if (run === undefined || (turnId !== undefined && run.key !== turnId)) break;
          if (run.prompt !== undefined) {
            if (event.payload.delivery === "steer" && !run.skip) run.fact.steers += 1;
            break;
          }
          prompted(chat, run, promptOf(event.payload));
          break;
        }
        case "tool.started": {
          if (fact === undefined || !topLevel || event.item_id === undefined) break;
          fact.tools += 1;
          fact[TOOL_KINDS[event.payload.kind] ?? "tool_other"] += 1;
          tick(live!, at);
          live!.tools[event.item_id] = at;
          break;
        }
        case "tool.done": {
          if (fact === undefined || !topLevel || event.item_id === undefined) break;
          if (event.payload.status === "failed") fact.tools_failed += 1;
          if (event.payload.status === "declined") fact.tools_declined += 1;
          tick(live!, at);
          delete live!.tools[event.item_id];
          break;
        }
        case "subagent.started":
          if (fact !== undefined && topLevel) fact.subagents += 1;
          break;
        case "subagent.done":
          if (fact !== undefined && topLevel && event.payload.status === "failed") fact.subagents_failed += 1;
          break;
        case "ask.user": {
          if (fact === undefined || event.item_id === undefined) break;
          const ask = event.payload;
          if (ask.kind === "approval") {
            fact.approvals += 1;
            live!.denies[event.item_id] = (ask.options ?? []).filter((option) => option.decision === "deny").map((option) => option.id);
          } else if (ask.kind === "question") fact.questions += 1;
          tick(live!, at);
          live!.asks[event.item_id] = at;
          break;
        }
        case "ask.resolved": {
          if (fact === undefined || event.item_id === undefined) break;
          tick(live!, at);
          const response = event.payload.response;
          if (response?.kind === "approval" && (live!.denies[event.item_id] ?? []).includes(response.option_id)) fact.approvals_denied += 1;
          delete live!.asks[event.item_id];
          delete live!.denies[event.item_id];
          break;
        }
        case "plan.updated":
          if (fact !== undefined) {
            fact.todos = event.payload.steps.length;
            fact.todos_done = event.payload.steps.filter((step) => step.status === "completed").length;
          }
          break;
        case "usage": {
          if (fact === undefined) break;
          const usage = event.payload;
          fact.requests += 1;
          fact.input_tokens += count(usage.input_tokens);
          fact.output_tokens += count(usage.output_tokens);
          fact.cache_read_tokens += count(usage.cache_read_tokens);
          fact.cache_write_tokens += count(usage.cache_write_tokens);
          fact.web_searches += count(usage.web_searches);
          if (usage.billing !== undefined) fact.billing = usage.billing;
          if (fact.ttft_ms === undefined && usage.ttft_ms !== undefined) fact.ttft_ms = count(usage.ttft_ms);
          break;
        }
        case "context.updated":
          chat.context = [event.payload.used_tokens, event.payload.window_tokens];
          if (fact !== undefined && live === chat.run) fact.context_end_tokens = count(event.payload.used_tokens);
          break;
        case "compaction.done":
          if (fact !== undefined) {
            fact.compactions += 1;
            if (event.payload.status === "failed") fact.compactions_failed += 1;
          }
          break;
        case "model.routed":
          if (fact !== undefined) fact.routed_model = token(event.payload.model);
          break;
        case "engine.status": {
          const status = event.payload;
          if (status.version !== undefined) chat.versions[status.engine] = token(status.version);
          if (fact !== undefined && status.engine === live!.fact.engine) {
            if (status.version !== undefined) fact.engine_version = token(status.version);
            if (status.rate_limit?.limited === true) fact.rate_limited = true;
          }
          break;
        }
        case "error":
          if (fact !== undefined) {
            if (event.payload.retry !== undefined) fact.retries += 1;
            if (event.payload.failure?.class === "usage_limit") fact.rate_limited = true;
          }
          break;
        case "turn.done": {
          const run = chat.run;
          if (run === undefined || run.key !== turnId) break;
          chat.run = undefined;
          run.doneAt = at;
          if (!run.skip) {
            const done = event.payload;
            run.fact.status = done.status;
            run.fact.moved = done.reason === "moved";
            run.fact.duration_ms = ms(at - run.startedAt);
            if (done.failure !== undefined) {
              run.fact.failure_class = done.failure.class;
              if (done.failure.code !== undefined) run.fact.failure_code = token(done.failure.code);
              if (done.failure.class === "usage_limit") run.fact.rate_limited = true;
            }
            // Asks and tools still open when the turn ended lasted until it ended.
            tick(run, at);
          }
          run.tools = {};
          run.asks = {};
          run.denies = {};
          // The turn before settles now if this one had no prompt of its own.
          if (chat.held?.next !== undefined) settleHeld(chat, run.prompt);
          else if (chat.held !== undefined) settleHeld(chat, undefined);
          chat.held = run;
          break;
        }
        case "checkpoint.created": {
          if (fact === undefined) break;
          const files = event.payload.files ?? [];
          live!.checkpoint = event.payload.checkpoint_id;
          fact.files_changed = files.length;
          fact.lines_added = files.reduce((sum, file) => sum + count(file.additions), 0);
          fact.lines_removed = files.reduce((sum, file) => sum + count(file.deletions), 0);
          break;
        }
        case "checkpoint.resolved": {
          const held = chat.held?.checkpoint === event.payload.checkpoint_id ? chat.held : chat.run?.checkpoint === event.payload.checkpoint_id ? chat.run : undefined;
          if (held === undefined || held.skip) break;
          if (event.payload.resolution === "undone") held.fact.undone = true;
          else held.fact.kept = true;
          break;
        }
        case "session.restored":
          for (const turn of [chat.held, chat.run]) if (turn !== undefined && !turn.skip && turn.cursor > event.payload.at) turn.fact.restored = true;
          break;
        default:
          break;
      }
    } catch {
      continue;
    }
  }

  state.emitted = [...emitted].slice(-MAX_EMITTED);
  return out;
}

/**
 * Settles the held turns whose chat stayed quiet for SETTLE_MS (as of `now`), and forgets idle chats past
 * MAX_CHATS. Run only once the journal has been read to its end: a backlog may still hold their next turn.
 */
export function settleQuiet(state: FoldState, now: number): Array<Fact> {
  const out: Array<Fact> = [];
  const emitted = new Set(state.emitted);
  for (const chat of Object.values(state.chats)) {
    const held = chat.held;
    if (held === undefined || held.next !== undefined || held.doneAt === undefined || now - held.doneAt < SETTLE_MS) continue;
    chat.held = undefined;
    if (held.skip || emitted.has(held.fact.id)) continue;
    emitted.add(held.fact.id);
    out.push(settled(held, undefined));
  }
  state.emitted = [...emitted].slice(-MAX_EMITTED);
  const idle = Object.entries(state.chats)
    .filter(([, chat]) => chat.run === undefined && chat.held === undefined)
    .sort(([, a], [, b]) => b.at - a.at);
  const busy = Object.keys(state.chats).length - idle.length;
  for (const [id] of idle.slice(Math.max(0, MAX_CHATS - busy))) delete state.chats[id];
  return out;
}
