// Device approval (DESIGN S13): driving a person's laptop from another device needs that device approved once on the
// laptop itself. Each device holds its own P-256 key (non-extractable in the browser, sealed with safeStorage in the
// desktop app). On every relayed connection to a laptop runtime the runtime sends a fresh challenge with an ephemeral
// ECDH key; the device signs (runtime id, nonce, both ephemeral keys) with its device key and answers with its own
// ephemeral key. Both sides derive two keys from the two ephemeral keys, one per direction, and every frame after that,
// either way, is encrypted with AES-GCM under its direction's key and a sequence number. So the relay (Cloud) sees the
// handshake but can neither replay it on another connection (the nonce and the runtime's key are new each time), use
// it for another runtime (the id is signed), read a frame, nor add, change, drop or reorder one, in either direction.
//
// Platform-neutral: WebCrypto only (browsers, Electron's renderer, Node 22's globalThis.crypto).

/**
 * What holds a device key: a Mac's desktop app ("mac": sealed by the keychain, signing in code the app ships from
 * disk) or anything else ("device": a browser or phone, whose page code Cloud serves). Only a "mac" key signs
 * approvals other Macs accept (device statements).
 */
export type DeviceKind = "mac" | "device";

/** What a device holds: its id (the key's RFC 7638 thumbprint), a name people recognise, and a signer. */
export interface DeviceKey {
  readonly device_id: string;
  /** "iPhone, Safari", "Caveman Code on Studio": what the laptop shows when it asks. */
  readonly name: string;
  /** "mac" for a Mac's desktop key; absent (a "device") for everything else. */
  readonly kind?: DeviceKind;
  /** P-256 public key, JWK (kty, crv, x, y only). */
  readonly public_key: DevicePublicKey;
  /** ECDSA P-256 with SHA-256 over `data`; the 64-byte r||s signature (WebCrypto's form). */
  sign(data: Bytes): Promise<Uint8Array>;
}

export interface DevicePublicKey {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export const DEVICE_CONTEXT = "caveman-device-v1";
/** A hello that also signs the device's kind and name, answered only when the challenge offers it (`hello: 2`). */
export const DEVICE_HELLO_V2 = "caveman-device-v2";
/** A device name is cut to this many characters and loses control characters. */
export const DEVICE_NAME_MAX = 80;
/** How long a laptop waits for a person to answer "Allow?" before the request lapses (the device asks again). */
export const DEVICE_REQUEST_TTL_MS = 10 * 60 * 1000;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("this platform has no WebCrypto");
  return s;
};
type Subtle = typeof globalThis.crypto.subtle;
/** A WebCrypto key, typed from the platform's own SubtleCrypto (the DOM's or Node's). */
export type WebKey = Awaited<ReturnType<Subtle["importKey"]>>;
type WebKeyPair = { readonly publicKey: WebKey; readonly privateKey: WebKey };

/** Bytes WebCrypto takes (an ArrayBuffer underneath, never a shared one). */
export type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

export const toBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromBase64url = (text: string): Bytes => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** The public part of a P-256 JWK, or undefined when it is not one (32-byte x and y). */
export function publicKeyOf(jwk: unknown): DevicePublicKey | undefined {
  if (jwk === null || typeof jwk !== "object") return undefined;
  const { kty, crv, x, y } = jwk as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string") return undefined;
  try {
    if (fromBase64url(x).length !== 32 || fromBase64url(y).length !== 32) return undefined;
  } catch {
    return undefined;
  }
  return { kty, crv, x, y };
}

/** RFC 7638 thumbprint (SHA-256, base64url) of a P-256 public key: the device's id, so no device can claim another's. */
export async function deviceIdOf(key: DevicePublicKey): Promise<string> {
  const canonical = `{"crv":"${key.crv}","kty":"${key.kty}","x":"${key.x}","y":"${key.y}"}`;
  return toBase64url(new Uint8Array(await subtle().digest("SHA-256", utf8(canonical))));
}

/** Crockford's base32: no I, L, O or U, so a code reads aloud and types without mixing letters up. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A device code's characters: 5 bits each, 60 bits of the device id. */
const DEVICE_CODE_CHARS = 12;

