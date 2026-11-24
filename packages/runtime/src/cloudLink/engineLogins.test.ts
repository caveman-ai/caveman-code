// Sign-ins that follow the person (engineLogins.ts) against a pretend Caveman Cloud (the five runtime routes, with
// the serialized refresh and a count of provider calls), a pretend provider behind the egress scrub, and temp
// directories as the tools container's home and the computer's Codex home. No real credential is read anywhere.
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { createScrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { ANTHROPIC_VIA_PROXY, CODEX_VIA_PROXY, startEgressProxy, type EgressProxy } from "../secrets/EgressScrub.ts";
import {
  CODEX_LOGIN_REFRESH,
  FollowedLogins,
  followedCloudOver,
  isStandIn,
  jwtClaims,
  parseCodexAuth,
  REFRESH_MIN_MS,
  REVALIDATE_MS,
  STAND_IN_MARK,
  toolsLoginFiles,
  withFollowedLogin,
  type FollowedEngine,
  type LoginProfile,
} from "./engineLogins.ts";
import { CloudError } from "./identity.ts";

vi.mock("node:https", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:https")>();
  return { ...original, request: vi.fn() };
});

// ------------------------------------------------------------------ fixtures (never real credentials)

const unsigned = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
const REAL = {
  claudeAccess: ("sk-" + "ant-oat01-REALFIXTURE-claude-access-0123456789abcdef"),
  claudeRefresh: ("sk-" + "ant-ort01-REALFIXTURE-claude-refresh-0123456789abcdef"),
  codexAccess: unsigned({ sub: "REALFIXTURE-codex-access", exp: Math.floor(Date.now() / 1000) + 3600 }),
  codexRefresh: "rt_REALFIXTURE-codex-refresh-0123456789abcdef",
  codexId: unsigned({
    email: "claire@work.example",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-0123", chatgpt_user_id: "user-0123" },
    note: "REALFIXTURE-codex-id",
  }),
};
const realValues = () => [...Object.values(REAL), "REALFIXTURE", ...cloud.issued];

const claudeFile = () =>
  JSON.stringify({ claudeAiOauth: { accessToken: REAL.claudeAccess, refreshToken: REAL.claudeRefresh, expiresAt: Date.now() + 8 * 3600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } });
const codexFile = () => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: REAL.codexId, access_token: REAL.codexAccess, refresh_token: REAL.codexRefresh, account_id: "acct-0123" }, last_refresh: new Date().toISOString() });

// ------------------------------------------------------------------ pretend Cloud

interface Row {
  version: number;
  access: string;
  expiresAt: string;
  profile: LoginProfile;
  status: "ready" | "needs_sign_in";
}

