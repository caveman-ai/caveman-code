import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const url = vi.hoisted(() => vi.fn<() => string | undefined>());
const codexUrl = vi.hoisted(() => vi.fn<() => string | undefined>());
const proxyHome = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("@caveman-app/provider-caveman/server", () => ({ CAVEMAN_GATEWAY_URL: "http://127.0.0.1:8787" }));
vi.mock("./proxyLauncher.ts", () => ({ APP_CLAUDE_AGENT: "caveman-code-claude", appProxyUrl: url, codexProxyUrl: codexUrl, appProxyHome: () => proxyHome.dir }));

import { claudeRoutable, claudeRoutableIn, claudeRouterEnv, claudeSettingsFilesEnv, proxySession, routerOffered, routingConfigured } from "./cavemanRouter.ts";

test("session escaping is fixed-width UTF-8, escapes underscores, and caps long ids", () => {
  expect(proxySession("a\u0001b")).toBe("a_01b");
  expect(proxySession("a\u001b")).toBe("a_1b");
  expect(proxySession("a_01b")).toBe("a_5f01b");
  expect(proxySession("é🪨")).toBe("_c3_a9_f0_9f_aa_a8");
  expect(proxySession("thread:command%3Amcp")).toBe("thread:command_253Amcp");
  const long = "é".repeat(150);
  expect(proxySession(long)).toMatch(/^[A-Za-z0-9._:-]{256}$/);
  expect(proxySession(long)).not.toBe(proxySession(`${long}x`));
});

let home: string;
let claudeDir: string;
// What writeProxyCloud writes for the app's own sign-in.
const SIGNED_IN = { baseURL: "https://app.caveman.example", tokenStore: "file", deviceId: "caveman-code", modules: { routing: true } };
const write = (name: string, text: string) => fs.writeFileSync(path.join(home, name), text);
const cloud = (doc: object) => write("cloud.json", JSON.stringify(doc));
const claudeSettings = (dir: string, env: Record<string, string>) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ env }));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-home-"));
  proxyHome.dir = home;
  claudeDir = path.join(home, "claude");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("Auto is configured by this app's own Caveman sign-in in its proxies' home, never the person's caveman", () => {
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  expect(routingConfigured("claude-agent", env)).toBe(false);

  cloud(SIGNED_IN);
  expect(routingConfigured("claude-agent", env)).toBe(true);
  expect(routingConfigured("codex", env)).toBe(true);
  expect(routingConfigured("caveman", env)).toBe(false);

  // Signed out (writeProxyCloud's cloud.json without a sign-in), or anything else.
  cloud({ telemetry: { enabled: false } });
  expect(routingConfigured("claude-agent", env)).toBe(false);
  cloud({ ...SIGNED_IN, modules: { routing: false } });
  expect(routingConfigured("claude-agent", env)).toBe(false);
  write("cloud.json", "{not json");
  expect(routingConfigured("claude-agent", env)).toBe(false);
  // The person's v4 sign-in and token count for nothing.
  const person = fs.mkdtempSync(path.join(os.tmpdir(), "person-caveman-"));
  fs.writeFileSync(path.join(person, "cloud.json"), JSON.stringify({ baseURL: "https://app.caveman.so", tokenStore: "keychain", modules: { routing: true } }));
  expect(routingConfigured("claude-agent", { ...env, CAVEMAN_HOME: person, CAVE_TOKEN: "set" })).toBe(false);
  // Before the runtime set the home, nothing is.
  proxyHome.dir = undefined;
  expect(routingConfigured("claude-agent", env)).toBe(false);
});

