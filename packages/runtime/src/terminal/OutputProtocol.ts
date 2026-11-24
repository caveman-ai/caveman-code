// ), apps/server/src/terminal/OutputProtocol.ts @ ab3a3cd1; terminalOutputStream from
// 3284143b45 (#18429).
import {
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  WS_METHODS,
} from "@caveman-app/protocol";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/rpc";

const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
const isFull = (sizes: number[]) =>
  sizes.length >= MAX_PENDING_CHUNKS ||
  sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_BYTES;

export function withTerminalOutputWindow(
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  const windows = new Map<string, number[]>();
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (
            message._tag === "Request" &&
            (message.tag === WS_METHODS.terminalAttach ||
              message.tag === WS_METHODS.terminalObserve ||
              message.tag === WS_METHODS.subscribeTerminalEvents)
          ) {
            const key = `${clientId}:${message.id}`;
            if (!windows.has(key)) windows.set(key, []);
          } else if (message._tag === "Ack") {
            const window = windows.get(`${clientId}:${message.requestId}`);
            if (window) {
              const wasFull = isFull(window);
              window.shift();
              if (!wasFull || isFull(window)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          windows.delete(`${clientId}:${response.requestId}`);
        } else if (response._tag === "Chunk") {
          const window = windows.get(`${clientId}:${response.requestId}`);
          if (window) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            const size = Buffer.byteLength(JSON.stringify(response));
            window.push(size);
            if (!isFull(window)) {
              return send.pipe(
                Effect.andThen(() =>
                  receive(clientId, {
                    _tag: "Ack",
                    requestId: response.requestId,
                  }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}

const MAX_QUEUED_OUTPUT = 8 * 1024 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD = 128;

type Listener<A> = (event: A) => Effect.Effect<void>;
type Subscribe<A, E> = (listener: Listener<A>) => Effect.Effect<() => void, E>;

const queuedSize = (event: TerminalEvent | TerminalAttachStreamEvent) =>
  EVENT_OVERHEAD +
  (event.type === "output"
    ? Buffer.byteLength(event.data)
    : "snapshot" in event
      ? Buffer.byteLength(event.snapshot.history)
      : 0);

/**
 * A terminal RPC stream's events, queued for its client up to a byte budget. A client that stops reading past it
 * loses the backlog: the stream starts over from a fresh snapshot (`resync`), or ends when there is none.
 *
 * The first subscription is held until the stream ends, because an attach is the client's viewer of the PTY and
 * sizes it; once a resync replaces it, its events are ignored. A later resync subscription is released when an
 * overflow replaces it.
 */
export function terminalOutputStream<A extends TerminalEvent | TerminalAttachStreamEvent, E>(
  subscribe: Subscribe<A, E>,
  resync?: Subscribe<A, E>,
  maxQueued = MAX_QUEUED_OUTPUT,
): Stream.Stream<A, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Latch.make();
      let pending: Array<A | undefined> = [];
      let sizes: number[] = [];
      let head = 0;
      let queued = 0;
      let overflowed = false;
      let subscription = 0;
      let first: (() => void) | undefined;
      let resynced: (() => void) | undefined;
      const drop = () => {
        subscription += 1;
        resynced?.();
        resynced = undefined;
        pending = [];
        sizes = [];
        head = 0;
        queued = 0;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          drop();
          first?.();
          first = undefined;
        }),
      );

      // Uninterruptible, so the handle of a listener the manager installed always reaches cleanup.
      const listen = (from: Subscribe<A, E>) =>
        Effect.suspend(() => {
          const id = ++subscription;
          return from((event) =>
            Effect.sync(() => {
              if (id !== subscription) return;
              const size = queuedSize(event);
              pending.push(event);
              sizes.push(size);
              queued += size;
              // A single snapshot must fit even when history fills the budget.
              if (queued - sizes[head]! > maxQueued) {
                drop();
                overflowed = true;
              }
              ready.openUnsafe();
            }),
          ).pipe(
            Effect.map((stop) => {
              if (first === undefined && from === subscribe) first = stop;
              else if (id === subscription) resynced = stop;
              // Replaced while it was being acquired.
              else stop();
            }),
            Effect.onError(() => Effect.sync(drop)),
          );
        }).pipe(Effect.uninterruptible);

      const take = () => {
        const event = pending[head]!;
        pending[head] = undefined;
        head += 1;
        return event;
      };
      const takeBatch = (): Arr.NonEmptyReadonlyArray<A> => {
        let bytes = sizes[head]!;
        const batch: [A, ...A[]] = [take()];
        while (head < pending.length && bytes + sizes[head]! <= MAX_PENDING_BYTES) {
          bytes += sizes[head]!;
          batch.push(take());
        }
        queued -= bytes;
        if (head * 2 >= pending.length) {
          pending = pending.slice(head);
          sizes = sizes.slice(head);
          head = 0;
        }
        return batch;
      };

      const pull: Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E | Cause.Done> = Effect.suspend(
        () => {
          if (overflowed) {
            overflowed = false;
            return resync ? listen(resync).pipe(Effect.andThen(pull)) : Cause.done();
          }
          if (head < pending.length) return Effect.succeed(takeBatch());
          ready.closeUnsafe();
          return ready.await.pipe(Effect.andThen(pull));
        },
      );

      yield* listen(subscribe);
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
