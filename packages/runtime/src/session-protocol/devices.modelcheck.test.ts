// relay-device-trust, part 2 (.claude/skills/relay-device-trust/SKILL.md): the gate on each relayed stream to This Mac
// (devices.ts makeDevices().gate), driven through every short sequence of what the device, the relay, Cloud, the
// person's screen and the clock can do; and the check a runner of Cloud-queued calls makes (queuedCallAllowed).
//
// Each sequence runs from scratch against a fresh makeDevices over the real SessionStore (in-memory SQLite), with real
// WebCrypto keys on both ends. Between steps nothing moves: the relay channel holds a send until a step drains it (as
// relay.ts does while its socket is over HIGH_WATER), Cloud holds a read of the person's log until a step answers it,
// and a timer of 500 ms or more waits for its own step. After a step everything else runs to rest (every WebCrypto job
// done, then the event loop idle), so one step is one event.
import { createDecipheriv, KeyObject } from "node:crypto";

import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import {
  DEVICE_CALL_MAX_AGE_MS,
  DEVICE_CALL_SKEW_MS,
  PAIRING_CODE_TTL_MS,
  channelKeys,
  ephemeralKey,
  frameParams,
  helloPayload,
  pairProof,
  sealFrame,
  sealedFrameAt,
  signCall,
  signStatement,
  toBase64url,
  type ChannelKeys,
  type DeviceKey,
  type DeviceList,
} from "@caveman-app/session-protocol";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { CALL_TIMEOUT_MS } from "../cloudLink/computers.ts";
import { LOG_WAIT_MS } from "../cloudLink/deviceLog.ts";
import type { Identity } from "../cloudLink/identity.ts";
import { CloudComputer } from "../cloudLink/index.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import {
  DevicesClock,
  LOG_PULL_MS,
  makeDevices,
  queuedCallAllowed,
  type FrameChannel,
  type FrameSink,
} from "./devices.ts";
import { testDevice } from "./devices.testkit.ts";
import { SessionStore, make as makeStore } from "./store.ts";

const ORG = "org-1";
const ME = "user-1";
const RUNTIME = "rt-this-mac";
/** devices.ts STALE_MS: a read of the log that finished longer ago than this (DevicesClock) is stale. */
const STALE_MS = LOG_WAIT_MS + CALL_TIMEOUT_MS;
/** server.ts DAY_MS: how long a request id's answer (its receipt) is kept for a queued call's methods. */
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ the world between steps

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realFetch = globalThis.fetch;
const subtle = globalThis.crypto.subtle as unknown as Record<
  string,
  (...args: Array<unknown>) => Promise<unknown>
>;
const SUBTLE = [
  "digest",
  "sign",
  "verify",
  "encrypt",
  "decrypt",
  "deriveBits",
  "deriveKey",
  "importKey",
  "exportKey",
  "generateKey",
] as const;
const originalSubtle = new Map(SUBTLE.map((name) => [name, subtle[name]!] as const));
let cryptoInFlight = 0;

/** Every WebCrypto job of a step done (the gate's and the device's), then the event loop idle for a few turns. */
const settle = async () => {
  for (let quiet = 0; quiet < 4;) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    quiet = cryptoInFlight > 0 ? 0 : quiet + 1;
  }
};

