// Test-only: one chaos run on a World (world.ts): chats on This Mac and both Cloud computers, every device viewing
// every chat, then a seeded mix of sends, stops, answers and faults; then quiet, then the invariants (DESIGN S11):
// - every device's transcript of every chat equals the owner's journal (same epoch, identical events by cursor);
// - every send ran at most once, and a send a device was told was accepted ran (or waits held in the queue);
// - one ask is answered once; every started turn ended;
// - Cloud's copy is a prefix of the owner's journal and catches up within 15 s of the last turn's end;
// - every device's list converges to Cloud's;
// - no view hangs (each ends in data or a stated reason within a bound);
// - nothing a device showed was replaced at the same epoch (only an epoch change may replace it).
import { queuedCallFields, type Client, type SessionEvent } from "@caveman-app/session-protocol";

import { createReady, MODEL, until } from "../../session-protocol/testHarness.ts";
import { eventKey, journalOf, loadWebSync, loseWalTail, PERSON, REPO, rng, sleep, type Device, type Rng, type RuntimeProc, type View, type World } from "./world.ts";

export type Fault =
  | "drop_sockets"
  | "drop_direct"
  | "drop_phone_relay"
  | "drop_runtime_relay"
  | "kill9_mac"
  | "kill9_box"
  | "box_asleep_queued"
  | "mac_asleep_send"
  | "lid"
  | "lid_return"
  | "move_named"
  | "lost_wal_tail"
  | "reload_outbox"
  | "box_empty_disk"
  | "box_older_disk";
export type Op = "send" | "send_ask" | "interrupt" | "send_then_interrupt" | "race_interrupt" | "answer" | "double_answer" | "both_paths";
export const ALL_FAULTS: ReadonlyArray<Fault> = ["drop_sockets", "drop_direct", "drop_phone_relay", "drop_runtime_relay", "kill9_mac", "kill9_box", "box_asleep_queued", "mac_asleep_send", "lid", "lid_return", "move_named", "lost_wal_tail", "reload_outbox", "box_empty_disk", "box_older_disk"];
const OPS: ReadonlyArray<readonly [Op, number]> = [
  ["send", 6],
  ["send_ask", 2],
  ["interrupt", 1],
  ["send_then_interrupt", 1],
  ["race_interrupt", 1],
  ["answer", 2],
  ["double_answer", 1],
  ["both_paths", 1],
];

export interface RunOptions {
  readonly seed: number;
  /** Steps after setup (ops and faults). */
  readonly steps: number;
  /** Faults that must happen in this run, at seeded places; more are drawn from `pool` with probability `faultRate`. */
  readonly faults?: ReadonlyArray<Fault>;
  readonly pool?: ReadonlyArray<Fault>;
  readonly faultRate?: number;
  /**
   * Steer clear of product bugs already known (KNOWN below, each with its entry), so a fixed seed tests everything else (CI).
   * Off, the run walks into them (CHAOS_LONG, CHAOS_KNOWN=1).
   */
  readonly avoidKnown?: boolean;
}

/**
 * Product bugs the chaos runs found, listed here with what each is (this list is where they are filed), that a CI run
 * steers around (avoidKnown). Delete an entry once its fix lands: the CI set then walks that path again.
 * - CHAOS-1 (fixed by lane A5): a chat moved onto a Cloud computer whose checkout another chat holds was stranded
 *   (adopt placed only at the checkout; it places as any chat there now, a worktree beside the first).
 * - CHAOS-2 (fixed by app ccd2f22c): a send queued in Cloud for a chat on This Mac failed device_not_approved.
 * - CHAOS-3 (fixed by A1): a chat's copy never got a boundary segment, so Cloud's own moves (the lid, a send to a
 *   sleeping Mac) stranded it.
 * - CHAOS-4 (fixed by lane A5): a stop or a crash right after a send erased the send (a turn that ends before its
 *   engine ran now keeps the person's message and ends interrupted).
 * - CHAOS-5 (fixed by A1): a lost WAL tail the copy never had left devices with events the journal reused at the same
 *   epoch; every chat a crashed run journaled now takes a new epoch.
 * - CHAOS-6 (fixed by A1, runtime side): a queued call taken by a runtime that then crashed waited out Cloud's lease.
 * - CHAOS-7 (fixed by lane A5): a stop right after a send was refused, naming the chat's first run (Stop takes the
 * newest turn, a starting one included, and one only finishing its checkpoint takes upstream own Stop).
 * - CHAOS-9 (fixed by lane A4's two-phase moves): Move to This Mac from a device stranded a Cloud computer's chat; the
 *   Mac now accepts a move onto it that a device it allowed signed, and refuses others before the source lets go.
 * - CHAOS-10 (fixed by lane A5): a chat moved off a Cloud computer kept its checkout there, so no new chat started
 *   (it lets the checkout go; what was made since is kept on a ref).
 * - CHAOS-12 (found by A1 once CHAOS-3 no longer stranded these moves; fixed by app ccc32ef0 and A1): sends This Mac
 *   queued behind a running turn stayed in its queue when Cloud moved the chat while the Mac slept. Every copy carries
 *   the queue now, and a change to the queue copies at once.
 * - CHAOS-14 (A1, 7008cd89): a send a runtime accepted under 2 s before it slept without a word, and before its copy
 *   took it, was lost when Cloud moved the chat from that copy. Now person input with nothing run is forwarded to the
 *   chat as queued calls, and turns that ran are kept as their own chat on that computer ("<title> (kept on this
 *   Mac)"); check reads both (keptElsewhere).
 * - CHAOS-19 (fixed with S01): a send that first reached that runtime as a Cloud call was forwarded
 *   under the person's request id into the call that runtime had already answered, and never ran (seed 114). A
 *   forward is its own call now (forwardedRequestId), the message keeps the person's id where it runs, and a restart
 *   before the forward still owes it.
 * - CHAOS-20 (found by seed 301 at load 20, 2026-11-07; fixed by handlers.ts followupGoesBefore): two follow-ups a
 *   device sent while a turn ran started in reverse. turn.submit queued each behind the running turn, then moved a
 *   follow-up ahead of the queue's first run (queued-run.reorder), which could be the earlier follow-up. A follow-up
 *   now goes ahead of the queue but behind the follow-ups waiting there already (followupReorder.test.ts, "two
 *   follow-ups sent behind a running turn start in the order they were sent"), and a move carries each queued
 *   message's kind, so the next computer places them the same way. Its signature stays a violation of its own
 *   (`reversals`, `chaos20`): the earlier one came in first (its run made first in one thread, by the ordinal each
 *   turn id ends in; across a move, first shown in the journal), the first queue snapshot listing the later one's run
 *   in a thread lists it ahead of the earlier one, and no held queue explains it.
 */
export const KNOWN = new Set<string>([]);
const KNOWN_FAULTS: Partial<Record<Fault, string>> = {};

/** One send's message in its chat's journal: where, how it was delivered, and the run it was first made as. */
export interface RanAt {
  readonly sent: Sent;
  readonly cursor: number;
  readonly delivery?: string;
  /**
   * The run the runtime first made for it (the first turn id the journal gives it, queued or started): its thread, and
   * the ordinal the runtime numbered it with as it made it (a turn id ends in ":ordinal:<n>"). A move makes the chat's
   * queued runs again, in another thread, in the order they were queued, so only the first says when it came in.
   */
  readonly run?: { readonly thread: string; readonly ordinal: number };
}

const runOf = (turnId: string | undefined) => {
  const m = /^(.*):ordinal:(\d+)$/.exec(turnId ?? "");
  return m ? { thread: m[1]!, ordinal: Number(m[2]) } : undefined;
};

/** Each of `sends` that ran once in `events`, in the order sent. */
export function ranIn(sends: ReadonlyArray<Sent>, events: ReadonlyArray<SessionEvent>): Array<RanAt> {
  const firstRun = new Map<string, string>();
  for (const e of events) {
    if (e.type === "queue.updated") for (const turn of e.payload.turns) if (!firstRun.has(turn.text)) firstRun.set(turn.text, turn.turn_id);
    if (e.type === "message.done" && e.payload.role === "user" && e.turn_id && !firstRun.has(e.payload.text)) firstRun.set(e.payload.text, e.turn_id);
  }
  const users = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e] : []));
  return sends.flatMap((sent) => {
    const mine = users.filter((e) => e.payload.text === sent.text);
    if (mine.length !== 1) return [];
    const e = mine[0]!;
    const run = runOf(firstRun.get(sent.text));
    return [{ sent, cursor: e.cursor, ...(e.payload.delivery ? { delivery: e.payload.delivery } : {}), ...(run ? { run } : {}) }];
  });
}

/**
 * How a pair ran out of the order sent came about, read from the runtime's own record (its journal) and what the
 * harness did to the chat (`Holds`).
 * - `both-paths`: the later one also went to Cloud's queue outside its device's lane (the both_paths step), and Cloud
 *   last handed that copy to a runtime before the earlier one first shows in the journal: that copy may have come in
 *   first, so the pair is not judged. The journal does not say which copy ran (the runtime runs a request id once,
 *   whichever comes first); a copy Cloud handed over again after the earlier one was in (the runtime that took it
 *   first died or let it follow its chat), or only then, or never, came in after it as the lane's copy did, and the
 *   pair is judged.
 * - `held`: the runtime held its queue with the earlier one in it and not the later one, and the later one was the
 * person's next message, which runs ahead of a held queue by design, as upstream Resume does. The hold shows
 *   as the last queue snapshot before the later one's message holding the earlier one and not the later one, or as
 *   what holds without writing a snapshot first: a restart of the runtime that held the chat (its recovery holds the
 *   queued runs and writes nothing unless a turn was running), or a turn that ended interrupted because the harness
 *   stopped it holding the queue (a Stop, a park for a move or the lid; one that ended interrupted otherwise, a lease
 *   lost while Cloud answers, a steer the engine never took, a cancel or a rollback, holds nothing). Either counts only
 *   for the first person's message to run after it, with the earlier one queued before it and the later one not.
 * - `chaos20`: CHAOS-20's own mechanism. The earlier one came in first (the first runs each got: in one thread, by
 *   their ordinals; across threads, after a move, by where each first shows in the journal), and as the later one's
 *   run was made in a thread, the first queue snapshot listing it there lists it ahead of the earlier one:
 *   turn.submit moved it there (queued-run.reorder), on that computer or on the one a move took the queue to, which
 *   makes its runs again through the same path. A queue a move carried or made again in another order, with no such
 *   snapshot, is not CHAOS-20.
 * - `came-in-reversed`: the runtime made the later one's run first: the calls came in reversed (the client's doing,
 *   or the way they took).
 * - `unexplained`: came in in the order sent, ran reversed, with neither a hold nor a reorder to show for it.
 * - `unknown`: their first runs share no thread and the later one shows first, so when each came in cannot be read.
 * Only `held` is the runtime's design; `chaos20` names CHAOS-20, fixed. The rest are violations.
 */
