// The default engine and the full harness, live, on a real `node packages/runtime/src/bin.ts` in a scratch home: one
// credential is the only thing connected, a chat is created with no engine named, and two turns of a small bug fix
// run on it. `--via endpoint` connects an OpenAI-compatible endpoint of the person's own (Chat Completions, no model
// named either); `--via credits` holds the key as Caveman credits with CAVEMAN_CREDITS_GATEWAY_URL at the relay
// (the gateway's routes: OpenAI models on the Responses API) and New chats' model set to `caveman/openai/<model>`. A recording relay in front of the endpoint
// keeps every request body (never its authorization header), so the evidence shows what the engine sent: the tools it
// declared, the then_run and edits[] calls it made, and whether turn 2's first request continues turn 1's last one
// byte for byte. Claude Agent is scripts/smoke-claude.mjs, so no login is read; the key is read from a file and only
// ever goes to the endpoint.
//
//   node packages/runtime/scripts/engine-default-live.ts --base-url <OpenAI-compatible /v1> --key-file <file>
//     --model <id> --engine-bin <caveman-engine> --out <dir> [--via endpoint|credits]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const need = (name: string) => arg(name) ?? (console.error(`missing ${name}`), process.exit(2));
const upstream = need("--base-url").replace(/\/+$/, "");
const key = fs.readFileSync(need("--key-file"), "utf8").trim();
const modelId = need("--model");
const engineBin = path.resolve(need("--engine-bin"));
const out = path.resolve(need("--out"));
const via = arg("--via") ?? "endpoint";
fs.mkdirSync(out, { recursive: true });

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
const log = (...parts: Array<unknown>) => console.log(`[engine-default-live ${new Date().toISOString().slice(11, 23)}]`, ...parts);
const until = async (what: string, test: () => boolean | Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

// ------------------------------------------------------------ the recording relay

const requestsFile = path.join(out, "requests.jsonl");
let seq = 0;
const relayPort = await freePort();
const relay = http.createServer(async (req, res) => {
  const chunks: Array<Buffer> = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const n = ++seq;
  const at = new Date().toISOString();
  const headers: Record<string, string> = {};
  for (const [h, v] of Object.entries(req.headers)) if (typeof v === "string" && h !== "host" && h !== "content-length" && h !== "connection") headers[h] = v;
  // The body as sent, never the authorization header.
  fs.appendFileSync(requestsFile, JSON.stringify({ n, at, method: req.method, path: req.url, sha256: createHash("sha256").update(body).digest("hex"), body: body.toString("utf8") }) + "\n");
  try {
    const up = await fetch(upstream + (req.url ?? "").replace(/^\/v1/, ""), { method: req.method ?? "POST", headers, ...(body.length > 0 ? { body } : {}) });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    if (up.body) for await (const c of up.body) res.write(c);
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise<void>((r) => relay.listen(relayPort, "127.0.0.1", r));
log(`relay on 127.0.0.1:${relayPort} -> ${upstream}`);

// ------------------------------------------------------------ scratch home and repository

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-engine-default-live-"));
const home = path.join(scratch, "home");
const runtimeHome = path.join(scratch, "runtime");
const stateDir = path.join(runtimeHome, "userdata");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(stateDir, "secrets"), { recursive: true, mode: 0o700 });
fs.chmodSync(fakeClaude, 0o755);
fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } } } }));

if (via === "credits") {
  // Caveman credits as a runtime that turned them on holds them (written unsealed; the runtime seals it on first read).
  const slot = createHash("sha256").update(`${"caveman".length}:cavemancaveman`).digest("hex");
  fs.writeFileSync(path.join(stateDir, "secrets", `provider-auth-${slot}.bin`), JSON.stringify({ version: 2, providers: { caveman: { key } } }), { mode: 0o600 });
}

const repo = path.join(scratch, "slugs");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "test"));
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "slugs", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
fs.writeFileSync(
  path.join(repo, "src", "slug.js"),
  `// Turns a title into a URL slug.
export function slugify(title) {
  return title.toLowerCase().replace(/ /g, "-");
}

// The slug of each title, numbered when two titles give the same slug.
export function uniqueSlugs(titles) {
  const seen = new Map();
  return titles.map((title) => {
    const slug = slugify(title);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : \`\${slug}-\${count}\`;
  });
}
`,
);
fs.writeFileSync(
  path.join(repo, "test", "slug.test.js"),
  `import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify, uniqueSlugs } from "../src/slug.js";

test("slugify keeps letters and digits, joined by single dashes", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Release 2.0  notes "), "release-2-0-notes");
});

test("uniqueSlugs numbers repeats", () => {
  assert.deepEqual(uniqueSlugs(["A b", "a  B", "c"]), ["a-b", "a-b-1", "c"]);
});
`,
);
const git = (...args: Array<string>) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("add", ".");
git("-c", "user.name=live", "-c", "user.email=live@example.invalid", "commit", "-qm", "slugs");

// ------------------------------------------------------------------- runtime