interface Parked {
  readonly ms: number;
  /** Set directly in devices.ts (the gate's hello and request timers); else an Effect sleep (pullLog's wait, follow's). */
  readonly gate: boolean;
  readonly fire: () => void;
}
/** Parks every timer of 500 ms or more until a step fires it; the set is this run's alone. */
const park = (): Set<Parked> => {
  const mine = new Set<Parked>();
  globalThis.setTimeout = ((
    fn: (...args: Array<unknown>) => void,
    ms?: number,
    ...args: Array<unknown>
  ) => {
    if (typeof ms !== "number" || ms < 500) return realSetTimeout(fn, ms, ...args);
    const timer: Parked & {
      unref(): unknown;
      ref(): unknown;
      hasRef(): boolean;
      refresh(): unknown;
    } = {
      ms,
      gate: (new Error().stack?.split("\n")[2] ?? "").includes("session-protocol/devices.ts"),
      fire: () => {
        mine.delete(timer);
        fn(...args);
      },
      unref: () => timer,
      ref: () => timer,
      hasRef: () => false,
      refresh: () => timer,
    };
    mine.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    if (!mine.delete(timer as Parked))
      realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return mine;
};
const unpark = () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = realFetch;
};

/** What the device reads in a frame the runtime sent it: sealed ones opened at their place, as a real device does. */
interface Sent {
  readonly what: string;
  held: boolean;
}

/** A relayed stream as relay.ts makes one: a send waits while the socket is backed up; close tells the sink at once. */
class Channel implements FrameChannel {
  readonly frames: Array<Sent> = [];
  readonly held: Array<{ readonly sent: Sent; readonly resolve: () => void }> = [];
  backedUp = false;
  closedWith: string | undefined;
  sink: FrameSink | undefined;
  /** The frame keys the device derived at its hello, to read what the runtime seals. */
  keys: ChannelKeys | undefined;
  /** The runtime's device.challenge, as the device reads it to sign its hello. */
  challenge:
    | { readonly nonce: string; readonly runtime_id: string; readonly key: string }
    | undefined;
  private sealedSeq = 0;
  send(data: string | Uint8Array): Promise<void> {
    if (this.closedWith !== undefined) return Promise.resolve();
    if (
      this.challenge === undefined &&
      typeof data === "string" &&
      data.includes('"device.challenge"')
    )
      this.challenge = (JSON.parse(data) as { params: NonNullable<Channel["challenge"]> }).params;
    const sent: Sent = { what: this.read(data), held: this.backedUp };
    this.frames.push(sent);
    if (!this.backedUp) return Promise.resolve();
    return new Promise<void>((resolve) => this.held.push({ sent, resolve }));
  }
  close(reason = "") {
    if (this.closedWith !== undefined) return;
    this.closedWith = reason || "closed";
    this.sink?.closed(this.closedWith);
  }
  drainOne() {
    const next = this.held.shift();
    if (next) {
      next.sent.held = false;
      next.resolve();
    }
    if (this.held.length === 0) this.backedUp = false;
  }
  private read(data: string | Uint8Array): string {
    if (typeof data !== "string") return "binary";
    let text = data;
    let sealed = "";
    if (data.includes('"device_frame"')) {
      const seq = ++this.sealedSeq;
      const ct = this.keys ? sealedFrameAt(data, seq) : undefined;
      if (!this.keys || !ct) return "sealed (unreadable)";
      const { iv, aad } = frameParams("to_device", seq);
      const decipher = createDecipheriv("aes-256-gcm", KeyObject.from(this.keys.to_device), iv, {
        authTagLength: 16,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(ct.subarray(ct.length - 16));
      text = Buffer.concat([
        decipher.update(ct.subarray(0, ct.length - 16)),
        decipher.final(),
      ]).toString("utf8");
      sealed = " (sealed)";
    }
    const m = JSON.parse(text) as {
      method?: string;
      params?: { status?: string };
      result?: { status?: string };
      error?: { message?: string };
    };
    if (m.method === "device.status") return `status ${m.params?.status}${sealed}`;
    if (m.method) return `${m.method}${sealed}`;
    if (m.error)
      return `error ${m.error.message?.startsWith("That code did not join") ? "(pairing code refused)" : `"${m.error.message?.slice(0, 40)}"`}${sealed}`;
    return m.result?.status ? `answer ${m.result.status}${sealed}` : `reply${sealed}`;
  }
}

/** Cloud's side of the person's device log: statements numbered from 1, and the reads it holds until a step answers them. */
class Cloud {
  readonly log: Array<unknown> = [];
  readonly reads: Array<{ readonly answer: () => void; readonly fail: () => void }> = [];
  /** Each answered read: when it went out (DevicesClock) and whether the log it answered held the removal. */
  readonly answered: Array<{ readonly sentAt: number; readonly removed: boolean }> = [];
  removal: unknown;
  fetchWith = (now: () => number) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if ((init?.method ?? "GET") !== "GET")
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      const after = Number(url.searchParams.get("after") ?? 0);
      const sentAt = now();
      return new Promise<Response>((resolve, reject) => {
        const read = {
          answer: () => {
            this.answered.push({
              sentAt,
              removed: this.removal !== undefined && this.log.includes(this.removal),
            });
            const statements = this.log
              .slice(after)
              .map((statement, i) => ({ seq: after + i + 1, statement }));
            resolve(
              new Response(JSON.stringify({ statements, seq: this.log.length }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          },
          fail: () => reject(new DOMException("The operation was aborted", "AbortError")),
        };
        this.reads.push(read);
        init?.signal?.addEventListener("abort", () => {
          const at = this.reads.indexOf(read);
          if (at >= 0) this.reads.splice(at, 1);
          read.fail();
        });
      });
    }) as typeof fetch;
}

interface Side {
  readonly key: DeviceKey;
  readonly channel: Channel;
  sink: FrameSink;
  helloSent: boolean;
  /** The bodies this device sealed, frame k at seq k, and the frames. */
  readonly bodies: Array<string>;
  readonly sealed: Array<string>;
  /** What the gate handed the Session Protocol server (inner.message), in order. */
  readonly delivered: Array<string>;
  served: number;
  /** Whether the server's connection for this stream heard it closed. */
  serverClosed: boolean;
  /** Set after a step that left this device blocked here or removed by one of the person's Macs. */
  cutOff: boolean;
  /** Whether its hello's pairing code should join (one live code, used up by the first try, right or wrong, 10 minutes). */
  pairExpected?: boolean;
}

interface Config {
  readonly label: string;
  /** This Mac's enrollment names the person, and the log is followed; else its screen alone allows. */
  readonly enrolled: boolean;
  /** Mac M allowed on this screen as a Mac before the sequence (its statements count). */
  readonly macRoot: boolean;
  /** The device on stream 0 allowed on this screen before the sequence. */
  readonly deviceRoot: boolean;
  /** One stream per key: the device (stream 0 in every config but pairing) or the person's other Macs. */
  readonly sides: ReadonlyArray<"device" | "mac">;
}

type Devices = Effect.Success<ReturnType<typeof makeDevices>>;

interface World {
  readonly devices: Devices;
  readonly sides: Array<Side>;
  readonly clock: { now: number };
  readonly cloud: Cloud;
  readonly parked: Set<Parked>;
  readonly violations: Array<string>;
  follow: Fiber.Fiber<void> | undefined;
  /** DevicesClock at the last sleep past the stale window (or the start). */
  sleptAt: number;
  callsInFlight: number;
  calls: number;
  /** What queuedCallAllowed answered each queued call, in order. */
  readonly verdicts: Array<string>;
  pairing: { readonly code: string; readonly shownAt: number; tried: boolean } | undefined;
}

let storeRuntime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
let store: SessionStore["Service"];
let keys: {
  readonly device: DeviceKey;
  readonly mac: DeviceKey;
  readonly macs: ReadonlyArray<DeviceKey>;
};

beforeAll(async () => {
  storeRuntime = ManagedRuntime.make(NodeSqliteClient.layer({ filename: ":memory:" }));
  store = await storeRuntime.runPromise(
    makeStore.pipe(Effect.provideService(ProjectSecrets, {} as ProjectSecrets["Service"])),
  );
  keys = {
    device: await testDevice("iPhone, Safari"),
    mac: await testDevice("Studio", "mac"),
    macs: [await testDevice("MacBook", "mac"), await testDevice("Mac mini", "mac")],
  };
  for (const name of SUBTLE) {
    const original = originalSubtle.get(name)!;
    subtle[name] = (...args: Array<unknown>) => {
      cryptoInFlight++;
      return original.apply(globalThis.crypto.subtle, args).finally(() => void cryptoInFlight--);
    };
  }
});

afterAll(async () => {
  for (const [name, original] of originalSubtle) subtle[name] = original;
  await storeRuntime.dispose();
});

const listOf = (w: World): DeviceList => Effect.runSync(w.devices.list);
const allowedNow = (w: World, side: Side) =>
  listOf(w).devices.some((d) => d.device_id === side.key.device_id);
const open = (side: Side) => side.channel.closedWith === undefined;

const identity: Identity = {
  cloudUrl: "http://cloud.test",
  runtimeId: RUNTIME,
  organizationId: ORG,
  computerId: "c-this-mac",
  key: undefined as never,
  userId: ME,
};

async function start(config: Config, parked: Set<Parked>): Promise<World> {
  await storeRuntime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM caveman_sp_kv`;
    }),
  );
  const at = "2026-11-06T09:00:00.000Z";
  const root = (key: DeviceKey, role: "mac" | "device") => ({
    device_id: key.device_id,
    name: key.name,
    public_key: key.public_key,
    user_id: ME,
    added_at: at,
    role,
  });
  const seeded = [
    ...(config.macRoot ? [root(keys.mac, "mac")] : []),
    ...(config.deviceRoot ? [root(keys.device, "device")] : []),
  ];
  if (seeded.length > 0)
    await Effect.runPromise(
      store.kvSet(
        "devices",
        JSON.stringify({
          devices: seeded,
          requests: [],
          blocked: [],
          outbox: [],
          refused: {},
          lifted: [],
          retired: [],
          seen: {},
        }),
      ),
    );
  const clock = { now: Date.parse("2026-11-06T10:00:00.000Z") };
  const devices = await Effect.runPromise(
    makeDevices({ notifyLocal: () => undefined, runtimeName: () => "This Mac" }).pipe(
      Effect.provideService(SessionStore, store),
      Effect.provideService(CloudComputer, undefined),
      Effect.provideService(DevicesClock, () => clock.now),
    ),
  );
  const cloud = new Cloud();
  globalThis.fetch = cloud.fetchWith(() => clock.now);
  const w: World = {
    devices,
    sides: [],
    clock,
    cloud,
    parked,
    violations: [],
    follow: undefined,
    sleptAt: Number.NEGATIVE_INFINITY,
    callsInFlight: 0,
    calls: 0,
    verdicts: [],
    pairing: undefined,
  };
  if (config.enrolled)
    w.follow = Effect.runFork(
      devices.follow({
        identity: () => identity,
        link: { cloudUrl: identity.cloudUrl, token: "runtime-token" },
      }),
    );
  config.sides.forEach((kind, i) => {
    const key =
      kind === "device"
        ? keys.device
        : keys.macs[config.sides.slice(0, i).filter((k) => k === "mac").length]!;
    const channel = new Channel();
    const side: Side = {
      key,
      channel,
      sink: undefined as never,
      helloSent: false,
      bodies: [],
      sealed: [],
      delivered: [],
      served: 0,
      serverClosed: false,
      cutOff: false,
    };
    side.sink = devices.gate!(channel, { runtimeId: RUNTIME, userId: ME }, () => {
      side.served++;
      if (!open(side))
        w.violations.push(
          `the gate started serving ${key.name}'s stream after it closed (a server connection nothing ever closes)`,
        );
      else if (side.cutOff)
        w.violations.push(
          `the gate started serving ${key.name}'s stream after its device stopped being allowed here`,
        );
      return {
        message: (body) => {
          side.delivered.push(typeof body === "string" ? body : "<bytes>");
          if (side.cutOff || !allowedNow(w, side))
            w.violations.push(
              `the gate handed the server a frame from ${key.name} while it is not allowed here`,
            );
        },
        closed: () => void (side.serverClosed = true),
      };
    });
    channel.sink = side.sink;
    w.sides.push(side);
  });
  await settle();
  return w;
}

