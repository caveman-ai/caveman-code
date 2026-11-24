// A person's Macs share device approvals (docs/), end to end on the test
// Cloud: three runtime processes' worth of This Mac (each its own state, link key and desktop key), each Mac's screen
// played by its local client signing with its desktop key, and Cloud as a carrier that forges, alters, replays,
// reorders, drops and withholds rows of the person's log. An approval on one Mac's screen reaches the others; Remove
// on any of them revokes everywhere; nothing Cloud makes up or changes approves a device.
import { execFileSync } from "node:child_process";

import { connect, deviceCode, signCall, signMove, signStatement, type DeviceKey, type DeviceList, type SessionEvent } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { allowStatement, allowedStream, pairingCodeOn, removeStatement, sayHello, streamClosed, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { MAC_MOVE_REFUSALS } from "./macMoveRefusals.ts";
import { CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * One of the person's Macs on `cloud`: its runtime (with its own link state: a process of its own would hold no other's
 * token), its screen (the local client), its relay side and desktop key. `restart` stops its runtime and starts it again
 * on the same state, as a Mac that quit or crashed does.
 */
async function mac(cloud: TestCloud, name: string) {
  const config = await makeConfig();
  const requests: Array<string> = [];
  const up = async () => {
    const runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.succeed(CloudLinkState, {}) as unknown as Layer.Layer<any> });
    const local = connect(runtime.url, runtime.token);
    local.on("device.request", (r) => requests.push(r.device_id));
    return { runtime, local };
  };
  const relayOf = (runtimeId: string) => cloud.state.relays.filter((side) => cloud.state.tokens.get(side.token)?.runtimeId === runtimeId);
  const first = await up();
  const enrolled = await first.local.call("cloud.enroll", { request_id: `e-${name}`, cloud_url: cloud.url, token: cloud.state.personToken, name });
  await first.local.call("settings.set", { request_id: `rc-${name}`, settings: { remote_control: true, sync_chats: true } });
  await until(async () => (await first.local.call("cloud.status", {})).state === "connected", 15_000);
  await until(() => relayOf(enrolled.runtime_id).length > 0, 15_000);
  const on = {
    name,
    ...first,
    relay: relayOf(enrolled.runtime_id).at(-1)!,
    key: await testDevice(name, "mac"),
    requests,
    runtimeId: enrolled.runtime_id,
    restart: async () => {
      on.local.close();
      await on.runtime.close();
      const links = relayOf(enrolled.runtime_id).length;
      Object.assign(on, await up());
      await until(async () => (await on.local.call("cloud.status", {})).state === "connected", 15_000);
      await until(() => relayOf(enrolled.runtime_id).length > links, 15_000);
      on.relay = relayOf(enrolled.runtime_id).at(-1)!;
    },
  };
  cleanups.push(() => on.runtime.close());
  cleanups.push(() => on.local.close());
  return on;
}
type Mac = Awaited<ReturnType<typeof mac>>;

/** `on`'s screen allows `device`, signing for the person's other Macs with its own desktop key. */
const allowOn = (on: Mac, device: DeviceKey) => allowedStream(on.relay, on.local, device, on.relay.open(), { signer: on.key });
/** `on`'s screen removes `device`, signed. */
const removeOn = async (on: Mac, device: DeviceKey) =>
  on.local.call("device.remove", { request_id: `rm-${device.device_id}-${Date.now()}`, device_id: device.device_id, statement: await removeStatement(on.local, on.key, device.device_id) });
const list = (on: Mac): Promise<DeviceList> => on.local.call("device.list", {});
const statusOn = async (on: Mac, device: DeviceKey) => {
  const { reply } = await sayHello(on.relay, on.relay.open(), device);
  return (reply.result as { status?: string } | undefined)?.status ?? `error ${JSON.stringify(reply.error)}`;
};
const trusts = async (on: Mac, device: DeviceKey) => (await list(on)).devices.some((d) => d.device_id === device.device_id);

