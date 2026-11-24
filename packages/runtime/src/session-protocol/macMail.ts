// Agent mail between a person's Macs (RESEARCH-W2 decision 33; THREAT-MODEL T16-T21, devices-2026-10-31). A chat here
// asks or tells a chat on another of the person's Macs with thread_send to `mac:<its Cloud workspace>`; the mail
// goes through Cloud's mailbox (channel "mac"), signed by this Mac's agents key, which this Mac's desktop key vouched
// for in the person's device log, with the sending chat's modes as the most it may run with.
//
// Mail for a chat here is untrusted input: it runs only when it verifies against this Mac's own enrollment (its
// organization and person), its agents key is one a Mac this Mac trusts vouched for (after a fresh read of the log), it
// is in date and new (by signer and message id), and the receiving chat's modes are no broader than the sender's (an
// answer to an ask this chat sent, once, excepted: upstream rule); then it queues as the chat's next turn, wrapped as
// another agent's message (never an answer to a pending ask, never a steer), and taints the chat's memory. Anything else
// starts nothing and leaves a note without the body (one an hour per chat; the rest are logged). Mail whose sending Mac
// stops counting here after it queued (removed on this Mac or another of the person's) never starts: it leaves the
// queue, and its sender hears only that (A-4). An ask is answered when
// the turn it started ends: that turn's own last message, or a status line (also when it never runs: taken out of the
// queue, left behind by a move, which settles it before the chat goes, or a chat paused here), unless the agent replied
// itself. Mail this Mac cannot run yet (its log not read since it woke, a chat whose adopt has not landed) stays this
// Mac's, renewed, and runs in each chat's order as soon as it can; nothing waits longer than that without its sender
// hearing. What ran here travels with its chat (its copy carries the mail it ran, by signer and message id), so a
// move never makes it new mail on the next Mac. While a mail's own turn runs (only then), the chat names the chat that
// asked (asked_by_session_id), which tells the person; the person's own turns in it never defer to anyone.
//
// The route that owns workspaces binds the implementation (as Builders is bound); the MCP's thread_send reaches it
// through this service.
import { createHash } from "node:crypto";

import { ProviderInteractionModeLiteral, RuntimeMode } from "@caveman-app/protocol";
import { callAge, type DeviceKey, type SessionEvent } from "@caveman-app/session-protocol";
import { MAC_THREAD, mailFrom, signAgentMail, verifyAgentMail, type AgentMail } from "@caveman-app/session-protocol/mac-mail";
import { threadMessageEnvelope } from "@caveman-app/shared/threadMessageEnvelope";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

import { CloudError, type Identity } from "../cloudLink/identity.ts";
import type { LinkState } from "../cloudLink/index.ts";
import { ackMacMail, macPeer, renewMacMail, sendMacMail, takeMacMail, waitMacMail, type MacMailPayload, type MacPeer } from "../cloudLink/macMail.ts";
import type { TreeMail } from "../cloudLink/mail.ts";
import type { CarriedAsk, CarriedSeen } from "../cloudLink/moves.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import type { TrustedAgents } from "./deviceTrust.ts";
import { resultOf } from "./builders.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";

export { MAC_THREAD } from "@caveman-app/session-protocol/mac-mail";
export type { CarriedAsk, CarriedSeen } from "../cloudLink/moves.ts";

export class MacMailError extends Schema.TaggedError<MacMailError>()("MacMailError", {
  reason: Schema.Literals(["invalid_request", "unavailable", "thread_not_found"]),
  message: Schema.String,
  /** Cloud's error code, when Cloud refused it. */
  code: Schema.optional(Schema.String),
}) {}

/** The modes a chat runs with (upstream runtime and interaction modes): a mail's limits, a receiving chat's own. */
export interface MailModes {
  readonly runtimeMode: string;
  readonly interactionMode: string;
}

export interface MacMailShape {
  /**
   * A message from a thread here to a chat on another of the person's Macs (thread_send to `mac:<workspace>`),
   * signed with the sending thread's modes as its limits. Undefined when `toThreadId` is none.
   */
  readonly send: (input: {
    readonly fromThreadId: string;
    readonly toThreadId: string;
    readonly text: string;
    readonly requestKey: string;
    readonly ask: boolean;
    readonly inReplyTo?: string | undefined;
    readonly limits: MailModes;
  }) => Effect.Effect<{ readonly id: string } | undefined, MacMailError>;
}

