// Test-only: one runtime process for moveEngines.e2e.test.ts: the real runtime with the real Claude Agent adapter and
// SDK on the stand-in claude (scripts/smoke-claude.mjs, resuming strictly from its own session file), as This Mac
// (MOVES_ROLE=mac: enrolled with MOVES_BEARER) or as a Cloud computer's runtime (CAVEMAN_CLOUD_LINK_DIR and
// CAVEMAN_WORKSPACE_ROOT set, as the computers service sets them). Each has its own CLAUDE_CONFIG_DIR. A Mac is
// named MOVES_NAME ("Moves Mac" by default). With MOVES_PROBE set, its provider snapshot is the Claude provider's own
// probe of the stand-in (signed out under SMOKE_CLAUDE_SIGNED_OUT), as a Mac reads whether Claude is signed in there:
// kept until something refreshes that instance, which probes again, as the provider registry does.
// Writes {url, token, stateDir} to MOVES_OUT once it serves, and runs until killed or its test runner is gone.
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkClaudeProviderStatus, probeClaudeCapabilities } from "../provider/ClaudeProvider.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { instanceForEngine } from "../session-protocol/projector.ts";
import { FAKE_CLAUDE, makeConfig, startRuntime } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { linkDirOf } from "./index.ts";

const out = process.env.MOVES_OUT!;
const config = await makeConfig();
if (process.env.MOVES_ROLE === "mac") await enroll({ dir: linkDirOf(config.stateDir), cloudUrl: process.env.MOVES_CLOUD_URL!, bearer: process.env.MOVES_BEARER!, name: process.env.MOVES_NAME ?? "Moves Mac" });
/** The Claude provider's snapshot as its probe of the stand-in CLI reads it (installed, signed in or not). */
const probed = async () => {
  const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: FAKE_CLAUDE });
  const draft = await Effect.runPromise(
    checkClaudeProviderStatus(settings, (s) => probeClaudeCapabilities(s, process.env, process.cwd(), false).pipe(Effect.provide(NodeServices.layer)), process.env, process.cwd()).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  return { ...draft, instanceId: ProviderInstanceId.make(instanceForEngine("claude-agent")), driver: ProviderDriverKind.make("claudeAgent") };
};
let snapshot = process.env.MOVES_PROBE ? await probed() : undefined;
const registry =
  snapshot &&
  Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [snapshot!]),
    refreshInstance: () => Effect.promise(async () => [(snapshot = await probed())]),
  } as never);
const runtime = await startRuntime(config, "fake-claude", undefined, registry ? { provide: registry } : {});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ url: runtime.url, token: runtime.token(), stateDir: config.stateDir }));
// Runs until killed, and never outlives the test runner (MOVES_PARENT): it runs in its own process group, so a
// runner stopped by hand would not take it along otherwise.
const parent = Number(process.env.MOVES_PARENT);
setInterval(() => {
  try {
    if (parent > 0) process.kill(parent, 0);
  } catch {
    process.exit(1);
  }
}, 2_000);