async function stop(w: World) {
  if (w.follow) await Effect.runPromise(Fiber.interrupt(w.follow));
  for (const side of w.sides) {
    while (side.channel.held.length > 0) side.channel.drainOne();
    side.channel.close("the run ended");
  }
  for (const read of w.cloud.reads.splice(0)) read.fail();
  await settle();
}

// ------------------------------------------------------------------ steps

interface Action {
  readonly name: string;
  /** How many times one sequence may take it (default: as often as the depth allows). */
  readonly max?: number;
  readonly enabled: (w: World) => boolean;
  readonly run: (w: World) => Promise<void>;
}

const bodyOf = (k: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 100 + k,
    method: "turn.submit",
    params: {
      request_id: `r-${k}`,
      session_id: "s-1",
      kind: "followup",
      input: { text: `frame ${k}` },
    },
  });

/** device.hello as a real device makes it (v2: kind and name signed), with a pairing proof when `pair` is given. */
async function sayHello(side: Side, pair?: { readonly code: string }) {
  const challenge = side.channel.challenge!;
  const ephemeral = await ephemeralKey();
  const kind = side.key.kind ?? "device";
  const payload = helloPayload({
    runtime_id: challenge.runtime_id,
    nonce: challenge.nonce,
    runtime_key: challenge.key,
    device_key: ephemeral.public_key,
    v2: { kind, name: side.key.name },
  });
  const signature = toBase64url(await side.key.sign(payload));
  const frameKeys = await channelKeys({
    privateKey: ephemeral.privateKey,
    peer_key: challenge.key,
    runtime_id: challenge.runtime_id,
    nonce: challenge.nonce,
    runtime_key: challenge.key,
    device_key: ephemeral.public_key,
  });
  side.channel.keys = frameKeys;
  for (let k = 1; k <= 2; k++) {
    side.bodies.push(bodyOf(k));
    side.sealed.push(await sealFrame(frameKeys.to_runtime, k, bodyOf(k), "to_runtime"));
  }
  const proof =
    pair === undefined ? undefined : await pairProof(pair.code, side.key.device_id, payload);
  side.helloSent = true;
  side.sink.message(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "device.hello",
      method: "device.hello",
      params: {
        device_id: side.key.device_id,
        name: side.key.name,
        public_key: side.key.public_key,
        key: ephemeral.public_key,
        signature,
        kind,
        ...(proof ? { pair: proof } : {}),
      },
    }),
  );
}

