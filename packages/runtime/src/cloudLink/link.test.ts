// The Cloud link against a stand-in Cloud: token minting on Cloud's clock
// and refresh before expiry, relay reconnects, heartbeats and stream teardown.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";

import { listCloudComputers } from "./computers.ts";
import { CLAIM_LOOK_MS, claimed, cloudComputerFromEnv, gitProxyEnv, type LinkState } from "./index.ts";
import { enroll, KEY_FILE, publicKeyOf, readIdentity, RECORD_FILE, type Identity } from "./identity.ts";
import { CloudLink } from "./link.ts";
import { RELAY_READ_LIMIT, type StreamSink } from "./relay.ts";
import { PROTOCOL_REVISION } from "@caveman-app/session-protocol";
import { RUNTIME_CAPABILITIES, RUNTIME_VERSION } from "../runtimeVersion.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";

const WIN = process.platform === "win32";

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

async function setup(options: { ttlMs?: number; pingMs?: number; graceMs?: number } = {}) {
  const cloud: TestCloud = await startTestCloud(options);
  cleanups.push(cloud.close);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-")), "cloud-link");
  const identity = await enroll({ dir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" });
  return { cloud, dir, identity };
}

function linkOf(identity: Identity, extra: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}) {
  const logs: Array<string> = [];
  const link = new CloudLink({ identity, onStream: () => ({ message: () => {}, closed: () => {} }), active: () => false, log: (m) => logs.push(m), ...extra });
  cleanups.push(() => link.stop());
  return { link, logs };
}

test("enroll keeps the key 0600 and never stores the person's token; a refused sign-in says so", async () => {
  const { cloud, dir, identity } = await setup();
  // Windows has no mode bits: the state dir's place in the person's profile (its ACL) keeps them private.
  if (!WIN) expect(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
  if (!WIN) expect(fs.statSync(path.join(dir, RECORD_FILE)).mode & 0o777).toBe(0o600);
  const stored = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  expect(stored).not.toContain(cloud.state.personToken);
  expect(readIdentity(dir)?.runtimeId).toBe(identity.runtimeId);
  const runtimes = cloud.state.runtimes;
  expect(publicKeyOf(readIdentity(dir)!.key)).toBe(runtimes.get(identity.runtimeId)!.publicKey);
  // Signing in again makes a fresh key on the same local computer and revokes the runtime it replaces.
  const again = await enroll({ dir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "again" });
  expect(again.runtimeId).not.toBe(identity.runtimeId);
  expect(again.computerId).toBe(identity.computerId);
  expect(runtimes.get(identity.runtimeId)!.status).toBe("revoked");
  // An owner revoked it (its key leaked, say): signing in again never trusts that key again.
  runtimes.get(again.runtimeId)!.status = "revoked";
  const third = await enroll({ dir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "third" });
  expect(third.computerId).toBe(identity.computerId);
  expect(new Set([...runtimes.values()].map((r) => r.publicKey)).size).toBe(3);
  expect(publicKeyOf(readIdentity(dir)!.key)).toBe(runtimes.get(third.runtimeId)!.publicKey);
  if (!WIN) expect(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
  // A refused enrollment leaves the identity on disk as it was.
  await expect(enroll({ dir, cloudUrl: cloud.url, bearer: "wrong", name: "x" })).rejects.toMatchObject({ status: 401, code: "cave_unauthorized" });
  await expect(enroll({ dir, cloudUrl: "http://example.com", bearer: "x", name: "x" })).rejects.toThrow(/https/);
  expect(readIdentity(dir)?.runtimeId).toBe(third.runtimeId);
  expect(fs.readdirSync(dir).sort()).toEqual([RECORD_FILE, KEY_FILE]);
});

test("a Cloud computer's mount that cannot be used says why; git proxy config follows the entries git already has", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-mount-"));
  expect(() => cloudComputerFromEnv({ CAVEMAN_CLOUD_LINK_DIR: dir })).toThrow(/runtime\.json/);
  const ids = { runtime_id: crypto.randomUUID(), organization_id: crypto.randomUUID(), computer_id: crypto.randomUUID() };
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ cloud_url: "http://cloud.internal", ...ids }));
  fs.writeFileSync(path.join(dir, KEY_FILE), crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  expect(() => cloudComputerFromEnv({ CAVEMAN_CLOUD_LINK_DIR: dir })).toThrow(/must be https/);
  const env = gitProxyEnv({ cloudUrl: "https://app.example", token: "ccrt_x" }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory" })!;
  expect(env).toEqual({
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: "url.https://app.example/relay/v1/git/.insteadOf",
    GIT_CONFIG_VALUE_1: "https://github.com/",
    GIT_CONFIG_KEY_2: "http.https://app.example/relay/v1/git/.extraHeader",
    GIT_CONFIG_VALUE_2: "Authorization: Bearer ccrt_x",
  });
});

test("a warm pod's runtime starts with no identity yet and learns its computer at the claim; an unusable one still stops it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-link-warm-"));
  const warm = { CAVEMAN_CLOUD_LINK_DIR: dir, CAVEMAN_RUNTIME_LINK_WAIT: "1", CAVEMAN_WORKSPACE_ROOT: "/w" };
  // Only the image's entrypoint says the pod is warm: a computer started without its identity still stops.
  expect(() => cloudComputerFromEnv({ CAVEMAN_CLOUD_LINK_DIR: dir })).toThrow(/runtime\.json/);
  const computer = cloudComputerFromEnv(warm)!;
  expect(computer).toMatchObject({ linkDir: dir, workspaceRoot: "/w", computerId: "" });
  let done = false;
  const wait = Effect.runPromise(claimed(computer)).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 3 * CLAIM_LOOK_MS));
  expect(done).toBe(false);
  // The claim writes the key, then the record (link-bootstrap.mjs), each renamed into place.
  const ids = { runtime_id: crypto.randomUUID(), organization_id: crypto.randomUUID(), computer_id: crypto.randomUUID() };
  fs.writeFileSync(path.join(dir, KEY_FILE), crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  await new Promise((r) => setTimeout(r, 3 * CLAIM_LOOK_MS));
  expect(done).toBe(false);
  const at = Date.now();
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ cloud_url: "https://cloud.example", ...ids }));
  await wait;
  expect(Date.now() - at).toBeLessThan(CLAIM_LOOK_MS + 200);
  expect(computer.computerId).toBe(ids.computer_id);
  // Once it has one, a restarted runtime is an ordinary computer, flag or not.
  expect(cloudComputerFromEnv(warm)!.computerId).toBe(ids.computer_id);
  // Written but unusable is never waited on at start: it says why.
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ cloud_url: "http://cloud.example", ...ids }));
  expect(() => cloudComputerFromEnv(warm)).toThrow(/must be https/);
});

