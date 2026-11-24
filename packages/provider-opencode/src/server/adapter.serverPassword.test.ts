import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { OpenCodeSettings } from "../settings.ts";
import { makeOpenCodeAdapterV2 } from "./adapter.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const PASSWORD = "secret";

// An OpenCode 1.x server with a password answers every path without the right
// Basic auth with an empty 401 (probeResponses.fixture.ts). Its event stream
// ends after server.connected.
const HANDLER_SOURCE = `(password, log) => (request, response) => {
  const expected = "Basic " + Buffer.from("opencode:" + password, "utf8").toString("base64");
  const path = new URL(request.url, "http://x").pathname;
  const authenticated = request.headers.authorization === expected;
  log(request.method + " " + path + (authenticated ? "" : " unauthenticated"));
  if (!authenticated) { response.statusCode = 401; response.end(); return; }
  if (path === "/global/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
    return;
  }
  if (path === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"server.connected","properties":{}}\\n\\n');
    return;
  }
  if (path === "/session" && request.method === "POST") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "ses_password", time: { created: 1, updated: 1 } }));
    return;
  }
  response.statusCode = 404;
  response.end();
}`;

const makeHandler = new Function(`return ${HANDLER_SOURCE}`)() as (
  password: string,
  log: (line: string) => void,
) => (request: IncomingMessage, response: ServerResponse) => void;

const instanceId = ProviderInstanceId.make("opencode-server-password");
const threadId = ThreadId.make("thread-opencode-server-password");
const modelSelection = { instanceId, model: "anthropic/claude-sonnet", options: [] };
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

/**
 * Opens a session and creates its first thread. The session's scope is closed by
 * the caller once the outcome is checked.
 */
const openSessionAndCreateThread = (settings: OpenCodeSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make();
    const exit = yield* Effect.gen(function* () {
      const adapter = yield* makeOpenCodeAdapterV2({ instanceId, settings, environment }).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-opencode-server-password"),
        modelSelection,
        runtimePolicy,
      });
      return yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.timeout("10 seconds"),
      Effect.exit,
    );
    return {
      nativeSessionId: Exit.isSuccess(exit) ? exit.value.nativeThreadRef?.nativeId : "failed",
      close: Scope.close(sessionScope, Exit.void),
    };
  });

const unauthenticated = (requests: ReadonlyArray<string>) => [
  ...new Set(requests.filter((line) => line.endsWith("unauthenticated"))),
];

const layer = Layer.mergeAll(
  OpenCodeRuntime.layer.pipe(
    Layer.provide(OpenCodeServerLedger.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
  IdAllocator.layer,
  McpProviderSessions.layer,
);

describe("OpenCode adapter server password", () => {
  it.live(
    "opens a thread on an external server that requires the Settings password",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const server = createServer(makeHandler(PASSWORD, (line) => requests.push(line)));
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())),
          ),
          () =>
            Effect.sync(() => {
              server.closeAllConnections();
              server.close();
            }),
        );
        const settings = Schema.decodeUnknownSync(OpenCodeSettings)({
          serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          serverPassword: PASSWORD,
        });

        const opened = yield* openSessionAndCreateThread(settings, {});

        assert.deepStrictEqual(
          {
            nativeSessionId: opened.nativeSessionId,
            unauthenticated: unauthenticated(requests),
          },
          { nativeSessionId: "ses_password", unauthenticated: [] },
        );
        yield* opened.close;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    15_000,
  );

  it.live(
    "opens a thread on a spawned server that requires the inherited OPENCODE_SERVER_PASSWORD",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcess.Environment;
        const executablePath = yield* HostProcess.ExecutablePath;
        const isWindows = (yield* HostProcess.Platform) === "win32";
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "opencode-server-password-",
        });
        const scriptPath = path.join(tempDir, "opencode.mjs");
        const requestsPath = path.join(tempDir, "requests.log");
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        yield* fs.writeFileString(
          scriptPath,
          `import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(requestsPath)}, line + "\\n");
const server = createServer((${HANDLER_SOURCE})(process.env.OPENCODE_SERVER_PASSWORD, log));
// A failing run leaves its session open; never outlive the test.
setTimeout(() => process.exit(0), 30_000).unref();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`,
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%OPENCODE_TEST_NODE_BINARY%" "%OPENCODE_TEST_SCRIPT%" %*'
              : 'exec "$OPENCODE_TEST_NODE_BINARY" "$OPENCODE_TEST_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) yield* fs.chmod(binaryPath, 0o755);

        const opened = yield* openSessionAndCreateThread(
          Schema.decodeUnknownSync(OpenCodeSettings)({ binaryPath }),
          {
            ...environment,
            OPENCODE_TEST_NODE_BINARY: executablePath,
            OPENCODE_TEST_SCRIPT: scriptPath,
            OPENCODE_SERVER_PASSWORD: PASSWORD,
          },
        );
        const requests = (yield* fs.readFileString(requestsPath)).split("\n");

        assert.deepStrictEqual(
          {
            nativeSessionId: opened.nativeSessionId,
            unauthenticated: unauthenticated(requests),
          },
          { nativeSessionId: "ses_password", unauthenticated: [] },
        );
        yield* opened.close;
      }).pipe(Effect.scoped, Effect.provide(layer)),
    15_000,
  );
});
