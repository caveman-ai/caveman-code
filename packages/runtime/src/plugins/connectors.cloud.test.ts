// Connectors on a runtime signed in to Caveman Cloud: Cloud holds the connection, the hub attaches a
// leased token (kept in memory, leased again after a 401), a refused refresh asks for a reconnect,
// GitHub leases the Cloud login (This Mac falls back to its own), and an unlinked Mac keeps the
// loopback sign-in.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { enroll } from "../cloudLink/identity.ts";
import { CloudComputer, linkDirOf } from "../cloudLink/index.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EgressScrub from "../secrets/EgressScrub.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import { CONNECTORS_REPOSITORY, Connectors, type GitHubLogin, layer as connectorsLayer, NO_CLOUD_GITHUB_TEXT, NO_GITHUB_TEXT } from "./connectors.ts";
import { McpHub, McpHubAuth, layer as hubLayer, personalServer } from "./McpHub.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { makePluginHandlers } from "./protocolHandlers.ts";

/** A remote MCP server that takes only the bearers in `accepted`, and records each one it was sent. */
function fakeMcp() {
  const accepted = new Set<string>();
  const seen: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push(request.headers.authorization);
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    if (bearer === undefined || !accepted.has(bearer)) return response.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_token"}');
    const frame = JSON.parse(body);
    if (frame.id === undefined) return response.writeHead(202).end();
    const result =
      frame.method === "initialize"
        ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "issues", version: "1" } }
        : frame.method === "tools/list"
          ? { tools: [{ name: "list_issues", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `echo ${bearer}` }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  });
  return { server, accepted, seen, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

const layer = (options: { computer?: boolean; githubToken?: string } = {}) => {
  const base = hubLayer.pipe(
    Layer.provideMerge(connectorsLayer),
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    // The egress scrub's ProjectSecrets: the one session events and model requests are scrubbed with.
    Layer.provideMerge(EgressScrub.layer.pipe(Layer.provideMerge(ProjectSecretsLive.layer))),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-cloud-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const withGithub =
    options.githubToken === undefined
      ? base
      : base.pipe(
          Layer.provide(
            Layer.succeed(GitHubCredentials.GitHubCredentials, {
              get: (host: string) => Effect.succeed({ host, token: Redacted.make(options.githubToken!), source: "env", fingerprint: "test" }),
              invalidate: () => Effect.void,
            } as never),
          ),
        );
  return withGithub;
};

/** Signs this runtime in to the test Cloud: This Mac's link dir, or (computer) a mounted one. */
const signIn = (cloud: TestCloud, computer: boolean) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const dir = computer ? path.join(config.stateDir, "mounted-link") : linkDirOf(config.stateDir);
    const identity = yield* Effect.promise(() => enroll({ dir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "test" }));
    return { dir, identity };
  });

const caller = { threadId: ThreadId.make("t-cloud"), hooks: false };
const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";
/** GitHub's MCP server is the fake one: requests to GITHUB_MCP go to `to` (the hub's transport takes the global fetch). */
const routeGithub = (to: () => string) => {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    real(typeof input === "string" || input instanceof URL ? String(input).replace(GITHUB_MCP, to()) : input, init)) as typeof fetch;
  return () => void (globalThis.fetch = real);
};
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_issues", arguments: {} } });
/** The bearer the hub would attach to a new connection to a plugin's server that signs in, or why it cannot. */
const hubBearer = (target: { readonly key: string; readonly auth: { readonly auth: "oauth" | "github"; readonly url: string; readonly plugin?: string; readonly repository?: string } }) =>
  Effect.gen(function* () {
    const auth = yield* McpHubAuth;
    return yield* auth.transportAuth({ key: target.key, server: { type: "http", url: target.auth.url, headers: {} }, auth: target.auth }).pipe(
      Effect.flatMap((transport) => Effect.promise(() => transport.authProvider!.token())),
      Effect.match({ onFailure: (error) => ({ failed: error.message }), onSuccess: (token) => ({ token }) }),
    );
  });

