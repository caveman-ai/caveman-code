// Test-only: a stand-in for Caveman Cloud's runtime routes (enroll, token,
// heartbeat, revoke, connections), the relay's runtime endpoint and the git proxy's front
// door, with the same checks as the real ones (Ed25519 assertion, 60 s
// window, replay fence, token expiry, one active runtime per key, re-keying
// a local computer), a clock that can run ahead of ours, and the relay's
// keepalive pings. It also serves chat sync: journal
// copies with epochs, summaries, the person's list and stream, queued calls,
// moves and the lid's handoff, for several runtimes and persons at once.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { gunzipSync } from "node:zlib";

import {
  CallRequest,
  ChatSummaryInput,
  NEEDS_YOU_MAX,
  PREVIEW_MAX,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_DECOMPRESSED_BYTES,
  START_METHOD,
  type CallDelivery,
  type CallState,
  type QueuedMethod,
  type ChatPullRequest,
  type ChatSummary,
  type CopiedEvent,
  type RuntimeState,
} from "@caveman-app/session-protocol";
import * as Schema from "effect/Schema";
import { WebSocketServer, type WebSocket } from "ws";

import { isEngineKeyName } from "./engineKeys.ts";
import { assertionMessage } from "./identity.ts";
import { observeRegistration, refusalFor, treeComputerWait, treeRoutes, treeState, type FieldKind } from "./testCloudMail.ts";
import { macMailRoutes, macMailState } from "./testCloudMacMail.ts";
import { pullRoutes, pullsState } from "./testCloudPulls.ts";
import { deviceLogRoutes, deviceLogState } from "./testCloudDevices.ts";

export interface Frame {
  readonly type: number;
  readonly id: Buffer;
  readonly payload: Buffer;
}

export interface RelaySide {
  readonly ws: WebSocket;
  /** The TCP socket under `ws`: pause() it to stop reading (backpressure). */
  readonly socket: Socket;
  token: string;
  /**
   * The connection is dead though its socket stays open: nothing flows either way (no pings, no frames sent, what the
   * runtime sends dropped), as a runtime restored from a memory snapshot finds its relay peer.
   */
  blackhole: boolean;
  readonly frames: Array<Frame>;
  /** Attaches a client: sends an open frame, returns the stream id. */
  open(info?: Partial<{ organization_id: string; user_id: string; subprotocol: string }>): Buffer;
  send(id: Buffer, text: string): void;
  close(id: Buffer, reason?: string): void;
  /** Text frames the runtime sent on `id`, parsed as JSON. */
  replies(id: Buffer): Array<{ id?: unknown; result?: unknown; error?: unknown; method?: string; params?: unknown }>;
}

const frame = (type: number, id: Buffer, payload: string | Buffer = "") => Buffer.concat([Buffer.from([type]), id, Buffer.from(payload)]);

/**
 * `pingMs`: the relay's own ping interval (the core's relay pings every 25 s; 0 never pings, as the relay at the edge,
 * which only answers the runtime's); `state.ping = false` silences it: no ping, and no answer to one. `graceMs`:
 * Cloud's rotation, as code_runtimes keeps it (RuntimeTokenGrace, 60 s): a runtime's mint leaves its token before
 * working only this much longer and ends any older one. Unset, every token lives out its own TTL.
 */
