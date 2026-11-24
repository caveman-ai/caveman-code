import { expect, test } from "vitest";

import {
  channelKeyBytes,
  channelKeys,
  fromBase64url,
  cleanDeviceName,
  DEVICE_CALL_MAX_AGE_MS,
  deviceCode,
  deviceIdOf,
  ephemeralKey,
  helloPayload,
  newDeviceKeyPair,
  normalizePairingCode,
  PAIRING_CODE_TTL_MS,
  pairingCode,
  pairProof,
  verifyPairProof,
  openFrame,
  publicKeyOf,
  remoteControlOn,
  sealFrame,
  signCall,
  signMove,
  signStatement,
  signStop,
  stopCall,
  statementId,
  statementPayload,
  toBase64url,
  verifyCall,
  verifyMove,
  verifyDeviceSignature,
  verifyStatement,
  webCryptoDeviceKey,
} from "../src/devices.ts";

test("a device's id is its key's RFC 7638 thumbprint, and its code is short and stable", async () => {
  // RFC 7638 3.1's canonical members, over an EC key: fixed by the key, not by how the JWK was written.
  const pair = await newDeviceKeyPair();
  const id = await deviceIdOf(pair.public_key);
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await deviceIdOf({ y: pair.public_key.y, x: pair.public_key.x, crv: "P-256", kty: "EC" } as never)).toBe(id);
  expect(deviceCode(id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{3}){3}$/);
  expect(deviceCode(id)).toBe(deviceCode(id));
  const other = await deviceIdOf((await newDeviceKeyPair()).public_key);
  expect(other).not.toBe(id);
});

test("a device's code is 60 bits of its id, each one counted: a key ground to show the same code is one in 2^60 (F-1)", () => {
  const idOf = (bytes: Uint8Array) => toBase64url(bytes);
  const zero = new Uint8Array(32);
  expect(deviceCode(idOf(zero))).toBe("000-000-000-000");
  // Every one of the first 60 bits changes the code; none after them does (the code names the id's first 60 bits).
  const codes = new Set([deviceCode(idOf(zero))]);
  for (let bit = 0; bit < 64; bit++) {
    const bytes = new Uint8Array(32);
    bytes[bit >> 3] = 0x80 >> (bit & 7);
    const code = deviceCode(idOf(bytes));
    if (bit < 60) codes.add(code);
    else expect(code).toBe("000-000-000-000");
  }
  expect(codes.size).toBe(61);
  const ones = new Uint8Array(32).fill(0xff);
  expect(deviceCode(idOf(ones))).toBe("ZZZ-ZZZ-ZZZ-ZZZ");
  // It never reads as a pairing code, which is typed (XXXX-XXXX-XXXX): grouped in threes.
  expect(deviceCode(idOf(ones))).not.toMatch(/^.{4}-/);
});

test("only a P-256 public key passes, and the private half cannot be exported", async () => {
  const pair = await newDeviceKeyPair();
  expect(publicKeyOf({ ...pair.public_key, d: "secret" })).toEqual(pair.public_key);
  expect(publicKeyOf({ ...pair.public_key, crv: "P-384" })).toBeUndefined();
  expect(publicKeyOf({ ...pair.public_key, x: "short" })).toBeUndefined();
  expect(publicKeyOf(null)).toBeUndefined();
  await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();
});

test("a hello signature holds only for its runtime, nonce and keys", async () => {
  const device = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const input = { runtime_id: "rt-1", nonce: toBase64url(crypto.getRandomValues(new Uint8Array(32))), runtime_key: "R", device_key: "D" };
  const signature = toBase64url(await device.sign(helloPayload(input)));
  expect(await verifyDeviceSignature(device.public_key, helloPayload(input), signature)).toBe(true);
  for (const changed of [{ runtime_id: "rt-2" }, { nonce: "AAAA" }, { runtime_key: "R2" }, { device_key: "D2" }]) {
    expect(await verifyDeviceSignature(device.public_key, helloPayload({ ...input, ...changed }), signature)).toBe(false);
  }
  const stranger = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "x" });
  expect(await verifyDeviceSignature(stranger.public_key, helloPayload(input), signature)).toBe(false);
  expect(await verifyDeviceSignature(device.public_key, helloPayload(input), "not-a-signature")).toBe(false);
});