const port = await freePort();
let runtime: ChildProcess | undefined;
const runtimeLog = fs.createWriteStream(path.join(out, "runtime.log"));
let output = "";
const events: Array<SessionEvent> = [];
const summary: Record<string, unknown> = { scratch, relay: `127.0.0.1:${relayPort}`, model: modelId };
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CAVEMAN_CODE_HOME: runtimeHome,
    CAVEMAN_CODE_NO_BROWSER: "1",
    // The app's pinned caveman-engine, as the packaged app carries it in runtime/bin.
    CAVEMAN_ENGINE_BIN: engineBin,
    ...(via === "credits" ? { CAVEMAN_CREDITS_GATEWAY_URL: `http://127.0.0.1:${relayPort}` } : {}),
    GIT_AUTHOR_NAME: "live",
    GIT_AUTHOR_EMAIL: "live@example.invalid",
    GIT_COMMITTER_NAME: "live",
    GIT_COMMITTER_EMAIL: "live@example.invalid",
  };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CAVEMAN_PROXY_BIN", "CAVEMAN_MCP_BIN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NODE_ENV", "CAVEMAN_ENGINE_REQUIRED"]) delete env[name];
  runtime = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["pipe", "pipe", "pipe"] });
  fs.writeFileSync(path.join(out, "runtime.pid"), String(runtime.pid));
  for (const stream of [runtime.stdout!, runtime.stderr!]) stream.on("data", (chunk) => {
    output += chunk;
    runtimeLog.write(chunk);
  });
  log(`runtime pid ${runtime.pid} on 127.0.0.1:${port}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 120_000);
  const token = () => fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  const engineSettings = () => client.call("settings.get", {}).then((s) => ({ default_engine: s.default_engine, default_engine_chosen: s.default_engine_chosen, caveman_model: s.engines.caveman?.model }));
  if (via === "credits") {
    // Credits were held from the start: the Caveman engine could already run, so it was already the default.
    summary.settings_before = await engineSettings();
    // Settings > General > New chats: the model a Caveman-engine chat starts on (the default engine is not touched).
    await client.call("settings.set", { request_id: "s1", settings: { engines: { caveman: { model: `caveman/openai/${modelId}` } } } });
  } else {
    summary.settings_before = await engineSettings();
    const added = await client.call("engine.account.add", {
      request_id: "a1",
      engine: "caveman",
      provider: "custom-bench",
      key,
      endpoint: { name: "Bench proxy", base_url: `http://127.0.0.1:${relayPort}/v1`, models: [modelId] },
    });
    summary.key_test = added.test;
  }
  summary.settings_after = await engineSettings();
  log(`connected via ${via}; settings ${JSON.stringify(summary.settings_after)}`);

  // A new chat as New chat makes it: no engine and no model named, so the runtime's defaults decide.
  const ws = await client.call("workspace.create", { request_id: "w1", repo: { path: repo }, title: "Fix slugify" });
  summary.workspace = { id: ws.id, engine: ws.engine, session_id: ws.session_id };
  log(`chat ${ws.id} on ${ws.engine}`);
  await client.attach(ws.session_id, 0, (e) => {
    events.push(e);
    fs.appendFileSync(path.join(out, "events.jsonl"), JSON.stringify(e) + "\n");
  });
  const turns = [
    "The tests in test/slug.test.js fail. Fix the bug in src/slug.js and run the tests (`node --test`).",
    "Now make uniqueSlugs give a title with no letters or digits the slug `untitled` (numbered like any other repeat), add a test for it to test/slug.test.js, and run the tests again.",
  ];
  for (const [i, text] of turns.entries()) {
    const done = events.filter((e) => e.type === "turn.done").length;
    const startedAt = seq;
    await client.call("turn.submit", { request_id: `t${i + 1}`, session_id: ws.session_id, kind: "followup", input: { text } });
    await until(`turn ${i + 1}`, () => events.filter((e) => e.type === "turn.done").length > done, 15 * 60_000);
    const doneEvent = events.filter((e) => e.type === "turn.done").at(-1)!;
    summary[`turn${i + 1}`] = { status: (doneEvent.payload as { status: string }).status, first_request: startedAt + 1, last_request: seq };
    log(`turn ${i + 1}: ${JSON.stringify(summary[`turn${i + 1}`])}`);
  }
  // The chat worked in a worktree of its own: its tests run there.
  const worktree = (events.find((e) => e.type === "tool.started" && (e.payload as { name: string }).name === "worktree")?.payload as { input?: { path?: string } } | undefined)?.input?.path ?? repo;
  summary.tests_after = (() => {
    try {
      return { ok: true, cwd: worktree, output: execFileSync(process.execPath, ["--test"], { cwd: worktree, encoding: "utf8" }).slice(-400) };
    } catch (error) {
      return { ok: false, output: String((error as { stdout?: string }).stdout ?? error).slice(-400) };
    }
  })();
  client.close();
} finally {
  if (runtime && runtime.exitCode === null) runtime.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  relay.close();
  summary.runtime_log_cave = output.split("\n").filter((line) => /cave: (local|off)/.test(line)).slice(0, 8);
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  log(`evidence in ${out}`);
}
