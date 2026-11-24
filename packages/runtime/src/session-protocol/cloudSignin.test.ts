// Remote control's sign-in on the real runtime against a stand-in Cloud
// (device flow, enroll, logout, runtime token, self-revoke): the runtime
// shows a code, enrolls once the person approves, and the credential Cloud
// issued is in no file, no receipt, no notification and no log line.
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { connect, type CloudStatus, type SessionEvent } from "@caveman-app/session-protocol";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { KEY_FILE, LEFT_FILE, RECORD_FILE } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import { AppProxyLauncher, type AppProxyStates } from "../router/proxyLauncher.ts";
import { startSignin } from "./cloudSignin.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Device codes the test approves by hand; every call Cloud saw, with its bearer. */
async function fakeCloud(options: { expiresIn?: number; codeStatus?: number; verifyHost?: string; plan?: string; gateway?: string | null } = {}) {
  const access = `cave_access_${randomBytes(12).toString("hex")}`;
  const refresh = `cave_refresh_${randomBytes(12).toString("hex")}`;
  const ack = `ack_${randomBytes(12).toString("hex")}`;
  const state = {
    access,
    refresh,
    ack,
    creditsKey: `cave_live_${randomBytes(12).toString("hex")}`,
    routingKey: "cave_fake_paid_router_0123456789abcdef",
    creditsKeyIds: [] as string[],
    creditsKeysRevoked: [] as string[],
    approved: new Set<string>(),
    /** Device codes the person denied on the activate page (RFC 8628 access_denied). */
    denied: new Set<string>(),
    codes: [] as Array<{ device: string; user: string; body: unknown }>,
    calls: [] as Array<{ path: string; bearer: string | undefined; body: Record<string, unknown> }>,
    organizationId: randomUUID(),
    enrolled: [] as string[],
    /** Runtime tokens minted, by token: the runtime each one is. */
    tokens: new Map<string, string>(),
    revoked: new Set<string>(),
    /** Holds enroll's answer until released (a sign-out racing an enrollment). */
    enrollGate: undefined as Promise<void> | undefined,
    /** Refuses enroll with this status (403: a role that cannot hold a runtime), or drops the connection ("network"). */
    enrollRefusal: undefined as 403 | "network" | undefined,
    /** Pay as you go as Cloud keeps it (undefined until first set), and whether a card is saved for it. */
    autoTopup: undefined as Record<string, unknown> | undefined,
    card: false,
  };
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = new URL(request.url ?? "/", "http://x");
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    state.calls.push({ path: url.pathname, bearer, body });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json", date: new Date().toUTCString() });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/v1/auth/device/code") {
      if (options.codeStatus) return json(options.codeStatus, { error: { code: "cave_busy", message: "busy" } });
      const device = randomBytes(16).toString("hex");
      const user = `${randomBytes(2).toString("hex").toUpperCase()}-WXYZ`;
      state.codes.push({ device, user, body });
      const verify = `http://${options.verifyHost ?? `127.0.0.1:${(server.address() as AddressInfo).port}`}/activate`;
      return json(200, { device_code: device, user_code: user, verification_uri: verify, verification_uri_complete: `${verify}?user_code=${user}&connection=code`, expires_in: options.expiresIn ?? 600, interval: 1 });
    }
    if (url.pathname === "/api/v1/auth/device/token") {
      if (state.denied.has(String(body.device_code))) return json(400, { error: "access_denied" });
      if (!state.approved.has(String(body.device_code))) return json(400, { error: "authorization_pending" });
      // The gateway this Cloud runs (control-api's CAVE_GATEWAY_URL): a stand-in on loopback unless the test names one, or none.
      const gateway = options.gateway === null ? {} : { gateway_url: options.gateway ?? "http://127.0.0.1:9" };
      return json(200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900, credential_kind: "none", delivery_ack_token: ack, ...gateway });
    }
    if (url.pathname === "/api/v1/auth/device/ack") return bearer === access ? json(200, { acknowledged: true }) : json(401, { error: { code: "cave_unauthorized" } });
    if (url.pathname === "/api/v1/auth/logout") return json(200, { revoked: bearer === access && body.refresh_token === refresh });
    if (url.pathname === "/api/v1/auth/me") return bearer === access ? json(200, { user: { email: "ada@example.com", organization_id: state.organizationId } }) : json(401, {});
    if (url.pathname === "/api/v1/org") return bearer === access ? json(200, { id: state.organizationId, name: "Analytical Engines" }) : json(401, {});
    // Settings -> Account, with the kept sign-in.
    if (url.pathname === "/api/v1/org/members") return bearer === access ? json(200, { data: [{ user: { email: "ada@example.com", name: "Ada" }, role: "owner", status: "active" }] }) : json(401, {});
    if (url.pathname === "/api/v1/code/credits")
      return bearer === access
        ? json(200, { plan: options.plan ?? "pro", seats: 1, windows: [{ window: "month", used_pct: 16 }], balance_micros: 10_000_000, grants: [], use_balance: true, contributor_opt_in: false, ...(state.autoTopup ? { auto_topup: state.autoTopup } : {}) })
        : json(401, {});
    // Pay as you go (docs/): the view PUT answers, and the card's setup Checkout.
    if (url.pathname === "/api/v1/code/credits/auto" && request.method === "PUT") {
      if (bearer !== access) return json(401, {});
      const limit = typeof body.month_limit_usd === "number" ? body.month_limit_usd : 500;
      const add = typeof body.amount_usd === "number" ? body.amount_usd : Math.min(2000, Math.ceil(limit / 10));
      state.autoTopup = {
        enabled: body.enabled,
        month_limit_usd: limit,
        amount_usd: add,
        below_usd: typeof body.below_usd === "number" ? body.below_usd : Math.floor(add / 2),
        charged_micros: 0,
        charging: false,
        card: state.card ? { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } : null,
        paused: null,
        confirm_url: null,
        ceiling_usd: 10000,
        next_ceiling: { month_usd: 50000, after_paid_usd: 2000, after_days: 30, paid_usd: 350 },
      };
      return json(200, state.autoTopup);
    }
    if (url.pathname === "/api/v1/code/credits/auto/card" && request.method === "POST") return bearer === access ? json(200, { url: "https://checkout.stripe.test/setup" }) : json(401, {});
    if (url.pathname === "/api/v1/code/router/keys") {
      if (bearer !== access) return json(401, {});
      return options.plan === "free" ? json(402, { error: { code: "cave_code_router_paid_required" } }) : json(201, { id: "router-id", full_key: state.routingKey, scopes: ["router:write"], expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.pathname === "/api/v1/code/credits/checkout") return bearer === access ? json(200, { url: `https://checkout.stripe.test/${body.amount_usd}` }) : json(401, {});
    if (url.pathname === "/api/v1/code/credits/keys") {
      if (bearer !== access) return json(401, {});
      const id = randomUUID();
      state.creditsKeyIds.push(id);
      return json(201, { id, full_key: state.creditsKey });
    }
    const revoke = /^\/api\/v1\/code\/credits\/keys\/([^/]+)$/.exec(url.pathname);
    if (revoke && request.method === "DELETE") {
      if (bearer !== access) return json(401, {});
      state.creditsKeysRevoked.push(revoke[1]!);
      response.writeHead(204);
      return response.end();
    }
    if (url.pathname === "/api/v1/code/runtimes" && request.method === "POST") {
      if (bearer !== access) return json(401, { error: { code: "cave_unauthorized", message: "Authentication required." } });
      // Cloud's own refusal for a role without code:write (control-api httpapi require()).
      if (state.enrollRefusal === 403) return json(403, { error: { code: "cave_forbidden", message: "Role lacks required permission." } });
      if (state.enrollRefusal === "network") return void request.socket.destroy();
      const id = randomUUID();
      state.enrolled.push(id);
      await state.enrollGate;
      return json(201, { id, organization_id: state.organizationId, computer_id: randomUUID(), status: "active" });
    }
    const mint = /^\/api\/v1\/code\/runtimes\/([^/]+)\/token$/.exec(url.pathname);
    if (mint) {
      if (state.revoked.has(mint[1]!)) return json(401, { error: { code: "cave_code_assertion_refused" } });
      const token = `ccrt_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
      state.tokens.set(token, mint[1]!);
      return json(200, { token, expires_at: new Date(Date.now() + 900_000).toISOString() });
    }
    if (url.pathname === "/api/v1/code/runtime/revoke") {
      const id = state.tokens.get(bearer ?? "");
      if (!id) return json(401, { error: { code: "cave_unauthorized" } });
      state.revoked.add(id);
      return json(200, { status: "revoked" });
    }
    json(404, { error: { code: "not_found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

/** Everything the process writes to the console while `fn` runs. */
function captureOutput() {
  const lines: string[] = [];
  const restore: Array<() => void> = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => (lines.push(String(chunk)), write(chunk as never, ...(rest as never[])))) as typeof stream.write;
    restore.push(() => (stream.write = write));
  }
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => (lines.push(args.map(String).join(" ")), original(...args));
    restore.push(() => (console[level] = original));
  }
  cleanups.push(() => restore.forEach((r) => r()));
  return lines;
}

test("cloud.signin: the runtime runs the device flow, enrolls, and keeps the credential only in its secret store", { timeout: 90_000 }, async () => {
  const output = captureOutput();
  const cloud = await fakeCloud();
  const config = await makeConfig();
  // The Caveman engine's key store, for Caveman credits.
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const pushed: CloudStatus[] = [];
  client.on("cloud.changed", (status) => pushed.push(status));

  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url, remote_control: true } });
  await until(async () => (await client.call("cloud.status", {})).state === "not_enrolled", 10_000);
  const started = await client.call("cloud.signin", { request_id: "s1" });
  expect(cloud.state.codes[0]!.body).toEqual({ connection: "code" });
  expect(started.user_code).toBe(cloud.state.codes[0]!.user);
  expect(started.verification_uri_complete).toContain("connection=code");
  expect((await client.call("cloud.status", {})).signin?.user_code).toBe(started.user_code);
  // The client hears it without asking.
  await until(() => pushed.some((s) => s.signin?.user_code === started.user_code), 5_000);

  // Still waiting while Cloud says authorization_pending.
  await until(() => cloud.state.calls.filter((c) => c.path === "/api/v1/auth/device/token").length >= 2, 10_000);
  expect((await client.call("cloud.status", {})).runtime_id).toBeUndefined();

  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).runtime_id !== undefined, 15_000);
  const status = await client.call("cloud.status", {});
  expect(status.signin).toBeUndefined();
  expect(status.signin_error).toBeUndefined();
  await until(() => pushed.some((s) => s.runtime_id !== undefined && !s.signin), 5_000);
  // Whoever approved the code links this computer, and it says who; it drives it only from a device allowed here
  // (devices.ts), so Remote control follows sync again (S13), and sync is not on.
  expect(status.account).toEqual({ email: "ada@example.com", organization_name: "Analytical Engines" });
  expect(status.state).toBe("off");
  expect((await client.call("settings.get", {})).remote_control).toBeUndefined();
  await until(() => cloud.state.calls.some((c) => c.path === "/api/v1/code/router/keys"), 5_000);

  // The credential was used for ack, who approved and enroll, and kept for Settings -> Account (not signed out).
  expect(cloud.state.calls.filter((c) => c.bearer === cloud.state.access).map((c) => c.path)).toEqual([
    "/api/v1/auth/device/ack",
    "/api/v1/auth/me",
    "/api/v1/org",
    "/api/v1/code/runtimes",
    "/api/v1/code/router/keys",
  ]);
  // Kept sealed in the runtime's secret store: no file holds it in the clear (an engine's shell reads only ciphertext), nor the output or a client.
  const files = () => fs.readdirSync(config.stateDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
  expect(files().length).toBeGreaterThan(0);
  // Skipped on Windows: no POSIX mode bits (the profile's ACL keeps the store).
  if (process.platform !== "win32") expect(files().filter((file) => file.includes(`${path.sep}secrets${path.sep}`) && fs.statSync(file).mode & 0o077)).toEqual([]);
  for (const secret of [cloud.state.access, cloud.state.refresh, cloud.state.routingKey]) {
    expect(files().filter((file) => fs.readFileSync(file).includes(secret))).toEqual([]);
  }
  for (const secret of [cloud.state.access, cloud.state.refresh, cloud.state.ack]) {
    expect(output.filter((line) => line.includes(secret))).toEqual([]);
    expect(JSON.stringify(pushed)).not.toContain(secret);
  }

  // Settings -> Account reads through the kept sign-in, and a top-up opens Stripe Checkout.
  const account = await client.call("account.get", {});
  expect(account).toMatchObject({ signed_in: true, email: "ada@example.com", organization_name: "Analytical Engines", credits: { plan: "pro", balance_micros: 10_000_000 }, members: [{ email: "ada@example.com", role: "owner" }] });
  expect(JSON.stringify(account)).not.toContain(cloud.state.access);
  expect(await client.call("account.checkout", { request_id: "topup", kind: "topup", amount_usd: 25 })).toEqual({ url: "https://checkout.stripe.test/25" });
  // Pay as you go: on with no card saved opens Stripe to save one; once one is saved, a new limit is just saved.
  expect(account.credits).not.toHaveProperty("auto_topup");
  expect(await client.call("account.auto_topup", { request_id: "payg-on", enabled: true, month_limit_usd: 10000 })).toEqual({
    auto_topup: expect.objectContaining({ enabled: true, month_limit_usd: 10000, amount_usd: 1000, below_usd: 500, card: null, paused: null, confirm_url: null }),
    url: "https://checkout.stripe.test/setup",
  });
  cloud.state.card = true;
  expect(await client.call("account.auto_topup", { request_id: "payg-limit", enabled: true, month_limit_usd: 2000, amount_usd: 300, below_usd: 100 })).toEqual({
    auto_topup: expect.objectContaining({ enabled: true, month_limit_usd: 2000, amount_usd: 300, below_usd: 100, card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } }),
  });
  expect((await client.call("account.get", {})).credits?.auto_topup).toMatchObject({ enabled: true, month_limit_usd: 2000, ceiling_usd: 10000, next_ceiling: { paid_usd: 350 } });
  expect(await client.call("account.auto_topup_card", { request_id: "payg-card" })).toEqual({ url: "https://checkout.stripe.test/setup" });
  await expect(client.call("account.auto_topup", { request_id: "payg-cents", enabled: true, month_limit_usd: 10.5 })).rejects.toThrow(/whole dollars/);
  await expect(client.call("account.auto_topup", { request_id: "payg-below", enabled: true, below_usd: 0 })).rejects.toThrow(/whole dollars/);
  expect(cloud.state.calls.filter((c) => c.path.startsWith("/api/v1/code/credits/auto")).map((c) => [c.path, c.body, c.bearer === cloud.state.access])).toEqual([
    ["/api/v1/code/credits/auto", { enabled: true, month_limit_usd: 10000 }, true],
    ["/api/v1/code/credits/auto/card", {}, true],
    ["/api/v1/code/credits/auto", { enabled: true, month_limit_usd: 2000, amount_usd: 300, below_usd: 100 }, true],
    ["/api/v1/code/credits/auto/card", {}, true],
  ]);
  // Caveman credits on the Caveman engine: a credits key minted for this person, kept as the engine's key, never shown.
  expect(account.credits_on).toBe(false);
  // Two enables at once (a double click, two clients) mint one key.
  expect(
    await Promise.all([client.call("account.credits", { request_id: "credits-on", enabled: true }), client.call("account.credits", { request_id: "credits-on-twice", enabled: true })]),
  ).toEqual([{ enabled: true }, { enabled: true }]);
  expect(cloud.state.creditsKeyIds).toHaveLength(1);
  expect((await client.call("account.get", {})).credits_on).toBe(true);
  const engines = await client.call("engine.list", {});
  expect(JSON.stringify(engines)).not.toContain(cloud.state.creditsKey);
  expect(output.filter((line) => line.includes(cloud.state.creditsKey))).toEqual([]);
  // On while on keeps the key it holds; off revokes it in Cloud.
  await client.call("account.credits", { request_id: "credits-on-again", enabled: true });
  expect(cloud.state.creditsKeyIds).toHaveLength(1);
  expect(await client.call("account.credits", { request_id: "credits-off", enabled: false })).toEqual({ enabled: false });
  expect((await client.call("account.get", {})).credits_on).toBe(false);
  expect(cloud.state.creditsKeysRevoked).toEqual(cloud.state.creditsKeyIds);
  // On again: signing out revokes and forgets the credits key with the sign-in.
  await client.call("account.credits", { request_id: "credits-on-2", enabled: true });

  // Sign out: Cloud revokes this runtime (its own token), the kept sign-in is signed out and forgotten, Remote control goes off.
  await client.call("cloud.signout", { request_id: "out" });
  expect([...cloud.state.revoked]).toEqual([status.runtime_id]);
  expect(cloud.state.calls.find((c) => c.path === "/api/v1/auth/logout")).toMatchObject({ bearer: cloud.state.access, body: { refresh_token: cloud.state.refresh } });
  expect(cloud.state.creditsKeyIds).toHaveLength(2);
  expect(cloud.state.creditsKeysRevoked).toEqual(cloud.state.creditsKeyIds);
  expect(fs.existsSync(path.join(config.stateDir, "cloud-link", "runtime.json"))).toBe(false);
  expect(fs.existsSync(path.join(config.stateDir, "cloud-link", "runtime.key"))).toBe(false);
  expect((await client.call("settings.get", {})).remote_control).toBe(false);
  await until(async () => {
    const after = await client.call("cloud.status", {});
    return after.state === "off" && after.runtime_id === undefined;
  }, 10_000);
  expect(await client.call("account.get", {})).toEqual({ signed_in: false, credits_on: false });
});

// Cloud keeps a synced chat's registration on the computer that synced it, past a sign-out: the next sign-in must be
// that computer again, or every such chat reads as moved away from this Mac.
test("signing out and in again keeps This Mac the same computer in Caveman: its synced chats stay here and take sends", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await client.call("settings.set", { request_id: "sync", settings: { sync_chats: true } });
  const w = await createReady(client, { request_id: "w1", repo: { path: makeRepo(tempRoot("signout-in-"), { "README.md": "hello\n" }) }, title: "Mine", engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const turnsDone = () => events.filter((e) => e.type === "turn.done").length;
  await client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "remember this turn" } });
  await until(() => turnsDone() === 1, 60_000);
  const first = await client.call("cloud.status", {});
  await until(() => cloud.state.chats.summaries.get(w.session_id)?.runtime_id === first.runtime_id, 30_000);
  // Its copy is done before Cloud goes out of reach: one cut off mid-way leaves its journal lease held for its 90 s, and
  // the next sign-in copies only once that runs out (the runtime tries again until then), which is not this test.
  await until(async () => {
    const head = (await client.call("workspace.get", { workspace_id: w.id })).head;
    return cloud.state.chats.sessions.get(w.session_id)?.lease === null && cloud.state.chats.copyOf(w.session_id).at(-1)?.cursor === head;
  }, 30_000);

  // Signed out while Cloud cannot be reached, then in again.
  cloud.state.unreachable = true;
  await client.call("cloud.signout", { request_id: "out", delete_cloud_copies: false });
  // Signed out: no link and no key, only which computer this was.
  const link = linkDirOf(config.stateDir);
  expect([RECORD_FILE, KEY_FILE].filter((file) => fs.existsSync(path.join(link, file)))).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(link, LEFT_FILE), "utf8"))).toEqual({ cloud_url: cloud.url, runtime_id: first.runtime_id, computer_id: first.computer_id });
  cloud.state.unreachable = false;
  await client.call("cloud.enroll", { request_id: "e2", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  const second = await client.call("cloud.status", {});
  expect(second.runtime_id).not.toBe(first.runtime_id);

  // The person carries on in the chat: its next turn copies to Cloud under the new sign-in, or Cloud refuses the chat as
  // another computer's and it parks as moved away.
  await client.call("turn.submit", { request_id: "t2", session_id: w.session_id, kind: "followup", input: { text: "and on" } });
  const chat = () => client.call("workspace.get", { workspace_id: w.id });
  await until(async () => {
    const now = await chat();
    return now.status === "parked" || (turnsDone() === 2 && (cloud.state.chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === now.head);
  }, 60_000).catch(async (error: Error) => {
    const now = await chat();
    const copied = cloud.state.chats.copyOf(w.session_id).at(-1)?.cursor ?? null;
    throw new Error(`${error.message} waiting for turn 2's copy: ${JSON.stringify({ status: now.status, head: now.head, copied, turnsDone: turnsDone() })}`);
  });
  expect(await chat()).toMatchObject({ status: "idle", computer: w.computer });
  expect(second.computer_id).toBe(first.computer_id);
  await until(() => cloud.state.chats.summaries.get(w.session_id)?.runtime_id === second.runtime_id, 30_000);
});

