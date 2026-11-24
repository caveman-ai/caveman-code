// What the phone's own WebCrypto costs (apps/mobile/src/live/webcrypto.ts, the noble libraries in JavaScript, where a
// phone's engine has no crypto.subtle): two phones on the phone's modules through the stand-in Cloud's relay to one
// runtime on This Mac, one on that adapter and one on the platform's WebCrypto, taking turns at the same work. Modelled
// on direct.latency.test.ts. Run by hand:
//   CAVEMAN_PHONE_BENCH=1 vitest run --silent=false src/cloudLink/phone.latency.test.ts
// It prints p50/p95 for connecting (the socket and the hello: a signature and a key agreement), a call, and a send
// until the runtime took it, then the bare operations with no wire. This is V8 with its compiler, on a Mac, over
// loopback: a phone's engine interprets, so the adapter's operations cost more there, and a real relay adds its round
// trips to both columns alike.
import { randomBytes } from "node:crypto";

import { connect, type Client } from "@caveman-app/session-protocol";
import {
  channelKeys,
  ephemeralKey,
  helloPayload,
  openFrame,
  sealFrame,
} from "@caveman-app/session-protocol/devices";
import { afterEach, expect, test } from "vitest";

import { phoneCloud } from "../../../../apps/mobile/src/live/cloud.ts";
import { openConnection, type Connection } from "../../../../apps/mobile/src/live/connection.ts";
import { deviceKeyOnce, loadDeviceKey } from "../../../../apps/mobile/src/live/deviceKey.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { asPhone, memorySecrets, splitCrypto } from "./phone.testkit.ts";
import { startTestCloud } from "./testCloud.ts";
import { startPhoneCloud } from "./testCloudPhone.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const summary = (values: ReadonlyArray<number>) => ({
  n: values.length,
  p50: +quantile(values, 0.5).toFixed(2),
  p95: +quantile(values, 0.95).toFixed(2),
});

/** Runs as the phone on its adapter, or as it is on the platform's WebCrypto. */
type As = <T>(run: () => T) => T;
const onPlatform: As = (run) => run();

