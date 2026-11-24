// Smoke test against a running `node packages/runtime/src/bin.ts`: starts the
// runtime in a scratch home, drives Session Protocol v1 with the bundled
// client over a TCP hop it can cut, and restarts the runtime. The engine is
// Claude Agent pointed at scripts/smoke-claude.mjs (a deterministic stand-in
// for the claude CLI), so no model is called and no login is read.
//
// The browser part runs upstream headless shell; a copy installed by the browser
// test (CAVEMAN_TEST_BROWSER_HOME) is linked in, else the runtime downloads it.
//
//   node packages/runtime/scripts/smoke.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const fakeClaude = path.join(here, "smoke-claude.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-smoke-"));
const home = path.join(scratch, "home");
const runtimeHome = path.join(scratch, "runtime");
const stateDir = path.join(runtimeHome, "userdata");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.chmodSync(fakeClaude, 0o755);
fs.writeFileSync(
  path.join(stateDir, "settings.json"),
  JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } } } }),
);
const browserShells = path.join(process.env.CAVEMAN_TEST_BROWSER_HOME ?? path.join(os.tmpdir(), "caveman-runtime-test-browser"), "tools", "chrome-headless-shell");
if (fs.existsSync(browserShells)) {
  fs.mkdirSync(path.join(runtimeHome, "tools"), { recursive: true });
  fs.symlinkSync(browserShells, path.join(runtimeHome, "tools", "chrome-headless-shell"));
}
const repo = path.join(scratch, "repo");
fs.mkdirSync(repo);
const git = (...args: Array<string>) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "smoke\n");
fs.mkdirSync(path.join(repo, ".caveman"));
fs.writeFileSync(path.join(repo, ".caveman", "computer.toml"), '[run]\nports = ["web"]\n\n[env]\nSMOKE_ENV = "from-computer-toml"\n');
git("add", ".");
git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init");

