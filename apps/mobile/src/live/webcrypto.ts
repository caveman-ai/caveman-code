// WebCrypto for a JavaScript engine that has none. A phone's (Hermes) has no `crypto.subtle`, and Session Protocol's
// device approval is written against it (packages/session-protocol/src/devices.ts), so the phone runs that one
// implementation on this adapter instead of a second copy of the protocol. It covers exactly what the protocol calls,
// and refuses everything else:
//
//   ECDSA P-256 with SHA-256   generateKey, importKey (jwk), exportKey (jwk), sign, verify   the device key, statements
//   ECDH P-256                 generateKey, importKey (raw), exportKey (raw), deriveBits     a connection's two keys
//   HKDF-SHA256                importKey (raw), deriveKey (AES-GCM 256), deriveBits          the frame keys
//   AES-256-GCM, 128-bit tag   importKey (raw), encrypt, decrypt                              sealed frames
//   HMAC-SHA256                importKey (raw), sign, verify                                  a pairing code's proof
//   SHA-256                    digest                                                         a key's id, a call's hash
//
// The arithmetic is the noble libraries' (@noble/curves, @noble/hashes, @noble/ciphers: audited, no dependencies, no
// native build, so the app still runs in Expo Go). This file only gives them WebCrypto's shape: keys that say their
// type, algorithm and usages and never their bytes, ECDSA signatures as the 64-byte r||s, AES-GCM's tag after the
// ciphertext. Tested against Node's own WebCrypto in both directions (webcrypto.test.ts), and under the protocol's own
// device tests (webcrypto.protocol.test.ts).
//
// What it cannot give: a key the JavaScript engine cannot read. WebCrypto keeps a non-extractable key outside the
// page; here its bytes are in this module's memory (never on the key object, never exportable through this API). The
// device key's bytes rest in the phone's Keychain or Keystore (deviceKey.ts).
import { gcm } from "@noble/ciphers/aes";
import { mapHashToField } from "@noble/curves/abstract/modular";
import { p256 } from "@noble/curves/nist";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

type Subtle = typeof globalThis.crypto.subtle;
type Usage = "sign" | "verify" | "deriveBits" | "deriveKey" | "encrypt" | "decrypt";
type KeyType = "public" | "private" | "secret";
type KeyAlgorithm =
  | { readonly name: "ECDSA" | "ECDH"; readonly namedCurve: "P-256" }
  | { readonly name: "HMAC"; readonly hash: { readonly name: "SHA-256" }; readonly length: number }
  | { readonly name: "HKDF" }
  | { readonly name: "AES-GCM"; readonly length: 256 };

/** A failure named as WebCrypto names it (NotSupportedError, InvalidAccessError, DataError, OperationError). */
const fail = (name: string, message: string) => Object.assign(new Error(message), { name });
const unsupported = (what: string) =>
  fail(
    "NotSupportedError",
    `${what} is not one of the algorithms Caveman Code's device approval uses.`,
  );

/** What crypto.subtle hands back: the four fields a CryptoKey shows. Its bytes stay in this module (`material`). */
class JsKey {
  readonly type: KeyType;
  readonly extractable: boolean;
  readonly algorithm: KeyAlgorithm;
  readonly usages: ReadonlyArray<Usage>;
  constructor(
    type: KeyType,
    extractable: boolean,
    algorithm: KeyAlgorithm,
    usages: ReadonlyArray<Usage>,
  ) {
    this.type = type;
    this.extractable = extractable;
    this.algorithm = algorithm;
    this.usages = usages;
    Object.freeze(this);
  }
}

/** Each key's bytes: a private key's 32-byte scalar, a public key's 65-byte point (04 || x || y), a secret as given. */
const material = new WeakMap<JsKey, Uint8Array>();

const makeKey = (
  type: KeyType,
  extractable: boolean,
  algorithm: KeyAlgorithm,
  usages: ReadonlyArray<Usage>,
  bytes: Uint8Array,
): JsKey => {
  const key = new JsKey(type, extractable, algorithm, Object.freeze([...usages]));
  material.set(key, bytes);
  return key;
};

