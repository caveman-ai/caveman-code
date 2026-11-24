// Who pays for Claude Agent and Codex on a Cloud computer (withEngineKey; agent-continuity.md §7.4): a launch
// runs only on the lane the person chose, as Cloud names it, and a lane that can't serve fails the launch. Against a
// pretend Cloud in memory (its lanes, followed sign-ins and person tag), a counting vault, and temp directories as
// the computer's Codex home. Mock providers only: no model is called and no real credential exists here.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import { ClaudeSettings } from "@caveman-app/protocol";
import { ProviderAdapterTurnStartError } from "@caveman-app/engine-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeAgentSdkQueryRunnerError } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "../provider/ClaudeProvider.ts";
import { scopeClaudeLaunch } from "../provider/Drivers/ClaudeExecutable.ts";
import { FAKE_CLAUDE } from "../session-protocol/testHarness.ts";
import {
  CODEX_VAULT_KEY_STAND_IN,
  EngineCloudKeys,
  EngineLoginUnavailable,
  holdsCloudStandIn,
  isEngineLoginUnavailable,
  VAULT_KEY_STAND_IN,
  vaultKeyFor,
  withEngineKey,
  type KeyedEngine,
} from "./engineKeys.ts";
import {
  CLOUD_ENGINE,
  FollowedLogins,
  followedCloudOver,
  followedLogins,
  REVALIDATE_MS,
  toolsLoginFiles,
  type CloudLanes,
  type EngineLane,
  type FollowedCloud,
  type FollowedEngine,
  type LoginAccess,
} from "./engineLogins.ts";
import { CloudError } from "./identity.ts";

const VAULT: Record<KeyedEngine, string> = { "claude-agent": ("sk-" + "ant-api03-VAULTFIXTURE-0123"), codex: ("sk-" + "proj-VAULTFIXTURE-0123") };
const PLAN: Record<KeyedEngine, string> = { "claude-agent": ("sk-" + "ant-oat01-PLANFIXTURE-0123"), codex: "eyJPLANFIXTURE.codex.access" };
const ENGINES: ReadonlyArray<KeyedEngine> = ["claude-agent", "codex"];

/** A pretend Cloud's engine-login routes for one computer: the person it acts for now, their lanes and sign-ins. */
class LaneCloud implements FollowedCloud {
  person: string | undefined = "person-a";
  /** undefined: a Cloud from before lanes (it says only which sign-ins follow the person). */
  bound: Partial<Record<FollowedEngine, EngineLane>> | undefined = {};
  rows = new Map<"claude" | "codex", { version: number; access: string; status: "ready" | "needs_sign_in" }>();
  /** Every route asked, in order. */
  readonly asked: string[] = [];
  /** A failure for the next asks of a route (Cloud unreachable, or refusing this computer). */
  lanesFail: Error | undefined;
  getFail: Error | undefined;

  list = async () => [...this.rows].map(([engine, row]) => ({ engine, status: row.status }));
  lanes = async (): Promise<CloudLanes> => {
    this.asked.push("lanes");
    if (this.lanesFail) throw this.lanesFail;
    const followed = FOLLOWED.filter((e) => this.rows.has(CLOUD_ENGINE[e]));
    return { ...(this.bound === undefined ? {} : { lanes: this.bound }), followed, ...(this.person === undefined ? {} : { person: this.person }) };
  };
  get = async (engine: "claude" | "codex", knownVersion?: number): Promise<LoginAccess | undefined> => {
    this.asked.push(`get ${engine}`);
    if (this.getFail) throw this.getFail;
    const row = this.rows.get(engine);
    if (row === undefined) return undefined;
    if (row.status !== "ready") throw new CloudError(409, "This sign-in has expired.", "cave_code_engine_login_expired");
    const person = this.person === undefined ? {} : { person: this.person };
    if (knownVersion === row.version) return { engine, version: row.version, status: row.status, unchanged: true, ...person };
    return { engine, version: row.version, status: row.status, access_token: row.access, expires_at: new Date(Date.now() + 3_600_000).toISOString(), profile: engine === "codex" ? { auth_mode: "chatgpt", account_id: "acct-1" } : { subscription_type: "max" }, ...person };
  };
  refresh = async (): Promise<LoginAccess> => Promise.reject(new Error("no refresh here"));
  put = async () => ({ version: 1 });
  remove = async () => undefined;