export async function startTestCloud(options: { ttlMs?: number; pingMs?: number; graceMs?: number } = {}) {
  const state = {
    skewMs: 0,
    /** The network is down: every connection is dropped unanswered. */
    unreachable: false,
    /** Routes (by the end of their path) that take a request and never answer it: a network that stalls (a sleeping Wi-Fi, a route into nowhere). */
    stalled: [] as Array<string>,
    /** Its database paused (docker pause): every request is taken and held, then answered once the pause lifts. */
    paused: false,
    /** Every request that reached this Cloud, in order (method and path). */
    /** Every request, in the order they arrived: when (`at`), and how long until it was answered (`ms`, once it was). */
    seen: [] as Array<{ method: string; path: string; at?: number; ms?: number }>,
    ping: true,
    ttlMs: options.ttlMs ?? 15 * 60_000,
    graceMs: options.graceMs,
    personToken: `person-${randomBytes(8).toString("hex")}`,
    organizationId: randomUUID(),
    runtimes: new Map<string, { publicKey: string; computerId: string; lastIssued: number; status: "active" | "revoked"; person?: string }>(),
    tokens: new Map<string, { runtimeId: string; expiresAt: number }>(),
    /** Relay upgrades refused for a token Cloud does not take (expired, or never minted). */
    refusedUpgrades: 0,
    mints: [] as Array<{ issuedAt: number; ok: boolean; runtimeId: string; at: number }>,
    heartbeats: [] as Array<{ active: boolean; token: string; suspending?: true; kept?: ReadonlyArray<string>; parks?: true; parked?: string; engines_signed_in?: ReadonlyArray<string>; repos?: ReadonlyArray<{ remote_hash: string; head: string }>; capacity?: { readonly chats: number; readonly used: number }; version?: string; refused?: true; runtime_version?: string; protocol_revision?: number; capabilities?: ReadonlyArray<string> }>,
    /**
     * A computer's life as its heartbeat reply says it (CONTRACT §5.1), by computer: when Cloud will ask for a stop, until
     * when it is paid for, and the stop Cloud wants now (setStop, clearStop). A computer with none set reads null for each.
     */
    lifecycle: new Map<string, { sleep_at?: string; funded_until?: string; stop?: { id: string; reason: string; deadline: string } }>(),
    /** A Cloud from before §5.1: its heartbeat reply names no lifecycle at all. */
    lifecycleUnknown: false,
    /** A Cloud from before the stop handshake: its strict decoder refuses `parks` and `parked` (400 "Invalid JSON."). */
    heartbeatParksUnknown: false,
    /**
     * Every heartbeat that said `parked`, with Cloud's copy of each chat on that computer as it stood when it arrived: a
     * runtime says it only once the copy holds everything on its disk (AckedStopLosesNothing).
     */
    parked: [] as Array<{ runtimeId: string; computerId: string; stop: string; current: boolean; at: number; copies: Record<string, { cursor_seq: number; segments: number }> }>,
    /** A Cloud from before capacity in the heartbeat: its strict decoder refuses the field (400 "Invalid JSON."). */
    heartbeatCapacityUnknown: false,
    /** A Cloud from before version in the heartbeat: its strict decoder refuses the field (400 "Invalid JSON."). */
    heartbeatVersionUnknown: false,
    /**
     * The oldest runtime version a Cloud computer may run (Cloud's code.minRuntimeVersion); "" sets none. A Cloud
     * computer whose runtime last said an older one, or was heard and said none, reads `runtime_outdated` in the
     * computers list (Caveman Cloud computers.go markOutdated).
     */
    minRuntimeVersion: "",
    /** A Cloud from before kept chats in the heartbeat: its strict decoder refuses the field (400 "Invalid JSON."). */
    heartbeatKeptUnknown: false,
    /** A Cloud from before repos in the heartbeat: its strict decoder refuses the field (400 "Invalid JSON."). */
    heartbeatReposUnknown: false,
    /** Every heartbeat is refused with this 400 message (one about another field). */
    heartbeatRefusal: undefined as string | undefined,
    /**
     * The heartbeat fields past the ones above that this Cloud reads, answered in `accepts` (docs/). None,
     * as Cloud's decoder today (DisallowUnknownFields), which refuses any other field with a 400.
     */
    heartbeatAccepts: [] as Array<string>,
    relays: [] as Array<RelaySide>,
    gitRequests: [] as Array<{ url: string; authorization: string | undefined }>,
    /** Pushes the git proxy refused: a ref outside refs/heads/caveman/ (Caveman Cloud relay/gitproxy.go takes those only). */
    gitRefused: [] as Array<string>,
    /** When set, the git proxy serves the bare repositories under this directory (`<owner>/<name>.git`) to the runtime's token. */
    gitBackend: undefined as string | undefined,
    /** The next this many fetches through the git proxy answer 503 (a proxy between restarts, Cloud asking a runtime to slow down). */
    gitFetchDown: 0,
    /** Asked before the git proxy serves a request, and waited for: a test orders two git commands' requests with it. `answered` settles once this request was. */
    gitServing: undefined as ((url: URL, answered: Promise<void>) => Promise<void> | undefined) | undefined,
    /** A Cloud this far away: every request, the git proxy's too, is looked at this many ms after it arrived (a round trip's worth). */
    latencyMs: 0,
    /** Set: an enroll answer names no person, as Cloud's did before 2026-10-15. */
    enrollWithoutPerson: false,
    ...connectionsState(),
    parity: parityState(),
    plugins: pluginsState(),
    environments: environmentsState(),
    sessions: sessionsState(),
    automations: automationsState(),
    chats: chatsState(),
    /** Trees that span computers (testCloudMail.ts): workspaces, mail on channel "tree", spawns. */
    tree: treeState(),
    /** Mail between a person's Macs, on channel "mac" (testCloudMacMail.ts; it keeps the mail with the tree's). */
    mac: macMailState(),
    /** Pull requests a Cloud computer's chats start on and move (testCloudPulls.ts). */
    pulls: pullsState(),
    /** The person's device log, and Cloud as a malicious carrier of it (testCloudDevices.ts). */
    devices: deviceLogState(),
  };
  state.chats.persons.set(state.personToken, "user-1");
  // A lead's Cloud workspace is the one its chat's registration made.
  state.tree.resolve = (workspaceId) => {
    const found = [...state.chats.sessions.values()].find((s) => s.workspace_id === workspaceId);
    return found === undefined ? undefined : { session_id: found.session_id, computer_id: found.computer_id };
  };
  // A spawn naming a computer is placed by the chat stand-in's computers, for the person whose lead chat it is.
  state.tree.computer = (id) => {
    const c = state.chats.computers.get(id);
    return c === undefined ? undefined : { laptop: c.kind === "laptop", person: c.person, deleted: c.state === "deleted" };
  };
  state.tree.personOf = (lead) => state.chats.sessions.get(lead.session_id)?.person;
  // What a computer last said it holds (its heartbeat's capacity): where the scheduler places a builder among a project's cells.
  state.tree.capacityOf = (computerId) => {
    const runtimes = new Set([...state.runtimes].filter(([, r]) => r.computerId === computerId).map(([id]) => id));
    return state.heartbeats.findLast((beat) => beat.capacity !== undefined && runtimes.has(state.tokens.get(beat.token)?.runtimeId ?? ""))?.capacity;
  };
  mailbox.set(state.chats, state.sessions.mail);
  state.plugins.link = { role: () => state.role };
  state.sharedFor = (pluginId, repository) => {
    const project = repository === undefined ? undefined : state.plugins.projects.find((p) => p.repos.includes(repository.toLowerCase()));
    return state.plugins.installs.some((i) => i.plugin_id === pluginId && i.connection === "shared" && (i.scope === "team" || (project !== undefined && i.project_id === project.id)));
  };
  const now = () => Date.now() + state.skewMs;
  const valid = (token: string | undefined) => token !== undefined && (state.tokens.get(token)?.expiresAt ?? 0) > now();
  const bearerOf = (request: http.IncomingMessage) => request.headers.authorization?.replace(/^Bearer /, "");
  /** A heartbeat's `capacity` when it is well-formed: the chats a computer holds at once and how many it has. */
  const capacityOf = (value: unknown) => {
    const c = value as { chats?: unknown; used?: unknown } | null | undefined;
    return typeof c?.chats === "number" && typeof c.used === "number" ? { chats: c.chats, used: c.used } : undefined;
  };
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  /** Cloud's versionBelow: the first three dotted numbers, a missing one counting as zero; a version with no number is below any minimum. */
  const versionBelow = (version: string, minimum: string) => {
    const parts = (v: string) => /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())?.slice(1).map((n) => Number(n ?? 0));
    const have = parts(version);
    const want = parts(minimum) ?? [0, 0, 0];
    if (have === undefined) return true;
    for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! < want[i]!;
    return false;
  };
  /**
   * Whether a Cloud computer reads `runtime_outdated` (Caveman Cloud computers.go markOutdated): the runtime of it that
   * was heard last said a version below the minimum, or none. One never heard says nothing yet; with no minimum, none.
   */
  const runtimeOutdated = (computerId: string) => {
    if (state.minRuntimeVersion === "") return false;
    const runtimeOf = (token: string) => state.tokens.get(token)?.runtimeId;
    const heard = state.heartbeats.findLast((beat) => beat.refused !== true && state.runtimes.get(runtimeOf(beat.token) ?? "")?.computerId === computerId);
    if (heard === undefined) return false;
    const said = state.heartbeats.findLast((beat) => beat.version !== undefined && runtimeOf(beat.token) === runtimeOf(heard.token))?.version ?? "";
    return versionBelow(said, state.minRuntimeVersion);
  };
  /** A person's own computers as Cloud lists them (GET computers?mine=true): their Macs (driver local) and their Cloud computers. */
  const computersOf = (person: string | undefined) =>
    [...state.chats.computers]
      .filter(([, c]) => c.person === person && c.state !== "deleted")
      .map(([id, c]) => ({
        id,
        name: c.name,
        driver: c.kind === "laptop" ? "local" : "kubernetes",
        size: c.kind === "laptop" ? "" : "2cpu-4gb",
        desired_state: c.state === "starting" ? "running" : c.state,
        observed_state: c.state,
        observed_reason: "",
        updated_at: new Date(now()).toISOString(),
        ...(c.sleep_reason ? { sleep_reason: c.sleep_reason } : {}),
        // When the plan resets, beside a sleep for usage, while Cloud knows (Caveman Cloud place_facts.go fillComputerResets).
        ...(c.sleep_reason === "usage" && c.state === "suspended" && c.resets_at ? { resets_at: c.resets_at } : {}),
        ...(c.disk_lost_at ? { disk_lost_at: c.disk_lost_at, disk_lost_reason: c.disk_lost_reason ?? "" } : {}),
        runtime_outdated: c.kind !== "laptop" && runtimeOutdated(id),
      }));
  const refuse = (response: http.ServerResponse, status: number, code: string) => json(response, status, { error: { code, message: code } });

  const server = http.createServer(async (request, response) => {
    if (state.unreachable) return void request.socket.destroy();
    const arrived: { method: string; path: string; at: number; ms?: number } = { method: request.method ?? "GET", path: request.url ?? "/", at: Date.now() };
    state.seen.push(arrived);
    response.once("finish", () => (arrived.ms = Date.now() - arrived.at));
    if (state.stalled.some((route) => (request.url ?? "/").split("?")[0]!.endsWith(route))) return;
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
    if (state.paused) {
      // A caller that gives up meanwhile (its own deadline) leaves nothing to answer.
      request.on("error", () => {});
      while (state.paused && !request.socket.destroyed) await new Promise((r) => setTimeout(r, 50));
      if (request.socket.destroyed) return;
    }
    response.setHeader("date", new Date(now()).toUTCString());
    const chunks: Array<Buffer> = [];
    try {
      for await (const chunk of request) chunks.push(chunk as Buffer);
    } catch (error) {
      // A caller that went away ends this request, its body whole or not: the async HTTP listener must not reject.
      if (request.destroyed) return;
      throw error;
    }
    const bytes = Buffer.concat(chunks);
    const raw = bytes.toString("utf8");
    const multipart = (request.headers["content-type"] ?? "").startsWith("multipart/form-data");
    const url = new URL(request.url ?? "/", "http://x");
    // git's own requests through the proxy carry packs, not JSON.
    const binary = (request.headers["content-type"] ?? "").startsWith("application/octet-stream") || request.headers["content-encoding"] === "gzip" || (bytes[0] === 0x1f && bytes[1] === 0x8b);
    let body: Record<string, unknown> = {};
    try {
      body = raw && !multipart && !binary && !url.pathname.startsWith("/relay/v1/git/") ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return refuse(response, 400, "cave_bad_request");
    }
    const mint = url.pathname.match(/^\/api\/v1\/code\/runtimes\/([^/]+)\/token$/);
    const revoke = url.pathname.match(/^\/api\/v1\/code\/runtimes\/([^/]+)\/revoke$/);
    if (request.method === "POST" && url.pathname === "/api/v1/code/runtimes") {
      const enroller = state.chats.persons.get(bearerOf(request) ?? "");
      if (enroller === undefined) return refuse(response, 401, "cave_unauthorized");
      if ([...state.runtimes.values()].some((r) => r.status === "active" && r.publicKey === body.public_key)) return refuse(response, 409, "cave_code_key_enrolled");
      // computer_id re-keys a local computer this person enrolled before; an unknown one is absent.
      const computerId = typeof body.computer_id === "string" ? body.computer_id : randomUUID();
      if (typeof body.computer_id === "string" && ![...state.runtimes.values()].some((r) => r.computerId === computerId)) return refuse(response, 404, "cave_not_found");
      const id = randomUUID();
      state.runtimes.set(id, { publicKey: String(body.public_key), computerId, lastIssued: 0, status: "active", person: enroller });
      if (!state.chats.computers.has(computerId)) state.chats.computers.set(computerId, { kind: "laptop", name: typeof body.name === "string" && body.name !== "" ? body.name : "This Mac", person: enroller, state: "running" });
      // The enrolling person, as Cloud names them on the enroll answer only (registry.go Runtime.user_id).
      return json(response, 201, { id, organization_id: state.organizationId, computer_id: computerId, status: "active", ...(state.enrollWithoutPerson ? {} : { user_id: enroller }) });
    }
    if (request.method === "POST" && revoke) {
      if (bearerOf(request) !== state.personToken) return refuse(response, 401, "cave_unauthorized");
      const runtime = state.runtimes.get(revoke[1]!);
      if (!runtime) return refuse(response, 404, "cave_not_found");
      runtime.status = "revoked";
      for (const [token, record] of state.tokens) if (record.runtimeId === revoke[1]) state.tokens.delete(token);
      return json(response, 200, { id: revoke[1], status: "revoked" });
    }
    if (request.method === "POST" && mint) {
      const runtime = state.runtimes.get(mint[1]!);
      const issuedAt = Number(body.issued_at);
      const key = runtime && createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(runtime.publicKey, "base64")]), format: "der", type: "spki" });
      const signed =
        key !== undefined &&
        runtime!.status === "active" &&
        body.organization_id === state.organizationId &&
        verify(null, Buffer.from(assertionMessage(state.organizationId, mint[1]!, issuedAt)), key, Buffer.from(String(body.signature), "base64"));
      const ok = signed && Math.abs(issuedAt * 1000 - now()) <= 60_000 && issuedAt > runtime!.lastIssued;
      state.mints.push({ issuedAt, ok, runtimeId: mint[1]!, at: Date.now() });
      if (!ok) return refuse(response, 401, "cave_code_assertion_refused");
      runtime!.lastIssued = issuedAt;
      if (state.graceMs !== undefined) {
        const own = [...state.tokens].filter(([, record]) => record.runtimeId === mint[1]);
        for (const [older] of own.slice(0, -1)) state.tokens.delete(older);
        const before = own.at(-1)?.[1];
        if (before) before.expiresAt = Math.min(before.expiresAt, now() + state.graceMs);
      }
      const token = `ccrt_${state.organizationId}_${randomBytes(32).toString("base64url")}`;
      const expiresAt = now() + state.ttlMs;
      state.tokens.set(token, { runtimeId: mint[1]!, expiresAt });
      return json(response, 200, { token, runtime_id: mint[1], organization_id: state.organizationId, computer_id: runtime!.computerId, expires_at: new Date(expiresAt).toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/code/runtime/heartbeat") {
      const token = bearerOf(request);
      if (!valid(token)) return refuse(response, 401, "cave_unauthorized");
      if (state.heartbeatCapacityUnknown && body.capacity !== undefined) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      if (state.heartbeatVersionUnknown && body.version !== undefined) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      if (typeof body.version === "string" && body.version.length > 64) return json(response, 400, { error: { code: "cave_bad_request", message: "version is at most 64 characters." } });
      if (state.heartbeatReposUnknown && body.repos !== undefined) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      if (state.heartbeatKeptUnknown && body.kept !== undefined) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      if (state.heartbeatParksUnknown && (body.parks !== undefined || body.parked !== undefined)) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      if (state.heartbeatRefusal !== undefined) {
        state.heartbeats.push({ active: body.active === true, token: token!, refused: true, ...(Array.isArray(body.repos) ? { repos: body.repos as ReadonlyArray<{ remote_hash: string; head: string }> } : {}) });
        return json(response, 400, { error: { code: "cave_bad_request", message: state.heartbeatRefusal } });
      }
      const known = new Set(["active", "suspending", "kept", "parks", "parked", "engines_signed_in", "repos", "capacity", "version", ...state.heartbeatAccepts]);
      if (Object.keys(body).some((key) => !known.has(key))) return json(response, 400, { error: { code: "cave_bad_request", message: "Invalid JSON." } });
      state.heartbeats.push({
        active: body.active === true,
        token: token!,
        ...(body.suspending === true ? { suspending: true as const } : {}),
        ...(Array.isArray(body.kept) ? { kept: body.kept as ReadonlyArray<string> } : {}),
        ...(body.parks === true ? { parks: true as const } : {}),
        ...(typeof body.parked === "string" ? { parked: body.parked } : {}),
        ...(Array.isArray(body.engines_signed_in) ? { engines_signed_in: body.engines_signed_in as ReadonlyArray<string> } : {}),
        ...(Array.isArray(body.repos) ? { repos: body.repos as ReadonlyArray<{ remote_hash: string; head: string }> } : {}),
        ...(typeof body.runtime_version === "string" ? { runtime_version: body.runtime_version } : {}),
        ...(typeof body.protocol_revision === "number" ? { protocol_revision: body.protocol_revision } : {}),
        ...(Array.isArray(body.capabilities) ? { capabilities: body.capabilities as ReadonlyArray<string> } : {}),
        ...(capacityOf(body.capacity) === undefined ? {} : { capacity: capacityOf(body.capacity)! }),
        ...(typeof body.version === "string" && body.version !== "" ? { version: body.version } : {}),
      });
      state.chats.lastHeartbeat.set(state.tokens.get(token!)!.runtimeId, now());
      if (body.suspending === true) state.chats.suspending.add(state.tokens.get(token!)!.runtimeId);
      else state.chats.suspending.delete(state.tokens.get(token!)!.runtimeId);
      const beating = state.tokens.get(token!)!;
      const computerId = state.runtimes.get(beating.runtimeId)?.computerId ?? "";
      // A heartbeat that says the computer is in use calls an idle stop off (CONTRACT §5.1); a renewal or a payment
      // calls the others off (clearStop).
      if (body.active === true && state.lifecycle.get(computerId)?.stop?.reason === "idle") {
        const { stop: _stop, ...rest } = state.lifecycle.get(computerId)!;
        state.lifecycle.set(computerId, rest);
      }
      const life = state.lifecycle.get(computerId);
      if (typeof body.parked === "string") {
        const copies = Object.fromEntries([...state.chats.sessions.values()].filter((s) => s.computer_id === computerId).map((s) => [s.session_id, { cursor_seq: s.cursor_seq, segments: s.segments.length }]));
        state.parked.push({ runtimeId: beating.runtimeId, computerId, stop: body.parked, current: life?.stop?.id === body.parked, at: Date.now(), copies });
      }
      // The fields of what this runtime is that Cloud takes (accepts), beside the lifecycle.
      const accepts = state.heartbeatAccepts.length > 0 ? { accepts: state.heartbeatAccepts } : {};
      if (state.lifecycleUnknown) return json(response, 200, { last_seen_at: new Date(now()).toISOString(), ...accepts });
      return json(response, 200, {
        last_seen_at: new Date(now()).toISOString(),
        token_expires_at: new Date(beating.expiresAt).toISOString(),
        sleep_at: life?.sleep_at ?? null,
        funded_until: life?.funded_until ?? null,
        stop: life?.stop ?? null,
        ...accepts,
      });
    }
    if (connectionRoutes({ state, now, valid: valid(bearerOf(request)), base: `http://${request.headers.host}`, request, url, body, json, refuse, response })) return;
    if (url.pathname === "/api/v1/code/runtime/devices/statements") {
      const token = bearerOf(request);
      const runtimeId = valid(token) ? state.tokens.get(token!)!.runtimeId : undefined;
      const runtime = runtimeId === undefined ? undefined : state.runtimes.get(runtimeId);
      const laptop = runtime !== undefined && state.chats.computers.get(runtime.computerId)?.kind === "laptop";
      const closed = () => request.socket.destroyed;
      if (await deviceLogRoutes(state.devices, { method: request.method ?? "GET", url, body, runtimeId, person: runtime?.person, laptop, organizationId: state.organizationId, closed }, (status, out) => json(response, status, out))) return;
    }
    if (url.pathname.startsWith("/api/v1/code/")) {
      const token = bearerOf(request);
      const runtimeId = valid(token) ? state.tokens.get(token!)!.runtimeId : undefined;
      const person = state.chats.persons.get(token ?? "");
      // The tree stand-in learns a lead's chat from its registration (chatRoutes answers it).
      observeRegistration(state.tree, { method: request.method ?? "GET", url, body, computer: runtimeId === undefined ? undefined : state.runtimes.get(runtimeId)?.computerId });
      if (await treeComputerWait(state.tree, { method: request.method ?? "GET", url, computer: runtimeId === undefined ? undefined : state.runtimes.get(runtimeId)?.computerId, now: now() }, (status, out) => json(response, status, out))) return;
      const runtime = runtimeId === undefined ? undefined : state.runtimes.get(runtimeId);
      if (
        await macMailRoutes(
          {
            organizationId: state.organizationId,
            tree: state.tree,
            mac: state.mac,
            sessions: state.chats.sessions,
            computers: state.chats.computers,
            titleOf: (sessionId) => String(state.chats.summaries.get(sessionId)?.title ?? state.tree.registrations.get(sessionId)?.body.title ?? "Chat"),
            archived: (workspaceId) => [...state.chats.summaries.entries()].some(([id, s]) => s.archived === true && state.chats.sessions.get(id)?.workspace_id === workspaceId),
          },
          { method: request.method ?? "GET", url, body, caller: runtime === undefined ? undefined : { computerId: runtime.computerId, person: runtime.person ?? "user-1" }, now: now() },
          (status, out) => json(response, status, out),
        )
      )
        return;
      if (await chatRoutes(state.chats, { method: request.method ?? "GET", url, bytes, headers: request.headers, runtimeId, person, now: now(), request }, response)) return;
    }
    if (pluginRoutes(state.plugins, { method: request.method ?? "GET", url, body, runtime: valid(bearerOf(request)), person: bearerOf(request) === state.personToken }, (status, out) => (status === 204 ? (response.writeHead(204), response.end()) : json(response, status, out)))) return;
    if (url.pathname.startsWith("/api/v1/code/runtime/")) {
      const token = bearerOf(request);
      const runtimeId = valid(token) ? state.tokens.get(token!)!.runtimeId : undefined;
      const person = runtimeId === undefined ? undefined : state.runtimes.get(runtimeId)?.person;
      const connections = () => ({ rows: [...state.connections.values()], github: state.githubToken !== undefined, engineLogins: person === undefined ? undefined : state.chats.engineLogins.get(person) });
      if (parityRoutes(state.parity, { method: request.method ?? "GET", url, raw, body, runtimeId, now: now(), ifNoneMatch: request.headers["if-none-match"], ifMatch: request.headers["if-match"], ifNoneMatchPut: request.method === "PUT" ? request.headers["if-none-match"] : undefined, connections }, (status, out) => (status === 204 || status === 304 ? (response.writeHead(status), response.end()) : json(response, status, out)))) return;
    }
    // A Cloud computer's credits key (Caveman Cloud POST /code/runtime/credits/key): where credits run on computers,
    // a short-lived key of the calling runtime's person, recorded; else 404 as Cloud answers.
    if (url.pathname === "/api/v1/code/runtime/credits/key" && request.method === "POST") {
      const token = bearerOf(request);
      if (!valid(token)) return refuse(response, 401, "cave_unauthorized");
      const credits = state.environments.credits;
      if (!credits.on) return refuse(response, 404, "cave_code_credits_unavailable");
      if (credits.refusal !== undefined) return refuse(response, credits.refusal.status, credits.refusal.code);
      const runtimeId = state.tokens.get(token!)!.runtimeId;
      const key = `cave_live_computer_${randomBytes(12).toString("hex")}`;
      const expires = new Date(now() + credits.ttlMs).toISOString();
      credits.minted.push({ runtimeId, person: state.runtimes.get(runtimeId)?.person, key, expires_at: expires });
      return json(response, 201, { id: randomUUID(), key, expires_at: expires, ...(credits.gateway === undefined ? {} : { gateway_url: credits.gateway }) });
    }
    if (url.pathname === "/api/v1/code/runtime/computers" && state.environments.computers) {
      const token = bearerOf(request);
      if (!valid(token)) return refuse(response, 401, "cave_unauthorized");
      // The person's own computers (?mine=true), as Cloud lists them.
      const computers = computersOf(state.runtimes.get(state.tokens.get(token!)!.runtimeId)?.person);
      return json(response, 200, {
        computers,
        cloud_computers: true,
        caveman_on_computers: state.environments.cavemanOnComputers,
        ...(state.environments.cavemanPaid === undefined ? {} : { caveman_paid: state.environments.cavemanPaid }),
      });
    }
    // Delete a Cloud computer the calling runtime's person made (Cloud's AsEnroller route): its chats are archived.
    const deleting = /^\/api\/v1\/code\/runtime\/computers\/([^/]+)$/.exec(url.pathname);
    if (deleting && request.method === "DELETE" && state.environments.computers) {
      const token = bearerOf(request);
      if (!valid(token)) return refuse(response, 401, "cave_unauthorized");
      const person = state.runtimes.get(state.tokens.get(token!)!.runtimeId)?.person;
      const id = decodeURIComponent(deleting[1]!);
      const computer = state.chats.computers.get(id);
      if (computer === undefined || computer.kind !== "cloud" || computer.person !== person) return refuse(response, 404, "cave_not_found");
      computer.state = "deleted";
      for (const [sessionId, summary] of state.chats.summaries) if (summary.computer_id === id) state.chats.summaries.set(sessionId, { ...summary, archived: true });
      return json(response, 200, { id, name: computer.name, driver: "kubernetes", size: "", desired_state: "deleted", observed_state: "running", observed_reason: "", updated_at: new Date(now()).toISOString() });
    }
    if (url.pathname.startsWith("/api/v1/code/runtime/environments")) {
      const token = bearerOf(request);
      const answer = environmentRoutes(state.environments, { method: request.method ?? "GET", url, body, runtime: valid(token), now: now() });
      if (answer) {
        if (typeof answer.body === "string") {
          response.writeHead(answer.status, { "content-type": "text/plain" });
          return response.end(answer.body);
        }
        return json(response, answer.status, answer.body);
      }
    }
    if (url.pathname.startsWith("/api/v1/code/runtime/")) {
      const token = bearerOf(request);
      const computerId = valid(token) ? state.runtimes.get(state.tokens.get(token!)!.runtimeId)?.computerId : undefined;
      // Cloud acts only for a session registered on the calling runtime's computer (a summary or a register).
      const knownSession = (sessionId: string) => computerId !== undefined && state.chats.sessions.get(sessionId)?.computer_id === computerId;
      if (pullRoutes(state.pulls, { method: request.method ?? "GET", url, body, runtime: valid(token), gitBackend: state.gitBackend, knownSession }, (status, out) => json(response, status, out))) return;
    }
    if (state.chats.gitScoped && url.pathname === "/api/v1/code/runtime/pull-requests" && request.method === "POST") {
      // Cloud opens a pull request only in a repository the chat's own workspace checks out (its `repo` or a checkout).
      const token = bearerOf(request);
      const computerId = valid(token) ? state.runtimes.get(state.tokens.get(token!)!.runtimeId)?.computerId : undefined;
      const session = state.chats.sessions.get(String(body.session_id ?? ""));
      const repos = session !== undefined && session.computer_id === computerId ? [session.repo, ...(session.checkouts ?? []).map((checkout) => checkout.repo)].map((repo) => repo.toLowerCase()) : [];
      if (!repos.includes(String(body.repo ?? "").toLowerCase())) {
        return json(response, 403, { error: { code: "cave_code_output_target_not_allowed", message: `${String(body.repo ?? "")} is not one of this chat's repositories.` } });
      }
    }
    if (url.pathname.startsWith("/api/v1/code/runtime/") && automationRoutes(state.automations, { method: request.method ?? "GET", url, body, runtime: valid(bearerOf(request)), gitBackend: state.gitBackend }, (status, out) => json(response, status, out))) return;
    if (url.pathname.startsWith("/api/v1/code/mail/") || url.pathname.startsWith("/api/v1/code/runtime/")) {
      const token = bearerOf(request);
      const computerId = valid(token) ? state.runtimes.get(state.tokens.get(token!)!.runtimeId)?.computerId : undefined;
      if (await treeRoutes(state.tree, { method: request.method ?? "GET", url, body, computer: computerId, now: now() }, (status, out) => json(response, status, out))) return;
      // Mail to a chat workspace goes to the computer it sits on; a call it carries is delivered once taken.
      const forCaller = (m: TestMail) => {
        if (m.to_computer_id !== undefined) return m.to_computer_id === computerId;
        const at = workspaceComputer(state.chats, m.to_workspace_id);
        return at === undefined || at === computerId;
      };
      const taken = (m: TestMail) => {
        if (m.channel !== "call") return;
        const call = [...state.chats.calls.values()].find((c) => c.mail_id === m.id);
        if (!call || (call.status !== "queued" && call.status !== "delivered")) return;
        call.taken_at = now();
        if (call.status === "queued") {
          call.status = "delivered";
          bump(state.chats, call.session_id);
        }
      };
      // A call's mail acknowledged with no result posted is never answered (a runtime from before its method only
      // acknowledges it): the call fails at once, and says so to the device that queued it.
      const acked = (m: TestMail) => {
        if (m.channel !== "call") return;
        const call = [...state.chats.calls.values()].find((c) => c.mail_id === m.id);
        if (!call || (call.status !== "queued" && call.status !== "delivered")) return;
        call.status = "failed";
        call.error = { code: "cave_code_call_unanswered", message: "Its computer took it and did not run it." };
        bump(state.chats, call.session_id);
      };
      if (await sessionRoutes(state.sessions, { method: request.method ?? "GET", url, body, bytes, contentType: request.headers["content-type"], runtime: valid(token), now: now(), forCaller, taken, acked }, response)) return;
    }
    if (url.pathname.startsWith("/relay/v1/git/")) {
      state.gitRequests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      if (state.gitFetchDown > 0 && url.pathname.endsWith("/info/refs") && url.searchParams.get("service") === "git-upload-pack") {
        state.gitFetchDown -= 1;
        response.writeHead(503, { "content-type": "text/plain" });
        return void response.end("the git proxy is not answering\n");
      }
      if (state.gitBackend !== undefined && valid(bearerOf(request))) {
        // By Cloud's rows alone (CONTRACT §7): a Cloud computer reaches the repositories its workspaces check out, and
        // no other, whatever it asks for.
        const asking = state.runtimes.get(state.tokens.get(bearerOf(request) ?? "")?.runtimeId ?? "")?.computerId ?? "";
        const repo = /^\/relay\/v1\/git\/([^/]+\/[^/]+?)(?:\.git)?\//.exec(url.pathname)?.[1]?.toLowerCase() ?? "";
        if (state.chats.gitScoped && state.chats.computers.get(asking)?.kind === "cloud" && !reposOf(state.chats, asking).has(repo)) {
          state.chats.gitOutOfScope.push({ computer_id: asking, repo });
          response.writeHead(403, { "content-type": "text/plain" });
          return void response.end(`Caveman's git proxy serves this computer only the repositories its chats were started with, not ${repo}.\n`);
        }
        // A push names the refs it moves before its pack: the proxy takes caveman/ branches and refuses the rest whole.
        const outside = url.pathname.endsWith("/git-receive-pack") ? pushedRefs(request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).filter((ref) => !ref.startsWith("refs/heads/caveman/")) : [];
        if (outside.length > 0) {
          state.gitRefused.push(...outside);
          response.writeHead(403, { "content-type": "text/plain" });
          return void response.end(`Caveman's git proxy takes pushes to caveman/ branches only, not ${outside.join(", ")}.\n`);
        }
        await state.gitServing?.(url, new Promise<void>((resolve) => response.once("close", resolve)));
        return gitHttpBackend(state.gitBackend, request, url, bytes, response);
      }
      return refuse(response, 403, "test proxy refuses");
    }
    refuse(response, 404, "not_found");
  });

  const wss = new WebSocketServer({ noServer: true, autoPong: false, handleProtocols: (protocols) => (protocols.has("caveman.relay.v1") ? "caveman.relay.v1" : false) });
  server.on("upgrade", (request, socket, head) => {
    const token = bearerOf(request);
    if (!valid(token)) {
      state.refusedUpgrades++;
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const pinger = options.pingMs === 0 ? undefined : setInterval(() => state.ping && !side.blackhole && ws.ping(), options.pingMs ?? 1_000);
      ws.on("ping", (data) => state.ping && !side.blackhole && ws.pong(data));
      ws.on("close", () => clearInterval(pinger));
      const side: RelaySide = {
        ws,
        socket: socket as Socket,
        token: token!,
        blackhole: false,
        frames: [],
        open: (info = {}) => {
          const id = randomBytes(16);
          if (!side.blackhole) ws.send(frame(1, id, JSON.stringify({ organization_id: state.organizationId, user_id: "user-1", subprotocol: "caveman.session.v1", ...info })));
          return id;
        },
        send: (id, text) => {
          if (!side.blackhole) ws.send(frame(2, id, text));
        },
        close: (id, reason = "") => {
          if (!side.blackhole) ws.send(frame(4, id, reason));
        },
        replies: (id) => side.frames.filter((f) => f.type === 2 && f.id.equals(id)).map((f) => JSON.parse(f.payload.toString("utf8"))),
      };
      ws.on("message", (data: Buffer) => {
        if (side.blackhole) return;
        const f = { type: data[0]!, id: data.subarray(1, 17), payload: data.subarray(17) };
        side.frames.push(f);
        if (f.type === 5) side.token = f.payload.toString("utf8");
      });
      state.relays.push(side);
    });
  });
  state.chats.link = {
    now,
    post: (mail) => state.sessions.post(mail),
    runtimesOf: (computerId) => [...state.runtimes].filter(([, r]) => r.computerId === computerId && r.status === "active").map(([id]) => id),
    computerOf: (runtimeId) => state.runtimes.get(runtimeId)?.computerId,
    relayUp: (runtimeId) => state.relays.some((side) => side.ws.readyState === side.ws.OPEN && state.tokens.get(side.token)?.runtimeId === runtimeId),
    nudge: () => undefined,
    runStateOf: (workspaceId) => state.sessions.runStates.findLast((r) => r.workspace === workspaceId)?.run_state,
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    /**
     * A runtime enrolled without the Ed25519 dance, for route tests: its id, computer and a live token. `kind: "cloud"`
     * makes its computer a Cloud computer; `person` is who it acts for (`user-1` by default).
     */
    /** Tells the person's streams which runtimes came or went since the last sweep (sweepRuntimes). */
    sweepRuntimes: () => sweepRuntimes(state.chats, now()),
    /** A person's own computers as Cloud's rows (GET computers?mine=true): what a client with a person's sign-in reads (testCloudPhone.ts). */
    computersOf,
    /** Cloud wants `computerId` down (CONTRACT §5.1): its heartbeat replies name this stop until clearStop. Answers the stop's id. */
    setStop: (computerId: string, reason: "idle" | "usage" | "lease" | "update" | "owner" | "funding" = "idle", deadlineMs = 120_000) => {
      const id = randomUUID();
      state.lifecycle.set(computerId, { ...state.lifecycle.get(computerId), stop: { id, reason, deadline: new Date(now() + deadlineMs).toISOString() } });
      return id;
    },
    /** The stop was called off (the person sent input, or paid): heartbeat replies say `stop: null` again. */
    clearStop: (computerId: string) => {
      const { stop: _stop, ...rest } = state.lifecycle.get(computerId) ?? {};
      state.lifecycle.set(computerId, rest);
    },
    /** The heartbeat that said `parked` for `stop`, once one did. */
    parkedFor: (stop: string) => state.parked.find((p) => p.stop === stop),
    /** Whether Cloud waits for `parked` from this computer's runtime before it stops it: only one whose last heartbeat said `parks: true` (any other is stopped at once). */
    waitsForParked: (computerId: string) => state.heartbeats.findLast((h) => state.runtimes.get(state.tokens.get(h.token)?.runtimeId ?? "")?.computerId === computerId)?.parks === true,
    enrollRuntime: (options: { person?: string; kind?: "laptop" | "cloud"; name?: string; computerId?: string } = {}) => {
      const runtimeId = randomUUID();
      const computerId = options.computerId ?? randomUUID();
      const person = options.person ?? "user-1";
      state.runtimes.set(runtimeId, { publicKey: randomBytes(32).toString("base64"), computerId, lastIssued: 0, status: "active", person });
      if (!state.chats.computers.has(computerId)) state.chats.computers.set(computerId, { kind: options.kind ?? "laptop", name: options.name ?? (options.kind === "cloud" ? "Cloud computer" : "This Mac"), person, state: "running" });
      const token = `ccrt_${state.organizationId}_${randomBytes(32).toString("base64url")}`;
      state.tokens.set(token, { runtimeId, expiresAt: now() + state.ttlMs });
      return { runtimeId, computerId, token };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of state.chats.streams) stream.close();
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type TestCloud = Awaited<ReturnType<typeof startTestCloud>>;

/** One connection Cloud holds: the token only Cloud has, leased on request. */
export interface TestConnection {
  readonly connection_id: string;
  readonly resource?: string;
  readonly provider?: string;
  /** org: a shared account an admin connected for `plugin_id`; absent: the person's own. */
  owner?: "org";
  plugin_id?: string;
  signed_in_by_name?: string;
  status: "connected" | "pending" | "needs_reconnect" | "error";
  problem?: string;
  updated_at: string;
  token?: string;
}

function connectionsState() {
  return {
    connections: new Map<string, TestConnection>(),
    /** How long a leased token lives. */
    leaseTtlMs: 60 * 60_000,
    /** The person's GitHub login in Cloud, leased for `provider: "github"`; none: 409 reconnect. */
    githubToken: undefined as string | undefined,
    leases: [] as Array<{ target: string; token: string; stale: boolean; owner?: "org"; body?: Record<string, unknown> }>,
    /** Start answers this for every server URL (Cloud's 422 for a private address or no client registration). */
    startRefusal: undefined as undefined | { status: number; code: string; message: string },
    /** The person's org role: a member cannot connect a shared account or install for the team. */
    role: "admin" as "owner" | "admin" | "member",
    /** Whether a team install, or one of the repository's project, shares an account for the plugin (startTestCloud links the plugins state). */
    sharedFor: (_pluginId: string, _repository: string | undefined): boolean => false,
    starts: [] as Array<Record<string, unknown>>,
  };
}

/** Cloud's canonicalResource: lowercase scheme and host, no default port; a query, userinfo or fragment is a 400. */
function canonical(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.search || url.hash || url.username || url.password || !/^https?:$/.test(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}${/^[a-z]+:\/\/[^/]+$/i.test(raw.trim()) ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Cloud's /code/runtime/connections routes: start (a pending row and Cloud's own sign-in page, which a
 * GET approves at once as the person would), list (never a token), delete, lease (409 reconnect for a
 * refused refresh, 404 for none; `stale: true` is recorded, the test rotates the token itself).
 */
function connectionRoutes(input: {
  readonly state: ReturnType<typeof connectionsState>;
  readonly now: () => number;
  readonly valid: boolean;
  readonly base: string;
  readonly request: http.IncomingMessage;
  readonly url: URL;
  readonly body: Record<string, unknown>;
  readonly json: (response: http.ServerResponse, status: number, body: unknown) => void;
  readonly refuse: (response: http.ServerResponse, status: number, code: string) => void;
  readonly response: http.ServerResponse;
}): boolean {
  const { state, url, body, response, json, refuse } = input;
  const method = input.request.method;
  if (method === "GET" && url.pathname === "/test/authorize") {
    const row = state.connections.get(url.searchParams.get("connection_id") ?? "");
    if (!row) return (refuse(response, 404, "cave_not_found"), true);
    Object.assign(row, { status: "connected", token: `lease-${randomBytes(12).toString("hex")}`, updated_at: new Date(input.now()).toISOString() });
    delete row.problem;
    response.writeHead(200, { "content-type": "text/html" }).end("Connected, you can close this tab");
    return true;
  }
  const prefix = "/api/v1/code/runtime/connections";
  if (!url.pathname.startsWith(prefix)) return false;
  if (!input.valid) return (refuse(response, 401, "cave_unauthorized"), true);
  const target = (b: Record<string, unknown>) => (b.provider === "github" ? "provider:github" : typeof b.resource === "string" ? canonical(b.resource) : undefined);
  const keyOf = (r: TestConnection) => (r.provider ? `provider:${r.provider}` : r.resource);
  /** The person's own row, or (`pluginId`) the org's shared one for that plugin. */
  const rowOf = (key: string, pluginId?: string) =>
    [...state.connections.values()].find((r) => keyOf(r) === key && (pluginId === undefined ? r.owner === undefined : r.owner === "org" && r.plugin_id === pluginId));
  const wire = ({ token: _token, owner, ...row }: TestConnection) => ({ ...row, owner: owner ?? "person" });
  if (method === "POST" && url.pathname === `${prefix}/start`) {
    const key = target(body);
    if (key === undefined) return (refuse(response, 400, "cave_bad_request"), true);
    // GitHub is connected in the Cloud console, never a row here.
    if (key === "provider:github") return (json(response, 200, { connection_id: "github", authorize_url: `${input.base}/test/console` }), true);
    if (state.startRefusal) return (json(response, state.startRefusal.status, { error: { code: state.startRefusal.code, message: state.startRefusal.message } }), true);
    // A shared account: org admins only, for one plugin; Cloud takes no project from the caller.
    const org = body.owner === "org";
    if (org && (state.role === "member" || typeof body.plugin_id !== "string")) return (refuse(response, 403, "cave_forbidden"), true);
    state.starts.push(body);
    const previous = rowOf(key, org ? String(body.plugin_id) : undefined);
    if (previous) state.connections.delete(previous.connection_id);
    const id = randomUUID();
    const row: TestConnection = {
      connection_id: id,
      resource: key,
      status: "pending",
      updated_at: new Date(input.now()).toISOString(),
      ...(org ? { owner: "org" as const, plugin_id: String(body.plugin_id), signed_in_by_name: "Ada Admin" } : {}),
    };
    state.connections.set(id, row);
    json(response, 201, { connection_id: id, authorize_url: `${input.base}/test/authorize?connection_id=${id}` });
    return true;
  }
  if (method === "GET" && url.pathname === prefix) {
    // Cloud's provider is "mcp" on every server row, and a GitHub login it keeps is a row of its own.
    const rows = [...state.connections.values()].map((r) => (r.provider ? wire(r) : { provider: "mcp", ...wire(r) }));
    if (state.githubToken) rows.push({ connection_id: "github", provider: "github", resource: "", status: "connected", updated_at: new Date(input.now()).toISOString(), owner: "person" });
    return (json(response, 200, { connections: rows }), true);
  }
  const del = url.pathname.match(/^\/api\/v1\/code\/runtime\/connections\/([^/]+)$/);
  if (method === "DELETE" && del?.[1] === "github") {
    // Cloud deletes the person's GitHub login it keeps (I5).
    state.githubToken = undefined;
    response.writeHead(204).end();
    return true;
  }
  if (method === "DELETE" && del && del[1] !== "lease" && del[1] !== "start") {
    // A person's sign-out never deletes the team's shared account; ?owner=org (an admin's) deletes only that.
    const id = decodeURIComponent(del[1]!);
    const org = url.searchParams.get("owner") === "org";
    if (org && state.role === "member") return (refuse(response, 403, "cave_forbidden"), true);
    if (state.connections.get(id)?.owner === "org" && !org) return (refuse(response, 403, "cave_forbidden"), true);
    if ((state.connections.get(id)?.owner === "org") !== org || !state.connections.delete(id)) return (refuse(response, 404, "cave_not_found"), true);
    response.writeHead(204).end();
    return true;
  }
  if (method === "POST" && url.pathname === `${prefix}/lease`) {
    const key = target(body);
    const expires_at = new Date(input.now() + state.leaseTtlMs).toISOString();
    if (key === "provider:github") {
      if (!state.githubToken) return (refuse(response, 409, "cave_code_connection_reconnect"), true);
      state.leases.push({ target: key, token: state.githubToken, stale: body.stale === true });
      return (json(response, 200, { access_token: state.githubToken, token_type: "Bearer", expires_at }), true);
    }
    // The person's own row first (one that needs a reconnect says so, never the team's instead); else, for a plugin
    // installed with a shared account (Cloud finds the install and its project itself), the org's row.
    const own = key === undefined ? undefined : rowOf(key);
    const shared = typeof body.plugin_id === "string" && state.sharedFor(body.plugin_id, typeof body.repository === "string" ? body.repository : undefined) ? rowOf(key!, body.plugin_id) : undefined;
    const row = own ?? shared;
    if (!row) return (refuse(response, 404, "cave_not_found"), true);
    if (row.status !== "connected" || !row.token) return (refuse(response, 409, "cave_code_connection_reconnect"), true);
    state.leases.push({ target: key!, token: row.token, stale: body.stale === true, ...(row.owner === undefined ? {} : { owner: row.owner }), body });
    json(response, 200, { access_token: row.token, token_type: "Bearer", expires_at });
    return true;
  }
  refuse(response, 404, "not_found");
  return true;
}

// ------------------------------------------------------------ cloud parity (profile, secrets, spaces, access log)

/**
 * The runtime routes the cloud-parity build adds (docs/), for one
 * person: the profile, repository secrets (with the reserved `caveman:servers`), the org's Spaces and the
 * access log. A runtime in `computers` acts as a Cloud computer (read-only profile, shared rule); every
 * request is recorded raw in `requests`, so a test can say what never left This Mac.
 */
export function parityState() {
  return {
    computers: new Set<string>(),
    /** Computers that also run someone else's work: profile, secrets and resolve answer 403 cave_code_computer_shared. */
    shared: new Set<string>(),
    /** Computers with no active workspace (403 cave_code_computer_idle) or not meant to run (403 cave_code_computer_asleep). */
    idle: new Set<string>(),
    asleep: new Set<string>(),
    profile: undefined as undefined | { profile: unknown; digest: string; updated_at: string },
    /**
     * A Cloud from before shared profiles: v1 and v2 only, and a PUT ignores If-Match and If-None-Match. On by default,
     * since real Cloud does exactly that today (control-api profiles.go): a test of shared profiles (v3, 412 on a
     * stale write) turns it off until Cloud ships them.
     */
    legacyProfiles: true,
    /** Runs before the next profile PUTs are checked, one each: another computer's write landing between a read and a write. */
    beforeProfilePut: [] as Array<() => void>,
    /** Profile PUTs refused because Cloud's profile changed since the writer read it (412). */
    profileConflicts: 0,
    /** The person removed the profile from Cloud (I4): a values-free tombstone; a PUT without `resume` is 409. */
    pausedAt: undefined as string | undefined,
    secrets: new Map<string, Map<string, string>>(),
    /**
     * A service account's computer (C2-5): what its resolve answers beside the granted secrets (variables bound to
     * hosts, and credentials), and a refusal it answers instead (409 cave_code_service_account_inactive).
     */
    account: undefined as
      | undefined
      | { secrets?: Array<{ name: string; value: string; hosts?: string[] }>; credentials?: Array<Record<string, unknown>>; refuse?: { status: number; code: string } },
    /** Repositories whose PUT Cloud refuses (400), as it would a name it does not take. */
    refuseRepos: new Set<string>(),
    spaces: [] as Array<{ id: string; name: string; repo: string; commit: string; ref?: string }>,
    accessLog: [] as Array<{ at: string; action: string; names: string[]; actor_type: string; actor_id: string; computer_id?: string }>,
    requests: [] as Array<{ method: string; path: string; raw: string }>,
  };
}
export type ParityState = ReturnType<typeof parityState>;

const SERVERS = "caveman:servers";
/**
 * profiles.go ProfileInput.check, the checks that have bitten: unknown fields, the 2 MiB cap, skill names and
 * paths, file counts and sizes, server `cloud`, long args. The message names the problem as Cloud's does.
 */
function profileProblem(raw: string, body: Record<string, unknown>, legacy = false): { status: number; code: string; message?: string } | undefined {
  const bad = { status: 400, code: "cave_bad_request" };
  if (Buffer.byteLength(raw) > (2 << 20) + 4096) return { status: 413, code: "cave_request_too_large" };
  if (Object.keys(body).some((k) => !["profile", "digest", "resume"].includes(k))) return bad;
  if (!/^[a-f0-9]{64}$/.test(String(body.digest))) return bad;
  const profile = body.profile as { version?: unknown; lineage?: unknown; plugins?: Record<string, unknown>; skills?: Array<{ name: string; source: string; files: Array<{ path: string; content: string }> }> };
  // v3 (shared by every computer that merges) carries its lineage; an older Cloud knows neither.
  if (profile?.version !== 1 && profile?.version !== 2 && (legacy || profile?.version !== 3)) return { ...bad, message: "profile.version is 1 or 2." };
  if (profile.version === 3 && !/^[0-9a-f]{32}$/.test(String(profile.lineage))) return { ...bad, message: "A v3 profile names its lineage." };
  const known = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
  if (!known(profile, ["version", "plugins", "skills", ...(profile.version === 3 ? ["lineage"] : [])])) return { ...bad, message: "Invalid profile: unknown field \"lineage\"." };
  if (profile.plugins && !known(profile.plugins, ["spaces", "disabled", "trusted", "envAllowlist", "servers", "installed", "trustedHooks"])) return bad;
  for (const space of (profile.plugins?.spaces ?? []) as Array<Record<string, unknown>>) {
    if (!known(space, ["url", "commit", "ref", "enabled", "granted"]) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(space.commit))) return bad;
  }
  for (const server of (profile.plugins?.servers ?? []) as Array<Record<string, unknown>>) {
    if (!known(server, ["name", "command", "args", "url", "env", "headers", "auth", "source", "enabled", "cloud", "cloudReason", "cloudConsent"])) return bad;
    if (!["runs", "needs_runtime", "mac_only"].includes(String(server.cloud))) return bad;
    if (((server.args as string[] | undefined) ?? []).some((a) => Buffer.byteLength(a) > 4096)) return bad;
  }
  for (const skill of profile.skills ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skill.name) || skill.name.includes("..")) return bad;
    if (skill.files.length === 0 || skill.files.length > 500) return bad;
    let size = 0;
    for (const f of skill.files) {
      if (f.path.startsWith("/") || f.path.includes("\\") || f.path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return bad;
      if (/^\.env/i.test(f.path.split("/").at(-1)!) || /\.(pem|key)$/i.test(f.path)) return bad;
      size += Buffer.byteLength(f.content);
    }
    if (size > 256 << 10) return bad;
  }
  return undefined;
}

