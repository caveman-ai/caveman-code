// Settings -> Engines on the runtime: a Caveman key added over the Session
// Protocol makes message.caveman_version answer (a scripted model, never a
// network or paid call) and writes a spend row; Codex API-key accounts are
// signed in and removed through ProviderAuthService against a fake codex
// app-server (scripts/fake-codex.mjs), never the real codex. No key ever
// comes back: not in a result, an event, the database, a log or the trace.
// The accounts are the runtime's owner's: another person's device reaches none of engine.account.*.
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId, type ServerProvider } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { CavemanKeyTester, makeCavemanRewriter } from "@caveman-app/provider-caveman/server";
import { fauxModel, scriptedStream } from "@caveman-app/provider-caveman/testing";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { codexManagedHomePath, makeCodexApiKeyAuth, resolveCodexLaunch } from "../provider/CodexApiKeyAccount.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import { EngineCloudKeys, type EngineCloudKeysShape } from "../cloudLink/engineKeys.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import { followedLogins } from "../cloudLink/engineLogins.ts";
import * as PtyAdapter from "@caveman-app/shared/PtyAdapter";
import { allowedStream } from "./devices.testkit.ts";
import { makeEngineAccounts } from "./engineAccounts.ts";
import type { ProtocolError } from "./handlers.ts";
import { harnessEngineOf } from "./harnesses.ts";
import { CavemanRewriter } from "./services.ts";
import * as Store from "./store.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";

const OPENAI_KEY = "sk-engine-accounts-test-0000-openai-k3y4";
const OPENAI_KEY_RETRY = "sk-engine-accounts-test-0000-retry-r3tr";
const CODEX_KEY = "sk-engine-accounts-test-1111-codex-c0d3";
const CODEX_KEY_2 = "sk-engine-accounts-test-2222-codex-9b1c";
const FAKE_CODEX = path.join(import.meta.dirname, "../../scripts/fake-codex.mjs");

/** Every file under `dir` that holds `needle` (database, WAL, logs, trace). */
function filesHolding(dir: string, needle: string): Array<string> {
  const hits: Array<string> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    // A WAL index (-shm) holds page numbers, never a row: and on Windows SQLite byte-locks it while the runtime runs,
    // so no other handle can read it there (EBUSY). The database and its WAL, where rows are, are read.
    if (file.endsWith("-shm")) continue;
    if (fs.readFileSync(file).includes(needle)) hits.push(file);
  }
  return hits;
}

