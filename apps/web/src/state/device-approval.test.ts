import { expect, test } from "vitest";

import type { HandshakeLink } from "@caveman-app/session-protocol/client";

import { deviceStatusOf, installDeviceHooks, noteDeviceStatus, waitingCopy } from "./device-approval.ts";
import { deviceName, loadDeviceKey } from "./device-key.ts";
import { deviceHooks } from "./sync/device-hooks.ts";
import { memoryKv } from "./sync/kv.ts";

test("a browser names itself the way people say it", () => {
  expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone, Safari");
  expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 5)).toBe("iPad, Safari");
  expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Mac, Chrome");
  expect(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe("Android phone, Chrome");
  expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Windows PC, Edge");
  expect(deviceName("")).toBe("A device");
});

test("the device key is made once and kept: the same id after a reload, its private half never readable", async () => {
  const kv = memoryKv();
  const first = await loadDeviceKey(kv, "Mac, Chrome");
  const again = await loadDeviceKey(kv, "Mac, Chrome");
  expect(again.device_id).toBe(first.device_id);
  const stored = await kv.get<{ privateKey: CryptoKey }>("device");
  expect(stored?.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("jwk", stored!.privateKey)).rejects.toThrow();
  // Several tabs at once make one key between them.
  const shared = memoryKv();
  let held: Promise<unknown> = Promise.resolve();
  const locks = { request: <T,>(_name: string, run: () => Promise<T>) => (held = held.then(run)) as Promise<T> };
  const keys = await Promise.all([loadDeviceKey(shared, "a", locks), loadDeviceKey(shared, "b", locks), loadDeviceKey(shared, "c", locks)]);
  expect(new Set(keys.map((k) => k.device_id)).size).toBe(1);
});

test("the waiting line names the Mac, the device and the code; nothing once approved", () => {
  expect(waitingCopy({ status: "pending", runtime_name: "Julius's MacBook", code: "4F2-9KM" }, "iPhone, Safari")).toEqual({
    title: "Waiting for Julius's MacBook to allow this phone",
    detail: "On Julius's MacBook, choose Allow when it asks, and check it shows 4F2-9KM. You only do this once.",
  });
  expect(waitingCopy({ status: "refused", runtime_name: "Studio", code: "" }, "Mac, Chrome")?.title).toBe("Studio did not allow this browser");
  expect(waitingCopy({ status: "approved", runtime_name: "Studio", code: "" }, "Mac, Chrome")).toBeNull();
  expect(waitingCopy(undefined, "Mac, Chrome")).toBeNull();
});

test("the hooks give each runtime one handshake; a Cloud computer's never waits, and statuses are kept per runtime", async () => {
  installDeviceHooks({ kindOf: (id) => (id === "rt-cloud" ? "cloud" : id === "rt-mac" ? "laptop" : undefined) });
  const handshake = deviceHooks().handshake!;
  expect(handshake("rt-mac")).toBe(handshake("rt-mac"));
  const asked: Array<string> = [];
  const link: HandshakeLink = {
    call: async () => {
      throw new Error("no call expected");
    },
    next: async (method) => {
      asked.push(method);
      throw new Error("none");
    },
  };
  const started = Date.now();
  await expect(handshake("rt-cloud")!(link)).resolves.toBeUndefined();
  expect(asked).toEqual([]);
  expect(Date.now() - started).toBeLessThan(100);
  // A laptop that never challenges (an older runtime) is spoken to as before.
  await expect(handshake("rt-mac")!(link)).resolves.toBeUndefined();
  expect(asked).toEqual(["device.challenge"]);

  noteDeviceStatus("rt-mac", { status: "pending", runtime_name: "Studio", code: "ABC-DEF" });
  expect(deviceStatusOf("rt-mac")?.status).toBe("pending");
  expect(deviceStatusOf("rt-other")).toBeUndefined();
});

