// The runtime's link to Caveman Cloud. On This Mac it runs while Remote
// control is on (Settings.remote_control, else on with sync) and the runtime
// is enrolled; on a Cloud computer (CAVEMAN_CLOUD_LINK_DIR set by the
// computers service) it always runs. Each client the relay attaches becomes a
// Session Protocol connection into this runtime's own server, as a local
// client's would; on This Mac only once the device behind it was allowed
// (session-protocol/devices.ts), and then also over a direct WebRTC channel
// the device may open (direct.ts).
import type { HeartbeatRepo } from "./heartbeatRepos.ts";
import * as fs from "node:fs";
import * as path from "node:path";

import { remoteControlOn, type CallDelivery } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { enginesSignedIn, onEnginesChanged } from "./engineSignins.ts";
import { takeIdentity } from "./bootstrap.ts";
import { loadIdentity, readIdentity, type Identity } from "./identity.ts";
import { makeDirectPeers } from "./direct.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { CloudLink, type LinkStatus } from "./link.ts";
import { fileNote, runCalls, type CallPlace, type RunCall, type Verdict } from "./calls.ts";
import type { OpenInfo, RelayStream, StreamSink } from "./relay.ts";

/**
 * This runtime's version as its heartbeat tells Cloud (CONTRACT §5.4): the app's that started it (the desktop's
 * CAVEMAN_APP_VERSION, or a Cloud computer's image setting it), else the runtime package's own.
 */
export const runtimeVersion = (env: NodeJS.ProcessEnv = process.env): string => env.CAVEMAN_APP_VERSION?.trim() || packageJson.version;

export interface CloudComputerInfo {
  /** Where the computers service mounted runtime.json and runtime.key. */
  readonly linkDir: string;
  /** "" on a warm pod until it is claimed (`claimed`). */
  readonly computerId: string;
  /** The snapshot checkout on the volume: the workspace root, not a new worktree. */
  readonly workspaceRoot: string;
  /** A warm pod's bootstrap file (CAVEMAN_RUNTIME_LINK_BOOTSTRAP): the runtime asks Cloud for its identity with it (bootstrap.ts). */
  readonly bootstrap?: string;
}

/**
 * Set on a Cloud computer. A mount without a readable identity stops the runtime rather than run as This Mac,
 * except on a warm pod (CAVEMAN_RUNTIME_LINK_WAIT=1, from the computer image's entrypoint): its runtime starts
 * before the pod is claimed, with nothing in the link dir yet, and waits there for its identity (`claimed`).
 */
export function cloudComputerFromEnv(env: NodeJS.ProcessEnv): CloudComputerInfo | undefined {
  const linkDir = env.CAVEMAN_CLOUD_LINK_DIR;
  if (!linkDir) return undefined;
  const workspaceRoot = env.CAVEMAN_WORKSPACE_ROOT || "/workspace";
  let identity: Identity;
  try {
    identity = loadIdentity(linkDir);
  } catch (error) {
    if (env.CAVEMAN_RUNTIME_LINK_WAIT === "1" && unwritten(error)) return warmComputer(linkDir, workspaceRoot, env.CAVEMAN_RUNTIME_LINK_BOOTSTRAP || undefined);
    throw new Error(`CAVEMAN_CLOUD_LINK_DIR=${linkDir} holds no usable runtime.json and runtime.key: ${(error as Error).message}`, { cause: error });
  }
  return { linkDir, computerId: identity.computerId, workspaceRoot };
}

/** The identity is not there yet, as opposed to there and unusable. */
const unwritten = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A warm pod's computer: its id is its identity's, once the claim wrote it. */
function warmComputer(linkDir: string, workspaceRoot: string, bootstrap: string | undefined): CloudComputerInfo {
  let computerId: string | undefined;
  return {
    linkDir,
    workspaceRoot,
    ...(bootstrap ? { bootstrap } : {}),
    get computerId() {
      return (computerId ??= readIdentity(linkDir)?.computerId) ?? "";
    },
  };
}

/** How often a warm pod looks for its identity (one stat while it is not there): part of a claimed pod's start. */
export const CLAIM_LOOK_MS = 100;

/**
 * Done once this runtime has its Cloud identity: at once on This Mac and on a computer started with it, and on a
 * warm pod when its claim writes it. Until then a warm pod's runtime touches no Cloud, git, workspace or secret:
 * what would (the link, sync, moves, the proxies, pull requests) starts after this.
 */
