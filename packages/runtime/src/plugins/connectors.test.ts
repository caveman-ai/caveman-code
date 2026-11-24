import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { enroll } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import { CONNECTORS_REPOSITORY, connectWhere, Connectors, EXPIRED_TEXT, layer as connectorsLayer } from "./connectors.ts";
import { McpHub, layer as hubLayer, personalServer } from "./McpHub.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { makePluginHandlers, makePluginHandlersWith } from "./protocolHandlers.ts";

/** An MCP server behind OAuth: RFC 9728 and 8414 discovery, dynamic registration, PKCE, refresh. */
function fakeOAuthServer() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const log: string[] = [];
  let access = "";
  /** How the token endpoint answers a refresh: a new grant (rotating the refresh token), invalid_grant, or down. */
  let refresh: "accept" | "refuse" | "down" = "refuse";
  let refreshToken = "refresh-1";
  const server = createServer(async (request, response) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(request.url ?? "/", base);
    let body = "";
    for await (const chunk of request) body += chunk;
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
    log.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") return json(201, { ...JSON.parse(body), client_id: "client-1" });
    if (url.pathname === "/authorize") {
      // The person approves at once.
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return response.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      log.push(`grant ${form.get("grant_type")}`);
      if (form.get("grant_type") === "refresh_token") {
        if (refresh === "down") return json(503, { error: "temporarily_unavailable" });
        if (refresh === "refuse" || form.get("refresh_token") !== refreshToken) return json(400, { error: "invalid_grant" });
        access = `access-${Math.random().toString(36).slice(2)}`;
        refreshToken = `refresh-${Math.random().toString(36).slice(2)}`;
        return json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken });
      }
      const grant = codes.get(form.get("code") ?? "");
      const verified = grant !== undefined && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge;
      if (form.get("grant_type") !== "authorization_code" || !verified) return json(400, { error: "invalid_grant" });
      access = `access-${Math.random().toString(36).slice(2)}`;
      return json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken });
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return response.writeHead(405).end();
      if (access === "" || request.headers.authorization !== `Bearer ${access}`) {
        return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      const frame = JSON.parse(body);
      if (frame.id === undefined) return response.writeHead(202).end();
      const result =
        frame.method === "initialize"
          ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "issues", version: "1" } }
          : frame.method === "tools/list"
            ? { tools: [{ name: "list_issues", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "LIN-1 Fix the bug" }] };
      return json(200, { jsonrpc: "2.0", id: frame.id, result });
    }
    response.writeHead(404).end();
  });
  return {
    server,
    log,
    token: () => access,
    setRefresh: (mode: typeof refresh) => (refresh = mode),
    /** The server stops taking the access token it gave (revoked or expired early). */
    revokeAccess: () => (access = "revoked"),
  };
}