test("the sync hub hears which Macs still have to allow this device, in the waiting line's words, and when that changes (K4)", () => {
  installDeviceHooks({ kindOf: () => "laptop" });
  const hooks = deviceHooks();
  let changes = 0;
  const off = hooks.onApproval!(() => changes++);
  noteDeviceStatus("rt-k4", { status: "pending", runtime_name: "MacBook Pro", code: "482913" });
  expect(hooks.approval!("rt-k4")).toMatchObject({ state: "pending", title: expect.stringMatching(/^Waiting for MacBook Pro to allow this /), detail: expect.stringContaining("482913") });
  noteDeviceStatus("rt-k4", { status: "approved", runtime_name: "MacBook Pro", code: "482913" });
  expect(hooks.approval!("rt-k4")).toBeNull();
  noteDeviceStatus("rt-k4", { status: "refused", runtime_name: "MacBook Pro", code: "" });
  expect(hooks.approval!("rt-k4")?.state).toBe("refused");
  expect(hooks.approval!("rt-never-asked")).toBeNull();
  expect(changes).toBe(3);
  off();
});

test("the desktop shell's key is a Mac's, and a browser's own key is not", async () => {
  const { desktopDeviceKey } = await import("./device-key.ts");
  const { newDeviceKeyPair } = await import("@caveman-app/session-protocol/devices");
  const pair = await newDeviceKeyPair();
  const desktop = await desktopDeviceKey({ describe: async () => ({ name: "Studio", public_key: pair.public_key }), sign: async () => new Uint8Array(64) });
  expect(desktop.kind).toBe("mac");
  expect((await loadDeviceKey(memoryKv(), "Mac, Chrome")).kind).toBeUndefined();
});

