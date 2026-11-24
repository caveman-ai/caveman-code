// The Chief's triage and cost harness (docs/chief.md), on a real runtime with a real key:
// 30 fixed notes, each labelled with the action the Chief should take and its project,
// typed one at a time over three fixture repositories. It reports triage accuracy, the
// Chief's tokens per note, how much of the Chief's input came from cache, how much of each
// fan-out sibling's first turn came from cache, the Chief's spend as a share of the spend
// of the chats it started, how many of its chats' turns opened with the report the crew contract
// asks for, and how often a wake still sent the Chief to chat_digest. Targets are labelled
// targets, not claims; report n with them.
//
// Usage (a runtime already serving, the Caveman engine signed in; its chats really run):
//   node scripts/chief-eval.ts <ws-url> <token-file> <work-dir>
// Writes <work-dir>/chief-eval.json. Without a key it writes { blocked } and exits 2.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";

import { reportOf } from "../src/chief/prompt.ts";
import { textingProblems } from "../src/chief/texting.ts";

const [url, tokenFile, workDir] = process.argv.slice(2);
if (!url || !tokenFile || !workDir) throw new Error("usage: chief-eval.ts <ws-url> <token-file> <work-dir>");
const c = connect(url, fs.readFileSync(tokenFile, "utf8").trim());
const id = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(workDir, { recursive: true });
const out = path.join(workDir, "chief-eval.json");

type Action = "answer" | "queue" | "start" | "steer" | "remember" | "ask";
type Repo = "web" | "api" | "docs";
interface Note {
  readonly text: string;
  readonly action: Action;
  /** The project its action should name; absent: not checked (a note about the person, a question). */
  readonly project?: Repo;
}

// Starts first, so the steers later have chats to steer; questions last, so there is a board to answer from.
const NOTES: ReadonlyArray<Note> = [
  { text: "The login button on the web app is misaligned on mobile; fix it.", action: "start", project: "web" },
  { text: "Add a /health endpoint to the API that returns the git sha.", action: "start", project: "api" },
  { text: "The setup guide in the docs still says Node 18; bump it to Node 22.", action: "start", project: "docs" },
  { text: "Add pagination to GET /orders in the API.", action: "start", project: "api" },
  { text: "Write a docs page for the new /health endpoint.", action: "start", project: "docs" },
  { text: "Try two independent approaches to making the cart page in the web app render faster: two chats in parallel, same brief.", action: "start", project: "web" },
  { text: "In the web app, show an empty-cart message when the cart has no items.", action: "start", project: "web" },
  { text: "At some point the API should move from log to slog. Not now.", action: "queue", project: "api" },
  { text: "Someday: dark mode for the web app. Park it.", action: "queue", project: "web" },
  { text: "Later this month the docs need a glossary. Just keep it on the list.", action: "queue", project: "docs" },
  { text: "Not urgent: the API's error messages could be friendlier. Put it in the queue.", action: "queue", project: "api" },
  { text: "Queue this, don't start it: a changelog page for the docs.", action: "queue", project: "docs" },
  { text: "Low priority, keep it for later: the web app's favicon is blurry.", action: "queue", project: "web" },
  { text: "Remember: the API never uses an ORM, plain SQL only.", action: "remember", project: "api" },
  { text: "Remember that docs pages are written in the second person, present tense.", action: "remember", project: "docs" },
  { text: "Keep in mind for every web app change: we support Safari 16 and up.", action: "remember", project: "web" },
  { text: "Remember: I review every pull request myself before it merges.", action: "remember" },
  { text: "For the record, the web app's colors live in src/tokens.ts and nothing should hardcode a color.", action: "remember", project: "web" },
  { text: "For the login button fix: also check the tablet breakpoint.", action: "steer", project: "web" },
  { text: "Tell the /health chat to include the build time too.", action: "steer", project: "api" },
  { text: "The pagination chat should use cursor pagination, not offsets.", action: "steer", project: "api" },
  { text: "The Node bump chat: also update the CI example in the setup guide.", action: "steer", project: "docs" },
  { text: "Empty cart message: make the copy say exactly 'Your cart is empty.'", action: "steer", project: "web" },
  { text: "Change it back.", action: "ask" },
  { text: "Make the thing we talked about faster.", action: "ask" },
  { text: "Use the other one instead.", action: "ask" },
  { text: "What's running right now?", action: "answer" },
  { text: "Which chats are waiting on me?", action: "answer" },
  { text: "How many items are in the queue?", action: "answer" },
  { text: "Has anything finished yet?", action: "answer" },
];

