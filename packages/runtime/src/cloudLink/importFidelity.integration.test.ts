// Bring my setup end to end (docs/ "Amended 2026-10-22"): a Codex config.toml
// written the ways TOML allows goes through import.scan and import.apply on This Mac's registry, the profile
// to the stand-in Cloud, and a Cloud computer runtime applies it. There the imported server starts with the
// argv Codex would give it (H07), a skill's 0755 helper runs from the synced folder through the tools channel
// while its data stays data (H08), same-named skills each say what happened (H09), and a server earns
// "started" only by its own tool list on the computer, a laptop's loopback and a missing script saying why
// they cannot (H10).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterEach, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layerSecretStore } from "../plugins/CredentialBroker.ts";
import { makeImportHandlers } from "../plugins/importHandlers.ts";
import { McpHub, layer as hubLayer, personalServer } from "../plugins/McpHub.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as SessionStore from "../session-protocol/store.ts";
import { git, makeRepo, tempRoot, until } from "../session-protocol/testHarness.ts";
import { CloudSyncState, computerSync, macSync } from "./cloudSync.ts";
import { CloudValues, layerBroker, makeProjectSecrets } from "./computerSecrets.ts";
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

/** An MCP server with one `argv` tool answering the arguments it was started with, as JSON. */
const SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
// "[mcp_servers.fake]" and a # hash live inside this string, as code often has them.
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "argv", version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "argv", inputSchema: { type: "object" } }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify([...process.execArgv, ...process.argv.slice(1)]) }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});`;

// The H07 shape: args over several lines, a comment between them, the script in a multi-line literal string.
const CONFIG = `# Bring my setup reads this as Codex does.
model = "gpt-6"

[mcp_servers.argv]
command = "node" # on PATH here and on the computer
args = [
  "-e",
  '''
${SERVER}
''',
  "marker", # after the script
  "argv #1",
]

[mcp_servers.scoped]
command = "node"
args = ["server.js"]
cwd = "/srv/app"

[mcp_servers.off]
command = "npx"
args = ["-y", "off-mcp"]
enabled = false

[mcp_servers.loopback]
url = "http://127.0.0.1:9/mcp"

