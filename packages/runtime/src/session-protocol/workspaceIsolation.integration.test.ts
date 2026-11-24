// Two workspaces of one project on one computer, each inside the same setup command at the same moment, on a real
// Postgres and a real Redis (Docker): each sees only its own rows, keys, containers and port, and what one had goes
// when it is archived while a database it did not make stays (cloud-computers SPEC §8.2, finding P2). The runtime's
// environment names the two services, as a VPC pool's does; a Cloud computer's fixed addresses go the same way.
// Skipped where Docker or psql is not there.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { workspaceTag } from "./computerConfig.ts";
import * as Store from "./store.ts";
import {
  loadTranscript,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";
import { releaseIsolation, runEnv, runScopeId, seedsFrom } from "./workspaceIsolation.ts";

// The suite runs on a scratch HOME (vitest.config.ts), where the docker CLI finds neither the daemon it is set to
// (OrbStack's or Docker Desktop's context) nor its compose plugin: both are in the person's own ~/.docker.
const dockerConfig = path.join(os.userInfo().homedir, ".docker");
const ownDockerConfig = process.env.DOCKER_CONFIG === undefined && fs.existsSync(dockerConfig);
if (ownDockerConfig) process.env.DOCKER_CONFIG = dockerConfig;

const has = (command: string, args: ReadonlyArray<string>) =>
  spawnSync(command, args, { stdio: "ignore", timeout: 30_000 }).status === 0;
const dockerHere =
  has("docker", ["version", "--format", "{{.Server.Version}}"]) &&
  has("docker", ["compose", "version"]) &&
  has("psql", ["--version"]);

const docker = (...args: Array<string>) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** What each workspace's setup runs: it touches everything a workspace has of its own and writes down what it saw. */
const PROBE = String.raw`import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const env = process.env;
const id = env.CAVEMAN_WORKSPACE_ID;
const out = path.join(env.OUT, id);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Both workspaces are inside this command at once: each waits for the other before it touches anything.
fs.writeFileSync(path.join(out, "started"), "");
const started = () => fs.readdirSync(env.OUT).filter((dir) => fs.existsSync(path.join(env.OUT, dir, "started"))).length;
for (let i = 0; started() < 2 && i < 1200; i++) await sleep(100);
const began = Date.now();

const psql = (url, sql) => execFileSync("psql", ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql], { encoding: "utf8" }).trim();
psql(env.DATABASE_URL, "CREATE TABLE IF NOT EXISTS seen (workspace text)");
psql(env.DATABASE_URL, "INSERT INTO seen VALUES ('" + id + "')");

// Redis by hand, as an app's client would: its index is the path of its URL.
const redisUrl = new URL(env.CAVEMAN_SERVICE_REDIS_URL);
const redis = (commands) =>
  new Promise((resolve, reject) => {
    let said = "";
    const socket = net.connect(Number(redisUrl.port), redisUrl.hostname);
    socket.on("data", (chunk) => (said += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(said));
    socket.write(["SELECT " + redisUrl.pathname.slice(1), ...commands, "QUIT"].join("\r\n") + "\r\n");
  });
await redis(["SET who " + id]);

execFileSync("docker", ["compose", "up", "-d", "--wait"], { stdio: "pipe" });
const server = net.createServer((socket) => socket.end(id));
await new Promise((resolve, reject) => server.once("error", reject).listen(Number(env.PORT), "127.0.0.1", resolve));
// The port, the stack, the rows and the key all stand while the other workspace has its own.
await sleep(2500);
const answered = await new Promise((resolve, reject) => {
  let said = "";
  const socket = net.connect(Number(env.PORT), "127.0.0.1");
  socket.on("data", (chunk) => (said += chunk));
  socket.on("end", () => resolve(said));
  socket.on("error", reject);
});
await new Promise((resolve) => server.close(resolve));
fs.writeFileSync(path.join(env.TMPDIR, "scratch"), id);
fs.writeFileSync(path.join(env.CAVEMAN_BROWSER_PROFILE, "Preferences"), id);

fs.writeFileSync(
  path.join(out, "saw.json"),
  JSON.stringify({
    began,
    ended: Date.now(),
    databaseUrl: env.DATABASE_URL,
    serviceUrl: env.CAVEMAN_SERVICE_POSTGRES_URL,
    database: psql(env.CAVEMAN_SERVICE_POSTGRES_URL, "SELECT current_database()"),
    rows: psql(env.DATABASE_URL, "SELECT workspace FROM seen ORDER BY 1").split("\n"),
    redisUrl: env.CAVEMAN_SERVICE_REDIS_URL,
    redis: await redis(["KEYS *", "GET who"]),
    project: env.COMPOSE_PROJECT_NAME,
    containers: execFileSync("docker", ["compose", "ps", "--format", "{{.Name}}"], { encoding: "utf8" }).trim().split("\n"),
    port: env.PORT,
    cavemanPort: env.CAVEMAN_PORT,
    answered,
    servicePorts: [env.CAVEMAN_PORT_POSTGRES, env.CAVEMAN_PORT_REDIS],
    tmpdir: env.TMPDIR,
    profile: env.CAVEMAN_BROWSER_PROFILE,
    agentProfile: env.AGENT_BROWSER_PROFILE,
    session: env.AGENT_BROWSER_SESSION,
  }),
);
`;

interface Saw {
  readonly began: number;
  readonly ended: number;
  readonly databaseUrl: string;
  readonly serviceUrl: string;
  readonly database: string;
  readonly rows: ReadonlyArray<string>;
  readonly redisUrl: string;
  readonly redis: string;
  readonly project: string;
  readonly containers: ReadonlyArray<string>;
  readonly port: string;
  readonly cavemanPort: string;
  readonly answered: string;
  readonly servicePorts: ReadonlyArray<string>;
  readonly tmpdir: string;
  readonly profile: string;
  readonly agentProfile: string;
  readonly session: string;
}

describe.skipIf(!dockerHere)("two workspaces of one project on real Postgres and Redis", () => {
  const suffix = randomBytes(4).toString("hex");
  const containers = { postgres: `cc-a6-iso-pg-${suffix}`, redis: `cc-a6-iso-redis-${suffix}` };
  /** Compose projects the workspaces' setups started, brought down at the end whatever happened. */
  const projects = new Set<string>();
  const root = tempRoot("sp-iso-");
  const out = path.join(root, "out");
  const saved = {
    postgres: process.env.CAVEMAN_SERVICE_POSTGRES_URL,
    redis: process.env.CAVEMAN_SERVICE_REDIS_URL,
  };
  let shared: { readonly postgres: string; readonly redis: string };
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  let repo: string;
  const events = new Map<string, Array<SessionEvent>>();

  /** What each terminal was started with (the terminal manager is not what is under test). */
  const opened: Array<Record<string, string>> = [];
  const layerTerminal = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) => Effect.sync(() => (opened.push({ ...input.env }), {} as never)),
    getShell: () => Effect.succeed("/bin/sh"),
    write: () => Effect.void,
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
  });

  const sql = (statement: string) =>
    execFileSync(
      "psql",
      ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-d", shared.postgres, "-c", statement],
      { encoding: "utf8" },
    ).trim();
  const databases = () =>
    sql("SELECT datname FROM pg_database WHERE datname LIKE 'ws\\_%' ORDER BY 1")
      .split("\n")
      .filter(Boolean);
  const redisCli = (index: string, ...args: Array<string>) =>
    docker("exec", containers.redis, "redis-cli", "-n", index, ...args);
  const ledger = () => {
    const db = new DatabaseSync(config.dbPath);
    try {
      return db
        .prepare("SELECT kind, name, workspace_id FROM caveman_sp_isolation ORDER BY kind, name")
        .all() as Array<{ kind: string; name: string; workspace_id: string }>;
    } finally {
      db.close();
    }
  };
  const removeContainers = () => {
    for (const project of projects) {
      const ids = spawnSync(
        "docker",
        ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
        { encoding: "utf8" },
      )
        .stdout.split("\n")
        .filter(Boolean);
      if (ids.length > 0) spawnSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
      spawnSync("docker", ["network", "rm", `${project}_default`], { stdio: "ignore" });
    }
    for (const name of Object.values(containers))
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  };

  const create = async (from: string, request: string) => {
    const workspace = await client.call("workspace.create", {
      request_id: request,
      repo: { path: from },
      engine: "claude-agent",
      options: { model: MODEL },
    });
    projects.add(workspaceTag(workspace.id));
    const list: Array<SessionEvent> = [];
    events.set(workspace.id, list);
    await client.attach(workspace.session_id, 0, (event) => list.push(event));
    return workspace;
  };
  const notes = (id: string) =>
    (events.get(id) ?? []).flatMap((e) =>
      e.type === "notification"
        ? [{ level: e.payload.level, title: e.payload.title, body: e.payload.body ?? "" }]
        : [],
    );
  /** What the workspace's setup saw, once it finished; its output if it failed. */
  const sawOf = async (workspace: Workspace): Promise<Saw> => {
    await until(
      () =>
        notes(workspace.id).some(
          (n) => n.title.startsWith("Setup finished") || n.title.startsWith("Setup failed"),
        ),
      240_000,
    );
    const failed = notes(workspace.id).find((n) => n.title.startsWith("Setup failed"));
    if (failed) throw new Error(`${failed.title}\n${failed.body}`);
    return JSON.parse(fs.readFileSync(path.join(out, workspace.id, "saw.json"), "utf8"));
  };

  beforeAll(async () => {
    try {
      const [postgresPort, redisPort] = [await freePort(), await freePort()];
      // Each ends by itself after 20 minutes and is removed then, should this process die before afterAll.
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        containers.postgres,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-p",
        `127.0.0.1:${postgresPort}:5432`,
        "postgres:17",
        "timeout",
        "1200",
        "docker-entrypoint.sh",
        "postgres",
      );
      // Three indexes: 0, the shared one, and one each for two workspaces.
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        containers.redis,
        "-p",
        `127.0.0.1:${redisPort}:6379`,
        "redis:7-alpine",
        "timeout",
        "1200",
        "docker-entrypoint.sh",
        "redis-server",
        "--databases",
        "3",
      );
      shared = {
        postgres: `postgres://postgres:postgres@127.0.0.1:${postgresPort}/postgres`,
        redis: `redis://127.0.0.1:${redisPort}`,
      };
      await until(
        () =>
          spawnSync("psql", ["-X", "-q", "-d", shared.postgres, "-c", "SELECT 1"], {
            stdio: "ignore",
            env: { ...process.env, PGCONNECT_TIMEOUT: "2" },
          }).status === 0,
        120_000,
      );
      await until(
        () =>
          spawnSync("docker", ["exec", containers.redis, "redis-cli", "ping"], {
            encoding: "utf8",
          }).stdout.trim() === "PONG",
        60_000,
      );
      // A database named like a workspace's that no workspace here made.
      sql('CREATE DATABASE "ws_0000beef"');
      // How a computer says where its services are: the runtime's own environment.
      process.env.CAVEMAN_SERVICE_POSTGRES_URL = shared.postgres;
      process.env.CAVEMAN_SERVICE_REDIS_URL = shared.redis;
      fs.mkdirSync(out, { recursive: true });
      config = await makeConfig();
      runtime = await startRuntime(config, await loadTranscript(), undefined, {
        provide: layerTerminal as Layer.Layer<any, never, any>,
      });
      client = connect(runtime.url, runtime.token);
      repo = makeRepo(root, {
        "README.md": "hi\n",
        ".caveman/computer.toml": [
          "[setup]",
          'run = ["node .caveman/probe.mjs"]',
          "[run]",
          'ports = ["web"]',
          "[archive]",
          'run = ["docker compose down -t 0"]',
          "[env]",
          // What the drafter writes: the service's shared address.
          `DATABASE_URL = "${shared.postgres}"`,
          `OUT = "${out}"`,
          "[services]",
          'postgres = "17"',
          'redis = "7"',
          "",
        ].join("\n"),
        ".caveman/probe.mjs": PROBE,
        "compose.yaml":
          'services:\n  box:\n    image: redis:7-alpine\n    command: ["sleep", "900"]\n',
      });
    } catch (error) {
      removeContainers();
      throw error;
    }
  }, 300_000);

  afterAll(async () => {
    try {
      client?.close();
      await runtime?.close();
    } finally {
      removeContainers();
      for (const [name, value] of [
        ["CAVEMAN_SERVICE_POSTGRES_URL", saved.postgres],
        ["CAVEMAN_SERVICE_REDIS_URL", saved.redis],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (ownDockerConfig) delete process.env.DOCKER_CONFIG;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  let a: Workspace;
  let b: Workspace;
  let sawA: Saw;
  let sawB: Saw;

  test("each sees only its own database, Redis index, Compose project, port and temp folder, while both run the same setup", async () => {
    [a, b] = await Promise.all([create(repo, "iso-a"), create(repo, "iso-b")]);
    [sawA, sawB] = await Promise.all([sawOf(a), sawOf(b)]);
    // They were inside it together.
    expect(Math.max(sawA.began, sawB.began)).toBeLessThan(Math.min(sawA.ended, sawB.ended));

    for (const [workspace, saw] of [
      [a, sawA],
      [b, sawB],
    ] as const) {
      const tag = workspaceTag(workspace.id);
      const ports = (await client.call("workspace.get", { workspace_id: workspace.id })).ports!;
      // Its database: the one its own URL names, and the one [env]'s DATABASE_URL was pointed at; only its row is in it.
      expect(saw.serviceUrl).toBe(shared.postgres.replace(/\/postgres$/, `/${tag}`));
      expect(saw.databaseUrl).toBe(saw.serviceUrl);
      expect(saw.database).toBe(tag);
      expect(saw.rows).toEqual([workspace.id]);
      // Its index: only its key is in it.
      expect(saw.redisUrl).toMatch(new RegExp(`^${shared.redis}/[12]$`));
      expect(saw.redis).toBe(
        `+OK\r\n*1\r\n$3\r\nwho\r\n$${workspace.id.length}\r\n${workspace.id}\r\n+OK\r\n`,
      );
      // Its Compose project: only its container.
      expect(saw.project).toBe(tag);
      expect(saw.containers).toEqual([`${tag}-box-1`]);
      // Its port: the first [run] port, which it listened on and answered from.
      expect(Object.keys(ports)).toEqual(["web", "postgres", "redis"]);
      expect(saw.port).toBe(String(ports.web));
      expect(saw.cavemanPort).toBe(saw.port);
      expect(saw.answered).toBe(workspace.id);
      expect(saw.servicePorts).toEqual([String(ports.postgres), String(ports.redis)]);
      // Its temp folder and browser profile.
      expect(path.basename(saw.tmpdir)).toBe(tag);
      expect(fs.readFileSync(path.join(saw.tmpdir, "scratch"), "utf8")).toBe(workspace.id);
      expect(saw.agentProfile).toBe(saw.profile);
      expect(fs.readFileSync(path.join(saw.profile, "Preferences"), "utf8")).toBe(workspace.id);
      expect(saw.session).toBe(tag);
    }
    // Nothing of one is the other's.
    for (const key of [
      "database",
      "redisUrl",
      "project",
      "port",
      "tmpdir",
      "profile",
      "session",
    ] as const)
      expect(sawA[key]).not.toBe(sawB[key]);
    expect(new Set([...sawA.servicePorts, ...sawB.servicePorts, sawA.port, sawB.port]).size).toBe(
      6,
    );

    // Seen from outside: the two databases beside the one nobody here made, a key in each index, and the runtime's record of what it made.
    expect(databases()).toEqual(["ws_0000beef", workspaceTag(a.id), workspaceTag(b.id)].sort());
    for (const [workspace, saw] of [
      [a, sawA],
      [b, sawB],
    ] as const) {
      expect(redisCli(new URL(saw.redisUrl).pathname.slice(1), "get", "who")).toBe(workspace.id);
      expect(
        sql(`SELECT count(*) FROM pg_database WHERE datname = '${workspaceTag(workspace.id)}'`),
      ).toBe("1");
    }
    expect(redisCli("0", "dbsize")).toBe("0");
    expect(ledger()).toEqual(
      [
        { kind: "postgres", name: workspaceTag(a.id), workspace_id: a.id },
        { kind: "postgres", name: workspaceTag(b.id), workspace_id: b.id },
        { kind: "redis", name: new URL(sawA.redisUrl).pathname.slice(1), workspace_id: a.id },
        { kind: "redis", name: new URL(sawB.redisUrl).pathname.slice(1), workspace_id: b.id },
      ].sort((x, y) => (x.kind + x.name < y.kind + y.name ? -1 : 1)),
    );
    expect(
      notes(a.id)
        .concat(notes(b.id))
        .filter((n) => n.level === "warning"),
    ).toEqual([]);
  }, 300_000);

  test("a database of its name that it did not make is never used, and a Redis with no index left gives none: its chat says so, and its archive leaves both alone", async () => {
    // Another repository on the same services, with no setup: nothing is made for its chat until a child of it starts.
    const other = makeRepo(root, {
      "README.md": "other\n",
      ".caveman/computer.toml": `[env]\nDATABASE_URL = "${shared.postgres}"\nREDIS_URL = "${shared.redis}"\n[services]\npostgres = "17"\nredis = "7"\n`,
    });
    const c = await create(other, "iso-c");
    await client.call("queue.list", { session_id: c.session_id });
    const tag = workspaceTag(c.id);
    // Someone's database, there before the chat's first child.
    sql(`CREATE DATABASE "${tag}"`);
    sql(`COMMENT ON DATABASE "${tag}" IS 'not the runtime''s'`);
    await client.call("term.open", {
      request_id: "iso-c-term",
      workspace_id: c.id,
      cols: 80,
      rows: 24,
      command: "env",
    });
    const env = opened.at(-1)!;
    // No URL of its own (empty, so the shared one in the runtime's environment never stands in); [env] stays as the repository wrote it.
    expect(env.CAVEMAN_SERVICE_POSTGRES_URL).toBe("");
    expect(env.CAVEMAN_SERVICE_REDIS_URL).toBe("");
    expect(env.DATABASE_URL).toBe(shared.postgres);
    expect(env.REDIS_URL).toBe(shared.redis);
    // What needs no service is still its own.
    expect(env).toMatchObject({
      CAVEMAN_WORKSPACE_ID: c.id,
      COMPOSE_PROJECT_NAME: tag,
      CAVEMAN_PORT_POSTGRES: expect.stringMatching(/^\d+$/),
      CAVEMAN_PORT_REDIS: expect.stringMatching(/^\d+$/),
    });
    await until(() => notes(c.id).filter((n) => n.level === "warning").length >= 2, 30_000);
    const said = notes(c.id).filter((n) => n.level === "warning");
    expect(said.map((n) => n.title).sort()).toEqual([
      "This chat has no Postgres database of its own",
      "This chat has no Redis index of its own",
    ]);
    expect(said.find((n) => n.title.includes("Postgres"))!.body).toContain(
      `(${tag}). A database of that name is there already, and this chat did not make it, so it is left alone.`,
    );
    expect(said.find((n) => n.title.includes("Redis"))!.body).toContain(
      "All 2 of its indexes past 0 are taken",
    );
    // Said once, however many children start.
    await client.call("term.open", {
      request_id: "iso-c-term-2",
      workspace_id: c.id,
      cols: 80,
      rows: 24,
      command: "env",
    });
    expect(notes(c.id).filter((n) => n.level === "warning")).toHaveLength(2);
    expect(ledger().filter((row) => row.workspace_id === c.id)).toEqual([]);

    await client.call("workspace.archive", { request_id: "iso-c-archive", workspace_id: c.id });
    expect(databases()).toContain(tag);
    expect(
      sql(`SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '${tag}'`),
    ).toBe("not the runtime's");
    expect(fs.existsSync(env.TMPDIR!)).toBe(false);
    sql(`DROP DATABASE "${tag}"`);
  }, 120_000);

  test("archiving a workspace drops its database, flushes and frees its index, removes its folders and its stack, and leaves its neighbour's and a stranger's alone", async () => {
    const indexA = new URL(sawA.redisUrl).pathname.slice(1);
    const indexB = new URL(sawB.redisUrl).pathname.slice(1);
    const archived = await client.call("workspace.archive", {
      request_id: "iso-a-archive",
      workspace_id: a.id,
    });
    expect(archived.status).toBe("archived");
    expect(notes(a.id).filter((n) => n.level === "warning")).toEqual([]);

    expect(databases()).toEqual(["ws_0000beef", workspaceTag(b.id)].sort());
    expect(redisCli(indexA, "dbsize")).toBe("0");
    expect(fs.existsSync(sawA.tmpdir) || fs.existsSync(sawA.profile)).toBe(false);
    // Its archive script took its own Compose project down, by the name it was given.
    expect(
      docker("ps", "-aq", "--filter", `label=com.docker.compose.project=${sawA.project}`),
    ).toBe("");
    expect(ledger().map((row) => row.workspace_id)).toEqual([b.id, b.id]);

    // The neighbour is as it was: its rows, its key, its stack, its folders.
    expect(
      execFileSync(
        "psql",
        ["-X", "-A", "-t", "-q", "-d", sawB.serviceUrl, "-c", "SELECT workspace FROM seen"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe(b.id);
    expect(redisCli(indexB, "get", "who")).toBe(b.id);
    expect(
      docker(
        "ps",
        "--filter",
        `label=com.docker.compose.project=${sawB.project}`,
        "--format",
        "{{.Names}}",
      ),
    ).toBe(`${sawB.project}-box-1`);
    expect(fs.readFileSync(path.join(sawB.tmpdir, "scratch"), "utf8")).toBe(b.id);

    // What it freed is given again: the next workspace gets the index, and a database with only its own row.
    const d = await create(repo, "iso-d");
    const sawD = await sawOf(d);
    expect(sawD.redisUrl).toBe(`${shared.redis}/${indexA}`);
    expect(sawD.redis).toContain(`*1\r\n$3\r\nwho\r\n$${d.id.length}\r\n${d.id}\r\n`);
    expect(sawD.rows).toEqual([d.id]);
    expect(sawD.port).not.toBe(sawB.port);
    expect(databases()).toEqual(["ws_0000beef", workspaceTag(b.id), workspaceTag(d.id)].sort());
  }, 300_000);

  // A Cloud computer's tools channel is a Unix socket: none on Windows.
  test.skipIf(process.platform === "win32")(
    "on a Cloud computer the database is made, and the folders are kept, in the tools container",
    async () => {
      // A tools container of this test's own (the real exec server): its temp folder, and a psql that says what it was
      // asked before it asks the real one. A runtime of its own too, which knows nothing of the chats above.
      const tools = path.join(root, "tools");
      const toolsTmp = path.join(tools, "tmp");
      fs.mkdirSync(path.join(tools, "bin"), { recursive: true });
      fs.mkdirSync(toolsTmp);
      const asked = path.join(tools, "psql.log");
      const realPsql = execFileSync("sh", ["-c", "command -v psql"], { encoding: "utf8" }).trim();
      fs.writeFileSync(
        path.join(tools, "bin", "psql"),
        `#!/bin/sh\nprintf '%s %s\\n' "$TOOLS_SIDE" "$*" >> '${asked}'\nexec '${realPsql}' "$@"\n`,
        { mode: 0o755 },
      );
      const socket = path.join(tools, "tools.sock");
      const server = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
        env: {
          ...process.env,
          TOOLS_SIDE: "tools",
          TMPDIR: toolsTmp,
          PATH: `${path.join(tools, "bin")}${path.delimiter}${process.env.PATH}`,
        },
        stdio: "ignore",
      });
      const worktree = path.join(root, "cloud-checkout");
      fs.mkdirSync(path.join(worktree, ".caveman"), { recursive: true });
      fs.writeFileSync(
        path.join(worktree, ".caveman", "computer.toml"),
        `[run]\nports = ["web"]\n[env]\nDATABASE_URL = "${shared.postgres}"\n[services]\npostgres = "17"\nredis = "7"\n`,
      );
      const scope = runScopeId("r_cloud");
      const tag = workspaceTag(scope);
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
      try {
        await until(() => fs.existsSync(socket), 30_000);
        const saw = await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* Store.SessionStore;
            const variables = yield* runEnv(store, "r_cloud", worktree);
            const there = {
              database: databases().includes(tag),
              folders: fs.readdirSync(path.join(toolsTmp, "caveman-ws")).sort(),
            };
            const kept = yield* releaseIsolation(store, scope);
            return { variables, there, kept };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              Store.layer.pipe(
                Layer.provideMerge(ProjectSecretsLive.layer),
                Layer.provide(ServerSecretStore.layer),
                Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
                Layer.provideMerge(
                  Layer.fresh(
                    ServerConfig.layerTest(process.cwd(), { prefix: "caveman-iso-cloud-" }),
                  ),
                ),
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              ),
            ),
          ),
        );
        const own = `${shared.postgres.replace(/\/postgres$/, "")}/${tag}`;
        // Its database, which [env]'s URL was pointed at; its folders in the tools container's temp folder, not the runtime's.
        expect(saw.variables.own).toMatchObject({
          CAVEMAN_WORKSPACE_ID: scope,
          CAVEMAN_SERVICE_POSTGRES_URL: own,
          DATABASE_URL: own,
          TMPDIR: path.join(toolsTmp, "caveman-ws", tag),
          CAVEMAN_BROWSER_PROFILE: path.join(toolsTmp, "caveman-ws", `${tag}.browser`),
        });
        expect(saw.there).toEqual({ database: true, folders: [tag, `${tag}.browser`] });
        // This runtime never heard of the two chats that hold Redis's indexes, and still takes neither: their keys are in them.
        expect(saw.variables.own.CAVEMAN_SERVICE_REDIS_URL).toBe("");
        expect(redisCli(new URL(sawB.redisUrl).pathname.slice(1), "get", "who")).toBe(b.id);
        // Every statement went through the tools container's psql, the password never in its arguments.
        const statements = fs.readFileSync(asked, "utf8").trim().split("\n");
        expect(statements.map((line) => line.slice(line.indexOf(" -c ") + 4))).toEqual([
          `SELECT 1 FROM pg_database WHERE datname = '${tag}'`,
          `CREATE DATABASE "${tag}"`,
          `DROP DATABASE IF EXISTS "${tag}" WITH (FORCE)`,
        ]);
        for (const line of statements) {
          expect(line.startsWith("tools ")).toBe(true);
          expect(line).toContain(shared.postgres.replace("postgres:postgres@", "postgres@"));
        }
        // The run ended: its database is dropped and its folders are gone from the tools container.
        expect(saw.kept).toEqual([]);
        expect(databases()).not.toContain(tag);
        expect(fs.readdirSync(path.join(toolsTmp, "caveman-ws"))).toEqual([]);
      } finally {
        delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
        server.kill();
      }
    },
    120_000,
  );

  // ------------------------------------------------------------------ the seeded database
  // A Cloud computer made from its project's environment (cloud-computers SPEC §6, §8.2): the build's setup ran
  // against a database of its own on the computer's Postgres (the seed), and the marker it left at the clone's root
  // names it. Setup never runs again on such a computer, so each workspace's database starts as a copy of the seed.

  const seed = `cc_seed_${suffix}`;
  const at = (database: string) => shared.postgres.replace(/\/postgres$/, `/${database}`);
  const query = (database: string, statement: string) =>
    execFileSync(
      "psql",
      ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-d", at(database), "-c", statement],
      { encoding: "utf8" },
    ).trim();
  const fruit = (database: string) =>
    query(database, "SELECT name FROM fruit ORDER BY 1").split("\n").filter(Boolean);
  const tables = (database: string) =>
    query(database, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
      .split("\n")
      .filter(Boolean);
  /** A clone as a build leaves it: the repository, and the git-excluded marker at its root (`marker` over the usual one; a string is written as it is). */
  const built = (
    marker: Record<string, unknown>,
    options: { readonly committed?: boolean } = {},
  ) => {
    const toml = `[env]\nDATABASE_URL = "${shared.postgres}"\n[services]\npostgres = "17"\n`;
    const clone = makeRepo(root, { "README.md": "seeded\n", ".caveman/computer.toml": toml });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(
      path.join(clone, ".caveman/snapshot.json"),
      JSON.stringify({
        hash: "h",
        commit,
        branch: "main",
        built_at: new Date().toISOString(),
        config: toml,
        ...marker,
      }),
    );
    if (options.committed) {
      execFileSync("git", ["add", ".caveman/snapshot.json"], { cwd: clone });
      execFileSync("git", ["commit", "-qm", "a marker"], { cwd: clone });
    } else fs.appendFileSync(path.join(clone, ".git/info/exclude"), ".caveman/snapshot.json\n");
    return clone;
  };
  /** The chat's first child starts (a terminal): its database is made now. Answers what the child was started with. */
  const firstChild = async (workspace: Workspace) => {
    await client.call("term.open", {
      request_id: `${workspace.id}-term`,
      workspace_id: workspace.id,
      cols: 80,
      rows: 24,
      command: "env",
    });
    return opened.findLast((env) => env.CAVEMAN_WORKSPACE_ID === workspace.id)!;
  };
  const warnings = (id: string) => notes(id).filter((n) => n.level === "warning");

  test("a workspace's database starts as a copy of the one the build's setup filled; two workspaces' writes reach neither each other nor the seed", async () => {
    sql(`CREATE DATABASE "${seed}"`);
    query(
      seed,
      "CREATE TABLE fruit (name text PRIMARY KEY); INSERT INTO fruit VALUES ('apple'), ('pear')",
    );
    const clone = built({ seed: { postgres: seed } });
    // Two chats at once, each a worktree of the clone; nothing is made until a child of each starts.
    const [e, f] = await Promise.all([create(clone, "seed-e"), create(clone, "seed-f")]);
    expect(databases()).not.toContain(workspaceTag(e.id));
    const [envE, envF] = await Promise.all([firstChild(e), firstChild(f)]);
    for (const [workspace, env] of [
      [e, envE],
      [f, envF],
    ] as const) {
      const tag = workspaceTag(workspace.id);
      // Its own database, which [env]'s URL was pointed at, holding what setup put in the seed.
      expect(env.CAVEMAN_SERVICE_POSTGRES_URL).toBe(at(tag));
      expect(env.DATABASE_URL).toBe(at(tag));
      expect(fruit(tag)).toEqual(["apple", "pear"]);
    }
    // Each writes to its own: the other never sees it, and the seed stays what the build left.
    query(workspaceTag(e.id), "INSERT INTO fruit VALUES ('kiwi'); CREATE TABLE only_e (n int)");
    query(
      workspaceTag(f.id),
      "DELETE FROM fruit WHERE name = 'apple'; INSERT INTO fruit VALUES ('plum')",
    );
    expect(fruit(workspaceTag(e.id))).toEqual(["apple", "kiwi", "pear"]);
    expect(fruit(workspaceTag(f.id))).toEqual(["pear", "plum"]);
    expect(tables(workspaceTag(f.id))).toEqual(["fruit"]);
    expect(fruit(seed)).toEqual(["apple", "pear"]);
    expect(tables(seed)).toEqual(["fruit"]);
    // Recorded as theirs, as any workspace's database is; nothing to say to either chat.
    expect(
      ledger()
        .filter((row) => row.kind === "postgres" && [e.id, f.id].includes(row.workspace_id))
        .map((row) => row.name)
        .sort(),
    ).toEqual([workspaceTag(e.id), workspaceTag(f.id)].sort());
    expect(warnings(e.id).concat(warnings(f.id))).toEqual([]);

    // A later workspace starts from the seed too, never from what another workspace wrote.
    const g = await create(clone, "seed-g");
    await firstChild(g);
    expect(fruit(workspaceTag(g.id))).toEqual(["apple", "pear"]);

    // Archive drops the workspace's own database and leaves the seed and its neighbours'.
    await client.call("workspace.archive", { request_id: "seed-e-archive", workspace_id: e.id });
    expect(databases()).not.toContain(workspaceTag(e.id));
    expect(fruit(seed)).toEqual(["apple", "pear"]);
    expect(fruit(workspaceTag(f.id))).toEqual(["pear", "plum"]);
    for (const workspace of [f, g])
      await client.call("workspace.archive", {
        request_id: `${workspace.id}-archive`,
        workspace_id: workspace.id,
      });
  }, 180_000);

  test("a seed someone is connected to cannot be copied: the workspace's database is made empty and its chat says so, once", async () => {
    const clone = built({ seed: { postgres: seed } });
    // A session left open on the seed (Postgres copies a database only while nobody else is connected to it).
    const holder = spawn("psql", ["-X", "-q", "-d", at(seed), "-c", "SELECT pg_sleep(300)"], {
      stdio: "ignore",
    });
    try {
      await until(
        () => sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${seed}'`) === "1",
        30_000,
      );
      const h = await create(clone, "seed-h");
      const env = await firstChild(h);
      const tag = workspaceTag(h.id);
      // It still has a database of its own, recorded as its own: with nothing in it.
      expect(env.CAVEMAN_SERVICE_POSTGRES_URL).toBe(at(tag));
      expect(env.DATABASE_URL).toBe(at(tag));
      expect(tables(tag)).toEqual([]);
      expect(ledger().filter((row) => row.workspace_id === h.id)).toEqual([
        { kind: "postgres", name: tag, workspace_id: h.id },
      ]);
      await until(() => warnings(h.id).length > 0, 30_000);
      const said = warnings(h.id);
      expect(said.map((n) => n.title)).toEqual(["This chat's Postgres database started empty"]);
      expect(said[0]!.body).toContain(
        `each chat gets a database of its own there (${tag}), a copy of the one this computer's setup filled (${seed}). Postgres would not copy it:`,
      );
      expect(said[0]!.body).toContain(`source database "${seed}" is being accessed by other users`);
      expect(said[0]!.body).toContain(
        "So the chat's database is its own and has nothing in it yet",
      );
      // Said once, however many children start, and the seed is as the build left it.
      await client.call("term.open", {
        request_id: "seed-h-term-2",
        workspace_id: h.id,
        cols: 80,
        rows: 24,
        command: "env",
      });
      expect(warnings(h.id)).toHaveLength(1);
      expect(fruit(seed)).toEqual(["apple", "pear"]);
      await client.call("workspace.archive", { request_id: "seed-h-archive", workspace_id: h.id });
      expect(databases()).not.toContain(tag);
    } finally {
      // Its backend first: one asleep in a statement outlives a client that was killed, and still holds the seed.
      sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${seed}'`);
      holder.kill();
    }
    await until(
      () => sql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${seed}'`) === "0",
      30_000,
    );
  }, 180_000);

  test("no seed in the marker, one that is no build's, or a name that is no database to copy: the database starts empty, as before, and nothing is said", async () => {
    // A workspace's own database, held by a chat here: never a template for another's.
    const holderClone = built({});
    const holder = await create(holderClone, "seed-holder");
    await firstChild(holder);
    query(workspaceTag(holder.id), "CREATE TABLE theirs (n int)");
    const cases: Array<readonly [string, string]> = [
      // An older build's marker: no seed.
      ["none", built({})],
      // A marker the repository commits is no build's: what it names is not read.
      ["committed", built({ seed: { postgres: seed } }, { committed: true })],
      // A database the server does not have.
      ["absent", built({ seed: { postgres: `cc_seed_absent_${suffix}` } })],
      // Not a plain identifier: never put into SQL.
      ["quoted", built({ seed: { postgres: `${seed}"; DROP DATABASE "${seed}` } })],
      ["upper", built({ seed: { postgres: seed.toUpperCase() } })],
      ["shape", built({ seed: seed })],
      // Another chat's database.
      ["another chat's", built({ seed: { postgres: workspaceTag(holder.id) } })],
    ];
    for (const [name, clone] of cases) {
      const workspace = await create(clone, `seed-${name}`);
      const env = await firstChild(workspace);
      const tag = workspaceTag(workspace.id);
      expect(env.CAVEMAN_SERVICE_POSTGRES_URL, name).toBe(at(tag));
      expect(tables(tag), name).toEqual([]);
      expect(warnings(workspace.id), name).toEqual([]);
      await client.call("workspace.archive", {
        request_id: `${workspace.id}-archive`,
        workspace_id: workspace.id,
      });
    }
    expect(fruit(seed)).toEqual(["apple", "pear"]);
    expect(tables(workspaceTag(holder.id))).toEqual(["theirs"]);
    await client.call("workspace.archive", {
      request_id: "seed-holder-archive",
      workspace_id: holder.id,
    });
  }, 300_000);

  // A Cloud computer's tools channel is a Unix socket: none on Windows.
  test.skipIf(process.platform === "win32")(
    "on a Cloud computer the copy is made in the tools container, by one statement that names the seed",
    async () => {
      const tools = path.join(root, "tools-seed");
      fs.mkdirSync(path.join(tools, "bin"), { recursive: true });
      fs.mkdirSync(path.join(tools, "tmp"));
      const asked = path.join(tools, "psql.log");
      const realPsql = execFileSync("sh", ["-c", "command -v psql"], { encoding: "utf8" }).trim();
      fs.writeFileSync(
        path.join(tools, "bin", "psql"),
        `#!/bin/sh\nprintf '%s %s\\n' "$TOOLS_SIDE" "$*" >> '${asked}'\nexec '${realPsql}' "$@"\n`,
        { mode: 0o755 },
      );
      const socket = path.join(tools, "tools.sock");
      const server = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
        env: {
          ...process.env,
          TOOLS_SIDE: "tools",
          TMPDIR: path.join(tools, "tmp"),
          PATH: `${path.join(tools, "bin")}${path.delimiter}${process.env.PATH}`,
        },
        stdio: "ignore",
      });
      // A run's worktree of a clone a build filled: the run's database starts from the clone's seed, as a chat's does.
      const clone = built({ seed: { postgres: seed } });
      const worktree = path.join(root, "seeded-run");
      execFileSync("git", ["worktree", "add", "-q", "-b", "run", worktree], { cwd: clone });
      const scope = runScopeId("r_seeded");
      const tag = workspaceTag(scope);
      const asks: Array<string> = [];
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
      try {
        await until(() => fs.existsSync(socket), 30_000);
        const saw = await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* Store.SessionStore;
            // As handlers.ts sets it: asked with the clone the worktree is one of, only when the database is made.
            yield* seedsFrom(store, (asked) => Effect.sync(() => (asks.push(asked), seed)));
            const variables = yield* runEnv(store, "r_seeded", worktree);
            const rows = fruit(tag);
            yield* runEnv(store, "r_seeded", worktree);
            const kept = yield* releaseIsolation(store, scope);
            return { variables, rows, kept };
          }).pipe(
            Effect.scoped,
            Effect.provide(
              Store.layer.pipe(
                Layer.provideMerge(ProjectSecretsLive.layer),
                Layer.provide(ServerSecretStore.layer),
                Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
                Layer.provideMerge(
                  Layer.fresh(
                    ServerConfig.layerTest(process.cwd(), { prefix: "caveman-iso-seed-" }),
                  ),
                ),
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              ),
            ),
          ),
        );
        expect(saw.variables.own).toMatchObject({
          CAVEMAN_SERVICE_POSTGRES_URL: at(tag),
          DATABASE_URL: at(tag),
        });
        expect(saw.rows).toEqual(["apple", "pear"]);
        expect(asks.map((asked) => fs.realpathSync(asked))).toEqual([fs.realpathSync(clone)]);
        const statements = fs.readFileSync(asked, "utf8").trim().split("\n");
        expect(statements.map((line) => line.slice(line.indexOf(" -c ") + 4))).toEqual([
          `SELECT 1 FROM pg_database WHERE datname = '${tag}'`,
          `SELECT 1 FROM pg_database WHERE datname = '${seed}'`,
          `CREATE DATABASE "${tag}" TEMPLATE "${seed}"`,
          `DROP DATABASE IF EXISTS "${tag}" WITH (FORCE)`,
        ]);
        for (const line of statements) expect(line.startsWith("tools ")).toBe(true);
        expect(saw.kept).toEqual([]);
        expect(databases()).not.toContain(tag);
        expect(fruit(seed)).toEqual(["apple", "pear"]);
      } finally {
        delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
        server.kill();
        spawnSync(
          "psql",
          [
            "-X",
            "-q",
            "-d",
            shared.postgres,
            "-c",
            `DROP DATABASE IF EXISTS "${seed}" WITH (FORCE)`,
          ],
          { stdio: "ignore" },
        );
      }
    },
    120_000,
  );
});
