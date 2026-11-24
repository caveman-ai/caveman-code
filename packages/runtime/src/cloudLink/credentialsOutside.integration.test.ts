// "An agent with root finds no real credential" (cloud-computers SPEC decision 2, CONTRACT §2 to §4,
// formal/NothingToSteal.tla): a real runtime as a Cloud computer, against a Cloud whose every credential is a canary
// (testCloudEngine.ts, in a process of its own). A Claude Agent turn and a Codex request go through the egress scrub
// and Cloud's data plane to a provider, which must receive the canary the data plane attached, and the answer must
// stream back. A tool call on an MCP connector goes through the runtime's hub and Cloud's connector proxy (CONTRACT
// §3.2) to the connector's server, which must receive the canary the proxy attached, and its answer must come back;
// GitHub's API is read the same way. Then every place an agent with root could look is searched for every canary: the
// files under the runtime's state, its link directory and the workspace; the environment of every child process the
// runtime started; every answer Cloud gave it; and the runtime's own heap (a V8 snapshot).
//
// The same run against a Cloud that does not apply the rule must find canaries in the heap: Cloud then hands them
// over, as it did before. So the search is shown able to find one.
//
// And what a client could hand the computer to keep (SPEC §5.6): a web search key, a voice key, a secret manager's
// service account token, a plugin's key and a key in a server's command line, each a canary of this test's own, sent
// before the turn runs. Under the rule each is refused with its sentence before anything is asked of a provider, and
// afterwards no file under the runtime's state, no child's environment and no answer holds one. Without the rule the
// same writes are kept, and the plugin's key and the command line's are found in files. These canaries are made in
// this process, so the heap is not searched for them.
import { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v8 from "node:v8";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import { ThreadId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, expect, test, vi } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeDeepgram, VoiceEngineRef } from "../chief/voice/deepgram.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConnectorsModule from "../plugins/connectors.ts";
import {
  Connectors,
  OUTSIDE_CONNECT_TEXT,
  OUTSIDE_GITHUB_TEXT,
  OUTSIDE_REMOVE_TEXT,
} from "../plugins/connectors.ts";
import { layerSecretStore } from "../plugins/CredentialBroker.ts";
import { McpHub, McpHubAuth, layer as hubLayer } from "../plugins/McpHub.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { CODEX_VIA_PROXY } from "../secrets/EgressScrub.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as SecretProviderTokens from "../secrets/SecretProviderTokens.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { makeGitHubHandlers } from "../session-protocol/github.ts";
import {
  createReady,
  FAKE_CLAUDE,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import {
  CloudValues,
  layerBroker,
  makeProjectSecrets,
  OUTSIDE_SECRETS,
} from "./computerSecrets.ts";
import {
  OUTSIDE_CONNECT,
  OUTSIDE_SECRET_MANAGER,
  OUTSIDE_SERVER_KEY,
  OUTSIDE_VOICE_KEY,
  OUTSIDE_WEB_KEY,
  outsideLine,
  ruleOf,
} from "./credentialRule.ts";
import { EngineCloudKeys } from "./engineKeys.ts";
import { followedLogins, hasFollowedLogin, parseCodexAuth } from "./engineLogins.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState, type LinkState } from "./index.ts";
import { connectionsOf } from "./modelConnections.ts";
import { startTestCloud } from "./testCloud.ts";
import { fileHoldsCanaries, startEngineCloud, type EngineConnection } from "./testCloudEngine.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CONNECTIONS: Array<EngineConnection> = [
  {
    id: "conn-claude-plan",
    kind: "claude_plan",
    provider: "anthropic",
    label: "Claude Max",
    position: 0,
    status: "ready",
    serves: ["claude-agent"],
  },
  {
    id: "conn-chatgpt-plan",
    kind: "chatgpt_plan",
    provider: "openai",
    label: "ChatGPT Pro",
    position: 1,
    status: "ready",
    serves: ["codex"],
  },
  {
    id: "conn-anthropic-key",
    kind: "api_key",
    provider: "anthropic",
    label: "Anthropic",
    position: 2,
    status: "ready",
    serves: ["claude-agent", "caveman"],
  },
  {
    id: "conn-openai-key",
    kind: "api_key",
    provider: "openai",
    label: "OpenAI",
    position: 3,
    status: "ready",
    serves: ["codex", "caveman"],
  },
  {
    id: "conn-gateway",
    kind: "gateway",
    provider: "openrouter",
    label: "OpenRouter",
    position: 4,
    status: "ready",
    serves: ["caveman"],
  },
];

