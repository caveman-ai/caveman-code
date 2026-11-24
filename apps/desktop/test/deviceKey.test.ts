import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { deviceIdOf, helloPayload, newDeviceKeyPair, signStatement, toBase64url, verifyDeviceSignature, verifyStatement, webCryptoDeviceKey } from "@caveman-app/session-protocol/devices";

import { DesktopDeviceKey, type SealedStorage } from "../src/deviceKey.ts";

/** A stand-in keychain: reversible, but never the plain text on disk. */
const keychain = (available = true): SealedStorage & { sealed: number } => {
  const storage = {
    sealed: 0,
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => {
      storage.sealed++;
      return Buffer.from(Buffer.from(text).map((b) => b ^ 0x5a));
    },
    decryptString: (sealed: Buffer) => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString(),
  };
  return storage;
};

test("the desktop's device key is made once, sealed on disk, and signs device approvals a Mac can check", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-device-key-")), "device-key.bin");
  const storage = keychain();
  const key = new DesktopDeviceKey(file, storage, "Caveman Code on Studio\n");
  const { name, public_key } = key.describe();
  expect(name).toBe("Caveman Code on Studio");
  // Windows has no POSIX modes: the file is private through the user profile's ACL.
  if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  expect(readFileSync(file, "utf8")).not.toContain("PRIVATE KEY");
  // A restart reads the same key back.
  const again = new DesktopDeviceKey(file, storage, "Caveman Code on Studio");
  expect(await deviceIdOf(again.describe().public_key)).toBe(await deviceIdOf(public_key));
  expect(storage.sealed).toBe(1);

  const payload = helloPayload({ runtime_id: "rt-1", nonce: "bm9uY2U", runtime_key: "R", device_key: "D" });
  const signature = toBase64url(again.sign(payload));
  expect(await verifyDeviceSignature(public_key, payload, signature)).toBe(true);
  expect(await verifyDeviceSignature(public_key, helloPayload({ runtime_id: "rt-2", nonce: "bm9uY2U", runtime_key: "R", device_key: "D" }), signature)).toBe(false);
});

test("the key signs nothing but device approvals, and says when the keychain cannot keep it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-device-key-")), "device-key.bin");
  const key = new DesktopDeviceKey(file, keychain(), "Studio");
  for (const allowed of ["caveman-device-v1\n", "caveman-device-v2\n", "caveman-device-call-v1\n", "caveman-device-statement-v1\n"])
    expect(() => key.sign(new TextEncoder().encode(`${allowed}anything`))).not.toThrow();
  for (const refused of ["caveman-device-v3\nanything", "caveman-device-v2", "caveman-device-statement-v2\nanything", "caveman-device-statement-v1anything", "GET /api/v1/code/chats"])
    expect(() => key.sign(new TextEncoder().encode(refused))).toThrow(/device approvals only/);
  expect(new DesktopDeviceKey(file, keychain(false), "Studio").available()).toBe(false);
});

test("as a Mac's desktop key it signs a v2 hello and a statement the person's other Macs verify", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-device-key-")), "device-key.bin");
  const key = new DesktopDeviceKey(file, keychain(), "Studio");
  const { name, public_key } = key.describe();
  const desktop = { device_id: await deviceIdOf(public_key), name, public_key, kind: "mac" as const, sign: async (data: Uint8Array) => key.sign(data) };
  const v2 = helloPayload({ runtime_id: "rt-1", nonce: "bm9uY2U", runtime_key: "R", device_key: "D", v2: { kind: "mac", name } });
  expect(await verifyDeviceSignature(public_key, v2, toBase64url(key.sign(v2)))).toBe(true);
  const phone = await webCryptoDeviceKey({ ...(await newDeviceKeyPair()), name: "iPhone, Safari" });
  const statement = await signStatement(desktop, { kind: "allow", organization_id: "org-1", user_id: "user-1", device_id: phone.device_id, public_key: phone.public_key, name: phone.name, role: "device" });
  expect(await verifyStatement(statement)).toEqual(statement);
});