test("every call takes the link's token, Cloud sees one mint, and a token Cloud cut to its grace is replaced at once (K14)", async () => {
  // Cloud's own rotation, its grace cut to 300 ms: a mint leaves the token before it working only that long.
  const { cloud, identity } = await setup({ graceMs: 300 });
  cloud.state.environments.computers = true;
  const state: LinkState = { cloudUrl: identity.cloudUrl };
  const { link } = linkOf(identity, { relay: false, onToken: (token) => (state.token = token.value) });
  state.fresh = (stale, waitMs) => link.tokenFor(stale, waitMs);
  // Calls made the moment the link starts (a claim): they wait for its token; Cloud saw one mint.
  await Promise.all([listCloudComputers(identity, state), listCloudComputers(identity, state), listCloudComputers(identity, state)]);
  expect(cloud.state.mints.filter((m) => m.ok)).toHaveLength(1);
  const first = link.token!.value;
  // Something else mints for this runtime (an older runtime build, another process): the link's token has 300 ms left.
  await link.mint();
  await new Promise((r) => setTimeout(r, 400));
  // A call on the cut token: refused once, the link mints at once, and the call goes through on the new token.
  await listCloudComputers(identity, state);
  expect(state.token).not.toBe(first);
  expect(cloud.state.mints.filter((m) => m.ok)).toHaveLength(3);
  // Revoked in Cloud: the link's new mint is refused, and a call says so at once (401), not after a wait.
  cloud.state.runtimes.get(identity.runtimeId)!.status = "revoked";
  for (const [token, record] of cloud.state.tokens) if (record.runtimeId === identity.runtimeId) cloud.state.tokens.delete(token);
  const asked = Date.now();
  await expect(listCloudComputers(identity, state)).rejects.toMatchObject({ status: 401 });
  expect(Date.now() - asked).toBeLessThan(5_000);
  // With no token in time (the link stopped), a call fails as Cloud not reached, never as a refused sign-in.
  link.stop();
  await expect(link.tokenFor(state.token, 100)).rejects.toMatchObject({ status: 503 });
});

test("mints on Cloud's clock when ours is 10 minutes behind, never repeats an issued_at, and refreshes before expiry", async () => {
  const { cloud, identity } = await setup({ ttlMs: 7_500 });
  cloud.state.skewMs = 10 * 60_000;
  const { link } = linkOf(identity);
  await until(() => link.status === "connected");
  // The first assertion used our clock and was refused; the Date header corrected it.
  expect(cloud.state.mints[0]).toMatchObject({ ok: false });
  expect(cloud.state.mints[1]).toMatchObject({ ok: true });
  const first = link.token!;
  // Two mints in a row: strictly increasing issued_at, both accepted (Cloud's replay fence).
  const a = await link.mint();
  const b = await link.mint();
  expect(b.issuedAt).toBe(a.issuedAt + 1);
  expect(cloud.state.mints.slice(-2).every((m) => m.ok)).toBe(true);
  // TTL 7.5 s: refreshed at two thirds (5 s), and the relay hears the new token (type 5) before the old one expires.
  await until(() => link.token !== first, 10_000);
  const relay = cloud.state.relays[0]!;
  await until(() => relay.token === link.token!.value);
  expect(relay.frames.some((f) => f.type === 5)).toBe(true);
  expect(cloud.state.relays).toHaveLength(1);
});