[mcp_servers.missing]
command = "node"
args = ["./missing-server.js"]
`;

/** Python's tomllib (standard library) as the independent reader of CONFIG; undefined where python3 has none. */
const oracleArgs = (): ReadonlyArray<string> | undefined => {
  const run = spawnSync("python3", ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())['mcp_servers']['argv']['args']))"], { input: CONFIG, encoding: "utf8" });
  return run.status === 0 ? (JSON.parse(run.stdout) as string[]) : undefined;
};

// Skipped on Windows: a Cloud computer is Linux; its tools channel is a Unix socket and modes are POSIX.
test.skipIf(process.platform === "win32")("Bring my setup keeps argv, helper modes and same-named skills, and claims a server starts only once it did on the computer", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);

  // ---------------------------------------------------------------- This Mac
  const macHome = tempRoot("fidelity-mac-home-");
  const put = (rel: string, text: string | Buffer, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(macHome, rel)), { recursive: true });
    fs.writeFileSync(path.join(macHome, rel), text);
    fs.chmodSync(path.join(macHome, rel), mode);
  };
  put(".codex/config.toml", CONFIG);
  put(".claude/skills/launch/SKILL.md", "---\nname: launch\ndescription: Check before launch.\n---\nRun scripts/check.sh directly.\n");
  put(".claude/skills/launch/scripts/check.sh", "#!/bin/sh\necho skill-ok\n", 0o755);
  put(".claude/skills/launch/templates/hook.sh", "#!/bin/sh\necho data\n", 0o644);
  put(".claude/skills/launch/bin/tool", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), 0o755);
  put(".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\nClaude's way.\n");
  put(".agents/skills/deploy/SKILL.md", "---\nname: deploy\n---\nThe shared way.\n");
  put(".codex/skills/deploy/SKILL.md", "---\nname: deploy\n---\nCodex's way.\n");
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = macHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanups.push(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const mac = await build(
    PluginRegistry.layerSessionPlugins.pipe(
      Layer.provideMerge(PluginRegistry.layer),
      Layer.provideMerge(SessionStore.layer),
      Layer.provideMerge(Layer.mergeAll(layerSecretStore, ProjectSecretsLive.layer, ServerSettingsModule.layer)),
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(CloudSyncState, { status: { state: "off", items: [] } }), Layer.succeed(CloudComputer, undefined))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "fidelity-mac-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const macState = Context.get(mac, ServerConfig.ServerConfig).stateDir;
  await enroll({ dir: linkDirOf(macState), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "Test Mac" });

  // import.scan and import.apply, as the Import dialog calls them.
  const imported = await runIn(
    mac,
    Effect.gen(function* () {
      const handlers = yield* makeImportHandlers({ home: macHome, codexOwnHome: Effect.succeed(false), env: {} });
      const ctx = { connectionId: "fidelity" };
      const scanned = yield* handlers["import.scan"]({}, ctx);
      const codex = scanned.sources.find((s) => s.from === "codex")!.items.filter((i) => i.kind === "mcp_server");
      const applied = yield* handlers["import.apply"]({ request_id: "fidelity-1", items: codex.filter((i) => i.action === "import").map(({ from, kind, name }) => ({ from, kind, name })) }, ctx);
      const servers = (yield* (yield* ServerSettingsModule.ServerSettingsService).getSettings).plugins.servers;
      return { codex, applied, servers };
    }),
  );
  const row = (name: string) => imported.codex.find((i) => i.name === name);
  expect(row("argv")).toMatchObject({ action: "import", detail: expect.stringMatching(/^node -e const rl = .* …$/s) });
  expect(row("scoped")).toMatchObject({ action: "skip", reason: "it starts in a folder of its own (cwd), which Caveman Code can't set yet" });
  expect(imported.applied).toEqual({ imported: 4, failed: [] });
  const argv = imported.servers.find((s) => s.name === "argv")!;
  // The argv Codex would give it: as the independent reader has it, where python3 can read TOML.
  const expected = oracleArgs() ?? ["-e", `${SERVER}\n`, "marker", "argv #1"];
  expect(argv.args).toEqual(expected);
  expect(argv.args).toEqual(["-e", `${SERVER}\n`, "marker", "argv #1"]);
  expect(imported.servers.find((s) => s.name === "off")).toMatchObject({ enabled: false });
  expect(imported.servers.some((s) => s.name === "scoped")).toBe(false);

  const side = await runIn(mac, macSync);
  await runIn(mac, side.pushProfile());
  const status = Context.get(mac, CloudSyncState).status;
  expect(status.state).toBe("ok");
  const item = (kind: string, id: string) => status.items.filter((i) => i.kind === kind && i.id === id);
  expect(item("server", "argv")).toEqual([{ kind: "server", id: "argv", cloud: "runs", available: false }]);
  expect(item("server", "loopback")).toEqual([{ kind: "server", id: "loopback", cloud: "mac_only", reason: "it reaches 127.0.0.1, a service on This Mac", available: false }]);
  expect(item("server", "missing")).toEqual([
    { kind: "server", id: "missing", cloud: "needs_runtime", reason: "it runs ./missing-server.js from the folder it starts in, so a Cloud computer needs that file too", available: false },
  ]);
  expect(item("skill", "launch")).toEqual([expect.objectContaining({ cloud: "runs", reason: "left out: bin/tool (a binary file: only text syncs)" })]);
  expect(item("skill", "deploy").map((i) => [i.cloud, i.path!.split(path.sep).slice(-4, -2).join("/")])).toEqual([
    ["runs", ".claude/skills"],
    ["skipped", ".agents/skills"],
    ["skipped", ".codex/skills"],
  ]);
  // What Cloud stored: text only, and the helper's bit as the manifest that names it.
  const stored = cloud.state.parity.profile as { profile: { skills: Array<{ name: string; files: Array<{ path: string; content: string }> }> } };
  const launch = stored.profile.skills.find((s) => s.name === "launch")!;
  expect(launch.files.find((f) => f.path === ".caveman-skill.json")?.content).toBe(JSON.stringify({ executable: ["scripts/check.sh"] }));

  // ---------------------------------------------------------------- the Cloud computer
  const toolsRoot = tempRoot("fidelity-tools-");
  const workspace = makeRepo(toolsRoot, { "README.md": "widgets\n" });
  git(workspace, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const toolsHome = path.join(toolsRoot, "home");
  fs.mkdirSync(toolsHome);
  const socket = path.join(tempRoot("fidelity-sock-"), "tools.sock");
  const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, HOME: toolsHome }, cwd: workspace, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  await until(() => fs.existsSync(socket));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cleanups.push(() => delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS);

  const linkDir = path.join(tempRoot("fidelity-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  cloud.state.parity.computers.add(identity.runtimeId);
  const computer = await build(
    hubLayer.pipe(
      Layer.provideMerge(PluginRegistry.layer),
      Layer.provideMerge(Layer.merge(layerBroker, Layer.effect(ProjectSecrets, makeProjectSecrets))),
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
      Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "fidelity-computer-" }))),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ) as Layer.Layer<any, unknown, never>,
  );
  const computerState = Context.get(computer, ServerConfig.ServerConfig).stateDir;
  await runIn(computer, computerSync);
  await Context.get(computer, CloudSyncState).beforeSession!();
  const pulled = Context.get(computer, CloudSyncState).status;
  expect(pulled.state).toBe("ok");
  expect(pulled.items.find((i) => i.id === "loopback")).toMatchObject({ cloud: "mac_only" });

  // H08: the helper runs as the skill says, from the folder the tools container reads; the data does not.
  const applied = path.join(computerState, "profile-skills", "current", "launch");
  const inTools = (file: string) => spawnSync(process.execPath, [TOOLS_EXEC, "exec", "--socket", socket, "--", file], { encoding: "utf8" });
  expect(inTools(path.join(applied, "scripts", "check.sh"))).toMatchObject({ status: 0, stdout: "skill-ok\n" });
  expect(fs.statSync(path.join(applied, "templates", "hook.sh")).mode & 0o777).toBe(0o644);
  expect(inTools(path.join(applied, "templates", "hook.sh")).stdout).not.toContain("data");
  expect(fs.existsSync(path.join(applied, ".caveman-skill.json"))).toBe(false);
  expect(fs.existsSync(path.join(applied, "bin", "tool"))).toBe(false);
  // H09: the name's one skill on the computer is the one This Mac said would go.
  expect(fs.readFileSync(path.join(computerState, "profile-skills", "current", "deploy", "SKILL.md"), "utf8")).toContain("Claude's way.");

  // H10: the check a person asks for (mcp.tools) on the computer itself.
  const checked = await runIn(
    computer,
    Effect.gen(function* () {
      const hub = yield* McpHub;
      const settled = <A, E>(effect: Effect.Effect<A, E>) => Effect.result(effect);
      const healthy = yield* settled(hub.tools(personalServer("argv")));
      const called = yield* hub.handle({ threadId: ThreadId.make("fidelity-thread"), hooks: false }, "argv", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "argv", arguments: {} } });
      return {
        healthy,
        called,
        missing: yield* settled(hub.tools(personalServer("missing"))),
        loopback: yield* settled(hub.tools(personalServer("loopback"))),
        off: yield* settled(hub.tools(personalServer("off"))),
        measured: { argv: hub.measured(personalServer("argv")), missing: hub.measured(personalServer("missing")) },
      };
    }),
  );
  expect(checked.healthy).toMatchObject({ _tag: "Success", success: [{ name: "argv" }] });
  // The argv it started with on the computer is the one config.toml wrote.
  const said = (checked.called as { result?: { content?: Array<{ text: string }> } }).result?.content?.[0]?.text;
  expect(JSON.parse(said ?? "null")).toEqual(expected);
  expect(checked.missing).toMatchObject({ _tag: "Failure", failure: { reason: "failed", message: expect.stringContaining("missing-server.js") } });
  // A laptop's loopback and a server Codex left off stay off here: nothing to start.
  expect(checked.loopback).toMatchObject({ _tag: "Failure", failure: { reason: "not_found" } });
  expect(checked.off).toMatchObject({ _tag: "Failure", failure: { reason: "not_found" } });
  expect(Option.isSome(checked.measured.argv)).toBe(true);
  expect(Option.isNone(checked.measured.missing)).toBe(true);
}, 180_000);