describe("connectors through Caveman", () => {
  let cloud: TestCloud;
  let mcp: ReturnType<typeof fakeMcp>;
  beforeEach(async () => {
    cloud = await startTestCloud();
    mcp = fakeMcp();
    await new Promise<void>((resolve) => mcp.server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    mcp.server.close();
    await cloud.close();
  });

  it("connects through Cloud's sign-in, attaches the leased token, leases again after a 401, and asks for a reconnect when Cloud's refresh is refused", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const hub = yield* McpHub;
        const handlers = yield* makePluginHandlers;
        const server = { name: "issues", url: mcp.url(), auth: "oauth" as const };
        yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);

        const before = yield* connectors.status(server);
        const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
        const pending = yield* connectors.status(server);
        // The person's browser: Cloud's own page, which approves at once here.
        yield* Effect.promise(() => fetch(started.authorization_url!).then((r) => r.text()));
        yield* Effect.sleep("2100 millis"); // past the list's reuse window
        const connected = yield* connectors.status(server);
        const row = [...cloud.state.connections.values()][0]!;
        mcp.accepted.add(row.token!);
        const listed = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 1, method: "tools/list" });
        const first = yield* hub.handle(caller, "issues", call(2));
        const leasesBefore = cloud.state.leases.length;

        // The provider rotated the token: the server refuses the cached one, the hub leases again.
        const rotated = `lease-rotated-${Date.now()}`;
        row.token = rotated;
        mcp.accepted.clear();
        mcp.accepted.add(rotated);
        const second = yield* hub.handle(caller, "issues", call(3));

        // Cloud's refresh was refused: the next lease is a 409.
        row.status = "needs_reconnect";
        row.problem = "Linear refused the refresh token.";
        mcp.accepted.clear();
        yield* Effect.sleep("2100 millis");
        const reconnect = yield* connectors.status(server);
        const refused = yield* hub.handle(caller, "issues", call(4));
        yield* hub.disconnect(personalServer("issues"));
        const reopened = yield* hub.handle(caller, "issues", { jsonrpc: "2.0", id: 5, method: "tools/list" });

        const mcpList = yield* handlers["mcp.list"]({});
        const catalog = yield* handlers["connector.list"]();
        const secrets = yield* ProjectSecrets;
        const stored = yield* secrets.list(CONNECTORS_REPOSITORY);
        const scrubbed = (yield* secrets.scrubber).scrub(`Authorization: Bearer ${rotated} and ${row.token}`);
        yield* handlers["connector.disconnect"]({ request_id: "r2", id: "issues" } as never);
        return { before, started, pending, connected, listed, first, leasesBefore, second, reconnect, refused, reopened, mcpList, catalog, stored, scrubbed, rotated };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.before).toEqual({ status: "needs_sign_in" });
    expect(out.started.status).toBe("signing_in");
    expect(out.started.authorization_url).toMatch(new RegExp(`^${cloud.url}/test/authorize\\?connection_id=`));
    expect(out.pending).toEqual({ status: "signing_in", authorizationUrl: out.started.authorization_url });
    expect(out.connected).toEqual({ status: "connected", heldBy: "cloud" });
    expect(out.listed).toMatchObject({ result: { tools: [{ name: "list_issues" }] } });
    expect(out.first).toMatchObject({ result: { content: [{ text: expect.stringMatching(/^echo lease-/) }] } });
    // One lease served the connection's every request until the server refused it.
    expect(out.leasesBefore).toBe(1);
    expect(out.second).toMatchObject({ result: { content: [{ text: `echo ${out.rotated}` }] } });
    // The lease after the 401 asked Cloud to refresh rather than hand back the refused token.
    expect(cloud.state.leases.slice(0, 2).map((l) => [l.token === out.rotated, l.stale])).toEqual([[false, false], [true, true]]);
    expect(out.reconnect).toEqual({ status: "needs_sign_in", problem: "Linear refused the refresh token." });
    expect(out.refused).toMatchObject({ error: { message: "issues: it needs a new sign-in: reconnect it in Plugins > Installed, on the server's page." } });
    expect(out.reopened).toMatchObject({ error: { message: "issues needs a new sign-in: reconnect it in Plugins > Installed, on the server's page." } });
    // Disconnect deleted Cloud's connection.
    expect(cloud.state.connections.size).toBe(0);
    // A leased token is never kept in the secrets store (memory only), never in an answer, and always scrubbed.
    expect(out.stored).toEqual([]);
    const answers = JSON.stringify([out.started, out.mcpList, out.catalog, out.listed, out.refused, out.reopened]);
    for (const lease of cloud.state.leases) expect(answers).not.toContain(lease.token);
    expect(out.scrubbed).not.toContain(out.rotated);
    expect(out.scrubbed).toContain("[secret:CONNECTOR_TOKEN]");
  });

  it("leases the Cloud GitHub login on a Cloud computer, and falls back to this Mac's own login on This Mac only", async () => {
    const unroute = routeGithub(mcp.url);
    try {
      const onComputer = await Effect.runPromise(
        Effect.gen(function* () {
          const { dir, identity } = yield* signIn(cloud, true);
          return yield* Effect.gen(function* () {
            const registry = yield* PluginRegistry.PluginRegistry;
            const connectors = yield* Connectors;
            const hub = yield* McpHub;
            const server = { name: "gh", url: GITHUB_MCP, auth: "github" as const };
            yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
            const none = yield* connectors.status(server);
            const refusedHub = yield* hub.handle(caller, "gh", { jsonrpc: "2.0", id: 1, method: "tools/list" });
            const start = yield* connectors.connect(server);
            cloud.state.githubToken = ("gh" + "o_cloudlogin0123456789");
            mcp.accepted.add(("gh" + "o_cloudlogin0123456789"));
            const leasesBefore = cloud.state.leases.length;
            const connected = yield* connectors.status(server);
            // Status reads Cloud's list: no lease, so no access-log row per mcp.list.
            const leasedByStatus = cloud.state.leases.length - leasesBefore;
            const listed = yield* hub.handle(caller, "gh", { jsonrpc: "2.0", id: 2, method: "tools/list" });
            return { none, refusedHub, start, connected, leasedByStatus, listed };
          }).pipe(Effect.provide(layer()), Effect.provideService(CloudComputer, { linkDir: dir, computerId: identity.computerId, workspaceRoot: "/workspace" }));
        }).pipe(Effect.scoped, Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-computer-" })), Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      );
      expect(onComputer.none).toEqual({ status: "needs_sign_in", problem: "Connect GitHub to Caveman to use it on this computer." });
      expect(onComputer.refusedHub).toMatchObject({ error: { message: "gh needs a new sign-in: reconnect it in Plugins > Installed, on the server's page." } });
      expect(onComputer.start.status).toBe("signing_in");
      expect(onComputer.start.authorizationUrl).toMatch(new RegExp(`^${cloud.url}/`));
      expect(onComputer.connected).toEqual({ status: "connected", heldBy: "cloud" });
      expect(onComputer.leasedByStatus).toBe(0);
      expect(onComputer.listed).toMatchObject({ result: { tools: [{ name: "list_issues" }] } });
      expect(mcp.seen).toContain(("Bearer gh" + "o_cloudlogin0123456789"));

      cloud.state.githubToken = undefined;
      mcp.accepted.add("gho_thismac0123456789");
      const onMac = await Effect.runPromise(
        Effect.gen(function* () {
          yield* signIn(cloud, false);
          const registry = yield* PluginRegistry.PluginRegistry;
          const connectors = yield* Connectors;
          const hub = yield* McpHub;
          const server = { name: "gh", url: GITHUB_MCP, auth: "github" as const };
          yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
          const status = yield* connectors.status(server);
          const listed = yield* hub.handle(caller, "gh", { jsonrpc: "2.0", id: 1, method: "tools/list" });
          return { status, listed };
        }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
      );
      expect(onMac.status).toEqual({ status: "connected", heldBy: "this_computer" });
      expect(onMac.listed).toMatchObject({ result: { tools: [{ name: "list_issues" }] } });
      expect(mcp.seen).toContain("Bearer gho_thismac0123456789");
    } finally {
      unroute();
    }
  });

  it("github (github.status, github.issues): Cloud's lease when Cloud holds a GitHub login, else this Mac's own; a Cloud computer has none of its own", async () => {
    // A token and where it came from; a login read through Cloud's proxy (a Cloud computer under the credential rule) holds none.
    const value = (login: GitHubLogin) => ({ token: "token" in login ? Redacted.value(login.token) : undefined, source: login.source });
    // Not signed in: this Mac's own login only, and Cloud is never asked.
    const unlinked = await Effect.runPromise(
      Effect.gen(function* () {
        return value(yield* (yield* Connectors).github);
      }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
    );
    expect(unlinked).toEqual({ token: "gho_thismac0123456789", source: "env" });
    const nothing = await Effect.runPromise(Effect.gen(function* () {
      return yield* Effect.flip((yield* Connectors).github);
    }).pipe(Effect.scoped, Effect.provide(layer())));
    expect(nothing).toBe(NO_GITHUB_TEXT);
    expect(cloud.state.leases).toEqual([]);

    // Signed in on This Mac: Cloud's login while Cloud lists it, leased once and reused from memory; else this Mac's.
    const onMac = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const connectors = yield* Connectors;
        const fallback = value(yield* connectors.github);
        cloud.state.githubToken = ("gh" + "o_cloudlogin0123456789");
        yield* Effect.sleep("2100 millis"); // past the list's reuse window
        const leased = value(yield* connectors.github);
        const again = value(yield* connectors.github);
        return { fallback, leased, again };
      }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
    );
    expect(onMac.fallback).toEqual({ token: "gho_thismac0123456789", source: "env" });
    expect(onMac.leased).toEqual({ token: ("gh" + "o_cloudlogin0123456789"), source: "cloud" });
    expect(onMac.again).toEqual(onMac.leased);
    expect(cloud.state.leases.map((l) => l.target)).toEqual(["provider:github"]);

    // A Cloud computer without Cloud's GitHub login: told to connect it in Cloud, never a login of the computer's.
    cloud.state.githubToken = undefined;
    const onComputer = await Effect.runPromise(
      Effect.gen(function* () {
        const { dir, identity } = yield* signIn(cloud, true);
        return yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* Connectors).github);
        }).pipe(
          Effect.provide(layer({ githubToken: "gho_thismac0123456789" })),
          Effect.provideService(CloudComputer, { linkDir: dir, computerId: identity.computerId, workspaceRoot: "/workspace" }),
        );
      }).pipe(Effect.scoped, Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-computer-" })), Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
    expect(onComputer).toBe(NO_CLOUD_GITHUB_TEXT);
  });

  it("connectGitHub (github.connect): Cloud's page when signed in, none when not, and the next github read sees what Cloud holds then", async () => {
    // A token and where it came from; a login read through Cloud's proxy (a Cloud computer under the credential rule) holds none.
    const value = (login: GitHubLogin) => ({ token: "token" in login ? Redacted.value(login.token) : undefined, source: login.source });
    // Not signed in: nowhere to connect it, and Cloud is never asked.
    const unlinked = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Connectors).connectGitHub;
      }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
    );
    expect(unlinked).toBeUndefined();

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const connectors = yield* Connectors;
        // This Mac's own login while Cloud holds none; Cloud's list is now kept for a moment.
        const before = value(yield* connectors.github);
        const url = yield* connectors.connectGitHub;
        // The person finishes in the browser: Cloud holds their GitHub login now.
        cloud.state.githubToken = ("gh" + "o_cloudlogin0123456789");
        // Read at once, inside the list's reuse window: the list kept from before was dropped by the connect.
        const after = value(yield* connectors.github);
        return { before, url, after };
      }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
    );
    expect(out.before).toEqual({ token: "gho_thismac0123456789", source: "env" });
    expect(out.url).toBe(`${cloud.url}/test/console`);
    expect(out.after).toEqual({ token: ("gh" + "o_cloudlogin0123456789"), source: "cloud" });
  });

  it("never sends a GitHub login to a server that is not GitHub's, from Cloud or from this Mac", async () => {
    cloud.state.githubToken = ("gh" + "o_cloudlogin0123456789");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const hub = yield* McpHub;
        // Any server can say auth "github" (a plugin's .mcp.json, an import): this one is on 127.0.0.1.
        const server = { name: "lookalike", url: mcp.url(), auth: "github" as const };
        yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
        const status = yield* connectors.status(server);
        const refused = yield* hub.handle(caller, "lookalike", { jsonrpc: "2.0", id: 1, method: "tools/list" });
        return { status, refused };
      }).pipe(Effect.scoped, Effect.provide(layer({ githubToken: "gho_thismac0123456789" }))),
    );
    expect(out.status).toMatchObject({ status: "error", problem: "This server can't use your GitHub sign-in. Give it its own key." });
    expect(out.refused).toMatchObject({ error: { message: "lookalike: This server can't use your GitHub sign-in. Give it its own key." } });
    expect(mcp.seen.filter((a) => a !== undefined)).toEqual([]);
    expect(cloud.state.leases).toEqual([]);
  });

  it("Disconnect ends a plugin server's lease of that connection: its next connection asks Caveman and finds it gone", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const connectors = yield* Connectors;
        const server = { name: "linear", url: mcp.url(), auth: "oauth" as const };
        const started = yield* connectors.connect(server);
        yield* Effect.promise(() => fetch(started.authorizationUrl!).then((r) => r.text()));
        // A catalog plugin's server: the hub leases it under the plugin and the repository (PluginRegistry remoteAuth).
        const target = { key: "linear__linear", auth: { auth: "oauth" as const, url: mcp.url(), plugin: "linear@caveman-curated", repository: "github.com/acme/app" } };
        const used = yield* hubBearer(target);
        // Disconnect, by the URL written another way than the plugin's.
        yield* connectors.disconnect(mcp.url().replace(/^http:/, "HTTP:"));
        return { used, rowsLeft: cloud.state.connections.size, after: yield* hubBearer(target) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.used).toEqual({ token: expect.stringMatching(/^lease-/) });
    expect(out.rowsLeft).toBe(0);
    expect(out.after).toEqual({ failed: "linear__linear is not connected: sign in from Plugins > linear > Connect." });
  });

  it("github.connect ends a plugin server's lease of the GitHub login being replaced: it leases the new one", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const connectors = yield* Connectors;
        cloud.state.githubToken = ("gh" + "o_oldaccount0123456789");
        const target = { key: "github__github", auth: { auth: "github" as const, url: GITHUB_MCP, plugin: "github@caveman-curated", repository: "github.com/acme/app" } };
        const before = yield* hubBearer(target);
        yield* connectors.connectGitHub;
        // The person connects another GitHub account in Caveman.
        cloud.state.githubToken = ("gh" + "o_newaccount0123456789");
        return { before, after: yield* hubBearer(target) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.before).toEqual({ token: ("gh" + "o_oldaccount0123456789") });
    expect(out.after).toEqual({ token: ("gh" + "o_newaccount0123456789") });
  });

  it("finds Cloud's connection for a server URL written differently from Cloud's canonical one", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* signIn(cloud, false);
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const handlers = yield* makePluginHandlers;
        // Cloud stores http://127.0.0.1:<port>/mcp; the person typed the scheme in capitals.
        const server = { name: "issues", url: mcp.url().replace(/^http:/, "HTTP:"), auth: "oauth" as const };
        yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
        const started = yield* handlers["connector.connect"]({ request_id: "r1", id: "issues" } as never);
        yield* Effect.promise(() => fetch(started.authorization_url!).then((r) => r.text()));
        yield* Effect.sleep("2100 millis");
        const connected = yield* connectors.status(server);
        yield* handlers["connector.disconnect"]({ request_id: "r2", id: "issues" } as never);
        return { connected, stored: [...cloud.state.connections.values()].map((r) => r.resource) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.connected).toEqual({ status: "connected", heldBy: "cloud" });
    // Sign out found it too.
    expect(out.stored).toEqual([]);
  });

  it("keeps the loopback sign-in on a Mac that is not signed in to Cloud, and never calls Cloud", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const server = { name: "issues", url: mcp.url(), auth: "oauth" as const };
        yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
        return { status: yield* connectors.status(server) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.status).toEqual({ status: "needs_sign_in" });
    expect(cloud.state.leases).toEqual([]);
    expect(cloud.state.connections.size).toBe(0);
    expect(cloud.state.mints).toEqual([]);
  });
});