/** The bytes of a key this adapter made, for `use` under algorithm `name`; anything else is not a key it can use. */
const bytesOf = (
  key: unknown,
  name: KeyAlgorithm["name"],
  use: Usage | null,
  type?: KeyType,
): Uint8Array => {
  const bytes = key instanceof JsKey ? material.get(key) : undefined;
  if (!(key instanceof JsKey) || !bytes) throw new TypeError("not a key this WebCrypto made");
  if (key.algorithm.name !== name || (type !== undefined && key.type !== type))
    throw fail("InvalidAccessError", `the key is not a ${name} ${type ?? "key"}`);
  if (use !== null && !key.usages.includes(use))
    throw fail("InvalidAccessError", `the key may not ${use}`);
  return bytes;
};

/** A BufferSource's bytes, as a view (never copied: nothing here writes into what it is given). */
const view = (data: unknown): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("expected an ArrayBuffer or a view of one");
};
/** A result as WebCrypto returns it: an ArrayBuffer of exactly these bytes. */
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const nameOf = (algorithm: unknown): string =>
  String(
    typeof algorithm === "string"
      ? algorithm
      : ((algorithm as { name?: unknown } | null)?.name ?? ""),
  ).toUpperCase();
const isSha256 = (hash: unknown) => nameOf(hash) === "SHA-256";
const curveOf = (algorithm: unknown, what: string): "ECDSA" | "ECDH" => {
  const name = nameOf(algorithm);
  if (
    (name !== "ECDSA" && name !== "ECDH") ||
    (algorithm as { namedCurve?: unknown }).namedCurve !== "P-256"
  )
    throw unsupported(what);
  return name;
};
const usagesOf = (asked: unknown, allowed: ReadonlyArray<Usage>): Usage[] => {
  const usages = Array.isArray(asked) ? (asked as Usage[]) : [];
  for (const usage of usages)
    if (!allowed.includes(usage))
      throw fail("SyntaxError", `a key of this kind cannot ${String(usage)}`);
  return usages;
};

const fromBase64url = (text: unknown, length: number): Uint8Array => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text))
    throw fail("DataError", "not base64url");
  const binary = atob(
    text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4),
  );
  if (binary.length !== length) throw fail("DataError", `expected ${length} bytes`);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const toBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const random = (length: number): Uint8Array => {
  const source = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (typeof source?.getRandomValues !== "function")
    throw fail("OperationError", "this platform has no secure random source");
  return source.getRandomValues(new Uint8Array(length));
};

/** A new P-256 private scalar in [1, n-1], uniform: 48 random bytes reduced (FIPS 186-5 A.2.1), as noble's own does. */
const newScalar = (): Uint8Array => mapHashToField(random(48), p256.CURVE.n);
/** The uncompressed point of a private scalar. */
const pointOf = (scalar: Uint8Array): Uint8Array => p256.getPublicKey(scalar, false);
/** `raw` when it is an uncompressed point on the curve; else a DataError. */
const checkedPoint = (raw: Uint8Array): Uint8Array => {
  if (raw.length !== 65 || raw[0] !== 4) throw fail("DataError", "not an uncompressed P-256 point");
  try {
    p256.ProjectivePoint.fromHex(raw).assertValidity();
  } catch {
    throw fail("DataError", "not a point on P-256");
  }
  return raw.slice();
};

