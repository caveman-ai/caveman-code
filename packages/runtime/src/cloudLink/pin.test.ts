// CAVEMAN_CLOUD_URL pins This Mac to one Cloud: an enrollment or sign-in kept for another reads as none, so nothing
// is sent to it; a value that is no Cloud URL pins to nothing usable; a Cloud computer is never pinned.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";

import { makeAccountStore } from "../session-protocol/account.ts";
import { HOSTED_CLOUD } from "./hosted.ts";
import { KEY_FILE, pinAllows, pinnedCloud, readIdentity, RECORD_FILE } from "./identity.ts";

const saved = { pin: process.env.CAVEMAN_CLOUD_URL, tools: process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS };
afterEach(() => {
  for (const [name, value] of [["CAVEMAN_CLOUD_URL", saved.pin], ["CAVEMAN_RUNTIME_TOOLS_ADDRESS", saved.tools]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const enrolledWith = (cloudUrl: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-pin-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, KEY_FILE), privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ cloud_url: cloudUrl, runtime_id: randomUUID(), organization_id: randomUUID(), computer_id: randomUUID() }));
  return dir;
};

test("the pin is an origin, or the raw value when it is none, and never on a Cloud computer", () => {
  expect(pinnedCloud({})).toBeUndefined();
  expect(pinnedCloud({ CAVEMAN_CLOUD_URL: "  " })).toBeUndefined();
  expect(pinnedCloud({ CAVEMAN_CLOUD_URL: "https://app.customer.example/" })).toEqual({ cloudUrl: "https://app.customer.example", valid: true });
  expect(pinnedCloud({ CAVEMAN_CLOUD_URL: "http://app.customer.example" })).toEqual({ cloudUrl: "http://app.customer.example", valid: false });
  expect(pinnedCloud({ CAVEMAN_CLOUD_URL: "https://app.customer.example", CAVEMAN_RUNTIME_TOOLS_ADDRESS: "/run/tools.sock" })).toBeUndefined();
  expect(pinAllows(HOSTED_CLOUD, undefined)).toBe(true);
  expect(pinAllows(HOSTED_CLOUD, { cloudUrl: "https://app.customer.example", valid: true })).toBe(false);
  // A pin that is no Cloud URL allows no Cloud at all.
  expect(pinAllows("https://app.customer.example", { cloudUrl: "app.customer.example", valid: false })).toBe(false);
});

test("an enrollment and a sign-in kept for another Cloud read as none under the pin", async () => {
  const hosted = enrolledWith(HOSTED_CLOUD);
  expect(readIdentity(hosted)?.cloudUrl).toBe(HOSTED_CLOUD);
  const store = await Effect.runPromise(makeAccountStore);
  await store.save({ cloud_url: HOSTED_CLOUD, access_token: "cave_access_hosted_0123456789" });

  process.env.CAVEMAN_CLOUD_URL = "https://app.customer.example";
  expect(readIdentity(hosted)).toBeUndefined();
  expect(await store.load()).toBeUndefined();
  expect(readIdentity(enrolledWith("https://app.customer.example"))?.cloudUrl).toBe("https://app.customer.example");
  await store.save({ cloud_url: "https://app.customer.example", access_token: "cave_access_own_0123456789" });
  expect((await store.load())?.cloud_url).toBe("https://app.customer.example");

  // The pin gone, what was kept for the hosted Cloud is as it was.
  delete process.env.CAVEMAN_CLOUD_URL;
  expect(readIdentity(hosted)?.cloudUrl).toBe(HOSTED_CLOUD);
});