const log = (...parts: Array<unknown>) => console.log(`[smoke ${new Date().toISOString().slice(11, 23)}]`, ...parts);
const fail = (message: string): never => {
  throw new Error(`SMOKE FAILED: ${message}`);
};
const until = async (what: string, check: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
const port = await freePort();

let runtime: ChildProcess | undefined;
async function startRuntime() {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), CAVEMAN_CODE_HOME: runtimeHome, CAVEMAN_CODE_NO_BROWSER: "1", GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid" };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const child = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["pipe", "pipe", "pipe"] });
  runtime = child;
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  fs.writeFileSync(path.join(scratch, `runtime-${child.pid}.pid`), String(child.pid));
  log(`runtime pid ${child.pid}: node ${path.relative(process.cwd(), bin)} --port ${port}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 60_000);
  log(output.split("\n").find((l) => l.includes("Session Protocol v1")) ?? "(no route line)");
  return child;
}
async function stopRuntime(child: ChildProcess) {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
  log(`runtime pid ${child.pid} stopped`);
}

// A TCP hop the smoke can cut, as a network drop would.
const sockets = new Set<net.Socket>();
const hop = net.createServer((inbound) => {
  const outbound = net.connect(port, "127.0.0.1");
  for (const s of [inbound, outbound]) {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
  }
  inbound.pipe(outbound).pipe(inbound);
});
const hopPort = await new Promise<number>((resolve) => hop.listen(0, "127.0.0.1", () => resolve((hop.address() as net.AddressInfo).port)));

const tokenFile = path.join(stateDir, "session-protocol.token");
const token = () => fs.readFileSync(tokenFile, "utf8");
try {
  let child = await startRuntime();
  log(`token file ${path.relative(scratch, tokenFile)} mode ${(fs.statSync(tokenFile).mode & 0o777).toString(8)}`);
  for (const route of ["/", "/session/v1", "/api/no-such-route"]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    const csp = response.headers.get("content-security-policy");
    const xfo = response.headers.get("x-frame-options");
    log(`GET ${route} -> ${response.status}; content-security-policy: ${csp}; x-frame-options: ${xfo}`);
    if (csp !== "frame-ancestors 'none'" || xfo !== "DENY") fail(`${route} may load in a frame`);
  }
  const states: Array<string> = [];
  const client = connect(`ws://127.0.0.1:${hopPort}/session/v1`, token, (state) => states.push(state));

  const { engines } = await client.call("engine.list", {});
  const claude = engines.find((e) => e.id === "claude-agent") ?? fail("no claude-agent engine");
  log(`engine.list: ${engines.map((e) => `${e.id} "${e.label}" auth=${e.auth.state} version=${e.version ?? "?"}${e.access_modes ? ` access=${e.access_modes}` : ""}`).join("; ")}`);
  log(`claude-agent models: ${claude.models.map((m) => `${m.id}${m.efforts.length ? ` [${m.efforts.join("|")}${m.default_effort ? ` default ${m.default_effort}` : ""}]` : ""}${m.legacy ? " legacy" : ""}`).join(", ") || "(none yet)"}`);
  // An engine without approvals cannot ask: asking for it is refused, never silently run with full access.
  const reasonOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason);
  const caveman = engines.find((e) => e.id === "caveman");
  if (caveman) {
    const refused = await reasonOf(client.call("workspace.create", { request_id: "smoke-ask", repo: { path: repo }, engine: "caveman", options: { access: "ask" } }));
    log(`workspace.create caveman access=ask -> ${refused}`);
    if (caveman.access_modes?.join() !== "full" || refused !== "unsupported") fail("caveman accepted an access mode it cannot honour");
  }
  const bogus = await reasonOf(client.call("workspace.create", { request_id: "smoke-bogus", repo: { path: repo }, engine: "claude-agent", options: { model: "claude-sonnet-4-6", effort: "bogus" } }));
  log(`workspace.create effort=bogus -> ${bogus}`);
  if (bogus !== "invalid_params") fail("an unknown effort was accepted");

  const workspace = await client.call("workspace.create", {
    request_id: "smoke-create",
    repo: { path: repo },
    title: "Smoke",
    engine: "claude-agent",
    options: { model: "claude-sonnet-4-6" },
  });
  log(`workspace.create: ${workspace.id} branch=${workspace.branch} base_ref=${workspace.base_ref} status=${workspace.status}`);

  const seen: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => {
    seen.push(event);
    log(`  event #${event.cursor} ${event.type} ${JSON.stringify(event.payload).slice(0, 90)}`);
  });
  const submitted = await client.call("turn.submit", {
    request_id: "smoke-turn-1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "slow: hello from the smoke" },
  });
  log(`turn.submit: ${JSON.stringify(submitted)}`);
  await until("the assistant message", () => seen.some((e) => e.type === "message.done" && e.payload.role === "assistant"));
  if (seen.some((e) => e.type === "turn.done")) fail("the turn ended before the drop");
  log(`dropping the socket mid-turn at cursor ${seen.at(-1)?.cursor}`);
  for (const s of sockets) s.destroy();
  await until("turn.done after the reconnect", () => seen.some((e) => e.type === "turn.done"));
  const cursors = seen.map((e) => e.cursor);
  if (cursors.some((c, i) => c !== i + 1)) fail(`cursors not gap-free: ${cursors}`);
  log(`reconnected (${states.filter((s) => s === "open").length} opens); ${seen.length} events, cursors 1..${seen.length}, none lost or repeated`);

  const again = await client.call("turn.submit", {
    request_id: "smoke-turn-1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "slow: hello from the smoke" },
  });
  if (JSON.stringify(again) !== JSON.stringify(submitted)) fail("request_id replay returned a different result");
  const conflict = await client
    .call("turn.submit", { request_id: "smoke-turn-1", session_id: workspace.session_id, kind: "followup", input: { text: "different" } })
    .then(() => "accepted", (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason);
  log(`request_id replay: same result ${JSON.stringify(again)}; different params -> ${conflict}`);
  const turns = seen.filter((e) => e.type === "turn.started").length;
  if (turns !== 1) fail(`expected one turn, saw ${turns}`);

  const spend = await client.call("spend.summary", { group_by: "engine" });
  log(`spend.summary: ${JSON.stringify(spend.rows)}`);
  client.close();
  const head = seen.length;
  await stopRuntime(child);

  child = await startRuntime();
  const reopened = connect(`ws://127.0.0.1:${port}/session/v1`, token);
  const replayed: Array<SessionEvent> = [];
  const { session } = await reopened.attach(workspace.session_id, 0, (event) => replayed.push(event));
  await until("the journal after the restart", () => replayed.length >= head);
  await new Promise((r) => setTimeout(r, 500));
  if (JSON.stringify(replayed) !== JSON.stringify(seen)) fail("the journal changed across the restart");
  log(`restart: session.head=${session.head}; reattached from 0 and got the same ${replayed.length} events`);
  const tail: Array<SessionEvent> = [];
  await reopened.attach(workspace.session_id, head - 1, (event) => tail.push(event));
  await until("the tail", () => tail.length >= 1);
  log(`reattach from cursor ${head - 1}: got ${tail.map((e) => `#${e.cursor} ${e.type}`).join(", ")}`);
  const replayAfterRestart = await reopened.call("turn.submit", {
    request_id: "smoke-turn-1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "slow: hello from the smoke" },
  });
  log(`request_id replay after restart: ${JSON.stringify(replayAfterRestart)}`);
  // The second turn picks an effort when the model offers one (Claude's effort option).
  const effort = (await reopened.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")?.models.find((m) => m.id === "claude-sonnet-4-6")?.efforts[0];
  const second = await reopened.call("turn.submit", {
    request_id: "smoke-turn-2",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "and again after the restart" },
    ...(effort ? { options: { effort } } : {}),
  });
  log(`turn.submit with effort ${effort ?? "(model offers none)"}`);
  const after: Array<SessionEvent> = [];
  await reopened.attach(workspace.session_id, head, (event) => after.push(event));
  await until("the second turn", () => after.some((e) => e.type === "turn.done"));
  log(`second turn after the restart: ${JSON.stringify(second)} -> ${after.map((e) => `#${e.cursor} ${e.type}`).join(", ")}`);
  // Engine tool processes get the workspace's ports and computer.toml [env].
  await reopened.call("turn.submit", { request_id: "smoke-env", session_id: workspace.session_id, kind: "followup", input: { text: "env?" } });
  await until("the env turn", () => after.filter((e) => e.type === "turn.done").length >= 2);
  const envReply = after.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [])).at(-1) ?? "";
  // Its Bash commands get the workspace env (CLAUDE_ENV_FILE); the CLI gets neither it nor the runtime's own.
  if (envReply !== `smoke ok: port=${workspace.ports?.web} env=from-computer-toml cli=unset runtime=unset`) fail(`the engine did not get the workspace env: ${envReply}`);
  log(`engine env: ${envReply}`);
  // No Caveman key in this scratch home: the honest answer is engine_unavailable, never a fake.
  const assistantItem = after.find((e) => e.type === "message.done" && e.payload.role === "assistant")?.item_id;
  const version = await reopened
    .call("message.caveman_version", { session_id: workspace.session_id, item_id: assistantItem! })
    .then((r) => `text ${JSON.stringify(r.text)}`, (error: { error?: { data?: { reason?: string }; message?: string } }) => `${error.error?.data?.reason}: ${error.error?.message}`);
  if (!version.startsWith("engine_unavailable")) fail(`message.caveman_version without a key: ${version}`);
  log(`message.caveman_version: ${version}`);
  const status = await reopened.call("git.status", { workspace_id: workspace.id });
  log(`git.status: branch=${status.branch} base_ref=${status.base_ref} files=${status.files.length}`);

 // A command terminal in the workspace (node-pty through upstream terminal manager).
  let output = "";
  let exit: unknown;
  reopened.on("term.output", ({ data }) => (output += data));
  reopened.on("term.exit", (event) => (exit = event));
  const { terminal_id } = await reopened.call("term.open", {
    request_id: "smoke-term",
    workspace_id: workspace.id,
    cols: 100,
    rows: 30,
    command: "echo smoke-term $(pwd | xargs basename) > term.txt; cat term.txt; exit",
  });
  await until("terminal output", () => /^smoke-term \S+/m.test(output), 30_000);
  await until("terminal exit", () => exit !== undefined, 30_000);
  log(`term.open ${terminal_id}: printed ${JSON.stringify(output.split(/\r?\n/).filter((line) => line.startsWith("smoke-term")))}, exit ${JSON.stringify(exit)}`);
  const listed = await reopened.call("term.list", { workspace_id: workspace.id });
  const attached = await reopened.call("term.attach", { terminal_id });
  log(`term.list: ${JSON.stringify(listed.terminals.map((t) => ({ id: t.terminal_id, exited: t.exited, exit_code: t.exit_code })))}; term.attach scrollback has smoke-term: ${attached.scrollback.includes("smoke-term")}`);
  const diff = await reopened.call("fs.diff", { workspace_id: workspace.id });
  log(`fs.diff: ${diff.files.map((f) => `${f.path} ${f.status} +${f.additions}`).join(", ")}`);

 // The workspace's browser: upstream headless shell, driven over Session Protocol.
  const site = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Smoke page</title><button onclick="document.title='Pressed'" style="position:fixed;inset:0">Press</button>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const pageUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}/`;
  const browserStates: Array<{ url: string; title: string; loading: boolean; controller: string }> = [];
  const browserFrames: Array<{ width: number; height: number; data: string }> = [];
  reopened.on("browser.state", (state) => browserStates.push(state));
  reopened.on("browser.frame", (frame) => browserFrames.push(frame));
  await reopened.call("browser.screencast", { workspace_id: workspace.id, enabled: true });
  await until("the first browser state and frame", () => browserStates.length > 0 && browserFrames.length > 0, 300_000);
  log(`browser.screencast: state ${JSON.stringify(browserStates[0])}; frame ${browserFrames[0]!.width}x${browserFrames[0]!.height} jpeg ${Buffer.from(browserFrames[0]!.data, "base64").length} bytes`);
  await reopened.call("browser.navigate", { request_id: "smoke-nav", workspace_id: workspace.id, url: pageUrl });
  await until("the page to load", () => browserStates.some((s) => s.title === "Smoke page" && !s.loading));
  log(`browser.navigate: ${JSON.stringify(browserStates.at(-1))}`);
  const lastFrame = browserFrames.at(-1)!;
  const center = { x: lastFrame.width / 2, y: lastFrame.height / 2, modifiers: 0 };
  await reopened.call("browser.input", {
    request_id: "smoke-click",
    workspace_id: workspace.id,
    events: [{ type: "pointer", action: "down", button: "left", ...center }, { type: "pointer", action: "up", button: "left", ...center }],
  });
  let shot = await reopened.call("browser.snapshot", { workspace_id: workspace.id });
  for (let i = 0; i < 50 && shot.title !== "Pressed"; i++) shot = await reopened.call("browser.snapshot", { workspace_id: workspace.id });
  if (shot.title !== "Pressed") fail(`the click did not land: title ${shot.title}`);
  log(`browser.input click at ${center.x},${center.y} -> browser.snapshot title "${shot.title}", ${shot.image.mime_type} ${Buffer.from(shot.image.data, "base64").length} bytes, refs ${JSON.stringify(shot.refs.split("\n").find((l) => l.includes("button")))}`);
  const handed = await reopened.call("browser.control", { request_id: "smoke-handback", workspace_id: workspace.id, controller: "agent" });
  log(`browser.control agent: ${JSON.stringify(handed)}`);
  await reopened.call("browser.screencast", { workspace_id: workspace.id, enabled: false });
  site.close();
  reopened.close();
  await stopRuntime(child);
  log("SMOKE PASSED");
} catch (error) {
  console.error(error);
  if (runtime && runtime.exitCode === null) await stopRuntime(runtime);
  process.exitCode = 1;
} finally {
  hop.close();
  if (!process.env.SMOKE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
}