export type Reversal = "both-paths" | "held" | "chaos20" | "came-in-reversed" | "unexplained" | "unknown";

/** What the harness did that holds a chat's queue without the runtime writing a held snapshot first (epoch ms). */
export interface Holds {
  /** Kills of the runtime that held the chat then: its restart's recovery holds the queued runs. */
  readonly restarts?: ReadonlyArray<number>;
  /** Stops and parks (a move, the lid) of the chat: each stops its turn holding its queue. */
  readonly stops?: ReadonlyArray<number>;
}

/**
 * Every pair of `ran` (in the order sent) whose later send's message comes first in `events`: every pair, not only
 * neighbours.
 */
export function reversals(
  ran: ReadonlyArray<RanAt>,
  events: ReadonlyArray<SessionEvent>,
  { restarts = [], stops = [] }: Holds = {},
): Array<{ readonly before: RanAt; readonly after: RanAt; readonly how: Reversal }> {
  const queues = events.flatMap((e) => (e.type === "queue.updated" ? [{ cursor: e.cursor, turns: e.payload.turns }] : []));
  const said = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.cursor] : []));
  const firstQueued = (text: string) => queues.find((q) => q.turns.some((t) => t.text === text))?.cursor ?? Infinity;
  const firstSeen = (r: RanAt) => Math.min(firstQueued(r.sent.text), r.cursor);
  // Where the runtime held without a snapshot: right before the first event its restarted process wrote, and right
  // after a turn that ended interrupted with a stop or park since the turn before it ended (the stop that ended it).
  const ends = events.flatMap((e) => (e.type === "turn.done" ? [{ cursor: e.cursor, at: Date.parse(e.at), interrupted: e.payload.status === "interrupted" }] : []));
  const holds = [
    ...restarts.flatMap((at) => {
      const next = events.find((e) => Date.parse(e.at) >= at);
      return next ? [next.cursor - 0.5] : [];
    }),
    ...ends.flatMap((end, i) => {
      const since = ends[i - 1]?.at ?? -Infinity;
      return end.interrupted && stops.some((at) => at > since && at <= end.at) ? [end.cursor + 0.5] : [];
    }),
  ];
  const heldAhead = (before: RanAt, after: RanAt) => {
    const last = queues.filter((q) => q.cursor < after.cursor).at(-1);
    if (last !== undefined && last.turns.some((t) => t.text === before.sent.text && t.held === true) && !last.turns.some((t) => t.text === after.sent.text && t.held === true)) return true;
    return holds.some((hold) => firstQueued(before.sent.text) < hold && hold < firstSeen(after) && !said.some((cursor) => cursor > hold && cursor < after.cursor));
  };
  // The first snapshot listing the later one's run in each thread: what turn.submit did with it as it made it there.
  const movedAhead = (before: RanAt, after: RanAt) => {
    const threads = new Set<string>();
    return queues.some((q) => {
      const later = q.turns.findIndex((t) => t.text === after.sent.text);
      if (later === -1) return false;
      const thread = runOf(q.turns[later]!.turn_id)?.thread ?? "";
      if (threads.has(thread)) return false;
      threads.add(thread);
      const earlier = q.turns.findIndex((t) => t.text === before.sent.text);
      return earlier !== -1 && later < earlier;
    });
  };
  /** Cloud last handed the later one's both_paths copy to a runtime before the earlier one first shows in the journal. */
  const cloudCopyFirst = (before: RanAt, after: RanAt) => {
    const at = events.find((e) => e.cursor === firstSeen(before))?.at;
    return after.sent.bothPaths === true && after.sent.cloudCopyAt !== undefined && at !== undefined && after.sent.cloudCopyAt <= Date.parse(at);
  };
  /** Which of the two the runtime had first: by their first runs' ordinals in one thread, else by where each first shows. */
  const cameFirst = (before: RanAt, after: RanAt): "before" | "after" | undefined => {
    if (before.run !== undefined && after.run !== undefined && before.run.thread === after.run.thread) return before.run.ordinal < after.run.ordinal ? "before" : "after";
    // A move made the earlier one's run again in another thread: shown in the journal before the later one, it came first.
    return firstSeen(before) < firstSeen(after) ? "before" : undefined;
  };
  const out: Array<{ readonly before: RanAt; readonly after: RanAt; readonly how: Reversal }> = [];
  for (let i = 0; i < ran.length; i++)
    for (let j = i + 1; j < ran.length; j++) {
      const before = ran[i]!;
      const after = ran[j]!;
      if (after.cursor > before.cursor) continue;
      const first = cameFirst(before, after);
      const how: Reversal =
        cloudCopyFirst(before, after)
          ? "both-paths"
          : heldAhead(before, after)
            ? "held"
            : first === undefined
              ? "unknown"
              : first === "after"
                ? "came-in-reversed"
                : movedAhead(before, after)
                  ? "chaos20"
                  : "unexplained";
      out.push({ before, after, how });
    }
  return out;
}

/**
 * What the order check does with each reversal (`reversals`): `excused` (a held queue, which is the runtime's design,
 * or a both_paths copy that may have come in first; counted), `known` (CHAOS-20 while KNOWN lists it and the run
 * avoids known bugs; counted), or a `violation`. Nothing else excuses a pair: a Stop beside it that held the queue shows as `held`, and
 * one with no turn to stop holds nothing.
 */
export function judgeOrder(
  ran: ReadonlyArray<RanAt>,
  events: ReadonlyArray<SessionEvent>,
  holds: Holds,
  avoidKnown: boolean,
): Array<{ readonly before: RanAt; readonly after: RanAt; readonly how: Reversal; readonly verdict: "excused" | "known" | "violation" }> {
  return reversals(ran, events, holds).map((r) => ({
    ...r,
    verdict: r.how === "held" || r.how === "both-paths" ? "excused" : r.how === "chaos20" && avoidKnown && KNOWN.has("CHAOS-20") ? "known" : "violation",
  }));
}

export interface Chat {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdOn: string;
}

export interface Sent {
  readonly id: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly device: string;
  readonly text: string;
  readonly at: number;
  /** The runtime that held the chat when it was sent. */
  readonly owner: string;
  outcome: "pending" | "ok" | "error";
  disposition?: string;
  error?: string;
  via?: "runtime" | "cloud";
  bothPaths?: boolean;
  /**
   * Its both_paths copy: when Cloud last handed it to a runtime (epoch ms; none: never). Read at the order check. A
   * runtime that took it and died, or let it follow its chat, hands it on, so an earlier take says nothing.
   */
  cloudCopyAt?: number | undefined;
  /** The page reloaded while this call was still in its outbox (it must still run, once). */
  inOutboxAtReload?: boolean;
  /**
   * The page reloaded while this call was pending and not in its outbox. Counted (reload_unsaved_send). It must still
   * run, once, if the event loop had turned between the send and the reload (`turnedBeforeReload`): the device's store
   * here writes at once (memoryKv), so by then the outbox holds every send the product kept, wherever it waits. A reload
   * in the same turn as the send is the one window a reload may lose it in: told only.
   */
  unsavedAtReload?: boolean;
  /** The event loop turned since the send was made (a setImmediate after it ran). */
  turned?: boolean;
  /** It had `turned` when its page reloaded. */
  turnedBeforeReload?: boolean;
  /** How long it had been pending when its page reloaded. */
  pendingAtReloadMs?: number;
  /**
   * The page reloaded before the answer came. A dead page opens no connection and sends nothing more (world.ts Page:
   * its Cloud requests, sockets and peers refuse it), so its call may never settle and nobody is left to tell: the
   * journals alone say how it went. What it sent before it died may still arrive and run.
   */
  pageGone?: boolean;
}

interface Answer {
  readonly askId: string;
  readonly sessionId: string;
  readonly device: string;
  readonly requestId: string;
  /** Where the answer went: the chat's runtime, or Cloud's queue (whose call says later whether it counted). */
  via?: string;
  readonly at: number;
  /** The runtime that held the chat when it was answered. */
  readonly owner: string;
  outcome: "pending" | "ok" | "error";
  error?: string;
  /** The page reloaded before the answer came (Sent.pageGone). */
  pageGone?: boolean;
}

export interface RunResult {
  readonly seed: number;
  readonly violations: ReadonlyArray<string>;
  readonly faults: ReadonlyArray<string>;
  readonly counts: Record<string, number>;
  readonly copyCatchUpMs: number;
  readonly ms: number;
}

const BUSY = new Set(["starting", "working", "needs_input", "waiting"]);
/** Cloud's copy catches up within the copy outbox's 15 s of the journal's last change, plus 2 s for the upload. */
const COPY_WITHIN_MS = 17_000;
/**
 * A send or an answer still pending when its page reloads, after this long with its chat's runtime up and the device's
 * link to it unchanged, hung on the live page: one routed through ChatSender goes to Cloud's queue once it has not gone out
 * within UNSENT_MS (sender.ts), and Cloud answers at once; any other goes out the moment its link is up, and the
 * runtime answers a send or an answer at once. The rest is room for a loaded machine.
 */
const HANG_BEFORE_RELOAD_MARGIN_MS = 3_000;

export class ChaosRun {
  readonly chats: Array<Chat> = [];
  readonly sends: Array<Sent> = [];
  readonly answers: Array<Answer> = [];
  readonly violations: Array<string> = [];
  readonly faultsDone: Array<string> = [];
  readonly counts: Record<string, number> = {};
  private readonly r: Rng;
  private n = 0;
  /** When each chat was last stopped, and when each runtime was last killed (to tell CHAOS-4 and CHAOS-6 apart). */
  private readonly stops: Array<{ sessionId: string; at: number }> = [];
  /** Each kill, with the chats Cloud said the runtime held then: its restart holds their queues (checkOrder). */
  private readonly kills: Array<{ runtime: string; at: number; chats: ReadonlyArray<string> }> = [];
  /** When a chat was parked (a move, the lid): a park stops its turn holding its queue, as Stop does (checkOrder). */
  private readonly parks: Array<{ sessionId: string; at: number }> = [];
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private copyCatchUpMs = 0;
  /** sender.ts UNSENT_MS, read in setup. */
  private unsentMs = 3_000;