/** Three Macs that each allowed one other on its screen, in a cycle: A allows C, B allows A, C allows B. */
async function family(cloud: TestCloud) {
  const [a, b, c] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B"), await mac(cloud, "Mac C")];
  await allowOn(b, a.key);
  await allowOn(c, b.key);
  await allowOn(a, c.key);
  for (const on of [a, b, c]) for (const other of [a, b, c]) if (other !== on) await until(() => trusts(on, other.key), 15_000);
  return { a, b, c };
}

test("one Mac's Allow reaches the person's other Macs, and Remove on any of them revokes it everywhere at once (T8)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b, c } = await family(cloud);
  // The chain: A trusts B only through C, B trusts C through A, C trusts A through B.
  expect((await list(a)).devices.find((d) => d.device_id === b.key.device_id)).toMatchObject({ role: "mac", allowed_by: { device_id: c.key.device_id, name: "Mac C" } });
  expect((await list(a)).devices.find((d) => d.device_id === c.key.device_id)).toMatchObject({ role: "mac", shared: true });
  expect((await list(a)).devices.find((d) => d.device_id === c.key.device_id)).not.toHaveProperty("allowed_by");

  // The phone, allowed once on Mac A's screen: Mac B and Mac C answer approved at its hello and never ask.
  const phone = await testDevice("iPhone, Safari");
  const asked = { a: a.requests.length, b: b.requests.length, c: c.requests.length };
  const onA = await allowOn(a, phone);
  expect(a.requests.length).toBe(asked.a + 1);
  const onB = await allowedStream(b.relay, b.local, phone);
  const onC = await allowedStream(c.relay, c.local, phone);
  expect([b.requests.length, c.requests.length]).toEqual([asked.b, asked.c]);
  expect((await onB.call("workspace.list", {})).error).toBeUndefined();
  for (const [on, by] of [
    [b, a],
    [c, a],
  ] as const)
    expect((await list(on)).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ name: "iPhone, Safari", allowed_by: { device_id: by.key.device_id, name: "Mac A" } });
  expect((await list(a)).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ shared: true });

  // Remove on Mac C, signed by its key: the phone's open sealed connections on A and B close, everywhere it is refused.
  const removedAt = Date.now();
  await removeOn(c, phone);
  await until(() => streamClosed(a.relay, onA.stream) && streamClosed(b.relay, onB.stream) && streamClosed(c.relay, onC.stream), 10_000);
  const closedMs = Date.now() - removedAt;
  for (const on of [a, b, c]) expect(await statusOn(on, phone)).toBe("refused");
  for (const on of [a, b]) {
    const removed = (await list(on)).blocked.find((x) => x.device_id === phone.device_id);
    expect(removed).toMatchObject({ name: "iPhone, Safari", removed_by: { device_id: c.key.device_id, name: "Mac C" } });
    expect(await trusts(on, phone)).toBe(false);
  }
  expect((await list(c)).blocked.find((x) => x.device_id === phone.device_id)).not.toHaveProperty("removed_by");
  console.log(`devices across Macs (test Cloud, lab-only): the removal closed the phone's connections on all three Macs in ${closedMs} ms`);
}, 240_000);