test("both sides derive the same two keys; a frame opens only one way, at its sequence number, unchanged, and is unreadable", async () => {
  const runtime = await ephemeralKey();
  const device = await ephemeralKey();
  const bind = { runtime_id: "rt-1", nonce: toBase64url(crypto.getRandomValues(new Uint8Array(32))), runtime_key: runtime.public_key, device_key: device.public_key };
  const deviceSide = await channelKeys({ ...bind, privateKey: device.privateKey, peer_key: runtime.public_key });
  const runtimeSide = await channelKeys({ ...bind, privateKey: runtime.privateKey, peer_key: device.public_key });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn.submit", params: { input: { text: "the secret plan" } } });
  const sealed = await sealFrame(deviceSide.to_runtime, 1, body, "to_runtime");
  expect(sealed).not.toContain("secret");
  expect(sealed).not.toContain("turn.submit");
  expect(await openFrame(runtimeSide.to_runtime, 1, sealed, "to_runtime")).toBe(body);
  // Another place in the sequence, the other direction's key, or the other direction's label: nothing.
  expect(await openFrame(runtimeSide.to_runtime, 2, sealed, "to_runtime")).toBeUndefined();
  expect(await openFrame(runtimeSide.to_device, 1, sealed, "to_device")).toBeUndefined();
  expect(await openFrame(runtimeSide.to_runtime, 1, sealed, "to_device")).toBeUndefined();
  // The Mac's reply opens on the device and nowhere else.
  const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "file contents" } });
  const back = await sealFrame(runtimeSide.to_device, 1, reply, "to_device");
  expect(back).not.toContain("file contents");
  expect(await openFrame(deviceSide.to_device, 1, back, "to_device")).toBe(reply);
  // One changed bit, a changed sequence number, a plain frame: nothing.
  const parsed = JSON.parse(back) as { device_frame: { seq: number; ct: string } };
  const ct = fromBase64url(parsed.device_frame.ct);
  ct[3] = ct[3]! ^ 1;
  expect(await openFrame(deviceSide.to_device, 1, JSON.stringify({ device_frame: { seq: 1, ct: toBase64url(ct) } }), "to_device")).toBeUndefined();
  expect(await openFrame(deviceSide.to_device, 2, JSON.stringify({ device_frame: { ...parsed.device_frame, seq: 2 } }), "to_device")).toBeUndefined();
  expect(await openFrame(deviceSide.to_device, 1, reply, "to_device")).toBeUndefined();
  // Keys bound to another nonce (another connection) open nothing.
  const elsewhere = await channelKeys({ ...bind, nonce: toBase64url(new Uint8Array(32)), privateKey: runtime.privateKey, peer_key: device.public_key });
  expect(await openFrame(elsewhere.to_runtime, 1, sealed, "to_runtime")).toBeUndefined();
  await expect(channelKeys({ ...bind, privateKey: runtime.privateKey, peer_key: "AAAA" })).rejects.toThrow();
  await expect(sealFrame(deviceSide.to_runtime, 0, body, "to_runtime")).rejects.toThrow();
});

test("the runtime's frame key bytes are the very keys both sides derive, each way", async () => {
  const runtime = await ephemeralKey();
  const device = await ephemeralKey();
  const bind = { runtime_id: "rt-1", nonce: toBase64url(crypto.getRandomValues(new Uint8Array(32))), runtime_key: runtime.public_key, device_key: device.public_key };
  const deviceSide = await channelKeys({ ...bind, privateKey: device.privateKey, peer_key: runtime.public_key });
  const bytes = await channelKeyBytes({ ...bind, privateKey: runtime.privateKey, peer_key: device.public_key });
  expect([bytes.to_runtime.length, bytes.to_device.length]).toEqual([32, 32]);
  expect(toBase64url(bytes.to_runtime)).not.toBe(toBase64url(bytes.to_device));
  const imported = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn.submit" });
  expect(await openFrame(deviceSide.to_device, 1, await sealFrame(await imported(bytes.to_device), 1, body, "to_device"), "to_device")).toBe(body);
  expect(await openFrame(await imported(bytes.to_runtime), 1, await sealFrame(deviceSide.to_runtime, 1, body, "to_runtime"), "to_runtime")).toBe(body);
  await expect(channelKeyBytes({ ...bind, privateKey: runtime.privateKey, peer_key: "AAAA" })).rejects.toThrow();
});