const local = (w: World, method: "device.allow" | "device.remove", deviceId: string) =>
  Effect.runPromiseExit(
    w.devices.handlers[method]({ device_id: deviceId }, { principal: "local" }) as Effect.Effect<
      unknown,
      unknown
    >,
  );
const device = (w: World) => w.sides[0]!;
const byMac = (kind: "allow" | "remove", of: DeviceKey) =>
  signStatement(
    keys.mac,
    kind === "allow"
      ? {
          kind,
          organization_id: ORG,
          user_id: ME,
          device_id: of.device_id,
          public_key: of.public_key,
          name: of.name,
          role: "device",
        }
      : { kind, organization_id: ORG, user_id: ME, device_id: of.device_id },
  );

const hello: Action = {
  name: "the device says device.hello",
  max: 1,
  enabled: (w) =>
    open(device(w)) && !device(w).helloSent && device(w).channel.challenge !== undefined,
  run: (w) => sayHello(device(w)),
};
const frame = (k: number): Action => ({
  name: `the relay delivers the device's sealed frame ${k}`,
  max: 2,
  enabled: (w) => open(device(w)) && device(w).helloSent,
  run: async (w) => device(w).sink.message(device(w).sealed[k - 1]!),
});
const plain: Action = {
  name: "the relay sends an unsealed turn.submit",
  max: 1,
  enabled: (w) => open(device(w)),
  run: async (w) =>
    device(w).sink.message(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "plain",
        method: "turn.submit",
        params: {
          request_id: "plain",
          session_id: "s-1",
          kind: "followup",
          input: { text: "plain" },
        },
      }),
    ),
};
const allow: Action = {
  name: "the screen allows the device",
  max: 1,
  enabled: (w) => listOf(w).requests.some((r) => r.device_id === device(w).key.device_id),
  run: async (w) => void (await local(w, "device.allow", device(w).key.device_id)),
};
const remove: Action = {
  name: "the screen removes the device",
  max: 1,
  enabled: (w) => {
    const list = listOf(w);
    const id = device(w).key.device_id;
    return (
      list.devices.some((d) => d.device_id === id) || list.requests.some((r) => r.device_id === id)
    );
  },
  run: async (w) => void (await local(w, "device.remove", device(w).key.device_id)),
};
const backUp: Action = {
  name: "the relay socket backs up (sends wait)",
  max: 1,
  enabled: (w) => open(device(w)) && !device(w).channel.backedUp,
  run: async (w) => void (device(w).channel.backedUp = true),
};
const drain: Action = {
  name: "the relay drains one frame",
  enabled: (w) => device(w).channel.held.length > 0,
  run: async (w) => device(w).channel.drainOne(),
};
const leave: Action = {
  name: "the device leaves (the relay closes the stream)",
  max: 1,
  enabled: (w) => open(device(w)),
  run: async (w) => device(w).channel.close("the client left"),
};
const timer: Action = {
  name: "the gate's timer fires",
  max: 1,
  enabled: (w) => open(device(w)) && [...w.parked].some((t) => t.gate),
  run: async (w) => {
    const due = [...w.parked].find((t) => t.gate)!;
    w.clock.now += due.ms;
    due.fire();
  },
};
const logAllow: Action = {
  name: "Mac M's allow of the device lands in Cloud's log",
  max: 1,
  enabled: () => true,
  run: async (w) => void w.cloud.log.push(await byMac("allow", keys.device)),
};
const logRemove: Action = {
  name: "Mac M's removal of the device lands in Cloud's log",
  max: 1,
  enabled: () => true,
  run: async (w) => {
    w.cloud.removal = await byMac("remove", keys.device);
    w.cloud.log.push(w.cloud.removal);
  },
};
const answer: Action = {
  name: "Cloud answers the reads it holds",
  enabled: (w) => w.cloud.reads.length > 0,
  run: async (w) => w.cloud.reads.splice(0).forEach((read) => read.answer()),
};
const logWait: Action = {
  name: "a 2 s wait on the log runs out",
  enabled: (w) => [...w.parked].some((t) => !t.gate && t.ms === LOG_PULL_MS),
  run: async (w) => {
    w.clock.now += LOG_PULL_MS;
    [...w.parked].find((t) => !t.gate && t.ms === LOG_PULL_MS)!.fire();
  },
};
const sleep: Action = {
  name: "This Mac sleeps past the stale window",
  max: 1,
  enabled: () => true,
  run: async (w) => {
    w.clock.now += STALE_MS + 1;
    w.sleptAt = w.clock.now;
  },
};
const call: Action = {
  name: "a call the device queued arrives",
  max: 2,
  enabled: (w) => w.callsInFlight === 0,
  run: async (w) => {
    const queued = {
      session_id: "s-1",
      request_id: `call-${w.calls++}`,
      method: "turn.submit",
      params: { session_id: "s-1", kind: "followup", input: { text: "queued" } },
    };
    const signed = await signCall(keys.device, queued, w.clock.now);
    w.callsInFlight++;
    void w.devices.queuedCallAllowed(ME, queued, signed).then((verdict) => {
      w.callsInFlight--;
      w.verdicts.push(`${queued.request_id} ${verdict.ok ? "runs" : `refused (${verdict.code})`}`);
      if (!verdict.ok) return;
      const fresh = w.cloud.answered.filter((read) => read.sentAt >= w.sleptAt);
      if (fresh.length === 0)
        w.violations.push("a queued call ran on trust not read since This Mac slept or started");
      else if (fresh.some((read) => read.removed))
        w.violations.push("a queued call ran from a device whose removal This Mac had read");
      if (!allowedNow(w, device(w)))
        w.violations.push("a queued call ran from a device not allowed here");
    });
  },
};
const showCode: Action = {
  name: "the screen shows a pairing code",
  max: 1,
  enabled: () => true,
  run: async (w) => {
    const shown = await Effect.runPromise(
      w.devices.handlers["device.pair.start"]({}, { principal: "local" }) as Effect.Effect<
        { readonly code: string },
        unknown
      >,
    );
    w.pairing = { code: shown.code, shownAt: w.clock.now, tried: false };
  },
};
const pairHello = (index: number, right: boolean): Action => ({
  name: `Mac ${index + 1} says hello with ${right ? "the" : "a wrong"} code`,
  max: 1,
  enabled: (w) =>
    open(w.sides[index]!) &&
    !w.sides[index]!.helloSent &&
    w.sides[index]!.channel.challenge !== undefined,
  run: async (w) => {
    const live = w.pairing;
    w.sides[index]!.pairExpected =
      right &&
      live !== undefined &&
      !live.tried &&
      w.clock.now <= live.shownAt + PAIRING_CODE_TTL_MS;
    if (live) live.tried = true;
    await sayHello(w.sides[index]!, { code: right && live ? live.code : "0000-0000-0000" });
  },
});
const codeLapses: Action = {
  name: "the pairing code's 10 minutes pass",
  max: 1,
  enabled: (w) => w.pairing !== undefined,
  run: async (w) => void (w.clock.now += PAIRING_CODE_TTL_MS + 1),
};

