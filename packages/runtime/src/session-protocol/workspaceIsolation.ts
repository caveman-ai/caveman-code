// What keeps one workspace's processes apart from the others on its computer (cloud-computers SPEC §8.2): its ports,
// a Postgres database and a Redis index of its own on the services the computer runs, a temp folder and a browser
// profile. This file works them out, and every child that runs code for a workspace (setup, run, archive, terminals,
// the preview, engine tool processes, an automation's commands) takes its environment from here, so a new child path
// cannot miss a variable. Secrets are not its business (repoEnv, the broker).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { threadMarker } from "../automations/journal.ts";
import type { RunVariables } from "../automations/steps.ts";
import { toolsRun, toolsSocket } from "../cloudLink/tools.ts";
import {
  onLoopback,
  portNames,
  serviceAt,
  workspaceEnv,
  workspaceTag,
  type ComputerConfig,
  type WorkspaceIsolation,
} from "./computerConfig.ts";
import { cloneRootOf, pickPorts, readComputerConfig } from "./lifecycle.ts";
import type { DraftEvent } from "./projector.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";

type Store = SessionStore["Service"];

/** What a chat is told when it could not get something of its own. */
interface Note {
  readonly title: string;
  readonly body: string;
}

/**
 * Per runtime: one lane per workspace (two children starting at once make one database), and what each chat was told.
 * ponytail: both keep an entry per workspace this process ever touched; drop idle ones if a runtime outlives that.
 */
interface State {
  readonly lanes: Map<string, Semaphore.Semaphore>;
  /** Redis indexes are picked one workspace at a time: the lowest free one is the same for all of them. */
  readonly redis: Semaphore.Semaphore;
  readonly told: Set<string>;
  /** Where a workspace's database starts from (seedsFrom); unset: every database starts empty. */
  seedOf?: (root: string) => Effect.Effect<string | undefined>;
}
const states = new WeakMap<Store, State>();
const stateOf = (store: Store): State => {
  let state = states.get(store);
  if (state === undefined)
    states.set(
      store,
      (state = { lanes: new Map(), redis: Semaphore.makeUnsafe(1), told: new Set() }),
    );
  return state;
};
const laneOf = (store: Store, id: string) => {
  const { lanes } = stateOf(store);
  let lane = lanes.get(id);
  if (lane === undefined) lanes.set(id, (lane = Semaphore.makeUnsafe(1)));
  return lane;
};

// ------------------------------------------------------------------ ports

/** Gives `id` a free port per name from the runtime's range, recorded so no other workspace gets one of them. */
export const allocatePorts = (store: Store, id: string, names: ReadonlyArray<string>) =>
  store.transact(
    Effect.gen(function* () {
      const taken = new Set(
        (yield* store.sql<{ port: number }>`SELECT port FROM caveman_sp_ports`.pipe(
          Effect.orDie,
        )).map((r) => r.port),
      );
      const ports = yield* Effect.promise(() => pickPorts(names, taken));
      for (const [name, port] of Object.entries(ports)) {
        yield* store.sql`INSERT INTO caveman_sp_ports (port, workspace_id, name) VALUES (${port}, ${id}, ${name})`.pipe(
          Effect.orDie,
        );
      }
      return { value: ports, published: [], changed: [] };
    }),
  );

/** The ports `id` holds, with one allocated for each of `names` it lacks. */
const portsFor = (store: Store, id: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* store.sql<{
      name: string;
      port: number;
    }>`SELECT name, port FROM caveman_sp_ports WHERE workspace_id = ${id} ORDER BY port`.pipe(
      Effect.orDie,
    );
    const held = Object.fromEntries(rows.map((r) => [r.name, r.port]));
    const missing = names.filter((name) => held[name] === undefined);
    return missing.length === 0 ? held : { ...held, ...(yield* allocatePorts(store, id, missing)) };
  });

// ------------------------------------------------------------------ services

/** Where a Cloud computer runs each service it offers: fixed, on its own loopback. */
const ON_CLOUD: Readonly<Record<string, string>> = {
  postgres: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  redis: "redis://127.0.0.1:6379",
};

/**
 * The address of a declared service on this computer, the one every workspace on it shares: what the runtime's own
 * environment names (CAVEMAN_SERVICE_<NAME>_URL: how a VPC pool, or a test, says where its services are), else a
 * Cloud computer's fixed one. Undefined where the computer runs none: This Mac, where you run your own.
 */