test("cloud.signout: answers without waiting on proxies that never come up, and the proxies' sign-in is gone", { timeout: 90_000 }, async () => {
  const cloud = await fakeCloud();
  const config = await makeConfig();
  // The app's proxies are down and a new one never answers on its port: a launch never settles.
  let signingOut = false;
  let launched!: () => void;
  const launchedWhileSigningOut = new Promise<void>((resolve) => (launched = resolve));
  const stuckProxies = Layer.succeed(AppProxyLauncher, () => {
    if (signingOut) launched();
    return new Promise<AppProxyStates>(() => undefined);
  });
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)), stuckProxies) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  await client.call("cloud.signin", { request_id: "s1" });
  await until(() => cloud.state.codes.length === 1, 10_000);
  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).runtime_id !== undefined, 15_000);
  // Credits on: the proxies' sign-in is written where they read it.
  await client.call("account.credits", { request_id: "credits-on", enabled: true });
  const home = path.join(config.stateDir, "proxy");
  const proxiesCloud = () => JSON.parse(fs.readFileSync(path.join(home, "cloud.json"), "utf8")) as Record<string, unknown>;
  expect({ baseURL: proxiesCloud().baseURL, credentials: fs.existsSync(path.join(home, "credentials")) }).toEqual({ baseURL: cloud.url, credentials: true });

  signingOut = true;
  const outcome = await Promise.race([
    client.call("cloud.signout", { request_id: "out" }).then(() => "answered"),
    launchedWhileSigningOut.then(() => "waiting for the proxies to come up"),
  ]);
  expect({ outcome, cloud: proxiesCloud(), credentials: fs.existsSync(path.join(home, "credentials")) }).toEqual({
    outcome: "answered",
    cloud: { telemetry: { enabled: false } },
    credentials: false,
  });
});

