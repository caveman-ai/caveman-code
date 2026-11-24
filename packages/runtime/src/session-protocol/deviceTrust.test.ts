// Whom This Mac trusts from its own screen's allows and the person's signed statements (deviceTrust.ts); each case
// names the threat it answers (docs/).
import { newDeviceKeyPair, signStatement, verifyStatement, webCryptoDeviceKey, type DeviceKey, type DeviceStatement } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { removalKey, trusted, type TrustInput, type TrustRoot } from "./deviceTrust.ts";

/** The statements in `raw` that verify, as devices.ts take keeps them; anything else is dropped. */
async function verifiedStatements(raw: ReadonlyArray<unknown>): Promise<Array<DeviceStatement>> {
  const out: Array<DeviceStatement> = [];
  for (const item of raw) {
    const statement = await verifyStatement(item);
    if (statement) out.push(statement);
  }
  return out;
}

const ORG = "org-1";
const ME = "user-1";
const key = async (name: string, kind?: "mac") => webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name, ...(kind ? { kind } : {}) });
const root = (k: DeviceKey): TrustRoot => ({ device_id: k.device_id, public_key: k.public_key, name: k.name, role: k.kind ?? "device" });
const allow = (by: DeviceKey, k: DeviceKey, person: { org?: string; user?: string } = {}, at?: number) =>
  signStatement(by, { kind: "allow", organization_id: person.org ?? ORG, user_id: person.user ?? ME, device_id: k.device_id, public_key: k.public_key, name: k.name, role: k.kind ?? "device" }, at);
const remove = (by: DeviceKey, k: DeviceKey) => signStatement(by, { kind: "remove", organization_id: ORG, user_id: ME, device_id: k.device_id });
const of = (input: Partial<TrustInput> & Pick<TrustInput, "roots" | "statements">) => trusted({ organizationId: ORG, userId: ME, ...input });
const ids = (trust: ReturnType<typeof trusted>) => [...trust.devices.keys()].sort();
const sorted = (...keys: Array<DeviceKey>) => keys.map((k) => k.device_id).sort();

test("a Mac this Mac allowed allows a phone for it; a signed allow names who allowed it", async () => {
  const [studio, phone] = [await key("Studio", "mac"), await key("iPhone, Safari")];
  const trust = of({ roots: [root(studio)], statements: [await allow(studio, phone)] });
  expect(ids(trust)).toEqual(sorted(studio, phone));
  expect(trust.devices.get(studio.device_id)).toMatchObject({ role: "mac", name: "Studio" });
  expect(trust.devices.get(studio.device_id)).not.toHaveProperty("allowed_by");
  expect(trust.devices.get(phone.device_id)).toMatchObject({ role: "device", name: "iPhone, Safari", allowed_by: { device_id: studio.device_id, name: "Studio" } });
});

test("an unknown signer adds nothing (T1), and a forged or altered statement never verifies (T1, T2)", async () => {
  const [studio, stranger, phone] = [await key("Studio", "mac"), await key("Cloud's own key", "mac"), await key("Mallory's phone")];
  const forged = await allow(stranger, phone);
  expect(ids(of({ roots: [root(studio)], statements: [forged] }))).toEqual(sorted(studio));
  // No roots: nothing at all, whatever the log says.
  expect(ids(of({ roots: [], statements: [forged, await allow(studio, phone)] }))).toEqual([]);
  const genuine = await allow(studio, await key("iPhone, Safari"));
  const altered = [
    { ...genuine, signature: undefined },
    { ...genuine, device_id: phone.device_id, public_key: phone.public_key },
    { ...genuine, role: "mac" },
    { ...genuine, name: "iPhone, Safari (2)" },
    { ...genuine, signer: { device_id: stranger.device_id, public_key: stranger.public_key } },
  ];
  expect(await verifiedStatements([...altered, "garbage", null, genuine])).toEqual([genuine]);
});