/** Compared in time that depends only on the lengths. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ (b[i] ?? 0);
  return diff === 0;
};

const EC_PRIVATE: Record<"ECDSA" | "ECDH", ReadonlyArray<Usage>> = {
  ECDSA: ["sign"],
  ECDH: ["deriveBits", "deriveKey"],
};
const EC_PUBLIC: Record<"ECDSA" | "ECDH", ReadonlyArray<Usage>> = { ECDSA: ["verify"], ECDH: [] };

async function digest(algorithm: unknown, data: unknown): Promise<ArrayBuffer> {
  if (!isSha256(algorithm)) throw unsupported(`digest ${nameOf(algorithm)}`);
  return buffer(sha256(view(data)));
}

async function generateKey(
  algorithm: unknown,
  extractable: boolean,
  usages: unknown,
): Promise<{ publicKey: JsKey; privateKey: JsKey }> {
  const name = curveOf(algorithm, `generateKey ${nameOf(algorithm)}`);
  const asked = usagesOf(usages, [...EC_PRIVATE[name], ...EC_PUBLIC[name]]);
  const scalar = newScalar();
  const curve = { name, namedCurve: "P-256" } as const;
  return {
    // A public key is always extractable, as WebCrypto has it.
    publicKey: makeKey(
      "public",
      true,
      curve,
      asked.filter((u) => EC_PUBLIC[name].includes(u)),
      pointOf(scalar),
    ),
    privateKey: makeKey(
      "private",
      extractable === true,
      curve,
      asked.filter((u) => EC_PRIVATE[name].includes(u)),
      scalar,
    ),
  };
}

async function importKey(
  format: unknown,
  keyData: unknown,
  algorithm: unknown,
  extractable: boolean,
  usages: unknown,
): Promise<JsKey> {
  const name = nameOf(algorithm);
  if (format === "jwk" && (name === "ECDSA" || name === "ECDH")) {
    const curve = { name: curveOf(algorithm, `importKey ${name}`), namedCurve: "P-256" } as const;
    const jwk = (keyData ?? {}) as {
      kty?: unknown;
      crv?: unknown;
      x?: unknown;
      y?: unknown;
      d?: unknown;
    };
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw fail("DataError", "not a P-256 key");
    const point = new Uint8Array(65);
    point[0] = 4;
    point.set(fromBase64url(jwk.x, 32), 1);
    point.set(fromBase64url(jwk.y, 32), 33);
    const checked = checkedPoint(point);
    if (jwk.d === undefined)
      return makeKey("public", true, curve, usagesOf(usages, EC_PUBLIC[curve.name]), checked);
    const scalar = fromBase64url(jwk.d, 32);
    let own: Uint8Array;
    try {
      own = pointOf(scalar);
    } catch {
      throw fail("DataError", "not a P-256 private key");
    }
    if (!sameBytes(own, checked))
      throw fail("DataError", "the private key is not this public key's");
    return makeKey(
      "private",
      extractable === true,
      curve,
      usagesOf(usages, EC_PRIVATE[curve.name]),
      scalar,
    );
  }
  if (format !== "raw") throw unsupported(`importKey ${String(format)} ${name}`);
  const raw = view(keyData);
  if (name === "ECDSA" || name === "ECDH") {
    const curve = { name: curveOf(algorithm, `importKey ${name}`), namedCurve: "P-256" } as const;
    return makeKey(
      "public",
      true,
      curve,
      usagesOf(usages, EC_PUBLIC[curve.name]),
      checkedPoint(raw),
    );
  }
  if (name === "HKDF") {
    if (extractable !== false) throw fail("SyntaxError", "an HKDF key is never extractable");
    return makeKey(
      "secret",
      false,
      { name: "HKDF" },
      usagesOf(usages, ["deriveKey", "deriveBits"]),
      raw.slice(),
    );
  }
  if (name === "HMAC") {
    if (!isSha256((algorithm as { hash?: unknown }).hash))
      throw unsupported("HMAC with another hash than SHA-256");
    if (raw.length === 0) throw fail("DataError", "an HMAC key is not empty");
    return makeKey(
      "secret",
      extractable === true,
      { name: "HMAC", hash: { name: "SHA-256" }, length: raw.length * 8 },
      usagesOf(usages, ["sign", "verify"]),
      raw.slice(),
    );
  }
  if (name === "AES-GCM") {
    if (raw.length !== 32) throw unsupported("AES-GCM with another key than 256 bits");
    return makeKey(
      "secret",
      extractable === true,
      { name: "AES-GCM", length: 256 },
      usagesOf(usages, ["encrypt", "decrypt"]),
      raw.slice(),
    );
  }
  throw unsupported(`importKey ${name}`);
}

async function exportKey(
  format: unknown,
  key: unknown,
): Promise<ArrayBuffer | Record<string, unknown>> {
  if (!(key instanceof JsKey)) throw new TypeError("not a key this WebCrypto made");
  const bytes = material.get(key);
  if (!bytes) throw new TypeError("not a key this WebCrypto made");
  if (!key.extractable) throw fail("InvalidAccessError", "the key is not extractable");
  const { name } = key.algorithm;
  if (format === "raw" && key.type !== "private" && name !== "HKDF") return buffer(bytes);
  if (format === "jwk" && (name === "ECDSA" || name === "ECDH")) {
    const point = key.type === "private" ? pointOf(bytes) : bytes;
    return {
      kty: "EC",
      crv: "P-256",
      x: toBase64url(point.subarray(1, 33)),
      y: toBase64url(point.subarray(33, 65)),
      ...(key.type === "private" ? { d: toBase64url(bytes) } : {}),
      ext: true,
      key_ops: [...key.usages],
    };
  }
  throw unsupported(`exportKey ${String(format)} ${name}`);
}

async function sign(algorithm: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
  const name = nameOf(algorithm);
  if (name === "ECDSA") {
    if (!isSha256((algorithm as { hash?: unknown }).hash))
      throw unsupported("ECDSA with another hash than SHA-256");
    // r||s, 64 bytes, as WebCrypto gives it. The nonce is RFC 6979's (from the key and the message), so signing needs
    // no random source; `lowS` off, as WebCrypto neither normalizes s nor asks for it.
    return buffer(
      p256
        .sign(sha256(view(data)), bytesOf(key, "ECDSA", "sign", "private"), { lowS: false })
        .toCompactRawBytes(),
    );
  }
  if (name === "HMAC") return buffer(hmac(sha256, bytesOf(key, "HMAC", "sign"), view(data)));
  throw unsupported(`sign ${name}`);
}

async function verify(
  algorithm: unknown,
  key: unknown,
  signature: unknown,
  data: unknown,
): Promise<boolean> {
  const name = nameOf(algorithm);
  if (name === "ECDSA") {
    if (!isSha256((algorithm as { hash?: unknown }).hash))
      throw unsupported("ECDSA with another hash than SHA-256");
    const point = bytesOf(key, "ECDSA", "verify", "public");
    const raw = view(signature);
    if (raw.length !== 64) return false;
    try {
      // Read as r||s and nothing else: handed the bytes, noble would try them as DER first.
      return p256.verify(p256.Signature.fromCompact(raw), sha256(view(data)), point, {
        lowS: false,
      });
    } catch {
      return false;
    }
  }
  if (name === "HMAC")
    return sameBytes(hmac(sha256, bytesOf(key, "HMAC", "verify"), view(data)), view(signature));
  throw unsupported(`verify ${name}`);
}

/** HKDF-SHA256's output, `bits` long. */
const hkdfBits = (
  algorithm: unknown,
  key: unknown,
  use: "deriveKey" | "deriveBits",
  bits: number,
): Uint8Array => {
  const params = algorithm as { hash?: unknown; salt?: unknown; info?: unknown };
  if (!isSha256(params.hash)) throw unsupported("HKDF with another hash than SHA-256");
  if (!Number.isInteger(bits) || bits <= 0 || bits % 8 !== 0 || bits > 255 * 256)
    throw fail("OperationError", "HKDF derives whole bytes, at most 8160 of them");
  return hkdf(sha256, bytesOf(key, "HKDF", use), view(params.salt), view(params.info), bits / 8);
};