const layer = () =>
  hubLayer.pipe(
    Layer.provideMerge(connectorsLayer),
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ProjectSecretsLive.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("connector sign-in", () => {
  it("signs in with OAuth in the browser, keeps the tokens in the runtime, and serves the server's tools through the hub", async () => {
    const fake = fakeOAuthServer();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/mcp`;
    const caller = { threadId: ThreadId.make("t-oauth"), hooks: false };
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const connectors = yield* Connectors;
          const hub = yield* McpHub;
          const handlers = yield* makePluginHandlers;
          const server = { name: "issues", url, auth: "oauth" as const };
          yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
          const before = yield* connectors.status(server);
          const refused = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 1, method: "tools/list" });
          const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
          // The browser: the authorization page redirects to the runtime's loopback callback.
          const approved = yield* Effect.promise(() => fetch(started.authorization_url!, { redirect: "manual" }));
          const page = yield* Effect.promise(() => fetch(approved.headers.get("location")!).then((r) => r.text()));
          let status = yield* connectors.status(server);
          for (let i = 0; i < 50 && status.status !== "connected"; i++) {
            yield* Effect.sleep("50 millis");
            status = yield* connectors.status(server);
          }
          const listed = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 2, method: "tools/list" });
          const called = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_issues", arguments: {} } });
          const mcpList = yield* handlers["mcp.list"]({});
          const stored = yield* (yield* ProjectSecrets).list(CONNECTORS_REPOSITORY);
          yield* handlers["connector.disconnect"]({ request_id: "r2", id: "issues" } as never);
          const after = yield* connectors.status(server);
          const catalog = yield* handlers["connector.list"]();
          return { before, refused, started, page, status, listed, called, mcpList, stored, after, catalog };
        }).pipe(Effect.scoped, Effect.provide(layer())),
      );
      expect(out.before).toEqual({ status: "needs_sign_in" });
      expect(out.refused).toMatchObject({ error: { message: "issues is not connected: sign in from Plugins > Installed, on the server's page." } });
      expect(out.started.status).toBe("signing_in");
      const authorization = new URL(out.started.authorization_url!);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("client_id")).toBe("client-1");
      expect(authorization.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      expect(out.status).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.listed).toMatchObject({ result: { tools: [{ name: "list_issues" }] } });
      expect(out.called).toMatchObject({ result: { content: [{ text: "LIN-1 Fix the bug" }] } });
      expect(out.mcpList.servers[0]).toMatchObject({ name: "issues", auth: "oauth", status: "connected", tools: ["list_issues"] });
      // Kept sealed in the runtime's secrets store under its own repository; no answer carries a token.
      expect(out.stored.map((s) => s.name)).toEqual([expect.stringMatching(/^MCP_OAUTH_[0-9A-F]{24}$/)]);
      expect(JSON.stringify([out.mcpList, out.listed, out.called, out.catalog])).not.toContain(fake.token());
      expect(fake.log).toContain("POST /register");
      expect(out.after).toEqual({ status: "needs_sign_in" });
      // Connectors are the Caveman catalog's plugins that sign in, in its order; none installed yet.
      const listed = out.catalog.connectors.map((c) => [c.id, c.added, c.status ?? c.unavailable?.slice(0, 5)]);
      expect(listed.slice(0, 3)).toEqual([
        ["github", false, expect.stringMatching(/connected|needs_sign_in/)],
        ["linear", false, "needs_sign_in"],
        ["slack", false, "Slack"],
      ]);
      expect(listed).toContainEqual(["notion", false, "needs_sign_in"]);
      expect(listed).toContainEqual(["sentry", false, "needs_sign_in"]);
    } finally {
      fake.server.close();
    }
  });
});

/** The person's browser on This Mac: follows the server's authorization page to the runtime's loopback callback. */
const approveLocally = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    await fetch(approved.headers.get("location")!).then((r) => r.text());
  });

const until = <A>(read: Effect.Effect<A>, done: (a: A) => boolean) =>
  Effect.gen(function* () {
    let value = yield* read;
    for (let i = 0; i < 60 && !done(value); i++) {
      yield* Effect.sleep("50 millis");
      value = yield* read;
    }
    return value;
  });

describe("a server with nothing to sign in to", () => {
  it("is kept without a sign-in when Sign in finds it answers and offers none, and its old sign-in is forgotten", async () => {
    const url = "https://docs.example/mcp";
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const handlers = yield* makePluginHandlersWith({ projectOf: () => Effect.succeed(undefined), probe: async () => false });
        yield* registry.saveServer({ name: "docs", url, auth: "oauth", source: "codex", enabled: true }, false);
        const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "docs" } as never);
        const listed = yield* handlers["mcp.list"]({});
        return { started, server: listed.servers.find((s) => s.name === "docs"), status: yield* connectors.status({ name: "docs", url, auth: "oauth" }) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.started).toEqual({ status: "connected" });
    expect(out.server).not.toHaveProperty("auth");
    expect(out.server).toMatchObject({ name: "docs", url, source: "codex", enabled: true });
    expect(out.status.status).toBe("needs_sign_in");
  });
});

describe("connector sign-ins once This Mac is signed in to Caveman", () => {
  it("moves a sign-in made before linking to Cloud in one click, keeps it working meanwhile, then forgets this Mac's copy", async () => {
    const fake = fakeOAuthServer();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    const cloud = await startTestCloud();
    const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/mcp`;
    const caller = { threadId: ThreadId.make("t-move"), hooks: false };
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const connectors = yield* Connectors;
          const hub = yield* McpHub;
          const handlers = yield* makePluginHandlers;
          const config = yield* ServerConfig.ServerConfig;
          const server = { name: "issues", url, auth: "oauth" as const };
          yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
          // Before linking: This Mac's own sign-in.
          const local = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
          yield* approveLocally(local.authorization_url!);
          yield* until(connectors.status(server), (s) => s.status === "connected");
          yield* Effect.promise(() => enroll({ dir: linkDirOf(config.stateDir), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" }));
          const linked = yield* connectors.status(server);
          // Plain connect leaves a working sign-in alone; Move to Cloud starts Cloud's.
          const plain = yield* handlers["connector.connect"]({ request_id: "r2", id: "issues" } as never);
          const moving = yield* handlers["connector.connect"]({ request_id: "r3", id: "issues", move_to_cloud: true } as never);
          const midway = yield* connectors.status(server);
          const toolsMidway = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 1, method: "tools/list" });
          // The browser: Cloud's page approves at once here.
          yield* Effect.promise(() => fetch(moving.authorization_url!).then((r) => r.text()));
          yield* Effect.sleep("2100 millis");
          const moved = yield* connectors.status(server);
          const stored = yield* (yield* ProjectSecrets).list(CONNECTORS_REPOSITORY);
          return { linked, plain, moving, midway, toolsMidway, moved, stored };
        }).pipe(Effect.scoped, Effect.provide(layer())),
      );
      expect(out.linked).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.plain.status).toBe("connected");
      expect(out.moving.status).toBe("signing_in");
      expect(out.moving.authorization_url).toMatch(new RegExp(`^${cloud.url}/test/authorize`));
      expect(out.midway).toMatchObject({ status: "signing_in" });
      // Until Cloud has it, this Mac's own sign-in keeps the tools working.
      expect(out.toolsMidway).toMatchObject({ result: { tools: [{ name: "list_issues" }] } });
      expect(out.moved).toEqual({ status: "connected", heldBy: "cloud" });
      expect(out.stored).toEqual([]);
    } finally {
      fake.server.close();
      await cloud.close();
    }
  });

  it("signs in on This Mac when Cloud cannot sign in to the server, and says why in one sentence", async () => {
    const fake = fakeOAuthServer();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    const cloud = await startTestCloud();
    cloud.state.startRefusal = {
      status: 422,
      code: "cave_code_connection_blocked",
      message: "Caveman does not connect to that address: only public HTTPS servers, never private or cloud-metadata addresses.",
    };
    const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/mcp`;
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const connectors = yield* Connectors;
          const handlers = yield* makePluginHandlers;
          const config = yield* ServerConfig.ServerConfig;
          yield* Effect.promise(() => enroll({ dir: linkDirOf(config.stateDir), cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" }));
          const server = { name: "issues", url, auth: "oauth" as const };
          yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
          const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
          yield* approveLocally(started.authorization_url!);
          const status = yield* until(connectors.status(server), (s) => s.status === "connected");
          const listed = yield* handlers["mcp.list"]({});
          return { started, status, listed };
        }).pipe(Effect.scoped, Effect.provide(layer())),
      );
      // The provider's own page, answered on this Mac's loopback: not Cloud's.
      expect(out.started.status).toBe("signing_in");
      expect(new URL(out.started.authorization_url!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      const reason =
        "Signed in on this Mac only, because Caveman refused it: Caveman does not connect to that address: only public HTTPS servers, never private or cloud-metadata addresses.";
      expect(out.status).toEqual({ status: "connected", heldBy: "this_computer", heldReason: reason });
      expect(out.listed.servers[0]).toMatchObject({ name: "issues", status: "connected", held_by: "this_computer", held_reason: reason });
      expect(cloud.state.connections.size).toBe(0);
    } finally {
      fake.server.close();
      await cloud.close();
    }
  });
});

describe("a sign-in's status tells the truth", () => {
  it("refreshes a sign-in about to expire when asked, says Reconnect once its server refuses, and connects again", async () => {
    const fake = fakeOAuthServer();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/mcp`;
    const caller = { threadId: ThreadId.make("t-expiry"), hooks: false };
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const connectors = yield* Connectors;
          const hub = yield* McpHub;
          const handlers = yield* makePluginHandlers;
          const secrets = yield* ProjectSecrets;
          const server = { name: "issues", url, auth: "oauth" as const };
          yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
          const signIn = Effect.gen(function* () {
            const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
            yield* approveLocally(started.authorization_url!);
            return yield* until(connectors.status(server), (s) => s.status === "connected");
          });
          const saved = Effect.gen(function* () {
            const [entry] = yield* secrets.resolve(CONNECTORS_REPOSITORY);
            return JSON.parse(entry!.value) as { state: { tokens?: { access_token: string }; tokensExpireAt?: number }; lost?: true };
          });
          /** The stored access token runs out now, as it would an hour after sign-in. */
          const expire = Effect.gen(function* () {
            const [entry] = yield* secrets.resolve(CONNECTORS_REPOSITORY);
            const value = JSON.parse(entry!.value);
            value.state.tokensExpireAt = Date.now() - 1_000;
            yield* secrets.set(CONNECTORS_REPOSITORY, [{ name: entry!.name, value: Redacted.make(JSON.stringify(value)) }]);
          });
          const first = yield* signIn;

          // Expired, refresh works: status refreshes it and stays connected; the hub uses the new token.
          yield* expire;
          fake.setRefresh("accept");
          const refreshed = yield* connectors.status(server);
          const afterRefresh = yield* saved;
          const called = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_issues", arguments: {} } });

          // Expired, its server does not answer: unknown, so still connected (and not asked again at once).
          yield* expire;
          fake.setRefresh("down");
          const down = yield* connectors.status(server);
          const refreshesWhileDown = fake.log.filter((l) => l === "grant refresh_token").length;
          yield* connectors.status(server);
          const askedAgain = fake.log.filter((l) => l === "grant refresh_token").length > refreshesWhileDown;
          yield* hub.disconnect(personalServer("issues"));

          // Revoked at the server and the refresh refused: the hub's own 401 drops it, and status says reconnect.
          fake.setRefresh("refuse");
          fake.revokeAccess();
          const refusedCall = yield* hub.handle({ ...caller, threadId: ThreadId.make("t-expiry-2") }, "issues", { jsonrpc: "2.0", id: 2, method: "tools/list" });
          const lost = yield* connectors.status(server);
          const listedLost = yield* handlers["mcp.list"]({});

          // Connect again: connected, and the reconnect note is gone.
          const again = yield* signIn;
          const afterAgain = yield* saved;

          // Expired with the refresh refused, found by status alone (no hub call first).
          yield* expire;
          const expired = yield* connectors.status(server);
          return { first, refreshed, afterRefresh, called, down, askedAgain, refusedCall, lost, listedLost, again, afterAgain, expired };
        }).pipe(Effect.scoped, Effect.provide(layer())),
      );
      expect(out.first).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.refreshed).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.afterRefresh.state.tokensExpireAt).toBeGreaterThan(Date.now() + 30 * 60_000);
      expect(out.called).toMatchObject({ result: { content: [{ text: "LIN-1 Fix the bug" }] } });
      expect(out.down).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.askedAgain).toBe(false);
      expect(out.refusedCall).toMatchObject({ error: { code: -32000 } });
      expect(out.lost).toEqual({ status: "needs_sign_in", problem: EXPIRED_TEXT });
      expect(out.listedLost.servers[0]).toMatchObject({ name: "issues", status: "needs_sign_in", problem: EXPIRED_TEXT });
      expect(out.again).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(out.afterAgain.lost).toBeUndefined();
      expect(out.expired).toEqual({ status: "needs_sign_in", problem: EXPIRED_TEXT });
    } finally {
      fake.server.close();
    }
  });
});

describe("connectWhere", () => {
  it("sends a person to the plugin's Connect row, or the server's page under Installed for one of their own", () => {
    expect(connectWhere("linear@caveman-curated")).toBe("Plugins > linear > Connect");
    expect(connectWhere(undefined)).toBe("Plugins > Installed, on the server's page");
  });
});