test("another person's or another org's statement adds nothing (T3)", async () => {
  const [studio, phone] = [await key("Studio", "mac"), await key("iPhone, Safari")];
  for (const person of [{ user: "user-2" }, { org: "org-2" }]) expect(ids(of({ roots: [root(studio)], statements: [await allow(studio, phone, person)] }))).toEqual(sorted(studio));
  // Nor does another person's removal take one away.
  const theirs = await signStatement(studio, { kind: "remove", organization_id: ORG, user_id: "user-2", device_id: phone.device_id });
  expect(ids(of({ roots: [root(studio), root(phone)], statements: [theirs] }))).toEqual(sorted(studio, phone));
});

test("a statement signed by a role-device key is ignored, allows and removals alike (T7)", async () => {
  const [studio, browser, phone, laptop] = [await key("Studio", "mac"), await key("Mac, Chrome"), await key("iPhone, Safari"), await key("MacBook", "mac")];
  // The browser is trusted (a Mac allowed it), but its key is a page's that Cloud serves: it allows no one.
  const trust = of({ roots: [root(studio), root(browser)], statements: [await allow(browser, phone)] });
  expect(ids(trust)).toEqual(sorted(studio, browser));
  // And removes no one.
  expect(ids(of({ roots: [root(studio), root(browser), root(laptop)], statements: [await remove(browser, laptop)] }))).toEqual(sorted(studio, browser, laptop));
  // A role-device root never signs, even when it holds a key that says "mac" of itself in a statement it made.
  const claims = await allow(browser, { ...browser, kind: "mac" } as DeviceKey);
  expect(of({ roots: [root(studio), root(browser)], statements: [claims, await allow(browser, phone)] }).devices.get(browser.device_id)?.role).toBe("device");
});

test("a removal beats an allow in any order, including an allow replayed after it (T4, T10)", async () => {
  const [studio, mini, phone] = [await key("Studio", "mac"), await key("Mac mini", "mac"), await key("iPhone, Safari")];
  const allowed = await allow(studio, phone);
  const removed = await remove(mini, phone);
  const again = await allow(studio, phone);
  for (const order of [
    [allowed, removed],
    [removed, allowed],
    [allowed, removed, again],
    [removed, again, allowed],
  ]) {
    const trust = of({ roots: [root(studio), root(mini)], statements: order });
    expect(ids(trust)).toEqual(sorted(studio, mini));
    expect(trust.removed.get(phone.device_id)).toEqual({ device_id: phone.device_id, name: "iPhone, Safari", removed_by: { device_id: mini.device_id, name: "Mac mini" } });
  }
  // Even a device this Mac's own screen allowed: removal on any of the person's Macs revokes it everywhere.
  expect(ids(of({ roots: [root(studio), root(phone)], statements: [await remove(studio, phone)] }))).toEqual(sorted(studio));
});

test("a removal by a key this Mac does not trust is ignored", async () => {
  const [studio, stranger, phone] = [await key("Studio", "mac"), await key("Someone's Mac", "mac"), await key("iPhone, Safari")];
  const trust = of({ roots: [root(studio), root(phone)], statements: [await remove(stranger, phone)] });
  expect(ids(trust)).toEqual(sorted(studio, phone));
  expect(trust.removed.size).toBe(0);
});

test("removing a Mac drops devices trusted only through it, and keeps those allowed here or through another Mac (T9)", async () => {
  const [studio, mini, stolen] = [await key("Studio", "mac"), await key("Mac mini", "mac"), await key("MacBook", "mac")];
  const [onlyThrough, alsoMini, here] = [await key("Tablet"), await key("iPhone, Safari"), await key("Mac, Firefox")];
  const statements = [
    await allow(studio, stolen),
    await allow(stolen, onlyThrough),
    await allow(stolen, alsoMini),
    await allow(mini, alsoMini),
    await allow(stolen, here),
  ];
  const before = of({ roots: [root(studio), root(mini), root(here)], statements });
  expect(ids(before)).toEqual(sorted(studio, mini, stolen, onlyThrough, alsoMini, here));
  const after = of({ roots: [root(studio), root(mini), root(here)], statements: [...statements, await remove(mini, stolen)] });
  expect(ids(after)).toEqual(sorted(studio, mini, alsoMini, here));
  expect(after.devices.get(alsoMini.device_id)?.allowed_by).toEqual({ device_id: mini.device_id, name: "Mac mini" });
  expect(after.removed.get(stolen.device_id)?.removed_by.name).toBe("Mac mini");
});