test("cloud.signin: an expired code ends the sign-in with a reason; a Cloud computer refuses it", { timeout: 60_000 }, async () => {
  const cloud = await fakeCloud({ expiresIn: 2 });
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  await client.call("cloud.signin", { request_id: "s1" });
  // A code that runs out unapproved is replaced by a new one (three times); then the sign-in ends with the reason.
  await until(async () => (await client.call("cloud.status", {})).signin_error === "The code expired. Sign in again.", 40_000);
  expect((await client.call("cloud.status", {})).signin).toBeUndefined();
  expect(cloud.state.codes).toHaveLength(4);

  // Not https and not loopback: refused before anything is sent.
  await client.call("settings.set", { request_id: "bad", settings: { cloud_url: "http://cloud.example.com" } });
  await expect(client.call("cloud.signin", { request_id: "s2" })).rejects.toThrow(/https/);
});

test("cloud.signin: a code that expires is replaced by a new one the person can still approve", { timeout: 60_000 }, async () => {
  const cloud = await fakeCloud({ expiresIn: 2 });
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  const first = await client.call("cloud.signin", { request_id: "s1" });
  // The status shows the new code, not an error, once the first ran out.
  await until(async () => (await client.call("cloud.status", {})).signin?.user_code === cloud.state.codes[1]?.user, 20_000);
  const status = await client.call("cloud.status", {});
  expect(status.signin?.user_code).not.toBe(first.user_code);
  expect(status.signin_error).toBeUndefined();
  // Approving the new code signs in and enrolls.
  cloud.state.approved.add(cloud.state.codes[1]!.device);
  await until(async () => (await client.call("cloud.status", {})).runtime_id !== undefined, 15_000);
  expect((await client.call("cloud.status", {})).signin_error).toBeUndefined();
});

