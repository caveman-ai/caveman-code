// ), apps/server/src/httpResponseErrorGuard.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

/**
 * Node surfaces late socket write failures (EPIPE, ECONNRESET,
 * ERR_STREAM_DESTROYED) as "error" events. An "error" event without a
 * listener escalates into an uncaught exception and terminates the whole
 * server process, taking every other client and all in-flight provider
 * work with it.
 *
 * Two emitters need coverage:
 *
 * - Upgrade sockets. Once a connection upgrades (the websocket RPC path,
 *   including its auth rejection responses), Node's http server detaches
 *   its own socket error handling, so the raw socket has no listener at
 *   all until the websocket server adopts it.
 * - Server responses. Response streams have no default error listener
 *   either.
 *
 * A disconnected client only affects its own request: the request fiber is
 * already interrupted through the response "close" event, so the write
 * failure needs no handling beyond being observed.
 */
export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  const onUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
    // Caveman: Node counts an upgrade as handled once any listener exists, and
    // the port opens before the routes add theirs. An upgrade in that gap would
    // wait forever (and a browser queues every later socket to the port behind
    // it), so refuse it and let the client retry.
    if (server.listeners("upgrade").every((listener) => listener === onUpgrade)) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  };
  server.on("upgrade", onUpgrade);
  return server;
}

/**
 * NodeHttpServer listens before serve() attaches its handlers, so requests in
 * between would hang. Install this after the write-error guards so only the
 * serving handlers trigger the handoff.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  const rejectRequest = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    response.writeHead(503, { "retry-after": "1", connection: "close" }).end();
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, making the handoff synchronous.
  server.on("newListener", function onNewListener(event) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