/** secrets.go checkSecretName: a variable name, or under caveman:servers <16 hex>.<UPPER VAR>; duplicates refused. */
const secretsProblem = (repository: string, entries: ReadonlyArray<{ name: string; value: string }>) => {
  const seen = new Set<string>();
  for (const { name, value } of entries) {
    const ok = repository === SERVERS ? /^[a-f0-9]{16}\.[A-Z_][A-Z0-9_]{0,255}$/.test(name) : /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name);
    if (!ok || seen.has(name) || value === "") return true;
    seen.add(name);
  }
  return entries.length === 0 || entries.length > 200;
};

function parityRoutes(
  st: ParityState,
  input: {
    method: string;
    url: URL;
    raw: string;
    body: Record<string, unknown>;
    runtimeId: string | undefined;
    now: number;
    ifNoneMatch?: string | undefined;
    /** A PUT's preconditions: the profile it merged onto, or `*` for none yet. */
    ifMatch?: string | undefined;
    ifNoneMatchPut?: string | undefined;
    /** The person's connections and GitHub login (for holdings), from the connections routes' state. */
    connections: () => { rows: ReadonlyArray<TestConnection>; github: boolean; engineLogins?: Record<string, unknown> | undefined };
  },
  reply: (status: number, body?: unknown) => void,
): boolean {
  const { method, url, body, runtimeId } = input;
  const route = url.pathname.slice("/api/v1/code/runtime/".length);
  if (!["profile", "spaces", "secrets", "secrets/resolve", "access-log", "holdings"].includes(route) && !route.startsWith("secrets/")) return false;
  st.requests.push({ method, path: `${url.pathname}${url.search}`, raw: input.raw });
  const refuse = (status: number, code: string, message = code) => (reply(status, { error: { code, message } }), true);
  if (runtimeId === undefined) return refuse(401, "cave_unauthorized");
  const computer = st.computers.has(runtimeId);
  const at = new Date(input.now).toISOString();
  const log = (action: string, names: string[]) => computer && st.accessLog.unshift({ at, action, names, actor_type: "system", actor_id: runtimeId });
  // bindRuntime: a computer that sleeps, runs nothing, or runs someone else's work too acts for no one.
  if (computer && route !== "spaces") {
    if (st.asleep.has(runtimeId)) return refuse(403, "cave_code_computer_asleep");
    if (st.idle.has(runtimeId)) return refuse(403, "cave_code_computer_idle");
    if (st.shared.has(runtimeId)) return refuse(403, "cave_code_computer_shared");
  }
  if (route === "spaces" && method === "GET") return (reply(200, { spaces: st.spaces }), true);
  if (route === "access-log" && method === "GET") return (reply(200, { entries: st.accessLog.slice(0, Number(url.searchParams.get("limit") ?? 100)) }), true);
  if (route === "holdings" && method === "GET") {
    if (computer) return refuse(403, "cave_forbidden");
    const { rows, github, engineLogins } = input.connections();
    const repositories = [...st.secrets].filter(([r]) => r !== SERVERS).map(([repository, names]) => ({ repository, names: [...names.keys()].sort(), updated_at: at }));
    const keys = st.secrets.get(SERVERS);
    return (
      reply(200, {
        ...(st.profile ? { profile: { digest: st.profile.digest, updated_at: st.profile.updated_at } } : st.pausedAt ? { profile: { digest: "", updated_at: st.pausedAt, paused_at: st.pausedAt } } : {}),
        repositories,
        server_keys: { names: [...(keys?.keys() ?? [])].sort(), ...(keys ? { updated_at: at } : {}) },
        connections: rows.map((r) => ({ connection_id: r.connection_id, resource: r.resource ?? "", provider: "mcp", status: r.status, updated_at: r.updated_at })),
        github_linked: github,
        // The person's Cloud logins for Claude Agent and Codex (engine_logins.go), names and computers only, once set.
        ...(engineLogins ? { engine_logins: engineLogins } : {}),
      }),
      true
    );
  }
  if (route === "profile") {
    if (method === "PUT") {
      if (computer) return refuse(403, "cave_code_profile_read_only");
      const problem = profileProblem(input.raw, body, st.legacyProfiles);
      if (problem) return refuse(problem.status, problem.code, problem.message);
      if (st.pausedAt !== undefined && body.resume !== true) return refuse(409, "cave_code_profile_paused");
      st.beforeProfilePut.shift()?.();
      // A write names the profile it merged onto: another computer's write since is refused, unless it holds the same.
      if (!st.legacyProfiles && st.profile?.digest !== body.digest) {
        const held = st.profile === undefined ? undefined : `"${st.profile.digest}"`;
        if ((input.ifMatch !== undefined && input.ifMatch !== held) || (input.ifNoneMatchPut === "*" && held !== undefined)) {
          st.profileConflicts++;
          return refuse(412, "cave_code_profile_changed", "Your profile changed in Caveman since this computer read it.");
        }
      }
      st.pausedAt = undefined;
      st.profile = { profile: body.profile, digest: String(body.digest), updated_at: at };
      return (reply(200, { digest: body.digest, updated_at: at }), true);
    }
    if (method === "DELETE") {
      if (computer) return refuse(403, "cave_code_profile_read_only");
      st.profile = undefined;
      st.pausedAt = at;
      return (reply(204), true);
    }
    if (method === "GET") {
      if (st.profile === undefined) return refuse(404, "cave_code_profile_none");
      // Unchanged since the caller's copy: no body and no access-log row, as Cloud answers.
      if (input.ifNoneMatch === `"${st.profile.digest}"`) return (reply(304), true);
      log("profile.read", []);
      return (reply(200, st.profile), true);
    }
  }
  const repository = String(method === "PUT" ? body.repository : (url.searchParams.get("repository") ?? ""));
  // secrets.go secretRepository: a repository (host/owner/name) or caveman:servers; any other key is a 400.
  if (repository !== SERVERS && !/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/:\s]+(?:\/[^/\s]+)+$/i.test(repository)) return refuse(400, "cave_bad_request");
  const names = st.secrets.get(repository) ?? new Map<string, string>();
  // I6: a computer reads server keys; only This Mac writes them, save an engine's own key (engineKeys.ts).
  const engineKeyOnly =
    method === "PUT"
      ? Array.isArray(body.secrets) && (body.secrets as Array<{ name?: unknown }>).every((s) => typeof s.name === "string" && isEngineKeyName(s.name))
      : isEngineKeyName(decodeURIComponent(route.replace(/^secrets\//, "")));
  if (computer && repository === SERVERS && (method === "PUT" || method === "DELETE") && !engineKeyOnly) return refuse(403, "cave_code_server_keys_mac_only");
  if (route === "secrets/resolve" && method === "POST") {
    if (st.account?.refuse) return refuse(st.account.refuse.status, st.account.refuse.code);
    log("secrets.resolve", [...names.keys()]);
    const granted = [...names].map(([name, value]) => ({ name, value }));
    return (reply(200, st.account ? { secrets: [...granted, ...(st.account.secrets ?? [])], credentials: st.account.credentials ?? [] } : { secrets: granted }), true);
  }
  if (route === "secrets" && method === "GET") return (reply(200, { secrets: [...names.keys()].sort().map((name) => ({ name, repository, created_at: at, updated_at: at, last_used_at: null })) }), true);
  if (route === "secrets" && method === "PUT") {
    const entries = (body.secrets as Array<{ name: string; value: string }>) ?? [];
    if (secretsProblem(repository, entries) || st.refuseRepos.has(repository)) return refuse(400, "cave_bad_request");
    for (const entry of entries) names.set(entry.name, entry.value);
    st.secrets.set(repository, names);
    return (reply(200, { secrets: [...names.keys()].map((name) => ({ name, repository })) }), true);
  }
  if (route.startsWith("secrets/") && method === "DELETE") {
    const name = decodeURIComponent(route.slice("secrets/".length));
    if (!names.delete(name)) return refuse(404, "cave_not_found");
    if (names.size === 0) st.secrets.delete(repository);
    return (reply(204), true);
  }
  return false;
}

// ------------------------------------------------------------ plugins (projects, installs, org marketplaces)

/** Caveman Cloud's plugin routes for one org (marketplace design §7, fix round D1/D4/D10). */
export function pluginsState() {
  return {
    projects: [] as Array<{ id: string; name: string; repos: string[] }>,
    installs: [] as Array<{ scope: "team" | "project"; project_id?: string; plugin_id: string; policy: string; connection: string; source?: unknown; commit?: string }>,
    marketplaces: [] as Array<{ name: string; repo: string; ref?: string; commit: string }>,
    /** Person writes, as sent. */
    writes: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
    /** Answer every runtime read with this status (Cloud down). */
    down: undefined as number | undefined,
    /** Set by startTestCloud: the person's role. */
    link: undefined as undefined | { role: () => string },
  };
}
export type PluginsState = ReturnType<typeof pluginsState>;

function pluginRoutes(
  st: PluginsState,
  input: { method: string; url: URL; body: Record<string, unknown>; runtime: boolean; person: boolean },
  reply: (status: number, body?: unknown) => void,
): boolean {
  const { method, url, body } = input;
  const route = url.pathname;
  const refuse = (status: number, code: string) => (reply(status, { error: { code, message: code } }), true);
  const admin = st.link?.role() !== "member";
  if (route === "/api/v1/code/runtime/plugins" && method === "GET") {
    if (!input.runtime) return refuse(401, "cave_unauthorized");
    if (st.down !== undefined) return refuse(st.down, "cave_unavailable");
    // Cloud keeps repository keys lower-case.
    const repository = url.searchParams.get("repository")?.toLowerCase();
    const project = repository === undefined ? undefined : st.projects.find((p) => p.repos.includes(repository));
    const installs = st.installs.filter((i) => i.scope === "team" || (project !== undefined && i.project_id === project.id));
    return (reply(200, { marketplaces: st.marketplaces, installs, ...(project === undefined ? {} : { project }) }), true);
  }
  if (!route.startsWith("/api/v1/code/projects") && !route.startsWith("/api/v1/code/plugins/installs") && route !== "/api/v1/code/marketplaces") return false;
  if (!input.person) return refuse(401, "cave_unauthorized");
  if (method !== "GET") st.writes.push({ method, path: `${route}${url.search}`, body });
  if (route === "/api/v1/code/projects" && method === "GET") return (reply(200, { projects: st.projects }), true);
  if (route === "/api/v1/code/projects/for-repository" && method === "POST") {
    const repository = String(body.repository).toLowerCase();
    const held = st.projects.find((p) => p.repos.includes(repository));
    if (held) return (reply(200, held), true);
    if (st.projects.some((p) => p.name === body.name)) return refuse(409, "cave_code_project_name_taken");
    const project = { id: randomUUID(), name: String(body.name), repos: [repository] };
    st.projects.push(project);
    return (reply(201, project), true);
  }
  if (route === "/api/v1/code/projects" && method === "POST") {
    if (st.projects.some((p) => p.name === body.name)) return refuse(409, "cave_code_project_name_taken");
    const project = { id: randomUUID(), name: String(body.name), repos: [] as string[] };
    st.projects.push(project);
    return (reply(201, project), true);
  }
  const repos = route.match(/^\/api\/v1\/code\/projects\/([^/]+)\/repos$/);
  if (repos && method === "POST") {
    const project = st.projects.find((p) => p.id === repos[1]);
    if (!project) return refuse(404, "cave_not_found");
    const repository = String(body.repository).toLowerCase();
    if (st.projects.some((p) => p !== project && p.repos.includes(repository))) return refuse(409, "cave_code_repo_in_project");
    if (!project.repos.includes(repository)) project.repos.push(repository);
    return (reply(200, project), true);
  }
  if (route === "/api/v1/code/marketplaces" && method === "POST") {
    if (!admin) return refuse(403, "cave_forbidden");
    if (st.marketplaces.some((m) => m.name === body.name)) return refuse(409, "cave_code_marketplace_name_taken");
    st.marketplaces.push({ name: String(body.name), repo: String(body.repo), commit: String(body.commit), ...(typeof body.ref === "string" ? { ref: body.ref } : {}) });
    return (reply(201, st.marketplaces.at(-1)), true);
  }
  if (route === "/api/v1/code/plugins/installs" && method === "POST") {
    // Team installs, Default or Required, any source or commit, and a shared account take an admin (D1, D4); only the catalog's or the team's marketplaces.
    if (!admin && (body.scope === "team" || (body.policy !== undefined && body.policy !== "available") || body.source !== undefined || body.commit !== undefined || body.connection === "shared")) return refuse(403, "cave_forbidden");
    const market = String(body.plugin_id).slice(String(body.plugin_id).lastIndexOf("@") + 1);
    if (market !== "caveman-curated" && !st.marketplaces.some((m) => m.name === market)) return refuse(409, "cave_code_marketplace_not_on_team");
    const same = (i: PluginsState["installs"][number]) => i.scope === body.scope && i.plugin_id === body.plugin_id && (i.project_id ?? null) === (body.project_id ?? null);
    st.installs = [...st.installs.filter((i) => !same(i)), { ...(body as PluginsState["installs"][number]) }];
    return (reply(201, body), true);
  }
  if (route === "/api/v1/code/plugins/installs" && method === "DELETE") {
    const scope = url.searchParams.get("scope");
    const project = url.searchParams.get("project_id");
    const before = st.installs.length;
    st.installs = st.installs.filter((i) => !(i.scope === scope && i.plugin_id === url.searchParams.get("plugin_id") && (i.project_id ?? null) === project));
    return before === st.installs.length ? refuse(404, "cave_not_found") : (reply(204), true);
  }
  return false;
}

// ------------------------------------------------------------ environments (a repo's Cloud setup)

const ENV_STEPS = ["clone", "services", "setup", "check", "snapshot", "restore_check"] as const;

/**
 * Caveman Cloud's environments routes (docs/ §3) for one org, with a
 * stand-in builder: each read of a build moves it one step on. `outcome` decides how a config's build ends.
 * `routes: false` is a Cloud from before environments (a bare 404). Like Cloud, `by: "caveman"` saves as Caveman,
 * a `[services]` name the install doesn't offer is a 400, `off` (computers off for the org) and `noSnapshots` (an
 * install without a snapshot class) are 409s, and `repoAccess: false` (a member Cloud can't see push access for)
 * gets a 403 on every save and build. A warm hint is warm once the repo has a ready snapshot.
 * docs/ adds build secrets (sealed values, names answered; the request log keeps
 * no value), versions and restore, and `all` (every repo of the org with a Cloud copy or a snapshot). `foreign` repos
 * are another organization's: Acme reads no versions of them, restores none and sets no secret on them. A save or
 * restore with `base_version` older than the latest Cloud copy is a 409 (cave_code_environment_changed).
 */
export function environmentsState() {
  return {
    routes: true,
    off: false,
    noSnapshots: false,
    repoAccess: true,
    /** Answer GET runtime/computers with cloud_computers true (background prepare needs it). */
    computers: false,
    /**
     * Its Cloud computers run Caveman chats (caveman_on_computers): a lab whose computers each get a Caveman key, as
     * the move tests run, or a Cloud whose computers' runtimes are each minted a credits key of their person's.
     */
    cavemanOnComputers: true,
    /** Where they pay from the person's credits, whether anything can pay now (caveman_paid); undefined unsaid, as a lab. */
    cavemanPaid: undefined as boolean | undefined,
    /**
     * Credits keys for Cloud computers' runtimes (POST runtime/credits/key): off (404) unless `on`; each minted lives
     * `ttlMs` and runs on `gateway`; `refusal` answers instead of a key.
     */
    credits: {
      on: false,
      ttlMs: 60 * 60_000,
      gateway: undefined as string | undefined,
      refusal: undefined as { readonly status: number; readonly code: string } | undefined,
      minted: [] as Array<{ runtimeId: string; person: string | undefined; key: string; expires_at: string }>,
    },
    /** Repos whose branch has .caveman/computer.toml (source repo; PUT refused). */
    repoFiles: new Map<string, string>(),
    envs: new Map<string, { config: string; version: number; secret_names: string[]; updated_by: string; updated_at: string }>(),
    ready: new Map<string, { commit: string; built_at: string; checks: Array<{ command: string; ok: boolean; seconds: number }>; gaps: string[] }>(),
    builds: new Map<string, { id: string; repo: string; config: string; save: boolean; by: string; step: number; status: string; failure: null | { kind: string; step: string; message: string }; gaps: string[]; started_at: string; finished_at: string | null }>(),
    latest: new Map<string, string>(),
    /** Build secrets by repo, sealed: only names leave. */
    buildSecrets: new Map<string, Map<string, string>>(),
    /** Every saved Cloud copy by repo, oldest first. */
    versions: new Map<string, Array<{ version: number; config: string; updated_by: string; updated_at: string }>>(),
    /** Another organization's repos (Globex's), with a version of their own Acme must never read. */
    foreign: new Set<string>(),
    /** Repos a teammate set up from another Mac (in `all`, never a project here). */
    teammates: new Map<string, { state: string; updated_by: string; updated_at: string }>(),
    outcome: (_config: string): { fail?: { kind: string; step: (typeof ENV_STEPS)[number]; message: string }; gaps?: string[] } => ({}),
    requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
  };
}
export type EnvironmentsState = ReturnType<typeof environmentsState>;

function environmentRoutes(
  st: EnvironmentsState,
  input: { method: string; url: URL; body: Record<string, unknown>; runtime: boolean; now: number },
): { status: number; body: unknown } | undefined {
  const { method, url, body } = input;
  if (!st.routes) return { status: 404, body: "404 page not found" };
  // Like Cloud's audit log, the stand-in keeps who set which build secret, never its value.
  st.requests.push({ method, path: `${url.pathname}${url.search}`, body: "value" in body ? { ...body, value: "[sealed]" } : body });
  if (!input.runtime) return { status: 401, body: { error: { code: "cave_unauthorized", message: "unauthorized" } } };
  if (st.off) return { status: 409, body: { error: { code: "cave_code_cloud_computers_off", message: "Cloud computers are off for Acme." } } };
  if (st.noSnapshots) return { status: 409, body: { error: { code: "cave_code_environments_off", message: "This install of Caveman Cloud doesn't prepare repos for Cloud computers." } } };
  const at = new Date(input.now).toISOString();
  const route = url.pathname.slice("/api/v1/code/runtime/environments".length);
  const who = body.by === "caveman" ? "Caveman" : "Julius";
  const unoffered = (config: string) =>
    [...(/^\[services\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(config)?.[1] ?? "").matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]!).find((name) => !["postgres", "redis"].includes(name));
  const refused = (config: string) => {
    const name = unoffered(config);
    return name ? { status: 400, body: { error: { code: "cave_code_environment_config", message: `This install doesn't offer ${name}.` } } } : undefined;
  };
  const build = (repo: string, config: string, save: boolean) => {
    const id = `b${st.builds.size + 1}`;
    st.builds.set(id, { id, repo, config, save, by: who, step: 0, status: "queued", failure: null, gaps: [], started_at: at, finished_at: null });
    st.latest.set(repo, id);
    return id;
  };
  const view = (id: string) => {
    const b = st.builds.get(id)!;
    const outcome = st.outcome(b.config);
    const failAt = outcome.fail ? ENV_STEPS.indexOf(outcome.fail.step) : -1;
    return {
      id: b.id,
      status: b.status,
      steps: ENV_STEPS.map((name, i) => ({ name, status: i < b.step ? (i === failAt ? "failed" : "done") : i === b.step && b.status === "running" ? "running" : b.status === "failed" ? "skipped" : "pending", ...(i < b.step ? { seconds: 3 } : {}) })),
      log_tail: `$ ${b.config.split("\n").find((l) => l.startsWith("run")) ?? "setup"}\n${b.failure ? b.failure.message : "ok"}`,
      failure: b.failure,
      gaps: b.gaps,
      started_at: b.started_at,
      finished_at: b.finished_at,
    };
  };
  // A read moves the build one step on, to its end.
  const advance = (id: string) => {
    const b = st.builds.get(id)!;
    if (b.status === "succeeded" || b.status === "failed") return;
    const outcome = st.outcome(b.config);
    const failAt = outcome.fail ? ENV_STEPS.indexOf(outcome.fail.step) : -1;
    if (b.status === "queued") return void (b.status = "running");
    b.step++;
    if (b.step - 1 === failAt) {
      b.status = "failed";
      b.failure = { kind: outcome.fail!.kind, step: outcome.fail!.step, message: outcome.fail!.message };
      b.finished_at = at;
      return;
    }
    if (b.step >= 4 && b.status === "running") b.status = "validating";
    if (b.step >= ENV_STEPS.length) {
      b.status = "succeeded";
      b.gaps = outcome.gaps ?? [];
      b.finished_at = at;
      if (b.save && !st.repoFiles.has(b.repo)) {
        const before = st.envs.get(b.repo);
        st.envs.set(b.repo, { config: b.config, version: (before?.version ?? 0) + 1, secret_names: before?.secret_names ?? [], updated_by: b.by, updated_at: at });
        keep(b.repo);
      }
      const checks = (/check = \[([^\]]*)\]/.exec(b.config)?.[1] ?? "").split(",").map((c) => c.trim().replace(/^"|"$/g, "")).filter(Boolean);
      st.ready.set(b.repo, { commit: "4f2c1a0d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c", built_at: at, checks: checks.map((command) => ({ command, ok: !b.gaps.includes(`${command} failed`), seconds: 12 })), gaps: b.gaps });
    }
  };
  const keep = (repo: string) => {
    const saved = st.envs.get(repo)!;
    st.versions.set(repo, [...(st.versions.get(repo) ?? []), { version: saved.version, config: saved.config, updated_by: saved.updated_by, updated_at: saved.updated_at }]);
  };
  const environment = (repo: string) => {
    const own = st.repoFiles.get(repo);
    const saved = st.envs.get(repo);
    const latest = st.latest.get(repo);
    const ready = st.ready.get(repo);
    const running = latest !== undefined && !["succeeded", "failed"].includes(st.builds.get(latest)!.status);
    const state = ready ? (ready.gaps.length > 0 ? "ready_with_gaps" : "ready") : running ? "setting_up" : latest ? "failed" : "not_set_up";
    return {
      repo,
      branch: "main",
      state,
      source: own !== undefined ? "repo" : saved ? "cloud" : "none",
      config: own ?? saved?.config ?? null,
      ...(saved ? { config_version: saved.version } : {}),
      updated_by: saved?.updated_by ?? null,
      updated_at: saved?.updated_at ?? null,
      secret_names: saved?.secret_names ?? [],
      build_secret_names: [...(st.buildSecrets.get(repo)?.keys() ?? [])].sort(),
      sizes: ["2x8", "4x16", "8x32", "16x64"],
      max_size: "16x64",
      services: { postgres: ["15", "16", "17"], redis: ["7"] },
      snapshot: ready ? { commit: ready.commit, built_at: ready.built_at, checks: ready.checks } : null,
      build: latest ? view(latest) : null,
      added_by_cloud_later: true,
    };
  };
  const repo = String(method === "GET" ? (url.searchParams.get("repo") ?? "") : (body.repo ?? ""));
  // A warm hint needs read access only: warm when the repo has a ready snapshot to keep a computer standing on.
  if (route === "/warm-hint" && method === "POST") return { status: 202, body: { warm: st.ready.has(repo) } };
  // Read access: Acme's repos only; another organization's versions are not Acme's to read.
  if (route === "/versions" && method === "GET")
    return { status: 200, body: { versions: st.foreign.has(repo) ? [] : [...(st.versions.get(repo) ?? [])].reverse().slice(0, 50) } };
  if (route === "/all" && method === "GET") {
    const repos = new Set([...st.envs.keys(), ...st.ready.keys(), ...st.repoFiles.keys()]);
    const rows = [...repos].filter((r) => !st.foreign.has(r)).map((r) => {
      const e = environment(r);
      return { repo: r, branch: e.branch, state: e.state, source: e.source, updated_by: e.updated_by, updated_at: e.updated_at, snapshot_built_at: e.snapshot?.built_at ?? null };
    });
    const teammates = [...st.teammates].map(([r, t]) => ({ repo: r, branch: "main", state: t.state, source: "cloud", updated_by: t.updated_by, updated_at: t.updated_at, snapshot_built_at: t.state === "ready" ? t.updated_at : null }));
    return { status: 200, body: { environments: [...rows, ...teammates] } };
  }
  if (st.foreign.has(repo) && method !== "GET")
    return { status: 403, body: { error: { code: "cave_code_environment_repo_access", message: `Only Acme's admins and people who can push to ${repo} change its Cloud setup. Add .caveman/computer.toml to the repo in a pull request instead.` } } };
  if (!st.repoAccess && method !== "GET")
    return { status: 403, body: { error: { code: "cave_code_environment_repo_access", message: `Only Acme's admins and people who can push to ${repo} change its Cloud setup. Add .caveman/computer.toml to the repo in a pull request instead.` } } };
  if (route === "" && method === "GET") {
    // Time passes for a running build between reads, as Cloud's builder works on its own.
    const latest = st.latest.get(repo);
    if (latest) advance(latest);
    return { status: 200, body: environment(repo) };
  }
  // A save or restore based on an older Cloud copy than the latest: someone saved since.
  const changed = () =>
    typeof body.base_version === "number" && body.base_version !== (st.envs.get(repo)?.version ?? 0)
      ? { status: 409, body: { error: { code: "cave_code_environment_changed", message: `${repo}'s Cloud setup changed since (now version ${st.envs.get(repo)?.version ?? 0}, by ${st.envs.get(repo)?.updated_by ?? "nobody"}). Review it again.` } } }
      : undefined;
  if (route === "" && method === "PUT") {
    if (st.repoFiles.has(repo)) return { status: 409, body: { error: { code: "cave_code_environment_repo_owned", message: `${repo} has .caveman/computer.toml on main; edit it there.` } } };
    const stale = changed();
    if (stale) return stale;
    const no = refused(String(body.config));
    if (no) return no;
    const before = st.envs.get(repo);
    st.envs.set(repo, { config: String(body.config), version: (before?.version ?? 0) + 1, secret_names: (body.secret_names as string[] | undefined) ?? [], updated_by: who, updated_at: at });
    keep(repo);
    const id = build(repo, String(body.config), false);
    return { status: 200, body: { environment: environment(repo), build_id: id } };
  }
  if (route === "/versions/restore" && method === "POST") {
    if (st.repoFiles.has(repo)) return { status: 409, body: { error: { code: "cave_code_environment_repo_owned", message: `${repo} has .caveman/computer.toml on main; edit it there.` } } };
    const stale = changed();
    if (stale) return stale;
    const old = (st.versions.get(repo) ?? []).find((v) => v.version === body.version);
    if (!old) return { status: 404, body: { error: { code: "cave_not_found", message: `${repo} has no version ${String(body.version)}.` } } };
    const before = st.envs.get(repo)!;
    st.envs.set(repo, { ...before, config: old.config, version: before.version + 1, updated_by: who, updated_at: at });
    keep(repo);
    const id = build(repo, old.config, false);
    return { status: 200, body: { environment: environment(repo), build_id: id } };
  }
  if (route === "/secrets" && (method === "PUT" || method === "DELETE")) {
    const name = String(body.name ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return { status: 400, body: { error: { code: "cave_bad_request", message: "name must be a NAME: letters, digits and _, not starting with a digit." } } };
    const sealed = st.buildSecrets.get(repo) ?? new Map<string, string>();
    if (method === "PUT") {
      const value = typeof body.value === "string" ? body.value : "";
      if (value === "" || value.length > 16 << 10) return { status: 400, body: { error: { code: "cave_bad_request", message: "value must be 1 byte to 16 KiB." } } };
      if (!sealed.has(name) && sealed.size >= 50) return { status: 400, body: { error: { code: "cave_bad_request", message: `${repo} has 50 build secrets, the most a repo keeps.` } } };
      sealed.set(name, value);
    } else sealed.delete(name);
    st.buildSecrets.set(repo, sealed);
    return { status: 200, body: { names: [...sealed.keys()].sort() } };
  }
  if (route === "/builds" && method === "POST") {
    const config = typeof body.config === "string" ? body.config : (st.repoFiles.get(repo) ?? st.envs.get(repo)?.config ?? "");
    const no = refused(config);
    if (no) return no;
    return { status: 200, body: { build_id: build(repo, config, body.save === true) } };
  }
  const one = /^\/builds\/([^/]+)(\/log)?$/.exec(route);
  if (one && method === "GET") {
    if (!st.builds.has(one[1]!)) return { status: 404, body: { error: { code: "cave_not_found", message: "no build" } } };
    if (one[2]) return { status: 200, body: `${view(one[1]!).log_tail}\n(full log)` };
    advance(one[1]!);
    return { status: 200, body: view(one[1]!) };
  }
  return undefined;
}

/** One mail in the stand-in's mailbox (Cloud's code_mail_envelopes), with the payload sessions carry. */
export interface TestMail {
  readonly id: string;
  readonly verb: string;
  readonly authority: string;
  readonly channel: string;
  readonly to_workspace_id: string | null;
  /** Mail for a computer rather than the chat's (a two-phase move's accept, a reassignment back to its source). */
  readonly to_computer_id?: string;
  readonly body: string;
  readonly wakes: boolean;
  readonly payload: unknown;
  readonly created_at: string;
  delivered: boolean;
  lease?: { token: string; expiresAt: number };
}

/**
 * Cloud's routes for sessions nobody sits at (platform CONTRACT §3-§4, §7): the mailbox's take and ack (by
 * channel, leased like the spec's outbox), agent versions, public events (kept once per seq), traces, input files,
 * outputs (multipart), memory stores (409 on a stale if_sha256) and run state.
 */
export function sessionsState() {
  const st = {
    mail: [] as Array<TestMail>,
    /** Every take (POST mail/deliveries), by channel: a runtime that waits on Cloud's long poll takes only when told. */
    takes: [] as Array<{ channel: string; at: number }>,
    /** Every renew (POST mail/deliveries/renew): the ids it held longer. */
    renews: [] as Array<{ ids: ReadonlyArray<string>; at: number }>,
    /** Agent versions by `<id>:<version>`. */
    agents: new Map<string, { file: string; file_sha256: string }>(),
    /** Public events by session id, one per seq. */
    events: new Map<string, Map<number, { seq: number; type: string; created_at: string; data: Record<string, unknown> }>>(),
    /** Every events request as sent (to watch batching and retries). */
    eventPosts: [] as Array<{ session: string; seqs: Array<number>; bytes: number }>,
    /** When set, the events route answers this status (a Cloud that is down) until cleared. */
    eventsDown: undefined as number | undefined,
    traces: [] as Array<unknown>,
    files: new Map<string, { name: string; bytes: Buffer }>(),
    outputs: [] as Array<{ id: string; session: string; path: string; content: Buffer }>,
    memories: new Map<string, Map<string, { content: string; sha256: string }>>(),
    runStates: [] as Array<{ workspace: string; run_state: string }>,
    /** When set, the run-state route answers this status (a blip) until cleared. */
    runStateDown: undefined as number | undefined,
    /** A slow Cloud for run state: the write is kept, then answered this many ms later. */
    runStateDelayMs: 0,
    /** Calls the meter recorded, once per (session, request_id), as sent. */
    usage: [] as Array<{ request_id: string; session_id: string; model: string; input_tokens: number; output_tokens: number; cost: { usd: number; basis: string } | null }>,
    /** Tree budgets by Cloud session (each session its own tree here); `workspace` is the tree's, whose run state parks. */
    budgets: new Map<string, { workspace: string; limit_usd: number; spent_usd: number; parked: boolean }>(),
    acks: [] as Array<string>,
    /** Posts a mail as Cloud's StartSession and events route do; answers its id. */
    post: (mail: { verb: string; authority: string; to_workspace_id: string; to_computer_id?: string; body?: string; payload?: unknown; channel?: string }) => {
      const id = randomUUID();
      st.mail.push({ id, verb: mail.verb, authority: mail.authority, channel: mail.channel ?? "session", to_workspace_id: mail.to_workspace_id, ...(mail.to_computer_id ? { to_computer_id: mail.to_computer_id } : {}), body: mail.body ?? "", wakes: mail.verb !== "note", payload: mail.payload ?? null, created_at: new Date().toISOString(), delivered: false });
      return id;
    },
    /** A session's events in seq order. */
    eventsOf: (session: string) => [...(st.events.get(session)?.values() ?? [])].sort((a, b) => a.seq - b.seq),
  };
  return st;
}

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A take's lease (mailbox.go): a queued call's mail 30 s (CallMailLeaseTTL, renewed while the call runs), the rest 5 min. */
export const CALL_MAIL_LEASE_MS = 30_000;
const mailLeaseMs = (mail: Pick<TestMail, "channel">) => (mail.channel === "call" ? CALL_MAIL_LEASE_MS : 5 * 60_000);

async function sessionRoutes(
  st: ReturnType<typeof sessionsState>,
  input: {
    method: string;
    url: URL;
    body: Record<string, unknown>;
    bytes: Buffer;
    contentType: string | undefined;
    runtime: boolean;
    now: number;
    /** Mail the caller's computer may take (every mail when absent). */
    forCaller?: (mail: TestMail) => boolean;
    /** Mail this call acknowledged: a call it carried that has no answer fails then (mailbox.go AckDeliveries). */
    acked?: (mail: TestMail) => void;
    /** Each mail as a take leases it. */
    taken?: (mail: TestMail) => void;
  },
  response: http.ServerResponse,
): Promise<boolean> {
  const reply = (status: number, out?: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
    response.writeHead(status, headers);
    response.end(out === undefined ? undefined : Buffer.isBuffer(out) ? out : JSON.stringify(out));
    return true;
  };
  const { method, url, body } = input;
  const route = url.pathname.replace(/^\/api\/v1\/code\//, "");
  const known = /^(mail\/deliveries(\/ack|\/renew)?|runtime\/(agents|sessions|traces|files|memory-stores|workspaces|usage)\b)/.test(route);
  if (!known) return false;
  if (route.startsWith("runtime/workspaces/") && !route.endsWith("/run-state")) return false;
  if (!input.runtime) return reply(401, { error: { code: "cave_unauthorized", message: "cave_unauthorized" } });
  if (route === "mail/deliveries" && method === "POST") {
    const channel = url.searchParams.get("channel") ?? "";
    st.takes.push({ channel, at: input.now });
    const token = randomUUID();
    const taken = st.mail.filter((m) => !m.delivered && (channel === "" || m.channel === channel) && (m.lease === undefined || m.lease.expiresAt < input.now) && (input.forCaller?.(m) ?? true));
    for (const m of taken) {
      // As C1 leases it (mailbox.go): a queued call's mail for 30 s (CallMailLeaseTTL, so a runtime that took it and
      // died, or let it follow its chat, hands it on that soon), any other mail for 5 minutes (MailLeaseTTL).
      m.lease = { token, expiresAt: input.now + mailLeaseMs(m) };
      input.taken?.(m);
    }
    const until = taken.length > 0 ? Math.min(...taken.map((m) => m.lease!.expiresAt)) : undefined;
    return reply(200, {
      lease_token: taken.length > 0 ? token : null,
      lease_expires_at: until === undefined ? null : new Date(until).toISOString(),
      messages: taken.map(({ delivered: _d, lease: _l, ...m }) => ({ ...m, from_workspace_id: null, to_user_id: null, reply_to: null, attempts: 1 })),
    });
  }
  if (route === "mail/deliveries/renew" && method === "POST") {
    // mailbox.go RenewDeliveries: the token's unacknowledged, unexpired mail held another lease of its channel's length.
    const ids = body.ids;
    if (typeof body.lease_token !== "string" || !Array.isArray(ids) || ids.length === 0 || ids.length > 100 || Object.keys(body).some((k) => k !== "lease_token" && k !== "ids"))
      return reply(400, { error: { code: "cave_bad_request", message: "lease_token and 1 to 100 ids are required." } });
    const renewed: Array<string> = [];
    let until: number | undefined;
    for (const m of st.mail) {
      if (!ids.includes(m.id) || m.delivered || m.lease?.token !== body.lease_token || m.lease.expiresAt <= input.now) continue;
      m.lease = { token: m.lease.token, expiresAt: input.now + mailLeaseMs(m) };
      renewed.push(m.id);
      until = Math.min(until ?? Infinity, m.lease.expiresAt);
    }
    st.renews.push({ ids: renewed, at: input.now });
    return reply(200, { renewed, lost: (ids as Array<string>).filter((id) => !renewed.includes(id)), lease_expires_at: until === undefined ? null : new Date(until).toISOString() });
  }
  if (route === "mail/deliveries/ack" && method === "POST") {
    const ids = (body.ids as Array<string>) ?? [];
    const delivered: Array<string> = [];
    for (const m of st.mail) {
      if (ids.includes(m.id) && m.lease?.token === body.lease_token && !m.delivered) {
        m.delivered = true;
        delivered.push(m.id);
        st.acks.push(m.id);
        input.acked?.(m);
      }
    }
    return reply(200, { delivered, lost: ids.filter((id) => !delivered.includes(id)) });
  }
  const agent = /^runtime\/agents\/([^/]+)\/versions\/(\d+)$/.exec(route);
  if (agent && method === "GET") {
    const found = st.agents.get(`${decodeURIComponent(agent[1]!)}:${agent[2]}`);
    return found ? reply(200, found) : reply(404, { error: { code: "cave_not_found", message: "No such agent version on this computer's sessions." } });
  }
  const events = /^runtime\/sessions\/([^/]+)\/events$/.exec(route);
  if (events && method === "POST") {
    const session = decodeURIComponent(events[1]!);
    const list = (body.events as Array<{ seq: number; type: string; created_at: string; data: Record<string, unknown> }>) ?? [];
    st.eventPosts.push({ session, seqs: list.map((e) => e.seq), bytes: input.bytes.length });
    if (st.eventsDown !== undefined) return reply(st.eventsDown, { error: { code: "cave_unavailable", message: "down" } });
    if (input.bytes.length > 256 * 1024) return reply(413, { error: { code: "cave_too_large", message: "too large" } });
    const kept = st.events.get(session) ?? new Map();
    for (const event of list) if (!kept.has(event.seq)) kept.set(event.seq, event);
    st.events.set(session, kept);
    return reply(200, { accepted: list.length });
  }
  if (route === "runtime/traces" && method === "POST") {
    st.traces.push(body);
    return reply(200, { accepted: true });
  }
  const file = /^runtime\/files\/([^/]+)\/content$/.exec(route);
  if (file && method === "GET") {
    const found = st.files.get(decodeURIComponent(file[1]!));
    if (!found) return reply(404, { error: { code: "cave_not_found", message: "No such file." } });
    return reply(200, found.bytes, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${found.name}"` });
  }
  const outputs = /^runtime\/sessions\/([^/]+)\/outputs$/.exec(route);
  if (outputs && method === "POST") {
    const form = await new Request("http://x/", { method: "POST", headers: { "content-type": input.contentType ?? "" }, body: input.bytes }).formData();
    const part = form.get("file") as Blob | null;
    const content = Buffer.from(part ? await part.arrayBuffer() : new ArrayBuffer(0));
    const id = `file_${randomUUID().slice(0, 8)}`;
    st.outputs.push({ id, session: decodeURIComponent(outputs[1]!), path: String(form.get("path")), content });
    return reply(201, { id, path: String(form.get("path")), bytes: content.length });
  }
  const memories = /^runtime\/memory-stores\/([^/]+)\/memories$/.exec(route);
  if (memories) {
    const store = st.memories.get(decodeURIComponent(memories[1]!));
    if (!store) return reply(404, { error: { code: "cave_not_found", message: "This session did not attach that store." } });
    if (method === "GET") {
      // A page of at most `limit` after `after`, with content when asked (C2-3).
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const after = url.searchParams.get("after") ?? "";
      const page = [...store].sort(([a], [b]) => a.localeCompare(b)).filter(([path]) => path > after).slice(0, limit);
      const content = url.searchParams.get("include_content") === "true";
      const next = page.length === limit ? page.at(-1)![0] : null;
      return reply(200, { memories: page.map(([path, m]) => ({ path, sha256: m.sha256, ...(content ? { content: m.content } : {}) })), next_cursor: next });
    }
    if (method === "PUT") {
      const path = String(body.path);
      const current = store.get(path);
      const stale = body.if_sha256 === "" ? current !== undefined : body.if_sha256 !== undefined && current?.sha256 !== body.if_sha256;
      if (stale) return reply(409, { error: { code: "cave_conflict", message: "The memory changed since it was read." } });
      const content = String(body.content);
      store.set(path, { content, sha256: sha256Hex(content) });
      return reply(200, { path, content, sha256: sha256Hex(content) });
    }
    if (method === "DELETE") {
      store.delete(url.searchParams.get("path") ?? "");
      return reply(204);
    }
  }
  const runState = /^runtime\/workspaces\/([^/]+)\/run-state$/.exec(route);
  if (runState && method === "PUT") {
    const workspace = decodeURIComponent(runState[1]!);
    if (st.runStateDown !== undefined) return reply(st.runStateDown, { error: { code: "cave_unavailable", message: "down" } });
    // SetRunState: a parked tree stays parked, and the runtime hears so.
    if ([...st.budgets.values()].some((b) => b.workspace === workspace && b.parked)) {
      return reply(409, { error: { code: "cave_code_tree_parked", message: "The tree's budget is spent: it is parked until a person raises the limit." } });
    }
    st.runStates.push({ workspace, run_state: String(body.run_state) });
    if (st.runStateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, st.runStateDelayMs));
    return reply(200, { id: runState[1], run_state: body.run_state });
  }
  // ReportUsage (code/tree.go): each call once per (session, request_id); a measured cost charges the session's tree
  // budget, which parks (and its workspace's run state with it) once the spend reaches the limit.
  if (route === "runtime/usage" && method === "POST") {
    const list = (body.events as Array<(typeof st.usage)[number] & { cost: { usd: number; basis: string } | null }>) ?? [];
    if (list.length === 0 || list.length > 100) return reply(400, { error: { code: "cave_bad_request", message: "events holds 1 to 100 usage events." } });
    let accepted = 0;
    let duplicates = 0;
    const charged = new Map<string, { workspace: string; limit_usd: number; spent_usd: number; parked: boolean }>();
    for (const event of list) {
      if (st.usage.some((u) => u.session_id === event.session_id && u.request_id === event.request_id)) {
        duplicates++;
        continue;
      }
      st.usage.push(event);
      accepted++;
      const budget = st.budgets.get(event.session_id);
      if (budget === undefined || event.cost === null || event.cost.usd <= 0) continue;
      budget.spent_usd += event.cost.usd;
      if (!budget.parked && budget.spent_usd >= budget.limit_usd) {
        budget.parked = true;
        st.runStates.push({ workspace: budget.workspace, run_state: "parked" });
      }
      charged.set(event.session_id, budget);
    }
    const budgets = [...charged].map(([session, b]) => ({ tree_id: `tree-${session}`, limit_usd: b.limit_usd, spent_usd: b.spent_usd, parked: b.parked, parked_at: b.parked ? new Date(input.now).toISOString() : null }));
    return reply(200, { accepted, duplicates, refused: [], budgets });
  }
  return false;
}

/**
 * Cloud's routes for an automation run its computer hosts (platform CONTRACT §7, CONTRACT-CHANGES A2/C3): the
 * revision by id, the outputs it posts (Slack, Linear, Jira; one per idempotency key) and its run record.
 */
export function automationsState() {
  return {
    /** Revisions by id: the files the apply sent and their digest. */
    revisions: new Map<string, { files: Record<string, string>; sha256: string }>(),
    outputs: [] as Array<{ session_id: string; kind: string; target: string; body: string; idempotency_key: string }>,
    runs: [] as Array<{ session_id: string; automation_id: string; record: Record<string, unknown> }>,
    /** Pull requests opened (CORRECTNESS C1), one per head; `/runtime/pull-requests` checks the head was pushed when the git proxy serves a repository. */
    pullRequests: [] as Array<{ session_id: string; repo: string; head: string; base: string; sha: string; title: string; body: string; draft: boolean; idempotency_key: string; number: number }>,
    comments: [] as Array<{ session_id: string; repo: string; issue_number?: number; commit_sha?: string; body: string; marker: string; idempotency_key: string; id: number }>,
    wakeAts: [] as Array<{ workspace: string; at: string | null }>,
    /** Answer this many run records with a 503 before taking one (a control-api restart). */
    runsDown: 0,
    /** Repositories whose pull request GitHub refuses for now, with what it says (Cloud's 422). */
    refusePullRequests: new Map<string, string>(),
  };
}

/** The refs a git-receive-pack request moves: its command lines ("<old> <new> <ref>", pkt-lines) up to the flush before the pack. */
export function pushedRefs(body: Buffer): Array<string> {
  const refs: Array<string> = [];
  for (let at = 0; at + 4 <= body.length; ) {
    const length = Number.parseInt(body.subarray(at, at + 4).toString("latin1"), 16);
    if (!Number.isFinite(length) || length === 0) break;
    if (length < 4) {
      at += 4;
      continue;
    }
    const line = body.subarray(at + 4, at + length).toString("utf8");
    const command = /^[0-9a-f]{40,64} [0-9a-f]{40,64} ([^\0\n]+)/.exec(line);
    if (command) refs.push(command[1]!);
    at += length;
  }
  return refs;
}

/** Cloud's git proxy as git sees it: `git http-backend` over bare repositories, pushes to caveman/ branches allowed. */
function gitHttpBackend(root: string, request: http.IncomingMessage, url: URL, bytes: Buffer, response: http.ServerResponse) {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : "";
  };
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "caveman-runtime",
      REMOTE_ADDR: "127.0.0.1",
      PATH_INFO: url.pathname.slice("/relay/v1/git".length),
      REQUEST_METHOD: request.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: header("content-type"),
      CONTENT_LENGTH: String(bytes.length),
      ...(header("content-encoding") ? { HTTP_CONTENT_ENCODING: header("content-encoding") } : {}),
      ...(header("git-protocol") ? { GIT_PROTOCOL: header("git-protocol") } : {}),
    },
  });
  const out: Array<Buffer> = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  // git may answer and exit before it reads the body (a GET has none to read): the write then fails with EPIPE,
  // which says nothing its answer does not.
  child.stdin.on("error", () => {});
  child.stdin.end(bytes);
  child.on("close", () => {
    const all = Buffer.concat(out);
    const crlf = all.indexOf("\r\n\r\n");
    const end = crlf !== -1 ? crlf : all.indexOf("\n\n");
    const head = all.subarray(0, end).toString("utf8").split(/\r?\n/);
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]) || 200;
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(all.subarray(end + (crlf !== -1 ? 4 : 2)));
  });
}

