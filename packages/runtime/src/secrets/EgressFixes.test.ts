// Review fixes for the egress scrub (review-app.md, 2026-10-15): one test per finding.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ProviderInstanceId, ThreadId, type CodexSettings } from "@caveman-app/protocol";
import { createScrubber, type SecretEntry } from "@caveman-app/session-protocol";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { redactCodexProtocolValue } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerDenyAll } from "../plugins/CredentialBroker.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import { makeEventNdjsonLogStore } from "../provider/EventNdjsonLogger.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as SessionStore from "../session-protocol/store.ts";
import { setAppProxyHome, writeProxyCloud } from "../router/proxyLauncher.ts";
import { layer as layerEgressScrub } from "./EgressScrub.ts";
import {
  claudeSettingsEnv,
  engineSecretEnv,
  layerClaudeEgress,
  layerCodexEgress,
  routeClaudeOptions,
  routeClaudeTextGeneration,
  routeCodexLaunch,
  routeCodexTextGeneration,
  type Egress,
} from "./EngineEgress.ts";
import { ProjectSecrets, ProjectSecretsError } from "./ProjectSecrets.ts";

const CANARY = ("sk_" + "live_canaryvalue0123456789abcdef");
const PROXY = "http://127.0.0.1:4100/tok";
const up: Egress = { route: (u) => `${PROXY}/${Buffer.from(u).toString("hex").slice(0, 12)}`, owns: (u) => u.startsWith(PROXY) };
const down: Egress = { route: () => undefined, owns: () => false };
const egressService = (egress: Egress, hasSecrets = false) =>
  EgressRoute.of({ ...egress, hasSecrets: () => Effect.succeed(hasSecrets) });

/** A ProjectSecrets with fixed answers; `resolve` empty while names list = a locked store. */
const fakeSecrets = (input: {
  readonly names?: ReadonlyArray<string>;
  readonly entries?: ReadonlyArray<SecretEntry>;
  readonly keyError?: "origin_changed" | "not_a_repository";
}) =>
  ProjectSecrets.of({
    keyOf: () =>
      input.keyError === undefined
        ? Effect.succeed("github.com/acme/app")
        : Effect.fail(new ProjectSecretsError({ message: input.keyError, reason: input.keyError })),
    repin: () => Effect.succeed("github.com/acme/app"),
    list: () =>
      Effect.succeed(
        (input.names ?? input.entries?.map((e) => e.name) ?? []).map((name) => ({
          name,
          repository: "github.com/acme/app",
          updated_at: "2026-10-15T00:00:00Z",
          hideable: true,
        })) as never,
      ),
    set: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    resolve: () => Effect.succeed(input.entries ?? []),
    has: () => Effect.succeed((input.entries ?? []).length > 0),
    scrubber: Effect.succeed(createScrubber(input.entries ?? [])),
    changes: Stream.empty,
  });

describe("H1: native provider logs", () => {
  it("scrubs every record by value before it is written", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-h1-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* makeEventNdjsonLogStore(NodePath.join(dir, "events.log"), {
            batchWindowMs: 0,
            scrubber: Effect.succeed(createScrubber([{ name: "STRIPE_SECRET_KEY", value: CANARY }])),
          });
          yield* store.logger("native").write(
            { method: "item/completed", params: { output: `cat .env\nSTRIPE_SECRET_KEY=${CANARY}` } },
            ThreadId.make("thread-h1"),
          );
          yield* store.close();
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      );
      const written = NodeFS.readdirSync(dir)
        .map((file) => NodeFS.readFileSync(NodePath.join(dir, file), "utf8"))
        .join("\n");
      expect(written).not.toContain(CANARY);
      expect(written).toContain("[secret:STRIPE_SECRET_KEY]");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blanks Codex's injected shell env in the protocol log, whatever the name", () => {
    const redacted = redactCodexProtocolValue({
      method: "thread/start",
      params: { config: { "shell_environment_policy.set.DATABASE_URL": "postgres://app:pw@db/app", model: "gpt" } },
    }) as { params: { config: Record<string, string> } };
    expect(redacted.params.config["shell_environment_policy.set.DATABASE_URL"]).toBe("[REDACTED]");
    expect(redacted.params.config.model).toBe("gpt");
  });
});