describe("Caveman engine keys over the Session Protocol", () => {
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  let root: string;
  const frames: Array<string> = [];

  beforeAll(async () => {
    root = tempRoot("sp-accounts-");
    const host = TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
    // The production rewriter on a scripted model: the key store and the cheap pick are real.
    const rewriter = Layer.effect(
      CavemanRewriter,
      makeCavemanRewriter(ProviderInstanceId.make("caveman"), {
        streamFn: scriptedStream([{ text: "Caveman fix bug. Test pass.", usage: { input: 321, output: 12 } }]),
        model: fauxModel({ priced: true }),
      }),
    ).pipe(Layer.provide(host));
    config = await makeConfig();
    // The add-time test call, stubbed: a key holding "refused" is refused, any other works. Nothing leaves the machine.
    const tester = Layer.succeed(CavemanKeyTester, (_provider, credential) =>
      Effect.succeed(credential.key?.includes("refused") ? { ok: false as const, kind: "auth" as const, message: "401 invalid key" } : { ok: true as const, model: "stub" }),
    );
    runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(host, rewriter, tester) });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = async <A>(promise: Promise<A>) => {
    const result = await promise;
    frames.push(JSON.stringify(result));
    return result;
  };
  const reason = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: { error?: { data?: { reason?: string }; message?: string } }) => {
        frames.push(JSON.stringify(error));
        return error.error?.data?.reason;
      },
    );

  test("a key added in Settings makes message.caveman_version answer and its spend count under the Caveman engine", async () => {
    // A finished assistant message to rewrite.
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await call(client.call("workspace.create", { request_id: "w1", repo: { path: repo }, title: "rewrite me", engine: "claude-agent", options: { model: MODEL }, task: { text: "fix the bug" } }));
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => {
      frames.push(JSON.stringify(e));
      events.push(e);
    });
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    const item = events.find((e) => e.type === "message.done" && e.payload.role === "assistant")!.item_id!;

    expect(await reason(client.call("message.caveman_version", { session_id: w.session_id, item_id: item }))).toBe("engine_unavailable");
    expect(await reason(client.call("engine.account.add", { request_id: "a0", engine: "caveman", key: OPENAI_KEY }))).toBe("invalid_params");

    const added = await call(client.call("engine.account.add", { request_id: "a1", engine: "caveman", provider: "openai", key: OPENAI_KEY }));
    expect(added.accounts).toEqual([
      { id: "caveman:openai", label: "OpenAI API key ...k3y4", kind: "api_key", active: true, tag: "OA", provider: "openai", health: { state: "ok", checked_at: expect.any(String) } },
    ]);
    expect(added.test).toEqual({ ok: true, model: "stub" });
    // A retry with the same request_id answers from the receipt, which never holds the key: its hash leaves
    // the key out, so even a different key is the same request (not request_id_conflict) and is never stored.
    expect(await call(client.call("engine.account.add", { request_id: "a1", engine: "caveman", provider: "openai", key: OPENAI_KEY }))).toEqual(added);
    expect(await call(client.call("engine.account.add", { request_id: "a1", engine: "caveman", provider: "openai", key: OPENAI_KEY_RETRY }))).toEqual(added);
    // An add never removes: a blank key is refused and the stored one stays (caveman_version below runs on it).
    expect(await reason(client.call("engine.account.add", { request_id: "a1b", engine: "caveman", provider: "openai", key: "   " }))).toBe("invalid_params");

    const version = await call(client.call("message.caveman_version", { session_id: w.session_id, item_id: item }));
    expect(version.text).toBe("Caveman fix bug. Test pass.");
    // The side call is spend under the Caveman engine and this workspace, never a session event.
    const byEngine = await call(client.call("spend.summary", { group_by: "engine" }));
    expect(byEngine.rows.find((r) => r.key === "caveman")).toMatchObject({ input_tokens: 321, output_tokens: 12, basis: "list_price" });
    const byWorkspace = await call(client.call("spend.summary", { group_by: "workspace" }));
    expect(byWorkspace.rows.find((r) => r.key === w.id)?.input_tokens).toBeGreaterThanOrEqual(321);
    expect(events.some((e) => e.type === "usage" && e.payload.engine === "caveman")).toBe(false);

    expect(await reason(client.call("engine.account.activate", { request_id: "a2", engine: "caveman", account_id: "caveman:openai" }))).toBe("invalid_params");
    const claude = await call(client.call("engine.account.add", { request_id: "a3", engine: "claude-agent" }));
    expect(claude.sign_in?.command).toBe("claude");
    expect(await reason(client.call("engine.account.add", { request_id: "a4", engine: "claude-agent", key: "sk-ant-no" }))).toBe("invalid_params");
    expect(await reason(client.call("engine.account.remove", { request_id: "a5", engine: "claude-agent", account_id: "claudeAgent:default" }))).toBe("invalid_params");

    const removed = await call(client.call("engine.account.remove", { request_id: "a6", engine: "caveman", account_id: "caveman:openai" }));
    expect(removed.accounts).toEqual([]);
    // The rewrite already paid for is kept (f515fa25): asking again answers it with no model call and no new spend.
    expect(await call(client.call("message.caveman_version", { session_id: w.session_id, item_id: item }))).toEqual({ text: "Caveman fix bug. Test pass." });
    const byEngineAgain = await call(client.call("spend.summary", { group_by: "engine" }));
    expect(byEngineAgain.rows.find((r) => r.key === "caveman")).toMatchObject({ input_tokens: 321, output_tokens: 12 });
    // A message with no kept rewrite needs the removed key: the Caveman version is unavailable.
    const seen = events.length;
    await call(client.call("turn.submit", { request_id: "t2", session_id: w.session_id, kind: "followup", input: { text: "and the other bug" } }));
    await until(() => events.slice(seen).some((e) => e.type === "turn.done"), 30_000);
    const next = events.slice(seen).find((e) => e.type === "message.done" && e.payload.role === "assistant")!.item_id!;
    expect(next).not.toBe(item);
    expect(await reason(client.call("message.caveman_version", { session_id: w.session_id, item_id: next }))).toBe("engine_unavailable");
    expect(await reason(client.call("engine.account.remove", { request_id: "a7", engine: "caveman", account_id: "caveman:openai" }))).toBe("not_found");
    // A short key's label shows none of it.
    const short = await call(client.call("engine.account.add", { request_id: "a8", engine: "caveman", provider: "google", key: "g00g" }));
    expect(short.accounts).toMatchObject([{ id: "caveman:google", label: "Gemini API key", kind: "api_key", active: true }]);
    await call(client.call("engine.account.remove", { request_id: "a9", engine: "caveman", account_id: "caveman:google" }));
    // A key the provider refuses on its test call is never kept; providers the app never offers are refused outright.
    expect(await reason(client.call("engine.account.add", { request_id: "a10", engine: "caveman", provider: "deepseek", key: "sk-refused-0000000000000000" }))).toBe("invalid_params");
    expect(await reason(client.call("engine.account.add", { request_id: "a11", engine: "caveman", provider: "github-copilot", key: "gho_0000000000000000000" }))).toBe("invalid_params");
    expect(await reason(client.call("engine.account.add", { request_id: "a12", engine: "caveman", provider: "caveman", key: "credits-0000000000000000" }))).toBe("invalid_params");
    // A local endpoint: no key, an address and model ids; a plain-http address off this network is refused.
    const local = await call(
      client.call("engine.account.add", { request_id: "a13", engine: "caveman", provider: "ollama", endpoint: { name: "Ollama", base_url: "http://localhost:11434/v1", models: ["qwen3-coder"] } }),
    );
    expect(local.accounts).toMatchObject([{ id: "caveman:ollama", label: "Ollama at localhost:11434", provider: "ollama" }]);
    expect(
      await reason(client.call("engine.account.add", { request_id: "a14", engine: "caveman", provider: "custom-far", endpoint: { name: "Far", base_url: "http://example.com/v1", models: ["m"] } })),
    ).toBe("invalid_params");
    const retested = await call(client.call("engine.account.test", { request_id: "a15", engine: "caveman", account_id: "caveman:ollama" }));
    expect(retested.test).toEqual({ ok: true, model: "stub" });
    await call(client.call("engine.account.remove", { request_id: "a16", engine: "caveman", account_id: "caveman:ollama" }));
    const providers = await call(client.call("engine.providers", { engine: "caveman" }));
    expect(providers.providers.slice(0, 4).map((p) => p.id)).toEqual(["github-copilot", "anthropic", "openai", "xai"]);
    expect(providers.providers.some((p) => p.id === "openai-codex")).toBe(false);
 // Subscriptions: compact and SuperGrok beside their provider's key; Copilot only by signing in; never claude.ai.
    const byId = new Map(providers.providers.map((p) => [p.id, p]));
    expect(byId.get("openai")).toMatchObject({ section: "keys", sign_in: true, sign_in_label: "Sign in with ChatGPT", sign_in_plan: "ChatGPT" });
    expect(byId.get("xai")).toMatchObject({ sign_in_plan: "SuperGrok" });
    expect(byId.get("github-copilot")).toMatchObject({ sign_in_only: true, sign_in_plan: "GitHub Copilot" });
    expect(byId.get("anthropic")?.sign_in).toBeUndefined();
    expect(byId.get("opencode-go")).toMatchObject({ section: "plans", plan: true });
    expect(byId.get("ollama-cloud")).toMatchObject({ section: "gateways", base_url: "https://ollama.com/v1" });
    expect(
      await reason(client.call("engine.account.add", { request_id: "a17", engine: "caveman", provider: "github-copilot", key: "gho_pasted_0123456789abcdef" })),
    ).toBe("invalid_params");

    // The grep: no result, error or event carried the key, and nothing on disk holds it.
    frames.push(JSON.stringify(await client.call("engine.list", {})), JSON.stringify(await client.call("settings.get", {})));
    for (const key of [OPENAI_KEY, OPENAI_KEY_RETRY]) {
      expect(frames.filter((f) => f.includes(key))).toEqual([]);
      expect(filesHolding(path.dirname(config.stateDir), key)).toEqual([]);
    }
  });

  test("two OpenAI keys and two Anthropic keys are four accounts with their own tags; removing one leaves the rest", async () => {
    const add = (request_id: string, provider: string, key: string) => call(client.call("engine.account.add", { request_id, engine: "caveman", provider, key }));
    await add("m0", "openai", "sk-engine-accounts-first-openai-0000-f1rs");
    await add("m1", "openai", "sk-engine-accounts-second-openai-0000-s2nd");
    await add("m2", "anthropic", ("sk-" + "ant-engine-accounts-first-0000-ant1"));
    await add("m3", "anthropic", ("sk-" + "ant-engine-accounts-second-0000-ant2"));
    // The same key again replaces itself: no third Anthropic account.
    const all = await add("m4", "anthropic", ("sk-" + "ant-engine-accounts-second-0000-ant2"));
    const keyed = all.accounts.filter((a) => a.provider === "openai" || a.provider === "anthropic");
    // OpenAI's first slot went with the key the first test removed: these two get slots of their own.
    expect(keyed.map((a) => [a.id, a.provider, a.tag])).toEqual([
      ["caveman:anthropic", "anthropic", "AA"],
      ["caveman:anthropic~2", "anthropic", "AA2"],
      ["caveman:openai~2", "openai", "OA2"],
      ["caveman:openai~3", "openai", "OA3"],
    ]);
    // A tag of your own, then removing the first OpenAI key: the second keeps its tag, Anthropic's two stay.
    await call(client.call("engine.account.tag", { request_id: "m5", engine: "caveman", account_id: "caveman:openai~3", tag: "WRK" }));
    const after = await call(client.call("engine.account.remove", { request_id: "m6", engine: "caveman", account_id: "caveman:openai~2" }));
    expect(after.accounts.filter((a) => a.provider === "openai" || a.provider === "anthropic").map((a) => [a.id, a.tag])).toEqual([
      ["caveman:anthropic", "AA"],
      ["caveman:anthropic~2", "AA2"],
      ["caveman:openai~3", "WRK"],
    ]);
  });

  test("a removed key's slot is never handed to another key, so nothing still naming it sends with the new one", async () => {
    const add = (request_id: string, provider: string, key: string) => call(client.call("engine.account.add", { request_id, engine: "caveman", provider, key }));
    const groq = (accounts: ReadonlyArray<{ id: string; provider?: string }>) => accounts.filter((a) => a.provider === "groq").map((a) => a.id);
    await add("r0", "groq", "gr0q-engine-accounts-first-0000-r0");
    await add("r1", "groq", "gr0q-engine-accounts-second-0000-r1");
    await call(client.call("engine.account.remove", { request_id: "r2", engine: "caveman", account_id: "caveman:groq~2" }));
    // A chat or the Chief still on groq~2/<model> finds it gone instead of running on the next key.
    expect(groq((await add("r3", "groq", "gr0q-engine-accounts-third-0000-r3")).accounts)).toEqual(["caveman:groq", "caveman:groq~3"]);
    // A slot named outright is its provider: the next slot, never that one or a nested one.
    expect(groq((await add("r4", "groq~2", "gr0q-engine-accounts-fourth-0000-r4")).accounts)).toEqual(["caveman:groq", "caveman:groq~3", "caveman:groq~4"]);
  });

  test("the first key's slot is never handed out again either: a pick still on provider/<model> fails instead of sending with the new key", async () => {
    const add = (request_id: string, key: string) => call(client.call("engine.account.add", { request_id, engine: "caveman", provider: "mistral", key }));
    const mistral = (accounts: ReadonlyArray<{ id: string; provider?: string }>) => accounts.filter((a) => a.provider === "mistral").map((a) => a.id);
    expect(mistral((await add("f0", "m1str4l-engine-accounts-first-0000-m0")).accounts)).toEqual(["caveman:mistral"]);
    await call(client.call("engine.account.remove", { request_id: "f1", engine: "caveman", account_id: "caveman:mistral" }));
    expect(mistral((await add("f2", "m1str4l-engine-accounts-second-000-m2")).accounts)).toEqual(["caveman:mistral~2"]);
  });
});