export const claimed = (computer: CloudComputerInfo | undefined): Effect.Effect<void> => {
  if (computer === undefined) return Effect.void;
  let said = "";
  const look = Effect.suspend(() => {
    let why = "";
    try {
      loadIdentity(computer.linkDir);
      return Effect.succeed(true);
    } catch (error) {
      why = unwritten(error) ? "" : (error as Error).message;
    }
    // Written but unusable: said once. The computers service restarts a pod whose runtime it never hears from.
    const say = why !== "" && why !== said ? Effect.logError(`The Cloud identity in ${computer.linkDir} is unusable: ${why}`) : Effect.void;
    said = why;
    return Effect.as(say, false);
  });
  const wait = Effect.repeat(look, { until: (ok) => ok, schedule: Schedule.spaced(CLAIM_LOOK_MS) }).pipe(Effect.asVoid);
  const bootFile = computer.bootstrap;
  if (bootFile === undefined) return wait;
  // With a bootstrap file the runtime takes its identity itself, from Cloud's bootstrap route or kubelet's copy.
  return Effect.gen(function* () {
    const log = Effect.runForkWith(yield* Effect.context<never>());
    const take = Effect.tryPromise({
      try: (signal) => takeIdentity({ bootFile, linkDir: computer.linkDir, signal, log: (line) => void log(Effect.logWarning(`Cloud identity: ${line}`)) }),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((from) => (from === "kept" ? Effect.void : Effect.logInfo(`Cloud identity received over ${from}`))),
      Effect.catchCause((cause) => Effect.logWarning("Asking Cloud for this computer's identity failed; kubelet's copy is next", cause)),
    );
    const taking = yield* Effect.forkChild(take);
    yield* wait;
    yield* Fiber.interrupt(taking);
  });
};

const claims = new WeakMap<CloudComputerInfo, Effect.Effect<void>>();

/**
 * Runs a task once this runtime has its identity (`claimed`): at once where it has it, and on a warm pod at its
 * claim, every task on the one wait.
 */
export const afterClaim = (computer: CloudComputerInfo | undefined) =>
  Effect.gen(function* () {
    if (computer === undefined || readIdentity(computer.linkDir) !== undefined) return <A, E, R>(task: Effect.Effect<A, E, R>) => task;
    let wait = claims.get(computer);
    if (wait === undefined) {
      yield* Effect.logInfo("Warm Cloud computer: serving here, waiting to be claimed for its Cloud identity");
      const start = Date.now();
      wait = yield* Effect.cached(
        claimed(computer).pipe(Effect.tap(() => Effect.logInfo(`Claimed: the Cloud identity arrived after ${((Date.now() - start) / 1000).toFixed(1)} s waiting`))),
      );
      claims.set(computer, wait);
    }
    const once = wait;
    return <A, E, R>(task: Effect.Effect<A, E, R>) => Effect.andThen(once, task);
  });

export class CloudComputer extends Context.Reference<CloudComputerInfo | undefined>("caveman/cloudLink/CloudComputer", {
  defaultValue: () => cloudComputerFromEnv(process.env),
}) {}

/** The live link's Cloud URL and token: the git proxy's credential. One per runtime, shared by the link and the handlers. */
export interface LinkState {
  cloudUrl?: string | undefined;
  token?: string | undefined;
  /**
   * While the link runs: its token, waiting for its first, or a new one in place of `stale` that Cloud refused
   * (CloudLink.tokenFor). Every call takes its token here then, never a mint of its own (computers.ts tokenFor, K14).
   */
  fresh?: ((stale: string | undefined, waitMs: number) => Promise<string>) | undefined;
  status?: LinkStatus | "off" | "not_enrolled";
  /** The link holds the relay (Remote control, a Cloud computer); without it, only tokens and heartbeats for moves. */
  relay?: boolean;
  /** This Mac is going to sleep: heartbeats say so until it wakes (moves: Cloud's fallback moves only such a Mac's chats). */
  suspending?: boolean;
  /** While it goes to sleep: the working chats the lid kept here, which the heartbeat names so Cloud never moves them (A-6). */
  kept?: (() => ReadonlyArray<string>) | undefined;
  /** Heartbeats at once, when the link runs. */
  beat?: (() => void) | undefined;
  /** Heartbeats at once, and is done when Cloud has answered that heartbeat or it failed (CloudLink.beatHeard); at once with no link. */
  beatHeard?: (() => Promise<void>) | undefined;
  /**
   * What Cloud's last heartbeat reply said of this computer's life (CONTRACT §5.1: `sleep_at`, `funded_until`, `stop`);
   * undefined until one came. The link alone writes it.
   */
  lifecycle?: Lifecycle | undefined;
  /** Called with every heartbeat reply's lifecycle: what parks this computer on a stop looks at once (handlers, parking.ts). */
  onLifecycle?: ((lifecycle: Lifecycle) => void) | undefined;
  /** The stop this computer parked for: every heartbeat names it (`parked`) until Cloud's stop is gone. */
  parked?: string | undefined;
  /** Whether the link's relay is connected: a Cloud computer is linked from then on. */
  connected?: (() => boolean) | undefined;
  /** Called when the link gets its first token (it is up): what waits for the link looks at once (the moves pass, K13). */
  linked?: (() => void) | undefined;
  /** A hosted automation run works (a step, a check, a command): the heartbeat says busy, so the computer stays up. */
  working?: (() => boolean) | undefined;
  /** On a Mac: the repositories it has checked out, by hash, for the heartbeat (heartbeatRepos.ts); undefined until known. */
  repos?: (() => ReadonlyArray<HeartbeatRepo> | undefined) | undefined;
  /** The chats this computer holds at once and how many it has now, for the heartbeat (capacity.ts); undefined until measured. */
  capacity?: (() => { readonly chats: number; readonly used: number } | undefined) | undefined;
}
export class CloudLinkState extends Context.Reference<LinkState>("caveman/cloudLink/State", { defaultValue: () => ({}) }) {}

/**
 * git config for Cloud's git proxy, passed as GIT_CONFIG_* environment (never
 * argv): github.com URLs go to <cloud>/relay/v1/git/ with the runtime token.
 * Appended after any GIT_CONFIG_* entries git already gets from `env`.
 * Undefined while the link has no token.
 */
export function gitProxyEnv(state: LinkState, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!state.cloudUrl || !state.token) return undefined;
  const proxy = `${state.cloudUrl}/relay/v1/git/`;
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: `url.${proxy}.insteadOf`,
    [`GIT_CONFIG_VALUE_${n}`]: "https://github.com/",
    [`GIT_CONFIG_KEY_${n + 1}`]: `http.${proxy}.extraHeader`,
    [`GIT_CONFIG_VALUE_${n + 1}`]: `Authorization: Bearer ${state.token}`,
  };
}

