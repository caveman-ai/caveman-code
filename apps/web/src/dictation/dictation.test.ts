// Talking to type, end to end on the client with a fake microphone and a fake Deepgram socket: what lands in the box,
// what stays grey, what the runtime is told, and what the box says when it can't listen.
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../state/runtime.tsx", () => ({ requestId: () => "req" }));
vi.mock("../call/media.ts", () => {
  class MicBlocked extends Error {}
  return {
    MicBlocked,
    microphone: vi.fn(),
    openCapture: vi.fn(),
  };
});

import { deepgramWords, openDictation } from "../call/engine.ts";
import * as media from "../call/media.ts";
import { dictationError, dictationState, spaceBefore, startDictation, stopDictation } from "./store.ts";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Array<ArrayBuffer | string> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.all.push(this);
  }
  send(data: ArrayBuffer | string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  // The server's side.
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  say(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  get audio() {
    return this.sent.filter((d) => typeof d !== "string").length;
  }
  get control() {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as { type: string });
  }
}
const results = (text: string, final: boolean) => ({ type: "Results", is_final: final, speech_final: final, channel: { alternatives: [{ transcript: text, confidence: 0.98 }] } });

function fakeCapture() {
  return { onFrame: null as ((pcm: ArrayBuffer) => void) | null, level: () => 0.5, bands: (into: Float32Array) => void into.fill(0.5), close: vi.fn() };
}
const frame = () => new ArrayBuffer(640);
const connect = { transport: "websocket" as const, url: "wss://api.deepgram.com/v1/listen?model=nova-3", protocols: ["bearer", "jwt"], input_rate: 16_000 };

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => undefined;
      suspend = async () => undefined;
    },
  );
});
afterEach(async () => {
  await stopDictation();
  vi.unstubAllGlobals();
  vi.mocked(media.microphone).mockReset();
  vi.mocked(media.openCapture).mockReset();
});

describe("Deepgram's words", () => {
  test("results are words, settled or not; anything else is none", () => {
    expect(deepgramWords(results(" add a mic ", false))).toEqual({ text: "add a mic", final: false });
    expect(deepgramWords(results("Add a mic to the composer.", true))).toEqual({ text: "Add a mic to the composer.", final: true });
    expect(deepgramWords(results("", true))).toEqual({ text: "", final: true });
    expect(deepgramWords({ type: "Metadata", request_id: "r" })).toBeNull();
    expect(deepgramWords({ type: "SpeechStarted" })).toBeNull();
  });

  test("the first words said while the socket opens are kept and go first; finishing asks for the rest, then waits for the close", async () => {
    const capture = fakeCapture();
    const words: unknown[] = [];
    let closed: string | null | undefined;
    const link = openDictation(connect, capture, { words: (w) => words.push(w), closed: (r) => (closed = r) });
    const ws = FakeSocket.all[0]!;
    expect(ws.protocols).toEqual(["bearer", "jwt"]);
    capture.onFrame!(frame());
    capture.onFrame!(frame());
    expect(ws.audio).toBe(0);
    ws.open();
    expect(ws.audio).toBe(2);
    capture.onFrame!(frame());
    expect(link.sentMs).toBe(60);
    ws.say(results("hello", false));
    const finished = link.finish(2_000);
    expect(ws.control).toEqual([{ type: "CloseStream" }]);
    // Nothing more goes once it is finishing.
    capture.onFrame?.(frame());
    expect(ws.audio).toBe(3);
    ws.say(results("Hello there.", true));
    ws.close(1000);
    await finished;
    expect(words).toEqual([
      { text: "hello", final: false },
      { text: "Hello there.", final: true },
    ]);
    expect(closed).toBeNull();
  });

  test("an engine that hangs up says why", () => {
    let closed: string | null | undefined;
    openDictation(connect, fakeCapture(), { words: () => undefined, closed: (r) => (closed = r) });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close(1011, "DATA-0000");
    expect(closed).toBe("DATA-0000");
  });
});