describe("Codex API-key accounts", () => {
  type Accounts = Effect.Success<typeof makeEngineAccounts>;
  interface Harness {
    readonly accounts: Accounts;
    readonly instances: Effect.Effect<Record<string, unknown>, unknown>;
    readonly home: (id: string) => string;
    /** "unknown": what the provider probe reports before it has run, or when it failed. */
    readonly probe: { status: "disk" | "unknown" };
  }

  /**
   * makeEngineAccounts with the real ProviderAuthService over scripts/fake-codex.mjs, the only `codex` on
   * PATH; `after` sees the fake's call log and the state dir before the temp root goes.
   */
  async function withCodex(
    body: (h: Harness) => Effect.Effect<void, unknown>,
    after: (r: { calls: Array<{ method: string; home: string; key_in_env?: boolean }>; stateDir: string; home: (id: string) => string }) => void,
  ) {
    const root = tempRoot("sp-codex-accounts-");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    if (process.platform === "win32") {
      // What npm puts on PATH on Windows: a .cmd shim, which the runtime starts through cmd.exe.
      fs.writeFileSync(path.join(bin, "codex.cmd"), `@"${process.execPath}" "${FAKE_CODEX}" %*\r\n`);
    } else {
      fs.symlinkSync(FAKE_CODEX, path.join(bin, "codex"));
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
    }
    const log = path.join(root, "codex.log");
    // OpenAI's GET /v1/models, where the runtime checks each key after Codex's login: 401 for OPENAI_REJECTS.
    const openAi = http.createServer((req, res) => res.writeHead(req.headers.authorization?.includes("openai-rejects") ? 401 : 200).end("{}"));
    await new Promise<void>((listening) => openAi.listen(0, "127.0.0.1", listening));
    const saved = { PATH: process.env.PATH, FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG };
    // `codex` on PATH is the fake, and no PATH entry leads to the real one.
    process.env.PATH = process.platform === "win32" ? [bin, path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter) : `${bin}:/usr/bin:/bin`;
    process.env.FAKE_CODEX_LOG = log;
    process.env.FAKE_CODEX_OPENAI_BASE_URL = `http://127.0.0.1:${(openAi.address() as AddressInfo).port}/v1`;
    const config = await makeConfig();
    const settings = Schema.decodeSync(CodexSettings)({});
    const home = (id: string) => codexManagedHomePath(path as never, config.stateDir, id);
    const probe: Harness["probe"] = { status: "disk" };
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettings.ServerSettingsService;
          const codexIds = Effect.map(serverSettings.getSettings, (s) => [
            ...new Set(["codex", ...Object.entries(s.providerInstances).filter(([, v]) => v.driver === "codex").map(([k]) => k)]),
          ]);
          // The provider snapshots the runtime would probe: signed in when the managed home holds auth.json.
          const snapshots = Effect.map(codexIds, (ids) =>
            ids.map(
              (id) =>
                ({
                  instanceId: id,
                  driver: "codex",
                  auth: { status: probe.status === "unknown" ? "unknown" : fs.existsSync(path.join(home(id), "auth.json")) ? "authenticated" : "unauthenticated" },
                }) as unknown as ServerProvider,
            ),
          );
          const auths = new Map<string, unknown>();
          const changes = yield* PubSub.unbounded<void>();
          const instance = (id: string) =>
            Effect.gen(function* () {
              if (!(yield* codexIds).includes(id)) return undefined;
              if (!auths.has(id)) {
                const instanceId = ProviderInstanceId.make(id);
                const launch = resolveCodexLaunch({ path: path as never, stateDir: config.stateDir, instanceId, config: settings, environment: process.env });
                auths.set(id, yield* makeCodexApiKeyAuth({ instanceId, launch, onChanged: Effect.void }));
              }
              return { instanceId: id, auth: auths.get(id) };
            }).pipe(Scope.provide(scope));
          const fakes = Layer.mergeAll(
            Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
              getInstance: instance,
              listInstances: Effect.flatMap(codexIds, (ids) => Effect.forEach(ids, instance)),
              subscribeChanges: PubSub.subscribe(changes),
            } as never),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, { getRecoveryThreadIds: () => Effect.succeed([]) } as never),
            Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {} as never),
          );
          const accounts = yield* makeEngineAccounts.pipe(
            Effect.provide(ProviderAuthService.layer.pipe(Layer.provide(fakes))),
            Effect.provideService(ProviderRegistry.ProviderRegistry, { getProviders: snapshots, refreshInstance: () => snapshots } as never),
            // The adapters a turn could run on: one per configured instance, as the runtime's registry has.
            Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
              list: () => Effect.map(codexIds, (ids) => ids.map((id) => ProviderInstanceId.make(id))),
            } as never),
          );
          yield* body({ accounts, instances: Effect.map(serverSettings.getSettings, (s) => s.providerInstances), home, probe });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Store.layer.pipe(
                Layer.provide(SqlitePersistence.layerMemory),
                // The store scrubs every event of repository secrets.
                Layer.provide(
                  ProjectSecretsLive.layer.pipe(
                    Layer.provide(ServerSecretStore.layer),
                    Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
                    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                  ),
                ),
              ),
              ServerSettings.layerTest(),
              Layer.succeed(ServerConfig.ServerConfig, config),
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
          Effect.scoped,
        ) as Effect.Effect<void, unknown>,
      );
      const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
      after({ calls, stateDir: config.stateDir, home });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      process.env.PATH = saved.PATH;
      delete process.env.FAKE_CODEX_OPENAI_BASE_URL;
      await new Promise((closed) => openAi.close(closed));
      if (saved.FAKE_CODEX_LOG === undefined) delete process.env.FAKE_CODEX_LOG;
      else process.env.FAKE_CODEX_LOG = saved.FAKE_CODEX_LOG;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const REFUSED_KEY = "sk-engine-accounts-test-refused-0000";
  const OPENAI_REJECTS = "sk-engine-accounts-test-openai-rejects-0000";
  const codexDirs = (h: Harness) => fs.readdirSync(path.dirname(path.dirname(h.home("codex")))).sort();

  test("add signs in inside a managed home of its own, activate picks one, remove signs out and deletes the home", async () => {
    await withCodex(
      (h) =>
        Effect.gen(function* () {
          const { accounts, home } = h;
          // The first key goes into the default `codex` slot and is active.
          const first = yield* accounts.add({ request_id: "c1", engine: "codex", key: CODEX_KEY });
          expect(first.accounts).toEqual([{ id: "codex", label: "OpenAI API key ...c0d3", kind: "api_key", active: true, tag: "OA" }]);
          expect(JSON.parse(fs.readFileSync(path.join(home("codex"), "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: CODEX_KEY });
          // Skipped on Windows: no POSIX mode bits (the profile's ACL keeps the home).
          if (process.platform !== "win32") expect(fs.statSync(home("codex")).mode & 0o777).toBe(0o700);

          // A second key gets an instance and a home of its own; the first stays active until activate.
          const second = yield* accounts.add({ request_id: "c2", engine: "codex", key: CODEX_KEY_2 });
          const other = second.accounts.find((a) => a.id !== "codex")!;
          expect(other).toMatchObject({ label: "OpenAI API key ...9b1c", kind: "api_key", active: false, tag: "OA2" });
          expect(other.id).toMatch(/^codex-account-[0-9a-f]{8}$/);
          expect(fs.existsSync(path.join(home(other.id), "auth.json"))).toBe(true);
          // A tag the person sets sticks to that account; null goes back to a default, unique within the engine.
          const tagged = yield* accounts.tag({ request_id: "t1", engine: "codex", account_id: other.id, tag: "WRK" });
          expect(tagged.accounts.map((a) => a.tag)).toEqual(["OA", "WRK"]);
          expect((yield* accounts.tag({ request_id: "t2", engine: "codex", account_id: other.id, tag: null })).accounts.map((a) => a.tag)).toEqual(["OA", "OA2"]);
          expect(yield* accounts.instanceOf("codex", "codex")).toBe("codex");
          yield* accounts.activate({ request_id: "c3", engine: "codex", account_id: other.id });
          expect(yield* accounts.instanceOf("codex", "codex")).toBe(other.id);
          // A workspace that started on the default account keeps it after activate.
          expect(yield* accounts.instanceOf("codex", "codex", "codex")).toBe("codex");

          // A blank key never reaches Codex; a key Codex refuses leaves no account and no home behind.
          const before = yield* h.instances;
          const dirs = codexDirs(h);
          expect(yield* Effect.flip(accounts.add({ request_id: "c4", engine: "codex", key: "   " }))).toMatchObject({ reason: "invalid_params", message: "Enter an API key." });
          const refused = yield* Effect.flip(accounts.add({ request_id: "c4b", engine: "codex", key: REFUSED_KEY }));
          expect(refused).toMatchObject({ reason: "invalid_params", message: "Codex did not accept the API key." });
          expect(yield* h.instances).toEqual(before);
          expect(codexDirs(h)).toEqual(dirs);
          // Codex stores any key; one OpenAI refuses after the login leaves nothing behind either.
          const rejected = yield* Effect.flip(accounts.add({ request_id: "c4c", engine: "codex", key: OPENAI_REJECTS }));
          expect(rejected).toMatchObject({ reason: "invalid_params", message: "Codex did not accept the API key." });
          expect(yield* h.instances).toEqual(before);
          expect(codexDirs(h)).toEqual(dirs);

          // Remove: sign out in its home, then delete the app's directory; the default account takes over,
          // and a workspace still on the removed account moves to it rather than failing every turn.
          const left = yield* accounts.remove({ request_id: "c5", engine: "codex", account_id: other.id });
          expect(left.accounts).toEqual([{ id: "codex", label: "OpenAI API key ...c0d3", kind: "api_key", active: true, tag: "OA" }]);
          expect(fs.existsSync(path.dirname(home(other.id)))).toBe(false);
          expect(yield* accounts.instanceOf("codex", "codex")).toBe("codex");
          expect(yield* accounts.instanceOf("codex", "codex", other.id)).toBe("codex");
          const none = yield* accounts.remove({ request_id: "c6", engine: "codex", account_id: "codex" });
          expect(none.accounts).toEqual([]);
          // The default slot keeps an empty owner-only home and no key.
          expect(fs.readdirSync(home("codex"))).toEqual([]);
          expect((yield* Effect.flip(accounts.remove({ request_id: "c7", engine: "codex", account_id: "codex" }))).reason).toBe("not_found");
        }),
      ({ calls, stateDir, home }) => {
        // Codex itself took each key over the app-server's stdin, inside that account's managed home, never through its environment.
        const logins = calls.filter((c) => c.method === "account/login/start");
        expect(logins).toHaveLength(4);
        expect(logins[0]).toEqual({ home: home("codex"), method: "account/login/start", key_in_env: false });
        expect(logins.every((c) => c.key_in_env === false)).toBe(true);
        expect(calls.filter((c) => c.method === "account/logout").map((c) => c.home)).toContain(home("codex"));
        expect(calls.every((c) => c.home.startsWith(stateDir))).toBe(true);
        for (const key of [CODEX_KEY, CODEX_KEY_2, REFUSED_KEY, OPENAI_REJECTS]) expect(filesHolding(path.dirname(stateDir), key)).toEqual([]);
      },
    );
  }, 60_000);

  test("a key already in the default home counts before the probe has run: an add never replaces or deletes it", async () => {
    const SEEDED = "sk-engine-accounts-test-3333-seeded-5eed";
    await withCodex(
      (h) =>
        Effect.gen(function* () {
          const { accounts, home } = h;
          fs.mkdirSync(home("codex"), { recursive: true, mode: 0o700 });
          const auth = path.join(home("codex"), "auth.json");
          fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: SEEDED }), { mode: 0o600 });
          const seeded = fs.readFileSync(auth, "utf8");
          // Runtime start: the probe has not run, every account reads "unknown".
          h.probe.status = "unknown";
          expect(yield* accounts.accountsOf("codex")).toEqual([{ id: "codex", label: "OpenAI API key", kind: "api_key", active: true, tag: "OA" }]);

          const refused = yield* Effect.flip(accounts.add({ request_id: "u1", engine: "codex", key: REFUSED_KEY }));
          expect(refused).toMatchObject({ reason: "invalid_params" });
          expect(fs.readFileSync(auth, "utf8")).toBe(seeded);

          // A good key gets an account of its own; the default keeps its key and stays active.
          const added = yield* accounts.add({ request_id: "u2", engine: "codex", key: CODEX_KEY });
          const other = added.accounts.find((a) => a.id !== "codex")!;
          expect(other.id).toMatch(/^codex-account-[0-9a-f]{8}$/);
          expect(added.accounts).toEqual([
            { id: "codex", label: "OpenAI API key", kind: "api_key", active: true, tag: "OA" },
            { id: other.id, label: "OpenAI API key ...c0d3", kind: "api_key", active: false, tag: "OA2" },
          ]);
          expect(fs.readFileSync(auth, "utf8")).toBe(seeded);

          // An account the probe has not checked yet can be made active, and stays the one new workspaces get.
          yield* accounts.activate({ request_id: "u3", engine: "codex", account_id: other.id });
          expect(yield* accounts.instanceOf("codex", "codex")).toBe(other.id);
        }),
      ({ calls }) => {
        // The refused key and the good one each went to a new instance, never to the default home.
        expect(calls.filter((c) => c.method === "account/login/start").map((c) => path.basename(path.dirname(c.home)))).not.toContain("codex");
      },
    );
  }, 60_000);
});