test("Cloud's forged, altered, replayed or misaddressed rows approve nothing, in any order (T1-T4, T7, T10)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.devices.reorder = true;
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(b, a.key);
  await allowOn(a, b.key);
  await until(async () => (await trusts(a, b.key)) && (await trusts(b, a.key)), 15_000);
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  await until(() => trusts(b, phone), 15_000);
  const genuine = cloud.state.devices.rows.find((r) => (r.statement as { device_id?: string }).device_id === phone.device_id)!.statement as Record<string, unknown>;
  await removeOn(a, phone);
  await until(async () => !(await trusts(b, phone)), 15_000);

  const mallory = await testDevice("Mallory's laptop", "mac");
  const stranger = await testDevice("Cloud's own key", "mac");
  const family = (await list(a)).family!;
  const allowMallory = (by: DeviceKey, person: { organization_id?: string; user_id?: string } = {}) =>
    signStatement(by, { kind: "allow", organization_id: person.organization_id ?? family.organization_id, user_id: person.user_id ?? family.user_id, device_id: mallory.device_id, public_key: mallory.public_key, name: mallory.name, role: "mac" });
  const rows: Record<string, unknown> = {
    "forged signer": await allowMallory(stranger),
    "target key swapped": { ...genuine, device_id: mallory.device_id, public_key: mallory.public_key },
    "role changed": { ...genuine, role: "mac" },
    "no signature": { ...genuine, signature: undefined },
    "signed by the phone's browser key": await allowMallory(phone),
    "another person's": await allowMallory(a.key, { user_id: "user-2" }),
    "another org's": await allowMallory(a.key, { organization_id: "org-elsewhere" }),
    "the phone's approval replayed after its removal": genuine,
    garbage: "not a statement",
  };
  for (const [label, row] of Object.entries(rows)) cloud.state.devices.inject("user-1", row, label);
  const last = cloud.state.devices.seq;
  // Both Macs read past every injected row.
  for (const on of [a, b])
    await until(() => cloud.state.devices.reads.some((r) => r.runtime_id === on.runtimeId && r.after >= last), 30_000).catch((error) => {
      throw new Error(`${on.name} read only ${JSON.stringify(cloud.state.devices.reads.filter((r) => r.runtime_id === on.runtimeId).slice(-5))}, last ${last}`, { cause: error });
    });
  for (const on of [a, b]) {
    expect(await statusOn(on, phone)).toBe("refused");
    expect(await statusOn(on, mallory)).toBe("pending");
    expect(await trusts(on, mallory)).toBe(false);
  }
  // An approve and a remove at once, on two Macs: removed on both, whichever lands first.
  const tablet = await testDevice("iPad, Safari");
  await allowOn(a, tablet);
  await until(() => trusts(b, tablet), 15_000);
  const tabletOnB = await allowedStream(b.relay, b.local, tablet);
  await Promise.all([removeOn(b, tablet), a.local.call("device.allow", { request_id: "again", device_id: tablet.device_id, statement: await signStatement(a.key, { kind: "allow", organization_id: family.organization_id, user_id: family.user_id, device_id: tablet.device_id, public_key: tablet.public_key, name: tablet.name, role: "device" }) }).catch(() => undefined)]);
  await until(async () => !(await trusts(a, tablet)) && !(await trusts(b, tablet)) && streamClosed(b.relay, tabletOnB.stream), 15_000);
}, 240_000);

test("a dropped approval leaves the device asking (T6); a withheld removal stays with the Mac that never heard it (T5, residual)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(b, a.key);
  await allowOn(a, b.key);
  await until(async () => (await trusts(a, b.key)) && (await trusts(b, a.key)), 15_000);

  const phone = await testDevice("iPhone, Safari");
  cloud.state.devices.drop = (s) => (s as { device_id?: string }).device_id === phone.device_id;
  await allowOn(a, phone);
  await until(() => cloud.state.devices.puts.some((p) => p.dropped), 15_000);
  const asked = b.requests.length;
  expect(await statusOn(b, phone)).toBe("pending");
  await until(() => b.requests.length === asked + 1, 5_000);
  cloud.state.devices.drop = undefined;

  const tablet = await testDevice("iPad, Safari");
  await allowOn(a, tablet);
  await until(() => trusts(b, tablet), 15_000);
  cloud.state.devices.withhold = (row, runtimeId) => runtimeId === b.runtimeId && (row.statement as { kind?: string; device_id?: string }).kind === "remove" && (row.statement as { device_id?: string }).device_id === tablet.device_id;
  await removeOn(a, tablet);
  // The Mac that removed refuses at once; the one Cloud kept it from still lets it in.
  expect(await statusOn(a, tablet)).toBe("refused");
  await until(() => cloud.state.devices.reads.some((r) => r.runtime_id === b.runtimeId && r.after >= cloud.state.devices.seq), 30_000);
  expect(await statusOn(b, tablet)).toBe("approved");
  expect(await trusts(b, tablet)).toBe(true);
}, 240_000);