class FakeCloud {
  readonly rows = new Map<string, Row>();
  readonly puts: Array<{ engine: string; body: Record<string, unknown> }> = [];
  readonly requests: string[] = [];
  /** Real access tokens Cloud handed out (a refresh's): none may reach the tools side either. */
  readonly issued: string[] = [];
  providerCalls = 0;
  refreshCalls = 0;
  /** The provider answers the next refresh with invalid_grant. */
  rejectRefresh = false;
  /** How long a new token lives. */
  lifetimeMs = 8 * 3600_000;
  private inflight = new Map<string, Promise<void>>();
  server!: http.Server;
  url = "";

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  seed(engine: "claude" | "codex", access: string, expiresInMs = this.lifetimeMs, profile: LoginProfile = {}) {
    this.rows.set(engine, { version: 1, access, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), profile, status: "ready" });
  }

  private reply(res: http.ServerResponse, status: number, body?: unknown) {
    if (body === undefined) return void res.writeHead(status).end();
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" }).end(text);
  }

  private access(engine: string, row: Row) {
    return { engine, version: row.version, status: row.status, expires_at: row.expiresAt, access_token: row.access, profile: row.profile };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : undefined;
    const url = new URL(req.url ?? "/", this.url);
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const match = /^\/api\/v1\/code\/runtime\/engine-logins(?:\/(claude|codex)(\/refresh)?)?$/.exec(url.pathname);
    if (!match) return this.reply(res, 404, { error: { code: "cave_not_found", message: "Not found." } });
    const [, engine, refresh] = match;
    if (engine === undefined) return this.reply(res, 200, { logins: [...this.rows].map(([e, row]) => ({ engine: e, status: row.status, version: row.version })) });
    const none = () => this.reply(res, 404, { error: { code: "cave_code_engine_login_none", message: "No sign-in follows you for this engine." } });
    const expired = () => this.reply(res, 409, { error: { code: "cave_code_engine_login_expired", message: "Sign in again." } });
    const row = this.rows.get(engine);
    if (req.method === "PUT") {
      if (body?.consent !== true) return this.reply(res, 400, { error: { code: "cave_code_engine_login_consent", message: "consent" } });
      const credential = body.credential as { access_token: string; expires_at?: string };
      this.puts.push({ engine, body });
      const next: Row = { version: (row?.version ?? 0) + 1, access: credential.access_token, expiresAt: credential.expires_at ?? new Date(Date.now() + this.lifetimeMs).toISOString(), profile: body.profile as LoginProfile, status: "ready" };
      this.rows.set(engine, next);
      return this.reply(res, 200, { engine, status: "ready", version: next.version });
    }
    if (req.method === "DELETE") {
      this.rows.delete(engine);
      return this.reply(res, 204);
    }
    if (row === undefined) return none();
    if (req.method === "GET") {
      if (row.status !== "ready") return expired();
      const known = url.searchParams.get("known_version");
      if (known !== null && Number(known) === row.version) return this.reply(res, 200, { engine, version: row.version, status: row.status, expires_at: row.expiresAt, unchanged: true });
      return this.reply(res, 200, this.access(engine, row));
    }
    if (req.method === "POST" && refresh !== undefined) {
      this.refreshCalls++;
      const asked = Number(body?.version);
      // Serialized: whoever holds the lease refreshes; everyone else waits for it and gets its result.
      while (this.inflight.has(engine)) await this.inflight.get(engine);
      const current = this.rows.get(engine);
      if (current === undefined) return none();
      if (current.status !== "ready") return expired();
      if (current.version > asked) return this.reply(res, 200, this.access(engine, current));
      const round = (async () => {
        this.providerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (this.rejectRefresh) {
          current.status = "needs_sign_in";
          return;
        }
        current.version++;
        current.access = `real-access-${engine}-v${current.version}-${Math.random().toString(36).slice(2)}`;
        current.expiresAt = new Date(Date.now() + this.lifetimeMs).toISOString();
        this.issued.push(current.access);
      })();
      this.inflight.set(engine, round);
      await round;
      this.inflight.delete(engine);
      return current.status === "ready" ? this.reply(res, 200, this.access(engine, current)) : expired();
    }
    return this.reply(res, 405, { error: { code: "cave_method", message: "no" } });
  }

  api() {
    return followedCloudOver(async (method, route, body) => {
      const response = await fetch(`${this.url}/api/v1/code/runtime/engine-logins${route}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 204) return undefined;
      const answer = (await response.json()) as { error?: { code?: string; message?: string } };
      if (!response.ok) throw new CloudError(response.status, answer.error?.message ?? "refused", answer.error?.code);
      return answer;
    });
  }
}

// ------------------------------------------------------------------ pretend provider

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

let upstream: http.Server;
let upstreamOrigin = "";
const seen: Seen[] = [];
/** Access tokens the provider no longer takes (expired, or replaced by another computer's refresh). */
const revoked = new Set<string>();

const cloud = new FakeCloud();
let root = "";
let proxies: EgressProxy[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const authorization = req.headers.authorization;
      seen.push({ url: req.url ?? "", authorization, body: Buffer.concat(chunks).toString("utf8") });
      const bearer = authorization?.replace(/^Bearer /, "");
      if (bearer !== undefined && revoked.has(bearer)) return void res.writeHead(401, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"authentication_error"}}');
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  await cloud.start();
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => cloud.server.close(resolve));
});

let mocks: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-logins-"));
  cloud.rows.clear();
  cloud.puts.length = 0;
  cloud.requests.length = 0;
  cloud.providerCalls = 0;
  cloud.refreshCalls = 0;
  cloud.rejectRefresh = false;
  seen.length = 0;
  revoked.clear();
  mocks = [vi.spyOn(appProxy, "url").mockReturnValue(`${upstreamOrigin}/app-proxy`), vi.spyOn(codexProxy, "url").mockReturnValue(`${upstreamOrigin}/codex-proxy`)];
  // Only canonical Claude token exchanges use HTTPS here; keep every provider call on our local fixture.
  vi.mocked(https.request).mockImplementation(((target: URL, options: https.RequestOptions) => {
    if (!(target instanceof URL) || target.origin !== "https://api.anthropic.com" || target.pathname !== "/v1/oauth/token") throw new Error("Unexpected HTTPS destination in followed-login fixture");
    return http.request(new URL(target.pathname + target.search, upstreamOrigin), options);
  }) as typeof https.request);
});
afterEach(async () => {
  for (const mock of mocks) mock.mockRestore();
  await Promise.all(proxies.map((p) => p.close()));
  proxies = [];
  fs.rmSync(root, { recursive: true, force: true });
});

/** One pretend Cloud computer: its tools home, its Codex home, its followed sign-ins and its egress scrub. */
const computer = async (name: string, now: () => number = Date.now) => {
  const home = path.join(root, name, "tools-home");
  const codexHome = path.join(root, name, "state", "providers", "codex", "active", "home");
  const logins = new FollowedLogins(now);
  logins.connect({
    cloud: cloud.api(),
    files: toolsLoginFiles(undefined),
    paths: { claude: async () => path.join(home, ".claude", ".credentials.json"), codex: async () => path.join(codexHome, "auth.json") },
  });
  const proxy = await startEgressProxy({ scrubber: () => createScrubber([]), logins });
  proxies.push(proxy);
  const claudeFilePath = path.join(home, ".claude", ".credentials.json");
  const codexFilePath = path.join(codexHome, "auth.json");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const claudeRequest = (token: string) =>
    fetch(`${proxy.route(ANTHROPIC_VIA_PROXY)}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: '{"model":"claude"}' });
  const codexRequest = (token: string, chatgpt = true) =>
    fetch(`${proxy.route(CODEX_VIA_PROXY)}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(chatgpt ? { "chatgpt-account-id": "acct-0123" } : {}) },
      body: '{"model":"gpt"}',
    });
  return { logins, proxy, home, codexHome, claudeFilePath, codexFilePath, write, claudeRequest, codexRequest };
};

/** Every file under `dir`, as text. */
const everyFile = (dir: string): Array<[string, string]> =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
        const file = path.join(e.parentPath, e.name);
        return [file, fs.readFileSync(file, "utf8")] as [string, string];
      })
    : [];

/** A launch's env; it must have launched. */
const launched = (launch: Awaited<ReturnType<FollowedLogins["launchEnv"]>>) => {
  if (launch === undefined || "unavailable" in launch) throw new Error(`no launch: ${JSON.stringify(launch)}`);
  return launch.env;
};

const codexStandInAccess = (logins: FollowedLogins, profile: LoginProfile) => (JSON.parse(logins.codexStandInFile(profile)) as { tokens: { access_token: string; refresh_token: string } }).tokens;

describe("stand-ins", () => {
  it("are told from real tokens by their mark, in every shape the CLIs read", () => {
    const logins = new FollowedLogins();
    expect(isStandIn(logins.claudeStandIn.access)).toBe(true);
    expect(isStandIn(logins.claudeStandIn.refresh)).toBe(true);
    const tokens = codexStandInAccess(logins, {});
    expect(isStandIn(tokens.access_token) && isStandIn(tokens.refresh_token)).toBe(true);
    for (const real of Object.values(REAL)) expect(isStandIn(real)).toBe(false);
    // Another run's stand-in is still a stand-in (never captured as a real sign-in), but not this run's to swap.
    const other = new FollowedLogins();
    expect(isStandIn(other.claudeStandIn.access)).toBe(true);
    expect(logins.owns("claude-agent", other.claudeStandIn.access)).toBe(false);
    expect(logins.owns("claude-agent", logins.claudeStandIn.access)).toBe(true);
    expect(logins.owns("codex", tokens.access_token)).toBe(true);
    expect(logins.owns("codex", logins.claudeStandIn.access)).toBe(false);
  });

  it("codex's stand-in auth.json parses as a ChatGPT login: the account and plan, a far expiry, no real token", () => {
    const logins = new FollowedLogins();
    const found = parseCodexAuth(codexFile())!;
    const text = logins.codexStandInFile(found.profile);
    for (const value of Object.values(REAL)) expect(text).not.toContain(value);
    const file = JSON.parse(text) as { auth_mode: string; OPENAI_API_KEY: null; tokens: Record<string, string>; last_refresh: string };
    expect(file.auth_mode).toBe("chatgpt");
    expect(file.OPENAI_API_KEY).toBeNull();
    expect(file.tokens.account_id).toBe("acct-0123");
    expect(Date.now() - Date.parse(file.last_refresh)).toBeLessThan(5_000);
    const id = jwtClaims(file.tokens.id_token)!;
    expect(id.email).toBe("claire@work.example");
    expect((id["https://api.openai.com/auth"] as Record<string, string>).chatgpt_plan_type).toBe("plus");
    expect(id.caveman_stand_in).toEqual(expect.any(String));
    expect(Number(id.exp) * 1000 - Date.now()).toBeGreaterThan(300 * 24 * 3600_000);
    const access = jwtClaims(file.tokens.access_token)!;
    expect(Number(access.exp) * 1000 - Date.now()).toBeGreaterThan(300 * 24 * 3600_000);
    expect(file.tokens.id_token!.split(".")[2]).toContain(STAND_IN_MARK);
  });
});

describe("sign-ins that follow the person", () => {
  it("(1) after a capture the tools side holds no real token: every file under the tools and Codex homes, and the env claude and codex get", async () => {
    const a = await computer("a");
    // The person signed in from each card; the CLI ran in the runtime container and left its credential in a private
    // folder there (signInHere.ts), which is what is taken.
    expect(await a.logins.captureFrom("claude-agent", claudeFile())).toBe("captured");
    expect(await a.logins.captureFrom("codex", codexFile())).toBe("captured");
    // Cloud got the real sign-ins, consented, with their non-secret profiles.
    expect(cloud.puts.map((p) => [p.engine, p.body.consent, (p.body.credential as { refresh_token: string }).refresh_token])).toEqual([
      ["claude", true, REAL.claudeRefresh],
      ["codex", true, REAL.codexRefresh],
    ]);
    expect(cloud.puts[0]!.body.profile).toEqual({ scopes: ["user:inference", "user:profile"], subscription_type: "max", rate_limit_tier: "default_claude_max_20x" });
    expect((cloud.puts[1]!.body.profile as LoginProfile).account_id).toBe("acct-0123");
    expect(JSON.stringify(cloud.puts.map((p) => p.body.profile))).not.toContain(REAL.codexRefresh);

    const claudeEnv = launched(await Effect.runPromise(withFollowedLogin("claude-agent", { KEEP: "1" }, a.logins)));
    const codexEnv = launched(await Effect.runPromise(withFollowedLogin("codex", { KEEP: "1", CODEX_HOME: a.codexHome }, a.logins)));
    expect(claudeEnv).toEqual({ KEEP: "1", CLAUDE_CODE_OAUTH_TOKEN: a.logins.claudeStandIn.access, CLAUDE_CODE_SUBSCRIPTION_TYPE: "max", CLAUDE_CODE_RATE_LIMIT_TIER: "default_claude_max_20x" });
    expect(codexEnv).toEqual({ KEEP: "1", CODEX_HOME: a.codexHome });

    const files = everyFile(path.join(root, "a"));
    // Claude needs no file there (its stand-in is in its env); Codex's home holds its stand-in auth.json.
    expect(files.map(([file]) => path.relative(root, file).split(path.sep).join("/")).sort()).toEqual(["a/state/providers/codex/active/home/auth.json"]);
    const scanned: Array<[string, string]> = [...files, ["claude env", JSON.stringify(claudeEnv)], ["codex env", JSON.stringify(codexEnv)]];
    for (const [file, text] of scanned) {
      for (const value of realValues()) expect(text.includes(value), `${file} holds ${value.slice(0, 24)}`).toBe(false);
    }
    // What is there is the stand-in, in the shape codex reads, readable by its owner only.
    // Windows has no mode bits (a Cloud computer, where these sign-ins live, is Linux).
    if (process.platform !== "win32") expect(fs.statSync(a.codexFilePath).mode & 0o077).toBe(0);
    expect(a.logins.owns("codex", parseCodexAuth(fs.readFileSync(a.codexFilePath, "utf8"))!.credential.access_token)).toBe(true);
    expect(a.logins.hasLogin("claude-agent") && a.logins.hasLogin("codex")).toBe(true);

    // The provider gets the real token from the scrub; the CLI only ever sent the stand-in.
    expect((await a.claudeRequest(a.logins.claudeStandIn.access)).status).toBe(200);
    expect((await a.codexRequest(codexStandInAccess(a.logins, {}).access_token)).status).toBe(200);
    expect(seen.map((s) => [s.url, s.authorization])).toEqual([
      ["/app-proxy/w/caveman-code-claude/v1/messages", `Bearer ${REAL.claudeAccess}`],
      ["/codex-proxy/chatgpt/responses", `Bearer ${REAL.codexAccess}`],
    ]);
  });

  it("(2) ten concurrent refreshes make one Cloud refresh and one provider call: requests that 401, requests near expiry, and codex's refresh route", async () => {
    let clock = Date.now();
    const a = await computer("a", () => clock);
    cloud.seed("claude", "real-access-claude-v1");
    await a.logins.ensureHeld("claude-agent");
    revoked.add("real-access-claude-v1");
    const answers = await Promise.all(Array.from({ length: 10 }, () => a.claudeRequest(a.logins.claudeStandIn.access)));
    expect(answers.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect([cloud.refreshCalls, cloud.providerCalls]).toEqual([1, 1]);
    // Each that went out on the old token was refused once and sent once more on the new one (a request that reached
    // the scrub after the round went out on the new one at once); all ten ended on the new one.
    const fresh = cloud.rows.get("claude")!.access;
    const refused = seen.filter((s) => s.authorization === "Bearer real-access-claude-v1").length;
    expect(refused).toBeGreaterThan(0);
    expect(seen.filter((s) => s.authorization === `Bearer ${fresh}`)).toHaveLength(10);
    expect(seen).toHaveLength(10 + refused);

    // About to expire: ten at once, one refresh, before any is sent.
    cloud.seed("codex", "real-access-codex-v1", 60_000, { account_id: "acct-0123" });
    await a.logins.ensureHeld("codex");
    cloud.refreshCalls = cloud.providerCalls = 0;
    seen.length = 0;
    const tokens = codexStandInAccess(a.logins, { account_id: "acct-0123" });
    expect((await Promise.all(Array.from({ length: 10 }, () => a.codexRequest(tokens.access_token)))).map((r) => r.status)).toEqual(Array(10).fill(200));
    expect([cloud.refreshCalls, cloud.providerCalls]).toEqual([1, 1]);
    expect(new Set(seen.map((s) => s.authorization))).toEqual(new Set([`Bearer ${cloud.rows.get("codex")!.access}`]));

    // codex's own refresh, ten at once on its refresh route: answered here with stand-ins, never forwarded, and no
    // refresh in Cloud while the held token is good (L-3: a tools process cannot drive refreshes).
    cloud.refreshCalls = cloud.providerCalls = 0;
    seen.length = 0;
    const refreshRoute = () =>
      fetch(a.proxy.route(CODEX_LOGIN_REFRESH)!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: "app_x", grant_type: "refresh_token", refresh_token: tokens.refresh_token }) });
    let refreshes = await Promise.all(Array.from({ length: 10 }, refreshRoute));
    expect(refreshes.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect([cloud.refreshCalls, cloud.providerCalls]).toEqual([0, 0]);
    // Near its expiry, ten at once: one refresh, before any answer.
    clock += cloud.lifetimeMs - 60_000;
    refreshes = await Promise.all(Array.from({ length: 10 }, refreshRoute));
    const bodies = await Promise.all(refreshes.map((r) => r.json() as Promise<Record<string, string>>));
    expect(refreshes.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect([cloud.refreshCalls, cloud.providerCalls]).toEqual([1, 1]);
    expect(seen).toHaveLength(0);
    for (const body of bodies) {
      expect(a.logins.owns("codex", body.access_token)).toBe(true);
      expect(isStandIn(body.refresh_token) && isStandIn(body.id_token)).toBe(true);
      for (const value of realValues()) expect(JSON.stringify(body)).not.toContain(value);
    }
    // A refresh token that is not this runtime's stand-in is refused, and still never forwarded.
    const foreign = await fetch(a.proxy.route(CODEX_LOGIN_REFRESH)!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: REAL.codexRefresh }) });
    expect([foreign.status, ((await foreign.json()) as { error: string }).error]).toEqual([400, "invalid_grant"]);
    expect(seen).toHaveLength(0);
  });

  it("(3) a refresh after rotation works on every computer: the other computer takes the new version, and the provider is called once", async () => {
    const a = await computer("a");
    const b = await computer("b");
    cloud.seed("claude", "real-access-claude-v1");
    await a.logins.ensureHeld("claude-agent");
    await b.logins.ensureHeld("claude-agent");
    // Computer A refreshes (its CLI asked, or its request was refused): version 2, and the provider drops version 1.
    const renewed = await a.logins.renew("claude-agent", 1, "refused");
    expect(renewed?.version).toBe(2);
    revoked.add("real-access-claude-v1");
    // Computer B still holds version 1: refused once, it reads version 2 from Cloud and sends again.
    expect((await b.claudeRequest(b.logins.claudeStandIn.access)).status).toBe(200);
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer real-access-claude-v1", `Bearer ${renewed!.access}`]);
    expect(cloud.providerCalls).toBe(1);
    expect(cloud.refreshCalls).toBe(1);
    // And A's own requests carry it too.
    expect((await a.claudeRequest(a.logins.claudeStandIn.access)).status).toBe(200);
    expect(seen.at(-1)!.authorization).toBe(`Bearer ${renewed!.access}`);
  });

  it("(4) a stand-in sent anywhere but its provider stays a stand-in, a look-alike token route included", async () => {
    const a = await computer("a");
    cloud.seed("claude", "real-access-claude-v1");
    cloud.seed("codex", "real-access-codex-v1", undefined, { account_id: "acct-0123" });
    const codexTokens = codexStandInAccess(a.logins, { account_id: "acct-0123" });
    // A base URL the repository names: not Anthropic.
    const elsewhere = (suffix: string, init: RequestInit) => fetch(`${a.proxy.route(upstreamOrigin + "/base")}${suffix}`, init);
    expect((await elsewhere("/v1/messages", { method: "POST", headers: { authorization: `Bearer ${a.logins.claudeStandIn.access}` }, body: "{}" })).status).toBe(200);
    // A refresh-looking request there is forwarded as it came: stand-ins only.
    const lookAlike = JSON.stringify({ grant_type: "refresh_token", refresh_token: a.logins.claudeStandIn.refresh });
    expect((await elsewhere("/v1/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: lookAlike })).status).toBe(200);
 // Codex's stand-in toward OpenAI's API route (an API-key route, not compact) and Claude's toward compact stay too.
    expect((await a.codexRequest(codexTokens.access_token, false)).status).toBe(200);
    expect((await a.codexRequest(a.logins.claudeStandIn.access)).status).toBe(200);
    expect(seen.map((s) => [s.url, s.authorization, s.body])).toEqual([
      ["/base/v1/messages", `Bearer ${a.logins.claudeStandIn.access}`, "{}"],
      ["/base/v1/oauth/token", undefined, lookAlike],
      ["/codex-proxy/w/caveman-code-codex/v1/responses", `Bearer ${codexTokens.access_token}`, '{"model":"gpt"}'],
      ["/codex-proxy/chatgpt/responses", `Bearer ${a.logins.claudeStandIn.access}`, '{"model":"gpt"}'],
    ]);
    for (const s of seen) for (const value of ["real-access-claude-v1", "real-access-codex-v1"]) expect(JSON.stringify(s)).not.toContain(value);
    // Claude's refresh at its base URL with this runtime's stand-in is answered here and never reaches Anthropic;
    // any other refresh there goes on as it came.
    seen.length = 0;
    const answered = await fetch(`${a.proxy.route(ANTHROPIC_VIA_PROXY)}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: lookAlike });
    const body = (await answered.json()) as Record<string, unknown>;
    expect(answered.status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", access_token: a.logins.claudeStandIn.access, refresh_token: a.logins.claudeStandIn.refresh });
    expect(seen).toHaveLength(0);
    const own = JSON.stringify({ grant_type: "refresh_token", refresh_token: ("sk-" + "ant-ort01-someone-elses") });
    expect((await fetch(`${a.proxy.route(ANTHROPIC_VIA_PROXY)}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: own })).status).toBe(200);
    expect(seen.map((s) => [s.url, s.body])).toEqual([["/v1/oauth/token", own]]);
  });

  it("(5) sign out everywhere: every computer stops swapping within its revalidation, drops its stand-ins, and says it has no sign-in", async () => {
    let clock = Date.now();
    const a = await computer("a", () => clock);
    const b = await computer("b", () => clock);
    cloud.seed("codex", "real-access-codex-v1", undefined, { account_id: "acct-0123" });
    for (const c of [a, b]) expect(await Effect.runPromise(withFollowedLogin("codex", { CODEX_HOME: c.codexHome }, c.logins))).toEqual({ env: { CODEX_HOME: c.codexHome } });
    expect(fs.existsSync(b.codexFilePath)).toBe(true);
    const changes: FollowedEngine[] = [];
    b.logins.onChange((engine) => changes.push(engine));
    const bToken = parseCodexAuth(fs.readFileSync(b.codexFilePath, "utf8"))!.credential.access_token;

    await a.logins.signOut("codex");
    expect(cloud.rows.has("codex")).toBe(false);
    expect(a.logins.hasLogin("codex")).toBe(false);
    expect(fs.existsSync(a.codexFilePath)).toBe(false);
    // B within its revalidation still swaps the token it holds (at most a minute)...
    expect((await b.codexRequest(bToken)).status).toBe(200);
    expect(seen.at(-1)!.authorization).toBe("Bearer real-access-codex-v1");
    // ...then looks, finds it gone, and stops: the stand-in goes out as it came, and its file is removed.
    clock += REVALIDATE_MS + 1;
    expect((await b.codexRequest(bToken)).status).toBe(200);
    expect(seen.at(-1)!.authorization).toBe(`Bearer ${bToken}`);
    expect(b.logins.hasLogin("codex")).toBe(false);
    expect(fs.existsSync(b.codexFilePath)).toBe(false);
    expect(changes).toEqual(["codex"]);
    // Signed out everywhere: a launch on it says so and starts nothing (engineKeys.ts takes no other login instead).
    expect(await Effect.runPromise(withFollowedLogin("codex", { CODEX_HOME: b.codexHome }, b.logins))).toEqual({ unavailable: "needs_sign_in", message: "Your ChatGPT sign-in expired. Reconnect it in Settings > Models & keys." });

    // A real sign-in someone made there since is never deleted by a sign out.
    b.write(b.codexFilePath, codexFile());
    await b.logins.signOut("codex");
    expect(fs.readFileSync(b.codexFilePath, "utf8")).toContain(REAL.codexRefresh);
  });

  it("a refresh the provider refuses (invalid_grant) looks once more, then drops the sign-in so the card shows", async () => {
    const a = await computer("a");
    cloud.seed("claude", "real-access-claude-v1");
    await a.logins.ensureHeld("claude-agent");
    const changes: FollowedEngine[] = [];
    a.logins.onChange((engine) => changes.push(engine));
    cloud.rejectRefresh = true;
    revoked.add("real-access-claude-v1");
    expect((await a.claudeRequest(a.logins.claudeStandIn.access)).status).toBe(401);
    expect(cloud.providerCalls).toBe(1);
    expect(a.logins.hasLogin("claude-agent")).toBe(false);
    expect(changes).toEqual(["claude-agent"]);
    // The re-fetch after the refusal was one GET without a known version.
    expect(cloud.requests.filter((r) => r === "GET /api/v1/code/runtime/engine-logins/claude")).toHaveLength(2);
  });

  it("(6) nothing a tools process writes is taken as a sign-in: a planted credentials file is never read or uploaded; This Mac never reads or calls", async () => {
    const c = await computer("c");
    // Planted by code on the computer (another account's sign-in) where the CLIs keep theirs: never uploaded, at a
    // launch, a request, a CLI refresh or because Cloud already follows a sign-in of the person's.
    c.write(c.claudeFilePath, claudeFile());
    c.write(c.codexFilePath, codexFile().replace(REAL.codexRefresh, `${REAL.codexRefresh}-planted`));
    cloud.seed("claude", "real-access-claude-person");
    const env = launched(await Effect.runPromise(withFollowedLogin("claude-agent", {}, c.logins)));
    // The followed sign-in wins at launch, over any file: claude gets the stand-in env.
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: c.logins.claudeStandIn.access });
    expect((await c.claudeRequest(c.logins.claudeStandIn.access)).status).toBe(200);
    await fetch(`${c.proxy.route(ANTHROPIC_VIA_PROXY)}/v1/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: c.logins.claudeStandIn.refresh }) });
    expect(cloud.puts).toHaveLength(0);
    expect(cloud.rows.get("claude")?.access).toBe("real-access-claude-person");
    // A stand-in handed to captureFrom (a copied stand-in file) is not a sign-in either.
    expect(await c.logins.captureFrom("codex", c.logins.codexStandInFile({ account_id: "acct-0123" }))).toBe("none");
    expect(cloud.puts).toHaveLength(0);

    // This Mac: never joined to Cloud, so nothing is read, uploaded or asked for.
    const mac = new FollowedLogins();
    const macHome = path.join(root, "mac");
    fs.mkdirSync(path.join(macHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(macHome, ".claude", ".credentials.json"), claudeFile());
    cloud.requests.length = 0;
    expect(await mac.captureFrom("claude-agent", claudeFile())).toBe("none");
    expect(await Effect.runPromise(withFollowedLogin("claude-agent", { KEEP: "1" }, mac))).toBeUndefined();
    expect(await mac.swap("claude-agent", mac.claudeStandIn.access)).toBeUndefined();
    await expect(mac.signOut("claude-agent")).rejects.toThrow();
    expect(mac.hasLogin("claude-agent")).toBe(false);
    expect(cloud.requests).toEqual([]);
    expect(fs.readFileSync(path.join(macHome, ".claude", ".credentials.json"), "utf8")).toContain(REAL.claudeAccess);
  });

  it("(L-2) the token goes only to the endpoints the CLIs use: other paths on the provider's host, and paths that climb out of the route, keep the stand-in", async () => {
    const a = await computer("a");
    cloud.seed("claude", "real-access-claude-v1");
    cloud.seed("codex", "real-access-codex-v1", undefined, { account_id: "acct-0123" });
    const codexTokens = codexStandInAccess(a.logins, { account_id: "acct-0123" });
    const claudeRoute = a.proxy.route(ANTHROPIC_VIA_PROXY)!;
    const codexRoute = a.proxy.route(CODEX_VIA_PROXY)!;
    // Sent as written, with no client-side normalization: the scrub must resolve `..` and `%2e` itself.
    const send = (url: string, method: string, token: string, chatgpt = false) =>
      new Promise<number>((resolve, reject) => {
        const at = new URL(url.replace(/\/(\.\.|%2e%2e)(?=\/)/g, "/__UP__"));
        const req = http.request(
          { host: at.hostname, port: at.port, method, path: (at.pathname + at.search).replaceAll("/__UP__", url.includes("%2e%2e") ? "/%2e%2e" : "/.."), headers: { authorization: `Bearer ${token}`, ...(chatgpt ? { "chatgpt-account-id": "acct-0123" } : {}), ...(method === "GET" ? {} : { "content-type": "application/json" }) } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(method === "GET" ? undefined : "{}");
      });
    const claude = a.logins.claudeStandIn.access;
    // Allowed: what claude and codex send.
    await send(`${claudeRoute}/v1/messages`, "POST", claude);
    await send(`${claudeRoute}/v1/messages/count_tokens`, "POST", claude);
    await send(`${claudeRoute}/v1/models`, "GET", claude);
    await send(`${codexRoute}/responses`, "POST", codexTokens.access_token, true);
    await send(`${codexRoute}/models?client_version=0.163.0`, "GET", codexTokens.access_token, true);
    // Not allowed: other endpoints on the same host, another method, and paths that normalize out of the route.
    await send(`${claudeRoute}/v1/messages/batches`, "POST", claude);
    await send(`${claudeRoute}/api/oauth/profile`, "GET", claude);
    await send(`${claudeRoute}/v1/messages`, "GET", claude);
    await send(`${claudeRoute}/v1/organizations/x/api_keys`, "POST", claude);
    await send(`${claudeRoute}/v1/messages/%2e%2e/%2e%2e/%2e%2e/v1/messages`, "POST", claude);
    await send(`${codexRoute}/../wham/tasks/list`, "GET", codexTokens.access_token, true);
    await send(`${codexRoute}/responses/x/../../conversations`, "POST", codexTokens.access_token, true);
    await send(`${codexRoute}/responses`, "DELETE", codexTokens.access_token, true);
    const real = (url: string) => seen.find((s) => s.url === url)?.authorization;
    expect(real("/app-proxy/w/caveman-code-claude/v1/messages")).toBe("Bearer real-access-claude-v1");
    expect(real("/app-proxy/w/caveman-code-claude/v1/messages/count_tokens")).toBe("Bearer real-access-claude-v1");
    expect(real("/app-proxy/w/caveman-code-claude/v1/models")).toBe("Bearer real-access-claude-v1");
    expect(real("/codex-proxy/chatgpt/responses")).toBe("Bearer real-access-codex-v1");
    expect(real("/codex-proxy/chatgpt/models?client_version=0.163.0")).toBe("Bearer real-access-codex-v1");
    const swapped = seen.filter((s) => s.authorization === "Bearer real-access-claude-v1" || s.authorization === "Bearer real-access-codex-v1");
    expect(swapped).toHaveLength(5);
    expect(seen).toHaveLength(13);
    for (const s of seen.filter((x) => !swapped.includes(x))) expect([`Bearer ${claude}`, `Bearer ${codexTokens.access_token}`]).toContain(s.authorization);
  });

  it("(L-3) a tools process cannot drive refreshes: CLI refreshes never make one while the token is good, and repeated 401s make at most one in REFRESH_MIN_MS", async () => {
    let clock = Date.now();
    const a = await computer("a", () => clock);
    cloud.seed("codex", "real-access-codex-v1", undefined, { account_id: "acct-0123" });
    await a.logins.ensureHeld("codex");
    const tokens = codexStandInAccess(a.logins, { account_id: "acct-0123" });
    for (let i = 0; i < 20; i++) {
      clock += 31_000;
      const answer = await fetch(a.proxy.route(CODEX_LOGIN_REFRESH)!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: tokens.refresh_token }) });
      expect(answer.status).toBe(200);
    }
    expect([cloud.refreshCalls, cloud.providerCalls]).toEqual([0, 0]);

    // A provider that refuses every token: one refresh, then the refusals pass through until REFRESH_MIN_MS is up.
    cloud.seed("claude", "real-access-claude-v1");
    await a.logins.ensureHeld("claude-agent");
    const refuseAll = vi.spyOn(revoked, "has").mockReturnValue(true);
    try {
      for (let i = 0; i < 5; i++) {
        clock += 31_000;
        expect((await a.claudeRequest(a.logins.claudeStandIn.access)).status).toBe(401);
      }
      expect(cloud.providerCalls).toBe(1);
      clock += REFRESH_MIN_MS;
      expect((await a.claudeRequest(a.logins.claudeStandIn.access)).status).toBe(401);
      expect(cloud.providerCalls).toBe(2);
    } finally {
      refuseAll.mockRestore();
    }
  });
});