/**
 * The code both screens show ("4F2-9KM-W3X-QH7"), from the device id: the person allows the device whose code they see
 * on the device in their hand, not one someone else asked with. It is the id's first 60 bits, in Crockford base32: a
 * relay that answers the genuine device itself and asks with a key of its own must find a key whose code is the same,
 * one in 2^60 (F-1: the 6 characters this replaced held 30 bits, which a small fleet grinds in minutes, and one Allow
 * now counts on every one of the person's Macs). Grouped in threes, so it never reads as a pairing code (XXXX-XXXX-XXXX).
 */
export function deviceCode(deviceId: string): string {
  const bytes = fromBase64url(deviceId);
  let code = "";
  for (let i = 0; i < DEVICE_CODE_CHARS; i++) {
    const bit = i * 5;
    const two = ((bytes[bit >> 3] ?? 0) << 8) | (bytes[(bit >> 3) + 1] ?? 0);
    code += CROCKFORD[(two >> (11 - (bit & 7))) & 31];
  }
  return code.match(/.{3}/g)!.join("-");
}

/** A device name as a laptop shows it: no control characters, at most DEVICE_NAME_MAX characters, never empty. */
export function cleanDeviceName(name: unknown): string {
  const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim() : "";
  // Trimmed again after the cut, so a name cleaned twice is the same name (a statement signs it cleaned).
  return [...(text || "A device")].slice(0, DEVICE_NAME_MAX).join("").trimEnd();
}

/**
 * The bytes a device signs in device.hello. `v2` (a challenge that offers `hello: 2`) adds the device's kind and its
 * cleaned name, so the relay can change neither; a v1 hello signs neither and reads as kind "device".
 */
export function helloPayload(input: {
  readonly runtime_id: string;
  readonly nonce: string;
  readonly runtime_key: string;
  readonly device_key: string;
  readonly v2?: { readonly kind: DeviceKind; readonly name: string };
}): Bytes {
  const fields = [input.runtime_id, input.nonce, input.runtime_key, input.device_key];
  return utf8((input.v2 ? [DEVICE_HELLO_V2, ...fields, input.v2.kind, cleanDeviceName(input.v2.name)] : [DEVICE_CONTEXT, ...fields]).join("\n"));
}

/**
 * How long the code a Mac's screen shows for another of the person's Macs to join it lives (decision 31): one live code
 * per Mac, in its runtime's memory only, and used up by the first hello that tries one, right or wrong.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/**
 * A new pairing code: 12 Crockford base32 characters (60 random bits), shown "XXXX-XXXX-XXXX". The relay sees a proof
 * of it (pairProof) and could try codes against it offline; 60 bits outlast the code's ten minutes and one try (T22).
 */
export function pairingCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // 256 is a multiple of 32: each character is uniform.
  const chars = [...bytes].map((b) => CROCKFORD[b & 31]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/**
 * A pairing code as the person typed it, read back: case, spaces and dashes do not count, and O, I and L read as 0, 1
 * and 1 (Crockford). Undefined when it is not 12 such characters.
 */
export function normalizePairingCode(input: string): string | undefined {
  const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return text.length === 12 && [...text].every((c) => CROCKFORD.includes(c)) ? text : undefined;
}

/**
 * v2 names the joining key: a v1 proof covered the hello's bytes only, which any key can sign again, so a relay that
 * held a joining Mac's hello back could send those bytes signed by its own key, with that Mac's proof, and be asked
 * about as one of the person's Macs (A-1).
 */
const PAIR_CONTEXT = "caveman-pair-v2\n";
const pairKey = (code: string, usages: Array<"sign" | "verify">) => {
  const normal = normalizePairingCode(code);
  if (normal === undefined) throw new Error("not a pairing code");
  return subtle().importKey("raw", utf8(normal), { name: "HMAC", hash: "SHA-256" }, false, usages);
};
const pairData = (deviceId: string, hello: Bytes) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceId)) throw new Error("not a device id");
  const head = utf8(`${PAIR_CONTEXT}${deviceId}\n`);
  const data = new Uint8Array(head.length + hello.length) as Bytes;
  data.set(head);
  data.set(hello, head.length);
  return data;
};