async function deriveBits(
  algorithm: unknown,
  key: unknown,
  length?: number | null,
): Promise<ArrayBuffer> {
  const name = nameOf(algorithm);
  if (name === "HKDF") return buffer(hkdfBits(algorithm, key, "deriveBits", length ?? 0));
  if (name !== "ECDH") throw unsupported(`deriveBits ${name}`);
  const scalar = bytesOf(key, "ECDH", "deriveBits", "private");
  const peer = bytesOf((algorithm as { public?: unknown }).public, "ECDH", null, "public");
  const bits = length ?? 256;
  if (!Number.isInteger(bits) || bits <= 0 || bits % 8 !== 0 || bits > 256)
    throw fail("OperationError", "P-256 ECDH derives at most 256 bits, in whole bytes");
  // The shared point's x coordinate (the compressed point without its sign byte), as WebCrypto derives it.
  return buffer(p256.getSharedSecret(scalar, peer, true).subarray(1, 1 + bits / 8));
}

async function deriveKey(
  algorithm: unknown,
  baseKey: unknown,
  derived: unknown,
  extractable: boolean,
  usages: unknown,
): Promise<JsKey> {
  const name = nameOf(algorithm);
  if (
    name !== "HKDF" ||
    nameOf(derived) !== "AES-GCM" ||
    (derived as { length?: unknown }).length !== 256
  )
    throw unsupported(`deriveKey ${name} to ${nameOf(derived)}`);
  return makeKey(
    "secret",
    extractable === true,
    { name: "AES-GCM", length: 256 },
    usagesOf(usages, ["encrypt", "decrypt"]),
    hkdfBits(algorithm, baseKey, "deriveKey", 256),
  );
}

