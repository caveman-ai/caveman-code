// Cloud's copy read over HTTP (cloudApi.events) as a chat's feed reads it, on a fetch that behaves as the platform's
// does: an aborted request rejects, and its body stops with the abort's reason. A socket that died while a page was out
// (the laptop slept, the Wi-Fi changed) never answers at all.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatFeed, type FeedState } from "./chat-feed.ts";
import { cloudApi } from "./cloud-api.ts";
import type { CopyPage } from "./wire.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const auth = {
  base: "https://cloud.test",
  headers: async () => ({}),
  renew: async () => false,
  credentials: "omit" as const,
};
const page = (cursors: number[]): CopyPage => ({
  epoch: 1,
  events: cursors.map((cursor) => ({
    cursor,
    at: "2026-11-07T10:00:00.000Z",
    type: "message.delta",
    event: { type: "message.delta", payload: { text: `e${cursor}` } },
  })),
  through: cursors.at(-1) ?? 0,
  more: false,
});

/** The request went out on a socket that is gone: nothing ever comes back, until it is aborted. */
const dead = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );

/** An answer whose body arrives in `chunks`, each `after` ms after the one before; it stops there unless `end`. */
const streamed = (
  signal: AbortSignal | null | undefined,
  chunks: ReadonlyArray<{ readonly after: number; readonly text: string }>,
  end: boolean,
) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let failed = false;
      signal?.addEventListener("abort", () => ((failed = true), controller.error(signal.reason)), {
        once: true,
      });
      let at = 0;
      for (const chunk of chunks)
        setTimeout(
          () => !failed && controller.enqueue(encoder.encode(chunk.text)),
          (at += chunk.after),
        );
      if (end) setTimeout(() => !failed && controller.close(), at);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

test("a copy read stuck on a dead socket gives way within a minute: the chat shows Cloud's copy instead of loading on", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    return asked.length === 1
      ? dead(init?.signal)
      : new Response(JSON.stringify(page([1, 2])), { status: 200 });
  }) as typeof fetch;
  const api = cloudApi(auth, fetchImpl);
  const shown: number[] = [];
  const states: FeedState["kind"][] = [];
  const feed = new ChatFeed({
    sessionId: "s1",
    sink: {
      reset: () => void (shown.length = 0),
      apply: (e: SessionEvent) => void shown.push(e.cursor),
    },
    copy: (epoch, after) => api.events("s1", epoch, after),
    epochHint: () => 1,
    onState: (s) => states.push(s.kind),
  });
  // The chat's computer went to sleep: the hub reads Cloud's copy. That read went out on the dead socket.
  feed.use({ kind: "copy" });
  await vi.advanceTimersByTimeAsync(0);
  expect(asked).toHaveLength(1);
  // Cloud's list says the copy moved on: the feed asks again behind the read that is still out.
  feed.copyAdvanced();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(asked).toHaveLength(2);
  expect(shown).toEqual([1, 2]);
  expect(states.at(-1)).toBe("copy");
  feed.close();
});

test("a copy page whose body stops arriving mid-way fails within a minute, so the next read is not held behind it", async () => {
  const api = cloudApi(auth, (async (_url: string, init?: RequestInit) =>
    streamed(init?.signal, [{ after: 10, text: '{"epoch":1,"events":[' }], false)) as typeof fetch);
  const read = api.events("s1", 1, 0).then(
    () => "answered",
    () => "failed",
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await Promise.race([read, Promise.resolve("still out")])).toBe("failed");
});

test("a large copy page that keeps arriving, however slowly, is read whole", async () => {
  const whole = JSON.stringify(page([1, 2, 3]));
  const thirds = [whole.slice(0, 40), whole.slice(40, 80), whole.slice(80)];
  // Each part comes well apart, the whole page taking longer than any one silence the read allows.
  const api = cloudApi(auth, (async (_url: string, init?: RequestInit) =>
    streamed(
      init?.signal,
      thirds.map((text) => ({ after: 20_000, text })),
      true,
    )) as typeof fetch);
  const read = api.events("s1", 1, 0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await read).events.map((e) => e.cursor)).toEqual([1, 2, 3]);
});
