// The desktop app's own device key (DESIGN S13): when this app drives another Mac through Caveman Cloud, that Mac
// asks it to sign a challenge. A P-256 key made here once, its private half sealed with the system keychain
// (Electron's safeStorage) in <userData>/device-key.bin, never in the clear on disk and never handed to the page. The
// page asks main to sign, and main signs only device-approval payloads, so the key is no general-purpose signer.
// Electron-free: main passes safeStorage in.
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

import { DEVICE_CALL_CONTEXT, DEVICE_CONTEXT, DEVICE_HELLO_V2, DEVICE_STATEMENT_CONTEXT, cleanDeviceName, publicKeyOf, type DevicePublicKey } from "@caveman-app/session-protocol/devices";
import { writeFileStaged } from "./stagedWrite.ts";

/** Electron's safeStorage, the part used here. */
export interface SealedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(sealed: Buffer): string;
}

/**
 * A P-256 key kept in `file`, its private half sealed with `storage` (never in the clear on disk): read back, or made
 * once when there is none, or the one there does not unseal (another keychain's, a copied profile) or is no P-256 key.
 */
export function sealedP256Key(file: string, storage: SealedStorage): KeyObject {
  if (existsSync(file)) {
    try {
      const key = createPrivateKey(storage.decryptString(readFileSync(file)));
      if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return key;
    } catch {
      // Made again below.
    }
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileStaged(file, storage.encryptString(privateKey.export({ format: "pem", type: "pkcs8" }).toString()), { mode: 0o600 });
  return privateKey;
}

/** This Mac's name as the person set it (System Settings > General > Sharing), else its host name. */
export function macName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (name) return cleanDeviceName(name);
    } catch {
      // Fall back to the host name.
    }
  }
  return cleanDeviceName(hostname().replace(/\.local$/, ""));
}

/**
 * What this key signs: device.hello payloads (v1, and v2 with its kind and name), queued calls and moves, and the
 * statements by which this Mac allows or removes a device for the person's other Macs (session-protocol devices.ts
 * helloPayload, callPayload, statementPayload). It signs those only from the app's own frames (assets.ts isOwnFrame),
 * never from a page Cloud serves.
 */
const SIGNABLE = [`${DEVICE_CONTEXT}\n`, `${DEVICE_HELLO_V2}\n`, `${DEVICE_CALL_CONTEXT}\n`, `${DEVICE_STATEMENT_CONTEXT}\n`];

export class DesktopDeviceKey {
  private key: KeyObject | undefined;
  private readonly file: string;
  private readonly storage: SealedStorage;
  private readonly name: string;

  constructor(file: string, storage: SealedStorage, name: string) {
    this.file = file;
    this.storage = storage;
    this.name = cleanDeviceName(name);
  }

  /** False where the system keychain cannot seal it (then the page keeps its own WebCrypto key instead). */
  available(): boolean {
    return this.storage.isEncryptionAvailable();
  }

  private privateKey(): KeyObject {
    // A key sealed by another keychain (a copied profile) or damaged is made again: Macs ask to allow it again.
    return (this.key ??= sealedP256Key(this.file, this.storage));
  }

  describe(): { readonly name: string; readonly public_key: DevicePublicKey } {
    const public_key = publicKeyOf(createPublicKey(this.privateKey()).export({ format: "jwk" }));
    if (!public_key) throw new Error("the device key is not a P-256 key");
    return { name: this.name, public_key };
  }

  /** ECDSA P-256 SHA-256, r||s: only over a device-approval payload (a hello, a call or move for a Mac, a statement). */
  sign(data: Uint8Array): Uint8Array {
    const bytes = Buffer.from(data);
    if (!SIGNABLE.some((prefix) => bytes.subarray(0, prefix.length).equals(Buffer.from(prefix)))) throw new Error("this key signs device approvals only");
    return new Uint8Array(sign("sha256", bytes, { key: this.privateKey(), dsaEncoding: "ieee-p1363" }));
  }
}
