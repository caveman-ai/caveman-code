// A Caveman chat on a Cloud computer pays from its person's Caveman credits and plan, against a REAL local Caveman
// Cloud (control-api on Postgres and Valkey, Caveman Cloud's feat/caveman-on-computers, CAVE_CODE_CAVEMAN_CREDITS=true
// and the credits broker on) and the REAL runtime process (bin.ts, as a Cloud computer's: CAVEMAN_CLOUD_LINK_DIR, its
// identity enrolled as the computers service enrolls it), on the real Caveman engine and its credits models. Nothing
// is added to the computer: no key, no endpoint. The gateway is a stand-in that does what Caveman's gateway does for a
// credits key and no more: it finds the key by its peppered hash, and has Cloud's broker admit (reserve) and settle
// each request, on the broker channel, before it answers as the model would.
//
//   1. The computer's runtime is minted a credits key for its person when the chat's first turn needs one (never
//      before), holds it in memory only (not on its disk), and the turn is sent with it and paid from the person's plan.
//   2. Its runtime revoked (the computer deleted or re-placed), the key it holds spends nothing: the broker refuses it
//      for good (key_revoked) and the next turn fails.
//
// Skipped unless CAVEMAN_E2E_CREDITS=1 with CAVEMAN_E2E_CLOUD_URL (that control-api), CAVEMAN_E2E_PSQL (SQL on its
// database, a shell command reading stdin), CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD (a member who may write Code),
// CAVEMAN_E2E_KEY_PEPPER (its CAVE_KEY_HASH_PEPPER), CAVEMAN_E2E_BROKER_SECRET (its CAVE_HOSTED_AI_BROKER_SECRET) and
// CAVEMAN_E2E_GATEWAY_PORT (the port its CAVE_GATEWAY_URL names on 127.0.0.1).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { makeRepo, tempRoot, until } from "../session-protocol/testHarness.ts";

const env = process.env;
const CLOUD = env.CAVEMAN_E2E_CLOUD_URL;
const live = env.CAVEMAN_E2E_CREDITS === "1" && !!CLOUD && !!env.CAVEMAN_E2E_PSQL && !!env.CAVEMAN_E2E_KEY_PEPPER && !!env.CAVEMAN_E2E_BROKER_SECRET && !!env.CAVEMAN_E2E_GATEWAY_PORT;
const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const MODEL = "caveman/deepseek/deepseek-flash";
const CLIENT = /^caveman-code\//;

const sql = (text: string) =>
  execFileSync("sh", ["-c", env.CAVEMAN_E2E_PSQL!], { input: `\\set ON_ERROR_STOP on\n${text}`, encoding: "utf8", env: { ...process.env, HOME: os.userInfo().homedir } }).trim();

const children: Array<ChildProcess> = [];
const servers: Array<http.Server> = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) server.close();
});

/**
 * The gateway's part for a credits key, in front of the real broker: the key by its peppered hash (as control-api
 * stored it), Cloud's admission on the broker channel, one streamed answer, Cloud's settlement. A refusal goes back
 * as the broker gave it.
 */