test("a refusal on Cloud's own clock is its replay fence: the next attempt goes past that second at once", async () => {
  const { cloud, identity } = await setup();
  // Another mint for this runtime (computers.ts, while the link is not up yet) just took this second.
  const second = Math.floor(Date.now() / 1000);
  cloud.state.runtimes.get(identity.runtimeId)!.lastIssued = second;
  // Our clock, stopped within that second: only the floor can move the next attempt past it.
  const { link } = linkOf(identity, { relay: false, now: () => second * 1000 + 500 });
  await until(() => link.token !== undefined || cloud.state.mints.length >= 3, 8_000);
  expect(cloud.state.mints.slice(0, 2).map((m) => [m.issuedAt - second, m.ok])).toEqual([
    [0, false],
    [1, true],
  ]);
  expect(link.token).toBeDefined();
});

test("mints on Cloud's clock when ours is 10 minutes ahead: the refused assertion is not a floor for the next", async () => {
  const { cloud, identity } = await setup();
  cloud.state.skewMs = -10 * 60_000;
  const { link } = linkOf(identity, { relay: false });
  await until(() => link.token !== undefined || cloud.state.mints.length >= 3, 8_000);
  expect(cloud.state.mints.slice(0, 2).map((m) => m.ok)).toEqual([false, true]);
  expect(link.token).toBeDefined();
  expect(link.status).not.toBe("unauthorized");
  // On Cloud's own clock, and later mints keep climbing from the one Cloud took.
  const taken = cloud.state.mints[1]!.issuedAt;
  expect(Math.abs(taken * 1000 - (Date.now() + cloud.state.skewMs))).toBeLessThan(5_000);
  expect((await link.mint()).issuedAt).toBeGreaterThan(taken);
});

test("a link-off call mints on Cloud's clock too, whichever way ours is off, and the next call shares its token", async () => {
  // Ours 20 minutes ahead (past the token's 15-minute life on our clock), then 10 minutes behind.
  for (const skewMs of [-20 * 60_000, 10 * 60_000]) {
    const { cloud, identity } = await setup();
    cloud.state.environments.computers = true;
    cloud.state.skewMs = skewMs;
    await expect(listCloudComputers(identity, {})).resolves.toBeDefined();
    await expect(listCloudComputers(identity, {})).resolves.toBeDefined();
    expect(cloud.state.mints.map((m) => m.ok)).toEqual([false, true]);
  }
});

test("reconnects after a relay drop, mints first after 4401, and after 4409 stays off the relay, minting and heartbeating nothing", async () => {
  const { cloud, identity } = await setup();
  const { link, logs } = linkOf(identity, { heartbeatMs: 200 });
  await until(() => cloud.state.relays.length === 1 && link.status === "connected");
  cloud.state.relays[0]!.ws.close(1012, "relay restarting");
  await until(() => cloud.state.relays.length === 2);
  const mintsBefore = cloud.state.mints.length;
  cloud.state.relays[1]!.ws.close(4401, "token refused");
  await until(() => cloud.state.relays.length === 3);
  expect(cloud.state.mints.length).toBe(mintsBefore + 1);
  expect(cloud.state.relays[2]!.token).toBe(link.token!.value);
  expect(cloud.state.relays[2]!.token).not.toBe(cloud.state.relays[1]!.token);
  cloud.state.relays[2]!.ws.close(4409, "replaced");
  await until(() => link.status === "replaced");
  await new Promise((r) => setTimeout(r, 300));
  const quiet = { mints: cloud.state.mints.length, heartbeats: cloud.state.heartbeats.length };
  await new Promise((r) => setTimeout(r, 1_500));
  expect(cloud.state.relays).toHaveLength(3);
  expect({ mints: cloud.state.mints.length, heartbeats: cloud.state.heartbeats.length }).toEqual(quiet);
  expect(link.status).toBe("replaced");
  expect(logs.join("\n")).toMatch(/another instance/);
});

test("a Cloud computer replaced on the relay tries again later with a fresh token", async () => {
  const { cloud, identity } = await setup();
  const { link } = linkOf(identity, { replacedRetryMs: 400 });
  await until(() => link.status === "connected");
  const mints = cloud.state.mints.length;
  cloud.state.relays[0]!.ws.close(4409, "replaced");
  await until(() => link.status === "replaced");
  await until(() => cloud.state.relays.length === 2 && link.status === "connected", 5_000);
  expect(cloud.state.mints.length).toBe(mints + 1);
  expect(cloud.state.relays[1]!.token).toBe(link.token!.value);
});

