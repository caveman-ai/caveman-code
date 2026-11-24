// Adapted ), apps/server/src/cli/pair.test.ts @ 714f849ec1 ("scripted auth output").
// @effect-diagnostics nodeBuiltinImport:off - Seeds an abandoned upload with an old mtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@caveman-app/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";

const layerCli = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  TestConsole.layer,
);
const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

describe("scripted auth output", () => {
  it.effect.each(
    [
      ["auth", "session", "issue", "--token-only"],
      ["auth", "session", "list", "--json"],
      ["auth", "pairing", "list", "--json"],
    ].map((command) => ({ command, label: command.join(" ") })),
  )("prints only the result for $label after removing an abandoned upload", ({ command }) =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-cli-quiet-test-"));
      const attachmentsDir = NodePath.join(baseDir, "userdata", "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      // An abandoned upload makes config resolution log that it removed it.
      const abandoned = NodePath.join(attachmentsDir, "abandoned.part");
      NodeFS.writeFileSync(abandoned, "");
      const jan2020Seconds = 1_577_836_800;
      NodeFS.utimesSync(abandoned, jan2020Seconds, jan2020Seconds);
      // The sweep reads Clock, so a week past the upload's mtime makes it expired.
      yield* TestClock.setTime((jan2020Seconds + 7 * 24 * 60 * 60) * 1000);

      yield* runCli([...command, "--base-dir", baseDir]);
      const lines = yield* TestConsole.logLines;

      assert.isFalse(NodeFS.existsSync(abandoned));
      assert.lengthOf(lines, 1);
      const output = String(lines[0]);
      if (command.includes("--json")) {
        assert.deepEqual(JSON.parse(output), []);
      } else {
        assert.match(output.trim(), /^[\w-]+\.[\w-]+/);
      }
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }).pipe(Effect.provide(layerCli)),
  );
});