test("removing a Mac drops the devices trusted only through it, and their open connections (T9)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b, c } = await family(cloud);
  const phone = await testDevice("Pixel, Chrome");
  await allowOn(a, phone);
  await until(async () => (await trusts(b, phone)) && (await trusts(c, phone)), 15_000);
  const onB = await allowedStream(b.relay, b.local, phone);
  // Mac A is stolen: Mac B's screen removes its key.
  await removeOn(b, a.key);
  await until(async () => !(await trusts(b, phone)) && !(await trusts(c, phone)) && streamClosed(b.relay, onB.stream), 15_000);
  // Mac C still trusts Mac B (its own screen allowed it); Mac A is removed on both; the phone stays on Mac A's own list.
  expect(await trusts(c, b.key)).toBe(true);
  expect((await list(b)).blocked.find((x) => x.device_id === a.key.device_id)).toMatchObject({ name: "Mac A" });
  expect((await list(c)).blocked.find((x) => x.device_id === a.key.device_id)).toMatchObject({ removed_by: { device_id: b.key.device_id, name: "Mac B" } });
  expect(await trusts(a, phone)).toBe(true);
  // The phone now asks Mac B's screen again, like any device it never allowed.
  expect(await statusOn(b, phone)).toBe("pending");
}, 240_000);

test("a Mac removed on this screen keeps its removals here: the phone it removed stays out (T9)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(b, a.key);
  await allowOn(a, b.key);
  await until(async () => (await trusts(a, b.key)) && (await trusts(b, a.key)), 15_000);
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  await until(() => trusts(b, phone), 15_000);
  // Stolen: removed on Mac B, so Mac A refuses it.
  await removeOn(b, phone);
  await until(async () => !(await trusts(a, phone)), 15_000);
  expect(await statusOn(a, phone)).toBe("refused");
  // Later Mac B is retired on Mac A's screen: the phone stays removed on A, by Mac B's word.
  await removeOn(a, b.key);
  expect(await statusOn(a, phone)).toBe("refused");
  expect((await list(a)).blocked.find((x) => x.device_id === phone.device_id)).toMatchObject({ removed_by: { device_id: b.key.device_id, name: "Mac B" } });
  expect(await trusts(a, phone)).toBe(false);
}, 240_000);

test("Unblock lifts the removal it saw: the device asks again, comes back on that Mac only, and a later removal ends it again (A4)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, c } = await family(cloud);
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  await until(() => trusts(c, phone), 15_000);
  // Removed on Mac C (perhaps stolen): refused on Mac A, which lists it as Mac C's removal with an Unblock.
  await removeOn(c, phone);
  await until(async () => (await list(a)).blocked.some((x) => x.device_id === phone.device_id && x.removed_by?.name === "Mac C"), 15_000);
  expect(await statusOn(a, phone)).toBe("refused");
  // Unblock on Mac A's screen (unsigned): no longer listed as removed, and not let in on its own Allow from before: it
  // asks this screen again, showing its code, like any device.
  await a.local.call("device.remove", { request_id: "unblock-a", device_id: phone.device_id });
  const unblocked = await list(a);
  expect(unblocked.blocked.some((x) => x.device_id === phone.device_id)).toBe(false);
  expect(unblocked.devices.some((d) => d.device_id === phone.device_id)).toBe(false);
  // Allowed again on Mac A's screen, signed: in here, but Mac C's removal still stands on the person's other Macs, so
  // the row says this Mac only.
  const onA = await allowOn(a, phone);
  expect((await list(a)).devices.find((d) => d.device_id === phone.device_id)).not.toHaveProperty("shared");
  expect(await statusOn(c, phone)).toBe("refused");
  // Mac C lifts its own removal and allows it again; weeks later it is stolen and Mac C removes it once more.
  await c.local.call("device.remove", { request_id: "unblock-c", device_id: phone.device_id });
  await allowOn(c, phone);
  await removeOn(c, phone);
  // A new removal: Mac A ends the phone's connection and refuses it, naming Mac C.
  await until(() => streamClosed(a.relay, onA.stream), 15_000);
  expect(await statusOn(a, phone)).toBe("refused");
  expect((await list(a)).blocked.find((x) => x.device_id === phone.device_id)).toMatchObject({ removed_by: { device_id: c.key.device_id, name: "Mac C" } });
}, 240_000);