const repo = (name: string, files: Record<string, string>) => {
  const dir = path.join(workDir, `${name}-${Date.now()}`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=eval@caveman.so", "-c", "user.name=eval", "commit", "-qm", "fixture"], { cwd: dir });
  return dir;
};

const READS = new Set(["chat_digest", "memory_sql", "chat_search", "playbook", "view_list"]);
interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** The action a note's turn took, by its tool calls; reads alone (or closing the note) are an answer. */
const actionOf = (calls: ReadonlyArray<Call>): Action | "drop" => {
  const names = calls.map((call) => call.name).filter((name) => !READS.has(name));
  if (names.includes("remember")) return "remember";
  if (names.includes("chat_send")) return "steer";
  if (names.includes("chat_start")) return "start";
  if (names.includes("ask")) return "ask";
  if (names.includes("queue_drop") || calls.some((call) => call.name === "queue_update" && call.input.state === "dropped")) return "drop";
  const closes = (call: Call) => call.name === "queue_update" && call.input.state === "done" && call.input.project_ids === undefined && call.input.title === undefined;
  if (calls.some((call) => !READS.has(call.name) && !closes(call))) return "queue";
  return "answer";
};

const total = (u: Extract<SessionEvent, { type: "usage" }>["payload"]) => u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
const share = (rows: ReadonlyArray<Extract<SessionEvent, { type: "usage" }>["payload"]>) => {
  const all = rows.reduce((n, u) => n + total(u), 0);
  return all === 0 ? null : rows.reduce((n, u) => n + u.cache_read_tokens, 0) / all;
};
const usd = (rows: ReadonlyArray<Extract<SessionEvent, { type: "usage" }>["payload"]>) => rows.reduce((n, u) => n + (u.cost?.usd ?? 0), 0);
const usages = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "usage" ? [e.payload] : []));

const chief = await c.call("chief.get", {});
if (chief.availability !== "ready") {
  fs.writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), blocked: `The Chief is ${chief.availability}: no key or credits for the Caveman engine.` }, null, 2)}\n`);
  console.error(`BLOCKED: the Chief is ${chief.availability}`);
  c.close();
  process.exit(2);
}

const dirs: Record<Repo, string> = {
  web: repo("shop-web", {
    "README.md": "# shop-web\n\nThe shop's web app (React).\n",
    "package.json": `${JSON.stringify({ name: "shop-web", private: true, scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/Login.tsx": "export const Login = () => <form className=\"login\"><button className=\"login-button\">Log in</button></form>;\n",
    "src/Cart.tsx": "export const Cart = ({ items }: { items: string[] }) => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;\n",
    "src/tokens.ts": "export const colors = { ink: \"#111\", paper: \"#fff\" };\n",
  }),
  api: repo("shop-api", {
    "README.md": "# shop-api\n\nThe shop's HTTP API (Go).\n",
    "go.mod": "module shop-api\n\ngo 1.23\n",
    "main.go": "package main\n\nimport (\n\t\"log\"\n\t\"net/http\"\n)\n\nfunc main() {\n\thttp.HandleFunc(\"/orders\", orders)\n\tlog.Fatal(http.ListenAndServe(\":8080\", nil))\n}\n",
    "orders.go": "package main\n\nimport \"net/http\"\n\nfunc orders(w http.ResponseWriter, r *http.Request) { w.Write([]byte(\"[]\")) }\n",
  }),
  docs: repo("shop-docs", {
    "README.md": "# shop-docs\n\nThe shop's documentation site (Markdown).\n",
    "docs/setup.md": "# Setup\n\nInstall Node 18, then run `npm install`.\n\n```yaml\n# CI\nnode-version: 18\n```\n",
    "docs/api.md": "# API\n\n`GET /orders` lists orders.\n",
  }),
};
// A project by id, or by the name the Chief's tools also take.
const repoOf = new Map<string, Repo>();
for (const [name, dir] of Object.entries(dirs) as Array<[Repo, string]>) {
  const project = await c.call("project.create", { request_id: id(), path: dir });
  repoOf.set(project.id, name).set(project.name, name);
}

const events: Array<SessionEvent> = [];
await c.attach(chief.workspace.session_id, 0, (e) => events.push(e));
await sleep(1_000);
const firstNew = events.length;