describe("several Claude logins and ChatGPT logins", () => {
  type Accounts = Effect.Success<typeof makeEngineAccounts>;

  /**
   * makeEngineAccounts over the runtime's settings, with provider snapshots made from them: a login is signed
   * in once `login` names it (as its own claude or codex would report after the person signed in there).
   * Nothing is ever signed in for real and no CLI runs.
   */
  async function withLogins(
    body: (accounts: Accounts, login: Map<string, { email: string; type: string; used?: number }>, stateDir: string) => Effect.Effect<void, unknown>,
    keys?: EngineCloudKeysShape,
    pty?: PtyAdapter.PtyAdapter["Service"],
  ) {
    const config = await makeConfig();
    const login = new Map<string, { email: string; type: string; used?: number }>();
    await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        const snapshots = Effect.map(serverSettings.getSettings, (s) =>
          [...new Set(["claudeAgent", "codex", ...Object.keys(s.providerInstances)])].map((id) => {
            const codex = id.startsWith("codex");
            const auth = login.get(id);
            return {
              instanceId: id,
              driver: codex ? "codex" : "claudeAgent",
              checkedAt: "2026-10-17T00:00:00.000Z",
              auth: auth ? { status: "authenticated", email: auth.email, type: auth.type } : { status: "unauthenticated" },
              models: codex ? [{ slug: "gpt-6-astra" }] : [{ slug: "claude-opus-5-5" }, { slug: "claude-sonnet-5-5" }],
              ...(auth?.used === undefined ? {} : { usageLimits: { windows: [{ id: "five_hour", label: "5h", kind: "session", usedPercent: auth.used }] } }),
            } as unknown as ServerProvider;
          }),
        );
        const accounts = yield* makeEngineAccounts.pipe(
          Effect.provideService(ProviderRegistry.ProviderRegistry, { getProviders: snapshots, refreshInstance: () => snapshots, refreshWorkspaceSnapshot: () => snapshots } as never),
          keys ? Effect.provideService(EngineCloudKeys, keys) : (effect) => effect,
          pty ? Effect.provideService(PtyAdapter.PtyAdapter, pty) : (effect) => effect,
          Effect.provideService(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
            list: () => Effect.map(snapshots, (list) => list.map((p) => p.instanceId)),
          } as never),
        );
        yield* body(accounts, login, config.stateDir);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Store.layer.pipe(
              Layer.provide(SqlitePersistence.layerMemory),
              Layer.provide(
                ProjectSecretsLive.layer.pipe(
                  Layer.provide(ServerSecretStore.layer),
                  Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
                  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                ),
              ),
            ),
            ServerSettings.layerTest(),
            Layer.succeed(ServerConfig.ServerConfig, config),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
        Effect.scoped,
      ) as Effect.Effect<void, unknown>,
    );
  }

  /** A pty for the sign-in CLIs that prints each one's page and records how it was started (never through tools). */
  const fakeLoginPty = (started: Array<{ shell: string; args: ReadonlyArray<string>; cwd: string; env: NodeJS.ProcessEnv }>): PtyAdapter.PtyAdapter["Service"] => ({
    spawn: (input) =>
      Effect.sync(() => {
        started.push({ shell: input.shell, args: input.args ?? [], cwd: input.cwd, env: input.env });
        const listeners: Array<(data: string) => void> = [];
        setTimeout(() => {
          const page = input.shell.endsWith("claude")
            ? "Browser didn't open? Use the url below to sign in\r\n\x1b[1mhttps://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s1\x1b[0m\r\nPaste code here if prompted > "
            : "Open https://auth.openai.com/codex/device and enter this one-time code ABCD-EFGH\r\n";
          for (const listener of listeners) listener(page);
        }, 5);
        return { pid: 1, write: () => undefined, resize: () => undefined, kill: () => undefined, onData: (cb: (data: string) => void) => (listeners.push(cb), () => undefined), onExit: () => () => undefined } as PtyAdapter.PtyProcess;
      }),
  });

  // Skipped on Windows: a Cloud computer is Linux.
  test.skipIf(process.platform === "win32")("on a Cloud computer: Claude Agent's API key goes to the vault, and each engine signs in in the runtime container, never in a terminal in tools", async () => {
    const kept: Array<[string, string | null]> = [];
    const keys: EngineCloudKeysShape = { get: () => Effect.succeed(undefined), set: (engine, key) => Effect.sync(() => void kept.push([engine, key])) };
    const started: Array<{ shell: string; args: ReadonlyArray<string>; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const connected = vi.spyOn(followedLogins, "connected", "get").mockReturnValue(true);
    process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = "127.0.0.1:1";
    try {
      await withLogins(
        (accounts, _login, stateDir) =>
          Effect.gen(function* () {
            expect(yield* accounts.add({ request_id: "c1", engine: "claude-agent", key: (" sk-" + "ant-cloud-key ") })).not.toHaveProperty("sign_in");
            expect(kept).toEqual([["claude-agent", ("sk-" + "ant-cloud-key")]]);
            expect(yield* Effect.flip(accounts.add({ request_id: "c2", engine: "claude-agent", key: "  " }))).toMatchObject({ reason: "invalid_params" });
            // No command to run in a terminal (that would be the tools container): the page to open.
            const claude = ((yield* accounts.add({ request_id: "c3", engine: "claude-agent" })) as { sign_in?: { command: string; url?: string; message: string } }).sign_in;
            expect(claude).toMatchObject({ command: "", url: "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s1", message: expect.stringContaining("This sign-in will follow you to your Cloud computers") });
            const codex = (yield* accounts.signin({ request_id: "c4", engine: "codex", provider: "follow" })) as { url?: string; code?: string };
            expect(codex).toMatchObject({ url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH" });
            // Each CLI started by its image path, in a private 0700 folder under the runtime's state, with nothing of
            // the runtime's environment but the network's.
            expect(started.map((s) => [s.shell, s.args.join(" ")])).toEqual([
              ["/usr/local/bin/claude", "auth login --claudeai"],
              ["/usr/local/bin/codex", '-c cli_auth_credentials_store="file" login --device-auth'],
            ]);
            for (const s of started) {
              const dir = s.env.CLAUDE_CONFIG_DIR ?? s.env.CODEX_HOME!;
              expect(path.dirname(dir)).toBe(path.join(stateDir, "sign-ins"));
              expect([s.cwd, s.env.HOME]).toEqual([dir, dir]);
              expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
              expect(Object.keys(s.env).every((name) => ["PATH", "HOME", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "LANG", "LC_ALL"].includes(name) || /proxy|CERT/i.test(name))).toBe(true);
            }
          }),
        keys,
        fakeLoginPty(started),
      );
    } finally {
      delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      connected.mockRestore();
    }
  });

  test("on a Cloud computer a key starts no sign-in; removing a followed sign-in signs out everywhere", async () => {
    const keys: EngineCloudKeysShape = { get: () => Effect.succeed(undefined), set: () => Effect.void };
    const spies = [vi.spyOn(followedLogins, "connected", "get").mockReturnValue(true), vi.spyOn(followedLogins, "hasLogin").mockReturnValue(true)];
    const started: Array<{ shell: string; args: ReadonlyArray<string>; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const signOut = vi.spyOn(followedLogins, "signOut").mockResolvedValue();
    process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = "127.0.0.1:1";
    try {
      await withLogins(
        (accounts) =>
          Effect.gen(function* () {
            // A key is not a sign-in: no CLI starts.
            yield* accounts.add({ request_id: "f0", engine: "claude-agent", key: ("sk-" + "ant-cloud-key") });
            expect(started).toHaveLength(0);
            yield* accounts.remove({ request_id: "f3", engine: "claude-agent", account_id: "claudeAgent:default" });
            expect(signOut).toHaveBeenCalledWith("claude-agent");
          }),
        keys,
        fakeLoginPty(started),
      );
    } finally {
      delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      for (const spy of [...spies, signOut]) spy.mockRestore();
    }
  });

  test("two Claude logins and two ChatGPT logins are four accounts, each picked by id, with its own tag and limits; removing one leaves the rest", async () => {
    await withLogins((accounts, login, stateDir) =>
      Effect.gen(function* () {
        // The person's own claude, signed in on their plan.
        login.set("claudeAgent", { email: "claire.adams@work.example", type: "max", used: 40 });
        // One more Claude login: a config folder of its own, signed in there with their own claude.
        const added = yield* accounts.add({ request_id: "l1", engine: "claude-agent", another: true });
        const extra = added.accounts.find((a) => a.id !== "claudeAgent:default")!;
        expect(extra.id).toMatch(/^claudeAgent-account-[0-9a-f]{8}$/);
        const dir = path.join(stateDir, "providers", "claudeAgent", extra.id, "config");
        expect(fs.statSync(dir).isDirectory()).toBe(true);
        expect((added as { sign_in?: { command: string } }).sign_in?.command).toBe(`CLAUDE_CONFIG_DIR='${dir}' claude`);
        // Not signed in yet: listed, tagged by its place, never picked.
        expect(extra).toMatchObject({ label: "Signed out", tag: "C2", active: false, health: { state: "failing" } });
        expect(yield* Effect.flip(accounts.instanceOfAccount("claude-agent", extra.id))).toMatchObject({ reason: "invalid_state" });
        // Asked again while it waits: the same login, not a third.
        const again = yield* accounts.add({ request_id: "l2", engine: "claude-agent", another: true });
        expect(again.accounts.map((a) => a.id)).toEqual(added.accounts.map((a) => a.id));
        login.set(extra.id, { email: "chris.miller@home.example", type: "pro", used: 75 });

 // Two compact logins for Codex: the person's own codex login, and one more in a home of its own.
        yield* accounts.add({ request_id: "l3", engine: "codex", chatgpt: true });
        login.set("codex-account-chatgpt", { email: "claire.adams@work.example", type: "chatgpt" });
        const chatgpt = yield* accounts.add({ request_id: "l4", engine: "codex", chatgpt: true, another: true });
        const second = chatgpt.accounts.find((a) => a.id.startsWith("codex-account-chatgpt-"))!;
        expect((chatgpt as { sign_in?: { command: string } }).sign_in?.command).toBe(`CODEX_HOME='${path.join(stateDir, "providers", "codex", second.id, "home")}' codex login`);
        login.set(second.id, { email: "chris.miller@home.example", type: "chatgpt" });

        const claude = (yield* accounts.accountsOf("claude-agent"))!;
        expect(claude.map((a) => [a.id, a.label, a.tag, a.usage_limits?.[0]?.used_percent])).toEqual([
          ["claudeAgent:default", "claire.adams@work.example", "CA", 40],
          [extra.id, "chris.miller@home.example", "CM", 75],
        ]);
        const codex = (yield* accounts.accountsOf("codex"))!;
        expect(codex.map((a) => [a.id, a.label, a.tag])).toEqual([
          ["codex-account-chatgpt", "claire.adams@work.example", "CA"],
          [second.id, "chris.miller@home.example", "CM"],
        ]);
        // Each account is its own instance: picking one runs the chat there.
        expect(yield* accounts.instanceOfAccount("claude-agent", "claudeAgent:default")).toBe("claudeAgent");
        expect(yield* accounts.instanceOfAccount("claude-agent", extra.id)).toBe(extra.id);
        expect(yield* accounts.instanceOfAccount("codex", second.id)).toBe(second.id);
        expect(yield* Effect.flip(accounts.instanceOfAccount("claude-agent", second.id))).toMatchObject({ reason: "invalid_params" });
        // The resolver lists all four, one source per login; the Chief's Claude-plan route can name either Claude one.
        const logins = (yield* accounts.connected).filter((source) => source.kind === "login");
        expect(logins.map((source) => [source.engine, source.id])).toEqual([
          ["claude-agent", "claudeAgent:default"],
          ["claude-agent", extra.id],
          ["codex", "codex-account-chatgpt"],
          ["codex", second.id],
        ]);
        expect((yield* accounts.claudePlans).map((plan) => [plan.account_id, plan.tag, plan.active])).toEqual([
          ["claudeAgent:default", "CA", true],
          [extra.id, "CM", false],
        ]);
        // Make active: new chats take it; a chat on the other keeps its own.
        yield* accounts.activate({ request_id: "l5", engine: "claude-agent", account_id: extra.id });
        expect(yield* accounts.instanceOf("claude-agent", "claudeAgent")).toBe(extra.id);
        expect(yield* accounts.instanceOf("claude-agent", "claudeAgent", "claudeAgent")).toBe("claudeAgent");

        // Removing the extra Claude login deletes only its folder; the person's own login and both Codex ones stay.
        yield* accounts.remove({ request_id: "l6", engine: "claude-agent", account_id: extra.id });
        expect(fs.existsSync(path.dirname(dir))).toBe(false);
        expect((yield* accounts.accountsOf("claude-agent"))!.map((a) => [a.id, a.active])).toEqual([["claudeAgent:default", true]]);
        expect((yield* accounts.accountsOf("codex"))!.map((a) => a.id)).toEqual(["codex-account-chatgpt", second.id]);
 // The person's own login is never the app's to remove; the extra compact login is.
        expect(yield* Effect.flip(accounts.remove({ request_id: "l7", engine: "claude-agent", account_id: "claudeAgent:default" }))).toMatchObject({ reason: "invalid_params" });
        yield* accounts.remove({ request_id: "l8", engine: "codex", account_id: second.id });
        expect((yield* accounts.accountsOf("codex"))!.map((a) => a.id)).toEqual(["codex-account-chatgpt"]);
      }),
    );
  }, 60_000);
});

describe("Caveman key health from real turns", () => {
  test("a 401 in a turn marks its key failing, a 429 limited, and a finished turn makes it ok again", async () => {
    const config = await makeConfig();
    const health = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store.SessionStore;
        const accounts = yield* makeEngineAccounts;
        yield* accounts.add({ request_id: "k1", engine: "caveman", provider: "openai", key: OPENAI_KEY });
        let cursor = 0;
        const publish = (type: string, payload: unknown, session = "s1") =>
          PubSub.publish(store.events, { session_id: session, cursor: ++cursor, at: `2026-10-17T00:00:0${cursor % 10}.000Z`, type, payload } as SessionEvent);
        const now = () =>
          accounts.accountsOf("caveman").pipe(Effect.map((all) => all?.find((a) => a.provider === "openai")?.health?.state));
        const settle = (want: string | undefined) =>
          Effect.gen(function* () {
            for (let i = 0; i < 100 && (yield* now()) !== want; i++) yield* Effect.sleep("20 millis");
            return yield* now();
          });
        const seen: Array<string | undefined> = [yield* now()];
        yield* publish("turn.started", { engine: "caveman", model: "openai/gpt-6-luna" });
        yield* publish("turn.done", { status: "failed", error: "OpenAI: 401 Incorrect API key provided" });
        seen.push(yield* settle("failing"));
        // Auto's pick is the usage's model; a quota is a limit.
        yield* publish("turn.started", { engine: "caveman", model: "caveman-auto" });
        yield* publish("usage", { engine: "caveman", model: "openai/gpt-6-luna", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: null });
        yield* publish("turn.done", { status: "failed", error: "429 You exceeded your current quota" });
        seen.push(yield* settle("limited"));
        // Auto refused on its first request: no usage names the pick, so the key it started on is the one.
        yield* publish("turn.started", { engine: "caveman", model: "auto" });
        yield* publish("turn.done", { status: "failed", error: "OpenAI: 401 Incorrect API key provided" });
        seen.push(yield* settle("failing"));
        // Rate limited, the engine went on with another provider's key and finished there: the key it left is limited.
        yield* publish("turn.started", { engine: "caveman", model: "openai/gpt-6-luna" });
        yield* publish("model.routed", { model: "anthropic/claude-sonnet-5-5" });
        yield* publish("turn.done", { status: "completed" });
        seen.push(yield* settle("limited"));
        // Another engine's failure, or a key that is not stored, changes nothing.
        yield* publish("turn.started", { engine: "codex", model: "gpt-6-luna" }, "s2");
        yield* publish("turn.done", { status: "failed", error: "401 Unauthorized" }, "s2");
        yield* publish("turn.started", { engine: "caveman", model: "google/gemini-2.5-flash" }, "s3");
        yield* publish("turn.done", { status: "failed", error: "401 Unauthorized" }, "s3");
        yield* publish("turn.started", { engine: "caveman", model: "openai/gpt-6-luna" });
        yield* publish("turn.done", { status: "completed" });
        seen.push(yield* settle("ok"));
        return seen;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Store.layer.pipe(
              Layer.provide(SqlitePersistence.layerMemory),
              Layer.provide(
                ProjectSecretsLive.layer.pipe(
                  Layer.provide(ServerSecretStore.layer),
                  Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
                  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                ),
              ),
            ),
            ServerSettings.layerTest(),
            Layer.succeed(ServerConfig.ServerConfig, config),
            NodeServices.layer,
            NodeCrypto.layer,
            TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
            Layer.succeed(CavemanKeyTester, () => Effect.succeed({ ok: true as const, model: "stub" })),
          ),
        ),
        Effect.scoped,
      ) as Effect.Effect<Array<string | undefined>, unknown>,
    );
    expect(health).toEqual(["ok", "failing", "limited", "failing", "limited", "ok"]);
  });
});

