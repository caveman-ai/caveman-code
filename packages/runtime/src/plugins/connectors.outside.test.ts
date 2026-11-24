// Connectors on a Cloud computer whose person's sign-ins stay outside it (cloudLink/credentialRule.ts; CONTRACT §3.2):
// a real hub and the real connectors against a Cloud in a process of its own (testCloudEngine.ts) that is the
// connector proxy and the upstreams behind it. The hub reaches a server through the proxy by the id Cloud's list gave
// it, with the runtime's own token and nothing else; the upstream gets the connector's sign-in, which this process
// never holds (it is a canary made in the other one); and whatever has no such route says what a person can do.
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@caveman-app/protocol";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { accountVault } from "../cloudLink/accountCredentials.ts";
import {
  NO_PROXY_TEXT,
  NOT_OFFERED_TEXT,
  PROXY_OFF_TEXT,
  RECONNECT_ELSEWHERE_TEXT,
} from "../cloudLink/connectorProxy.ts";
import { ruleOf } from "../cloudLink/credentialRule.ts";
import { CloudError, enroll } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "../cloudLink/index.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import {
  type ConnectorRow,
  type EngineCloud,
  startEngineCloud,
} from "../cloudLink/testCloudEngine.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EgressScrub from "../secrets/EgressScrub.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { makeGitHubHandlers, OUTSIDE_SCOPE_TEXT } from "../session-protocol/github.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import {
  Connectors,
  layer as connectorsLayer,
  OUTSIDE_CONNECT_TEXT,
  OUTSIDE_GITHUB_SERVER_TEXT,
  OUTSIDE_GITHUB_TEXT,
  OUTSIDE_REMOVE_TEXT,
} from "./connectors.ts";
import { McpHub, McpHubAuth, layer as hubLayer, type TransportAuth } from "./McpHub.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const layer = () =>
  hubLayer.pipe(
    Layer.provideMerge(connectorsLayer),
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(EgressScrub.layer.pipe(Layer.provideMerge(ProjectSecretsLive.layer))),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-outside-" })),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const caller = { threadId: ThreadId.make("t-outside"), hooks: false };
const DOCS = "https://mcp.example.test/mcp";
const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";
const GITHUB: ConnectorRow = { connection_id: "github", provider: "github", status: "connected" };
const OWN: ConnectorRow = {
  connection_id: "conn-mcp",
  provider: "mcp",
  resource: DOCS,
  status: "connected",
  owner: "person",
};
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const textOf = (answer: unknown) => JSON.stringify(answer);

/** One tool call over what the hub's sign-in answered, as the hub's own transport makes it. */
const callThrough = async (
  auth: TransportAuth,
  tool: string,
  args: Record<string, unknown> = {},
) => {
  const client = new McpClient({ name: "test", version: "1" });
  await client.connect(
    new StreamableHttpTransport({
      url: auth.url!,
      headers: { ...auth.headers },
      authProvider: auth.authProvider!,
      fetch: auth.fetch!,
      openGetStream: false,
    }),
  );
  try {
    return await client.callTool(tool, args);
  } finally {
    await client.close();
  }
};

describe("connectors where credentials stay outside the computer", () => {
  let inner: TestCloud;
  let cloud: EngineCloud;
  beforeEach(async () => {
    inner = await startTestCloud();
    cloud = await startEngineCloud(inner.url, { credentialsOutside: true, connections: [] });
  });
  afterEach(async () => {
    accountVault.clear();
    await cloud.close();
    await inner.close();
  });

  /** `run` in a runtime that is a Cloud computer of this Cloud, under the rule (Cloud's own answer to `GET runtime` is asked by the integration test). */
  const onComputer = <A, E>(run: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const dir = path.join(config.stateDir, "mounted-link");
        const identity = yield* Effect.promise(() =>
          enroll({ dir, cloudUrl: cloud.url, bearer: inner.state.personToken, name: "computer" }),
        );
        const link: LinkState = {};
        ruleOf(link).join(() => Promise.resolve(true));
        return yield* (run as Effect.Effect<A, E, never>).pipe(
          Effect.provide(layer() as Layer.Layer<any, unknown, never>),
          Effect.provideService(CloudComputer, {
            linkDir: dir,
            computerId: identity.computerId,
            workspaceRoot: "/workspace",
          }),
          Effect.provideService(CloudLinkState, link),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "caveman-connectors-outside-link-" }),
        ),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ) as Effect.Effect<A, unknown, never>,
    );

  it("runs a server the person connected through Cloud's proxy: status from the list, the upstream's answer, and no lease, token or direct dial", async () => {
    const out = await onComputer(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const hub = yield* McpHub;
        const server = { name: "docs", url: DOCS, auth: "oauth" as const };
        yield* registry.saveServer({ ...server, source: "manual", enabled: true }, false);
        const status = yield* connectors.status(server);
        const auth = yield* (yield* McpHubAuth).transportAuth({
          key: "docs",
          server: { type: "http", url: DOCS, headers: {} },
          auth: { auth: "oauth", url: DOCS },
        });
        const listed = yield* hub.handle(caller, "docs", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        });
        const answered = yield* hub.handle(caller, "docs", call(2, "lookup", { q: "widgets" }));
        // The upstream repeats the sign-in it was sent, in an answer and in an error: neither arrives.
        const echoed = yield* hub.handle(caller, "docs", call(3, "echo_headers"));
        const failed = yield* hub.handle(caller, "docs", call(4, "fail"));
        // Managed from the person's own device, as before.
        const connect = yield* connectors.connect(server);
        const disconnect = yield* Effect.flip(connectors.disconnect(DOCS));
        return {
          status,
          url: auth.url,
          headers: auth.headers,
          listed,
          answered,
          echoed,
          failed,
          connect,
          disconnect,
        };
      }),
    );
    expect(out.status).toEqual({ status: "connected", heldBy: "cloud" });
    // The hub sends to Cloud, naming the connection by the id Cloud listed: the server's own address is never dialed
    // (mcp.example.test resolves nowhere).
    expect(out.url).toBe(`${cloud.url}/relay/v1/mcp/conn-mcp`);
    expect(out.headers).toBeUndefined();
    expect(out.listed).toMatchObject({
      result: {
        tools: expect.arrayContaining([{ name: "lookup", inputSchema: { type: "object" } }]),
      },
    });
    expect(textOf(out.answered)).toContain(
      'answer from the connector: lookup({\\"q\\":\\"widgets\\"})',
    );
    expect(textOf(out.echoed)).toMatch(/the upstream was sent authorization: Bearer \*{20,}/);
    expect(out.failed).toMatchObject({
      error: { message: expect.stringContaining("The connector answered 500.") },
    });
    expect(out.connect).toEqual({ status: "error", problem: OUTSIDE_CONNECT_TEXT });
    expect(out.disconnect.message).toBe(OUTSIDE_REMOVE_TEXT);

    const report = await cloud.report();
    // The upstream got the connector's sign-in, which Cloud attached, and nothing of the computer's.
    expect(report.connectors.length).toBeGreaterThanOrEqual(5);
    for (const seen of report.connectors)
      expect(seen).toMatchObject({
        upstream: "mcp",
        credentials: ["connectorToken"],
        runtimeToken: false,
        callerCredential: false,
      });
    expect(report.proxy.every((p) => p.connection === "conn-mcp")).toBe(true);
    expect(report.proxy.find((p) => p.status === 500)).toMatchObject({
      code: "cave_code_upstream",
    });
    // No answer carried it back, no lease was asked, and nothing was removed: only the list was read.
    expect(report.answersWithCanary).toEqual([]);
    expect(report.closed).toEqual([]);
    expect(report.asked).toContain("GET runtime/connections");
    expect(inner.state.leases).toEqual([]);
  });

  it("uses the shared account Cloud offers this workspace for a plugin, the person's own first, and names the chat's repository", async () => {
    const team: ConnectorRow = {
      connection_id: "conn-team",
      provider: "mcp",
      resource: DOCS,
      status: "connected",
      owner: "org",
      plugin_id: "docs@acme",
      offered: true,
      signed_in_by_name: "Ada",
    };
    const elsewhere: ConnectorRow = {
      ...team,
      connection_id: "conn-team-elsewhere",
      offered: false,
    };
    await cloud.configure({ connectors: [elsewhere, team] });
    const target = {
      key: "docs__docs",
      server: { type: "http" as const, url: DOCS, headers: {} },
      auth: {
        auth: "oauth" as const,
        url: DOCS,
        plugin: "docs@acme",
        repository: "github.com/acme/widgets",
      },
    };
    const out = await onComputer(
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        const auth = yield* McpHubAuth;
        const server = { name: "docs", url: DOCS, auth: "oauth" as const };
        const status = yield* connectors.status(server, { shared: { pluginId: "docs@acme" } });
        const shared = yield* auth.transportAuth(target);
        const answered = yield* Effect.promise(() => callThrough(shared, "lookup", { q: "team" }));
        // Another plugin's server at the same address is offered nothing.
        const other = yield* Effect.flip(
          auth.transportAuth({
            ...target,
            key: "other__docs",
            auth: { ...target.auth, plugin: "other@acme" },
          }),
        );
        // The person connects their own: it is used from the next list on.
        yield* Effect.promise(() => cloud.configure({ connectors: [elsewhere, team, OWN] }));
        yield* Effect.sleep("2100 millis");
        const own = yield* auth.transportAuth(target);
        const ownStatus = yield* connectors.status(server, { shared: { pluginId: "docs@acme" } });
        const alone = yield* connectors.status(server, {
          shared: { pluginId: "docs@acme", alone: true },
        });
        return {
          status,
          shared: { url: shared.url, headers: shared.headers },
          answered,
          other: other.message,
          own: own.url,
          ownStatus,
          alone,
        };
      }),
    );
    expect(out.status).toEqual({
      status: "connected",
      heldBy: "cloud",
      shared: true,
      sharedBy: "Ada",
    });
    expect(out.shared).toEqual({
      url: `${cloud.url}/relay/v1/mcp/conn-team`,
      headers: { "x-caveman-repository": "github.com/acme/widgets" },
    });
    expect(textOf(out.answered)).toContain("answer from the connector: lookup");
    expect(out.other).toBe(`other__docs isn't connected. ${OUTSIDE_CONNECT_TEXT}`);
    expect(out.own).toBe(`${cloud.url}/relay/v1/mcp/conn-mcp`);
    expect(out.ownStatus).toEqual({ status: "connected", heldBy: "cloud" });
    expect(out.alone).toEqual({
      status: "connected",
      heldBy: "cloud",
      shared: true,
      sharedBy: "Ada",
    });
    const report = await cloud.report();
    expect(
      report.proxy
        .filter((p) => p.connection === "conn-team")
        .every((p) => p.repository === "github.com/acme/widgets" && p.status < 300),
    ).toBe(true);
    expect(report.proxy.some((p) => p.connection === "conn-team-elsewhere")).toBe(false);
  });

  it("says what to do when a server is not connected, needs a new sign-in, or Cloud refuses it at the proxy", async () => {
    await cloud.configure({
      connectors: [
        {
          ...OWN,
          connection_id: "conn-stale",
          resource: "https://stale.example.test/mcp",
          status: "needs_reconnect",
        },
        OWN,
        { ...OWN, connection_id: "conn-gone", resource: "https://gone.example.test/mcp" },
      ],
    });
    const out = await onComputer(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const hub = yield* McpHub;
        const add = (name: string, url: string) =>
          registry.saveServer({ name, url, auth: "oauth", source: "manual", enabled: true }, false);
        yield* add("never", "https://never.example.test/mcp");
        yield* add("stale", "https://stale.example.test/mcp");
        yield* add("docs", DOCS);
        yield* add("gone", "https://gone.example.test/mcp");
        const list = (key: string) =>
          hub.handle(caller, key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
        const never = {
          status: yield* connectors.status({
            name: "never",
            url: "https://never.example.test/mcp",
            auth: "oauth",
          }),
          hub: yield* list("never"),
        };
        const stale = {
          status: yield* connectors.status({
            name: "stale",
            url: "https://stale.example.test/mcp",
            auth: "oauth",
          }),
          hub: yield* list("stale"),
        };
        // Cloud listed it, and no longer lets this computer use it (a shared account withdrawn, a connection removed).
        yield* Effect.promise(() => cloud.configure({ connectors: [OWN] }));
        const gone = yield* list("gone");
        // A Cloud whose proxy is switched off, and one that does not run it at all.
        yield* Effect.promise(() => cloud.configure({ connectorProxy: "off" }));
        const off = yield* list("docs");
        yield* Effect.promise(() => cloud.configure({ connectorProxy: "absent" }));
        const absent = yield* list("docs");
        return { never, stale, gone, off, absent };
      }),
    );
    // Not connected: the client says where a connector is connected; the hub says it to the model.
    expect(out.never.status).toEqual({ status: "needs_sign_in" });
    expect(out.never.hub).toMatchObject({
      error: { message: `never isn't connected. ${OUTSIDE_CONNECT_TEXT}` },
    });
    expect(out.stale.status).toEqual({
      status: "needs_sign_in",
      problem: RECONNECT_ELSEWHERE_TEXT,
    });
    expect(out.stale.hub).toMatchObject({
      error: {
        message:
          "stale's sign-in expired. Reconnect it on your Mac (Plugins > Installed, on the server's page).",
      },
    });
    expect(out.gone).toMatchObject({ error: { message: `gone: ${NOT_OFFERED_TEXT}` } });
    expect(out.off).toMatchObject({ error: { message: `docs: ${PROXY_OFF_TEXT}` } });
    expect(out.absent).toMatchObject({ error: { message: `docs: ${NO_PROXY_TEXT}` } });
    expect((await cloud.report()).closed).toEqual([]);
  });

  it("GitHub: its MCP server read-only through the proxy and its API reads for the repositories Cloud placed, never a token", async () => {
    const ctx = { connectionId: "c1", principal: "local" };
    const widgets = {
      id: "caveman-repo:widgets",
      path: "/workspace",
      repository: {
        host: "github.com",
        full_name: "acme/widgets",
        web_url: "https://github.com/acme/widgets",
        clone_url: "https://github.com/acme/widgets.git",
      },
    };
    const other = {
      ...widgets,
      id: "caveman-repo:other",
      repository: { ...widgets.repository, full_name: "acme/other" },
    };
    const out = await onComputer(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const connectors = yield* Connectors;
        const hub = yield* McpHub;
        yield* registry.saveServer(
          { name: "gh", url: GITHUB_MCP, auth: "github", source: "manual", enabled: true },
          false,
        );
        yield* registry.saveServer(
          {
            name: "ghapi",
            url: "https://api.github.com/graphql",
            auth: "github",
            source: "manual",
            enabled: true,
          },
          false,
        );
        const status = yield* connectors.status({ name: "gh", url: GITHUB_MCP, auth: "github" });
        const read = yield* hub.handle(
          caller,
          "gh",
          call(1, "list_issues", { owner: "acme", repo: "widgets" }),
        );
        const elsewhere = yield* hub.handle(
          caller,
          "gh",
          call(2, "list_issues", { owner: "acme", repo: "other" }),
        );
        const write = yield* hub.handle(
          caller,
          "gh",
          call(3, "create_issue", { owner: "acme", repo: "widgets", title: "x" }),
        );
        // A server that asks for the GitHub login at another of GitHub's addresses.
        const apiStatus = yield* connectors.status({
          name: "ghapi",
          url: "https://api.github.com/graphql",
          auth: "github",
        });
        const apiHub = yield* hub.handle(caller, "ghapi", {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
        });
        // The runtime's own reads (github.status, github.issues), over the real handlers.
        const login = yield* connectors.github;
        const handlers = makeGitHubHandlers({
          login: connectors.github,
          connect: Effect.succeed(undefined),
          api: undefined,
          project: (id) =>
            Effect.succeed(id === widgets.id ? widgets : id === other.id ? other : undefined),
        });
        const named = yield* handlers["github.status"]({}, ctx);
        const issues = yield* handlers["github.issues"]({ project_id: widgets.id }, ctx);
        const outOfScope = yield* Effect.flip(
          handlers["github.issues"]({ project_id: other.id }, ctx),
        );
        const refusedRead = yield* Effect.promise(() =>
          "proxy" in login
            ? login.proxy.get("repos/acme/widgets/collaborators").then(
                () => undefined,
                (cause: unknown) => cause,
              )
            : Promise.resolve(undefined),
        );
        // GitHub no longer connected in Cloud.
        yield* Effect.promise(() => cloud.configure({ connectors: [OWN] }));
        yield* Effect.sleep("2100 millis");
        const disconnected = yield* Effect.flip(connectors.github);
        const disconnectedStatus = yield* connectors.status({
          name: "gh",
          url: GITHUB_MCP,
          auth: "github",
        });
        return {
          status,
          read,
          elsewhere,
          write,
          apiStatus,
          apiHub,
          login: { source: login.source, token: "token" in login },
          named,
          issues,
          outOfScope,
          refusedRead,
          disconnected,
          disconnectedStatus,
        };
      }),
    );
    expect(out.status).toEqual({ status: "connected", heldBy: "cloud" });
    expect(textOf(out.read)).toContain("answer from the connector: list_issues");
    expect(textOf(out.elsewhere)).toContain("only read the repositories this computer works in");
    expect(textOf(out.write)).toContain("only read the repositories this computer works in");
    expect(out.apiStatus).toEqual({ status: "error", problem: OUTSIDE_GITHUB_SERVER_TEXT });
    expect(out.apiHub).toMatchObject({
      error: { message: `ghapi: ${OUTSIDE_GITHUB_SERVER_TEXT}` },
    });
    // The login is Cloud's and holds no token here.
    expect(out.login).toEqual({ source: "cloud", token: false });
    expect(out.named).toEqual({ login: "octo-person", source: "cloud" });
    expect(out.issues).toEqual({
      issues: [
        {
          number: 12,
          title: "Widgets wobble",
          url: "https://github.com/acme/widgets/issues/12",
          created_at: "2026-11-01T00:00:00Z",
          labels: ["bug"],
          assigned_to_me: true,
        },
      ],
    });
    expect(out.outOfScope).toMatchObject({
      reason: "invalid_state",
      message: OUTSIDE_SCOPE_TEXT,
      cloudCode: "cave_code_github_scope",
    });
    expect(out.refusedRead).toBeInstanceOf(CloudError);
    expect(out.refusedRead).toMatchObject({ status: 403, code: "cave_code_github_scope" });
    expect(out.disconnected).toBe(OUTSIDE_GITHUB_TEXT);
    expect(out.disconnectedStatus).toEqual({
      status: "needs_sign_in",
      problem: OUTSIDE_GITHUB_TEXT,
    });

    const report = await cloud.report();
    const mcp = report.connectors.filter((seen) => seen.upstream === "github-mcp");
    expect(mcp.length).toBeGreaterThan(0);
    for (const seen of mcp)
      expect(seen).toMatchObject({
        credentials: ["githubToken"],
        readOnly: true,
        runtimeToken: false,
      });
    expect(mcp.every((seen) => seen.path.endsWith("/readonly"))).toBe(true);
    // The refused calls never reached GitHub.
    expect(
      mcp.some((seen) => seen.body.includes("create_issue") || seen.body.includes('"other"')),
    ).toBe(false);
    const api = report.connectors.filter((seen) => seen.upstream === "github-api");
    expect(api.map((seen) => seen.path).sort()).toEqual(["/repos/acme/widgets/issues", "/user"]);
    for (const seen of api)
      expect(seen).toMatchObject({ credentials: ["githubToken"], runtimeToken: false });
    expect(report.answersWithCanary).toEqual([]);
    expect(report.closed).toEqual([]);
  });

  it("a service account's connector goes by the name Cloud gave it, below the address its credential is for", async () => {
    const connectors = [
      {
        id: "cred-bearer",
        type: "static_bearer" as const,
        match_url: "https://api.account.test/v1",
      },
    ];
    await cloud.configure({ account: connectors });
    const out = await onComputer(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        // What the computer's resolve heard under the rule: names, no value (computerSecrets.ts takes them so).
        accountVault.take([], undefined, connectors);
        yield* registry.saveServer(
          {
            name: "robot",
            url: "https://api.account.test/v1/mcp",
            source: "manual",
            enabled: true,
          },
          false,
        );
        yield* registry.saveServer(
          {
            name: "stranger",
            url: "https://api.account.test/v2/mcp",
            source: "manual",
            enabled: true,
          },
          false,
        );
        const answered = yield* hub.handle(caller, "robot", call(1, "lookup", { q: "robot" }));
        return { answered, covered: accountVault.proxiedFor("https://api.account.test/v2/mcp") };
      }),
    );
    expect(textOf(out.answered)).toContain("answer from the connector: lookup");
    // A server beside the credential's address is not covered: it is dialed as any server without a sign-in is.
    expect(out.covered).toBeUndefined();
    const report = await cloud.report();
    expect(report.proxy.length).toBeGreaterThan(0);
    for (const p of report.proxy)
      expect(p).toMatchObject({ connection: "cred-bearer", path: "/mcp" });
    for (const seen of report.connectors)
      expect(seen).toMatchObject({ credentials: ["connectorToken"], runtimeToken: false });
    expect(report.answersWithCanary).toEqual([]);
  });
});
