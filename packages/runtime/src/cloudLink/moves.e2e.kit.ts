// Test-only: what the real-stack move tests share (moves.e2e.test.ts, lidCycle.e2e.test.ts, and through macs.e2e.kit.ts
// the tests of a person's several Macs: the Cloud, its SQL and the person's sign-in). A REAL local Caveman
// Cloud (control-api on Postgres, SeaweedFS for the journal segments) named by CAVEMAN_E2E_CLOUD_URL, SQL on its
// database through CAVEMAN_E2E_PSQL, and real runtime processes (moves.e2e.runtime.ts) as This Mac or as a Cloud
// computer's runtime, enrolled the way the computers service does it. This Mac reaches Cloud through a proxy, so a
// test can cut its network, and "sleeps" by SIGSTOP. Each test file calls stopAll after its tests.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { expect } from "vitest";

import { tempRoot, until } from "../session-protocol/testHarness.ts";

export const CLOUD = process.env.CAVEMAN_E2E_CLOUD_URL;
export const PSQL = process.env.CAVEMAN_E2E_PSQL;
/** The real-stack tests run only against a stack named this way. */
export const REAL_STACK = Boolean(process.env.CAVEMAN_E2E_MOVES && CLOUD && PSQL);
const RUNTIME = fileURLToPath(new URL("./moves.e2e.runtime.ts", import.meta.url));
export const MODEL = "anthropic/claude-haiku-4-5";

const children: Array<ChildProcess> = [];
const servers: Array<http.Server> = [];
/** Every runtime process and proxy the file started: woken and killed, closed. */
export function stopAll() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    child.kill("SIGCONT");
    child.kill("SIGKILL");
  }
  for (const server of servers.splice(0)) server.close();
}

/** SQL on Cloud's database, under the real home (vitest's scratch HOME hides ~/.docker); an error fails the call. */
export const sql = (text: string) =>
  execFileSync("sh", ["-c", PSQL!], { input: `\\set ON_ERROR_STOP on\n${text}`, encoding: "utf8", env: { ...process.env, HOME: os.userInfo().homedir } }).trim();
export const out = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
export const staged = (cwd: string) => out(cwd, "diff", "--cached", "--name-only");