test("a Mac allowed before Macs shared approvals becomes an approver once it joins with the code, with no removal of it in the log (decision 31)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b, c] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B"), await mac(cloud, "Mac C")];
  await allowOn(a, c.key);
  await allowOn(c, a.key);
  await until(async () => (await trusts(a, c.key)) && (await trusts(c, a.key)), 15_000);
  // Mac C allowed Mac B before Macs shared approvals: a hello that never said its kind, an Allow that signed nothing.
  await allowedStream(c.relay, c.local, b.key, c.relay.open(), { hello: { v1: true } });
  expect((await list(c)).devices.find((d) => d.device_id === b.key.device_id)).not.toHaveProperty("role");
  expect(await trusts(a, b.key)).toBe(false);
  // Mac B's app now says, signed, that it is a Mac: Mac C serves it as before, and asks nothing on that word alone.
  const asked = c.requests.length;
  expect(await statusOn(c, b.key)).toBe("approved");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(c.requests.length).toBe(asked);
  // Joining with the code Mac C's screen shows (Add a Mac): C's screen asks once, and the Join's own connection waits on
  // that answer (m-13); B's other connections are served as before.
  const join = c.relay.open();
  const { reply } = await sayHello(c.relay, join, b.key, { pair: await pairingCodeOn(c.local) });
  expect(reply.result).toMatchObject({ status: "pending" });
  await until(() => c.requests.length === asked + 1, 10_000);
  expect((await list(c)).requests.find((r) => r.device_id === b.key.device_id)).toMatchObject({ role: "mac", name: "Mac B" });
  expect(await statusOn(c, b.key)).toBe("approved");
  // Mac C's screen lets it, signed: an approver on Mac C, and through Mac C on Mac A. Nothing was removed on the way.
  await c.local.call("device.allow", { request_id: "upgrade-b", device_id: b.key.device_id, role: "mac", statement: await allowStatement(c.local, c.key, b.key.device_id) });
  expect((await list(c)).devices.find((d) => d.device_id === b.key.device_id)).toMatchObject({ role: "mac", shared: true });
  await until(() => c.relay.replies(join).some((r) => r.method === "device.status" && (r.params as { status: string }).status === "approved"), 10_000);
  await until(() => trusts(a, b.key), 15_000);
  expect((await list(a)).devices.find((d) => d.device_id === b.key.device_id)).toMatchObject({ role: "mac", allowed_by: { device_id: c.key.device_id, name: "Mac C" } });
  expect(cloud.state.devices.rows.filter((r) => (r.statement as { kind?: string }).kind === "remove")).toEqual([]);
  // Its approvals count on both: a phone allowed on Mac B's screen is let in on Mac A and Mac C without asking.
  const phone = await testDevice("iPhone, Safari");
  await allowOn(b, phone);
  await until(async () => (await trusts(a, phone)) && (await trusts(c, phone)), 15_000);
  const before = { a: a.requests.length, c: c.requests.length };
  expect([await statusOn(a, phone), await statusOn(c, phone)]).toEqual(["approved", "approved"]);
  expect({ a: a.requests.length, c: c.requests.length }).toEqual(before);
}, 240_000);

