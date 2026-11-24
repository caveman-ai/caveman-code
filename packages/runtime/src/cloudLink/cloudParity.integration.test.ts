// Cloud parity end to end against the stand-in Cloud (docs/):
// This Mac's profile reaches a Cloud computer runtime whose state and tools roots are apart, as on the pod
// (the tools container never sees the runtime's state dir). There a space's plugin MCP server runs in the
// tools container, the Mac's home skill loads, a personal server gets its key only after the person opted it
// in, and a Mac-only server is kept but off with its reason. Canaries (TRUST T7) prove where values go:
// never into the profile, a request for a repository that was not opted in, the computer's disk, or an
// engine's server config; and into the one process meant to get them.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { afterEach, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CredentialGrants, layerSecretStore } from "../plugins/CredentialBroker.ts";
import { routeThroughHub } from "../plugins/hubRoute.ts";
import { McpHub, layer as hubLayer } from "../plugins/McpHub.ts";
import { PERSONAL_SPACE_URL } from "../plugins/personal.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import { checkoutSpace } from "../plugins/spaces.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { connect } from "@caveman-app/session-protocol";
import { git, makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { serverKeysShared } from "../session-protocol/cloudSync.ts";
import { CloudSyncState, computerSync, macSync, readChoices, writeChoices } from "./cloudSync.ts";
import { CloudValues, layerBroker, makeProjectSecrets } from "./computerSecrets.ts";
import { EngineCloudKeys, engineKeyName } from "./engineKeys.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

const scopes: Array<Scope.Closeable> = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const build = async <A>(layer: Layer.Layer<A, unknown, never>) => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  return Effect.runPromise(Layer.buildWithScope(layer, scope));
};
const runIn = <A, E>(context: Context.Context<any>, effect: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(effect, context) as Effect.Effect<A, E, never>);