/** Every regular file under `root`. */
const filesUnder = (root: string): Array<string> =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
    : [];

/** Runs the whole story against a Cloud that applies the rule (`outside`) or one from before it; answers what was found where. */
async function story(outside: boolean) {
  const inner = await startTestCloud();
  cleanups.push(inner.close);
  const cloud = await startEngineCloud(inner.url, {
    credentialsOutside: outside ? true : null,
    connections: CONNECTIONS,
  });
  cleanups.push(cloud.close);
  // The providers, as the scrub reaches them when it holds the credential itself: the same stand-in provider.
  vi.spyOn(appProxy, "url").mockReturnValue(`${cloud.url}/__provider/claude`);
  vi.spyOn(codexProxy, "url").mockReturnValue(`${cloud.url}/__provider/codex`);

  const root = tempRoot("credentials-outside-");
  const linkDir = path.join(root, "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: inner.state.personToken,
    name: "computer",
  });
  const checkout = makeRepo(path.join(root, "workspace"), { "README.md": "widgets\n" });
  fs.chmodSync(checkout, 0o755);

  // The environment of every child process this process starts from here on, as the kernel is handed it.
  const spawned = path.join(root, "spawned.ndjson");
  const proto = ChildProcess.prototype as unknown as {
    spawn: (options: {
      file?: string;
      args?: ReadonlyArray<string>;
      envPairs?: ReadonlyArray<string>;
    }) => unknown;
  };
  const spawnChild = proto.spawn;
  let children = 0;
  proto.spawn = function (options) {
    children++;
    fs.appendFileSync(
      spawned,
      `${JSON.stringify({ file: options.file, args: options.args, env: options.envPairs })}\n`,
    );
    return spawnChild.call(this, options);
  };
  cleanups.push(() => void (proto.spawn = spawnChild));
  // And the claude's own, as the process itself sees it.
  const claudeEnv = path.join(root, "claude-env");
  fs.mkdirSync(claudeEnv);
  const claude = path.join(root, "claude");
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nenv > '${claudeEnv}'/$$.env\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`,
    { mode: 0o755 },
  );

  const link: LinkState = {};
  const computer = { linkDir, computerId: identity.computerId, workspaceRoot: checkout };
  const config = await makeConfig();
  // What a client's pasted keys land in, as server.ts gives the route: the runtime's settings file and secret store on
  // its state dir, the plugin registry with its grants, a secret manager's tokens, and the keys' host. The voice
  // engine's provider is a stand-in that counts what it is asked: no key of this test's leaves the machine.
  let voiceAsked = 0;
  const voiceEngine = makeDeepgram({
    fetch: async () => (
      voiceAsked++,
      { status: 200, json: async () => ({ access_token: "test-token" }), text: async () => "" }
    ),
  });
  const stores = Layer.mergeAll(
    ServerSettingsModule.layer,
    PluginRegistry.layer.pipe(
      Layer.provide(Layer.mergeAll(ServerSettingsModule.layer, layerSecretStore)),
    ),
    SecretProviderTokens.layer,
    TestProviderHost.layer(),
    Layer.succeed(VoiceEngineRef, voiceEngine),
  ) as Layer.Layer<any, never, any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    cloudComputer: { computer, link },
    egress: true,
    claudeBinary: claude,
    provide: stores,
  });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);

  // What a person could paste into this computer from a client, before anything runs: each a canary of this test's.
  const pasted = {
    webKey: `BSA-CANARY-web-${randomBytes(18).toString("hex")}`,
    voiceKey: `dg-CANARY-voice-${randomBytes(18).toString("hex")}`,
    managerToken: `ops_CANARY-manager-${randomBytes(18).toString("hex")}`,
    serverKey: `CANARY-server-${randomBytes(18).toString("hex")}`,
    // A key pasted with a server's command line, as many servers' docs write it.
    serverLine: `CANARY-line-${randomBytes(18).toString("hex")}`,
  };
  /** Every answer the runtime gave this client about them, as text. */
  const answers: Array<string> = [];
  /** A call's answer as it reached the client: its result, or the refusal's reason and words. */
  const tried = <A>(call: Promise<A>) =>
    call
      .then(
        (result) => ({ ok: true as const, result }),
        (error: { error?: { data?: { reason?: string }; message?: string } }) => ({
          ok: false as const,
          reason: error.error?.data?.reason,
          message: error.error?.message,
        }),
      )
      .then((answer) => (answers.push(JSON.stringify(answer)), answer));
  const writes = {
    webKey: await tried(
      client.call("web.keys.set", { request_id: "k1", provider: "brave", key: pasted.webKey }),
    ),
    voiceKey: await tried(
      client.call("chief.voice.key", {
        request_id: "k2",
        engine: "deepgram",
        key: pasted.voiceKey,
      }),
    ),
    secretManager: await tried(
      client.call("secret_provider.save", {
        request_id: "k3",
        label: "1Password",
        service_account: true,
        service_account_token: pasted.managerToken,
      }),
    ),
    // The server itself holds no key: only the names of the ones it needs.
    server: await tried(
      client.call("mcp.add", {
        request_id: "k4",
        name: "datadog",
        command: "datadog-mcp",
        env: ["DD_API_KEY"],
      }),
    ),
    serverKey: await tried(
      client.call("credential.grant", {
        request_id: "k5",
        marketplace: "personal",
        name: "DD_API_KEY",
        value: pasted.serverKey,
      }),
    ),
    serverLine: await tried(
      client.call("mcp.add", {
        request_id: "k6",
        name: "keyflag",
        command: "tool-mcp",
        args: ["--api-key", pasted.serverLine],
      }),
    ),
  };
  // What the computer then says it keeps, by the reads a client has (the voice key's is its write's own answer).
  const reads = {
    web: await tried(client.call("web.keys.status", {})),
    managers: await tried(client.call("secret_provider.list", {})),
    servers: await tried(client.call("mcp.list", {})),
  };
  const kept = {
    webKey:
      reads.web.ok && reads.web.result.providers.some((p) => p.id === "brave" && p.configured),
    secretManager:
      reads.managers.ok && reads.managers.result.providers.some((p) => p.has_token === true),
    serverKey:
      reads.servers.ok &&
      reads.servers.result.servers.some(
        (s) => s.name === "datadog" && s.credentials.some((c) => c.granted),
      ),
    serverLine: reads.servers.ok && reads.servers.result.servers.some((s) => s.name === "keyflag"),
  };
  const voiceAskedForKey = voiceAsked;

  // What server.ts gives a Cloud computer beside the route: its broker (the engines' keys, the sign-ins that follow
  // the person), its repository secrets from Cloud, the connectors, and the MCP hub that reaches servers for a chat's
  // engine. Each is what asked Cloud for a credential.
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const side = await Effect.runPromise(
    Layer.buildWithScope(
      hubLayer.pipe(
        Layer.provideMerge(ConnectorsModule.layer),
        Layer.provideMerge(PluginRegistry.layer),
        Layer.provideMerge(
          Layer.merge(layerBroker, Layer.effect(ProjectSecrets, makeProjectSecrets)),
        ),
        Layer.provideMerge(ServerSettingsModule.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(CloudComputer, computer),
            Layer.succeed(CloudLinkState, link),
            Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
          ),
        ),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ) as Layer.Layer<any, unknown, never>,
      scope,
    ),
  );
  const inSide = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(Effect.result(effect.pipe(Effect.provide(side))) as Effect.Effect<any>);
  /** A failure as the words it carries (an Error's message is not a property JSON shows). */
  const inWords = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) => (error instanceof Error ? error.message : String(error))),
    );
  const sideAnswers = {
    engineKey: await inSide(
      Effect.gen(function* () {
        return yield* (yield* EngineCloudKeys).get("claude-agent");
      }),
    ),
    secrets: await inSide(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecrets;
        return (yield* secrets.resolve("github.com/acme/widgets")).map((entry) => entry.name);
      }),
    ),
    secretSet: await inSide(
      Effect.gen(function* () {
        const { Redacted } = yield* Effect.promise(() => import("effect"));
        return yield* (yield* ProjectSecrets).set("github.com/acme/widgets", [
          { name: "NEW_NAME", value: Redacted.make("a-new-test-value") },
        ]);
      }),
    ),
    github: await inSide(
      Effect.gen(function* () {
        return (yield* (yield* Connectors).github).source;
      }),
    ),
    connectorStatus: await inSide(
      Effect.gen(function* () {
        return yield* (yield* Connectors).status({
          name: "docs",
          url: "https://mcp.example.test/mcp",
          auth: "oauth",
        });
      }),
    ),
    connector: await inSide(
      Effect.gen(function* () {
        const auth = yield* (yield* McpHubAuth).transportAuth({
          key: "docs",
          server: { type: "http", url: "https://mcp.example.test/mcp" } as never,
          auth: { auth: "oauth", url: "https://mcp.example.test/mcp" },
        });
        // Through Cloud's connector proxy (an address of Cloud's, the runtime's own token), or a token leased to the runtime.
        return auth.url !== undefined
          ? `proxied ${auth.url.replace(cloud.url, "")}`
          : auth.authProvider === undefined
            ? "none"
            : "leased";
      }),
    ),
    // GitHub as the runtime itself reads it (github.status): the login's name.
    githubName: !outside
      ? undefined
      : await inSide(
          Effect.gen(function* () {
            const connectors = yield* Connectors;
            const handlers = makeGitHubHandlers({
              login: connectors.github,
              connect: Effect.succeed(undefined),
              api: undefined,
              project: () => Effect.succeed(undefined),
            });
            return yield* handlers["github.status"]({}, { connectionId: "c1", principal: "local" });
          }),
        ),
    // What a person manages from Settings, asked of the computer instead: its secrets, an engine's key, its connectors.
    secretList: await inSide(
      Effect.gen(function* () {
        return (yield* (yield* ProjectSecrets).list("github.com/acme/widgets")).map(
          (entry) => entry.name,
        );
      }),
    ),
    secretRemove: await inSide(
      Effect.gen(function* () {
        return yield* (yield* ProjectSecrets).remove("github.com/acme/widgets", "NEW_NAME");
      }),
    ),
    engineKeySet: await inSide(
      Effect.gen(function* () {
        return yield* inWords((yield* EngineCloudKeys).set("codex", "sk-only-a-test-value"));
      }),
    ),
    connectorConnect: await inSide(
      Effect.gen(function* () {
        return yield* (yield* Connectors).connect({
          name: "docs",
          url: "https://mcp.example.test/mcp",
          auth: "oauth",
        });
      }),
    ),
    connectGitHub: await inSide(
      Effect.gen(function* () {
        return yield* inWords((yield* Connectors).connectGitHub);
      }),
    ),
    connectorDisconnect: await inSide(
      Effect.gen(function* () {
        return yield* inWords((yield* Connectors).disconnect("https://mcp.example.test/mcp"));
      }),
    ),
  };

  // A real Claude Agent turn: the stand-in claude calls its model through the base URL it was launched with.
  const workspace = await createReady(client, {
    request_id: "w1",
    repo: { url: "https://github.com/acme/widgets" },
    title: "Proof",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => events.push(event));
  await client.call("turn.submit", {
    request_id: "t1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: "model: say where you ran" },
  });
  await until(() => events.some((event) => event.type === "turn.done"), 60_000);
  const said = JSON.stringify(
    events.filter((event) => event.type === "message.done" && event.payload.role === "assistant"),
  );

  // That chat's tool calls on an MCP connector, as its engine's requests reach the runtime's hub (what /mcp/hub/<key>
  // serves; this harness's route does not mount the hub, so the calls enter where that route hands them over). One
  // answers; one has the connector's server repeat the sign-in it was sent, which must come back as asterisks.
  const hubCall = (id: number, name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const connectorCalls = !outside
    ? undefined
    : await inSide(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer(
            {
              name: "docs",
              url: "https://mcp.example.test/mcp",
              auth: "oauth",
              source: "manual",
              enabled: true,
            },
            false,
          );
          const caller = { threadId: ThreadId.make(workspace.session_id), hooks: false };
          return {
            answered: yield* hub.handle(caller, "docs", hubCall(1, "lookup", { q: "widgets" })),
            echoed: yield* hub.handle(caller, "docs", hubCall(2, "echo_headers", {})),
          };
        }),
      );

 // A Codex request, as codex makes it on a compact sign-in: its stand-in from the home it was launched with, through
  // the scrub's route for Codex's chats. Held after its first event until this side has read it: nothing buffers.
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome);
  const launch = outside
    ? await connectionsOf(link)!.launch("codex", { CODEX_HOME: codexHome })
    : await followedLogins.launchEnv("codex", { CODEX_HOME: codexHome });
  expect(launch).toHaveProperty("env");
  const standIn = parseCodexAuth(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"))!
    .credential.access_token;
  expect(standIn).toContain("caveman-stand-in");
  const route = Context.get(
    runtime.context as unknown as Context.Context<EgressRoute>,
    EgressRoute,
  ).route(CODEX_VIA_PROXY)!;
  await cloud.configure({ holdStream: true });
  const codex = await fetch(`${route}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${standIn}`,
      "chatgpt-account-id": "acct-in-auth-json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-test", stream: true, input: "say where you ran" }),
  });
  const reader = codex.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const heldAfterFirst = !first.includes("response.completed");
  await cloud.release();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }

  // What this computer tells Cloud it can run (the heartbeat's engines_signed_in): Cloud moves a chat here only then.
  const canRun = {
    claude: await hasFollowedLogin("claude-agent"),
    codex: await hasFollowedLogin("codex"),
  };
  if (outside)
    await until(() => inner.state.heartbeats.at(-1)?.engines_signed_in?.length === 2, 15_000);
  const heartbeat = inner.state.heartbeats.at(-1)?.engines_signed_in;
  // Whether a client may offer a sign-in or a key field on this computer, engine by engine (engine.list).
  const signInOffered = (await client.call("engine.list", {})).engines.map(
    (engine) => engine.auth.no_sign_in_here !== true,
  );

  // Everything is in memory that will be. Now look everywhere an agent with root could.
  const report = await cloud.report();
  const snapshot = path.join(root, "runtime.heapsnapshot");
  v8.writeHeapSnapshot(snapshot);
  const searched = [
    ...filesUnder(config.stateDir),
    ...filesUnder(config.baseDir),
    ...filesUnder(linkDir),
    ...filesUnder(checkout),
    ...filesUnder(codexHome),
  ];
  const inFiles = [...new Set(searched)].flatMap((file) =>
    fileHoldsCanaries(file, report.canaries).map(
      (kind) => `${kind} in ${path.relative(os.tmpdir(), file)}`,
    ),
  );
  const inChildren = [
    ...fileHoldsCanaries(spawned, report.canaries),
    ...filesUnder(claudeEnv).flatMap((file) => fileHoldsCanaries(file, report.canaries)),
  ];
  const inHeap = fileHoldsCanaries(snapshot, report.canaries).sort();
  const heapBytes = fs.statSync(snapshot).size;
  fs.rmSync(snapshot);
  // Taking a key off the computer brings nothing in: it passes with the rule and without it.
  const voiceKeyRemoved = await tried(
    client.call("chief.voice.key", { request_id: "k7", engine: "deepgram", key: null }),
  );
  // And for what the client pasted: the same files, every child started since (the claude among them), every answer.
  const pastedIn = (bytes: Buffer | string) =>
    Object.entries(pasted).flatMap(([kind, value]) => (bytes.includes(value) ? [kind] : []));
  const pastedFound = {
    inFiles: [...new Set(searched)]
      .flatMap((file) =>
        pastedIn(fs.readFileSync(file)).map((kind) => `${kind} in ${path.basename(file)}`),
      )
      .sort(),
    inChildren: [spawned, ...filesUnder(claudeEnv)].flatMap((file) =>
      pastedIn(fs.readFileSync(file)),
    ),
    inAnswers: answers.flatMap((answer) => pastedIn(answer)),
  };
  return {
    report,
    said,
    codex: { status: codex.status, first, rest, heldAfterFirst },
    sideAnswers,
    connectorCalls,
    signInOffered,
    canRun,
    heartbeat,
    inFiles,
    inChildren,
    inHeap,
    heapBytes,
    searched: searched.length,
    children,
    claudeRuns: filesUnder(claudeEnv).length,
    rule: ruleOf(link).known(),
    pasted: {
      writes,
      kept,
      voiceAsked: voiceAskedForKey,
      voiceKeyRemoved,
      answers: answers.length,
      ...pastedFound,
    },
  };
}

test.skipIf(process.platform === "win32")(
  "under the rule an agent with root finds no credential: not in a file, a child's environment, an answer from Cloud, or the runtime's heap",
  async () => {
    const found = await story(true);
    expect(found.rule).toBe(true);

    // The turn ran, through the scrub and the data plane, and the provider got the credential the data plane attached.
    expect(found.said).toContain("smoke ok: model said: answer from the provider");
    const claude = found.report.upstream.find((seen) => seen.lane === "claude");
    expect(claude).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      credentials: ["claudePlan"],
      standIn: false,
      runtimeToken: false,
    });
    expect(found.report.plane.find((p) => p.lane === "claude")).toMatchObject({
      path: "/v1/messages",
      named: "conn-claude-plan",
      served: "conn-claude-plan",
      status: 200,
    });
    // Codex's too, and its answer streamed: the first event arrived while the provider still held the rest.
    expect(found.codex.status).toBe(200);
    expect(found.codex.heldAfterFirst).toBe(true);
    expect(found.codex.first + found.codex.rest).toContain("response.completed");
    expect(found.report.upstream.find((seen) => seen.lane === "codex")).toMatchObject({
      path: "/responses",
      credentials: ["chatgptAccess"],
      standIn: false,
      runtimeToken: false,
    });
    expect(found.report.plane.find((p) => p.lane === "codex")).toMatchObject({
      named: "conn-chatgpt-plan",
      served: "conn-chatgpt-plan",
      status: 200,
    });

    // What used to fetch a credential asks for none.
    expect(found.sideAnswers.engineKey).toMatchObject({ _tag: "Success", success: undefined });
    expect(found.sideAnswers.secrets).toMatchObject({
      _tag: "Success",
      success: ["TEST_DATABASE_URL"],
    });
    expect(JSON.stringify(found.sideAnswers.secretSet)).toContain(OUTSIDE_SECRETS);
    // A connector runs through Cloud's connector proxy: its state from Cloud's list, the hub's way to it an address of
    // Cloud's named by the id Cloud listed, and the tool call answered by the connector's own server.
    expect(found.sideAnswers.connectorStatus).toMatchObject({
      _tag: "Success",
      success: { status: "connected", heldBy: "cloud" },
    });
    expect(found.sideAnswers.connector).toMatchObject({
      _tag: "Success",
      success: "proxied /relay/v1/mcp/conn-mcp",
    });
    expect(JSON.stringify(found.connectorCalls)).toContain(
      'answer from the connector: lookup({\\\"q\\\":\\\"widgets\\\"})',
    );
    // The server repeated the sign-in it was sent: what came back is asterisks.
    expect(JSON.stringify(found.connectorCalls)).toMatch(
      /the upstream was sent authorization: Bearer \*{20,}/,
    );
    const connector = found.report.connectors.filter((seen) => seen.upstream === "mcp");
    expect(connector.length).toBeGreaterThanOrEqual(3);
    for (const seen of connector)
      expect(seen).toMatchObject({
        credentials: ["connectorToken"],
        runtimeToken: false,
        callerCredential: false,
        status: expect.any(Number),
      });
    expect(
      found.report.proxy.filter((p) => p.connection === "conn-mcp").every((p) => p.status < 300),
    ).toBe(true);
    // GitHub's API too: the login's name was read through the proxy, on GitHub's sign-in, with no token here.
    expect(found.sideAnswers.github).toMatchObject({ _tag: "Success", success: "cloud" });
    expect(found.sideAnswers.githubName).toMatchObject({
      _tag: "Success",
      success: { login: "octo-person", source: "cloud" },
    });
    expect(found.report.connectors.find((seen) => seen.upstream === "github-api")).toMatchObject({
      method: "GET",
      path: "/user",
      credentials: ["githubToken"],
      runtimeToken: false,
    });
    // Cloud hears which engines can run here from what is connected, with no sign-in held or listed.
    expect(found.canRun).toEqual({ claude: true, codex: true });
    expect(found.heartbeat).toEqual(["claude", "codex"]);
    // No engine's sign-in is offered on the computer.
    expect(found.signInOffered.length).toBeGreaterThan(0);
    expect(found.signInOffered).toEqual(found.signInOffered.map(() => false));
    // What is managed from a person's own device says so, each in its own words.
    expect(found.sideAnswers.secretList).toMatchObject({
      _tag: "Success",
      success: ["TEST_DATABASE_URL"],
    });
    expect(JSON.stringify(found.sideAnswers.secretRemove)).toContain(OUTSIDE_SECRETS);
    expect(JSON.stringify(found.sideAnswers.engineKeySet)).toContain(OUTSIDE_CONNECT);
    expect(found.sideAnswers.connectorConnect).toMatchObject({
      _tag: "Success",
      success: { status: "error", problem: OUTSIDE_CONNECT_TEXT },
    });
    expect(JSON.stringify(found.sideAnswers.connectGitHub)).toContain(OUTSIDE_GITHUB_TEXT);
    expect(JSON.stringify(found.sideAnswers.connectorDisconnect)).toContain(OUTSIDE_REMOVE_TEXT);
    // Not by being refused: the runtime made not one call to a route the rule closes (a sign-in's read or refresh, a
    // lease, a secret's list or change, an engine's key switch, a connector's removal, a settings write), ...
    expect(found.report.closed).toEqual([]);
    expect(found.report.refused).toEqual([]);
    // ... and of a connector or a sign-in it asked Cloud only the list of connections (names and states, no token):
    // never a lease, a start, a removal or a sign-in's lanes.
    expect([
      ...new Set(
        found.report.asked.filter((route) => /runtime\/(connections|engine-logins)/.test(route)),
      ),
    ]).toEqual(["GET runtime/connections"]);
    // What it asked instead: whether the rule applies, what is connected, and its workspace's own secrets.
    expect(found.report.asked).toEqual(
      expect.arrayContaining([
        "GET runtime",
        "GET runtime/model-connections",
        "GET runtime/connections",
        "POST runtime/secrets/resolve",
      ]),
    );

    // The search covered something: files, children (the claude among them) and a whole heap.
    expect(found.searched).toBeGreaterThan(10);
    expect(found.claudeRuns).toBeGreaterThan(0);
    expect(found.children).toBeGreaterThan(0);
    expect(found.report.answers).toBeGreaterThan(5);
    expect(found.heapBytes).toBeGreaterThan(10 * 1024 * 1024);
    // And found no canary anywhere.
    expect(found.report.answersWithCanary).toEqual([]);
    expect(found.inFiles).toEqual([]);
    expect(found.inChildren).toEqual([]);
    expect(found.inHeap).toEqual([]);

    // What a client pasted was refused, each with where it is done instead, ...
    expect(found.pasted.writes.webKey).toEqual({
      ok: false,
      reason: "unsupported",
      message: OUTSIDE_WEB_KEY,
    });
    expect(found.pasted.writes.voiceKey).toEqual({
      ok: false,
      reason: "unsupported",
      message: OUTSIDE_VOICE_KEY,
    });
    expect(found.pasted.writes.secretManager).toEqual({
      ok: false,
      reason: "unsupported",
      message: OUTSIDE_SECRET_MANAGER,
    });
    expect(found.pasted.writes.serverKey).toEqual({
      ok: false,
      reason: "unsupported",
      message: OUTSIDE_SERVER_KEY,
    });
    expect(found.pasted.writes.serverLine).toEqual({
      ok: false,
      reason: "unsupported",
      message: outsideLine("server"),
    });
    // ... a server, which holds only the names of its keys, is still added, ...
    expect(found.pasted.writes.server).toMatchObject({
      ok: true,
      result: { name: "datadog", credentials: [{ name: "DD_API_KEY", granted: false }] },
    });
    // ... no provider was asked about a key, and the computer says it keeps none.
    expect(found.pasted.voiceAsked).toBe(0);
    expect(found.pasted.kept).toEqual({
      webKey: false,
      secretManager: false,
      serverKey: false,
      serverLine: false,
    });
    expect(found.pasted.voiceKeyRemoved).toMatchObject({ ok: true, result: { state: "no_key" } });
    // Nor does it: not in a file under its state, a child's environment or an answer.
    expect(found.pasted.answers).toBe(10);
    expect(found.pasted.inFiles).toEqual([]);
    expect(found.pasted.inChildren).toEqual([]);
    expect(found.pasted.inAnswers).toEqual([]);
  },
  240_000,
);

test.skipIf(process.platform === "win32")(
  "without the rule the same search finds the credentials Cloud handed over, in the runtime's heap",
  async () => {
    const found = await story(false);
    expect(found.rule).toBe(false);
    // Everything works as before: the turn and the request ran on the tokens the runtime held and swapped in itself.
    expect(found.said).toContain("smoke ok: model said: answer from the provider");
    expect(found.codex.status).toBe(200);
    expect(found.report.plane).toEqual([]);
    expect(found.report.upstream.find((seen) => seen.lane === "claude")).toMatchObject({
      credentials: ["claudePlan"],
      standIn: false,
    });
    expect(found.report.upstream.find((seen) => seen.lane === "codex")).toMatchObject({
      credentials: ["chatgptAccess"],
      standIn: false,
    });
    expect(found.sideAnswers.github).toMatchObject({ _tag: "Success", success: "cloud" });
    expect(found.sideAnswers.connector).toMatchObject({ _tag: "Success", success: "leased" });
    expect(found.signInOffered).toEqual(found.signInOffered.map(() => true));
    // The same story asks the routes the rule closes, each one: the count above is of calls that are made without it.
    expect(
      new Set(
        found.report.closed.map((route) => route.replace(/(runtime\/secrets)\/.+$/, "$1/{name}")),
      ),
    ).toEqual(
      new Set([
        "GET runtime/engine-logins/claude",
        "GET runtime/engine-logins/codex",
        "POST runtime/connections/lease",
        "GET runtime/secrets",
        "PUT runtime/secrets",
        "DELETE runtime/secrets/{name}",
        "DELETE runtime/connections/conn-mcp",
      ]),
    );
    expect(found.report.refused).toEqual([]);
    // Cloud's answers carried them, and so the heap holds them: sign-in tokens, a vault key, a connector's and GitHub's.
    expect(new Set(found.report.answersWithCanary.map((answer) => answer.kind))).toEqual(
      new Set([
        "claudePlan",
        "chatgptAccess",
        "anthropicKey",
        "gatewayKey",
        "connectorToken",
        "githubToken",
      ]),
    );
    expect(found.inHeap).toEqual([
      "anthropicKey",
      "chatgptAccess",
      "claudePlan",
      "connectorToken",
      "gatewayKey",
      "githubToken",
    ]);
    // Even then no child's environment and no file held one: the stand-ins did that much already.
    expect(found.inChildren).toEqual([]);
    expect(found.inFiles).toEqual([]);

    // What a client pasted is kept, as it always was: each write answers, the voice engine was asked about its key, ...
    expect(found.pasted.writes.webKey).toMatchObject({
      ok: true,
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "brave", configured: true }),
        ]),
      },
    });
    expect(found.pasted.writes.voiceKey).toMatchObject({
      ok: true,
      result: { state: "ready", paid_by: "key" },
    });
    expect(found.pasted.writes.secretManager).toMatchObject({
      ok: true,
      result: { providers: [{ id: "1password", service_account: true, has_token: true }] },
    });
    expect(found.pasted.writes.serverKey).toEqual({ ok: true, result: {} });
    expect(found.pasted.writes.serverLine).toMatchObject({
      ok: true,
      result: { name: "keyflag", command: "tool-mcp" },
    });
    expect(found.pasted.voiceAsked).toBeGreaterThan(0);
    expect(found.pasted.kept).toEqual({
      webKey: true,
      secretManager: true,
      serverKey: true,
      serverLine: true,
    });
    expect(found.pasted.voiceKeyRemoved).toMatchObject({ ok: true, result: { state: "no_key" } });
    // ... and the same search finds two of them in files: the plugin's key as the secret store holds it, and the key in
    // a command line wherever that line is kept. (The secret manager's token is sealed there; the web and voice keys
    // are in this test's key host, which keeps them in memory.)
    expect(found.pasted.inFiles).toContainEqual(
      expect.stringMatching(/^serverKey in plugin-credential-[0-9a-f]{32}\.bin$/),
    );
    expect(found.pasted.inFiles).toContain("serverLine in settings.json");
    expect([...new Set(found.pasted.inFiles.map((hit) => hit.split(" in ")[0]))]).toEqual([
      "serverKey",
      "serverLine",
    ]);
    // A pasted key is in no answer; a command line is shown as it was pasted, to add the server and to list it.
    expect(found.pasted.inAnswers).toEqual(["serverLine", "serverLine"]);
  },
  240_000,
);