  readonly world: World;
  readonly options: RunOptions;

  constructor(world: World, options: RunOptions) {
    this.world = world;
    this.options = options;
    this.r = rng(options.seed);
  }

  private get trace() {
    return this.world.trace;
  }

  private count(what: string): void {
    this.counts[what] = (this.counts[what] ?? 0) + 1;
  }

  private violate(what: string): void {
    this.violations.push(what);
    this.trace.note(`VIOLATION ${what}`);
  }

  // ---------------------------------------------------------------------------------------------- setup

  async setup(): Promise<void> {
    const { world, options } = this;
    this.unsentMs = (await loadWebSync()).UNSENT_MS;
    const make = async (rt: RuntimeProc, label: string) => {
      const title = `s${options.seed} ${label}`;
      const repo = rt.role === "mac" ? { path: world.macRepo } : { url: `https://github.com/${REPO}` };
      const w = await createReady(rt.admin! as Parameters<typeof createReady>[0], {
        request_id: `create-${options.seed}-${label}`,
        repo,
        title,
        engine: "claude-agent",
        options: { model: MODEL, access: "ask" },
      });
      this.chats.push({ sessionId: w.session_id, workspaceId: w.id, title, createdOn: rt.name });
    };
    // Two chats on This Mac and one on box-b. box-a starts empty: Cloud sends the lid's and a sleeping Mac's chats to the
    // person's first Cloud computer, which is box-a.
    await make(world.mac, "mac-1");
    await make(world.mac, "mac-2");
    await make(world.boxB, "box-b");
    // A first turn on each, so every chat has a copy (a chat moves only once it copied something).
    for (const chat of this.chats) await this.ownerCall(chat, "turn.submit", { request_id: `warm-${chat.sessionId}`, session_id: chat.sessionId, kind: "followup", input: { text: `slow 200: warm ${chat.title}` } });
    await until(() => this.chats.every((c) => (world.cloud.state.chats.summaries.get(c.sessionId)?.head ?? 0) > 3 && world.cloud.state.chats.copyOf(c.sessionId).length > 0), 60_000);
    // Every device lists them and opens them all.
    for (const device of world.devices) {
      await until(() => this.chats.every((c) => device.hub!.list?.get().chats.has(c.sessionId) === true), 20_000);
      for (const chat of this.chats) device.view(chat.sessionId);
    }
    for (const chat of this.chats) {
      const session = world.cloud.state.chats.sessions.get(chat.sessionId);
      const last = session?.segments.at(-1);
      this.trace.note(`${chat.title}: follow ${session?.follow}, repo ${session?.repo}, ${session?.segments.length} segments, last boundary ${last?.boundary} wip ${String(last?.body.wip)} bundle ${last?.body.wip_bundle ? "yes" : "no"}`);
    }
    this.watchdog = setInterval(() => this.watch(), 1_000);
    this.cloudWatch = setInterval(() => this.watchCloud(), 200);
    this.trace.note(`seed ${options.seed}: ${this.chats.map((c) => `${c.title}=${c.sessionId.slice(0, 8)}`).join(", ")}`);
  }

  /** What Cloud last said of each chat (computer, epoch) and each queued call (status): a change goes in the trace. */
  private readonly cloudSaid = new Map<string, string>();
  private cloudWatch: ReturnType<typeof setInterval> | undefined;
  private watchCloud(): void {
    const { chats } = this.world.cloud.state;
    const name = (computerId: string) => this.world.runtimeOfComputer(computerId)?.name ?? computerId.slice(0, 6);
    for (const chat of this.chats) {
      const session = chats.sessions.get(chat.sessionId);
      if (!session) continue;
      const said = `${name(session.computer_id)} epoch ${session.epoch}`;
      if (this.cloudSaid.get(chat.sessionId) !== said) {
        if (this.cloudSaid.has(chat.sessionId)) this.trace.note(`cloud: ${chat.title} now on ${said}`);
        this.cloudSaid.set(chat.sessionId, said);
      }
    }
    for (const call of chats.calls.values()) {
      if (!this.chats.some((c) => c.sessionId === call.session_id)) continue;
      const session = chats.sessions.get(call.session_id);
      const said = `${call.status}${call.waiting ? ` (${call.waiting.reason})` : ""}`;
      if (this.cloudSaid.get(call.id) === said) continue;
      this.cloudSaid.set(call.id, said);
      this.trace.note(`cloud: call ${call.request_id} ${call.method} for ${this.label(call.session_id)} ${said}, the chat on ${session ? name(session.computer_id) : "?"}${call.error ? `: ${call.error.code} ${call.error.message.slice(0, 80)}` : ""}`);
    }
  }

  /**
   * A view stuck loading or reconnecting for 25 s while every runtime has been up all that time is a hang: it should be
   * live, or on Cloud's copy, or ended with a reason (DESIGN S4). While a runtime is down, asleep or starting, its
   * viewers may say "Reconnecting".
   */
  private watch(): void {
    const { runtimes } = this.world;
    if (runtimes.some((r) => !r.up())) {
      this.disrupted = Date.now();
      return;
    }
    const since = Math.max(this.disrupted, ...runtimes.map((r) => r.downAt));
    for (const device of this.world.devices) {
      for (const view of device.views.values()) {
        const stuck = Date.now() - Math.max(view.stateSince, since);
        if ((view.state.kind === "loading" || view.state.kind === "reconnecting") && stuck > 25_000) {
          this.violate(`hang: ${device.name} on ${this.label(view.sessionId)} stuck ${view.state.kind} for ${Math.round(stuck / 1000)} s with every runtime up (states ${view.states.slice(-6).join(",")})`);
          view.stateSince = Date.now();
        }
      }
    }
  }
  private disrupted = 0;

  label(sessionId: string): string {
    return this.chats.find((c) => c.sessionId === sessionId)?.title ?? sessionId.slice(0, 8);
  }

  // ---------------------------------------------------------------------------------------------- helpers

  private owner(chat: Chat): RuntimeProc {
    return this.world.ownerOf(chat.sessionId) ?? this.world.mac;
  }

  /** The chats Cloud says `rt` holds now. */
  private heldBy(rt: RuntimeProc): Array<string> {
    return this.chats.filter((c) => this.owner(c) === rt).map((c) => c.sessionId);
  }

  private ownerCall(chat: Chat, method: string, params: Record<string, unknown>) {
    return (this.owner(chat).call as (m: string, p: unknown) => Promise<any>)(method, params);
  }

  private async status(chat: Chat): Promise<string | undefined> {
    const rt = this.owner(chat);
    if (!rt.alive() || rt.asleep) return undefined;
    return (await rt.call("workspace.get", { workspace_id: chat.workspaceId }).catch(() => undefined))?.status;
  }

  /** A Cloud computer whose checkout a chat of this run holds (CHAOS-1: another chat moved there is stranded). */
  private occupied(rt: RuntimeProc): boolean {
    return rt.role === "cloud" && this.chats.some((c) => this.owner(c) === rt);
  }

  /** A move onto `rt` would walk into a bug already filed: skipped when the run avoids them. */
  private known(rt: RuntimeProc, fault: string): boolean {
    if (!this.options.avoidKnown || !KNOWN.has("CHAOS-1") || !this.occupied(rt)) return false;
    this.trace.note(`skip ${fault}: ${rt.name} holds a chat (CHAOS-1)`);
    this.count(`skipped_known:${fault}`);
    return true;
  }

  /** Devices a person can use now: the desktop sleeps with its Mac. */
  private awakeDevices(): Array<Device> {
    return this.world.devices.filter((d) => !(d.spec.home === "mac" && (this.world.mac.asleep || !this.world.mac.alive())));
  }

  private pickDevice(except?: Device): Device {
    const choices = this.awakeDevices().filter((d) => d !== except);
    return this.r.pick(choices.length > 0 ? choices : this.world.devices);
  }

  private nextId(): string {
    return `s${this.options.seed}-${++this.n}`;
  }

  /** A send the way the pane makes it: the window's own runtime, the hub's route, or Cloud's queue. */
  send(device: Device, chat: Chat, text: string, requestId?: string): Sent {
    const id = this.nextId();
    const sent: Sent = { id, requestId: requestId ?? `${device.name}-${id}`, sessionId: chat.sessionId, device: device.name, text: text.replace("{id}", id), at: Date.now(), owner: this.owner(chat).name, outcome: "pending" };
    setImmediate(() => void (sent.turned = true));
    this.sends.push(sent);
    this.count("send");
    let client: Client;
    try {
      client = device.clientFor(chat.sessionId);
    } catch (error) {
      sent.outcome = "error";
      sent.error = (error as Error).message;
      return sent;
    }
    this.trace.note(`${device.name} sends "${sent.text}" to ${chat.title} (${device.hub!.viaFor(chat.sessionId)})`);
    client.call("turn.submit", { request_id: sent.requestId, session_id: chat.sessionId, kind: "followup", input: { text: sent.text } }).then(
      (result) => {
        sent.outcome = "ok";
        sent.disposition = (result as { disposition?: string }).disposition ?? "none";
        sent.via = device.hub!.queuedCalls(chat.sessionId).some((q) => q.call.request_id === sent.requestId) ? "cloud" : "runtime";
      },
      (error: Error) => {
        sent.outcome = "error";
        sent.error = error.message;
        this.trace.note(`${device.name} send ${sent.id} failed: ${error.message}`);
      },
    );
    return sent;
  }

  interrupt(device: Device, chat: Chat): void {
    this.count("interrupt");
    this.stops.push({ sessionId: chat.sessionId, at: Date.now() });
    const requestId = `${device.name}-stop-${this.nextId()}`;
    this.trace.note(`${device.name} stops ${chat.title}`);
    let client: Client;
    try {
      client = device.clientFor(chat.sessionId);
    } catch {
      return;
    }
    client.call("turn.interrupt", { request_id: requestId, session_id: chat.sessionId }).catch((error: Error) => {
      this.trace.note(`${device.name} stop failed: ${error.message}`);
      this.count(/not interruptible/.test(error.message) ? "stop_refused:not_interruptible" : `stop_error:${error.message.slice(0, 40)}`);
    });
  }

