import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import type { DraftEvent } from "../session-protocol/projector.ts";
import * as SessionProtocolStore from "../session-protocol/store.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { McpHub } from "./McpHub.ts";
import { makePluginHandlers } from "./protocolHandlers.ts";
import { SANDBOX_LAUNCHER } from "./resolve.ts";
import {
  isConnectTimeout,
  layer,
  leftOut,
  serverLaunch,
  skippedUntil,
  StalledMcpServers,
  type StalledServer,
  without,
} from "./StalledMcpServers.ts";
import * as StalledMcpServersCheck from "./StalledMcpServersCheck.ts";

const TIMEOUT = 'MCP server "cua" connection timed out after 30000ms';
const HOUR = 60 * 60_000;
const servers: Record<string, McpServerConfig> = {
  "computer-use__cua": { type: "stdio", command: "/app/node", args: ["cua.mjs"], env: { TOKEN: "secret" } },
  github: { type: "http", url: "https://api.github.com/mcp", headers: { Authorization: "Bearer ghp_secret" } },
  "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" },
};
const names = Object.keys(servers);
/** A fresh CLI's reply: it added each of `of`, and `errors` says which did not connect. */
const started = (errors: Record<string, string> = {}, of: Record<string, McpServerConfig> = servers) => ({ added: Object.keys(of), errors });

/** The four store methods the service uses: kv rows and the chats' notices. */
function fakeStore(kv = new Map<string, string>(), failWrites = false, failAppends = 0) {
  const notices: Array<{ readonly session: string; readonly event: DraftEvent }> = [];
  let appendsToFail = failAppends;
  const store = {
    kvGet: (key: string) => Effect.sync(() => kv.get(key)),
    kvSet: (key: string, value: string) => (failWrites ? Effect.die(new Error("disk full")) : Effect.sync(() => void kv.set(key, value))),
    getByThread: (threadId: string) => Effect.succeed(threadId.startsWith("thread-") ? { session: { id: threadId.replace("thread-", "session-") } } : undefined),
    append: (session: string, build: (record: never) => Effect.Effect<{ readonly events: ReadonlyArray<DraftEvent>; readonly value: unknown }>) =>
      appendsToFail-- > 0 ? Effect.die(new Error("disk full")) : build(undefined as never).pipe(
        Effect.tap(({ events }) => Effect.sync(() => events.forEach((event) => notices.push({ session, event })))),
        Effect.as({ events: [], value: undefined }),
      ),
  } as unknown as SessionStore["Service"];
  return { kv, notices, layer: layer.pipe(Layer.provide(Layer.succeed(SessionStore, store))) };
}