/**
 * Proof that this hello comes from the Mac the person typed the code into (decision 31): HMAC-SHA256 under the code
 * over "caveman-pair-v2", the joining key's id (deviceIdOf, the key that signs the hello) and the hello's own signed
 * bytes (helloPayload, v2: this connection's nonce, the device's kind and name), base64url. It holds for that one
 * connection and that one key only: the relay, which does not know the code, can make none for a key of its own.
 */
export async function pairProof(code: string, deviceId: string, hello: Bytes): Promise<string> {
  return toBase64url(new Uint8Array(await subtle().sign("HMAC", await pairKey(code, ["sign"]), pairData(deviceId, hello))));
}

/** Whether `proof` is pairProof(code, deviceId, hello); false for anything malformed (compared in constant time). */
export async function verifyPairProof(code: string, deviceId: string, hello: Bytes, proof: string): Promise<boolean> {
  try {
    const mac = fromBase64url(proof);
    if (mac.length !== 32) return false;
    return await subtle().verify("HMAC", await pairKey(code, ["verify"]), mac, pairData(deviceId, hello));
  } catch {
    return false;
  }
}

const PAIR_ANSWER_CONTEXT = "caveman-pair-ok-v1\n";
const pairAnswerData = (deviceId: string, hello: Bytes) => {
  const data = pairData(deviceId, hello);
  const head = utf8(PAIR_ANSWER_CONTEXT);
  const out = new Uint8Array(head.length + data.length) as Bytes;
  out.set(head);
  out.set(data, head.length);
  return out;
};
/**
 * The Mac's answer to a Join (decision 31): once its screen allowed the joining key as one of the person's Macs, the
 * first frame it seals on that connection is a device.status naming the role "mac" with this proof, HMAC-SHA256 under
 * the code its screen showed over "caveman-pair-ok-v1", the joining key's id and the hello's signed bytes. A plain
 * status can be forged by the relay, and a sealed one by a relay that plays the Mac itself; neither knows the code, so
 * only this one tells the joining Mac it was taken (m-h).
 */
export async function pairAnswer(code: string, deviceId: string, hello: Bytes): Promise<string> {
  return toBase64url(new Uint8Array(await subtle().sign("HMAC", await pairKey(code, ["sign"]), pairAnswerData(deviceId, hello))));
}
/** Whether `proof` is pairAnswer(code, deviceId, hello); false for anything malformed. */
export async function verifyPairAnswer(code: string, deviceId: string, hello: Bytes, proof: unknown): Promise<boolean> {
  try {
    if (typeof proof !== "string") return false;
    const mac = fromBase64url(proof);
    if (mac.length !== 32) return false;
    return await subtle().verify("HMAC", await pairKey(code, ["verify"]), mac, pairAnswerData(deviceId, hello));
  } catch {
    return false;
  }
}

/** An ephemeral ECDH P-256 key for one connection: `public_key` is the raw point, base64url. */
export async function ephemeralKey(): Promise<{ readonly public_key: string; readonly privateKey: WebKey }> {
  const pair = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as WebKeyPair;
  return { public_key: toBase64url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))), privateKey: pair.privateKey };
}

/** Which way a sealed frame goes: each way has its own key and its own sequence numbers. */
export type FrameDirection = "to_runtime" | "to_device";

/** A connection's two frame keys (AES-256-GCM, never extractable), one per direction. */
export interface ChannelKeys {
  readonly to_runtime: WebKey;
  readonly to_device: WebKey;
}

/** The same two keys as raw AES-256 bytes, for a sealer other than WebCrypto (channelKeyBytes). */
export interface ChannelKeyBytes {
  readonly to_runtime: Bytes;
  readonly to_device: Bytes;
}

interface ChannelInput {
  readonly privateKey: WebKey;
  readonly peer_key: string;
  readonly runtime_id: string;
  readonly nonce: string;
  readonly runtime_key: string;
  readonly device_key: string;
}