/** A stdio MCP server: one `whoami` tool answering the sha256 of ECHO_KEY (never the value), its script's path, whether it saw RUNTIME_ONLY, and its HOME (which container started it). */
const SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const hash = (v) => v === undefined ? "none" : require("node:crypto").createHash("sha256").update(v).digest("hex");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "whoami", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: hash(process.env.ECHO_KEY) + " " + (process.argv[1] ?? "inline") + " " + (process.env.RUNTIME_ONLY ?? "hidden") + " " + process.env.HOME }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});`;

const restoreEnv = (saved: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const filesUnder = (root: string): string[] =>
  fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name)) : [];
const holding = (root: string, needle: string) => filesUnder(root).filter((file) => fs.readFileSync(file).includes(needle));

// Skipped on Windows: a Cloud computer is Linux; its tools channel is a Unix socket.
test.skipIf(process.platform === "win32")("a Mac profile runs on a Cloud computer with split state and tools roots; secret values go only where opted in", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // Shared profiles (v3): the profile is read before it is written, which Cloud does not do yet.
  cloud.state.parity.legacyProfiles = false;
  const KEY_CANARY = `canary-key-${randomBytes(12).toString("hex")}`;
  const REPO_CANARY = `canary-repo-${randomBytes(12).toString("hex")}`;
  const PRIVATE_CANARY = `canary-private-${randomBytes(12).toString("hex")}`;

  // A space repo, reachable at an https URL through git's insteadOf (no network).
  const spaceRepo = makeRepo(tempRoot("parity-space-"), {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "kit" }),
    ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.cjs"] } } }),
    "server.cjs": SERVER,
    "skills/ship/SKILL.md": "---\nname: ship\ndescription: Ship a change.\n---\nShip it.\n",
  });
  const spaceUrl = "https://parity.example.test/kit.git";
  const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${spaceRepo}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://parity.example.test/kit" };
  Object.assign(process.env, gitEnv);
  cleanups.push(() => Object.keys(gitEnv).forEach((k) => delete process.env[k]));
  const commit = git(spaceRepo, "rev-parse", "HEAD").trim();

  // ---------------------------------------------------------------- This Mac
  const macHome = tempRoot("parity-mac-home-");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(macHome, rel)), { recursive: true });
    fs.writeFileSync(path.join(macHome, rel), text);
  };
  write(".claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy the app.\n---\nRun the deploy.\n");
  write(".claude/skills/deploy/notes.md", `The key is ${REPO_CANARY}\n`);
  write(".claude/skills/deploy/.env", "TOKEN=whatever\n");
  write(".agents/skills/leaky/SKILL.md", `---\nname: leaky\n---\nUse sk-ant-api03-${"a".repeat(40)} for this.\n`);
  // C1: a skill Cloud refuses (its name) is left out here; it never stops the rest of the profile.
  write(".claude/skills/a..b/SKILL.md", "---\nname: dots\n---\nDots.\n");
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = macHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => restoreEnv(saved));

  const macConfig = Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-mac-" }));
  const mac = await build(
    Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }), Layer.succeed(CloudComputer, undefined))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(macConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const macState = Context.get(mac, ServerConfig.ServerConfig).stateDir;
  await enroll({ dir: linkDirOf(macState), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "Test Mac" });
  const side = await runIn(mac, macSync);

  await runIn(
    mac,
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      // This Mac has the git marketplace checked out (its registry does that) and its plugin installed.
      yield* Effect.promise(() => checkoutSpace({ url: spaceUrl, commit, spacesDir: path.join(macState, "spaces") }));
      yield* settings.updateSettings({
        plugins: {
          marketplaces: [
            { name: "kit", source: { kind: "git", url: spaceUrl, commit }, added_at: "" },
            { name: "my-space", source: { kind: "git", url: "/Users/someone/my-space", commit }, added_at: "" },
          ],
          installed: [{ id: "kit@kit", enabled: true }],
          servers: [
            { name: "echo", command: "node", args: ["-e", SERVER], env: ["ECHO_KEY"], source: "manual", enabled: true },
            { name: "notes", command: "osascript", args: ["notes.scpt"], source: "manual", enabled: true },
            { name: "leaky", command: "npx", args: ["some-mcp", "--api-key", ("sk_" + "live_abcdefghijklmnop123456")], source: "manual", enabled: true },
            // C4: shares ECHO_KEY with echo (one grant here, one name in Cloud) and needs a name Cloud cannot keep.
            { name: "echo2", command: "node", args: ["-e", SERVER], env: ["ECHO_KEY", "lower_key"], source: "manual", enabled: true },
          ],
        },
      });
      yield* (yield* CredentialGrants).grant(PERSONAL_SPACE_URL, "ECHO_KEY", Redacted.make(KEY_CANARY));
      const secrets = yield* ProjectSecrets;
      yield* secrets.set("github.com/acme/widgets", [{ name: "API_TOKEN", value: Redacted.make(REPO_CANARY) }]);
      yield* secrets.set("github.com/acme/private", [{ name: "PRIVATE_TOKEN", value: Redacted.make(PRIVATE_CANARY) }]);
      yield* side.pushProfile();
      yield* side.syncServerKeys();
    }),
  );
  const status = Context.get(mac, CloudSyncState).status;
  expect(status.state).toBe("ok");
  const item = (kind: string, id: string) => status.items.find((i) => i.kind === kind && i.id === id);
  expect(item("marketplace", "kit")).toMatchObject({ cloud: "runs" });
  expect(item("marketplace", "my-space")).toMatchObject({ cloud: "skipped" });
  expect(item("server", "notes")).toMatchObject({ cloud: "mac_only", reason: "osascript runs only on This Mac" });
  expect(item("server", "leaky")).toMatchObject({ cloud: "skipped" });
  expect(item("skill", "deploy")).toMatchObject({ cloud: "runs", reason: expect.stringContaining("notes.md (looks like it holds a secret)") });
  expect(item("skill", "deploy")!.reason).toContain(".env (a key or env file)");
  expect(item("skill", "leaky")).toMatchObject({ cloud: "skipped" });
  expect(item("skill", "a..b")).toMatchObject({ cloud: "skipped", reason: "its folder name is not a skill name" });
  // Nothing opted in yet: no secret value and no repository name went to Cloud, only the profile.
  // The profile is read before it is written (it is every computer's), then written over what was read.
  expect(cloud.state.parity.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/code/runtime/profile", "PUT /api/v1/code/runtime/profile"]);

  // The person opts one repository and one server in.
  await runIn(
    mac,
    Effect.gen(function* () {
      yield* side.setRepository("github.com/acme/widgets", true);
      yield* side.setServer("echo", true);
      yield* side.setServer("echo2", true);
    }),
  );
  // C4: two servers, one variable: one name in Cloud; the name Cloud cannot keep stays here, and says so.
  expect(Context.get(mac, CloudSyncState).status.keys_error).toContain("echo2's lower_key");
  // C5: a repository Cloud refuses is not left showing "on" while Cloud holds nothing.
  cloud.state.parity.refuseRepos.add("github.com/acme/refused");
  await expect(
    runIn(
      mac,
      Effect.gen(function* () {
        yield* (yield* ProjectSecrets).set("github.com/acme/refused", [{ name: "REFUSED", value: Redacted.make("refused-value") }]);
        return yield* side.setRepository("github.com/acme/refused", true);
      }),
    ),
  ).rejects.toThrow();
  expect(readChoices(macState).repositories).toEqual(["github.com/acme/widgets"]);
  expect(cloud.state.parity.secrets.get("github.com/acme/widgets")?.get("API_TOKEN")).toBe(REPO_CANARY);
  const keyName = [...(cloud.state.parity.secrets.get("caveman:servers")?.keys() ?? [])];
  expect(keyName).toEqual([`${sha(`${PERSONAL_SPACE_URL}\0ECHO_KEY`).slice(0, 16)}.ECHO_KEY`]);
  const pushedProfile = JSON.stringify(cloud.state.parity.profile);
  expect(pushedProfile).toContain('"cloudConsent":true');
  // T7: the profile carries no value, and the repository that was not opted in was never named to Cloud.
  for (const canary of [KEY_CANARY, REPO_CANARY, PRIVATE_CANARY]) expect(pushedProfile).not.toContain(canary);
  expect(JSON.stringify(cloud.state.parity.requests)).not.toContain("acme/private");
  expect(JSON.stringify(cloud.state.parity.requests)).not.toContain(PRIVATE_CANARY);

  // ---------------------------------------------------------------- the Cloud computer
  // Two roots, as the pod mounts them: the runtime's state, and what the tools container sees (workspace, home).
  const toolsRoot = tempRoot("parity-tools-");
  const workspace = makeRepo(toolsRoot, { "README.md": "widgets\n" });
  git(workspace, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const toolsHome = path.join(toolsRoot, "home");
  fs.mkdirSync(toolsHome);
  const socket = path.join(tempRoot("parity-sock-"), "tools.sock");
  const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, HOME: toolsHome }, cwd: workspace, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  await until(() => fs.existsSync(socket));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cleanups.push(() => delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS);
  // I1: a third root, the servers container (its own uid on the pod): MCP servers and their keys start there.
  const serversHome = path.join(tempRoot("parity-servers-"), "home");
  fs.mkdirSync(serversHome);
  const serversSocket = path.join(tempRoot("parity-sock-"), "servers.sock");
  const serversToken = randomBytes(32).toString("hex");
  const serversExec = spawn(process.execPath, [TOOLS_EXEC, "serve", serversSocket], { env: { ...process.env, HOME: serversHome, CAVEMAN_TOOLS_TOKEN: serversToken }, cwd: workspace, stdio: "ignore" });
  cleanups.push(() => serversExec.kill());
  await until(() => fs.existsSync(serversSocket));
  process.env.CAVEMAN_RUNTIME_SERVERS_ADDRESS = serversSocket;
  process.env.CAVEMAN_RUNTIME_SERVERS_TOKEN = serversToken;
  cleanups.push(() => {
    delete process.env.CAVEMAN_RUNTIME_SERVERS_ADDRESS;
    delete process.env.CAVEMAN_RUNTIME_SERVERS_TOKEN;
  });
  // The agent's commands share the pod's loopback: without the token the servers channel runs nothing.
  const intruder = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const env = { ...process.env };
    delete env.CAVEMAN_RUNTIME_SERVERS_TOKEN;
    const child = spawn(process.execPath, [TOOLS_EXEC, "exec", "--socket", serversSocket, "--", "sh", "-c", "echo ran"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  expect(intruder).toMatchObject({ code: 127, stderr: expect.stringContaining("bad request") });
  // H2: an org Space this person never turned on on This Mac (a computer pulls only their profile).
  cloud.state.parity.spaces.push({ id: "s-admin", name: "admin-kit", repo: "acme/admin-kit", commit });
  process.env.RUNTIME_ONLY = "runtime-only-value";
  cleanups.push(() => delete process.env.RUNTIME_ONLY);

  const linkDir = path.join(tempRoot("parity-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  cloud.state.parity.computers.add(identity.runtimeId);
  const computerRefs = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: workspace }),
    Layer.succeed(CloudLinkState, {}),
    Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }),
    Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
  );
  const computer = await build(
    hubLayer.pipe(
      Layer.provideMerge(PluginRegistry.layer),
      Layer.provideMerge(Layer.merge(layerBroker, Layer.effect(ProjectSecrets, makeProjectSecrets))),
      Layer.provideMerge(ServerSettingsModule.layer),
      Layer.provideMerge(computerRefs),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-computer-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const computerState = Context.get(computer, ServerConfig.ServerConfig).stateDir;
  const pull = await runIn(computer, computerSync);
  await Context.get(computer, CloudSyncState).beforeSession!();
  const pulled = Context.get(computer, CloudSyncState).status;
  expect(pulled.state).toBe("ok");
  expect(pulled.items.find((i) => i.id === "notes")).toMatchObject({ kind: "server", cloud: "mac_only", reason: "osascript runs only on This Mac" });
  // The hub starts servers in the servers container here, so the UI may say only that server's process gets its keys.
  expect(await serverKeysShared(true)).toBe(false);
  // H2: the org's Space never reaches the person's computer through their profile.
  expect(pulled.items.some((i) => i.id.includes("admin-kit"))).toBe(false);
  // I2: the skills folder is stable; `current` names the generation in use.
  const skillsDir = path.join(computerState, "profile-skills");
  expect(fs.lstatSync(path.join(skillsDir, "current")).isSymbolicLink()).toBe(true);

  const out = await runIn(
    computer,
    Effect.gen(function* () {
      const registry = yield* PluginRegistry.PluginRegistry;
      const hub = yield* McpHub;
      const settings = (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).plugins;
      // The space checks out on the computer (in the runtime's state dir); its plugin and the Mac's skill load.
      let known = yield* registry.known;
      for (let i = 0; i < 200 && !known.markets.every((m) => m.status === "ready"); i++) {
        yield* Effect.sleep("100 millis");
        known = yield* registry.known;
      }
      const session = yield* registry.session();
      const caller = { threadId: ThreadId.make("parity-thread"), hooks: false };
      const call = (key: string) => hub.handle(caller, key, { jsonrpc: "2.0", id: key, method: "tools/call", params: { name: "whoami", arguments: {} } });
      const secrets = yield* ProjectSecrets;
      const repo = yield* secrets.resolve(yield* secrets.keyOf({ path: workspace }));
      return { settings, known, session, plugin: yield* call("kit__files"), echo: yield* call("echo"), scrubber: yield* secrets.scrubber, repo };
    }),
  );
  // By name: the shared profile lists everything sorted, so every computer writes the same bytes.
  expect(out.settings.servers.map((s) => [s.name, s.enabled])).toEqual([
    ["echo", true],
    ["echo2", true],
    ["notes", false],
  ]);
  // The profile's space became the computer's marketplace and install again.
  expect(out.known.plugins.map(({ plugin }) => plugin.id)).toEqual(expect.arrayContaining(["kit@kit", "my-skills@profile"]));
  const skills = out.known.plugins.flatMap(({ plugin }) => plugin.skills.map((s) => s.name));
  expect(skills).toEqual(expect.arrayContaining(["ship", "deploy"]));
  expect(skills).not.toContain("leaky");
  // The space's server ran in the servers container (I1), from the checkout the pod mounts read-only at the
  // same path (M1): nothing was copied into a home the agent can write.
  const text = (reply: unknown) => (reply as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text ?? JSON.stringify(reply);
  const [pluginKey, pluginScript, pluginSaw, pluginHome] = text(out.plugin).split(" ");
  expect(pluginKey).toBe("none");
  expect(fs.realpathSync(pluginScript!).startsWith(path.join(fs.realpathSync(computerState), "spaces") + path.sep)).toBe(true);
  expect(pluginSaw).toBe("hidden");
  expect(pluginHome).toBe(serversHome);
  expect(fs.existsSync(path.join(toolsHome, ".caveman", "spaces"))).toBe(false);
  expect(fs.existsSync(path.join(serversHome, ".caveman", "spaces"))).toBe(false);
  // What the bundle itself names is the checkout in the state dir, which the tools container cannot see: the hub's copy is what runs.
  expect(JSON.stringify(out.session.bundle.mcpServers.kit__files)).toContain(fs.realpathSync(computerState));
  // The opted-in server's key reached its own process (its hash), and the runtime's own environment did not.
  expect(text(out.echo).split(" ")[0]).toBe(sha(KEY_CANARY));
  expect(text(out.echo).split(" ")[2]).toBe("hidden");
  // I1: the keyed server is not in the tools container, where the agent's commands run.
  expect(text(out.echo).split(" ")[3]).toBe(serversHome);
  // Engines reach stdio servers only through the hub: no engine config holds the key.
  expect(out.session.hubOnly).toEqual(expect.arrayContaining(["echo", "kit__files"]));
  const engineView = routeThroughHub(out.session.bundle.mcpServers, { endpoint: "http://127.0.0.1:1/mcp", authorizationHeader: "Bearer t" }, (k) => out.session.hubOnly.includes(k), out.session.hubOnly);
  expect(JSON.stringify(engineView)).not.toContain(KEY_CANARY);
  // The opted-in repository's secret resolved on the computer, in memory, and every value is scrubbed.
  expect(out.repo).toEqual([{ name: "API_TOKEN", value: REPO_CANARY }]);
  expect(out.scrubber.scrub(`a ${KEY_CANARY} b ${REPO_CANARY}`)).not.toMatch(/canary-/);
  // T4/T7: no value on the computer's disk (state dir) or in the tools root.
  for (const canary of [KEY_CANARY, REPO_CANARY, PRIVATE_CANARY]) {
    expect(holding(computerState, canary)).toEqual([]);
    expect(holding(toolsRoot, canary)).toEqual([]);
  }
  // Claude Agent's API key, typed on the computer: kept in the vault beside the server keys, read back into memory
  // only and scrubbed, never on the computer's disk. This Mac's server-key mirror leaves it, and What Cloud holds names it.
  const ENGINE_CANARY = `canary-engine-${randomBytes(12).toString("hex")}`;
  const engine = await runIn(
    computer,
    Effect.gen(function* () {
      const keys = yield* EngineCloudKeys;
      yield* keys.set("claude-agent", ENGINE_CANARY);
      const key = yield* keys.get("claude-agent");
      return { key, scrubbed: (yield* (yield* ProjectSecrets).scrubber).scrub(`key ${ENGINE_CANARY}`) };
    }),
  );
  expect(engine.key).toBe(ENGINE_CANARY);
  expect(engine.scrubbed).not.toContain(ENGINE_CANARY);
  expect(holding(computerState, ENGINE_CANARY)).toEqual([]);
  expect(holding(toolsRoot, ENGINE_CANARY)).toEqual([]);
  await runIn(mac, side.syncServerKeys(true));
  expect(cloud.state.parity.secrets.get("caveman:servers")?.get(engineKeyName("claude-agent"))).toBe(ENGINE_CANARY);
  const heldKeys = (await runIn(mac, side.holdings)).find((h) => h.kind === "server_keys");
  expect(heldKeys).toMatchObject({ label: "Keys of your MCP servers, and Claude Agent's API key", names: expect.arrayContaining(["ANTHROPIC_API_KEY", "ECHO_KEY"]) });
  expect(JSON.stringify(heldKeys)).not.toContain(ENGINE_CANARY);

  // Every read by the computer is in the access log the Mac can show.
  const log = await runIn(mac, side.accessLog(50));
  expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(["profile.read", "secrets.resolve"]));

  // A pull of an unchanged profile asks with its digest: Cloud answers 304 and logs no read.
  const reads = cloud.state.parity.accessLog.filter((e) => e.action === "profile.read").length;
  await pull.pullNow();
  expect(cloud.state.parity.accessLog.filter((e) => e.action === "profile.read").length).toBe(reads);
  expect(Context.get(computer, CloudSyncState).status.state).toBe("ok");
  const computerSettings = Context.get(computer, ServerSettingsModule.ServerSettingsService);
  const computerServers = () => runIn(computer, computerSettings.getSettings.pipe(Effect.map((s) => s.plugins.servers)));
  // C6: a pull that brings nothing new writes nothing, so an edit made on this computer stays.
  await runIn(computer, computerSettings.updateSettings({ plugins: { servers: (await computerServers()).map((s) => (s.name === "echo2" ? { ...s, enabled: false } : s)) } }));
  await pull.pullNow();
  expect((await computerServers()).find((s) => s.name === "echo2")?.enabled).toBe(false);
  // ---------------------------------------------------------------- what Cloud holds, and removing it
  const held = await runIn(mac, side.holdings);
  expect(held.map((h) => h.kind)).toEqual(["profile", "repository_secrets", "server_keys"]);
  expect(held.find((h) => h.kind === "repository_secrets")).toMatchObject({ id: "github.com/acme/widgets", names: ["API_TOKEN"] });
  expect(JSON.stringify(held)).not.toMatch(/canary-/);
  // Turning one repository off deletes its Cloud copies at once.
  await runIn(mac, side.setRepository("github.com/acme/widgets", false));
  expect(cloud.state.parity.secrets.has("github.com/acme/widgets")).toBe(false);
  await runIn(mac, side.remove({ all: true }));
  expect(cloud.state.parity.profile).toBeUndefined();
  expect(cloud.state.parity.pausedAt).toBeDefined();
  expect(cloud.state.parity.secrets.size).toBe(0);
  expect(readChoices(macState)).toMatchObject({ repositories: [], serverKeys: false, paused: true });
  // Paused: a change does not push the profile again until cloud.profile.sync.
  await runIn(mac, side.pushProfile());
  expect(cloud.state.parity.profile).toBeUndefined();
  expect(JSON.stringify(cloud.state.parity.requests)).not.toContain(PRIVATE_CANARY);
  // Cloud unreachable: the last good profile stays.
  await cloud.close();
  await pull.pullNow();
  expect(Context.get(computer, CloudSyncState).status).toMatchObject({ state: "error", error: expect.stringContaining("the last profile pulled stays in use") });
  expect(await computerServers()).toHaveLength(3);
}, 180_000);

// Skipped on Windows: a Cloud computer is Linux; it swaps profile skills by renaming a symlink over the last.
test.skipIf(process.platform === "win32")("H1: a computer that Cloud refuses (shared with someone else's work, revoked) keeps none of the person's settings, servers, skills or secrets", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = tempRoot("parity-h1-home-");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => restoreEnv(saved));
  fs.mkdirSync(path.join(process.env.HOME, ".claude/skills/deploy"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\n---\nDeploy.\n");
  const SECRET = `canary-h1-${randomBytes(8).toString("hex")}`;

  const mac = await build(
    Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }), Layer.succeed(CloudComputer, undefined))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-h1-mac-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const macState = Context.get(mac, ServerConfig.ServerConfig).stateDir;
  await enroll({ dir: linkDirOf(macState), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "Test Mac" });
  const side = await runIn(mac, macSync);
  // C14: one sync per runtime, whoever asks.
  expect(await runIn(mac, macSync)).toBe(side);
  await runIn(
    mac,
    Effect.gen(function* () {
      yield* (yield* ServerSettingsModule.ServerSettingsService).updateSettings({ plugins: { servers: [{ name: "echo", command: "node", args: ["-e", SERVER], source: "manual", enabled: true }] } });
      yield* (yield* ProjectSecrets).set("github.com/acme/widgets", [{ name: "API_TOKEN", value: Redacted.make(SECRET) }]);
      yield* side.pushProfile();
      yield* side.setRepository("github.com/acme/widgets", true);
    }),
  );

  const toolsRoot = tempRoot("parity-h1-tools-");
  const workspace = makeRepo(toolsRoot, { "README.md": "widgets\n" });
  git(workspace, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const linkDir = path.join(tempRoot("parity-h1-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  cloud.state.parity.computers.add(identity.runtimeId);
  const computer = await build(
    Layer.merge(layerBroker, Layer.effect(ProjectSecrets, makeProjectSecrets)).pipe(
      Layer.provideMerge(ServerSettingsModule.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: workspace }),
          Layer.succeed(CloudLinkState, {}),
          Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }),
          Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
        ),
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-h1-computer-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const computerState = Context.get(computer, ServerConfig.ServerConfig).stateDir;
  // No servers container here (or one that does not answer): the agent's commands can read server keys, and the status says so.
  expect(await serverKeysShared(true)).toBe(true);
  const pull = await runIn(computer, computerSync);
  await pull.pullNow();
  const servers = () => runIn(computer, Effect.gen(function* () {
    return (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).plugins.servers;
  }));
  expect((await servers()).map((s) => s.name)).toEqual(["echo"]);
  expect(fs.readdirSync(path.join(computerState, "profile-skills", "current"))).toEqual(["deploy"]);
  const secrets = Context.get(computer, ProjectSecrets);
  expect((await runIn(computer, secrets.list("github.com/acme/widgets"))).map((s) => s.name)).toEqual(["API_TOKEN"]);

  // Another person's work lands on this computer: Cloud refuses, and nothing of this person's stays.
  cloud.state.parity.shared.add(identity.runtimeId);
  await pull.pullNow();
  expect(Context.get(computer, CloudSyncState).status).toMatchObject({
    state: "error",
    error: "Caveman refused: this computer also runs another person's work, so it gets no one's settings or secrets; none of your settings are used here",
  });
  expect(await servers()).toEqual([]);
  expect(fs.readdirSync(path.join(computerState, "profile-skills", "current"))).toEqual([]);
  expect(await runIn(computer, secrets.list("github.com/acme/widgets"))).toEqual([]);
  // Asleep or idle answers the same way.
  cloud.state.parity.shared.delete(identity.runtimeId);
  cloud.state.parity.asleep.add(identity.runtimeId);
  await pull.pullNow();
  expect(Context.get(computer, CloudSyncState).status.error).toContain("asleep or stopped");
  cloud.state.parity.asleep.delete(identity.runtimeId);
  await pull.pullNow();
  expect((await servers()).map((s) => s.name)).toEqual(["echo"]);
}, 120_000);

test("what Cloud holds comes from Cloud (M3), removing it is honest (C10/I5), a removal elsewhere pauses This Mac (I4), and a new account starts from no (M4)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = tempRoot("parity-m3-home-");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => restoreEnv(saved));
  const KEY = `canary-m3-${randomBytes(8).toString("hex")}`;
  const mac = await build(
    Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }), Layer.succeed(CloudComputer, undefined))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-m3-mac-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const macState = Context.get(mac, ServerConfig.ServerConfig).stateDir;
  await enroll({ dir: linkDirOf(macState), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "Test Mac" });
  const side = await runIn(mac, macSync);
  const status = () => Context.get(mac, CloudSyncState).status;
  await runIn(
    mac,
    Effect.gen(function* () {
      yield* (yield* ServerSettingsModule.ServerSettingsService).updateSettings({ plugins: { servers: [{ name: "echo", command: "node", args: ["-e", SERVER], env: ["ECHO_KEY"], source: "manual", enabled: true }] } });
      yield* (yield* CredentialGrants).grant(PERSONAL_SPACE_URL, "ECHO_KEY", Redacted.make(KEY));
      yield* side.pushProfile();
      yield* side.setServer("echo", true);
    }),
  );
  // Set from the web (or another Mac): This Mac never opted it in, Cloud still lists it.
  cloud.state.parity.secrets.set("github.com/acme/web-only", new Map([["WEB_TOKEN", "web-value"]]));
  cloud.state.githubToken = "gho_test";
  const held = await runIn(mac, side.holdings);
  expect(held.map((h) => [h.kind, h.id])).toEqual([
    ["profile", "profile"],
    ["repository_secrets", "github.com/acme/web-only"],
    ["server_keys", "caveman:servers"],
    ["connection", "github"],
  ]);
  expect(held.find((h) => h.kind === "server_keys")!.names).toEqual(["ECHO_KEY"]);
  expect(held.find((h) => h.kind === "connection")!.label).toContain("GitHub");
  expect(JSON.stringify(held)).not.toContain(KEY);
  // Remove everything: what This Mac never opted in and the GitHub login go too.
  expect(await runIn(mac, side.remove({ all: true }))).toBe(4);
  expect(cloud.state.parity.secrets.size).toBe(0);
  expect(cloud.state.githubToken).toBeUndefined();
  expect(cloud.state.parity.pausedAt).toBeDefined();
  expect(status().state).toBe("paused");
  // Sync again: Cloud's tombstone is lifted with an explicit resume.
  await runIn(mac, side.resume);
  expect(cloud.state.parity.profile).toBeDefined();
  expect(status().state).toBe("ok");
  expect(readChoices(macState).paused).toBe(false);
  // Removed on the web: This Mac's next push is refused, it stops and says so instead of putting it back.
  cloud.state.parity.profile = undefined;
  cloud.state.parity.pausedAt = new Date().toISOString();
  await runIn(mac, side.pushProfile(true));
  expect(status().state).toBe("paused");
  expect(cloud.state.parity.profile).toBeUndefined();
  expect(readChoices(macState).paused).toBe(true);

  // Signed in to another account: no earlier yes carries over, so no key goes.
  await runIn(mac, side.setServer("echo", true));
  expect(cloud.state.parity.secrets.has("caveman:servers")).toBe(true);
  await runIn(mac, side.remove({ kind: "server_keys" }));
  writeChoices(macState, (c) => ({ ...c, owner: "another account" }));
  await runIn(mac, side.syncServerKeys(true));
  expect(cloud.state.parity.secrets.has("caveman:servers")).toBe(false);
  const consent = await runIn(mac, Effect.gen(function* () {
    return (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).plugins.servers.map((s) => s.cloudConsent);
  }));
  expect(consent).toEqual([undefined]);
  expect(readChoices(macState)).toMatchObject({ repositories: [], paused: false });
}, 120_000);


test("Session Protocol: profile status after sign-in, a repository opted in and out, what Cloud holds, sign-out deletes it", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // An empty home: no skill of the machine running the test goes anywhere.
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = tempRoot("parity-sp-home-");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => restoreEnv(saved));
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(ServerSettingsModule.layerTest().pipe(Layer.orDie), layerSecretStore, Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } })) as unknown as Layer.Layer<any>,
  });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const repo = { url: "https://github.com/acme/widgets" };
  const CANARY = `canary-${randomBytes(12).toString("hex")}`;

  expect(await client.call("cloud.profile.status", {})).toMatchObject({ state: "off", server_keys_shared: true });
  await client.call("secret.set", { request_id: "s0", repo, secrets: [{ name: "API_TOKEN", value: CANARY }] });
  await client.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  // Signed in: the profile goes by itself; the secret does not.
  await until(async () => (await client.call("cloud.profile.status", {})).state === "ok", 15_000);
  expect(cloud.state.parity.profile).toBeDefined();
  expect((await client.call("secret.list", { repo })).cloud_available).toBeUndefined();
  expect(JSON.stringify(cloud.state.parity.requests)).not.toContain("acme/widgets");

  // Add from this Mac: only the names the person was shown go, and follow their changes; the switch stays off.
  const gadgets = { url: "https://github.com/acme/gadgets" };
  await client.call("secret.set", { request_id: "g0", repo: gadgets, secrets: [{ name: "STRIPE_KEY", value: `${CANARY}-s` }, { name: "AWS_SECRET", value: `${CANARY}-a` }] });
  expect(await client.call("cloud.secrets.set_available", { request_id: "g1", repo: gadgets, available: true, names: ["STRIPE_KEY"] })).toEqual({ repository: "github.com/acme/gadgets", available: true, names: ["STRIPE_KEY"] });
  expect([...(cloud.state.parity.secrets.get("github.com/acme/gadgets")?.keys() ?? [])]).toEqual(["STRIPE_KEY"]);
  // The switch stays off, and the list names what Cloud holds anyway.
  expect(await client.call("secret.list", { repo: gadgets })).toMatchObject({ cloud_names: ["STRIPE_KEY"] });
  expect((await client.call("secret.list", { repo: gadgets })).cloud_available).toBeUndefined();
  await client.call("secret.set", { request_id: "g2", repo: gadgets, secrets: [{ name: "STRIPE_KEY", value: `${CANARY}-s2` }, { name: "AWS_SECRET", value: `${CANARY}-a2` }] });
  await until(() => cloud.state.parity.secrets.get("github.com/acme/gadgets")?.get("STRIPE_KEY") === `${CANARY}-s2`, 10_000);
  expect(cloud.state.parity.secrets.get("github.com/acme/gadgets")?.has("AWS_SECRET")).toBe(false);
  expect(JSON.stringify(cloud.state.parity.requests)).not.toContain(`${CANARY}-a`);
  await client.call("cloud.secrets.set_available", { request_id: "g3", repo: gadgets, available: false });
  expect(cloud.state.parity.secrets.get("github.com/acme/gadgets")?.size ?? 0).toBe(0);
  expect((await client.call("secret.list", { repo: gadgets })).cloud_names).toBeUndefined();

  expect(await client.call("cloud.secrets.set_available", { request_id: "a1", repo, available: true })).toEqual({ repository: "github.com/acme/widgets", available: true, names: ["API_TOKEN"] });
  expect(cloud.state.parity.secrets.get("github.com/acme/widgets")?.get("API_TOKEN")).toBe(CANARY);
  expect((await client.call("secret.list", { repo })).cloud_available).toBe(true);
  // An opted-in repository follows each change.
  await client.call("secret.set", { request_id: "s1", repo, secrets: [{ name: "SECOND", value: `${CANARY}-2` }] });
  await until(() => cloud.state.parity.secrets.get("github.com/acme/widgets")?.has("SECOND") === true, 10_000);
  await client.call("secret.delete", { request_id: "s2", repo, name: "SECOND" });
  await until(() => cloud.state.parity.secrets.get("github.com/acme/widgets")?.has("SECOND") === false, 10_000);

  const { items } = await client.call("cloud.holdings", {});
  expect(items.map((i) => [i.kind, i.id, i.names])).toEqual([
    ["profile", "profile", []],
    ["repository_secrets", "github.com/acme/widgets", ["API_TOKEN"]],
  ]);
  expect(JSON.stringify(items)).not.toContain(CANARY);
  // A connection is named by its server, GitHub as GitHub (Cloud's provider is "mcp" on every server row).
  cloud.state.connections.set("c1", { connection_id: "c1", resource: "https://mcp.linear.app/mcp", status: "connected", updated_at: new Date().toISOString(), token: CANARY });
  cloud.state.githubToken = `${CANARY}-gh`;
  const named = (await client.call("cloud.holdings", {})).items.filter((i) => i.kind === "connection");
  expect(named.map((i) => [i.id, i.label])).toEqual([
    ["c1", "https://mcp.linear.app/mcp"],
    ["github", "GitHub"],
  ]);

  // Signing out deletes what Cloud holds (the default).
  await client.call("cloud.signout", { request_id: "o1" });
  expect(cloud.state.parity.profile).toBeUndefined();
  expect(cloud.state.parity.secrets.size).toBe(0);
  // Connector sign-ins too, GitHub's included.
  expect(cloud.state.connections.size).toBe(0);
  expect(cloud.state.githubToken).toBeUndefined();
}, 120_000);

test("a Settings change made while a profile push is in flight reaches Cloud within seconds, not at the five-minute push", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = tempRoot("parity-mid-push-home-");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => restoreEnv(saved));
  const mac = await build(
    Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }), Layer.succeed(CloudComputer, undefined))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "parity-mid-push-mac-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  await enroll({ dir: linkDirOf(Context.get(mac, ServerConfig.ServerConfig).stateDir), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "Test Mac" });
  const side = await runIn(mac, macSync);
  const loop = Effect.runFork(Effect.provide(Effect.scoped(side.loop), mac) as Effect.Effect<never, unknown, never>);
  cleanups.push(() => Effect.runPromise(Fiber.interrupt(loop)));
  const setServers = (names: ReadonlyArray<string>) =>
    runIn(
      mac,
      Effect.gen(function* () {
        yield* (yield* ServerSettingsModule.ServerSettingsService).updateSettings({ plugins: { servers: names.map((name) => ({ name, command: "node", args: ["-e", "0"], source: "manual" as const, enabled: true })) } });
      }),
    );
  const inCloud = () => ((cloud.state.parity.profile?.profile as { plugins?: { servers?: Array<{ name: string }> } } | undefined)?.plugins?.servers ?? []).map((s) => s.name);
  // A push reads the shared profile before it writes it: the held read is the push in flight.
  const profileCalls = () => cloud.state.seen.filter((r) => r.path.endsWith("/profile")).length;

  // The push on sign-in lands.
  await until(() => cloud.state.parity.profile !== undefined && Context.get(mac, CloudSyncState).status.state === "ok", 10_000);
  // A server added: its push (2 s later) is held mid-flight, and another server is added meanwhile.
  cloud.state.paused = true;
  const before = profileCalls();
  await setServers(["a"]);
  await until(() => profileCalls() > before, 10_000);
  await setServers(["a", "b"]);
  cloud.state.paused = false;
  await until(() => inCloud().includes("a"), 10_000);
  await until(() => inCloud().includes("b"), 8_000).catch(() => {});
  await Effect.runPromise(Fiber.interrupt(loop));
  expect(inCloud()).toEqual(["a", "b"]);
}, 60_000);
