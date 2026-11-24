// One Session Protocol client for main's own calls to its runtime (settings, the keep-awake checks, the Chief's
// capture window, turn stats), kept open instead of a new socket per call. It follows the supervisor's endpoint: when
// that changes (a restart, the state-dir owner's runtime, back to this app's own), the old client closes and one opens
// on the new endpoint, with every handler carried over. Electron-free, so it is tested in node.
import type {
  Client,
  MethodName,
  NotificationName,
  NotificationParams,
  Params,
  Result,
} from "@caveman-app/session-protocol";

export interface Endpoint {
  readonly url: string;
  readonly token: string;
}

export interface RuntimeClient {
  /**
   * `method` on the runtime, failing after `timeoutMs` whether or not the call went out (a runtime still starting, or
   * gone, never holds the caller). A mutating call that has not gone out by then is withdrawn, so it never runs late.
   */
  call<M extends MethodName>(method: M, params: Params<M>, timeoutMs: number): Promise<Result<M>>;
  /** A runtime notification, on whichever endpoint is current. It opens the client. Returns the unsubscribe. */
  on<N extends NotificationName>(
    name: N,
    handler: (params: NotificationParams<N>) => void,
  ): () => void;
  /** Each connection the runtime answers, the first and every reconnect: notifications sent in between were missed. */
  onConnected(handler: () => void): () => void;
  /** The supervisor's endpoint may have changed: move to it now, so notifications keep coming without a call. */
  follow(): void;
  close(): void;
}

/** A handler kept across clients: `attach` subscribes it on one and returns the unsubscribe. */
type Kept = { readonly attach: (client: Client) => () => void; off?: () => void };

export function runtimeClient(
  endpoint: () => Endpoint,
  connect: (url: string, token: string) => Client,
): RuntimeClient {
  let current: { key: string; client: Client } | undefined;
  const kept = new Set<Kept>();
  let closed = false;

  const client = (): Client => {
    if (closed) throw new Error("runtime client closed");
    const { url, token } = endpoint();
    const key = `${url}\n${token}`;
    if (current?.key !== key) {
      for (const handler of kept) handler.off?.();
      current?.client.close();
      const next = connect(url, token);
      current = { key, client: next };
      for (const handler of kept) handler.off = handler.attach(next);
    }
    return current.client;
  };

  const keep = (attach: (client: Client) => () => void): (() => void) => {
    const handler: Kept = { attach };
    const open = current;
    kept.add(handler);
    // A client opened here attaches every kept handler, this one included; an open one takes just this one.
    if (open) handler.off = attach(open.client);
    else if (!closed) client();
    return () => {
      kept.delete(handler);
      handler.off?.();
    };
  };

  return {
    async call(method, params, timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          client().call(method, params, { timeoutMs, unsentAfterMs: timeoutMs }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Caveman Code's runtime did not answer ${method}`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    on: (name, handler) => keep((c) => c.on(name as never, handler as (params: never) => void)),
    onConnected: (handler) => keep((c) => c.onHello(() => handler())),
    follow() {
      if (!closed && current) client();
    },
    close() {
      closed = true;
      current?.client.close();
      current = undefined;
    },
  };
}