test("a move request's signature holds for exactly that move", async () => {
  const device = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const move = { session_id: "s1", request_id: "m1", to: "cloud" };
  const now = Date.now();
  const signed = await signMove(device, move, now);
  expect(await verifyMove(device.public_key, { ...move, at: signed.at }, signed.signature, now)).toBe(true);
  expect(await verifyMove(device.public_key, { ...move, to: { computer_id: "c-attacker" }, at: signed.at }, signed.signature, now)).toBe(false);
  expect(await verifyMove(device.public_key, { ...move, session_id: "s2", at: signed.at }, signed.signature, now)).toBe(false);
  // Not a queued call's signature either, and not reusable as one.
  expect(await verifyCall(device.public_key, { session_id: "s1", request_id: "m1", method: "turn.submit", params: { to: "cloud" }, at: signed.at }, signed.signature, now)).toBe(false);
});

test("device names lose control characters and length", () => {
  expect(cleanDeviceName("iPhone,\u0000 Safari\n")).toBe("iPhone, Safari");
  expect(cleanDeviceName(" ")).toBe("A device");
  expect(cleanDeviceName(42)).toBe("A device");
  expect([...cleanDeviceName("x".repeat(500))]).toHaveLength(80);
  // Cut where its 80th character is a space: no space at the end, and cleaning it again changes nothing (a statement
  // signs the cleaned name, which must be the name the device asked with).
  const cut = cleanDeviceName(`Caveman Code on ${"x".repeat(63)} Studio`);
  expect(cut).toBe(`Caveman Code on ${"x".repeat(63)}`);
  expect(cleanDeviceName(cut)).toBe(cut);
});

test("Remote control follows sync unless the person set it", () => {
  expect(remoteControlOn(undefined)).toBe(false);
  expect(remoteControlOn({})).toBe(false);
  expect(remoteControlOn({ sync_chats: true })).toBe(true);
  expect(remoteControlOn({ sync_chats: false })).toBe(false);
  expect(remoteControlOn({ sync_chats: true, remote_control: false })).toBe(false);
  expect(remoteControlOn({ remote_control: true })).toBe(true);
});

test("a queued call's signature holds for exactly that call, within its window", async () => {
  const device = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const call = { session_id: "s1", request_id: "r1", method: "turn.submit", params: { session_id: "s1", input: { text: "hi" }, kind: "followup" } };
  const now = Date.parse("2026-10-21T20:00:00Z");
  const signed = await signCall(device, call, now);
  expect(signed.device_id).toBe(device.device_id);
  const at = signed.at;
  expect(await verifyCall(device.public_key, { ...call, at }, signed.signature, now + 1_000)).toBe(true);
  // Key order in params does not matter; any change does.
  expect(await verifyCall(device.public_key, { ...call, params: { kind: "followup", input: { text: "hi" }, session_id: "s1" }, at }, signed.signature, now)).toBe(true);
  for (const changed of [{ session_id: "s2" }, { request_id: "r2" }, { method: "ask.respond" }, { params: { ...call.params, input: { text: "rm -rf" } } }]) {
    expect(await verifyCall(device.public_key, { ...call, ...changed, at }, signed.signature, now)).toBe(false);
  }
  // Too old (Cloud keeps queued calls a day; the runtime's receipts too), or from the future.
  expect(await verifyCall(device.public_key, { ...call, at }, signed.signature, now + DEVICE_CALL_MAX_AGE_MS + 1)).toBe(false);
  expect(await verifyCall(device.public_key, { ...call, at }, signed.signature, now - 10 * 60_000)).toBe(false);
  expect(await verifyCall(device.public_key, { ...call, at: "not a date" }, signed.signature, now)).toBe(false);
});

// ------------------------------------------------------------------ approvals across a person's Macs (devices-2026-10-31)

const macKey = async (name: string) => webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name, kind: "mac" });

