// ), packages/effect-codex-app-server/src/client.ts @ ab3a3cd1.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CodexRpc from "./_generated/meta.gen.ts";
import * as CodexSchema from "./_generated/schema.gen.ts";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export interface CodexAppServerClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: CodexProtocol.CodexAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

interface CodexAppServerClientRaw {
  readonly notifications: CodexProtocol.CodexAppServerPatchedProtocol["incomingNotifications"];
  readonly requests: CodexProtocol.CodexAppServerPatchedProtocol["incomingRequests"];
  readonly request: CodexProtocol.CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexProtocol.CodexAppServerPatchedProtocol["notify"];
  readonly respond: CodexProtocol.CodexAppServerPatchedProtocol["respond"];
  readonly respondError: CodexProtocol.CodexAppServerPatchedProtocol["respondError"];
}

export class CodexAppServerClient extends Context.Service<
  CodexAppServerClient,
  {
    readonly raw: CodexAppServerClientRaw;
    readonly awaitTermination: Effect.Effect<never, CodexError.CodexAppServerError>;
    readonly request: <M extends CodexRpc.ClientRequestMethod>(
      method: M,
      payload: CodexRpc.ClientRequestParamsByMethod[M],
    ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError>;
    readonly notify: <M extends CodexRpc.ClientNotificationMethod>(
      method: M,
      payload: CodexRpc.ClientNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexError.CodexAppServerError>;
    readonly handleServerRequest: <M extends CodexRpc.ServerRequestMethod>(
      method: M,
      handler: (
        payload: CodexRpc.ServerRequestParamsByMethod[M],
      ) => Effect.Effect<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexError.CodexAppServerError
      >,
    ) => Effect.Effect<void>;
    readonly handleServerNotification: <M extends CodexRpc.ServerNotificationMethod>(
      method: M,
      handler: (
        payload: CodexRpc.ServerNotificationParamsByMethod[M],
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerRequest: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
  }
>()("@caveman-app/codex-app-server/client/CodexAppServerClient") {}

type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexError.CodexAppServerError>;

const V2TurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
  }),
);

export const make = Effect.fn("@caveman-app/codex-app-server/CodexAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
  terminationError?: Effect.Effect<CodexError.CodexAppServerError>,
): Effect.fn.Return<CodexAppServerClient["Service"], never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const termination = yield* Deferred.make<never, CodexError.CodexAppServerError>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, CodexError.CodexAppServerError>)
    | undefined;
  let unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>)
    | undefined;

  const getServerRequestParamSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ServerRequestParamsByMethod[M], CodexRpc.ServerRequestParamsByMethod[M]>
    | undefined => CodexRpc.SERVER_REQUEST_PARAMS[method] as never;

  const getServerRequestResponseSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexRpc.ServerRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.SERVER_REQUEST_RESPONSES[method] as never;

  const getClientRequestParamSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ClientRequestParamsByMethod[M], CodexRpc.ClientRequestParamsByMethod[M]>
    | undefined =>
    method === "turn/start"
      ? (V2TurnStartParamsWithCollaborationMode as never)
      : (CodexRpc.CLIENT_REQUEST_PARAMS[method] as never);

  const getClientRequestResponseSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientRequestResponsesByMethod[M],
        CodexRpc.ClientRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_REQUEST_RESPONSES[method] as never;

  const getClientNotificationParamSchema = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientNotificationParamsByMethod[M],
        CodexRpc.ClientNotificationParamsByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_NOTIFICATION_PARAMS[method] as never;

  // A notification has no reply to fail, so one the schema rejects is logged
  // and dropped. Codex repeats a shape it changed on every update, so each
  // distinct failure is warned about once per connection.
  const warnedDecodeFailures = new Set<string>();
  const dropUndecodableNotification = (error: CodexError.CodexAppServerProtocolParseError) => {
    const diagnostics = {
      operation: error.operation,
      ...(error.method === undefined ? {} : { method: error.method }),
      ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
      ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
      ...(error.maximumPathDepth === undefined ? {} : { maximumPathDepth: error.maximumPathDepth }),
    };
    const key = JSON.stringify(diagnostics);
    if (warnedDecodeFailures.has(key)) return Effect.void;
    warnedDecodeFailures.add(key);
    return Effect.logWarning("Dropped a Codex notification that failed to decode").pipe(
      Effect.annotateLogs(diagnostics),
    );
  };

  const logHandlerFailure =
    (method: string) =>
    (cause: Cause.Cause<CodexError.CodexAppServerError>): Effect.Effect<void> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("A Codex notification handler failed").pipe(
            Effect.annotateLogs({ method, error: Cause.pretty(cause) }),
          );

  const dispatchNotification = (
    notification: CodexProtocol.CodexAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    const schema =
      notification.method in CodexRpc.SERVER_NOTIFICATION_PARAMS
        ? CodexRpc.SERVER_NOTIFICATION_PARAMS[
            notification.method as CodexRpc.ServerNotificationMethod
          ]
        : undefined;
    const handlers = notificationHandlers.get(notification.method) ?? [];
    const handlerFailed = logHandlerFailure(notification.method);

    if (schema) {
      return decodeNotificationPayload(notification.method, schema, notification.params).pipe(
        Effect.matchEffect({
          onFailure: dropUndecodableNotification,
          onSuccess: (decoded) =>
            Effect.forEach(
              handlers,
              // A callback defect must not kill the shared input reader and strand every pending RPC.
              (handler) => Effect.suspend(() => handler(decoded)).pipe(Effect.catchCause(handlerFailed)),
              { discard: true },
            ),
        }),
      );
    }

    return unknownNotificationHandler
      ? Effect.suspend(() => unknownNotificationHandler!(notification.method, notification.params)).pipe(
          Effect.catchCause(handlerFailed),
        )
      : Effect.void;
  };

  const dispatchRequest = (
    request: CodexProtocol.CodexAppServerIncomingRequest,
  ): Effect.Effect<unknown, CodexError.CodexAppServerError> => {
    if (request.method in CodexRpc.SERVER_REQUEST_PARAMS) {
      const method = request.method as CodexRpc.ServerRequestMethod;
      const payloadSchema = getServerRequestParamSchema(method);
      const responseSchema = getServerRequestResponseSchema(method);
      const handler = requestHandlers.get(method);

      return decodeOptionalPayload(method, payloadSchema, request.params).pipe(
        Effect.flatMap((decoded) => runHandler(handler, decoded, method)),
        Effect.flatMap((result) => encodeOptionalPayload(method, responseSchema, result)),
      );
    }

    return unknownRequestHandler
      ? unknownRequestHandler(request.method, request.params)
      : Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound(request.method));
  };

  const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
    stdio,
    ...(terminationError ? { terminationError } : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
    onTermination: (error) => Deferred.fail(termination, error).pipe(Effect.asVoid),
  });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError> =>
    encodeOptionalPayload(method, getClientRequestParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.request(method, encoded)),
      Effect.flatMap(
        (
          raw,
        ): Effect.Effect<
          CodexRpc.ClientRequestResponsesByMethod[M],
          CodexError.CodexAppServerError
        > => decodeOptionalPayload(method, getClientRequestResponseSchema(method), raw),
      ),
    );

  const notify = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) =>
    encodeOptionalPayload(method, getClientNotificationParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.notify(method, encoded)),
    );

  return CodexAppServerClient.of({
    awaitTermination: Deferred.await(termination),
    raw: {
      notifications: transport.incomingNotifications,
      requests: transport.incomingRequests,
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    request,
    notify,
    handleServerRequest: (method, handler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler as ServerRequestHandler);
      }),
    handleServerNotification: (method, handler) =>
      Effect.sync(() => {
        const current = notificationHandlers.get(method) ?? [];
        current.push(handler as ServerNotificationHandler);
        notificationHandlers.set(method, current);
      }),
    handleUnknownServerRequest: (handler) =>
      Effect.sync(() => {
        unknownRequestHandler = handler;
      }),
    handleUnknownServerNotification: (handler) =>
      Effect.sync(() => {
        unknownNotificationHandler = handler;
      }),
  });
});