/** Quiet: the Chief is between turns and has been for a while (a wake is debounced 3s). */
const quiet = async (ms = 4_000, deadline = Date.now() + 5 * 60_000) => {
  for (;;) {
    const between = events.findLastIndex((e) => e.type === "turn.done") >= events.findLastIndex((e) => e.type === "turn.started");
    const last = events.at(-1);
    if ((between && (last === undefined || Date.now() - Date.parse(last.at) >= ms)) || Date.now() > deadline) return;
    await sleep(500);
  }
};

const workspaceRepo = new Map<string, Repo | undefined>();
const repoOfWorkspace = async (workspaceId: string) => {
  if (!workspaceRepo.has(workspaceId)) {
    const w = await c.call("workspace.get", { workspace_id: workspaceId }).catch(() => undefined);
    workspaceRepo.set(workspaceId, w?.project_id ? repoOf.get(w.project_id) : undefined);
  }
  return workspaceRepo.get(workspaceId);
};
const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

const results: Array<{ note: string; expected: Action; got: Action | "drop"; project?: Repo; got_projects: Array<string>; ok: boolean; tools: Array<string>; replies: Array<{ text: string; texting_problems: ReturnType<typeof textingProblems> }> }> = [];
for (const note of NOTES) {
  await quiet();
  await c.call("chief.capture", { request_id: id(), text: note.text, mode: "decide" });
  const deadline = Date.now() + 3 * 60_000;
  let from = -1;
  let to = -1;
  while (Date.now() < deadline && to < 0) {
    if (from < 0) from = events.findIndex((e, i) => i >= firstNew && e.type === "message.done" && e.payload.role === "user" && e.payload.text === note.text);
    if (from >= 0) to = events.findIndex((e, i) => i > from && e.type === "turn.done");
    if (to < 0) await sleep(500);
  }
  const window = from < 0 ? [] : events.slice(from, to < 0 ? undefined : to + 1);
  // On a Claude plan the Chief's tools come through Claude Code's MCP server, named mcp__chief__<tool>, and each call's
  // tool.started comes twice (first with no input yet): one call per item, its last input.
  const byItem = new Map<string, Call>();
  for (const [i, e] of window.entries()) {
    if (e.type === "tool.started") byItem.set(e.item_id ?? `#${i}`, { name: e.payload.name.replace(/^mcp__chief__/, ""), input: (e.payload.input ?? {}) as Record<string, unknown> });
  }
  const calls = [...byItem.values()];
  const got = actionOf(calls);
  const named = new Set<Repo | undefined>();
  for (const call of calls) {
    if (call.name === "chat_start" || call.name === "queue_add" || call.name === "queue_update") for (const pid of ids(call.input.project_ids)) named.add(repoOf.get(pid));
    if (call.name === "remember" && typeof call.input.repo === "string") named.add(repoOf.get(call.input.repo));
    if (call.name === "chat_send" && typeof call.input.workspace_id === "string") named.add(await repoOfWorkspace(call.input.workspace_id));
  }
  const projectOk = note.project === undefined || (named.size > 0 && [...named].every((r) => r === note.project));
  const replies = window.flatMap((e) => e.type === "message.done" && e.payload.role === "assistant" ? [{ text: e.payload.text, texting_problems: textingProblems(e.payload.text) }] : []);
  const row = { note: note.text, expected: note.action, got, ...(note.project ? { project: note.project } : {}), got_projects: [...named].map((r) => r ?? "unknown"), ok: got === note.action && projectOk, tools: calls.map((call) => call.name), replies };
  results.push(row);
  console.log(`${row.ok ? "ok  " : "MISS"} ${note.action.padEnd(8)} -> ${got.padEnd(8)} ${row.got_projects.join(",") || "-"}  ${note.text}`);
  for (const reply of replies) for (const problem of reply.texting_problems) console.log(`  texting ${problem.rule}: ${problem.at}`);
}

// Let the chats it started finish (or stop on a question), so their spend is in.
const board = async () => (await c.call("chief.items.list", {})).items;
const started = async () => [...new Set((await board()).flatMap((i) => i.workspace_ids))];
const settledBy = Date.now() + 15 * 60_000;
while (Date.now() < settledBy) {
  const all = (await c.call("workspace.list", {})).workspaces;
  const mine = new Set(await started());
  if (all.filter((w) => mine.has(w.id)).every((w) => ["idle", "needs_input", "failed", "parked", "archived"].includes(w.status))) break;
  await sleep(5_000);
}
await quiet();