test("a removal waits in the outbox while Cloud will not take it, survives a restart, and then reaches the other Mac", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(b, a.key);
  await allowOn(a, b.key);
  await until(async () => (await trusts(a, b.key)) && (await trusts(b, a.key)), 15_000);
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  await until(() => trusts(b, phone), 15_000);
  // The person may not run Caveman Code for a while (a role change): Cloud refuses Mac A's put, 403.
  cloud.state.devices.refuse = () => ({ status: 403, code: "cave_forbidden", message: "This runtime acts for no member who may run Caveman Code." });
  const reads = cloud.state.devices.reads.length;
  await removeOn(a, phone);
  expect(await statusOn(a, phone)).toBe("refused");
  // The put failed, so the round read the log without waiting (a statement still to go), then backed off.
  await until(() => cloud.state.devices.reads.slice(reads).some((r) => r.runtime_id === a.runtimeId && r.wait_ms === 0), 15_000);
  // Kept to send again, not refused for good; Mac B has not heard.
  expect((await list(a)).blocked.find((x) => x.device_id === phone.device_id)).not.toHaveProperty("not_shared");
  expect(cloud.state.devices.rows.some((r) => (r.statement as { kind?: string }).kind === "remove")).toBe(false);
  expect(await trusts(b, phone)).toBe(true);
  // Cloud takes statements again, and Mac A quits and starts again: the removal goes, and Mac B refuses the phone.
  cloud.state.devices.refuse = undefined;
  await a.restart();
  expect(await statusOn(a, phone)).toBe("refused");
  await until(() => cloud.state.devices.rows.some((r) => (r.statement as { kind?: string; device_id?: string }).kind === "remove" && (r.statement as { device_id?: string }).device_id === phone.device_id), 15_000);
  await until(async () => !(await trusts(b, phone)), 15_000);
  expect(await statusOn(b, phone)).toBe("refused");
  expect((await list(b)).blocked.find((x) => x.device_id === phone.device_id)).toMatchObject({ removed_by: { device_id: a.key.device_id, name: "Mac A" } });
  // Mac A still trusts Mac B after the restart, and B's word still counts there.
  expect(await trusts(a, b.key)).toBe(true);
}, 240_000);

test("a statement Cloud refuses for good is kept on this Mac with why, and the Mac still takes its other Macs' removals", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(b, a.key);
  await allowOn(a, b.key);
  await until(async () => (await trusts(a, b.key)) && (await trusts(b, a.key)), 15_000);
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  await until(() => trusts(b, phone), 15_000);
  // Cloud refuses Mac A's allow of a tablet for good, as a full log does.
  const tablet = await testDevice("iPad, Safari");
  cloud.state.devices.refuse = (s) =>
    (s as { device_id?: string }).device_id === tablet.device_id ? { status: 409, code: "cave_code_device_log_full", message: "The person's device log is full." } : undefined;
  await allowOn(a, tablet);
  await until(async () => (await list(a)).devices.find((d) => d.device_id === tablet.device_id)?.not_shared === "The person's device log is full.", 15_000);
  expect((await list(a)).devices.find((d) => d.device_id === tablet.device_id)).not.toHaveProperty("shared");
  // Mac B removes the phone: Mac A still follows the log, and refuses it.
  const onA = await allowedStream(a.relay, a.local, phone);
  await removeOn(b, phone);
  await until(() => streamClosed(a.relay, onA.stream), 15_000);
  expect(await statusOn(a, phone)).toBe("refused");
  // The tablet was never carried: Mac B never heard of it, and Mac A put it once only.
  expect(cloud.state.devices.rows.some((r) => (r.statement as { device_id?: string }).device_id === tablet.device_id)).toBe(false);
  expect(await statusOn(b, tablet)).toBe("pending");
}, 240_000);

