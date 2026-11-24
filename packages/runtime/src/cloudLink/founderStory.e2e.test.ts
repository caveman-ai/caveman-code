// The founder's story, end to end, on Firecracker: "I work on my Mac, close the lid, the chat continues on a Cloud
// computer, I open the lid and it comes back; my other Mac and my phone see and steer it; the Cloud computer sleeps and
// wakes with its processes alive; a new release reaches it without losing work."
//
// Against the stack Caveman Cloud's scripts/tests/fc-story-lab.sh builds and names in its story.env: a real local
// Cloud (control-api, relay, the computers service with driver firecracker and the runtime link) on the GCE control
// box, two jailed Firecracker hosts whose computers boot the real computer image with a runtime packed from this repo,
// and here two real runtimes as the desktop app starts them (Mac A and Mac B, each its own state, link key, desktop
// key and agents key), a phone's WebCrypto key, and one scripted model every engine reaches (this file serves it on
// CAVEMAN_E2E_STORY_MODEL_PORT, which the lab reverse-tunnels to the control box: the computers reach it there).
// GitHub is the lab's stand-in (git over http behind the same front). Asleep is SIGSTOP on a Mac; the lid is the
// desktop's own onLidClose.
//
// Steps, each asserted and timed (lab-only, with the Mac's and the hosts' load):
//   1. On Mac A a chat makes uncommitted changes and starts a dev server.
//   2. The lid closes: the chat moves to Cloud with its work, a Firecracker computer adopts it and runs the next turn.
//   3. Mac B and the phone see the chat and send it a message.
//   4. The computer sleeps (its memory kept) and wakes on a message with the dev server still serving, same pid.
//   5. A release roll: N+1 reaches the computer at its next cold boot, its files kept and setup run again.
//   6. Mac A's lid opens and the chat comes back by itself after 30 s idle, its work intact.
//   7. Mac B pulls the chat with Continue on This Mac.
//   8. An agent on Mac A mails an agent on Mac B.
//   9. A NEW chat started in Cloud on a project with no computer yet, as a browser window's Send makes it: when Cloud
//      has placed it, when its computer runs, when that computer's runtime linked, when the chat's first event
//      arrives and when the first token of the answer arrives, each from Send. A test of its own (no Mac in it), so
//      `-t "new chat started in Cloud"` runs it alone; its numbers then join the results file the story last wrote.
// A step that cannot pass says why and the next ones still run (expect.soft); the evidence goes to
// CAVEMAN_E2E_RESULTS (default <stack cache>/story-results.json).
//
// Skipped unless CAVEMAN_E2E_STORY=1 with the stack's env (source <cache>/story.env). CAVEMAN_E2E_STORY_LAST=8 leaves
// step 9 out, as CAVEMAN_E2E_STORY_MACS_ONLY=1 does (it needs Cloud computers).
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { agentsStatementFor, signMove, signStop, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { onLidClose } from "../../../../apps/desktop/src/lid.ts";
import { testDevice } from "../session-protocol/devices.testkit.ts";
import { tempRoot } from "../session-protocol/testHarness.ts";

import { repoHash } from "./heartbeatRepos.ts";
import { agentsKeyFile, allowOnScreen, CLOUD, codeTool, deviceList, PSQL, sql, startDesktopMac, stopAll, trusts, type Mac } from "./macs.e2e.kit.ts";

const env = process.env;
const live = env.CAVEMAN_E2E_STORY === "1" && !!CLOUD && !!PSQL && !!env.CAVEMAN_E2E_EMAIL && !!env.CAVEMAN_E2E_PASSWORD;
const MODEL_PORT = Number(env.CAVEMAN_E2E_STORY_MODEL_PORT ?? 21040);
const COMPUTER_MODEL = env.CAVEMAN_E2E_STORY_MODEL_URL_COMPUTER ?? "";
const GIT = env.CAVEMAN_E2E_STORY_GIT ?? "";
const [IMAGE_N, IMAGE_N1] = (env.CAVEMAN_E2E_STORY_IMAGES ?? "").split(" ");
const RESULTS = env.CAVEMAN_E2E_RESULTS ?? (env.CAVE_FC_LAB_CACHE ? path.join(env.CAVE_FC_LAB_CACHE, "story-results.json") : "");
const DEV_PORT = 4321;
/** The last step to run (CAVEMAN_E2E_STORY_LAST, 9): a shorter story while the harness itself is being proven. */
const LAST = Number(env.CAVEMAN_E2E_STORY_LAST ?? 9);

const results: Record<string, unknown> = { stack: env.CAVEMAN_E2E_STORY_STACK, images: { n: IMAGE_N, n1: IMAGE_N1 }, steps: {} };
const steps = results.steps as Record<string, Record<string, unknown>>;
/** Whether the story itself (steps 1 to 8) ran in this process: without it, step 9's numbers join the file the story last wrote. */
let storyRan = false;
const save = () => {
  if (!RESULTS) return;
  let earlier: Record<string, unknown> = {};
  if (!storyRan) {
    try {
      earlier = JSON.parse(fs.readFileSync(RESULTS, "utf8")) as Record<string, unknown>;
    } catch {
      // No file yet, or one that does not parse: this run's alone.
    }
  }
  fs.writeFileSync(RESULTS, JSON.stringify({ ...earlier, ...results, steps: { ...(earlier.steps as Record<string, unknown> | undefined), ...steps } }, null, 1));
};
/** What the chat last read as in Cloud's copy, and every model call: the evidence of a step that did not pass. */
let lastEvents: ReadonlyArray<SessionEvent> = [];
/** The dev servers this file started on this Mac (in sessions of their own, so stopAll does not end them). */
const devServers: Array<number> = [];
afterAll(() => {
  for (const pid of devServers) {
    try {
      process.kill(pid);
    } catch {
      // gone already
    }
  }
  // The story's own evidence; a run of step 9 alone leaves the story's as the file has it.
  if (storyRan) {
    results.last_events = lastEvents.map((e) => `${e.cursor} ${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`);
    results.model_calls = calls;
  }
  stopAll();
  model?.close();
  save();
});
const macLoad = () => os.loadavg().map((n) => n.toFixed(2)).join(" ");
/** The hosts' 1-minute load, through the lab's control box (best effort: "" when it cannot say). */
const hostLoad = () => {
  try {
    return execFileSync("sh", ["-c", `${env.CAVEMAN_E2E_STORY_CONTROL} load`], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: os.userInfo().homedir } }).trim();
  } catch {
    return "";
  }
};
const step = (name: string, data: Record<string, unknown>) => {
  steps[name] = { ...steps[name], ...data, mac_load: macLoad() };
  save();
};