  /** The ask a device shows as waiting in a chat, if any. */
  private openAsk(view: View | undefined): { id: string; option: string } | undefined {
    if (!view) return undefined;
    const resolved = new Set(view.events.filter((e) => e.type === "ask.resolved").map((e) => e.item_id));
    const ask = view.events.findLast((e) => e.type === "ask.user" && e.item_id !== undefined && !resolved.has(e.item_id));
    if (!ask || ask.type !== "ask.user") return undefined;
    const payload = ask.payload as { kind: string; options?: ReadonlyArray<{ id: string }> };
    return { id: ask.item_id!, option: payload.options?.[0]?.id ?? "accept" };
  }

  answer(device: Device, chat: Chat, ask?: { id: string; option: string }): Answer | undefined {
    const open = ask ?? this.openAsk(device.views.get(chat.sessionId));
    if (!open) return undefined;
    const answer: Answer = { askId: open.id, sessionId: chat.sessionId, device: device.name, requestId: `${device.name}-answer-${this.nextId()}`, at: Date.now(), owner: this.owner(chat).name, outcome: "pending" };
    this.answers.push(answer);
    this.count("answer");
    answer.via = device.hub!.viaFor(chat.sessionId);
    this.trace.note(`${device.name} answers ${open.id.slice(-12)} in ${chat.title} (${answer.via})`);
    let client: Client;
    try {
      client = device.clientFor(chat.sessionId);
    } catch (error) {
      answer.outcome = "error";
      answer.error = (error as Error).message;
      return answer;
    }
    client.call("ask.respond", { request_id: answer.requestId, session_id: chat.sessionId, ask_id: open.id, response: { kind: "approval", option_id: open.option } }).then(
      () => void (answer.outcome = "ok"),
      (error: Error) => {
        answer.outcome = "error";
        answer.error = error.message;
      },
    );
    return answer;
  }

  /** A chat on `rt` working on a turn now (one is started if none is). */
  private async working(rt: RuntimeProc): Promise<Chat | undefined> {
    const here = this.chats.filter((c) => this.owner(c) === rt);
    if (here.length === 0) return undefined;
    for (const chat of here) if ((await this.status(chat)) === "working") return chat;
    const chat = this.r.pick(here);
    const device = this.pickDevice();
    this.send(device, chat, "slow 6000: {id} long");
    await until(async () => BUSY.has((await this.status(chat)) ?? ""), 15_000).catch(() => undefined);
    await sleep(300 + this.r.int(1200));
    return chat;
  }

  // ---------------------------------------------------------------------------------------------- one step

  private async op(op: Op): Promise<void> {
    const { r } = this;
    const chat = r.pick(this.chats);
    const device = this.pickDevice();
    switch (op) {
      case "send":
        this.send(device, chat, `slow ${200 + r.int(2500)}: {id}`);
        return;
      case "send_ask":
        this.send(device, chat, "ask: {id}");
        return;
      case "interrupt":
        this.interrupt(device, chat);
        return;
      case "send_then_interrupt":
        this.send(device, chat, `slow ${1000 + r.int(2000)}: {id} then stop`);
        this.interrupt(device, chat);
        return;
      case "race_interrupt": {
        const other = this.pickDevice(device);
        this.send(device, chat, `slow ${500 + r.int(2000)}: {id} raced`);
        await sleep(r.int(30));
        this.interrupt(other, chat);
        return;
      }
      case "answer":
        this.answer(device, chat);
        return;
      case "double_answer": {
        const open = this.openAsk(device.views.get(chat.sessionId));
        if (!open) {
          this.send(device, chat, "ask: {id} for two");
          return;
        }
        const other = this.pickDevice(device);
        this.count("double_answer");
        this.answer(device, chat, open);
        this.answer(other, chat, open);
        return;
      }
      case "both_paths": {
        // One request id down both ways: the device's route, and Cloud's queue (as a resend from another page would).
        const remote = this.awakeDevices().filter((d) => d.spec.home !== "mac");
        if (remote.length === 0) return;
        const d = r.pick(remote);
        const sent = this.send(d, chat, `slow 300: {id} both ways`);
        sent.bothPaths = true;
        this.count("both_paths");
        const params = { request_id: sent.requestId, session_id: chat.sessionId, kind: "followup", input: { text: sent.text } };
        // Signed by the device, as its sender signs a call it queues (a Mac runs only those).
        const signed = await queuedCallFields(d.key, { session_id: chat.sessionId, request_id: sent.requestId, method: "turn.submit", params });
        void fetch(`${this.world.cloud.url}/api/v1/code/chats/${chat.sessionId}/calls`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.world.cloud.state.personToken}`, "content-type": "application/json" },
          body: JSON.stringify({ request_id: sent.requestId, method: "turn.submit", params, ...signed }),
        }).catch(() => undefined);
        return;
      }
    }
  }

  private async fault(fault: Fault): Promise<void> {
    const { world, r } = this;
    const bug = KNOWN_FAULTS[fault];
    if (this.options.avoidKnown && bug && KNOWN.has(bug)) {
      this.trace.note(`skip ${fault}: ${bug}`);
      this.count(`skipped_known:${fault}`);
      return;
    }
    this.faultsDone.push(fault);
    this.count(`fault:${fault}`);
    this.trace.note(`fault: ${fault}`);
    switch (fault) {
      case "drop_sockets": {
        const device = r.pick(world.devices);
        world.relay.dropDevice(device.name);
        if (device.spec.home === "mac") world.mac.desktopPipe.drop();
        return;
      }
      case "drop_direct": {
        // The phone's direct channel to the Mac dies (a network change): the relay carries on by cursor.
        const phone = world.devices.find((d) => d.spec.direct);
        if (!phone) return;
        this.trace.note(`fault: the phone's direct channels cut (${phone.dropDirect()})`);
        return;
      }
      case "drop_phone_relay": {
        // The phone's relay socket dies while its direct channel to the Mac is up: nothing it shows may change.
        const phone = world.devices.find((d) => d.spec.direct);
        if (!phone) return;
        this.trace.note(`fault: the phone's relay sockets cut (direct to the Mac ${phone.hub!.pool.isDirect(world.mac.runtimeId) ? "up" : "down"})`);
        world.relay.dropDevice(phone.name);
        return;
      }
      case "drop_runtime_relay": {
        const rt = r.pick(world.runtimes.filter((x) => x.alive() && !x.asleep));
        if (!rt) return;
        this.trace.note(`fault: ${rt.name}'s relay link cut`);
        world.relay.dropRuntime(rt.runtimeId);
        return;
      }
      case "kill9_mac":
      case "kill9_box": {
        const rt = fault === "kill9_mac" ? world.mac : r.pick([world.boxA, world.boxB]);
        if (rt.asleep || !rt.alive()) return;
        await this.working(rt);
        this.kills.push({ runtime: rt.name, at: Date.now(), chats: this.heldBy(rt) });
        await rt.kill();
        await sleep(r.int(1500));
        await rt.start();
        return;
      }
      case "box_asleep_queued": {
        // A Cloud computer sleeps; sends to its chats queue in Cloud and run once it wakes.
        const rt = r.pick([world.boxA, world.boxB]);
        if (rt.asleep || !rt.alive()) return;
        world.sleepRuntime(rt);
        await sleep(800);
        for (const chat of this.chats.filter((c) => this.owner(c) === rt)) this.send(this.pickDevice(), chat, `slow 300: {id} while asleep`);
        await sleep(1_500 + r.int(2_500));
        world.wakeRuntime(rt);
        return;
      }
      case "mac_asleep_send": {
        // The Mac sleeps without a word; its leases lapse; a send from the phone moves the chat to a Cloud computer.
        const rt = world.mac;
        if (rt.asleep || !rt.alive() || this.known(world.boxA, fault)) return;
        world.sleepRuntime(rt);
        await sleep(800);
        world.lapseLeases(rt);
        const here = this.chats.filter((c) => this.owner(c) === rt);
        if (here.length > 0) this.send(this.pickDevice(), r.pick(here), `slow 300: {id} to a sleeping Mac`);
        await sleep(3_000 + r.int(3_000));
        world.wakeRuntime(rt);
        return;
      }
      case "lid":
      case "lid_return": {
        // The lid closes mid-turn: the Mac flushes, hands working chats to Cloud, and sleeps a little.
        const rt = world.mac;
        if (rt.asleep || !rt.alive() || this.known(world.boxA, fault)) return;
        await this.working(rt);
        for (const sessionId of this.heldBy(rt)) this.parks.push({ sessionId, at: Date.now() });
        const out = await rt.call("cloud.suspend", { request_id: `lid-${this.nextId()}` }).catch((error: Error) => ({ error: error.message }));
        this.trace.note(`lid: ${JSON.stringify(out)}`);
        world.sleepRuntime(rt);
        await sleep(fault === "lid_return" ? 21_000 : 1_000 + r.int(2_000));
        world.wakeRuntime(rt);
        return;
      }
      case "move_named": {
        // Move to a named computer (the Move to menu), from a device through Cloud, or on the owner itself.
        const chat = r.pick(this.chats);
        const from = this.owner(chat);
        const targets = world.runtimes.filter((x) => x !== from && x.alive() && !x.asleep && !(this.options.avoidKnown && KNOWN.has("CHAOS-1") && this.occupied(x)));
        if (targets.length === 0 || from.asleep || !from.alive()) return;
        const to = r.pick(targets);
        const mover = this.awakeDevices().filter((d) => d.hub!.summary(chat.sessionId)?.runtime_id !== d.hub!.homeRuntimeId());
        // Nobody sits at a Cloud computer: its chats move from a device. The person at the Mac moves the Mac's own.
        if (mover.length > 0 && (from.role === "cloud" || r.chance(0.5))) {
          if (to === world.mac && this.options.avoidKnown && KNOWN.has("CHAOS-9")) {
            this.trace.note(`skip move_named to the Mac through Cloud: CHAOS-9`);
            this.count("skipped_known:move_to_mac");
            return;
          }
          // Move to from a device that does not hold the chat: through Cloud, signed by that device (hub.ts).
          const device = r.pick(mover);
          this.trace.note(`${device.name} moves ${chat.title} from ${from.name} to ${to.name} (Move to, through Cloud)`);
          this.parks.push({ sessionId: chat.sessionId, at: Date.now() });
          const out = await device
            .clientFor(chat.sessionId)
            .call("session.move", { request_id: `${device.name}-move-${this.nextId()}`, session_id: chat.sessionId, to: { computer_id: to.computerId } })
            .catch((error: Error) => ({ error: error.message }));
          this.trace.note(`move answered ${JSON.stringify(out).slice(0, 200)}`);
        } else {
          this.trace.note(`move ${chat.title} from ${from.name} to ${to.name} (session.move on the owner)`);
          this.parks.push({ sessionId: chat.sessionId, at: Date.now() });
          const out = await from.call("session.move", { request_id: `move-${this.nextId()}`, session_id: chat.sessionId, to: { computer_id: to.computerId } }).catch((error: Error) => ({ error: error.message }));
          this.trace.note(`session.move: ${JSON.stringify(out).slice(0, 200)}`);
        }
        return;
      }
      case "lost_wal_tail": {
        // An OS crash eats the newest commits of This Mac's database (synchronous=NORMAL), then it starts again.
        const rt = world.mac;
        if (rt.asleep || !rt.alive()) return;
        const here = this.chats.filter((c) => this.owner(c) === rt);
        if (here.length === 0) return;
        if (this.options.avoidKnown && KNOWN.has("CHAOS-5")) {
          // Only what Cloud's copy already holds may be lost (CHAOS-5): wait until every chat here is quiet and copied.
          const quiet = await until(async () => {
            for (const chat of here) {
              const record = await rt.call("workspace.get", { workspace_id: chat.workspaceId }).catch(() => undefined);
              if (!record || BUSY.has(record.status) || (world.cloud.state.chats.copyOf(chat.sessionId).at(-1)?.cursor ?? 0) < (record.head ?? 0)) return false;
            }
            return true;
          }, 30_000).then(
            () => true,
            () => false,
          );
          if (!quiet) {
            // Losing what the copy lacks walks into CHAOS-5: a plain kill -9 instead.
            this.trace.note("lost WAL tail: the Mac's chats did not go quiet and copied in 30 s; a kill -9 without the loss (CHAOS-5)");
            this.kills.push({ runtime: rt.name, at: Date.now(), chats: this.heldBy(rt) });
            await rt.kill();
            await rt.start();
            return;
          }
        } else await sleep(r.int(1500));
        const heads = async () => Promise.all(here.map(async (c) => (await rt.call("workspace.get", { workspace_id: c.workspaceId }).catch(() => undefined))?.head ?? -1));
        const before = await heads();
        this.kills.push({ runtime: rt.name, at: Date.now(), chats: this.heldBy(rt) });
        await rt.kill();
        const lose = 1 + r.int(8);
        const dropped = loseWalTail(rt.info!.dbPath, lose);
        await rt.start();
        const after = await heads();
        this.trace.note(`lost WAL tail: ${dropped} of the newest commits on the Mac; heads ${here.map((c, i) => `${c.title} ${before[i]} -> ${after[i]} (copy ${world.cloud.state.chats.copyOf(c.sessionId).at(-1)?.cursor ?? 0})`).join(", ")}`);
        return;
      }
      case "box_empty_disk":
      case "box_older_disk": {
        // A Cloud computer comes back on an empty volume (R1 of cloud-computers-2026-11-09), or on an earlier snapshot
        // of its own (R2), and takes its chats back from Cloud's copies (CONTRACT §5.2). Only what the copy holds
        // survives a lost disk (a step's intent reaching the copy before its effect is later work, R11), so the disk
        // goes only once every chat there is quiet and copied; one that is not within 30 s gets a plain kill -9. A
        // computer that holds a chat, when one does.
        const boxes = [world.boxA, world.boxB].filter((box) => !box.asleep && box.alive());
        if (boxes.length === 0) return;
        const holding = boxes.filter((box) => this.heldBy(box).length > 0);
        const rt = r.pick(holding.length > 0 ? holding : boxes);
        const here = () => this.chats.filter((c) => this.owner(c) === rt);
        const headOf = async (chat: Chat) => (await rt.call("workspace.get", { workspace_id: chat.workspaceId }).catch(() => undefined))?.head ?? -1;
        const settled = () =>
          until(async () => {
            for (const chat of here()) {
              const record = await rt.call("workspace.get", { workspace_id: chat.workspaceId }).catch(() => undefined);
              const copy = world.cloud.state.chats.sessions.get(chat.sessionId);
              if (!record || BUSY.has(record.status) || (copy?.cursor_seq ?? 0) < (record.head ?? 0) || copy?.segments.at(-1)?.boundary !== true) return false;
            }
            return true;
          }, 30_000).then(
            () => true,
            () => false,
          );
        const restart = async (disk: () => void) => {
          this.kills.push({ runtime: rt.name, at: Date.now(), chats: this.heldBy(rt) });
          await rt.kill();
          disk();
          await rt.start();
        };
        const plain = async (why: string) => {
          this.trace.note(`${fault}: ${why}; a kill -9 on the same disk instead`);
          this.count(`${fault}:plain_kill`);
          await restart(() => undefined);
        };
        if (!(await settled())) return plain(`${rt.name}'s chats did not go quiet and copied in 30 s`);
        let snapshot: string | undefined;
        if (fault === "box_older_disk") {
          // The snapshot it will come back on is the volume as it is now; then a turn in each chat there, so the copy
          // is ahead of it.
          await restart(() => void (snapshot = rt.snapshotDisk()));
          await until(async () => (await rt.call("cloud.status", {})).state === "connected", 30_000).catch(() => undefined);
          const before = await Promise.all(here().map(headOf));
          const device = this.pickDevice();
          for (const chat of here()) this.send(device, chat, "slow 300: {id} after the snapshot");
          await until(async () => (await Promise.all(here().map(headOf))).every((head, i) => head > (before[i] ?? -1)), 30_000).catch(() => undefined);
          if (!(await settled())) return plain(`${rt.name}'s chats did not go quiet and copied in 30 s after its snapshot`);
        }
        const chats = here();
        const heads = await Promise.all(chats.map(headOf));
        await restart(() => (snapshot === undefined ? world.newDisk(rt) : rt.replaceDisk(snapshot)));
        // Back from their copies: each chat is on the computer again with all its copy held.
        const back = await until(async () => (await Promise.all(chats.map(headOf))).every((head, i) => head >= (heads[i] ?? 0)), 60_000).then(
          () => true,
          () => false,
        );
        if (!back) this.violate(`${fault}: ${rt.name} did not take ${chats.map((c) => c.title).join(", ")} back from Cloud's copies within 60 s (heads ${(await Promise.all(chats.map(headOf))).join(", ")} of ${heads.join(", ")})`);
        this.trace.note(`${fault}: ${rt.name} came back ${snapshot === undefined ? "on an empty disk" : "on an earlier snapshot"} with ${chats.map((c, i) => `${c.title} at ${heads[i]}`).join(", ")}`);
        return;
      }
      case "reload_outbox": {
        // A send, and the page reloads before its answer (when the runtime is slower than 0-14 ms): its outbox sends it
        // again from the new page, once.
        const device = this.pickDevice();
        const chat = r.pick(this.chats);
        this.send(device, chat, "slow 300: {id} then reload");
        await sleep(r.int(15));
        await this.reload(device);
        return;
      }
    }
  }