test("a v2 hello signs kind and name: the relay can change neither, and v1 signs neither (T11)", async () => {
  const studio = await macKey("Caveman Code on Studio");
  const fields = { runtime_id: "rt-1", nonce: toBase64url(new Uint8Array(32)), runtime_key: "rk", device_key: "dk" };
  const v2 = helloPayload({ ...fields, v2: { kind: "mac", name: studio.name } });
  const signature = toBase64url(await studio.sign(v2));
  expect(new TextDecoder().decode(v2).split("\n")).toEqual(["caveman-device-v2", "rt-1", fields.nonce, "rk", "dk", "mac", "Caveman Code on Studio"]);
  expect(await verifyDeviceSignature(studio.public_key, v2, signature)).toBe(true);
  // The kind flipped, the name changed, or the hello read as v1: none verifies.
  expect(await verifyDeviceSignature(studio.public_key, helloPayload({ ...fields, v2: { kind: "device", name: studio.name } }), signature)).toBe(false);
  expect(await verifyDeviceSignature(studio.public_key, helloPayload({ ...fields, v2: { kind: "mac", name: "Mallory's Mac" } }), signature)).toBe(false);
  expect(await verifyDeviceSignature(studio.public_key, helloPayload(fields), signature)).toBe(false);
  // The name is signed as a Mac shows it: control characters gone, cut to 80.
  expect(helloPayload({ ...fields, v2: { kind: "mac", name: "a\nb" } })).toEqual(helloPayload({ ...fields, v2: { kind: "mac", name: "a b" } }));
});

test("the device answers v2 only when the challenge offers it, with its own kind (a phone says device)", async () => {
  const { deviceHandshake } = await import("../src/deviceClient.ts");
  const studio = await macKey("Studio");
  const phone = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const runtime = await ephemeralKey();
  const hello = async (device: typeof studio, offer: number | undefined) => {
    const challenge = { nonce: toBase64url(new Uint8Array(32).fill(7)), runtime_id: "rt-2", key: runtime.public_key, runtime_name: "Mac B", ...(offer ? { hello: offer } : {}) };
    let said: Record<string, unknown> = {};
    await deviceHandshake({ device, kind: () => "laptop" })({
      next: async (method) => (method === "device.challenge" ? challenge : { status: "approved" }),
      call: async (_method, params) => ((said = params as Record<string, unknown>), { status: "approved", code: "X" }),
    });
    const fields = { runtime_id: "rt-2", nonce: challenge.nonce, runtime_key: runtime.public_key, device_key: said.key as string };
    return { said, fields };
  };
  const v2 = await hello(studio, 2);
  expect(v2.said.kind).toBe("mac");
  expect(await verifyDeviceSignature(studio.public_key, helloPayload({ ...v2.fields, v2: { kind: "mac", name: "Studio" } }), v2.said.signature as string)).toBe(true);
  const v1 = await hello(studio, undefined);
  expect(v1.said.kind).toBeUndefined();
  expect(await verifyDeviceSignature(studio.public_key, helloPayload(v1.fields), v1.said.signature as string)).toBe(true);
  const fromPhone = await hello(phone, 2);
  expect(fromPhone.said.kind).toBe("device");
  expect(await verifyDeviceSignature(phone.public_key, helloPayload({ ...fromPhone.fields, v2: { kind: "device", name: "iPhone, Safari" } }), fromPhone.said.signature as string)).toBe(true);
});

test("a pairing code is 12 Crockford base32 characters, 60 bits, read back however the person types it (decision 31, T22)", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = pairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    codes.add(code);
  }
  // 60 random bits: 200 codes never repeat.
  expect(codes.size).toBe(200);
  expect(PAIRING_CODE_TTL_MS).toBe(10 * 60 * 1000);
  // Lower case, spaces or none, and the letters people mistake for digits (O for 0, I and L for 1) read the same.
  expect(normalizePairingCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
  expect(normalizePairingCode(" ab cd ef gh jk mn ")).toBe("ABCDEFGHJKMN");
  expect(normalizePairingCode("O0Il-1111-2222")).toBe("001111112222");
  // Not one: too short, too long, or a letter Crockford leaves out (U).
  for (const bad of ["ABCD-EFGH-JKM", "ABCD-EFGH-JKMNP", "ABCD-EFGH-JKMU", "", "ABCD/EFGH/JKMN"]) expect(normalizePairingCode(bad)).toBeUndefined();
});

