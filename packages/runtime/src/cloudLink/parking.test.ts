// Parking on Cloud's word (CONTRACT §5.1 of docs/): what the heartbeat reply says and
// where it is read, what "a tool runs" means, the loop that parks and says so, and the turn checkpoints a copy carries.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, expect, test } from "vitest";

import { listCloudComputers } from "./computers.ts";
import { enroll } from "./identity.ts";
import { runtimeVersion } from "./index.ts";
import { readLifecycle, type Lifecycle } from "./lifecycle.ts";
import { CloudLink } from "./link.ts";
import { mergeBundles, type MoveBundle } from "./moves.ts";
import { makeParking, toolRuns } from "./parking.ts";
import { startTestCloud } from "./testCloud.ts";

const until = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a heartbeat reply's lifecycle: times, a stop, and a Cloud from before it", () => {
  expect(
    readLifecycle({
      last_seen_at: "2026-11-09T10:00:00Z",
      sleep_at: "2026-11-09T10:10:00Z",
      funded_until: "2026-11-10T00:00:00Z",
      stop: { id: "s1", reason: "funding", deadline: "2026-11-09T10:02:00Z" },
    }),
  ).toEqual({
    sleepAt: Date.parse("2026-11-09T10:10:00Z"),
    fundedUntil: Date.parse("2026-11-10T00:00:00Z"),
    stop: { id: "s1", reason: "funding", deadline: Date.parse("2026-11-09T10:02:00Z") },
  });
  // A Cloud from before §5.1 names none of it: no stop, as it never asks for one.
  expect(readLifecycle({ last_seen_at: "2026-11-09T10:00:00Z" })).toEqual({
    sleepAt: null,
    fundedUntil: null,
    stop: null,
  });
  expect(readLifecycle(undefined)).toEqual({ sleepAt: null, fundedUntil: null, stop: null });
  // A stop that cannot be answered (`parked` names its id) is none; one with an unknown reason or no deadline still is.
  expect(readLifecycle({ stop: { reason: "idle" } }).stop).toBeNull();
  expect(readLifecycle({ stop: { id: "s2", reason: "later-reason" } }).stop).toEqual({
    id: "s2",
    reason: "later-reason",
    deadline: Number.POSITIVE_INFINITY,
  });
});

test("the link's heartbeat reads the reply, says parked while asked to, and beatHeard waits for a heartbeat sent after it", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-parking-")),
    "cloud-link",
  );
  const identity = await enroll({
    dir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "test",
  });
  const heard: Array<Lifecycle> = [];
  let parked: string | undefined;
  const link = new CloudLink({
    identity,
    onStream: () => ({ message: () => {}, closed: () => {} }),
    active: () => false,
    log: () => {},
    heartbeatMs: 60_000,
    parked: () => parked,
    onLifecycle: (lifecycle) => heard.push(lifecycle),
  });
  cleanups.push(() => link.stop());
  await until(() => heard.length >= 1);
  expect(heard[0]).toEqual({ sleepAt: null, fundedUntil: null, stop: null });
  // Every heartbeat says this runtime parks when told to, so Cloud waits for its `parked`.
  expect(cloud.state.heartbeats.at(-1)).toMatchObject({ parks: true });
  expect(cloud.state.heartbeats.at(-1)?.parked).toBeUndefined();
  expect(cloud.waitsForParked(identity.computerId)).toBe(true);

  const stop = cloud.setStop(identity.computerId, "idle", 120_000);
  await link.beatHeard();
  expect(heard.at(-1)?.stop).toMatchObject({ id: stop, reason: "idle" });
  // Parked: the next heartbeat says so, and Cloud holds it against the stop that stands.
  parked = stop;
  const before = cloud.state.heartbeats.length;
  await link.beatHeard();
  expect(cloud.state.heartbeats.length).toBeGreaterThan(before);
  expect(cloud.state.heartbeats.at(-1)?.parked).toBe(stop);
  expect(cloud.parkedFor(stop)).toMatchObject({ computerId: identity.computerId, current: true });

  // Called off: the reply says no stop.
  cloud.clearStop(identity.computerId);
  parked = undefined;
  await link.beatHeard();
  expect(heard.at(-1)?.stop).toBeNull();
  expect(cloud.state.heartbeats.at(-1)?.parked).toBeUndefined();
});