test("a refused mint reads unauthorized only until a mint succeeds again, while the relay stays up", async () => {
  const { cloud, identity } = await setup();
  const { link } = linkOf(identity, { heartbeatMs: 200 });
  await until(() => link.status === "connected");
  const runtime = cloud.state.runtimes.get(identity.runtimeId)!;
  // The heartbeat's token is refused and every mint fails: unauthorized.
  runtime.status = "revoked";
  cloud.state.tokens.clear();
  await until(() => link.status === "unauthorized");
  runtime.status = "active";
  await until(() => link.status === "connected");
  expect(cloud.state.relays).toHaveLength(1);
});

test.each([
  ["pings and answers, as the core's does", 200],
  ["only answers the runtime's pings, as the one at the edge does", 0],
])("a relay that %s is kept; one that goes silent is dropped and dialed again", async (_relay, pingMs) => {
  const { cloud, identity } = await setup({ pingMs });
  const { logs } = linkOf(identity, { relaySilenceMs: 800 });
  await until(() => cloud.state.relays.length === 1);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(cloud.state.relays).toHaveLength(1);
  cloud.state.ping = false;
  await until(() => cloud.state.relays.length === 2, 5_000);
  expect(logs.join("\n")).toMatch(/silent/);
});

test("a message over the relay's limit closes only its own stream", async () => {
  const { cloud, identity } = await setup();
  const closed: Array<string> = [];
  const { link } = linkOf(identity, {
    onStream: (stream) => ({
      message: (data) => void stream.send(data === "big" ? "x".repeat(RELAY_READ_LIMIT) : `echo:${String(data)}`),
      closed: (reason) => closed.push(reason),
    }),
  });
  await until(() => link.status === "connected");
  const relay = cloud.state.relays[0]!;
  const a = relay.open();
  const b = relay.open();
  relay.send(a, "big");
  await until(() => relay.frames.some((f) => f.type === 4 && f.id.equals(a)));
  expect(closed).toEqual(["a reply was too large for the relay"]);
  relay.send(b, "hi");
  await until(() => relay.frames.some((f) => f.type === 2 && f.id.equals(b)));
  expect(relay.frames.some((f) => f.type === 2 && f.id.equals(a))).toBe(false);
  expect(relay.ws.readyState).toBe(relay.ws.OPEN);
  expect(cloud.state.relays).toHaveLength(1);
});

test("a stream's sends wait while the socket holds over 4 MiB unsent, and go once the relay reads again", async () => {
  const { cloud, identity } = await setup();
  const sent: Array<Promise<void>> = [];
  const { link } = linkOf(identity, {
    onStream: (stream) => ({
      message: () => {
        for (let i = 0; i < 4; i++) sent.push(stream.send(Buffer.alloc(8 * 1024 * 1024)));
      },
      closed: () => {},
    }),
  });
  await until(() => link.status === "connected");
  const relay = cloud.state.relays[0]!;
  relay.socket.pause();
  relay.send(relay.open(), "flood");
  await until(() => sent.length === 4);
  let settled = 0;
  for (const promise of sent) void promise.then(() => settled++);
  await new Promise((r) => setTimeout(r, 500));
  // The first goes out at once; with 32 MiB queued and the relay not reading, the later ones wait.
  expect(settled).toBeGreaterThanOrEqual(1);
  expect(settled).toBeLessThan(4);
  relay.socket.resume();
  await until(() => settled === 4);
});

test("a refused upgrade (expired token) is unauthorized: the link mints and dials again", async () => {
  const { cloud, identity } = await setup();
  const { link } = linkOf(identity);
  await until(() => link.status === "connected");
  // Cloud forgets every token: the heartbeat gets 401 and the next dial is refused at the upgrade.
  cloud.state.tokens.clear();
  cloud.state.relays[0]!.ws.close(1012);
  await until(() => cloud.state.relays.length === 2 && link.status === "connected");
  expect(cloud.state.tokens.has(cloud.state.relays[1]!.token)).toBe(true);
});

test("heartbeats say active only while a turn runs or a client is attached", async () => {
  const { cloud, identity } = await setup();
  let busy = false;
  const { link } = linkOf(identity, { active: () => busy, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.active).toBe(false);
  busy = true;
  link.poke();
  // Becoming active heartbeats at once, not at the next 60 s tick.
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]!.active).toBe(true);
  busy = false;
  link.poke();
  await new Promise((r) => setTimeout(r, 300));
  expect(cloud.state.heartbeats).toHaveLength(2);
});

test("going to sleep: every heartbeat says suspending, the first at once, until it is awake again", async () => {
  const { cloud, identity } = await setup();
  let suspending = false;
  const { link } = linkOf(identity, { suspending: () => suspending, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.suspending).toBeUndefined();
  suspending = true;
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]!.suspending).toBe(true);
  suspending = false;
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.suspending).toBeUndefined();
});