// UX plan N11 (DECIDED D1: the account stays first): Cloud knows the account but does not register this computer, so
// the person stays signed in with no runtime identity and Remote control off, and can try again.
test("cloud.signin: a refused registration (403) keeps the account with no runtime identity and Remote control off", { timeout: 90_000 }, async () => {
  const cloud = await fakeCloud();
  cloud.state.enrollRefusal = 403;
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const linkDir = path.join(config.stateDir, "cloud-link");

  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url, remote_control: true } });
  await client.call("cloud.signin", { request_id: "s1" });
  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).account !== undefined, 15_000);
  const status = await client.call("cloud.status", {});
  // Signed in as ada, with no computer registered: no runtime, no link, no sync, and why it is off.
  expect(status.account).toEqual({ email: "ada@example.com", organization_name: "Analytical Engines" });
  expect(status).toMatchObject({ state: "off", signin_error: "Your role in your Caveman organization cannot turn on remote control (Engineer, Admin or Owner can)." });
  for (const key of ["runtime_id", "computer_id", "cloud_url", "signin", "sync", "capabilities", "usage_reported"] as const) expect(status).not.toHaveProperty(key);
  expect((await client.call("settings.get", {})).remote_control).toBe(false);
  expect(fs.existsSync(path.join(linkDir, KEY_FILE))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(linkDir, RECORD_FILE), "utf8"))).toEqual({ cloud_url: cloud.url, account: { email: "ada@example.com", organization_name: "Analytical Engines" } });
  // The session is kept (Settings, Account works), and Cloud was never told to end it.
  expect(await client.call("account.get", {})).toMatchObject({ signed_in: true, email: "ada@example.com" });
  expect(cloud.state.calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(false);
  expect(cloud.state.enrolled).toEqual([]);
  await until(() => cloud.state.calls.some((c) => c.path === "/api/v1/code/router/keys"), 5_000);

  // Try again once the role allows it: the account is the same and the computer registers.
  cloud.state.enrollRefusal = undefined;
  await client.call("cloud.signin", { request_id: "s2" });
  cloud.state.approved.add(cloud.state.codes[1]!.device);
  await until(async () => (await client.call("cloud.status", {})).runtime_id !== undefined, 15_000);
  const registered = await client.call("cloud.status", {});
  expect(registered.account).toEqual({ email: "ada@example.com", organization_name: "Analytical Engines" });
  expect(registered.signin_error).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(path.join(linkDir, RECORD_FILE), "utf8"))).toMatchObject({ runtime_id: registered.runtime_id });

  // Signing out of an account kept without a computer leaves nothing behind, and keeps which computer the first sign-out remembered.
  await client.call("cloud.signout", { request_id: "out1" });
  cloud.state.enrollRefusal = 403;
  await client.call("cloud.signin", { request_id: "s3" });
  cloud.state.approved.add(cloud.state.codes[2]!.device);
  await until(async () => (await client.call("cloud.status", {})).account !== undefined, 15_000);
  await client.call("cloud.signout", { request_id: "out2" });
  expect(fs.existsSync(path.join(linkDir, RECORD_FILE))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(linkDir, LEFT_FILE), "utf8"))).toMatchObject({ runtime_id: registered.runtime_id });
  expect((await client.call("cloud.status", {})).account).toBeUndefined();
  expect(await client.call("account.get", {})).toEqual({ signed_in: false, credits_on: false });
});