/** The HKDF a connection's frame keys come from, and its parameters for each direction. */
async function channelHkdf(input: ChannelInput) {
  const raw = fromBase64url(input.peer_key);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("not a P-256 public key");
  const peer = await subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await subtle().deriveBits({ name: "ECDH", public: peer }, input.privateKey, 256);
  const material = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = (direction: FrameDirection) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: fromBase64url(input.nonce),
    info: utf8([`${DEVICE_CONTEXT} ${direction === "to_runtime" ? "device-to-runtime" : "runtime-to-device"}`, input.runtime_id, input.runtime_key, input.device_key].join("\n")),
  });
  return { material, params };
}

/**
 * The connection's frame keys: HKDF-SHA256 over the ECDH secret of the two ephemeral keys, salted with the nonce and
 * bound to the runtime and both public keys, one key per direction. The relay sees neither ephemeral private key, so
 * it can neither read nor forge a frame either way.
 */
export async function channelKeys(input: ChannelInput): Promise<ChannelKeys> {
  const { material, params } = await channelHkdf(input);
  const derive = (direction: FrameDirection) => subtle().deriveKey(params(direction), material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const [to_runtime, to_device] = await Promise.all([derive("to_runtime"), derive("to_device")]);
  return { to_runtime, to_device };
}

/**
 * channelKeys' two keys as their bytes, for the runtime's own AES-GCM (frameParams): Node takes a WebCrypto key that
 * was never extractable only through KeyObject.from, which it deprecates (DEP0204).
 */
export async function channelKeyBytes(input: ChannelInput): Promise<ChannelKeyBytes> {
  const { material, params } = await channelHkdf(input);
  const derive = async (direction: FrameDirection) => new Uint8Array(await subtle().deriveBits(params(direction), material, 256)) as Bytes;
  const [to_runtime, to_device] = await Promise.all([derive("to_runtime"), derive("to_device")]);
  return { to_runtime, to_device };
}

/** Verifies a device's ECDSA P-256 signature (64-byte r||s, base64url) over `data`. False for anything malformed. */
export async function verifyDeviceSignature(key: DevicePublicKey, data: Bytes, signature: string): Promise<boolean> {
  try {
    const bytes = fromBase64url(signature);
    if (bytes.length !== 64) return false;
    const imported = await subtle().importKey("jwk", { kty: key.kty, crv: key.crv, x: key.x, y: key.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, imported, bytes, data);
  } catch {
    return false;
  }
}

/** The 96-bit GCM nonce of frame `seq`: never reused under a key, since each direction has its own key and counts up. */
const frameIv = (seq: number): Bytes => {
  const iv = new Uint8Array(12) as Bytes;
  new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
  return iv;
};
const frameAad = (direction: FrameDirection, seq: number) => utf8([DEVICE_CONTEXT, direction, String(seq)].join("\n"));

/**
 * A frame's AES-GCM nonce and associated data. For a sealer other than WebCrypto: the runtime seals with Node's own
 * AES-GCM at once, where a WebCrypto job would wait for its event loop (S14), and gets the same bytes.
 */
export const frameParams = (direction: FrameDirection, seq: number): { readonly iv: Bytes; readonly aad: Bytes } => {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("a frame's sequence number counts from 1");
  return { iv: frameIv(seq), aad: frameAad(direction, seq) };
};

/** The text of a sealed frame around its ciphertext (with the 128-bit tag after it, as WebCrypto gives it). */
export const sealedFrameText = (seq: number, ct: Uint8Array): string => JSON.stringify({ device_frame: { seq, ct: toBase64url(ct) } });

/** The ciphertext of a sealed frame at sequence number `seq`; undefined when it is not one, or not at that place. */
export const sealedFrameAt = (raw: string, seq: number): Bytes | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const frame = (parsed as { device_frame?: unknown } | null)?.device_frame as { seq?: unknown; ct?: unknown } | undefined;
  if (!frame || frame.seq !== seq || typeof frame.ct !== "string") return undefined;
  try {
    return fromBase64url(frame.ct);
  } catch {
    return undefined;
  }
};

/**
 * One frame on an approved connection, either way: `{"device_frame":{"seq":n,"ct":"<base64url>"}}`, the JSON-RPC text
 * encrypted with AES-256-GCM under that direction's key. Sequence numbers start at 1 and go up by one per frame.
 */
export async function sealFrame(key: WebKey, seq: number, body: string, direction: FrameDirection): Promise<string> {
  const { iv, aad } = frameParams(direction, seq);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, utf8(body)));
  return sealedFrameText(seq, ct);
}

