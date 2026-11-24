// Live: the installed `claude`'s own model list reaches the picker (free; run with CAVEMAN_LIVE_CLAUDE=1).
//
// Only initialize runs: no prompt is sent, so nothing reaches Anthropic and nothing is billed. Every Anthropic model
// the CLI lists must be selectable, whether or not this build's manifest bundles it.
//
//   CAVEMAN_LIVE_CLAUDE=1 vitest run src/provider/ClaudeModels.live.test.ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BUNDLED_CLAUDE_MODEL_CATALOG, parseClaudeReportedModels } from "./ClaudeModelCatalog.ts";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "./ClaudeProvider.ts";

const live = process.env.CAVEMAN_LIVE_CLAUDE === "1";
const settings = Schema.decodeSync(ClaudeSettings)({});

it.layer(NodeServices.layer)("Claude Agent's live model list", (it) => {
  it.effect.skipIf(!live)(
    "lists every model the installed claude lists",
    () =>
      Effect.gen(function* () {
        const probe = yield* probeClaudeCapabilities(settings, process.env, undefined, false);
        const reported = parseClaudeReportedModels(probe.models);
        assert.isAbove(reported.length, 0, "claude listed no Anthropic model");
        const snapshot = yield* checkClaudeProviderStatus(
          settings,
          () => Effect.succeed(probe),
          process.env,
          undefined,
          BUNDLED_CLAUDE_MODEL_CATALOG,
        );
        const listed = snapshot.models.map((model) => model.slug);
        for (const { slug } of reported) assert.include(listed, slug);
        const defaultRow = reported.find((row) => row.alias === "default");
        if (defaultRow) {
          assert.strictEqual(
            snapshot.models.find((model) => model.isDefault)?.slug,
            defaultRow.slug,
          );
        }
      }),
    60_000,
  );
});