  /**
   * `device`'s page reloads now. Every call it still waits on dies with it (pageGone): the journals alone judge those,
   * unless it waited longer than a live page lets one wait (`hungBeforeReload`). What its outbox held must still run,
   * once, from the new page. A pending send it did not hold is counted and traced (reload_unsaved_send), and in check
   * one lost with the page is a violation (Sent.unsavedAtReload).
   */
  async reload(device: Device): Promise<void> {
    // This page's calls still waiting (one of a page that died at an earlier reload was classified then).
    const pending = this.sends.filter((s) => s.device === device.name && s.outcome === "pending" && !s.pageGone);
    const answers = this.answers.filter((a) => a.device === device.name && a.outcome === "pending" && !a.pageGone);
    this.hungBeforeReload(device, pending, answers);
    for (const s of pending) s.pageGone = true;
    for (const a of answers) a.pageGone = true;
    for (const view of device.views.values()) view.segments.at(-1)!.epoch ??= view.feed?.position().epoch;
    const page = device.page;
    const reloadedAt = Date.now();
    const held = await device.reload();
    const kept = pending.filter((s) => held.includes(s.requestId));
    const unsaved = pending.filter((s) => !held.includes(s.requestId));
    for (const s of kept) {
      s.inOutboxAtReload = true;
      this.count("reload_kept_send");
    }
    for (const s of unsaved) {
      s.unsavedAtReload = true;
      s.turnedBeforeReload = s.turned === true;
      s.pendingAtReloadMs = reloadedAt - s.at;
      this.count("reload_unsaved_send");
    }
    const ids = (sends: ReadonlyArray<Sent>) => sends.map((s) => s.id).join(" ") || "none";
    this.trace.note(`${device.name} reloaded its page ${page} (outbox: ${held.length} entries; pending sends in it: ${ids(kept)}; pending and not in it: ${ids(unsaved)})`);
    // The trace says when the new page's outbox lets each send go (answered), or that it still holds it.
    for (const s of kept) {
      const at = Date.now();
      void until(async () => !(await device.outboxEntries()).includes(s.requestId), 20_000).then(
        () => this.trace.note(`${device.name}'s new page let ${s.id} out of its outbox after ${Date.now() - at} ms`),
        () => this.trace.note(`${device.name}'s new page still holds ${s.id} in its outbox 20 s after the reload`),
      );
    }
  }

  /**
   * A send or an answer still pending when its page reloads, after waiting longer than a live page lets one wait
   * (UNSENT_MS and HANG_BEFORE_RELOAD_MARGIN_MS) since its chat's runtime was last up and the device's link to it last
   * changed, hung before the reload: the new page may send it again and run it, but the person watched it hang. Its
   * chat's runtime is the one that held the chat when it was made and the one that holds it now (a move between them);
   * another runtime down, or another of the device's links changing, holds nothing up. Counted from the later of when
   * it was made and when its runtime and link last settled, as the view watchdog counts.
   */
  private hungBeforeReload(device: Device, sends: ReadonlyArray<Sent>, answers: ReadonlyArray<Answer>): void {
    const now = Date.now();
    const bound = this.unsentMs + HANG_BEFORE_RELOAD_MARGIN_MS;
    const waited = (call: { readonly sessionId: string; readonly owner: string; readonly at: number }) => {
      const names = new Set([call.owner, this.world.ownerOf(call.sessionId)?.name]);
      const runtimes = this.world.runtimes.filter((r) => names.has(r.name));
      const settled = runtimes.some((r) => !r.up()) ? now : Math.max(0, ...runtimes.map((r) => Math.max(r.downAt, device.linkChangedAt.get(r.name) ?? 0)));
      return { ms: now - Math.max(call.at, settled), on: runtimes.map((r) => r.name).join(" and ") };
    };
    const s1 = (ms: number) => Math.round(ms / 100) / 10;
    for (const s of sends) {
      const w = waited(s);
      if (w.ms > bound) this.violate(`hang before its page reloaded: ${device.name}'s send ${s.id} ("${s.text}") pending ${s1(now - s.at)} s, ${s1(w.ms)} s of it with ${w.on} up and the device's link to it unchanged`);
    }
    for (const a of answers) {
      const w = waited(a);
      if (w.ms > bound) this.violate(`hang before its page reloaded: ${device.name}'s answer to ${a.askId.slice(-12)} pending ${s1(now - a.at)} s, ${s1(w.ms)} s of it with ${w.on} up and the device's link to it unchanged`);
    }
  }