test("an Allow signed over another device than the one that asked, or for another person, is refused on the Mac's own screen", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const a = await mac(cloud, "Mac A");
  const phone = await testDevice("iPhone, Safari");
  const other = await testDevice("Someone's phone");
  void sayHello(a.relay, a.relay.open(), phone);
  await until(async () => (await list(a)).requests.some((r) => r.device_id === phone.device_id), 10_000);
  const genuine = await allowStatement(a.local, a.key, phone.device_id);
  const family = (await list(a)).family!;
  const reasonOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { error?: { data?: { reason?: string } }; message?: string }) => error.error?.data?.reason ?? String(error.message));
  for (const statement of [
    { ...genuine, name: "Renamed" },
    await signStatement(a.key, { ...genuine, name: "Renamed" }),
    await signStatement(a.key, { ...genuine, role: "mac" }),
    await signStatement(a.key, { ...genuine, device_id: other.device_id, public_key: other.public_key }),
    await signStatement(a.key, { ...genuine, user_id: "user-2" }),
    await signStatement(a.key, { kind: "remove", organization_id: family.organization_id, user_id: family.user_id, device_id: phone.device_id }),
  ])
    expect(await reasonOf(a.local.call("device.allow", { request_id: `bad-${Math.random()}`, device_id: phone.device_id, statement: statement as never }))).toBe("invalid_params");
  expect((await list(a)).devices.some((d) => d.device_id === phone.device_id)).toBe(false);
  expect(cloud.state.devices.rows).toEqual([]);
  expect(await reasonOf(a.local.call("device.allow", { request_id: "good", device_id: phone.device_id, statement: genuine }))).toBe("ok");
  await until(() => cloud.state.devices.rows.length === 1, 15_000);
}, 120_000);