test("going to sleep, every heartbeat names the chats the lid kept here; awake, none; a Cloud from before them still hears the suspending mark (A-6)", async () => {
  const { cloud, identity } = await setup();
  let suspending = false;
  let kept: ReadonlyArray<string> = [];
  const { link } = linkOf(identity, { suspending: () => suspending, kept: () => kept, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.kept).toBeUndefined();
  suspending = true;
  kept = ["0190a000-0000-7000-8000-000000000001"];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]).toMatchObject({ suspending: true, kept: ["0190a000-0000-7000-8000-000000000001"] });
  suspending = false;
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.suspending).toBeUndefined();
  expect(cloud.state.heartbeats[2]!.kept).toBeUndefined();
  // A Cloud whose strict decoder does not know the field: the same heartbeat at once without it, the mark landing.
  cloud.state.heartbeatKeptUnknown = true;
  suspending = true;
  link.beat();
  await until(() => cloud.state.heartbeats.length === 4, 2_000);
  expect(cloud.state.heartbeats[3]).toMatchObject({ suspending: true });
  expect(cloud.state.heartbeats[3]!.kept).toBeUndefined();
});

test("every heartbeat says how many chats the computer holds and has, once measured; a Cloud from before capacity still hears the rest", async () => {
  const { cloud, identity } = await setup();
  let capacity: { chats: number; used: number } | undefined;
  let kept: ReadonlyArray<string> = [];
  let suspending = false;
  const { link } = linkOf(identity, { capacity: () => capacity, suspending: () => suspending, kept: () => kept, heartbeatMs: 60_000 });
  // Not measured yet: the heartbeat names none.
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.capacity).toBeUndefined();
  capacity = { chats: 8, used: 3 };
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]).toMatchObject({ active: false, capacity: { chats: 8, used: 3 } });
  // It moves with the computer: every heartbeat carries what is true now.
  capacity = { chats: 6, used: 6 };
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.capacity).toEqual({ chats: 6, used: 6 });
  // A Cloud whose strict decoder does not know the field: the same heartbeat at once without it, the rest landing.
  cloud.state.heartbeatCapacityUnknown = true;
  suspending = true;
  kept = ["0190a000-0000-7000-8000-000000000001"];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 4, 2_000);
  expect(cloud.state.heartbeats[3]).toMatchObject({ suspending: true, kept: ["0190a000-0000-7000-8000-000000000001"] });
  expect(cloud.state.heartbeats[3]!.capacity).toBeUndefined();
  // And none after it, until the hour is up: liveness never waits on a field Cloud does not take.
  link.beat();
  await until(() => cloud.state.heartbeats.length === 5, 2_000);
  expect(cloud.state.heartbeats[4]!.capacity).toBeUndefined();
});

test("awake again while a heartbeat saying suspending is on its way: the next one goes at once, not a heartbeat period later (H1)", async () => {
  const { cloud, identity } = await setup();
  let suspending = true;
  // Woken, the Mac's timer-due heartbeat goes out before its pass sees the wake: held on its way here.
  let held: (() => void) | undefined;
  const holding = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input).endsWith("/runtime/heartbeat") && held === undefined && cloud.state.heartbeats.length === 0
      ? new Promise<Response>((resolve, reject) => (held = () => void fetch(input, init).then(resolve, reject)))
      : fetch(input, init);
  const { link } = linkOf(identity, { suspending: () => suspending, heartbeatMs: 60_000, fetch: holding as typeof fetch });
  await until(() => held !== undefined, 2_000);
  // The pass sees the wake: the mark goes, and it asks for a heartbeat now.
  suspending = false;
  link.beat();
  held!();
  // Cloud hears it is awake within moments: one still saying suspending would let Cloud move a chat that just started a turn.
  await until(() => cloud.state.heartbeats.length >= 2, 2_000);
  expect(cloud.state.heartbeats.map((h) => h.suspending ?? false)).toEqual([true, false]);
});