export const serviceHere = (
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (!Object.hasOwn(ON_CLOUD, name)) return undefined;
  const shared =
    env[`CAVEMAN_SERVICE_${name.toUpperCase()}_URL`]?.trim() ||
    (toolsSocket(env) !== undefined ? ON_CLOUD[name] : undefined);
  return shared !== undefined && serviceAt(shared) !== undefined ? shared : undefined;
};

/** A workspace's name where it goes into SQL: nothing but what workspaceTag makes. */
const TAG = /^ws_[a-z0-9]{1,8}$/;
/** A seed database's name where it goes into SQL: a plain lowercase identifier, as Cloud's build names one. Anything else is no seed. */
const SEED = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Says where a workspace's database starts from. `seedOf` answers, for the clone a workspace's checkout is one of,
 * the database that clone's build filled when its setup ran (snapshot.json's `seed.postgres`), or undefined. Set
 * once by what runs git (handlers.ts, lifecycle.ts snapshotSeed): this file reads no repository.
 */
export const seedsFrom = (
  store: Store,
  seedOf: (root: string) => Effect.Effect<string | undefined>,
) => Effect.sync(() => void (stateOf(store).seedOf = seedOf));

interface Ran {
  readonly ok: boolean;
  /** What it printed: its answer, or why it failed. */
  readonly out: string;
  /** There is no psql to run. */
  readonly missing?: true;
}

/**
 * One statement through psql on the service's shared database: in the tools container on a Cloud computer (its image
 * has postgresql-client; the runtime's does not), else here. The password goes in the environment, never in argv.
 */
const psql = async (shared: string, statement: string): Promise<Ran> => {
  const url = new URL(shared);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const args = [
    "-X",
    "-A",
    "-t",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    url.toString(),
    "-c",
    statement,
  ];
  const env = { PGCONNECT_TIMEOUT: "5", ...(password === "" ? {} : { PGPASSWORD: password }) };
  const tools = toolsSocket();
  if (tools !== undefined) {
    const ran = await toolsRun(tools, "/", ["psql", ...args], env).catch((error: Error) => ({
      code: 1,
      stdout: "",
      stderr: error.message,
    }));
    if (ran.code === 0) return { ok: true, out: ran.stdout.trim() };
    return {
      ok: false,
      out: ran.stderr.trim(),
      ...(/psql: not found/.test(ran.stderr) ? { missing: true as const } : {}),
    };
  }
  return new Promise((resolve) =>
    execFile(
      "psql",
      args,
      { env: { ...process.env, ...env }, timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) =>
        resolve(
          error === null
            ? { ok: true, out: stdout.trim() }
            : {
                ok: false,
                out: stderr.trim() || error.message,
                ...((error as NodeJS.ErrnoException).code === "ENOENT"
                  ? { missing: true as const }
                  : {}),
              },
        ),
    ),
  );
};

/** One Redis reply at `at` and where the next begins (RESP 2); undefined while it is not all here. A refusal is an Error. */
const readReply = (bytes: Buffer, at: number): readonly [unknown, number] | undefined => {
  const end = bytes.indexOf("\r\n", at);
  if (end < 0) return undefined;
  const line = bytes.toString("utf8", at + 1, end);
  const next = end + 2;
  const kind = String.fromCharCode(bytes[at]!);
  if (kind === "+") return [line, next];
  if (kind === "-") return [new Error(line), next];
  if (kind === ":") return [Number(line), next];
  if (kind === "$") {
    const length = Number(line);
    if (length < 0) return [null, next];
    return bytes.length < next + length + 2
      ? undefined
      : [bytes.toString("utf8", next, next + length), next + length + 2];
  }
  if (kind === "*") {
    const items: Array<unknown> = [];
    let from = next;
    for (let i = 0; i < Number(line); i++) {
      const item = readReply(bytes, from);
      if (item === undefined) return undefined;
      items.push(item[0]);
      from = item[1];
    }
    return [items, from];
  }
  return [new Error(`an unexpected reply: ${kind}${line}`), next];
};

/**
 * `commands` sent to Redis on one connection, and their replies in order (a refused command's is an Error). The
 * runtime speaks the protocol itself: a computer's image has no redis-cli. Rejects when Redis does not answer in 5 s
 * or refuses the URL's password.
 */