/** AES-256-GCM with the tag (128 bits) after the ciphertext, as WebCrypto lays it out. */
const aesGcm = (algorithm: unknown, key: unknown, use: "encrypt" | "decrypt") => {
  const params = algorithm as { iv?: unknown; additionalData?: unknown; tagLength?: unknown };
  if (nameOf(algorithm) !== "AES-GCM") throw unsupported(`${use} ${nameOf(algorithm)}`);
  if (params.tagLength !== undefined && params.tagLength !== 128)
    throw unsupported("AES-GCM with another tag than 128 bits");
  const iv = view(params.iv);
  if (iv.length !== 12) throw unsupported("AES-GCM with another nonce than 96 bits");
  return gcm(
    bytesOf(key, "AES-GCM", use),
    iv,
    params.additionalData === undefined ? undefined : view(params.additionalData),
  );
};

async function encrypt(algorithm: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
  return buffer(aesGcm(algorithm, key, "encrypt").encrypt(view(data)));
}

async function decrypt(algorithm: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
  const cipher = aesGcm(algorithm, key, "decrypt");
  try {
    return buffer(cipher.decrypt(view(data)));
  } catch {
    // A wrong key, nonce, associated data, tag or one changed bit: one answer for all of them.
    throw fail("OperationError", "the data does not decrypt");
  }
}

/** crypto.subtle, for the algorithms above. Every other method and algorithm rejects with NotSupportedError. */
export const subtle = {
  digest,
  generateKey,
  importKey,
  exportKey,
  sign,
  verify,
  deriveBits,
  deriveKey,
  encrypt,
  decrypt,
} as unknown as Subtle;

/** RFC 9562 version 4, from the platform's random source. */
const randomUUID = (): string => {
  const b = random(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Puts this WebCrypto in place as `globalThis.crypto`, once, before anything connects (index.ts). Where the platform
 * has its own `crypto.subtle` (a browser, Node) it is left alone unless `force` (tests, and the web build's
 * `?jscrypto`, which run the phone's crypto where a native one exists). `getRandomValues` is the platform's secure
 * random source (expo-crypto's on a phone); absent, the one already on `globalThis.crypto`. Answers whether it was
 * put in place.
 */
export function installWebCrypto(
  options: {
    readonly getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
    readonly force?: boolean;
  } = {},
): boolean {
  const g = globalThis as {
    crypto?: { subtle?: unknown; getRandomValues?: <T extends ArrayBufferView>(array: T) => T };
  };
  const had = g.crypto;
  if (had?.subtle !== undefined && options.force !== true) return false;
  const getRandomValues =
    options.getRandomValues ??
    (typeof had?.getRandomValues === "function" ? had.getRandomValues.bind(had) : undefined);
  if (!getRandomValues)
    throw new Error("WebCrypto needs a secure random source, and this platform gave none.");
  Object.defineProperty(globalThis, "crypto", {
    value: Object.freeze({ subtle, getRandomValues, randomUUID }),
    configurable: true,
    writable: true,
    enumerable: true,
  });
  return true;
}
