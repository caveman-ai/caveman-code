// What is a workspace's own on a computer that holds many (docs/computer-config.md, cloud-computers SPEC §8.2): the
// variables, the names they are made from, the ports, and whose variables an engine's thread gets. The database, index
// and folders are proved against real services in workspaceIsolation.integration.test.ts; delegated children and
// automation runs through the real projector and runner in workspaceIsolation.children.test.ts.
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import { parseComputerConfig, portNames, workspaceEnv, workspaceTag } from "./computerConfig.ts";
import { pickPorts, PORT_RANGE } from "./lifecycle.ts";
import * as Store from "./store.ts";
import {
  allocatePorts,
  childEnv,
  releaseIsolation,
  runScopeId,
  serviceHere,
  threadWorkspaceEnv,
} from "./workspaceIsolation.ts";

const ID = "1B9D6BCD-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const PG = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const REDIS = "redis://127.0.0.1:6379";
const services = {
  postgres: { shared: PG, own: "postgres://postgres:postgres@127.0.0.1:5432/ws_1b9d6bcd" },
  redis: { shared: REDIS, own: "redis://127.0.0.1:6379/3" },
};

test("a workspace's short name is ws_ and the first 8 letters and digits of its id, lowercase", () => {
  expect(workspaceTag(ID)).toBe("ws_1b9d6bcd");
  expect(workspaceTag("ab-cd-ef-01-23")).toBe("ws_abcdef01");
  expect(workspaceTag("Ws_Env")).toBe("ws_wsenv");
  // An automation run's own id starts with the time, so two begun together would share a name: its workspace id is a hash of it.
  const [a, b] = [
    runScopeId("r_01jc8z3k5m0000000000000001"),
    runScopeId("r_01jc8z3k5m0000000000000002"),
  ];
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(workspaceTag(a)).not.toBe(workspaceTag(b));
  expect(runScopeId("r_01jc8z3k5m0000000000000001")).toBe(a);
});

test("a workspace gets a port for each [run] port and each declared service not among them", () => {
  expect(portNames(null)).toEqual([]);
  expect(portNames(parseComputerConfig(`[run]\nports = ["web", "api"]\n`))).toEqual(["web", "api"]);
  expect(portNames(parseComputerConfig(`[services]\npostgres = "16"\nredis = "7"\n`))).toEqual([
    "postgres",
    "redis",
  ]);
  expect(
    portNames(
      parseComputerConfig(
        `[run]\nports = ["web", "redis"]\n[services]\npostgres = "16"\nredis = "7"\n`,
      ),
    ),
  ).toEqual(["web", "redis", "postgres"]);
});

test("every variable that is the workspace's own, set over [env]", () => {
  const config = parseComputerConfig(
    `[run]\nports = ["web", "api"]\n[services]\npostgres = "16"\nredis = "7"\n[env]\nNODE_ENV = "development"\nPORT = "3000"\nCOMPOSE_PROJECT_NAME = "app"\nTMPDIR = "/tmp"\nCAVEMAN_PORT = "1"\n`,
  );
  const env = workspaceEnv(config, {
    id: ID,
    ports: { web: 42100, api: 42101, postgres: 42102, redis: 42103 },
    tmpDir: "/t/ws_1b9d6bcd",
    browserProfile: "/t/ws_1b9d6bcd.browser",
    services,
  });
  expect(env).toEqual({
    NODE_ENV: "development",
    CAVEMAN_WORKSPACE_ID: ID,
    COMPOSE_PROJECT_NAME: "ws_1b9d6bcd",
    AGENT_BROWSER_SESSION: "ws_1b9d6bcd",
    CAVEMAN_PORT_WEB: "42100",
    CAVEMAN_PORT_API: "42101",
    CAVEMAN_PORT_POSTGRES: "42102",
    CAVEMAN_PORT_REDIS: "42103",
    // The first [run] port, never a service's.
    CAVEMAN_PORT: "42100",
    PORT: "42100",
    TMPDIR: "/t/ws_1b9d6bcd",
    CAVEMAN_BROWSER_PROFILE: "/t/ws_1b9d6bcd.browser",
    AGENT_BROWSER_PROFILE: "/t/ws_1b9d6bcd.browser",
    CAVEMAN_SERVICE_POSTGRES_URL: "postgres://postgres:postgres@127.0.0.1:5432/ws_1b9d6bcd",
    CAVEMAN_SERVICE_REDIS_URL: "redis://127.0.0.1:6379/3",
  });
});