test("cloud.signin: a re-sign-in whose registration is refused leaves the computer enrolled before untouched", { timeout: 90_000 }, async () => {
  const cloud = await fakeCloud();
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const linkDir = path.join(config.stateDir, "cloud-link");
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  await client.call("cloud.signin", { request_id: "s1" });
  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).runtime_id !== undefined, 15_000);
  const before = await client.call("cloud.status", {});
  const record = fs.readFileSync(path.join(linkDir, RECORD_FILE), "utf8");
  const key = fs.readFileSync(path.join(linkDir, KEY_FILE));

  // Signing in again, Cloud refuses to register the computer: only a sign-out revokes the one enrolled before.
  cloud.state.enrollRefusal = 403;
  await client.call("cloud.signin", { request_id: "s2" });
  cloud.state.approved.add(cloud.state.codes[1]!.device);
  await until(async () => (await client.call("cloud.status", {})).signin_error !== undefined, 15_000);
  const status = await client.call("cloud.status", {});
  // The status keeps reporting the computer it has, with the reason beside it.
  expect(status).toMatchObject({ runtime_id: before.runtime_id, computer_id: before.computer_id, account: before.account, signin_error: "Your role in your Caveman organization cannot turn on remote control (Engineer, Admin or Owner can)." });
  expect(status.signin).toBeUndefined();
  expect(fs.readFileSync(path.join(linkDir, RECORD_FILE), "utf8")).toBe(record);
  expect(fs.readFileSync(path.join(linkDir, KEY_FILE)).equals(key)).toBe(true);
  expect(fs.existsSync(path.join(linkDir, LEFT_FILE))).toBe(false);
  expect([...cloud.state.revoked]).toEqual([]);
  expect(cloud.state.calls.filter((c) => c.path === "/api/v1/code/runtime/revoke" || /^\/api\/v1\/code\/runtimes\/[^/]+\/token$/.test(c.path))).toEqual([]);
  // Remote control was not switched off: the computer is still the one it was.
  expect((await client.call("settings.get", {})).remote_control).not.toBe(false);
});