test("a link that does not park says nothing of it, and one that does goes without it for a Cloud that refuses the field", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-parks-")), "cloud-link");
  const identity = await enroll({
    dir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "test",
  });
  // This Mac's link: Cloud never stops it, and it never says it parks.
  const mac = new CloudLink({
    identity,
    onStream: () => ({ message: () => {}, closed: () => {} }),
    active: () => false,
    log: () => {},
    heartbeatMs: 60_000,
    relay: false,
  });
  await until(() => cloud.state.heartbeats.length >= 1);
  mac.stop();
  expect(cloud.state.heartbeats.at(-1)?.parks).toBeUndefined();
  expect(cloud.waitsForParked(identity.computerId)).toBe(false);
  // A Cloud from before the handshake refuses the field: the same heartbeat lands at once without it.
  cloud.state.heartbeatParksUnknown = true;
  const logs: Array<string> = [];
  const heard: Array<Lifecycle> = [];
  const before = cloud.state.heartbeats.length;
  const link = new CloudLink({
    identity,
    onStream: () => ({ message: () => {}, closed: () => {} }),
    active: () => false,
    log: (m) => logs.push(m),
    heartbeatMs: 60_000,
    relay: false,
    parked: () => "a-stop",
    onLifecycle: (lifecycle) => heard.push(lifecycle),
  });
  cleanups.push(() => link.stop());
  await until(() => heard.length >= 1);
  expect(
    cloud.state.heartbeats.slice(before).map((h) => ({ parks: h.parks, parked: h.parked })),
  ).toEqual([{ parks: undefined, parked: undefined }]);
  expect(logs).toContain(
    "Cloud link: Cloud does not take parks in the heartbeat; heartbeats go without it for now",
  );
});

test("a Cloud that knows the stop handshake and not capacity keeps the handshake: capacity is the field that goes", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-parks-")), "cloud-link");
  const identity = await enroll({
    dir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "test",
  });
  // Both refusals read the same ("Invalid JSON."): the newer field is dropped first, and the heartbeat lands with the other.
  cloud.state.heartbeatCapacityUnknown = true;
  const logs: Array<string> = [];
  const heard: Array<Lifecycle> = [];
  const link = new CloudLink({
    identity,
    onStream: () => ({ message: () => {}, closed: () => {} }),
    active: () => false,
    log: (m) => logs.push(m),
    heartbeatMs: 60_000,
    relay: false,
    parked: () => "a-stop",
    capacity: () => ({ chats: 8, used: 1 }),
    onLifecycle: (lifecycle) => heard.push(lifecycle),
  });
  cleanups.push(() => link.stop());
  await until(() => heard.length >= 1);
  expect(
    cloud.state.heartbeats.map((h) => ({ parks: h.parks, parked: h.parked, capacity: h.capacity })),
  ).toEqual([{ parks: true, parked: "a-stop", capacity: undefined }]);
  expect(cloud.waitsForParked(identity.computerId)).toBe(true);
  expect(logs).toContain(
    "Cloud link: Cloud does not take capacity in the heartbeat; heartbeats go without it for now",
  );
  expect(logs).not.toContain(
    "Cloud link: Cloud does not take parks in the heartbeat; heartbeats go without it for now",
  );
  // A Cloud from before both: capacity goes first, then parks, and the heartbeat still lands.
  link.stop();
  cloud.state.heartbeatParksUnknown = true;
  const older = new CloudLink({
    identity,
    onStream: () => ({ message: () => {}, closed: () => {} }),
    active: () => false,
    log: () => {},
    heartbeatMs: 60_000,
    relay: false,
    parked: () => "a-stop",
    capacity: () => ({ chats: 8, used: 1 }),
    onLifecycle: (lifecycle) => heard.push(lifecycle),
  });
  cleanups.push(() => older.stop());
  const before = cloud.state.heartbeats.length;
  await until(() => cloud.state.heartbeats.length > before);
  expect(cloud.state.heartbeats.at(-1)).toMatchObject({ active: false });
  expect(cloud.state.heartbeats.at(-1)?.parks).toBeUndefined();
  expect(cloud.state.heartbeats.at(-1)?.capacity).toBeUndefined();
});

