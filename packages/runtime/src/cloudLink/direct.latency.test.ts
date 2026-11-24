// Measures the direct path against the relay on this computer (DESIGN S14): the same calls and the same chat's events,
// one device client on each path at once, against a runtime on This Mac linked to the test Cloud (its relay on
// loopback, the device allowed, device frames sealed on both paths). Run by hand: CAVEMAN_DIRECT_BENCH=1 vitest run
// src/cloudLink/direct.latency.test.ts. It prints p50/p95; the real relay adds the round trips to Caveman Cloud.
import { connect, deviceHandshake, type SessionEvent } from "@caveman-app/session-protocol";
import { connectDirect } from "@caveman-app/session-protocol/direct";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { afterEach, expect, test } from "vitest";

import { allowedStream, relayBridge, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const summary = (values: ReadonlyArray<number>) => ({ n: values.length, p50: +quantile(values, 0.5).toFixed(2), p95: +quantile(values, 0.95).toFixed(2) });

test.skipIf(process.env.CAVEMAN_DIRECT_BENCH !== "1")("relay against direct on this computer: calls, sends and events", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Bench Mac" });
  await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relay = cloud.state.relays[0]!;
  const workspace = await createReady(local, { request_id: "w0", repo: { path: makeRepo(tempRoot("bench-repo-"), { "README.md": "hi\n" }) }, title: "Bench", engine: "claude-agent", options: { model: MODEL } });
  const bridge = await relayBridge(relay);
  cleanups.push(bridge.close);
  const phone = await testDevice("Bench phone");
  await allowedStream(relay, local, phone);
  const handshake = deviceHandshake({ device: phone, kind: () => "laptop" });
  const rtc = RTCPeerConnection as never;
  const viaRelay = connectDirect(bridge.url, "", undefined, { handshake, direct: { enabled: () => false } });
  const viaDirect = connectDirect(bridge.url, "", undefined, { handshake, direct: { rtc, iceServers: [], network: () => () => undefined } });
  cleanups.push(() => viaRelay.close(), () => viaDirect.close());
  const t0 = performance.now();
  await until(() => viaDirect.path() === "direct", 20_000);
  const upgradeMs = performance.now() - t0;

  const roundTrips = async (client: typeof viaRelay, n: number) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const at = performance.now();
      await client.call("settings.get", {});
      times.push(performance.now() - at);
    }
    return times;
  };
  await roundTrips(viaRelay, 50);
  await roundTrips(viaDirect, 50);
  const callRelay = await roundTrips(viaRelay, 500);
  const callDirect = await roundTrips(viaDirect, 500);

  // Both follow the chat; every event's delay from its commit, on each path.
  const delays = { relay: [] as number[], direct: [] as number[] };
  const follow = (client: typeof viaRelay, into: number[]) =>
    client.attach(workspace.session_id, 0, (event: SessionEvent & { committed_ms?: number }) => {
      if (event.cursor > 3) into.push(Date.now() - (typeof event.committed_ms === "number" ? event.committed_ms : Date.parse(event.at)));
    });
  await follow(viaRelay, delays.relay);
  await follow(viaDirect, delays.direct);
  const sends = { relay: [] as number[], direct: [] as number[] };
  for (let i = 0; i < 40; i++) {
    const client = i % 2 === 0 ? viaRelay : viaDirect;
    const at = performance.now();
    await client.call("turn.submit", { request_id: `b${i}`, session_id: workspace.session_id, kind: "followup", input: { text: `turn ${i}` } });
    (i % 2 === 0 ? sends.relay : sends.direct).push(performance.now() - at);
    await until(async () => (await local.call("workspace.get", { workspace_id: workspace.id })).status === "idle", 30_000);
  }
  await until(() => delays.relay.length === delays.direct.length && delays.relay.length > 0, 10_000);
  const result = {
    upgrade_ms: +upgradeMs.toFixed(1),
    call: { relay: summary(callRelay), direct: summary(callDirect) },
    send_to_accepted: { relay: summary(sends.relay), direct: summary(sends.direct) },
    // From each event's `at` (the runtime's own clock; committed_ms where a runtime sends it) to this client.
    event_to_device: { relay: summary(delays.relay), direct: summary(delays.direct) },
  };
  console.log(`DIRECT-BENCH ${JSON.stringify(result)}`);
  expect(viaDirect.path()).toBe("direct");
}, 300_000);
