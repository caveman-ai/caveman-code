// Actions smoke (docs/computer-config.md "Actions") against a real `node packages/runtime/src/bin.ts`
// in a scratch home, with real terminals: a repo with [run], .caveman/actions.toml and package.json
// scripts, one chat in it on Claude Agent's stand-in CLI (scripts/smoke-claude.mjs, no login read),
// then actions.list, a personal action saved and read back, and commands run in terminals whose
// term.exit carries the command's own exit code. Nothing leaves the machine.
//
//   node packages/runtime/scripts/actions-smoke.ts [--port <runtime>] [--keep]
//
// --keep leaves the runtime and the chat up (for the web app: VITE_RUNTIME_URL, VITE_RUNTIME_TOKEN)
// until SIGTERM or a `stop` file in the scratch dir.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const fakeClaude = path.join(here, "smoke-claude.mjs");
const keep = process.argv.includes("--keep");
const portArg = process.argv.indexOf("--port");
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
const port = portArg < 0 ? await freePort() : Number(process.argv[portArg + 1]);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-actions-smoke-"));
const home = path.join(scratch, "home");
const stateDir = path.join(scratch, "runtime", "userdata");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(stateDir, "secrets"), { recursive: true, mode: 0o700 });
fs.chmodSync(fakeClaude, 0o755);
fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } } } }));