const redis = (
  shared: string,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): Promise<ReadonlyArray<unknown>> =>
  new Promise((resolve, reject) => {
    const url = new URL(shared);
    const auth =
      url.password === ""
        ? []
        : [
            [
              "AUTH",
              ...(url.username === "" ? [] : [decodeURIComponent(url.username)]),
              decodeURIComponent(url.password),
            ],
          ];
    const all = [...auth, ...commands];
    if (commands.length === 0) return resolve([]);
    const socket = net.connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 6379),
    });
    const replies: Array<unknown> = [];
    let pending = Buffer.alloc(0);
    const end = (error?: Error) => {
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (auth.length > 0 && replies[0] instanceof Error) reject(replies[0]);
      else resolve(replies.slice(auth.length));
    };
    socket.setTimeout(5_000, () => end(new Error("no answer within 5 s")));
    socket.once("error", end);
    socket.once("close", () => end(new Error("the connection closed")));
    socket.once("connect", () =>
      socket.write(
        all
          .map(
            (args) =>
              `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`,
          )
          .join(""),
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let at = 0;
      for (
        let reply = readReply(pending, at);
        reply !== undefined;
        reply = readReply(pending, at)
      ) {
        replies.push(reply[0]);
        at = reply[1];
      }
      pending = pending.subarray(at);
      if (replies.length >= all.length) end();
    });
  });

/**
 * A workspace's own URL at a service, or what its chat is told when it has none (neither: it has none and nothing was
 * to be made). Both: it has its own, and its chat is told what is not as it should be about it.
 */
interface Made {
  readonly own?: string;
  readonly note?: Note;
}
const none = (what: string, why: string): Made => ({
  note: {
    title: `This chat has no ${what} of its own`,
    body: `${why} A URL in [env] at the shared one stays as written, so what reads it shares that one with the other chats on this computer.`,
  },
});

/**
 * The workspace's own database on the computer's Postgres, `ws_<id8>`, made the first time a child of it asks and
 * recorded. One of that name the workspace did not make (another's, a person's) is never used or touched.
 * `make` false: only one it already has. `seed`: the database the build of the workspace's clone filled, asked only
 * when the workspace's own is made: the new database is a copy of it (CREATE DATABASE … TEMPLATE), so a workspace
 * whose setup is skipped starts on what setup put there. Never a name that is not a plain identifier, the
 * workspace's own, one a chat here holds, or one the server does not have; and when Postgres will not copy it
 * (someone is connected to it), the database is made empty and the chat is told.
 */
const postgresFor = (
  store: Store,
  id: string,
  shared: string,
  make: boolean,
  seed: Effect.Effect<string | undefined> = Effect.succeed(undefined),
): Effect.Effect<Made> =>
  Effect.gen(function* () {
    const name = workspaceTag(id);
    const at = serviceAt(shared)!;
    const own = () => {
      const url = new URL(shared);
      url.pathname = `/${name}`;
      return { own: url.toString() };
    };
    const rows = yield* store.sql<{
      workspace_id: string;
    }>`SELECT workspace_id FROM caveman_sp_isolation WHERE kind = 'postgres' AND at = ${at} AND name = ${name}`.pipe(
      Effect.orDie,
    );
    if (rows[0]?.workspace_id === id) return own();
    if (!make) return {};
    const no = (why: string) =>
      none(
        "Postgres database",
        `computer.toml declares postgres, and each chat gets a database of its own there (${name}). ${why}`,
      );
    if (rows[0] !== undefined || !TAG.test(name))
      return no("Another chat here holds a database of that name.");
    const exists = yield* Effect.promise(() =>
      psql(shared, `SELECT 1 FROM pg_database WHERE datname = '${name}'`),
    );
    if (exists.missing)
      return no("Making it takes the Postgres client, and this computer has no psql.");
    if (!exists.ok) return no(`Postgres at ${at} could not be asked: ${exists.out.slice(-300)}`);
    if (exists.out !== "")
      return no(
        "A database of that name is there already, and this chat did not make it, so it is left alone.",
      );
    // Recorded once it exists: a database listed here is one this workspace made, and only those are ever dropped.
    const record =
      store.sql`INSERT INTO caveman_sp_isolation (kind, at, name, workspace_id) VALUES ('postgres', ${at}, ${name}, ${id})`.pipe(
        Effect.orDie,
      );
    const template = yield* templateFor(store, shared, at, name, yield* seed);
    const copied =
      template === undefined
        ? undefined
        : yield* Effect.promise(() =>
            psql(shared, `CREATE DATABASE "${name}" TEMPLATE "${template}"`),
          );
    if (copied?.ok) return yield* record.pipe(Effect.as(own()));
    const created = yield* Effect.promise(() => psql(shared, `CREATE DATABASE "${name}"`));
    if (!created.ok) return no(`Postgres would not make it: ${created.out.slice(-300)}`);
    yield* record;
    if (copied === undefined) return own();
    return {
      ...own(),
      note: {
        title: "This chat's Postgres database started empty",
        body: `computer.toml declares postgres, and each chat gets a database of its own there (${name}), a copy of the one this computer's setup filled (${template}). Postgres would not copy it: ${copied.out.slice(-300)} So the chat's database is its own and has nothing in it yet: run the setup's database steps in this chat to fill it.`,
      },
    };
  });

