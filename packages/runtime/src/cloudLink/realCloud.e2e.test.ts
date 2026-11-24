// The runtime's Cloud link against a REAL Caveman Cloud stack (control-api,
// relay, Valkey and Postgres; not the stand-in testCloud.ts):
// 1. the Code sign-in through Cloud's device flow, approved over the API as
//    the activate page does; enrollment; the relay link; a client attaching
//    through the relay with the person's bearer and running a turn; the
//    account; the org's computers; sign-out revoking the runtime;
// 2. the routes the app calls with its kept sign-in (account, credits,
//    projects) and with the runtime's own token (plugins, Cloud computers,
//    This Mac's usage and the Spend API, connections, profile);
// 3. This Mac's profile, repository secrets and server keys reaching a Cloud
//    computer's runtime, and the access log of those reads;
// 4. an MCP server connection through Cloud's own OAuth sign-in (consent
//    page, callback, lease, refresh, delete revoking at the server).
//
// Skipped unless CAVEMAN_E2E_CLOUD_URL names a Cloud origin (one origin with
// /relay routed to the relay, as the chart's ingress does) and
// CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD sign a person in there (legacy
// auth: a local stack's seeded owner), or CAVEMAN_E2E_TOKEN is their access
// token. CAVEMAN_E2E_RELAY2_URL (a second relay replica) adds the cross-replica
// check; test 3 also needs CAVEMAN_E2E_PSQL (SQL on the stack's database) to
// mint the computer's identity as the computers service does; test 4 needs
// CAVEMAN_E2E_MCP_PORT, a 127.0.0.1 port Cloud's CAVE_SSRF_ALLOWLIST admits.
import { randomUUID } from "node:crypto";

import { connect, type DeviceKey } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";

import { allowedOn } from "../session-protocol/devices.testkit.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";

const CLOUD = process.env.CAVEMAN_E2E_CLOUD_URL;
const EMAIL = process.env.CAVEMAN_E2E_EMAIL;
const PASSWORD = process.env.CAVEMAN_E2E_PASSWORD;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function personSession() {
  // A token instead of a password sign-in: Cloud rate-limits sign-ins per address.
  const token = process.env.CAVEMAN_E2E_TOKEN;
  if (token) {
    const me = await fetch(`${CLOUD}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    return { access_token: token, user: ((await me.json()) as { user: { id: string; organization_id: string; email: string } }).user };
  }
  const response = await fetch(`${CLOUD}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; user: { id: string; organization_id: string; email: string } };
}

const api = async (token: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${CLOUD}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined };
};

/**
 * A client attached to a runtime through the real relay with the person's Cloud bearer. With `local` (This Mac's own
 * client), it is a device This Mac allowed (devices.ts): its calls go sealed.
 */
async function attach(runtimeId: string, bearer: string, origin = CLOUD, local?: Parameters<typeof allowedOn>[1], device?: DeviceKey) {
  const url = new URL(`/relay/v1/runtimes/${runtimeId}`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
  const replies: Array<any> = [];
  ws.on("message", (data) => replies.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`relay answered ${res.statusCode}`)));
  });
  let next = 1;
  const allowed = local ? await allowedOn({ send: (text) => ws.send(text), replies: () => replies }, local, device) : undefined;
  const call = async (method: string, params: unknown) => {
    let reply: any;
    if (allowed) reply = await allowed.call(method, params);
    else {
      const id = next++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await until(() => replies.some((r) => r.id === id), 30_000);
      reply = replies.find((r) => r.id === id);
    }
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
    return reply.result as Record<string, any>;
  };
  /** What the runtime sent, opened with the device's key where it is a device This Mac allowed. */
  const received = async (): Promise<ReadonlyArray<any>> => (allowed ? allowed.opened() : replies);
  return { ws, replies, received, call, device: allowed?.device, close: () => ws.close() };
}

