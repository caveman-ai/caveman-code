import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { OpenCodeSettings } from "../settings.ts";
import { makeOpenCodeAdapterV2 } from "./adapter.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const instanceId = ProviderInstanceId.make("opencode-event-stream");
const threadId = ThreadId.make("thread-opencode-event-stream");
const modelSelection = { instanceId, model: "anthropic/claude-sonnet", options: [] };
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const layer = Layer.mergeAll(
  OpenCodeRuntime.layer.pipe(
    Layer.provide(OpenCodeServerLedger.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
  IdAllocator.layer,
  McpProviderSessions.layer,
);

/**
 * An external OpenCode 1.x server. Its event stream either says it connected and
 * then stays quiet, or is refused as it is after the server's password changed.
 */
const fakeServer = (eventStream: "quiet" | "refused") =>
  Effect.gen(function* () {
    const eventRequested = yield* Deferred.make<void>();
    const eventStreamClosed = yield* Deferred.make<void>();
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      if (path === "/global/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
        return;
      }
      if (path === "/event") {
        Deferred.doneUnsafe(eventRequested, Exit.void);
        if (eventStream === "refused") {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
        response.on("close", () => Deferred.doneUnsafe(eventStreamClosed, Exit.void));
        return;
      }
      response.statusCode = 404;
      response.end();
    };
    const server = createServer(handler);
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
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      eventRequested,
      eventStreamClosed,
    };
  });

const openSession = (
  serverUrl: string,
  nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger,
) =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make();
    const adapter = yield* makeOpenCodeAdapterV2({
      instanceId,
      settings: Schema.decodeUnknownSync(OpenCodeSettings)({ serverUrl }),
      environment: {},
      ...(nativeEventLogger === undefined ? {} : { nativeEventLogger }),
    }).pipe(
      Effect.provideService(ProviderHost.ProviderHost, {
        paths: { cwd: "/workspace" },
        resolveAttachmentPath: () => null,
      } as unknown as ProviderHost.ProviderHost["Service"]),
    );
    yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-opencode-event-stream"),
        modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.provideService(Scope.Scope, sessionScope));
    return {
      /** Whether closing the session finished within the time given. */
      closeWithin: (duration: Duration.Input) =>
        Scope.close(sessionScope, Exit.void).pipe(
          Effect.forkDetach,
          Effect.flatMap((close) => Fiber.await(close).pipe(Effect.timeoutOption(duration))),
          Effect.map(Option.isSome),
        ),
    };
  });

describe("OpenCode adapter event stream", () => {
  it.live("closes a session at once while its event stream waits for the next event", () =>
    Effect.gen(function* () {
      const server = yield* fakeServer("quiet");
      const connected = yield* Deferred.make<void>();
      const session = yield* openSession(server.url, {
        filePath: "/tmp/opencode-event-stream.ndjson",
        write: (record) =>
          JSON.stringify(record).includes("server.connected")
            ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
            : Effect.void,
        close: () => Effect.void,
      });
      // Past server.connected the stream waits on an event the server never sends.
      yield* Deferred.await(connected);

      const closed = yield* session.closeWithin("5 seconds");

      assert.isTrue(closed, "closing the session waited on the event stream");
      // The session also lets go of its connection to the server.
      yield* Deferred.await(server.eventStreamClosed);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("closes a session at once while it waits to reconnect a refused event stream", () =>
    Effect.gen(function* () {
      const server = yield* fakeServer("refused");
      const session = yield* openSession(server.url);
      yield* Deferred.await(server.eventRequested);

      // The first reconnect waits 3 seconds.
      const closed = yield* session.closeWithin("2 seconds");

      assert.isTrue(closed, "closing the session waited out a reconnect delay");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