test("a pairing proof holds only for that code, over that very hello, for the key that signed it (decision 31, T22)", async () => {
  const studio = await macKey("Studio");
  const fields = { runtime_id: "rt-1", nonce: toBase64url(new Uint8Array(32).fill(3)), runtime_key: "rk", device_key: "dk" };
  const hello = helloPayload({ ...fields, v2: { kind: "mac", name: studio.name } });
  const code = pairingCode();
  const proof = await pairProof(code, studio.device_id, hello);
  expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await verifyPairProof(code, studio.device_id, hello, proof)).toBe(true);
  // Typed in lower case, without its dashes: the same code.
  expect(await verifyPairProof(code.toLowerCase().replace(/-/g, ""), studio.device_id, hello, proof)).toBe(true);
  // Another code, another hello (another connection's nonce, another kind or name), or a proof changed: none holds.
  expect(await verifyPairProof(pairingCode(), studio.device_id, hello, proof)).toBe(false);
  expect(await verifyPairProof(code, studio.device_id, helloPayload({ ...fields, nonce: toBase64url(new Uint8Array(32).fill(4)), v2: { kind: "mac", name: studio.name } }), proof)).toBe(false);
  expect(await verifyPairProof(code, studio.device_id, helloPayload({ ...fields, v2: { kind: "mac", name: "Mallory's Mac" } }), proof)).toBe(false);
  // The same hello bytes signed again by another key (a relay that held the joining Mac's hello back and sent it as its
  // own, with the joining Mac's proof): the proof names the key it was made for, so it holds for no other (A-1).
  const relay = await macKey("Studio");
  expect(await verifyDeviceSignature(relay.public_key, hello, toBase64url(await relay.sign(hello)))).toBe(true);
  expect(await verifyPairProof(code, relay.device_id, hello, proof)).toBe(false);
  // Changed in its first character: the last one of 43 carries 2 unused bits, so changing it can leave the bytes as they
  // were (1 in 16 proofs), and the proof would rightly hold.
  expect(await verifyPairProof(code, studio.device_id, hello, `${proof.startsWith("A") ? "B" : "A"}${proof.slice(1)}`)).toBe(false);
  for (const bad of ["", "not base64!", toBase64url(new Uint8Array(16))]) expect(await verifyPairProof(code, studio.device_id, hello, bad)).toBe(false);
  // Not a code at all, or not a key's id: never a proof.
  expect(await verifyPairProof("ABCD", studio.device_id, hello, proof)).toBe(false);
  await expect(pairProof("ABCD", studio.device_id, hello)).rejects.toThrow(/pairing code/);
  await expect(pairProof(code, "not\nan id", hello)).rejects.toThrow(/device id/);
});