describe("egress token and M4: the scrub layer", () => {
  it("redacts the app's own Caveman access token the proxies read from their home, an earlier run's and every refreshed one", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-proxy-token-"));
    const earlier = "cvm_at_earlier_run_0123456789abcdef";
    const first = "cvm_at_first_0123456789abcdefghij";
    const refreshed = "cvm_at_refreshed_0123456789abcdefgh";
    const earlierRouting = "cave_router_earlier_0123456789abcd";
    const routing = "cave_router_now_0123456789abcdefg";
    NodeFS.writeFileSync(NodePath.join(home, "credentials"), JSON.stringify({ access_token: earlier, gateway_api_key: earlierRouting }));
    try {
      setAppProxyHome(home);
      const written = writeProxyCloud(home, { cloudUrl: "https://caveman.so", accessToken: first });
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const secrets = yield* ProjectSecrets;
          const before = (yield* secrets.scrubber).scrub(`cat credentials: ${earlier} ${first} ${earlierRouting}`);
          // The sign-in refreshes while engines run: the new token is scrubbed from then on.
          writeProxyCloud(home, { cloudUrl: "https://caveman.so", accessToken: refreshed, routingKey: routing }, written);
          return { before, after: (yield* secrets.scrubber).scrub(JSON.stringify({ output: NodeFS.readFileSync(NodePath.join(home, "credentials"), "utf8") })) };
        }).pipe(Effect.scoped, Effect.provide(layerEgressScrub.pipe(Layer.provide(Layer.succeed(ProjectSecrets, fakeSecrets({})))))),
      );
      expect(out.before).toBe("cat credentials: [secret:CAVEMAN_ACCESS_TOKEN] [secret:CAVEMAN_ACCESS_TOKEN] [secret:CAVEMAN_ACCESS_TOKEN]");
      expect(out.after).not.toContain(refreshed);
      expect(out.after).not.toContain(routing);
      expect(out.after).toContain("[secret:CAVEMAN_ACCESS_TOKEN]");
    } finally {
      setAppProxyHome(undefined);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("needs the store, redacts its own path token everywhere ProjectSecrets scrubs, and answers hasSecrets from names", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const egress = yield* EgressRoute;
        const secrets = yield* ProjectSecrets;
        const url = egress.route("https://api.anthropic.com")!;
        const token = new URL(url).pathname.split("/")[1]!;
        const scrubber = yield* secrets.scrubber;
        return {
          token,
          scrubbed: scrubber.scrub(`error: connect to ${url}/v1/messages failed`),
          deep: JSON.stringify(scrubber.scrubDeep({ message: `base ${url}` })),
          // Names alone count: a locked store with names has secrets.
          has: yield* egress.hasSecrets(process.cwd()),
        };
      }).pipe(Effect.scoped, Effect.provide(layerEgressScrub.pipe(Layer.provide(Layer.succeed(ProjectSecrets, fakeSecrets({ names: ["X_KEY"] })))))),
    );
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    expect(out.scrubbed).not.toContain(out.token);
    expect(out.scrubbed).toContain("[secret:CAVEMAN_EGRESS_TOKEN]");
    expect(out.deep).not.toContain(out.token);
    expect(out.has).toBe(true);
  });
});

const sessionPluginsLayer = (secrets: ReturnType<typeof fakeSecrets>) =>
  PluginRegistry.layerSessionPlugins.pipe(
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(SessionStore.layer),
    Layer.provideMerge(layerDenyAll),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(Layer.succeed(ProjectSecrets, secrets)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "egress-fixes-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const readSecretEnv = (secrets: ReturnType<typeof fakeSecrets>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const plugins = yield* SessionPlugins;
      return yield* plugins.secretEnv!(ThreadId.make("thread-h4"), process.cwd());
    }).pipe(Effect.scoped, Effect.provide(sessionPluginsLayer(secrets))),
  );