// ------------------------------------------------------------------ properties

/** After every step: what the gate did so far. */
const stepChecks = (w: World): Array<string> => {
  const out = [...w.violations];
  for (const side of w.sides) {
    side.delivered.forEach((body, i) => {
      if (body !== side.bodies[i])
        out.push(
          `the server got ${side.bodies.includes(body) ? "a sealed frame out of its place (replayed or reordered)" : "a frame the device never sealed"} (delivery ${i + 1})`,
        );
    });
    if (side.served > 1) out.push(`the gate served ${side.key.name}'s stream twice`);
    if (side.cutOff && side.served > 0 && !side.serverClosed)
      out.push(
        `the server's connection for ${side.key.name}'s stream outlived its device's removal`,
      );
    if (side.pairExpected !== undefined) {
      const refused = side.channel.frames.some((f) => f.what === "error (pairing code refused)");
      if (side.pairExpected && refused)
        out.push(`a live, untried pairing code did not join ${side.key.name}`);
      if (!side.pairExpected && !refused && side.helloSent)
        out.push(
          `a pairing code joined ${side.key.name} though it was used, wrong, or past its 10 minutes`,
        );
    }
  }
  return out;
};

/** Once the run is over and every held send drained: what the stream promises once nothing is left to do. */
const endChecks = (w: World): Array<string> => [
  ...w.sides.flatMap((side) => [
    ...(side.cutOff && open(side)
      ? [`${side.key.name}'s stream is still open after its device stopped being allowed here`]
      : []),
    ...(open(side) && side.served > 0 && !allowedNow(w, side)
      ? [`${side.key.name}'s stream is served while its device is not allowed here`]
      : []),
  ]),
  // A timer the gate armed holds its stream (keys, closures) until it fires: up to DEVICE_REQUEST_TTL_MS for nothing.
  ...(w.sides.every((side) => !open(side)) && [...w.parked].some((t) => t.gate)
    ? ["a gate timer is still armed after every stream closed"]
    : []),
];

