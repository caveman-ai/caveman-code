// Live Codex on a real OpenAI API key (paid; run only with CAVEMAN_LIVE_CODEX=1).
//
// The account home is created through the adapter's own login path (the
// `credentials` sign-in that runs Codex's `account/login/start`), then one
// turn runs with a space's MCP server and instructions passed as per-thread
// overrides. The key is read from CAVEMAN_LIVE_CODEX_KEY_FILE and never printed.
//
//   CAVEMAN_LIVE_CODEX=1 CAVEMAN_LIVE_CODEX_KEY_FILE=<file> CAVEMAN_LIVE_CODEX_MODEL=gpt-5-mini \
//   CAVEMAN_LIVE_CODEX_DIR=<dir to keep the signed-in home in, optional> vitest run src/provider/CodexLive.live.test.ts
//
// With CAVEMAN_LIVE_CODEX_DIR the signed-in home stays (for the replay recorder,
// whose caller removes it); without it the test signs out and deletes everything.
// Vitest hides a passing test's console, so CAVEMAN_LIVE_CODEX_OUT names a file for the summary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CODEX_API_KEY_METHOD_ID,
  makeCodexApiKeyAuth,
  resolveCodexLaunch,
} from "./CodexApiKeyAccount.ts";
import { checkCodexProviderStatus, withCodexAppServerClient } from "./CodexProvider.ts";

const keyFile = process.env.CAVEMAN_LIVE_CODEX_KEY_FILE;
// Both are required: a live run never falls back to a key somewhere on this machine.
const live = process.env.CAVEMAN_LIVE_CODEX === "1" && keyFile !== undefined;
if (process.env.CAVEMAN_LIVE_CODEX === "1" && keyFile === undefined)
  console.warn("Codex live test skipped: set CAVEMAN_LIVE_CODEX_KEY_FILE to the key's file.");
// gpt-5-nano completed the turn but never called the namespaced MCP tool (2026-10-15); gpt-5-mini did.
const model = process.env.CAVEMAN_LIVE_CODEX_MODEL ?? "gpt-5-mini";
const keptDir = process.env.CAVEMAN_LIVE_CODEX_DIR;
const instanceId = ProviderInstanceId.make("codex");
const SPACE_INSTRUCTIONS = "Always end every reply with the exact word PINEAPPLE.";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Codex live (API key)", (it) => {
  it.effect.skipIf(!live)(
    "signs in through the adapter, probes, and runs one turn with a space's MCP server",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const base = keptDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-live-"));
        // Codex sees a throwaway HOME; the managed home lives under it, so the
        // replay recorder's home scrubbing also removes the state dir.
        const home = path.join(base, "home");
        NodeFS.mkdirSync(home, { recursive: true });
        const launch = resolveCodexLaunch({
          path,
          stateDir: path.join(home, "state"),
          instanceId,
          config: { ...Schema.decodeSync(CodexSettings)({}), enabled: true },
          environment: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!keptDir) NodeFS.rmSync(base, { recursive: true, force: true });
          }),
        );

        const auth = yield* makeCodexApiKeyAuth({ instanceId, launch, onChanged: Effect.void });
        const phase = (wanted: string) =>
          auth.subscribe("live").pipe(
            Stream.filter((state) => state.phase === wanted || state.phase === "failed"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.timeout("60 seconds"),
          );
        yield* auth.start("live");
        const waiting = yield* phase("waiting");
        yield* auth.respond!("live", {
          instanceId,
          flowId: waiting.flowId!,
          interactionId: CODEX_API_KEY_METHOD_ID,
          response: {
            type: "credentials",
            values: { apiKey: NodeFS.readFileSync(keyFile!, "utf8").trim() },
          },
        });
        const signedIn = yield* phase("succeeded");
        assert.strictEqual(signedIn.phase, "succeeded", signedIn.message ?? "");

        const status = yield* checkCodexProviderStatus(
          launch.config,
          undefined,
          launch.environment,
        );
        console.log(
          "[codex-live] status",
          JSON.stringify({
            status: status.status,
            version: status.version,
            auth: status.auth,
            models: status.models.map((entry) => entry.slug),
          }),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.type, "apiKey");

        const result = yield* Effect.gen(function* () {
          const { client } = yield* withCodexAppServerClient({
            binaryPath: launch.config.binaryPath,
            homePath: launch.config.homePath,
            launchArgs: launch.config.launchArgs,
            cwd: home,
            environment: launch.environment,
          });
          const done = yield* Deferred.make<string>();
          const items: Array<{ type: string; text?: string; server?: string; tool?: string }> = [];
          let usage: unknown;
          yield* client.handleServerNotification("item/completed", ({ item }) =>
            Effect.sync(() => {
              items.push({
                type: item.type,
                ...("text" in item && typeof item.text === "string" ? { text: item.text } : {}),
                ...("server" in item && typeof item.server === "string"
                  ? { server: item.server, tool: String(item.tool) }
                  : {}),
              });
            }),
          );
          yield* client.handleServerNotification("thread/tokenUsage/updated", (payload) =>
            Effect.sync(() => {
              usage = payload.tokenUsage.total;
            }),
          );
          yield* client.handleServerNotification("turn/completed", ({ turn }) =>
            Deferred.succeed(done, turn.status).pipe(Effect.asVoid),
          );
          // What SessionPlugins.codex hands the adapter for a space with one MCP server.
          const params = codexThreadRuntimeParams({
            mcpSession: undefined,
            plugins: {
              config: {
                mcp_servers: {
                  "space-echo": {
                    command: process.execPath,
                    args: [NodePath.join(import.meta.dirname, "codexLiveSpaceMcp.mjs")],
                    env: {},
                  },
                },
              },
              developerInstructions: SPACE_INSTRUCTIONS,
            },
            modelSelection: { model },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: home,
            },
          });
          const thread = yield* client.request("thread/start", params);
          yield* client.request("turn/start", {
            threadId: thread.thread.id,
            model,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
            input: [
              {
                type: "text",
                text: "Call the MCP tool space_echo (server space-echo) once, then reply with the exact text it returned.",
              },
            ],
          });
          const turnStatus = yield* Deferred.await(done).pipe(Effect.timeout("180 seconds"));
          return { turnStatus, items, usage };
        }).pipe(Effect.scoped);

        console.log("[codex-live] turn", JSON.stringify(result));
        if (process.env.CAVEMAN_LIVE_CODEX_OUT)
          NodeFS.writeFileSync(
            process.env.CAVEMAN_LIVE_CODEX_OUT,
            `${JSON.stringify({ model, status: { status: status.status, version: status.version, auth: status.auth }, ...result }, null, 2)}\n`,
          );
        assert.strictEqual(result.turnStatus, "completed");
        assert.isTrue(
          result.items.some((item) => item.type === "mcpToolCall" && item.server === "space-echo"),
          "the space's MCP server was called",
        );
        const reply = result.items.findLast((item) => item.type === "agentMessage")?.text ?? "";
        assert.include(reply, "SPACE-TOOL-OK");
        assert.include(reply, "PINEAPPLE", "the space's instructions reached Codex");
        assert.isFalse(NodeFS.existsSync(path.join(home, ".codex")), "~/.codex untouched");

        if (!keptDir) yield* auth.logout(Effect.void);
      }).pipe(Effect.scoped),
    300_000,
  );
});
