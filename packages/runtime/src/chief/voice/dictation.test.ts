// Dictation's runtime half: the connection Deepgram's adapter mints, and the minutes it records. The words never
// reach the runtime, so there is nothing else here to test.
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import { DICTATION_USD_PER_MINUTE, deepgramDictationUrl, makeDeepgram } from "./deepgram.ts";
import { keytermsOf, makeDictation, makeDictationHandlers } from "./Dictation.ts";
import type { VoiceCredits } from "./keys.ts";

const grantOk = async () => ({ status: 200, json: async () => ({ access_token: "jwt-for-one-dictation", expires_in: 60 }) });
/** Cloud's gateway minting a dictation ticket (Caveman Cloud code_voice.go), each body it was sent kept. */
const ticketOk = (bodies: Array<unknown>, sessions: Array<string | undefined> = []) => async (url: string, init: { body: string; headers: Record<string, string> }) => {
  bodies.push({ url, body: JSON.parse(init.body) as unknown });
  sessions.push(init.headers["x-caveman-session"]);
  return { status: 200, json: async () => ({ ticket: "cvt_one-dictation", expires_in: 60, usd_per_minute: 0.0092 }) };
};

describe("Deepgram dictation", () => {
  test("the URL: Nova-3 in any of its languages, written text, words as they firm up, one keyterm per name", () => {
    const url = new URL(deepgramDictationUrl(["caveman-code", "Dark mode for runs"]));
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    const q = url.searchParams;
    expect(Object.fromEntries([...q].filter(([k]) => k !== "keyterm"))).toEqual({
      model: "nova-3",
      language: "multi",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      endpointing: "300",
      mip_opt_out: "true",
    });
    // Spoken punctuation stays words: "add a comma" is about the code.
    expect(q.has("dictation")).toBe(false);
    expect(q.getAll("keyterm")).toEqual(["caveman-code", "Dark mode for runs"]);
  });

  test("connect mints a token for the socket and never hands out the key", async () => {
    const engine = makeDeepgram({ fetch: grantOk });
    const { connect, usdPerMinute } = await Effect.runPromise(engine.dictation.connect({ kind: "key", key: "dg-secret-key-0123456789" }, ["app"]));
    expect(connect).toMatchObject({ transport: "websocket", protocols: ["bearer", "jwt-for-one-dictation"], input_rate: 16_000 });
    expect(connect.url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
    expect(JSON.stringify(connect)).not.toContain("dg-secret-key");
    expect(usdPerMinute).toBe(DICTATION_USD_PER_MINUTE);
  });

  test("on Caveman credits: the keyterms go to Cloud, which builds the query itself, and the socket is the gateway's", async () => {
    const bodies: Array<unknown> = [];
    const engine = makeDeepgram({ fetch: ticketOk(bodies) });
    const { connect, usdPerMinute } = await Effect.runPromise(engine.dictation.connect({ kind: "credits", key: "cave_secret_credits_key", gateway: "https://gateway.example" }, ["app", "Dark mode"]));
    expect(bodies).toEqual([{ url: "https://gateway.example/v1/code/voice", body: { kind: "dictation", keyterms: ["app", "Dark mode"] } }]);
    expect(connect).toEqual({ transport: "websocket", url: "wss://gateway.example/v1/code/voice/socket", protocols: ["bearer", "cvt_one-dictation"], input_rate: 16_000 });
    expect(usdPerMinute).toBe(0.0092);
  });
});

describe("dictation", () => {
  const harness = (options: { keys?: Record<string, string>; credits?: VoiceCredits; fetch?: NonNullable<Parameters<typeof makeDeepgram>[0]>["fetch"] } = {}) => {
    let t = 1_000_000;
    const spend: Array<{ workspaceId: string | null; usd: number; durationMs: number; paid: string }> = [];
    const names: Array<string | undefined> = [];
    const engine = makeDeepgram({ fetch: options.fetch ?? grantOk });
    const dictation = makeDictation({
      engine,
      keys: Effect.succeed(options.keys ?? { deepgram: "dg-secret-key-0123456789" }),
      credits: Effect.succeed(options.credits),
      names: (workspaceId) => (names.push(workspaceId), Effect.succeed(["caveman-code", "ab", "Dark mode for runs", "caveman-code"])),
      hasWorkspace: (id) => Effect.succeed(id === "ws1"),
      recordSpend: (workspaceId, usd, durationMs, paid) => Effect.sync(() => void spend.push({ workspaceId, usd, durationMs, paid })),
      now: () => t,
    });
    return { dictation, spend, names, advance: (ms: number) => void (t += ms), engine };
  };

  test("start answers how to connect, with the box's chat named first", async () => {
    const h = harness();
    const started = await Effect.runPromise(h.dictation.start({ workspaceId: "ws1" }));
    expect(started.dictation_id).toMatch(/^dc-/);
    expect(new URL(started.connect.url).searchParams.getAll("keyterm")).toEqual(["caveman-code", "Dark mode for runs"]);
    expect(h.names).toEqual(["ws1"]);
  });

  test("end records the streamed minutes at list price in the chat's bucket, once, never past the time it ran", async () => {
    const h = harness();
    const { dictation_id } = await Effect.runPromise(h.dictation.start({ workspaceId: "ws1" }));
    h.advance(60_000);
    await Effect.runPromise(h.dictation.end({ dictationId: dictation_id, audioMs: 60_000 }));
    await Effect.runPromise(h.dictation.end({ dictationId: dictation_id, audioMs: 60_000 }));
    expect(h.spend).toEqual([{ workspaceId: "ws1", usd: DICTATION_USD_PER_MINUTE, durationMs: 60_000, paid: "key" }]);

    const second = await Effect.runPromise(h.dictation.start({ workspaceId: "ws1" }));
    h.advance(10_000);
    await Effect.runPromise(h.dictation.end({ dictationId: second.dictation_id, audioMs: 3_600_000 }));
    expect(h.spend[1]!.durationMs).toBe(15_000);
  });

  test("a box with no chat on this runtime spends in no chat's bucket", async () => {
    const h = harness();
    const a = await Effect.runPromise(h.dictation.start({ workspaceId: "ws-gone" }));
    const b = await Effect.runPromise(h.dictation.start({}));
    await Effect.runPromise(h.dictation.end({ dictationId: a.dictation_id, audioMs: 1_000 }));
    await Effect.runPromise(h.dictation.end({ dictationId: b.dictation_id, audioMs: 1_000 }));
    expect(h.spend.map((s) => s.workspaceId)).toEqual([null, null]);
    expect(h.names).toEqual([undefined, undefined]);
  });

  test("with no key of their own, Caveman credits pay: Cloud's ticket, at Cloud's price, recorded as credits", async () => {
    const bodies: Array<unknown> = [];
    const sessions: Array<string | undefined> = [];
    const h = harness({ keys: {}, credits: async () => ({ key: "cave_credits", gateway: "https://gateway.example" }), fetch: ticketOk(bodies, sessions) });
    const started = await Effect.runPromise(h.dictation.start({ workspaceId: "ws1" }));
    expect(started.connect.url).toBe("wss://gateway.example/v1/code/voice/socket");
    expect(bodies).toEqual([{ url: "https://gateway.example/v1/code/voice", body: { kind: "dictation", keyterms: ["caveman-code", "Dark mode for runs"] } }]);
    // The minutes are the chat's being dictated into; a box with none names no chat.
    await Effect.runPromise(h.dictation.start({}));
    expect(sessions).toEqual(["ws1", undefined]);
    h.advance(60_000);
    await Effect.runPromise(h.dictation.end({ dictationId: started.dictation_id, audioMs: 30_000 }));
    expect(h.spend).toEqual([{ workspaceId: "ws1", usd: 0.0046, durationMs: 30_000, paid: "credits" }]);
  });

  test("a key of their own pays even with credits on", async () => {
    let asked = false;
    const h = harness({ credits: async () => ((asked = true), { key: "cave_credits", gateway: "https://gateway.example" }) });
    const started = await Effect.runPromise(h.dictation.start({}));
    expect(started.connect.url.startsWith("wss://api.deepgram.com/v1/listen?")).toBe(true);
    expect(asked).toBe(false);
  });

  test("no key, no credits, and an engine away are refused in words the box can act on", async () => {
    const noKey = await Effect.runPromise(Effect.flip(harness({ keys: {} }).dictation.start({})));
    expect(noKey).toMatchObject({ reason: "invalid_state" });
    expect(noKey.message).toMatch(/^no_key: dictation needs a Caveman plan or credits, or a Deepgram key/);
    const away = await Effect.runPromise(Effect.flip(harness({ fetch: () => Promise.reject(new Error("ENOTFOUND")) }).dictation.start({})));
    expect(away).toMatchObject({ reason: "engine_unavailable" });
  });

  test("an unknown id records nothing", async () => {
    const h = harness();
    await Effect.runPromise(h.dictation.end({ dictationId: "dc-nope", audioMs: 5_000 }));
    expect(h.spend).toEqual([]);
  });

  test("only the runtime's owner may dictate: the key it spends is theirs", async () => {
    const h = harness();
    const handlers = makeDictationHandlers(h.dictation, (principal) => principal === undefined || principal === "local");
    const reason = (effect: Effect.Effect<unknown, { reason: string }>) => Effect.runPromise(effect.pipe(Effect.match({ onFailure: (e) => e.reason, onSuccess: () => "ok" })));
    expect(await reason(handlers["dictation.start"]({ request_id: "x" }, { connectionId: "c", principal: "cloud:intruder" }))).toBe("forbidden");
    expect(await reason(handlers["dictation.end"]({ request_id: "x", dictation_id: "dc-1", audio_ms: 1 }, { connectionId: "c", principal: "cloud:intruder" }))).toBe("forbidden");
    expect(await reason(handlers["dictation.start"]({ request_id: "x" }, { connectionId: "c", principal: "local" }))).toBe("ok");
  });

  test("keyterms: each name once, not too short or long, no control characters, 30 at most", () => {
    expect(keytermsOf([" app ", "app", "ab", "x".repeat(41), "Dark mode", "tab\there"])).toEqual(["app", "Dark mode"]);
    expect(keytermsOf(Array.from({ length: 50 }, (_, i) => `project ${i}`))).toHaveLength(30);
  });
});