/**
 * Whether git may run as this process in `root`: git's own ownership test
 * (the checkout and its .git are ours) and no group or other write. On a
 * Cloud computer the agent writes the checkout as the tools uid, so the
 * repo's config and hooks would run as the runtime, which reads runtime.key
 * and hands git the proxy token: refused until git runs in the tools
 * container. No safe.directory exception can widen this.
 */
export function gitTrusts(root: string): boolean {
  return [root, path.join(root, ".git")].every((file) => {
    try {
      const stat = fs.statSync(file);
      return stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0;
    } catch {
      return false;
    }
  });
}

export const linkDirOf = (stateDir: string) => path.join(stateDir, "cloud-link");

type Serve = (socket: Socket.Socket, principal: string) => Effect.Effect<void, unknown>;
/** This Mac's device check on a relayed stream (session-protocol/devices.ts); null on a Cloud computer. */
type DeviceGate = (stream: RelayStream, info: { readonly runtimeId: string; readonly userId: string }, serve: (stream: RelayStream) => StreamSink) => StreamSink;

/** After a client changed something, the heartbeat says active this long: the computer then sleeps its window after it (S7). */
export const ACTIVE_AFTER_CHANGE_MS = 45_000;

/**
 * Whether the computer is in use (the heartbeat's `active`, CONTRACT §6): a turn runs or waits in its queue, a hosted run
 * works, a person holds the desktop, or a client changed something within ACTIVE_AFTER_CHANGE_MS. A client that only
 * watches (an open tab, a phone left on a chat) keeps nothing awake.
 */
export const inUse = (input: { readonly busy: boolean; readonly working: boolean; readonly desktopHeld: boolean; readonly lastChangeAt: number; readonly now: number }) =>
  input.busy || input.working || input.desktopHeld || input.now - input.lastChangeAt < ACTIVE_AFTER_CHANGE_MS;