describe("talking to type", () => {
  const stream = () => {
    const track = { stop: vi.fn() };
    return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
  };
  const client = (answer: (method: string, params: Record<string, unknown>) => unknown) => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        call: vi.fn(async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return answer(method, params);
        }),
      } as never,
    };
  };
  const ok = (method: string) => (method === "dictation.start" ? { dictation_id: "dc-1", connect } : {});

  test("settled words land in the box in order, the rest stays grey, and stopping lands the last of it and reports the minutes", async () => {
    const capture = fakeCapture();
    vi.mocked(media.microphone).mockResolvedValue(stream().stream);
    vi.mocked(media.openCapture).mockResolvedValue(capture);
    const { client: c, calls } = client(ok);
    const landed: string[] = [];
    await startDictation(c, { owner: "chat:ws1", workspaceId: "ws1", onFinal: (w) => landed.push(w) });
    expect(calls[0]).toEqual({ method: "dictation.start", params: { request_id: "req", workspace_id: "ws1" } });
    const ws = FakeSocket.all[0]!;
    capture.onFrame!(frame());
    ws.open();
    for (let i = 0; i < 49; i++) capture.onFrame!(frame());
    ws.say(results("add a mic", false));
    ws.say(results("Add a mic to the composer.", true));
    ws.say(results("so I can", false));
    expect(landed).toEqual(["Add a mic to the composer."]);
    expect(dictationState()).toMatchObject({ phase: "live", owner: "chat:ws1", heard: "so I can" });
    const stopping = stopDictation();
    expect(ws.control).toEqual([{ type: "CloseStream" }]);
    ws.say(results("So I can just talk.", true));
    ws.close(1000);
    await stopping;
    expect(dictationState()).toMatchObject({ phase: "idle", owner: null, heard: "" });
    expect(landed).toEqual(["Add a mic to the composer.", "So I can just talk."]);
    expect(capture.close).toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ method: "dictation.end", params: { request_id: "req", dictation_id: "dc-1", audio_ms: 1_000 } });
  });

  test("no key: nothing listens, the mic is let go, and the box can open Settings", async () => {
    const { stream: s, track } = stream();
    vi.mocked(media.microphone).mockResolvedValue(s);
    const { client: c } = client((method) => {
      if (method === "dictation.start") throw new Error("no_key: dictation needs a Deepgram key (Settings > Chief > Calls)");
      return {};
    });
    await startDictation(c, { owner: "chief", onFinal: () => undefined });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(0);
    expect(media.openCapture).not.toHaveBeenCalled();
    expect(dictationState()).toMatchObject({ phase: "idle", error: { fix: "key", owner: "chief" } });
  });

  test("an engine that hangs up mid-sentence keeps what was settled, says why, and still reports the minutes", async () => {
    const capture = fakeCapture();
    vi.mocked(media.microphone).mockResolvedValue(stream().stream);
    vi.mocked(media.openCapture).mockResolvedValue(capture);
    const { client: c, calls } = client(ok);
    const landed: string[] = [];
    await startDictation(c, { owner: "new-chat", onFinal: (w) => landed.push(w) });
    const ws = FakeSocket.all[0]!;
    ws.open();
    capture.onFrame!(frame());
    ws.say(results("Kept.", true));
    ws.close(1011, "NET-0001");
    expect(landed).toEqual(["Kept."]);
    expect(dictationState()).toMatchObject({ phase: "idle", error: { text: "Stopped listening: NET-0001.", owner: "new-chat" } });
    expect(calls.at(-1)).toMatchObject({ method: "dictation.end", params: { audio_ms: 20 } });
    expect(capture.close).toHaveBeenCalled();
  });

  test("another box asking takes the mic: the first stops, its last words still land there", async () => {
    const first = fakeCapture();
    const second = fakeCapture();
    vi.mocked(media.microphone).mockResolvedValue(stream().stream);
    vi.mocked(media.openCapture).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { client: c } = client(ok);
    const a: string[] = [];
    const b: string[] = [];
    await startDictation(c, { owner: "a", onFinal: (w) => a.push(w) });
    const wsA = FakeSocket.all[0]!;
    wsA.open();
    const starting = startDictation(c, { owner: "b", onFinal: (w) => b.push(w) });
    wsA.say(results("For A.", true));
    wsA.close(1000);
    await starting;
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.say(results("For B.", true));
    expect(a).toEqual(["For A."]);
    expect(b).toEqual(["For B."]);
    expect(first.close).toHaveBeenCalled();
  });
});

describe("what the box says", () => {
  test("a missing key, a blocked mic, an engine away", () => {
    expect(dictationError(new Error("no_key: dictation needs a Caveman plan or credits, or a Deepgram key (Settings > Chief > Calls)"))).toEqual({ text: "Talking to type needs a Caveman plan or credits, or a Deepgram key, as calls do.", fix: "key" });
    expect(dictationError(new Error("no_key: dictation needs a Deepgram key (Settings > Chief > Calls)"))).toEqual({ text: "Talking to type needs a Deepgram key, as calls do.", fix: "key" });
    const refused = new SessionProtocolError({ code: -32005, message: "Caveman Code credits are used up until 1 December.", data: { reason: "engine_unavailable" } } as never);
    expect(dictationError(new Error("not_offered: Calls and dictation on Caveman credits aren't on yet. Add a key of your own to use them now."))).toEqual({
      text: "Calls and dictation on Caveman credits aren't on yet. Add a key of your own to use them now.",
      fix: "key",
    });
    expect(dictationError(refused)).toEqual({ text: "Caveman Code credits are used up until 1 December." });
    const revoked = "Deepgram refused the key. Check it in the Deepgram console under API Keys.";
    expect(dictationError(new SessionProtocolError({ code: -32016, message: revoked, data: { reason: "key_refused" } }))).toEqual({ text: revoked, fix: "key" });
    expect(dictationError(new media.MicBlocked())).toMatchObject({ fix: "mic" });
    expect(dictationError(new Error("boom")).text).toBe("Couldn't start listening: boom");
  });

  test("dictated words join the text with one space", () => {
    expect(spaceBefore("")).toBe("");
    expect(spaceBefore("Fix the build.")).toBe(" ");
    expect(spaceBefore("Fix the build.\n")).toBe("");
    expect(spaceBefore("Fix ")).toBe("");
  });
});