const failures: string[] = [];
const log = (line: string) => console.log(`[actions-smoke] ${line}`);
const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const until = async (what: string, ok: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// The repo: the team's actions, a dev server's [run], and a script no action runs yet.
const repo = path.join(scratch, "shop");
fs.mkdirSync(path.join(repo, ".caveman"), { recursive: true });
const files: Record<string, string> = {
  ".caveman/computer.toml": `[run]\ncommand = "node -e \\"require('http').createServer((q, s) => s.end('shop')).listen(process.env.CAVEMAN_PORT_WEB, () => console.log('ready on ' + process.env.CAVEMAN_PORT_WEB))\\""\nports = ["web"]\n`,
  ".caveman/actions.toml": [
    `[test]\ncommand = "node -e \\"console.log('12 passed'); process.exit(0)\\""\nicon = "test"\n`,
    `[typecheck]\ncommand = "node -e \\"console.error('src/cart.ts:41 TS2322'); process.exit(2)\\""\nicon = "lint"\n`,
    `[build]\ncommand = "sleep 600"\n`,
  ].join("\n"),
  "package.json": JSON.stringify({ name: "shop", scripts: { dev: "vite", lint: "eslint .", "db:migrate": "drizzle-kit migrate", postinstall: "true" } }, null, 2),
  "pnpm-lock.yaml": "",
  "README.md": "shop\n",
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid" } });
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-qm", "init");

let runtime: ChildProcess | undefined;
let output = "";
try {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CAVEMAN_CODE_HOME: path.join(scratch, "runtime"), CAVEMAN_CODE_NO_BROWSER: "1", SHELL: "/bin/zsh" };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CAVEMAN_PROXY_BIN", "CAVEMAN_MCP_BIN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[name];
  runtime = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["pipe", "pipe", "pipe"] });
  fs.writeFileSync(path.join(scratch, "runtime.pid"), String(runtime.pid));
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  log(`runtime pid ${runtime.pid} on 127.0.0.1:${port}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 120_000);
  const token = fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  const created = await client.call("workspace.create", { request_id: "w1", repo: { path: repo }, title: "Fix the cart total", engine: "claude-agent", options: { model: "claude-sonnet-4-6" } });
  let w = await client.call("workspace.get", { workspace_id: created.id });
  for (let i = 0; i < 200 && !w.root_path; i++) {
    await new Promise((r) => setTimeout(r, 100));
    w = await client.call("workspace.get", { workspace_id: created.id });
  }
  await client.attach(w.session_id, 0, () => {});

  const listed = await client.call("actions.list", { workspace_id: w.id });
  check(listed.actions.map((a) => `${a.source}:${a.id}`).join(" ") === "run:run repo:test repo:typecheck repo:build", `actions.list: [run], then actions.toml in order (${listed.actions.map((a) => a.id).join(", ")})`);
  check(JSON.stringify(listed.suggestions) === JSON.stringify([{ name: "dev", command: "pnpm run dev" }, { name: "lint", command: "pnpm run lint" }, { name: "db:migrate", command: "pnpm run db:migrate" }]), `package.json's scripts suggested with pnpm, lifecycle left out (${listed.suggestions.map((s) => s.name).join(", ")})`);

  const saved = await client.call("project.update", { request_id: "p1", project_id: w.project_id!, actions: [{ id: "lint", name: "lint", command: "pnpm run lint", icon: "lint" }] });
  check(saved.actions?.[0]?.id === "lint", "a personal action is saved with the project");
  const again = await client.call("actions.list", { workspace_id: w.id });
  check(again.actions.at(-1)?.source === "personal" && !again.suggestions.some((s) => s.name === "lint"), "it lists as the person's own and stops being suggested");

  // Real terminals: each ends with its command and says the command's exit code.
  const exits = new Map<string, number | null>();
  const signals = new Map<string, string>();
  client.on("term.exit", (p) => {
    if (p.signal) signals.set(p.terminal_id, p.signal);
    exits.set(p.terminal_id, p.exit_code);
  });
  // A request id per run: the runtime answers a repeated one with the first run's terminal.
  let runs = 0;
  const runOf = async (command: string) => (await client.call("term.open", { request_id: `run-${++runs}`, workspace_id: w.id, cols: 100, rows: 30, command })).terminal_id;
  const pass = await runOf(listed.actions.find((a) => a.id === "test")!.command);
  const fail = await runOf(listed.actions.find((a) => a.id === "typecheck")!.command);
  const exit3 = await runOf("echo about to fail; exit 3");
  await until("the three runs to end", () => exits.has(pass) && exits.has(fail) && exits.has(exit3));
  check(exits.get(pass) === 0, `a passing command exits 0 (${exits.get(pass)})`);
  check(exits.get(fail) === 2, `a failing command's own code reaches term.exit (${exits.get(fail)})`);
  check(exits.get(exit3) === 3, `exit inside the command is its code (${exits.get(exit3)})`);
  const terms = (await client.call("term.list", { workspace_id: w.id })).terminals;
  const failed = terms.find((t) => t.terminal_id === fail);
  check(failed?.exited === true && failed.exit_code === 2 && typeof failed.exited_at === "string" && Date.parse(failed.exited_at) >= Date.parse(failed.created_at), "term.list keeps the code and when it ended");
  const scrollback = (await client.call("term.attach", { terminal_id: fail })).scrollback;
  check(scrollback.includes("src/cart.ts:41 TS2322") && !scrollback.includes("__T3_SETUP_DONE__") && !scrollback.includes("printf"), "the output is the command's, with no wrapper echoed");
  await client.call("term.detach", { terminal_id: fail });

  // Stop: Ctrl-C ends a long run, and its terminal with it.
  const long = await runOf("sleep 600");
  await new Promise((r) => setTimeout(r, 1500));
  await client.call("term.write", { request_id: "stop-1", terminal_id: long, data: "\u0003" });
  await until("Ctrl-C to end the long run", () => exits.has(long), 15_000);
  const stoppedRun = (await client.call("term.list", { workspace_id: w.id })).terminals.find((t) => t.terminal_id === long);
  check(signals.has(long) && stoppedRun?.signal === signals.get(long), `Ctrl-C stops it, and term.list says by which signal (${signals.get(long)}, code ${exits.get(long)})`);
  for (const id of [pass, fail, exit3, long]) await client.call("term.close", { request_id: `c-${id}`, terminal_id: id }).catch(() => undefined);

  if (keep) {
    // A first run of each, as a person would have left them, for the web app to show.
    await runOf(listed.actions.find((a) => a.id === "test")!.command);
    await runOf(listed.actions.find((a) => a.id === "typecheck")!.command);
    log(`KEEP VITE_RUNTIME_URL=ws://127.0.0.1:${port}/session/v1 VITE_RUNTIME_TOKEN=${token} workspace ${w.id}; touch ${path.join(scratch, "stop")} to end`);
    client.close();
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
      const timer = setInterval(() => fs.existsSync(path.join(scratch, "stop")) && (clearInterval(timer), resolve()), 500);
    });
  } else client.close();
} catch (error) {
  failures.push(String(error));
  log(String(error));
  log(`runtime output tail:\n${output.split("\n").slice(-40).join("\n")}`);
} finally {
  if (runtime && runtime.exitCode === null) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
  }
  fs.writeFileSync(path.join(scratch, "runtime.log"), output);
  log(failures.length === 0 ? "all checks passed" : `${failures.length} failed: ${failures.join("; ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}