test("every heartbeat says the runtime's version, and each Cloud keeps the fields it knows: capacity goes first, then version", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-version-")),
    "cloud-link",
  );
  const identity = await enroll({
    dir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "test",
  });
  const fields = (from = 0) =>
    cloud.state.heartbeats
      .slice(from)
      .map((h) => ({ parks: h.parks, capacity: h.capacity, version: h.version }));
  const start = (logs: Array<string>, version: string | null = "1.4.2") => {
    const heard: Array<Lifecycle> = [];
    const link = new CloudLink({
      identity,
      onStream: () => ({ message: () => {}, closed: () => {} }),
      active: () => false,
      log: (m) => logs.push(m),
      heartbeatMs: 60_000,
      relay: false,
      parked: () => undefined,
      capacity: () => ({ chats: 8, used: 1 }),
      ...(version === null ? {} : { version }),
      onLifecycle: (lifecycle) => heard.push(lifecycle),
    });
    cleanups.push(() => link.stop());
    return { link, landed: () => until(() => heard.length >= 1) };
  };
  const NO_CAPACITY =
    "Cloud link: Cloud does not take capacity in the heartbeat; heartbeats go without it for now";
  const NO_VERSION =
    "Cloud link: Cloud does not take version in the heartbeat; heartbeats go without it for now";
  const NO_PARKS =
    "Cloud link: Cloud does not take parks in the heartbeat; heartbeats go without it for now";

  // A Cloud that takes all of it: the version rides in every heartbeat, beside the rest.
  let logs: Array<string> = [];
  let run = start(logs);
  await run.landed();
  await run.link.beatHeard();
  expect(fields()).toEqual([
    { parks: true, capacity: { chats: 8, used: 1 }, version: "1.4.2" },
    { parks: true, capacity: { chats: 8, used: 1 }, version: "1.4.2" },
  ]);
  expect(logs).toEqual([]);
  run.link.stop();

  // A Cloud that knows version and not capacity (Cloud took version first): only capacity goes.
  cloud.state.heartbeatCapacityUnknown = true;
  let before = cloud.state.heartbeats.length;
  logs = [];
  run = start(logs);
  await run.landed();
  expect(fields(before)).toEqual([{ parks: true, capacity: undefined, version: "1.4.2" }]);
  expect(logs).toEqual([NO_CAPACITY]);
  run.link.stop();

  // A Cloud from before both that knows the stop handshake: capacity, then version, and the handshake stays.
  cloud.state.heartbeatVersionUnknown = true;
  before = cloud.state.heartbeats.length;
  logs = [];
  run = start(logs);
  await run.landed();
  expect(fields(before)).toEqual([{ parks: true, capacity: undefined, version: undefined }]);
  expect(logs).toEqual([NO_CAPACITY, NO_VERSION]);
  expect(cloud.waitsForParked(identity.computerId)).toBe(true);
  // Dropped for a while, not for one heartbeat: the next goes without them at once, with no refusal on the way.
  await run.link.beatHeard();
  expect(fields(before)).toEqual([
    { parks: true, capacity: undefined, version: undefined },
    { parks: true, capacity: undefined, version: undefined },
  ]);
  expect(logs).toEqual([NO_CAPACITY, NO_VERSION]);
  run.link.stop();

  // A Cloud from before all three: each goes in turn, newest first, and the heartbeat still lands.
  cloud.state.heartbeatParksUnknown = true;
  before = cloud.state.heartbeats.length;
  logs = [];
  run = start(logs);
  await run.landed();
  expect(fields(before)).toEqual([{ parks: undefined, capacity: undefined, version: undefined }]);
  expect(logs).toEqual([NO_CAPACITY, NO_VERSION, NO_PARKS]);
  run.link.stop();

  // No version to say, or one longer than the 64 characters Cloud takes: the field is left out, never refused.
  Object.assign(cloud.state, {
    heartbeatCapacityUnknown: false,
    heartbeatVersionUnknown: false,
    heartbeatParksUnknown: false,
  });
  for (const version of [null, "  ", "v".repeat(65)]) {
    before = cloud.state.heartbeats.length;
    logs = [];
    run = start(logs, version);
    await run.landed();
    expect(fields(before)).toEqual([
      { parks: true, capacity: { chats: 8, used: 1 }, version: undefined },
    ]);
    expect(logs).toEqual([]);
    run.link.stop();
  }
  // What the runtime says: the app's version that started it, else its own package's.
  expect(runtimeVersion({ CAVEMAN_APP_VERSION: " 1.4.2 " })).toBe("1.4.2");
  expect(runtimeVersion({})).toMatch(/^\d+\.\d+\.\d+/);
});

