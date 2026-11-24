import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId, ThreadId, type CodexSettings } from "@caveman-app/protocol";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import { tokenizeCliArgs } from "@caveman-app/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vitest";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as OpenCodeRuntime from "@caveman-app/provider-opencode/server/OpenCodeRuntime";
import { proxySession } from "../router/cavemanRouter.ts";
import { appProxy, codexProxy, setAppProxyHome } from "../router/proxyLauncher.ts";
import { ANTHROPIC_VIA_PROXY, CODEX_VIA_PROXY, EgressScrub, OPENAI_AUTO_UPSTREAM, OPENAI_VIA_PROXY } from "./EgressScrub.ts";
import {
  claudeSettingsEnv,
  engineSecretEnv,
  layerClaudeEgress,
  layerCodexEgress,
  layerOpenCodeEgress,
  routeClaudeOptions,
  routeCodexLaunch,
  routeCodexTextGeneration,
  routeCodexOpen,
  openCodeRouting,
  routeOpenCodeEnvironment,
  withCodexThreadEnv,
  withCodexThreadEgress,
  type Egress,
} from "./EngineEgress.ts";

const PROXY = "http://127.0.0.1:4100/tok";
const fakeEgress = (routed: string[] = []): Egress => ({
  route: (upstream) => {
    routed.push(upstream);
    return `${PROXY}/${Buffer.from(upstream).toString("hex").slice(0, 16)}`;
  },
  owns: (url) => url.startsWith(PROXY),
});
const downEgress: Egress = { route: () => undefined, owns: () => false };

it("chosen-model Claude keeps effective custom headers and replaces stale session correlation", () => {
  const routed = routeClaudeOptions(claudeOptions({
    env: { ANTHROPIC_CUSTOM_HEADERS: "x-env: ignored" },
    settings: { env: { ANTHROPIC_CUSTOM_HEADERS: "x-personal: kept\nX-Cave-Session: stale" } },
  }), { egress: fakeEgress(), secrets: [], settingsEnv: {}, threadId: "caveman:chosen" });
  if ("refused" in routed) throw new Error(routed.refused);
  expect(routed.options.env?.ANTHROPIC_CUSTOM_HEADERS).toBe("x-personal: kept\nx-cave-session: caveman:chosen");
  expect(routed.options.settings).toMatchObject({ env: { ANTHROPIC_CUSTOM_HEADERS: "x-personal: kept\nx-cave-session: caveman:chosen" } });
  const fileHeaders = routeClaudeOptions(claudeOptions(), { egress: fakeEgress(), secrets: [], settingsEnv: { ANTHROPIC_CUSTOM_HEADERS: "x-project: kept" }, threadId: "caveman:chosen" });
  expect(fileHeaders).toMatchObject({ options: { env: { ANTHROPIC_CUSTOM_HEADERS: "x-project: kept\nx-cave-session: caveman:chosen" } } });
  // A delegated chat's id carries `%`; the proxy takes only [A-Za-z0-9._:-], so it is spelled out, never refused.
  const delegated = routeClaudeOptions(claudeOptions(), { egress: fakeEgress(), secrets: [], settingsEnv: {}, threadId: "thread:delegated-task:command%3Amcp" });
  expect(delegated).toMatchObject({ options: { env: { ANTHROPIC_CUSTOM_HEADERS: "x-cave-session: thread:delegated-task:command_253Amcp" } } });
  for (const threadId of ["bad\nsession", "a".repeat(400)]) {
    const session = proxySession(threadId);
    expect(session).toMatch(/^[A-Za-z0-9._:-]{1,256}$/);
    expect(proxySession(threadId)).toBe(session);
  }
});