test("cloud.signin: Cloud unreachable while registering the computer keeps the account the same way", { timeout: 90_000 }, async () => {
  const cloud = await fakeCloud();
  cloud.state.enrollRefusal = "network";
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url, remote_control: true } });
  await client.call("cloud.signin", { request_id: "s1" });
  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).account !== undefined, 15_000);
  const status = await client.call("cloud.status", {});
  expect(status.account?.email).toBe("ada@example.com");
  expect(status.signin_error).toMatch(/^Caveman did not register this computer: /);
  expect(status.runtime_id).toBeUndefined();
  expect((await client.call("settings.get", {})).remote_control).toBe(false);
  expect(await client.call("account.get", {})).toMatchObject({ signed_in: true });
});

test("cloud.signin: a code denied in the browser ends the sign-in and says so", { timeout: 60_000 }, async () => {
  const cloud = await fakeCloud();
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  // Signing in with GitHub: Cloud's device start hears the provider beside the connection.
  await client.call("cloud.signin", { request_id: "s1", provider: "github" });
  await until(async () => cloud.state.codes.length === 1, 10_000);
  expect(cloud.state.codes[0]!.body).toEqual({ connection: "code", provider: "github" });
  cloud.state.denied.add(cloud.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).signin_error === "The sign-in was denied in the browser. Sign in again if that was you.", 15_000);
  expect((await client.call("cloud.status", {})).signin).toBeUndefined();
  expect(cloud.state.enrolled).toEqual([]);
});