/** The JSON-RPC text inside a sealed frame, when it decrypts under `key` at sequence number `seq`; else undefined. */
export async function openFrame(key: WebKey, seq: number, raw: string, direction: FrameDirection): Promise<string | undefined> {
  const ct = sealedFrameAt(raw, seq);
  if (ct === undefined) return undefined;
  try {
    const { iv, aad } = frameParams(direction, seq);
    const plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ct);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return undefined;
  }
}

export const DEVICE_CALL_CONTEXT = "caveman-device-call-v1";
/** How far ahead of the runtime's clock a device's clock may be. */
export const DEVICE_CALL_SKEW_MS = 5 * 60 * 1000;
/**
 * A queued call's signature holds this long after the device made it. Cloud expires queued calls after 24 h, and the
 * runtime keeps a request id's answer for 24 h after it ran: ending 5 minutes (the clock skew allowed) short of a day
 * means a signed call can never run again once its answer is forgotten.
 */
export const DEVICE_CALL_MAX_AGE_MS = 24 * 60 * 60 * 1000 - DEVICE_CALL_SKEW_MS;

/** Whether a signed call's time is still good now: "expired" once past DEVICE_CALL_MAX_AGE_MS, "future" if ahead. */
export function callAge(at: string, now = Date.now()): "ok" | "expired" | "future" | "invalid" {
  const made = Date.parse(at);
  if (!Number.isFinite(made)) return "invalid";
  if (made > now + DEVICE_CALL_SKEW_MS) return "future";
  return now - made > DEVICE_CALL_MAX_AGE_MS ? "expired" : "ok";
}

const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** What a device signs for a call it queues in Cloud for a chat on a Mac (so the Mac runs only calls its devices made). */
export interface DeviceCall {
  readonly session_id: string;
  readonly request_id: string;
  readonly method: string;
  readonly params: unknown;
  /** When the device made it, ISO 8601. */
  readonly at: string;
}

export async function callPayload(call: DeviceCall): Promise<Bytes> {
  const digest = toBase64url(new Uint8Array(await subtle().digest("SHA-256", utf8(canonicalJson(call.params)))));
  return utf8([DEVICE_CALL_CONTEXT, call.session_id, call.request_id, call.method, call.at, digest].join("\n"));
}

/** The fields a queued call carries for a Mac: `{ device_id, at, signature }`. */
export async function signCall(device: DeviceKey, call: Omit<DeviceCall, "at">, now = Date.now()): Promise<{ readonly device_id: string; readonly at: string; readonly signature: string }> {
  const at = new Date(now).toISOString();
  return { device_id: device.device_id, at, signature: toBase64url(await device.sign(await callPayload({ ...call, at }))) };
}

/** Whether `signature` is `key`'s over this call, made within the window that ends now. */
export async function verifyCall(key: DevicePublicKey, call: DeviceCall, signature: string, now = Date.now()): Promise<boolean> {
  if (callAge(call.at, now) !== "ok") return false;
  return verifyDeviceSignature(key, await callPayload(call), signature);
}

/**
 * The fields a device adds to a call it queues in Cloud for a chat (`{ device: { device_id, at, signature } }`), signed
 * over the params as Cloud and the runtime will read them back: through one JSON round trip, so `undefined`, a `Date`
 * or a sparse array hash the same on both sides.
 */
export async function queuedCallFields(
  device: DeviceKey,
  call: { readonly session_id: string; readonly request_id: string; readonly method: string; readonly params: unknown },
  now = Date.now(),
): Promise<{ readonly device: { readonly device_id: string; readonly at: string; readonly signature: string } }> {
  const params = call.params === undefined ? null : (JSON.parse(JSON.stringify(call.params)) as unknown);
  return { device: await signCall(device, { session_id: call.session_id, request_id: call.request_id, method: call.method, params }, now) };
}

/** A move a device asks for (a chat leaving This Mac, Cloud-initiated): signed as a call of method "session.move". */
export interface DeviceMove {
  readonly session_id: string;
  readonly request_id: string;
  /** Where to: "cloud", or `{ computer_id }`, as the move request says it. */
  readonly to: unknown;
}
const moveCall = (move: DeviceMove) => ({ session_id: move.session_id, request_id: move.request_id, method: "session.move", params: { to: move.to } });

