// Live canary for the egress scrub (paid, tiny: one short turn per engine on
// the user's own logins; run only with CAVEMAN_LIVE_EGRESS=1).
//
//   CAVEMAN_LIVE_EGRESS=1 CAVEMAN_LIVE_EGRESS_OUT=<file> vitest run src/secrets/EgressScrub.live.test.ts
//
// The repository's secrets live in ProjectSecretsLive and the scrub is the
// runtime's EgressScrub layer. Each engine runs routed exactly as EngineEgress
// routes it, with the resolved secrets in its environment and one more value
// only in a file it reads. A recorder sits between the scrub and the real
// upstream (the user's own base URL, chained), so the test sees exactly the
// bytes a model provider receives. Passes only if both values reached the
// scrub (placeholders upstream) and neither left it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as CodexClient from "@caveman-app/codex-app-server/client";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createScrubber, type Scrubber, type SecretEntry } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layer as layerEgressScrub, startEgressProxy, type EgressProxy } from "./EgressScrub.ts";
import { ProjectSecrets } from "./ProjectSecrets.ts";
import * as ProjectSecretsLive from "./ProjectSecretsLive.ts";
import {
  claudeSettingsEnv,
  engineSecretEnv,
  routeClaudeOptions,
  routeCodexLaunch,
  withCodexThreadEnv,
  type Egress,
} from "./EngineEgress.ts";

const live = process.env.CAVEMAN_LIVE_EGRESS === "1";
// Vitest points HOME and XDG_* at a scratch dir; the CLIs need the user's real logins and config.
const REAL_HOME = NodeOS.userInfo().homedir;
const hostEnv = (): Record<string, string> => {
  const env = { ...process.env, HOME: REAL_HOME, USERPROFILE: REAL_HOME } as Record<string, string>;
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];
  return env;
};
// One canary only in the engine's environment (injection), one only in the repo's .env (cat .env).
const CANARY = `cvs_canary_${NodeCrypto.randomBytes(12).toString("hex")}`;
const FILE_CANARY = `cvs_filecanary_${NodeCrypto.randomBytes(12).toString("hex")}`;
const forms = (value: string) => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString("base64").replace(/=+$/, ""),
  Buffer.from(value).toString("base64url"),
];
// Benign names: the scrub matches values, never names, and models balk at "print the secret".
// CANARY_SECRET only answers present/missing: Codex's shell policy drops *SECRET* names by default.
const PROMPT =
  "Run these three shell commands and show me exactly what each prints: `cat notes.txt`, `echo $BUILD_LABEL`, `test -n \"$CANARY_SECRET\" && echo present || echo missing`.";
const ENGINE_ENV = { BUILD_LABEL: CANARY, CANARY_SECRET: `cvs_presence_${NodeCrypto.randomBytes(12).toString("hex")}` };

/** A scrubber that only records: what it sees is what the upstream gets. */
const recording = (seen: string[]): Scrubber => {
  const none = createScrubber([]);
  return { ...none, scrub: (text) => (seen.push(text), text) };
};

const summary: Record<string, unknown> = { canaryLength: CANARY.length };
// The runtime's own stack: the repository's secrets in ProjectSecretsLive (no keychain), the
// scrub proxy from EgressScrub.layer reading its scrubber.
const stack = layerEgressScrub.pipe(
  Layer.provideMerge(ProjectSecretsLive.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-egress-live-" }))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
);
let runtime: ManagedRuntime.ManagedRuntime<EgressRoute | ProjectSecrets, unknown>;
let scrub: EgressRoute["Service"];
let engineSecrets: ReadonlyArray<SecretEntry> = [];
let recorder: EgressProxy;
const upstreamSaw: string[] = [];
let cwd = "";

beforeAll(async () => {
  if (!live) return;
  recorder = await startEgressProxy({ scrubber: () => recording(upstreamSaw) });
  cwd = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "egress-canary-"));
  NodeFS.writeFileSync(NodePath.join(cwd, "notes.txt"), `release label ${FILE_CANARY}\n`);
  NodeChildProcess.execFileSync("git", ["-C", cwd, "init", "-q"]);
  NodeChildProcess.execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/caveman-test/egress-canary.git"]);
  runtime = ManagedRuntime.make(stack);
  ({ scrub, engineSecrets } = await runtime.runPromise(
    Effect.gen(function* () {
      const secrets = yield* ProjectSecrets;
      const key = yield* secrets.keyOf({ path: cwd });
      yield* secrets.set(key, [
        ...Object.entries(ENGINE_ENV).map(([name, value]) => ({ name, value: Redacted.make(value) })),
        { name: "DATABASE_PASSWORD", value: Redacted.make(FILE_CANARY) },
      ]);
      // What the broker hands the engine process: everything but the .env-only one.
      const resolved = yield* secrets.resolve(key);
      return {
        scrub: yield* EgressRoute,
        engineSecrets: resolved.filter(({ name }) => name in ENGINE_ENV),
      };
    }),
  ));
});

afterAll(async () => {
  if (!live) return;
  await runtime.dispose();
  await recorder.close();
  NodeFS.rmSync(cwd, { recursive: true, force: true });
  if (process.env.CAVEMAN_LIVE_EGRESS_OUT) NodeFS.writeFileSync(process.env.CAVEMAN_LIVE_EGRESS_OUT, JSON.stringify(summary, null, 2));
});

/** Scrub in front, recorder behind, then the real upstream. */
const egress = (): Egress => ({
  route: (upstream) => scrub.route(recorder.route(upstream)),
  owns: (url) => scrub.owns(url),
});