test("a removed Mac's removals still stand: a thief cannot undo them", async () => {
  const [studio, stolen, phone] = [await key("Studio", "mac"), await key("MacBook", "mac"), await key("iPhone, Safari")];
  const statements = [await allow(studio, stolen), await allow(studio, phone), await remove(stolen, phone), await remove(studio, stolen)];
  const trust = of({ roots: [root(studio)], statements });
  expect(ids(trust)).toEqual(sorted(studio));
  expect(trust.removed.get(phone.device_id)?.removed_by).toEqual({ device_id: stolen.device_id, name: "MacBook" });
  // Allowing it again, from the thief's key or anyone's, does not bring it back.
  expect(ids(of({ roots: [root(studio)], statements: [...statements, await allow(stolen, phone), await allow(studio, phone)] }))).toEqual(sorted(studio));
});

test("this Mac's block wins here, and Unblock with an Allow here re-allows only here", async () => {
  const [studio, phone] = [await key("Studio", "mac"), await key("iPhone, Safari")];
  // Blocked on this screen: a statement from a trusted Mac does not bring it in.
  expect(ids(of({ roots: [root(studio)], statements: [await allow(studio, phone)], blocked: [phone.device_id] }))).toEqual(sorted(studio));
  const removed = [await allow(studio, phone), await remove(studio, phone)];
  const unblock = [removalKey(removed[1]!)];
  // Unblocked but not allowed again here: still not trusted, and no longer listed as removed (it may ask here).
  const lifted = of({ roots: [root(studio)], statements: removed, lifted: unblock });
  expect(ids(lifted)).toEqual(sorted(studio));
  expect(lifted.removed.size).toBe(0);
  // Allowed again on this screen: trusted here, and listed as lifted here only (its row is not shared: the removal
  // stands on the person's other Macs). Another Mac without the Unblock still has it removed.
  const again = of({ roots: [root(studio), root(phone)], statements: removed, lifted: unblock });
  expect(ids(again)).toEqual(sorted(studio, phone));
  expect(again.lifted.get(phone.device_id)?.removed_by).toEqual({ device_id: studio.device_id, name: "Studio" });
  expect(ids(of({ roots: [root(studio), root(phone)], statements: removed }))).toEqual(sorted(studio));
  expect(of({ roots: [root(studio), root(phone)], statements: removed }).lifted.size).toBe(0);
});

test("an Unblock lifts the removals it saw, never a later one (A4)", async () => {
  const [studio, mini, phone] = [await key("Studio", "mac"), await key("Mac mini", "mac"), await key("iPhone, Safari")];
  // Removed by mistake on the Mac mini, unblocked and allowed again here.
  const mistake = await remove(mini, phone);
  const roots = [root(studio), root(mini), root(phone)];
  expect(ids(of({ roots, statements: [mistake], lifted: [removalKey(mistake)] }))).toEqual(sorted(studio, mini, phone));
  // Weeks later it is stolen and removed on the Mac mini again: a new removal, which counts here at once.
  const stolen = of({ roots, statements: [mistake, await remove(mini, phone)], lifted: [removalKey(mistake)] });
  expect(ids(stolen)).toEqual(sorted(studio, mini));
  expect(stolen.removed.get(phone.device_id)?.removed_by).toEqual({ device_id: mini.device_id, name: "Mac mini" });
});