/** The fields a move request carries for a Mac: `{ device_id, at, signature }` (signCall's). */
export const signMove = (device: DeviceKey, move: DeviceMove, now = Date.now()) => signCall(device, moveCall(move), now);

/**
 * A stop of a chat's running turn a device asks for with Continue on This Mac (decision 32), bound to that one move:
 * signed as a call of its own method, "session.move.stop", naming the move's request id, which the chat's Mac checks
 * (verifyCall) before it stops the turn and lets the chat go at the boundary. Cloud cannot carry it with another move
 * (the move's id is signed), and no queued call runs it (a device queues only a send, a Stop or an answer).
 */
export const stopCall = (stop: { readonly session_id: string; readonly move_request_id: string }) => ({
  session_id: stop.session_id,
  request_id: `${stop.move_request_id}:stop`,
  method: "session.move.stop",
  params: { session_id: stop.session_id, move_request_id: stop.move_request_id },
});

/** The `stop` a pull carries: its request id and this device's signature over stopping that session's turn for that move. */
export const signStop = async (device: DeviceKey, stop: { readonly session_id: string; readonly move_request_id: string }, now = Date.now()) => {
  const call = stopCall(stop);
  return { request_id: call.request_id, device: await signCall(device, call, now) };
};

/** Whether `signature` is `key`'s over this move (session, request id, where to, time), within the window. */
export const verifyMove = (key: DevicePublicKey, move: DeviceMove & { readonly at: string }, signature: string, now = Date.now()) =>
  verifyCall(key, { ...moveCall(move), at: move.at }, signature, now);

export const DEVICE_STATEMENT_CONTEXT = "caveman-device-statement-v1";
/** The most a statement takes as JSON, signature included; a bigger one is refused, never cut. */
export const DEVICE_STATEMENT_MAX_BYTES = 4096;

/** The key that signed a statement: a Mac's desktop key (role "mac" where it counts). */
export interface DeviceStatementSigner {
  readonly device_id: string;
  readonly public_key: DevicePublicKey;
}

/**
 * What a Mac's screen said about a device, for the person's other Macs: allowed (with its key, name and role) or
 * removed; or ("agents") that a key is that Mac's agents key, which signs the mail its chats send the person's other
 * Macs (macMail.ts). An agents key is never a device: it drives nothing, and a Mac's removal of its id takes it away.
 */
export interface DeviceStatementBody {
  readonly kind: "allow" | "remove" | "agents";
  readonly organization_id: string;
  readonly user_id: string;
  readonly device_id: string;
  /**
   * An allow's: the device's key, its name and its kind as the signing Mac's screen allowed it (from its signed hello).
   * An agents statement's: the agents key and the signing Mac's own name, with no role.
   */
  readonly public_key?: DevicePublicKey;
  readonly name?: string;
  readonly role?: DeviceKind;
}

/**
 * A signed approval or removal (THREAT-MODEL.md, devices-2026-10-31). Cloud carries it in the person's log and cannot
 * make one: every field is signed, and a Mac counts it only when the signer is a Mac key it trusts. `at` is shown
 * only; no decision reads it. `nonce` makes each statement its own.
 */
export interface DeviceStatement extends DeviceStatementBody {
  readonly signer: DeviceStatementSigner;
  readonly at: string;
  readonly nonce: string;
  readonly signature: string;
}

/**
 * The bytes a statement's signature covers: one field per line, each free of line breaks (a name is clean, the rest
 * are ids, base64url or a time), so every Mac computes the same bytes, and the same id, from the fields it reads back.
 */
export function statementPayload(s: Omit<DeviceStatement, "signature">): Bytes {
  return utf8(
    [
      DEVICE_STATEMENT_CONTEXT,
      s.kind,
      s.organization_id,
      s.user_id,
      s.device_id,
      s.public_key?.x ?? "",
      s.public_key?.y ?? "",
      s.role ?? "",
      s.name ?? "",
      s.signer.device_id,
      s.signer.public_key.x,
      s.signer.public_key.y,
      s.at,
      s.nonce,
    ].join("\n"),
  );
}