/**
 * A stream whose device said hello (so the gate knows whose it is) is cut off for the rest of the run once this screen
 * blocked that device or one of the person's Macs removed it. A stream that never said hello names no device yet.
 */
const noteCutOffs = (w: World) => {
  const blocked = listOf(w).blocked;
  for (const side of w.sides)
    if (side.helloSent && blocked.some((b) => b.device_id === side.key.device_id))
      side.cutOff = true;
};

const tell = (w: World) =>
  (w.verdicts.length > 0 || w.callsInFlight > 0
    ? `queued calls: [${w.verdicts.join(", ")}]${w.callsInFlight > 0 ? " + 1 waiting" : ""} / `
    : "") +
  w.sides
    .map((side) => {
      const frames = side.channel.frames.map((f) => `${f.what}${f.held ? " [held]" : ""}`);
      return `${side.key.name}: sent [${frames.join(", ")}], ${open(side) ? "open" : `closed (${side.channel.closedWith})`}, served ${side.served}, delivered ${side.delivered.length}${side.cutOff ? ", cut off" : ""}`;
    })
    .join(" / ");

interface Outcome {
  readonly broken?: { readonly property: string; readonly at: number };
  readonly enabled: ReadonlyArray<string>;
}

async function runSequence(
  config: Config,
  alphabet: ReadonlyArray<Action>,
  sequence: ReadonlyArray<string>,
  options: { readonly told?: Array<string> } = {},
): Promise<Outcome> {
  const parked = park();
  try {
    const w = await start(config, parked);
    const counts = new Map<string, number>();
    const fail = async (property: string, at: number): Promise<Outcome> => {
      await stop(w);
      return { broken: { property, at }, enabled: [] };
    };
    for (const [i, name] of sequence.entries()) {
      const action = alphabet.find((a) => a.name === name);
      if (!action) throw new Error(`no step named "${name}" in this alphabet`);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      await action.run(w);
      await settle();
      noteCutOffs(w);
      options.told?.push(`${i + 1}. ${name}\n     ${tell(w)}`);
      const bad = stepChecks(w);
      if (bad.length > 0) return fail(bad[0]!, i + 1);
    }
    const enabled = alphabet
      .filter((a) => (a.max === undefined || (counts.get(a.name) ?? 0) < a.max) && a.enabled(w))
      .map((a) => a.name);
    for (const side of w.sides)
      while (side.channel.held.length > 0) {
        side.channel.drainOne();
        await settle();
      }
    noteCutOffs(w);
    options.told?.push(`end: every held send drained\n     ${tell(w)}`);
    const bad = [...stepChecks(w), ...endChecks(w)];
    if (bad.length > 0) return fail(bad[0]!, sequence.length + 1);
    await stop(w);
    return { enabled };
  } finally {
    unpark();
  }
}

/** One sequence comes to rest in milliseconds; one still running after this waits on something no step gives. */
const SEQUENCE_HANG_MS = 60_000;

const notHung = <A>(run: Promise<A>, sequence: ReadonlyArray<string>) =>
  new Promise<A>((resolve, reject) => {
    const timer = realSetTimeout(
      () =>
        reject(
          new Error(
            `a sequence did not come to rest in ${SEQUENCE_HANG_MS / 1000} s: [${sequence.join(" | ")}]`,
          ),
        ),
      SEQUENCE_HANG_MS,
    );
    run.then(resolve, reject).finally(() => realClearTimeout(timer));
  });

/**
 * Breadth-first over every sequence of enabled steps up to `maxDepth`, each run from a fresh world, so the first broken
 * promise comes back with the shortest sequence that breaks it, told step by step.
 */