test("a Mac this screen removed keeps its removals here: a phone it removed never comes back (T9)", async () => {
  // On Mac A: Mac B and the phone allowed on A's screen; the phone is stolen and removed on Mac B.
  const [macB, phone] = [await key("Mac B", "mac"), await key("iPhone, Safari")];
  const statements = [await remove(macB, phone)];
  expect(ids(of({ roots: [root(macB), root(phone)], statements }))).toEqual(sorted(macB));
  // Later the person retires Mac B with Remove on A's screen: B is no root here any more, and blocked. Its removal
  // still stands, so the phone stays out.
  const retired = of({ roots: [root(phone)], statements, blocked: [macB.device_id], removers: [{ device_id: macB.device_id, name: "Mac B" }] });
  expect(ids(retired)).toEqual([]);
  expect(retired.removed.get(phone.device_id)?.removed_by).toEqual({ device_id: macB.device_id, name: "Mac B" });
  // This Mac's own key is a remover too: what its screen removed stays removed here after an Unblock of something else.
  const self = await key("Mac A", "mac");
  expect(ids(of({ roots: [root(phone)], statements: [await remove(self, phone)], removers: [{ device_id: self.device_id, name: "This Mac" }] }))).toEqual([]);
  // A remover is never trusted for being one, and allows nothing.
  expect(ids(of({ roots: [], statements: [await allow(macB, phone)], removers: [{ device_id: macB.device_id, name: "Mac B" }] }))).toEqual([]);
});

test("a Mac this screen removed keeps its removals here after Unblock and an Allow of it as a device: the phone it removed stays out (T9)", async () => {
  // On Mac A: Mac B removed the stolen phone; A's screen removed Mac B (retired: a remover), unblocked it, and allowed it
  // again when it asked without the code, so as a device.
  const [self, macB, phone] = [await key("Mac A", "mac"), await key("Mac B", "mac"), await key("iPhone, Safari")];
  const retire = await remove(self, macB);
  const again = of({
    roots: [root(phone), { ...root(macB), role: "device" }],
    statements: [await remove(macB, phone), retire],
    removers: [
      { device_id: self.device_id, name: "This Mac" },
      { device_id: macB.device_id, name: "Mac B" },
    ],
    lifted: [removalKey(retire)],
  });
  expect(ids(again)).toEqual(sorted(macB));
  expect(again.removed.get(phone.device_id)?.removed_by).toEqual({ device_id: macB.device_id, name: "Mac B" });
});

test("a statement's time decides nothing (T13)", async () => {
  const [studio, phone] = [await key("Studio", "mac"), await key("iPhone, Safari")];
  for (const at of [Date.parse("1999-01-01T00:00:00Z"), Date.parse("2099-01-01T00:00:00Z")]) {
    const statements = await verifiedStatements([await allow(studio, phone, {}, at)]);
    expect(ids(of({ roots: [root(studio)], statements }))).toEqual(sorted(studio, phone));
  }
  // A removal dated before the allow still wins.
  const early = await verifiedStatements([await signStatement(studio, { kind: "remove", organization_id: ORG, user_id: ME, device_id: phone.device_id }, Date.parse("2000-01-01T00:00:00Z"))]);
  expect(ids(of({ roots: [root(studio)], statements: [...early, await allow(studio, phone)] }))).toEqual(sorted(studio));
});

