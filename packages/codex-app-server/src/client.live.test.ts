// Live check against the installed `codex` CLI (skipped when it is not on PATH).
// Runs with a throwaway CODEX_HOME, so it needs no login and never touches ~/.codex.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";

const codexBin = process.env.CODEX_BIN ?? "codex";
// `codex --version` writes $CODEX_HOME/tmp/arg0, so the availability probe gets a throwaway home too.
const probeHome = mkdtempSync(join(tmpdir(), "codex-live-probe-"));
const hasCodex =
  spawnSync(codexBin, ["--version"], {
    env: { ...process.env, CODEX_HOME: probeHome, HOME: probeHome, XDG_CONFIG_HOME: probeHome },
    timeout: 10_000,
  }).status === 0;
rmSync(probeHome, { recursive: true, force: true });

it.layer(NodeServices.layer)("@caveman-app/codex-app-server live codex", (it) => {
  it.effect.skipIf(!hasCodex)("decodes initialize, account/read and skills/list from the real app-server", () =>
    Effect.gen(function* () {
      const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "codex-live-",
      });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(codexBin, ["app-server"], {
          cwd: home,
          env: { CODEX_HOME: home, HOME: home, XDG_CONFIG_HOME: home },
          extendEnv: true,
        }),
      );

      yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        const initialized = yield* client.request("initialize", {
          clientInfo: { name: "caveman-code-live-test", title: "Caveman Code live test", version: "0.0.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        assert.include(initialized.userAgent, "caveman-code-live-test");
        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.isNull(account.account);
        assert.isTrue(account.requiresOpenaiAuth);

        const skills = yield* client.request("skills/list", { cwds: [home] });
        assert.equal(skills.data.length, 1);
      }).pipe(Effect.provide(CodexClient.layerChildProcess(handle)), Effect.timeout("20 seconds"));
    }).pipe(Effect.scoped),
  );
});