async function explore(config: Config, alphabet: ReadonlyArray<Action>, maxDepth: number) {
  const started = performance.now();
  let runs = 0;
  let steps = 0;
  let frontier: Array<Array<string>> = [[]];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Array<Array<string>> = [];
    for (const sequence of frontier) {
      const outcome = await notHung(runSequence(config, alphabet, sequence), sequence);
      runs++;
      steps += sequence.length;
      if (outcome.broken) {
        const told: Array<string> = [];
        await runSequence(config, alphabet, sequence.slice(0, outcome.broken.at), { told });
        const message = `relay-device-trust gate (${config.label}): "${outcome.broken.property}" after ${runs} sequences:\n  ${told.join("\n  ")}`;
        console.log(message);
        return {
          ok: false as const,
          message,
          property: outcome.broken.property,
          sequence: sequence.slice(0, outcome.broken.at),
          runs,
        };
      }
      if (depth < maxDepth) for (const name of outcome.enabled) next.push([...sequence, name]);
    }
    frontier = next;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `relay-device-trust gate (${config.label}): ${runs} sequences, ${steps} steps, every sequence of at most ${maxDepth} steps, ${seconds} s`,
  );
  return { ok: true as const, runs };
}

// ------------------------------------------------------------------ the checks

const screenOnly: Config = {
  label: "screen only, a new device",
  enrolled: false,
  macRoot: false,
  deviceRoot: false,
  sides: ["device"],
};
const screenKnown: Config = {
  label: "screen only, a device this screen allowed",
  enrolled: false,
  macRoot: false,
  deviceRoot: true,
  sides: ["device"],
};
const followed: Config = {
  label: "the person's log, a new device, Mac M allowed here",
  enrolled: true,
  macRoot: true,
  deviceRoot: false,
  sides: ["device"],
};
const calls: Config = {
  label: "queued calls, the device and Mac M allowed here",
  enrolled: true,
  macRoot: true,
  deviceRoot: true,
  sides: ["device"],
};
const pairing: Config = {
  label: "Add a Mac: two Macs try the code",
  enrolled: true,
  macRoot: false,
  deviceRoot: false,
  sides: ["mac", "mac"],
};

const DEPTH =
  process.env.RDT_GATE_DEPTH === undefined ? undefined : Number(process.env.RDT_GATE_DEPTH);
const runs: ReadonlyArray<{
  readonly config: Config;
  readonly alphabet: ReadonlyArray<Action>;
  readonly depth: number;
}> = [
  {
    config: screenOnly,
    alphabet: [hello, frame(1), frame(2), plain, allow, remove, backUp, drain, leave, timer],
    depth: 5,
  },
  {
    config: screenKnown,
    alphabet: [hello, frame(1), frame(2), plain, remove, backUp, drain, leave, timer],
    depth: 5,
  },
  {
    config: followed,
    alphabet: [
      hello,
      frame(1),
      allow,
      remove,
      backUp,
      drain,
      leave,
      timer,
      logAllow,
      logRemove,
      answer,
      logWait,
    ],
    depth: 5,
  },
  { config: calls, alphabet: [sleep, logRemove, answer, logWait, call], depth: 6 },
  {
    config: pairing,
    alphabet: [
      showCode,
      pairHello(0, true),
      pairHello(1, true),
      pairHello(0, false),
      codeLapses,
      answer,
      logWait,
    ],
    depth: 5,
  },
];

// No wall-clock budget: the depth bounds the work, and a loaded machine only makes it slower. A test cut off by one
// left its exploration running on the patched timers and fetch beside the next test's.
for (const { config, alphabet, depth } of runs)
  test(`gate keeps every promise: ${config.label}`, { timeout: 0 }, async () => {
    const outcome = await explore(config, alphabet, DEPTH ?? depth);
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
  });

/** `RDT_TRACE="step|step|..."` (names as a counterexample prints them) and `RDT_TRACE_CONFIG=<label>` tell one sequence. */
test.runIf(process.env.RDT_TRACE !== undefined)("gate: tell one sequence (RDT_TRACE)", async () => {
  const sequence = process.env
    .RDT_TRACE!.split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const chosen = runs.find(
    (r) => r.config.label === (process.env.RDT_TRACE_CONFIG ?? screenOnly.label),
  );
  if (!chosen)
    throw new Error(`RDT_TRACE_CONFIG is one of: ${runs.map((r) => r.config.label).join("; ")}`);
  const told: Array<string> = [];
  const outcome = await runSequence(chosen.config, chosen.alphabet, sequence, { told });
  console.log(
    `${told.join("\n")}\n${outcome.broken ? `broken: ${outcome.broken.property}` : `holds; enabled next: ${outcome.enabled.join("; ")}`}`,
  );
});

// ------------------------------------------------------------------ queuedCallAllowed

const queued = {
  session_id: "s-1",
  request_id: "r-1",
  method: "turn.submit",
  params: { session_id: "s-1", kind: "followup", input: { text: "go" } },
};