/** A statement's id: SHA-256 of its signed bytes, base64url. The same statement has one id, a changed one another. */
export async function statementId(s: Omit<DeviceStatement, "signature">): Promise<string> {
  return toBase64url(new Uint8Array(await subtle().digest("SHA-256", statementPayload(s))));
}

/** `signer` signs `body` (on a Mac's own screen, with its desktop key). */
export async function signStatement(signer: DeviceKey, body: DeviceStatementBody, now = Date.now()): Promise<DeviceStatement> {
  const nonce = toBase64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const unsigned = {
    kind: body.kind,
    organization_id: body.organization_id,
    user_id: body.user_id,
    device_id: body.device_id,
    ...(body.kind === "allow"
      ? { public_key: body.public_key, name: cleanDeviceName(body.name), role: body.role ?? "device" }
      : body.kind === "agents"
        ? { public_key: body.public_key, name: cleanDeviceName(body.name) }
        : {}),
    signer: { device_id: signer.device_id, public_key: signer.public_key },
    at: new Date(now).toISOString(),
    nonce,
  } as Omit<DeviceStatement, "signature">;
  return { ...unsigned, signature: toBase64url(await signer.sign(statementPayload(unsigned))) };
}

/** The person whose Macs share approvals, as device.list names them (`family`). */
export interface DeviceFamily {
  readonly organization_id: string;
  readonly user_id: string;
}

/**
 * A Mac screen's Allow of a waiting device, signed for the person's other Macs: only with a Mac's desktop key, only for
 * a device that asked as this Mac's own person, with its key, name and kind as it asked. Undefined: the Allow counts on
 * this Mac only (a browser's key, a Mac that shares nothing, or a request that did not say its key).
 */
export async function allowStatementFor(
  signer: DeviceKey,
  family: DeviceFamily | undefined,
  request: { readonly device_id: string; readonly name: string; readonly user_id: string; readonly public_key?: DevicePublicKey | undefined; readonly role?: DeviceKind | undefined },
): Promise<DeviceStatement | undefined> {
  if (signer.kind !== "mac" || !family || !request.public_key || request.user_id !== family.user_id) return undefined;
  return signStatement(signer, {
    kind: "allow",
    organization_id: family.organization_id,
    user_id: family.user_id,
    device_id: request.device_id,
    public_key: request.public_key,
    name: request.name,
    role: request.role ?? "device",
  });
}

/**
 * This Mac's desktop key vouching for its own agents key (`agents`, the key's public half) under `name`, the Mac's name,
 * for the person's other Macs: they take mail its chats sign with that key while they trust this Mac. Only a Mac's
 * desktop key signs one; undefined otherwise.
 */
export async function agentsStatementFor(signer: DeviceKey, family: DeviceFamily | undefined, agents: { readonly device_id: string; readonly public_key: DevicePublicKey }, name: string): Promise<DeviceStatement | undefined> {
  if (signer.kind !== "mac" || !family) return undefined;
  return signStatement(signer, { kind: "agents", organization_id: family.organization_id, user_id: family.user_id, device_id: agents.device_id, public_key: agents.public_key, name });
}