const chiefUsage = usages(events.slice(firstNew));
const chats: Array<{ workspace_id: string; item_id: string; project?: Repo; usage: ReturnType<typeof usages>; turns: number; reported: number }> = [];
for (const item of await board()) {
  for (const workspaceId of item.workspace_ids) {
    const w = await c.call("workspace.get", { workspace_id: workspaceId }).catch(() => undefined);
    if (!w) continue;
    const chatEvents: Array<SessionEvent> = [];
    await c.attach(w.session_id, 0, (e) => chatEvents.push(e));
    await sleep(300);
    const project = w.project_id ? repoOf.get(w.project_id) : undefined;
    // Each finished turn's last answer, and whether it opened with a report (crewContract).
    const answers: Array<string> = [];
    let last: string | undefined;
    for (const e of chatEvents) {
      if (e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.trim() !== "") last = e.payload.text;
      if (e.type === "turn.done" && e.payload.status === "completed" && last !== undefined) {
        answers.push(last);
        last = undefined;
      }
    }
    chats.push({ workspace_id: workspaceId, item_id: item.id, ...(project ? { project } : {}), usage: usages(chatEvents), turns: answers.length, reported: answers.filter((a) => reportOf(a) !== undefined).length });
  }
}
// A sibling: a chat after the first of its item in the same project (the fan-out hold makes it wait for the first's cache).
const seen = new Set<string>();
const siblings = chats.filter((chat) => {
  const key = `${chat.item_id}\0${chat.project}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
});
const siblingFirst = siblings.flatMap((chat) => (chat.usage[0] ? [{ workspace_id: chat.workspace_id, cache_read_share: share([chat.usage[0]]) }] : []));
const chiefUsd = usd(chiefUsage);
const chatsUsd = chats.reduce((n, chat) => n + usd(chat.usage), 0);
const correct = results.filter((r) => r.ok).length;
const laterShare = share(chiefUsage.slice(1));
const chatTurns = chats.reduce((n, chat) => n + chat.turns, 0);
const reportShare = chatTurns === 0 ? null : chats.reduce((n, chat) => n + chat.reported, 0) / chatTurns;
const wakes = events.slice(firstNew).filter((e) => e.type === "notification" && /changed/.test(e.payload.title)).length;
const digests = events.slice(firstNew).filter((e) => e.type === "tool.started" && /chat_digest$/.test(e.payload.name)).length;
const overhead = chatsUsd === 0 ? null : chiefUsd / chatsUsd;
const report = {
  at: new Date().toISOString(),
  models: [...new Set(chiefUsage.map((u) => u.model))],
  billing: [...new Set(chiefUsage.map((u) => u.billing ?? "unknown"))],
  n: results.length,
  accuracy: correct / results.length,
  by_action: Object.fromEntries((["answer", "queue", "start", "steer", "remember", "ask"] as const).map((a) => [a, `${results.filter((r) => r.expected === a && r.ok).length}/${results.filter((r) => r.expected === a).length}`])),
  chief_turns: chiefUsage.length,
  chief_tokens_per_note: chiefUsage.reduce((n, u) => n + total(u) + u.output_tokens, 0) / results.length,
  chief_cache_read_share_from_second_turn: laterShare,
  sibling_first_turn_cache_read_share: siblingFirst,
  chief_usd: chiefUsd,
  chats_usd: chatsUsd,
  chats: chats.length,
  chat_turns: chatTurns,
  chat_report_share: reportShare,
  wakes,
  chief_digests_per_wake: wakes === 0 ? null : digests / wakes,
  chief_answers: events.slice(firstNew).filter((e) => e.type === "tool.started" && /chat_answer$/.test(e.payload.name)).length,
  chief_overhead: overhead,
  targets: {
    "accuracy >= 0.90": correct / results.length >= 0.9,
    "chief overhead <= 0.03": overhead === null ? null : overhead <= 0.03,
    "chief turns from the second read >= 0.80 from cache": laterShare === null ? null : laterShare >= 0.8,
    "chat turns opening with a report >= 0.90": reportShare === null ? null : reportShare >= 0.9,
  },
  notes: results,
};
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, notes: undefined }, null, 2));
c.close();