const STDERR_TAIL_CHARS = 2_000;

/**
 * The tail reaches logs, traces and the provider status line: no terminal
 * escapes (RUST_LOG colours), no key-shaped text, and a cut tail starts at a
 * line so the cut leaves no half key behind.
 */
const cleanStderrTail = (tail: string, cut: boolean): string => {
  const fromLine = tail.slice(tail.indexOf("\n") + 1);
  return (cut && fromLine.trim() ? fromLine : tail)
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[api key]");
};

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> =>
  Layer.effect(CodexAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "@caveman-app/codex-app-server/CodexAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: CodexAppServerClientOptions) {
  // Kept, not dropped: a process that exits at once says why only here.
  let stderrTail = "";
  let stderrCut = false;
  const decoder = new TextDecoder();
  const stderrDrained = yield* Stream.runForEach(handle.stderr, (chunk) =>
    Effect.sync(() => {
      const next = stderrTail + decoder.decode(chunk, { stream: true });
      stderrCut ||= next.length > STDERR_TAIL_CHARS;
      stderrTail = next.slice(-STDERR_TAIL_CHARS);
    }),
  ).pipe(Effect.ignore, Effect.forkScoped);
  // The exit can land before the last stderr bytes do; a grandchild holding
  // the pipe open must not hold the error back.
  const terminationError = Fiber.join(stderrDrained).pipe(
    Effect.timeoutOption("1 second"),
    Effect.andThen(makeTerminationError(handle, () => cleanStderrTail(stderrTail, stderrCut))),
  );
  return yield* make(makeChildStdio(handle), options, terminationError);
});
