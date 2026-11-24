// @effect-diagnostics nodeBuiltinImport:off
/**
 * Switching a Codex chat into and out of Auto, through the adapter's own
 * resume, against the installed `codex` app-server. Codex rejoins a thread it
 * still holds as it is, ignoring a new provider, so the adapter unsubscribes
 * and resumes again; the replay test only restates that, this pins it to the
 * real CLI. No model call is made, so it needs no login and no caveman-proxy,
 * and it runs in a throwaway CODEX_HOME. Skipped when `codex` is not on PATH.
 *
 *   pnpm --filter @caveman-app/runtime exec vitest run \
 *     src/orchestration-v2/Adapters/CodexAdapterV2.live.test.ts
 */
import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as CodexClient from "@caveman-app/codex-app-server/client";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import { CodexSettings, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { vi } from "vitest";

import { codexProxy } from "../../router/proxyLauncher.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

// Auto names Codex's own app proxy (never called here: no model request is made).
vi.spyOn(codexProxy, "url").mockReturnValue("http://127.0.0.1:8787");

const codexBin = process.env.CODEX_BIN ?? "codex";
// `codex --version` writes $CODEX_HOME/tmp/arg0, so the probe gets a throwaway home too.
const probeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-auto-probe-"));
const hasCodex =
  spawnSync(codexBin, ["--version"], {
    env: { ...process.env, CODEX_HOME: probeHome, HOME: probeHome, XDG_CONFIG_HOME: probeHome },
    timeout: 10_000,
  }).status === 0;
NodeFS.rmSync(probeHome, { recursive: true, force: true });

type Client = CodexClient.CodexAppServerClient["Service"];

it.layer(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, IdAllocator.layer, McpProviderSessions.layer),
)(
  "CodexAdapterV2 live codex",
  (it) => {
    it.effect.skipIf(!hasCodex)("switches a loaded thread into and out of Auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-auto-live-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Every reply from Codex, by method, to read the provider it settled on.
        const replies: Array<{ readonly method: string; readonly result: unknown }> = [];
        const recorded = (method: string) =>
          Effect.tap((result: unknown) => Effect.sync(() => void replies.push({ method, result })));
        let client: Client | undefined;
        const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
          open: () =>
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(codexBin, ["app-server"], {
                  cwd: home,
                  env: { CODEX_HOME: home, HOME: home, XDG_CONFIG_HOME: home },
                  extendEnv: true,
                }),
              );
              const context = yield* Layer.build(CodexClient.layerChildProcess(handle));
              const real = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
              client = {
                ...real,
                request: ((method: string, params: unknown) =>
                  real.request(method as never, params as never).pipe(recorded(method))) as Client["request"],
                raw: {
                  ...real.raw,
                  request: ((method: string, params: unknown) =>
                    real.raw.request(method as never, params as never).pipe(recorded(method))) as Client["raw"]["request"],
                },
              };
              return client;
            }).pipe(Effect.orDie),
        };
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          settings: Schema.decodeSync(CodexSettings)({}),
          environment: {},
          clientFactory,
          digest: yield* Digest.Digest,
          fileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("codex-auto-live").pipe(Effect.orDie),
          continuationRequests: { offer: () => Effect.void },
        });
        const threadId = ThreadId.make("thread-codex-auto-live");
        const plain = { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
        const auto = { ...plain, model: "caveman-auto" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: home,
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-codex-auto-live"),
          modelSelection: plain,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: plain,
          runtimePolicy,
        });
        const settled = (method: string) => {
          const reply = replies.findLast((entry) => entry.method === method)?.result as
            | { readonly model?: string; readonly modelProvider?: string }
            | undefined;
          return { model: reply?.model, modelProvider: reply?.modelProvider };
        };
        assert.deepEqual(settled("thread/start"), { model: "gpt-5.4", modelProvider: "openai" });
        // A resume needs the thread on disk; a turn writes it, and so does an injected item, for free.
        yield* client!.request("thread/inject_items", {
          threadId: providerThread.nativeThreadRef!.nativeId!,
          items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        });

        const switchTo = (modelSelection: typeof plain) =>
          Effect.gen(function* () {
            replies.length = 0;
            yield* runtime.resumeThread({ providerThread, threadId, modelSelection, runtimePolicy });
            return replies.map(({ method }) => method).filter((method) => method !== "account/read");
          });

        // Codex first rejoins the loaded thread on its old provider; the adapter reloads it.
        assert.deepEqual(yield* switchTo(auto), ["thread/resume", "thread/unsubscribe", "thread/resume"]);
        assert.deepEqual(settled("thread/resume"), { model: "caveman-auto", modelProvider: "caveman" });
        assert.deepEqual(yield* switchTo(plain), ["thread/resume", "thread/unsubscribe", "thread/resume"]);
        assert.deepEqual(settled("thread/resume"), { model: "gpt-5.4", modelProvider: "openai" });
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
    );
  },
);
