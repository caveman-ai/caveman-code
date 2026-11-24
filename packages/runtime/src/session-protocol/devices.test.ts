// The check a runner of Cloud-queued calls makes on This Mac (devices.ts queuedCallAllowed), and the runtime's own frame
// sealing (devices.ts frameCrypto) against the devices' WebCrypto one.
import { channelKeyBytes, channelKeys, ephemeralKey, openFrame, sealFrame, signCall, toBase64url } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { frameCrypto, queuedCallAllowed } from "./devices.ts";
import { testDevice } from "./devices.testkit.ts";

test("This Mac runs a queued call only when a device it allowed for that person signed exactly it", async () => {
  const phone = await testDevice("iPhone, Safari");
  const stranger = await testDevice("Someone else");
  const allowed = [{ device_id: phone.device_id, user_id: "user-1", public_key: phone.public_key }];
  const call = { session_id: "s1", request_id: "r1", method: "turn.submit", params: { session_id: "s1", kind: "followup", input: { text: "go" } } };
  const now = Date.now();
  const signed = await signCall(phone, call, now);
  expect(await queuedCallAllowed(allowed, "user-1", call, signed, now)).toEqual({ ok: true });
  // No device fields: a stolen Cloud session, or Cloud itself, queued it.
  expect((await queuedCallAllowed(allowed, "user-1", call, undefined, now)).ok).toBe(false);
  // Signed by a device this Mac never allowed, or allowed for another person.
  expect((await queuedCallAllowed(allowed, "user-1", call, await signCall(stranger, call, now), now)).ok).toBe(false);
  expect((await queuedCallAllowed(allowed, "user-2", call, signed, now)).ok).toBe(false);
  // The phone's signature on another call, or another request id (a replay with new params).
  expect((await queuedCallAllowed(allowed, "user-1", { ...call, params: { ...call.params, input: { text: "rm -rf /" } } }, signed, now)).ok).toBe(false);
  expect((await queuedCallAllowed(allowed, "user-1", { ...call, request_id: "r2" }, signed, now)).ok).toBe(false);
  // A day later: refused (the runtime no longer remembers the request id).
  expect((await queuedCallAllowed(allowed, "user-1", call, signed, now + 24 * 60 * 60 * 1000)).ok).toBe(false);
});

test("the runtime seals and opens frames at once with Node's AES-GCM, byte for byte as a device's WebCrypto does", async () => {
  const runtime = await ephemeralKey();
  const device = await ephemeralKey();
  const bind = { runtime_id: "rt-1", nonce: toBase64url(crypto.getRandomValues(new Uint8Array(32))), runtime_key: runtime.public_key, device_key: device.public_key };
  // The device's WebCrypto keys, and the same keys as the runtime derives them for Node.
  const keys = await channelKeys({ ...bind, privateKey: device.privateKey, peer_key: runtime.public_key });
  const mac = frameCrypto(await channelKeyBytes({ ...bind, privateKey: runtime.privateKey, peer_key: device.public_key }));
  const body = JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { text: "é and 🦴" } });
  // To the device: the same frame WebCrypto makes, and the device opens it at its place only.
  expect(mac.seal(1, body)).toBe(await sealFrame(keys.to_device, 1, body, "to_device"));
  expect(await openFrame(keys.to_device, 7, mac.seal(7, body), "to_device")).toBe(body);
  expect(await openFrame(keys.to_device, 8, mac.seal(7, body), "to_device")).toBeUndefined();
  // From the device: opened at its place, under its direction's key; moved, changed or under the other key, never.
  const fromPhone = await sealFrame(keys.to_runtime, 3, body, "to_runtime");
  expect(mac.open(3, fromPhone)).toBe(body);
  expect(mac.open(4, fromPhone)).toBeUndefined();
  expect(mac.open(3, await sealFrame(keys.to_device, 3, body, "to_device"))).toBeUndefined();
  const parsed = JSON.parse(fromPhone) as { device_frame: { seq: number; ct: string } };
  const flipped = `${parsed.device_frame.ct.slice(0, 10)}${parsed.device_frame.ct[10] === "A" ? "B" : "A"}${parsed.device_frame.ct.slice(11)}`;
  expect(mac.open(3, JSON.stringify({ device_frame: { seq: 3, ct: flipped } }))).toBeUndefined();
  expect(mac.open(3, "not a frame")).toBeUndefined();
  expect(() => mac.seal(0, body)).toThrow();
});
