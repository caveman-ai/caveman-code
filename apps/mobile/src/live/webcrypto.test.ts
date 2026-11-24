// The phone's WebCrypto (webcrypto.ts, on the noble libraries) against Node's own as the oracle: for every algorithm
// Session Protocol's device approval uses, what one makes the other takes, both ways (sign with one and verify with
// the other; seal with one and open with the other; the same bytes from the same inputs), published vectors hold on
// both, and the protocol's own functions agree across the two (a device on the adapter, a Mac on Node's).
import { createECDH, randomBytes as nodeRandomBytes, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  channelKeys,
  deviceCode,
  deviceIdOf,
  ephemeralKey,
  helloPayload,
  newDeviceKeyPair,
  openFrame,
  pairProof,
  sealFrame,
  toBase64url,
  verifyDeviceSignature,
  verifyPairProof,
  webCryptoDeviceKey,
} from "@caveman-app/session-protocol/devices";

import { installWebCrypto, subtle } from "./webcrypto";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebCrypto's overloads, called loosely to compare the adapter with Node's */
type Loose = Record<
  | "digest"
  | "generateKey"
  | "importKey"
  | "exportKey"
  | "sign"
  | "verify"
  | "deriveBits"
  | "deriveKey"
  | "encrypt"
  | "decrypt",
  (...args: any[]) => Promise<any>
>;
/** The adapter, and the oracle: Node's WebCrypto, taken from node:crypto so nothing the adapter installs can stand in for it. */
const js = subtle as unknown as Loose;
const node = webcrypto.subtle as unknown as Loose;
const both = [
  ["the adapter signs, Node checks", js, node],
  ["Node signs, the adapter checks", node, js],
] as const;

const hex = (text: string) =>
  Uint8Array.from(text.replace(/\s+/g, "").match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes as ArrayBuffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const utf8 = (text: string) => new TextEncoder().encode(text);
const randomBytes = (length: number) => new Uint8Array(nodeRandomBytes(length));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ES256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** A P-256 private key as a JWK, from its scalar (Node's own curve arithmetic fills in the point). */
const jwkOf = (scalar: Uint8Array) => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey();
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64url(point.subarray(1, 33)),
    y: toBase64url(point.subarray(33, 65)),
    d: toBase64url(scalar),
  };
};
const publicOf = (jwk: { kty: string; crv: string; x: string; y: string }) => ({
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
});