function automationRoutes(
  st: ReturnType<typeof automationsState>,
  input: { method: string; url: URL; body: Record<string, unknown>; runtime: boolean; gitBackend: string | undefined },
  reply: (status: number, body: unknown) => void,
): boolean {
  const route = input.url.pathname.slice("/api/v1/code/runtime/".length);
  const revision = /^automations\/revisions\/([^/]+)$/.exec(route);
  const wake = /^workspaces\/([^/]+)\/wake-at$/.exec(route);
  if (revision === null && wake === null && !["outputs", "runs", "pull-requests", "comments"].includes(route)) return false;
  if (!input.runtime) return (reply(401, { error: { code: "cave_unauthorized", message: "cave_unauthorized" } }), true);
  if (revision !== null && input.method === "GET") {
    const found = st.revisions.get(decodeURIComponent(revision[1]!));
    return (found ? reply(200, found) : reply(404, { error: { code: "cave_not_found", message: "No such revision." } }), true);
  }
  if (route === "outputs" && input.method === "POST") {
    const output = input.body as (typeof st.outputs)[number];
    const index = st.outputs.findIndex((o) => o.idempotency_key === output.idempotency_key);
    if (index === -1) st.outputs.push(output);
    const n = index === -1 ? st.outputs.length : index + 1;
    return (reply(200, { url: `https://slack.example/archives/${output.target}/p${n}`, remote_id: `${n}` }), true);
  }
  if (route === "runs" && input.method === "POST") {
    if (st.runsDown > 0) {
      st.runsDown -= 1;
      return (reply(503, { error: { code: "cave_unavailable", message: "control-api is restarting" } }), true);
    }
    st.runs.push(input.body as (typeof st.runs)[number]);
    return (reply(200, { accepted: true }), true);
  }
  if (route === "pull-requests" && input.method === "POST") {
    const pr = input.body as Omit<(typeof st.pullRequests)[number], "number">;
    if (!pr.head.startsWith("caveman/")) return (reply(403, { error: { code: "cave_code_head_not_allowed", message: "Only caveman/* heads." } }), true);
    if (input.gitBackend !== undefined) {
      // As Cloud's App would find it on GitHub: the head is there, at the checked commit.
      const at = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${pr.head}`], { cwd: `${input.gitBackend}/${pr.repo}.git`, encoding: "utf8" }).stdout.trim();
      if (at !== pr.sha) return (reply(422, { error: { code: "cave_code_head_missing", message: `${pr.head} is not at ${pr.sha} on GitHub.` } }), true);
    }
    const refused = st.refusePullRequests.get(pr.repo);
    if (refused !== undefined) return (reply(422, { error: { code: "cave_code_pull_request_refused", message: refused } }), true);
    const open = st.pullRequests.find((p) => p.repo === pr.repo && p.head === pr.head);
    if (open !== undefined) Object.assign(open, { title: pr.title, body: pr.body, sha: pr.sha });
    const number = open?.number ?? 100 + st.pullRequests.length;
    if (open === undefined) st.pullRequests.push({ ...pr, number });
    return (reply(200, { url: `https://github.com/${pr.repo}/pull/${number}`, number }), true);
  }
  if (route === "comments" && input.method === "POST") {
    const comment = input.body as Omit<(typeof st.comments)[number], "id">;
    const mine = st.comments.find((c) => c.repo === comment.repo && c.issue_number === comment.issue_number && c.commit_sha === comment.commit_sha && c.marker === comment.marker);
    if (mine !== undefined) mine.body = comment.body;
    const id = mine?.id ?? 9000 + st.comments.length;
    if (mine === undefined) st.comments.push({ ...comment, id });
    return (reply(200, { url: `https://github.com/${comment.repo}/issues/${comment.issue_number ?? 0}#issuecomment-${id}`, id }), true);
  }
  if (wake !== null && input.method === "PUT") {
    st.wakeAts.push({ workspace: decodeURIComponent(wake[1]!), at: typeof input.body.at === "string" ? input.body.at : null });
    return (reply(200, { at: input.body.at ?? null }), true);
  }
  return false;
}

// ------------------------------------------------------------------ chat sync (Caveman Cloud the spec)

/** A journal segment as the stand-in recorded it: its range, and its body decoded. */
export interface TestSegment {
  readonly n: number;
  readonly epoch: number;
  readonly from: number;
  readonly through: number;
  readonly boundary: boolean;
  /** Bytes as sent (gzip when the runtime gzipped it). */
  readonly bytes: number;
  readonly gzip: boolean;
  /** The body as sent, so a reader gets back what was written. */
  readonly raw: Buffer;
  readonly body: Record<string, unknown>;
  readonly events: ReadonlyArray<CopiedEvent>;
}

/** One of a workspace's other repositories, as Cloud's row holds it. */
export interface TestCheckout {
  readonly repo: string;
  readonly base_branch: string;
  readonly branch: string;
}

export interface TestChatSession {
  readonly session_id: string;
  readonly workspace_id: string;
  computer_id: string;
  engine: string;
  repo: string;
  /** The other repositories of its project the chat works in (CONTRACT §7 of cloud-computers-2026-11-09); absent for a chat in one. */
  checkouts?: Array<TestCheckout>;
  follow: boolean;
  /** Who the chat belongs to (the runtime's enroller, or the Cloud computer's creator). */
  readonly person: string;
  epoch: number;
  cursor_seq: number;
  /** Counted segments (PUT journal counts the one just written); `pending` holds slot `segments` until then. */
  segments: Array<TestSegment>;
  pending?: TestSegment;
  /** Chunks of the copy's large parts by sha256: they go with the copy. */
  blobs?: Map<string, Buffer>;
  size_bytes: number;
  lease: { runtime_id: string; token: string; expires_at: number } | null;
  /** Where the lid moved it from (S12 auto-return). */
  returns_to?: string;
  /** Its most recent move: the computer it left, the epoch that move made, when, and how many calls its source forwarded since. */
  last_move?: { readonly from_runtime_id: string | undefined; readonly epoch: number; readonly at: number; forwarded: number };
  /** Its runtime registered it to follow (RegisterSession): only such a chat moves (M-4); one a summary registered syncs only. */
  movable_flag?: boolean;
  /** As its runtime last registered it: what the list of a computer's chats names (CONTRACT §5.2). */
  title?: string;
  base_branch?: string;
  branch?: string;
  /** Cloud is asking Cloud computers to take it while its Mac sleeps (MoveQuiet's accept step), or none had room until then. */
  placing?: boolean;
  place_after?: number;
}

export interface TestCall {
  readonly id: string;
  readonly session_id: string;
  readonly person: string;
  readonly request_id: string;
  readonly method: QueuedMethod;
  readonly params: Record<string, unknown>;
  readonly params_key: string;
  status: CallState["status"];
  readonly created_at: number;
  result?: unknown;
  error?: { code: string; message: string };
  /** `code`, with not_movable: why the chat cannot move, in the codes a chat's `stays` uses (Caveman Cloud waitingCode). */
  waiting?: { reason: "laptop_asleep" | "not_movable"; detail: string; code?: string };
  mail_id?: string;
  /**
   * When a runtime last took the mail carrying it (epoch ms). One that took it and died, or let it follow its chat,
   * hands it on once its lease runs out, so only the last take says when it last reached a runtime.
   */
  taken_at?: number;
  readonly device_id?: string;
  readonly device?: { readonly device_id: string; readonly at: string; readonly signature: string };
  /** The runtime that forwarded it: input its source accepted that the copy a move went from lacked (CHAOS-14). */
  readonly forwarded_by_runtime_id?: string;
}

/**
 * Cloud's chat sync (CONTRACT §1-§3, S12): every synced chat's copy (journal segments with epoch and range, the
 * lease, the epoch bump), the summaries a runtime writes, the person's list and its SSE stream, copy reads, person
 * state, queued calls delivered as mail on channel `call`, person moves and the lid's handoff. One org; persons by
 * bearer (`personToken` is `user-1`; `addPerson` makes another for refusal tests).
 */
export function chatsState() {
  const st = {
    seq: 0,
    sessions: new Map<string, TestChatSession>(),
    summaries: new Map<string, ChatSummaryInput & { runtime_id: string; computer_id: string; seq: number }>(),
    person: new Map<string, { seen_cursor: number; pinned: boolean; done_at?: string; snoozed_until?: string }>(),
    calls: new Map<string, TestCall>(),
    /** Computers by id: a laptop unless a test marks it a Cloud computer (markCloud). */
    /** sleep_reason "usage": asleep because nothing paid for its time (Caveman Cloud registry.go Computer.SleepReason). */
    /** resets_at: when the plan resets, said beside a sleep for usage (a computer's `resets_at`, a chat's `where.resets_at`). */
    computers: new Map<string, { kind: "laptop" | "cloud"; name: string; person: string; state: "running" | "starting" | "suspended" | "stopped" | "deleted"; image_current?: boolean; sleep_reason?: "usage"; resets_at?: string; disk_lost_at?: string; disk_lost_reason?: string }>(),
    /** Each change the stream sends, in seq order; `retain` bounds the window a stream may resume from. */
    changes: [] as Array<{ seq: number; event: "chat" | "gone" | "runtime"; key: string; person: string }>,
    retain: 1000,
    keepaliveMs: 25_000,
    streams: new Set<{ person: string; write: (event: string, data: unknown, seq: number) => void; close: () => void }>(),
    /** Lease TTL (S12: 90 s while a turn runs). */
    leaseTtlMs: 90_000,
    /** A runtime is online while its last heartbeat is this recent. */
    onlineMs: 75_000,
    /** A Cloud from before asked_by_session_id: a summary naming it is refused (400), as its strict decoder would. */
    askedByUnknown: false,
    /** A Cloud from before a pull's stop (decision 32): a pull carrying one is refused (400), as its strict decoder would. */
    pullStopUnknown: false,
    /** A Cloud from before placed_workspace_id: a registration or a summary naming it is refused (400), as its strict decoder would. */
    placedUnknown: false,
    /** A Cloud from before movable, stays and moving (CONTRACT §11): a summary naming one is refused (400), as its strict decoder would. */
    placeFactsUnknown: false,
    /** Cloud's own moves that are open (its code_session_moves): where each chat is on its way to, and since when. */
    openMoves: new Map<string, { readonly to_computer_id: string; readonly since: string }>(),
    /**
     * The workspaces Cloud placed for chats their runtimes have yet to start (POST workspaces, CONTRACT §6.3), by id:
     * the computer each is on, and the session that took it up. A test places them, as a person's client would.
     */
    placements: new Map<string, { readonly computer_id: string; taken?: string }>(),
    /**
     * A Cloud from before queued starts (CONTRACT §6.8): a placement that carries `start` is refused (400), as its
     * strict decoder would, and the same placement without it is made as before.
     */
    startUnknown: false,
    /** Every placement a person or their Mac's runtime asked for (POST workspaces, runtime/workspaces), as sent. */
    placeRequests: [] as Array<{ readonly person: string; readonly by: "person" | "runtime"; readonly body: Record<string, unknown> }>,
    /** Computers that are full by Cloud's count: a chat nobody placed registers there as 409 cave_code_computer_full. */
    fullComputers: new Set<string>(),
    /** What each chat's first registration said of its placement, in order ("absent": it said nothing). */
    placedAsked: [] as Array<{ session_id: string; placed: string; by: "register" | "summary" }>,
    /**
     * Projects, as `code_project_repos` holds them: each repository (owner/name) with the project it belongs to. A
     * workspace's checkouts are repositories of its own repository's project (CONTRACT §7).
     */
    projectRepos: new Map<string, string>(),
    /**
     * What a person started on a Cloud computer (POST workspaces with `checkouts`), by computer: the chat its runtime
     * registers there next takes these, whatever the runtime's own request says.
     */
    placed: new Map<string, { repo: string; checkouts: Array<TestCheckout> }>(),
    /** Every write of a session's checkouts a runtime asked for, taken or refused. */
    checkoutWrites: [] as Array<{ session_id: string; runtime_id: string; checkouts: ReadonlyArray<TestCheckout>; refused?: string }>,
    /**
     * The git proxy serves a Cloud computer only the repositories its workspaces check out in these rows (CONTRACT §1
     * and §7), and Cloud opens a pull request for one of them only. Off: any repository, as before checkouts.
     */
    gitScoped: false,
    /** The repositories the scoped git proxy refused, by computer. */
    gitOutOfScope: [] as Array<{ computer_id: string; repo: string }>,
    /** A Cloud from before the list of a computer's chats (CONTRACT §5.2): GET runtime/sessions answers 404. */
    sessionsHereUnknown: false,
    /** Every read of that list, by the runtime that asked. */
    sessionsHereReads: [] as Array<{ runtime_id: string; computer_id: string }>,
    /** Fault injection: answer this status on the named route kind until cleared. */
    down: {} as Partial<Record<"segments" | "journal" | "summaries" | "results" | "forward" | "wait" | "register", number>>,
    /** A Cloud, or a proxy in front of it, that answers the computer's long mail wait at once. */
    waitsAnswerAtOnce: false,
    /** Fault injection: a computer's next moves of a chat (POST .../move) answer these refusals, one each, in order. */
    refuseMoves: [] as Array<{ computerId: string; status: number; code: string; message: string }>,
    /** Fault injection: a computer's next reserves of a move (POST .../move-check that offers) answer these, one each, in order. */
    refuseReserves: [] as Array<{ computerId: string; status: number; code: string; message: string }>,
    /** One computer whose reads of a chat's copy fail (503): its adopt fails, as a broken target's would. */
    segmentReadsDownOn: undefined as string | undefined,
    /**
     * One computer whose reads of a chat's copy wait until `until` settles (an adopt held mid-way): every segment, or
     * those from `from` on. Settled with "down", the held reads then fail (503), as segmentReadsDownOn's do.
     */
    segmentReadsHeldOn: undefined as { readonly computer: string; readonly until: Promise<unknown>; readonly from?: number } | undefined,
    /** A Cloud without the copy's chunk routes (before the spec's addendum): they answer 404. */
    blobsOff: false,
    /** Chunks whose reads answer other bytes than were stored (a store that went wrong). */
    tamperBlobs: new Set<string>(),
    /** Fault injection: this many more new chunks are stored, then the next chunk's PUT answers 503, once. */
    blobPutsBeforeFailure: undefined as number | undefined,
    /** A stalled uplink: each chunk's PUT, its body read, waits until this settles before Cloud stores it and answers. */
    blobPutsHeld: undefined as Promise<unknown> | undefined,
    /** A slow uplink: each chunk's PUT, its body read, takes this long before Cloud stores it and answers. */
    blobPutMs: 0,
    /**
     * A slow uplink for a running turn's files: each segment PUT that is not a boundary's and carries work in progress,
     * its body read, waits until this settles (`waiting` counts those that did); a caller gone by then is answered nothing.
     */
    midWipPutsHeld: undefined as { readonly until: Promise<unknown>; waiting: number } | undefined,
    /** A slow uplink for every copy: each segment PUT waits until this settles (`waiting` counts them), holding its chat's move lock meanwhile. */
    segmentPutsHeld: undefined as { readonly until: Promise<unknown>; waiting: number } | undefined,
    /** Chats whose journal Cloud reads back one segment more than the last read, every time (a store gone wrong): no count here ever matches it. */
    journalReadsAstray: new Map<string, number>(),
    /** Fault injection: the next segment PUT of a running turn that carries work in progress answers this status, once. */
    midWipPutsDown: undefined as number | undefined,
    /** Bounds the stand-in holds a chat's chunks to (Cloud's: 8 MiB a chunk, 64 MiB a blob, 256 MiB and 1024 chunks a chat). */
    blobLimits: { chunk: 8 * 1024 * 1024, blob: 64 * 1024 * 1024, chat: 256 * 1024 * 1024, chunks: 1024 },
    /** Every chunk call: PUT, HEAD and GET, with the answer. */
    blobCalls: [] as Array<{ method: string; session_id: string; sha: string; status: number }>,
    /** One computer whose next accept answer is lost (500), as a blip loses it; cleared once it is. */
    acceptAnswerLostOn: undefined as string | undefined,
    /** Fault injection: this many more "I took it" answers (phase adopt, ok) answer 500, as a Cloud whose database is paused. */
    adoptAnswersLost: 0,
    /** A slow Cloud: the named route does its work, then answers this many ms later (a far core, a computer to wake). */
    delay: {} as Partial<Record<"handoff" | "move" | "summaries" | "journal" | "check" | "segments", number>>,
    /** Bodies Cloud's strict decoder refused (an unknown field, a wrong type), by route: each answered 400. */
    refused: [] as Array<{ route: string; why: string }>,
    /** Every segment write as sent, accepted or not (to watch splitting, retries, gzip). */
    segmentPuts: [] as Array<{ session_id: string; n: number; status: number; bytes: number; gzip: boolean; epoch?: number; from?: number; through?: number; boundary?: boolean; code?: string }>,
    summaryPuts: [] as Array<{
      session_id: string;
      batch: boolean;
      status: string;
      head: number;
      preview?: string;
      asked_by?: string;
      movable?: boolean;
      stays?: string;
      moving?: { readonly to: string; readonly waiting_turn: boolean; readonly since: string };
    }>,
    /** Hold a crash-recovery epoch response until a test releases it. */
    epochGate: undefined as Promise<void> | undefined,
    epochBumps: [] as Array<{ session_id: string; epoch: number; why: "move" | "rebuild" }>,
    handoffs: [] as Array<{ session_id: string; through: number; reason: string; moved: boolean }>,
    /**
     * A lid handoff of a working chat answers pending (a Cloud computer that is up was asked to take it, chats_moves.go
     * LidHandoffResult.pending), and Cloud hands the chat over this many ms later, as that computer's accept lands.
     */
    handoffPendingMs: undefined as number | undefined,
    /**
     * With handoffPendingMs: the Cloud computer that accepted the pending handoff fails its adopt with this, and Cloud
     * hands the chat back to its source under the pending move's id (chats_offers.go failMove).
     */
    handoffPendingFails: undefined as { readonly code?: string; readonly message?: string } | undefined,
    moveRequests: [] as Array<{ session_id: string; to: unknown; by: string; pending: boolean }>,
    /** Two-phase moves (CONTRACT-CHANGES A4 02:00): each move's target, source and the answers its target gave. */
    moves: new Map<string, TestMove>(),
    /** Answers still awaited, by move id (the accept step waits up to ACCEPT_WAIT_MS). */
    moveWaiters: new Map<string, (answer: MoveAnswer) => void>(),
    callResults: [] as Array<{ call_id: string; ok: boolean }>,
    /** Forwards Cloud refused (not_source, moved_again), as C1 logs them. */
    forwardRefusals: [] as Array<{ session_id: string; code: string }>,
    waits: [] as Array<{ runtime_id: string; channel: string }>,
    /** Chats a runtime deleted from Cloud (sync turned off). */
    deleted: [] as Array<string>,
    pullRequests: new Map<string, ChatPullRequest>(),
    /** Persons by bearer. */
    persons: new Map<string, string>(),
    /**
     * Each person's Cloud logins for Claude Agent and Codex (A4): a key in the vault, and the computers signed in to the
     * engine. A chat of those engines moves to a computer only with one (cave_code_engine_login_needed otherwise).
     */
    engineLogins: new Map<string, Partial<Record<"claude-agent" | "codex", { vault_key: boolean; signed_in_on: Array<string> }>>>(),
    moveChecks: [] as Array<{ session_id: string; to: unknown; login: string | null; code?: string }>,
    /** A move-check blocked before replying: deterministic crash-window barrier. */
    moveChecksPending: 0,
    lastHeartbeat: new Map<string, number>(),
    /** Runtimes whose last heartbeat said they are going to sleep (code_runtimes.suspending_at). */
    suspending: new Set<string>(),
    /** What the stream last said of each runtime (sweepRuntimes): online and computer state. */
    runtimeSaid: new Map<string, string>(),
    /** Set by startTestCloud: the mailbox, the runtimes' computers and the clock. */
    link: undefined as
      | undefined
      | {
          now: () => number;
          post: (mail: { verb: string; authority: string; to_workspace_id: string; to_computer_id?: string; body?: string; channel?: string }) => string;
          runtimesOf: (computerId: string) => ReadonlyArray<string>;
          computerOf: (runtimeId: string) => string | undefined;
          relayUp: (runtimeId: string) => boolean;
          nudge: () => void;
          /** The run state its runtime last reported for a workspace (PUT runtime/workspaces/{id}/run-state). */
          runStateOf?: (workspaceId: string) => string | undefined;
        },
    /** A Cloud computer of `person` (or a new one with no runtime yet): where moves to "cloud" go. */
    cloudComputerFor: (person: string, except?: string): string => {
      for (const [id, c] of st.computers) if (c.kind === "cloud" && c.person === person && id !== except && c.state !== "deleted") return id;
      const id = randomUUID();
      st.computers.set(id, { kind: "cloud", name: "Cloud computer", person, state: "starting" });
      return id;
    },
    /** Marks a computer as a Cloud computer (the stand-in enrolls every runtime as a laptop). */
    markCloud: (computerId: string, name = "Cloud computer") => {
      const c = st.computers.get(computerId);
      st.computers.set(computerId, { kind: "cloud", name, person: c?.person ?? "user-1", state: "running" });
    },
    addPerson: (userId: string) => {
      const token = `person-${randomBytes(8).toString("hex")}`;
      st.persons.set(token, userId);
      return token;
    },
    /** The copy Cloud serves for a chat: every counted segment's events, in cursor order. */
    copyOf: (sessionId: string) => {
      const s = st.sessions.get(sessionId);
      const events = new Map<number, CopiedEvent>();
      for (const segment of s?.segments ?? []) for (const event of segment.events) events.set(event.cursor, event);
      return [...events.values()].sort((a, b) => a.cursor - b.cursor);
    },
  };
  return st;
}
export type ChatsState = ReturnType<typeof chatsState>;

const gunzipCapped = (bytes: Buffer) => gunzipSync(bytes, { maxOutputLength: SEGMENT_MAX_DECOMPRESSED_BYTES });
const isGzip = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** A segment's events as Cloud's copy holds them: v2 bodies carry {cursor, type, at, event}; v1 the events whole. */
const copiedEvents = (body: Record<string, unknown>): Array<CopiedEvent> =>
  ((body.events as Array<Record<string, unknown>> | undefined) ?? []).map((e) =>
    "event" in e && typeof e.event === "object" ? (e as unknown as CopiedEvent) : ({ cursor: Number(e.cursor), type: String(e.type), at: String(e.at), event: e } as unknown as CopiedEvent),
  );

/** Undelivered call mail and person state ride along on every summary a device reads. */
function summaryOf(st: ChatsState, sessionId: string): ChatSummary | undefined {
  const s = st.summaries.get(sessionId);
  const session = st.sessions.get(sessionId);
  if (s === undefined || session === undefined) return undefined;
  const computer = st.computers.get(session.computer_id);
  const person = st.person.get(sessionId) ?? { seen_cursor: 0, pinned: false };
  const copy = st.copyOf(sessionId);
  const calls = [...st.calls.values()]
    .filter((c) => c.session_id === sessionId && (c.status === "queued" || c.status === "delivered"))
    .map((c) => callStateOf(c));
  const { movable: _movable, stays: _stays, moving: _moving, ...said } = s;
  const asleepForUsage = computer?.kind === "cloud" && computer.state === "suspended" && computer.sleep_reason === "usage";
  return {
    ...said,
    // As Cloud lists it: the runtime the chat's computer runs as now, the one seen last; none for a computer with no
    // runtime yet, and none while a Cloud computer is not asked to run (CONTRACT §11).
    runtime_id: cloudAsleep(computer) ? null : liveRuntimeOf(st, session.computer_id),
    computer_id: session.computer_id,
    sync: session.follow,
    where: {
      kind: computer?.kind ?? "laptop",
      name: computer?.name ?? "This Mac",
      ...(asleepForUsage ? { sleep_reason: "usage" as const, ...(computer.resets_at ? { resets_at: computer.resets_at } : {}) } : {}),
    },
    epoch: session.epoch,
    synced_through: copy.at(-1)?.cursor ?? 0,
    person,
    calls,
    seq: s.seq,
    ...placeFactsOf(st, s, session),
  } as ChatSummary;
}

/** A Cloud computer that is not asked to run has no runtime (Caveman Cloud place_facts.go runtimeListed). */
const cloudAsleep = (computer: { readonly kind: "laptop" | "cloud"; readonly state: string } | undefined) =>
  computer?.kind === "cloud" && computer.state !== "running" && computer.state !== "starting";

/**
 * What Cloud tells every device of where a chat can run and where it is going (Caveman Cloud place_facts.go fill).
 * Movable is the runtime's word, narrowed by Cloud's own: a chat not registered to move stays, whatever its runtime
 * said. Moving is Cloud's own open move, else the one the chat's runtime reported, read against Cloud's computers (a
 * Mac of the chat's person by its id, a Cloud computer of theirs as "cloud", any other not at all) and only while
 * that runtime is the one heard on the chat's computer.
 */
function placeFactsOf(st: ChatsState, s: ChatSummaryInput & { runtime_id: string }, session: TestChatSession) {
  const out: { movable?: boolean; stays?: { code: string }; moving?: { to: string; waiting_turn: boolean; since: string } } = {};
  if (s.movable !== undefined) {
    const movable = s.movable && session.movable_flag === true;
    out.movable = movable;
    if (!movable) out.stays = { code: s.movable ? "not_saved" : (s.stays?.code ?? "other") };
  }
  if (s.archived) return out;
  const target = (computerId: string) => {
    const computer = st.computers.get(computerId);
    return computer === undefined || computer.person !== session.person ? undefined : computer.kind === "cloud" ? "cloud" : computerId;
  };
  const own = st.openMoves.get(session.session_id);
  const now = st.link?.now() ?? Date.now();
  const heard = st.link?.computerOf(s.runtime_id) === session.computer_id && now - (st.lastHeartbeat.get(s.runtime_id) ?? -Infinity) < st.onlineMs;
  if (own !== undefined) {
    const to = target(own.to_computer_id) ?? "cloud";
    out.moving = { to, waiting_turn: false, since: own.since };
  } else if (s.moving !== undefined && heard) {
    const to = s.moving.to === "cloud" ? "cloud" : target(s.moving.to);
    if (to !== undefined) out.moving = { to, waiting_turn: s.moving.waiting_turn, since: s.moving.since };
  }
  return out;
}

/** The runtime on `computerId` heard from last, as Cloud's summary names it; null when there is none. */
function liveRuntimeOf(st: ChatsState, computerId: string): string | null {
  const runtimes = [...(st.link?.runtimesOf(computerId) ?? [])];
  runtimes.sort((a, b) => (st.lastHeartbeat.get(b) ?? 0) - (st.lastHeartbeat.get(a) ?? 0));
  return runtimes[0] ?? null;
}

function callStateOf(c: TestCall): CallState & { waiting?: TestCall["waiting"] } {
  return {
    id: c.id,
    request_id: c.request_id,
    method: c.method,
    status: c.status,
    created_at: new Date(c.created_at).toISOString(),
    ...(c.result !== undefined ? { result: c.result } : {}),
    ...(c.error !== undefined ? { error: c.error } : {}),
    ...(c.waiting !== undefined ? { waiting: c.waiting } : {}),
  };
}

/** One change for the person's streams: the summary's seq moves on, and every open stream of that person hears it. */
function bump(st: ChatsState, sessionId: string, event: "chat" | "gone" = "chat") {
  const s = st.summaries.get(sessionId);
  const session = st.sessions.get(sessionId);
  if (s === undefined || session === undefined) return;
  s.seq = ++st.seq;
  st.changes.push({ seq: s.seq, event, key: sessionId, person: session.person });
  if (st.changes.length > st.retain) st.changes.splice(0, st.changes.length - st.retain);
  const data = event === "gone" ? { session_id: sessionId } : summaryOf(st, sessionId);
  for (const stream of st.streams) if (stream.person === session.person) stream.write(event, data, s.seq);
}

/**
 * The repositories a computer reaches, by Cloud's rows (CONTRACT §1 and §7): each chat on it that is not archived,
 * its `repo` and its checkouts, and what a person started there that no chat has taken up yet. Lower-case owner/name.
 */
export function reposOf(st: Pick<ChatsState, "sessions" | "summaries" | "placed">, computerId: string): Set<string> {
  const repos = new Set<string>();
  for (const session of st.sessions.values()) {
    if (session.computer_id !== computerId || st.summaries.get(session.session_id)?.archived === true) continue;
    repos.add(session.repo.toLowerCase());
    for (const checkout of session.checkouts ?? []) repos.add(checkout.repo.toLowerCase());
  }
  const started = st.placed.get(computerId);
  if (started !== undefined) {
    repos.add(started.repo.toLowerCase());
    for (const checkout of started.checkouts) repos.add(checkout.repo.toLowerCase());
  }
  return repos;
}

function runtimeStateOf(st: ChatsState, runtimeId: string, now: number): RuntimeState | undefined {
  const computerId = st.link?.computerOf(runtimeId);
  if (computerId === undefined) return undefined;
  const computer = st.computers.get(computerId);
  const seen = st.lastHeartbeat.get(runtimeId);
  return {
    runtime_id: runtimeId,
    computer_id: computerId,
    kind: computer?.kind ?? "laptop",
    name: computer?.name ?? "This Mac",
    online: seen !== undefined && now - seen < st.onlineMs && (st.link?.relayUp(runtimeId) ?? false),
    ...(computer?.kind === "cloud" ? { computer_state: computer.state } : {}),
    // As Cloud's ListChats sends it (RuntimeState.LastSeenAt, a *time.Time): null until the runtime's first heartbeat.
    last_seen_at: seen === undefined ? null : new Date(seen).toISOString(),
    ...(computer?.image_current !== undefined ? { image_current: computer.image_current } : {}),
  };
}

/**
 * C1's runtime sweep (CONTRACT §3: "a 30 s sweep emits transitions"): each runtime whose online flag or computer state
 * changed since the stream last said goes out as a `runtime` event to its person's streams. Tests call it when they
 * want devices to hear (the chaos harness every 250 ms); nothing calls it by itself.
 */
export function sweepRuntimes(st: ChatsState, now: number): void {
  for (const [computerId, computer] of st.computers) {
    for (const runtimeId of st.link?.runtimesOf(computerId) ?? []) {
      const runtime = runtimeStateOf(st, runtimeId, now);
      if (runtime === undefined) continue;
      const said = `${runtime.online}:${runtime.computer_state ?? ""}`;
      if (st.runtimeSaid.get(runtimeId) === said) continue;
      st.runtimeSaid.set(runtimeId, said);
      const seq = ++st.seq;
      st.changes.push({ seq, event: "runtime", key: runtimeId, person: computer.person });
      if (st.changes.length > st.retain) st.changes.splice(0, st.changes.length - st.retain);
      for (const stream of st.streams) if (stream.person === computer.person) stream.write("runtime", runtime, seq);
    }
  }
}

/** Whether a computer's runtime is up, as Cloud's runtimeUp has it: heard within onlineMs, and not going to sleep. */
const computerUp = (st: ChatsState, computerId: string, now: number) =>
  (st.link?.runtimesOf(computerId) ?? []).some((r) => now - (st.lastHeartbeat.get(r) ?? -Infinity) < st.onlineMs && !st.suspending.has(r));
/**
 * A move to one of the person's Macs by computer id whose runtime is not up: refused before anything is offered (C1
 * targetComputer), as a Mac takes a chat only on its own word and Cloud never accepts for it. A runtime id is not asked.
 */
const macAway = (st: ChatsState, to: unknown, target: string, now: number) =>
  typeof to === "object" && to !== null && "computer_id" in to && st.computers.get(target)?.kind === "laptop" && !computerUp(st, target, now);
const TARGET_SILENT = "The computer the chat would move to did not answer: try again, or move it elsewhere.";
const SOURCE_ASLEEP = "The chat's Mac is not up: a chat moves to another Mac only from its own Mac while that Mac is up. Wake it, then move the chat again.";

/** Whether the runtime holding a chat is reachable by mail right now (a recent heartbeat). */
const ownerAwake = (st: ChatsState, session: TestChatSession, now: number) =>
  (st.link?.runtimesOf(session.computer_id) ?? []).some((r) => now - (st.lastHeartbeat.get(r) ?? -Infinity) < st.onlineMs);

const leaseLive = (session: TestChatSession, now: number) => session.lease !== null && session.lease.expires_at > now;

/** Whether a chat can continue on a Cloud computer: its runtime registered it to follow, its repository is on GitHub and it copied something. */
const movable = (session: TestChatSession) => session.movable_flag === true && /^[\w.-]+\/[\w.-]+$/.test(session.repo) && session.segments.length > 0;

/** A copy purged (sync or follow off): Cloud keeps the epoch and starts the copy again from cursor 1. */
function purge(session: TestChatSession) {
  session.segments = [];
  session.blobs?.clear();
  delete session.pending;
  session.size_bytes = 0;
  session.cursor_seq = 0;
}

/** Sync off for a chat (DELETE, or a summary with sync false): its copy, summary and marks leave; the session stays registered. */
function unsync(st: ChatsState, session: TestChatSession) {
  session.follow = false;
  delete session.movable_flag;
  purge(session);
  if (st.summaries.has(session.session_id)) bump(st, session.session_id, "gone");
  st.summaries.delete(session.session_id);
  st.person.delete(session.session_id);
}

/**
 * The bodies Cloud's chat routes decode, field by field (moves.go SessionRegistration, MoveInput; runtime.go
 * JournalUpdate; chats_moves.go LidHandoffInput, PersonMoveInput; chats.go ChatSummaryInput, PersonStateInput;
 * chat_calls.go CallInput, CallResultInput). Cloud decodes strictly (httpx.DecodeJSON, DisallowUnknownFields): an
 * unknown field or a value of the wrong type is a 400 "Invalid JSON.", and so it is here.
 */
const SUMMARY_INPUT: Readonly<Record<string, FieldKind>> = {
  session_id: "string",
  workspace_id: "string",
  title: "string",
  engine: "string",
  model: "string",
  repo: "string",
  branch: "string",
  base_branch: "string",
  kind: "string",
  parent_session_id: "string",
  asked_by_session_id: "string",
  status: "string",
  needs_you: { kind: "string", summary: "string" },
  last_activity_at: "time",
  preview: "string",
  epoch: "int",
  head: "int",
  archived: "bool",
  sync: "bool",
  pull_request: "raw",
  placed_workspace_id: "string",
  movable: "bool",
  stays: { code: "string" },
  moving: { to: "string", waiting_turn: "bool", since: "time" },
};
/** The fields a Cloud from before them does not take (chatsState's placeFactsUnknown). */
const PLACE_FACT_FIELDS = new Set(["movable", "stays", "moving"]);
const STAYS_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_INPUTS = {
  register: { title: "string", repo: "string", base_branch: "string", branch: "string", engine: "string", follow: "bool", placed_workspace_id: "string" },
  journal: { lease_token: "string", cursor_seq: "int", segments: "int", size_bytes: "int", release: "bool" },
  epoch: { lease_token: "string" },
  handoff: { through: "int", reason: "string", move_id: "string" },
  move_check: { to: "target", reason: "string", offer: "bool", request_id: "string", device: { device_id: "string", at: "string", signature: "string" } },
  move: { to: "target", reason: "string", move_id: "string", request_id: "string", device: { device_id: "string", at: "string", signature: "string" } },
  move_answer: { phase: "string", ok: "bool", code: "string", message: "string" },
  summary: SUMMARY_INPUT,
  summaries: { chats: [SUMMARY_INPUT] },
  result: { ok: "bool", result: "raw", error: { code: "string", message: "string" } },
  state: { seen_cursor: "int", pinned: "bool", done: "bool", snoozed_until: "raw" },
  call: { request_id: "string", method: "string", params: "raw", device: { device_id: "string", at: "string", signature: "string" }, device_id: "string" },
  forward: { request_id: "string", method: "string", params: "raw" },
  person_move: { to: "target", request_id: "string", device: { device_id: "string", at: "string", signature: "string" } },
  pull: { to: "target", request_id: "string", device: { device_id: "string", at: "string", signature: "string" }, stop: { request_id: "string", device: { device_id: "string", at: "string", signature: "string" } } },
} satisfies Record<string, Readonly<Record<string, FieldKind>>>;
/** A Cloud from before a pull's stop (chatsState.pullStopUnknown). */
const { stop: _stop, ...OLDER_PULL_INPUT } = CHAT_INPUTS.pull;

/**
 * Moves a chat to `computerId` as Cloud's move transaction does: the workspace goes there, the epoch moves on, the
 * lease is dropped, and the workspace gets the adopt mail (channel "move") its runtime takes.
 */
function moveChat(
  st: ChatsState,
  session: TestChatSession,
  computerId: string,
  reason: "lid" | "user" | "asleep" | "reassigned",
  fromRuntime: string | undefined,
  extra: { readonly move_id?: string; readonly asked?: Record<string, unknown> } = {},
) {
  const from = session.computer_id;
  if (extra.move_id !== undefined) {
    const move = st.moves.get(extra.move_id);
    if (move) Object.assign(move, { committed: true, from_computer: from, from_runtime: fromRuntime });
  }
  session.computer_id = computerId;
  session.epoch += 1;
  session.lease = null;
  session.last_move = { from_runtime_id: fromRuntime ?? st.link?.runtimesOf(from)[0], epoch: session.epoch, at: Date.now(), forwarded: 0 };
  if (reason === "lid" && fromRuntime !== undefined) session.returns_to = fromRuntime;
  st.epochBumps.push({ session_id: session.session_id, epoch: session.epoch, why: "move" });
  const computer = st.computers.get(computerId);
  if (computer && (computer.state === "suspended" || computer.state === "stopped")) computer.state = "starting";
  const summary = st.summaries.get(session.session_id);
  if (summary) summary.computer_id = computerId;
  // For the target alone (C1): a hand back later never gives its source this mail.
  st.link?.post({
    verb: "handoff",
    authority: "system",
    channel: "move",
    to_workspace_id: session.workspace_id,
    to_computer_id: computerId,
    body: JSON.stringify({
      action: "adopt",
      session_id: session.session_id,
      reason,
      // As Cloud's place(): the runtime it left, and whether that runtime's computer is a Mac (only a Mac is where a chat came from).
      ...(fromRuntime ? { from_runtime_id: fromRuntime, ...(st.computers.get(from)?.kind ? { from_kind: st.computers.get(from)!.kind } : {}) } : {}),
      from_computer_id: from,
      ...(extra.move_id ? { move_id: extra.move_id } : {}),
      ...extra.asked,
    }),
  });
  bump(st, session.session_id);
}

/** A two-phase move as the test Cloud keeps it (C1's shape, CONTRACT-CHANGES A4 02:00). */
export interface TestMove {
  readonly move_id: string;
  readonly session_id: string;
  readonly target: string;
  readonly answers: Array<MoveAnswer>;
  /** The target accepted it, or Cloud did for a target with no runtime up (nothing to ask). */
  accepted?: boolean;
  committed?: boolean;
  from_computer?: string;
  from_runtime?: string | undefined;
  reassigned?: "source" | "computer";
  /** A reassignment's move: the move its source let go of, whose id a hand back to that source carries. */
  origin?: TestMove;
  /** Computers that could not take the chat on this move's way (a reassignment asks none of them again). */
  tried?: Set<string>;
}
export interface MoveAnswer {
  readonly phase: "accept" | "adopt";
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
}
/** How long the accept step waits for the target's answer before it counts as refused. */
export const ACCEPT_WAIT_MS = 15_000;
/** How soon a sleeping Mac's chat no Cloud computer had room for is offered again. */
const PLACE_AGAIN_MS = 5_000;

/**
 * The accept step: the target computer's runtime is asked (move mail `accept`) whether it can take the chat now, and
 * answers within ACCEPT_WAIT_MS. A target with no runtime heard lately has nobody to ask: Cloud accepts for it at once
 * (C1, CONTRACT-CHANGES 02:45), and its adopt answers on the same move id.
 */
async function askAccept(st: ChatsState, session: TestChatSession, target: string, reason: string, extra: Record<string, unknown>, now: number): Promise<{ ok: true; move_id: string } | { ok: false; code: string; message: string }> {
  const move_id = randomUUID();
  st.moves.set(move_id, { move_id, session_id: session.session_id, target, answers: [] });
  const runtime = liveRuntimeOf(st, target);
  if (runtime === null || now - (st.lastHeartbeat.get(runtime) ?? -Infinity) >= st.onlineMs) {
    st.moves.get(move_id)!.accepted = true;
    return { ok: true, move_id };
  }
  const answered = new Promise<MoveAnswer | undefined>((resolve) => {
    const timer = setTimeout(() => (st.moveWaiters.delete(move_id), resolve(undefined)), ACCEPT_WAIT_MS);
    st.moveWaiters.set(move_id, (answer) => (clearTimeout(timer), st.moveWaiters.delete(move_id), resolve(answer)));
  });
  st.link?.post({
    verb: "handoff",
    authority: "system",
    channel: "move",
    to_workspace_id: session.workspace_id,
    to_computer_id: target,
    body: JSON.stringify({ action: "accept", move_id, session_id: session.session_id, reason, engine: session.engine, repo: session.repo ?? "", from_runtime_id: liveRuntimeOf(st, session.computer_id) ?? undefined, ...extra }),
  });
  const answer = await answered;
  if (answer === undefined) return { ok: false, code: "cave_code_target_silent", message: "The computer it would move to did not answer." };
  if (answer.ok) st.moves.get(move_id)!.accepted = true;
  return answer.ok ? { ok: true, move_id } : { ok: false, code: answer.code ?? "cave_code_target_refused", message: answer.message ?? "The computer it would move to cannot take it now." };
}

/**
 * Cloud's own move to a Cloud computer with room (MoveQuiet, or a reassignment while the source sleeps): the person's
 * Cloud computers not in `except` are asked in turn, and the first that accepts gets the chat on that move's id. A
 * person with no Cloud computer gets a new one (Cloud accepts for it). The computer it went to, or undefined when none
 * took it (or the chat moved meanwhile): it stays where it is.
 */
async function moveToRoom(st: ChatsState, session: TestChatSession, fromRuntime: string | undefined, except: ReadonlySet<string>, now: number, reason: "asleep" | "reassigned" = "asleep"): Promise<TestMove | undefined> {
  const from = session.computer_id;
  const epoch = session.epoch;
  const theirs = [...st.computers].filter(([, c]) => c.kind === "cloud" && c.person === session.person && c.state !== "deleted").map(([id]) => id);
  const candidates = theirs.length === 0 ? [st.cloudComputerFor(session.person)] : theirs.filter((id) => id !== from && !except.has(id));
  for (const target of candidates) {
    const accepted = await askAccept(st, session, target, reason, { to: "cloud", user_id: session.person }, now);
    if (session.computer_id !== from || session.epoch !== epoch) return undefined;
    if (!accepted.ok) continue;
    moveChat(st, session, target, reason, fromRuntime, { move_id: accepted.move_id });
    return st.moves.get(accepted.move_id);
  }
  return undefined;
}

const PERMANENT_ADOPT_FAILURES = new Set(["cave_code_copy_not_movable", "cave_code_engine_login_needed", "cave_code_repo_unverified", "cave_code_nothing_to_move"]);

/**
 * A target that could not adopt a committed move: Cloud gives the chat back to its source when that runtime is
 * awake (adopt mail `returned` with why, as C1 sends it), else to another of the person's Cloud computers that accepts
 * it (`reassigned`) unless no Cloud computer gets past the failure, else to its source anyway. Never left ownerless.
 */
async function reassign(st: ChatsState, move: TestMove, answer: MoveAnswer, now: number) {
  const session = st.sessions.get(move.session_id);
  if (session === undefined || session.computer_id !== move.target || move.reassigned !== undefined) return;
  // The move its source let go of: a hand back carries that id (the source knows no other).
  const origin = move.origin ?? move;
  const source = origin.from_computer;
  const tried = new Set([...(move.tried ?? []), move.target]);
  const awake = source !== undefined && (st.link?.runtimesOf(source) ?? []).some((r) => now - (st.lastHeartbeat.get(r) ?? -Infinity) < st.onlineMs);
  // A failure no other Cloud computer gets past goes back to its source (chats_offers.go permanentAdoptFailures).
  const permanent = PERMANENT_ADOPT_FAILURES.has(answer.code ?? "");
  if (source !== undefined && !awake && !permanent) {
    // C1: a sleeping source's chat goes to a Cloud computer with room (asked first); none has room: its source anyway.
    move.reassigned = "computer";
    const next = await moveToRoom(st, session, undefined, new Set([...tried, source]), now, "reassigned");
    if (next !== undefined) {
      Object.assign(next, { origin, tried, from_computer: source, from_runtime: origin.from_runtime });
      return;
    }
    if (session.computer_id !== move.target) return;
  }
  if (source !== undefined) {
    origin.reassigned = "source";
    move.reassigned = "source";
    // A reassignment after a failed adopt keeps the move's own source (chats_offers.go).
    session.last_move = { from_runtime_id: origin.from_runtime ?? session.last_move?.from_runtime_id, epoch: session.epoch + 1, at: Date.now(), forwarded: 0 };
    session.computer_id = source;
    session.epoch += 1;
    session.lease = null;
    st.epochBumps.push({ session_id: session.session_id, epoch: session.epoch, why: "move" });
    const summary = st.summaries.get(session.session_id);
    if (summary) summary.computer_id = source;
    st.link?.post({
      verb: "handoff",
      authority: "system",
      channel: "move",
      to_workspace_id: session.workspace_id,
      to_computer_id: source,
      body: JSON.stringify({ action: "adopt", move_id: origin.move_id, session_id: session.session_id, reason: "returned", failed: { ...(answer.code ? { code: answer.code } : {}), ...(answer.message ? { message: answer.message } : {}) } }),
    });
    bump(st, session.session_id);
  }
}

/** Queued calls whose chat can run now: mailed to its workspace (after a move to a Cloud computer when its laptop sleeps). */
/** Cloud's cap on a queued call's request id (mailbox.go checkRequest: at most 200 bytes). */
const requestIdFits = (requestId: string) => requestId !== "" && Buffer.byteLength(requestId, "utf8") <= 200;
const REQUEST_ID_TOO_LONG = "request_id is required and at most 200 characters.";

function routeCalls(st: ChatsState, now: number) {
  for (const call of st.calls.values()) {
    if (call.status === "queued" && now - call.created_at > 24 * 60 * 60_000) {
      call.status = "expired";
      bump(st, call.session_id);
      continue;
    }
    if (call.status !== "queued" || call.mail_id !== undefined) continue;
    const session = st.sessions.get(call.session_id);
    if (session === undefined) continue;
    const computer = st.computers.get(session.computer_id);
    const laptop = (computer?.kind ?? "laptop") === "laptop";
    if (laptop && !ownerAwake(st, session, now)) {
      // S12: a send to a chat whose Mac sleeps moves it to a Cloud computer once its lease is gone.
      if (!movable(session)) {
        // Why, as a code: what its runtime said of why it stays, else Cloud's own word (waitingCode).
        const code = st.summaries.get(call.session_id)?.stays?.code ?? (session.movable_flag !== true || session.segments.length === 0 ? "not_saved" : "not_on_github");
        call.waiting = { reason: "not_movable", detail: "This chat's repository isn't on GitHub, so it waits for its Mac.", code };
        bump(st, call.session_id);
        continue;
      }
      if (leaseLive(session, now)) {
        if (call.waiting?.reason !== "laptop_asleep") {
          call.waiting = { reason: "laptop_asleep", detail: "Its Mac is asleep: it moves to a Cloud computer once its Mac lets go." };
          bump(st, call.session_id);
        }
        continue;
      }
      // Two-phase as every move: a Cloud computer with room accepts it first. None has room: it waits for one, or its Mac.
      if (session.placing === true || now < (session.place_after ?? 0)) continue;
      session.placing = true;
      const skew = now - Date.now();
      void moveToRoom(st, session, st.link?.runtimesOf(session.computer_id)[0], new Set(), now)
        .then((placed) => {
          if (placed !== undefined) return;
          session.place_after = Date.now() + skew + PLACE_AGAIN_MS;
          call.waiting = { reason: "laptop_asleep", detail: "Its Mac is asleep and its Cloud computers are busy: it runs when one has room, or its Mac wakes." };
          bump(st, call.session_id);
        })
        .finally(() => (session.placing = false));
      continue;
    }
    delete call.waiting;
    // A Mac runs a queued call only for a device the person approved, and a forward carries no device (calls.ts runOne):
    // that Mac answers it refused, as it would here.
    if (laptop && call.forwarded_by_runtime_id !== undefined) {
      call.status = "failed";
      call.error = { code: "device_not_approved", message: "Approve this device on the Mac first (Settings, Devices)." };
      bump(st, call.session_id);
      continue;
    }
    if (st.link === undefined) continue;
    // As Cloud posts it (chat_calls.go): a handoff with the person's authority.
    call.mail_id = st.link.post({
      verb: "handoff",
      authority: "human",
      channel: "call",
      to_workspace_id: session.workspace_id,
      body: JSON.stringify({
        call_id: call.id,
        session_id: call.session_id,
        request_id: call.request_id,
        method: call.method,
        params: call.params,
        user_id: call.person,
        ...(call.device ? { device: call.device } : {}),
        ...(call.device_id ? { device_id: call.device_id } : {}),
        ...(call.forwarded_by_runtime_id ? { forwarded_by_runtime_id: call.forwarded_by_runtime_id } : {}),
      } satisfies CallDelivery),
    });
    bump(st, call.session_id);
  }
}

/** The stand-in's chat sync routes; false when the route is not one of them. */
async function chatRoutes(
  st: ChatsState,
  input: {
    method: string;
    url: URL;
    bytes: Buffer;
    headers: http.IncomingHttpHeaders;
    /** The runtime the bearer is a live token of, if it is one. */
    runtimeId: string | undefined;
    /** The person the bearer is, if it is a person's. */
    person: string | undefined;
    now: number;
    request: http.IncomingMessage;
  },
  response: http.ServerResponse,
): Promise<boolean> {
  const { method, url, now } = input;
  const route = url.pathname.replace(/^\/api\/v1\/code\//, "");
  const reply = (status: number, out?: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(out === undefined ? undefined : JSON.stringify(out));
    return true;
  };
  const refuse = (status: number, code: string, message = code) => reply(status, { error: { code, message } });
  const json = () => {
    try {
      return JSON.parse(input.bytes.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  /** The body as Cloud's strict decoder takes it, or undefined once answered 400 as Cloud does. */
  const strictBody = (name: keyof typeof CHAT_INPUTS) => {
    const body = json();
    // A Cloud from before a field (askedByUnknown, placedUnknown): its decoder refuses that field.
    const without = <F extends Readonly<Record<string, FieldKind>>>(fields: F): Readonly<Record<string, FieldKind>> =>
      Object.fromEntries(
        Object.entries(fields).filter(
          ([field]) => !(st.askedByUnknown && field === "asked_by_session_id") && !(st.placedUnknown && field === "placed_workspace_id") && !(st.placeFactsUnknown && PLACE_FACT_FIELDS.has(field)),
        ),
      );
    const fields =
      name === "summary"
        ? without(SUMMARY_INPUT)
        : name === "summaries"
          ? { chats: [without(SUMMARY_INPUT)] as const }
          : name === "register"
            ? without(CHAT_INPUTS.register)
            : st.pullStopUnknown && name === "pull"
              ? OLDER_PULL_INPUT
              : CHAT_INPUTS[name];
    const why = body === undefined ? "invalid JSON" : refusalFor(fields as Readonly<Record<string, FieldKind>>, body);
    if (why === undefined) return body ?? {};
    st.refused.push({ route: name, why });
    refuse(400, "cave_bad_request", "Invalid JSON.");
    return undefined;
  };
  const pause = (ms: number | undefined) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const runtimeRoute = /^runtime\/(sessions|sessions\/[^/]+(\/journal(\/segments\/\d+|\/epoch|\/blobs\/[0-9a-f]{64})?|\/handoff|\/move|\/move-check|\/checkouts)?|chats(\/[^/]+(\/calls(\/[^/]+\/result)?|\/pull)?)?|pull-requests|returns|moves\/[^/]+)$/.test(route);
  const personRoute = /^chats(\/stream|\/[^/]+(\/state|\/events|\/calls(\/[^/]+)?|\/move))?$/.test(route);
  const waitRoute = route === "mail/wait" && !url.searchParams.has("workspace_id");
  if ((route === "workspaces" || route === "runtime/workspaces") && method === "POST") {
    // A person's ask for a chat on a Cloud computer, or their Mac's runtime asking as the person who enrolled it.
    const byRuntime = route === "runtime/workspaces";
    const person = byRuntime ? (input.runtimeId === undefined ? undefined : (st.computers.get(st.link?.computerOf(input.runtimeId) ?? "")?.person ?? "user-1")) : input.person;
    if (person === undefined) return refuse(401, "cave_unauthorized");
    const body = json();
    if (body === undefined || (st.startUnknown && body.start !== undefined)) return refuse(400, "cave_bad_request", "Invalid JSON.");
    st.placeRequests.push({ person, by: byRuntime ? "runtime" : "person", body });
    const placed = placeWorkspace(st, person, body, now);
    if ("error" in placed) return refuse(placed.error.status, placed.error.code, placed.error.message);
    return reply(201, placed);
  }
  if (!runtimeRoute && !personRoute && !waitRoute) return false;
  // The automation stand-in answers POST runtime/pull-requests.
  if (route === "runtime/pull-requests" && method !== "GET") return false;
  routeCalls(st, now);

  if (runtimeRoute || waitRoute) {
    const runtimeId = input.runtimeId;
    if (runtimeId === undefined) return refuse(401, "cave_unauthorized");
    const computerId = st.link?.computerOf(runtimeId) ?? "";
    const owner = st.computers.get(computerId)?.person ?? "user-1";
    const sessionMatch = /^runtime\/sessions\/([^/]+)/.exec(route);
    const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]!) : undefined;
    const mine = (session: TestChatSession | undefined) => session === undefined || session.computer_id === computerId;
    const register = (id: string, fields: { engine: string; repo: string; follow: boolean; workspace_id?: string }) => {
      const found = st.sessions.get(id);
      if (found) return found;
      const session: TestChatSession = { session_id: id, workspace_id: randomUUID(), computer_id: computerId, person: owner, epoch: 1, cursor_seq: 0, segments: [], size_bytes: 0, lease: null, ...fields };
      // A chat a hosted runtime registers takes the checkouts of what the person started on its computer: Cloud's
      // row decides, never the computer's own request.
      const started = st.computers.get(computerId)?.kind === "cloud" ? st.placed.get(computerId) : undefined;
      if (started !== undefined && started.checkouts.length > 0) session.checkouts = [...started.checkouts];
      st.sessions.set(id, session);
      return session;
    };
    const index = (s: TestChatSession) => ({
      session_id: s.session_id,
      epoch: s.epoch,
      cursor_seq: s.cursor_seq,
      segments: s.segments.length,
      size_bytes: s.size_bytes,
      lease_runtime_id: s.lease?.runtime_id ?? null,
      lease_expires_at: s.lease ? new Date(s.lease.expires_at).toISOString() : null,
      updated_at: new Date(now).toISOString(),
    });

    if (waitRoute && method === "GET") {
      // A long poll for the runtime's computer: answers once undelivered mail on `channel` is there for it (never
      // consuming it; POST mail/deliveries takes it), or after timeout_ms.
      if (st.down.wait !== undefined) return refuse(st.down.wait, "cave_unavailable");
      const channel = url.searchParams.get("channel") ?? "";
      st.waits.push({ runtime_id: runtimeId, channel });
      const timeout = Math.min(Number(url.searchParams.get("timeout_ms") ?? 25_000), 25_000);
      const deadline = Date.now() + timeout;
      const ready = () => st.link !== undefined && mailWaiting(st, computerId, channel);
      // Until the caller hangs up: the request itself reads as destroyed once its body was read, which made this answer
      // at once and every runtime against this Cloud spin on its waits (kind review K10, a core each).
      while (!ready() && Date.now() < deadline && !input.request.socket.destroyed && !st.waitsAnswerAtOnce) await new Promise((resolve) => setTimeout(resolve, 20));
      return reply(200, { messages: [], finished: [], timed_out: !ready(), ready: ready() });
    }
    if (route === "runtime/pull-requests" && method === "GET") {
      const branch = url.searchParams.get("branch") ?? "";
      const repo = url.searchParams.get("repo");
      // Another repository of one of the computer's workspaces (CONTRACT §7): one outside them is not found.
      if (repo !== null && st.gitScoped && !reposOf(st, computerId).has(repo.toLowerCase())) return refuse(404, "cave_not_found");
      return reply(200, { pull_request: (repo === null ? undefined : st.pullRequests.get(`${repo}#${branch}`)) ?? st.pullRequests.get(branch) ?? null });
    }
    if (route === "runtime/sessions") {
      // CONTRACT §5.2: the chats Cloud has placed on the caller's computer, with how far the copy of each stands.
      if (method !== "GET" || st.sessionsHereUnknown) return refuse(404, "cave_not_found");
      // Hosted runtimes only: a Mac's chats are on its own disk.
      if (st.computers.get(computerId)?.kind !== "cloud") return refuse(403, "cave_forbidden");
      if (url.searchParams.get("here") !== "true") return refuse(400, "cave_bad_request", "here=true is the only list.");
      st.sessionsHereReads.push({ runtime_id: runtimeId, computer_id: computerId });
      const sessions = [...st.sessions.values()]
        .filter((s) => s.computer_id === computerId && st.summaries.get(s.session_id)?.archived !== true)
        .map((s) => ({
          session_id: s.session_id,
          workspace_id: s.workspace_id,
          title: s.title ?? String(st.summaries.get(s.session_id)?.title ?? ""),
          repo: s.repo,
          base_branch: s.base_branch ?? "",
          branch: s.branch ?? "",
          engine: s.engine,
          epoch: s.epoch,
          journal: { cursor_seq: s.cursor_seq, segments: s.segments.length, size_bytes: s.size_bytes },
          // Only for a chat that has any: a chat in one repository reads as it did.
          ...(s.checkouts !== undefined && s.checkouts.length > 0 ? { checkouts: s.checkouts } : {}),
        }));
      return reply(200, { sessions });
    }
    if (sessionId !== undefined && /^runtime\/sessions\/[^/]+$/.test(route) && method === "PUT") {
      if (st.down.register !== undefined) return refuse(st.down.register, "cave_unavailable");
      const body = strictBody("register");
      if (body === undefined) return true;
      const found = st.sessions.get(sessionId);
      if (!mine(found)) return refuse(409, "cave_code_session_elsewhere");
      // The session Cloud placed with a workspace (a queued start's): registering it takes that placement up (moves.go RegisterSession).
      const own = found === undefined ? undefined : st.placements.get(found.workspace_id);
      if (own !== undefined && own.taken === undefined) own.taken = sessionId;
      // A chat Cloud does not know yet takes up its placement, or needs a place of its own (placing).
      const place = found === undefined ? placing(st, sessionId, computerId, body.placed_workspace_id, "register") : {};
      if (place.error !== undefined) return refuse(place.error.status, place.error.code, place.error.message);
      const session = register(sessionId, { engine: String(body.engine ?? "caveman"), repo: String(body.repo ?? ""), follow: body.follow === true, ...(place.workspace_id === undefined ? {} : { workspace_id: place.workspace_id }) });
      session.follow = body.follow === true;
      for (const field of ["title", "base_branch", "branch"] as const) {
        const value = body[field];
        if (typeof value === "string") session[field] = value;
      }
      if (session.follow) session.movable_flag = true;
      else {
        delete session.movable_flag;
        // Follow off deletes the copy: it starts again from cursor 1.
        if (found !== undefined) purge(session);
      }
      return reply(200, { workspace_id: session.workspace_id, follow: session.follow, journal: index(session) });
    }
    if (sessionId !== undefined && route.endsWith("/checkouts") && method === "PUT") {
      // CONTRACT §7: a Mac's runtime says which other repositories of the project its chat works in. A hosted
      // runtime never may: only a person widens what a Cloud computer reaches.
      const sent = (json() as { checkouts?: unknown } | undefined)?.checkouts;
      const asked = (Array.isArray(sent) ? (sent as ReadonlyArray<unknown>) : []).map((one) => {
        const c = (one ?? {}) as Partial<TestCheckout>;
        return { repo: String(c.repo ?? ""), base_branch: String(c.base_branch ?? ""), branch: String(c.branch ?? "") };
      });
      const write = (refused?: string) => st.checkoutWrites.push({ session_id: sessionId, runtime_id: runtimeId, checkouts: asked, ...(refused === undefined ? {} : { refused }) });
      // Every hosted runtime, before the body is read.
      if (st.computers.get(computerId)?.kind === "cloud") return (write("cave_code_outside_computer"), refuse(403, "cave_code_outside_computer", "A Cloud computer cannot change which repositories its chats reach."));
      if (!Array.isArray(sent)) return (write("cave_bad_request"), refuse(400, "cave_bad_request", "checkouts is required."));
      const session = st.sessions.get(sessionId);
      if (session === undefined) return (write("cave_not_found"), refuse(404, "cave_not_found"));
      if (!mine(session)) return (write("cave_code_session_elsewhere"), refuse(409, "cave_code_session_elsewhere"));
      const project = st.projectRepos.get(session.repo.toLowerCase());
      const seen = new Set<string>([session.repo.toLowerCase()]);
      for (const checkout of asked) {
        const repo = checkout.repo.toLowerCase();
        if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo) || seen.has(repo) || asked.length > 16) return (write("cave_code_checkout_invalid"), refuse(400, "cave_code_checkout_invalid", `${checkout.repo} cannot be one of this chat's repositories.`));
        seen.add(repo);
        if (project === undefined || st.projectRepos.get(repo) !== project) return (write("cave_code_checkout_outside_project"), refuse(400, "cave_code_checkout_outside_project", `${checkout.repo} is not a repository of this chat's project.`));
      }
      write();
      if (asked.length === 0) delete session.checkouts;
      else session.checkouts = asked;
      return reply(200, { workspace_id: session.workspace_id, checkouts: asked });
    }
    if (sessionId !== undefined && route.endsWith("/journal") && (method === "GET" || method === "PUT")) {
      if (st.down.journal !== undefined) return refuse(st.down.journal, "cave_unavailable");
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      if (!mine(session)) return refuse(409, "cave_code_session_elsewhere");
      if (method === "GET" && st.journalReadsAstray.has(sessionId)) {
        const more = st.journalReadsAstray.get(sessionId)! + 1;
        st.journalReadsAstray.set(sessionId, more);
        return reply(200, { ...index(session), segments: session.segments.length + more });
      }
      if (method === "GET") return reply(200, index(session));
      const strict = strictBody("journal");
      if (strict === undefined) return true;
      const body = strict as { lease_token?: string; cursor_seq?: number; segments?: number; size_bytes?: number; release?: boolean };
      const held = leaseLive(session, now) ? session.lease : null;
      if (body.lease_token && (session.lease?.token !== body.lease_token || session.lease.runtime_id !== runtimeId)) return refuse(409, "cave_code_lease_lost");
      if (!body.lease_token && held && held.runtime_id !== runtimeId) return refuse(409, "cave_code_lease_held");
      if ((body.cursor_seq ?? 0) < session.cursor_seq) return refuse(409, "cave_code_cursor_regressed");
      const counted = session.segments.length;
      if ((body.segments ?? 0) < counted) return refuse(409, "cave_code_cursor_regressed");
      if ((body.segments ?? 0) > counted + 1 || ((body.segments ?? 0) === counted + 1 && session.pending === undefined)) return refuse(409, "cave_code_segment_gap");
      if ((body.segments ?? 0) === counted + 1) {
        session.segments.push(session.pending!);
        delete session.pending;
      }
      session.cursor_seq = body.cursor_seq ?? session.cursor_seq;
      session.size_bytes = body.size_bytes ?? session.size_bytes;
      const token = body.lease_token || randomUUID();
      session.lease = body.release ? null : { runtime_id: runtimeId, token, expires_at: now + st.leaseTtlMs };
      if (counted !== session.segments.length) bump(st, sessionId);
      return reply(200, { ...index(session), lease_token: body.release ? null : token });
    }
    const segment = sessionId !== undefined ? /\/journal\/segments\/(\d+)$/.exec(route) : null;
    if (sessionId !== undefined && segment && method === "PUT") {
      if (st.segmentPutsHeld !== undefined) {
        st.segmentPutsHeld.waiting++;
        await st.segmentPutsHeld.until;
        if (input.request.socket.destroyed) return true;
      }
      await pause(st.delay.segments);
      const n = Number(segment[1]);
      const gzip = isGzip(input.bytes);
      const log = (status: number, extra: Record<string, unknown> = {}) => st.segmentPuts.push({ session_id: sessionId, n, status, bytes: input.bytes.length, gzip, ...extra });
      if (st.down.segments !== undefined) return (log(st.down.segments), refuse(st.down.segments, "cave_unavailable"));
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      if (!mine(session)) return refuse(409, "cave_code_session_elsewhere");
      if (input.bytes.length === 0 || input.bytes.length > SEGMENT_MAX_BYTES) return (log(413, { code: "cave_code_segment_too_large" }), refuse(413, "cave_code_segment_too_large"));
      const lease = String(input.headers["x-caveman-lease"] ?? "");
      if (!leaseLive(session, now) || session.lease!.token !== lease || session.lease!.runtime_id !== runtimeId) return (log(409, { code: "cave_code_lease_lost" }), refuse(409, "cave_code_lease_lost"));
      if (n > session.segments.length) return (log(409, { code: "cave_code_segment_gap" }), refuse(409, "cave_code_segment_gap"));
      if (n < session.segments.length) return (log(409, { code: "cave_code_segment_exists" }), refuse(409, "cave_code_segment_exists"));
      let body: Record<string, unknown>;
      try {
        body = JSON.parse((gzip ? gunzipCapped(input.bytes) : input.bytes).toString("utf8")) as Record<string, unknown>;
      } catch {
        return (log(413, { code: "cave_code_segment_too_large" }), refuse(413, "cave_code_segment_too_large", "A segment decompresses to at most 64 MiB of JSON."));
      }
      if (st.midWipPutsDown !== undefined && body.boundary !== true && body.wip_at !== undefined) {
        const status = st.midWipPutsDown;
        st.midWipPutsDown = undefined;
        return (log(status, { code: "cave_unavailable" }), refuse(status, "cave_unavailable"));
      }
      if (st.midWipPutsHeld !== undefined && body.boundary !== true && body.wip_at !== undefined) {
        st.midWipPutsHeld.waiting++;
        await st.midWipPutsHeld.until;
        if (input.request.socket.destroyed) return true;
      }
      const events = copiedEvents(body);
      const v2 = typeof body.epoch === "number";
      const from = v2 ? Number(body.from) : Number(body.after ?? 0) + 1;
      const through = v2 ? Number(body.through) : (events.at(-1)?.cursor ?? from - 1);
      const facts = { epoch: v2 ? Number(body.epoch) : session.epoch, from, through, boundary: body.boundary === true };
      if (v2 && body.epoch !== session.epoch) return (log(409, { ...facts, code: "cave_code_journal_epoch" }), refuse(409, "cave_code_journal_epoch", `The journal's epoch is ${session.epoch}.`));
      if (v2 && from !== session.cursor_seq + 1 && !(session.segments.length === 0 && from === 1)) {
        return (log(409, { ...facts, code: "cave_code_journal_gap" }), refuse(409, "cave_code_journal_gap", `The copy stands at cursor ${session.cursor_seq}: the next segment starts at ${session.cursor_seq + 1}.`));
      }
      if (events.some((e, i) => e.cursor !== from + i) || events.length !== through - from + 1) return (log(400, { ...facts, code: "cave_bad_request" }), refuse(400, "cave_bad_request", "events are the cursors from..through, in order."));
      session.pending = { n, ...facts, bytes: input.bytes.length, gzip, raw: Buffer.from(input.bytes), body, events };
      log(200, facts);
      return reply(204);
    }
    if (sessionId !== undefined && segment && method === "GET") {
      if (st.segmentReadsDownOn !== undefined && st.segmentReadsDownOn === computerId) return refuse(503, "cave_unavailable", "Caveman Cloud could not read the copy.");
      if (st.segmentReadsHeldOn !== undefined && st.segmentReadsHeldOn.computer === computerId && Number(segment[1]) >= (st.segmentReadsHeldOn.from ?? 0)) {
        if ((await st.segmentReadsHeldOn.until) === "down") return refuse(503, "cave_unavailable", "Caveman Cloud could not read the copy.");
      }
      await pause(st.delay.segments);
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      if (!mine(session)) return refuse(409, "cave_code_session_elsewhere");
      if (leaseLive(session, now) && session.lease!.runtime_id !== runtimeId) return refuse(409, "cave_code_lease_held");
      const found = session.segments[Number(segment[1])];
      if (found === undefined) return refuse(404, "cave_not_found");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(found.raw);
      return true;
    }
    const blob = sessionId !== undefined ? /\/journal\/blobs\/([0-9a-f]{64})$/.exec(route) : null;
    if (sessionId !== undefined && blob) {
      // Cloud's journal_blobs.go: the lease holder writes a chunk under the sha256 of its bytes; reads follow segments'.
      const sha = blob[1]!;
      const answer = (status: number, code?: string, message?: string) => {
        st.blobCalls.push({ method, session_id: sessionId, sha, status });
        return code === undefined ? reply(status) : refuse(status, code, message);
      };
      if (st.blobsOff) return answer(404, "cave_not_found");
      const session = st.sessions.get(sessionId);
      if (session === undefined) return answer(404, "cave_not_found");
      if (!mine(session)) return answer(409, "cave_code_session_elsewhere");
      const blobs = (session.blobs ??= new Map());
      if (method === "PUT") {
        if (st.blobPutsHeld !== undefined) await st.blobPutsHeld;
        if (st.blobPutMs > 0) await new Promise((r) => setTimeout(r, st.blobPutMs));
        const lease = String(input.headers["x-caveman-lease"] ?? "");
        const whole = Number(input.headers["x-caveman-blob-bytes"] ?? 0);
        if (!leaseLive(session, now) || session.lease!.token !== lease || session.lease!.runtime_id !== runtimeId) return answer(409, "cave_code_lease_lost");
        if (whole > st.blobLimits.blob) return answer(413, "cave_code_blob_too_large", `One blob of a chat's copy is at most ${st.blobLimits.blob >> 20} MiB.`);
        if (input.bytes.length === 0 || input.bytes.length > st.blobLimits.chunk) return answer(413, "cave_code_blob_too_large", "A chunk is 1 byte to 8 MiB.");
        if (createHash("sha256").update(input.bytes).digest("hex") !== sha) return answer(400, "cave_code_blob_mismatch");
        if (blobs.has(sha)) return answer(204);
        if (blobs.size >= st.blobLimits.chunks) return answer(413, "cave_code_blobs_full", `A chat's copy holds at most ${st.blobLimits.chunks} chunks of large files; this one holds ${blobs.size}.`);
        const total = [...blobs.values()].reduce((sum, b) => sum + b.length, 0);
        if (total + input.bytes.length > st.blobLimits.chat) return answer(413, "cave_code_blobs_full", "A chat's copy holds at most 256 MiB of large files.");
        if (st.blobPutsBeforeFailure === 0) {
          st.blobPutsBeforeFailure = undefined;
          return answer(503, "cave_unavailable", "Caveman Cloud is busy.");
        }
        if (st.blobPutsBeforeFailure !== undefined) st.blobPutsBeforeFailure--;
        blobs.set(sha, Buffer.from(input.bytes));
        return answer(204);
      }
      if (method === "GET" || method === "HEAD") {
        if (leaseLive(session, now) && session.lease!.runtime_id !== runtimeId) return answer(409, "cave_code_lease_held");
        const found = blobs.get(sha);
        if (found === undefined) return answer(404, "cave_not_found");
        st.blobCalls.push({ method, session_id: sessionId, sha, status: 200 });
        const bytes = st.tamperBlobs.has(sha) ? Buffer.concat([found.subarray(0, -1), Buffer.from([found.at(-1)! ^ 0xff])]) : found;
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
        response.end(method === "HEAD" ? undefined : bytes);
        return true;
      }
    }
    if (sessionId !== undefined && route.endsWith("/journal/epoch") && method === "POST") {
      await st.epochGate;
      // A runtime that lost its WAL tail rebuilds from the copy under a new epoch: only while it holds the lease.
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      if (!mine(session)) return refuse(409, "cave_code_session_elsewhere");
      // As Cloud reads it: the body's lease_token when the body decodes, else X-Caveman-Lease.
      const body = json();
      const token = body !== undefined && refusalFor(CHAT_INPUTS.epoch, body) === undefined && typeof body.lease_token === "string" && body.lease_token !== "" ? body.lease_token : String(input.headers["x-caveman-lease"] ?? "");
      if (!leaseLive(session, now) || session.lease!.token !== token || session.lease!.runtime_id !== runtimeId) return refuse(409, "cave_code_lease_lost");
      session.epoch += 1;
      st.epochBumps.push({ session_id: sessionId, epoch: session.epoch, why: "rebuild" });
      bump(st, sessionId);
      return reply(200, index(session));
    }
    // Which login pays for a Claude Agent or Codex chat on a Cloud computer `computerId`, or the refusal (C1 targetComputer). As Cloud's
    // engineLogin: the person's lane (here only a vault key) before a sign-in made on that computer, since the
    // runtime there launches on the lane and its stand-in wins over the CLI's own login (agent-continuity.md §7.4).
    const engineLogin = (session: TestChatSession, computerId: string): { login: "vault_key" | "computer_sign_in" | null } | { code: string; message: string } => {
      // Another of the person's Macs runs it on its own sign-in, which that Mac checks when it accepts (Cloud skips the lane).
      if ((session.engine !== "claude-agent" && session.engine !== "codex") || st.computers.get(computerId)?.kind === "laptop") return { login: null };
      const logins = st.engineLogins.get(session.person)?.[session.engine];
      if (logins?.vault_key) return { login: "vault_key" };
      if (logins?.signed_in_on.includes(computerId)) return { login: "computer_sign_in" };
      return {
        code: "cave_code_engine_login_needed",
        message: session.engine === "codex" ? "Add your OpenAI key for Cloud computers, or sign Codex in on one." : "Add your Anthropic key for Cloud computers, or sign Claude in on one.",
      };
    };
    if (sessionId !== undefined && route.endsWith("/handoff") && method === "POST") {
      // S12: the lid's last word (chats_moves.go LidHandoff). The copy is flushed through `through`: the lease goes, and
      // a working chat moves now. Said again, it answers the same.
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      const body = strictBody("handoff") as { through?: number; reason?: string; move_id?: string } | undefined;
      if (body === undefined) return true;
      if ((body.reason ?? "lid") !== "lid") return refuse(400, "cave_bad_request", 'reason is "lid".');
      if (!mine(session)) {
        if (session.returns_to === runtimeId) return reply(200, { session_id: sessionId, released: true, moved: true, computer_id: session.computer_id });
        return refuse(409, "cave_code_session_elsewhere");
      }
      if (leaseLive(session, now) && session.lease!.runtime_id !== runtimeId) return refuse(409, "cave_code_lease_held", "Another runtime holds the session's journal lease.");
      if (Number(body.through ?? 0) > session.cursor_seq) return refuse(409, "cave_code_journal_behind", `Cloud's copy runs through cursor ${session.cursor_seq}: copy through ${body.through} before handing the chat off.`);
      session.lease = null;
      // As Cloud reads it: the run state the runtime reported, or the summary (chats_moves.go workingStates).
      const summary = st.summaries.get(sessionId);
      const runState = st.link?.runStateOf?.(session.workspace_id);
      const working = ["starting", "working", "needs_input", "waiting", "moving"].includes(runState ?? "") || summary?.status === "working" || summary?.status === "needs_you";
      const reservedLid = body.move_id !== undefined ? st.moves.get(body.move_id) : undefined;
      const lidTarget = reservedLid !== undefined && reservedLid.session_id === sessionId && !reservedLid.committed && reservedLid.accepted === true ? reservedLid.target : st.cloudComputerFor(session.person, computerId);
      if (st.handoffPendingMs !== undefined && working && movable(session)) {
        // Asked of a Cloud computer that is up: on its way, handed over once that one accepts.
        const moveId = randomUUID();
        st.handoffs.push({ session_id: sessionId, through: Number(body.through ?? 0), reason: "lid", moved: false });
        const failsThere = st.handoffPendingFails;
        setTimeout(() => {
          if (failsThere === undefined) return moveChat(st, session, lidTarget, "lid", runtimeId);
          const move: TestMove = { move_id: moveId, session_id: sessionId, target: lidTarget, answers: [], accepted: true };
          st.moves.set(moveId, move);
          moveChat(st, session, lidTarget, "lid", runtimeId, { move_id: moveId });
          void reassign(st, move, { phase: "adopt", ok: false, ...failsThere }, Date.now());
        }, st.handoffPendingMs);
        return reply(200, { session_id: sessionId, released: true, moved: false, pending: true, move_id: moveId });
      }
      // Two-phase moves: a target the lid's check did not reserve is asked now (it may refuse: the chat stays here), once
      // there is a login for the chat's engine there, as Cloud's moveLocked checks it (targetComputer): the lid leaves a
      // check its budget cut to this refusal.
      const unreserved = working && movable(session) && reservedLid === undefined;
      const login = unreserved ? engineLogin(session, lidTarget) : undefined;
      const accepted =
        login !== undefined && "code" in login ? ({ ok: false, ...login } as const) : unreserved ? await askAccept(st, session, lidTarget, "lid", { to: "cloud", user_id: session.person }, now) : ({ ok: true } as const);
      const moved = working && movable(session) && accepted.ok;
      st.handoffs.push({ session_id: sessionId, through: Number(body.through ?? 0), reason: "lid", moved });
      if (moved) moveChat(st, session, lidTarget, "lid", runtimeId, reservedLid !== undefined ? { move_id: reservedLid.move_id } : "move_id" in accepted && accepted.move_id ? { move_id: accepted.move_id } : {});
      const refused =
        working && !moved && !accepted.ok
          ? { refused: { code: accepted.code, message: accepted.message } }
          : working && !moved
          ? session.movable_flag !== true
            ? { refused: { code: "cave_code_session_not_movable", message: "Its runtime did not register this chat to move." } }
            : session.segments.length === 0
              ? { refused: { code: "cave_code_nothing_to_move", message: "Nothing of the chat is in Cloud yet." } }
              : {}
          : {};
      // Done before the answer: a slow answer leaves the move made (the runtime must not take a timeout as "not moved").
      await pause(st.delay.handoff);
      return reply(200, { session_id: sessionId, released: true, moved, ...(moved ? { computer_id: session.computer_id, runtime_id: liveRuntimeOf(st, session.computer_id) } : {}), ...refused });
    }
    // Where a runtime's move sends a chat: a Cloud computer of its person, a runtime, or one of its person's computers by id (A4).
    const moveTargetOf = (session: TestChatSession, to: unknown) =>
      to === "cloud"
        ? st.cloudComputerFor(session.person, session.computer_id)
        : typeof to === "object" && to !== null && "computer_id" in to
          ? st.computers.get(String((to as { computer_id: unknown }).computer_id))?.person === session.person
            ? String((to as { computer_id: unknown }).computer_id)
            : undefined
          : st.link?.computerOf(String((to as { runtime_id?: unknown } | undefined)?.runtime_id ?? ""));
    if (sessionId !== undefined && route.endsWith("/move-check") && method === "POST") {
      st.moveChecksPending++;
      try {
        await pause(st.delay.check);
      } finally {
        st.moveChecksPending--;
      }
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_code_session_not_found");
      const body = strictBody("move_check") as { to?: unknown; reason?: string; offer?: boolean; request_id?: string; device?: unknown } | undefined;
      if (body === undefined) return true;
      if (body.reason !== undefined && body.reason !== "lid" && body.reason !== "user") return refuse(400, "cave_bad_request", 'reason is "lid" or "user".');
      const target = moveTargetOf(session, body.to);
      if (target === undefined) return refuse(404, "cave_code_session_not_found", "No such computer.");
      if (macAway(st, body.to, target, now)) return refuse(409, "cave_code_target_silent", TARGET_SILENT);
      const login = engineLogin(session, target);
      st.moveChecks.push({ session_id: sessionId, to: body.to, login: "login" in login ? login.login : null, ...("code" in login ? { code: login.code } : {}) });
      if ("code" in login) return refuse(400, login.code, login.message);
      if (target === session.computer_id) return reply(200, { login: login.login });
      const toKind = st.computers.get(target)?.kind === "cloud" ? "cloud" : "laptop";
      // Only asked (the Move to menu; A4's ask of C1, CONTRACT-CHANGES 03:30): no offer. Where it would go, as Cloud's
      // dryCheck says it.
      if (body.offer === false) return reply(200, { login: login.login, computer_id: target, to_kind: toKind });
      const injected = st.refuseReserves.findIndex((r) => r.computerId === computerId);
      if (injected >= 0) {
        const [r] = st.refuseReserves.splice(injected, 1);
        return refuse(r!.status, r!.code, r!.message);
      }
      // Two-phase moves (C1 as landed): every check offers the move, the target accepts before its source parks
      // anything, and the move commits to it.
      const asked = { ...(body.to !== undefined ? { to: body.to } : {}), ...(body.request_id ? { request_id: body.request_id } : {}), ...(body.device ? { device: body.device } : {}), user_id: session.person };
      const accepted = await askAccept(st, session, target, body.reason ?? "user", asked, now);
      if (!accepted.ok) return refuse(409, accepted.code, accepted.message);
      return reply(200, { login: login.login, computer_id: target, move_id: accepted.move_id, to_kind: toKind });
    }
    if (sessionId !== undefined && route.endsWith("/move") && method === "POST") {
      const injected = st.refuseMoves.findIndex((r) => r.computerId === computerId);
      if (injected >= 0) {
        const [r] = st.refuseMoves.splice(injected, 1);
        return refuse(r!.status, r!.code, r!.message);
      }
      // The runtime's own move: its source moves it now; another runtime asking for it waits for an awake source.
      const session = st.sessions.get(sessionId);
      if (session === undefined) return refuse(404, "cave_not_found");
      const body = strictBody("move") as { to?: "cloud" | { runtime_id: string } | { computer_id: string }; reason?: "lid" | "user"; move_id?: string; request_id?: string; device?: unknown } | undefined;
      if (body === undefined) return true;
      const reserved = body.move_id !== undefined ? st.moves.get(body.move_id) : undefined;
      if (body.move_id !== undefined && (reserved === undefined || reserved.session_id !== sessionId || reserved.committed || reserved.accepted !== true))
        return refuse(409, "cave_code_move_expired", "That move is not reserved for this chat any more; check it again.");
      const target = reserved?.target ?? moveTargetOf(session, body.to);
      if (target === undefined) return refuse(404, "cave_not_found", "No such runtime.");
      if (target === session.computer_id) return refuse(409, "cave_code_already_there");
      if (session.movable_flag !== true) return refuse(409, "cave_code_session_not_movable", "Its runtime did not register this chat to move.");
      if (reserved === undefined && macAway(st, body.to, target, now)) return refuse(409, "cave_code_target_silent", TARGET_SILENT);
      const login = engineLogin(session, target);
      if ("code" in login) return refuse(400, login.code, login.message);
      if (session.segments.length === 0) return refuse(409, "cave_code_nothing_to_move");
      const source = mine(session);
      if (!source && ownerAwake(st, session, now)) {
        st.link?.post({ verb: "handoff", authority: "system", channel: "move", to_workspace_id: session.workspace_id, body: JSON.stringify({ action: "move", session_id: sessionId, reason: "user", to_runtime_id: runtimeId }) });
        return reply(202, { session_id: sessionId, workspace_id: session.workspace_id, computer_id: session.computer_id, runtime_id: null, pending: true });
      }
      if (!source && leaseLive(session, now)) return refuse(409, "cave_code_lease_held");
      const asked = { ...(body.request_id ? { request_id: body.request_id } : {}), ...(body.device ? { device: body.device } : {}), ...(body.to !== undefined ? { to: body.to } : {}) };
      let moveId = reserved?.move_id;
      if (moveId === undefined) {
        // Not reserved by a check: the accept step runs now, before anything moves.
        const accepted = await askAccept(st, session, target, body.reason ?? "user", { ...asked, user_id: session.person }, now);
        if (!accepted.ok) return refuse(409, accepted.code, accepted.message);
        moveId = accepted.move_id;
      }
      moveChat(st, session, target, body.reason ?? "user", source ? runtimeId : undefined, { ...(moveId ? { move_id: moveId } : {}), asked });
      await pause(st.delay.move);
      return reply(200, { session_id: sessionId, workspace_id: session.workspace_id, computer_id: target, runtime_id: liveRuntimeOf(st, target), pending: false });
    }
    const pulling = /^runtime\/chats\/([^/]+)\/pull$/.exec(route);
    if (pulling && method === "POST") {
      // chats_moves.go PullChat: a Mac's own screen asks for its person's chat, to its own computer, signed; Cloud passes
      // it on as a person's move (the chat's Mac checks the signature) and refuses a sleeping Mac's chat.
      const body = strictBody("pull") as
        | { to?: unknown; request_id?: string; device?: { device_id: string; at: string; signature: string }; stop?: { request_id?: string; device?: { device_id: string; at: string; signature: string } } }
        | undefined;
      if (body === undefined) return true;
      if (st.computers.get(computerId)?.kind !== "laptop") return refuse(403, "cave_forbidden", "This runtime acts for no member who may run Caveman Code.");
      if (typeof body.to !== "object" || body.to === null || (body.to as { computer_id?: unknown }).computer_id !== computerId || "runtime_id" in body.to)
        return refuse(400, "cave_bad_request", 'A Mac pulls a chat only to itself: to is {"computer_id": <its own computer>}.');
      if (!body.device || !body.request_id) return refuse(400, "cave_bad_request", "A pull carries the asking Mac's signature (request_id and device).");
      if (body.stop !== undefined && (!body.stop.request_id || !body.stop.device)) return refuse(400, "cave_bad_request", "A stop comes with a signed move, and is signed itself.");
      const pulled = st.sessions.get(decodeURIComponent(pulling[1]!));
      if (pulled === undefined || pulled.person !== owner || !st.summaries.has(pulled.session_id)) return refuse(404, "cave_not_found", "No such chat.");
      if (pulled.computer_id === computerId) return refuse(409, "cave_code_already_there");
      if (pulled.movable_flag !== true) return refuse(409, "cave_code_session_not_movable", "This chat stays where it runs.");
      const asked = { user_id: owner, to: body.to, request_id: body.request_id, device: body.device };
      if (ownerAwake(st, pulled, now) || leaseLive(pulled, now)) {
        // The device's signed stop of the chat's running turn goes to its Mac unchanged (decision 32).
        st.link?.post({ verb: "handoff", authority: "system", channel: "move", to_workspace_id: pulled.workspace_id, body: JSON.stringify({ action: "move", session_id: pulled.session_id, reason: "user", to_computer_id: computerId, ...asked, ...(body.stop ? { stop: body.stop } : {}) }) });
        st.moveRequests.push({ session_id: pulled.session_id, to: body.to, by: owner, pending: true });
        return reply(202, { pending: true, computer_id: pulled.computer_id, workspace_id: pulled.workspace_id, engine: pulled.engine });
      }
      if (st.computers.get(pulled.computer_id)?.kind === "laptop") return refuse(409, "cave_code_source_asleep", SOURCE_ASLEEP);
      if (pulled.segments.length === 0) return refuse(409, "cave_code_nothing_to_move");
      const accepted = await askAccept(st, pulled, computerId, "user", asked, now);
      if (!accepted.ok) return refuse(409, accepted.code, accepted.message);
      moveChat(st, pulled, computerId, "user", st.link?.runtimesOf(pulled.computer_id)[0], { ...(accepted.move_id ? { move_id: accepted.move_id } : {}), asked });
      st.moveRequests.push({ session_id: pulled.session_id, to: body.to, by: owner, pending: false });
      return reply(200, { pending: false, computer_id: computerId, workspace_id: pulled.workspace_id, engine: pulled.engine });
    }
    const answering = /^runtime\/moves\/([^/]+)$/.exec(route);
    if (answering && method === "POST") {
      // A two-phase move's target answers: it can take the chat (accept), or it took it or could not (adopt).
      const move = st.moves.get(decodeURIComponent(answering[1]!));
      if (move === undefined) return refuse(404, "cave_not_found", "No such move.");
      if (computerId !== move.target && !(move.reassigned === "source" && computerId === move.from_computer)) return refuse(403, "cave_forbidden", "Only the move's target answers it.");
      const body = strictBody("move_answer") as { phase?: string; ok?: boolean; code?: string; message?: string } | undefined;
      if (body === undefined) return true;
      if (body.phase !== "accept" && body.phase !== "adopt") return refuse(400, "cave_bad_request", 'phase is "accept" or "adopt".');
      if (body.phase === "accept" && st.acceptAnswerLostOn === computerId) {
        st.acceptAnswerLostOn = undefined;
        return refuse(500, "cave_internal", "Could not complete the Caveman Code request.");
      }
      if (body.phase === "adopt" && body.ok === true && st.adoptAnswersLost > 0) {
        st.adoptAnswersLost -= 1;
        return refuse(500, "cave_internal", "Could not complete the Caveman Code request.");
      }
      const answer: MoveAnswer = { phase: body.phase, ok: body.ok === true, ...(body.code ? { code: body.code } : {}), ...(body.message ? { message: body.message } : {}) };
      move.answers.push(answer);
      if (answer.phase === "accept") st.moveWaiters.get(move.move_id)?.(answer);
      // Reassigned at once; the answer does not wait for the next computer's accept step.
      else if (!answer.ok && move.committed && computerId === move.target) void reassign(st, move, answer, now);
      return reply(204);
    }
    if (route === "runtime/returns" && method === "GET") {
      // C1 Returns: the chats this runtime's lid sent to a Cloud computer, idle there when no turn or call runs.
      const chats = [...st.sessions.values()]
        .filter((session) => session.returns_to === runtimeId && session.computer_id !== computerId)
        .map((session) => {
          const status = st.summaries.get(session.session_id)?.status;
          const calls = [...st.calls.values()].some((call) => call.session_id === session.session_id && (call.status === "queued" || call.status === "delivered"));
          const idle = status !== "working" && status !== "needs_you" && !calls && !leaseLive(session, now);
          return { session_id: session.session_id, computer_id: session.computer_id, moved_at: new Date(now).toISOString(), idle };
        });
      return reply(200, { chats });
    }
    const chat = /^runtime\/chats\/([^/]+)$/.exec(route);
    if (chat && method === "DELETE") {
      // Sync turned off: the chat's summary, copy and person state leave Cloud.
      const id = decodeURIComponent(chat[1]!);
      const session = st.sessions.get(id);
      if (session === undefined) return refuse(404, "cave_not_found");
      if (!mine(session)) return refuse(409, "cave_code_session_elsewhere");
      // The session stays registered, so the chat can sync again from cursor 1.
      unsync(st, session);
      st.deleted.push(id);
      return reply(204);
    }
    if ((chat && method === "PUT") || (route === "runtime/chats" && method === "PUT")) {
      if (st.down.summaries !== undefined) return refuse(st.down.summaries, "cave_unavailable");
      const body = strictBody(chat ? "summary" : "summaries");
      if (body === undefined) return true;
      const inputs = chat ? [{ ...body, session_id: decodeURIComponent(chat[1]!) }] : ((body.chats as Array<Record<string, unknown>> | null | undefined) ?? []);
      if (!chat && (inputs.length === 0 || inputs.length > 100)) return refuse(400, "cave_bad_request", "chats holds 1 to 100 summaries.");
      // Each on its own (chats.go PutChatSummaries): one refused never holds back the rest.
      const results = inputs.map((raw) => putSummaryOne(st, raw, { runtimeId, computerId, register, mine, batch: !chat }));
      await pause(st.delay.summaries);
      if (chat) {
        const one = results[0]!;
        return one.error ? refuse(one.error.status, one.error.code, one.error.message) : reply(200, { session_id: one.session_id, seq: one.seq });
      }
      return reply(200, { chats: results.map((r) => (r.error ? { session_id: r.session_id, error: { code: r.error.code, message: r.error.message } } : { session_id: r.session_id, seq: r.seq })) });
    }
    const forward = /^runtime\/chats\/([^/]+)\/calls$/.exec(route);
    if (forward && method === "POST") {
      // Forwarded input (Cloud 53565ffec, chats_forward.go): what the source of the chat's latest move took in that the
      // copy the move went from lacks, queued as the chat's person's call on the computer the chat is on now.
      if (st.down.forward !== undefined) return refuse(st.down.forward, "cave_unavailable");
      const session = st.sessions.get(decodeURIComponent(forward[1]!));
      if (session === undefined) return refuse(404, "cave_not_found");
      const body = strictBody("forward") as { request_id?: string; method?: string; params?: Record<string, unknown> } | undefined;
      if (body === undefined) return true;
      if (input.bytes.length > 64 * 1024) return refuse(413, "cave_too_large");
      if (body.method !== "turn.submit") return refuse(400, "cave_code_call_method", "Only turn.submit is forwarded.");
      const params = body.params;
      const sent = params?.input as { text?: unknown; attachments?: unknown } | undefined;
      if (Array.isArray(sent?.attachments) && sent.attachments.length > 0) return refuse(400, "cave_code_forward_attachments", "A forward carries text only.");
      if (typeof body.request_id !== "string" || typeof sent?.text !== "string" || sent.text === "" || (sent.attachments !== undefined && !Array.isArray(sent.attachments)))
        return refuse(400, "cave_bad_request", "request_id and params.input.text are required.");
      if (!requestIdFits(body.request_id)) return refuse(400, "cave_bad_request", REQUEST_ID_TOO_LONG);
      // Said again, or under a device's request id: that call, whatever the params (only the method must match).
      const existing = [...st.calls.values()].find((c) => c.session_id === session.session_id && c.person === session.person && c.request_id === body.request_id);
      if (existing) return existing.method === "turn.submit" ? reply(202, callStateOf(existing)) : refuse(409, "cave_code_request_id_conflict");
      const last = session.last_move;
      const refused = (status: number, code: string, message: string) => (st.forwardRefusals.push({ session_id: session.session_id, code }), refuse(status, code, message));
      if (last === undefined || last.from_runtime_id !== runtimeId || now - last.at > 24 * 60 * 60_000) return refused(403, "cave_code_not_source", "Only the runtime the chat's last move left forwards to it.");
      if (session.epoch !== last.epoch) return refused(409, "cave_code_moved_again", "The chat moved again since.");
      if (last.forwarded >= 20) return refused(429, "cave_code_too_many_forwards", "At most 20 forwarded calls per move.");
      last.forwarded += 1;
      const call: TestCall = {
        id: randomUUID(),
        session_id: session.session_id,
        person: session.person,
        request_id: body.request_id,
        method: "turn.submit",
        params: params!,
        params_key: JSON.stringify([body.method, params]),
        status: "queued",
        created_at: now,
        forwarded_by_runtime_id: runtimeId,
      };
      st.calls.set(call.id, call);
      routeCalls(st, now);
      bump(st, session.session_id);
      return reply(202, callStateOf(call));
    }
    const result = /^runtime\/chats\/([^/]+)\/calls\/([^/]+)\/result$/.exec(route);
    if (result && method === "POST") {
      if (st.down.results !== undefined) return refuse(st.down.results, "cave_unavailable");
      const call = st.calls.get(decodeURIComponent(result[2]!));
      if (call === undefined || call.session_id !== decodeURIComponent(result[1]!)) return refuse(404, "cave_not_found");
      if (!mine(st.sessions.get(call.session_id))) return refuse(409, "cave_code_session_elsewhere");
      const body = strictBody("result") as { ok?: boolean; result?: unknown; error?: { code: string; message: string } } | undefined;
      if (body === undefined) return true;
      st.callResults.push({ call_id: call.id, ok: body.ok === true });
      // The first result stands: a call the relay ran too is answered once.
      if (call.status !== "done" && call.status !== "failed") {
        call.status = body.ok ? "done" : "failed";
        if (body.ok) call.result = body.result ?? null;
        else call.error = body.error ?? { code: "cave_code_call_failed", message: "The call failed." };
        bump(st, call.session_id);
      }
      return reply(200, callStateOf(call));
    }
    return refuse(404, "cave_not_found");
  }

  // Person routes: a person sees only their own chats.
  const person = input.person;
  if (person === undefined) return refuse(401, "cave_unauthorized");
  const theirs = (sessionId: string) => {
    const session = st.sessions.get(sessionId);
    return session !== undefined && session.person === person && st.summaries.has(sessionId) ? session : undefined;
  };
  if (route === "chats" && method === "GET") {
    const archived = url.searchParams.get("archived") === "true";
    const chats = [...st.summaries.keys()].flatMap((id) => (theirs(id) ? [summaryOf(st, id)!] : [])).filter((c) => c.archived === archived);
    // Every runtime of a Mac; of a Cloud computer the one it runs as now, and none while it is not asked to run (CONTRACT §11).
    const runtimes = [
      ...new Set(
        [...st.computers]
          .filter(([, c]) => c.person === person)
          .flatMap(([id, c]) => (c.kind !== "cloud" ? (st.link?.runtimesOf(id) ?? []) : cloudAsleep(c) ? [] : [liveRuntimeOf(st, id)].filter((r): r is string => r !== null))),
      ),
    ].flatMap((r) => runtimeStateOf(st, r, now) ?? []);
    return reply(200, { chats, runtimes, seq: st.seq });
  }
  if (route === "chats/stream" && method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // Headers and a first byte at once, so a device knows the stream is up before anything changes.
    response.write(": ok\n\n");
    const write = (event: string, data: unknown, seq: number) => response.write(`event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
    const oldest = st.changes[0]?.seq ?? st.seq + 1;
    if (after < st.seq && after < oldest - 1) write("reset", {}, st.seq);
    else
      for (const change of st.changes) {
        if (change.seq <= after || change.person !== person) continue;
        // The latest of each chat only: a later change of the same chat sends it again.
        if (st.changes.some((c) => c.key === change.key && c.seq > change.seq)) continue;
        const data = change.event === "gone" ? { session_id: change.key } : change.event === "runtime" ? runtimeStateOf(st, change.key, now) : summaryOf(st, change.key);
        if (data !== undefined) write(change.event, data, change.seq);
      }
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), st.keepaliveMs);
    const stream = { person, write, close: () => response.end() };
    st.streams.add(stream);
    input.request.on("close", () => (clearInterval(keepalive), st.streams.delete(stream)));
    return true;
  }
  const chatMatch = /^chats\/([^/]+)/.exec(route);
  const sessionId = decodeURIComponent(chatMatch![1]!);
  // The person's chat by Cloud's rows (chats.go personalChat): one a runtime wrote a summary of, and the session Cloud
  // placed for a chat its runtime has yet to start, whose start's call and empty copy its person reads meanwhile.
  const placedFor = st.sessions.get(sessionId);
  const session = theirs(sessionId) ?? (placedFor !== undefined && placedFor.person === person && st.placements.has(placedFor.workspace_id) ? placedFor : undefined);
  if (session === undefined) return refuse(404, "cave_not_found", "No such chat.");
  if (route.endsWith("/state") && method === "PUT") {
    const body = strictBody("state") as { seen_cursor?: number; pinned?: boolean; done?: boolean; snoozed_until?: string | null } | undefined;
    if (body === undefined) return true;
    const current = st.person.get(sessionId) ?? { seen_cursor: 0, pinned: false };
    const next = { ...current };
    if (body.seen_cursor !== undefined) next.seen_cursor = Math.max(current.seen_cursor, body.seen_cursor);
    if (body.pinned !== undefined) next.pinned = body.pinned;
    if (body.done === true) next.done_at = new Date(now).toISOString();
    if (body.done === false) delete next.done_at;
    if (body.snoozed_until === null) delete next.snoozed_until;
    else if (body.snoozed_until !== undefined) next.snoozed_until = body.snoozed_until;
    st.person.set(sessionId, next);
    bump(st, sessionId);
    return reply(200, next);
  }
  if (route.endsWith("/events") && method === "GET") {
    const epoch = url.searchParams.has("epoch") ? Number(url.searchParams.get("epoch")) : session.epoch;
    const copy = st.copyOf(sessionId);
    const through = copy.at(-1)?.cursor ?? 0;
    if (epoch !== session.epoch) return reply(200, { epoch: session.epoch, through, events: [], more: false, reset: true });
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 2000), 1), 2000);
    const page: Array<CopiedEvent> = [];
    let bytes = 0;
    for (const event of copy) {
      if (event.cursor <= after) continue;
      const size = JSON.stringify(event).length;
      if (page.length >= limit || (page.length > 0 && bytes + size > 1024 * 1024)) break;
      page.push(event);
      bytes += size;
    }
    const last = page.at(-1)?.cursor ?? after;
    return reply(200, { epoch: session.epoch, through, events: page, more: last < through });
  }
  const callMatch = /\/calls\/([^/]+)$/.exec(route);
  if (callMatch && method === "GET") {
    const requestId = decodeURIComponent(callMatch[1]!);
    const call = [...st.calls.values()].find((c) => c.session_id === sessionId && c.person === person && c.request_id === requestId);
    return call ? reply(200, callStateOf(call)) : refuse(404, "cave_not_found");
  }
  if (route.endsWith("/calls") && method === "POST") {
    const body = strictBody("call");
    if (body === undefined) return true;
    const out = Schema.decodeUnknownExit(CallRequest)(body);
    if (out._tag === "Failure") {
      const known = ["turn.submit", "turn.interrupt", "ask.respond"].includes(String(body.method));
      return known ? refuse(400, "cave_bad_request") : refuse(400, "cave_code_call_method", "Only turn.submit, turn.interrupt and ask.respond queue in Cloud.");
    }
    if (!requestIdFits(out.value.request_id)) return refuse(400, "cave_bad_request", REQUEST_ID_TOO_LONG);
    const key = JSON.stringify([out.value.method, out.value.params]);
    const existing = [...st.calls.values()].find((c) => c.session_id === sessionId && c.person === person && c.request_id === out.value.request_id);
    // A forward under this request id answers it whatever the params (only the method must match).
    if (existing) return existing.params_key === key || (existing.forwarded_by_runtime_id !== undefined && existing.method === out.value.method) ? reply(202, callStateOf(existing)) : refuse(409, "cave_code_request_id_conflict");
    const call: TestCall = {
      id: randomUUID(),
      session_id: sessionId,
      person,
      request_id: out.value.request_id,
      method: out.value.method,
      // As the device sent them (its signature covers them); the runtime adds the request id when it runs the call.
      params: out.value.params,
      params_key: key,
      status: "queued",
      created_at: now,
      ...(out.value.device_id ? { device_id: out.value.device_id } : {}),
      ...(out.value.device ? { device: out.value.device } : {}),
    };
    st.calls.set(call.id, call);
    // It wakes the chat's Cloud computer.
    const computer = st.computers.get(session.computer_id);
    if (computer?.kind === "cloud" && (computer.state === "suspended" || computer.state === "stopped")) computer.state = "starting";
    routeCalls(st, now);
    bump(st, sessionId);
    return reply(202, callStateOf(call));
  }
  if (route.endsWith("/move") && method === "POST") {
    // chats_moves.go MoveChat: to "cloud" or {computer_id}, and the request id and signature of the device that asked
    // (This Mac moves a chat only for a device it allowed, handlers actOnMove); the chat's own runtime moves it when online.
    const body = strictBody("person_move") as { to?: "cloud" | { computer_id?: string; runtime_id?: string }; request_id?: string; device?: { device_id: string; at: string; signature: string } } | undefined;
    if (body === undefined) return true;
    if (typeof body.to === "object" && body.to.runtime_id !== undefined) return refuse(400, "cave_bad_request", 'to is "cloud" or {"computer_id": …}.');
    const target = body.to === "cloud" ? st.cloudComputerFor(person, session.computer_id) : typeof body.to === "object" ? body.to.computer_id : undefined;
    if (target === undefined || (typeof body.to === "object" && st.computers.get(target)?.person !== person)) return refuse(404, "cave_not_found", "No such computer.");
    if (target === session.computer_id) return refuse(409, "cave_code_already_there");
    if (session.movable_flag !== true) return refuse(409, "cave_code_session_not_movable", "This chat stays where it runs.");
    if (macAway(st, body.to, target, now)) return refuse(409, "cave_code_target_silent", TARGET_SILENT);
    if (ownerAwake(st, session, now) || leaseLive(session, now)) {
      // The owner lets it go at its turn boundary: mailed as C1 mails it (to_cloud or to_computer_id, never a runtime),
      // with the person's word as their device signed it.
      const where = body.to === "cloud" ? { to_cloud: true } : { to_computer_id: target };
      const asked = { user_id: person, ...(body.to !== undefined ? { to: body.to } : {}), ...(body.request_id ? { request_id: body.request_id } : {}), ...(body.device ? { device: body.device } : {}) };
      st.link?.post({ verb: "handoff", authority: "system", channel: "move", to_workspace_id: session.workspace_id, body: JSON.stringify({ action: "move", session_id: sessionId, reason: "user", ...where, ...asked }) });
      st.moveRequests.push({ session_id: sessionId, to: body.to, by: person, pending: true });
      return reply(202, { pending: true, computer_id: session.computer_id });
    }
    // A Mac's chat goes to another Mac only on its own Mac's word, which names where it went (chats_moves.go MoveChat).
    if (typeof body.to === "object" && st.computers.get(session.computer_id)?.kind === "laptop" && st.computers.get(target)?.kind === "laptop") return refuse(409, "cave_code_source_asleep", SOURCE_ASLEEP);
    if (session.segments.length === 0) return refuse(409, "cave_code_nothing_to_move");
    // Cloud moves it itself (its owner is away): the target accepts first, with the person's word as their device signed it.
    const asked = { user_id: person, ...(body.to !== undefined ? { to: body.to } : {}), ...(body.request_id ? { request_id: body.request_id } : {}), ...(body.device ? { device: body.device } : {}) };
    const accepted = await askAccept(st, session, target, "user", asked, now);
    if (!accepted.ok) return refuse(409, accepted.code, accepted.message);
    moveChat(st, session, target, "user", st.link?.runtimesOf(session.computer_id)[0], { ...(accepted.move_id ? { move_id: accepted.move_id } : {}), asked });
    st.moveRequests.push({ session_id: sessionId, to: body.to, by: person, pending: false });
    return reply(200, { pending: false, computer_id: target });
  }
  return refuse(404, "cave_not_found");
}

/**
 * A person's ask for a chat on a Cloud computer (registry.go CreateWorkspace), and with `start` the chat's start queued
 * with it (chat_calls.go queueStart; CONTRACT §6.8): Cloud places a workspace on one of the person's Cloud computers,
 * makes its session, and queues the runtime's workspace.create for that session, naming the workspace it placed
 * whatever the client sent for it. The same person and request id again answer the first placement; with other params
 * it is refused. Without `start` it places and no more, and its answer names neither session nor call.
 */
function placeWorkspace(
  st: ChatsState,
  person: string,
  body: Record<string, unknown>,
  now: number,
): { readonly id: string; readonly computer_id: string; readonly session_id?: string; readonly start?: CallState } | { readonly error: { readonly status: number; readonly code: string; readonly message: string } } {
  const no = (status: number, code: string, message: string) => ({ error: { status, code, message } });
  const start = body.start as { request_id?: unknown; params?: unknown } | undefined;
  const cloud = (body.computer as { kind?: unknown } | undefined)?.kind === "cloud" && typeof body.repo === "string" && body.repo !== "";
  if (start !== undefined) {
    if (!cloud) return no(409, "cave_code_start_not_placed", "A start goes with a chat Cloud places on a Cloud computer.");
    if (typeof start.request_id !== "string" || start.request_id === "" || start.request_id.length > 150) return no(400, "cave_bad_request", "start.request_id is required and at most 150 characters.");
    if (typeof start.params !== "object" || start.params === null || Array.isArray(start.params)) return no(400, "cave_bad_request", "start.params is a JSON object: the runtime's workspace.create params.");
    if ("computer_id" in start.params) return no(400, "cave_bad_request", "start.params names no computer: Cloud places the chat.");
    const { placed_workspace_id: _never, ...sent } = start.params as Record<string, unknown>;
    const key = JSON.stringify(sent);
    const first = [...st.calls.values()].find((c) => c.method === START_METHOD && c.person === person && c.request_id === start.request_id);
    if (first !== undefined) {
      const session = st.sessions.get(first.session_id)!;
      return first.params_key === key ? { id: session.workspace_id, computer_id: session.computer_id, session_id: session.session_id, start: callStateOf(first) } : no(409, "cave_code_request_id_conflict", "This request_id already started a different chat.");
    }
    const computerId = st.cloudComputerFor(person);
    const workspaceId = randomUUID();
    st.placements.set(workspaceId, { computer_id: computerId });
    const session: TestChatSession = { session_id: randomUUID(), workspace_id: workspaceId, computer_id: computerId, person, engine: String(body.engine ?? "caveman"), repo: String(body.repo), follow: false, epoch: 1, cursor_seq: 0, segments: [], size_bytes: 0, lease: null };
    st.sessions.set(session.session_id, session);
    const call: TestCall = { id: randomUUID(), session_id: session.session_id, person, request_id: start.request_id, method: START_METHOD, params: { ...sent, placed_workspace_id: workspaceId }, params_key: key, status: "queued", created_at: now };
    st.calls.set(call.id, call);
    // It wakes the computer the chat was placed on.
    const computer = st.computers.get(computerId);
    if (computer?.kind === "cloud" && (computer.state === "suspended" || computer.state === "stopped")) computer.state = "starting";
    routeCalls(st, now);
    return { id: workspaceId, computer_id: computerId, session_id: session.session_id, start: callStateOf(call) };
  }
  if (!cloud) return no(400, "cave_bad_request", "The stand-in places only chats that ask for a Cloud computer on a repository.");
  const computerId = st.cloudComputerFor(person);
  const workspaceId = randomUUID();
  st.placements.set(workspaceId, { computer_id: computerId });
  return { id: workspaceId, computer_id: computerId };
}

/** One summary of a write, as chats.go PutChatSummary takes it: its seq, or the refusal (a batch carries it per chat). */
/**
 * A new chat's place on its Cloud computer, as Cloud's registration decides it (project_computers.go takeUpPlacement,
 * requirePlaceOfItsOwn; CONTRACT §6.3). `placed` is the registration's placed_workspace_id: a workspace id takes up
 * exactly that placement when it waits on the caller's computer, and is absent (404) when it is not on it; "" and a
 * placement taken already leave the chat one nobody placed, which needs a free place (409 on a full computer). A
 * registration that says nothing, from a runtime before the field, is taken as before.
 */
function placing(
  st: ChatsState,
  sessionId: string,
  computerId: string,
  placed: unknown,
  by: "register" | "summary",
): { readonly workspace_id?: string; readonly error?: { readonly status: number; readonly code: string; readonly message: string } } {
  st.placedAsked.push({ session_id: sessionId, placed: typeof placed === "string" ? placed : "absent", by });
  if (typeof placed !== "string") return {};
  if (placed !== "") {
    const placement = st.placements.get(placed);
    if (placement === undefined || placement.computer_id !== computerId) return { error: { status: 404, code: "cave_code_placement_not_here", message: "That workspace was not placed on this computer." } };
    if (placement.taken === undefined) {
      placement.taken = sessionId;
      return { workspace_id: placed };
    }
  }
  if (st.fullComputers.has(computerId)) return { error: { status: 409, code: "cave_code_computer_full", message: "That Cloud computer runs as many chats as it can: move this one to another Cloud computer, or to a new one." } };
  return {};
}

function putSummaryOne(
  st: ChatsState,
  raw: Record<string, unknown>,
  at: {
    readonly runtimeId: string;
    readonly computerId: string;
    readonly register: (id: string, fields: { engine: string; repo: string; follow: boolean; workspace_id?: string }) => TestChatSession;
    readonly mine: (session: TestChatSession | undefined) => boolean;
    readonly batch: boolean;
  },
): { readonly session_id: string; readonly seq?: number; readonly error?: { readonly status: number; readonly code: string; readonly message: string } } {
  const session_id = String(raw.session_id ?? "");
  const no = (status: number, code: string, message: string) => ({ session_id, error: { status, code, message } });
  const out = Schema.decodeUnknownExit(ChatSummaryInput)(raw);
  if (out._tag === "Failure") return no(400, "cave_bad_request", `not a chat summary: ${JSON.stringify(raw).slice(0, 200)}`);
  const summary = out.value;
  if ((summary.preview?.length ?? 0) > PREVIEW_MAX || (summary.needs_you?.summary.length ?? 0) > NEEDS_YOU_MAX) return no(400, "cave_bad_request", "preview is at most 280 characters, needs_you.summary 200.");
  // As Cloud's checkPlaceFacts: each refusal names its field.
  if (summary.stays !== undefined && !STAYS_CODE.test(summary.stays.code)) return no(400, "cave_bad_request", "stays.code is a code of lower-case letters, digits and underscores, at most 40 characters.");
  if (summary.moving !== undefined && summary.moving.to !== "cloud" && !COMPUTER_ID.test(summary.moving.to)) return no(400, "cave_bad_request", `moving.to is "cloud" or the computer id of one of the person's Macs.`);
  const found = st.sessions.get(session_id);
  if (found !== undefined && !at.mine(found)) return no(409, "cave_code_session_elsewhere", "The session's workspace is not on this runtime's computer.");
  // Nothing in Cloud, and nothing to keep.
  if (found === undefined && summary.sync === false) return { session_id, seq: 0 };
  // A chat Cloud does not know yet takes up its placement, or needs a place of its own (placing).
  const place = found === undefined ? placing(st, session_id, at.computerId, summary.placed_workspace_id, "summary") : {};
  if (place.error !== undefined) return no(place.error.status, place.error.code, place.error.message);
  // A chat its first summary registers syncs (follow), and does not move.
  const session = at.register(session_id, { engine: summary.engine, repo: summary.repo ?? "", follow: true, ...(place.workspace_id === undefined ? {} : { workspace_id: place.workspace_id }) });
  if (summary.sync !== undefined) {
    session.follow = summary.sync;
    if (!summary.sync) {
      unsync(st, session);
      return { session_id, seq: 0 };
    }
  }
  if (summary.epoch > 0 && summary.epoch !== session.epoch) return no(409, "cave_code_journal_epoch", `The journal is at epoch ${session.epoch}: this runtime holds another; rebuild from Cloud's copy.`);
  session.engine = summary.engine;
  const seq = st.summaries.get(session_id)?.seq ?? 0;
  st.summaries.set(session_id, { ...summary, workspace_id: summary.workspace_id, runtime_id: at.runtimeId, computer_id: at.computerId, seq });
  st.summaryPuts.push({
    session_id,
    batch: at.batch,
    status: summary.status,
    head: summary.head,
    ...(summary.preview !== undefined ? { preview: summary.preview } : {}),
    ...(summary.asked_by_session_id !== undefined ? { asked_by: summary.asked_by_session_id } : {}),
    ...(summary.movable !== undefined ? { movable: summary.movable } : {}),
    ...(summary.stays !== undefined ? { stays: summary.stays.code } : {}),
    ...(summary.moving !== undefined ? { moving: summary.moving } : {}),
  });
  // An archived chat is a chat with archived: true; only a chat that left Cloud is "gone".
  bump(st, session_id, "chat");
  return { session_id, seq: st.summaries.get(session_id)!.seq };
}

/** Undelivered, unleased mail on `channel` for workspaces on `computerId`. */
function mailWaiting(st: ChatsState, computerId: string, channel: string) {
  const mail = mailbox.get(st);
  if (mail === undefined) return false;
  const now = st.link?.now() ?? Date.now();
  // As a take hands it out (forCaller): mail to a workspace the chat sync does not place (a session Cloud started) too.
  return mail.some((m) => {
    if (m.delivered || (channel !== "" && m.channel !== channel) || (m.lease !== undefined && m.lease.expiresAt >= now)) return false;
    const at = m.to_computer_id ?? workspaceComputer(st, m.to_workspace_id);
    return at === undefined || at === computerId;
  });
}

/** The computer a chat workspace sits on, when the chat sync knows it. */
function workspaceComputer(st: ChatsState, workspaceId: string | null) {
  for (const session of st.sessions.values()) if (session.workspace_id === workspaceId) return session.computer_id;
  return undefined;
}

/** The mailbox the chat routes wait on (set by startTestCloud). */
const mailbox = new WeakMap<ChatsState, Array<TestMail>>();
