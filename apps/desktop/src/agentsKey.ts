// This Mac's agents key (session-protocol macMail.ts; THREAT-MODEL T16-T21): the P-256 key this Mac's chats sign mail
// to the person's other Macs with. Not the device key (deviceKey.ts), which never leaves main and signs device
// approvals only: this one is handed to the app's own runtime, on the private bootstrap descriptor (fd 3) and nowhere
// else, never in the environment or argv, so the runtime keeps it in memory and an engine's tools cannot read it from
// a file. Made here once, its private half sealed with the system keychain (Electron's safeStorage) in
// <userData>/agents-key.bin. The Mac's screen vouches for it with the device key (device.vouch), so the person's other
// Macs take mail it signs while they trust this Mac. Electron-free: main passes safeStorage in.
import type { KeyObject } from "node:crypto";

import { sealedP256Key, type SealedStorage } from "./deviceKey.ts";

export class DesktopAgentsKey {
  private key: KeyObject | undefined;
  private readonly file: string;
  private readonly storage: SealedStorage;

  constructor(file: string, storage: SealedStorage) {
    this.file = file;
    this.storage = storage;
  }

  /**
   * The key as PKCS#8 PEM for the runtime's bootstrap, made on first use; undefined where the keychain cannot seal it
   * (then this Mac sends and takes no mail between the person's Macs).
   */
  pem(): string | undefined {
    try {
      if (!this.storage.isEncryptionAvailable()) return undefined;
      return this.privateKey().export({ format: "pem", type: "pkcs8" }).toString();
    } catch {
      return undefined;
    }
  }

  /**
   * pem() for each runtime start's bootstrap descriptor, once `sealable` resolves: Electron's keychain seals and unseals
   * nothing before `ready`, and the app starts its runtime before that, so the first start's descriptor waits for it
   * (src/runtime.ts) rather than going without the key until a restart.
   */
  forBootstrap(sealable: () => Promise<unknown>): () => Promise<string | undefined> {
    return async () => {
      await sealable();
      return this.pem();
    };
  }

  private privateKey(): KeyObject {
    // A key sealed by another keychain (a copied profile) or damaged is made again: the screen vouches for it again.
    return (this.key ??= sealedP256Key(this.file, this.storage));
  }
}
