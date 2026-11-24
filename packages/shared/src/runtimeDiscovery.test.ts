import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { discoverRuntime, processStartedAt } from "./runtimeDiscovery.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** A home as a serving runtime leaves it; `record` overrides fields of server-runtime.json. */
function publish(record: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-discovery-"));
  homes.push(home);
  const state = path.join(home, "userdata");
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(
    path.join(state, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: 4100, origin: "http://127.0.0.1:4100", startedAt: new Date().toISOString(), ...record }),
  );
  fs.writeFileSync(path.join(state, "session-protocol.token"), "t0ken\n", { mode: 0o600 });
  return home;
}

it("finds a live runtime on loopback", () => {
  expect(discoverRuntime(publish())).toEqual({ pid: process.pid, origin: "http://127.0.0.1:4100", url: "ws://127.0.0.1:4100/session/v1", token: "t0ken" });
});

it("rejects a non-loopback origin, a bad or dead pid and a record without a start time", () => {
  expect(discoverRuntime(publish({ origin: "http://192.0.2.1:4100" }))).toBeUndefined();
  for (const pid of [0, -1, 1.5, "1"]) expect(discoverRuntime(publish({ pid }))).toBeUndefined();
  expect(discoverRuntime(publish({ pid: 99_999_999 }))).toBeUndefined();
  expect(discoverRuntime(publish({ startedAt: undefined }))).toBeUndefined();
});

// Skipped on Windows: processStartedAt does not ask there (no ps; PowerShell is too slow for the desktop's main process).
it.skipIf(process.platform === "win32")("rejects a reused pid: one that started after the record was written", () => {
  // This test process is the "runtime"; ps says it started well after 2001.
  expect(processStartedAt(process.pid)).toBeGreaterThan(Date.parse("2001-01-01T00:00:00Z"));
  expect(discoverRuntime(publish({ startedAt: "2001-01-01T00:00:00.000Z" }))).toBeUndefined();
  const home = publish();
  expect(discoverRuntime(home, { startedAt: () => Date.now() + 5_000 })).toBeUndefined();
  expect(discoverRuntime(home, { startedAt: () => Date.now() - 5_000 })?.pid).toBe(process.pid);
});

// Skipped on Windows: no uid or mode bits there; the profile's ACL is the ownership check (DiscoverOptions.uid).
it.skipIf(process.platform === "win32")("rejects files another user owns or others may write", () => {
  const home = publish();
  expect(discoverRuntime(home, { uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
  fs.chmodSync(path.join(home, "userdata", "session-protocol.token"), 0o666);
  expect(discoverRuntime(home)).toBeUndefined();
  fs.chmodSync(path.join(home, "userdata", "session-protocol.token"), 0o600);
  fs.chmodSync(path.join(home, "userdata"), 0o777);
  expect(discoverRuntime(home)).toBeUndefined();
});