describe("SHA-256", () => {
  it("is Node's for every length around a block, and the published vector", async () => {
    expect(toHex(await js.digest("SHA-256", utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = randomBytes(length);
      expect(toHex(await js.digest({ name: "SHA-256" }, data))).toBe(
        toHex(await node.digest("SHA-256", data)),
      );
    }
    // A view into a larger buffer is read where it points, not from the buffer's start.
    const wide = randomBytes(64);
    expect(toHex(await js.digest("SHA-256", wide.subarray(10, 30)))).toBe(
      toHex(await node.digest("SHA-256", wide.subarray(10, 30))),
    );
    expect(toHex(await js.digest("SHA-256", wide.buffer))).toBe(
      toHex(await node.digest("SHA-256", wide)),
    );
  });
});

describe("ECDSA P-256 with SHA-256", () => {
  for (const [name, signer, checker] of both) {
    it(`${name}: a key one made, as the other reads its JWK`, async () => {
      const pair = await signer.generateKey(ECDSA, true, ["sign", "verify"]);
      const jwk = await signer.exportKey("jwk", pair.publicKey);
      expect(Object.keys(publicOf(jwk)).every((k) => typeof jwk[k] === "string")).toBe(true);
      const theirs = await checker.importKey("jwk", publicOf(jwk), ECDSA, false, ["verify"]);
      for (const length of [0, 1, 32, 200, 5000]) {
        const data = randomBytes(length);
        const signature = new Uint8Array(await signer.sign(ES256, pair.privateKey, data));
        expect(signature.length).toBe(64);
        expect(await checker.verify(ES256, theirs, signature, data)).toBe(true);
        expect(await signer.verify(ES256, pair.publicKey, signature, data)).toBe(true);
        // One changed bit of the message or the signature, or the wrong key: no.
        const other = Uint8Array.from(data.length ? data : [0]);
        other[0] = other[0]! ^ 1;
        expect(await checker.verify(ES256, theirs, signature, other)).toBe(false);
        const bent = Uint8Array.from(signature);
        bent[40] = bent[40]! ^ 1;
        expect(await checker.verify(ES256, theirs, bent, data)).toBe(false);
      }
    });
  }

  it("the same private key gives the same public key, and each verifies what the other signed with it", async () => {
    const jwk = jwkOf(hex("c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721"));
    const mine = await js.importKey("jwk", jwk, ECDSA, true, ["sign"]);
    const theirs = await node.importKey("jwk", jwk, ECDSA, true, ["sign"]);
    const exported = await js.exportKey("jwk", mine);
    const oracle = await node.exportKey("jwk", theirs);
    expect({
      x: exported.x,
      y: exported.y,
      d: exported.d,
      kty: exported.kty,
      crv: exported.crv,
    }).toEqual({ x: oracle.x, y: oracle.y, d: oracle.d, kty: oracle.kty, crv: oracle.crv });
    const data = utf8("sample");
    const jsPublic = await js.importKey("jwk", publicOf(jwk), ECDSA, true, ["verify"]);
    const nodePublic = await node.importKey("jwk", publicOf(jwk), ECDSA, true, ["verify"]);
    expect(await node.verify(ES256, nodePublic, await js.sign(ES256, mine, data), data)).toBe(true);
    expect(await js.verify(ES256, jsPublic, await node.sign(ES256, theirs, data), data)).toBe(true);
    // RFC 6979 A.2.5 (P-256, SHA-256, "sample"): the adapter's nonce is the RFC's, so its signature is the RFC's.
    expect(toHex(await js.sign(ES256, mine, data))).toBe(
      "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
    );
    expect(
      await node.verify(
        ES256,
        nodePublic,
        hex(
          "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
        ),
        data,
      ),
    ).toBe(true);
  });

  it("takes what Node takes and refuses what Node refuses: a high s, a wrong length, a DER signature", async () => {
    const jwk = jwkOf(randomScalar());
    const data = utf8("the secret plan");
    const jsPublic = await js.importKey("jwk", publicOf(jwk), ECDSA, true, ["verify"]);
    const nodePublic = await node.importKey("jwk", publicOf(jwk), ECDSA, true, ["verify"]);
    const signature = new Uint8Array(
      await node.sign(ES256, await node.importKey("jwk", jwk, ECDSA, false, ["sign"]), data),
    );
    // The other s of the same signature (n - s): WebCrypto does not ask for the low one, so neither does the adapter.
    const n = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    const flipped = Uint8Array.from(signature);
    flipped.set(
      hex((n - BigInt(`0x${toHex(signature.subarray(32))}`)).toString(16).padStart(64, "0")),
      32,
    );
    const der = derOf(signature);
    for (const [candidate, expected] of [
      [signature, true],
      [flipped, true],
      [signature.subarray(0, 63), false],
      [new Uint8Array([...signature, 0]), false],
      [der, false],
      [new Uint8Array(64), false],
      [new Uint8Array(0), false],
    ] as const) {
      expect(await node.verify(ES256, nodePublic, candidate, data)).toBe(expected);
      expect(await js.verify(ES256, jsPublic, candidate, data)).toBe(expected);
    }
  });

  it("keeps a private key that was made non-extractable in, and reads only a real P-256 key", async () => {
    const pair = await js.generateKey(ECDSA, false, ["sign", "verify"]);
    await expect(js.exportKey("jwk", pair.privateKey)).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    // The key object says what it is and never its bytes.
    expect(Object.keys(pair.privateKey).sort()).toEqual([
      "algorithm",
      "extractable",
      "type",
      "usages",
    ]);
    expect(JSON.stringify(pair.privateKey)).not.toMatch(/"d"|[A-Za-z0-9_-]{40}/);
    expect(pair.privateKey).toMatchObject({
      type: "private",
      extractable: false,
      algorithm: { name: "ECDSA", namedCurve: "P-256" },
      usages: ["sign"],
    });
    expect(pair.publicKey).toMatchObject({ type: "public", extractable: true, usages: ["verify"] });
    const jwk = jwkOf(randomScalar());
    // A point off the curve, a private half that is not this public key's, another curve: refused, as Node refuses them.
    const off = { ...publicOf(jwk), y: toBase64url(randomBytes(32)) };
    await expect(js.importKey("jwk", off, ECDSA, true, ["verify"])).rejects.toMatchObject({
      name: "DataError",
    });
    await expect(node.importKey("jwk", off, ECDSA, true, ["verify"])).rejects.toThrow();
    const wrong = { ...jwk, d: toBase64url(randomScalar()) };
    await expect(js.importKey("jwk", wrong, ECDSA, true, ["sign"])).rejects.toMatchObject({
      name: "DataError",
    });
    await expect(node.importKey("jwk", wrong, ECDSA, true, ["sign"])).rejects.toThrow();
    await expect(
      js.importKey("jwk", { ...publicOf(jwk), crv: "P-384" }, ECDSA, true, ["verify"]),
    ).rejects.toThrow();
    await expect(
      js.importKey("jwk", publicOf(jwk), { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    // A key signs only when it may, and a public key never does.
    const verifyOnly = await js.importKey("jwk", jwk, ECDSA, true, []);
    await expect(js.sign(ES256, verifyOnly, utf8("x"))).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    await expect(js.sign(ES256, pair.publicKey, utf8("x"))).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    await expect(js.importKey("jwk", publicOf(jwk), ECDSA, true, ["sign"])).rejects.toMatchObject({
      name: "SyntaxError",
    });
  });
});

describe("ECDH P-256", () => {
  it("both sides reach the same secret whichever implementation holds which key", async () => {
    for (const [, a, b] of both) {
      const mine = await a.generateKey(ECDH, false, ["deriveBits"]);
      const theirs = await b.generateKey(ECDH, false, ["deriveBits"]);
      const myPoint = new Uint8Array(await a.exportKey("raw", mine.publicKey));
      const theirPoint = new Uint8Array(await b.exportKey("raw", theirs.publicKey));
      expect([myPoint.length, myPoint[0], theirPoint.length, theirPoint[0]]).toEqual([
        65, 4, 65, 4,
      ]);
      const here = await a.deriveBits(
        { name: "ECDH", public: await a.importKey("raw", theirPoint, ECDH, false, []) },
        mine.privateKey,
        256,
      );
      const there = await b.deriveBits(
        { name: "ECDH", public: await b.importKey("raw", myPoint, ECDH, false, []) },
        theirs.privateKey,
        256,
      );
      expect(toHex(here)).toBe(toHex(there));
      expect(new Uint8Array(here).length).toBe(32);
    }
  });

  it("derives RFC 5903's public key and shared secret from its two keys, as Node does", async () => {
    // RFC 5903 section 8.1: the initiator's private key and its point, the responder's point, and the x of their shared point.
    const scalar = hex("c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433");
    const own =
      "04dad0b65394221cf9b051e1feca5787d098dfe637fc90b9ef945d0c37725811805271a0461cdb8252d61f1c456fa3e59ab1f45b33accf5f58389e0577b8990bb3";
    const peer = hex(
      "04 d12dfb5289c8d4f81208b70270398c342296970a0bccb74c736fc7554494bf63 56fbf3ca366cc23e8157854c13c58d6aac23f046ada30f8353e74f33039872ab",
    );
    const shared = "d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de";
    for (const impl of [js, node]) {
      const key = await impl.importKey("jwk", jwkOf(scalar), ECDH, true, ["deriveBits"]);
      const jwk = await impl.exportKey("jwk", key);
      expect(
        `04${toHex(Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))}${toHex(Uint8Array.from(atob(jwk.y.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))}`,
      ).toBe(own);
      expect(
        toHex(
          await impl.deriveBits(
            { name: "ECDH", public: await impl.importKey("raw", peer, ECDH, false, []) },
            key,
            256,
          ),
        ),
      ).toBe(shared);
    }
  });

  it("refuses a point that is not on the curve, a compressed one, and a key that may not derive", async () => {
    const off = new Uint8Array(65);
    off[0] = 4;
    off.set(randomBytes(64), 1);
    await expect(js.importKey("raw", off, ECDH, false, [])).rejects.toMatchObject({
      name: "DataError",
    });
    await expect(node.importKey("raw", off, ECDH, false, [])).rejects.toThrow();
    await expect(js.importKey("raw", randomBytes(33), ECDH, false, [])).rejects.toMatchObject({
      name: "DataError",
    });
    const signing = await js.generateKey(ECDSA, false, ["sign", "verify"]);
    const other = await js.generateKey(ECDH, false, ["deriveBits"]);
    await expect(
      js.deriveBits({ name: "ECDH", public: other.publicKey }, signing.privateKey, 256),
    ).rejects.toMatchObject({ name: "InvalidAccessError" });
    await expect(
      js.deriveBits({ name: "ECDH", public: signing.publicKey }, other.privateKey, 256),
    ).rejects.toMatchObject({ name: "InvalidAccessError" });
  });
});

describe("HKDF-SHA256", () => {
  it("derives RFC 5869's test vector and Node's bytes for any salt, info and length", async () => {
    const material = (impl: Loose, ikm: Uint8Array) =>
      impl.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
    // RFC 5869 A.1.
    const ikm = hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
    const params = {
      name: "HKDF",
      hash: "SHA-256",
      salt: hex("000102030405060708090a0b0c"),
      info: hex("f0f1f2f3f4f5f6f7f8f9"),
    };
    const okm =
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";
    expect(toHex(await js.deriveBits(params, await material(js, ikm), 336))).toBe(okm);
    expect(toHex(await node.deriveBits(params, await material(node, ikm), 336))).toBe(okm);
    for (const [salt, info, bits] of [
      [0, 0, 256],
      [32, 100, 256],
      [16, 3, 8],
      [64, 300, 1024],
    ] as const) {
      const secret = randomBytes(32);
      const p = { name: "HKDF", hash: "SHA-256", salt: randomBytes(salt), info: randomBytes(info) };
      expect(toHex(await js.deriveBits(p, await material(js, secret), bits))).toBe(
        toHex(await node.deriveBits(p, await material(node, secret), bits)),
      );
    }
    await expect(js.importKey("raw", ikm, "HKDF", true, ["deriveBits"])).rejects.toMatchObject({
      name: "SyntaxError",
    });
    await expect(
      js.deriveBits({ ...params, hash: "SHA-1" }, await material(js, ikm), 256),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
  });

  it("derives the AES-256-GCM key Node derives: what one seals under it the other opens", async () => {
    const secret = randomBytes(32);
    const params = {
      name: "HKDF",
      hash: "SHA-256",
      salt: randomBytes(32),
      info: utf8("caveman-device-v1 device-to-runtime"),
    };
    const keyOf = async (impl: Loose) =>
      impl.deriveKey(
        params,
        await impl.importKey("raw", secret, "HKDF", false, ["deriveKey"]),
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    const [mine, theirs] = [await keyOf(js), await keyOf(node)];
    expect(mine).toMatchObject({
      type: "secret",
      extractable: false,
      algorithm: { name: "AES-GCM", length: 256 },
      usages: ["encrypt", "decrypt"],
    });
    await expect(js.exportKey("raw", mine)).rejects.toMatchObject({ name: "InvalidAccessError" });
    const gcm = {
      name: "AES-GCM",
      iv: randomBytes(12),
      additionalData: utf8("aad"),
      tagLength: 128,
    };
    const text = utf8("the secret plan");
    expect(toHex(await node.decrypt(gcm, theirs, await js.encrypt(gcm, mine, text)))).toBe(
      toHex(text),
    );
    expect(toHex(await js.decrypt(gcm, mine, await node.encrypt(gcm, theirs, text)))).toBe(
      toHex(text),
    );
  });
});

describe("AES-256-GCM", () => {
  it("is Node's byte for byte, the tag after the ciphertext, and the published vector", async () => {
    // The GCM specification's test case 14: a zero key and nonce, one zero block.
    const zero = { name: "AES-GCM", iv: new Uint8Array(12), tagLength: 128 };
    for (const impl of [js, node]) {
      const key = await impl.importKey("raw", new Uint8Array(32), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      expect(toHex(await impl.encrypt(zero, key, new Uint8Array(16)))).toBe(
        "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919",
      );
    }
    for (const length of [0, 1, 15, 16, 17, 255, 4096, 100_000]) {
      const raw = randomBytes(32);
      const params = {
        name: "AES-GCM",
        iv: randomBytes(12),
        additionalData: randomBytes(length % 40),
        tagLength: 128,
      };
      const mine = await js.importKey("raw", raw, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
      const theirs = await node.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      const text = randomBytes(length);
      const sealed = new Uint8Array(await js.encrypt(params, mine, text));
      expect(sealed.length).toBe(length + 16);
      expect(toHex(sealed)).toBe(toHex(await node.encrypt(params, theirs, text)));
      expect(toHex(await node.decrypt(params, theirs, sealed))).toBe(toHex(text));
      expect(toHex(await js.decrypt(params, mine, await node.encrypt(params, theirs, text)))).toBe(
        toHex(text),
      );
    }
  });

  it("opens nothing that was changed: a bit of the ciphertext or tag, the nonce, the associated data, the key", async () => {
    const raw = randomBytes(32);
    const params = {
      name: "AES-GCM",
      iv: randomBytes(12),
      additionalData: utf8("caveman-device-v1\nto_runtime\n1"),
      tagLength: 128,
    };
    const text = utf8('{"jsonrpc":"2.0","id":1,"method":"turn.submit"}');
    for (const [, sealer, opener] of both) {
      const sealed = new Uint8Array(
        await sealer.encrypt(
          params,
          await sealer.importKey("raw", raw, "AES-GCM", false, ["encrypt"]),
          text,
        ),
      );
      const key = await opener.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      for (const at of [0, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
        const bent = Uint8Array.from(sealed);
        bent[at] = bent[at]! ^ 1;
        await expect(opener.decrypt(params, key, bent)).rejects.toThrow();
      }
      await expect(
        opener.decrypt({ ...params, iv: randomBytes(12) }, key, sealed),
      ).rejects.toThrow();
      await expect(
        opener.decrypt(
          { ...params, additionalData: utf8("caveman-device-v1\nto_runtime\n2") },
          key,
          sealed,
        ),
      ).rejects.toThrow();
      await expect(
        opener.decrypt({ name: "AES-GCM", iv: params.iv, tagLength: 128 }, key, sealed),
      ).rejects.toThrow();
      await expect(
        opener.decrypt(
          params,
          await opener.importKey("raw", randomBytes(32), "AES-GCM", false, ["decrypt"]),
          sealed,
        ),
      ).rejects.toThrow();
      await expect(opener.decrypt(params, key, sealed.subarray(0, 10))).rejects.toThrow();
    }
    await expect(
      js.decrypt(
        params,
        await js.importKey("raw", raw, "AES-GCM", false, ["decrypt"]),
        randomBytes(40),
      ),
    ).rejects.toMatchObject({ name: "OperationError" });
    // A key made to seal does not open, and only a 256-bit key, a 96-bit nonce and a 128-bit tag are AES-GCM here.
    const sealOnly = await js.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    await expect(js.decrypt(params, sealOnly, randomBytes(40))).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    await expect(
      js.importKey("raw", randomBytes(16), "AES-GCM", false, ["encrypt"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(
      js.encrypt({ ...params, iv: randomBytes(16) }, sealOnly, text),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(js.encrypt({ ...params, tagLength: 96 }, sealOnly, text)).rejects.toMatchObject({
      name: "NotSupportedError",
    });
  });
});

describe("HMAC-SHA256", () => {
  it("is RFC 4231's, and each checks the other's", async () => {
    const algorithm = { name: "HMAC", hash: "SHA-256" };
    // RFC 4231 test case 2.
    const jefe = await js.importKey("raw", utf8("Jefe"), algorithm, false, ["sign", "verify"]);
    expect(toHex(await js.sign("HMAC", jefe, utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    for (const [, signer, checker] of both) {
      for (const keyLength of [1, 12, 32, 64, 65, 200]) {
        const raw = randomBytes(keyLength);
        const data = randomBytes(keyLength * 7);
        const mac = new Uint8Array(
          await signer.sign(
            "HMAC",
            await signer.importKey("raw", raw, algorithm, false, ["sign"]),
            data,
          ),
        );
        expect(mac.length).toBe(32);
        const key = await checker.importKey("raw", raw, algorithm, false, ["verify"]);
        expect(await checker.verify("HMAC", key, mac, data)).toBe(true);
        const bent = Uint8Array.from(mac);
        bent[31] = bent[31]! ^ 1;
        expect(await checker.verify("HMAC", key, bent, data)).toBe(false);
        expect(await checker.verify("HMAC", key, mac.subarray(0, 31), data)).toBe(false);
        expect(await checker.verify("HMAC", key, mac, new Uint8Array([...data, 0]))).toBe(false);
      }
    }
    await expect(
      js.importKey("raw", utf8("k"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
  });
});

describe("only what the protocol uses", () => {
  it("refuses every other algorithm, and a key it did not make", async () => {
    await expect(js.digest("SHA-1", utf8("x"))).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    await expect(js.digest("SHA-512", utf8("x"))).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    await expect(
      js.generateKey(
        {
          name: "RSA-PSS",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        false,
        ["sign"],
      ),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(
      js.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(js.generateKey({ name: "Ed25519" }, false, ["sign"])).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    await expect(
      js.importKey("raw", randomBytes(32), "AES-CBC", false, ["encrypt"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    await expect(
      js.importKey("pkcs8", randomBytes(32), ECDSA, false, ["sign"]),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    const theirs = await node.generateKey(ECDSA, false, ["sign", "verify"]);
    await expect(js.sign(ES256, theirs.privateKey, utf8("x"))).rejects.toThrow(TypeError);
    await expect(js.exportKey("jwk", theirs.publicKey)).rejects.toThrow(TypeError);
    expect(Object.keys(subtle).sort()).toEqual([
      "decrypt",
      "deriveBits",
      "deriveKey",
      "digest",
      "encrypt",
      "exportKey",
      "generateKey",
      "importKey",
      "sign",
      "verify",
    ]);
  });
});

describe("the protocol across the two", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  afterEach(() => Object.defineProperty(globalThis, "crypto", real));
  /** Runs the protocol's own functions on the adapter (a phone) or on Node's WebCrypto (a Mac). */
  const on = async <T>(side: "phone" | "mac", run: () => Promise<T>): Promise<T> => {
    Object.defineProperty(globalThis, "crypto", real);
    if (side === "phone") installWebCrypto({ force: true });
    try {
      return await run();
    } finally {
      Object.defineProperty(globalThis, "crypto", real);
    }
  };

  it("a device key made on the adapter has the id and the code Node gives its public key (RFC 7638)", async () => {
    const pair = await on("phone", newDeviceKeyPair);
    const phoneId = await on("phone", () => deviceIdOf(pair.public_key));
    expect(await on("mac", () => deviceIdOf(pair.public_key))).toBe(phoneId);
    // The thumbprint by hand: SHA-256 over the canonical JWK, members in order, no spaces.
    const canonical = `{"crv":"P-256","kty":"EC","x":"${pair.public_key.x}","y":"${pair.public_key.y}"}`;
    expect(phoneId).toBe(
      toBase64url(new Uint8Array(await node.digest("SHA-256", utf8(canonical)))),
    );
    expect(phoneId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deviceCode(phoneId)).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{3}){3}$/);
    // And a key neither made (RFC 7517 appendix A.1's P-256 key): the same id on both.
    const known = {
      kty: "EC",
      crv: "P-256",
      x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
      y: "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
    } as const;
    expect(await on("phone", () => deviceIdOf(known))).toBe(
      await on("mac", () => deviceIdOf(known)),
    );
  });

  it("a Mac on Node's WebCrypto verifies the phone's hello, both reach the same frame keys, and each opens what the other sealed", async () => {
    const device = await on("phone", async () =>
      webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone" }),
    );
    const mac = await on("mac", ephemeralKey);
    const phone = await on("phone", ephemeralKey);
    const bind = {
      runtime_id: "rt-1",
      nonce: toBase64url(randomBytes(32)),
      runtime_key: mac.public_key,
      device_key: phone.public_key,
    };
    const payload = helloPayload({ ...bind, v2: { kind: "device", name: device.name } });
    const signature = toBase64url(await on("phone", () => device.sign(payload)));
    expect(
      await on("mac", () => verifyDeviceSignature(device.public_key, payload, signature)),
    ).toBe(true);
    expect(
      await on("mac", () =>
        verifyDeviceSignature(
          device.public_key,
          helloPayload({ ...bind, runtime_id: "rt-2", v2: { kind: "device", name: device.name } }),
          signature,
        ),
      ),
    ).toBe(false);
    // And the other way: the phone verifies what a Mac's key signed (a statement's signature).
    const desktop = await on("mac", async () =>
      webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "Studio", kind: "mac" }),
    );
    const signed = toBase64url(await on("mac", () => desktop.sign(payload)));
    expect(
      await on("phone", () => verifyDeviceSignature(desktop.public_key, payload, signed)),
    ).toBe(true);
    expect(await on("phone", () => verifyDeviceSignature(device.public_key, payload, signed))).toBe(
      false,
    );

    const phoneKeys = await on("phone", () =>
      channelKeys({ ...bind, privateKey: phone.privateKey, peer_key: mac.public_key }),
    );
    const macKeys = await on("mac", () =>
      channelKeys({ ...bind, privateKey: mac.privateKey, peer_key: phone.public_key }),
    );
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "turn.submit",
      params: { input: { text: "the secret plan" } },
    });
    for (let seq = 1; seq <= 3; seq++) {
      const sealed = await on("phone", () =>
        sealFrame(phoneKeys.to_runtime, seq, call, "to_runtime"),
      );
      expect(sealed).not.toContain("secret");
      expect(await on("mac", () => openFrame(macKeys.to_runtime, seq, sealed, "to_runtime"))).toBe(
        call,
      );
      // Another place in the sequence, the other direction: nothing, on either implementation.
      expect(
        await on("mac", () => openFrame(macKeys.to_runtime, seq + 1, sealed, "to_runtime")),
      ).toBeUndefined();
      expect(
        await on("phone", () => openFrame(phoneKeys.to_device, seq, sealed, "to_device")),
      ).toBeUndefined();
      const reply = JSON.stringify({ jsonrpc: "2.0", id: seq, result: { text: "file contents" } });
      const back = await on("mac", () => sealFrame(macKeys.to_device, seq, reply, "to_device"));
      expect(await on("phone", () => openFrame(phoneKeys.to_device, seq, back, "to_device"))).toBe(
        reply,
      );
      // One changed bit, or the same frame at the next place (a replay): the phone opens neither.
      const frame = JSON.parse(back) as { device_frame: { seq: number; ct: string } };
      const bent = frame.device_frame.ct.replace(/^./, (c) => (c === "A" ? "B" : "A"));
      expect(
        await on("phone", () =>
          openFrame(
            phoneKeys.to_device,
            seq,
            JSON.stringify({ device_frame: { seq, ct: bent } }),
            "to_device",
          ),
        ),
      ).toBeUndefined();
      expect(
        await on("phone", () =>
          openFrame(
            phoneKeys.to_device,
            seq + 1,
            JSON.stringify({ device_frame: { seq: seq + 1, ct: frame.device_frame.ct } }),
            "to_device",
          ),
        ),
      ).toBeUndefined();
    }
  });

  it("a pairing proof made on one checks on the other, for that code, key and hello only", async () => {
    const hello = helloPayload({
      runtime_id: "rt-1",
      nonce: "n",
      runtime_key: "R",
      device_key: "D",
      v2: { kind: "mac", name: "Studio" },
    });
    const id = toBase64url(randomBytes(32));
    for (const [maker, checker] of [
      ["phone", "mac"],
      ["mac", "phone"],
    ] as const) {
      const proof = await on(maker, () => pairProof("4F2K-9QMW-3XH7", id, hello));
      expect(await on(checker, () => verifyPairProof("4f2k 9qmw 3xh7", id, hello, proof))).toBe(
        true,
      );
      expect(await on(checker, () => verifyPairProof("4F2K-9QMW-3XH8", id, hello, proof))).toBe(
        false,
      );
      expect(
        await on(checker, () =>
          verifyPairProof("4F2K-9QMW-3XH7", toBase64url(randomBytes(32)), hello, proof),
        ),
      ).toBe(false);
    }
  });
});

describe("installing it", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  afterEach(() => Object.defineProperty(globalThis, "crypto", real));

  it("leaves a platform's own WebCrypto alone unless forced, and takes the random source it is given", async () => {
    const own = globalThis.crypto;
    expect(installWebCrypto()).toBe(false);
    expect(globalThis.crypto).toBe(own);
    let asked = 0;
    const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
      asked++;
      return webcrypto.getRandomValues(array as unknown as Uint8Array) as unknown as T;
    };
    expect(installWebCrypto({ force: true, getRandomValues })).toBe(true);
    expect(globalThis.crypto.subtle).toBe(subtle);
    const pair = await globalThis.crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"]);
    expect(asked).toBe(1);
    expect((pair as { privateKey: { type: string } }).privateKey.type).toBe("private");
    const ids = new Set(Array.from({ length: 50 }, () => globalThis.crypto.randomUUID()));
    expect(ids.size).toBe(50);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("puts WebCrypto where there is none (a phone), on the platform's random source, and says so when it has none", async () => {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => installWebCrypto()).toThrow(/random source/);
    expect(
      installWebCrypto({
        getRandomValues: (array) =>
          webcrypto.getRandomValues(array as unknown as Uint8Array) as unknown as typeof array,
      }),
    ).toBe(true);
    const pair = await newDeviceKeyPair();
    const device = await webCryptoDeviceKey({ ...pair, name: "iPhone" });
    expect(
      await verifyDeviceSignature(
        device.public_key,
        utf8("hello"),
        toBase64url(await device.sign(utf8("hello"))),
      ),
    ).toBe(true);
    // A getRandomValues-only crypto (some React Native set-ups) gets subtle added, keeping its random source.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array) },
      configurable: true,
      writable: true,
    });
    expect(installWebCrypto()).toBe(true);
    expect((await newDeviceKeyPair()).public_key.crv).toBe("P-256");
  });
});

function randomScalar(): Uint8Array {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();
  const out = new Uint8Array(32);
  out.set(scalar, 32 - scalar.length);
  return out;
}

/** A 64-byte r||s signature as ASN.1 DER, the form WebCrypto does not take. */
function derOf(signature: Uint8Array): Uint8Array {
  const part = (bytes: Uint8Array) => {
    let at = 0;
    while (at < bytes.length - 1 && bytes[at] === 0) at++;
    const body = bytes[at]! & 0x80 ? [0, ...bytes.subarray(at)] : [...bytes.subarray(at)];
    return [2, body.length, ...body];
  };
  const body = [...part(signature.subarray(0, 32)), ...part(signature.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