test.skipIf(!CLOUD || !((EMAIL && PASSWORD) || process.env.CAVEMAN_E2E_TOKEN))(
  "real Cloud: Code sign-in, enroll, relay link, a relayed client runs a turn, account and sign-out",
  async () => {
    const person = await personSession();
    const config = await makeConfig();
    const runtime = await startRuntime(config, "fake-claude");
    cleanups.push(runtime.close);
    const local = connect(runtime.url, runtime.token, () => {});
    cleanups.push(() => local.close());

    await local.call("settings.set", { request_id: "cloud-url", settings: { cloud_url: CLOUD! } });
    const signin = (await local.call("cloud.signin", { request_id: "s1" })) as { user_code: string; verification_uri_complete: string };
    expect(new URL(signin.verification_uri_complete).searchParams.get("connection")).toBe("code");
    // The activate page's approval for connection=code (cloud/web app/activate, lib/mcp-connection.ts codeConnectionGrant): it names a project.
    const projects = await api(person.access_token, "GET", "/api/v1/projects");
    const approved = await api(person.access_token, "POST", "/api/v1/auth/device/approve", {
      user_code: signin.user_code,
      project_id: projects.body.data[0].id,
      agent_connection: { name: "Caveman Code", scopes: ["org:read", "code:read", "code:write", "billing:write", "org:update"] },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await until(async () => (await local.call("cloud.status", {})).runtime_id !== undefined, 30_000);
    const status = (await local.call("cloud.status", {})) as Record<string, any>;
    expect(status).toMatchObject({ state: "off" });
    expect(status.account?.email).toBe(person.user.email);
    const runtimeId = status.runtime_id as string;

    // Cloud lists it for the person.
    const listed = await api(person.access_token, "GET", "/api/v1/code/runtimes");
    expect(listed.status).toBe(200);
    expect(listed.body.runtimes.map((r: { id: string }) => r.id)).toContain(runtimeId);

    // Off: the relay has no control connection for it, so a client is closed with 4404.
    const early = await attach(runtimeId, person.access_token);
    const closed = await new Promise<number>((resolve) => early.ws.once("close", (code) => resolve(code)));
    expect(closed).toBe(4404);

    await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
    await until(async () => (await local.call("cloud.status", {})).state === "connected", 30_000);

    const client = await attach(runtimeId, person.access_token, CLOUD, local);
    cleanups.push(client.close);
    const { engines } = await client.call("engine.list", {});
    expect(engines.map((e: { id: string }) => e.id)).toContain("claude-agent");
    const repo = makeRepo(tempRoot("real-cloud-repo-"), { "README.md": "hello\n" });
    const workspace = await client.call("workspace.create", { request_id: "w1", repo: { path: repo }, title: "Relayed", engine: "claude-agent", options: { model: MODEL } });
    await client.call("session.attach", { session_id: workspace.session_id, cursor: 0 });
    await client.call("turn.submit", { request_id: "t1", session_id: workspace.session_id, kind: "followup", input: { text: "hello through the real relay" } });
    const events = async () => (await client.received()).filter((r) => r.method === "session.event").map((r) => r.params as { type: string; payload: Record<string, unknown> });
    await until(async () => (await events()).some((e) => e.type === "turn.done"), 60_000);
    expect(JSON.stringify((await events()).find((e) => e.type === "message.done" && e.payload.role === "assistant"))).toContain("hello through the real relay");

    // A second relay replica (another pod behind the same host) reaches the runtime through Valkey.
    if (process.env.CAVEMAN_E2E_RELAY2_URL) {
      const other = await attach(runtimeId, person.access_token, process.env.CAVEMAN_E2E_RELAY2_URL, local, client.device);
      cleanups.push(other.close);
      const listed2 = await other.call("engine.list", {});
      expect(listed2.engines.map((e: { id: string }) => e.id)).toContain("claude-agent");
      // A reply bigger than pub/sub carries (relay blobOver, 256 KiB) rides a Valkey key across replicas.
      (await import("node:fs")).writeFileSync(`${workspace.root_path}/big.txt`, "x".repeat(600_000));
      const read = await other.call("fs.read", { workspace_id: workspace.id, path: "big.txt", max_bytes: 1_000_000 });
      expect(JSON.stringify(read).length).toBeGreaterThan(600_000);
      other.close();
    }

    // Heartbeats reached Cloud: the runtime is seen.
    await until(async () => {
      const again = await api(person.access_token, "GET", "/api/v1/code/runtimes");
      return again.body.runtimes.some((r: { id: string; last_seen_at: string | null }) => r.id === runtimeId && r.last_seen_at !== null);
    }, 45_000);

    // Settings -> Account over the kept Code sign-in.
    const account = (await local.call("account.get", {})) as Record<string, any>;
    expect(account).toMatchObject({ signed_in: true, email: person.user.email });

    // The organization's computers through the kept sign-in: this Cloud runs them (CAVE_CODE_CLOUD_COMPUTERS).
    const computers = (await local.call("cloud.computers", {})) as { available: boolean; computers: ReadonlyArray<{ id: string }> };
    expect(computers.available).toBe(true);
    expect(computers.computers.map((c) => c.id)).toContain(status.computer_id);

    // Sign-out revokes the runtime in Cloud and ends its relay link (this harness has no Settings to sync: keep Cloud's copies).
    await local.call("cloud.signout", { request_id: "out", delete_cloud_copies: false });
    await until(async () => (await api(person.access_token, "GET", "/api/v1/code/runtimes")).body.runtimes.every((r: { id: string }) => r.id !== runtimeId), 15_000);
    await until(() => client.ws.readyState === WebSocket.CLOSED, 15_000);
  },
  180_000,
);

test.skipIf(!CLOUD || !((EMAIL && PASSWORD) || process.env.CAVEMAN_E2E_TOKEN))(
  "real Cloud: the routes the app calls with its kept Code sign-in and with the runtime's own token",
  async () => {
    const { startSignin } = await import("../session-protocol/cloudSignin.ts");
    const account = await import("./account.ts");
    const computers = await import("./computers.ts");
    const plugins = await import("./plugins.ts");
    const connections = await import("./connections.ts");
    const person = await personSession();
    const dir = tempRoot("real-cloud-link-");
    let kept: import("./account.ts").AccountSession | undefined;
    const store = { load: async () => kept, save: async (s: typeof kept) => void (kept = s) };
    const state = {};
    let done: ((v: unknown) => void) | undefined;
    const finished = new Promise((resolve) => (done = resolve));
    const signinState: { current?: unknown; error?: string } = {};
    const pending = await startSignin({ state: signinState as never, cloudUrl: CLOUD!, dir, name: "E2E Mac", keep: async (s) => void (kept = s), onDone: (identity) => done!(identity) });
    const projects = await api(person.access_token, "GET", "/api/v1/projects");
    const approved = await api(person.access_token, "POST", "/api/v1/auth/device/approve", {
      user_code: pending.user_code,
      project_id: projects.body.data[0].id,
      agent_connection: { name: "Caveman Code", scopes: ["org:read", "code:read", "code:write", "billing:write", "org:update"] },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const identity = (await finished) as import("./identity.ts").Identity;
    expect(signinState.error).toBeUndefined();
    expect(identity.organizationId).toBe(person.user.organization_id);
    expect(identity.userId).toBe(person.user.id);
    expect(kept?.access_token).toBeTruthy();
    const results: Record<string, unknown> = {};

    // Settings -> Account with the device grant (not the person's full session).
    const summary = await account.accountSummary(store);
    expect(summary.email).toBe(person.user.email);
    expect(summary.members.length).toBeGreaterThan(0);
    results.summary = { role: summary.role, credits: summary.credits, members: summary.members.length };

    // Credits: a Cloud without the broker answers 404 for both, and the app shows no credits; with it, a cave_ key.
    results.mintCredits = await account.mintCreditsKey(store).then((k) => `minted ${k.slice(0, 5)}`, (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    expect(results.mintCredits).toMatch(summary.credits === null ? /^404 cave_code_credits_unavailable / : /^minted cave_/);
    if (summary.credits !== null) await account.revokeCreditsKey(store);

    // Projects for plugins, with the device grant.
    const name = `e2e-${randomUUID().slice(0, 8)}`;
    const repo = `github.com/acme/${name}`;
    const project = await plugins.projectForRepository(store, repo, name);
    expect(project.repos).toContain(repo);
    const listedProjects = await plugins.listProjects(store);
    expect(listedProjects.map((p) => p.id)).toContain(project.id);
    const runtimeView = await plugins.runtimePlugins(identity, state, repo);
    expect(runtimeView?.project?.id).toBe(project.id);

    // Cloud computers with the runtime's own token.
    const before = await computers.listCloudComputers(identity, state);
    expect(before.available).toBe(true);
    const ws = await computers.createCloudWorkspace(identity, state, { title: "E2E cloud", repo: "octocat/Hello-World", engine: "caveman" });
    const after = await computers.listCloudComputers(identity, state);
    const computer = after.computers.find((c) => c.id === ws.computer_id);
    expect(computer?.desired_state).toBe("running");
    const workspaces = await api(person.access_token, "GET", "/api/v1/code/workspaces");
    expect(workspaces.status).toBe(200);
    expect(JSON.stringify(workspaces.body)).toContain(ws.workspace_id);
    results.sleep = await computers.setCloudComputer(identity, state, ws.computer_id, "suspended").then((c) => c.desired_state, (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.resume = await computers.setCloudComputer(identity, state, ws.computer_id, "running").then((c) => c.desired_state, (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    expect([results.sleep, results.resume]).toEqual(["suspended", "running"]);

    // This Mac's usage, then Settings -> Spend counts it.
    const sessionId = `ses_${randomUUID()}`;
    const usage = await computers.reportLocalUsage(identity, state, [
      { request_id: `${sessionId}:1`, session_id: sessionId, engine: "claude-agent", model: "claude-haiku-4-5", input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.0002, basis: "billed" }, occurred_at: new Date().toISOString() },
    ]);
    expect(usage.accepted, JSON.stringify(usage)).toBe(1);
    const again = await computers.reportLocalUsage(identity, state, [
      { request_id: `${sessionId}:1`, session_id: sessionId, engine: "claude-agent", model: "claude-haiku-4-5", input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.0002, basis: "billed" }, occurred_at: new Date().toISOString() },
    ]);
    expect(again.duplicates).toBe(1);
    const spend = await api(person.access_token, "GET", "/api/v1/code/spend");
    expect(spend.status, JSON.stringify(spend.body)).toBe(200);
    results.spend = spend.body;
    const mine = (spend.body.rows as Array<{ key: string; label: string; calls: number; measured_usd: number; basis: string }>).find((r) => r.key === sessionId);
    expect(mine).toMatchObject({ label: "E2E Mac", calls: 1, basis: "billed" });
    expect(spend.body.inferred.usd).toBeNull(); // measured stays apart from inferred and verified

    // Connections through Cloud (none yet) with the runtime token.
    results.connections = await connections.listConnections(identity, state).then((c) => c.length, (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.connectionStart = await connections
      .startConnection(identity, state, { provider: "github" })
      .then((c) => (c as { authorize_url: string }).authorize_url, (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    // GitHub is connected on the console's page for Caveman Code (Cloud's GithubConnectPath, which runs the App install
    // and its user authorization for the person's project), not through a Cloud OAuth start.
    expect(results.connectionStart).toMatch(/\/cave-agent\/code$/);
    expect(results.connections).toEqual(expect.any(Number));

    // The access log reads as a list of entries (test 3 fills it).
    const log = await computers.call<{ entries?: unknown[] }>(identity, state, "GET", "access-log");
    expect(Array.isArray(log?.entries)).toBe(true);

    if (process.env.CAVEMAN_E2E_RESULTS) (await import("node:fs")).writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
    await account.accountSignOut(store);
  },
  180_000,
);

/** SQL on the stack's database as its owner, a shell command reading stdin (e.g. `docker exec -i <pg> psql -U postgres -d caveman -v ON_ERROR_STOP=1 -At`). */
const PSQL = process.env.CAVEMAN_E2E_PSQL;

test.skipIf(!CLOUD || !((EMAIL && PASSWORD) || process.env.CAVEMAN_E2E_TOKEN) || !PSQL)(
  "real Cloud: This Mac's profile and secrets reach a Cloud computer's runtime; its reads land in the access log",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { generateKeyPairSync, createPublicKey } = await import("node:crypto");
    const computers = await import("./computers.ts");
    const { enroll, loadIdentity } = await import("./identity.ts");
    const { profileDigest } = await import("./profile.ts");
    const sql = (text: string) => execFileSync("sh", ["-c", PSQL!], { input: text, encoding: "utf8" }).trim();
    const person = await personSession();
    // This Mac: enrolled with the person's session (cloud.enroll).
    const mac = await enroll({ dir: tempRoot("real-cloud-mac-"), cloudUrl: CLOUD!, bearer: person.access_token, name: "Parity Mac" });
    const macState = {};
    const repo = `parity-${randomUUID().slice(0, 8)}`;
    const ws = await computers.createCloudWorkspace(mac, macState, { title: "Parity", repo: `octocat/${repo}`, engine: "caveman" });
    // The computers service's part (Caveman Cloud Sandboxes link.go ensureLink): an identity of the
    // computer's own, owned by whoever asked for it, and the pod observed running.
    const { privateKey } = generateKeyPairSync("ed25519");
    const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const runtimeId = randomUUID();
    sql(`INSERT INTO code_runtimes (id, organization_id, computer_id, name, public_key) VALUES ('${runtimeId}', '${mac.organizationId}', '${ws.computer_id}', 'Cloud computer', '\\x${pub}');
      UPDATE code_computers SET observed_state='running', observed_generation=desired_generation, observed_at=now() WHERE id='${ws.computer_id}';`);
    const linkDir = tempRoot("real-cloud-computer-");
    fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: CLOUD, runtime_id: runtimeId, organization_id: mac.organizationId, computer_id: ws.computer_id, user_id: person.user.id }));
    fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const box = loadIdentity(linkDir);
    const boxState = {};
    const results: Record<string, unknown> = {};

    // This Mac pushes its profile (macSync.pushProfile's call).
    const profile = { version: 2 as const, plugins: { spaces: [], disabled: [], servers: [], installed: [], trustedHooks: [] }, skills: [{ name: "parity-skill", source: "agents-home" as const, files: [{ path: "SKILL.md", content: "---\nname: parity-skill\ndescription: e2e\n---\nhello\n" }] }] };
    const digest = profileDigest(profile);
    results.pushProfile = await computers.call(mac, macState, "PUT", "profile", { profile, digest }).then(() => "ok", (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    // The computer reads it (computerSync's getProfile); a second read with the digest is a 304.
    const pulled = await computers.call<{ profile: unknown; digest: string } | undefined>(box, boxState, "GET", "profile").catch((e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    results.pullProfile = typeof pulled === "string" ? pulled : pulled?.digest === digest ? "same digest" : JSON.stringify(pulled);
    results.pull304 = await computers.call(box, boxState, "GET", "profile", undefined, fetch, { "if-none-match": `"${digest}"` }).then((v) => (v === undefined ? "304" : "body"), (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.computerWritesProfile = await computers.call(box, boxState, "PUT", "profile", { profile, digest }).then(() => "accepted", (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);

    // Repository secrets opted in on This Mac (cloud.secrets.set_available's mirror), resolved on the computer.
    const repository = `github.com/octocat/${repo}`;
    results.putSecrets = await computers.call(mac, macState, "PUT", "secrets", { repository, secrets: [{ name: "PARITY_TOKEN", value: "parity-value-1" }] }).then(() => "ok", (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    results.listSecrets = await computers.call<{ secrets?: Array<{ name: string }> }>(mac, macState, "GET", `secrets?repository=${encodeURIComponent(repository)}`).then((o) => o?.secrets?.map((s) => s.name), (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.resolveOnComputer = await computers
      .call<{ secrets?: Array<{ name: string; value: string }> }>(box, boxState, "POST", `secrets/resolve?repository=${encodeURIComponent(repository)}`, {})
      .then((o) => o?.secrets?.map((s) => `${s.name}=${s.value === "parity-value-1" ? "match" : "differs"}`), (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    results.resolveOtherRepo = await computers
      .call(box, boxState, "POST", `secrets/resolve?repository=${encodeURIComponent("github.com/octocat/other")}`, {})
      .then((o) => JSON.stringify(o), (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.macCannotResolve = await computers
      .call(mac, macState, "POST", `secrets/resolve?repository=${encodeURIComponent(repository)}`, {})
      .then((o) => JSON.stringify(o), (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    // A personal server's opted-in keys (cloud.server.set_available): the reserved caveman:servers key, resolved on the computer.
    const { cloudCredentialName, CLOUD_SERVERS_REPOSITORY } = await import("../plugins/CredentialBroker.ts");
    const { PERSONAL_SPACE_URL } = await import("../plugins/personal.ts");
    const serverKey = cloudCredentialName(PERSONAL_SPACE_URL, "PARITY_API_KEY");
    results.putServerKeys = await computers.call(mac, macState, "PUT", "secrets", { repository: CLOUD_SERVERS_REPOSITORY, secrets: [{ name: serverKey, value: "server-value-1" }] }).then(() => "ok", (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    results.resolveServerKeys = await computers
      .call<{ secrets?: Array<{ name: string; value: string }> }>(box, boxState, "POST", `secrets/resolve?repository=${encodeURIComponent(CLOUD_SERVERS_REPOSITORY)}`, {})
      .then((o) => o?.secrets?.map((s) => `${s.name === serverKey ? "key" : s.name}=${s.value === "server-value-1" ? "match" : "differs"}`), (e: { status?: number; code?: string; message?: string }) => `${e.status} ${e.code} ${e.message}`);
    results.badServerKeyName = await computers.call(mac, macState, "PUT", "secrets", { repository: CLOUD_SERVERS_REPOSITORY, secrets: [{ name: "PLAIN_NAME", value: "x" }] }).then(() => "accepted", (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);

    // Who read what, from This Mac.
    results.accessLog = await computers.call<{ entries?: Array<{ kind?: string; what?: string; [k: string]: unknown }> }>(mac, macState, "GET", "access-log?limit=20").then((o) => o?.entries, (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    results.computerPlugins = await computers.call(box, boxState, "GET", `plugins?repository=${encodeURIComponent(repository)}`).then((o) => o, (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
    // Clean up what this test put in Cloud.
    results.cleanup = await Promise.all([
      computers.call(mac, macState, "DELETE", `secrets/PARITY_TOKEN?repository=${encodeURIComponent(repository)}`).then(() => "ok", (e: { status?: number }) => `${e.status}`),
      computers.call(mac, macState, "DELETE", "profile").then(() => "ok", (e: { status?: number }) => `${e.status}`),
      computers.call(mac, macState, "DELETE", `secrets/${encodeURIComponent(serverKey)}?repository=${encodeURIComponent(CLOUD_SERVERS_REPOSITORY)}`).then(() => "ok", (e: { status?: number }) => `${e.status}`),
    ]);
    if (process.env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
    expect(results.pushProfile).toBe("ok");
    expect(results.pullProfile).toBe("same digest");
    expect(results.resolveOnComputer).toEqual(["PARITY_TOKEN=match"]);
    expect(results.resolveServerKeys).toEqual(["key=match"]);
  },
  180_000,
);

/** The 127.0.0.1 port Cloud's SSRF allowlist admits (CAVE_SSRF_ALLOWLIST=127.0.0.1:<port>), where test 4 serves its MCP server. */
const MCP_PORT = Number(process.env.CAVEMAN_E2E_MCP_PORT ?? "0");

/** An MCP server with its own OAuth server (RFC 9728 discovery, RFC 8414, dynamic registration, PKCE S256, refresh, revocation). */
async function startMcpServer(port: number, ttlSeconds: number) {
  const http = await import("node:http");
  const { createHash, randomBytes } = await import("node:crypto");
  const origin = `http://127.0.0.1:${port}`;
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const revoked: string[] = [];
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = () => {
    const at = `at_${randomBytes(12).toString("hex")}`;
    const rt = `rt_${randomBytes(12).toString("hex")}`;
    access.set(at, Date.now() + ttlSeconds * 1000);
    refresh.add(rt);
    return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: ttlSeconds };
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", origin);
    const form = new URLSearchParams(raw);
    switch (url.pathname) {
      case "/mcp": {
        const expires = access.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
        if (expires === undefined || expires < Date.now())
          return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return json(res, 200, { ok: true });
      }
      case "/.well-known/oauth-protected-resource/mcp":
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      case "/.well-known/oauth-authorization-server":
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      case "/register": {
        const id = `client_${randomBytes(6).toString("hex")}`;
        clients.set(id, JSON.parse(raw || "{}"));
        return json(res, 201, { client_id: id, token_endpoint_auth_method: "none" });
      }
      case "/authorize": {
        const q = url.searchParams;
        if (!clients.get(q.get("client_id") ?? "")?.redirect_uris?.includes(q.get("redirect_uri") ?? "") || q.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
        const code = `code_${randomBytes(8).toString("hex")}`;
        codes.set(code, { client: q.get("client_id")!, challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")! });
        const back = new URL(q.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", origin);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      case "/token": {
        if (form.get("grant_type") === "authorization_code") {
          const c = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const ok = c && c.challenge === createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") && c.redirect === form.get("redirect_uri") && c.client === form.get("client_id");
          return ok ? json(res, 200, issue()) : json(res, 400, { error: "invalid_grant" });
        }
        if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token") ?? "")) return json(res, 200, issue());
        return json(res, 400, { error: "invalid_grant" });
      }
      case "/revoke":
        revoked.push(form.get("token_type_hint") ?? "");
        access.delete(form.get("token") ?? "");
        refresh.delete(form.get("token") ?? "");
        return json(res, 200, {});
    }
    json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { resource: `${origin}/mcp`, revoked, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test.skipIf(!CLOUD || !((EMAIL && PASSWORD) || process.env.CAVEMAN_E2E_TOKEN) || !MCP_PORT)(
  "real Cloud: an MCP server connection through Cloud's own OAuth sign-in: consent, callback, lease, refresh, delete",
  async () => {
    const connections = await import("./connections.ts");
    const { enroll } = await import("./identity.ts");
    const mcp = await startMcpServer(MCP_PORT, 8);
    cleanups.push(mcp.close);
    const person = await personSession();
    const id = await enroll({ dir: tempRoot("real-cloud-mcp-"), cloudUrl: CLOUD!, bearer: person.access_token, name: "MCP Mac" });
    const state = {};
    const code = (e: { code?: string }) => e.code;
    // A clean slate: an earlier run's connection to this address goes first.
    for (const c of await connections.listConnections(id, state)) if (c.resource === mcp.resource) await connections.deleteConnection(id, state, c.connection_id);
    expect(await connections.leaseConnection(id, state, { resource: mcp.resource }).then(() => "leased", code)).toBe("cave_not_found");

    // The person's browser: Caveman's consent page names the account, then Continue with the page's nonce cookie.
    const signIn = async () => {
      const started = await connections.startConnection(id, state, { resource: mcp.resource });
      const page = await fetch(started.authorize_url, { redirect: "manual" });
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain(`Connect <b>127.0.0.1:${MCP_PORT}</b>`);
      const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
      const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? "";
      const press = () =>
        fetch(new URL("/api/v1/code/connections/begin", CLOUD), {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: new URL(CLOUD!).origin },
          body: new URLSearchParams({ state: field("state"), nonce: field("nonce") }),
        });
      const go = await press();
      expect(go.status).toBe(303);
      const authorize = new URL(go.headers.get("location")!);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("resource")).toBe(mcp.resource);
      expect((await press()).status).toBe(400); // consent is recorded once
      return { started, signedIn: await fetch(authorize, { redirect: "manual" }) };
    };
    let { started, signedIn } = await signIn();
    if (signedIn.status === 400) {
      // This server never saw Caveman's registration (a stack that registered with an earlier
      // run's server): it refuses without calling back, and the next start registers again.
      ({ started, signedIn } = await signIn());
    }
    expect(signedIn.status).toBe(302);
    const callback = await fetch(signedIn.headers.get("location")!, { redirect: "manual" });
    expect(callback.status).toBe(200);

    const listed = await connections.listConnections(id, state);
    const mine = listed.find((c) => c.connection_id === started.connection_id);
    expect(mine).toMatchObject({ status: "connected", resource: mcp.resource });
    const first = await connections.leaseConnection(id, state, { resource: mcp.resource });
    expect((await fetch(mcp.resource, { headers: { authorization: `Bearer ${first.access_token}` } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 9_000)); // past the token's 8 s
    const second = await connections.leaseConnection(id, state, { resource: mcp.resource });
    expect(second.access_token).not.toBe(first.access_token);
    expect((await fetch(mcp.resource, { headers: { authorization: `Bearer ${second.access_token}` } })).status).toBe(200);

    await connections.deleteConnection(id, state, started.connection_id);
    expect(mcp.revoked.sort()).toEqual(["access_token", "refresh_token"]);
    expect(await connections.leaseConnection(id, state, { resource: mcp.resource }).then(() => "leased", code)).toBe("cave_not_found");
  },
  120_000,
);
