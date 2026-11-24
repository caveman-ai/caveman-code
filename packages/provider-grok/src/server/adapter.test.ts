import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { GrokAdapterV2Driver } from "./adapter.ts";

const plainEnv = (
  env: Readonly<Record<string, string | Redacted.Redacted<string> | undefined>> | undefined,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
);

/**
 * Opens a Grok session on a runtime whose own env is `host` and returns the
 * environment each `grok agent stdio` launch got. The spawn fails, so no CLI runs.
 */
const agentEnvironments = (input: {
  readonly host: NodeJS.ProcessEnv;
  /** Variables set on the instance in Settings. */
  readonly instance?: Readonly<Record<string, string>>;
  /** The thread's workspace ports and computer.toml [env], as SessionPlugins hands them out. */
  readonly workspace?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const launches: Array<NodeJS.ProcessEnv> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") launches.push(plainEnv(command.options.env));
      return Effect.fail(
        PlatformError.systemError({ _tag: "NotFound", module: "grok-env-test", method: "spawn" }),
      );
    });
    const instanceId = ProviderInstanceId.make("grok-env-test");
    const threadId = ThreadId.make("grok-env-test");
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make("environment-grok-env-test"),
      threadId,
      providerSessionId: "mcp-session-grok-env-test",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer grok-session-token",
      browserToolsAvailable: false,
    });
    const adapter = yield* GrokAdapterV2Driver.create({
      instanceId,
      displayName: undefined,
      enabled: true,
      environment: Object.entries(input.instance ?? {}).map(([name, value]) => ({
        name,
        value,
        sensitive: false,
      })),
      config: GrokAdapterV2Driver.defaultConfig(),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-env-test"),
        modelSelection: { instanceId, model: "grok-build" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      })
      .pipe(Effect.scoped, Effect.ignore);
    return launches;
  }).pipe(
    Effect.provideService(SessionPlugins.SessionPlugins, {
      acp: () => Effect.succeed([]),
      claudeAgent: () => Effect.die("unused"),
      codex: () => Effect.die("unused"),
      env: () => Effect.succeed(input.workspace ?? {}),
    }),
    Effect.provideService(HostProcess.Environment, input.host),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(layerTest),
  );

it.effect("keeps the runtime's own variables off the Grok agent and the commands it runs", () =>
  Effect.gen(function* () {
    const runtimeOnly = {
      CAVEMAN_CODE_DEV_AUTH_TOKEN: "runtime-dev-token",
      CAVEMAN_CODE_OTLP_HEADERS: "authorization=Bearer runtime-otlp",
      CAVEMAN_RUNTIME_STATE_DIR: "/runtime/state",
      CAVEMAN_CLOUD_LINK_DIR: "/cloud/link",
      CAVEMAN_WORKSPACE_ROOT: "/cloud/workspace",
    };
    const launches = yield* agentEnvironments({
      host: { PATH: "/host/bin", XAI_API_KEY: "host-xai-key", ...runtimeOnly },
    });
    expect(launches).toHaveLength(1);
    const environment = launches[0]!;
    expect(
      Object.fromEntries(Object.keys(runtimeOnly).map((name) => [name, environment[name]])),
    ).toEqual(Object.fromEntries(Object.keys(runtimeOnly).map((name) => [name, undefined])));
    // The rest of the host's env passes through, as for a CLI run by hand.
    expect({ PATH: environment.PATH, XAI_API_KEY: environment.XAI_API_KEY }).toEqual({
      PATH: "/host/bin",
      XAI_API_KEY: "host-xai-key",
    });
  }),
);

it.effect("gives a Grok session's agent the workspace's ports and [env] under what it owns", () =>
  Effect.gen(function* () {
    const host = {
      PATH: "/host/bin",
      TERM: "host-term",
      DATABASE_URL: "postgres://host-db.test/host",
      XAI_API_KEY: "host-xai-key",
    };
    const instance = { HTTPS_PROXY: "http://settings-proxy.test:3128" };
    const workspace = {
      CAVEMAN_PORT_WEB: "42100",
      CAVEMAN_PORT: "42100",
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      // The repo tries to take back the instance's proxy, the agent's PATH and TERM, and Grok's
      // own login and home.
      HTTPS_PROXY: "http://repo-proxy.test:3128",
      PATH: "/repo/bin",
      TERM: "repo-term",
      XAI_API_KEY: "repo-xai-key",
      GROK_HOME: "/repo/grok-home",
    };
    const launches = yield* agentEnvironments({ host, instance, workspace });
    expect(launches).toHaveLength(1);
    const environment = launches[0]!;
    // Grok runs its own commands, so its environment is what `pnpm dev` sees. Like a registry
    // agent's commands, they also get the session's MCP credential, so the ACP terminal
    // fallback (acp-mcp-call) can reach the Caveman Code tools.
    expect({
      CAVEMAN_PORT_WEB: environment.CAVEMAN_PORT_WEB,
      CAVEMAN_PORT: environment.CAVEMAN_PORT,
      DATABASE_URL: environment.DATABASE_URL,
      HTTPS_PROXY: environment.HTTPS_PROXY,
      PATH: environment.PATH,
      TERM: environment.TERM,
      XAI_API_KEY: environment.XAI_API_KEY,
      GROK_HOME: environment.GROK_HOME,
      CAVEMAN_CODE_ACP_MCP_ENDPOINT: environment.CAVEMAN_CODE_ACP_MCP_ENDPOINT,
      CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: environment.CAVEMAN_CODE_ACP_MCP_AUTHORIZATION,
    }).toEqual({
      CAVEMAN_PORT_WEB: workspace.CAVEMAN_PORT_WEB,
      CAVEMAN_PORT: workspace.CAVEMAN_PORT,
      DATABASE_URL: workspace.DATABASE_URL,
      HTTPS_PROXY: instance.HTTPS_PROXY,
      PATH: host.PATH,
      TERM: host.TERM,
      XAI_API_KEY: host.XAI_API_KEY,
      GROK_HOME: undefined,
      CAVEMAN_CODE_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp",
      CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: "Bearer grok-session-token",
    });
  }),
);