describe("H4 and L11: secretEnv", () => {
  it("fails when the repository lists names the store cannot resolve (locked)", async () => {
    const exit = await readSecretEnv(fakeSecrets({ names: ["STRIPE_SECRET_KEY"], entries: [] }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("locked");
  });

  it("stops the engine when the checkout's origin changed; nothing for a path outside git", async () => {
    const changed = await readSecretEnv(fakeSecrets({ entries: [{ name: "A_KEY", value: CANARY }], keyError: "origin_changed" }));
    expect(Exit.isFailure(changed)).toBe(true);
    const outside = await readSecretEnv(fakeSecrets({ entries: [{ name: "A_KEY", value: CANARY }], keyError: "not_a_repository" }));
    expect(Exit.isSuccess(outside) && outside.value).toEqual({});
  });

  it("never hands an engine names that change how its shell or git runs", async () => {
    const exit = await readSecretEnv(
      fakeSecrets({
        entries: [
          { name: "STRIPE_SECRET_KEY", value: CANARY },
          { name: "BASH_ENV", value: "/tmp/evil.sh" },
          { name: "GIT_SSH_COMMAND", value: "ssh -o ProxyCommand=evil" },
          { name: "ANTHROPIC_API_KEY", value: ("sk-" + "ant-project-key") },
        ],
      }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ STRIPE_SECRET_KEY: CANARY });
    expect(
      engineSecretEnv([
        { name: "BASH_ENV", value: "x" },
        { name: "GIT_SSH_COMMAND", value: "y" },
        { name: "OK", value: "z" },
      ]),
    ).toEqual({ OK: "z" });
  });
});

describe("M1: an engine that started unrouted", () => {
  const plugins = (env: () => Record<string, string>) =>
    Layer.succeed(SessionPlugins, {
      acp: () => Effect.succeed([]),
      claudeAgent: () => Effect.die("unused"),
      codex: () => Effect.die("unused"),
      secretEnv: () => Effect.sync(env),
    });

  it("Claude Agent: refuses the next turn once the repository has secrets", async () => {
    let secrets: Record<string, string> = {};
    const offered: unknown[] = [];
    const inner = Layer.succeed(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      open: () => Effect.succeed({ offer: (message: unknown) => Effect.sync(() => void offered.push(message)) }),
    } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryRunner["Service"]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        const session = yield* runner.open({
          // Bedrock: cannot be routed; no secrets yet, so it starts.
          options: { env: { CLAUDE_CODE_USE_BEDROCK: "1" }, settingSources: [] },
          threadId: ThreadId.make("thread-m1"),
          providerSessionId: "ps",
        } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput);
        yield* session.offer({ n: 1 } as never);
        secrets = { STRIPE_SECRET_KEY: CANARY };
        return yield* Effect.flip(session.offer({ n: 2 } as never));
      }).pipe(
        Effect.provide(
          layerClaudeEgress.pipe(Layer.provide(Layer.mergeAll(inner, plugins(() => secrets), Layer.succeed(EgressRoute, egressService(up))))),
        ),
      ),
    );
    expect(offered).toHaveLength(1);
    expect(((result as { cause: Error }).cause).message).toContain("started without the egress scrub");
  });

  it("Codex: refuses turn/start once the repository has secrets", async () => {
    let secrets: Record<string, string> = {};
    const requests: string[] = [];
    const client = {
      request: (method: string) => Effect.sync(() => void requests.push(method)),
      raw: { request: (method: string) => Effect.sync(() => void requests.push(`raw:${method}`)) },
    };
    const inner = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
      open: () => Effect.succeed(client as never),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
        const opened = yield* factory.open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-m1"),
          providerSessionId: "ps",
          runtimePolicy: {},
          // A local provider: cannot be routed; no secrets yet, so it starts.
          settings: { launchArgs: `-c 'model_provider="ollama"'`, homePath: NodeOS.tmpdir() } as CodexSettings,
          environment: {},
        } as never);
        yield* opened.request("turn/start", {} as never);
        secrets = { STRIPE_SECRET_KEY: CANARY };
        yield* opened.request("thread/read", {} as never);
        return yield* Effect.exit(opened.request("turn/start", {} as never));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerCodexEgress.pipe(Layer.provide(Layer.mergeAll(inner, plugins(() => secrets), Layer.succeed(EgressRoute, egressService(up))))),
        ),
      ),
    );
    expect(requests).toEqual(["turn/start", "thread/read"]);
    expect(Exit.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("started without the egress scrub");
  });
});