it.effect.prop(
  "queuedCallAllowed runs only the exact call an allowed device signed for this person: any one field changed is refused",
  {
    field: Schema.Literals([
      "session_id",
      "request_id",
      "method",
      "params",
      "at",
      "device_id",
      "signature",
      "user_id",
      "signer",
    ]),
    text: Schema.String,
    offsetMs: Schema.Int.check(
      Schema.isBetween({ minimum: -DEVICE_CALL_SKEW_MS, maximum: DEVICE_CALL_MAX_AGE_MS }),
    ),
  },
  ({ field, text, offsetMs }) =>
    Effect.promise(async () => {
      const now = Date.parse("2026-11-06T10:00:00.000Z");
      const allowed = [
        { device_id: keys.device.device_id, user_id: ME, public_key: keys.device.public_key },
      ];
      const signed = await signCall(keys.device, queued, now - offsetMs);
      if (!(await queuedCallAllowed(allowed, ME, queued, signed, now)).ok) return false;
      const other = text === "" ? "x" : text;
      const changed = {
        session_id: () =>
          [{ ...queued, session_id: queued.session_id + other }, signed, ME] as const,
        request_id: () =>
          [{ ...queued, request_id: queued.request_id + other }, signed, ME] as const,
        method: () =>
          [
            { ...queued, method: queued.method === other ? "ask.respond" : other },
            signed,
            ME,
          ] as const,
        params: () =>
          [
            {
              ...queued,
              params: { ...queued.params, input: { text: queued.params.input.text + other } },
            },
            signed,
            ME,
          ] as const,
        at: () =>
          [
            queued,
            {
              ...signed,
              at: new Date(Date.parse(signed.at) + 1 + (other.length % 1000)).toISOString(),
            },
            ME,
          ] as const,
        device_id: () => [queued, { ...signed, device_id: keys.mac.device_id }, ME] as const,
        signature: () =>
          [
            queued,
            {
              ...signed,
              signature:
                signed.signature.slice(0, -2) + (signed.signature.endsWith("AA") ? "BB" : "AA"),
            },
            ME,
          ] as const,
        user_id: () => [queued, signed, "user-2"] as const,
        signer: () => [queued, { ...signed, device_id: keys.mac.device_id }, ME] as const,
      }[field]();
      const devicesHere =
        field === "signer"
          ? [
              ...allowed,
              { device_id: keys.mac.device_id, user_id: ME, public_key: keys.mac.public_key },
            ]
          : allowed;
      return !(await queuedCallAllowed(devicesHere, changed[2], changed[0], changed[1], now)).ok;
    }),
  { timeout: 60_000, arbitrary: { runs: 300 } },
);

test("queuedCallAllowed's window: a call runs from 5 minutes ahead of This Mac's clock to its last millisecond, never past", async () => {
  const made = Date.parse("2026-11-06T10:00:00.000Z");
  const allowed = [
    { device_id: keys.device.device_id, user_id: ME, public_key: keys.device.public_key },
  ];
  const signed = await signCall(keys.device, queued, made);
  const at = async (now: number) => (await queuedCallAllowed(allowed, ME, queued, signed, now)).ok;
  expect(await at(made - DEVICE_CALL_SKEW_MS), "a device clock 5 minutes ahead").toBe(true);
  expect(await at(made - DEVICE_CALL_SKEW_MS - 1), "a call from further ahead than the skew").toBe(
    false,
  );
  expect(await at(made + DEVICE_CALL_MAX_AGE_MS), "the last millisecond of the window").toBe(true);
  expect(await at(made + DEVICE_CALL_MAX_AGE_MS + 1), "a millisecond past the window").toBe(false);
});

test("FINDING 3 (pinned): at the last millisecond a signed call is accepted, the receipt of its earliest run is gone", async () => {
  // session-protocol DEVICE_CALL_MAX_AGE_MS promises "a signed call can never run again once its answer is forgotten".
  // Its earliest run is at `made - SKEW` (a device clock 5 minutes ahead); server.ts once() writes the receipt then with
  // DAY_MS; store.ts getReceipt answers while expires_at > now.
  const made = Date.parse("2026-11-06T10:00:00.000Z");
  const allowed = [
    { device_id: keys.device.device_id, user_id: ME, public_key: keys.device.public_key },
  ];
  const signed = await signCall(keys.device, queued, made);
  const firstRun = made - DEVICE_CALL_SKEW_MS;
  const lastAccepted = made + DEVICE_CALL_MAX_AGE_MS;
  expect((await queuedCallAllowed(allowed, ME, queued, signed, firstRun)).ok).toBe(true);
  expect((await queuedCallAllowed(allowed, ME, queued, signed, lastAccepted)).ok).toBe(true);
  const clock = vi.spyOn(Date, "now");
  try {
    clock.mockReturnValue(firstRun);
    await Effect.runPromise(
      store.putReceipt(
        `cloud:${ME}`,
        queued.method,
        queued.request_id,
        { paramsHash: "h", result: null },
        RECEIPT_TTL_MS,
      ),
    );
    clock.mockReturnValue(lastAccepted - 1);
    expect(
      await Effect.runPromise(store.getReceipt(`cloud:${ME}`, queued.method, queued.request_id)),
      "a millisecond before the end, the replay is answered from the receipt",
    ).toBeDefined();
    clock.mockReturnValue(lastAccepted);
    const receipt = await Effect.runPromise(
      store.getReceipt(`cloud:${ME}`, queued.method, queued.request_id),
    );
    expect(
      receipt,
      "fixed: the receipt now outlives the window; turn this pin into a check that it does (skill: Findings)",
    ).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