describe("Harness accounts", () => {
  /**
   * engineAccounts over a fake registry (a snapshot per enabled harness instance in the settings)
   * and a fake ProviderAuthService whose states the test pushes. No harness CLI runs.
   */
  interface Fakes {
    readonly accounts: Effect.Success<typeof makeEngineAccounts>;
    readonly instances: Effect.Effect<Record<string, { readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }> }>>;
    /** Pushes the next sign-in state of an instance's open flow. */
    readonly push: (instanceId: string, state: { phase: string; authorizationUrl?: string; message?: string }) => Effect.Effect<void>;
    readonly starts: Array<string>;
    readonly completes: Array<{ instanceId: string; flowId: string; callbackUrl: string }>;
    /** While set, every probe (refreshInstance) hangs until it is released. */
    readonly wedge: { gate: Deferred.Deferred<void> | undefined };
  }
  const withHarnesses = <A>(
    body: (f: Fakes) => Effect.Effect<A, unknown, never>,
    options: { readonly clock?: boolean; readonly egress?: EgressRoute["Service"]; readonly version?: string; readonly auth?: "unauthenticated" | "unknown" } = {},
  ) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => makeConfig());
      return yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        const harnessIds = Effect.map(serverSettings.getSettings, (s) =>
          Object.entries(s.providerInstances).filter(([, v]) => harnessEngineOf(v.driver) !== undefined && v.enabled !== false),
        );
        const snapshots = Effect.map(harnessIds, (ids) =>
          ids.map(([id, v]) => ({ instanceId: id, driver: v.driver, enabled: true, installed: true, auth: { status: options.auth ?? "unauthenticated" }, displayName: id, ...(options.version ? { version: options.version } : {}) }) as unknown as ServerProvider),
        );
        const flows = new Map<string, Queue.Queue<unknown>>();
        const starts: Array<string> = [];
        const completes: Fakes["completes"] = [];
        const wedge: Fakes["wedge"] = { gate: undefined };
        const flowOf = (id: string) =>
          Effect.gen(function* () {
            if (!flows.has(id)) flows.set(id, yield* Queue.unbounded<unknown>());
            return flows.get(id)!;
          });
        const state = (instanceId: string, s: { phase: string; authorizationUrl?: string; message?: string }) => ({
          instanceId,
          phase: s.phase,
          flowId: `flow-${instanceId}`,
          authorizationUrl: s.authorizationUrl ?? null,
          expiresAt: null,
          message: s.message ?? null,
        });
        const auth = {
          start: (input: { instanceId: string }) =>
            Effect.sync(() => {
              starts.push(input.instanceId);
              return state(input.instanceId, { phase: "starting" });
            }),
          subscribe: (input: { instanceId: string }) => Stream.unwrap(Effect.map(flowOf(input.instanceId), (q) => Stream.fromQueue(q))),
          complete: (input: { instanceId: string; flowId: string; callbackUrl: string }) =>
            Effect.gen(function* () {
              completes.push(input);
              yield* Queue.offer(yield* flowOf(input.instanceId), state(input.instanceId, { phase: "succeeded" }));
              return state(input.instanceId, { phase: "verifying" });
            }),
        };
        const accounts = yield* makeEngineAccounts.pipe(
          // The scrub, when a test gives one, only while the accounts are built (as the runtime's layers do).
          options.egress ? Effect.provideService(EgressRoute, options.egress) : (effect) => effect,
          Effect.provideService(ProviderAuthService.ProviderAuthService, auth as never),
          Effect.provideService(ProviderRegistry.ProviderRegistry, {
            getProviders: snapshots,
            refreshInstance: () => Effect.flatMap(Effect.sync(() => wedge.gate), (gate) => (gate ? Deferred.await(gate) : Effect.void)).pipe(Effect.andThen(snapshots)),
          } as never),
        );
        return yield* body({
          accounts,
          instances: Effect.orDie(Effect.map(serverSettings.getSettings, (s) => s.providerInstances as never)),
          push: (id, s) => Effect.flatMap(flowOf(id), (q) => Queue.offer(q, state(id, s))).pipe(Effect.asVoid),
          starts,
          completes,
          wedge,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Store.layer.pipe(
              Layer.provide(SqlitePersistence.layerMemory),
              Layer.provide(
                ProjectSecretsLive.layer.pipe(
                  Layer.provide(ServerSecretStore.layer),
                  Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
                  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                ),
              ),
            ),
            ServerSettings.layerTest(),
            Layer.succeed(ServerConfig.ServerConfig, config),
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.succeed(CavemanKeyTester, () => Effect.succeed({ ok: true as const, model: "stub" })),
            options.clock ? TestClock.layer() : Layer.empty,
          ),
        ),
        Effect.scoped,
      );
    });
  type SignIn = { readonly sign_in?: { readonly command?: string; readonly url?: string } };
  const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect as Effect.Effect<A>);
  const reasonOf = (effect: Effect.Effect<unknown, unknown, never>) =>
    effect.pipe(
      Effect.match({ onSuccess: () => ({ reason: "ok", message: "" }), onFailure: (e) => ({ reason: (e as ProtocolError).reason, message: (e as ProtocolError).message }) }),
    );

  test("OpenCode says it goes through the proxy when the scrub is up, though a call runs without the scrub in context", async () => {
    const egress = { route: () => "http://127.0.0.1:1/token/route", owns: () => false } as unknown as EgressRoute["Service"];
    await run(
      withHarnesses(
        ({ accounts }) =>
          Effect.gen(function* () {
            yield* accounts.add({ request_id: "oc", engine: "opencode" });
            expect(yield* accounts.proxies("opencode", "opencode")).toBe(true);
          }),
        { egress, version: "2.0.22" },
      ),
    );
    // No scrub at all: never claimed.
    await run(
      withHarnesses(
        ({ accounts }) =>
          Effect.gen(function* () {
            yield* accounts.add({ request_id: "oc", engine: "opencode" });
            expect(yield* accounts.proxies("opencode", "opencode")).toBe(false);
          }),
        { version: "2.0.22" },
      ),
    );
  });

  test("a wedged probe or a slow sign-in never holds the accounts lock", async () => {
    await run(
      withHarnesses(({ accounts, wedge, push }) =>
        Effect.gen(function* () {
          wedge.gate = yield* Deferred.make<void>();
 // native browser sign-in, its probe hanging: other account changes go on meanwhile.
          const adding = yield* accounts.add({ request_id: "a1", engine: "cursor" }).pipe(Effect.forkChild);
          yield* Effect.sleep("200 millis");
          const tagged = yield* accounts.tag({ request_id: "t1", engine: "cursor", account_id: "cursor", tag: "WRK" }).pipe(Effect.timeout("2 seconds"));
          expect(tagged.accounts.map((a) => a.tag)).toEqual(["WRK"]);
          yield* Deferred.succeed(wedge.gate, undefined);
          wedge.gate = undefined;
          yield* push("cursor", { phase: "waiting", authorizationUrl: "https://cursor.com/loginDeepControl?x=1" });
          expect(((yield* Fiber.join(adding)) as SignIn).sign_in?.url).toBe("https://cursor.com/loginDeepControl?x=1");
        }),
      ),
    );
  }, 30_000);

  test("a sign-in slower than the wait stays open and hands its page to the next Sign in; a pasted redirect finishes it", async () => {
    await run(
      withHarnesses(
        ({ accounts, push, starts, completes }) =>
          Effect.gen(function* () {
            yield* accounts.add({ request_id: "a1", engine: "cursor", key: "cursor-key-for-a-test" });
            const first = yield* accounts.signin({ request_id: "s1", engine: "cursor", provider: "cursor" }).pipe(Effect.forkChild);
            yield* TestClock.adjust("21 seconds");
            expect(((yield* Fiber.join(first)) as { message?: string }).message).toMatch(/still starting/);
            // The page arrives later (Antigravity's first download); the same flow hands it over, no second start.
            yield* push("cursor", { phase: "waiting", authorizationUrl: "https://example.test/login" });
            expect(yield* accounts.signin({ request_id: "s2", engine: "cursor", provider: "cursor" })).toEqual({ url: "https://example.test/login" });
            expect(starts).toEqual(["cursor"]);
            // A remote computer: the address the browser ended on finishes it here.
            expect((yield* reasonOf(accounts.complete({ request_id: "c0", engine: "cursor", account_id: "cursor", callback_url: "not a url" }))).reason).toBe("invalid_params");
            const done = yield* accounts.complete({ request_id: "c1", engine: "cursor", account_id: "cursor", callback_url: "http://localhost:1455/callback?code=abc" }).pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            yield* Fiber.join(done);
            expect(completes).toEqual([{ instanceId: "cursor", flowId: "flow-cursor", callbackUrl: "http://localhost:1455/callback?code=abc" }]);
          }),
        { clock: true },
      ),
    );
  }, 30_000);

  test("Antigravity installed with its Google login unchecked offers its sign-in; Muse, which never reports one, does not", async () => {
    await run(
      withHarnesses(
        ({ accounts, push }) =>
          Effect.gen(function* () {
            const adding = yield* accounts.add({ request_id: "a1", engine: "antigravity" }).pipe(Effect.forkChild);
            yield* push("antigravity", { phase: "waiting", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
            const [antigravity] = (yield* Fiber.join(adding)).accounts;
            expect(antigravity).toMatchObject({ id: "antigravity", health: { state: "failing", message: "Not signed in yet." } });
            // Muse's probe answers "unknown" even signed in: no sign-in is asked of it.
            const [muse] = (yield* accounts.add({ request_id: "m1", engine: "muse" })).accounts;
            expect(muse?.health).toBeUndefined();
          }),
        { auth: "unknown" },
      ),
    );
  }, 30_000);

  test("a sign-in that succeeds without a page (an Antigravity API key) is a success; only a failure fails", async () => {
    await run(
      withHarnesses(({ accounts, push }) =>
        Effect.gen(function* () {
          yield* accounts.add({ request_id: "a1", engine: "cursor", key: "cursor-key-for-a-test" });
          yield* push("cursor", { phase: "succeeded" });
          expect(yield* accounts.signin({ request_id: "s1", engine: "cursor", provider: "cursor" })).toEqual({});
          const failed = accounts.signin({ request_id: "s2", engine: "cursor", provider: "cursor" });
          yield* push("cursor", { phase: "failed", message: "Google refused the sign-in." });
          expect(yield* reasonOf(failed)).toEqual({ reason: "engine_unavailable", message: "Google refused the sign-in." });
        }),
      ),
    );
  }, 30_000);

  test("a second keyless account signs in under a home of its own, or is refused where the harness has none", async () => {
    await run(
      withHarnesses(({ accounts, instances }) =>
        Effect.gen(function* () {
          // The first OpenCode account is the person's own login.
          expect(((yield* accounts.add({ request_id: "o1", engine: "opencode" })) as SignIn).sign_in?.command).toBe("opencode auth login");
          const second = (yield* accounts.add({ request_id: "o2", engine: "opencode" })) as SignIn;
          const id = Object.keys(yield* instances).find((k) => k.startsWith("opencode-account-"))!;
          const home = (yield* instances)[id]!.environment!.find((v) => v.name === "XDG_DATA_HOME")!.value;
          expect(home.endsWith(path.join("harness-homes", id)), home).toBe(true);
          // Skipped on Windows: no POSIX mode bits (the profile's ACL keeps the home).
          if (process.platform !== "win32") expect(fs.statSync(home).mode & 0o777).toBe(0o700);
          expect(second.sign_in?.command).toBe(`XDG_DATA_HOME='${home}' opencode auth login`);
          // Sign in again from the account's row: the same home.
          expect(((yield* accounts.signin({ request_id: "o3", engine: "opencode", provider: id })) as { command?: string }).command).toBe(`XDG_DATA_HOME='${home}' opencode auth login`);
          // Muse has no home to move: one keyless account. Grok takes a key for a second one.
          yield* accounts.add({ request_id: "m1", engine: "muse" });
          expect(yield* reasonOf(accounts.add({ request_id: "m2", engine: "muse" }))).toEqual({ reason: "invalid_params", message: "Muse Code keeps one login on this computer, so it has one account here." });
          yield* accounts.add({ request_id: "g1", engine: "grok" });
          expect((yield* reasonOf(accounts.add({ request_id: "g2", engine: "grok" }))).message).toMatch(/needs its own API key/);
          expect((yield* reasonOf(accounts.add({ request_id: "g3", engine: "grok", key: "xai-key-for-a-test" }))).reason).toBe("ok");
        }),
      ),
    );
  }, 30_000);

  test("settings the harness's own schema refuses are invalid_params, and the value never comes back", async () => {
    const pasted = ("AI" + "zaSy-pasted-into-the-wrong-field-0000");
    await run(
      withHarnesses(({ accounts, instances }) =>
        Effect.gen(function* () {
          const refused = yield* reasonOf(accounts.add({ request_id: "g1", engine: "antigravity", fields: { authMethod: pasted } }));
          expect(refused).toEqual({ reason: "invalid_params", message: "Antigravity did not accept Sign-in method." });
          expect(JSON.stringify(yield* instances)).not.toContain(pasted);
        }),
      ),
    );
  }, 30_000);
});