  /** Sends whose page reloaded before their answer came that the new page's outbox still holds: they are owed still. */
  private async heldAfterReload(): Promise<Array<Sent>> {
    const held: Array<Sent> = [];
    for (const sent of this.sends) {
      if (!sent.pageGone || !sent.inOutboxAtReload) continue;
      const device = this.world.devices.find((d) => d.name === sent.device);
      if (device && (await device.outboxEntries()).includes(sent.requestId)) held.push(sent);
    }
    return held;
  }

  async play(): Promise<void> {
    const { r, options } = this;
    const required = [...(options.faults ?? [])];
    // Required faults at seeded steps, spread over the run.
    const at = new Map<number, Fault>();
    for (const fault of required.slice(0, options.steps)) {
      let step = r.int(options.steps);
      while (at.has(step)) step = (step + 1) % options.steps;
      at.set(step, fault);
    }
    const total = OPS.reduce((sum, [, w]) => sum + w, 0);
    for (let step = 0; step < options.steps; step++) {
      const fault = at.get(step) ?? (options.pool && options.pool.length > 0 && r.chance(options.faultRate ?? 0) ? r.pick(options.pool) : undefined);
      if (fault) await this.fault(fault);
      else {
        let roll = r.int(total);
        const op = OPS.find(([, w]) => (roll -= w) < 0)![0];
        await this.op(op);
      }
      await sleep(50 + r.int(450));
    }
  }

  // ---------------------------------------------------------------------------------------------- quiet, then check

  /** Every runtime up, every ask answered, every turn ended, every call settled. */
  async quiesce(): Promise<number> {
    const { world } = this;
    for (const rt of world.runtimes) if (rt.asleep) world.wakeRuntime(rt);
    for (const rt of world.runtimes) if (!rt.alive()) await rt.start();
    const deadline = Date.now() + 120_000;
    let lastBusy = Date.now();
    while (Date.now() < deadline) {
      let busy = false;
      for (const chat of this.chats) {
        const owner = this.owner(chat);
        const record = await owner.call("workspace.get", { workspace_id: chat.workspaceId }).catch(() => undefined);
        const summary = world.cloud.state.chats.summaries.get(chat.sessionId);
        if (!record || BUSY.has(record.status) || record.status === "parked" || summary?.status === "working" || summary?.status === "needs_you") busy = true;
        if (record?.status === "needs_input" || summary?.status === "needs_you") {
          // Someone answers what is still asked.
          const { events } = await journalOf(owner, chat.sessionId).catch(() => ({ events: [] as Array<SessionEvent> }));
          const resolved = new Set(events.filter((e) => e.type === "ask.resolved").map((e) => e.item_id));
          const ask = events.findLast((e) => e.type === "ask.user" && !resolved.has(e.item_id));
          // Answered once; again only when every earlier answer to it failed (or died with its page), a while ago.
          const tried = this.answers.filter((a) => a.askId === ask?.item_id);
          if (ask?.type === "ask.user" && tried.every((a) => (a.outcome === "error" || (a.outcome === "pending" && a.pageGone)) && Date.now() - a.at > 5_000)) {
            this.answer(this.pickDevice(), chat, { id: ask.item_id!, option: (ask.payload as { options?: ReadonlyArray<{ id: string }> }).options?.[0]?.id ?? "accept" });
          }
        }
      }
      // A call queued in Cloud is in flight until a runtime answers it: one a runtime let follow its chat (a move) comes
      // back when Cloud's 30 s call lease lapses.
      const calls = [...world.cloud.state.chats.calls.values()].some((c) => (c.status === "queued" || c.status === "delivered") && this.chats.some((x) => x.sessionId === c.session_id));
      // A page that reloaded is told nothing more: its calls are in flight while its outbox (the new page's) holds them.
      const pending =
        calls ||
        this.sends.some((s) => s.outcome === "pending" && !s.pageGone) ||
        this.answers.some((a) => a.outcome === "pending" && !a.pageGone) ||
        (await this.heldAfterReload()).length > 0;
      if (busy || pending) lastBusy = Date.now();
      // Quiet for a moment: nothing working, nothing in flight.
      if (Date.now() - lastBusy > 1_500) return lastBusy;
      await sleep(250);
    }
    const stuck = [
      ...this.sends.filter((s) => s.outcome === "pending" && !s.pageGone).map((s) => `${s.device}:${s.id}`),
      ...(await this.heldAfterReload()).map((s) => `${s.device}:${s.id} (in its outbox since a reload)`),
    ];
    this.violate(`never quiet in 120 s (pending sends ${stuck.join(" ") || "none"}; chats ${(await Promise.all(this.chats.map(async (c) => `${c.title}=${(await this.status(c)) ?? "?"}@${this.owner(c).name}`))).join(", ")})`);
    return lastBusy;
  }