/** One run of the runtime on `store`'s rows. */
const run = <A>(store: ReturnType<typeof fakeStore>, use: (stalled: StalledMcpServers["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(StalledMcpServers.use(use).pipe(Effect.provide(store.layer)));

const entry = (over: Partial<StalledServer> & Pick<StalledServer, "at" | "stalls">): StalledServer => ({
  server: "computer-use__cua",
  launch: serverLaunch(servers["computer-use__cua"]!),
  ...over,
});
const seeded = (...entries: ReadonlyArray<StalledServer>) => fakeStore(new Map([["mcp.stalled", JSON.stringify(entries)]]));

describe("StalledMcpServers", () => {
  it("knows Claude Code's connect timeout from its other errors", () => {
    expect(isConnectTimeout(TIMEOUT)).toBe(true);
    expect(isConnectTimeout("HTTP 401 Unauthorized")).toBe(false);
    expect(isConnectTimeout("connection refused")).toBe(false);
  });

  it("names a launch by its command, arguments or URL, never its env or headers", () => {
    const launches = Object.values(servers).map(serverLaunch);
    expect(serverLaunch({ ...servers["computer-use__cua"]!, env: { TOKEN: "rotated" } } as McpServerConfig)).toBe(launches[0]);
    expect(serverLaunch({ type: "stdio", command: "/app/node", args: ["cua-2.mjs"] })).not.toBe(launches[0]);
    // A contained server, as two chats launch it: the launcher's policy names each chat's own folders.
    const contained = (worktree: string, server: ReadonlyArray<string>): McpServerConfig => ({
      type: "stdio",
      command: "/usr/bin/env",
      args: ["-u", "NODE_OPTIONS", "/node", "--disable-sigusr1", SANDBOX_LAUNCHER, JSON.stringify({ write: [worktree] }), ...server],
    });
    expect(serverLaunch(contained("/wt/chat-1", ["/app/node", "cua.mjs"]))).toBe(serverLaunch(contained("/wt/chat-2", ["/app/node", "cua.mjs"])));
    expect(serverLaunch(contained("/wt/chat-1", ["/app/node", "cua.mjs"]))).not.toBe(serverLaunch(contained("/wt/chat-1", ["/app/node", "cua-2.mjs"])));
  });

  it("keeps a hash of a launch, never a secret in its URL or arguments", async () => {
    const secretive: Record<string, McpServerConfig> = {
      search: { type: "http", url: "https://mcp.search.dev/mcp?api_key=sk-live-url-secret" },
      db: { type: "stdio", command: "npx", args: ["-y", "@acme/db-mcp", "--token", "sk-live-arg-secret"] },
    };
    const store = fakeStore();
    await run(store, (s) => s.record("thread-waited", secretive, started({ search: TIMEOUT, db: TIMEOUT }, secretive)));
    const row = store.kv.get("mcp.stalled")!;
    expect(row).not.toContain("sk-live");
    expect(row).not.toContain("mcp.search.dev");
    expect(row).not.toContain("@acme/db-mcp");
    expect(JSON.parse(row).map((s: StalledServer) => s.launch)).toEqual([serverLaunch(secretive.search!), serverLaunch(secretive.db!)]);
    for (const launch of JSON.parse(row).map((s: StalledServer) => s.launch)) expect(launch).toMatch(/^[0-9a-f]{32}$/);
  });

  it("records a server that timed out, tells the chat that waited, and leaves it out of the next start", async () => {
    const store = fakeStore();
    await run(store, (s) => s.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT, github: "HTTP 401 Unauthorized" })));
    const list = await run(store, (s) => s.list);
    // Only the timeout: a fast failure costs no start anything.
    expect(list.map((s) => [s.server, s.stalls])).toEqual([["computer-use__cua", 1]]);
    expect(store.notices).toHaveLength(1);
    expect(store.notices[0]).toMatchObject({
      session: "session-waited",
      event: { type: "notification", payload: { level: "warning", title: "cua (computer-use) did not connect within 30 seconds, so this chat waited for it" } },
    });

    expect(leftOut(servers, list, names)).toEqual(["computer-use__cua"]);
    expect(Object.keys(without(servers, leftOut(servers, list, names)))).toEqual(["github", "t3-code"]);
    // Only the person's servers are left out, never one the caller did not name.
    expect(leftOut(servers, list, ["github"])).toEqual([]);
    // Another launch of it is tried again.
    const moved = { ...servers, "computer-use__cua": { type: "stdio", command: "/app/node", args: ["cua-2.mjs"] } } satisfies Record<string, McpServerConfig>;
    expect(leftOut(moved, list, names)).toEqual([]);
  });

  it("leaves a server out for a day after it stalls, doubling with each stall in a row, at most a week", () => {
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();
    expect(skippedUntil(entry({ at: ago(0), stalls: 1 }))).toBe(now + 24 * HOUR);
    expect(leftOut(servers, [entry({ at: ago(23), stalls: 1 })], names, now)).toEqual(["computer-use__cua"]);
    // Its day ran out: the next start tries it again.
    expect(leftOut(servers, [entry({ at: ago(25), stalls: 1 })], names, now)).toEqual([]);
    // It stalled again the time after: two days, then four, never past a week.
    expect(leftOut(servers, [entry({ at: ago(25), stalls: 2 })], names, now)).toEqual(["computer-use__cua"]);
    expect(skippedUntil(entry({ at: ago(0), stalls: 3 }))).toBe(now + 96 * HOUR);
    expect(skippedUntil(entry({ at: ago(0), stalls: 9 }))).toBe(now + 7 * 24 * HOUR);
    expect(leftOut(servers, [entry({ at: ago(7 * 24 + 1), stalls: 9 })], names, now)).toEqual([]);
  });

  it("counts a stall in a row and forgets a server once a start registers it", async () => {
    const store = seeded(entry({ at: new Date(Date.now() - 25 * HOUR).toISOString(), stalls: 1 }));
    // Its day ran out and it timed out again: two days now.
    await run(store, (s) => s.record("thread-again", servers, started({ "computer-use__cua": TIMEOUT })));
    const again = await run(store, (s) => s.list);
    expect(again.map((s) => s.stalls)).toEqual([2]);
    expect(leftOut(servers, again, names)).toEqual(["computer-use__cua"]);
    // Registered without a timeout (a Retry's next chat, a fixed server): forgotten.
    // A live CLI sending a server it already has adds nothing, and says nothing about it now.
    await run(store, (s) => s.record("thread-live", servers, { added: [], errors: {} }));
    expect(await run(store, (s) => s.list)).toHaveLength(1);
    // Added without a timeout (a Retry's next chat, a fixed server): forgotten.
    await run(store, (s) => s.record("thread-fixed", servers, started({})));
    expect(await run(store, (s) => s.list)).toEqual([]);
  });

  it("counts a timeout while a server is left out as the same stall, which its check still brings back", async () => {
    const store = fakeStore();
    await run(store, (s) => s.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT })));
    const [stall] = await run(store, (s) => s.list);
    // A start planned before the stall was known, or a live CLI sending its servers again, waited for it too.
    await run(store, (s) => s.record("thread-overlapping", servers, started({ "computer-use__cua": TIMEOUT })));
    expect(await run(store, (s) => s.list)).toEqual([stall]);
    expect(store.notices.map((n) => n.session)).toEqual(["session-waited", "session-overlapping"]);
    await run(store, (s) => s.answered(stall!));
    expect(leftOut(servers, await run(store, (s) => s.list), names)).toEqual([]);
  });

  it("tells each chat that leaves a server out, once, and not a chat already told it waited", async () => {
    const store = fakeStore();
    await run(store, (s) =>
      Effect.gen(function* () {
        yield* s.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT }));
        yield* s.tellLeftOut("thread-waited", ["computer-use__cua"]);
        yield* s.tellLeftOut("thread-later", ["computer-use__cua"]);
        yield* s.tellLeftOut("thread-later", ["computer-use__cua"]);
      }),
    );
    expect(store.notices.map((n) => [n.session, (n.event.payload as { level: string }).level])).toEqual([
      ["session-waited", "warning"],
      ["session-later", "info"],
    ]);
    expect(store.notices[1]!.event.payload).toMatchObject({
      title: "Left out cua (computer-use)",
      body: "It did not connect within 30 seconds when an earlier chat started. Retry in Plugins > MCP servers to try it in the next chat.",
    });
  });

  it("tells a chat again when its notice could not be saved", async () => {
    const store = fakeStore(new Map(), false, 1);
    await run(store, (s) =>
      Effect.gen(function* () {
        yield* s.tellLeftOut("thread-later", ["computer-use__cua"]);
        yield* s.tellLeftOut("thread-later", ["computer-use__cua"]);
        yield* s.tellLeftOut("thread-later", ["computer-use__cua"]);
      }),
    );
    expect(store.notices.map((n) => n.session)).toEqual(["session-later"]);
  });

  it("brings back a first stall that answered a check, but not one that stalled again after answering", async () => {
    const store = fakeStore();
    await run(store, (s) => s.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT })));
    const [first] = await run(store, (s) => s.list);
    await run(store, (s) => s.answered(first!));
    expect(leftOut(servers, await run(store, (s) => s.list), names)).toEqual([]);
    // The check did not predict Claude Code: it stalled again, and a check no longer brings it back.
    await run(store, (s) => s.record("thread-again", servers, started({ "computer-use__cua": TIMEOUT })));
    const [again] = await run(store, (s) => s.list);
    await run(store, (s) => s.answered(again!));
    const list = await run(store, (s) => s.list);
    expect(list.map((s) => [s.stalls, s.answered])).toEqual([[2, undefined]]);
    expect(leftOut(servers, list, names)).toEqual(["computer-use__cua"]);
  });

  it("keeps what it recorded across a restart until the server is retried", async () => {
    const store = fakeStore();
    await run(store, (s) => s.record("elsewhere", servers, started({ "computer-use__cua": TIMEOUT })));
    // A thread with no chat (no workspace record) is told nothing, and nothing fails.
    expect(store.notices).toHaveLength(0);

    const restarted = fakeStore(store.kv);
    expect((await run(restarted, (s) => s.list)).map((s) => s.server)).toEqual(["computer-use__cua"]);
    await run(restarted, (s) => s.retry("computer-use__cua"));
    expect(await run(restarted, (s) => s.list)).toEqual([]);
    expect(await run(fakeStore(restarted.kv), (s) => s.list)).toEqual([]);
  });

  it("changes nothing a start reads when the store fails to save it", async () => {
    const before = entry({ at: new Date().toISOString(), stalls: 1 });
    const store = fakeStore(new Map([["mcp.stalled", JSON.stringify([before])]]), true);
    const list = await run(store, (s) =>
      s.record("thread-unsaved", servers, started({ github: TIMEOUT })).pipe(
        Effect.andThen(Effect.exit(s.retry("computer-use__cua"))),
        Effect.andThen(Effect.exit(s.answered(before))),
        Effect.andThen(s.list),
      ),
    );
    // Neither the stall it could not save nor the retry or check it could not save: starts read what the store has.
    expect(list).toEqual([before]);
    expect(store.notices).toEqual([]);
  });

  it("starts empty from a missing or unreadable row", async () => {
    expect(await run(fakeStore(new Map([["mcp.stalled", "not json"]])), (s) => s.list)).toEqual([]);
    expect(await run(fakeStore(new Map([["mcp.stalled", '[{"server":1}]']])), (s) => s.list)).toEqual([]);
    expect(await run(fakeStore(new Map([["mcp.stalled", '[{"server":"a","launch":"b","at":"c"}]']])), (s) => s.list)).toEqual([]);
  });
});