const verdict = (engine: string, reply: string, sinceUpstream: number) => {
  const sent = upstreamSaw.slice(sinceUpstream);
  // A placeholder upstream means the value was in the request and the scrub replaced it.
  const reachedScrub = (name: string) => sent.filter((body) => body.includes(`[secret:${name}]`)).length;
  const leaked = sent.filter((body) => [...forms(CANARY), ...forms(FILE_CANARY)].some((form) => body.includes(form))).length;
  const placeholders = sent.filter((body) => body.includes("[secret:BUILD_LABEL]") || body.includes("[secret:DATABASE_PASSWORD]")).length;
  const result = {
    requestsWithBody: sent.length,
    envCanaryReachedScrub: reachedScrub("BUILD_LABEL"),
    fileCanaryReachedScrub: reachedScrub("DATABASE_PASSWORD"),
    leakedUpstream: leaked,
    placeholdersUpstream: placeholders,
    canarySecretInEngineShell: /^\s*present\s*$/m.test(reply) ? "present" : /^\s*missing\s*$/m.test(reply) ? "missing" : "unknown",
    replyHasACanary: reply.includes(CANARY) || reply.includes(FILE_CANARY),
    reply: reply.replaceAll(CANARY, "<CANARY>").replaceAll(FILE_CANARY, "<FILE_CANARY>").slice(0, 300),
  };
  summary[engine] = result;
  expect(sent.length).toBeGreaterThan(0);
  expect(result.envCanaryReachedScrub + result.fileCanaryReachedScrub).toBeGreaterThan(0);
  expect(leaked).toBe(0);
  expect(placeholders).toBeGreaterThan(0);
};

describe.skipIf(!live)("egress scrub, live canary", () => {
  it("Claude Agent: the canary never reaches Anthropic", async () => {
    const sinceUpstream = upstreamSaw.length;
    const env = hostEnv();
    const base = {
      model: "claude-haiku-4-5",
      tools: ["Bash"],
      allowedTools: ["Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd,
      env,
      settingSources: ["user", "project", "local"],
      pathToClaudeCodeExecutable: NodePath.join(REAL_HOME, ".local/bin/claude"),
      maxTurns: 4,
    } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
    const routed = routeClaudeOptions(base, {
      egress: egress(),
      secrets: engineSecrets,
      settingsEnv: claudeSettingsEnv({ configDir: NodePath.join(REAL_HOME, ".claude"), cwd, sources: ["user", "project", "local"] }),
    });
    if (!("options" in routed)) throw new Error(routed.refused);
    summary.claudeUpstreamChain = "settings/env ANTHROPIC_BASE_URL or api.anthropic.com";
    let reply = "";
    for await (const message of query({ prompt: PROMPT, options: routed.options as NonNullable<Parameters<typeof query>[0]["options"]> })) {
      if (message.type === "result") reply = "result" in message ? String(message.result) : message.subtype;
    }
    verdict("claude", reply, sinceUpstream);
  }, 180_000);

 // `user-config`: chained to the provider in ~/.codex/config.toml (here a Caveman v4 proxy, compact login).
  // `built-in`: routing as if config.toml named no provider, so Codex's OpenAI provider is replaced and
 // requests go straight to compact backend, zstd-compressed.
  it.each(["user-config", "built-in"] as const)("Codex app-server (%s): the canary never reaches OpenAI", async (mode) => {
    const sinceUpstream = upstreamSaw.length;
    let configText = "";
    try {
      if (mode === "user-config") configText = NodeFS.readFileSync(NodePath.join(REAL_HOME, ".codex", "config.toml"), "utf8");
    } catch {}
    const secrets = engineSecrets;
    const routed = routeCodexLaunch({ egress: egress(), configText, launchArgs: undefined, environment: hostEnv() });
    if (!("args" in routed)) throw new Error(routed.unroutable);
    summary[`codexArgs ${mode}`] = routed.args.map((arg) => arg.replace(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/[0-9a-f]+/, "<scrub-route>"));
    const reply = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make("codex", ["app-server", ...routed.args], {
            cwd,
            env: { ...hostEnv(), ...engineSecretEnv(secrets) },
            extendEnv: false,
          }),
        );
        return yield* Effect.gen(function* () {
          const client = withCodexThreadEnv(yield* CodexClient.CodexAppServerClient, secrets);
          let text = "";
          const done = yield* Deferred.make<void>();
          yield* client.handleServerNotification("item/completed", (payload) =>
            Effect.sync(() => {
              const item = payload.item as { type: string; text?: string };
              if (item.type === "agentMessage" && item.text !== undefined) text += item.text;
            }),
          );
          yield* client.handleServerNotification("turn/completed", () => Deferred.succeed(done, undefined).pipe(Effect.asVoid));
          yield* client.request("initialize", {
            clientInfo: { name: "caveman-egress-canary", title: "Caveman egress canary", version: "0.0.0" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: null },
          } as never);
          yield* client.notify("initialized", undefined);
          const started = yield* client.request("thread/start", {
            cwd,
            model: "gpt-5.6-luna",
            approvalPolicy: "never",
            sandbox: "read-only",
          } as never);
          yield* client.request("turn/start", {
            threadId: (started as { thread: { id: string } }).thread.id,
            input: [{ type: "text", text: PROMPT }],
            effort: "low",
          } as never);
          yield* Deferred.await(done);
          return text;
        }).pipe(Effect.provide(CodexClient.layerChildProcess(handle)), Effect.timeout("150 seconds"));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))),
    );
    verdict(`codex ${mode}`, reply, sinceUpstream);
  }, 180_000);
});