describe("Codex text generation egress", () => {
  it("uses the retrieve-gated proxy through the scrub and preserves OpenAI authentication", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-text-egress-"));
    try {
      const routed: string[] = [];
      const result = await Effect.runPromise(routeCodexTextGeneration({
        egress: Option.some({ ...fakeEgress(routed), hasSecrets: () => Effect.succeed(true) }),
        env: { CODEX_HOME: home },
        launchArgs: undefined,
        cwd: home,
      }));
      expect(routed).toEqual([OPENAI_VIA_PROXY]);
      expect(result.args.join(" ")).toContain(PROXY);
      expect(result.args.join(" ")).toContain("requires_openai_auth = true");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps custom providers scrubbed and refuses a secret-bearing project when the scrub is down", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-text-egress-"));
    try {
      NodeFS.writeFileSync(NodePath.join(home, "config.toml"), 'model_provider = "company"\n[model_providers.company]\nname = "Company"\nbase_url = "https://company.example/v1"\nwire_api = "responses"\n');
      const routed: string[] = [];
      const input = { env: { CODEX_HOME: home }, launchArgs: undefined, cwd: home };
      await Effect.runPromise(routeCodexTextGeneration({ ...input, egress: Option.some({ ...fakeEgress(routed), hasSecrets: () => Effect.succeed(true) }) }));
      expect(routed).toEqual(["https://company.example/v1"]);
      await expect(Effect.runPromise(routeCodexTextGeneration({ ...input, egress: Option.some({ ...downEgress, hasSecrets: () => Effect.succeed(true) }) }))).rejects.toThrow("cannot start without the egress scrub");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

const SECRETS = [
  { name: "CANARY_SECRET", value: "cvs-canary-value-1234567890" },
  // A project's own Anthropic key must not become Claude Agent's login.
  { name: "ANTHROPIC_API_KEY", value: ("sk-" + "ant-project-key-not-the-engines") },
];

const claudeOptions = (extra: Partial<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = {}) =>
  ({
    model: "claude-haiku-4-5",
    tools: [],
    permissionMode: "default",
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "engine-own" },
    ...extra,
  }) as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;

describe("Claude Agent egress", () => {
  it("routes to api.anthropic.com through the scrub and injects the project's secrets", () => {
    const routed: string[] = [];
    const result = routeClaudeOptions(
      claudeOptions({
        settings: { showThinkingSummaries: true },
        mcpServers: { space: { type: "stdio", command: "space-mcp", env: { A: "1" } }, web: { type: "http", url: "http://x" } },
      }),
      { egress: fakeEgress(routed), secrets: SECRETS, settingsEnv: {} },
    );
    if (!("options" in result)) throw new Error(result.refused);
    const { env, settings, mcpServers } = result.options as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions & {
      settings: { env: Record<string, string>; showThinkingSummaries: boolean };
    };
    // The provider's own API goes through the app's caveman-proxy, which the scrub resolves per request.
    expect(routed).toEqual([ANTHROPIC_VIA_PROXY]);
    expect(env?.ANTHROPIC_BASE_URL?.startsWith(PROXY)).toBe(true);
    expect(env?._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
    expect(env?.CANARY_SECRET).toBe("cvs-canary-value-1234567890");
    expect(env?.ANTHROPIC_API_KEY).toBe("engine-own");
    // Flag settings outrank ~/.claude/settings.json's env.
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(env?.ANTHROPIC_BASE_URL);
    expect(settings.showThinkingSummaries).toBe(true);
    // Plugin servers get the names blanked; non-stdio servers are untouched.
    expect(mcpServers?.space).toEqual({
      type: "stdio",
      command: "space-mcp",
      env: { A: "1", CANARY_SECRET: "", ANTHROPIC_API_KEY: "" },
    });
    expect(mcpServers?.web).toEqual({ type: "http", url: "http://x" });
  });

  it("chains to the user's own base URL, settings file first, and keeps their first-party choice", () => {
    const routed: string[] = [];
    const result = routeClaudeOptions(claudeOptions({ env: { ANTHROPIC_BASE_URL: "http://env-proxy" } }), {
      egress: fakeEgress(routed),
      secrets: [],
      settingsEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/w/claude" },
    });
    if (!("options" in result)) throw new Error(result.refused);
    // The person's own proxy is theirs; the app's chats take the app's.
    expect(routed).toEqual([ANTHROPIC_VIA_PROXY]);
    expect(result.options.env?._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBeUndefined();
    const fromEnv: string[] = [];
    routeClaudeOptions(claudeOptions({ env: { ANTHROPIC_BASE_URL: "http://env-proxy" } }), {
      egress: fakeEgress(fromEnv),
      secrets: [],
      settingsEnv: {},
    });
    expect(fromEnv).toEqual(["http://env-proxy"]);
  });

  it("routes even with no secrets, and never routes a route twice", () => {
    const routed: string[] = [];
    const egress = fakeEgress(routed);
    const once = routeClaudeOptions(claudeOptions(), { egress, secrets: [], settingsEnv: {} });
    if (!("options" in once)) throw new Error(once.refused);
    const twice = routeClaudeOptions(once.options, { egress, secrets: [], settingsEnv: {} });
    if (!("options" in twice)) throw new Error(twice.refused);
    expect(twice.options.env?.ANTHROPIC_BASE_URL).toBe(once.options.env?.ANTHROPIC_BASE_URL);
    expect(routed).toHaveLength(1);
  });

  it("refuses to start when it cannot be routed and the project has secrets", () => {
    const down = routeClaudeOptions(claudeOptions(), { egress: downEgress, secrets: SECRETS, settingsEnv: {} });
    expect(down).toEqual({ refused: expect.stringContaining("scrub is not running") });
    const bedrock = routeClaudeOptions(claudeOptions({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }), {
      egress: fakeEgress(),
      secrets: SECRETS,
      settingsEnv: {},
    });
    expect(bedrock).toEqual({ refused: expect.stringContaining("CLAUDE_CODE_USE_BEDROCK") });
    // No secrets: starting direct is fine.
    const options = claudeOptions();
    expect(routeClaudeOptions(options, { egress: downEgress, secrets: [], settingsEnv: {} })).toEqual({ options, unrouted: true });
  });

  it("Auto stays routed without injecting compression recovery", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-retrieve-"));
    const mcp = NodePath.join(root, "caveman-mcp");
    NodeFS.writeFileSync(mcp, "#!/bin/sh\n", { mode: 0o755 });
    setAppProxyHome(NodePath.join(root, "proxy"));
    process.env.CAVEMAN_MCP_BIN = mcp;
    const url = vi.spyOn(appProxy, "url").mockReturnValue("http://127.0.0.1:4555");
    try {
      const auto = claudeOptions({ settings: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4555/w/caveman-code-claude" } } });
      const routed = routeClaudeOptions(auto, { egress: downEgress, secrets: [], settingsEnv: {} });
      if (!("options" in routed)) throw new Error(routed.refused);
      expect(routed.unrouted).toBe(true);
      expect(routed.options.mcpServers?.caveman).toEqual(auto.mcpServers?.caveman);
      expect(routed.options.allowedTools ?? []).not.toContain("mcp__caveman__caveman_retrieve");
      expect(routed.options.disallowedTools).toContain("mcp__caveman__caveman_retrieve");
      // A chosen model, direct: no proxy, no tool.
      const direct = routeClaudeOptions(claudeOptions(), { egress: downEgress, secrets: [], settingsEnv: {} });
      expect("options" in direct && direct.options.mcpServers).toBeFalsy();
      // A Cloud computer: Claude runs in the tools container, which must never read the proxy's home. No tool there
      // either, and nothing of the home: no command, path or environment.
      vi.stubEnv("CAVEMAN_RUNTIME_TOOLS_ADDRESS", "127.0.0.1:47917");
      const onComputer = routeClaudeOptions(auto, { egress: downEgress, secrets: [], settingsEnv: {} });
      if (!("options" in onComputer)) throw new Error(onComputer.refused);
      expect(onComputer.options.mcpServers?.caveman).toBeUndefined();
      expect(JSON.stringify(onComputer.options.mcpServers ?? {})).not.toContain(NodePath.join(root, "proxy"));
      expect(onComputer.options.allowedTools ?? []).not.toContain("mcp__caveman__caveman_retrieve");
      expect(onComputer.options.disallowedTools ?? []).toContain("mcp__caveman__caveman_retrieve");
    } finally {
      url.mockRestore();
      vi.unstubAllEnvs();
      delete process.env.CAVEMAN_MCP_BIN;
    }
  });

  it("a plugin server is preserved but app compression recovery is never enabled", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-retrieve-name-"));
    const mcp = NodePath.join(root, "caveman-mcp");
    NodeFS.writeFileSync(mcp, "#!/bin/sh\n", { mode: 0o755 });
    setAppProxyHome(NodePath.join(root, "proxy"));
    process.env.CAVEMAN_MCP_BIN = mcp;
    try {
      // A plugin's (or an imported setup's) own "caveman" server, on the person's v4 store.
      const theirs = claudeOptions({ mcpServers: { caveman: { type: "stdio", command: "/usr/local/bin/caveman-mcp" } } });
      const routed = routeClaudeOptions(theirs, { egress: fakeEgress(), secrets: [], settingsEnv: {} });
      if (!("options" in routed)) throw new Error(routed.refused);
      expect(routed.options.mcpServers?.caveman).toMatchObject(theirs.mcpServers!.caveman!);
      expect(routed.options.disallowedTools ?? []).toContain("mcp__caveman__caveman_retrieve");
      // On a Cloud computer too: a .mcp.json or user "caveman" server's tool is kept from the proxy, and theirs stays.
      vi.stubEnv("CAVEMAN_RUNTIME_TOOLS_ADDRESS", "127.0.0.1:47917");
      const onComputer = routeClaudeOptions(claudeOptions(), { egress: fakeEgress(), secrets: [], settingsEnv: {} });
      if (!("options" in onComputer)) throw new Error(onComputer.refused);
      expect(onComputer.options.disallowedTools).toEqual(["mcp__caveman__caveman_retrieve"]);
      const kept = routeClaudeOptions(theirs, { egress: fakeEgress(), secrets: [], settingsEnv: {} });
      if (!("options" in kept)) throw new Error(kept.refused);
      expect(kept.options.mcpServers?.caveman).toMatchObject(theirs.mcpServers!.caveman!);
      // Direct to another endpoint, nothing about it changes.
      const direct = routeClaudeOptions(claudeOptions({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }), { egress: fakeEgress(), secrets: [], settingsEnv: {} });
      expect("options" in direct && direct.options.disallowedTools).toBeFalsy();
    } finally {
      vi.unstubAllEnvs();
      delete process.env.CAVEMAN_MCP_BIN;
      setAppProxyHome(undefined);
    }
  });

  it("reads the base URL from the settings files the CLI loads, later ones winning", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-claude-"));
    const configDir = NodePath.join(root, "home");
    const cwd = NodePath.join(root, "repo");
    NodeFS.mkdirSync(configDir, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(cwd, ".claude"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(configDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://user", ANTHROPIC_API_KEY: "never-read" } }),
    );
    NodeFS.writeFileSync(NodePath.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://local" } }));
    expect(claudeSettingsEnv({ configDir, cwd, sources: ["user", "project", "local"] })).toEqual({ ANTHROPIC_BASE_URL: "http://local" });
    expect(claudeSettingsEnv({ configDir, cwd, sources: ["user"] })).toEqual({ ANTHROPIC_BASE_URL: "http://user" });
    expect(claudeSettingsEnv({ configDir, cwd, sources: [] })).toEqual({});
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});

const V4_CODEX_CONFIG = `# >>> caveman:native-root
model_provider = "caveman"
# <<< caveman:native-root
[features]
x = true

[model_providers.caveman]
name = "Caveman"
base_url = "http://127.0.0.1:8787/chatgpt"
wire_api = "responses"
requires_openai_auth = true

[[skills.config]]
path = "/x"
`;

/** The `-c` values Codex will see, after the same tokenizing the launcher does. */
const configValues = (launchArgs: string) => {
  const tokens = tokenizeCliArgs(launchArgs);
  return tokens.flatMap((token, i) => (tokens[i - 1] === "-c" ? [token] : []));
};

describe("Codex egress", () => {
  it("swaps the built-in OpenAI provider for a scrubbed one without WebSockets", () => {
    const routed: string[] = [];
    const result = routeCodexLaunch({ egress: fakeEgress(routed), configText: "", launchArgs: undefined, environment: {} });
    if (!("args" in result)) throw new Error(result.unroutable);
    // Codex's own app proxy, the one told its chats hold caveman_retrieve.
    expect(routed).toEqual([CODEX_VIA_PROXY]);
    expect(result.viaProxy).toBe(true);
    expect(result.args[1]).toBe('model_provider="caveman_code_egress"');
    expect(result.args[3]).toContain('name = "OpenAI"');
    expect(result.args[3]).toContain("supports_websockets = false");
    expect(result.args[3]).toContain("requires_openai_auth = true");
    expect(result.args[3]).toContain(`base_url = "${PROXY}/`);
  });

  it("chains to a user's own provider (a Caveman v4 install) and to openai_base_url / OPENAI_BASE_URL", () => {
    const routed: string[] = [];
    const v4 = routeCodexLaunch({ egress: fakeEgress(routed), configText: V4_CODEX_CONFIG, launchArgs: undefined, environment: {} });
    if (!("args" in v4)) throw new Error(v4.unroutable);
    expect(routed).toEqual([CODEX_VIA_PROXY]);
    // Always the scrub's own provider id: a copy of the user's, base_url chained, WebSockets off.
    expect(v4.args[1]).toBe('model_provider="caveman_code_egress"');
    expect(v4.args[3]).toMatch(
      /^model_providers\.caveman_code_egress=\{ name = "Caveman", wire_api = "responses", requires_openai_auth = true, base_url = "http:\/\/127\.0\.0\.1:4100\/tok\/[0-9a-f]+", supports_websockets = false \}$/,
    );

    const viaConfig: string[] = [];
    routeCodexLaunch({ egress: fakeEgress(viaConfig), configText: 'openai_base_url = "https://corp/v1"\n', launchArgs: undefined, environment: {} });
    expect(viaConfig).toEqual(["https://corp/v1"]);
    const viaEnv: string[] = [];
    routeCodexLaunch({ egress: fakeEgress(viaEnv), configText: "", launchArgs: undefined, environment: { OPENAI_BASE_URL: "https://env/v1" } });
    expect(viaEnv).toEqual(["https://env/v1"]);
    // The user's launch arguments pick the provider over config.toml.
    const viaArgs: string[] = [];
    routeCodexLaunch({ egress: fakeEgress(viaArgs), configText: V4_CODEX_CONFIG, launchArgs: `-c 'model_provider="openai"'`, environment: {} });
    expect(viaArgs).toEqual([CODEX_VIA_PROXY]);
    // A profile's provider.
    const viaProfile: string[] = [];
    routeCodexLaunch({
      egress: fakeEgress(viaProfile),
      configText: `profile = "work"\n[profiles.work]\nmodel_provider = "corp"\n[model_providers.corp]\nbase_url = "https://corp.example/v1"\n`,
      launchArgs: undefined,
      environment: {},
    });
    expect(viaProfile).toEqual(["https://corp.example/v1"]);
  });

  it("appends its arguments last and injects secrets, minus the engine's own names", () => {
    const open = {
      instanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "ps-1",
      runtimePolicy: {},
      settings: { launchArgs: `-c 'model="gpt-5"'` } as CodexSettings,
      environment: { PATH: "/usr/bin", HTTPS_PROXY: "http://corp:3128" },
    } as unknown as Parameters<typeof routeCodexOpen>[0];
    const result = routeCodexOpen(open, {
      egress: fakeEgress(),
      secrets: [...SECRETS, { name: "OPENAI_API_KEY", value: "sk-project-not-the-engines-key" }],
      configText: "",
    });
    if (!("open" in result)) throw new Error(result.refused);
    const values = configValues(result.open.settings.launchArgs ?? "");
    expect(values[0]).toBe('model="gpt-5"');
    expect(values[1]).toBe('model_provider="caveman_code_egress"');
    expect(values[2]).toMatch(
      /^model_providers\.caveman_code_egress=\{ name = "OpenAI", wire_api = "responses", requires_openai_auth = true, base_url = "http:\/\/127\.0\.0\.1:4100\/tok\//,
    );
    expect(result.open.environment.CANARY_SECRET).toBe("cvs-canary-value-1234567890");
    expect(result.open.environment.OPENAI_API_KEY).toBeUndefined();
    expect(result.open.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.open.environment.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  it("refuses a provider it cannot route when the project has secrets", () => {
    const open = {
      settings: { launchArgs: `-c 'model_provider="ollama"'` },
      environment: {},
    } as unknown as Parameters<typeof routeCodexOpen>[0];
    expect(routeCodexOpen(open, { egress: fakeEgress(), secrets: SECRETS, configText: "" })).toEqual({
      refused: expect.stringContaining('"ollama"'),
    });
    expect(routeCodexOpen(open, { egress: fakeEgress(), secrets: [], configText: "" })).toEqual({ open, unrouted: true });
    const plain = { settings: {}, environment: {} } as unknown as Parameters<typeof routeCodexOpen>[0];
    expect(routeCodexOpen(plain, { egress: downEgress, secrets: SECRETS, configText: "" })).toEqual({
      refused: expect.stringContaining("scrub is not running"),
    });
  });
});

describe("OpenCode egress", () => {
  const dir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-egress-"));
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  };
  const route = (upstream: string) => `${PROXY}/${Buffer.from(upstream).toString("hex").slice(0, 16)}`;

  it("writes Anthropic and OpenAI through the scrub, over HTTP, into a private OPENCODE_CONFIG built on the person's own", () => {
    const routed: string[] = [];
    const own = NodePath.join(dir(), "mine.jsonc");
    write(own, '{\n  // my setup\n  "model": "anthropic/x",\n  "providers": { "anthropic": { "headers": { "a": "b" } } },\n}');
    const out = dir();
    const env = routeOpenCodeEnvironment({ HOME: dir(), XDG_CONFIG_HOME: dir(), OPENCODE_CONFIG: own }, fakeEgress(routed), out);
    expect(routed).toEqual([ANTHROPIC_VIA_PROXY, OPENAI_VIA_PROXY]);
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(NodePath.dirname(env.OPENCODE_CONFIG!)).toBe(out);
    // Windows has no mode bits: the runtime's state dir in the person's profile (its ACL) keeps it private.
    if (process.platform !== "win32") expect(NodeFS.statSync(env.OPENCODE_CONFIG!).mode & 0o777).toBe(0o600);
    const c = JSON.parse(NodeFS.readFileSync(env.OPENCODE_CONFIG!, "utf8"));
    expect(c.model).toBe("anthropic/x");
    expect(c.providers.anthropic).toEqual({ headers: { a: "b" }, settings: { baseURL: `${route(ANTHROPIC_VIA_PROXY)}/v1`, transport: "http" } });
    expect(c.providers.openai.settings).toEqual({ baseURL: route(OPENAI_VIA_PROXY), transport: "http" });
  });

  it("never takes over a provider the person gave a base URL or a key anywhere OpenCode reads", () => {
    const providersOf = (env: NodeJS.ProcessEnv) => Object.keys(openCodeRouting(env, fakeEgress())!.providers as object).sort();
    const xdg = dir();
    // A commented global config: a corporate gateway with its key.
    write(NodePath.join(xdg, "opencode", "opencode.jsonc"), '/* gateway */\n{"provider":{"openai":{"options":{"baseURL":"https://gw.example/v1","apiKey":"gw"}}}}');
    expect(providersOf({ HOME: dir(), XDG_CONFIG_HOME: xdg })).toEqual(["anthropic"]);
    // A key alone, in 2.x shape, in OPENCODE_CONFIG_DIR.
    const configDir = dir();
    write(NodePath.join(configDir, "opencode.json"), '{"providers":{"anthropic":{"settings":{"apiKey":"k"}}}}');
    expect(providersOf({ HOME: dir(), XDG_CONFIG_HOME: dir(), OPENCODE_CONFIG_DIR: configDir })).toEqual(["openai"]);
    // The inline content and the provider's own base URL variable.
    expect(providersOf({ HOME: dir(), XDG_CONFIG_HOME: dir(), OPENCODE_CONFIG_CONTENT: '{"providers":{"openai":{"settings":{"baseURL":"https://x"}}}}', ANTHROPIC_BASE_URL: "https://gw" })).toEqual([]);
  });

  it("changes nothing while the scrub is down or when a config cannot be parsed", () => {
    const env = { HOME: dir(), XDG_CONFIG_HOME: dir() };
    expect(routeOpenCodeEnvironment(env, downEgress, dir())).toBe(env);
    const odd = { HOME: dir(), XDG_CONFIG_HOME: dir(), OPENCODE_CONFIG_CONTENT: "{not json" };
    expect(routeOpenCodeEnvironment(odd, fakeEgress(), dir())).toBe(odd);
    const xdg = dir();
    write(NodePath.join(xdg, "opencode", "opencode.json"), "{ broken");
    const broken = { HOME: dir(), XDG_CONFIG_HOME: xdg };
    expect(routeOpenCodeEnvironment(broken, fakeEgress(), dir())).toBe(broken);
  });
});

describe("Codex thread env", () => {
  it("correlates chosen-model and Auto threads on both transports without replacing custom headers", async () => {
    const calls: Array<{ config: Record<string, unknown> }> = [];
    const request = (_method: string, payload: { config: Record<string, unknown> }) => (calls.push(payload), Effect.succeed({}));
    const client = { request, raw: { request } } as unknown as Parameters<typeof withCodexThreadEgress>[0];
    const url = vi.spyOn(codexProxy, "url").mockReturnValue("http://127.0.0.1:4556");
    try {
      const wrapped = withCodexThreadEgress(client, fakeEgress(), true, "caveman:chosen");
      for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
        for (const transport of [wrapped, wrapped.raw]) {
          await Effect.runPromise(transport.request(method as never, { config: { model: "gpt-6.1-sol" } } as never));
          await Effect.runPromise(transport.request(method as never, { config: {
            "model_providers.caveman": { base_url: "http://127.0.0.1:4556/chatgpt", http_headers: { "x-personal": "keep", "x-cave-session": "old" } },
          } } as never));
        }
      }
      expect(calls).toHaveLength(12);
      for (const call of calls) {
        expect(call.config["model_providers.caveman_code_egress.http_headers.x-cave-session"]).toBe("caveman:chosen");
        if (call.config["model_providers.caveman"]) expect(call.config["model_providers.caveman"]).toMatchObject({ http_headers: { "x-personal": "keep", "x-cave-session": "caveman:chosen" } });
      }
      // A delegated chat's id is spelled out for the proxy, never refused.
      const delegated = withCodexThreadEgress(client, fakeEgress(), true, "thread:delegated-task:command%3Amcp");
      await Effect.runPromise(delegated.request("thread/start", {} as never));
      expect(calls).toHaveLength(13);
      expect(calls[12]!.config["model_providers.caveman_code_egress.http_headers.x-cave-session"]).toBe("thread:delegated-task:command_253Amcp");
    } finally {
      url.mockRestore();
    }
  });

  it("keeps Auto behind the scrub on start, resume and fork, including raw requests", async () => {
    const calls: Array<{ config?: Record<string, unknown> }> = [];
    const request = (_method: string, payload: { config?: Record<string, unknown> }) => {
      calls.push(payload);
      return Effect.succeed({});
    };
    const client = { request, raw: { request } } as unknown as Parameters<typeof withCodexThreadEnv>[0];
    const upstreams: string[] = [];
    const wrapped = withCodexThreadEgress(withCodexThreadEnv(client, SECRETS), fakeEgress(upstreams));
    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      for (const transport of [wrapped, wrapped.raw]) {
        await Effect.runPromise(transport.request(method as never, {
          modelProvider: "caveman",
          config: { "model_providers.caveman": { base_url: "http://127.0.0.1:8787/chatgpt", requires_openai_auth: true, http_headers: { "x-cave-session": "session-1" } } },
        } as never));
      }
    }
    expect(upstreams).toEqual(Array(6).fill("http://127.0.0.1:8787/chatgpt"));
    for (const call of calls) {
      expect(call.config?.["model_providers.caveman"]).toMatchObject({
        base_url: expect.stringContaining(PROXY), supports_websockets: false,
        requires_openai_auth: true, http_headers: { "x-cave-session": "session-1" },
      });
      expect(call.config?.["shell_environment_policy.set.CANARY_SECRET"]).toBe(SECRETS[0]!.value);
    }
    const down = withCodexThreadEgress(client, downEgress);
    await expect(Effect.runPromise(down.request("thread/start", {
      config: { "model_providers.caveman": { base_url: "http://127.0.0.1:8787/chatgpt" } },
    } as never))).rejects.toThrow("egress scrub is not running");
    expect(calls).toHaveLength(6);
  });

  it("no Codex thread is handed caveman_retrieve, on Auto or through the proxy, and a thread's own servers stay", async () => {
    const calls: Array<{ config?: Record<string, unknown> }> = [];
    const request = (_method: string, payload: { config?: Record<string, unknown> }) => (calls.push(payload), Effect.succeed({ thread: { id: "native-1" } }));
    const client = { request, raw: { request } } as unknown as Parameters<typeof withCodexThreadEnv>[0];
    const url = vi.spyOn(codexProxy, "url").mockReturnValue("http://127.0.0.1:4556");
    const onAuto = { config: { "model_providers.caveman": { base_url: "http://127.0.0.1:4556/chatgpt" } } };
    const chosen = { config: { model: "gpt-6.1-sol" } };
    const servers = (call: { config?: Record<string, unknown> }) => Object.keys(call.config ?? {}).filter((key) => key.startsWith("mcp_servers"));
    try {
      for (const wrapped of [withCodexThreadEgress(client, undefined), withCodexThreadEgress(client, fakeEgress()), withCodexThreadEgress(client, fakeEgress(), true)]) {
        for (const payload of [onAuto, chosen]) await Effect.runPromise(wrapped.request("thread/start", payload as never));
        expect(wrapped.compressionRetrieveExpected?.("native-1") ?? false).toBe(false);
      }
      expect(calls.map(servers)).toEqual(Array.from({ length: 6 }, () => []));
      // Unrouted, the Auto provider goes to the proxy as it is.
      expect(calls[0]!.config?.["model_providers.caveman"]).toEqual({ base_url: "http://127.0.0.1:4556/chatgpt" });
      // A server named caveman in the thread's config (a plugin's) stays the thread's, under either spelling.
      const proxied = withCodexThreadEgress(client, fakeEgress(), true);
      const keyed = { config: { model: "gpt-6.1-sol", "mcp_servers.caveman": { command: "/usr/local/bin/caveman-mcp" }, "mcp_servers.other": { command: "x" } } };
      await Effect.runPromise(proxied.request("thread/start", keyed as never));
      expect(calls.at(-1)!.config).toEqual(keyed.config);
      const theirs = { config: { model: "gpt-6.1-sol", mcp_servers: { caveman: { command: "/usr/local/bin/caveman-mcp" }, other: { command: "x" } } } };
      await Effect.runPromise(proxied.request("thread/start", theirs as never));
      expect(calls.at(-1)!.config).toEqual(theirs.config);
    } finally {
      url.mockRestore();
    }
  });

  it("names only the hidden secrets for the git hooks, never a public or too-plain value's", () => {
    expect(
      engineSecretEnv([
        { name: "DEPLOY_TOKEN", value: "cvs-live-4f9a2b7c1d8e6a3f" },
        { name: "NEXT_PUBLIC_URL", value: "https://app.example.com/very/long/path" },
        { name: "MODE", value: "development" },
        { name: "ANTHROPIC_API_KEY", value: ("sk-" + "ant-not-for-the-engine-000000000000") },
      ]),
    ).toEqual({
      DEPLOY_TOKEN: "cvs-live-4f9a2b7c1d8e6a3f",
      NEXT_PUBLIC_URL: "https://app.example.com/very/long/path",
      MODE: "development",
      CAVEMAN_SECRET_NAMES: "DEPLOY_TOKEN",
    });
    expect(engineSecretEnv([{ name: "MODE", value: "development" }])).toEqual({ MODE: "development" });
  });

  it("sets each secret through shell_environment_policy on thread start, resume and fork only", async () => {
    const calls: Array<[string, { config?: Record<string, unknown> }]> = [];
    const record = (prefix: string) => (method: string, payload: { config?: Record<string, unknown> }) => {
      calls.push([prefix + method, payload]);
      return Effect.succeed({});
    };
    const client = { request: record(""), raw: { request: record("raw:") } } as unknown as Parameters<typeof withCodexThreadEnv>[0];
    const wrapped = withCodexThreadEnv(client, SECRETS);
    await Effect.runPromise(wrapped.request("thread/start", { config: { "tools.update_plan.enabled": true } } as never));
    await Effect.runPromise(wrapped.raw.request("thread/resume", {} as never));
    await Effect.runPromise(wrapped.request("turn/start", {} as never));
    expect(calls[0]).toEqual([
      "thread/start",
      {
        config: {
          "tools.update_plan.enabled": true,
          "shell_environment_policy.set.CANARY_SECRET": "cvs-canary-value-1234567890",
          // Its name, for the runtime's git hooks: a commit or push that adds the value is refused.
          "shell_environment_policy.set.CAVEMAN_SECRET_NAMES": "CANARY_SECRET",
        },
      },
    ]);
    expect(calls[1]![0]).toBe("raw:thread/resume");
    expect(calls[1]![1].config?.["shell_environment_policy.set.CANARY_SECRET"]).toBe("cvs-canary-value-1234567890");
    expect(calls[2]).toEqual(["turn/start", {}]);
    // No secrets: the client is untouched.
    expect(withCodexThreadEnv(client, [])).toBe(client);
  });
});

describe("engine egress layers", () => {
  const sessionPlugins = (secretEnv: Record<string, string>) =>
    Layer.succeed(SessionPlugins.SessionPlugins, {
      acp: () => Effect.succeed([]),
      claudeAgent: () => Effect.die("unused"),
      codex: () => Effect.die("unused"),
      secretEnv: () => Effect.succeed(secretEnv),
    });

  it("opens Codex with the thread's secrets and the scrub, and refuses when the scrub is down", async () => {
    const opened: Array<Parameters<CodexAdapterV2.CodexAppServerClientFactory["Service"]["open"]>[0]> = [];
    const inner = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
      open: (input) => {
        opened.push(input);
        return Effect.die("stop after open");
      },
    });
    const run = (egress: Egress) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
          return yield* factory.open({
            instanceId: ProviderInstanceId.make("codex"),
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "ps-1",
            runtimePolicy: {},
            settings: { homePath: NodeOS.tmpdir() } as CodexSettings,
            environment: {},
          } as unknown as Parameters<CodexAdapterV2.CodexAppServerClientFactory["Service"]["open"]>[0]);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerCodexEgress.pipe(
              Layer.provide(Layer.mergeAll(inner, sessionPlugins({ CANARY_SECRET: "cvs-canary-value-1234567890" }), Layer.succeed(EgressScrub, { ...egress, hasSecrets: () => Effect.succeed(false) }))),
            ),
          ),
        ),
      );
    await run(fakeEgress());
    expect(opened).toHaveLength(1);
    expect(opened[0]!.environment.CANARY_SECRET).toBe("cvs-canary-value-1234567890");
    expect(opened[0]!.settings.launchArgs).toContain("caveman_code_egress");
    const refused = await run(downEgress);
    expect(opened).toHaveLength(1);
    expect(Exit.isFailure(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain("ProviderAdapterOpenSessionError");
  });

  it("routes OpenCode 2 servers (they carry OPENCODE_PASSWORD) and starts 1.x ones as they were", async () => {
    const started: Array<NodeJS.ProcessEnv | undefined> = [];
    const inner = Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, {
      startOpenCodeServerProcess: (input: { readonly environment?: NodeJS.ProcessEnv }) => {
        started.push(input.environment);
        return Effect.die("stop after start");
      },
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]);
    const start = (environment: NodeJS.ProcessEnv) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
          return yield* runtime.startOpenCodeServerProcess({ binaryPath: "opencode", directory: "/tmp", environment });
        }).pipe(
          Effect.scoped,
          Effect.provide(layerOpenCodeEgress.pipe(Layer.provide(Layer.mergeAll(inner, Layer.succeed(EgressScrub, { ...fakeEgress(), hasSecrets: () => Effect.succeed(false) }))))),
        ),
      );
    const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-egress-"));
    await start({ HOME: empty, XDG_CONFIG_HOME: empty, OPENCODE_PASSWORD: "pw" });
    await start({ HOME: NodeOS.tmpdir() });
    expect(JSON.parse(NodeFS.readFileSync(started[0]!.OPENCODE_CONFIG!, "utf8")).providers.anthropic.settings.baseURL).toContain(PROXY);
    expect(started[1]).toEqual({ HOME: NodeOS.tmpdir() });
  });

  it.each([
    { base: "https://api.anthropic.com", cloud: false, expected: true },
    { base: "https://gateway.example", cloud: false, expected: false },
    { base: "https://api.anthropic.com", cloud: true, expected: true },
    { base: "https://api.anthropic.com", cloud: false, expected: false, missingRetrieve: true },
  ])("opens Claude Agent with secrets and never expects retrieve, proxied or not (%j)", async ({ base, cloud, expected, missingRetrieve }) => {
    const opened: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput[] = [];
    const replacements: Array<NonNullable<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["mcpServers"]>> = [];
    const inner = Layer.succeed(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      open: (input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput) => {
        opened.push(input);
        return Effect.succeed({ setMcpServers: (servers: NonNullable<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["mcpServers"]>) => Effect.sync(() => { replacements.push(servers); }) } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQuerySession);
      },
    } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryRunner["Service"]);
    if (cloud) vi.stubEnv("CAVEMAN_RUNTIME_TOOLS_ADDRESS", "127.0.0.1:47917");
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-live-mcp-"));
    setAppProxyHome(NodePath.join(home, "proxy"));
    vi.spyOn(await import("../router/proxyLauncher.ts"), "findMcpBinary").mockReturnValue(missingRetrieve ? undefined : "/app/caveman-mcp");
    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        const session = yield* runner.open({
          options: claudeOptions({ settingSources: [], env: { ANTHROPIC_BASE_URL: base } }),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "ps-1",
        } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput);
        // Warm take, then grill on/off replace the dynamic set with adapter-owned maps.
        for (const servers of [{}, { space: { type: "stdio" as const, command: "plugin", env: { KEEP: "yes", CANARY_SECRET: "override" } } }, {}]) {
          yield* session.setMcpServers!(servers);
        }
        return session;
      }).pipe(
        Effect.provide(
          layerClaudeEgress.pipe(
            Layer.provide(Layer.mergeAll(inner, sessionPlugins({ CANARY_SECRET: "cvs-canary-value-1234567890" }), Layer.succeed(EgressScrub, { ...fakeEgress(), hasSecrets: () => Effect.succeed(false) }))),
          ),
        ),
      ),
    );
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setAppProxyHome(undefined);
    NodeFS.rmSync(home, { recursive: true, force: true });
    expect(session.compressionRetrieveExpected ?? false).toBe(false);
    for (const servers of replacements) {
      expect(servers.caveman).toBeUndefined();

    }
    expect(replacements[1]!.space).toMatchObject({ env: { KEEP: "yes", CANARY_SECRET: "" } });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.options.env?.CANARY_SECRET).toBe("cvs-canary-value-1234567890");
    expect(opened[0]!.options.env?.ANTHROPIC_BASE_URL?.startsWith(PROXY)).toBe(true);
    // Only a chat through the app's proxy is tied to its chat; another gateway never sees the header.
    expect(opened[0]!.options.env?.ANTHROPIC_CUSTOM_HEADERS).toBe(base === "https://api.anthropic.com" ? "x-cave-session: thread-1" : undefined);
  });
});
