// Plugins end to end on a running `node packages/runtime/src/bin.ts` (scratch
// home), driven over Session Protocol v1, with no model call and no login:
//   marketplace.add (a local git repo) -> plugin.install -> credential.grant ->
//   a Claude Agent workspace and a Codex workspace start a turn.
// Claude Agent is scripts/plugins-smoke/fake-claude.mjs and Codex is
// scripts/plugins-smoke/fake-codex.mjs; both record what the runtime sent them.
// The smoke checks the plugin's MCP server reached Claude over stdin
// (mcp_set_servers, never --mcp-config) and Codex in thread/start's
// mcp_servers beside caveman-code, with the granted credential in neither, and then
// starts that server exactly as an engine would to see what it gets.
//
//   node packages/runtime/scripts/plugins-smoke.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { CATALOG_NAME } from "../src/plugins/marketplaces.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const fakeClaude = path.join(here, "plugins-smoke", "fake-claude.mjs");
const fakeCodex = path.join(here, "plugins-smoke", "fake-codex.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-plugins-smoke-"));
const home = path.join(scratch, "home");
const runtimeHome = path.join(scratch, "runtime");
const stateDir = path.join(runtimeHome, "userdata");
const records = path.join(scratch, "records");
for (const dir of [home, stateDir, records]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "settings.json"),
  JSON.stringify({
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } },
      codex: { driver: "codex", config: { binaryPath: fakeCodex } },
    },
  }),
);
const SECRET = "dd-smoke-granted-secret";
const RUNTIME_SECRET = "sk-runtime-env-secret";

const log = (...parts: Array<unknown>) => console.log(`[plugins-smoke ${new Date().toISOString().slice(11, 23)}]`, ...parts);
const fail = (message: string): never => {
  throw new Error(`PLUGINS SMOKE FAILED: ${message}`);
};
const until = async <A>(what: string, check: () => A | undefined | false, ms = 30_000): Promise<A> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd, encoding: "utf8" });
const writeTree = (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
};

// A space: one plugin with a stdio MCP server that needs DD_API_KEY, a skill, a hook and an LSP server.
const spaceWork = path.join(scratch, "ops-kit");
fs.mkdirSync(spaceWork);
git(spaceWork, "init", "-q", "-b", "main");
writeTree(spaceWork, {
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "ops",
    description: "Datadog logs for the on-call",
    contributes: {
      tools: [{ name: "env", server: "dd", description: "What the server sees" }],
      connectors: [{ id: "datadog", title: "Datadog", server: "dd", credentials: ["DD_API_KEY"] }],
    },
  }),
  ".mcp.json": JSON.stringify({
    mcpServers: { dd: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], env: { DD_API_KEY: "${DD_API_KEY}", DD_SITE: "eu" } } },
  }),
  // An MCP server whose one tool returns the environment it runs with.
  "server.mjs": `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "env", version: "1" } } });
  else if (method === "tools/list") send({ id, result: { tools: [{ name: "env", inputSchema: { type: "object" } }] } });
  else if (method === "tools/call") send({ id, result: { content: [{ type: "text", text: JSON.stringify(process.env) }] } });
  else send({ id, error: { code: -32601, message: "unknown" } });
});
`,
  "skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage an alert\n---\nRead the logs first.",
  "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ops" }] }] } }),
  ".lsp.json": JSON.stringify({ yaml: { command: "yaml-language-server", args: ["--stdio"], extensionToLanguage: { ".yaml": "yaml" } } }),
});
git(spaceWork, "add", "-A");
git(spaceWork, "commit", "-qm", "ops kit");
const spaceRepo = path.join(scratch, "ops-kit.git");
git(scratch, "clone", "-q", "--bare", spaceWork, spaceRepo);

const repo = path.join(scratch, "repo");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "smoke\n");
git(repo, "add", ".");
git(repo, "commit", "-qm", "init");

const port = await new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const p = (server.address() as net.AddressInfo).port;
    server.close(() => resolve(p));
  });
});

