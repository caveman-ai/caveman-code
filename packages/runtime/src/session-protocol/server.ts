// Session Protocol v1 over WebSocket: bearer auth on the upgrade, JSON-RPC
// framing, request_id idempotency, session attachments that replay from a
// cursor then follow live, and terminals (packages/session-protocol README).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ThreadId, TurnItemId } from "@caveman-app/protocol";
import {
  ErrorCodes,
  Methods,
  SUBPROTOCOL,
  isMutating,
  type EngineDescriptor,
  type ErrorReason,
  type McpClientId,
  type MethodName,
  type SessionEvent,
} from "@caveman-app/session-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { AutomationFiles } from "../automations/services.ts";
import * as ServerConfig from "../config.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { childEnv } from "./workspaceIsolation.ts";
import { makeBrowser } from "./browser.ts";
import { makeComputer } from "./computer.ts";
import { carryOnWith } from "./connectionNotes.ts";
import { makeDevices } from "./devices.ts";
import { makeHandlers, ProtocolError } from "./handlers.ts";
import {
  AGENT_PRINCIPAL,
  agentHears,
  connectCommand,
  disconnected,
  enginesForAgents,
  gate,
  hidden,
  isAgentPrincipal,
  lineageOf,
  listed,
  lowerLevel,
  makeRegistry,
  sanitizeName,
  type GateDeps,
  type Level,
  type Lineage,
} from "./outsideAgents.ts";
import { detect as detectClients, installFor } from "./mcpClients.ts";
import { containedPath, readComputerConfig } from "./lifecycle.ts";
import { followingStream, makeCommandOutputScrub, repoEnv } from "./secrets.ts";
import { CommandOutputHub } from "../orchestration-v2/CommandOutputHub.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { Outbox } from "./outbox.ts";
import { EngineAccountChanges } from "./engineAccounts.ts";
import { forOthers } from "./ownerGate.ts";
import { SessionStore } from "./store.ts";
import { CARRIED_RECEIPTS, carriedKey, type CarriedReceipt } from "../cloudLink/copySegments.ts";
import { CloudLinkState } from "../cloudLink/index.ts";
import { carriedSigned, signedReceipt } from "../cloudLink/moves.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { Desktop } from "./desktop.ts";

export const SESSION_PROTOCOL_PATH = "/session/v1";
export const TOKEN_FILE = "session-protocol.token";
const BEARER_PREFIX = "base64url.bearer.";
const DAY_MS = 24 * 60 * 60 * 1000;
const KEYSTROKE_MS = 10 * 60 * 1000;
/** Calls that carry keystrokes or typed text (a password at a prompt or in a page): kept briefly. */
const KEYSTROKE_METHODS = new Set<string>(["term.write", "term.resize", "browser.input", "computer.input"]);
/** The calls a device may queue in Cloud: a person's receipt of one travels with the chat's copy (M-8). */
const CARRIED_METHODS = new Set<string>(["turn.submit", "turn.interrupt", "ask.respond"]);
/**
 * Calls whose effect is the asking connection's and ends with it (closeConnection hands control back, ends the call):
 * no receipt, so one resent on the next connection after a drop takes control or dials there instead of answering
 * what the old one was given.
 */
const CONNECTION_METHODS = new Set<string>(["browser.control", "computer.control", "chief.voice.start"]);
/**
 * Calls that do slow work beside a chat (an LLM call, the network, starting the browser or a Cloud desktop for Take
 * over) and that none of its other calls build on, by the lane each kind keeps its own order in: a chat's Stop or an
 * answer to its agent never waits for them. The person's input to the browser or desktop shares that lane, so it lands
 * after the Take over it follows.
 */
const SIDE_LANES = new Map<string, string>([
  ["skill.record", "skill"],
  ["git.push", "git"],
  ["git.pr", "git"],
  ["browser.navigate", "browser"],
  ["browser.history", "browser"],
  ["browser.control", "browser"],
  ["browser.input", "browser"],
  ["computer.control", "computer"],
  ["computer.input", "computer"],
]);
/** An attach's batched backlog: journal rows per query, and the events text one session.events frame holds (a bigger event goes alone). */
const BACKLOG_PAGE_EVENTS = 2_000;
const BACKLOG_FRAME_BYTES = 256 * 1024;
/** An attach's backlog reads its next page only once at most this much waits to go to the client. */
const BACKLOG_PAUSE_BYTES = 2 * 1024 * 1024;
/** Bytes the socket may hold unsent; past this, frames wait in the connection's outbox (outbox.ts). */
const SOCKET_HIGH_WATER = 512 * 1024;
/** A watched command's next frame is read only once at most this much waits: the hub then sends a client that fell behind its whole tail. */
const TOOL_LIVE_PAUSE_BYTES = 256 * 1024;
/** Close code for a client too far behind to catch up frame by frame: it reconnects and resumes from its cursors. */
const CLOSE_TOO_FAR_BEHIND = 4008;
/** Close code for an outside agent the person disconnected (Settings > Caveman MCP). */
const CLOSE_DISCONNECTED = 4003;

/** The upgraded socket's unsent bytes, and a wait for them to drain (index.ts passes the request's TCP socket). */
export interface SocketBacklog {
  readonly bytes: () => number;
  readonly drained: Effect.Effect<void>;
}

/** For the ws server's handleProtocols: pick ours when offered, else ws's default (the first). */
export const selectSubprotocol = (protocols: Set<string>): string | false =>
  protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : (protocols.values().next().value ?? false);

/** The bearer from `Authorization: Bearer` or the `base64url.bearer.<token>` subprotocol. */
export function bearerOf(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  const header = headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const offered = (headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const encoded = offered.find((p) => p.startsWith(BEARER_PREFIX));
  return encoded ? Buffer.from(encoded.slice(BEARER_PREFIX.length), "base64url").toString("utf8") : undefined;
}

/**
 * The tokens the runtime accepts: a fresh one in a 0600 file, which local
 * clients (`caveman code`, a desktop attaching to a runtime it did not start)
 * read, plus the desktop's bootstrap token when it gave one.
 */
export const resolveTokens = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const token = randomBytes(32).toString("hex");
  const file = path.join(config.stateDir, TOKEN_FILE);
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return config.desktopBootstrapToken ? [token, config.desktopBootstrapToken] : [token];
});

const sameToken = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);

interface Connection {
  readonly id: string;
  /** Who calls: "local", "cloud:<user>", or "agent:<id>" once outside_agent.become made it an outside agent's (once). */
  principal: string;
  /** The outside agent this connection is (outsideAgents.ts): its id, name and `--at-most`. Set once, by become. */
  agent?: { readonly id: string; readonly name: string; readonly atMost?: Level };
  /** A queued call Cloud says another runtime handed on (runCall's `via`): the runtime it names. Never a socket's. */
  readonly forwardedBy?: string;
  /** A chat's start from Cloud's queue (runCall's `via`): the session Cloud placed with it. Never a socket's. */
  readonly placedSession?: string;
  /** Closes the socket (an agent the person disconnected); the client may come back and is refused then. */
  kick: () => void;
  readonly outbox: Outbox;
  /** Its socket closed and its attachments were ended: nothing may attach to it after that. */
  closed: boolean;
  readonly attachments: Map<string, Fiber.Fiber<void>>;
  /** What streams to this connection: commands' output (tool.watch) by workspace and item, and chats' suggestions (suggestion.watch). */
  readonly watches: Map<string, Fiber.Fiber<void>>;
  /** The last mutating call of each chat on this connection, its last attach or detach, and its last side work of each kind: the next one starts once it ended (G14). */
  readonly lanes: Map<string, Deferred.Deferred<void>>;
}

/** Calls a client makes by looking (marking a chat read, a window's size): no activity that keeps a computer up (S7). */
const WATCHING = (method: string, params: Record<string, unknown>) =>
  method === "term.resize" || (method === "workspace.inbox" && (params.action as { do?: string } | undefined)?.do === "seen");

/** The chat a mutating call acts on, for its order on the connection: its session (a workspace's, by `sessionOf`). */
const laneKey = (params: unknown, sessionOf: (workspaceId: string) => string | undefined) => {
  if (params === null || typeof params !== "object") return undefined;
  const p = params as { session_id?: unknown; workspace_id?: unknown };
  if (typeof p.session_id === "string") return p.session_id;
  return typeof p.workspace_id === "string" ? (sessionOf(p.workspace_id) ?? `workspace:${p.workspace_id}`) : undefined;
};