describe("M5: Codex always runs on the scrub's provider", () => {
  const route = (configText: string, launchArgs?: string) =>
    routeCodexLaunch({ egress: up, configText, launchArgs, environment: {} });

  it("copies the user's provider fields under one forced id, base_url chained, WebSockets off", () => {
    const result = route(
      `model_provider = "corp"\n[model_providers.corp]\nname = "Corp"\nbase_url = "https://gw.corp/v1"\nenv_key = "CORP_KEY"\nwire_api = "responses"\nrequest_max_retries = 4\nsupports_websockets = true\n`,
    );
    if (!("args" in result)) throw new Error(result.unroutable);
    expect(result.args[1]).toBe('model_provider="caveman_code_egress"');
    expect(result.args[3]).toMatch(/^model_providers\.caveman_code_egress=\{ name = "Corp", env_key = "CORP_KEY", wire_api = "responses", request_max_retries = 4, base_url = "http:\/\/127\.0\.0\.1:4100\/tok\/[0-9a-f]+", supports_websockets = false \}$/);
  });

  it("refuses a provider it cannot read safely", () => {
    const cases = {
      dotted: `model_provider = "corp.gw"\n[model_providers."corp.gw"]\nbase_url = "https://gw/v1"\n`,
      inlineHeaders: `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://gw/v1"\nhttp_headers = { "X-Org" = "acme" }\n`,
      subTable: `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://gw/v1"\n[model_providers.corp.query_params]\napi-version = "1"\n`,
      credential: `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://gw/v1"\nexperimental_bearer_token = "abc"\n`,
      multiline: `model_provider = "corp"\n[model_providers.corp]\nbase_url = """\nhttps://gw/v1"""\n`,
      inlineProvider: `model_provider = "corp"\nmodel_providers.corp = { base_url = "https://gw/v1" }\n`,
    };
    for (const [label, config] of Object.entries(cases)) {
      expect(route(config), label).toEqual({ unroutable: expect.any(String) });
    }
    expect(route("", `-c 'model_providers.openai.base_url="https://x"'`)).toEqual({ unroutable: expect.any(String) });
  });
});

describe("M6: text generation", () => {
  it("routes claude -p through the scrub, and refuses when it cannot and the repository has secrets", async () => {
    const routed = await Effect.runPromise(
      routeClaudeTextGeneration({ egress: Option.some(egressService(up)), env: { PATH: "/usr/bin" }, settings: { disableAllHooks: true }, cwd: NodeOS.tmpdir() }),
    );
    expect(routed.env.ANTHROPIC_BASE_URL?.startsWith(PROXY)).toBe(true);
    expect((routed.settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(routed.env.ANTHROPIC_BASE_URL);
    expect(routed.settings.disableAllHooks).toBe(true);
    const refused = await Effect.runPromiseExit(
      routeClaudeTextGeneration({ egress: Option.some(egressService(down, true)), env: {}, settings: {}, cwd: NodeOS.tmpdir() }),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    // No secrets: an unroutable scrub lets it run direct.
    const direct = await Effect.runPromise(
      routeClaudeTextGeneration({ egress: Option.some(egressService(down, false)), env: {}, settings: {}, cwd: NodeOS.tmpdir() }),
    );
    expect(direct.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("gives codex exec the scrub's provider, and refuses when it cannot and the repository has secrets", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-m6-"));
    try {
      const routed = await Effect.runPromise(
        routeCodexTextGeneration({ egress: Option.some(egressService(up)), env: { CODEX_HOME: home }, launchArgs: undefined, cwd: home }),
      );
      expect(routed.args[1]).toBe('model_provider="caveman_code_egress"');
      const refused = await Effect.runPromiseExit(
        routeCodexTextGeneration({ egress: Option.some(egressService(down, true)), env: { CODEX_HOME: home }, launchArgs: undefined, cwd: home }),
      );
      expect(Exit.isFailure(refused)).toBe(true);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("L1: proxies set in Claude settings files", () => {
  it("puts NO_PROXY for the loopback scrub in the env and the flag settings", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-l1-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp:3128", NO_PROXY: "corp.internal" } }));
      const result = routeClaudeOptions({ env: {}, settings: {} } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions, {
        egress: up,
        secrets: [],
        settingsEnv: claudeSettingsEnv({ configDir: root, cwd: undefined, sources: ["user"] }),
      });
      if (!("options" in result)) throw new Error(result.refused);
      const flag = (result.options.settings as { env: Record<string, string> }).env;
      expect(flag.NO_PROXY).toBe("corp.internal,127.0.0.1,localhost");
      expect(result.options.env?.NO_PROXY).toBe("corp.internal,127.0.0.1,localhost");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