test.skipIf(process.env.CAVEMAN_PHONE_BENCH !== "1")(
  "a phone through the relay: the adapter's crypto against the platform's",
  async () => {
    cleanups.push(splitCrypto());
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    const front = await startPhoneCloud(cloud);
    cleanups.push(front.close);
    const runtime = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(runtime.close);
    const local = connect(runtime.url, runtime.token);
    cleanups.push(() => local.close());
    await local.call("cloud.enroll", {
      request_id: "e1",
      cloud_url: cloud.url,
      token: cloud.state.personToken,
      name: "Bench Mac",
    });
    await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
    await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
    const workspace = await createReady(local, {
      request_id: "w0",
      repo: { path: makeRepo(tempRoot("phone-bench-"), { "README.md": "hi\n" }) },
      title: "Bench",
      engine: "claude-agent",
      options: { model: MODEL },
    });

    /** A phone signed in and allowed on the Mac, and a way to open one more connection of it. */
    const phone = async (as: As, name: string) => {
      const secrets = memorySecrets();
      const mine = as(() => phoneCloud({ url: front.url, secrets }));
      const device = deviceKeyOnce(() => as(() => loadDeviceKey(secrets, name)));
      const pending = await as(() => mine.signIn());
      front.approve(pending.user_code);
      await pending.done;
      const mac = (await as(() => mine.computers())).computers[0]!;
      const open = () => {
        const connection = as(() =>
          openConnection({
            computer: mac,
            cloud: mine,
            device,
            direct: { advert: () => ({ enabled: false, stun_servers: [] }) },
          }),
        );
        cleanups.push(() => connection.close());
        return connection;
      };
      const first = open();
      await until(() => first.state().phase === "waiting", 20_000);
      const deviceId = (await device()).device_id;
      const request = (await local.call("device.list", {})).requests.find(
        (r) => r.device_id === deviceId,
      )!;
      await local.call("device.allow", {
        request_id: `allow-${deviceId}`,
        device_id: deviceId,
        role: request.role ?? "device",
      });
      await until(() => first.state().phase === "open", 20_000);
      return { as, open, connection: first, device };
    };
    const adapter = await phone(asPhone, "Bench phone, adapter");
    const platform = await phone(onPlatform, "Bench phone, platform");
    const sides = { adapter, platform } as const;
    type Side = keyof typeof sides;
    const each = <T>(make: () => T): Record<Side, T> => ({ adapter: make(), platform: make() });

    // Connecting, for a phone the Mac knows: the socket through the relay, the hello this phone signs and the key both
    // agree on, until the first sealed frame is read.
    const connects = each(() => [] as number[]);
    for (let i = 0; i < 24; i++) {
      const side: Side = i % 2 === 0 ? "adapter" : "platform";
      const at = performance.now();
      const connection: Connection = sides[side].open();
      await new Promise<void>((resolve) =>
        connection.subscribe((state) => state.phase === "open" && resolve()),
      );
      if (i >= 4) connects[side].push(performance.now() - at);
      connection.close();
    }

    // A call and its answer, each sealed and opened on the phone.
    const roundTrips = async (side: Side, n: number) => {
      const { as, connection } = sides[side];
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const at = performance.now();
        await as(() => connection.client.call("settings.get", {}));
        times.push(performance.now() - at);
      }
      return times;
    };
    await roundTrips("adapter", 50);
    await roundTrips("platform", 50);
    const calls = each(() => [] as number[]);
    for (let block = 0; block < 4; block++)
      for (const side of ["adapter", "platform"] as const)
        calls[side].push(...(await roundTrips(side, 100)));

    // A message sent until the runtime took it.
    const idle = (client: Client) =>
      until(
        async () =>
          (await client.call("workspace.get", { workspace_id: workspace.id })).status === "idle",
        30_000,
      );
    const sends = each(() => [] as number[]);
    for (let i = 0; i < 40; i++) {
      const side: Side = i % 2 === 0 ? "adapter" : "platform";
      const { as, connection } = sides[side];
      const at = performance.now();
      await as(() =>
        connection.client.call("turn.submit", {
          request_id: `b${i}`,
          session_id: workspace.session_id,
          kind: "followup",
          input: { text: `say: turn ${i}` },
        }),
      );
      sends[side].push(performance.now() - at);
      await idle(local);
    }

    // The bare operations, with no wire: the hello's crypto (an ECDSA signature, an ephemeral key, ECDH and HKDF), and
    // sealing then opening one frame (AES-256-GCM) of a call's size and of a long answer's.
    const operations = async (side: Side) => {
      const { as, device } = sides[side];
      const own = await device();
      const timed = async (n: number, run: () => Promise<unknown>) => {
        const times: number[] = [];
        for (let i = 0; i < n; i++) {
          const at = performance.now();
          await as(run);
          times.push(performance.now() - at);
        }
        return summary(times);
      };
      const peer = await as(() => ephemeralKey());
      const nonce = randomBytes(32).toString("base64url");
      const agree = async () => {
        const ephemeral = await ephemeralKey();
        await own.sign(
          helloPayload({
            runtime_id: "rt",
            nonce,
            runtime_key: peer.public_key,
            device_key: ephemeral.public_key,
          }),
        );
        return channelKeys({
          privateKey: ephemeral.privateKey,
          peer_key: peer.public_key,
          runtime_id: "rt",
          nonce,
          runtime_key: peer.public_key,
          device_key: ephemeral.public_key,
        });
      };
      const keys = await as(agree);
      const frame = (bytes: number) => {
        const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(bytes) } });
        let seq = 0;
        return async () => {
          seq += 1;
          const sealed = await sealFrame(keys.to_device, seq, text, "to_device");
          if ((await openFrame(keys.to_device, seq, sealed, "to_device")) !== text)
            throw new Error("the frame did not open");
        };
      };
      await timed(20, agree);
      return {
        hello: await timed(60, agree),
        frame_1kb: await timed(300, frame(1_024)),
        frame_64kb: await timed(60, frame(65_536)),
      };
    };

    const result = {
      connect: { adapter: summary(connects.adapter), platform: summary(connects.platform) },
      call: { adapter: summary(calls.adapter), platform: summary(calls.platform) },
      send_to_accepted: { adapter: summary(sends.adapter), platform: summary(sends.platform) },
      operations: { adapter: await operations("adapter"), platform: await operations("platform") },
    };
    console.log(`PHONE-BENCH ${JSON.stringify(result)}`);
    expect(adapter.connection.state()).toEqual({ phase: "open", path: "relay" });
    expect(platform.connection.state()).toEqual({ phase: "open", path: "relay" });
  },
  600_000,
);
