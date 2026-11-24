import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { DesktopAgentsKey } from "../src/agentsKey.ts";
import type { SealedStorage } from "../src/deviceKey.ts";
import { bootstrapEnvelope, RuntimeSupervisor } from "../src/runtime.ts";

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

test("the agents key is made once, sealed on disk, and is a P-256 key", () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-agents-key-")), "agents-key.bin");
  const storage = keychain();
  const pem = new DesktopAgentsKey(file, storage).pem()!;
  expect(pem).toContain("PRIVATE KEY");
  expect(readFileSync(file, "utf8")).not.toContain("PRIVATE KEY");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  // A restart reads the same key back, and makes none.
  expect(new DesktopAgentsKey(file, storage).pem()).toBe(pem);
  expect(storage.sealed).toBe(1);
  // What the runtime takes as a signer (packages/runtime session-protocol/agentsKey.ts).
  expect(createPrivateKey(pem).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  // Sealed by another keychain or damaged: a new one (the screen vouches for it again).
  writeFileSync(file, "garbage");
  expect(new DesktopAgentsKey(file, storage).pem()).not.toBe(pem);
});

test("no keychain, no agents key: the runtime then sends and takes no mail between Macs", () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-agents-key-")), "agents-key.bin");
  expect(new DesktopAgentsKey(file, keychain(false)).pem()).toBeUndefined();
});

test("the key rides the bootstrap descriptor only when there is one", () => {
  expect(bootstrapEnvelope(1234, "tok", undefined, "PEM")).toMatchObject({ agentsKey: "PEM", desktopBootstrapToken: "tok" });
  expect(bootstrapEnvelope(1234, "tok")).not.toHaveProperty("agentsKey");
});

test("first launch, no key sealed yet: the runtime's first start gets the agents key once the keychain can seal", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-agents-key-")), "agents-key.bin");
  // Electron's safeStorage seals nothing before `ready`, which comes after the app has spawned its runtime.
  let ready = false;
  let markReady!: () => void;
  const whenReady = new Promise<void>((resolve) => (markReady = resolve));
  const storage = { ...keychain(), isEncryptionAvailable: () => ready };
  const key = new DesktopAgentsKey(file, storage);
  const fixture = fileURLToPath(new URL("./fixture-runtime.mjs", import.meta.url));
  const lines: string[] = [];
  const supervisor = await RuntimeSupervisor.create(
    { command: process.execPath, args: [fixture, "--bootstrap-fd", "3"], env: process.env, cwd: process.cwd() },
    (line) => lines.push(line),
    { agentsKey: key.forBootstrap(() => whenReady) },
  );
  try {
    supervisor.start();
    setTimeout(() => {
      ready = true;
      markReady();
    }, 300);
    await supervisor.waitReady(10_000);
    expect(existsSync(file)).toBe(true);
    const sealed = createPublicKey(key.pem()!).export({ format: "jwk" });
    expect(lines).toContain(`runtime: fixture runtime agents key ${sealed.x}`);
  } finally {
    await supervisor.stop();
  }
});
