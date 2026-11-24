import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { waitForAcpMockCommandPids } from "./acpMockCommandReadiness.ts";

it.each([2, 3])(
  "waits past 100ms for all %i command PIDs, ignoring partial publication",
  async (count) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-pid-ready-"));
    const path = NodePath.join(dir, "pids");
    let ready = false;
    const result = Effect.runPromise(waitForAcpMockCommandPids(path, count)).then(() => {
      ready = true;
    });
    try {
      NodeFS.writeFileSync(path, "");
      await delay(150);
      expect(ready).toBe(false);
      NodeFS.writeFileSync(path, "17");
      await delay(30);
      expect(ready).toBe(false);
      NodeFS.writeFileSync(path, count === 3 ? "17 18 nope" : "17 nope");
      await delay(30);
      expect(ready).toBe(false);
      NodeFS.writeFileSync(path, count === 3 ? "17 18 19\n" : "17 18\n");
      await result;
      expect(ready).toBe(true);
    } finally {
      await result.catch(() => {});
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("fails within its bound when the command never publishes its PIDs", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-pid-timeout-"));
  try {
    const result = await Effect.runPromiseExit(
      waitForAcpMockCommandPids(NodePath.join(dir, "missing"), 3),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.hasFails(result.cause)).toBe(false);
    }
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