let runtime: ChildProcess | undefined;
let passed = false;
const readJsonl = (file: string): Array<Record<string, any>> =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CAVEMAN_CODE_HOME: runtimeHome,
    CAVEMAN_CODE_NO_BROWSER: "1",
    PLUGINS_SMOKE_RECORD: records,
    // A secret in the runtime's own environment, which no plugin process may see.
    CAVEMAN_SMOKE_RUNTIME_SECRET: RUNTIME_SECRET,
    GIT_AUTHOR_NAME: "smoke",
    GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "smoke",
    GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  runtime = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  fs.writeFileSync(path.join(scratch, "runtime.pid"), String(runtime.pid));
  log(`runtime pid ${runtime.pid} on port ${port}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 60_000);

  const token = () => fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  const added = await client.call("marketplace.add", { request_id: "ps-add", source: spaceRepo });
  log(`marketplace.add -> ${added.name}`);
  let plugins = (await client.call("plugin.list", { marketplace: added.name })).plugins;
  for (let i = 0; i < 100 && plugins.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    plugins = (await client.call("plugin.list", { marketplace: added.name })).plugins;
  }
  const found = plugins.find((p) => p.name === "ops") ?? fail("plugin.list has no ops plugin");
  await client.call("plugin.install", { request_id: "ps-install", id: found.id, scope: "me" });
  const ops = (await client.call("plugin.list", { marketplace: added.name })).plugins.find((p) => p.name === "ops")!;
  log(
    `plugin.list: ${ops.name} skills=${ops.skills} hooks=${ops.hooks} mcp=${ops.mcp_servers} lsp=${ops.lsp_servers} ` +
      `connectors=${JSON.stringify(ops.connectors)} containment=${ops.containment}`,
  );
  await client.call("credential.grant", { request_id: "ps-grant", marketplace: added.name, name: "DD_API_KEY", value: SECRET });
  const granted = (await client.call("plugin.list", {})).plugins.find((p) => p.name === "ops")!;
  log(`credential.grant DD_API_KEY -> granted=${JSON.stringify(granted.connectors?.[0]?.granted)}`);
  if (JSON.stringify(await client.call("plugin.list", {})).includes(SECRET)) fail("plugin.list returned the credential");
  const refused = await client
    .call("credential.grant", { request_id: "ps-grant-undeclared", marketplace: added.name, name: "AWS_SECRET_ACCESS_KEY", value: "x" })
    .then(() => "ok", (e: { error?: { data?: { reason?: string } } }) => e.error?.data?.reason);
  log(`credential.grant of an undeclared name -> ${refused}`);
  if (refused !== "invalid_params") fail("an undeclared credential was granted");

  // The Caveman catalog ships with the runtime; installing Linear for me asks to connect it.
  const catalog = await client.call("plugin.list", { marketplace: CATALOG_NAME });
  log(`catalog: ${catalog.plugins.length} plugins, featured ${catalog.featured?.slice(0, 3).join(", ")}, categories ${catalog.categories?.join(", ")}`);
  if (catalog.plugins.length < 10 || !catalog.plugins.every((p) => p.interface.display_name)) fail("the Caveman catalog did not load");
  const linear = await client.call("plugin.install", { request_id: "ps-linear", id: `linear@${CATALOG_NAME}`, scope: "me" });
  log(`plugin.install linear@${CATALOG_NAME} -> needs_connect ${JSON.stringify(linear.needs_connect)}`);
  if (linear.needs_connect[0]?.server !== "linear") fail("Linear did not ask to connect");

  // Claude Agent.
  const claudeWs = await client.call("workspace.create", {
    request_id: "ps-claude",
    repo: { path: repo },
    title: "Plugins smoke (Claude Agent)",
    engine: "claude-agent",
    options: { model: "claude-sonnet-4-6" },
    // The composer's skill pill: Claude publishes the plugin's skill as /ops:triage.
    task: { text: "$triage hello from the plugins smoke" },
  });
  log(`workspace.create claude-agent: ${claudeWs.id}`);
  const claudeLog = path.join(records, "claude.jsonl");
  const setFrame = await until("mcp_set_servers at the fake claude", () =>
    readJsonl(claudeLog).find((e) => e.stdin?.request?.subtype === "mcp_set_servers"),
  );
  const setServers = setFrame.stdin.request.servers;
  // The argv of the CLI process that got them (others are version probes).
  const argv: Array<string> = readJsonl(claudeLog).find((e) => e.pid === setFrame.pid && e.argv)!.argv;
  log(`claude argv flags: ${argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]).join(" ")}`);
  log(`claude mcp_set_servers keys: ${Object.keys(setServers).join(", ")}`);
  if (argv.some((a) => a.startsWith("--mcp-config"))) fail("MCP servers went on the claude argv");
  if (!argv.some((a) => a.startsWith("--plugin-dir"))) fail("no plugin dir on the claude argv");
  if (JSON.stringify(argv).includes(SECRET)) fail("the credential is on the claude argv");
  const dd = setServers["ops__dd"] ?? fail("ops__dd is not among Claude's MCP servers");
  const prompt = await until("the first message at the fake claude", () =>
    readJsonl(claudeLog).find((e) => e.pid === setFrame.pid && e.stdin?.type === "user")?.stdin.message.content,
  );
  const lastText = typeof prompt === "string" ? prompt : prompt.filter((b: { type: string }) => b.type === "text").at(-1)?.text;
  log(`claude got the skill pill as: ${JSON.stringify(lastText)}`);
  if (!String(lastText).startsWith("/ops:triage")) fail("the plugin's skill was not dispatched as /ops:triage");
  if (JSON.stringify(readJsonl(claudeLog)).includes(SECRET)) fail("the credential reached the claude CLI");
  const policy = JSON.parse(dd.args[dd.args.findIndex((a: string) => a.endsWith("sandboxLaunch.mjs")) + 1]);
  log(`ops__dd launches: ${dd.command} ... sandboxLaunch.mjs {sandbox: ${policy.sandbox}, deny: ${policy.deny.length} paths, secrets: ${path.relative(stateDir, policy.secrets)}} node server.mjs`);
  log(`credential file mode ${(fs.statSync(policy.secrets).mode & 0o777).toString(8)}`);

  // Start that server as an engine would: the whole runtime environment plus the config's env.
  const transport = new StdioClientTransport({
    command: dd.command,
    args: dd.args,
    env: { ...(env as Record<string, string>), ...dd.env },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "engine", version: "1" });
  await mcp.connect(transport);
  const seen = JSON.parse(((await mcp.callTool({ name: "env", arguments: {} })).content as Array<{ text: string }>)[0]!.text);
  await mcp.close();
  log(`the plugin server sees: DD_API_KEY=${seen.DD_API_KEY === SECRET ? "<granted value>" : seen.DD_API_KEY} DD_SITE=${seen.DD_SITE} CAVEMAN_SMOKE_RUNTIME_SECRET=${seen.CAVEMAN_SMOKE_RUNTIME_SECRET ?? "unset"} env names=${Object.keys(seen).sort().join(",")}`);
  if (seen.DD_API_KEY !== SECRET || JSON.stringify(seen).includes(RUNTIME_SECRET)) fail("the server's environment is wrong");

  // Codex.
  const codexWs = await client.call("workspace.create", {
    request_id: "ps-codex",
    repo: { path: repo },
    title: "Plugins smoke (Codex)",
    engine: "codex",
    options: { model: "gpt-5-nano" },
    task: { text: "hello from the plugins smoke" },
  });
  log(`workspace.create codex: ${codexWs.id}`);
  const codexLog = path.join(records, "codex.jsonl");
  const threadStart = await until(
    "thread/start at the fake codex",
    () => readJsonl(codexLog).find((e) => e.stdin?.method === "thread/start")?.stdin.params,
    60_000,
  );
  const servers = threadStart.config?.mcp_servers ?? {};
  log(`codex thread/start mcp_servers: ${Object.keys(servers).join(", ")}`);
  // Linear signs in through the runtime's hub: never its own URL in an engine's config.
  if (JSON.stringify(servers).includes("mcp.linear.app")) fail("Linear's URL reached Codex directly");
  if (!("ops__dd" in servers)) fail("ops__dd is not in Codex's thread config");
  if (!("caveman-code" in servers)) fail("the runtime's caveman-code server is gone from Codex's thread config");
  if (JSON.stringify(readJsonl(codexLog)).includes(SECRET)) fail("the credential reached codex");
  log(`codex developerInstructions mention the skill: ${String(threadStart.developerInstructions ?? "").includes("triage")}`);

  await client.call("credential.revoke", { request_id: "ps-revoke", marketplace: added.name, name: "DD_API_KEY" });
  log(`credential.revoke -> credential file gone: ${!fs.existsSync(policy.secrets)}`);
  log("PLUGINS SMOKE PASSED");
  client.close();
  passed = true;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (runtime?.pid !== undefined) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
    log(`runtime pid ${runtime.pid} stopped`);
  }
  // A failed run keeps its scratch dir (records, runtime state) for a look.
  if (passed) fs.rmSync(scratch, { recursive: true, force: true });
}