  /**
   * Waits until no journal grows for 2 s (a turn's checkpoint and diff land a moment after its end) and answers when
   * the last one grew: Cloud's copy has 15 s from then.
   */
  private async settle(quietSince: number): Promise<number> {
    let last = quietSince;
    let heads = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const now = (await Promise.all(this.chats.map(async (c) => (await this.owner(c).call("workspace.get", { workspace_id: c.workspaceId }).catch(() => undefined))?.head ?? -1))).join(",");
      if (now !== heads) {
        if (heads !== "") last = Date.now();
        heads = now;
      } else if (Date.now() - last > 2_000) return last;
      await sleep(250);
    }
    this.violate(`journals still growing 60 s after every chat went quiet (heads ${heads})`);
    return last;
  }

  /** Where Cloud places each chat of the run, and at which epoch. */
  private placement(): string {
    return this.chats.map((c) => `${this.owner(c).name}@${this.world.cloud.state.chats.sessions.get(c.sessionId)?.epoch}`).join(",");
  }

  async check(quietSince: number, again = 0): Promise<void> {
    const { world } = this;
    quietSince = await this.settle(quietSince);
    // A chat may still move on its own while it is checked (a lid's chat comes home 30 s after the Mac wakes): then
    // the journals read below are no longer its owner's, and the check starts over once things are quiet again.
    const placed = this.placement();
    const journals = new Map<string, { epoch: number; events: Array<SessionEvent>; owner: RuntimeProc }>();
    for (const chat of this.chats) {
      const owner = this.owner(chat);
      const journal = await journalOf(owner, chat.sessionId).catch((error: Error) => {
        this.violate(`journal: ${chat.title} unreadable on its owner ${owner.name}: ${error.message}`);
        return undefined;
      });
      if (journal) journals.set(chat.sessionId, { ...journal, owner });
    }

    // Cloud's copy: a prefix of the owner's journal, caught up within 15 s of the quiet.
    const caughtUp = await until(
      () =>
        this.chats.every((c) => {
          const j = journals.get(c.sessionId);
          const session = world.cloud.state.chats.sessions.get(c.sessionId);
          return j !== undefined && session?.epoch === j.epoch && (world.cloud.state.chats.copyOf(c.sessionId).at(-1)?.cursor ?? 0) >= j.events.length;
        }),
      // The copy outbox's 15 s, plus 2 s for the upload itself on a busy machine.
      Math.max(0, quietSince + COPY_WITHIN_MS - Date.now()) + 50,
    ).then(
      () => true,
      () => false,
    );
    this.copyCatchUpMs = Date.now() - quietSince;
    if (this.placement() !== placed && again < 2) {
      this.trace.note(`check: chats moved while checked (${placed} -> ${this.placement()}); quiet again, then check again`);
      return this.check(await this.quiesce(), again + 1);
    }
    for (const chat of this.chats) {
      const j = journals.get(chat.sessionId);
      if (!j) continue;
      const session = world.cloud.state.chats.sessions.get(chat.sessionId);
      const copy = world.cloud.state.chats.copyOf(chat.sessionId);
      if (!caughtUp && ((copy.at(-1)?.cursor ?? 0) < j.events.length || session?.epoch !== j.epoch))
        this.violate(`copy: ${chat.title}'s copy through ${copy.at(-1)?.cursor ?? 0} (epoch ${session?.epoch}) not caught up with ${j.owner.name}'s head ${j.events.length} (epoch ${j.epoch}) ${COPY_WITHIN_MS / 1000} s after the journal last grew`);
      for (const event of copy) {
        const mine = j.events[event.cursor - 1];
        if (mine && eventKey(event.event as SessionEvent) !== eventKey(mine)) {
          this.violate(`copy: ${chat.title} cursor ${event.cursor} differs from the journal (${event.type} vs ${mine.type})`);
          break;
        }
      }
      if (copy.length > j.events.length) this.violate(`copy: ${chat.title}'s copy (${copy.length}) is longer than its owner's journal (${j.events.length})`);
    }

    // Every device's view of every chat equals the owner's journal, by epoch and cursor.
    await until(() => this.converged(journals), 15_000).catch(() => undefined);
    for (const device of world.devices) {
      for (const view of device.views.values()) {
        const j = journals.get(view.sessionId);
        if (!j) continue;
        const label = `${device.name} on ${this.label(view.sessionId)}`;
        if (view.misorders.length > 0) this.violate(`view: ${label} delivered out of order: ${view.misorders.slice(0, 3).join("; ")}`);
        if (view.epoch() !== j.epoch) this.violate(`view: ${label} on epoch ${view.epoch()}, the journal on ${j.epoch}`);
        if (view.events.length !== j.events.length)
          this.violate(`view: ${label} shows ${view.events.length} events, the journal holds ${j.events.length} (state ${view.state.kind}, via ${device.hub!.viaFor(view.sessionId)}, states ${view.states.slice(-5).join(",")})`);
        const differs = view.events.findIndex((e, i) => j.events[i] === undefined || eventKey(e) !== eventKey(j.events[i]!));
        if (differs >= 0) this.violate(`view: ${label} cursor ${differs + 1} differs from the journal`);
        if (view.state.kind !== "live" && view.state.kind !== "copy") this.violate(`view: ${label} ended ${JSON.stringify(view.state)}`);
      }
    }

    // Nothing a device showed was replaced at the same epoch (current views and the ones a reload replaced).
    const truth = new Map<string, Map<number, Map<number, string>>>();
    const at = (session: string, epoch: number) => {
      let bySession = truth.get(session);
      if (!bySession) truth.set(session, (bySession = new Map()));
      let byEpoch = bySession.get(epoch);
      if (!byEpoch) bySession.set(epoch, (byEpoch = new Map()));
      return byEpoch;
    };
    for (const chat of this.chats) {
      for (const segment of world.cloud.state.chats.sessions.get(chat.sessionId)?.segments ?? []) for (const e of segment.events) at(chat.sessionId, segment.epoch).set(e.cursor, eventKey(e.event as SessionEvent));
      const j = journals.get(chat.sessionId);
      if (j) for (const e of j.events) at(chat.sessionId, j.epoch).set(e.cursor, eventKey(e));
    }
    const shown = new Map<string, string>();
    for (const view of [...world.devices.flatMap((d) => [...d.views.values()]), ...world.retired]) {
      if (!this.chats.some((c) => c.sessionId === view.sessionId)) continue;
      for (const segment of view.segments) {
        if (segment.epoch === undefined) continue;
        for (const [cursor, key] of segment.shown) {
          const known = truth.get(view.sessionId)?.get(segment.epoch)?.get(cursor);
          if (known !== undefined && known !== key) {
            this.violate(`replaced: ${view.device} showed ${this.label(view.sessionId)} epoch ${segment.epoch} cursor ${cursor} and the journal now has another event there at the same epoch`);
            break;
          }
          const other = shown.get(`${view.sessionId}/${segment.epoch}/${cursor}`);
          if (other !== undefined && other !== key) this.violate(`replaced: two devices showed different events at ${this.label(view.sessionId)} epoch ${segment.epoch} cursor ${cursor}`);
          shown.set(`${view.sessionId}/${segment.epoch}/${cursor}`, key);
        }
      }
    }

    // Every send at most once; an accepted one ran (or waits, held by a stop).
    for (const sent of this.sends) {
      const j = journals.get(sent.sessionId);
      if (!j) continue;
      const ran = j.events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === sent.text).length;
      if (ran > 1) this.violate(`twice: ${sent.device}'s send ${sent.id} ("${sent.text}") ran ${ran} times`);
      if (sent.outcome === "pending" && !sent.pageGone) this.violate(`hang: ${sent.device}'s send ${sent.id} never answered`);
      // A send pending and in no outbox when its page reloaded is owed like one in it once the event loop had turned after
      // it (Sent.unsavedAtReload); before that, losing it is told only.
      if (sent.unsavedAtReload) {
        this.count(ran > 0 ? "reload_unsaved_send:ran" : "reload_unsaved_send:lost");
        this.trace.note(`${sent.device}'s send ${sent.id} was pending ${sent.pendingAtReloadMs} ms and not in its outbox when its page reloaded: ${ran > 0 ? "it ran" : "lost with the page"}`);
      }
      const owed = sent.outcome === "ok" || sent.inOutboxAtReload === true || (sent.unsavedAtReload === true && sent.turnedBeforeReload === true);
      if (ran === 0 && owed) {
        const how = sent.outcome === "ok" ? `accepted (${sent.disposition}, via ${sent.via})` : sent.inOutboxAtReload ? "in its outbox at a reload" : `pending ${sent.pendingAtReloadMs} ms at a reload, in no outbox,`;
        const queue = await j.owner.call("queue.list", { session_id: sent.sessionId }).catch(() => ({ turns: [] as Array<{ text: string }> }));
        const call = [...world.cloud.state.chats.calls.values()].find((c) => c.request_id === sent.requestId && c.session_id === sent.sessionId);
        // A stop on that chat or a kill of a runtime within seconds of the send: the run had not started (CHAOS-4).
        // A stop still on its way (from another device) when the send's run starts counts too: within 1 s before it.
        const stopped = this.stops.some((x) => x.sessionId === sent.sessionId && x.at >= sent.at - 1_000 && x.at - sent.at < 5_000);
        const killed = this.kills.some((k) => k.runtime === sent.owner && k.at >= sent.at && k.at - sent.at < 15_000);
        const what = `${sent.device}'s send ${sent.id} ("${sent.text}", ${sent.outcome === "ok" ? `${sent.disposition}, via ${sent.via}` : sent.inOutboxAtReload ? "in its outbox at a reload" : "in no outbox at a reload"}) on ${sent.owner}`;
        // Held by a stop (it waits for the next message), or refused in Cloud with a reason: not lost.
        const waits = queue.turns.some((t) => t.text === sent.text) || (call !== undefined && (call.status === "failed" || call.status === "expired"));
        const elsewhere = waits ? undefined : await this.keptElsewhere(sent);
        if (waits) this.count("send_waits_held_or_refused");
        else if (elsewhere === "kept") {
          this.count("send_kept_where_it_ran");
          this.trace.note(`${what}: ran on ${sent.owner} after the copy the chat moved from, and is kept there`);
        } else if (elsewhere === "told") {
          this.count("send_told_not_sent");
          this.trace.note(`${what}: listed as not sent on ${sent.owner}, which took it in as the chat moved`);
        } else if ((stopped || killed) && this.options.avoidKnown && KNOWN.has("CHAOS-4")) {
          this.count(`known:CHAOS-4:${stopped ? "stop" : "kill"}`);
          this.trace.note(`known CHAOS-4: ${what} never ran (${stopped ? "a stop" : "a kill -9"} right after it)`);
        } else
          this.violate(`lost: ${sent.device}'s send ${sent.id} ("${sent.text}") was ${how} and never ran${call ? ` (Cloud call ${call.status}${call.error ? ` ${call.error.code}` : ""})` : ""}`);
      }
      if (sent.outcome === "error") this.count(`send_error:${(sent.error ?? "").slice(0, 60)}`);
    }
    this.checkOrder(journals);
    // Calls a device queued in Cloud: none still waiting once everything is awake, none refused for a device the Mac
    // allowed (every device here is allowed on the Mac).
    for (const call of world.cloud.state.chats.calls.values()) {
      if (!this.chats.some((c) => c.sessionId === call.session_id)) continue;
      if (call.status === "delivered" && this.options.avoidKnown && KNOWN.has("CHAOS-6") && this.kills.some((k) => k.at >= call.created_at)) this.count("known:CHAOS-6");
      else if (call.status === "queued" || call.status === "delivered") this.violate(`hang: Cloud call ${call.request_id} for ${this.label(call.session_id)} still ${call.status}${call.waiting ? ` (${call.waiting.reason})` : ""}`);
      if (call.status !== "failed") continue;
      this.count(`cloud_call_failed:${call.error?.code}`);
      if (call.error?.code === "device_not_approved") {
        if (this.options.avoidKnown && KNOWN.has("CHAOS-2")) this.count("known:CHAOS-2");
        else this.violate(`refused: ${call.method} ${call.request_id} queued in Cloud for ${this.label(call.session_id)} failed device_not_approved from a device the Mac allowed (CHAOS-2)`);
      }
    }

    // One ask, one answer; every started turn ended.
    for (const [sessionId, j] of journals) {
      const resolved = new Map<string, number>();
      for (const e of j.events) if (e.type === "ask.resolved" && e.item_id) resolved.set(e.item_id, (resolved.get(e.item_id) ?? 0) + 1);
      for (const [ask, times] of resolved) if (times > 1) this.violate(`ask: ${this.label(sessionId)} ask ${ask.slice(0, 12)} resolved ${times} times`);
      const started = j.events.filter((e) => e.type === "turn.started").length;
      const ended = j.events.filter((e) => e.type === "turn.done").length;
      if (started !== ended) this.violate(`turn: ${this.label(sessionId)} has ${started} turns started and ${ended} ended`);
    }
    // An answer queued in Cloud counted only if its call ran (done); a failed one was told why ("Answered on another device").
    for (const a of this.answers) {
      if (a.via !== "queue" || a.outcome !== "ok") continue;
      const call = [...world.cloud.state.chats.calls.values()].find((c) => c.request_id === a.requestId && c.session_id === a.sessionId);
      if (call?.status === "failed" || call?.status === "expired") {
        a.outcome = "error";
        a.error = call.error?.message ?? call.status;
      }
    }
    const byAsk = new Map<string, Array<Answer>>();
    for (const a of this.answers) byAsk.set(`${a.sessionId}/${a.askId}`, [...(byAsk.get(`${a.sessionId}/${a.askId}`) ?? []), a]);
    for (const [ask, answers] of byAsk) {
      const ok = answers.filter((a) => a.outcome === "ok");
      if (ok.length > 1) this.violate(`ask: ${ask.slice(-12)} in ${this.label(answers[0]!.sessionId)} answered by ${ok.map((a) => `${a.device} (${a.via})`).join(" and ")}, each told it was accepted`);
      for (const a of answers) if (a.outcome === "pending" && !a.pageGone) this.violate(`hang: ${a.device}'s answer to ${ask.slice(-12)} never answered`);
    }

    // Every device's list converges to Cloud's.
    const listed = async () => (await (await fetch(`${world.cloud.url}/api/v1/code/chats`, { headers: { authorization: `Bearer ${world.cloud.state.personToken}` } })).json()) as { chats: Array<Record<string, any>>; runtimes: Array<Record<string, any>> };
    const fields = (c: Record<string, any> | undefined) => (c ? JSON.stringify([c.status, c.epoch, c.head, c.synced_through, c.runtime_id, c.computer_id, c.seq]) : "missing");
    const diff = async () => {
      const cloud = await listed();
      const out: Array<string> = [];
      for (const device of world.devices) {
        const mine = device.hub!.list!.get();
        for (const c of cloud.chats) {
          if (!this.chats.some((x) => x.sessionId === c.session_id)) continue;
          if (fields(mine.chats.get(c.session_id)) !== fields(c)) out.push(`${device.name} lists ${this.label(c.session_id)} as ${fields(mine.chats.get(c.session_id))}, Cloud ${fields(c)}`);
        }
        for (const rt of cloud.runtimes) if (mine.runtimes.get(rt.runtime_id)?.online !== rt.online) out.push(`${device.name} has runtime ${rt.name} online=${mine.runtimes.get(rt.runtime_id)?.online}, Cloud ${rt.online}`);
      }
      return out;
    };
    let last: Array<string> = [];
    await until(async () => (last = await diff()).length === 0, 5_000).catch(() => undefined);
    for (const d of last) this.violate(`list: ${d}`);
  }

  /**
   * Each device's sends to a chat ran in the order it sent them: of any two that each ran once, the later one's message
   * is never before the earlier one's in the chat's journal (`reversals`). A queue the runtime held with the earlier one
   * in it and not the later lets the next message go ahead of what it holds, so such a pair is not judged. The hold
   * shows in a queue snapshot (`held`), or comes from what the harness did: a restart of the runtime that held the chat
   * then, or a turn its stop or park (a move, the lid) ended. A stop near the pair excuses nothing more: one that held
   * the queue shows so, and one with no turn to stop holds nothing (turn.interrupt). Nor is a later send judged whose
   * both_paths copy Cloud last handed over before the earlier one came in, nor, while the run avoids known bugs, a pair
   * the runtime reversed as CHAOS-20 does (each counted). Every other is a violation: one whose runs the runtime made
   * reversed came in reversed, and one where that cannot be read is not excused. Which is which, judgeOrder decides
   * (order.test.ts); this only gathers what the harness did and reports.
   */
  private checkOrder(journals: ReadonlyMap<string, { epoch: number; events: Array<SessionEvent>; owner: RuntimeProc }>): void {
    const groups = new Map<string, Array<Sent>>();
    for (const sent of this.sends) groups.set(`${sent.device}\u0000${sent.sessionId}`, [...(groups.get(`${sent.device}\u0000${sent.sessionId}`) ?? []), sent]);
    for (const sends of groups.values()) {
      const sessionId = sends[0]!.sessionId;
      const j = journals.get(sessionId);
      if (!j) continue;
      // What held the chat's queue without a snapshot: a restart of the runtime that held it then, a stop or a park.
      const restarts = this.kills.filter((k) => k.chats.includes(sessionId));
      const stops = [...this.stops, ...this.parks].filter((x) => x.sessionId === sessionId).map((x) => x.at);
      for (const sent of sends)
        if (sent.bothPaths) sent.cloudCopyAt = [...this.world.cloud.state.chats.calls.values()].find((c) => c.session_id === sessionId && c.request_id === sent.requestId)?.taken_at;
      let dumped = false;
      for (const { before, after, how, verdict } of judgeOrder(ranIn(sends, j.events), j.events, { restarts: restarts.map((k) => k.at), stops }, this.options.avoidKnown === true)) {
        if (verdict === "excused") {
          this.count(how === "held" ? "order_queue_held" : "order_both_paths");
          continue;
        }
        const one = (r: RanAt) => `${r.sent.id} ("${r.sent.text}", cursor ${r.cursor}${r.delivery ? `, ${r.delivery}` : ""}${r.run ? `, first run ordinal ${r.run.ordinal}` : ""})`;
        const what = `${before.sent.device}'s sends to ${this.label(before.sent.sessionId)} ran out of the order sent: ${one(after)} before ${one(before)}`;
        if (verdict === "known") {
          this.count("known:CHAOS-20");
          this.trace.note(`known CHAOS-20 (came in in the order sent, moved ahead in the queue): ${what}`);
        } else {
          const why = ({
            "came-in-reversed": " (the runtime made the later one's run first: it came in first)",
            unexplained: " (came in in the order sent, ran reversed, with no held queue or reorder to show for it)",
            unknown: " (when each came in cannot be read)",
            chaos20: " (CHAOS-20: moved ahead in the queue)",
            held: "",
            "both-paths": "",
          } satisfies Record<Reversal, string>)[how];
          this.violate(`order: ${what}${why}`);
          if (dumped) continue;
          dumped = true;
          // How the runtime started its turns and changed its queue, and what the harness did to the chat, for whoever
          // takes the bug. Once per chat and device.
          this.trace.note(`${this.label(before.sent.sessionId)}'s turns and queue on ${j.owner.name} (epoch ${j.epoch}):`);
          for (const e of j.events) {
            if (e.type === "turn.started" || e.type === "queue.updated" || e.type === "turn.done" || e.type === "ask.user" || (e.type === "message.done" && e.payload.role === "user"))
              this.trace.note(
                `  ${e.cursor} ${e.at.slice(11, 23)} ${e.type}${e.turn_id ? ` ${e.turn_id.split(":").slice(-2).join(":")}` : ""}${e.type === "message.done" ? ` "${e.payload.text}"${e.payload.delivery ? ` (${e.payload.delivery})` : ""}` : ""}${e.type === "turn.done" ? ` ${e.payload.status}${e.payload.reason ? ` (${e.payload.reason})` : ""}` : ""}${e.type === "queue.updated" ? ` ${JSON.stringify(e.payload)}` : ""}`,
              );
          }
          const times = (ats: ReadonlyArray<number>) => ats.map((at) => new Date(at).toISOString().slice(11, 23)).join(", ") || "none";
          this.trace.note(`  restarts of the runtime that held it: ${restarts.map((k) => `${k.runtime} ${times([k.at])}`).join(", ") || "none"}; stops and parks: ${times(stops)}`);
        }
      }
    }
  }

  /** Every open view equals its owner's journal now. */
  private converged(journals: ReadonlyMap<string, { epoch: number; events: Array<SessionEvent> }>): boolean {
    return this.world.devices.every((device) =>
      [...device.views.values()].every((view) => {
        const j = journals.get(view.sessionId);
        return !j || (view.epoch() === j.epoch && view.events.length === j.events.length && (view.state.kind === "live" || view.state.kind === "copy"));
      }),
    );
  }

  /**
   * Where a send its chat's owner never ran may be instead (CHAOS-14 and -18, app 7008cd89). When Cloud moved the chat
   * from a copy without it, the computer that took it in passes on what ran nowhere (as queued calls under their own
   * request ids, which the owner's journal then has). Turns that ran there it keeps: as their own chat ("<title> (kept
   * on this Mac)") or, when it cannot fork, in its own record of the chat ("Kept here"). Follow-ups queued behind that
   * work are listed there as not sent, and a message it could not pass on is noted "Not sent". Answers "kept" when the
   * send's message is in such a kept branch, "told" when a note lists it as not sent.
   */
  private async keptElsewhere(sent: Sent): Promise<"kept" | "told" | undefined> {
    const rt = this.world.runtimes.find((r) => r.name === sent.owner);
    if (!rt?.up()) return undefined;
    const said = (events: ReadonlyArray<SessionEvent>) => events.some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === sent.text);
    const notes = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "notification" ? [e.payload as { title: string; body?: string }] : []));
    const lists = (body: string | undefined, limit: number) => body?.includes(`"${sent.text.slice(0, limit)}"`) === true;
    const listed = await rt.call("workspace.list", {}).catch(() => ({ workspaces: [] as Array<{ session_id: string; title: string; status: string }> }));
    for (const kept of listed.workspaces.filter((w) => w.title.includes(" (kept on ") && w.status !== "archived")) {
      const { events } = await journalOf(rt, kept.session_id).catch(() => ({ events: [] as Array<SessionEvent> }));
      if (said(events)) return "kept";
      if (notes(events).some((n) => n.title === "Kept here when the chat moved" && lists(n.body, 80))) return "told";
    }
    const { events } = await journalOf(rt, sent.sessionId).catch(() => ({ events: [] as Array<SessionEvent> }));
    const here = notes(events);
    if (here.some((n) => n.title === "Kept here")) {
      if (said(events)) return "kept";
      if (here.some((n) => n.title === "Kept here" && lists(n.body, 80))) return "told";
    }
    if (here.some((n) => n.title === "Not sent" && lists(n.body, 120))) return "told";
    return undefined;
  }

  /** Lets go of this run's chats: archived on their owners, closed on every device. */
  async teardown(): Promise<void> {
    clearInterval(this.watchdog);
    clearInterval(this.cloudWatch);
    for (const device of this.world.devices) for (const chat of this.chats) {
      device.hub?.close(chat.sessionId);
      device.views.delete(chat.sessionId);
    }
    // Archived where it runs, and where a move left it parked (CHAOS-10: a parked chat keeps its Cloud computer's
    // checkout, so the next chat there would never start).
    for (const chat of this.chats) {
      for (const rt of this.world.runtimes) {
        if (!rt.up() || (rt !== this.owner(chat) && !(this.options.avoidKnown && KNOWN.has("CHAOS-10")))) continue;
        const listed = await rt.call("workspace.list", {}).catch(() => ({ workspaces: [] as Array<{ id: string; session_id: string; status: string }> }));
        for (const w of listed.workspaces) if (w.session_id === chat.sessionId && w.status !== "archived") await rt.call("workspace.archive", { request_id: `archive-${rt.name}-${w.id}`, workspace_id: w.id }).catch(() => undefined);
      }
    }
    // Branches a computer kept when one of these chats moved without them (CHAOS-14): read in check, let go here.
    for (const rt of this.world.runtimes) {
      if (!rt.up()) continue;
      const listed = await rt.call("workspace.list", {}).catch(() => ({ workspaces: [] as Array<{ id: string; title: string; status: string }> }));
      for (const w of listed.workspaces) if (w.title.includes(" (kept on ") && w.status !== "archived") await rt.call("workspace.archive", { request_id: `archive-kept-${rt.name}-${w.id}`, workspace_id: w.id }).catch(() => undefined);
    }
  }

  result(started: number): RunResult {
    return { seed: this.options.seed, violations: [...this.violations], faults: [...this.faultsDone], counts: { ...this.counts }, copyCatchUpMs: this.copyCatchUpMs, ms: Date.now() - started };
  }
}

/** One whole run: setup, play, quiet, check, teardown. */
export async function chaos(world: World, options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const run = new ChaosRun(world, options);
  world.trace.note(`---- seed ${options.seed}: ${options.steps} steps, faults ${(options.faults ?? []).join(", ") || "drawn"}`);
  try {
    await run.setup();
    await run.play();
    const quiet = await run.quiesce();
    await run.check(quiet);
  } catch (error) {
    run.violations.push(`harness: ${(error as Error).stack ?? String(error)}`);
  } finally {
    await run.teardown().catch(() => undefined);
  }
  return run.result(started);
}

export { PERSON };