test("after a restart a removed phone's queued call and signed move wait for a fresh read of the log, then are refused; the note names a code only for a removed device (T8, T14)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowOn(a, b.key);
  // A chat on Mac A that Cloud may move (sync on, a GitHub repository, a Cloud computer to move it to).
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("devices-moves-"), { "README.md": "moves\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/moves.git"], { cwd: repo });
  const w = await createReady(a.local, { request_id: "w-moves", repo: { path: repo }, title: "Moves", engine: "claude-agent", options: { model: MODEL } });
  await until(() => cloud.state.chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const home = cloud.state.chats.sessions.get(w.session_id)!.computer_id;
  // The phone, allowed on Mac B's screen: Mac A lets it in through Mac B.
  const phone = await testDevice("iPhone, Safari");
  await allowOn(b, phone);
  await until(() => trusts(a, phone), 15_000);

  const person = (method: string, route: string, body?: unknown) =>
    fetch(`${cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${cloud.state.personToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(
      (r) => r.json() as Promise<{ status?: string; pending?: boolean; error?: { code?: string } }>,
    );
  const move = async (key: DeviceKey, request_id: string, now = Date.now()) =>
    person("POST", `chats/${w.session_id}/move`, { to: "cloud", request_id, device: await signMove(key, { session_id: w.session_id, request_id, to: "cloud" }, now) });
  const refusals = async () => {
    const events: Array<SessionEvent> = [];
    const sub = await a.local.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
    await sub.detach();
    return events.filter((e) => e.type === "notification" && /A move from Caveman was refused/.test(JSON.stringify(e.payload))).map((e) => JSON.stringify(e.payload));
  };
  const stays = () => expect(cloud.state.chats.sessions.get(w.session_id)?.computer_id).toBe(home);

  // T14: a key Cloud made wait on Mac A's screen with one hello. Its move is refused, and Mac A's chat never vouches for
  // its code (nor tells the person to allow it): the waiting request counts as a key Mac A never saw.
  const planted = await testDevice("Julius's iPhone");
  expect(await statusOn(a, planted)).toBe("pending");
  expect(await move(planted, "planted")).toMatchObject({ pending: true });
  await until(async () => (await refusals()).length === 1, 30_000);
  expect((await refusals())[0]).toContain("A device this Mac doesn't know asked for it");
  expect((await refusals())[0]).not.toContain(deviceCode(planted.device_id));
  // A device Mac A allows, whose move waited more than 23 hours: said as such, never "not allowed".
  await move(phone, "late", Date.now() - 24 * 60 * 60_000);
  await until(async () => (await refusals()).length === 2, 30_000);
  expect((await refusals())[1]).toContain(JSON.stringify(MAC_MOVE_REFUSALS.expiredNote()).slice(1, -1));
  stays();

  // Mac A's reads of the log hang from now on (its network not back yet after a restart, or Cloud slow), and Mac B
  // removes the phone meanwhile.
  cloud.state.devices.hold = (runtimeId) => runtimeId === a.runtimeId;
  const reads = cloud.state.devices.reads.length;
  cloud.state.devices.inject("user-1", "nothing");
  await until(() => cloud.state.devices.reads.slice(reads).some((r) => r.runtime_id === a.runtimeId && r.held === true), 30_000);
  await removeOn(b, phone);
  await until(() => cloud.state.devices.rows.some((r) => (r.statement as { kind?: string; device_id?: string }).kind === "remove" && (r.statement as { device_id?: string }).device_id === phone.device_id), 15_000);
  // Mac A quits and starts again; the phone (stolen) queues a call and moves the chat.
  await a.restart();
  const started = cloud.state.devices.reads.length;
  const call = { session_id: w.session_id, request_id: "after-restart", method: "turn.submit", params: { session_id: w.session_id, kind: "followup", input: { text: "from the stolen phone" } } };
  await person("POST", `chats/${w.session_id}/calls`, { request_id: call.request_id, method: call.method, params: call.params, device: await signCall(phone, call) });
  const callState = () => person("GET", `chats/${w.session_id}/calls/${call.request_id}`);
  await move(phone, "stolen");
  // Mac A reads the log before it answers either; the read hangs, so neither is run nor refused, and the chat stays.
  await until(() => cloud.state.devices.reads.slice(started).filter((r) => r.runtime_id === a.runtimeId && r.held === true).length >= 2, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(["done", "failed"]).not.toContain((await callState()).status);
  expect(await refusals()).toHaveLength(2);
  stays();
  // The log is read again: the removal is in it. The move is refused, its note naming the removed phone's code, and the
  // call, handed out again, is refused.
  cloud.state.devices.hold = undefined;
  await until(async () => (await refusals()).length === 3, 90_000);
  expect((await refusals())[2]).toContain(`The device that asked (${deviceCode(phone.device_id)}) was removed from this Mac`);
  await until(async () => ["done", "failed"].includes((await callState()).status ?? ""), 90_000);
  expect(await callState()).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
  stays();
}, 300_000);

test("a device's signed move this Mac refused for good is spent: Cloud handing the same move back within its day moves nothing (m-k)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const a = await mac(cloud, "Mac A");
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("devices-spent-"), { "README.md": "spent\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/spent.git"], { cwd: repo });
  const w = await createReady(a.local, { request_id: "w-spent", repo: { path: repo }, title: "Spent", engine: "claude-agent", options: { model: MODEL } });
  await until(() => cloud.state.chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const home = cloud.state.chats.sessions.get(w.session_id)!.computer_id;
  const workspaceId = cloud.state.chats.sessions.get(w.session_id)!.workspace_id;
  const phone = await testDevice("iPhone, Safari");
  await allowOn(a, phone);
  const notes = async (title: string) => {
    const events: Array<SessionEvent> = [];
    const sub = await a.local.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
    await sub.detach();
    return events.flatMap((e) => (e.type === "notification" && e.payload.title === title ? [e.payload.body ?? ""] : []));
  };
  // The phone's move reaches Mac A while Claude has no Cloud login: refused for good, said in the chat.
  cloud.state.chats.engineLogins.delete("user-1");
  const request_id = "refused-for-good";
  const device = await signMove(phone, { session_id: w.session_id, request_id, to: "cloud" });
  const handed = () =>
    cloud.state.chats.link!.post({
      verb: "handoff",
      authority: "system",
      channel: "move",
      to_workspace_id: workspaceId,
      body: JSON.stringify({ action: "move", session_id: w.session_id, reason: "user", to: "cloud", user_id: "user-1", request_id, device }),
    });
  handed();
  await until(async () => (await notes("The move did not go through")).length === 1, 30_000);
  // With a login there now, Cloud hands Mac A that same signed move again: spent, it moves nothing.
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  handed();
  await until(async () => (await notes("A move from Caveman was refused")).length === 1, 30_000);
  expect((await notes("A move from Caveman was refused"))[0]).toContain("made once already");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(cloud.state.chats.sessions.get(w.session_id)?.computer_id).toBe(home);
  expect((await a.local.call("workspace.get", { workspace_id: w.id })).computer.kind).toBe("this_mac");
}, 120_000);