test("joining another Mac proves the typed code in the first v2 hello only, once; never from a phone or to an older Mac (decision 31)", async () => {
  const { deviceHandshake } = await import("../src/deviceClient.ts");
  const studio = await macKey("Studio");
  const phone = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const runtime = await ephemeralKey();
  const code = pairingCode();
  const challenge = (offer?: number) => ({ nonce: toBase64url(new Uint8Array(32).fill(9)), runtime_id: "rt-3", key: runtime.public_key, runtime_name: "Mac A", ...(offer ? { hello: offer } : {}) });
  const said: Array<Record<string, unknown>> = [];
  const handshake = deviceHandshake({ device: studio, kind: () => "laptop", pairing: code });
  const link = (offer?: number) => ({
    next: async (method: string) => (method === "device.challenge" ? challenge(offer) : { status: "approved" }),
    call: async (_method: string, params: unknown) => (said.push(params as Record<string, unknown>), { status: "approved", code: "X" }),
  });
  await handshake(link(2));
  const fields = { runtime_id: "rt-3", nonce: challenge(2).nonce, runtime_key: runtime.public_key, device_key: said[0]!.key as string };
  expect(await verifyPairProof(code, studio.device_id, helloPayload({ ...fields, v2: { kind: "mac", name: "Studio" } }), said[0]!.pair as string)).toBe(true);
  // The next socket's hello carries no proof: the code had its one try.
  await handshake(link(2));
  expect(said[1]).not.toHaveProperty("pair");
  // A phone never pairs, nor does anything to a Mac that offers no v2 hello (its signature would not cover the kind).
  await expect(deviceHandshake({ device: phone, kind: () => "laptop", pairing: code })(link(2))).rejects.toThrow(/Mac's own Caveman Code app/);
  await expect(deviceHandshake({ device: studio, kind: () => "laptop", pairing: code })(link(undefined))).rejects.toThrow(/older Caveman Code/);
  await expect(deviceHandshake({ device: studio, kind: () => "laptop", pairing: "ABCD" })(link(2))).rejects.toThrow(/12 letters and digits/);
  expect(said).toHaveLength(2);
});

test("the code a device shows is its own key's, never one the Mac's answer or a status carries (A-1)", async () => {
  const { deviceHandshake } = await import("../src/deviceClient.ts");
  const studio = await macKey("Studio");
  const runtime = await ephemeralKey();
  const challenge = { nonce: toBase64url(new Uint8Array(32).fill(7)), runtime_id: "rt-4", key: runtime.public_key, runtime_name: "Mac A", hello: 2 };
  const shown: Array<string> = [];
  // A relay that swapped the hello for its own key answers with that key's code, then says it again in a status.
  const statuses = [{ status: "pending", runtime_name: "Mac A", code: "XXX-XXX" }, { status: "approved", runtime_name: "Mac A", code: "XXX-XXX" }];
  await deviceHandshake({ device: studio, kind: () => "laptop", onStatus: (s) => shown.push(s.code) })({
    next: async (method: string) => (method === "device.challenge" ? challenge : statuses.shift()),
    call: async () => ({ status: "pending", code: "XXX-XXX" }),
  });
  expect(shown).toEqual([deviceCode(studio.device_id), deviceCode(studio.device_id), deviceCode(studio.device_id)]);
});

test("an agents statement vouches for a Mac's agents key: it verifies only as signed, with its key and the Mac's name and no role (T16)", async () => {
  const studio = await macKey("Studio");
  const agents = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "agents" });
  const body = { kind: "agents", organization_id: "org-1", user_id: "user-1", device_id: agents.device_id, public_key: agents.public_key, name: "Studio" } as const;
  const signed = await signStatement(studio, body, Date.parse("2026-11-01T12:00:00Z"));
  expect(signed).toMatchObject({ ...body, signer: { device_id: studio.device_id } });
  expect(signed).not.toHaveProperty("role");
  expect(await verifyStatement(signed)).toEqual(signed);
  // The same line layout as an allow's, with no role.
  const { signature: _signature, ...unsigned } = signed;
  expect(new TextDecoder().decode(statementPayload(unsigned)).split("\n").slice(0, 9)).toEqual([
    "caveman-device-statement-v1",
    "agents",
    "org-1",
    "user-1",
    agents.device_id,
    agents.public_key.x,
    agents.public_key.y,
    "",
    "Studio",
  ]);
  // Extra fields Cloud adds are not kept; a role, another key, a name it did not sign or a key that is not its id's: refused.
  expect(await verifyStatement({ ...signed, trusted: true })).toEqual(signed);
  const other = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Mallory" });
  for (const changed of [{ role: "mac" }, { role: "device" }, { public_key: other.public_key }, { device_id: other.device_id }, { name: "Mallory" }, { kind: "allow" }, { kind: "remove" }, { public_key: undefined }])
    expect([changed, await verifyStatement({ ...signed, ...changed })]).toEqual([changed, undefined]);
  // A Mac that knows only allow and remove reads an agents statement as nothing (it fails safe).
  const older = { ...signed, kind: "agents" as string };
  expect(["allow", "remove"]).not.toContain(older.kind);
});