test("heartbeats name the repositories this Mac has, by hash; a Cloud from before them gets the same heartbeat without them", async () => {
  const { cloud, identity } = await setup();
  const repos = [{ remote_hash: "f60ecdb16e5e8e829d8346f19a25e2304ed38ace98f1c958ce4fd3792c2e8126", head: "a".repeat(40) }];
  const first = linkOf(identity, { repos: () => repos, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.repos).toEqual(repos);
  first.link.stop();
  cloud.state.heartbeatReposUnknown = true;
  const { link, logs } = linkOf(identity, { repos: () => repos, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 2);
  expect(cloud.state.heartbeats[1]!.repos).toBeUndefined();
  expect(logs.some((l) => /repos in the heartbeat/.test(l))).toBe(true);
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.repos).toBeUndefined();
});

test("a beat asked while a heartbeat is on its way goes next, at once: what it was asked for is never left to the next timer", async () => {
  const { cloud, identity } = await setup();
  const repos = [{ remote_hash: "f60ecdb16e5e8e829d8346f19a25e2304ed38ace98f1c958ce4fd3792c2e8126", head: "a".repeat(40) }];
  let read = false;
  // The first heartbeat asks for the repos, which are read meanwhile and ready as it goes: the read asks for a beat.
  const { link } = linkOf(identity, {
    repos: () => {
      if (read) return repos;
      read = true;
      queueMicrotask(() => link.beat());
      return undefined;
    },
    heartbeatMs: 60_000,
  });
  await until(() => cloud.state.heartbeats.length >= 2, 3_000);
  expect(cloud.state.heartbeats[0]!.repos).toBeUndefined();
  expect(cloud.state.heartbeats[1]!.repos).toEqual(repos);
});

test("repos go again only when they changed; a Cloud that refused them gets them again after a while; a 400 about another field leaves them in", async () => {
  const { cloud, identity } = await setup();
  let repos = [{ remote_hash: "f60ecdb16e5e8e829d8346f19a25e2304ed38ace98f1c958ce4fd3792c2e8126", head: "a".repeat(40) }];
  const { link } = linkOf(identity, { repos: () => repos, heartbeatMs: 60_000, reposRetryMs: 1_500 });
  await until(() => cloud.state.heartbeats.length === 1);
  expect(cloud.state.heartbeats[0]!.repos).toEqual(repos);
  // Unchanged: Cloud keeps the last list, so the next heartbeat names none.
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]!.repos).toBeUndefined();
  // Changed: named again.
  repos = [...repos, { remote_hash: "0".repeat(64), head: "" }];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.repos).toEqual(repos);
  // An older Cloud refuses them: the heartbeat goes again without them at once, and they are tried again later.
  cloud.state.heartbeatReposUnknown = true;
  repos = [repos[0]!];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 4, 2_000);
  expect(cloud.state.heartbeats[3]!.repos).toBeUndefined();
  cloud.state.heartbeatReposUnknown = false;
  await new Promise((r) => setTimeout(r, 1_700));
  link.beat();
  await until(() => cloud.state.heartbeats.length === 5, 2_000);
  expect(cloud.state.heartbeats[4]!.repos).toEqual(repos);
  // A 400 about another field: repos are not given up, and go again on the next heartbeat.
  repos = [...repos, { remote_hash: "1".repeat(64), head: "" }];
  cloud.state.heartbeatRefusal = 'engines_signed_in holds "claude" and "codex".';
  link.beat();
  await until(() => cloud.state.heartbeats.length === 6, 2_000);
  expect(cloud.state.heartbeats[5]).toMatchObject({ refused: true, repos });
  cloud.state.heartbeatRefusal = undefined;
  link.beat();
  await until(() => cloud.state.heartbeats.length === 7, 2_000);
  expect(cloud.state.heartbeats[6]!.repos).toEqual(repos);
});

test("streams: messages both ways, a client leaving closes its sink, stopping the link closes every stream", async () => {
  const { cloud, identity } = await setup();
  const sinks: Array<{ messages: Array<string | Uint8Array>; closed?: string }> = [];
  const { link } = linkOf(identity, {
    onStream: (stream, info) => {
      const record: (typeof sinks)[number] = { messages: [] };
      sinks.push(record);
      const sink: StreamSink = {
        message: (data) => {
          record.messages.push(data);
          void stream.send(`echo:${info.user_id}:${String(data)}`);
        },
        closed: (reason) => (record.closed = reason),
      };
      return sink;
    },
  });
  await until(() => link.status === "connected");
  const relay = cloud.state.relays[0]!;
  const a = relay.open();
  const b = relay.open({ user_id: "user-2" });
  relay.send(a, "hello");
  relay.send(b, "there");
  await until(() => relay.frames.filter((f) => f.type === 2).length === 2);
  expect(relay.frames.filter((f) => f.type === 2).map((f) => f.payload.toString())).toEqual(["echo:user-1:hello", "echo:user-2:there"]);
  relay.close(a, "client left");
  await until(() => sinks[0]!.closed !== undefined);
  expect(sinks[0]!.closed).toBe("client left");
  expect(sinks[1]!.closed).toBeUndefined();
  link.stop();
  await until(() => sinks[1]!.closed !== undefined && relay.ws.readyState === relay.ws.CLOSED);
  // The relay was told the remaining stream ended before the connection closed.
  expect(relay.frames.some((f) => f.type === 4 && f.id.equals(b))).toBe(true);
});

test("heartbeats say which engines run on the person's own login here, once known, and never guess one", async () => {
  const { cloud, identity } = await setup();
  let engines: ReadonlyArray<string> | undefined;
  const { link } = linkOf(identity, { enginesSignedIn: () => engines, heartbeatMs: 60_000 });
  await until(() => cloud.state.heartbeats.length === 1);
  // Not known yet (the CLIs are still being asked): left out, so Cloud keeps what it last heard.
  expect(cloud.state.heartbeats[0]!.engines_signed_in).toBeUndefined();
  engines = ["claude"];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats[1]!.engines_signed_in).toEqual(["claude"]);
  // Signed out of both: an empty list is news too.
  engines = [];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  expect(cloud.state.heartbeats[2]!.engines_signed_in).toEqual([]);
});