describe("StalledMcpServersCheck", () => {
  /** The check, the service on a fake store, and a hub whose tools call answers or fails `after`, as `answers` says. */
  const checked = (answers: () => boolean, after: Duration.Input = 0) => {
    const store = fakeStore();
    const probed: Array<string> = [];
    const cutShort: Array<string> = [];
    const hub = Layer.succeed(McpHub, {
      tools: ({ server: key }: { server: string }) =>
        Effect.suspend(() => {
          probed.push(key);
          return Effect.sleep(after).pipe(
            Effect.andThen(answers() ? Effect.succeed([]) : Effect.fail("did not start and list its tools")),
            Effect.onInterrupt(() => Effect.sync(() => void cutShort.push(key))),
          );
        }),
    } as unknown as McpHub["Service"]);
    return { store, probed, cutShort, layer: StalledMcpServersCheck.layer.pipe(Layer.provideMerge(store.layer), Layer.provide(hub)) };
  };
  const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

  effectIt.effect("brings a server back when it answers through the hub a little after its stall", () => {
    const h = checked(() => true);
    return Effect.gen(function* () {
      const stalled = yield* StalledMcpServers;
      yield* settle;
      yield* stalled.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT }));
      yield* settle;
      expect(h.probed).toEqual([]);
      yield* TestClock.adjust(StalledMcpServersCheck.CHECK_AFTER);
      yield* settle;
      expect(h.probed).toEqual(["computer-use__cua"]);
      expect(leftOut(servers, yield* stalled.list, names)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  effectIt.effect("checks each first stall on its own: an earlier stall's check never brings back a newer one", () => {
    const h = checked(() => true);
    const realMs = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    return Effect.gen(function* () {
      const stalled = yield* StalledMcpServers;
      yield* settle;
      yield* stalled.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT }));
      yield* settle;
      // A minute on, the person retries it, and the next chat's start times out on it again.
      yield* TestClock.adjust("1 minute");
      yield* stalled.retry("computer-use__cua");
      yield* realMs(5);
      yield* stalled.record("thread-retried", servers, started({ "computer-use__cua": TIMEOUT }));
      yield* settle;
      // The first stall's check finds it answering, but it checked a stall that is gone.
      yield* TestClock.adjust("1 minute");
      yield* settle;
      expect(h.probed).toEqual(["computer-use__cua"]);
      expect(leftOut(servers, yield* stalled.list, names)).toEqual(["computer-use__cua"]);
      // The newer stall's own check, two minutes after it.
      yield* TestClock.adjust("1 minute");
      yield* settle;
      expect(h.probed).toEqual(["computer-use__cua", "computer-use__cua"]);
      expect(leftOut(servers, yield* stalled.list, names)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  effectIt.effect("leaves a server out when the hub gives up on it", () => {
    const h = checked(() => false, "60 seconds");
    return Effect.gen(function* () {
      const stalled = yield* StalledMcpServers;
      yield* settle;
      yield* stalled.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT }));
      yield* settle;
      yield* TestClock.adjust(StalledMcpServersCheck.CHECK_AFTER);
      yield* settle;
      yield* TestClock.adjust("60 seconds");
      yield* settle;
      expect(h.probed).toEqual(["computer-use__cua"]);
      expect(leftOut(servers, yield* stalled.list, names)).toEqual(["computer-use__cua"]);
    }).pipe(Effect.provide(h.layer));
  });

  effectIt.effect("leaves out a server that answers only after Claude Code's 30 seconds, letting the hub's call finish", () => {
    const h = checked(() => true, "45 seconds");
    return Effect.gen(function* () {
      const stalled = yield* StalledMcpServers;
      yield* settle;
      yield* stalled.record("thread-waited", servers, started({ "computer-use__cua": TIMEOUT }));
      yield* settle;
      yield* TestClock.adjust(StalledMcpServersCheck.CHECK_AFTER);
      yield* settle;
      // Past Claude Code's 30 s the hub's call goes on: cutting it short would leave its connection open.
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      expect(h.cutShort).toEqual([]);
      yield* TestClock.adjust("15 seconds");
      yield* settle;
      expect(h.probed).toEqual(["computer-use__cua"]);
      expect(h.cutShort).toEqual([]);
      expect(leftOut(servers, yield* stalled.list, names)).toEqual(["computer-use__cua"]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("StalledMcpServers on the runtime's own session store", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-stalled-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, "statev2.sqlite");
  /** One run of the runtime: the store on the same database file, built afresh each time, as a restart builds it. */
  const runtime = <A, E>(use: Effect.Effect<A, E, StalledMcpServers>) =>
    Effect.runPromise(
      use.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(SessionProtocolStore.layer),
            Layer.provideMerge(ProjectSecretsLive.layer),
            Layer.provide(ServerSecretStore.layer),
            Layer.provideMerge(Layer.fresh(SqlitePersistence.layerFromPath(db))),
            Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-stalled-" }))),
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(NodeCrypto.layer),
          ),
        ),
        Effect.scoped,
      ),
    );
  const skipped = () => runtime(Effect.flatMap(makePluginHandlers, (handlers) => handlers["mcp.skipped"]()));

  it("remembers a skipped server across restarts until Retry (mcp.retry) forgets it", async () => {
    await runtime(StalledMcpServers.use((s) => s.record("thread-without-chat", servers, started({ "computer-use__cua": TIMEOUT }))));

    // Restarted: Plugins still shows it skipped, until a day after its stall, and the next start still leaves it out.
    const after = await skipped();
    expect(after.servers.map((s) => s.server)).toEqual(["computer-use__cua"]);
    expect(Date.parse(after.servers[0]!.until) - Date.parse(after.servers[0]!.at)).toBe(24 * HOUR);
    expect(leftOut(servers, await runtime(StalledMcpServers.use((s) => s.list)), names)).toEqual(["computer-use__cua"]);

    // Retry, then restart again: the next start tries it.
    await runtime(Effect.flatMap(makePluginHandlers, (handlers) => handlers["mcp.retry"]({ request_id: "retry-cua", server: "computer-use__cua" })));
    expect((await skipped()).servers).toEqual([]);
    expect(leftOut(servers, await runtime(StalledMcpServers.use((s) => s.list)), names)).toEqual([]);
  });
});