test("startSignin: without Cloud's approve link, the one it makes names the provider, the intent and the email too", async () => {
  const bodies: unknown[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ device_code: "d", user_code: "AB-CD", verification_uri: "http://127.0.0.1:9/activate", expires_in: 600, interval: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-provider-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = {};
  const withProvider = await startSignin({ state, cloudUrl: "http://127.0.0.1:9", dir, name: "test", fetch: fakeFetch, provider: "google" });
  withProvider.cancel();
  const without = await startSignin({ state, cloudUrl: "http://127.0.0.1:9", dir, name: "test", fetch: fakeFetch });
  without.cancel();
  const withEmail = await startSignin({ state, cloudUrl: "http://127.0.0.1:9", dir, name: "test", fetch: fakeFetch, email: " ada+code@example.com " });
  withEmail.cancel();
  // An empty email prefills nothing.
  const blank = await startSignin({ state, cloudUrl: "http://127.0.0.1:9", dir, name: "test", fetch: fakeFetch, email: "  " });
  blank.cancel();
  // A new account by email: Cloud opens its new-account form, not the sign-in or the chooser.
  const signup = await startSignin({ state, cloudUrl: "http://127.0.0.1:9", dir, name: "test", fetch: fakeFetch, email: "ada@example.com", intent: "signup" });
  signup.cancel();
  expect(bodies).toEqual([
    { connection: "code", provider: "google" },
    { connection: "code" },
    { connection: "code", email: "ada+code@example.com" },
    { connection: "code" },
    { connection: "code", email: "ada@example.com", intent: "signup" },
  ]);
  expect(signup.verification_uri_complete).toBe("http://127.0.0.1:9/activate?user_code=AB-CD&connection=code&intent=signup#email=ada%40example.com");
  expect(withProvider.verification_uri_complete).toBe("http://127.0.0.1:9/activate?user_code=AB-CD&connection=code&provider=google");
  expect(without.verification_uri_complete).toBe("http://127.0.0.1:9/activate?user_code=AB-CD&connection=code");
  expect(withEmail.verification_uri_complete).toBe("http://127.0.0.1:9/activate?user_code=AB-CD&connection=code#email=ada%2Bcode%40example.com");
  // In the fragment, never the query: no server, log or Referer sees it.
  expect(new URL(withEmail.verification_uri_complete).searchParams.get("email")).toBeNull();
  expect(new URLSearchParams(new URL(withEmail.verification_uri_complete).hash.slice(1)).get("email")).toBe("ada+code@example.com");
  expect(blank.verification_uri_complete).toBe("http://127.0.0.1:9/activate?user_code=AB-CD&connection=code");
});

test("cloud.signin: replacing an enrollment revokes the old runtime with its own key; switching off cancels, even mid-enroll", { timeout: 90_000 }, async () => {
  const cloud = await fakeCloud();
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await client.call("settings.set", { request_id: "url", settings: { cloud_url: cloud.url } });
  const old = await client.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.access });

  await client.call("cloud.signin", { request_id: "s1" });
  cloud.state.approved.add(cloud.state.codes[0]!.device);
  await until(async () => {
    const id = (await client.call("cloud.status", {})).runtime_id;
    return id !== undefined && id !== old.runtime_id;
  }, 15_000);
  // The grant may only enroll: the old runtime ends with a token its own key minted.
  await until(() => cloud.state.revoked.has(old.runtime_id), 10_000);
  const revoke = cloud.state.calls.find((c) => c.path === "/api/v1/code/runtime/revoke")!;
  expect(cloud.state.tokens.get(revoke.bearer!)).toBe(old.runtime_id);
  const current = (await client.call("cloud.status", {})).runtime_id!;
  expect(cloud.state.revoked.has(current)).toBe(false);

  // Switching off while the code waits ends the sign-in; approving later enrolls nothing.
  await client.call("cloud.signin", { request_id: "s2" });
  await client.call("settings.set", { request_id: "off", settings: { remote_control: false } });
  expect((await client.call("cloud.status", {})).signin).toBeUndefined();
  cloud.state.approved.add(cloud.state.codes[1]!.device);
  const enrolled = cloud.state.enrolled.length;
  await new Promise((r) => setTimeout(r, 2_500));
  expect(cloud.state.enrolled.length).toBe(enrolled);

  // Switched off while Cloud is enrolling: the new runtime is revoked and nothing is left here.
  let release!: () => void;
  cloud.state.enrollGate = new Promise((r) => (release = r));
  await client.call("cloud.signin", { request_id: "s3" });
  cloud.state.approved.add(cloud.state.codes[2]!.device);
  await until(() => cloud.state.enrolled.length > enrolled, 10_000);
  const racing = cloud.state.enrolled.at(-1)!;
  await client.call("cloud.signout", { request_id: "out" });
  release();
  await until(() => cloud.state.revoked.has(racing), 10_000);
  await until(async () => (await client.call("cloud.status", {})).runtime_id === undefined, 10_000);
  expect(fs.existsSync(path.join(config.stateDir, "cloud-link", "runtime.json"))).toBe(false);
  expect(cloud.state.revoked.has(current)).toBe(true);
});