/** A relay stream as an Effect Socket: the queue fails with a close when the stream ends, which ends the server's read loop. */
function streamSocket(stream: RelayStream) {
  const inbox = Effect.runSync(Queue.unbounded<string | Uint8Array, Socket.SocketError>());
  const socket = Socket.make({
    reader: Effect.succeed({ pull: Queue.takeAll(inbox), upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.succeed({
      write: (chunk) =>
        Socket.isCloseEvent(chunk) ? Effect.sync(() => stream.close(chunk.reason)) : Effect.promise(() => stream.send(chunk)),
      writeAll: (chunks) => Effect.forEach(chunks, (chunk) => Effect.promise(() => stream.send(chunk)), { discard: true }),
    }),
  });
  const sink: StreamSink = {
    message: (data) => Queue.offerUnsafe(inbox, data),
    closed: (reason) =>
      Effect.runSync(Queue.fail(inbox, new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000, closeReason: reason }) }))),
  };
  return { socket, sink };
}

/**
 * Runs the link for as long as it is wanted. ponytail: polls the setting,
 * the enrollment and activity every 2 s; a settings change feed if that lag
 * ever matters.
 */
export const run = (server: {
  readonly serve: Serve;
  readonly connectionCount: () => number;
  readonly devices?: {
    readonly gate: DeviceGate | null;
    readonly queuedCallAllowed?: (
      userId: string,
      call: { readonly session_id: string; readonly request_id: string; readonly method: string; readonly params: unknown },
      device: { readonly device_id: string; readonly at: string; readonly signature: string } | undefined,
    ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code?: string; readonly reason?: string }>;
  };
  readonly activity: () => { readonly lastChangeAt: number; readonly desktopHeld: boolean };
  readonly runCall: RunCall;
  /** Where a chat is for its queued calls (handlers callPlace, M-8); `method`: the call's, a chat's start being for one not made yet. */
  readonly callPlace?: (sessionId: string, method?: string) => Effect.Effect<CallPlace>;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* SessionStore;
    const computer = yield* CloudComputer;
    const state = yield* CloudLinkState;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const dir = computer?.linkDir ?? linkDirOf(config.stateDir);
    let link: CloudLink | undefined;
    let busy = false;
    // Calls a device queued in Cloud (calls.ts): on a Cloud computer always, on This Mac while its chats sync.
    let syncing = computer !== undefined;
    // On This Mac a queued call runs only from a device the Mac allowed on its own screen (S13, devices.ts).
    const devices = server.devices;
    yield* runCalls({
      identity: () => link?.identity,
      state,
      wanted: () => link !== undefined && syncing,
      run: server.runCall,
      laptop: computer === undefined,
      ...(server.callPlace ? { place: server.callPlace } : {}),
      // Call mail taken and not finished survives a crash: it is finished at the next start (CHAOS-6).
      note: fileNote(path.join(config.stateDir, "cloud-calls-taken.json")),
      ...(devices?.queuedCallAllowed
        ? {
            allowed: (call: CallDelivery) =>
              Effect.promise(() =>
                devices.queuedCallAllowed!(call.user_id, { session_id: call.session_id, request_id: call.request_id, method: call.method, params: call.params }, call.device).catch((): { readonly ok: false; readonly code?: string; readonly reason?: string } => ({ ok: false })),
              ).pipe(Effect.map((out): Verdict => (out.ok ? true : out.code !== undefined ? { code: out.code, message: out.reason ?? out.code } : false))),
          }
        : {}),
    }).pipe(Effect.forkScoped);

    // The direct path to devices This Mac allowed (DESIGN S14, direct.ts); a Cloud computer offers none.
    const direct = computer === undefined && server.devices?.gate ? makeDirectPeers({ log: (message) => runFork(Effect.logInfo(message)) }) : undefined;

    const onStream = (identity: Identity) => (stream: RelayStream, info: OpenInfo): StreamSink => {
      // The relay authorized this person for this runtime; a stream from another org is never ours.
      if (info.organization_id !== identity.organizationId || typeof info.user_id !== "string" || info.user_id === "") {
        stream.close("wrong organization");
        return { message: () => {}, closed: () => {} };
      }
      const serveStream = (served: RelayStream) => {
        const { socket, sink } = streamSocket(served);
        runFork(server.serve(socket, `cloud:${info.user_id}`).pipe(Effect.ensuring(Effect.sync(() => served.close()))));
        return sink;
      };
      // This Mac serves a relayed stream only to a device it allowed (DESIGN S13); a Cloud computer serves it at once.
      const gate = server.devices?.gate;
      if (!gate) return serveStream(stream);
      const who = { runtimeId: identity.runtimeId, userId: info.user_id };
      // Past the check, the device may open a direct channel (S14), which is checked again before it is served.
      const served = direct ? (s: RelayStream) => direct.serve(s, serveStream(s), (channel) => gate(channel, who, serveStream)) : serveStream;
      return gate(stream, who, served);
    };

    const stop = () => {
      direct?.closeAll();
      link?.stop();
      link = undefined;
      state.token = undefined;
      state.fresh = undefined;
      state.beat = undefined;
      state.beatHeard = undefined;
      state.connected = undefined;
    };

    const tick = Effect.gen(function* () {
      const raw = computer === undefined ? yield* store.kvGet("settings") : undefined;
      const settings = raw === undefined ? {} : (JSON.parse(raw) as { remote_control?: boolean; sync_chats?: boolean; move_to_cloud?: boolean });
      // On with sync unless the person said otherwise (S13); devices still need This Mac's approval to drive it.
      const relay = computer !== undefined || remoteControlOn(settings);
      // Chats that move or sync to Cloud need this Mac's heartbeat and tokens, not the relay.
      // Only once the person said yes (the chat's notice, or Settings): until then nothing is copied, so no link is needed.
      syncing = computer !== undefined || (settings.sync_chats ?? settings.move_to_cloud) === true;
      const wanted = relay || settings.move_to_cloud === true || syncing;
      const identity = wanted ? readIdentity(dir) : undefined;
      if (link && (link.identity.runtimeId !== identity?.runtimeId || link.relayed !== relay)) stop();
      if (!link && identity) {
        state.cloudUrl = identity.cloudUrl;
        link = new CloudLink({
          identity,
          relay,
          onStream: onStream(identity),
          active: () => inUse({ busy, working: state.working?.() === true, ...server.activity(), now: Date.now() }),
          suspending: () => state.suspending === true,
          kept: () => state.kept?.() ?? [],
          // Only a Cloud computer is stopped by Cloud: This Mac neither reads a stop nor answers one.
          ...(computer
            ? {
                parked: () => state.parked,
                onLifecycle: (lifecycle: Lifecycle) => {
                  state.lifecycle = lifecycle;
                  state.onLifecycle?.(lifecycle);
                },
              }
            : {}),
          enginesSignedIn,
          // A Mac names the repositories it has checked out; a Cloud computer's are the chats' own.
          ...(computer === undefined ? { repos: () => state.repos?.() } : {}),
          capacity: () => state.capacity?.(),
          version: runtimeVersion(),
          log: (message) => runFork(Effect.logWarning(message)),
          onToken: (token) => {
            const first = state.token === undefined;
            state.token = token.value;
            if (first) state.linked?.();
          },
          // A Cloud computer has no setting to turn the link back on: after another instance took the relay, try again later.
          ...(computer ? { replacedRetryMs: 5 * 60_000 } : {}),
        });
        const started = link;
        state.fresh = (stale, waitMs) => started.tokenFor(stale, waitMs);
        state.beat = () => started.beat();
        state.beatHeard = () => started.beatHeard();
        state.connected = () => started.status === "connected";
        onEnginesChanged(() => started.beat());
        yield* Effect.logInfo(`Cloud link on: runtime ${identity.runtimeId} at ${identity.cloudUrl}`);
      }
      state.relay = relay;
      // Remote control off reads "off" even while a moves-only link runs (or waits for enrollment).
      state.status = link ? link.status : !relay ? "off" : "not_enrolled";
      if (link) {
        busy = (yield* store.listWorkspaces()).some((r) => BUSY.has(r.workspace.status));
        link.poke();
      }
    });

    yield* Effect.forever(tick.pipe(Effect.catchCause((cause) => Effect.logError("Cloud link check failed", cause)), Effect.andThen(Effect.sleep("2 seconds")))).pipe(
      Effect.ensuring(Effect.sync(stop)),
    );
  });

/** A turn is running, waiting in the queue, or waiting on the person mid-turn. */
const BUSY = new Set(["starting", "working", "needs_input", "waiting"]);