// --- the scripted model every engine reaches: /<where>/v1/chat/completions -----------------------------------------
// Its words: WRITE <text> edits the worktree (uncommitted); SERVE starts a dev server on DEV_PORT in its own session
// (pid in .devserver.pid); PROBE says the dev server's pid and answer, the worktree's state, and which machine this
// is; SLOW <s> answers after s seconds; MAIL <thread> <text> sends agent mail with thread_send from the code tool.
// Anything else: "heard: <first line> (on <where>)". After a tool: "sent (on <where>): <the tool's output>".
type Call = { where: string; last: string; tools: Array<string> };
const calls: Array<Call> = [];
/** What a Cloud computer may reach: the lab's Cloud front (https), and none of the hosts' agents, the metadata server or the internet. */
const NET_TARGETS = (env.CAVEMAN_E2E_STORY_NET ?? "10.90.0.4:21001 10.90.0.2:47460 10.90.0.3:47460 169.254.169.254:80 1.1.1.1:443 8.8.8.8:53").split(" ");
const SHELL = {
  NET: () => NET_TARGETS.map((t) => `timeout 4 bash -c 'exec 3<>/dev/tcp/${t.split(":")[0]}/${t.split(":")[1]}' 2>/dev/null && echo "${t}=open" || echo "${t}=closed"`).join("; "),
  WRITE: (text: string) => `printf '%s\\n' '${text.replace(/'/g, "")}' >> notes.txt && printf 'edited on the move\\n' >> README.md && git status --short`,
  SERVE: () =>
    `python3 -c 'import subprocess; p = subprocess.Popen(["python3", "-m", "http.server", "${DEV_PORT}", "--bind", "127.0.0.1"], stdout=open(".devserver.log", "w"), stderr=subprocess.STDOUT, start_new_session=True); open(".devserver.pid", "w").write(str(p.pid))' && sleep 1 && echo "pid=$(cat .devserver.pid)"`,
  PROBE: () =>
    `echo "pid=$(cat .devserver.pid 2>/dev/null)"; echo "alive=$(kill -0 "$(cat .devserver.pid 2>/dev/null)" 2>/dev/null && echo yes || echo no)"; echo "http=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${DEV_PORT}/ || true)"; echo "notes=$(tr '\\n' '|' < notes.txt 2>/dev/null)"; echo "status=$(git status --short | tr '\\n' '|')"; echo "boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.boottime 2>/dev/null | tr -d ' ')"; echo "setup=$(cat "$HOME/.story-setup-runs" 2>/dev/null | tr '\\n' '|')"`,
};
let model: http.Server | undefined;
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? "").join("") : "";
function reply(where: string, body: { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name: string } }> }) {
  const messages = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
  const last = messages.at(-1);
  calls.push({ where, last: textOf(last?.content).slice(0, 400), tools });
  if (messages.some((m) => m.role === "user" && textOf(m.content).includes("Reply with the word OK"))) return { text: "OK" };
  if (last?.role === "tool") return { text: `sent (on ${where}): ${textOf(last.content).slice(0, 1500)}` };
  // What the person said last: the last line of the last message past a wrapper's tags (earlier turns that never ran
  // can share the message).
  const full = textOf(last?.content);
  const lines = full.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("<"));
  const said = lines.at(-1) ?? "";
  const shell = tools.find((t) => /^(bash|shell)$/i.test(t)) ?? tools.find((t) => /bash|shell|exec/i.test(t));
  const command = (cmd: string) => (shell ? { calls: [{ name: shell, args: { command: cmd } }] } : { text: `no shell tool (on ${where}) among ${tools.join(",")}` });
  const write = /\bWRITE ([^\n]*)/.exec(said);
  if (write) return command(SHELL.WRITE(write[1]!));
  if (/\bSERVE\b/.test(said)) return command(SHELL.SERVE());
  if (/\bPROBE\b/.test(said)) return command(SHELL.PROBE());
  if (/\bNET\b/.test(said)) return command(SHELL.NET());
  const mail = /\bMAIL (\S+) ([^\n]*)/.exec(said);
  if (mail) {
    const code = codeTool(tools);
    if (code === undefined) return { text: `cannot mail (on ${where}): no code tool` };
    const args = JSON.stringify({ threadId: mail[1], message: mail[2], expectReply: true });
    const cell = [
      "const names = (Array.isArray(ALL_TOOLS) ? ALL_TOOLS : Object.keys(ALL_TOOLS)).map((t) => (typeof t === 'string' ? t : t.name));",
      "const name = names.find((n) => /thread_send$/.test(n));",
      "if (!name) return 'no send tool among ' + names.join(',');",
      `return await tools[name](${args});`,
    ].join("\n");
    return { calls: [{ name: code, args: { code: cell } }] };
  }
  const slow = /\bSLOW (\d+)/.exec(said);
  // The first line of the person's (or a mail's) words, past a wrapper's tags.
  const line = lines[0] ?? full.split("\n")[0]!.trim();
  return { text: `heard: ${line.slice(0, 200)} (on ${where})`, delay: slow ? Number(slow[1]) * 1000 : 0 };
}
function serveModel() {
  let n = 0;
  model = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const where = /^\/([a-z0-9-]+)\/v1\/chat\/completions/.exec(req.url ?? "")?.[1];
      if (req.method !== "POST" || where === undefined) return void res.writeHead(404).end();
      const body = JSON.parse(raw || "{}");
      const out = reply(where, body) as { text?: string; calls?: Array<{ name: string; args: unknown }>; delay?: number };
      const id = `chatcmpl-${++n}`;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const send = () => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        chunk({ role: "assistant", content: "" });
        if (out.calls) {
          out.calls.forEach((c, index) => chunk({ tool_calls: [{ index, id: `call_${n}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
          chunk({}, "tool_calls");
        } else {
          chunk({ content: out.text ?? "" });
          chunk({}, "stop");
        }
        // The usage the engine requires of every answer (cave_provider_usage_incomplete without it).
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      setTimeout(send, out.delay ?? 0);
    });
  });
  return new Promise<void>((resolve) => model!.listen(MODEL_PORT, "127.0.0.1", () => resolve()));
}

/** fetch through the lab's tunnel, once more on a connection the far side closed while idle (keep-alive's race). */
async function fetchCloud(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// --- Cloud, as the person and as SQL -------------------------------------------------------------------------------
let bearer = "";
const signIn = async () => {
  const r = await fetchCloud(`${CLOUD}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: env.CAVEMAN_E2E_EMAIL, password: env.CAVEMAN_E2E_PASSWORD }) });
  const out = (await r.json()) as { access_token: string; user: { id: string; organization_id: string } };
  bearer = out.access_token;
  return out;
};
const cloud = async (method: string, route: string, body?: unknown) => {
  const r = await fetchCloud(`${CLOUD}/api/v1${route}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
};
/** Cloud's copy of the chat, as any of the person's devices reads it. */
async function cloudEvents(sessionId: string): Promise<Array<SessionEvent>> {
  const out: Array<SessionEvent> = [];
  for (let after = 0; ; ) {
    const r = await cloud("GET", `/code/chats/${sessionId}/events?after=${after}&limit=500`);
    // Each is Cloud's row: its cursor and the runtime's event.
    const rows = (r.body?.events ?? []) as Array<{ cursor: number; event: SessionEvent }>;
    out.push(...rows.map((row) => row.event));
    if (rows.length < 500) return (lastEvents = out);
    after = rows.at(-1)!.cursor;
  }
}
const assistantSaid = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text as string] : []));
/** Waits for an assistant line in Cloud's copy matching `match`, and returns it. */
async function heard(sessionId: string, match: (text: string) => boolean, ms: number, after = 0) {
  let line = "";
  await waitFor(async () => (line = assistantSaid((await cloudEvents(sessionId)).filter((e) => e.cursor > after)).find(match) ?? "") !== "", ms);
  return line;
}
/** The chat's last cursor in Cloud's copy: what an answer to the next message comes after. */
const mark = async (sessionId: string) => (await cloudEvents(sessionId)).reduce((n, e) => Math.max(n, e.cursor), 0);
const owner = (sessionId: string) => sql(`SELECT coalesce(w.computer_id::text, '') FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id AND w.organization_id = s.organization_id WHERE s.id = '${sessionId}'`);
const computerRow = (id: string) => {
  const [driver, desired, observed, reason] = sql(`SELECT driver || '|' || desired_state || '|' || observed_state || '|' || coalesce(observed_reason, '') FROM code_computers WHERE id = '${id}'`).split("|");
  return { driver, desired, observed, reason };
};
const probe = (line: string) => Object.fromEntries(line.split(/\n/).flatMap((l) => /^(\w+)=(.*)$/.exec(l.trim())?.slice(1, 3) ? [[/^(\w+)=/.exec(l.trim())![1]!, l.trim().slice(l.trim().indexOf("=") + 1)]] : []));
/** The phone (WebCrypto key): a turn queued in Cloud, which runs wherever the chat is. */
const phoneSays = (sessionId: string, text: string) =>
  cloud("POST", `/code/chats/${sessionId}/calls`, { request_id: `phone-${randomUUID()}`, method: "turn.submit", params: { session_id: sessionId, kind: "followup", input: { text } } });

/** One JSON-RPC call to a runtime through the relay, as the person (their bearer): how a device reaches a Cloud computer. */
function relayCall(runtimeId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`/relay/v1/runtimes/${runtimeId}`, CLOUD);
  url.protocol = "ws:";
  const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (ws.close(), reject(new Error(`${method}: no answer in 60 s`))), 60_000);
    ws.on("unexpected-response", (_q, r) => (clearTimeout(timer), reject(new Error(`relay answered ${r.statusCode}`))));
    ws.on("error", (e) => (clearTimeout(timer), reject(e)));
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: unknown };
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
      else resolve(m.result);
    });
  });
}

async function vouch(on: Mac) {
  const { agents, name } = await on.client.call("device.agents", {});
  const statement = await agentsStatementFor(on.key, (await deviceList(on)).family, agents!, name);
  await on.client.call("device.vouch", { request_id: `vouch-${on.name}`, statement: statement! });
  await waitFor(async () => (await on.client.call("device.agents", {})).shared === true, 60_000);
}
/** until, at a pace a tunnelled Cloud and its SQL bear: every `every` ms. */
async function waitFor(check: () => boolean | Promise<boolean>, ms: number, every = 500) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const timed = async <T>(f: () => Promise<T>) => {
  const started = Date.now();
  const value = await f();
  return [value, Date.now() - started] as const;
};

test.skipIf(!live)(
  "the founder's story on Firecracker: lid closed, the chat on a Cloud computer, seen and steered from Mac B and a phone, asleep and awake with its processes, rolled to a release, home again, pulled, and mail between Macs",
  async () => {
    storyRan = true;
    await serveModel();
    const me = await signIn();
    // The stand-in GitHub: a repository with a setup that leaves a mark in the tools home each time it runs.
    const name = `story-${randomUUID().slice(0, 8)}`;
    const repoUrl = `https://github.com/octocat/${name}`;
    const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${GIT}/octocat/${name}.git.insteadOf`, GIT_CONFIG_VALUE_0: repoUrl };
    Object.assign(process.env, gitEnv);
    const seed = path.join(tempRoot("story-seed-"), "seed");
    fs.mkdirSync(path.join(seed, ".caveman"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "README.md"), "the founder's story\n");
    fs.writeFileSync(path.join(seed, ".caveman", "computer.toml"), `[setup]\nrun = ["date +%s >> $HOME/.story-setup-runs"]\n`);
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git(seed, "push", "-q", `${GIT}/octocat/${name}.git`, "HEAD:main");

    const keys = { a: agentsKeyFile(), b: agentsKeyFile() };
    const pem = { a: fs.readFileSync(keys.a, "utf8"), b: fs.readFileSync(keys.b, "utf8") };
    const a = await startDesktopMac("Mac A", CLOUD!, bearer, { agentsKey: pem.a, model: `http://127.0.0.1:${MODEL_PORT}/mac-a/v1`, env: gitEnv });
    const b = await startDesktopMac("Mac B", CLOUD!, bearer, { agentsKey: pem.b, model: `http://127.0.0.1:${MODEL_PORT}/mac-b/v1`, env: gitEnv });
    await a.client.call("settings.set", { request_id: "lid-moves-on", settings: { sync_chats: true, move_to_cloud: true } });
    // The Macs pair (each allows the other's desktop key) and vouch for their agents keys; Mac A allows the phone.
    await allowOnScreen(a as unknown as Mac, b.key);
    await allowOnScreen(b as unknown as Mac, a.key);
    await waitFor(async () => (await trusts(a as unknown as Mac, b.key)) && (await trusts(b as unknown as Mac, a.key)), 60_000);
    await vouch(a as unknown as Mac);
    await vouch(b as unknown as Mac);
    // Mac B has the repository open too (decision 30: a chat moves only to a Mac that holds its repository).
    const bClone = path.join(tempRoot("story-mac-b-"), "repo");
    execFileSync("git", ["clone", "-q", repoUrl, bClone]);
    await b.client.call("project.create", { request_id: "b-open", path: bClone });
    await waitFor(() => sql(`SELECT COALESCE(repos::text, '') FROM code_runtimes WHERE id = '${b.runtimeId}'`).includes(repoHash(repoUrl)!), 120_000);
    const phone = await testDevice("iPhone, Safari");
    await allowOnScreen(a as unknown as Mac, phone);

    // --- 1. On Mac A: uncommitted changes and a dev server -------------------------------------------------------
    const clone = path.join(tempRoot("story-mac-a-"), "repo");
    execFileSync("git", ["clone", "-q", repoUrl, clone]);
    const started1 = Date.now();
    const w = await a.client.call("workspace.create", { request_id: "story", repo: { path: clone }, title: "The founder's story", engine: "caveman", options: { model: a.model, access: "full" }, task: { text: "WRITE wip from Mac A" } });
    const session = w.session_id;
    const approveAll = async (on: { client: Mac["client"] }) => {
      for (const ask of (await cloudEvents(session)).filter((e) => e.type === "ask.user")) {
        const allow = (ask.payload as { options?: Array<{ id: string; decision: string }> }).options?.find((o) => o.decision === "allow");
        if (allow) await on.client.call("ask.respond", { request_id: `allow-${ask.item_id}`, session_id: session, ask_id: ask.item_id!, response: { kind: "approval", option_id: allow.id } }).catch(() => undefined);
      }
    };
    await waitFor(async () => {
      await approveAll(a);
      return assistantSaid(await cloudEvents(session)).some((t) => t.startsWith("sent (on mac-a)") && t.includes("notes.txt"));
    }, 180_000);
    await a.client.call("turn.submit", { request_id: "serve-a", session_id: session, kind: "followup", input: { text: "SERVE" } });
    await waitFor(async () => {
      await approveAll(a);
      return assistantSaid(await cloudEvents(session)).some((t) => t.startsWith("sent (on mac-a)") && t.includes("pid="));
    }, 120_000);
    // The chat works in its own worktree of the clone.
    const tree = (await a.client.call("workspace.list", {})).workspaces.find((x) => x.session_id === session)!.root_path!;
    const devA = Number(fs.readFileSync(path.join(tree, ".devserver.pid"), "utf8"));
    devServers.push(devA);
    const servingA = await fetch(`http://127.0.0.1:${DEV_PORT}/`).then((r) => r.status, () => 0);
    expect(git(tree, "status", "--short")).toContain("notes.txt");
    expect(servingA).toBe(200);
    step("1_work_on_mac_a", { session, tree, wip: git(tree, "status", "--short"), dev_server_pid: devA, ms: Date.now() - started1 });
    if (LAST <= 1) return;

    // CAVEMAN_E2E_STORY_MACS_ONLY=1: the Macs' steps alone (1, 7, 8), on a Cloud with no computers (the lab's cloud
    // stage), while the harness itself is being proven.
    if (env.CAVEMAN_E2E_STORY_MACS_ONLY !== "1") {
    // --- 2. The lid closes: the chat moves to a Firecracker computer, which runs its next turn -----------------------
    const macA = sql(`SELECT id FROM code_computers WHERE id = (SELECT computer_id FROM code_runtimes WHERE id = '${a.runtimeId}')`);
    await a.client.call("turn.submit", { request_id: "slow-a", session_id: session, kind: "followup", input: { text: "SLOW 45 still working at the lid" } });
    await waitFor(async () => (await a.client.call("workspace.list", {})).workspaces.find((x) => x.session_id === session)?.status === "working", 60_000);
    const atLid = await mark(session);
    const lidAt = Date.now();
    const [lidOut, lidMs] = await timed(() => onLidClose(a.client, () => `lid:${randomUUID()}`));
    a.child.kill("SIGSTOP");
    let computer = "";
    await waitFor(() => (computer = owner(session)) !== "" && computer !== macA, 180_000);
    const ownedMs = Date.now() - lidAt;
    expect.soft(computerRow(computer).driver, "the computer Cloud made for the lid's move is a Firecracker one").toBe("firecracker");
    await waitFor(() => computerRow(computer).observed === "running", 300_000).catch(() => undefined);
    const runningMs = Date.now() - lidAt;
    let computerRuntime = "";
    await waitFor(() => (computerRuntime = sql(`SELECT id FROM code_runtimes WHERE computer_id = '${computer}' AND status = 'active' AND last_seen_at IS NOT NULL`)) !== "", 300_000).catch(() => undefined);
    const linkedMs = Date.now() - lidAt;
    expect.soft(computerRuntime, "the Firecracker computer's runtime links to Cloud").not.toBe("");
    // The turn the lid interrupted carries on on the computer once it adopted the chat (its session.resumed): what it
    // did, as Cloud's copy says.
    let adopted = 0;
    await waitFor(async () => (adopted = (await cloudEvents(session)).find((e) => e.cursor > atLid && e.type === "session.resumed")?.cursor ?? 0) > 0, 300_000).catch(() => undefined);
    const adoptedMs = Date.now() - lidAt;
    let carried: SessionEvent | undefined;
    await waitFor(async () => (carried = (await cloudEvents(session)).find((e) => adopted > 0 && e.cursor > adopted && e.type === "turn.done")) !== undefined, 240_000).catch(() => undefined);
    const carriedMs = Date.now() - lidAt;
    const continued = carried?.payload as { status?: string; error?: string } | undefined;
    // Where Cloud sells credits (CAVE_CODE_CAVEMAN_CREDITS) the computer's runtime is minted its person's credits key and
    // the carried turn pays from their plan (computerCredits.e2e.test.ts). This lab runs no credits broker: its computers
    // run Caveman chats on a key or endpoint each gets (CAVE_CODE_LAB_CAVEMAN_ON_COMPUTERS), so until the story adds the
    // model below, a fresh computer holds none of the person's Caveman engine credentials and the carried turn fails, said.
    expect
      .soft(continued?.status, `the turn the lid interrupted carries on on the Cloud computer (it said ${JSON.stringify(continued ?? "nothing")}: a fresh Cloud computer in this lab, which runs no credits broker, holds none of the person's Caveman engine credentials)`)
      .toBe("completed");
    // The person adds the lab's model to the computer, as Settings does for a Cloud computer: a call to its runtime
    // through the relay, as the person. Then the chat's next turn runs there.
    let account: unknown;
    if (computerRuntime) {
      account = await relayCall(computerRuntime, "engine.account.add", {
        request_id: "story-model",
        engine: "caveman",
        provider: "custom-agents",
        endpoint: { name: "story model", base_url: COMPUTER_MODEL.replace(/\/v1$/, "/cloud/v1"), models: ["mail-m"] },
      }).catch((e: Error) => ({ error: e.message }));
    }
    const before2 = await mark(session);
    const nextAt = Date.now();
    await phoneSays(session, "PROBE");
    const probed2 = await heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("notes="), 240_000, before2).catch(() => "");
    const nextMs = Date.now() - nextAt;
    const p2 = probe(probed2.replace(/^sent \(on cloud\): /, ""));
    expect.soft(probed2, "the chat's next turn runs on the Cloud computer").not.toBe("");
    expect.soft(p2.notes ?? "", "Mac A's uncommitted notes reached the computer").toContain("wip from Mac A");
    expect.soft(p2.status ?? "", "Mac A's edit to a tracked file reached the computer").toContain("M README.md");
    // The computer has no snapshot of the repository's setup: it ran for the chat it adopted, beside it.
    expect.soft((p2.setup ?? "").split("|").filter(Boolean).length, "the computer ran the repository's setup for the chat it adopted").toBe(1);
    // The computer's network: the Cloud front, and nothing else of the lab's.
    const beforeNet = await mark(session);
    await phoneSays(session, "NET");
    const net = Object.fromEntries((await heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("=open") || t.includes("=closed"), 180_000, beforeNet).catch(() => "")).replace(/^sent \(on cloud\): /, "").split("\n").flatMap((l) => (/^(\S+:\d+)=(open|closed)$/.exec(l.trim()) ? [[l.trim().split("=")[0], l.trim().split("=")[1]]] : [])));
    expect.soft(net[NET_TARGETS[0]!], "the computer reaches the Cloud front").toBe("open");
    for (const t of NET_TARGETS.slice(1)) expect.soft(net[t], `the computer does not reach ${t}`).toBe("closed");
    step("2_lid_closes", { lid: lidOut, lid_ms: lidMs, computer, driver: computerRow(computer).driver, owned_ms: ownedMs, running_ms: runningMs, linked_ms: linkedMs, adopted_ms: adoptedMs, carried_turn: continued, carried_ms: carriedMs, account, next_turn_ms: nextMs, probe: p2, net, host_load: hostLoad() });
    if (LAST <= 2) return;

    // --- 3. Mac B and the phone see the chat and steer it --------------------------------------------------------------
    // Mac B's app lists the person's chats from Cloud (its renderer calls the chat routes with the bearer), and steers this
    // one live through the relay to the computer's runtime; the phone queues its messages in Cloud.
    const listed = (await cloud("GET", "/code/chats")).body;
    const seenByB = JSON.stringify(listed ?? {}).includes(session);
    expect.soft(seenByB, "Mac B's app lists the chat").toBe(true);
    const before3 = await mark(session);
    const [fromB, bMs] = await timed(async () => {
      const sent = await relayCall(computerRuntime, "turn.submit", { request_id: "from-b", session_id: session, kind: "followup", input: { text: "hello from Mac B" } }).catch((e: Error) => ({ error: e.message }));
      return { sent, heard: await heard(session, (t) => t.includes("hello from Mac B") && t.includes("(on cloud)"), 180_000, before3).catch(() => "") };
    });
    expect.soft(fromB.heard, "Mac B's message runs on the Cloud computer").not.toBe("");
    const before3b = await mark(session);
    const [served, phoneMs] = await timed(async () => {
      await phoneSays(session, "SERVE");
      return heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("pid="), 180_000, before3b).catch(() => "");
    });
    expect.soft(served, "the phone's message starts the dev server on the Cloud computer").not.toBe("");
    const before3c = await mark(session);
    await phoneSays(session, "PROBE");
    const probed3 = probe((await heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("http="), 180_000, before3c).catch(() => "")).replace(/^sent \(on cloud\): /, ""));
    expect.soft(probed3.http, "the dev server serves on the Cloud computer").toBe("200");
    step("3_mac_b_and_phone", { seen_by_b: seenByB, from_b: fromB, mac_b_turn_ms: bMs, phone_turn_ms: phoneMs, probe: probed3 });
    if (LAST <= 3) return;

    // --- 4. Asleep with its memory, awake on a message: the dev server still serving, the same pid -------------------
    const [slept, sleepMs] = await timed(async () => {
      const r = await cloud("POST", `/code/computers/${computer}/sleep`);
      await waitFor(() => computerRow(computer).observed === "suspended" || computerRow(computer).observed === "stopped", 300_000).catch(() => undefined);
      return { status: r.status, row: computerRow(computer) };
    });
    const before4 = await mark(session);
    const [, wakeMs] = await timed(async () => {
      await phoneSays(session, "PROBE after sleep");
      return waitFor(() => computerRow(computer).observed === "running", 300_000).catch(() => undefined);
    });
    const woke = computerRow(computer);
    const probed4 = probe((await heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("pid="), 300_000, before4).catch(() => "")).replace(/^sent \(on cloud\): /, ""));
    expect.soft(woke.observed, "a message wakes the sleeping computer (no device hint)").toBe("running");
    expect.soft(probed4.pid, "the dev server's pid after the wake").toBe(probed3.pid);
    expect.soft(probed4.http, "the dev server serves after the wake").toBe("200");
    expect.soft(probed4.boot, "the same boot (a wake, not a cold boot)").toBe(probed3.boot);
    step("4_sleep_and_wake", { slept, sleep_ms: sleepMs, wake_ms: wakeMs, woke, probe: probed4, host_load: hostLoad() });
    if (LAST <= 4) return;

    // --- 5. A release roll: N+1 at the next cold boot, files kept, setup again ----------------------------------------
    const setupBefore = (probed4.setup ?? "").split("|").filter(Boolean).length;
    // The release reaches Cloud as a deploy rolls it: control-api and the computers service restart on N+1.
    const releaseAt = Date.now();
    execFileSync("sh", ["-c", `${env.CAVEMAN_E2E_STORY_CONTROL} release ${env.CAVEMAN_E2E_STORY_WORK} ${IMAGE_N1}`], { stdio: "inherit", timeout: 180_000, env: { ...process.env, HOME: os.userInfo().homedir } });
    const releaseMs = Date.now() - releaseAt;
    // The person updates the computer (Settings > Computers > Update): once its runtime has been idle 90 s Cloud restarts
    // it cold on N+1 now (a busy one would take N+1 at its next wake).
    let update: { status: number; body?: { updating?: string; image?: string } } = { status: 0 };
    const [, idleMs] = await timed(() =>
      waitFor(async () => {
        update = await cloud("POST", `/code/computers/${computer}/update`);
        return update.body?.updating === "now" || update.body?.image === IMAGE_N1;
      }, 300_000, 10_000).catch(() => undefined),
    );
    const rollAt = Date.now();
    await waitFor(async () => (await cloud("GET", `/code/computers/${computer}`)).body?.image === IMAGE_N1 && computerRow(computer).observed === "running", 600_000).catch(() => undefined);
    const rollMs = Date.now() - rollAt;
    const before5 = await mark(session);
    await phoneSays(session, "PROBE after the roll");
    const probed5 = probe((await heard(session, (t) => t.startsWith("sent (on cloud)") && t.includes("setup="), 300_000, before5).catch(() => "")).replace(/^sent \(on cloud\): /, ""));
    const image = (await cloud("GET", `/code/computers/${computer}`)).body?.image;
    expect.soft(image, "the computer runs release N+1").toBe(IMAGE_N1);
    expect.soft(probed5.boot, "a cold boot onto the new release").not.toBe(probed4.boot);
    expect.soft(probed5.notes ?? "", "its files kept across the roll").toContain("wip from Mac A");
    expect.soft((probed5.setup ?? "").split("|").filter(Boolean).length, "setup ran again on the new release").toBeGreaterThan(setupBefore);
    const rolledNotes = (await cloudEvents(session)).flatMap((e) => (e.cursor > before4 && e.type === "notification" ? [(e.payload as { title: string }).title] : []));
    expect.soft(rolledNotes, "the chat says why setup ran again").toContain("Setup runs again: this computer woke on a newer image");
    step("5_release_roll", { release_ms: releaseMs, idle_wait_ms: idleMs, update: { status: update.status, updating: update.body?.updating }, image, roll_ms: rollMs, probe: probed5, setup_notes: rolledNotes.filter((t) => t.startsWith("Setup ")), host_load: hostLoad() });
    if (LAST <= 5) return;

    // --- 6. Mac A's lid opens: the chat comes back by itself after 30 s idle -------------------------------------------
    const wokeAt = Date.now();
    a.child.kill("SIGCONT");
    await waitFor(() => owner(session) === macA, 240_000).catch(() => undefined);
    const backMs = Date.now() - wokeAt;
    expect.soft(owner(session), "the chat is back on Mac A").toBe(macA);
    expect.soft(backMs, "back no sooner than 30 s after the wake").toBeGreaterThanOrEqual(30_000);
    const treeBack = (await a.client.call("workspace.list", {})).workspaces.find((x) => x.session_id === session)?.root_path ?? tree;
    expect.soft(fs.existsSync(path.join(treeBack, "notes.txt")) ? fs.readFileSync(path.join(treeBack, "notes.txt"), "utf8") : "", "its work intact on Mac A").toContain("wip from Mac A");
    step("6_lid_opens", { back_ms: backMs, tree: treeBack, wip: fs.existsSync(treeBack) ? git(treeBack, "status", "--short") : "gone" });
    if (LAST <= 6) return;

    }
    // --- 7. Continue on This Mac from Mac B ----------------------------------------------------------------------------
    const pull = randomUUID();
    const to = { computer_id: b.computerId };
    const [, pullMs] = await timed(async () => {
      await b.client.call("session.move", { request_id: pull, session_id: session, to, device: await signMove(b.key, { session_id: session, request_id: pull, to }), stop: await signStop(b.key, { session_id: session, move_request_id: pull }) });
      return waitFor(() => owner(session) === b.computerId, 180_000).catch(() => undefined);
    });
    expect.soft(owner(session), "Mac B holds the chat").toBe(b.computerId);
    step("7_pull_to_mac_b", { pull_ms: pullMs });
    if (LAST <= 7) return;

    // --- 8. An agent on Mac A mails an agent on Mac B --------------------------------------------------------------------
    const askerClone = path.join(tempRoot("story-asker-"), "repo");
    execFileSync("git", ["clone", "-q", repoUrl, askerClone]);
    const asker = await a.client.call("workspace.create", { request_id: "asker", repo: { path: askerClone }, title: "Asker", engine: "caveman", options: { model: a.model, access: "full" }, task: { text: "hello" } });
    const target = sql(`SELECT workspace_id FROM code_sessions WHERE id = '${session}'`);
    const before8 = await mark(session);
    const mailAt = Date.now();
    await heard(asker.session_id, (t) => t.includes("(on mac-a)"), 120_000).catch(() => "");
    await a.client.call("turn.submit", { request_id: "mail", session_id: asker.session_id, kind: "followup", input: { text: `MAIL mac:${target} what is in your README?` } });
    const ranOnB = await heard(session, (t) => t.includes("what is in your README") && t.includes("(on mac-b)"), 180_000, before8).catch(() => "");
    const mailMs = Date.now() - mailAt;
    // Mac B's answer comes back to the asker as its next turn: "heard: <B's words> (on mac-a)".
    const answered = await heard(asker.session_id, (t) => t.includes("(on mac-b)") && t.endsWith("(on mac-a)"), 180_000).catch(() => "");
    const answeredMs = Date.now() - mailAt;
    expect.soft(ranOnB, "Mac B's chat runs the mail as its next turn").not.toBe("");
    expect.soft(answered, "the asker on Mac A hears Mac B's answer").not.toBe("");
    step("8_mail_a_to_b", { ran_on_b_ms: mailMs, answered_ms: answeredMs, ran_on_b: ranOnB, answered });
  },
  60 * 60_000,
);