test("PORT is the first [run] port only: a workspace with service ports alone keeps [env]'s", () => {
  const config = parseComputerConfig(`[services]\npostgres = "16"\n[env]\nPORT = "3000"\n`);
  const env = workspaceEnv(config, { id: ID, ports: { postgres: 42100 } });
  expect(env).toMatchObject({ CAVEMAN_PORT_POSTGRES: "42100", PORT: "3000" });
  expect(env.CAVEMAN_PORT).toBeUndefined();
  // No computer.toml: the ports the workspace holds (its preview's), the first of them as PORT.
  expect(workspaceEnv(null, { id: ID, ports: { preview: 42105 } })).toMatchObject({
    CAVEMAN_PORT_PREVIEW: "42105",
    CAVEMAN_PORT: "42105",
    PORT: "42105",
  });
});

test("an [env] URL at a declared service's shared address goes to the workspace's own database or index; nothing else changes", () => {
  const config = parseComputerConfig(
    [
      "[services]",
      'postgres = "16"',
      'redis = "7"',
      "[env]",
      `DATABASE_URL = "${PG}"`,
      // Its own user, driver, database and options stay; only the database is the workspace's.
      'DIRECT_URL = "postgresql://app:secret@localhost:5432/app?sslmode=disable&schema=public"',
      'ASYNC_URL = "postgresql+asyncpg://postgres:postgres@127.0.0.1/postgres"',
      'REDIS_URL = "redis://127.0.0.1:6379"',
      'CACHE_URL = "redis://localhost:6379/0"',
      // Another port, another host, another service, no URL at all: as written.
      'OTHER_PG = "postgres://postgres:postgres@127.0.0.1:5433/postgres"',
      'REMOTE_PG = "postgres://u:p@db.example.com:5432/app"',
      'API_URL = "http://127.0.0.1:5432/postgres"',
      'MYSQL_URL = "mysql://root:mysql@127.0.0.1:3306/mysql"',
      'GREETING = "hello"',
      "",
    ].join("\n"),
  );
  const env = workspaceEnv(config, { id: ID, ports: {}, services });
  expect(env).toMatchObject({
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/ws_1b9d6bcd",
    DIRECT_URL: "postgresql://app:secret@localhost:5432/ws_1b9d6bcd?sslmode=disable&schema=public",
    ASYNC_URL: "postgresql+asyncpg://postgres:postgres@127.0.0.1/ws_1b9d6bcd",
    REDIS_URL: "redis://127.0.0.1:6379/3",
    CACHE_URL: "redis://localhost:6379/3",
    OTHER_PG: "postgres://postgres:postgres@127.0.0.1:5433/postgres",
    REMOTE_PG: "postgres://u:p@db.example.com:5432/app",
    API_URL: "http://127.0.0.1:5432/postgres",
    MYSQL_URL: "mysql://root:mysql@127.0.0.1:3306/mysql",
    GREETING: "hello",
  });
});

test("a computer that runs no service of its own sets no URL and leaves [env] as written; the runtime never invents DATABASE_URL", () => {
  const config = parseComputerConfig(
    `[services]\npostgres = "16"\nredis = "7"\n[env]\nDATABASE_URL = "${PG}"\n`,
  );
  const here = workspaceEnv(config, { id: ID, ports: {} });
  expect(here.DATABASE_URL).toBe(PG);
  expect(Object.keys(here).filter((name) => name.startsWith("CAVEMAN_SERVICE_"))).toEqual([]);
  // Postgres only: Redis has no URL, and neither service gets a name [env] did not set.
  const one = workspaceEnv(parseComputerConfig(`[services]\npostgres = "16"\nredis = "7"\n`), {
    id: ID,
    ports: {},
    services: { postgres: services.postgres },
  });
  expect(one.CAVEMAN_SERVICE_POSTGRES_URL).toBe(services.postgres.own);
  expect(one.CAVEMAN_SERVICE_REDIS_URL).toBeUndefined();
  expect(one.DATABASE_URL).toBeUndefined();
  expect(one.REDIS_URL).toBeUndefined();
  // A service the computer runs that the workspace could not have its own on: its URL is empty, [env] as written.
  const refused = workspaceEnv(config, {
    id: ID,
    ports: {},
    services: { postgres: { shared: PG } },
  });
  expect(refused.CAVEMAN_SERVICE_POSTGRES_URL).toBe("");
  expect(refused.DATABASE_URL).toBe(PG);
});