test("cloud.signin: Cloud's failures keep their reason; an approve page on another site is refused", { timeout: 60_000 }, async () => {
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  for (const [codeStatus, reason] of [
    [429, "rate_limited"],
    [503, "internal"],
  ] as const) {
    const cloud = await fakeCloud({ codeStatus });
    await client.call("settings.set", { request_id: `url-${codeStatus}`, settings: { cloud_url: cloud.url } });
    await expect(client.call("cloud.signin", { request_id: `s-${codeStatus}` })).rejects.toMatchObject({ error: { data: { reason } } });
  }
  const elsewhere = await fakeCloud({ verifyHost: "evil.example" });
  await client.call("settings.set", { request_id: "url-evil", settings: { cloud_url: elsewhere.url } });
  await expect(client.call("cloud.signin", { request_id: "s-evil" })).rejects.toThrow(/another site/);
  // Nothing listening: Cloud unreachable, not a bad URL.
  await client.call("settings.set", { request_id: "url-down", settings: { cloud_url: "http://127.0.0.1:9" } });
  await expect(client.call("cloud.signin", { request_id: "s-down" })).rejects.toMatchObject({ error: { data: { reason: "internal" } } });
});

test("cloud.signin: a credits key is its Cloud's; signing in to another drops it there and asks the first nothing", { timeout: 90_000 }, async () => {
  const first = await fakeCloud({ gateway: "https://gateway.first.example" });
  // A company Cloud whose grant names Caveman's gateway (left at a default): not taken, so it gets no credits.
  const second = await fakeCloud({ gateway: "https://gateway.caveman.so" });
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const signIn = async (cloud: Awaited<ReturnType<typeof fakeCloud>>, id: string) => {
    await client.call("settings.set", { request_id: `url-${id}`, settings: { cloud_url: cloud.url } });
    await client.call("cloud.signin", { request_id: `s-${id}` });
    cloud.state.approved.add(cloud.state.codes.at(-1)!.device);
    await until(async () => (await client.call("cloud.status", {})).cloud_url === cloud.url, 15_000);
    await until(async () => (await client.call("account.get", {})).signed_in === true, 10_000);
  };

  await signIn(first, "first");
  expect(await client.call("account.credits", { request_id: "on", enabled: true })).toEqual({ enabled: true });
  expect((await client.call("account.get", {})).credits_on).toBe(true);
  const firstCalls = first.state.calls.length;

  await signIn(second, "second");
  // The first Cloud's key is gone from the engine, and the first Cloud heard nothing about it.
  expect((await client.call("account.get", {})).credits_on).toBe(false);
  expect(first.state.calls.slice(firstCalls).map((c) => c.path)).not.toContain(`/api/v1/code/credits/keys/${first.state.creditsKeyIds[0]}`);
  // The second Cloud named no gateway of its own: credits stay off and no key is minted.
  await expect(client.call("account.credits", { request_id: "on-2", enabled: true })).rejects.toThrow(/did not say where its gateway is/);
  expect(second.state.creditsKeyIds).toEqual([]);
});

test("CAVEMAN_CLOUD_URL pins the Cloud: Settings shows it and cannot change it, and the sign-in goes there only", { timeout: 90_000 }, async () => {
  const pinned = await fakeCloud({ gateway: "https://gateway.pinned.example" });
  const other = await fakeCloud();
  const before = process.env.CAVEMAN_CLOUD_URL;
  process.env.CAVEMAN_CLOUD_URL = `${pinned.url}/`;
  cleanups.push(() => (before === undefined ? delete process.env.CAVEMAN_CLOUD_URL : (process.env.CAVEMAN_CLOUD_URL = before)));
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());

  expect(await client.call("settings.get", {})).toMatchObject({ cloud_url: pinned.url, cloud_url_managed: true });
  await expect(client.call("settings.set", { request_id: "other", settings: { cloud_url: other.url } })).rejects.toMatchObject({ error: { data: { reason: "forbidden" } } });
  await expect(client.call("settings.set", { request_id: "hosted", settings: { cloud_url: "https://app.caveman.so" } })).rejects.toThrow(/CAVEMAN_CLOUD_URL/);
  // The pinned Cloud itself, however written, and any other setting, save as usual; the pin is never saved.
  await client.call("settings.set", { request_id: "same", settings: { cloud_url: `${pinned.url}/`, remote_control: true } });
  await expect(client.call("cloud.enroll", { request_id: "enroll", cloud_url: other.url, token: "cave_access_other_0123456789" })).rejects.toMatchObject({ error: { data: { reason: "forbidden" } } });

  await client.call("cloud.signin", { request_id: "s1" });
  expect([pinned.state.codes.length, other.state.calls.length]).toEqual([1, 0]);
  pinned.state.approved.add(pinned.state.codes[0]!.device);
  await until(async () => (await client.call("cloud.status", {})).cloud_url === pinned.url, 15_000);
  // Credits run on the gateway the pinned Cloud named.
  expect(await client.call("account.credits", { request_id: "on", enabled: true })).toEqual({ enabled: true });
  expect(pinned.state.creditsKeyIds).toHaveLength(1);
  expect(other.state.calls).toEqual([]);

  delete process.env.CAVEMAN_CLOUD_URL;
  const unpinned = await client.call("settings.get", {});
  expect(unpinned.cloud_url_managed).toBeUndefined();
  expect(unpinned.cloud_url).toBeUndefined();

  // Pinned to something that is no Cloud URL: the sign-in fails here and nothing goes anywhere.
  process.env.CAVEMAN_CLOUD_URL = "app.customer.example";
  await expect(client.call("cloud.signin", { request_id: "s2" })).rejects.toThrow(/Could not start the Caveman sign-in/);
  expect([pinned.state.codes.length, other.state.calls.length]).toEqual([1, 0]);
});