  /** A sign-in that follows the person, ready. */
  signIn(engine: KeyedEngine, access = PLAN[engine], version = 1) {
    this.rows.set(CLOUD_ENGINE[engine], { version, access, status: "ready" });
  }
}
const FOLLOWED: ReadonlyArray<FollowedEngine> = ["claude-agent", "codex"];

let root = "";
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-keys-"));
  // The scrub's vault keys are the runtime's (one per engine): a launch where the person has neither lane drops them.
  for (const engine of ENGINES) await computer().launch(engine, {});
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** One pretend Cloud computer: its Cloud, its followed sign-ins, its Codex home and a vault that counts its reads. */
const computer = (cloud = new LaneCloud(), now: () => number = Date.now, logins = new FollowedLogins(now)) => {
  const codexHome = path.join(root, "providers", "codex", "active", "home");
  logins.connect({ cloud, files: toolsLoginFiles(undefined), paths: { claude: async () => path.join(root, "tools-home", ".claude", ".credentials.json"), codex: async () => path.join(codexHome, "auth.json") } });
  const vault = { keys: { ...VAULT } as Partial<Record<KeyedEngine, string>>, reads: 0 };
  const keys = { get: (engine: KeyedEngine) => Effect.sync(() => (vault.reads++, vault.keys[engine])), set: () => Effect.void };
  const launch = (engine: KeyedEngine, env: Record<string, string | undefined> = { KEEP: "1", ...(engine === "codex" ? { CODEX_HOME: codexHome } : {}) }) =>
    Effect.runPromiseExit(withEngineKey(engine, env, logins).pipe(Effect.provideService(EngineCloudKeys, keys)));
  return { cloud, logins, vault, keys, launch, codexHome, codexFile: path.join(codexHome, "auth.json") };
};

const envOf = <A>(exit: Exit.Exit<A, EngineLoginUnavailable>) => {
  if (Exit.isFailure(exit)) throw new Error(`launch failed: ${JSON.stringify(exit.cause)}`);
  return exit.value as Record<string, string | undefined>;
};
const refusalOf = (exit: Exit.Exit<unknown, EngineLoginUnavailable>) => {
  if (Exit.isSuccess(exit)) throw new Error(`launch ran on ${JSON.stringify(exit.value)}`);
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
  if (!isEngineLoginUnavailable(error)) throw new Error(`not a refusal: ${JSON.stringify(exit.cause)}`);
  return error;
};
/** Nothing of the vault key reached this launch: never read, no stand-in, the scrub holds none to swap in. */
const noVaultKey = (c: ReturnType<typeof computer>, env?: Record<string, string | undefined>) => {
  expect(c.vault.reads).toBe(0);
  for (const engine of ENGINES) expect(vaultKeyFor(engine === "codex" ? CODEX_VAULT_KEY_STAND_IN : VAULT_KEY_STAND_IN, engine)).toBeUndefined();
  if (env !== undefined) for (const value of [VAULT_KEY_STAND_IN, CODEX_VAULT_KEY_STAND_IN, ...Object.values(VAULT)]) expect(JSON.stringify(env)).not.toContain(value);
};
const onPlan = (c: ReturnType<typeof computer>, engine: KeyedEngine, env: Record<string, string | undefined>) => {
  if (engine === "claude-agent") expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(c.logins.claudeStandIn.access);
  else expect(c.logins.owns("codex", JSON.parse(fs.readFileSync(c.codexFile, "utf8")).tokens.access_token)).toBe(true);
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) expect(env[key]).toBeUndefined();
};