test("where a computer runs its services: what the runtime's environment names, a Cloud computer's fixed address, nowhere on This Mac", () => {
  expect(serviceHere("postgres", {})).toBeUndefined();
  expect(serviceHere("redis", {})).toBeUndefined();
  const cloud = { CAVEMAN_RUNTIME_TOOLS_ADDRESS: "127.0.0.1:47917" };
  expect(serviceHere("postgres", cloud)).toBe(PG);
  expect(serviceHere("redis", cloud)).toBe(REDIS);
  const pool = {
    CAVEMAN_SERVICE_POSTGRES_URL: "postgres://pool:pw@10.0.0.7:6432/postgres",
    CAVEMAN_SERVICE_REDIS_URL: "redis://10.0.0.8:6380",
  };
  expect(serviceHere("postgres", pool)).toBe(pool.CAVEMAN_SERVICE_POSTGRES_URL);
  expect(serviceHere("redis", { ...cloud, ...pool })).toBe(pool.CAVEMAN_SERVICE_REDIS_URL);
  // Not a URL of that service, or a service the runtime gives nothing of its own on: none.
  expect(
    serviceHere("postgres", { CAVEMAN_SERVICE_POSTGRES_URL: "localhost:5432" }),
  ).toBeUndefined();
  expect(
    serviceHere("mysql", {
      ...cloud,
      CAVEMAN_SERVICE_MYSQL_URL: "mysql://root:mysql@127.0.0.1:3306/mysql",
    }),
  ).toBeUndefined();
});