test("Claude Agent gets Auto only while Claude Code talks to Anthropic or the proxy, on no cloud lane", () => {
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  cloud(SIGNED_IN);

  // A company gateway in the user's settings: its key must never reach the proxy. Codex is not affected.
  claudeSettings(claudeDir, { ANTHROPIC_BASE_URL: "https://gateway.corp", ANTHROPIC_AUTH_TOKEN: "corp-key" });
  expect(routingConfigured("claude-agent", env)).toBe(false);
  expect(routingConfigured("codex", env)).toBe(true);
  // The settings file outranks the shell, as in Claude Code.
  expect(routingConfigured("claude-agent", { ...env, ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(false);

  claudeSettings(claudeDir, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/w/claude" });
  expect(routingConfigured("claude-agent", env)).toBe(true);
  claudeSettings(claudeDir, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  expect(routingConfigured("claude-agent", env)).toBe(true);
  expect(routingConfigured("claude-agent", { ...env, CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(false);
  expect(routingConfigured("claude-agent", { ...env, CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(true);
  claudeSettings(claudeDir, { CLAUDE_CODE_USE_VERTEX: "true" });
  expect(routingConfigured("claude-agent", env)).toBe(false);

  expect(claudeRoutable({})).toBe(true);
  expect(claudeRoutable({ ANTHROPIC_BASE_URL: "not a url" })).toBe(false);
  expect(claudeRoutable({ CLAUDE_CODE_USE_MANTLE: "yes" })).toBe(false);
  expect(claudeRoutable({ CLAUDE_CODE_USE_FOUNDRY: "1" })).toBe(false);
});

test("Claude's settings files: user, then project, then local, only the sources the CLI loads", () => {
  claudeSettings(claudeDir, { A: "user", B: "user", N: 1 as unknown as string });
  const cwd = path.join(home, "repo");
  claudeSettings(path.join(cwd, ".claude"), { B: "project", C: "project" });
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { C: "local" } }));
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  expect(claudeSettingsFilesEnv({ env, cwd })).toEqual({ A: "user", B: "project", C: "local" });
  expect(claudeSettingsFilesEnv({ env, cwd, sources: ["user"] })).toEqual({ A: "user", B: "user" });
  expect(claudeSettingsFilesEnv({ env, cwd, sources: [] })).toEqual({});
  expect(claudeSettingsFilesEnv({ env: { CLAUDE_CONFIG_DIR: path.join(home, "none") }, cwd: null })).toEqual({});
});

test("Auto is offered while routing is configured and the engine's own app proxy is up, never the person's", async () => {
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    cloud(SIGNED_IN);
    url.mockReturnValue(undefined);
    codexUrl.mockReturnValue(undefined);
    expect(await routerOffered("claude-agent")).toBe(false);
    url.mockReturnValue("http://127.0.0.1:4555");
    expect(await routerOffered("claude-agent")).toBe(true);
    expect(await routerOffered("codex")).toBe(false);
    codexUrl.mockReturnValue("http://127.0.0.1:4556");
    expect(await routerOffered("codex")).toBe(true);
    // Routing turned off answers false whatever the proxy does.
    cloud({ ...SIGNED_IN, modules: { routing: false } });
    expect(await routerOffered("claude-agent")).toBe(false);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("a signed-in free account gets no Auto; credits and paid-plan routing keys both enable it", async () => {
  const { writeProxyCloud } = await vi.importActual<typeof import("./proxyLauncher.ts")>("./proxyLauncher.ts");
  const cloud = { cloudUrl: "https://cloud.test", accessToken: "cave_login_only" };
  url.mockReturnValue("http://127.0.0.1:4555");
  codexUrl.mockReturnValue("http://127.0.0.1:4556");
  writeProxyCloud(home, cloud);
  expect(await routerOffered("claude-agent")).toBe(false);
  expect(await routerOffered("codex")).toBe(false);
  for (const routingKey of ["cave_credits_fake", "cave_paid_router_fake"]) {
    writeProxyCloud(home, { ...cloud, routingKey });
    expect(await routerOffered("claude-agent")).toBe(true);
    expect(await routerOffered("codex")).toBe(true);
  }
});

test("Claude's Auto env keys the chat in ANTHROPIC_CUSTOM_HEADERS beside the user's own headers", () => {
  expect(claudeRouterEnv("caveman:abc", {}, "http://127.0.0.1:4555")).toEqual({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4555/w/caveman-code-claude",
    ANTHROPIC_CUSTOM_HEADERS: "x-cave-session: caveman:abc",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "caveman-auto[1m]",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort,xhigh_effort,thinking,adaptive_thinking,interleaved_thinking",
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  });
  const mine = claudeRouterEnv(
    "caveman:abc",
    {
      ANTHROPIC_CUSTOM_HEADERS: "x-cave-tags: repo=app\r\nX-Cave-Session: stale\n\nx-team: core",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "0",
    },
    "http://127.0.0.1:4555",
  );
  expect(mine.ANTHROPIC_CUSTOM_HEADERS).toBe("x-cave-tags: repo=app\nx-team: core\nx-cave-session: caveman:abc");
  expect(mine).not.toHaveProperty("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL");
});

test("Auto's availability reads the project's and local Claude settings, as the launch does", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "router-project-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-home-"));
  const env = { CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv;
  expect(claudeRoutableIn(cwd, env)).toBe(true);
  fs.mkdirSync(path.join(cwd, ".claude"));
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }));
  expect(claudeRoutableIn(cwd, env)).toBe(false);
});