export async function person() {
  const response = await fetch(`${CLOUD}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.CAVEMAN_E2E_EMAIL, password: process.env.CAVEMAN_E2E_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; user: { id: string; organization_id: string } };
}
export type Person = Awaited<ReturnType<typeof person>>;

/**
 * Lab hygiene before a file's cases: the Cloud computers earlier runs had Cloud make for `me` (the computers service's
 * part here is SQL) are marked deleted, so the person's awake quota (10) is this run's own. Only on a Cloud on this
 * machine; their old chats stay as they are.
 */
export function retireLabComputers(me: Person) {
  if (!LOCAL_CLOUD || !labDatabase()) return;
  sql(`UPDATE code_computers SET desired_state='deleted' WHERE driver='kubernetes' AND desired_state<>'deleted' AND created_by='${me.user.id}'`);
}

/** Lab SQL runs only against a Cloud on this machine. */
const LOCAL_CLOUD = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(CLOUD ?? "");
/**
 * And only where CAVEMAN_E2E_PSQL reaches a database on this machine: over a Unix socket (docker exec), loopback, or
 * Docker's bridge, never a host elsewhere (a port forwarded to a shared Cloud passes the URL check, not this one).
 */
let labDatabaseSaid: boolean | undefined;
const labDatabase = () => (labDatabaseSaid ??= /^(socket$|127\.|::1$|172\.(1[6-9]|2\d|3[01])\.)/.test(sql("SELECT coalesce(host(inet_server_addr()), 'socket')")));

/**
 * Lab funding before a file's cases: a fresh local stack's organization has no plan and no credits, and Cloud makes no
 * Cloud computer for it. A Max plan (no Stripe subscription) and one promo grant of 100,000,000 micros, made once per
 * organization (its source ref), both lab-only. Only when asked (CAVEMAN_E2E_LAB_FUNDING=1), on a Cloud and a database
 * on this machine.
 */
export function labFunding(me: Person) {
  if (process.env.CAVEMAN_E2E_LAB_FUNDING !== "1") return;
  if (!LOCAL_CLOUD || !labDatabase()) throw new Error("CAVEMAN_E2E_LAB_FUNDING funds only a lab stack: a Cloud and a database on this machine");
  const org = me.user.organization_id;
  if (!/^[0-9a-f-]{36}$/.test(org)) throw new Error(`not an organization id: ${org}`);
  sql(`INSERT INTO broker_accounts (organization_id, plan, status) VALUES ('${org}', 'max', 'active')
      ON CONFLICT (organization_id) DO UPDATE SET plan = 'max', status = 'active', updated_at = now();
    INSERT INTO broker_grants (id, organization_id, kind, amount_micros, remaining_micros, source_ref, note)
      VALUES (gen_random_uuid(), '${org}', 'promo', 100000000, 100000000, 'lab-moves-e2e:${org}', 'lab-only') ON CONFLICT DO NOTHING;`);
}

export const api = async (token: string, route: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${CLOUD}${route}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
};

/**
 * This Mac's way to Cloud: forwards everything, or (cut) drops every connection. `onSuspend` runs when the first
 * heartbeat saying the Mac is going to sleep passes, before Cloud hears it. `hold`: requests whose method and path
 * match wait at the proxy until it is let go (a slow uplink), counted as they arrive.
 */
export async function proxy() {
  const target = new URL(CLOUD!);
  const state = { cut: false, onSuspend: undefined as (() => void) | undefined, hold: undefined as { readonly match: RegExp; readonly until: Promise<void>; waiting: number } | undefined };
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      if (state.cut) return req.socket.destroy();
      const body = Buffer.concat(chunks);
      if (req.url?.endsWith("/runtime/heartbeat") && body.toString().includes('"suspending":true') && state.onSuspend) {
        const hook = state.onSuspend;
        state.onSuspend = undefined;
        hook();
      }
      // MOVES_HEARTBEAT_LOG names a file: every heartbeat that passes is a line there as it leaves for Cloud and as Cloud
      // answers it (what it said of going to sleep, and when), for a run that asks which heartbeat un-marked a Mac.
      const beatLog = req.url?.endsWith("/runtime/heartbeat") ? process.env.MOVES_HEARTBEAT_LOG : undefined;
      const beatId = beatLog ? `${(req.headers.authorization ?? "").slice(-6)} #${++beatsSeen}` : "";
      const beatSaid = () => {
        const said = JSON.parse(body.toString() || "{}") as { suspending?: boolean; kept?: ReadonlyArray<string>; active?: boolean; capacity?: unknown; version?: unknown };
        return `suspending=${said.suspending === true} kept=${said.kept?.length ?? "-"} active=${said.active} capacity=${said.capacity !== undefined} version=${said.version !== undefined}`;
      };
      if (beatLog) fs.appendFileSync(beatLog, `${new Date().toISOString().slice(11, 23)} out ${beatId} ${beatSaid()}\n`);
      const held = state.hold;
      if (held !== undefined && held.match.test(`${req.method} ${req.url}`)) {
        held.waiting++;
        await held.until;
        if (req.socket.destroyed) return;
      }
      const forward = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
        if (beatLog) fs.appendFileSync(beatLog, `${new Date().toISOString().slice(11, 23)} answered ${beatId} ${answer.statusCode}\n`);
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forward.on("error", () => req.socket.destroy());
      forward.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

let beatsSeen = 0;

/** A runtime process: This Mac, or a Cloud computer's runtime on `linkDir`. */
export async function runtime(role: "mac" | "cloud", env: Record<string, string>) {
  const outFile = path.join(tempRoot(`moves-${role}-`), "out.json");
  const log = fs.openSync(`${outFile}.log`, "w");
  const child = spawn(process.execPath, ["--no-warnings", RUNTIME], { env: { ...process.env, ...env, MOVES_ROLE: role, MOVES_OUT: outFile }, stdio: ["ignore", log, log] });
  children.push(child);
  await until(() => fs.existsSync(outFile) || child.exitCode !== null, 90_000);
  if (!fs.existsSync(outFile)) throw new Error(`the ${role} runtime exited: ${fs.readFileSync(`${outFile}.log`, "utf8").slice(-2000)}`);
  const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as { url: string; token: string; stateDir: string };
  const notes: Array<{ method: string; params: any }> = [];
  const client = connect(info.url, info.token);
  client.on("session.moved", (params) => notes.push({ method: "session.moved", params }));
  await client.call("engine.account.add", { request_id: `key-${role}`, engine: "caveman", provider: "anthropic", key: `sk-ant-moves-${role}-0123456789abcdef` });
  return { child, client, notes, log: `${outFile}.log`, ...info };
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;

/**
 * A Cloud computer as the computers service makes one: its runtime identity (SQL), the pod running, and its runtime
 * process on its snapshot checkout `workspaceRoot`.
 */
export async function cloudComputer(me: Person, computer: string, workspaceRoot: string, env: Record<string, string>) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const runtimeId = randomUUID();
  sql(`INSERT INTO code_runtimes (id, organization_id, computer_id, name, public_key) VALUES ('${runtimeId}', '${me.user.organization_id}', '${computer}', 'Cloud computer', '\\x${pub}');
    UPDATE code_computers SET observed_state='running', observed_generation=desired_generation, observed_at=now() WHERE id='${computer}';`);
  const linkDir = tempRoot("moves-link-");
  fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: CLOUD, runtime_id: runtimeId, organization_id: me.user.organization_id, computer_id: computer, user_id: me.user.id }));
  fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return { ...(await runtime("cloud", { ...env, CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_WORKSPACE_ROOT: workspaceRoot })), linkDir, runtimeId, computerId: computer };
}