async function gateway(port: number) {
  const seen: Array<{ key: string; client: string | undefined; admitted: number; reason?: string | undefined; requestId: string; keyId?: string | undefined }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const hash = createHmac("sha256", env.CAVEMAN_E2E_KEY_PEPPER!).update(key).digest("hex");
    const row = sql(`SELECT organization_id||' '||project_id||' '||id FROM project_api_keys WHERE key_hash='${hash.replace(/[^0-9a-f]/g, "")}'`);
    const requestId = randomUUID();
    if (row === "") {
      seen.push({ key, client: request.headers["x-caveman-client"] as string | undefined, admitted: 401, requestId });
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { type: "cave_gateway_error", code: "cave_unauthorized", message: "Invalid API key." } }));
    }
    const [organization_id, project_id, key_id] = row.split(" ");
    const body = JSON.parse(raw || "{}") as { model?: string };
    const reserve = await fetch(`${CLOUD}/internal/v1/broker/reserve`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CAVEMAN_E2E_BROKER_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id, project_id, key_id, request_id: requestId, provider: "deepseek", model: body.model ?? "", reserved_micros: 2000, tokens: 50, client: request.headers["x-caveman-client"] }),
    });
    const refusal = reserve.ok ? undefined : ((await reserve.json().catch(() => ({}))) as { reason?: string; message?: string });
    seen.push({ key, client: request.headers["x-caveman-client"] as string | undefined, admitted: reserve.status, reason: refusal?.reason, requestId, keyId: key_id });
    if (refusal !== undefined) {
      // As Caveman's gateway answers (gateway-managed broker.go brokerRefusalCode): a key that spends no more is an
      // invalid key, final; any other refusal passes through.
      const revoked = refusal.reason === "key_revoked";
      response.writeHead(revoked ? 401 : reserve.status, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { type: "cave_gateway_error", code: revoked ? "cave_invalid_api_key" : "cave_code_credits_unavailable", message: refusal.message ?? "refused" } }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: "paid from your plan, on a Cloud computer" }));
    response.write(chunk({}, "stop"));
    response.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    await fetch(`${CLOUD}/internal/v1/broker/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CAVEMAN_E2E_BROKER_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ organization_id, project_id, key_id, request_id: requestId, actual_micros: 100, uncertain: false }),
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return seen;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });

/** Files under `dir` whose bytes hold `needle`. */
const holding = (dir: string, needle: string): Array<string> =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = path.join(entry.parentPath, entry.name);
    try {
      return fs.readFileSync(file).includes(needle) ? [file] : [];
    } catch {
      return [];
    }
  });

test.skipIf(!live)(
  "real Cloud: a Caveman chat on a Cloud computer pays from its person's credits and plan, with no credential on the computer",
  async () => {
    const results: Record<string, unknown> = {};
    const login = await fetch(`${CLOUD}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: env.CAVEMAN_E2E_EMAIL, password: env.CAVEMAN_E2E_PASSWORD }) });
    expect(login.status).toBe(200);
    const me = (await login.clone().json()) as { user: { id: string; organization_id: string } };
    const org = me.user.organization_id;
    // The person's plan (Pro), and the model Caveman sells on credits.
    sql(`INSERT INTO broker_accounts(organization_id,plan,status) VALUES('${org}','pro','active') ON CONFLICT (organization_id) DO UPDATE SET plan='pro', status='active';
      INSERT INTO broker_offers(model,provider,upstream_model,cost_permille,data_policy,updated_by) VALUES('deepseek/deepseek-flash','deepseek','deepseek-flash',400,'no_training','e2e') ON CONFLICT (model) DO NOTHING;`);
    // Its credits keys live in its organization's oldest project, as the person's own key on their Mac does.
    const token0 = ((await login.clone().json().catch(() => undefined)) as { access_token?: string } | undefined)?.access_token;
    if (sql(`SELECT count(*) FROM projects WHERE organization_id='${org}' AND deleted_at IS NULL`) === "0") {
      const made = await fetch(`${CLOUD}/api/v1/projects`, { method: "POST", headers: { authorization: `Bearer ${token0}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Code", slug: `code-${randomUUID().slice(0, 8)}` }) });
      expect(made.status).toBe(201);
    }
    const seen = await gateway(Number(env.CAVEMAN_E2E_GATEWAY_PORT));

    // A Cloud computer of the person's, as the computers service makes one: its row, running; the person's Caveman chat's
    // workspace on it; its runtime's identity (SQL), and the real runtime process on its checkout.
    const computerId = randomUUID();
    const runtimeId = randomUUID();
    const workspaceId = randomUUID();
    const { privateKey } = generateKeyPairSync("ed25519");
    const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    sql(`INSERT INTO code_computers (id, organization_id, driver, size, name, created_by, observed_state, observed_generation, observed_at) VALUES ('${computerId}', '${org}', 'kubernetes', '2cpu-4gb', 'credits box', '${me.user.id}', 'running', 1, now());
      INSERT INTO code_runtimes (id, organization_id, computer_id, name, public_key) VALUES ('${runtimeId}', '${org}', '${computerId}', 'credits box', '\\x${pub}');
      INSERT INTO code_workspaces (id, organization_id, root_id, title, repo, base_branch, branch, engine, computer_id, created_by) VALUES ('${workspaceId}', '${org}', '${workspaceId}', 'Caveman on credits', 'acme/credits', 'main', '', 'caveman', '${computerId}', '${me.user.id}');`);
    const linkDir = tempRoot("credits-link-");
    fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: CLOUD, runtime_id: runtimeId, organization_id: org, computer_id: computerId }));
    fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const checkout = makeRepo(tempRoot("credits-checkout-"), { "README.md": "credits\n" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/credits.git"], { cwd: checkout });

    const scratch = tempRoot("credits-computer-");
    const home = path.join(scratch, "home");
    const baseDir = path.join(scratch, "caveman");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(baseDir, "userdata"), { recursive: true, mode: 0o700 });
    const port = await freePort();
    const token = randomUUID();
    const runtimeEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CAVEMAN_CODE_NO_BROWSER: "1", CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_WORKSPACE_ROOT: checkout };
    for (const variable of ["CAVEMAN_CREDITS_GATEWAY_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "CAVEMAN_CODE_HOME", "CAVEMAN_TOOLS_SOCKET"]) delete runtimeEnv[variable];
    const log = path.join(scratch, "runtime.log");
    const out = fs.openSync(log, "w");
    const child = spawn(process.execPath, ["--no-warnings", "--disable-sigusr1", BIN, "--bootstrap-fd", "3"], { env: runtimeEnv, cwd: home, stdio: ["pipe", out, out, "pipe"] });
    children.push(child);
    (child.stdio[3] as NodeJS.WritableStream).end(`${JSON.stringify({ mode: "desktop", noBrowser: true, host: "127.0.0.1", port, t3Home: baseDir, desktopBootstrapToken: token })}\n`);
    await until(() => fs.readFileSync(log, "utf8").includes("Listening on") || child.exitCode !== null, 180_000);
    if (child.exitCode !== null) throw new Error(`the computer's runtime exited: ${fs.readFileSync(log, "utf8").slice(-3000)}`);
    const client = connect(`ws://127.0.0.1:${port}/session/v1`, () => token);

    // 1. With nothing added to the computer, Cloud mints its runtime a credits key of its person's, for an hour, when a
    // turn needs one: the runtime's own probes (its engines' status, the model list) ask for none.
    const mintedFor = () => sql(`SELECT b.key_id||' '||b.created_by||' '||round(extract(epoch FROM k.expires_at - k.created_at)/60) FROM broker_keys b JOIN project_api_keys k ON k.id=b.key_id WHERE b.runtime_id='${runtimeId}' AND k.revoked_at IS NULL ORDER BY b.created_at`);
    const workspace = await client.call("workspace.create", { request_id: "w-credits", repo: { path: checkout }, title: "Caveman on credits", engine: "caveman", options: { model: MODEL } });
    await client.call("queue.list", { session_id: workspace.session_id });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(mintedFor(), "a key minted before any turn needed one").toBe("");
    const events: Array<SessionEvent> = [];
    const sub = await client.attach(workspace.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t1", session_id: workspace.session_id, kind: "followup", input: { text: "hello from the lid" } });
    await until(() => events.some((e) => e.type === "turn.done"), 180_000);
    const [keyId, keyPerson, lifetime] = mintedFor().split("\n")[0]!.split(" ");
    expect(keyPerson, "the key is the computer's person's").toBe(me.user.id);
    expect(lifetime, "it lives an hour").toBe("60");
    expect(mintedFor().split("\n"), "one key for the turn").toHaveLength(1);
    results.key = { key_id: keyId, minutes: lifetime };
    const done = events.find((e) => e.type === "turn.done")!.payload as { status: string; error?: string };
    const reply = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : [])).at(-1);
    results.turn1 = { status: done.status, error: done.error, reply };
    expect(done.status, JSON.stringify(done)).toBe("completed");
    expect(reply).toBe("paid from your plan, on a Cloud computer");
    // Sent with the computer's key, as Caveman Code, and the broker admitted it on the person's plan.
    const first = seen.filter((s) => s.admitted === 200);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((s) => s.keyId === keyId && CLIENT.test(s.client ?? ""))).toBe(true);
    const billed = sql(`SELECT source||' '||state FROM broker_requests WHERE key_id='${keyId}' ORDER BY created_at`).split("\n");
    results.billed = billed;
    expect(billed.length).toBeGreaterThan(0);
    expect(billed.every((row) => row.startsWith("plan "))).toBe(true);
    // Nothing of it on the computer's disk: not its state, not its home, not its link.
    const secret = first[0]!.key;
    expect(secret.startsWith("cave_")).toBe(true);
    for (const dir of [scratch, linkDir, checkout]) expect(holding(dir, secret), dir).toEqual([]);
    // Nor in the chat's transcript.
    expect(JSON.stringify(events)).not.toContain(secret);

    // 2. The runtime revoked (its computer deleted or re-placed): the key it still holds spends nothing.
    sql(`UPDATE code_runtimes SET status='revoked', revoked_at=now(), token_hash=NULL, token_expires_at=NULL WHERE id='${runtimeId}';`);
    const before = seen.length;
    await client.call("turn.submit", { request_id: "t2", session_id: workspace.session_id, kind: "followup", input: { text: "and again" } });
    await until(() => events.filter((e) => e.type === "turn.done").length >= 2, 180_000);
    const second = events.filter((e) => e.type === "turn.done")[1]!.payload as { status: string; error?: string };
    results.turn2 = second;
    expect(second.status).not.toBe("completed");
    // Refused by the broker for good (403 key_revoked, an invalid key at the gateway), never as a passing outage.
    expect(seen.slice(before).length).toBeGreaterThan(0);
    expect(seen.slice(before).every((s) => s.admitted === 403 && s.reason === "key_revoked"), JSON.stringify(seen.slice(before))).toBe(true);
    expect(sql(`SELECT count(*) FROM broker_requests WHERE key_id='${keyId}'`)).toBe(String(billed.length));
    await sub.detach();
    client.close();
    if (env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
  },
  600_000,
);
