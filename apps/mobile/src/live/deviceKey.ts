// This phone's own key for driving a Mac through Caveman Cloud (DESIGN S13; the wire is session-protocol devices.ts):
// a P-256 signing key made here on first use, whose id (its RFC 7638 thumbprint) and comparison code are what each Mac
// allows once, on its own screen. It is made on the phone and never leaves it: it is not sent to Cloud, a Mac sees
// only its public half, and it is kept in the phone's Keychain or Keystore (SecretStore, native.ts), bound to this
// device, so a backup or another phone never holds it. A Mac's Remove of this phone is the way to take it away.
//
// The phone's WebCrypto is JavaScript (webcrypto.ts), so unlike a browser's key this one's private half is readable by
// the app's own code while it signs. It is read from the Keychain into a key the WebCrypto API will not export, and
// nothing else in the app reads that entry.
import {
  publicKeyOf,
  webCryptoDeviceKey,
  type DeviceKey,
} from "@caveman-app/session-protocol/devices";

import type { SecretStore } from "./cloud.ts";

const KEY = "caveman.device.key";
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

type Jwk = { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; d?: unknown };

/** The key in `secrets`, made (and kept before it is ever used) when there is none or it does not read back. */
export async function loadDeviceKey(secrets: SecretStore, name: string): Promise<DeviceKey> {
  const subtle = globalThis.crypto.subtle;
  const use = async (jwk: Jwk): Promise<DeviceKey | undefined> => {
    const public_key = publicKeyOf(jwk);
    if (!public_key || typeof jwk.d !== "string") return undefined;
    const privateKey = await subtle
      .importKey("jwk", { ...public_key, d: jwk.d }, ECDSA, false, ["sign"])
      .catch(() => undefined);
    return privateKey ? webCryptoDeviceKey({ privateKey, public_key, name }) : undefined;
  };
  const stored = await secrets.get(KEY);
  if (stored !== null) {
    let jwk: Jwk | null = null;
    try {
      jwk = JSON.parse(stored) as Jwk | null;
    } catch {
      jwk = null;
    }
    const kept = jwk ? await use(jwk) : undefined;
    if (kept) return kept;
  }
  // A new device: every Mac asks its person about it. Extractable only for this one export into the Keychain.
  const pair = (await subtle.generateKey(ECDSA, true, ["sign", "verify"])) as {
    readonly privateKey: Parameters<typeof subtle.exportKey>[1];
  };
  const jwk = (await subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  const made = await use(jwk);
  if (!made) throw new Error("this phone could not make a device key");
  await secrets.set(
    KEY,
    JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }),
  );
  return made;
}

/** One key for the app: `load` runs once, and again only after it failed (a locked Keychain is tried again). */
export function deviceKeyOnce(load: () => Promise<DeviceKey>): () => Promise<DeviceKey> {
  let mine: Promise<DeviceKey> | undefined;
  return () => {
    mine ??= load();
    mine.catch(() => (mine = undefined));
    return mine;
  };
}