export class MacMail extends Context.Service<
  MacMail,
  MacMailShape & {
    /** The route's implementation; the last bind wins. */
    readonly bind: (impl: MacMailShape) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/MacMail") {}

export const layer = Layer.sync(MacMail, () => {
  let bound: MacMailShape | undefined;
  return MacMail.of({
    send: (input) => (bound ? bound.send(input) : Effect.succeed(undefined)),
    bind: (impl) => Effect.sync(() => void (bound = impl)),
  });
});

// ------------------------------------------------------------------ the route's implementation

/** How long a mail's (signer, message id) is remembered here: past it the mail is out of date anyway (callAge). */
const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
/**
 * How long an ask a chat here sent takes an answer: its receiver runs it up to a day after it was sent (callAge), and
 * its turn may run a while after that.
 */
const SENT_FOR_MS = 2 * SEEN_FOR_MS;
/** An answer goes back in one message (cut past this). */
const ANSWER_MAX_CHARS = 16_000;
const WAIT_MS = 25_000;
const POLL_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** How often mail held here is kept another lease (Cloud leases mail between Macs for 30 s). */
const RENEW_EVERY_MS = 10_000;
/** How long mail for a chat this Mac does not have yet waits for its adopt to land (the chat came here with it). */
const ARRIVE_WAIT_MS = 2 * 60_000;
/** How often mail turns are looked at for an end with no turn.done: taken out of the queue, left behind by a move. */
const SWEEP_MS = 30_000;
/** The most an answer that could not go waits before it is tried again (it waits twice as long after each try). */
const MAX_RETRY_MS = 30 * 60_000;
/** How often a chat gets a note for mail it did not run: once an hour, the rest only logged (forged mail cannot flood it). */
const NOTE_EVERY_MS = 60 * 60_000;

const SCHEMA = [
  // Mail this Mac acted on, by its signer and message id: run once, however often Cloud carries it. `session_id`: the
  // chat it was for, whose copy carries it to the next computer (seenOf), so it never runs there either.
  `CREATE TABLE IF NOT EXISTS caveman_sp_mac_mail_seen (
     signer TEXT NOT NULL,
     message_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     session_id TEXT,
     PRIMARY KEY (signer, message_id))`,
  // Asks a chat here sent to a chat on another Mac: only an answer from that chat to one of these is an answer, once.
  `CREATE TABLE IF NOT EXISTS caveman_sp_mac_mail_sent (
     message_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     to_workspace_id TEXT NOT NULL,
     answered INTEGER NOT NULL DEFAULT 0,
     at INTEGER NOT NULL)`,
  // Mail a chat here runs (an ask or a note, never an answer), from a cursor before its turn's first event: while that
  // turn runs, the chat that sent it (from_session_id, Cloud's word) is the one that tells the person; an ask (reply 1)
  // is answered once it ends (settled), unless the agent replied first (answered). `answer`: the line owed, kept once
  // known, so a retry only sends it (after next_at, later each try), until two days after the mail was signed
  // (mail_at), when its asker takes no answer. `signer`: the agents key that signed it, so mail from a Mac removed
  // since never starts, and no answer goes back to it (A-4).
  `CREATE TABLE IF NOT EXISTS caveman_sp_mac_mail_runs (
     message_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     from_cursor INTEGER NOT NULL,
     to_workspace_id TEXT NOT NULL,
     from_workspace_id TEXT NOT NULL,
     reply INTEGER NOT NULL,
     answered INTEGER NOT NULL DEFAULT 0,
     settled INTEGER NOT NULL DEFAULT 0,
     at INTEGER NOT NULL,
     mail_at INTEGER NOT NULL,
     answer TEXT,
     tries INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL DEFAULT 0,
     from_session_id TEXT,
     signer TEXT,
     carried TEXT)`,
];
/** Columns added to the tables above after they were first made: added to a runtime's tables from before them. */
const ADDED = [
  ["caveman_sp_mac_mail_seen", "session_id"],
  ["caveman_sp_mac_mail_runs", "from_session_id"],
  ["caveman_sp_mac_mail_runs", "signer"],
  ["caveman_sp_mac_mail_runs", "carried"],
] as const;
/** The most mail a chat's copy carries as run (the newest): far more than a day of mail to one chat. */
const CARRIED_SEEN = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

interface RunRow {
  readonly message_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly from_cursor: number;
  readonly to_workspace_id: string;
  readonly from_workspace_id: string;
  readonly reply: number;
  readonly answered: number;
  readonly settled: number;
  readonly at: number;
  readonly mail_at: number;
  readonly answer: string | null;
  readonly tries: number;
  readonly next_at: number;
  readonly from_session_id: string | null;
  /** The agents key that signed the mail; null for a row from before it was kept. */
  readonly signer: string | null;
  /**
   * "lid": the chat is being handed on with this turn mid-way (the lid's handoff of a working chat), so the turn its
   * stop ended carries on on another computer, which runs no mail between Macs: its asker hears that, never the stop's
   * words as the answer (F-5). Null: nothing carries it.
   */
  readonly carried: string | null;
}

/**
 * Where a chat is, for mail to it: here; leaving (a move lets it go now); arriving (Cloud gave this Mac the chat, and
 * its adopt has not landed); elsewhere (it moved to another computer).
 */
export type MailPlace = "here" | "leaving" | "arriving" | "elsewhere";

/** What the route needs from the handlers that own workspaces. */
export interface MacMailRouteDeps {
  readonly sql: SqlClient.SqlClient;
  readonly store: SessionStore["Service"];
  /** This runtime is a Cloud computer's: it sends and takes no mail between Macs. */
  readonly onComputer: boolean;
  /** This Mac's agents key (memory only); undefined: no desktop app, so no mail between Macs. */
  readonly agentsKey: DeviceKey | undefined;
  readonly link: () => { readonly identity: Identity; readonly state: LinkState } | undefined;
  /** The sending chat's Cloud workspace id: registered with Cloud first when it is not yet (as a lead's is for its builders). */
  readonly cloudWorkspaceOf: (record: WorkspaceRecord) => Effect.Effect<string, { readonly message: string }>;
  /** The chat's Cloud workspace id as this Mac synced it, read here only (mail to it never registers it); undefined: none. */
  readonly syncedWorkspaceOf: (record: WorkspaceRecord) => Effect.Effect<string | undefined>;
  /** Where a chat is for mail to it (MailPlace). */
  readonly place: (sessionId: string) => Effect.Effect<MailPlace>;
  /** A turn of the chat as its thread has it: whether it started, and whether it is over; undefined: none by that id. */
  readonly runOf: (record: WorkspaceRecord, turnId: string) => Effect.Effect<{ readonly started: boolean; readonly over: boolean } | undefined>;
  /** Takes a mail turn out of the chat's queue, when it is still waiting there (it never runs: its asker heard so). */
  readonly dropQueued: (record: WorkspaceRecord, turnId: string) => Effect.Effect<void>;
  /** The modes a chat here runs with now; undefined when its thread is not known. */
  readonly modesOf: (record: WorkspaceRecord) => Effect.Effect<MailModes | undefined>;
  /** Secret values out of what leaves this Mac. */
  readonly scrub: (text: string) => Effect.Effect<string>;
  /**
   * Queues `text` (the envelope the engine reads; `shown` is what the transcript shows) as the chat's next turn, as an
   * agent's message from `from` (`mac:<workspace>`, by `name`), its memory tainted, never above `limits`. Answers the
   * turn's id.
   */
  readonly deliver: (
    to: WorkspaceRecord,
    input: { readonly requestId: string; readonly text: string; readonly shown: string; readonly from: string; readonly name: string; readonly limits: MailModes },
  ) => Effect.Effect<string, { readonly message: string }>;
  /** A note in a chat here (never the mail's body). */
  readonly note: (to: WorkspaceRecord, title: string, body: string) => Effect.Effect<void>;
  /** The chat a turn of mail runs in names the chat that asked (asked_by_session_id), or no longer (undefined). */
  readonly askedBy: (record: WorkspaceRecord, sessionId: string | undefined) => Effect.Effect<void>;
  /**
   * Whether the chat's turn `turnId` stopped only to carry on here by itself (the lease stop when Caveman could not be
   * reached, decision 26): its mail's answer waits for the turn that continues it (continueTurn), never the stop's words.
   */
  readonly resumesHere: (sessionId: string, turnId: string) => Effect.Effect<boolean>;
}

/** A UUID made from a request key: a retried send is the same message, which Cloud and the receiver keep once. */
const messageIdOf = (requestKey: string) => {
  const h = createHash("sha256").update(`caveman-mac-mail\0${requestKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * A sent mail's id: one per sending chat and request key (thread_send's clientRequestId), so a retry is the same
 * mail, and two chats here that pick the same key send two mails, never one the receiver takes for the other.
 */
export const mailMessageId = (fromThreadId: string, requestKey: string) => messageIdOf(`send\0${fromThreadId}\0${requestKey}`);

const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(ProviderInteractionModeLiteral);
/**
 * Whether a chat's modes are broader than a mail's limits, by the orchestrator's own rule (DispatchModeLimit, which
 * submit checks again under the thread's lock): a mode either side names that T3 does not know counts as broader.
 */
export const broaderThan = (modes: MailModes, limits: MailModes) =>
  !isRuntimeMode(modes.runtimeMode) ||
  !isInteractionMode(modes.interactionMode) ||
  !isRuntimeMode(limits.runtimeMode) ||
  !isInteractionMode(limits.interactionMode) ||
  exceededDispatchModeLimit({ runtimeMode: limits.runtimeMode, interactionMode: limits.interactionMode }, { runtimeMode: modes.runtimeMode, interactionMode: modes.interactionMode }) !== undefined;

/** The modes a status line is signed with when the replying chat's are not known: the narrowest. */
const NARROWEST: MailModes = { runtimeMode: "approval-required", interactionMode: "default" };

/**
 * What became of one mail on a pass: "done" (acknowledged: run, refused or dropped); "away" (let go: its chat is leaving
 * or left this Mac, and Cloud hands it to the chat's computer once its lease lapses); "soon" (held, and tried again in a
 * moment: the log not read since this Mac woke, the chat's adopt not landed); "wait" (held, and tried again with the
 * next renewal: the chat not shared with Cloud yet, a queue that refused it for now).
 */
type Outcome = "done" | "away" | "soon" | "wait";

/**
 * The status line for an ask whose chat was moving before it ran: settled as the chat goes (while Cloud still takes a
 * reply from this Mac), so before the move is known to land; it is out of the queue either way, so this holds either way.
 */
const MOVED_LINE = "[not run] That chat was moving to another computer, so it did not run this mail; send it again.";
/** The status line for an ask whose sending Mac was removed before its turn started (A-4): it never runs here. */
const REMOVED_LINE = "[not run] The Mac that sent this was removed from your Macs, so this mail did not run.";
/** The status line for an ask whose turn ran, or was running, when its sending Mac was removed: its answer stays here. */
const WITHHELD_LINE = "[no answer] The Mac that sent this was removed from your Macs, so its answer stays on this Mac.";
/**
 * The status line for an ask whose turn the lid's handoff stopped mid-way to carry on with the chat on another computer
 * (F-5): that computer runs no mail between Macs, so no answer comes back from it, and the ask must not run twice.
 * Settled before the move is known to land (while Cloud still takes a reply from this Mac), so it holds either way.
 */
const CARRIED_LINE =
  "[no answer] That chat's Mac closed its lid in the middle of this mail's turn, so the turn stopped there and carries on wherever the chat continues; no answer will come back from it. Ask that chat for the result later rather than sending this again.";
/** The status line for an ask Cloud handed to a chat this Mac archived: it never runs (m-m). */
const ARCHIVED_LINE = "[not run] That chat is archived on its Mac, so it did not take this mail.";
/** The status line for an ask Cloud handed to a chat this Mac does not have (any more): it never runs (m-m). */
const GONE_LINE = "[not run] That chat is no longer on the Mac Caveman sent this to, so it did not take this mail.";
/** The status line for an ask signed further ahead than this Mac's clock allows (m-n): one Mac's clock is off. */
const AHEAD_LINE = "[not run] This mail's time was more than 5 minutes ahead of the receiving Mac's clock, so it was not run: check the date and time on both Macs.";
/** How a status line for a chat this Mac does not have names its sender (it has no title here). */
const GONE_TITLE = "A chat no longer on this Mac";
/** The status line for an ask whose turn is not over a day after it came: nothing more comes back. */
const lateLine = (started: boolean) =>
  started
    ? "[no answer] That chat's turn was still running a day after this mail came, so no answer will come back."
    : "[not run] This mail was still waiting in that chat's queue a day after it came, so it was taken out.";

/** Mail taken and not finished: kept under its lease (renewed) until it runs, is refused, or follows its chat away. */
interface Held {
  readonly message: TreeMail;
  readonly lease: string;
  /** When this Mac first took it. */
  readonly since: number;
  /** When its lease was last taken or renewed. */
  leased: number;
}

/**
 * A send that Cloud refused for good: the asker archived or gone, or on this same Mac. Not for now: the asker on a Cloud
 * computer, or the answering chat on another computer than this one (Cloud moved it while this Mac slept; it may come back).
 */
const finalRefusal = (error: MacMailError) =>
  error.reason === "thread_not_found" || (error.reason === "invalid_request" && error.code !== "cave_code_mac_mail_not_another_mac" && error.code !== "cave_code_session_elsewhere");

/** How long an answer that could not go waits before its next try: SWEEP_MS, twice as long each time, at most MAX_RETRY_MS. */
const retryAfter = (tries: number) => Math.min(SWEEP_MS * 2 ** Math.min(tries, 16), MAX_RETRY_MS);

export const makeMacMailRoute = (deps: MacMailRouteDeps) =>
  Effect.gen(function* () {
    const { sql, store } = deps;
    for (const statement of SCHEMA) yield* sql.unsafe(statement).pipe(Effect.orDie);
    for (const [table, column] of ADDED)
      if (!(yield* sql.unsafe<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).pipe(Effect.orDie)).some((c) => c.name === column))
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).pipe(Effect.orDie);
    /**
     * Set by the server once its device registry exists: whether a Mac This Mac trusts vouched for an agents key. `pull`:
     * a stale log, or a key it does not know, is read again first (up to LOG_PULL_MS); without, it answers from what it has.
     */
    let trusted: ((id: string, pull: boolean) => Promise<{ readonly unread: true } | { readonly unread?: undefined; readonly agents: TrustedAgents | undefined }>) | undefined;
    /**
     * Set with `trusted`: whether this Mac's own agents key is vouched for in its log and Cloud took that vouch (devices.ts
     * agentsShared). Until then nothing is sent: the person's other Macs would take it for a key no Mac vouched for, and
     * drop it for good.
     */
    let shared: (() => boolean) | undefined;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    /** One mail or settle at a time (Cloud's calls that answer are made outside it). */
    const lane = Semaphore.makeUnsafe(1);
    /** One look at a chat's asked_by_session_id at a time, each from what its events say then (refreshAskedBy). */
    const askLane = Semaphore.makeUnsafe(1);
    const unavailable = (message: string) => new MacMailError({ reason: "unavailable", message });
    const cloudCall = <A>(run: (identity: Identity, state: LinkState) => Promise<A>) =>
      Effect.suspend(() => {
        const link = deps.link();
        if (link === undefined) return Effect.fail(unavailable("This Mac is not signed in to Caveman, so it cannot reach your other Macs."));
        return Effect.tryPromise({
          try: () => run(link.identity, link.state),
          catch: (error) =>
            new MacMailError({
              reason: error instanceof CloudError && error.status === 404 ? "thread_not_found" : error instanceof CloudError && error.status < 500 && error.status !== 429 ? "invalid_request" : "unavailable",
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof CloudError && error.code ? { code: error.code } : {}),
            }),
        });
      });
    const runs = (where: { readonly message?: string; readonly session?: string; readonly unsettled?: boolean }) =>
      sql<RunRow>`SELECT * FROM caveman_sp_mac_mail_runs WHERE 1 = 1
        ${where.message === undefined ? sql`` : sql`AND message_id = ${where.message}`}
        ${where.session === undefined ? sql`` : sql`AND session_id = ${where.session}`}
        ${where.unsettled ? sql`AND settled = 0` : sql``}
        ORDER BY at`.pipe(Effect.orDie);

    // ------------------------------------------------------------ sending

    const sendSigned = (input: {
      /** The sending chat here, or (a status line for a chat this Mac does not have) the Cloud workspace it answers as. */
      readonly from: WorkspaceRecord | { readonly workspaceId: string; readonly title: string };
      readonly to: string;
      readonly body: string;
      readonly messageId: string;
      readonly ask: boolean;
      readonly inReplyTo: string;
      readonly limits: MailModes;
    }) =>
      Effect.gen(function* () {
        const key = deps.agentsKey;
        const link = deps.link();
        if (deps.onComputer || key === undefined) return yield* new MacMailError({ reason: "unavailable", message: "Mail between your Macs goes from the Caveman Code desktop app on a Mac." });
        if (link === undefined || link.identity.userId === undefined) return yield* unavailable("This Mac is not signed in to Caveman as you, so it cannot reach your other Macs.");
        if (!(shared?.() ?? false))
          return yield* unavailable("This Mac's mail key is not vouched for in your Macs' approvals yet, so your other Macs would not take this mail: open Caveman Code on this Mac and try again in a moment.");
        const from = input.from;
        const fromWorkspace =
          "workspaceId" in from ? from.workspaceId : yield* deps.cloudWorkspaceOf(from).pipe(Effect.mapError((error) => new MacMailError({ reason: "invalid_request", message: error.message })));
        const body = yield* deps.scrub(input.body);
        const mail = yield* Effect.promise(() =>
          signAgentMail(
            key,
            {
              organization_id: link.identity.organizationId,
              user_id: link.identity.userId!,
              message_id: input.messageId,
              from_workspace_id: fromWorkspace,
              from_title: "workspaceId" in from ? from.title : from.workspace.title,
              to_workspace_id: input.to,
              expects_reply: input.ask,
              in_reply_to: input.inReplyTo,
              runtime_mode: input.limits.runtimeMode,
              interaction_mode: input.limits.interactionMode,
            },
            body,
          ),
        );
        yield* cloudCall((identity, state) => sendMacMail(identity, state, { mail, body }));
        return { id: input.messageId };
      });

    const send: MacMailShape["send"] = (input) =>
      Effect.gen(function* () {
        if (!input.toThreadId.startsWith(MAC_THREAD)) return undefined;
        const from = yield* store.getByThread(input.fromThreadId);
        if (from === undefined) return yield* new MacMailError({ reason: "invalid_request", message: "Only a chat on this Mac sends mail to your other Macs." });
        const to = input.toThreadId.slice(MAC_THREAD.length);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(to)) return yield* new MacMailError({ reason: "thread_not_found", message: `${input.toThreadId} is not a chat on one of your Macs.` });
        // A reply names the mail it answers by the id its envelope gave (a UUID).
        if (input.inReplyTo !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.inReplyTo))
          return yield* new MacMailError({ reason: "invalid_request", message: `inReplyTo ${input.inReplyTo} is not the id of a mail from another of your Macs.` });
        const messageId = mailMessageId(input.fromThreadId, input.requestKey);
        // A reply never asks back.
        const ask = input.inReplyTo === undefined && input.ask;
        // An answer to mail this chat runs: the agent replied itself, so its turn's end sends nothing more.
        const answering = input.inReplyTo === undefined ? undefined : (yield* runs({ message: input.inReplyTo })).find((r) => r.session_id === from.session.id && r.from_workspace_id === to);
        // An ask, kept before it goes: only that chat's answer to it is taken as an answer here, once.
        if (ask) yield* sql`INSERT OR IGNORE INTO caveman_sp_mac_mail_sent (message_id, session_id, to_workspace_id, answered, at) VALUES (${messageId}, ${from.session.id}, ${to}, 0, ${Date.now()})`.pipe(Effect.orDie);
        const sent = yield* sendSigned({ from, to, body: input.text, messageId, ask, inReplyTo: input.inReplyTo ?? "", limits: input.limits });
        if (answering !== undefined) yield* sql`UPDATE caveman_sp_mac_mail_runs SET answered = 1 WHERE message_id = ${answering.message_id}`.pipe(Effect.orDie);
        return sent;
      });

    /** A chat on another of the person's Macs, as Cloud names it (a reference to it in a chat here); undefined: none. */
    const peer = (workspaceId: string): Effect.Effect<MacPeer | undefined> =>
      deps.onComputer || deps.agentsKey === undefined ? Effect.succeed(undefined) : cloudCall((identity, state) => macPeer(identity, state, workspaceId)).pipe(Effect.orElseSucceed(() => undefined));

    // ------------------------------------------------------------ receiving

    /** When each chat here last got a note for mail it did not run (one an hour; NOTE_EVERY_MS). */
    const notedAt = new Map<string, number>();
    /** A note in the receiving chat, without the body: the mail started nothing, and why. At most one an hour per chat. */
    const refused = (to: WorkspaceRecord | undefined, why: string) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`mac mail: ${why}`);
        if (to === undefined) return;
        const last = notedAt.get(to.session.id);
        if (last !== undefined && Date.now() - last < NOTE_EVERY_MS) return;
        notedAt.set(to.session.id, Date.now());
        yield* deps.note(to, "Mail from another Mac was not run", why);
      });

    /**
     * A signed status line back to the asking chat: an ask that will not be answered, and why. Signed with the replying
     * chat's own modes, as every mail is: a status line claims no more than the chat that sends it has.
     */
    const statusReply = (to: WorkspaceRecord | { readonly workspaceId: string; readonly title: string }, mail: AgentMail, line: string) =>
      mail.expects_reply
        ? Effect.gen(function* () {
            const modes = ("workspaceId" in to ? undefined : yield* deps.modesOf(to)) ?? NARROWEST;
            yield* sendSigned({ from: to, to: mail.from_workspace_id, body: line, messageId: messageIdOf(`status:${mail.signer.device_id}:${mail.message_id}`), ask: false, inReplyTo: mail.message_id, limits: modes });
          }).pipe(Effect.catch((error) => Effect.logWarning(`mac mail: the status reply to ${mail.message_id} did not go: ${error.message}`)))
        : Effect.void;

    /** The signer a mail names, before it is verified (only to know whether the log is worth reading again for it). */
    const signerOf = (held: Held) => {
      const id = (held.message.payload as { mail?: { signer?: { device_id?: unknown } } } | null | undefined)?.mail?.signer?.device_id;
      return typeof id === "string" ? id : undefined;
    };
    /**
     * Before a pass runs mail: one fresh read of the person's log, outside the lane, when it is stale or a mail names a
     * key this Mac does not know (the Mac that vouched for it may have done so a moment ago). At most one read a pass,
     * however many keys the mail names (and the registry reads at most once a second): every mail the pass runs after
     * it is judged against a log read since that mail came, and a burst of forged keys never holds genuine mail up.
     */
    const refresh = (held: ReadonlyMap<string, Held>) =>
      Effect.gen(function* () {
        const check = trusted;
        if (check === undefined) return;
        for (const h of held.values()) {
          const id = signerOf(h);
          if (id === undefined) continue;
          const known = yield* Effect.promise(() => check(id, false));
          if (!known.unread && known.agents !== undefined) continue;
          yield* Effect.promise(() => check(id, true));
          return;
        }
      });

    /**
     * Whether a mail that will not run may still be answered with a status line: an ask, in date, signed by an agents key
     * a Mac this Mac trusts vouched for (as trust stands, without reading the log again). Never one Cloud could make up.
     */
    const answerable = (mail: AgentMail) =>
      Effect.gen(function* () {
        const check = trusted;
        if (!mail.expects_reply || check === undefined || callAge(mail.at) !== "ok") return false;
        const known = yield* Effect.promise(() => check(mail.signer.device_id, false));
        return !known.unread && known.agents !== undefined;
      });

    /**
     * One mail for a chat here (Outcome). A status line it owes its sender goes in `later`, sent once the lane is free:
     * a slow Cloud never holds up the next mail, or a move settling its chat's mail.
     */
    const deliver = (held: Held, later: Array<Effect.Effect<void>>) =>
      Effect.gen(function* () {
        const message = held.message;
        const link = deps.link();
        const payload = message.payload as Partial<MacMailPayload> | null | undefined;
        if (link === undefined || link.identity.userId === undefined) return "soon" as const;
        const sessionId = typeof payload?.session_id === "string" ? payload.session_id : undefined;
        const place = sessionId === undefined ? undefined : yield* deps.place(sessionId);
        if (place === "leaving" || place === "elsewhere") return "away" as const;
        const record = sessionId === undefined ? undefined : yield* store.getBySession(sessionId);
        const live = record !== undefined && place === "here" && record.session.state === "live" && record.workspace.status !== "parked";
        const mail = yield* Effect.promise(() => verifyAgentMail(payload?.mail, message.body));
        // Forged, altered, another person's or organization's, or not for this chat: nothing runs, and the chat says so.
        if (mail === undefined || mail.organization_id !== link.identity.organizationId || mail.user_id !== link.identity.userId || (message.to_workspace_id !== null && mail.to_workspace_id !== message.to_workspace_id)) {
          yield* refused(live ? record : undefined, "A mail that came through Caveman did not carry a valid signature from one of your Macs, so it was not run.");
          return "done" as const;
        }
        // A chat whose adopt has not landed here yet (it came here with mail on its way): it runs once the chat is here.
        if (record === undefined || place === "arriving") {
          if (record !== undefined || Date.now() - held.since < ARRIVE_WAIT_MS) return "soon" as const;
          yield* Effect.logInfo(`mac mail: ${mail.message_id} is for a chat this Mac does not have; dropped`);
          // Its asker hears it never runs (m-m), answered as the chat it was signed for, which Cloud has on this Mac.
          if (yield* answerable(mail)) later.push(statusReply({ workspaceId: mail.to_workspace_id, title: GONE_TITLE }, mail, GONE_LINE));
          return "done" as const;
        }
        // Archived: it runs nothing, and its asker hears so when this was the chat it was signed for (m-m; Cloud takes the
        // line only while it still has the chat, unarchived, here).
        if (record.workspace.status === "archived") {
          yield* Effect.logInfo(`mac mail: ${mail.message_id} is for a chat this Mac archived; dropped`);
          if ((yield* answerable(mail)) && (yield* deps.syncedWorkspaceOf(record)) === mail.to_workspace_id) later.push(statusReply(record, mail, ARCHIVED_LINE));
          return "done" as const;
        }
        // The chat Cloud hands it to (its session, Cloud's word) must be the chat it was signed for, as this Mac synced it:
        // Cloud never moves a genuine mail into another of this Mac's chats, and a mail never registers a chat with Cloud.
        const own = yield* deps.syncedWorkspaceOf(record);
        if (own === undefined) {
          if (Date.now() - held.since < ARRIVE_WAIT_MS) return "wait" as const;
          yield* refused(record, "A mail that came through Caveman was for a chat this Mac does not share with Caveman, so it was not run.");
          return "done" as const;
        }
        if (own !== mail.to_workspace_id) {
          yield* refused(record, "A mail that came through Caveman was signed for another chat, so it was not run here.");
          return "done" as const;
        }
        const seen = yield* sql<{ at: number }>`SELECT at FROM caveman_sp_mac_mail_seen WHERE signer = ${mail.signer.device_id} AND message_id = ${mail.message_id}`.pipe(Effect.orDie);
        if (seen.length > 0) return "done" as const;
        const markSeen = sql`INSERT OR IGNORE INTO caveman_sp_mac_mail_seen (signer, message_id, at, session_id) VALUES (${mail.signer.device_id}, ${mail.message_id}, ${Date.now()}, ${record.session.id})`.pipe(
          Effect.orDie,
        );
        const age = callAge(mail.at);
        const expired = age !== "ok";
        // Signed ahead of this Mac's clock (one Mac's clock is off): said so, never "too old" (m-n).
        const ahead = age === "future";
        // Signed by an agents key a Mac this Mac trusts vouched for, as a fresh read of the person's log has it (the pass
        // read the log for a key this Mac did not know): only then does anything run, or go back to its sender.
        const check = trusted;
        const vouched = check === undefined ? ({ unread: true } as const) : yield* Effect.promise(() => check(mail.signer.device_id, false));
        if (vouched.unread) {
          if (!expired) return "soon" as const;
          yield* markSeen;
          yield* refused(
            record,
            ahead
              ? "A mail from another of your Macs was signed more than 5 minutes ahead of this Mac's clock, so it was not run: check the date and time on both Macs."
              : "A mail from another of your Macs waited more than a day while this Mac could not check who sent it, so it was not run.",
          );
          return "done" as const;
        }
        if (vouched.agents === undefined) {
          yield* refused(record, "A mail came from a key none of your Macs this Mac trusts vouched for (a removed Mac, or not a Mac), so it was not run.");
          return "done" as const;
        }
        // Named by the Mac that vouched for the key (always the sending Mac: its own screen vouches for its runtime's
        // key) as This Mac knows that Mac, by the name its screen or a Mac it trusts allowed it under, as Settings,
        // Devices names it: never a name the vouch or the mail gives.
        const name = mailFrom(mail, vouched.agents.vouched_by.name);
        const limits = { runtimeMode: mail.runtime_mode, interactionMode: mail.interaction_mode };
        if (expired) {
          yield* markSeen;
          yield* refused(
            record,
            ahead
              ? `A mail from ${name} was signed more than 5 minutes ahead of this Mac's clock, so it was not run: check the date and time on both Macs.`
              : `A mail from ${name} was too old to run (more than a day), so it was not run.`,
          );
          later.push(statusReply(record, mail, ahead ? AHEAD_LINE : "[not run] This mail waited more than a day, so it was not run."));
          return "done" as const;
        }
        // Paused here (session.park, a handoff): it takes nothing until the person carries on, so the sender hears now.
        if (!live) {
          yield* markSeen;
          yield* refused(record, `A mail from ${name} came while this chat was paused, so it was not run.`);
          later.push(statusReply(record, mail, "[not run] That chat is paused on its Mac, so it did not take this mail."));
          return "done" as const;
        }
        // An answer is one only to an ask this chat sent that chat, unanswered, and only once: anything else (an "answer"
        // nobody asked for) is mail like any other.
        const asked =
          mail.in_reply_to === ""
            ? undefined
            : (yield* sql<{ message_id: string }>`SELECT message_id FROM caveman_sp_mac_mail_sent WHERE message_id = ${mail.in_reply_to} AND session_id = ${record.session.id}
                AND to_workspace_id = ${mail.from_workspace_id} AND answered = 0 AND at > ${Date.now() - SENT_FOR_MS}`.pipe(Effect.orDie))[0];
        const modes = yield* deps.modesOf(record);
 // upstream thread_send rule: nothing another chat wrote reaches broader modes than that chat's. Mail into a broader
        // chat is refused; the answer to an ask it sent is not lost: the asker learns it is there, without its words.
        const broader = modes === undefined || broaderThan(modes, limits);
        if (modes === undefined || (broader && asked === undefined)) {
          yield* markSeen;
          yield* refused(record, `A mail from ${name} asked to run here with broader permissions than the chat that sent it has, so it was not run.`);
          later.push(statusReply(record, mail, "[refused] That chat runs with broader permissions than yours, so it did not take this mail."));
          return "done" as const;
        }
        const words = broader ? `${name} answered, but its answer can't be delivered to a chat with broader permissions; open that chat to read it.` : message.body;
        const text = threadMessageEnvelope({
          senderTitle: name,
          senderThreadId: `${MAC_THREAD}${mail.from_workspace_id}`,
          messageId: mail.message_id,
          text: words,
          ...(mail.in_reply_to === "" ? {} : { inReplyTo: mail.in_reply_to }),
          expectsReply: mail.expects_reply,
          canReply: true,
        });
        const headBefore = record.session.head;
        // Queued once by its request id: taken again after a restart, it is the same turn.
        const turn = yield* deps
          .deliver(record, { requestId: `mac-mail:${mail.signer.device_id}:${mail.message_id}`, text, shown: words, from: `${MAC_THREAD}${mail.from_workspace_id}`, name, limits: broader ? modes : limits })
          .pipe(Effect.result);
        if (turn._tag === "Failure") {
          if (Date.now() - held.since < ARRIVE_WAIT_MS) {
            yield* Effect.logWarning(`mac mail: ${mail.message_id} could not queue in ${record.session.id} yet: ${turn.failure.message}`);
            return "wait" as const;
          }
          yield* markSeen;
          yield* refused(record, `A mail from ${name} could not be queued in this chat (${turn.failure.message}), so it was not run.`);
          later.push(statusReply(record, mail, "[not run] That chat could not queue this mail, so it was not run."));
          return "done" as const;
        }
        // One write: run once (seen), and either the answer taken or what the turn owes its sender.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* markSeen;
              // An answer goes back to the chat that asked, which tells the person itself.
              if (asked !== undefined) return yield* sql`UPDATE caveman_sp_mac_mail_sent SET answered = 1 WHERE message_id = ${asked.message_id}`;
              // An ask or a note runs for the chat that sent it: that chat tells the person, this one stays quiet until the
              // turn ends (or never runs). Its answer is read from before the turn's first event, also when the turn was
              // queued (and maybe ran) before a restart took this mail again.
              const first = (yield* sql<{ c: number | null }>`SELECT min(cursor) AS c FROM caveman_sp_events WHERE session_id = ${record.session.id} AND json_extract(event, '$.turn_id') = ${turn.success}`)[0]?.c;
              const from = first === null || first === undefined ? headBefore : Math.min(headBefore, first - 1);
              const signedAt = Date.parse(mail.at);
              const asker = typeof payload?.from_session_id === "string" && payload.from_session_id.length <= 64 ? payload.from_session_id : null;
              yield* sql`INSERT OR IGNORE INTO caveman_sp_mac_mail_runs (message_id, session_id, turn_id, from_cursor, to_workspace_id, from_workspace_id, reply, answered, settled, at, mail_at, from_session_id, signer)
                VALUES (${mail.message_id}, ${record.session.id}, ${turn.success}, ${from}, ${mail.to_workspace_id}, ${mail.from_workspace_id}, ${mail.expects_reply ? 1 : 0}, 0, 0, ${Date.now()}, ${Number.isFinite(signedAt) ? signedAt : Date.now()}, ${asker}, ${mail.signer.device_id})`;
            }),
          )
          .pipe(Effect.orDie);
        // Queued behind the person's own turn, it names no one yet; one that started already (an idle chat) does now.
        if (asked === undefined) yield* refreshAskedBy(record.session.id);
        return "done" as const;
      });

    /** Mail held here and taken now, finished in each receiving chat's order (Cloud's recipient_seq), whatever order it came in. */
    const pass = (held: Map<string, Held>) =>
      Effect.gen(function* () {
        const byLease = (entries: ReadonlyArray<Held>) => {
          const out = new Map<string, Array<string>>();
          for (const h of entries) out.set(h.lease, [...(out.get(h.lease) ?? []), h.message.id]);
          return out;
        };
        // Held another lease while it waits; what the lease no longer holds goes (Cloud hands it out again).
        const due = [...held.values()].filter((h) => Date.now() - h.leased >= RENEW_EVERY_MS);
        for (const [lease, ids] of byLease(due)) {
          const at = Date.now();
          const out = yield* cloudCall((identity, state) => renewMacMail(identity, state, lease, ids));
          for (const id of out.lost) held.delete(id);
          for (const id of out.renewed) {
            const h = held.get(id);
            if (h !== undefined) h.leased = at;
          }
        }
        const taken = yield* cloudCall((identity, state) => takeMacMail(identity, state));
        if (taken.lease !== null) for (const message of taken.messages) held.set(message.id, { message, lease: taken.lease, since: Date.now(), leased: Date.now() });
        yield* refresh(held);
        const chatOf = (h: Held) => String((h.message.payload as MacMailPayload | undefined)?.session_id ?? h.message.to_workspace_id ?? "");
        const seqOf = (h: Held) => (h.message.payload as MacMailPayload | undefined)?.recipient_seq ?? 0;
        const ordered = [...held.values()].sort((a, b) => chatOf(a).localeCompare(chatOf(b)) || seqOf(a) - seqOf(b));
        const acked: Array<Held> = [];
        // A receiving chat whose earlier mail waits keeps its later mail waiting too: it runs them in order.
        const waiting = new Set<string>();
        let soon = false;
        for (const h of ordered) {
          const chat = chatOf(h);
          if (waiting.has(chat)) continue;
          const later: Array<Effect.Effect<void>> = [];
          const outcome = yield* lane.withPermits(1)(deliver(h, later)).pipe(Effect.catchCause((cause) => Effect.logWarning(`mac mail: ${h.message.id} failed`, cause).pipe(Effect.as<Outcome>("wait"))));
          for (const reply of later) yield* reply;
          if (outcome === "soon" || outcome === "wait") {
            if (outcome === "soon") soon = true;
            waiting.add(chat);
            continue;
          }
          held.delete(h.message.id);
          if (outcome === "done") acked.push(h);
          // Its chat left this Mac: all its mail goes with it.
          else {
            waiting.add(chat);
            for (const other of [...held.values()]) if (chatOf(other) === chat) held.delete(other.message.id);
          }
        }
        for (const [lease, ids] of byLease(acked)) yield* cloudCall((identity, state) => ackMacMail(identity, state, lease, ids));
        return { taken: taken.messages.length, soon };
      });

    // ------------------------------------------------------------ answers

    /** Why a mail turn will never run here, or undefined while it still may (queued, running, or its chat on the move). */
    const neverRuns = (record: WorkspaceRecord, turn: { readonly started: boolean; readonly over: boolean } | undefined) =>
      Effect.gen(function* () {
        const place = yield* deps.place(record.session.id);
        if (place === "elsewhere") return MOVED_LINE;
        if (place !== "here") return undefined;
        return turn === undefined || (turn.over && !turn.started) ? "[not run] This mail was taken out of that chat's queue before it ran." : undefined;
      });

    /**
     * The chat whose mail a chat here is running now, if any: a mail turn of it that started and is not over (its own
     * turn.started and no turn.done yet, and its thread does not say it ended). Written as asked_by_session_id, so the
     * chat that asked tells the person while that turn runs, and never for the person's own turns (one the mail queued
     * behind, or any after). Read from the chat's events each time, one look at a time: the last look after the last
     * event has it right, whatever order the looks came in.
     */
    const refreshAskedBy = (sessionId: string) =>
      askLane.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* store.getBySession(sessionId);
          if (record === undefined) return;
          let asker: string | undefined;
          for (const row of yield* runs({ session: sessionId, unsettled: true })) {
            if (row.from_session_id === null) continue;
            const marks = yield* sql<{ type: string }>`SELECT DISTINCT type FROM caveman_sp_events WHERE session_id = ${sessionId} AND cursor > ${row.from_cursor}
              AND type IN ('turn.started', 'turn.done') AND json_extract(event, '$.turn_id') = ${row.turn_id}`.pipe(Effect.orDie);
            if (!marks.some((m) => m.type === "turn.started") || marks.some((m) => m.type === "turn.done")) continue;
            if ((yield* deps.runOf(record, row.turn_id))?.over === true) continue;
            asker = row.from_session_id;
            break;
          }
          yield* deps.askedBy(record, asker);
        }),
      );

    /** Answers on their way to Cloud now, by the mail they answer: one send at a time for each. */
    const sending = new Set<string>();

    /**
     * Whether the Mac whose agents key signed a mail no longer counts here, as trust stands (removed on this Mac or on
     * another of the person's since the mail came). False while that is not known: no trust check bound yet, a log not
     * read since a wake (it is asked again once it is), or no sign-in naming the person.
     */
    const senderGone = (signer: string | null) =>
      Effect.gen(function* () {
        const check = trusted;
        const link = deps.link();
        if (signer === null || check === undefined || link === undefined || link.identity.userId === undefined) return false;
        const known = yield* Effect.promise(() => check(signer, false));
        return !known.unread && known.agents === undefined;
      });

    /**
     * A mail turn a chat here ran (or never will): once it ends, the chat is its own again at once, and an ask's answer
     * (that turn's own last message, or a status line) goes back once, unless the agent replied itself. An answer that
     * cannot go for now (Cloud not reached, the asker on a Cloud computer) is kept and tried again later, less often each
     * time, while its asker still takes it; it never holds the chat as asked. `leaving`: the chat is going (a move, the
     * lid), so a turn that has not ended never runs here: it leaves the queue, and its asker hears so while Cloud still
     * has the chat here. A turn whose sending Mac was removed since it came (A-4) never starts either: it leaves the queue
     * at once, and its sender hears only that, never an answer (one already running ends as it would, and its answer
     * stays here). What the turn owes is worked out under the lane; Cloud is called outside it.
     */
    const settle = (row: RunRow, leaving = false) =>
      Effect.gen(function* () {
        const due = yield* lane.withPermits(1)(
          Effect.gen(function* () {
            const current = (yield* runs({ message: row.message_id }))[0];
            if (current === undefined || current.settled === 1) return undefined;
            const removed = yield* senderGone(current.signer);
            if (!leaving && !removed && current.next_at > Date.now()) return undefined;
            const record = yield* store.getBySession(current.session_id);
            const owed = current.reply === 1 && current.answered === 0;
            let line = current.answer ?? undefined;
            if (line === undefined && record !== undefined) {
              const done = (
                yield* sql<{ event: string }>`SELECT event FROM caveman_sp_events WHERE session_id = ${record.session.id} AND cursor > ${current.from_cursor} AND type = 'turn.done'
                  AND json_extract(event, '$.turn_id') = ${current.turn_id} ORDER BY cursor LIMIT 1`.pipe(Effect.orDie)
              ).map((e) => JSON.parse(e.event) as SessionEvent)[0];
              const stopped = done?.type === "turn.done" && done.payload.status === "interrupted";
              // Stopped only to carry on here by itself once Caveman answers (decision 26): its answer is the turn that
              // continues it (continueTurn), never the stop's words (F-5).
              if (stopped && current.carried === null && (yield* deps.resumesHere(record.session.id, current.turn_id))) return undefined;
              if (done !== undefined) {
                if (owed && removed) line = WITHHELD_LINE;
                // Stopped by the lid's handoff to carry on with the chat elsewhere, where no answer is sent from (F-5).
                else if (owed && stopped && current.carried !== null) line = CARRIED_LINE;
                else if (owed) {
                  // Only that turn's own words: a turn it queued behind (the person's, another asker's) is never its answer.
                  const own = (yield* store.readEvents(record.session.id, current.from_cursor, done.cursor)).filter((e) => e.turn_id === current.turn_id);
                  const result = resultOf(own, done.cursor);
                  line = result.status === "completed" ? result.text : `[${result.status}] ${result.text}`;
                }
              } else {
                const turn = yield* deps.runOf(record, current.turn_id);
                // From a Mac removed since it came: one not started never does; one running ends as it would.
                const never = leaving ? MOVED_LINE : removed && turn?.started !== true ? REMOVED_LINE : yield* neverRuns(record, turn);
                // Still to run, or running: looked at again when it ends, or a day on.
                if (never === undefined && Date.now() - current.at < SEEN_FOR_MS) return undefined;
                if (owed) line = removed && never === undefined ? WITHHELD_LINE : (never ?? lateLine(turn?.started === true));
                // Its asker hears it does not run: it never does, here, even should the chat stay after all.
                yield* deps.dropQueued(record, current.turn_id);
              }
              if (line !== undefined) yield* sql`UPDATE caveman_sp_mac_mail_runs SET answer = ${line} WHERE message_id = ${current.message_id}`.pipe(Effect.orDie);
            } else if (removed && owed && line !== undefined && line !== REMOVED_LINE && line !== WITHHELD_LINE && line !== MOVED_LINE) {
              // An answer kept for a retry never goes to a Mac removed since: only that it was.
              line = WITHHELD_LINE;
              yield* sql`UPDATE caveman_sp_mac_mail_runs SET answer = ${line} WHERE message_id = ${current.message_id}`.pipe(Effect.orDie);
            }
            return { current, record, owed, line };
          }),
        );
        if (due === undefined) return;
        const { current, record, owed, line } = due;
        // The turn is over or never runs: the chat is its own again now, whatever becomes of its answer.
        yield* refreshAskedBy(current.session_id);
        if (sending.has(current.message_id)) return;
        sending.add(current.message_id);
        yield* Effect.gen(function* () {
          if (line !== undefined && record !== undefined && owed) {
            if (Date.now() - current.mail_at >= SENT_FOR_MS) yield* Effect.logWarning(`mac mail: the answer to ${current.message_id} is past what its asker takes (two days); nothing more goes`);
            else {
              const sent = yield* sendSigned({
                from: record,
                to: current.from_workspace_id,
                body: line.length > ANSWER_MAX_CHARS ? `${line.slice(0, ANSWER_MAX_CHARS)}\n\n[cut: the full answer is in its chat]` : line,
                messageId: messageIdOf(`answer:${current.message_id}`),
                ask: false,
                inReplyTo: current.message_id,
                limits: (yield* deps.modesOf(record)) ?? NARROWEST,
              }).pipe(Effect.result);
              if (sent._tag === "Failure") {
                if (!finalRefusal(sent.failure)) {
                  yield* sql`UPDATE caveman_sp_mac_mail_runs SET tries = tries + 1, next_at = ${Date.now() + retryAfter(current.tries)} WHERE message_id = ${current.message_id}`.pipe(Effect.orDie);
                  return yield* Effect.logWarning(`mac mail: the answer to ${current.message_id} did not go (${sent.failure.message}); it goes on a later look`);
                }
                yield* Effect.logWarning(`mac mail: the answer to ${current.message_id} was refused (${sent.failure.message}); nothing more goes`);
              }
            }
          }
          yield* sql`UPDATE caveman_sp_mac_mail_runs SET settled = 1 WHERE message_id = ${current.message_id}`.pipe(Effect.orDie);
        }).pipe(Effect.ensuring(Effect.sync(() => sending.delete(current.message_id))));
      });

    /**
     * A chat this Mac lets go of (a move, the lid), once its turn stopped: each mail turn of it settles now, while Cloud
     * still has the chat here (once it moved, Cloud takes no reply from this Mac for it). One that ended sends its answer;
     * one that never ran leaves the queue, and its asker hears so. What cannot go now is kept and tried again.
     */
    const letGo = (sessionId: string) =>
      Effect.gen(function* () {
        for (const row of yield* runs({ session: sessionId, unsettled: true })) yield* settle(row, true).pipe(Effect.catchCause((cause) => Effect.logWarning(`mac mail: settling ${row.message_id} as its chat left failed`, cause)));
      });

    /**
     * Trust changed (a Mac removed on this screen, or a removal or allow read from the person's log): each mail turn not
     * settled yet is looked at again now, so one from a Mac that no longer counts leaves its queue before the turn ahead
     * of it ends (A-4). Changes that come while a look runs make one more look after it.
     */
    let looking = false;
    let lookAgain = false;
    const trustChanged = (): void => {
      lookAgain = true;
      if (looking) return;
      looking = true;
      runFork(
        Effect.gen(function* () {
          while (lookAgain) {
            lookAgain = false;
            // Read under the lane: a mail being queued now (deliver queues its turn, then writes its row) is either
            // written already and looked at here, or judged after this change of trust by deliver itself (m-i).
            for (const row of yield* lane.withPermits(1)(runs({ unsettled: true })))
              if (row.signer !== null) yield* settle(row).pipe(Effect.catchCause((cause) => Effect.logWarning(`mac mail: settling ${row.message_id} after a change of trust failed`, cause)));
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              looking = false;
              if (lookAgain) trustChanged();
            }),
          ),
        ),
      );
    };

    /** Mail turns that end without a turn.done (taken out of the queue, left behind by a move), and what is past keeping. */
    const sweep = Effect.gen(function* () {
      const now = Date.now();
      yield* sql`DELETE FROM caveman_sp_mac_mail_seen WHERE at < ${now - SEEN_FOR_MS}`.pipe(Effect.orDie);
      yield* sql`DELETE FROM caveman_sp_mac_mail_runs WHERE settled = 1 AND at < ${now - SEEN_FOR_MS}`.pipe(Effect.orDie);
      yield* sql`DELETE FROM caveman_sp_mac_mail_sent WHERE at < ${now - SENT_FOR_MS}`.pipe(Effect.orDie);
      for (const row of yield* runs({ unsettled: true })) yield* settle(row).pipe(Effect.catchCause((cause) => Effect.logWarning(`mac mail: settling ${row.message_id} failed`, cause)));
    });

    /**
     * The lid hands a working chat on mid-turn (`on`), or does not after all (the stop failed): its mail turns not settled
     * yet are marked before the stop, so whichever look settles a turn the stop ended answers that it carries on
     * elsewhere, never the stop's words (F-5). Only an interrupted turn reads it.
     */
    const carry = (sessionId: string, on: boolean) =>
      sql`UPDATE caveman_sp_mac_mail_runs SET carried = ${on ? "lid" : null} WHERE session_id = ${sessionId} AND settled = 0`.pipe(Effect.orDie, Effect.asVoid);

    /**
     * A turn that stopped to carry on here by itself (resumesHere) continues as `toTurnId`: its mail's answer is that
     * turn's own (F-5), and while it runs the chat names its asker again.
     */
    const continueTurn = (sessionId: string, fromTurnId: string, toTurnId: string) =>
      Effect.gen(function* () {
        const moved = yield* lane.withPermits(1)(
          Effect.gen(function* () {
            const rows = (yield* runs({ session: sessionId, unsettled: true })).filter((r) => r.turn_id === fromTurnId);
            if (rows.length > 0) yield* sql`UPDATE caveman_sp_mac_mail_runs SET turn_id = ${toTurnId} WHERE session_id = ${sessionId} AND turn_id = ${fromTurnId} AND settled = 0`.pipe(Effect.orDie);
            return rows.length > 0;
          }),
        );
        // Its end is looked at as any mail turn's is (its turn.done, or the sweep should it have ended already).
        if (moved) yield* refreshAskedBy(sessionId);
      });

    // ------------------------------------------------------------ asks that travel with their chat

    /** The asks a chat here sent and has no answer to yet, for its copy (a move carries them: MoveBundle mac_asks). */
    const asksOf = (sessionId: string) =>
      sql<CarriedAsk>`SELECT message_id, to_workspace_id, at FROM caveman_sp_mac_mail_sent WHERE session_id = ${sessionId} AND answered = 0 AND at > ${Date.now() - SENT_FOR_MS} ORDER BY at`.pipe(
        Effect.orElseSucceed((): ReadonlyArray<CarriedAsk> => []),
      );
    /** A chat adopted here: the asks its copy carried are its own here, so their answers are answers here. */
    const carryAsks = (sessionId: string, asks: unknown) =>
      Effect.gen(function* () {
        if (!Array.isArray(asks)) return;
        for (const ask of asks.slice(0, 200) as Array<Partial<CarriedAsk> | null>) {
          if (typeof ask?.message_id !== "string" || !UUID.test(ask.message_id)) continue;
          if (typeof ask.to_workspace_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(ask.to_workspace_id) || typeof ask.at !== "number" || !Number.isFinite(ask.at)) continue;
          yield* sql`INSERT OR IGNORE INTO caveman_sp_mac_mail_sent (message_id, session_id, to_workspace_id, answered, at) VALUES (${ask.message_id}, ${sessionId}, ${ask.to_workspace_id}, 0, ${ask.at})`.pipe(Effect.orDie);
        }
      });

    /**
     * The mail a chat here ran or acted on lately, by signer and message id, for its copy (a move carries them: MoveBundle
     * mac_seen): Cloud handing one of them to the computer the chat goes to never runs it there.
     */
    const seenOf = (sessionId: string) =>
      sql<CarriedSeen>`SELECT signer, message_id, at FROM caveman_sp_mac_mail_seen WHERE session_id = ${sessionId} AND at > ${Date.now() - SEEN_FOR_MS} ORDER BY at DESC LIMIT ${CARRIED_SEEN}`.pipe(
        Effect.orElseSucceed((): ReadonlyArray<CarriedSeen> => []),
      );
    /** A chat adopted here: the mail its copy says it ran is run here too (it never runs again), for as long as it was there. */
    const carrySeen = (sessionId: string, seen: unknown) =>
      Effect.gen(function* () {
        if (!Array.isArray(seen)) return;
        const since = Date.now() - SEEN_FOR_MS;
        for (const row of seen.slice(0, CARRIED_SEEN) as Array<Partial<CarriedSeen> | null>) {
          if (typeof row?.signer !== "string" || !THUMBPRINT.test(row.signer) || typeof row.message_id !== "string" || !UUID.test(row.message_id)) continue;
          if (typeof row.at !== "number" || !Number.isFinite(row.at) || row.at <= since) continue;
          yield* sql`INSERT OR IGNORE INTO caveman_sp_mac_mail_seen (signer, message_id, at, session_id) VALUES (${row.signer}, ${row.message_id}, ${Math.min(row.at, Date.now())}, ${sessionId})`.pipe(Effect.orDie);
        }
      });

    // ------------------------------------------------------------ the read loop

    const run = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        if (deps.onComputer || deps.agentsKey === undefined) return;
        // A mail turn's start and end: the chat names the chat that asked while it runs, and its answer goes once it ends.
        const events = yield* PubSub.subscribe(store.events);
        yield* Effect.forever(
          PubSub.take(events).pipe(
            Effect.flatMap((event) =>
              event.type !== "turn.started" && event.type !== "turn.done"
                ? Effect.void
                : runs({ session: event.session_id, unsettled: true }).pipe(
                    Effect.flatMap((rows) => {
                      const mine = rows.filter((r) => r.turn_id === event.turn_id);
                      if (mine.length === 0) return Effect.void;
                      return refreshAskedBy(event.session_id).pipe(Effect.andThen(event.type === "turn.done" ? Effect.forEach(mine, (r) => settle(r), { discard: true }) : Effect.void));
                    }),
                  ),
            ),
            Effect.catchCause((cause) => Effect.logWarning("mac mail: answering an ask failed", cause)),
          ),
        ).pipe(Effect.forkIn(scope));
        // At start (what a restart left), then every SWEEP_MS.
        yield* Effect.forever(sweep.pipe(Effect.catchCause((cause) => Effect.logWarning("mac mail: a sweep failed", cause)), Effect.andThen(Effect.sleep(`${SWEEP_MS} millis`)))).pipe(Effect.forkIn(scope));
        const held = new Map<string, Held>();
        let backoff = POLL_MS;
        yield* Effect.forever(
          Effect.gen(function* () {
            const link = deps.link();
            if (link === undefined || link.identity.userId === undefined) return yield* Effect.sleep("5 seconds");
            const outcome = yield* pass(held).pipe(Effect.result);
            if (outcome._tag === "Failure") {
              yield* Effect.logWarning(`mac mail: reading mail from your other Macs failed: ${outcome.failure.message}`);
              yield* Effect.sleep(`${backoff} millis`);
              backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
              return;
            }
            backoff = POLL_MS;
            if (outcome.success.taken > 0) return;
            // Mail that may run in a moment (a log not read since this Mac woke, a chat whose adopt has not landed): tried
            // again soon. Otherwise Cloud's long wait says when mail comes, cut short to renew the leases of mail held here.
            if (outcome.success.soon) return yield* Effect.sleep(`${POLL_MS} millis`);
            yield* Effect.tryPromise(() => waitMacMail(link.identity, link.state, held.size > 0 ? RENEW_EVERY_MS : WAIT_MS)).pipe(Effect.catch(() => Effect.sleep(`${POLL_MS} millis`)));
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("mac mail: a pass failed", cause).pipe(Effect.andThen(Effect.sleep("5 seconds"))))),
        ).pipe(Effect.forkIn(scope));
      });

    return {
      send,
      peer,
      run,
      letGo,
      carry,
      continueTurn,
      asksOf,
      carryAsks,
      seenOf,
      carrySeen,
      /**
       * The server's device registry: whether a Mac This Mac trusts vouched for an agents key (devices.ts agentsTrusted),
       * whether this Mac's own is vouched for and in Cloud (devices.ts agentsShared), and a hook it calls when trust
       * changes (devices.ts onTrust), on which mail a removed Mac queued here leaves its queue (A-4).
       */
      trustWith: (check: NonNullable<typeof trusted>, isShared: NonNullable<typeof shared>, onTrust?: (listener: () => void) => void) => {
        trusted = check;
        shared = isShared;
        onTrust?.(trustChanged);
      },
    } as const;
  });