/** A link whose wall and monotonic clocks the test moves: ahead of the machine's by `wall` and `mono` ms. */
function frozenLinkOf(identity: Identity, extra: Partial<ConstructorParameters<typeof CloudLink>[0]> = {}) {
  const clock = { wall: 0, mono: 0 };
  const { link, logs } = linkOf(identity, { now: () => Date.now() + clock.wall, monotonic: () => performance.now() + clock.mono, ...extra });
  return { link, logs, clock };
}

test("restored from a memory snapshot (wall clock 20 min on, timers not, the relay's peer gone): one mint, a redial on the new token, a heartbeat, within 2 s", async () => {
  const { cloud, identity } = await setup();
  const { link, logs, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000 });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1);
  const before = { mints: cloud.state.mints.length, token: link.token!.value };
  // The guest's agent stepped its clock 20 min on, as Cloud's own moved; its relay connection is dead but looks open.
  cloud.state.relays[0]!.blackhole = true;
  clock.wall = 20 * 60_000;
  cloud.state.skewMs = 20 * 60_000;
  const at = Date.now();
  await until(() => cloud.state.relays.length === 2 && cloud.state.relays[1]!.ws.readyState === cloud.state.relays[1]!.ws.OPEN && cloud.state.heartbeats.length === 2 && link.status === "connected", 2_000);
  const took = Date.now() - at;
  expect(cloud.state.mints.length).toBe(before.mints + 1);
  expect(cloud.state.mints.at(-1)).toMatchObject({ ok: true });
  // Dialed on the new token, never on the one that expired while the process did not run.
  expect(cloud.state.refusedUpgrades).toBe(0);
  expect(cloud.state.relays[1]!.token).toBe(link.token!.value);
  expect(link.token!.value).not.toBe(before.token);
  expect(cloud.state.heartbeats[1]!.token).toBe(link.token!.value);
  expect(logs.filter((l) => /did not run/.test(l))).toHaveLength(1);
  expect(took).toBeLessThanOrEqual(2_000);
});

test("stopped for 30 s (SIGSTOP: timers late past the relay's 25 s ping window): the relay is dialed again at once and a heartbeat goes out, on the token still good", async () => {
  const { cloud, identity } = await setup();
  const { link, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000 });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1);
  const mints = cloud.state.mints.length;
  cloud.state.relays[0]!.blackhole = true;
  clock.wall = 30_000;
  clock.mono = 30_000;
  await until(() => cloud.state.relays.length === 2 && link.status === "connected" && cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.mints.length).toBe(mints);
  expect(cloud.state.refusedUpgrades).toBe(0);
});

test("timers late by 10 s (a short stop, an event loop stalled): a heartbeat goes out at once, and the relay connection and its streams are kept", async () => {
  const { cloud, identity } = await setup();
  const { link, logs, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000 });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1);
  const mints = cloud.state.mints.length;
  clock.wall = 10_000;
  clock.mono = 10_000;
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(cloud.state.relays).toHaveLength(1);
  expect(cloud.state.relays[0]!.ws.readyState).toBe(cloud.state.relays[0]!.ws.OPEN);
  expect(cloud.state.mints.length).toBe(mints);
  expect(link.status).toBe("connected");
  expect(logs.filter((l) => /did not run/.test(l))).toHaveLength(1);
});

test("frozen while a heartbeat was on its way (a restore, SIGSTOP, the host asleep): the next one goes right after it settles, not a heartbeat period later", async () => {
  const { cloud, identity } = await setup();
  // The heartbeat that goes out before the freeze is held on its way, as one a freeze caught mid-fetch.
  let held: (() => void) | undefined;
  let holdNext = false;
  const holding = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!String(input).endsWith("/runtime/heartbeat") || !holdNext) return fetch(input, init);
    holdNext = false;
    return new Promise<Response>((resolve, reject) => (held = () => void fetch(input, init).then(resolve, reject)));
  };
  const { link, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000, fetch: holding as typeof fetch });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1);
  holdNext = true;
  link.beat();
  await until(() => held !== undefined, 2_000);
  // Timers late by 10 s: the thaw asks for a heartbeat now, while the held one is still on its way.
  clock.wall = 10_000;
  clock.mono = 10_000;
  await new Promise((r) => setTimeout(r, 1_500));
  held!();
  await until(() => cloud.state.heartbeats.length === 3, 3_000);
});

test("restored between a third and two thirds of its token's life: refreshed on Cloud's clock, once, before the old token expires", async () => {
  // TTL 30 s: refreshed at 20 s. 2 s into its life (every clock moved on 2 s, as if it ran), then restored 17 s later on
  // Cloud's clock and its own wall clock: 1 s to the refresh point, where its timers, which did not run, would wait 18 s,
  // past the old token's expiry 11 s on.
  const { cloud, identity } = await setup({ ttlMs: 30_000 });
  const { link, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000 });
  await until(() => link.status === "connected");
  const first = link.token!;
  const mints = cloud.state.mints.length;
  clock.wall = clock.mono = cloud.state.skewMs = 2_000;
  clock.wall = cloud.state.skewMs = 19_000;
  await until(() => link.token !== first, 5_000);
  // Its wall clock moved on 17 s past its timers: the relay connection was dropped as maybe dead (thawed), so the link
  // may still be dialing it again as the token turns.
  await until(() => link.status === "connected", 5_000);
  const minted = cloud.state.mints.slice(mints);
  expect(minted).toHaveLength(1);
  expect(minted[0]).toMatchObject({ ok: true });
  // On Cloud's clock, the mint came before the old token expired.
  expect(minted[0]!.at + cloud.state.skewMs).toBeLessThan(first.expiresAt);
});