test("a Cloud computer whose runtime is below Cloud's minimum is listed outdated until a runtime of it says a newer version", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.environments.computers = true;
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-outdated-")),
    "cloud-link",
  );
  const identity = await enroll({
    dir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "boat",
  });
  // Its computer is a Cloud computer (the computers service made it); a Mac is never marked.
  cloud.state.chats.computers.get(identity.computerId)!.kind = "cloud";
  const listed = async () =>
    (await listCloudComputers(identity, {})).computers.find((c) => c.id === identity.computerId);
  const say = async (version: string | undefined) => {
    const heard: Array<Lifecycle> = [];
    const link = new CloudLink({
      identity,
      onStream: () => ({ message: () => {}, closed: () => {} }),
      active: () => false,
      log: () => {},
      heartbeatMs: 60_000,
      relay: false,
      ...(version === undefined ? {} : { version }),
      onLifecycle: (lifecycle) => heard.push(lifecycle),
    });
    cleanups.push(() => link.stop());
    await until(() => heard.length >= 1);
    link.stop();
  };
  // No minimum set, or a runtime never heard: nothing is marked.
  expect((await listed())?.runtime_outdated).toBeUndefined();
  cloud.state.minRuntimeVersion = "1.4.0";
  expect((await listed())?.runtime_outdated).toBeUndefined();
  // Heard, and it said an older version, or none: Cloud marks the computer, and the runtime's row carries it.
  await say("1.3.9");
  expect((await listed())?.runtime_outdated).toBe(true);
  await say("1.4.0");
  expect((await listed())?.runtime_outdated).toBeUndefined();
  // The same computer as a Mac: never marked, whatever its runtime says.
  await say("1.2.0");
  expect((await listed())?.runtime_outdated).toBe(true);
  cloud.state.chats.computers.get(identity.computerId)!.kind = "laptop";
  expect((await listed())?.runtime_outdated).toBeUndefined();
});

test("a tool runs while one started has no end; a turn waiting on the person, or ended, stands at a boundary", () => {
  expect(toolRuns([{ type: "turn.started" }])).toBe(false);
  expect(toolRuns([{ type: "turn.started" }, { type: "tool.started", item_id: "a" }])).toBe(true);
  expect(
    toolRuns([
      { type: "turn.started" },
      { type: "tool.started", item_id: "a" },
      { type: "tool.done", item_id: "a" },
    ]),
  ).toBe(false);
  // Two at once: one still runs.
  expect(
    toolRuns([
      { type: "tool.started", item_id: "a" },
      { type: "tool.started", item_id: "b" },
      { type: "tool.done", item_id: "a" },
    ]),
  ).toBe(true);
  // Asked and not answered: the tool has not run.
  expect(
    toolRuns([
      { type: "tool.started", item_id: "a" },
      { type: "ask.user", item_id: "q" },
    ]),
  ).toBe(false);
  expect(
    toolRuns([
      { type: "tool.started", item_id: "a" },
      { type: "ask.user", item_id: "q" },
      { type: "ask.resolved", item_id: "q" },
    ]),
  ).toBe(true);
  expect(toolRuns([{ type: "tool.started", item_id: "a" }, { type: "turn.done" }])).toBe(false);
});

