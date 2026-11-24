// This Mac's usage reports: nothing leaves until the runtime is signed in, nothing from before the
// sign-in, only tokens, cost, model and engine per call, in batches of 100; a failure resends the same
// events next time, a fork's copies of its source's events are not sent twice, and side calls count.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, expect, test } from "vitest";

import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as Store from "../session-protocol/store.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "../session-protocol/testHarness.ts";
import { KEY_FILE, RECORD_FILE } from "./identity.ts";
import { flushUsage } from "./usageReporter.ts";

const root = tempRoot("usage-reporter-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const SIGNED_IN = Date.UTC(2026, 9, 16, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function signIn(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const ids = { runtime_id: crypto.randomUUID(), organization_id: crypto.randomUUID(), computer_id: crypto.randomUUID() };
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ cloud_url: "https://cloud.test", ...ids }));
  fs.writeFileSync(path.join(dir, KEY_FILE), crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.utimesSync(path.join(dir, RECORD_FILE), new Date(SIGNED_IN), new Date(SIGNED_IN));
}

function fakeCloud() {
  const batches: Array<Array<Record<string, unknown>>> = [];
  let failNext = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/token")) return Response.json({ token: "ccrt_test", expires_at: "2099-01-01T00:00:00Z" });
    expect(pathname).toBe("/api/v1/code/runtime/local-usage");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ccrt_test");
    if (failNext) {
      failNext = false;
      return Response.json({ error: { code: "cave_internal", message: "down" } }, { status: 503 });
    }
    const { events } = JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> };
    batches.push(events);
    return Response.json({ accepted: events.length, duplicates: 0, refused: [] });
  }) as typeof fetch;
  return { batches, fetchImpl, failOnce: () => (failNext = true) };
}

test("reports signed-in usage once, in batches, tokens and cost only", async () => {
  const config = await makeConfig();
  let sessions!: Store.SessionStore["Service"];
  let secrets!: ProjectSecrets["Service"];
  const capture = Layer.effectDiscard(
    Effect.gen(function* () {
      sessions = yield* Store.SessionStore;
      secrets = yield* ProjectSecrets;
    }),
  ).pipe(Layer.provide(Store.layer)) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: capture });
  const client = connect(runtime.url, runtime.token);
  try {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await client.call("workspace.create", { request_id: "usage-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
    const db = new DatabaseSync(config.dbPath);
    const usage = (sessionId: string, cursor: number, at: number, cost: { usd: number; basis: "list_price" } | null = { usd: 0.002, basis: "list_price" }) => {
      const payload = { engine: "claude-agent", model: "claude-haiku-5-5", input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 1, cost, billing: "api_key", ttft_ms: 300 };
      db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, 'usage', ?, ?)").run(
        sessionId,
        cursor,
        iso(at),
        JSON.stringify({ session_id: sessionId, cursor, at: iso(at), type: "usage", payload }),
      );
    };
    usage(w.session_id, 1_000_000, SIGNED_IN - 3_600_000); // before the sign-in: never sent
    for (let i = 1; i <= 250; i++) usage(w.session_id, 1_000_000 + i, SIGNED_IN + 60_000, i === 2 ? null : undefined);
    db.prepare("INSERT INTO caveman_sp_spend (at, workspace_id, usage) VALUES (?, ?, ?)").run(
      iso(SIGNED_IN + 120_000),
      w.id,
      JSON.stringify({ model: "claude-haiku-5-5", input_tokens: 7, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.0001, basis: "list_price" } }),
    );
    // Web searches (web/WebTools.ts) never go: on credits Cloud billed them itself; on an own key the provider bills it.
    for (const cost of [{ usd: 0.005, basis: "list_price" }, { usd: 0.005, basis: "billed" }]) {
      db.prepare("INSERT INTO caveman_sp_spend (at, workspace_id, usage) VALUES (?, ?, ?)").run(
        iso(SIGNED_IN + 150_000),
        w.id,
        JSON.stringify({ engine: "caveman", bucket: "web", model: "Brave Search", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost, searches: 1 }),
      );
    }

    const cloud = fakeCloud();
    const linkDir = path.join(root, "cloud-link");
    const flush = (dir = linkDir) =>
      Effect.runPromise(flushUsage({ dir, state: {}, fetchImpl: cloud.fetchImpl }).pipe(Effect.provideService(Store.SessionStore, sessions), Effect.provideService(ProjectSecrets, secrets)));

    // Not signed in: nothing leaves.
    expect(await flush()).toBe(0);
    expect(cloud.batches).toEqual([]);

    signIn(linkDir);
    // Cloud failing: the same events go next time.
    cloud.failOnce();
    await expect(flush()).rejects.toThrow();
    expect(await flush()).toBe(251);
    expect(cloud.batches.map((b) => b.length)).toEqual([100, 100, 51]);
    const sent = cloud.batches.flat();
    expect(sent[0]).toEqual({
      request_id: `${w.session_id}:1000001`,
      session_id: w.session_id,
      engine: "claude-agent",
      model: "claude-haiku-5-5",
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 5,
      cache_write_tokens: 1,
      cost: { usd: 0.002, basis: "list_price" },
      occurred_at: iso(SIGNED_IN + 60_000),
    });
    expect(sent[1]!.cost).toBeNull();
    expect(sent.some((e) => e.request_id === `${w.session_id}:1000000`)).toBe(false);
    expect(sent.at(-1)).toMatchObject({ request_id: expect.stringMatching(/^spend:\d+$/), session_id: w.session_id, engine: "claude-agent", input_tokens: 7 });
    expect(new Set(sent.map((e) => e.request_id)).size).toBe(251);
    expect(sent.some((e) => e.model === "Brave Search")).toBe(false);

    // Nothing new: nothing sent.
    expect(await flush()).toBe(0);

    // A fork's copies of its source's events (cursor <= forked_from) are its source's to report.
    const source = (await Effect.runPromise(sessions.getBySession(w.session_id)))!;
    await Effect.runPromise(
      sessions.putWorkspace({
        workspace: { ...source.workspace, id: "ws-fork" },
        session: { ...source.session, id: "ses-fork", forked_from: { session_id: w.session_id, cursor: 1_000_100 } },
        internal: { ...source.internal, threadId: "thread-fork" },
      }),
    );
    usage("ses-fork", 1_000_100, SIGNED_IN + 60_000);
    usage("ses-fork", 1_000_101, SIGNED_IN + 180_000);
    cloud.batches.length = 0;
    expect(await flush()).toBe(1);
    expect(cloud.batches.flat().map((e) => e.request_id)).toEqual(["ses-fork:1000101"]);
    db.close();
  } finally {
    client.close();
    await runtime.close();
  }
}, 60_000);