test("pickPorts skips a port another workspace holds and a port something on the host listens on", async () => {
  // Two ports nothing holds, found by asking the picker itself: one goes to another workspace, the other is taken on the host.
  const [held, busy] = Object.values(await pickPorts(["a", "b"], new Set())) as [number, number];
  const server = net.createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(busy, "127.0.0.1", resolve),
  );
  try {
    // Without either, the picker would give these two again.
    const picked = await pickPorts(["web", "api"], new Set([held]));
    expect(Object.values(picked)).not.toContain(held);
    expect(Object.values(picked)).not.toContain(busy);
    expect(new Set(Object.values(picked)).size).toBe(2);
    for (const port of Object.values(picked))
      expect(port >= PORT_RANGE.from && port <= PORT_RANGE.to).toBe(true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ------------------------------------------------------------------ an engine's start (threadWorkspaceEnv)

const storeLayer = () =>
  Store.layer.pipe(
    Layer.provideMerge(ProjectSecretsLive.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-iso-" })),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** A workspace as the route or the projector stores one, with what the lookups here read. */
const record = (
  id: string,
  worktree: string,
  more: {
    readonly parent?: string;
    readonly delegated?: true;
    readonly run?: string;
    readonly ports?: Record<string, number>;
  } = {},
) =>
  ({
    workspace: {
      id,
      title: id,
      session_id: `ses-${id}`,
      status: "idle",
      created_at: "2026-11-09T00:00:00Z",
      updated_at: "2026-11-09T00:00:00Z",
      ...(more.parent ? { parent_workspace_id: more.parent } : {}),
      ...(more.ports ? { ports: more.ports } : {}),
    },
    session: {
      id: `ses-${id}`,
      workspace_id: id,
      state: "live",
      head: 0,
      created_at: "2026-11-09T00:00:00Z",
      updated_at: "2026-11-09T00:00:00Z",
    },
    internal: {
      threadId: `thread-${id}`,
      worktreePath: worktree,
      repoPath: worktree,
      ...(more.delegated ? { delegated: true as const } : {}),
      ...(more.run
        ? { automation: { automation: "a", run: more.run, step: "s", attempt: 1 } }
        : {}),
    },
  }) as unknown as Store.WorkspaceRecord;

test("an engine that starts before the projector adopted its thread waits for its workspace; a thread that is none gets nothing at once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-iso-engine-"));
  const lead = path.join(root, "lead");
  const mine = path.join(root, "mine");
  for (const dir of [lead, mine]) {
    fs.mkdirSync(path.join(dir, ".caveman"), { recursive: true });
    // Names that would steer an engine never reach it; the rest of [env] does.
    fs.writeFileSync(
      path.join(dir, ".caveman", "computer.toml"),
      '[run]\nports = ["web"]\n[env]\nGREETING = "hello"\nHOME = "/elsewhere"\nANTHROPIC_BASE_URL = "http://elsewhere"\n',
    );
  }
  const made: Array<string> = [];
  try {
    const saw = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const thread = (id: string, payload: object) =>
          sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
              VALUES (${id}, 'p', 't', 'claudeAgent', 'full-access', 'default', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00Z', ${JSON.stringify(payload)})
              ON CONFLICT (thread_id) DO UPDATE SET payload_json = excluded.payload_json`.pipe(
            Effect.orDie,
          );
        const later = (put: Store.WorkspaceRecord) =>
          Effect.sleep(300).pipe(Effect.andThen(store.putWorkspace(put)), Effect.forkChild);

        // A chat with its ports, as the route makes one.
        const ports = yield* allocatePorts(store, "lead", ["web"]);
        yield* store.putWorkspace(record("lead", lead, { ports }));
        const leadEnv = yield* threadWorkspaceEnv(store, "thread-lead");

        // Its delegated child, which T3 has made and the projector has not adopted yet: in the lead's checkout, the lead's variables.
        yield* thread("thread-child", {
          lineage: { parentThreadId: "thread-lead", relationshipToParent: "subagent" },
          creationSource: "mcp",
          worktreePath: null,
        });
        yield* later(record("child", lead, { parent: "lead", delegated: true }));
        const before = Date.now();
        const sharedEnv = yield* threadWorkspaceEnv(store, "thread-child");
        const waited = Date.now() - before;
 // T3 gave it a worktree of its own, and the record has not followed yet: upstream row says where it works.
        yield* thread("thread-child", {
          lineage: { parentThreadId: "thread-lead", relationshipToParent: "subagent" },
          creationSource: "mcp",
          worktreePath: mine,
        });
        const ownEnv = yield* threadWorkspaceEnv(store, "thread-child");

        // An automation step's thread, registered for its run before it started.
        yield* sql`INSERT INTO automation_run_threads (thread_id, run_id, automation, step, attempt) VALUES ('thread-step', 'r_engine', 'a', 's', 1)`.pipe(
          Effect.orDie,
        );
        yield* later(record("step", mine, { delegated: true, run: "r_engine" }));
        const stepEnv = yield* threadWorkspaceEnv(store, "thread-step");

 // Neither a workspace nor about to be one: upstream own thread, and a native subagent's (its lead's transcript holds it).
        yield* thread("thread-native", {
          lineage: { parentThreadId: "thread-lead", relationshipToParent: "subagent" },
          creationSource: "provider",
          worktreePath: null,
        });
        const start = Date.now();
        const none = [
          yield* threadWorkspaceEnv(store, "thread-unknown"),
          yield* threadWorkspaceEnv(store, "thread-native"),
        ];
        const noneMs = Date.now() - start;

        for (const id of ["lead", "child", runScopeId("r_engine")])
          yield* releaseIsolation(store, id);
        return {
          leadEnv,
          sharedEnv,
          waited,
          ownEnv,
          stepEnv,
          none,
          noneMs,
          left: yield* sql`SELECT port FROM caveman_sp_ports`.pipe(Effect.orDie),
        };
      }).pipe(Effect.scoped, Effect.provide(storeLayer())),
    );
    for (const env of [saw.leadEnv, saw.ownEnv, saw.stepEnv])
      made.push(env.TMPDIR!, env.CAVEMAN_BROWSER_PROFILE!);

    expect(saw.leadEnv).toMatchObject({
      CAVEMAN_WORKSPACE_ID: "lead",
      GREETING: "hello",
      PORT: saw.leadEnv.CAVEMAN_PORT_WEB,
    });
    expect(saw.leadEnv.HOME).toBeUndefined();
    expect(saw.leadEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    // It waited for the projector, and got its lead's.
    expect(saw.waited).toBeGreaterThanOrEqual(250);
    expect(saw.sharedEnv).toEqual(saw.leadEnv);
    // In a worktree of its own: its own id, port and folders.
    expect(saw.ownEnv.CAVEMAN_WORKSPACE_ID).toBe("child");
    expect(saw.ownEnv.PORT).not.toBe(saw.leadEnv.PORT);
    expect(saw.ownEnv.TMPDIR).not.toBe(saw.leadEnv.TMPDIR);
    // The step's: its run's.
    expect(saw.stepEnv).toMatchObject({
      CAVEMAN_WORKSPACE_ID: runScopeId("r_engine"),
      COMPOSE_PROJECT_NAME: workspaceTag(runScopeId("r_engine")),
      GREETING: "hello",
    });
    expect(saw.stepEnv.PORT).toMatch(/^\d+$/);
    expect(saw.none).toEqual([{}, {}]);
    expect(saw.noneMs).toBeLessThan(2_000);
    // Released: no port is held, no folder is left.
    expect(saw.left).toEqual([]);
    expect(made.filter((dir) => fs.existsSync(dir))).toEqual([]);
  } finally {
    for (const dir of [root, ...made]) fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a chat made ahead starts its engine on the variables its workspace gets once taken, and nothing is made for it before", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-iso-spare-"));
  fs.mkdirSync(path.join(root, ".caveman"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".caveman", "computer.toml"),
    '[run]\nports = ["web"]\n[env]\nGREETING = "hello"\n',
  );
  const id = "5bare000-0000-4000-8000-000000000001";
  let made: Array<string> = [];
  try {
    const saw = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store.SessionStore;
        // The worktree's ports (makeSpare allocates them), on the chat's record as makeSpareChat stores it.
        const ports = yield* allocatePorts(store, id, ["web"]);
        const spare = record(id, root, { ports });
        yield* store.putWorkspace({ ...spare, internal: { ...spare.internal, spare: true } });
        const ahead = yield* threadWorkspaceEnv(store, `thread-${id}`);
        const madeAhead = [ahead.TMPDIR!, ahead.CAVEMAN_BROWSER_PROFILE!].filter((dir) =>
          fs.existsSync(dir),
        );
        // Taken by workspace.create: the same record, a spare no more.
        yield* store.putWorkspace(spare);
        const taken = yield* threadWorkspaceEnv(store, `thread-${id}`);
        made = [taken.TMPDIR!, taken.CAVEMAN_BROWSER_PROFILE!];
        const madeTaken = made.filter((dir) => fs.existsSync(dir));
        yield* releaseIsolation(store, id);
        return { ahead, madeAhead, taken, madeTaken };
      }).pipe(Effect.scoped, Effect.provide(storeLayer())),
    );
    expect(saw.ahead).toEqual(saw.taken);
    expect(saw.ahead).toMatchObject({
      CAVEMAN_WORKSPACE_ID: id,
      GREETING: "hello",
      PORT: expect.stringMatching(/^\d+$/),
    });
    expect(saw.madeAhead).toEqual([]);
    expect(saw.madeTaken).toEqual(made);
  } finally {
    for (const dir of [root, ...made]) fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a computer with no psql, or whose Redis does not answer, gives the workspace no URL of its own and tells its chat why, once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-iso-none-"));
  const worktree = path.join(root, "checkout");
  fs.mkdirSync(path.join(worktree, ".caveman"), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".caveman", "computer.toml"),
    `[services]\npostgres = "16"\nredis = "7"\n[env]\nDATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres"\n`,
  );
  // The runtime's environment names the two services (nothing listens there), and its PATH holds no psql.
  const saved = {
    PATH: process.env.PATH,
    postgres: process.env.CAVEMAN_SERVICE_POSTGRES_URL,
    redis: process.env.CAVEMAN_SERVICE_REDIS_URL,
  };
  process.env.CAVEMAN_SERVICE_POSTGRES_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";
  process.env.CAVEMAN_SERVICE_REDIS_URL = "redis://127.0.0.1:1";
  process.env.PATH = path.join(root, "no-bin");
  let folders: Array<string> = [];
  try {
    const saw = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store.SessionStore;
        const chat = record("nopsql", worktree);
        yield* store.putWorkspace(chat);
        const env = yield* childEnv(store, chat);
        yield* childEnv(store, chat);
        const events = yield* store.readEvents(chat.session.id, 0, 100);
        yield* releaseIsolation(store, "nopsql");
        return {
          env,
          notes: events.flatMap((e) => (e.type === "notification" ? [e.payload] : [])),
        };
      }).pipe(Effect.scoped, Effect.provide(storeLayer())),
    );
    folders = [saw.env.TMPDIR!, saw.env.CAVEMAN_BROWSER_PROFILE!];
    expect(saw.env).toMatchObject({
      CAVEMAN_SERVICE_POSTGRES_URL: "",
      CAVEMAN_SERVICE_REDIS_URL: "",
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/postgres",
      CAVEMAN_WORKSPACE_ID: "nopsql",
    });
    expect(saw.notes.map((n) => [n.level, n.title])).toEqual([
      ["warning", "This chat has no Postgres database of its own"],
      ["warning", "This chat has no Redis index of its own"],
    ]);
    expect(saw.notes[0]!.body).toContain(
      "(ws_nopsql). Making it takes the Postgres client, and this computer has no psql.",
    );
    expect(saw.notes[1]!.body).toContain("Redis at 127.0.0.1:1 could not be asked: ");
  } finally {
    process.env.PATH = saved.PATH;
    for (const [name, value] of [
      ["CAVEMAN_SERVICE_POSTGRES_URL", saved.postgres],
      ["CAVEMAN_SERVICE_REDIS_URL", saved.redis],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of [root, ...folders]) fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