describe("engine logins and keys belong to the runtime's owner", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const reasonIn = (reply: { error?: unknown }) => (reply.error as { data?: { reason?: string } } | undefined)?.data?.reason ?? "ok";

  test("a device This Mac allowed for another person of the org can neither add, remove, switch, tag, test nor sign in its engines' accounts", async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    // A Mac that names its owner takes no other person's device at all (devices.ts). One whose sign-in names nobody
    // still asks its screen about any device, so there a person its screen let in is not its owner.
    cloud.state.enrollWithoutPerson = true;
    // The stand-in CLI serves as the Caveman engine too, so engine.list lists its accounts.
    const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { alsoAs: ["caveman"], provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
    cleanups.push(runtime.close);
    const local = connect(runtime.url, runtime.token);
    cleanups.push(() => local.close());
    await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
    await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
    await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
    const relay = cloud.state.relays[0]!;
    await local.call("engine.account.add", { request_id: "owner-openai", engine: "caveman", provider: "openai", key: OPENAI_KEY });
    const owners = async () => (await local.call("engine.list", {})).engines.find((e) => e.id === "caveman")!.auth.accounts.map((a) => [a.id, a.tag, a.health?.checked_at]);
    const before = await owners();

    // The screen allowed a device of user-2, in the owner's org: its calls run as cloud:user-2.
    const other = await allowedStream(relay, local, undefined, relay.open({ user_id: "user-2", organization_id: cloud.state.organizationId }));
    const tried = {
      add: reasonIn(await other.call("engine.account.add", { request_id: "o-add", engine: "caveman", provider: "anthropic", key: ("sk-" + "ant-other-person-0000") })),
      tag: reasonIn(await other.call("engine.account.tag", { request_id: "o-tag", engine: "caveman", account_id: "caveman:openai", tag: "XX" })),
      test: reasonIn(await other.call("engine.account.test", { request_id: "o-test", engine: "caveman", account_id: "caveman:openai" })),
      activate: reasonIn(await other.call("engine.account.activate", { request_id: "o-activate", engine: "codex", account_id: "codex" })),
      signin: reasonIn(await other.call("engine.account.signin", { request_id: "o-signin", engine: "codex", provider: "openai" })),
      complete: reasonIn(await other.call("engine.account.complete", { request_id: "o-complete", engine: "codex", account_id: "codex", callback_url: "http://127.0.0.1:1/callback" })),
      remove: reasonIn(await other.call("engine.account.remove", { request_id: "o-remove", engine: "caveman", account_id: "caveman:openai" })),
    };
    expect({ ...tried, owners: await owners() }).toEqual({
      add: "forbidden",
      tag: "forbidden",
      test: "forbidden",
      activate: "forbidden",
      signin: "forbidden",
      complete: "forbidden",
      remove: "forbidden",
      owners: before,
    });
  }, 120_000);
});