test("a statement's bytes and id are stable, and it verifies only as signed (T2, T12)", async () => {
  const studio = await macKey("Studio");
  const phone = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const body = { kind: "allow", organization_id: "org-1", user_id: "user-1", device_id: phone.device_id, public_key: phone.public_key, name: phone.name, role: "device" } as const;
  const signed = await signStatement(studio, body, Date.parse("2026-10-31T12:00:00Z"));
  expect(signed).toMatchObject({ ...body, signer: { device_id: studio.device_id, public_key: studio.public_key }, at: "2026-10-31T12:00:00.000Z" });
  expect(await verifyStatement(signed)).toEqual(signed);
  // The bytes: one field per line, in a fixed order, so every Mac makes the same id from the fields it reads.
  const { signature: _signature, ...unsigned } = signed;
  expect(new TextDecoder().decode(statementPayload(unsigned)).split("\n")).toEqual([
    "caveman-device-statement-v1",
    "allow",
    "org-1",
    "user-1",
    phone.device_id,
    phone.public_key.x,
    phone.public_key.y,
    "device",
    "iPhone, Safari",
    studio.device_id,
    studio.public_key.x,
    studio.public_key.y,
    "2026-10-31T12:00:00.000Z",
    signed.nonce,
  ]);
  const id = await statementId(signed);
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await statementId({ ...signed })).toBe(id);
  // Two statements of the same allow are two (each has its own nonce).
  expect(await statementId(await signStatement(studio, body))).not.toBe(id);
  // Extra fields Cloud adds are not kept.
  expect(await verifyStatement({ ...signed, trusted: true })).toEqual(signed);
  const other = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Mallory" });
  // Every field changed refuses it (T2).
  for (const changed of [
    { kind: "remove", public_key: undefined, name: undefined, role: undefined },
    { organization_id: "org-2" },
    { user_id: "user-2" },
    { device_id: other.device_id, public_key: other.public_key },
    { name: "Mallory's phone" },
    { role: "mac" },
    { at: "2026-10-31T12:00:01.000Z" },
    { nonce: toBase64url(new Uint8Array(16)) },
    { signer: { device_id: other.device_id, public_key: other.public_key } },
  ])
    expect([changed, await verifyStatement({ ...signed, ...changed })]).toEqual([changed, undefined]);
  // A signer id or a target id that is not its key's thumbprint; a name a Mac would not show; no or a bad signature.
  expect(await verifyStatement({ ...signed, signer: { ...signed.signer, device_id: other.device_id } })).toBeUndefined();
  expect(await verifyStatement({ ...signed, device_id: other.device_id })).toBeUndefined();
  const dirty = await signStatement(studio, body);
  expect(await verifyStatement({ ...dirty, name: "iPhone,\u0007Safari" })).toBeUndefined();
  expect(await verifyStatement({ ...signed, signature: "not base64url!" })).toBeUndefined();
  expect(await verifyStatement({ ...signed, signature: toBase64url(new Uint8Array(64)) })).toBeUndefined();
  const { signature: _gone, ...unsignedCopy } = signed;
  expect(await verifyStatement(unsignedCopy)).toBeUndefined();
  // A removal carries no key, name or role; one that does is refused.
  const removal = await signStatement(studio, { kind: "remove", organization_id: "org-1", user_id: "user-1", device_id: phone.device_id });
  expect(await verifyStatement(removal)).toEqual(removal);
  expect(removal).not.toHaveProperty("public_key");
  expect(await verifyStatement({ ...removal, role: "device" })).toBeUndefined();
  // Too big is refused, never cut (T12); garbage too.
  expect(await verifyStatement({ ...signed, padding: "x".repeat(4096) })).toBeUndefined();
  for (const garbage of [null, "statement", 42, [], {}, { kind: "allow" }]) expect(await verifyStatement(garbage)).toBeUndefined();
});

test("a pull's stop is signed for exactly that chat and that move, under a method no queued call runs (decision 32)", async () => {
  const device = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Studio" });
  const stop = await signStop(device, { session_id: "s1", move_request_id: "pull-1" });
  expect(stop.request_id).toBe("pull-1:stop");
  const call = { ...stopCall({ session_id: "s1", move_request_id: "pull-1" }), at: stop.device.at };
  expect(call).toMatchObject({ request_id: "pull-1:stop", method: "session.move.stop", params: { session_id: "s1", move_request_id: "pull-1" } });
  expect(await verifyCall(device.public_key, call, stop.device.signature)).toBe(true);
  // Never another chat's turn, another move's, a queued Stop of the chat, or the move's own signature.
  expect(await verifyCall(device.public_key, { ...stopCall({ session_id: "s2", move_request_id: "pull-1" }), at: stop.device.at }, stop.device.signature)).toBe(false);
  expect(await verifyCall(device.public_key, { ...stopCall({ session_id: "s1", move_request_id: "pull-2" }), at: stop.device.at }, stop.device.signature)).toBe(false);
  expect(await verifyCall(device.public_key, { session_id: "s1", request_id: "pull-1:stop", method: "turn.interrupt", params: { session_id: "s1" }, at: stop.device.at }, stop.device.signature)).toBe(false);
  const move = await signMove(device, { session_id: "s1", request_id: "pull-1", to: { computer_id: "pc" } });
  expect(await verifyCall(device.public_key, call, move.signature)).toBe(false);
});
