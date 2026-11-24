// A Pi whose RPC mode never answers, and that ignores SIGTERM, still ends the probe under a
// TestClock (it.effect): the discovery deadline and the SIGTERM->SIGKILL grace are real time.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { writeFakeCli } from "@caveman-app/engine-testing/fakeCli";
import * as Effect from "effect/Effect";

import { checkPiProviderStatus } from "./status.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.effect.skipIf(process.platform === "win32")(
  "ends a probe whose Pi hangs in RPC mode and ignores SIGTERM, under a TestClock",
  () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-hung-rpc-"));
      const pidFile = NodePath.join(dir, "pid");
      const binaryPath = writeFakeCli({
        directory: dir,
        name: "pi",
        env: { PI_FAKE_PID_FILE: pidFile },
        source: [
          'import { writeFileSync } from "node:fs";',
          'if (process.argv.includes("--version")) { console.log("pi 1.0.0"); process.exit(0); }',
          'process.on("SIGTERM", () => {});',
          "writeFileSync(process.env.PI_FAKE_PID_FILE, String(process.pid));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      });
      const started = Date.now();
      const snapshot = yield* checkPiProviderStatus(
        { enabled: true, binaryPath, launchArgs: "", customModels: [] },
        process.env,
        dir,
      );
      assert.equal(snapshot.version, "1.0.0");
      assert.include(snapshot.message ?? "", "discovery needs interactive input");
      // The 30 s discovery deadline plus the 1 s SIGKILL grace, with slack.
      assert.isBelow(Date.now() - started, 40_000);
      const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)));
      assert.isFalse(alive(pid));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