test("order never decides: random statement sets, shuffled, give the same trust", async () => {
  // A seeded generator, so a failure replays.
  let seed = 0x5eed;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const keys = [
    ...(await Promise.all(["Studio", "Mac mini", "MacBook", "iMac"].map((name) => key(name, "mac")))),
    ...(await Promise.all(["iPhone", "iPad", "Mac, Chrome", "Pixel"].map((name) => key(name)))),
  ];
  const shuffle = <T,>(items: ReadonlyArray<T>) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const view = (trust: ReturnType<typeof trusted>) => JSON.stringify([[...trust.devices].sort(), [...trust.removed].sort(), [...trust.lifted].sort()]);
  for (let round = 0; round < 40; round++) {
    const statements: Array<DeviceStatement> = [];
    for (let n = rand(14); n > 0; n--) {
      const by = keys[rand(keys.length)]!;
      const target = keys[rand(keys.length)]!;
      statements.push(rand(4) === 0 ? await remove(by, target) : await allow(by, target));
    }
    const roots = shuffle(keys).slice(0, 1 + rand(2)).map(root);
    const expected = view(of({ roots, statements }));
    for (let again = 0; again < 5; again++) expect(view(of({ roots: shuffle(roots), statements: shuffle(statements) }))).toBe(expected);
  }
});

const vouch = (by: DeviceKey, agents: DeviceKey, name = by.name) =>
  signStatement(by, { kind: "agents", organization_id: ORG, user_id: ME, device_id: agents.device_id, public_key: agents.public_key, name });

test("a Mac's agents key counts when a Mac this Mac trusts vouched for it, and is never a device (T16)", async () => {
  const [studio, mini, phone] = [await key("Studio", "mac"), await key("Mini", "mac"), await key("iPhone, Safari")];
  const [studioAgents, miniAgents] = [await key("agents"), await key("agents")];
  // Studio allowed here; Mini only through Studio.
  const statements = [await allow(studio, mini), await vouch(studio, studioAgents), await vouch(mini, miniAgents), await allow(studio, phone)];
  const trust = of({ roots: [root(studio)], statements });
  expect([...trust.agents.keys()].sort()).toEqual(sorted(studioAgents, miniAgents));
  expect(trust.agents.get(miniAgents.device_id)).toEqual({ device_id: miniAgents.device_id, public_key: miniAgents.public_key, vouched_by: { device_id: mini.device_id, name: "Mini" } });
  // Never a device: it drives nothing, whoever vouched.
  expect(trust.devices.has(studioAgents.device_id)).toBe(false);
  expect(trust.devices.has(miniAgents.device_id)).toBe(false);
});

test("a vouch by a phone, an unknown key, a removed Mac, or for a removed agents key does not count; order never decides (T16)", async () => {
  const [studio, mini, phone, stranger] = [await key("Studio", "mac"), await key("Mini", "mac"), await key("iPhone, Safari"), await key("Cloud's own key", "mac")];
  const [a1, a2, a3, a4] = [await key("agents"), await key("agents"), await key("agents"), await key("agents")];
  const base = [await allow(studio, mini), await allow(studio, phone)];
  const vouches = [await vouch(phone, a1), await vouch(stranger, a2), await vouch(mini, a3), await vouch(studio, a4)];
  // A phone's (role device) and an unknown key's vouch never count; Mini's and Studio's do.
  expect([...of({ roots: [root(studio)], statements: [...base, ...vouches] }).agents.keys()].sort()).toEqual(sorted(a3, a4));
  // Mini removed (by Studio): its vouch stops counting. Studio's own agents key removed: so does Studio's vouch.
  const removals = [await remove(studio, mini), await remove(studio, a4)];
  for (const order of [
    [...base, ...vouches, ...removals],
    [...removals, ...vouches.reverse(), ...base],
  ])
    expect([...of({ roots: [root(studio)], statements: order }).agents.keys()]).toEqual([]);
  // Blocked here: never counted.
  expect([...of({ roots: [root(studio)], statements: [...base, ...vouches], blocked: [a4.device_id] }).agents.keys()].sort()).toEqual(sorted(a3));
  // Another person's vouch adds nothing.
  const theirs = await signStatement(studio, { kind: "agents", organization_id: ORG, user_id: "user-2", device_id: a1.device_id, public_key: a1.public_key, name: "Studio" });
  expect([...of({ roots: [root(studio)], statements: [theirs] }).agents.keys()]).toEqual([]);
});