test("the loop says parked only once every chat is parked, waits while one is not, and carries turns on when the stop is called off", async () => {
  const said: Array<string | undefined> = [];
  const parks: Array<string> = [];
  let ready = false;
  let working = false;
  let resumes = 0;
  const parking = makeParking({
    chats: Effect.succeed(["one", "two"]),
    park: (sessionId) => Effect.sync(() => (parks.push(sessionId), sessionId === "one" || ready)),
    quiet: Effect.succeed(true),
    resume: Effect.sync(() => (resumes++, true)),
    working: () => working,
    say: (stop) => void said.push(stop),
    log: () => Effect.void,
    lookMs: 20,
  });
  const loop = Effect.runFork(parking.run);
  cleanups.push(() => Effect.runPromise(Fiber.interrupt(loop)));
  const stop = (id: string | null): Lifecycle => ({
    sleepAt: null,
    fundedUntil: null,
    stop: id === null ? null : { id, reason: "idle", deadline: Date.now() + 120_000 },
  });
  // Cloud's first word is no stop: what an earlier run of this runtime parked carries on.
  expect(parking.stopping()).toBe(false);
  parking.heard(stop(null));
  await until(() => resumes === 1);
  parking.heard(stop("s1"));
  expect(parking.stopping()).toBe(true);
  // One chat is not parked yet (a tool runs): looked at again, nothing said.
  await until(() => parks.filter((id) => id === "two").length >= 3);
  expect(said).toEqual([]);
  // Every chat parked, but a hosted run works: still nothing.
  working = true;
  ready = true;
  const looks = parks.length;
  await until(() => parks.length >= looks + 4);
  expect(said).toEqual([]);
  working = false;
  await until(() => said.length === 1);
  expect(said).toEqual(["s1"]);
  // Called off: no heartbeat says parked any more, and the turns carry on.
  parking.heard(stop(null));
  await until(() => resumes === 2);
  expect(said).toEqual(["s1", undefined]);
  expect(parking.stopping()).toBe(false);
});

test("a copy's turn checkpoints merge across its segments: every ref at its latest commit, each bundle in order", () => {
  const event = (cursor: number) =>
    ({
      cursor,
      type: "notification",
      at: "2026-11-09T10:00:00Z",
      session_id: "s",
      payload: { level: "info", title: `n${cursor}` },
    }) as unknown as SessionEvent;
  const segment = (cursor: number, extra: Partial<MoveBundle>): MoveBundle => ({
    ...({
      after: cursor - 1,
      events: [event(cursor)],
      display: [],
      record: { session: { id: "s" } },
      repo: "acme/widgets",
      engine: null,
      wip: null,
    } as unknown as MoveBundle),
    ...extra,
  });
  const merged = mergeBundles([
    segment(1, {
      checkpoints: {
        refs: { "refs/t3/orchestration-v2/checkpoints/k/ordinal/1": "a".repeat(40) },
        bundle: "Zmlyc3Q=",
      },
    }),
    // A segment from before checkpoints travelled, or one that had none.
    segment(2, {}),
    segment(3, {
      checkpoints: {
        refs: {
          "refs/t3/orchestration-v2/checkpoints/k/ordinal/1": "b".repeat(40),
          "refs/t3/orchestration-v2/checkpoints/k/ordinal/2": "c".repeat(40),
        },
        bundle: "c2Vjb25k",
      },
    }),
    // Refs whose commits the checkout already has: named without a bundle.
    segment(4, {
      checkpoints: { refs: { "refs/t3/orchestration-v2/checkpoints/k/ordinal/3": "d".repeat(40) } },
    }),
  ]);
  expect(merged.checkpoints).toEqual({
    refs: {
      "refs/t3/orchestration-v2/checkpoints/k/ordinal/1": "b".repeat(40),
      "refs/t3/orchestration-v2/checkpoints/k/ordinal/2": "c".repeat(40),
      "refs/t3/orchestration-v2/checkpoints/k/ordinal/3": "d".repeat(40),
    },
  });
  expect(merged.checkpoint_bundles).toEqual(["Zmlyc3Q=", "c2Vjb25k"]);
  expect(mergeBundles([segment(1, {})]).checkpoints).toBeUndefined();
});