test("Join your other Mac proves the typed code in its own connection's first hello, follows that Mac's answer, and closes (decision 31)", async () => {
  const { joinMac } = await import("./device-approval.ts");
  const { channelKeys, deviceCode, ephemeralKey, helloPayload, newDeviceKeyPair, pairAnswer, pairingCode, sealFrame, toBase64url, verifyPairProof, webCryptoDeviceKey } = await import(
    "@caveman-app/session-protocol/devices"
  );
  const { SessionProtocolError } = await import("@caveman-app/session-protocol/client");
  const studio = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Studio", kind: "mac" });
  const runtime = await ephemeralKey();
  const challenge = { nonce: toBase64url(new Uint8Array(32).fill(5)), runtime_id: "rt-a", key: runtime.public_key, runtime_name: "Mac A", hello: 2 };
  const code = pairingCode();
  const payloadOf = (hello: Record<string, unknown>) =>
    helloPayload({ runtime_id: "rt-a", nonce: challenge.nonce, runtime_key: runtime.public_key, device_key: hello.key as string, v2: { kind: "mac", name: "Studio" } });
  /** Mac A's first sealed frame on the connection: its answer, proved under `under` (the code its screen showed). */
  const sealedAnswer = async (hello: Record<string, unknown>, under: string, params: Record<string, unknown> = {}) => {
    const keys = await channelKeys({ privateKey: runtime.privateKey, peer_key: hello.key as string, runtime_id: "rt-a", nonce: challenge.nonce, runtime_key: runtime.public_key, device_key: hello.key as string });
    const proof = await pairAnswer(under, studio.device_id, payloadOf(hello));
    return sealFrame(keys.to_device, 1, JSON.stringify({ jsonrpc: "2.0", method: "device.status", params: { status: "approved", runtime_name: "Mac A", code: "X", role: "mac", proof, ...params } }), "to_device");
  };
  /**
   * A connection of its own whose runtime answers the hello with `answer`, then says `then` (plain), then seals
   * `sealed` (each made for the hello it got): the client reads sealed frames through the handshake's `open`.
   */
  const opener = (answer: (params: Record<string, unknown>) => unknown, then: Array<unknown>, sealed: (hello: Record<string, unknown>) => Promise<Array<string>> = async () => []) => {
    const said: Array<Record<string, unknown>> = [];
    let closed = 0;
    const open = (handshake: (link: HandshakeLink) => Promise<{ open?: (frame: string) => Promise<string | undefined> } | void>) => {
      const statuses = [...then];
      void handshake({
        next: async (method) => (method === "device.challenge" ? challenge : statuses.shift()),
        call: async (_method, params) => (said.push(params as Record<string, unknown>), answer(params as Record<string, unknown>)),
      })
        .then(async (done) => {
          for (const frame of await sealed(said[0]!)) await done?.open?.(frame);
        })
        .catch(() => undefined);
      return { close: () => void closed++ };
    };
    return { open, said, closed: () => closed };
  };
  const statuses: Array<string> = [];
  const codes: Array<string> = [];
  const roles: Array<string | undefined> = [];
  // The answer carries a code the relay could have put there (a key it swapped in): the Join line shows this Mac's own.
  // Taken only once Mac A's first sealed frame says so under the code.
  const ok = opener(() => ({ status: "pending", code: "4F2-9KM" }), [{ status: "approved", runtime_name: "Mac A", code: "4F2-9KM" }], async (hello) => [await sealedAnswer(hello, code)]);
  await joinMac(ok.open, code, { device: async () => studio, onStatus: (s) => (statuses.push(s.status), codes.push(s.code), roles.push(s.role)) });
  expect(statuses).toEqual(["pending", "approved", "approved"]);
  expect(roles).toEqual([undefined, undefined, "mac"]);
  expect(codes).toEqual([deviceCode(studio.device_id), deviceCode(studio.device_id), deviceCode(studio.device_id)]);
  const hello = ok.said[0]!;
  expect(await verifyPairProof(code, studio.device_id, payloadOf(hello), hello.pair as string)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(ok.closed()).toBe(1);
  // m-h: a plain "approved" (the relay can make one up), even one naming the role, is not an answer, nor is a sealed
  // one proved under another code (a relay playing Mac A): Join never says Mac A took this Mac, and gives up.
  for (const forged of [
    opener(() => ({ status: "approved", code: "X" }), [], async () => []),
    opener(() => ({ status: "pending", code: "X" }), [{ status: "approved", runtime_name: "Mac A", code: "X", role: "mac", proof: "AAAA" }], async () => []),
    opener(() => ({ status: "pending", code: "X" }), [{ status: "approved", runtime_name: "Mac A", code: "X" }], async (h) => [await sealedAnswer(h, pairingCode())]),
    opener(() => ({ status: "pending", code: "X" }), [{ status: "approved", runtime_name: "Mac A", code: "X" }], async (h) => [await sealedAnswer(h, code, { role: "device" })]),
  ]) {
    const heard: Array<string | undefined> = [];
    await expect(joinMac(forged.open, code, { device: async () => studio, answerMs: 300, onStatus: (s) => heard.push(s.role) })).rejects.toThrow(/never said it took it as one of your Macs/);
    expect(heard).not.toContain("mac");
  }
  // That Mac refuses the code (wrong, used or old): the refusal, in its words, and the connection closes.
  const no = opener(() => {
    throw new SessionProtocolError({ code: -32602, message: "That code did not join Mac A: it was wrong, used, or more than 10 minutes old.", data: { reason: "invalid_params" } });
  }, []);
  await expect(joinMac(no.open, code, { device: async () => studio })).rejects.toThrow(/did not join Mac A/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(no.closed()).toBe(1);
  // Not reachable from here, or not a code: nothing goes.
  await expect(joinMac(() => null, code, { device: async () => studio })).rejects.toThrow(/cannot reach that Mac/);
  const typo = opener(() => ({ status: "approved", code: "X" }), []);
  await expect(joinMac(typo.open, "ABCD-EFGH", { device: async () => studio })).rejects.toThrow(/12 letters and digits/);
  expect(typo.said).toEqual([]);
});
