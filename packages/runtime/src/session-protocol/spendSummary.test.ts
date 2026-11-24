// spend.summary over a long journal: Settings > Usage re-reads it,
// so a re-read parses only usage events added since the last one, and a new
// secret still reaches every row.
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";
import { appProxyHome, setAppProxyHome } from "../router/proxyLauncher.ts";
import { proxySession } from "../router/cavemanRouter.ts";

let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let config: Awaited<ReturnType<typeof makeConfig>>;

beforeAll(async () => {
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
});

const MODEL_SECRET = "mdl-7Hq2Lx9Pv4Kz";

function journal(sessionId: string, from: number, count: number, model = "claude-haiku-5-5") {
  const db = new DatabaseSync(config.dbPath);
  try {
    const insert = db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let i = from; i < from + count; i++) {
      const at = new Date(Date.UTC(2026, 9, 16, 0, 0, i % 60)).toISOString();
      const payload = { engine: "claude-agent", model, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 0, cost: { usd: 0.001, basis: "list_price" } };
      insert.run(sessionId, i, "usage", at, JSON.stringify({ session_id: sessionId, cursor: i, at, type: "usage", payload }));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

test("re-reads count new usage only once, stay fast on a long journal, and re-scrub after a new secret", async () => {
  const repo = makeRepo(tempRoot("sp-spend-"), { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "spend-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const N = 20_000;
  journal(w.session_id, 1_000_000, N);
  const row = async () => (await client.call("spend.summary", { group_by: "workspace" })).rows.find((r) => r.key === w.id)!;

  const t0 = performance.now();
  const first = await row();
  const firstMs = performance.now() - t0;
  expect(first.input_tokens).toBe(N * 100);
  expect(first).toMatchObject({ saved_tokens: 0, saved_usd: null, saved_usd_partial: false });

  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    expect((await row()).input_tokens).toBe(N * 100);
    times.push(performance.now() - t);
  }
  const reread = times.sort((a, b) => a - b)[2]!;
  const base: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await client.call("settings.get", {});
    base.push(performance.now() - t);
  }
  console.log(
    `[w6b-timing] spend.summary over ${N} usage events: first ${firstMs.toFixed(0)} ms, re-read median ${reread.toFixed(1)} ms (a settings.get round trip: ${base.sort((a, b) => a - b)[2]!.toFixed(1)} ms)`,
  );

  // Cached: a re-read never parses rows it already has. Rewriting an old row in place (the journal is
  // append-only, so only a test does this) must not show; a cache that re-parses would count it.
  const db = new DatabaseSync(config.dbPath);
  try {
    db.prepare("UPDATE caveman_sp_events SET event = replace(event, '\"input_tokens\":100', '\"input_tokens\":999') WHERE session_id = ? AND cursor = ?").run(w.session_id, 1_000_000);
  } finally {
    db.close();
  }
  expect((await row()).input_tokens).toBe(N * 100);

  // Added since: counted once, however often it is read.
  journal(w.session_id, 2_000_000, 10, MODEL_SECRET);
  expect((await row()).input_tokens).toBe((N + 10) * 100);
  expect((await row()).input_tokens).toBe((N + 10) * 100);
  const byModel = await client.call("spend.summary", { group_by: "model" });
  expect(byModel.rows.some((r) => r.key === MODEL_SECRET)).toBe(true);

  // A value stored as a secret afterwards is scrubbed from rows read before it existed.
  await client.call("secret.set", { request_id: "spend-secret", repo: { path: repo }, secrets: [{ name: "MODEL_NAME", value: MODEL_SECRET }] });
  const after = await client.call("spend.summary", { group_by: "model" });
  expect(after.rows.some((r) => r.key === MODEL_SECRET)).toBe(false);
  // Parsed again from the start: the row rewritten above now counts.
  expect(after.rows.reduce((n, r) => n + r.input_tokens, 0)).toBe((N + 10) * 100 + 899);

  // Date bounds still apply.
  const none = await client.call("spend.summary", { group_by: "workspace", from: "2027-01-01T00:00:00.000Z" });
  expect(none.rows.find((r) => r.key === w.id)).toBeUndefined();
}, 120_000);

test("by project, with plan, unpriced and list-price rows apart, median latencies, and memory dreams on their own", async () => {
  const repo = makeRepo(tempRoot("sp-spend-project-"), { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "spend-project-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const db = new DatabaseSync(config.dbPath);
  try {
    const insert = db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)");
    const rows: Array<Record<string, unknown>> = [
      { engine: "claude-agent", model: "plan-model", billing: "plan", cost: null, ttft_ms: 900, duration_ms: 4000 },
      { engine: "codex", model: "codex-model", billing: "api_key", cost: { usd: 0.5, basis: "list_price" }, ttft_ms: 300, duration_ms: 2000 },
      { engine: "caveman", model: "custom-local/qwen", billing: "api_key", cost: null, ttft_ms: 100, duration_ms: 1000 },
    ];
    rows.forEach((extra, i) => {
      const at = new Date(Date.UTC(2026, 9, 17, 0, 0, i)).toISOString();
      const payload = { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, ...extra };
      insert.run(w.session_id, 3_000_000 + i, "usage", at, JSON.stringify({ session_id: w.session_id, cursor: 3_000_000 + i, at, type: "usage", payload }));
    });
    db.prepare("INSERT INTO caveman_sp_spend (at, workspace_id, usage) VALUES (?, ?, ?)").run(
      "2026-10-17T00:00:09.000Z",
      "memory",
      JSON.stringify({ engine: "caveman", bucket: "memory", model: "openai/gpt-6-luna", input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.01, basis: "list_price" } }),
    );
  } finally {
    db.close();
  }
  const byModel = (await client.call("spend.summary", { group_by: "model", from: "2026-10-17T00:00:00.000Z" })).rows;
  expect(byModel.find((r) => r.key === "plan-model")).toMatchObject({ basis: "plan", measured_usd: null, p50_ttft_ms: 900, p50_turn_ms: 4000 });
  expect(byModel.find((r) => r.key === "codex-model")).toMatchObject({ basis: "list_price", measured_usd: 0.5 });
  expect(byModel.find((r) => r.key === "custom-local/qwen")).toMatchObject({ basis: "unpriced", measured_usd: null });
  const byProject = (await client.call("spend.summary", { group_by: "project", from: "2026-10-17T00:00:00.000Z" })).rows;
  const project = byProject.find((r) => r.bucket === undefined)!;
  expect(project.label).toBe(repo.split("/").pop());
  expect(project).toMatchObject({ input_tokens: 30, basis: "mixed", measured_usd: 0.5, p50_ttft_ms: 300, p50_turn_ms: 2000 });
  expect(byProject.find((r) => r.bucket === "dream")).toMatchObject({ key: "dream", label: "Memory dreams", measured_usd: 0.01 });
});

test("web searches total beside the tokens, as a count only: the cost stays the turns' own", async () => {
  const repo = makeRepo(tempRoot("sp-spend-search-"), { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "spend-search-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const db = new DatabaseSync(config.dbPath);
  try {
    const insert = db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)");
    const rows: Array<Record<string, unknown>> = [
      { engine: "claude-agent", model: "claude-sonnet-4-6", billing: "plan", cost: null, web_searches: 2 },
      { engine: "claude-agent", model: "claude-sonnet-4-6", billing: "plan", cost: null, web_searches: 3 },
      { engine: "claude-agent", model: "claude-sonnet-4-6", billing: "plan", cost: null },
      { engine: "codex", model: "gpt-6.1-sol", billing: "api_key", cost: { usd: 0.25, basis: "list_price" } },
    ];
    rows.forEach((extra, i) => {
      const at = new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString();
      const payload = { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, ...extra };
      insert.run(w.session_id, 4_000_000 + i, "usage", at, JSON.stringify({ session_id: w.session_id, cursor: 4_000_000 + i, at, type: "usage", payload }));
    });
  } finally {
    db.close();
  }
  const from = "2026-10-18T00:00:00.000Z";
  const byEngine = (await client.call("spend.summary", { group_by: "engine", from })).rows;
  expect(byEngine.find((r) => r.key === "claude-agent")).toMatchObject({ web_searches: 5, input_tokens: 30, measured_usd: null, basis: "plan" });
  const codex = byEngine.find((r) => r.key === "codex")!;
  expect(codex).toMatchObject({ measured_usd: 0.25 });
  expect(codex).not.toHaveProperty("web_searches");
  const byWorkspace = (await client.call("spend.summary", { group_by: "workspace", from })).rows;
  expect(byWorkspace.find((r) => r.key === w.id)).toMatchObject({ web_searches: 5, measured_usd: 0.25 });
});

test("web searches: their own row by engine and project, in their chat's row by workspace, estimated or billed", async () => {
  const repo = makeRepo(tempRoot("sp-spend-web-"), { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "spend-web-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const db = new DatabaseSync(config.dbPath);
  try {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString();
    const search = (model: string, cost: { usd: number; basis: string }) =>
      JSON.stringify({ engine: "caveman", bucket: "web", model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost, ...(cost.basis === "list_price" ? { billing: "api_key" } : {}), searches: 1 });
    const insert = db.prepare("INSERT INTO caveman_sp_spend (at, workspace_id, usage) VALUES (?, ?, ?)");
    insert.run(at(1), w.id, search("Brave Search", { usd: 0.005, basis: "list_price" }));
    insert.run(at(2), w.id, search("Brave Search", { usd: 0.005, basis: "list_price" }));
    insert.run(at(3), w.id, search("Perplexity on Caveman credits", { usd: 0.006, basis: "billed" }));
  } finally {
    db.close();
  }
  const from = "2026-10-18T00:00:00.000Z";
  const byEngine = (await client.call("spend.summary", { group_by: "engine", from })).rows;
  expect(byEngine.find((r) => r.key === "web")).toMatchObject({ label: "Web search", bucket: "web", web_searches: 3, input_tokens: 0, basis: "mixed" });
  expect(byEngine.find((r) => r.key === "web")!.measured_usd).toBeCloseTo(0.016);
  expect(byEngine.find((r) => r.key === "caveman")).toBeUndefined();
  const byWorkspace = (await client.call("spend.summary", { group_by: "workspace", from })).rows;
  expect(byWorkspace.find((r) => r.key === w.id)).toMatchObject({ web_searches: 3 });
  expect(byWorkspace.find((r) => r.key === "web")).toBeUndefined();
  const byModel = (await client.call("spend.summary", { group_by: "model", from })).rows;
  expect(byModel.find((r) => r.key === "Brave Search")).toMatchObject({ basis: "list_price", measured_usd: 0.01, web_searches: 2 });
  expect(byModel.find((r) => r.key === "Perplexity on Caveman credits")).toMatchObject({ basis: "billed", measured_usd: 0.006, web_searches: 1 });
});

test("compression evidence follows chat, engine, project, model and day, with plan dollars kept inferred", async () => {
  const repo = makeRepo(tempRoot("sp-savings-project-"), { "README.md": "hi\n" });
  const keyChat = await client.call("workspace.create", { request_id: "savings-key", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const planChat = await client.call("workspace.create", { request_id: "savings-plan", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const at = "2026-10-21T01:00:00.000Z";
  const store = new DatabaseSync(config.dbPath);
  const threads = new Map<string, string>();
  try {
    const insert = store.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, 'usage', ?, ?)");
    for (const [chat, cost, billing] of [[keyChat, { usd: 1, basis: "list_price" }, "api_key"], [planChat, null, "plan"]] as const) {
      threads.set(chat.id, String(store.prepare("SELECT thread_id FROM caveman_sp_workspaces WHERE id = ?").get(chat.id)!.thread_id));
      const payload = { engine: "claude-agent", model: "caveman-auto", input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost, billing };
      insert.run(chat.session_id, 4_000_000, at, JSON.stringify({ session_id: chat.session_id, cursor: 4_000_000, type: "usage", at, payload }));
    }
  } finally {
    store.close();
  }
  const home = tempRoot("sp-savings-proxy-");
  const db = new DatabaseSync(path.join(home, "caveman.db"));
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, provider TEXT, ts TEXT, input_tokens INTEGER, cached_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_creation_1h_tokens INTEGER, request_tokens_before INTEGER,
    request_tokens_after INTEGER, request_estimated_input_delta_usd REAL, request_measurement_status TEXT)`);
  const add = db.prepare("INSERT INTO requests VALUES (NULL, ?, 'claude-opus-5-5', 'anthropic', ?, 1000, 0, 0, 0, 1000, 900, ?, 'measured')");
  add.run(proxySession(threads.get(keyChat.id)!), "2026-10-21 01:00:00.000", 0.2);
  add.run(proxySession(threads.get(planChat.id)!), at, 0.3);
  add.run("unowned-thread", at, 99);
  add.run(proxySession(threads.get(keyChat.id)!), "2026-10-17 01:00:00.000", 99);
  db.close();
  const previous = appProxyHome();
  setAppProxyHome(home);
  try {
    for (const group_by of ["workspace", "engine", "project", "model", "day"] as const) {
      const result = await client.call("spend.summary", { group_by, from: "2026-10-21T00:00:00.000Z", to: "2026-10-21T23:59:59.999Z" });
      expect(result).toMatchObject({ saved_tokens: 200, saved_usd: 0.5, saved_usd_partial: false, verified_usd: null });
      expect(result.rows.reduce((sum, row) => sum + row.saved_tokens, 0)).toBe(200);
      expect(result.rows.reduce((sum, row) => sum + (row.saved_usd ?? 0), 0)).toBeCloseTo(0.5);
      if (group_by === "workspace") {
        expect(result.rows.find((r) => r.key === keyChat.id)).toMatchObject({ measured_usd: 1, saved_usd: 0.2, saved_tokens: 100, basis: "list_price" });
        expect(result.rows.find((r) => r.key === planChat.id)).toMatchObject({ measured_usd: null, saved_usd: 0.3, saved_tokens: 100, basis: "plan" });
      }
      if (group_by === "model") {
        expect(result.rows).toMatchObject([{ key: "caveman-auto", measured_usd: 1, saved_usd: 0.5, saved_tokens: 200 }]);
        expect(result.rows).toHaveLength(1);
      }
    }
    // A second read must not count the same requests twice.
    expect(await client.call("spend.summary", { group_by: "engine", from: "2026-10-21T00:00:00.000Z" })).toMatchObject({ saved_tokens: 200, saved_usd: 0.5 });
    const proxy = new DatabaseSync(path.join(home, "caveman.db"));
    proxy.prepare("INSERT INTO requests VALUES (NULL, ?, 'unpriced-model', 'custom', ?, 1000, 0, 0, 0, 1000, 900, NULL, 'measured')")
      .run(proxySession(threads.get(keyChat.id)!), at);
    proxy.close();
    const partial = await client.call("spend.summary", { group_by: "workspace", from: "2026-10-21T00:00:00.000Z" });
    expect(partial).toMatchObject({ saved_tokens: 300, saved_usd: 0.5, saved_usd_partial: true });
    expect(partial.rows.find((r) => r.key === keyChat.id)).toMatchObject({ saved_usd: 0.2, saved_usd_partial: true });
    // Multiple usage models: no unique chat-model attribution, so keep the proxy models.
    const journal = new DatabaseSync(config.dbPath);
    const payload = { engine: "claude-agent", model: "second-model", input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: null, billing: "api_key" };
    journal.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, 'usage', ?, ?)")
      .run(keyChat.session_id, 4_000_001, at, JSON.stringify({ session_id: keyChat.session_id, cursor: 4_000_001, type: "usage", at, payload }));
    journal.close();
    const multiple = await client.call("spend.summary", { group_by: "model", from: "2026-10-21T00:00:00.000Z" });
    expect(multiple.rows.find((r) => r.key === "claude-opus-5-5")).toMatchObject({ saved_tokens: 100, saved_usd: 0.2 });
    expect(multiple.rows.find((r) => r.key === "unpriced-model")).toMatchObject({ saved_tokens: 100, saved_usd: null, saved_usd_partial: true });
    expect(multiple.rows.find((r) => r.key === "caveman-auto")).toMatchObject({ saved_tokens: 100, saved_usd: 0.3 });
  } finally {
    setAppProxyHome(previous);
  }
});