/**
 * The database a new workspace's `name` is copied from: `seed` when it is a plain identifier, not the workspace's own
 * name, not a database a chat here holds (another chat's is never a template), and there on the server. Else none.
 */
const templateFor = (
  store: Store,
  shared: string,
  at: string,
  name: string,
  seed: string | undefined,
) =>
  Effect.gen(function* () {
    if (seed === undefined || !SEED.test(seed) || seed === name) return undefined;
    const held = yield* store.sql<{
      workspace_id: string;
    }>`SELECT workspace_id FROM caveman_sp_isolation WHERE kind = 'postgres' AND at = ${at} AND name = ${seed}`.pipe(
      Effect.orDie,
    );
    if (held.length > 0) return undefined;
    const there = yield* Effect.promise(() =>
      psql(shared, `SELECT 1 FROM pg_database WHERE datname = '${seed}'`),
    );
    return there.ok && there.out !== "" ? seed : undefined;
  });

/**
 * The workspace's own index on the computer's Redis: the lowest from 1 that no workspace here holds and that holds no
 * keys (index 0 stays the shared one; an index with keys in it is someone's), recorded. `make` false: only one it
 * already has.
 */
const redisFor = (store: Store, id: string, shared: string, make: boolean): Effect.Effect<Made> =>
  Effect.gen(function* () {
    const at = serviceAt(shared)!;
    const own = (index: string) => {
      const url = new URL(shared);
      url.pathname = `/${index}`;
      return { own: url.toString() };
    };
    const held = store.sql<{
      name: string;
      workspace_id: string;
    }>`SELECT name, workspace_id FROM caveman_sp_isolation WHERE kind = 'redis' AND at = ${at}`.pipe(
      Effect.orDie,
    );
    const mine = (yield* held).find((row) => row.workspace_id === id);
    if (mine !== undefined) return own(mine.name);
    if (!make) return {};
    const no = (why: string) =>
      none(
        "Redis index",
        `computer.toml declares redis, and each chat gets an index of its own there. ${why}`,
      );
    return yield* stateOf(store).redis.withPermits(1)(
      Effect.gen(function* () {
        const taken = new Set((yield* held).map((row) => row.name));
        const picked = yield* Effect.tryPromise({
          try: async () => {
            const [configured] = await redis(shared, [["CONFIG", "GET", "databases"]]);
            // A Redis that keeps CONFIG to itself has its default 16; an index past its end is refused below.
            const count = Array.isArray(configured) ? Number(configured[1]) || 16 : 16;
            const candidates = Array.from({ length: Math.max(0, count - 1) }, (_, i) =>
              String(i + 1),
            ).filter((index) => !taken.has(index));
            const replies = await redis(
              shared,
              candidates.flatMap((index) => [["SELECT", index], ["DBSIZE"]]),
            );
            return {
              count,
              index: candidates.find((_, i) => replies[2 * i] === "OK" && replies[2 * i + 1] === 0),
            };
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.catch((error) => Effect.succeed({ failed: error.message })));
        if ("failed" in picked)
          return no(`Redis at ${at} could not be asked: ${picked.failed.slice(-300)}.`);
        if (picked.index === undefined)
          return no(
            `All ${picked.count - 1} of its indexes past 0 are taken, by other chats here or by keys this runtime did not put there.`,
          );
        yield* store.sql`INSERT INTO caveman_sp_isolation (kind, at, name, workspace_id) VALUES ('redis', ${at}, ${picked.index}, ${id})`.pipe(
          Effect.orDie,
        );
        return own(picked.index);
      }),
    );
  });

/** The declared services this computer runs, each with the workspace's own URL there, and what to tell its chat about one it could not have. */
const servicesFor = (
  store: Store,
  id: string,
  computer: ComputerConfig | null,
  make: boolean,
  seed?: Effect.Effect<string | undefined>,
) =>
  Effect.gen(function* () {
    const services: Record<string, { shared: string; own?: string }> = {};
    const notes: Array<Note> = [];
    for (const name of Object.keys(computer?.services ?? {})) {
      const shared = serviceHere(name);
      if (shared === undefined) continue;
      const made = yield* name === "postgres"
        ? postgresFor(store, id, shared, make, seed)
        : redisFor(store, id, shared, make);
      services[name] = made.own === undefined ? { shared } : { shared, own: made.own };
      if (made.note !== undefined) notes.push(made.note);
    }
    return { services, notes };
  });

// ------------------------------------------------------------------ folders

/** In the tools container: its temp folder's `caveman-ws`, where each workspace's two folders go. */
const TOOLS_ROOT = 'd="${TMPDIR:-/tmp}/caveman-ws"';

/** Where this computer's own temp folder and browser profile for a workspace go (not on a Cloud computer's tools). */
const folderPaths = (tag: string) => ({
  tmpDir: path.join(os.tmpdir(), "caveman-ws", tag),
  browserProfile: path.join(os.tmpdir(), "caveman-ws", `${tag}.browser`),
});

/**
 * The workspace's temp folder and browser profile, made if they are not there: in the tools container on a Cloud
 * computer (the runtime's temp folder is not the agent's), else under this computer's temp folder. Short on purpose:
 * tools put sockets in TMPDIR, and macOS caps a socket's path at 104 bytes. Undefined when they could not be made.
 */
const ensureFolders = async (
  tag: string,
): Promise<{ readonly tmpDir: string; readonly browserProfile: string } | undefined> => {
  const tools = toolsSocket();
  try {
    if (tools !== undefined) {
      const made = await toolsRun(tools, "/", [
        "sh",
        "-c",
        `${TOOLS_ROOT}; mkdir -p "$d/$1" "$d/$1.browser" && chmod 700 "$d/$1" "$d/$1.browser" && printf %s "$d"`,
        "sh",
        tag,
      ]);
      const root = made.stdout.trim();
      return made.code === 0 && root.startsWith("/")
        ? { tmpDir: `${root}/${tag}`, browserProfile: `${root}/${tag}.browser` }
        : undefined;
    }
    const folders = folderPaths(tag);
    for (const dir of Object.values(folders)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return folders;
  } catch {
    return undefined;
  }
};

const removeFolders = async (tag: string) => {
  const tools = toolsSocket();
  if (tools !== undefined)
    await toolsRun(tools, "/", [
      "sh",
      "-c",
      `${TOOLS_ROOT}; rm -rf -- "$d/$1" "$d/$1.browser"`,
      "sh",
      tag,
    ]).catch(() => undefined);
  else
    for (const dir of [tag, `${tag}.browser`])
      fs.rmSync(path.join(os.tmpdir(), "caveman-ws", dir), { recursive: true, force: true });
};

// ------------------------------------------------------------------ whose variables

/**
 * Whose variables a workspace's children get. A delegated child that works in its parent's checkout is one working
 * copy, so one environment: its parent's. An automation run's steps and commands share the run's. Any other
 * workspace has its own.
 */
interface Scope {
  readonly id: string;
  readonly worktree: string | null;
  /**
   * The clone its checkout is a worktree of, or is: where a Cloud build left what a new workspace starts from (its
   * database's seed). Absent where nothing says.
   */
  readonly root?: string | undefined;
  /** Another source of a chat in several (sourceScopeId): its ports are its own and never the workspace's to show. */
  readonly source?: string;
  /**
   * The ports it was given when it was made (handlers.ts folderConfig). Absent for what the projector adopts with
   * none (daemon.ts: a delegated child with a worktree of its own, an automation's run): given here, the first time
   * a child of it asks.
   */
  readonly ports?: Readonly<Record<string, number>>;
}

/** An automation run's id as a workspace's: its own ids start with the time, so two runs begun together would share a name. */
export const runScopeId = (runId: string) => {
  const hex = createHash("sha256").update(`automation-run\0${runId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Another source of a chat in several, as a workspace of its own for what is made for it: its database, its Redis
 * index, its temp folder and its ports. Two sources of one chat that both declare postgres, or both name a port
 * `dev`, then never share one. The chat's primary source keeps the workspace's own id.
 */
export const sourceScopeId = (workspaceId: string, source: string) => {
  const hex = createHash("sha256")
    .update(`workspace-source\0${workspaceId}\0${source}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** The ports of a chat in several sources that are its primary's: another source's carry that source's name (`web.dev`). */
const ownPorts = (ports: Readonly<Record<string, number>> | undefined) =>
  Object.fromEntries(Object.entries(ports ?? {}).filter(([name]) => !name.includes(".")));

const scopeOf = (
  store: Store,
  record: WorkspaceRecord,
  worktree: string | null,
  depth = 0,
): Effect.Effect<Scope> =>
  Effect.gen(function* () {
    const root = record.internal.repoPath ?? undefined;
    if (record.internal.automation !== undefined)
      return { id: runScopeId(record.internal.automation.run), worktree, root };
    const sources = record.internal.sources;
    if (
      !record.internal.delegated &&
      sources !== undefined &&
      sources.length > 0 &&
      record.internal.worktreePath !== null
    ) {
      // A chat in several sources: a child that works in another source's worktree gets that source's own; one that
      // works in the chat's folder (its engine, a terminal) or in its primary source gets the workspace's, read from
      // the primary's computer.toml.
      const folder = record.internal.worktreePath;
      const at = worktree === null ? folder : path.resolve(worktree);
      const inside = sources.find(
        (source, index) =>
          index > 0 &&
          !source.folder &&
          (at === path.join(folder, source.name) ||
            at.startsWith(path.join(folder, source.name) + path.sep)),
      );
      if (inside !== undefined)
        return {
          id: sourceScopeId(record.workspace.id, inside.name),
          worktree: path.join(folder, inside.name),
          root: inside.repoPath,
          source: inside.name,
        };
      return {
        id: record.workspace.id,
        worktree: path.join(folder, sources[0]!.name),
        root: sources[0]!.repoPath,
        ports: ownPorts(record.workspace.ports),
      };
    }
    if (!record.internal.delegated)
      return { id: record.workspace.id, worktree, root, ports: record.workspace.ports ?? {} };
    const parent =
      record.workspace.parent_workspace_id === undefined || depth >= 16
        ? undefined
        : yield* store.getWorkspace(record.workspace.parent_workspace_id);
    return parent !== undefined && parent.internal.worktreePath === worktree
      ? yield* scopeOf(store, parent, worktree, depth + 1)
      : { id: record.workspace.id, worktree, root };
  });

/** computer.toml at a worktree; null without one or when it does not parse (its chat already carries that error). */
const configAt = (worktree: string | null): ComputerConfig | null => {
  try {
    return worktree ? readComputerConfig(worktree) : null;
  } catch {
    return null;
  }
};

interface EnvOptions {
  /** The worktree's computer.toml when the caller has read it; undefined: read here. */
  readonly computer?: ComputerConfig | null;
  /** False: only what the workspace already has, nothing made for it (its archive script, a chat nobody took yet). */
  readonly make?: boolean;
}

const scopeEnv = (store: Store, scope: Scope, options: EnvOptions) =>
  Effect.suspend(() => {
    const computer = options.computer !== undefined ? options.computer : configAt(scope.worktree);
    const make = options.make !== false;
    return laneOf(store, scope.id).withPermits(1)(
      Effect.gen(function* () {
        const ports =
          scope.ports ?? (yield* portsFor(store, scope.id, make ? portNames(computer) : []));
        // Asked only when the workspace's database is made: the clone's build may have filled one for it to start from.
        const seedOf = stateOf(store).seedOf;
        const seed =
          seedOf === undefined || scope.root === undefined ? undefined : seedOf(scope.root);
        const { services, notes } = yield* servicesFor(store, scope.id, computer, make, seed);
        const folders = yield* Effect.promise(() => ensureFolders(workspaceTag(scope.id)));
        const isolation: WorkspaceIsolation = { id: scope.id, ports, ...folders, services };
        return { computer, isolation, env: workspaceEnv(computer, isolation), notes };
      }),
    );
  });

/**
 * The environment of a child that runs code for `record`'s workspace: [env] and everything that is the workspace's
 * own (computerConfig.ts workspaceEnv), with its database, index and folders made if this is the first to ask. What
 * it could not have is said on its chat, once.
 */
export const childEnv = (
  store: Store,
  record: WorkspaceRecord,
  options: EnvOptions & {
    /** Where the child works, when the record may not have caught up with it. */ readonly worktree?: string;
  } = {},
) =>
  Effect.gen(function* () {
    // A chat made ahead that nobody took is no workspace yet: nothing is made for it. Its folders are named where its
    // workspace will have them, so the engine started ahead launches as its first turn will (that turn makes them
    // before any command runs); a database or index it would get is not, and that engine is not taken.
    if (record.internal.spare)
      return workspaceEnv(
        options.computer !== undefined ? options.computer : configAt(record.internal.worktreePath),
        {
          id: record.workspace.id,
          ports: record.workspace.ports ?? {},
          ...(toolsSocket() === undefined ? folderPaths(workspaceTag(record.workspace.id)) : {}),
        },
      );
    const scope = yield* scopeOf(store, record, options.worktree ?? record.internal.worktreePath);
    const { isolation, env, notes } = yield* scopeEnv(store, scope, options);
    const { told } = stateOf(store);
    for (const note of notes) {
      const key = `${scope.id}\0${note.title}\0${note.body}`;
      if (told.has(key)) continue;
      told.add(key);
      yield* store.append(record.session.id, () =>
        Effect.succeed({
          events: [
            {
              at: new Date().toISOString(),
              type: "notification",
              payload: { level: "warning", ...note },
            } as DraftEvent,
          ],
          value: undefined,
        }),
      );
    }
    // Ports given here show on the workspace too, as a chat's own do (the preview serves on them).
    if (
      scope.ports === undefined &&
      scope.source === undefined &&
      Object.keys(isolation.ports).length > 0 &&
      JSON.stringify(isolation.ports) !== JSON.stringify(record.workspace.ports ?? {})
    ) {
      yield* store.append(record.session.id, (current) =>
        Effect.succeed({
          events: [],
          value: undefined,
          record: { ...current, workspace: { ...current.workspace, ports: isolation.ports } },
        }),
      );
      const next = yield* store.getWorkspace(record.workspace.id);
      if (next !== undefined) yield* store.publishWorkspace(next.workspace);
    }
    return env;
  });

/**
 * The variables of an automation run for a command it runs at `cwd` (a command step, a command check): the run's own,
 * the same its steps' agents get, apart from [env] as written (automations/checks.ts strips that of credentials). The
 * run's own URL at a service that is not on this computer's loopback (a VPC pool's) counts as written: its password
 * is a real one. What the run could not have is logged: a command has no chat.
 */
export const runEnv = (store: Store, runId: string, cwd: string): Effect.Effect<RunVariables> =>
  Effect.gen(function* () {
    // A run's worktree is one of the clone its repository is checked out in: its database starts as a chat's there does.
    const { computer, isolation, env, notes } = yield* scopeEnv(
      store,
      { id: runScopeId(runId), worktree: cwd, root: cloneRootOf(cwd) ?? cwd },
      {},
    );
    for (const note of notes)
      yield* Effect.logWarning(`automation run ${runId}: ${note.title}. ${note.body}`);
    const services = Object.values(isolation.services ?? {}).filter(
      (service) => service.own !== undefined,
    );
    const local = services
      .filter((service) => onLoopback(service.shared))
      .map((service) => serviceAt(service.shared));
    const remote = services
      .filter((service) => !onLoopback(service.shared))
      .map((service) => serviceAt(service.shared));
    const written = (name: string, value: string) =>
      remote.includes(serviceAt(value)) ||
      (computer?.env[name] === value && !local.includes(serviceAt(value)));
    const entries = Object.entries(env);
    return {
      env: Object.fromEntries(entries.filter(([name, value]) => written(name, value))),
      own: Object.fromEntries(entries.filter(([name, value]) => !written(name, value))),
    };
  });

/**
 * The workspace `id` is over (archived, its disk dropped, its run ended): its ports are free again, the databases it
 * made are dropped, its Redis index is flushed and free, its temp folder and browser profile are gone. Only what
 * this runtime recorded as that workspace's: a child that used its parent's has nothing here. Answers what could not
 * be dropped, which stays recorded.
 */
export const releaseIsolation = (store: Store, id: string) =>
  laneOf(store, id).withPermits(1)(
    Effect.gen(function* () {
      yield* store.sql`DELETE FROM caveman_sp_ports WHERE workspace_id = ${id}`.pipe(Effect.orDie);
      const problems: Array<string> = [];
      const rows = yield* store.sql<{
        kind: string;
        at: string;
        name: string;
      }>`SELECT kind, at, name FROM caveman_sp_isolation WHERE workspace_id = ${id}`.pipe(
        Effect.orDie,
      );
      for (const row of rows) {
        const shared = serviceHere(row.kind);
        // A service this computer no longer runs there cannot be reached by any address it knows: only the record goes.
        if (shared !== undefined && serviceAt(shared) === row.at) {
          const failed = yield* Effect.promise(async () => {
            if (row.kind === "postgres") {
              const dropped = TAG.test(row.name)
                ? await psql(shared, `DROP DATABASE IF EXISTS "${row.name}" WITH (FORCE)`)
                : { ok: true, out: "" };
              return dropped.ok
                ? undefined
                : `Its Postgres database ${row.name} could not be dropped: ${dropped.out.slice(-300)}`;
            }
            const flushed: ReadonlyArray<unknown> = await redis(shared, [
              ["SELECT", row.name],
              ["FLUSHDB"],
            ]).catch((error: Error) => [error]);
            const refused = flushed.find((reply): reply is Error => reply instanceof Error);
            return refused === undefined
              ? undefined
              : `Its Redis index ${row.name} could not be flushed: ${refused.message.slice(-300)}`;
          });
          if (failed !== undefined) {
            problems.push(failed);
            continue;
          }
        }
        yield* store.sql`DELETE FROM caveman_sp_isolation WHERE kind = ${row.kind} AND at = ${row.at} AND name = ${row.name}`.pipe(
          Effect.orDie,
        );
      }
      yield* Effect.promise(() => removeFolders(workspaceTag(id)));
      return problems as ReadonlyArray<string>;
    }),
  );

// ------------------------------------------------------------------ engines

/**
 * Names [env] may not set on an engine process: they pick, redirect or relaunch
 * its credentials and home (an engine's own login, a managed Codex account, an
 * ACP agent's contained home), or load code or trust into it. The repo, and an
 * agent that edits computer.toml, control [env]. Terminals and setup scripts
 * still get every name.
 */
const ENGINE_RESERVED_ENV =
  /^(?:(?:ANTHROPIC|CLAUDE|OPENAI|CODEX|CAVEMAN_CODE|XDG|DYLD)_\w*|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD)$/i;

/** How long an engine's start waits for the projector to adopt its thread as a workspace. */
const ADOPTION_WAIT_MS = 5_000;

/** upstream own row of a thread: who delegated it and where it works. Undefined when T3 has none. */
const threadRow = (store: Store, threadId: string) =>
  store.sql<{
    parent: string | null;
    relationship: string | null;
    source: string | null;
    worktree: string | null;
  }>`SELECT
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
      json_extract(payload_json, '$.creationSource') AS source,
      json_extract(payload_json, '$.worktreePath') AS worktree
    FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`.pipe(
    Effect.map((rows) => rows[0]),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The record of a thread the projector adopts a moment after T3 makes it (daemon.ts): an automation step's, which
 * its run registered before starting it, or a delegated child's of a chat here. Its engine can start before the
 * projector got to it, so it waits for the record, a few seconds at most: its first session never starts without
 * its variables. Any other thread (upstream own, a native subagent's) is no workspace: undefined at once.
 */
const adopted = (store: Store, threadId: string) =>
  Effect.gen(function* () {
    let expected = (yield* threadMarker(store.sql, threadId)) !== undefined;
    if (!expected) {
      const row = yield* threadRow(store, threadId);
      expected =
        row !== undefined &&
        row.relationship === "subagent" &&
        row.source !== "provider" &&
        row.parent !== null &&
        (yield* store.getByThread(row.parent)) !== undefined;
    }
    for (let waited = 0; expected && waited < ADOPTION_WAIT_MS; waited += 50) {
      const record = yield* store.getByThread(threadId);
      if (record !== undefined) return record;
      yield* Effect.sleep(50);
    }
    return undefined;
  });

/**
 * What a workspace thread's engine tool processes add to their environment: its workspace's variables (childEnv)
 * minus the engine's reserved names, nothing else. Read per call, so an edited [env] reaches the next session. Not a
 * workspace, or no worktree: empty. A broken computer.toml gives what is the workspace's own alone (the session
 * already carries the config error).
 */
export const threadWorkspaceEnv = (store: Store, threadId: string) =>
  Effect.gen(function* () {
    const record = (yield* store.getByThread(threadId)) ?? (yield* adopted(store, threadId));
    // No checkout (the Chief): no code runs for it, so nothing is made for it.
    if (record === undefined || !record.internal.worktreePath) return {} as Record<string, string>;
 // A delegated child's own worktree is upstream to prepare, and the record follows it: upstream row says where it works now.
    const worktree = record.internal.delegated
      ? (yield* threadRow(store, threadId))?.worktree
      : undefined;
    const env = yield* childEnv(store, record, worktree ? { worktree } : {});
    return Object.fromEntries(
      Object.entries(env).filter(([name]) => !ENGINE_RESERVED_ENV.test(name)),
    );
  });