interface TerminalRoute {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly workspaceSessionId: string;
  /** Connections that opened or attached to it: term.output flows to them. */
  readonly openers: Set<Connection>;
  readonly command?: string;
  readonly cwd: string;
  readonly createdAt: string;
  cols: number;
  rows: number;
  exitCode?: number | null;
  exitSignal?: number;
  exitedAt?: string;
  /** Why its shell never started, as the manager's "error" event said: term.open answers with it. */
  startError?: string;
  /** Holds back a tail that could start a secret value; follows scrubber changes; sent when output pauses. */
  readonly scrub: ReturnType<typeof followingStream>;
  flushTimer?: ReturnType<typeof setTimeout>;
}

/** How long terminal output may pause before a held-back tail is sent anyway (an echo, a prompt). */
const TERMINAL_FLUSH_MS = 30;

/** Every connection's outbox, for diagnostics and tests (the queue of a slow client stays bounded). */
export const liveOutboxes = new Set<Outbox>();

export const makeSessionProtocolServer = Effect.gen(function* () {
  // Where engine.list's answer changes with no provider changing (engineAccounts.ts): provided to the handlers below.
  const accountChanges = yield* EngineAccountChanges;
  const { handlers, recordBySession, recordByWorkspace, worktreeOf, terminals, live, secretsAllowed, chief, voice, environmentChanges, environmentProposals, environmentSetupChats, moves, macMail, archiveDone, settingsSync, bootSteps, headless, deviceLog, outsideAgentFacts } = yield* makeHandlers;
  // A chat refused for want of a plan or key carries on by itself once something serves its engine (connectionNotes.ts):
  // the person's last message goes again as the chat's next turn, on the chat's own engine.
  carryOnWith(yield* CloudLinkState, (record, text) =>
    handlers["turn.submit"]({ request_id: `served-${randomUUID()}`, session_id: record.session.id, kind: "followup", input: { text } }, { connectionId: "" }),
  );
  const store = yield* SessionStore;
  const secrets = yield* ProjectSecrets;
  // secret.set receipts hash an HMAC of the values: a retry with another value conflicts, and the row is no oracle.
  const receiptKey = yield* (yield* ServerSecretStore).getOrCreateRandom("session-receipt-hmac-key", 32).pipe(Effect.orDie);
  const tokens = yield* resolveTokens;
  const scope = yield* Effect.scope;
  const connections = new Set<Connection>();
  const terminalRoutes = new Map<string, TerminalRoute>();
  const inflight = new Map<string, { readonly hash: string; readonly deferred: Deferred.Deferred<unknown, ProtocolError> }>();
  /** When a client last changed something here (a call that is not just looking): the computer stays up a sleep window after (S7). */
  let lastChangeAt = 0;
  const desktop = Option.getOrUndefined(yield* Effect.serviceOption(Desktop));
  /** Each workspace's session, so a chat's calls by workspace and by session share one order. Kept from workspace.changed. */
  const known = yield* store.listWorkspaces();
  const sessionOfWorkspace = new Map(known.map((r) => [r.workspace.id, r.session.id] as const));

  /** What the target rule reads of every chat (outsideAgents.ts lineage): kept from workspace.changed, for notifications. */
  const lineages = new Map<string, Lineage>(known.map((r) => [r.workspace.id, r.workspace] as const));
  /** An outside agent hears workspace.changed for the chats it may read, and engine.changed; nothing else. */
  const hears = (connection: Connection, method: string, params: unknown) =>
    connection.agent === undefined
      ? !isAgentPrincipal(connection.principal)
      : agentHears(method, params, (workspace) => !hidden(lineageOf(workspace, (id) => lineages.get(id))));

  const send = (connection: Connection, message: unknown) => connection.outbox.push(JSON.stringify(message));
  const sendText = (connection: Connection, frame: string) => connection.outbox.push(frame);
  /** What of a notification an outside agent gets: engines without the person's logins and limits. */
  const shown = (connection: Connection, method: string, params: unknown) =>
    connection.agent !== undefined && method === "engine.changed" ? enginesForAgents(params as { engines: ReadonlyArray<EngineDescriptor> }) : params;
  const notify = (connection: Connection, method: string, params: unknown) => {
    if (hears(connection, method, params)) send(connection, { jsonrpc: "2.0", method, params: shown(connection, method, params) });
  };
  /** A state the client needs only the newest of: replaces the same state still waiting for a slow client. */
  const notifyLatest = (connection: Connection, key: string, method: string, params: unknown) => {
    if (hears(connection, method, params)) connection.outbox.pushLatest(key, JSON.stringify({ jsonrpc: "2.0", method, params: shown(connection, method, params) }));
  };

  // Outside agents (outsideAgents.ts): every name that has connected, its level, and whether the person blocked it.
  const registry = yield* makeRegistry(store);
  const connectedAs = (name: string) => [...connections].filter((connection) => connection.agent?.name === name).length;
  const agentList = Effect.gen(function* () {
    const workspaces = (yield* store.listWorkspaces()).map((r) => r.workspace);
    // Settings > Caveman MCP's install rows: which clients are here and hold the server (mcpClients.ts). Never fails the list.
    const clients = yield* Effect.tryPromise(() => detectClients()).pipe(Effect.option);
    return {
      agents: registry.entries().map((entry) => listed(entry, connectedAs(entry.name), workspaces)),
      command: [...connectCommand()],
      ...(Option.isSome(clients) ? { clients: [...clients.value] } : {}),
    };
  });
  /** The status each agent-started chat last had, so a change of its activity alone sends no outside_agent.changed. */
  const agentChatStatus = new Map<string, string>();
  const owners = () => [...connections].filter((connection) => connection.agent === undefined && secretsAllowed(connection.principal));
  /** outside_agent.changed: Settings > Caveman MCP again, to the owner's connections only. */
  const agentsChanged = Effect.suspend(() =>
    owners().length === 0
      ? Effect.void
      : agentList.pipe(
          Effect.map((list) => {
            for (const connection of owners()) notifyLatest(connection, "outside_agents", "outside_agent.changed", list);
          }),
          Effect.ignore,
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
  );
  const refuse = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));

  const workspaceOfThread = (threadId: string) => store.getByThread(threadId).pipe(Effect.map((record) => record?.workspace.id));
  const browser = yield* makeBrowser({ recordByWorkspace, workspaceOfThread, notify, connections: () => connections });
  const computer = yield* makeComputer({ recordByWorkspace, workspaceOfThread, notify, connections: () => connections });
  // The devices that may drive This Mac through Caveman Cloud (DESIGN S13): allowed on this Mac's own screen only.
  const devices = yield* makeDevices({
    notifyLocal: (method, params) => {
      for (const connection of connections) if (connection.principal === "local") notify(connection, method, params);
    },
    agentsKey: macMail.agentsKey,
  });
  // A move Cloud passes on runs on This Mac only when a device allowed here signed it (handlers actOnMove).
  moves.verifyWith(devices.queuedMoveAllowed);
  // Continue on This Mac's stop of a turn here runs only when a device allowed here signed it (handlers pullStopSigned).
  moves.stopWith(devices.queuedCallAllowed);
  // Mail from another of the person's Macs runs only when a Mac this Mac trusts vouched for its agents key (macMail.ts),
  // and mail it queued here leaves the queue once that Mac no longer counts (A-4): told on every change of trust.
  macMail.trustWith(devices.agentsTrusted, devices.agentsShared, devices.onTrust);
  // The approvals the person's Macs share, from their log in Cloud (devices-2026-10-31).
  yield* devices.follow(deviceLog).pipe(Effect.forkScoped);

  // Workspace changes go to every connection; an archived workspace's browser tab closes.
  yield* PubSub.subscribe(store.workspaceChanges).pipe(
    Effect.flatMap((sub) =>
      Effect.forever(
        PubSub.take(sub).pipe(
          Effect.tap((changed) =>
            Effect.sync(() => {
              sessionOfWorkspace.set(changed.id, changed.session_id);
              lineages.set(changed.id, changed);
            }),
          ),
          // Settings > Caveman MCP counts each agent's chats, and which of them work: again when one's status moves.
          Effect.tap((changed) => {
            if (changed.started_by === undefined || agentChatStatus.get(changed.id) === changed.status) return Effect.void;
            agentChatStatus.set(changed.id, changed.status);
            return agentsChanged;
          }),
          // With its journal's epoch and head and how far Cloud's copy stands (CONTRACT §1), as workspace.list has them.
          Effect.flatMap((changed) => store.getWorkspace(changed.id).pipe(Effect.flatMap((record) => (record ? store.withJournal({ ...record, workspace: changed }) : Effect.succeed(changed))))),
          Effect.flatMap((workspace) => {
            for (const connection of connections) notifyLatest(connection, `workspace:${workspace.id}`, "workspace.changed", workspace);
            return workspace.status === "archived"
              ? recordByWorkspace(workspace.id).pipe(Effect.flatMap(browser.closeWorkspace), Effect.ignore)
              : Effect.void;
          }),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  // The Chiefs' board, whole, after any change, and every Chief after one is made, edited or removed: to the owner's
  // connections only, as chief.* answers only them (the board holds their notes verbatim; a Chief's soul is theirs).
  const chiefOwners = () => [...connections].filter((connection) => secretsAllowed(connection.principal));
  yield* PubSub.subscribe(chief.board.changes).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((board) => {
      for (const connection of chiefOwners()) notifyLatest(connection, "chief.board", "chief.board.updated", board);
    })))),
    Effect.forkIn(scope),
  );
  yield* PubSub.subscribe(chief.view.changes).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((view) => {
      for (const connection of chiefOwners()) notifyLatest(connection, `chief.view:${view.chief_id}`, "chief.view.updated", view);
    })))),
    Effect.forkIn(scope),
  );
  yield* PubSub.subscribe(chief.listChanges).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((chiefs) => {
      for (const connection of chiefOwners()) notifyLatest(connection, "chief.list", "chief.list.updated", { chiefs: [...chiefs] });
    })))),
    Effect.forkIn(scope),
  );

  // Calls (chief/voice/Call.ts): what changed about a call, and rings, to the owner's connections only (a call is
  // theirs, as the Chief is); what the voice engine should hear next, only to the connection holding the call.
  yield* PubSub.subscribe(voice.out).pipe(
    Effect.flatMap((sub) =>
      Effect.forever(
        PubSub.take(sub).pipe(
          Effect.map((message) => {
            if (message.kind === "send") {
              for (const connection of connections) if (connection.id === message.connectionId) notify(connection, "chief.voice.send", { call_id: message.call_id, messages: message.messages });
              return;
            }
            const owners = [...connections].filter((connection) => secretsAllowed(connection.principal));
            if (message.kind === "updated") for (const connection of owners) notifyLatest(connection, `voice:${message.call.id}`, "chief.voice.updated", message.call);
            else for (const connection of owners) notify(connection, "chief.voice.ringing", { item_id: message.item_id, title: message.title, state: message.state, line: message.line, ...(message.chief_id === undefined ? {} : { chief_id: message.chief_id }), ...(message.muted ? { muted: true } : {}) });
          }),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  // engine.changed: engine.list's answer, to every connection when a provider change (a probe ending, a sign-in) or
  // a change to an engine's accounts (engineAccounts.ts: a plan connected or used up, a sign-in opening or ending)
  // changes it, so a client never waits on its next poll to see an engine come up.
  const providers = yield* Effect.serviceOption(ProviderRegistry);
  // (Test hosts may run without a registry, or stand one in without a change stream.)
  const providerChanges = (Option.isSome(providers) ? providers.value.streamChanges : undefined) ?? Stream.empty;
  let lastEngines: string | undefined;
  const compare = handlers["engine.list"]({}, { connectionId: "" }).pipe(
    Effect.map((answer) => {
      const json = JSON.stringify(answer);
      if (lastEngines !== undefined && json !== lastEngines) for (const connection of connections) notifyLatest(connection, "engines", "engine.changed", answer);
      lastEngines = json;
    }),
    Effect.ignore,
  );
  yield* compare.pipe(
    Effect.andThen(Stream.merge(providerChanges, Stream.fromPubSub(accountChanges)).pipe(Stream.debounce("100 millis"), Stream.runForEach(() => compare))),
    Effect.forkIn(scope),
  );

  // A project's Cloud setup, to every connection while its build runs (environments.ts polls Cloud).
  yield* PubSub.subscribe(environmentChanges).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((change) => {
      for (const connection of connections) notifyLatest(connection, `environment:${change.project_id}`, "environment.updated", change);
    })))),
    Effect.forkIn(scope),
  );

  // A setup change an agent proposed (propose_setup_change), to every connection: the chat and Settings show it.
  yield* PubSub.subscribe(environmentProposals).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((change) => {
      for (const connection of connections) notify(connection, "environment.proposed", change);
    })))),
    Effect.forkIn(scope),
  );

  // A setup chat changed (a proposal replaced, review, published, stopped): clients never review a stale one.
  yield* PubSub.subscribe(environmentSetupChats).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((change) => {
      for (const connection of connections) notifyLatest(connection, `setup-chat:${change.project_id}`, "environment.setup_chat", change);
    })))),
    Effect.forkIn(scope),
  );

  // session.moved: a chat this runtime let go of, to every connection, so clients follow it.
  yield* PubSub.subscribe(moves.moved).pipe(
    Effect.flatMap((sub) => Effect.forever(PubSub.take(sub).pipe(Effect.map((move) => {
      for (const connection of connections) notify(connection, "session.moved", move);
    })))),
    Effect.forkIn(scope),
  );

  // automation.changed: a project's automation files changed anywhere the watch looks (its checkout, its other
  // worktrees, origin's default branch), so the Automations page reads its list again without a reload.
  const automationFiles = yield* Effect.serviceOption(AutomationFiles);
  if (Option.isSome(automationFiles)) {
    yield* automationFiles.value.changes.pipe(
      Stream.runForEach(({ projectId }) =>
        Effect.sync(() => {
          for (const connection of connections) notifyLatest(connection, `automation:${projectId}`, "automation.changed", { project_id: projectId });
        }),
      ),
      Effect.forkIn(scope),
    );
  }

  // cloud.changed: cloud.status's answer, to every connection whenever it changes, each as cloud.status would answer it
  // (ownerGate.ts forOthers: a sign-in's code goes to the owner's connections only).
  // ponytail: compared once a second (the link's own supervisor ticks every 2 s); a change feed if that lag ever matters.
  let lastCloud: string | undefined;
  yield* handlers["cloud.status"]({}, { connectionId: "" }).pipe(
    Effect.map((status) => {
      const json = JSON.stringify(status);
      if (lastCloud !== undefined && json !== lastCloud)
        for (const connection of connections) notifyLatest(connection, "cloud", "cloud.changed", secretsAllowed(connection.principal) ? status : forOthers("cloud.status", status));
      lastCloud = json;
    }),
    Effect.ignore,
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
    Effect.forkIn(scope),
  );

  /** The scrubber terminal streams follow: refreshed on every secret change and terminal event. */
  let scrubber = yield* secrets.scrubber;
  // A repository's secret names (never values) go to every connection.
  yield* secrets.changes.pipe(
    Stream.runForEach((change) =>
      secrets.scrubber.pipe(
        Effect.map((next) => {
          scrubber = next;
          for (const connection of connections) {
            notifyLatest(connection, `secret:${change.repository}`, "secret.changed", { repository: change.repository, names: change.names });
          }
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  // Terminal output goes to the opener and every connection attached to the workspace's session; never an outside agent.
  const terminalTargets = (route: TerminalRoute) => {
    const targets = new Set([...route.openers].filter((connection) => connection.agent === undefined && !isAgentPrincipal(connection.principal)));
    for (const connection of connections) {
      if (connection.agent === undefined && !isAgentPrincipal(connection.principal) && connection.attachments.has(route.workspaceSessionId)) targets.add(connection);
    }
    return targets;
  };
  const sendOutput = (route: TerminalRoute, terminalId: string, data: string) => {
    if (data === "") return;
    for (const connection of terminalTargets(route)) connection.outbox.pushTerminalOutput(terminalId, data);
  };
  if (Option.isSome(terminals)) {
    yield* terminals.value.subscribe((event) =>
      secrets.scrubber.pipe(Effect.map((next) => {
        scrubber = next;
        const route = terminalRoutes.get(event.terminalId);
        if (route === undefined || route.threadId !== event.threadId) return;
        if (event.type === "output") {
          sendOutput(route, event.terminalId, route.scrub.push(event.data));
          clearTimeout(route.flushTimer);
          route.flushTimer = setTimeout(() => sendOutput(route, event.terminalId, route.scrub.idle()), TERMINAL_FLUSH_MS);
          return;
        }
        if (event.type === "error") {
          route.startError = event.message;
          return;
        }
        if (event.type === "exited") {
          clearTimeout(route.flushTimer);
          sendOutput(route, event.terminalId, route.scrub.end());
          // Kept even when no client is connected: term.list reports it to the next one.
          route.exitCode = event.exitCode;
          if (event.exitSignal) route.exitSignal = event.exitSignal;
          route.exitedAt = new Date().toISOString();
        }
        for (const connection of terminalTargets(route)) {
          if (event.type === "exited") {
            connection.outbox.pushTerminalFrame(
              event.terminalId,
              JSON.stringify({
                jsonrpc: "2.0",
                method: "term.exit",
                params: { terminal_id: event.terminalId, exit_code: event.exitCode, ...(event.exitSignal ? { signal: String(event.exitSignal) } : {}) },
              }),
            );
          }
        }
      })),
    );
  }

  const terminalFor = (terminalId: string) =>
    Effect.gen(function* () {
      const route = terminalRoutes.get(terminalId);
      if (route === undefined || Option.isNone(terminals)) return yield* Effect.fail(new ProtocolError({ reason: "not_found", message: `no terminal ${terminalId}` }));
      return { route, manager: terminals.value };
    });
  const terminalError = (error: { readonly message: string }) => new ProtocolError({ reason: "invalid_state", message: error.message });

 /** Live command output (upstream CommandOutputHub): what a running command printed, to the rows that show it. */
  const commandOutput = yield* Effect.serviceOption(CommandOutputHub);
 /** Each chat's suggested next message (upstream prompt suggestions), held by the engines' session manager. */
  const providerSessions = yield* Effect.serviceOption(ProviderSessionManagerV2);

  /** Methods that act on the connection itself. */
  const connectionHandlers: Partial<Record<MethodName, (params: never, connection: Connection, reply: (result: unknown) => void) => Effect.Effect<unknown, ProtocolError>>> = {
    /**
     * `caveman-code mcp`'s handshake on every socket it opens: this connection is that outside agent's from here on
     * (principal `agent:<agent_id>`), for good. Only an owner connection on this computer, once; the first become binds
     * the agent_id to its name; a name the person disconnected is refused.
     */
    "outside_agent.become": (params: { agent_id: string; name: string; at_most?: Level }, connection) =>
      Effect.gen(function* () {
        if (connection.principal !== "local" || connection.agent !== undefined) {
          return yield* refuse("forbidden", "outside_agent.become is the first call of a connection on this computer, and only once.");
        }
        const chiefs = yield* chief.list.pipe(Effect.orElseSucceed(() => []));
        const name = sanitizeName(params.name, chiefs.map((c) => c.name));
        if (name === undefined) return yield* refuse("invalid_params", "name is empty once its control and direction characters are taken out");
        const bound = registry.nameOf(params.agent_id);
        if (bound !== undefined && bound !== name) return yield* refuse("forbidden", `agent_id ${params.agent_id} connected as ${bound}: an agent_id keeps the name it first connected with.`);
        if (registry.get(name)?.blocked) return yield* refuse("forbidden", disconnected(name));
        const entry = yield* registry.seen(params.agent_id, name, new Date().toISOString());
        connection.principal = `${AGENT_PRINCIPAL}${params.agent_id}`;
        connection.agent = { id: params.agent_id, name, ...(params.at_most ? { atMost: params.at_most } : {}) };
        yield* agentsChanged;
        return { name, level: lowerLevel(entry.level, params.at_most) };
      }),
    "outside_agent.list": (_params: Record<string, never>, connection) =>
      connection.principal === "local" ? agentList : refuse("forbidden", "Outside agents are listed only on this computer's own screen."),
    "outside_agent.update": (params: { name: string; level?: Level; blocked?: boolean }, connection) =>
      Effect.gen(function* () {
        if (connection.principal !== "local") return yield* refuse("forbidden", "Outside agents are changed only on this computer's own screen.");
        const entry = yield* registry.update(params.name, { level: params.level, blocked: params.blocked });
        if (entry === undefined) return yield* refuse("not_found", `no outside agent named ${params.name}`);
        // Disconnect: its connections close now; become is refused until the person allows it again.
        if (entry.blocked) for (const other of connections) if (other.agent?.name === entry.name) other.kick();
        yield* agentsChanged;
        return listed(entry, connectedAs(entry.name), (yield* store.listWorkspaces()).map((r) => r.workspace));
      }),
    /** Settings > Caveman MCP's Install: adds `caveman-code mcp` to one client's config (mcpClients.ts). Owner only. */
    "outside_agent.install": (params: { client: McpClientId }, connection) => installFor(connection.principal, params.client, connectCommand()).pipe(Effect.tap(() => agentsChanged)),
    "session.attach": (params: { session_id: string; cursor: number; batch?: boolean; epoch?: number }, connection, reply) =>
      Effect.gen(function* () {
        // Never waits for a starting workspace: its first events show while its worktree is made. A chat Cloud has just
        // placed here waits for its adopt (CHAOS-15); any other unknown chat is refused at once.
        if ((yield* store.getBySession(params.session_id)) === undefined) yield* recordBySession(params.session_id);
        const previous = connection.attachments.get(params.session_id);
        if (previous) yield* Fiber.interrupt(previous);
        const ready = yield* Deferred.make<unknown>();
        const replied = yield* Deferred.make<void>();
        let self: Fiber.Fiber<void> | undefined;
        const fiber = yield* Effect.gen(function* () {
          // Subscribed and read between commits: every event after this head comes through `sub`, under this epoch or a
          // later one (whose reset the epoch check sees first).
          const { sub, resetSub, record, epoch } = yield* store.betweenCommits(
            Effect.gen(function* () {
              const sub = yield* PubSub.subscribe(store.events);
              const resetSub = yield* PubSub.subscribe(store.resets);
              return { sub, resetSub, record: (yield* store.getBySession(params.session_id))!, epoch: store.epochOf(params.session_id) };
            }),
          );
          // The client's events are another journal's (a new epoch), or more than this one holds (a lost tail): it drops
          // them, and the backlog replays from the start.
          const reset = (params.epoch !== undefined && params.epoch !== epoch) || params.cursor > record.session.head;
          yield* Deferred.succeed(ready, { session: record.session, epoch, reset });
          yield* Deferred.await(replied);
          let last = reset ? 0 : params.cursor;
          /** The journal was rewritten since this attachment read it: nothing more of the old one goes out. */
          const rewritten = () => store.epochOf(params.session_id) !== epoch;
          const deliver = (event: SessionEvent) => {
            if (event.cursor !== last + 1) return;
            last = event.cursor;
            notify(connection, "session.event", event);
          };
          const follow = Effect.gen(function* () {
            if (params.batch === true) {
              // The backlog as session.events frames of stored JSON, a page of the journal at a time.
              const head = `{"jsonrpc":"2.0","method":"session.events","params":{"session_id":${JSON.stringify(params.session_id)},"events":[`;
              /** The cursor the backlog reads to: the head it attached at, moved on after each wait for the client. */
              let end = record.session.head;
              while (last < end) {
                // The reply and each page's frames go out before the next page is read; a slow client paces the reads.
                yield* Effect.yieldNow;
                if (connection.outbox.stats().bytes > BACKLOG_PAUSE_BYTES) {
                  // `sub` is taken from while the client keeps the backlog waiting: left alone it would keep every event
                  // the runtime commits meanwhile, of every chat. This chat's are in the journal (committed before they
                  // were published), so the backlog then reads on to its head.
                  yield* connection.outbox.awaitBelow(BACKLOG_PAUSE_BYTES).pipe(Effect.raceFirst(Effect.forever(PubSub.take(sub))));
                  end = Math.max(end, (yield* store.getBySession(params.session_id))?.session.head ?? end);
                }
                const page = yield* store.readEventJson(params.session_id, last, end, BACKLOG_PAGE_EVENTS);
                if (rewritten()) return;
                if (page.length === 0) break;
                let frame: string[] = [];
                let bytes = 0;
                for (const { cursor, json } of page) {
                  if (cursor !== last + 1) break;
                  last = cursor;
                  if (frame.length > 0 && bytes + json.length > BACKLOG_FRAME_BYTES) {
                    sendText(connection, `${head}${frame.join(",")}]}}`);
                    frame = [];
                    bytes = 0;
                  }
                  frame.push(json);
                  bytes += json.length;
                }
                if (frame.length > 0) sendText(connection, `${head}${frame.join(",")}]}}`);
                if (last !== page[page.length - 1]!.cursor) break;
              }
            } else {
              const backlog = yield* store.readEvents(params.session_id, last, record.session.head);
              if (rewritten()) return;
              for (const event of backlog) deliver(event);
            }
            while (true) {
              const event = yield* PubSub.take(sub);
              if (rewritten()) return;
              if (event.session_id !== params.session_id || event.cursor <= last) continue;
              // A commit this subscription raced past is read back from the journal.
              if (event.cursor > last + 1) {
                const missed = yield* store.readEvents(params.session_id, last, event.cursor - 1);
                if (rewritten()) return;
                for (const one of missed) deliver(one);
              }
              deliver(event);
            }
          });
          // A rewrite with no event after it still ends the attachment.
          const watch = Effect.gen(function* () {
            while ((yield* PubSub.take(resetSub)).session_id !== params.session_id) continue;
          });
          yield* Effect.raceFirst(follow, watch);
          notify(connection, "session.ended", {
            session_id: params.session_id,
            error: { code: ErrorCodes.journal_reset, message: `session ${params.session_id}: its journal was rewritten (epoch ${store.epochOf(params.session_id)}); attach again`, data: { reason: "journal_reset" } },
          });
          if (connection.attachments.get(params.session_id) === self) connection.attachments.delete(params.session_id);
        }).pipe(
          Effect.scoped,
          // Ended before it was ready (its connection closed, a defect): the answer ends with it, so this call and the
          // chat's attach lane behind it never wait on an attachment that is gone.
          Effect.onError((cause) => Deferred.failCause(ready, cause)),
          Effect.forkIn(scope),
        );
        self = fiber;
        // Its connection closed while this attach read the store: the close ended the attachments it found, and nothing
        // would ever end this one. Checked in the same turn as the set below, so a close comes wholly before or after.
        if (connection.closed) {
          yield* Fiber.interrupt(fiber);
          return yield* refuse("invalid_state", "the connection closed");
        }
        connection.attachments.set(params.session_id, fiber);
        const result = yield* Deferred.await(ready);
        reply(result);
        yield* Deferred.succeed(replied, undefined);
        return result;
      }),
    "session.detach": (params: { session_id: string }, connection) =>
      Effect.gen(function* () {
        const fiber = connection.attachments.get(params.session_id);
        connection.attachments.delete(params.session_id);
        if (fiber) yield* Fiber.interrupt(fiber);
        return {};
      }),
    "term.open": (params: { workspace_id: string; cols: number; rows: number; command?: string; cwd?: string }, connection) =>
      Effect.gen(function* () {
        if (Option.isNone(terminals)) return yield* Effect.fail(new ProtocolError({ reason: "unsupported", message: "this runtime has no terminals", capability: "terminal" }));
        const record = yield* recordByWorkspace(params.workspace_id).pipe(Effect.flatMap(live));
        const worktree = yield* worktreeOf(record);
        const cwd = containedPath(worktree, params.cwd ?? ".");
        if (cwd === undefined) return yield* Effect.fail(new ProtocolError({ reason: "invalid_params", message: "cwd is outside the workspace" }));
        let computer = null;
        try {
          computer = readComputerConfig(worktree);
        } catch {
          // The session already carries the config error as a notification.
        }
        const terminalId = `term-${randomUUID().slice(0, 12)}`;
        const cols = Math.max(1, Math.min(1000, params.cols));
        const rows = Math.max(1, Math.min(500, params.rows));
        const route: TerminalRoute = {
          threadId: record.internal.threadId,
          workspaceId: record.workspace.id,
          workspaceSessionId: record.session.id,
          openers: new Set([connection]),
          ...(params.command ? { command: params.command } : {}),
          cwd: params.cwd ?? ".",
          createdAt: new Date().toISOString(),
          cols,
          rows,
          scrub: followingStream(() => scrubber),
        };
        terminalRoutes.set(terminalId, route);
        const threadId = ThreadId.make(record.internal.threadId);
        const opened = yield* terminals.value
          .open({
            threadId,
            terminalId,
            cwd,
            worktreePath: worktree,
            cols,
            rows,
            // The repository's secrets after [env] and what is the workspace's own; an action (the Run button's too) is a term.open with its command.
            env: {
              ...(yield* childEnv(store, record, { computer })),
              ...(secretsAllowed(connection.principal) ? yield* repoEnv(secrets, record.workspace.repo) : {}),
            },
            // The shell runs the command and ends with it: term.exit's code is the command's.
            ...(params.command ? { command: params.command } : {}),
          })
          .pipe(
            Effect.mapError(terminalError),
            Effect.onError(() => Effect.sync(() => terminalRoutes.delete(terminalId))),
          );
 // A shell that could not start (no PTY left, nothing node-pty can spawn) is no failure of upstream open: its session
        // ends in "error" at once. Nothing will ever run there, so the call fails with why and leaves no terminal behind.
        if (opened.status === "error") {
          terminalRoutes.delete(terminalId);
          yield* terminals.value.close({ threadId, terminalId, deleteHistory: true }).pipe(Effect.ignore);
          return yield* Effect.fail(terminalError({ message: route.startError ?? "the terminal's shell did not start" }));
        }
        return { terminal_id: terminalId };
      }),
    "term.write": (params: { terminal_id: string; data: string }) =>
      terminalFor(params.terminal_id).pipe(
        Effect.flatMap(({ route, manager }) => manager.write({ threadId: route.threadId, terminalId: params.terminal_id, data: params.data }).pipe(Effect.mapError(terminalError))),
        Effect.as({}),
      ),
    "term.resize": (params: { terminal_id: string; cols: number; rows: number }) =>
      terminalFor(params.terminal_id).pipe(
        Effect.flatMap(({ route, manager }) =>
          manager.resize({ threadId: route.threadId, terminalId: params.terminal_id, cols: params.cols, rows: params.rows }).pipe(
            Effect.mapError(terminalError),
            Effect.tap(() =>
              Effect.sync(() => {
                route.cols = params.cols;
                route.rows = params.rows;
              }),
            ),
          ),
        ),
        Effect.as({}),
      ),
    "term.list": (params: { workspace_id: string }) =>
      recordByWorkspace(params.workspace_id).pipe(
        Effect.map((record) => ({
          terminals: [...terminalRoutes]
            .filter(([, route]) => route.workspaceId === record.workspace.id)
            .map(([terminalId, route]) => ({
              terminal_id: terminalId,
              title: route.command ?? "Terminal",
              ...(route.command ? { command: route.command } : {}),
              cwd: route.cwd,
              created_at: route.createdAt,
              exited: route.exitCode !== undefined,
              ...(route.exitCode !== undefined ? { exit_code: route.exitCode } : {}),
              ...(route.exitSignal !== undefined ? { signal: String(route.exitSignal) } : {}),
              ...(route.exitedAt !== undefined ? { exited_at: route.exitedAt } : {}),
            })),
        })),
      ),
    "term.attach": (params: { terminal_id: string }, connection) =>
      Effect.gen(function* () {
        const { route, manager } = yield* terminalFor(params.terminal_id);
        // Observe once for the scrollback without touching the process; output then flows to this connection.
        const snapshot = yield* Deferred.make<string>();
        const stop = yield* manager
          .observeStream({ threadId: route.threadId, terminalId: params.terminal_id }, (event) =>
            event.type === "snapshot" ? Deferred.succeed(snapshot, event.snapshot.history).pipe(Effect.asVoid) : Effect.void,
          )
          .pipe(Effect.mapError(terminalError));
        const history = yield* Deferred.await(snapshot).pipe(Effect.ensuring(Effect.sync(stop)));
        // As the live scrub has sent it: a tail that could begin a value is the live scrub's to send, masked or not.
        const current = yield* secrets.scrubber;
        const scrub = followingStream(() => current);
        const scrollback = scrub.push(history) + scrub.idle();
        // Its connection closed while this read the scrollback: the close took it off the terminals it was on, and
        // nothing would take it off this one. Checked in the same turn as the add, so a close comes wholly before or after.
        if (connection.closed) return yield* refuse("invalid_state", "the connection closed");
        route.openers.add(connection);
        // A connection that was sent term.resync gets this terminal's output again from here.
        connection.outbox.resumeTerminal(params.terminal_id);
        return { scrollback, cols: route.cols, rows: route.rows, exited: route.exitCode !== undefined };
      }),
    "tool.watch": (params: { workspace_id: string; item_id: string }, connection) =>
      Effect.gen(function* () {
        if (Option.isNone(commandOutput)) return yield* Effect.fail(new ProtocolError({ reason: "unsupported", message: "this runtime streams no command output" }));
        const record = yield* recordByWorkspace(params.workspace_id);
        const key = `${params.workspace_id}\0${params.item_id}`;
        if (connection.watches.has(key)) return {};
        let current = yield* secrets.scrubber;
        const scrub = makeCommandOutputScrub(() => current);
        const started = yield* Deferred.make<void, ProtocolError>();
        const live = { workspace_id: params.workspace_id, item_id: params.item_id };
        // A tail the scrub holds back (it could begin a value) goes out once output pauses, as a terminal's does:
        // a command that prints a line and then works quietly shows that line now, not at its next one.
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        const fiber = yield* commandOutput.value.subscribe({ threadId: ThreadId.make(record.internal.threadId), itemId: TurnItemId.make(params.item_id) }).pipe(
          Stream.runForEach((frame) =>
            Effect.gen(function* () {
              current = yield* secrets.scrubber;
              clearTimeout(flushTimer);
              const scrubbed = scrub(frame);
              Deferred.doneUnsafe(started, Exit.void);
              notify(connection, "tool.live", { ...live, ...scrubbed });
              if (frame.running) {
                flushTimer = setTimeout(() => {
                  const held = scrub.idle();
                  if (held !== "") notify(connection, "tool.live", { ...live, kind: "append", text: held, truncated: frame.truncated, running: true });
                }, TERMINAL_FLUSH_MS);
              }
              // Read the next frame only once the client has taken most of this: a slow one gets the tail instead.
              yield* connection.outbox.awaitBelow(TOOL_LIVE_PAUSE_BYTES);
            }),
          ),
          Effect.catch((error) => Effect.sync(() => void Deferred.doneUnsafe(started, Exit.fail(new ProtocolError({ reason: "not_found", message: error.message }))))),
          Effect.ensuring(Effect.sync(() => {
            clearTimeout(flushTimer);
            if (connection.watches.get(key) === fiber) connection.watches.delete(key);
            Deferred.doneUnsafe(started, Exit.void);
          })),
          Effect.forkIn(scope),
        );
        // Its connection closed while this read the store: the close ended the watches it found, and nothing would end
        // this one. Checked in the same turn as the set below, so a close comes wholly before or after.
        if (connection.closed) {
          yield* Fiber.interrupt(fiber);
          return yield* refuse("invalid_state", "the connection closed");
        }
        connection.watches.set(key, fiber);
        // Answer once the first frame is queued, or with the reason there is none.
        yield* Deferred.await(started);
        return {};
      }),
    "tool.unwatch": (params: { workspace_id: string; item_id: string }, connection) =>
      Effect.gen(function* () {
        const key = `${params.workspace_id}\0${params.item_id}`;
        const fiber = connection.watches.get(key);
        connection.watches.delete(key);
        if (fiber) yield* Fiber.interrupt(fiber);
        return {};
      }),
    "suggestion.watch": (params: { workspace_id: string }, connection) =>
      Effect.gen(function* () {
        if (Option.isNone(providerSessions)) return yield* Effect.fail(new ProtocolError({ reason: "unsupported", message: "this runtime makes no suggestions" }));
        const record = yield* recordByWorkspace(params.workspace_id);
        const key = `suggestion\0${params.workspace_id}`;
        if (connection.watches.has(key)) return {};
        const fiber = yield* providerSessions.value.subscribePromptSuggestion(ThreadId.make(record.internal.threadId)).pipe(
          Stream.runForEach((suggestion) =>
            Effect.gen(function* () {
              // An engine's words, so its secrets are masked as in its transcript.
              const text = suggestion === null ? null : (yield* secrets.scrubber).scrub(suggestion.text);
              notify(connection, "suggestion.live", { workspace_id: params.workspace_id, run_id: suggestion?.runId ?? null, text });
            }),
          ),
          Effect.ensuring(Effect.sync(() => {
            if (connection.watches.get(key) === fiber) connection.watches.delete(key);
          })),
          Effect.forkIn(scope),
        );
        connection.watches.set(key, fiber);
        return {};
      }),
    "suggestion.unwatch": (params: { workspace_id: string }, connection) =>
      Effect.gen(function* () {
        const key = `suggestion\0${params.workspace_id}`;
        const fiber = connection.watches.get(key);
        connection.watches.delete(key);
        if (fiber) yield* Fiber.interrupt(fiber);
        return {};
      }),
    "term.detach": (params: { terminal_id: string }, connection) =>
      terminalFor(params.terminal_id).pipe(
        Effect.tap(({ route }) => Effect.sync(() => route.openers.delete(connection))),
        Effect.as({}),
      ),
    ...(browser.handlers as unknown as Record<string, (params: never, connection: Connection) => Effect.Effect<unknown, ProtocolError>>),
    ...(computer.handlers as unknown as Record<string, (params: never, connection: Connection) => Effect.Effect<unknown, ProtocolError>>),
    ...(devices.handlers as unknown as Record<string, (params: never, connection: Connection) => Effect.Effect<unknown, ProtocolError>>),
    "term.close": (params: { terminal_id: string }) =>
      terminalFor(params.terminal_id).pipe(
        // Its route goes with it, so nothing can attach to the log again: drop that too (each re-run of an action closes the last).
        Effect.flatMap(({ route, manager }) => manager.close({ threadId: route.threadId, terminalId: params.terminal_id, deleteHistory: true }).pipe(Effect.mapError(terminalError))),
        Effect.tap(() => Effect.sync(() => terminalRoutes.delete(params.terminal_id))),
        Effect.as({}),
      ),
  };

  const errorFrame = (id: unknown, reason: ErrorReason, message: string, extra: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: ErrorCodes[reason], message, data: { reason, ...extra } },
  });

  /**
   * Runs a mutating call once per (principal, method, request_id); retries get the first result. The call runs in the
   * server's scope, not its connection's: one whose asker left still finishes and keeps its receipt, and a retry on
   * another connection joins it while it runs. Only a success is kept: a retry after a failure runs it again.
   */
  const once = (principal: string, method: MethodName, params: Record<string, unknown>, run: Effect.Effect<unknown, ProtocolError>): Effect.Effect<unknown, ProtocolError> =>
    Effect.gen(function* () {
      const requestId = String(params.request_id);
      const key = `${principal}\0${method}\0${requestId}`;
      // credential.grant carries the secret in `value`, engine.account.add in `key`, cloud.enroll in `token`;
      // never derive the persisted receipt hash from it (it would be a credential-derived
      // value stored for a day, and a reused request_id with a different value would be
      // a guessing oracle). secret.set likewise: only its names feed the hash, and environment.build_secret.set's
      // value only as an HMAC under this runtime's receipt key, as is secret_provider.save's service account token.
      const { value: _secret, ...withoutValue } = params;
      const { key: _key, ...withoutKey } = params;
      const { token: _token, ...withoutToken } = params;
      const hashed =
        method === "credential.grant"
          ? withoutValue
          : method === "engine.account.add"
            ? withoutKey
            : method === "cloud.enroll"
              ? withoutToken
              : method === "secret_provider.save" && typeof params.service_account_token === "string"
                ? { ...params, service_account_token: createHmac("sha256", receiptKey).update(params.service_account_token).digest("hex") }
              : method === "environment.build_secret.set"
                ? { ...params, value: createHmac("sha256", receiptKey).update(String(params.value)).digest("hex") }
                : method === "secret.set"
                ? {
                    ...params,
                    secrets: (params.secrets as ReadonlyArray<{ readonly name: string; readonly value: string }>).map((s) => [
                      s.name,
                      createHmac("sha256", receiptKey).update(s.value).digest("hex"),
                    ]),
                  }
                : params;
      const hash = createHash("sha256").update(canonical(hashed)).digest("hex");
      const running = inflight.get(key);
      if (running) {
        const joined = yield* Effect.exit(Deferred.await(running.deferred));
        // Its runner was stopped (the runtime is shutting down): this asker runs it instead. Other params are no retry of
        // that run: once it ends this call starts over, so its receipt refuses it, and its failure leaves the request_id free.
        if (running.hash === hash && !(Exit.isFailure(joined) && Cause.hasInterruptsOnly(joined.cause))) return yield* joined;
        if (inflight.get(key) === running) inflight.delete(key);
        return yield* once(principal, method, params, run);
      }
      // Claimed in the turn that found nothing in flight, before the receipt is read: a retry either joins this run or,
      // once it left `inflight`, reads its receipt. Read first, a retry could miss both and run the call again.
      const deferred = Deferred.makeUnsafe<unknown, ProtocolError>();
      const claim = { hash, deferred };
      inflight.set(key, claim);
      yield* store.getReceipt(principal, method, requestId).pipe(
        Effect.flatMap((existing) =>
          existing === undefined
            ? run.pipe(
                Effect.tap((value) => store.putReceipt(principal, method, requestId, { paramsHash: hash, result: value }, KEYSTROKE_METHODS.has(method) ? KEYSTROKE_MS : DAY_MS)),
                // A person's call through Cloud (relayed or queued): the chat's copy carries its receipt, so a computer the chat
                // moves to answers the same call again without running it.
                Effect.tap((value) =>
                  principal.startsWith("cloud:") && CARRIED_METHODS.has(method) && typeof params.session_id === "string"
                    ? carryReceipt(params.session_id, { principal, method, request_id: requestId, params_hash: hash, result: value ?? null, expires_at: Date.now() + DAY_MS })
                    : Effect.void,
                ),
              )
            : existing.paramsHash === hash
              ? Effect.succeed(existing.result)
              : Effect.fail(new ProtocolError({ reason: "request_id_conflict", message: "request_id was used with different params" })),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (inflight.get(key) === claim) inflight.delete(key);
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(deferred);
    });

  /** Keeps a person's call receipt with its chat (newest last, at most CARRIED_RECEIPTS, none expired). */
  const carryReceipt = (sessionId: string, receipt: CarriedReceipt) =>
    Effect.gen(function* () {
      const now = Date.now();
      const all = JSON.parse((yield* store.kvGet(carriedKey(sessionId))) ?? "[]") as Array<CarriedReceipt>;
      const kept = all.filter((r) => !signedReceipt(r.method) && r.expires_at > now && !(r.principal === receipt.principal && r.method === receipt.method && r.request_id === receipt.request_id));
      // The devices' signed moves and stops the chat carries stay beside them, never pushed out by calls (m-11).
      yield* store.kvSet(carriedKey(sessionId), JSON.stringify([...[...kept, receipt].slice(-CARRIED_RECEIPTS), ...carriedSigned(all, now)]));
    });

  /** What the outside agents' gate reads of the runtime. */
  const gateDeps: GateDeps = {
    workspace: (id) => store.getWorkspace(id),
    session: (id) => store.getBySession(id),
    workspaces: Effect.suspend(() => store.listWorkspaces()),
    ...outsideAgentFacts,
  };

  /**
   * A method's handler for `connection`, decoded params in. An outside agent's call passes the gate first
   * (outsideAgents.ts), at the level the person gives its name now, lowered by its `--at-most`; its answer goes back
   * through the gate's filter. Here, so connection handlers and runCall are behind it too.
   */
  const handlerFor = (name: MethodName, params: Record<string, unknown>, connection: Connection, reply: (result: unknown) => void): Effect.Effect<unknown, ProtocolError> => {
    const special = connectionHandlers[name];
    const run = (p: Record<string, unknown>) =>
      special
        ? special(p as never, connection, reply)
        : (handlers[name] as (p: unknown, ctx: { connectionId: string; principal: string; agent?: { id: string; name: string }; forwardedBy?: string; placedSession?: string }) => Effect.Effect<unknown, ProtocolError>)(p, {
            connectionId: connection.id,
            principal: connection.principal,
            ...(connection.agent ? { agent: { id: connection.agent.id, name: connection.agent.name } } : {}),
            ...(connection.forwardedBy !== undefined ? { forwardedBy: connection.forwardedBy } : {}),
            ...(connection.placedSession !== undefined ? { placedSession: connection.placedSession } : {}),
          });
    const agent = connection.agent;
    if (agent === undefined) return isAgentPrincipal(connection.principal) ? refuse("forbidden", `Outside agents can't call ${name}.`) : run(params);
    return Effect.gen(function* () {
      const entry = registry.get(agent.name);
      if (entry === undefined || entry.blocked) return yield* refuse("forbidden", disconnected(agent.name));
      const gated = yield* gate({ name: agent.name, level: lowerLevel(entry.level, agent.atMost) }, name, params, gateDeps);
      const value = yield* run(gated.params);
      return gated.result ? yield* gated.result(value) : value;
    });
  };

  /**
   * A call Caveman Cloud queued for a chat whose runtime no device could reach (CONTRACT §3, queued calls): run as the
   * person (`cloud:<user_id>`) with the device's request id, so a call that also came over the relay runs once.
   * `via` is Cloud's own word on the call, from its mail and never its params: the runtime that handed it on, or for
   * a chat's start the session Cloud placed (the params, and so the receipt, are the relay call's exactly).
   */
  const runCall = (principal: string, method: MethodName, rawParams: unknown, via?: { readonly forwardedBy?: string; readonly placedSession?: string }): Effect.Effect<unknown, ProtocolError> =>
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownExit(Methods[method].params as Schema.Codec<unknown>)(rawParams ?? {});
      if (decoded._tag === "Failure") return yield* Effect.fail(new ProtocolError({ reason: "invalid_params", message: `params do not match ${method}` }));
      const params = decoded.value as Record<string, unknown>;
      const connection: Connection = {
        id: `cloud-call:${randomUUID()}`,
        principal,
        ...(via?.forwardedBy !== undefined ? { forwardedBy: via.forwardedBy } : {}),
        ...(via?.placedSession !== undefined ? { placedSession: via.placedSession } : {}),
        outbox: new Outbox(),
        closed: false,
        attachments: new Map(),
        watches: new Map(),
        lanes: new Map(),
        kick: () => undefined,
      };
      lastChangeAt = Date.now();
      const run = handlerFor(method, params, connection, () => undefined);
      return yield* isMutating(method) ? once(principal, method, params, run) : run;
    });

  const handleFrame = (connection: Connection, raw: string) =>
    Effect.gen(function* () {
      let message: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      try {
        message = JSON.parse(raw);
      } catch {
        return send(connection, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      if (message === null || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return send(connection, { jsonrpc: "2.0", id: (message as { id?: unknown })?.id ?? null, error: { code: -32600, message: "invalid request" } });
      }
      const { id, method } = message;
      if (id === undefined) return; // Clients send no notifications in v1.
      if (!Object.hasOwn(Methods, method)) {
        return send(connection, { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
      }
      const name = method as MethodName;
      const decoded = Schema.decodeUnknownExit(Methods[name].params as Schema.Codec<unknown>)(message.params ?? {});
      if (decoded._tag === "Failure") return send(connection, errorFrame(id, "invalid_params", `params do not match ${name}`));
      const params = decoded.value as Record<string, unknown>;
      let replied = false;
      const reply = (result: unknown) => {
        replied = true;
        send(connection, { jsonrpc: "2.0", id, result });
      };
      const run = handlerFor(name, params, connection, reply);
      if (isMutating(name) && !WATCHING(name, params)) lastChangeAt = Date.now();
      const exit = yield* Effect.exit(isMutating(name) && !CONNECTION_METHODS.has(name) ? once(connection.principal, name, params, run) : run);
      if (exit._tag === "Success") {
        if (!replied) {
          if (name === "media.read" || name === "attachment.read" || name === "browser.readFile" || name === "htmlRender.read") {
            // Large raster/HTML reads expand in JSON. Pace them under the
            // connection's finite budget, independently of chat events.
            const frame = JSON.stringify({ jsonrpc: "2.0", id, result: exit.value });
            if (frame.length > connection.outbox.limits.max) return send(connection, errorFrame(id, "internal", `${name === "media.read" || name === "attachment.read" ? "the image" : "the HTML document"} exceeds the bounded transport budget`));
            yield* connection.outbox.awaitBelow(connection.outbox.limits.max - frame.length);
            sendText(connection, frame);
          } else reply(exit.value);
        }
        return;
      }
      const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      if (failure instanceof ProtocolError) {
        const reason = (failure.reason in ErrorCodes ? failure.reason : "internal") as ErrorReason;
        return send(connection, errorFrame(id, reason, failure.message, {
          ...(failure.capability ? { capability: failure.capability } : {}),
          ...(failure.retryAfterMs !== undefined ? { retry_after_ms: failure.retryAfterMs } : {}),
          ...(failure.cloudCode ? { cloud_code: failure.cloudCode } : {}),
          ...(failure.pullRequests ? { pull_requests: failure.pullRequests } : {}),
        }));
      }
      yield* Effect.logError("session protocol call failed", { method: name, cause: exit.cause });
      return send(connection, errorFrame(id, "internal", "the runtime failed this call"));
    });

  /**
   * Serves one upgraded socket until it closes. `principal` keys request_id receipts: "local", or "cloud:<user>" through the relay.
   * With `backlog`, frames wait in the connection's outbox while the socket holds more than SOCKET_HIGH_WATER unsent, so a slow
   * client's queue stays bounded there (outbox.ts); without it they go straight to the socket.
   */
  const serve = (socket: Socket.Socket, principal = "local", backlog?: SocketBacklog) =>
    Effect.gen(function* () {
      const connection: Connection = {
        id: randomUUID(),
        principal,
        outbox: new Outbox(),
        closed: false,
        attachments: new Map(),
        watches: new Map(),
        lanes: new Map(),
        kick: () => undefined,
      };
      connections.add(connection);
      liveOutboxes.add(connection.outbox);
      yield* Effect.addFinalizer(() => Effect.sync(() => (liveOutboxes.delete(connection.outbox), connection.outbox.close())));
      const writer = yield* socket.writer;
      const tooFarBehind = yield* Deferred.make<void>();
      connection.outbox.onOverflow = () => void Deferred.doneUnsafe(tooFarBehind, Exit.void);
      yield* Effect.gen(function* () {
        while (true) {
          while (backlog !== undefined && backlog.bytes() > SOCKET_HIGH_WATER) yield* backlog.drained;
          yield* writer.write(yield* connection.outbox.take);
        }
      }).pipe(Effect.raceFirst(Deferred.await(tooFarBehind)), Effect.forkScoped);
      // An outside agent the person disconnected: its socket closes (its client reconnects, and is refused).
      const kicked = yield* Deferred.make<void>();
      connection.kick = () => void Deferred.doneUnsafe(kicked, Exit.void);
      yield* Deferred.await(kicked).pipe(Effect.andThen(writer.write(new Socket.CloseEvent(CLOSE_DISCONNECTED, "disconnected"))), Effect.ignore, Effect.forkScoped);
      // Too far behind: drop what waits and close. The client reconnects, re-attaches each session from its cursor and each terminal.
      yield* Deferred.await(tooFarBehind).pipe(
        Effect.andThen(Effect.sync(() => connection.outbox.close())),
        Effect.andThen(writer.write(new Socket.CloseEvent(CLOSE_TOO_FAR_BEHIND, "too far behind"))),
        Effect.ignore,
        Effect.forkScoped,
      );
      const reader = yield* socket.reader;
      const decoder = new TextDecoder();
      yield* Effect.forever(
        reader.pull.pipe(
          Effect.flatMap((chunks) =>
            Effect.forEach(chunks, (chunk) => {
              const raw = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              // Taken in arrival order: a chat's mutating calls run one after another (send, then stop, lands in that order),
              // and so do its attaches and detaches; reads and other chats' calls run alongside.
              const lane = laneOf(connection, raw);
              const handled = handleFrame(connection, raw);
              return (lane === undefined
                ? handled
                : Effect.gen(function* () {
                    if (lane.after !== undefined) yield* Deferred.await(lane.after);
                    if (lane.previous !== undefined) yield* Deferred.await(lane.previous);
                    yield* handled;
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        Deferred.doneUnsafe(lane.mine, Exit.void);
                        if (connection.lanes.get(lane.key) === lane.mine) connection.lanes.delete(lane.key);
                      }),
                    ),
                  )
              ).pipe(Effect.forkIn(scope));
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function* () {
            connections.delete(connection);
            connection.closed = true;
            for (const route of terminalRoutes.values()) route.openers.delete(connection);
            for (const fiber of connection.attachments.values()) yield* Fiber.interrupt(fiber);
            for (const fiber of connection.watches.values()) yield* Fiber.interrupt(fiber);
            yield* browser.closeConnection(connection);
            yield* computer.closeConnection(connection);
            // The client holding a call is gone: the call ends, so nothing stays billed.
            yield* voice.closeConnection(connection.id).pipe(Effect.ignore);
            // Settings > Caveman MCP shows it gone.
            if (connection.agent !== undefined) yield* agentsChanged;
          }),
        ),
      );
    }).pipe(Effect.scoped);

  /**
   * Mutations keep their chat's order. A chat's attaches and detaches keep theirs in a lane of their own: an attach
   * reads the store before it takes its place, so a detach or a second attach sent behind it would otherwise finish
   * first. A chat's side work (SIDE_LANES) starts after the chat's calls sent before it but holds only its own lane.
   * Large media/HTML reads share a separate lane, without blocking chat calls.
   */
  const laneOf = (connection: Connection, raw: string) => {
    let message: { method?: unknown; params?: unknown; id?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (message === null || typeof message !== "object" || typeof message.method !== "string" || message.id === undefined || !Object.hasOwn(Methods, message.method)) return undefined;
    const largeRead = message.method === "media.read" || message.method === "attachment.read" || message.method === "browser.readFile" || message.method === "htmlRender.read";
    const attachment = message.method === "session.attach" || message.method === "session.detach";
    if (!largeRead && !attachment && !isMutating(message.method as MethodName)) return undefined;
    const chat = largeRead ? undefined : laneKey(message.params, (id) => sessionOfWorkspace.get(id));
    const side = SIDE_LANES.get(message.method);
    const key = largeRead ? "media:read" : chat === undefined ? undefined : attachment ? `attach:${chat}` : side !== undefined ? `${side}:${chat}` : chat;
    if (key === undefined) return undefined;
    const previous = connection.lanes.get(key);
    const after = side !== undefined && chat !== undefined ? connection.lanes.get(chat) : undefined;
    const mine = Deferred.makeUnsafe<void>();
    connection.lanes.set(key, mine);
    return { key, previous, after, mine };
  };

  const authorize = (headers: Readonly<Record<string, string | undefined>>) => {
    const presented = bearerOf(headers);
    return presented !== undefined && tokens.some((token) => sameToken(presented, token));
  };

  /**
   * What keeps the computer up besides its turns (S7, cloudLink/index.ts): the last change a client made and whether a
   * person holds the desktop. An open connection alone does not.
   */
  const activity = () => ({ lastChangeAt, desktopHeld: desktop?.holder() !== undefined });

  return { serve, authorize, devices, runCall, activity, connectionCount: () => connections.size, chiefWatch: Effect.all([chief.watch, voice.watch], { concurrency: "unbounded", discard: true }), moves: moves.run, callPlace: moves.callPlace, archiveDone, settingsSync, bootSteps, headless };
}).pipe(Effect.provideServiceEffect(EngineAccountChanges, PubSub.unbounded<void>()));

