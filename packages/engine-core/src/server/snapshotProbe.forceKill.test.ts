// A probe CLI that ignores SIGTERM must not wedge spawnAndCollect: after
// PROBE_FORCE_KILL_AFTER its whole process group gets SIGKILL.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";

import { spawnAndCollect } from "./snapshotProbe.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The stub and the grandchild it starts (same process group) both ignore SIGTERM.
const STUB = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], process.pid + " " + child.pid);
setInterval(() => {}, 1000);
`;

it.live.skipIf(process.platform === "win32")(
  "kills a SIGTERM-ignoring probe CLI and its process group once the probe gives up",
  () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "probe-force-kill-"));
      const script = NodePath.join(dir, "stub.cjs");
      const pids = NodePath.join(dir, "pids");
      NodeFS.writeFileSync(script, STUB);
      const started = Date.now();
      const result = yield* spawnAndCollect("stub", ChildProcess.make(process.execPath, [script, pids])).pipe(
        Effect.timeoutOption("1500 millis"),
      );
      expect(Option.isNone(result)).toBe(true);
      // Bounded: the 2 s SIGKILL deadline plus the spawner's 1 s wait, not forever.
      expect(Date.now() - started).toBeLessThan(6_000);
      const [leader, grandchild] = NodeFS.readFileSync(pids, "utf8").split(" ").map(Number);
      yield* Effect.sleep("200 millis");
      expect(alive(leader!)).toBe(false);
      expect(alive(grandchild!)).toBe(false);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);