describe.each(ENGINES)("%s on a Cloud computer", (engine) => {
  const cloudEngine = CLOUD_ENGINE[engine];
  const keyVariable = engine === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  it("plan sign-in and vault key together: the lane Cloud names pays, and the other is never read or held", async () => {
    const c = computer();
    c.cloud.signIn(engine);
    c.cloud.bound = { [engine]: "followed_login" };
    // A key someone left in the environment does not win over the plan either.
    const planEnv = envOf(await c.launch(engine, { KEEP: "1", [keyVariable]: "sk-ambient", ...(engine === "codex" ? { CODEX_HOME: c.codexHome } : {}) }));
    onPlan(c, engine, planEnv);
    noVaultKey(c, planEnv);

    // The person added their API key for Cloud computers since (Cloud's lane is now vault_key): the key pays, the
    // sign-in is not read, and a Codex home's stand-ins no longer stand in the way.
    c.cloud.bound = { [engine]: "vault_key" };
    c.cloud.asked.length = 0;
    const keyEnv = envOf(await c.launch(engine));
    expect(keyEnv[keyVariable]).toBe(engine === "codex" ? CODEX_VAULT_KEY_STAND_IN : VAULT_KEY_STAND_IN);
    expect(keyEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(vaultKeyFor(keyEnv[keyVariable]!, engine)).toBe(VAULT[engine]);
    expect(c.cloud.asked).toEqual(["lanes"]);
    if (engine === "codex") expect(fs.existsSync(c.codexFile)).toBe(false);
  });

  it("refresh refused (invalid_grant → needs_sign_in): the launch fails with the sign-in fix, and no key is read", async () => {
    const c = computer();
    c.cloud.signIn(engine);
    c.cloud.bound = { [engine]: "followed_login" };
    onPlan(c, engine, envOf(await c.launch(engine)));
    // Cloud marked it needs_sign_in (its refresh got invalid_grant); this computer looks after REVALIDATE_MS.
    c.cloud.rows.get(cloudEngine)!.status = "needs_sign_in";
    await c.logins.ensureHeld(engine, true);
    const refusal = refusalOf(await c.launch(engine));
    expect(refusal).toMatchObject({ engine, lane: "followed_login" });
    expect(refusal.message).toBe(`Your ${engine === "codex" ? "ChatGPT" : "Claude"} sign-in expired. Reconnect it in Settings > Models & keys.`);
    noVaultKey(c);
  });

  it("sign-in removed (signed out everywhere; Cloud keeps the plan lane): the launch fails, never on the key", async () => {
    const c = computer();
    c.cloud.signIn(engine);
    c.cloud.bound = { [engine]: "followed_login" };
    envOf(await c.launch(engine));
    c.cloud.rows.delete(cloudEngine);
    await c.logins.ensureHeld(engine, true);
    expect(refusalOf(await c.launch(engine)).message).toMatch(/sign-in expired\. Reconnect it in Settings > Models & keys\./);
    if (engine === "codex") expect(fs.existsSync(c.codexFile)).toBe(false);
    noVaultKey(c);
  });

  it("Cloud unreachable: a cold computer launches nothing; a held sign-in carries on; nothing falls to the key", async () => {
    let clock = Date.now();
    const c = computer(new LaneCloud(), () => clock);
    c.cloud.signIn(engine);
    c.cloud.bound = { [engine]: "followed_login" };
    // Cold: Cloud can't say who pays.
    c.cloud.lanesFail = new Error("connect ECONNREFUSED");
    expect(refusalOf(await c.launch(engine))).toMatchObject({ lane: "unknown" });
    // Lanes known, the sign-in's read fails (503) with nothing held: refused, not the key.
    c.cloud.lanesFail = undefined;
    c.cloud.getFail = new CloudError(503, "unavailable", "cave_unavailable");
    expect(refusalOf(await c.launch(engine)).message).toBe("Can't reach Caveman, so this didn't start. Try again in a moment.");
    noVaultKey(c);
    // Reachable again: it runs on the plan, and a blip after that keeps the held sign-in for its minute.
    c.cloud.getFail = undefined;
    onPlan(c, engine, envOf(await c.launch(engine)));
    c.cloud.lanesFail = new Error("socket hang up");
    c.cloud.getFail = new Error("socket hang up");
    clock += REVALIDATE_MS / 2;
    onPlan(c, engine, envOf(await c.launch(engine)));
    // Past it, Cloud's last word is too old to launch on.
    clock += REVALIDATE_MS;
    expect(refusalOf(await c.launch(engine))).toMatchObject({ lane: "unknown" });
    noVaultKey(c);
  });

  it("restart: a fresh runtime asks Cloud again and keeps the plan lane through an expired sign-in", async () => {
    const cloud = new LaneCloud();
    cloud.signIn(engine);
    cloud.bound = { [engine]: "followed_login" };
    const before = computer(cloud);
    onPlan(before, engine, envOf(await before.launch(engine)));
    cloud.rows.get(cloudEngine)!.status = "needs_sign_in";
    const restarted = computer(cloud);
    expect(refusalOf(await restarted.launch(engine))).toMatchObject({ lane: "followed_login" });
    noVaultKey(restarted);
  });

  it("person change on the computer: what was held for the last person is dropped before the next one's launch", async () => {
    let clock = Date.now();
    const c = computer(new LaneCloud(), () => clock);
    c.cloud.signIn(engine, `${PLAN[engine]}-person-a`);
    c.cloud.bound = { [engine]: "followed_login" };
    envOf(await c.launch(engine));
    const standIn = engine === "claude-agent" ? c.logins.claudeStandIn.access : JSON.parse(fs.readFileSync(c.codexFile, "utf8")).tokens.access_token;
    expect((await c.logins.swap(engine, standIn))?.token).toBe(`${PLAN[engine]}-person-a`);

    // Person B's work runs here now. B's sign-in has the same version number, so the next `known_version` look says
    // "unchanged"; B's own token is read whole, and A's never serves B.
    c.cloud.person = "person-b";
    c.cloud.signIn(engine, `${PLAN[engine]}-person-b`);
    clock += REVALIDATE_MS + 1;
    expect((await c.logins.swap(engine, standIn))?.token).toBe(`${PLAN[engine]}-person-b`);
    onPlan(c, engine, envOf(await c.launch(engine)));

    // Person C pays with an API key: A's and B's sign-ins are gone from this computer, and C's key pays.
    c.cloud.person = "person-c";
    c.cloud.rows.clear();
    c.cloud.bound = { [engine]: "vault_key" };
    const env = envOf(await c.launch(engine));
    expect(env[keyVariable]).toBe(engine === "codex" ? CODEX_VAULT_KEY_STAND_IN : VAULT_KEY_STAND_IN);
    expect(c.logins.hasLogin(engine)).toBe(false);
    expect(await c.logins.swap(engine, standIn)).toBeUndefined();
  });

  it("a vault key chosen and then removed: the launch fails, and a sign-in that follows the person is not used instead", async () => {
    const c = computer();
    c.cloud.signIn(engine);
    c.cloud.bound = { [engine]: "vault_key" };
    delete c.vault.keys[engine];
    expect(refusalOf(await c.launch(engine))).toMatchObject({ lane: "vault_key" });
    expect(c.cloud.asked).toEqual(["lanes"]);
  });

  it("API-key-only person: runs on the key, from a Cloud with lanes and from one before them", async () => {
    for (const bound of [{ [engine]: "vault_key" as const }, undefined]) {
      const c = computer();
      c.cloud.bound = bound;
      const env = envOf(await c.launch(engine));
      expect(env[keyVariable]).toBe(engine === "codex" ? CODEX_VAULT_KEY_STAND_IN : VAULT_KEY_STAND_IN);
      expect(c.cloud.asked.filter((a) => a.startsWith("get"))).toEqual([]);
    }
  });

  it("a Cloud from before lanes: a sign-in that follows the person, in any state, still pays and never hands over to the key", async () => {
    const c = computer();
    c.cloud.bound = undefined;
    c.cloud.signIn(engine);
    c.cloud.rows.get(cloudEngine)!.status = "needs_sign_in";
    expect(refusalOf(await c.launch(engine))).toMatchObject({ lane: "followed_login" });
    noVaultKey(c);
  });

  it("neither (Cloud says so): the CLI's own login on this computer, the environment untouched, no key read", async () => {
    const c = computer();
    const given = { KEEP: "1" };
    expect(envOf(await c.launch(engine, given))).toBe(given);
    noVaultKey(c);
    expect(await Effect.runPromise(holdsCloudStandIn(engine, c.logins).pipe(Effect.provideService(EngineCloudKeys, c.keys)))).toBe(false);
  });
});

describe("This Mac", () => {
  it("is never joined to Cloud: the environment is untouched and nothing is asked or read", async () => {
    const mac = new FollowedLogins();
    const given = { KEEP: "1" };
    let reads = 0;
    const keys = { get: () => Effect.sync(() => (reads++, undefined)), set: () => Effect.void };
    for (const engine of ENGINES) expect(await Effect.runPromise(withEngineKey(engine, given, mac).pipe(Effect.provideService(EngineCloudKeys, keys)))).toBe(given);
    // The default vault off a Cloud computer holds nothing.
    for (const engine of ENGINES) expect(await Effect.runPromise(withEngineKey(engine, given, mac))).toBe(given);
    expect(reads).toBe(2);
  });
});

describe("Cloud's answer on the wire", () => {
  it("reads lanes, followed sign-ins and the person tag; an older Cloud's list without lanes; a Cloud without the route", async () => {
    const over = (answer: unknown) => followedCloudOver(async () => answer).lanes();
    expect(
      await over({
        logins: [{ engine: "claude", status: "needs_sign_in" }],
        lanes: [{ engine: "claude", lane: "followed_login", ready: false }, { engine: "codex", lane: "vault_key", ready: true }, { engine: "gemini", lane: "vault_key" }, { engine: "codex", lane: "bogus" }],
        person: "p-1",
      }),
    ).toEqual({ lanes: { "claude-agent": "followed_login", codex: "vault_key" }, followed: ["claude-agent"], person: "p-1" });
    expect(await over({ logins: [{ engine: "codex", status: "ready" }] })).toEqual({ followed: ["codex"] });
    expect(await followedCloudOver(async () => Promise.reject(new CloudError(404, "Not found."))).lanes()).toEqual({ followed: [] });
    await expect(followedCloudOver(async () => Promise.reject(new CloudError(503, "down"))).lanes()).rejects.toThrow("down");
  });
});

describe("the launch entrypoints", () => {
  // The runtime's own followed sign-ins, joined to a pretend Cloud as computerSecrets.ts joins them on a computer.
  const join = (cloud: LaneCloud) => computer(cloud, Date.now, followedLogins);

  it("Claude Agent's launch (scopeClaudeLaunch, sessions and the account probe) fails on a plan lane that can't serve, without the key", async () => {
    const cloud = new LaneCloud();
    cloud.person = "entry-claude";
    cloud.signIn("claude-agent");
    cloud.rows.get("claude")!.status = "needs_sign_in";
    cloud.bound = { "claude-agent": "followed_login" };
    const c = join(cloud);
    const exit = await Effect.runPromiseExit(scopeClaudeLaunch({ env: { KEEP: "1" } }, "thread-1").pipe(Effect.provideService(EngineCloudKeys, c.keys)));
    expect(refusalOf(exit as Exit.Exit<unknown, EngineLoginUnavailable>)).toMatchObject({ engine: "claude-agent", lane: "followed_login" });
    noVaultKey(c);
    // What the chat shows for that failed turn: the refusal's own words, not a generic provider failure.
    const runner = new ClaudeAgentSdkQueryRunnerError({ method: "scopeClaudeLaunch", cause: refusalOf(exit as Exit.Exit<unknown, EngineLoginUnavailable>) });
    const turn = new ProviderAdapterTurnStartError({ driver: "claudeAgent" as never, threadId: "thread-1" as never, providerThreadId: "p" as never, runId: "r" as never, cause: runner });
    expect(makeProviderFailure({ cause: turn }).message).toMatch(/Your Claude sign-in expired/);

    cloud.rows.get("claude")!.status = "ready";
    await followedLogins.ensureHeld("claude-agent", true);
    const options = await Effect.runPromise(scopeClaudeLaunch({ env: { KEEP: "1", ANTHROPIC_API_KEY: "sk-ambient" } }, "thread-1").pipe(Effect.provideService(EngineCloudKeys, c.keys)));
    expect(options.env).toEqual({ KEEP: "1", CLAUDE_CODE_OAUTH_TOKEN: followedLogins.claudeStandIn.access, CLAUDE_CODE_SUBSCRIPTION_TYPE: "max" });
    noVaultKey(c);
  });

  it("Claude Agent's account probe: a plan lane that can't serve reads as signed out with the fix, and no claude session starts on the key", { timeout: 60_000 }, async () => {
    const cloud = new LaneCloud();
    cloud.person = "entry-probe";
    cloud.bound = { "claude-agent": "followed_login" };
    const c = join(cloud);
    // A claude (the test fixture CLI, no model) that notes each start and which credential it was handed.
    const dir = fs.mkdtempSync(path.join(root, "claude-"));
    const mark = path.join(dir, "ran");
    // And its process id: the test ends once each has exited (on Windows a live one holds `dir`, its cwd).
    const pids = path.join(dir, "pids");
    // Windows starts no `#!` script. There it is laid out as npm installs claude: a claude.cmd shim, run through
    // cmd.exe for the version, and the package's cli.js beside it, which the SDK finds behind the shim.
    const claude = path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
    if (process.platform === "win32") {
      const entry = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(entry), "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", type: "module" }));
      fs.writeFileSync(
        entry,
        `import { appendFileSync } from "node:fs";\nimport { pathToFileURL } from "node:url";\n` +
          `const has = (name) => (process.env[name] ? "yes" : "");\n` +
          `appendFileSync(${JSON.stringify(mark)}, \`\${process.argv[2]} key=\${has("ANTHROPIC_API_KEY")} plan=\${has("CLAUDE_CODE_OAUTH_TOKEN")}\\n\`);\n` +
          `appendFileSync(${JSON.stringify(pids)}, \`\${process.pid}\\n\`);\n` +
          `await import(pathToFileURL(${JSON.stringify(FAKE_CLAUDE)}).href);\n`,
      );
      fs.writeFileSync(claude, `@"${process.execPath}" "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
    } else {
      fs.writeFileSync(claude, `#!/bin/sh\necho "$1 key=\${ANTHROPIC_API_KEY:+yes} plan=\${CLAUDE_CODE_OAUTH_TOKEN:+yes}" >> '${mark}'\necho $$ >> '${pids}'\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });
    }
    const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: claude });
    const probe = () =>
      Effect.runPromise(
        checkClaudeProviderStatus(settings, (s) => probeClaudeCapabilities(s, process.env, dir, false).pipe(Effect.provide(NodeServices.layer), Effect.provideService(EngineCloudKeys, c.keys)), process.env, dir).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    const out = await probe();
    expect(out).toMatchObject({ status: "error", auth: { status: "unauthenticated" }, message: expect.stringMatching(/Your Claude sign-in expired/) });
    // Only `claude --version` ran: no session, so nothing reached a provider on any login.
    expect(fs.readFileSync(mark, "utf8").trim().split("\n")).toEqual(["--version key= plan="]);
    noVaultKey(c);

    // The person chose their API key since: the probe's claude starts on the key's stand-in, never the plan.
    cloud.bound = { "claude-agent": "vault_key" };
    expect(await probe()).toMatchObject({ auth: { status: "authenticated" } });
    expect(fs.readFileSync(mark, "utf8").trim().split("\n").slice(1)).toEqual(["--version key= plan=", "--output-format key=yes plan="]);
    expect(c.vault.reads).toBeGreaterThan(0);
    // The probe ends its session's claude when it has read the login; none is left running.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const started = fs.readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(started).toHaveLength(3);
    for (const deadline = Date.now() + 10_000; started.some(alive) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
    expect(started.filter(alive)).toEqual([]);
  });

  it("Codex's app-server launch (makeCodexAppServerSpawnCommand) fails on a plan lane that can't serve, and runs on the key when the person chose it", async () => {
    const cloud = new LaneCloud();
    cloud.person = "entry-codex";
    cloud.bound = { codex: "followed_login" };
    const c = join(cloud);
    const spawn = () =>
      Effect.runPromiseExit(makeCodexAppServerSpawnCommand({ command: "codex", args: ["app-server"], env: { CODEX_HOME: c.codexHome }, threadId: "thread-2" }).pipe(Effect.provideService(EngineCloudKeys, c.keys)));
    expect(refusalOf((await spawn()) as Exit.Exit<unknown, EngineLoginUnavailable>)).toMatchObject({ engine: "codex", lane: "followed_login" });
    noVaultKey(c);
    expect(fs.existsSync(c.codexFile)).toBe(false);

    cloud.bound = { codex: "vault_key" };
    const exit = await spawn();
    if (Exit.isFailure(exit)) throw new Error(JSON.stringify(exit.cause));
    const env = (exit.value as unknown as { options: { env?: Record<string, string> } }).options.env ?? {};
    expect([env.OPENAI_API_KEY, env.CODEX_API_KEY]).toEqual([CODEX_VAULT_KEY_STAND_IN, CODEX_VAULT_KEY_STAND_IN]);
    expect(JSON.stringify(env)).not.toContain(VAULT.codex);
  });
});
