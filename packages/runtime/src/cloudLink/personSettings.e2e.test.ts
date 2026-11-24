// A person's settings across two computers against a REAL Caveman Cloud (control-api, Postgres, Valkey; the spec):
// both runtimes enroll as the person, run the settings loop, and a choice made on one, a Chief's limit included,
// reaches the other through Cloud's wait in well under a second; a computer that starts with only defaults takes
// the person's choices and seeds nothing.
//
// Skipped unless CAVEMAN_E2E_CLOUD_URL names a Cloud and CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD sign a person in
// there (legacy auth: a local stack's seeded owner), as realCloud.e2e.test.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Settings } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, expect, test } from "vitest";

import { enroll } from "./identity.ts";
import { makeSettingsSync } from "./personSettings.ts";

const CLOUD = process.env.CAVEMAN_E2E_CLOUD_URL;
const EMAIL = process.env.CAVEMAN_E2E_EMAIL;
const PASSWORD = process.env.CAVEMAN_E2E_PASSWORD;

const DEFAULTS = { default_engine: "claude-agent", default_computer_id: "this-mac", engines: {}, theme: "system", notifications: { needs_input: true, turn_done: true }, git_co_author: true } as Settings;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function computer(bearer: string, name: string, start?: Partial<Settings>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-e2e-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identity = await enroll({ dir, cloudUrl: CLOUD!, bearer, name });
  let settings = { ...DEFAULTS, ...start } as Settings;
  const kv = new Map<string, string>();
  const sync = makeSettingsSync({
    identity: () => identity,
    link: {},
    get: Effect.sync(() => settings),
    defaults: Effect.succeed(DEFAULTS),
    set: (patch) => Effect.sync(() => ((settings = { ...settings, ...patch } as Settings), sync.changed())),
    unset: (keys) => Effect.sync(() => ((settings = { ...settings, ...Object.fromEntries(keys.map((k) => [k, (DEFAULTS as Record<string, unknown>)[k]])) } as Settings), sync.changed())),
    load: Effect.sync(() => kv.get("settings_sync")),
    save: (value) => Effect.sync(() => void kv.set("settings_sync", value)),
  });
  const fiber = Effect.runFork(sync.run);
  cleanups.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
  return {
    get settings() {
      return settings;
    },
    change: (patch: Partial<Settings>) => ((settings = { ...settings, ...patch } as Settings), sync.changed()),
  };
}

test.skipIf(!CLOUD || !EMAIL || !PASSWORD)("a choice on one computer reaches the person's other computer through Cloud", { timeout: 60_000 }, async () => {
  const login = await fetch(`${CLOUD}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  expect(login.status).toBe(200);
  const { access_token: bearer } = (await login.json()) as { access_token: string };

  // Values of this run, so a person (or an earlier run) who already chose any never matches by chance.
  const cap = 1 + (Date.now() % 997);
  const turns = 100 + cap;
  const mac = await computer(bearer, "settings-e2e mac");
  // First contact: the Mac takes whatever the person already has in Cloud, then chooses.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const theme = mac.settings.theme === "dark" ? "light" : "dark";
  mac.change({ theme, chief_daily_cap_usd: cap, chief_daily_turns: turns } as Partial<Settings>);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  // A new computer, all defaults, takes the person's choices, the Chiefs' limits included.
  const box = await computer(bearer, "settings-e2e box");
  await until(() => box.settings.theme === theme && box.settings.chief_daily_cap_usd === cap && box.settings.chief_daily_turns === turns, 15_000);

  let at = Date.now();
  const patience = box.settings.chief_voice_patience === "patient" ? "quick" : "patient";
  const tldr = box.settings.review_chat_tldr === false;
  box.change({ review_chat_tldr: tldr, chief_voice_patience: patience } as Partial<Settings>);
  await until(() => mac.settings.review_chat_tldr === tldr && mac.settings.chief_voice_patience === patience, 10_000);
  const toMac = Date.now() - at;

  at = Date.now();
  const back = theme === "dark" ? "light" : "dark";
  mac.change({ theme: back } as Partial<Settings>);
  await until(() => box.settings.theme === back, 10_000);
  const toBox = Date.now() - at;
  console.log(`settings e2e: box→mac ${toMac} ms, mac→box ${toBox} ms (measured)`);
  expect(Math.max(toMac, toBox)).toBeLessThan(2_000);
  // The box's defaults never went over the Mac's choices.
  expect(mac.settings.theme).toBe(back);
  expect(mac.settings.chief_daily_cap_usd).toBe(cap);
});