/** A Mac screen's Remove of a device, signed so every Mac of the person's that takes this Mac's approvals removes it too. */
export async function removeStatementFor(signer: DeviceKey, family: DeviceFamily | undefined, deviceId: string): Promise<DeviceStatement | undefined> {
  if (signer.kind !== "mac" || !family) return undefined;
  return signStatement(signer, { kind: "remove", organization_id: family.organization_id, user_id: family.user_id, device_id: deviceId });
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The statement in `raw`, rebuilt from its own fields only, when it is one and its signature holds: undefined for
 * anything else (too big, a field missing, wrong or extra for its kind, a name that is not clean, a device or signer
 * id that is not its key's thumbprint, a signature that does not verify). Whether its signer counts is the Mac's call.
 */
export async function verifyStatement(raw: unknown): Promise<DeviceStatement | undefined> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  let size: number;
  try {
    size = utf8(JSON.stringify(raw)).length;
  } catch {
    return undefined;
  }
  if (size > DEVICE_STATEMENT_MAX_BYTES) return undefined;
  const r = raw as Record<string, unknown>;
  const signerRaw = r.signer as Record<string, unknown> | null | undefined;
  if (r.kind !== "allow" && r.kind !== "remove" && r.kind !== "agents") return undefined;
  for (const field of [r.organization_id, r.user_id]) if (typeof field !== "string" || !ID.test(field)) return undefined;
  if (typeof r.device_id !== "string" || !THUMBPRINT.test(r.device_id)) return undefined;
  if (typeof r.at !== "string" || r.at.length > 40 || !Number.isFinite(Date.parse(r.at)) || /\s/.test(r.at)) return undefined;
  if (typeof r.nonce !== "string" || !NONCE.test(r.nonce) || typeof r.signature !== "string") return undefined;
  if (signerRaw === null || typeof signerRaw !== "object") return undefined;
  const signerKey = publicKeyOf(signerRaw.public_key);
  if (!signerKey || signerRaw.device_id !== (await deviceIdOf(signerKey))) return undefined;
  let allow: { public_key: DevicePublicKey; name: string; role?: DeviceKind } | undefined;
  if (r.kind === "allow" || r.kind === "agents") {
    const key = publicKeyOf(r.public_key);
    if (!key || r.device_id !== (await deviceIdOf(key))) return undefined;
    if (typeof r.name !== "string" || cleanDeviceName(r.name) !== r.name) return undefined;
    if (r.kind === "agents") {
      // A Mac's agents key has no role: it is never a device.
      if (r.role !== undefined) return undefined;
      allow = { public_key: key, name: r.name };
    } else {
      if (r.role !== "mac" && r.role !== "device") return undefined;
      allow = { public_key: key, name: r.name, role: r.role };
    }
  } else if (r.public_key !== undefined || r.name !== undefined || r.role !== undefined) return undefined;
  const unsigned = {
    kind: r.kind,
    organization_id: r.organization_id as string,
    user_id: r.user_id as string,
    device_id: r.device_id,
    ...allow,
    signer: { device_id: signerRaw.device_id as string, public_key: signerKey },
    at: r.at,
    nonce: r.nonce,
  } as Omit<DeviceStatement, "signature">;
  if (!(await verifyDeviceSignature(signerKey, statementPayload(unsigned), r.signature))) return undefined;
  return { ...unsigned, signature: r.signature };
}

/**
 * Remote control for This Mac: the person's own word when they gave it (Settings), else on with sync (DESIGN S13:
 * the one notice that turns sync on turns remote control on too). A Cloud computer's link always runs.
 */
export function remoteControlOn(settings: { readonly remote_control?: boolean | undefined; readonly sync_chats?: boolean | undefined } | null | undefined): boolean {
  if (settings?.remote_control !== undefined) return settings.remote_control;
  return settings?.sync_chats === true;
}

/** The one-time notice's words for remote control, for whichever surface asks about sync (S13). */
export const REMOTE_CONTROL_NOTICE =
  "Your phone and the web can see this Mac's chats and work in them. A new device controls this Mac only after you allow it here, once.";

/** A device's own key made with WebCrypto: the private key never leaves `privateKey` (made non-extractable). */
export async function webCryptoDeviceKey(input: { readonly privateKey: WebKey; readonly public_key: DevicePublicKey; readonly name: string; readonly kind?: DeviceKind }): Promise<DeviceKey> {
  const device_id = await deviceIdOf(input.public_key);
  return {
    device_id,
    name: cleanDeviceName(input.name),
    ...(input.kind ? { kind: input.kind } : {}),
    public_key: input.public_key,
    sign: async (data) => new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, data)),
  };
}

/** A new P-256 signing key pair whose private half cannot be exported. */
export async function newDeviceKeyPair(): Promise<{ readonly privateKey: WebKey; readonly public_key: DevicePublicKey }> {
  const pair = (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as WebKeyPair;
  const jwk = await subtle().exportKey("jwk", pair.publicKey);
  const public_key = publicKeyOf(jwk);
  if (!public_key) throw new Error("WebCrypto made a key that is not P-256");
  return { privateKey: pair.privateKey, public_key };
}