/**
 * The chat's events as they come, live, through the relay to its computer's runtime as the person: how a device reads
 * a chat on a Cloud computer. Asked again while the runtime does not know the chat yet (its start is still running).
 * Answers what ends it.
 */
function relayAttach(runtimeId: string, sessionId: string, seen: (event: SessionEvent) => void): () => void {
  const url = new URL(`/relay/v1/runtimes/${runtimeId}`, CLOUD);
  url.protocol = "ws:";
  const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
  let ended = false;
  let id = 0;
  const attach = () => !ended && ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "session.attach", params: { session_id: sessionId, cursor: 0, batch: true } }));
  ws.on("open", attach);
  ws.on("error", () => {});
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as { id?: number; method?: string; error?: unknown; params?: unknown };
    if (m.method === "session.event") seen(m.params as SessionEvent);
    else if (m.method === "session.events") for (const event of (m.params as { events?: Array<SessionEvent> }).events ?? []) seen(event);
    else if (m.id === id && m.error) setTimeout(attach, 100);
  });
  return () => {
    ended = true;
    ws.close();
  };
}

// --- 9. A new chat started in Cloud, on a project with no computer yet ----------------------------------------------
test.skipIf(!live || env.CAVEMAN_E2E_STORY_MACS_ONLY === "1" || LAST < 9)(
  "a new chat started in Cloud on a project with no computer yet: placed, its computer running, its runtime linked, its first event and its first token, from Send",
  async () => {
    if (model === undefined) await serveModel();
    if (bearer === "") await signIn();
    // A repository of its own on the stand-in GitHub: a project Cloud has made no computer for.
    const name = `story-new-${randomUUID().slice(0, 8)}`;
    const repoUrl = `https://github.com/octocat/${name}`;
    const seed = path.join(tempRoot("story-new-seed-"), "seed");
    fs.mkdirSync(seed, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "README.md"), "a new chat in Cloud\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git(seed, "push", "-q", `${GIT}/octocat/${name}.git`, "HEAD:main");

    // Send, as a browser window makes it (apps/web state/cloud.ts sendCloudStart): one request. Cloud places the chat
    // and queues its start with the placement (CONTRACT 6.8); the computer's runtime runs it when it links.
    const requestId = `story-new-${randomUUID()}`;
    const text = "hello from a new chat in Cloud";
    const params = { repo: { url: repoUrl }, engine: "caveman", title: "A new chat in Cloud", task: { text }, options: { access: "full" } };
    const sentAt = Date.now();
    const since = () => Date.now() - sentAt;
    const sent = await cloud("POST", "/code/workspaces", { title: "A new chat in Cloud", repo: `octocat/${name}`, base_branch: "", engine: "caveman", computer: { kind: "cloud" }, start: { request_id: requestId, params } });
    const placedMs = since();
    const placed = (sent.body ?? {}) as { id?: string; computer_id?: string; session_id?: string; start?: { status?: string } };
    expect.soft(sent.status, `Cloud places the chat (it answered ${JSON.stringify(sent.body ?? null).slice(0, 300)})`).toBe(201);
    expect.soft(placed.start?.status, "Cloud queued the chat's start with its placement").toBeDefined();
    const computer = placed.computer_id ?? "";
    const session = placed.session_id ?? "";
    if (computer === "" || session === "") {
      step("9_new_chat_in_cloud", { sent: { status: sent.status, body: sent.body }, placed_ms: placedMs, host_load: hostLoad() });
      return;
    }
    // Every wait below runs beside the others and looks every 100 ms: they are close together, and one after another
    // each would only be seen at the pace of the one before it.
    const at: Record<string, number> = {};
    const watch = (key: string, check: () => boolean | Promise<boolean>, ms: number) => waitFor(check, ms, 100).then(() => void (at[key] = since()), () => undefined);
    let computerRuntime = "";
    let ended: (() => void) | undefined;
    const live: Array<{ readonly event: SessionEvent; readonly ms: number }> = [];
    const isAnswer = (event: SessionEvent) => event.type === "message.delta" || (event.type === "message.done" && event.payload.role === "assistant");
    const running = watch("running", () => computerRow(computer).observed === "running", 300_000);
    const linked = watch("linked", () => (computerRuntime = sql(`SELECT id FROM code_runtimes WHERE computer_id = '${computer}' AND status = 'active' AND last_seen_at IS NOT NULL`)) !== "", 300_000).then(() => {
      // A device's own view from here on: the chat's events live, through the relay.
      if (computerRuntime !== "") ended = relayAttach(computerRuntime, session, (event) => live.push({ event, ms: since() }));
    });
    // The start ran: Cloud's call for it is done, and the chat's first event exists (live, and in Cloud's copy).
    const started = watch("start_done", async () => (await cloud("GET", `/code/chats/${session}/calls/${requestId}`)).body?.status === "done", 300_000);
    const firstLive = watch("first_event", () => live.length > 0, 300_000);
    const firstCopied = watch("first_event_in_clouds_copy", async () => (await cloudEvents(session)).length > 0, 300_000);
    const firstToken = watch("first_token", () => live.some(({ event }) => isAnswer(event)), 300_000);
    const turnOver = watch("first_turn_done", () => live.some(({ event }) => event.type === "turn.done"), 300_000);
    await Promise.all([running, linked, started, firstLive, firstCopied]);
    await Promise.race([firstToken, turnOver]);
    const first = live[0];
    const token = live.find(({ event }) => isAnswer(event));
    const done = live.find(({ event }) => event.type === "turn.done")?.event.payload as { status?: string; error?: string } | undefined;
    expect.soft(computerRow(computer).driver, "the computer Cloud made for the new chat is a Firecracker one").toBe("firecracker");
    expect.soft(at.linked, "the new computer's runtime links to Cloud").toBeDefined();
    expect.soft(at.start_done, "the computer ran the start Cloud queued").toBeDefined();
    expect.soft(first, "the chat's first event reaches a device through the relay").toBeDefined();
    // A fresh computer in this lab holds none of the person's Caveman engine credentials (no credits broker): its first
    // turn then ends without an answer, said. The person adds the lab's model, as step 2 does, and the chat's next
    // message is timed to its first token instead, from its own Send.
    let followup: Record<string, unknown> | undefined;
    if (token === undefined && computerRuntime !== "") {
      const account = await relayCall(computerRuntime, "engine.account.add", {
        request_id: `story-new-model-${name}`,
        engine: "caveman",
        provider: "custom-agents",
        endpoint: { name: "story model", base_url: COMPUTER_MODEL.replace(/\/v1$/, "/cloud/v1"), models: ["mail-m"] },
      }).catch((e: Error) => ({ error: e.message }));
      let picked = "";
      await waitFor(async () => {
        const listed = (await relayCall(computerRuntime, "engine.list", {}).catch(() => ({}))) as { engines?: Array<{ id: string; models: Array<{ id: string }> }> };
        return (picked = listed.engines?.find((e) => e.id === "caveman")?.models.find((m) => m.id.endsWith("/mail-m"))?.id ?? "") !== "";
      }, 60_000, 250).catch(() => undefined);
      const seenBefore = live.length;
      const againAt = Date.now();
      const again = await relayCall(computerRuntime, "turn.submit", { request_id: `story-new-again-${name}`, session_id: session, kind: "followup", input: { text: "hello again" }, options: { engine: "caveman", model: picked } }).catch((e: Error) => ({ error: e.message }));
      await waitFor(() => live.slice(seenBefore).some(({ event }) => isAnswer(event) || event.type === "turn.done"), 180_000, 50).catch(() => undefined);
      const answered = live.slice(seenBefore).find(({ event }) => isAnswer(event));
      followup = { account, model: picked, sent: again, first_token_ms: answered ? answered.ms - (againAt - sentAt) : null, first_token: answered?.event.type ?? null };
      expect.soft(answered, "with the lab's model added, the chat's next message answers on the new computer").toBeDefined();
    } else expect.soft(token, "the first token of the answer arrives").toBeDefined();
    ended?.();
    step("9_new_chat_in_cloud", {
      session,
      computer,
      driver: computerRow(computer).driver,
      placed_ms: placedMs,
      running_ms: at.running ?? null,
      linked_ms: at.linked ?? null,
      start_done_ms: at.start_done ?? null,
      first_event_ms: first?.ms ?? null,
      first_event: first?.event.type ?? null,
      first_event_in_clouds_copy_ms: at.first_event_in_clouds_copy ?? null,
      first_token_ms: token?.ms ?? null,
      first_token: token?.event.type ?? null,
      first_turn: done ?? null,
      ...(followup ? { followup } : {}),
      host_load: hostLoad(),
    });
  },
  30 * 60_000,
);