/** Every event of the session on `rt`, from the start, and the session as `rt` has it. */
export async function transcript(rt: Runtime, sessionId: string) {
  const events: Array<SessionEvent> = [];
  const sub = await rt.client.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  return Object.assign(events, { session: sub.session });
}
export type Transcript = Awaited<ReturnType<typeof transcript>>;
export const replies = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []));
export const turnsDone = (events: ReadonlyArray<SessionEvent>) => events.filter((e) => e.type === "turn.done").length;
export const contiguous = (events: ReadonlyArray<SessionEvent>) => events.every((e, i) => e.cursor === i + 1);

export async function waitTurns(rt: Runtime, sessionId: string, n: number, ms = 60_000) {
  let events: Transcript | undefined;
  await until(async () => turnsDone((events = await transcript(rt, sessionId))) >= n, ms);
  return events!;
}

/** The transcript once its last answer matches `reply` (a stopped turn also ends with turn.done). */
export async function waitReply(rt: Runtime, sessionId: string, reply: RegExp, ms = 60_000) {
  let events: Transcript | undefined;
  // Not there yet ("no session") until the runtime has adopted it.
  await until(async () => reply.test(replies((events = await transcript(rt, sessionId).catch(() => events)) ?? []).at(-1) ?? ""), ms);
  return events!;
}

export const recordOn = async (rt: Runtime, sessionId: string) => (await rt.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === sessionId);

/** A turn well under way: working, and the model answering (stopping one the instant it starts wedges the scripted engine's next turn). */
export async function working(rt: Runtime, sessionId: string) {
  await until(async () => (await recordOn(rt, sessionId))?.status === "working", 30_000);
  await new Promise((r) => setTimeout(r, 3_000));
  expect(await recordOn(rt, sessionId)).toMatchObject({ status: "working" });
}