test("Cloud not minting past the refresh point: a relay that closes is dialed again on the token still good", async () => {
  const { cloud, identity } = await setup({ ttlMs: 15_000 });
  let down = false;
  const { link, logs, clock } = frozenLinkOf(identity, {
    heartbeatMs: 60_000,
    fetch: ((url: string, init: RequestInit) => (down && url.endsWith("/token") ? Promise.reject(new Error("control-api is deploying")) : fetch(url, init))) as typeof fetch,
  });
  await until(() => link.status === "connected");
  const first = link.token!;
  down = true;
  // Every clock, Cloud's too, 4 s from the token's expiry: past its refresh point (10 s of its 15). The relay restarts.
  clock.wall = clock.mono = cloud.state.skewMs = first.expiresAt - 4_000 - Date.now();
  cloud.state.relays[0]!.ws.close(1012, "relay restarting");
  await until(() => cloud.state.relays.length === 2 && link.status === "connected", 2_000);
  expect(cloud.state.relays[1]!.token).toBe(first.value);
  await until(() => logs.some((l) => /minting a runtime token failed \(control-api is deploying\)/.test(l)), 2_000);
  expect(link.token).toBe(first);
});

test("a mint Cloud never answers (a pooled connection dead after a restore) is abandoned, and the next one connects", async () => {
  const { cloud, identity } = await setup();
  let hung = 1;
  const { link } = linkOf(identity, {
    cloudTimeoutMs: 300,
    fetch: ((url: string, init: RequestInit) =>
      url.endsWith("/token") && hung-- > 0 ? new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))) : fetch(url, init)) as typeof fetch,
  });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1, 5_000);
  expect(cloud.state.mints.filter((m) => m.ok)).toHaveLength(1);
});

test("a process that runs on, or whose wall clock steps back, keeps its link: no mint, no redial", async () => {
  const { cloud, identity } = await setup();
  const { link, logs, clock } = frozenLinkOf(identity, { heartbeatMs: 60_000 });
  await until(() => link.status === "connected" && cloud.state.heartbeats.length === 1);
  const quiet = () => ({ mints: cloud.state.mints.length, relays: cloud.state.relays.length, heartbeats: cloud.state.heartbeats.length });
  const steady = quiet();
  // 5 s of running, its wall clock stepped 20 min back after 2: five ticks, two of them across the step.
  await new Promise((r) => setTimeout(r, 2_000));
  expect(quiet()).toEqual(steady);
  clock.wall = -20 * 60_000;
  await new Promise((r) => setTimeout(r, 3_000));
  expect(quiet()).toEqual(steady);
  expect(link.status).toBe("connected");
  expect(logs.filter((l) => /did not run/.test(l))).toEqual([]);
});

test("heartbeats say which build this is only once Cloud reads it: today's Cloud refuses a field it doesn't know", async () => {
  const { cloud, identity } = await setup();
  const { link, logs } = linkOf(identity, { heartbeatMs: 60_000 });
  // Cloud as it is (its decoder refuses unknown fields): nothing new is sent, so no heartbeat is refused.
  await until(() => cloud.state.heartbeats.length === 1);
  link.beat();
  await until(() => cloud.state.heartbeats.length === 2, 2_000);
  expect(cloud.state.heartbeats.map((h) => h.runtime_version)).toEqual([undefined, undefined]);
  expect(logs.filter((line) => line.includes("heartbeat answered"))).toEqual([]);
  // Cloud reads them now and says so in its answer: the next heartbeat carries them.
  cloud.state.heartbeatAccepts = ["runtime_version", "protocol_revision", "capabilities"];
  link.beat();
  await until(() => cloud.state.heartbeats.length === 3, 2_000);
  link.beat();
  await until(() => cloud.state.heartbeats.length === 4, 2_000);
  expect(cloud.state.heartbeats[3]).toMatchObject({ runtime_version: RUNTIME_VERSION, protocol_revision: PROTOCOL_REVISION, capabilities: RUNTIME_CAPABILITIES });
  // Rolled back: one heartbeat is refused, and the ones after it go out as before.
  cloud.state.heartbeatAccepts = [];
  link.beat();
  await until(() => logs.some((line) => line.includes("heartbeat answered 400")), 2_000);
  link.beat();
  await until(() => cloud.state.heartbeats.length === 5, 2_000);
  expect(cloud.state.heartbeats[4]!.runtime_version).toBeUndefined();
});
