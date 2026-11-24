import { newDeviceKeyPair, verifyStatement, webCryptoDeviceKey, type DeviceKey } from "@caveman-app/session-protocol/devices";
import { afterEach, expect, test, vi } from "vitest";

import { keepVouching, vouchAgentsKey, type AgentsKeyClient } from "./device-key.ts";

afterEach(() => vi.useRealTimers());

const family = { organization_id: "org-1", user_id: "user-1" };
const key = async (name: string, kind?: "mac") => webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name, ...(kind ? { kind } : {}) });

/** This Mac's runtime as its screen sees it: its agents key, under This Mac's name, vouched for once a vouch lands. */
function runtime(agents: DeviceKey | undefined) {
  const calls: Array<{ method: string; params: any }> = [];
  let vouched = false;
  const landed = Promise.withResolvers<void>();
  const client = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "device.agents") return { ...(agents ? { agents: { device_id: agents.device_id, public_key: agents.public_key } } : {}), name: "Studio", vouched };
      vouched = true;
      landed.resolve();
      return { vouched: true };
    },
  } as unknown as AgentsKeyClient;
  return { client, calls, vouch: landed.promise };
}

test("the desktop's screen vouches for its own runtime's agents key once per person, under This Mac's name; never a browser, never again once done", async () => {
  const [desktop, browser, agents] = [await key("Studio", "mac"), await key("Mac, Chrome"), await key("agents")];
  const own = runtime(agents);
  await vouchAgentsKey(own.client, family, async () => desktop);
  expect(own.calls.map((c) => c.method)).toEqual(["device.agents", "device.vouch"]);
  const vouch = own.calls[1]!.params.statement;
  expect(await verifyStatement(vouch)).toEqual(vouch);
  expect(vouch).toMatchObject({ kind: "agents", organization_id: "org-1", user_id: "user-1", device_id: agents.device_id, public_key: agents.public_key, name: "Studio", signer: { device_id: desktop.device_id } });
  expect(vouch).not.toHaveProperty("role");
  // Every later list refresh: nothing asked again for this runtime and person.
  await vouchAgentsKey(own.client, family, async () => desktop);
  await vouchAgentsKey(own.client, family, async () => desktop);
  expect(own.calls).toHaveLength(2);
  // Another person signed in on it: asked once for them.
  await vouchAgentsKey(own.client, { ...family, user_id: "user-2" }, async () => desktop);
  expect(own.calls.map((c) => c.method).slice(2)).toEqual(["device.agents"]);

  // A runtime whose log already holds the vouch, or with no agents key (no desktop app): nothing signed.
  const done = runtime(agents);
  await done.client.call("device.vouch", {} as never);
  await vouchAgentsKey(done.client, family, async () => desktop);
  expect(done.calls.map((c) => c.method)).toEqual(["device.vouch", "device.agents"]);
  const headless = runtime(undefined);
  await vouchAgentsKey(headless.client, family, async () => desktop);
  expect(headless.calls.map((c) => c.method)).toEqual(["device.agents"]);
  // A browser's key never vouches, nor asks.
  const fromBrowser = runtime(agents);
  await vouchAgentsKey(fromBrowser.client, family, async () => browser);
  expect(fromBrowser.calls).toEqual([]);
  // A failure is tried again on the next call.
  const flaky = runtime(agents);
  await expect(vouchAgentsKey(flaky.client, family, async () => Promise.reject(new Error("keychain locked")))).rejects.toThrow(/keychain/);
  await vouchAgentsKey(flaky.client, family, async () => desktop);
  expect(flaky.calls.map((c) => c.method)).toEqual(["device.agents", "device.vouch"]);
});

test("a vouch that failed is tried again, later each time, until it goes, and never after the screen stopped it", async () => {
  const [desktop, agents] = [await key("Studio", "mac"), await key("agents")];
  // The waits are the ones keepVouching asks for, not however late a busy machine runs them.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let failures = 2;
  const own = runtime(agents);
  const start = Date.now();
  const attempts: Array<number> = [];
  const flaky = async () => {
    attempts.push(Date.now() - start);
    if (failures-- > 0) throw new Error("keychain locked");
    return desktop;
  };
  const stop = keepVouching(own.client, family, { own: flaky, waitMs: 20, maxMs: 200 });
  await vi.advanceTimersByTimeAsync(60);
  expect(attempts).toEqual([0, 20, 60]);
  await own.vouch;
  expect(own.calls.map((c) => c.method)).toEqual(["device.agents", "device.vouch"]);
  expect(vi.getTimerCount()).toBe(0);
  stop();
  // Stopped (the screen went): nothing is tried again.
  const never = runtime(agents);
  const tried: Array<number> = [];
  const stopNow = keepVouching(never.client, { ...family, user_id: "user-9" }, { own: async () => (tried.push(1), Promise.reject(new Error("locked"))), waitMs: 20 });
  await vi.advanceTimersByTimeAsync(5);
  stopNow();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(80);
  expect(tried).toHaveLength(1);
});
