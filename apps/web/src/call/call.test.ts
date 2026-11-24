import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { CallStage, callMode, statusLine, waveOf } from "./CallStage.tsx";
import { clock } from "./clock.ts";
import { deepgramCue, openEngine } from "./engine.ts";
import { hear, type CallMedia } from "./media.ts";
import { fitCanvas } from "./VoiceWave.tsx";
import { MUTE_OPTIONS, muteLabel, muteSettings, ringMute, tomorrowMorning, unmuteSettings } from "./mute.ts";
import { showingKey, showingTarget } from "./showing.ts";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";

describe("muting the Chief's rings", () => {
  const now = new Date(2026, 9, 25, 22, 40); // Sunday 25 Oct 2026, 10:40 PM local
  test("each option saves what the runtime reads: a time ahead, or Ring me back off", () => {
    expect(MUTE_OPTIONS.map((o) => o.label)).toEqual(["15 minutes", "1 hour", "Until tomorrow morning", "Until I turn it back on"]);
    expect(muteSettings("15m", now)).toEqual({ chief_voice_ring_muted_until: new Date(2026, 9, 25, 22, 55).toISOString() });
    expect(muteSettings("1h", now)).toEqual({ chief_voice_ring_muted_until: new Date(2026, 9, 25, 23, 40).toISOString() });
    expect(muteSettings("morning", now)).toEqual({ chief_voice_ring_muted_until: new Date(2026, 9, 26, 8, 0).toISOString() });
    expect(tomorrowMorning(new Date(2026, 9, 31, 1, 0))).toEqual(new Date(2026, 10, 1, 8, 0));
    expect(muteSettings("manual", now)).toEqual({ chief_voice_ring_back: false });
    expect(unmuteSettings()).toEqual({ chief_voice_ring_back: true, chief_voice_ring_muted_until: null });
  });
  test("the pill reads the settings: off wins, a time ahead counts, a past time or nothing does not", () => {
    expect(ringMute(null, now)).toBeNull();
    expect(ringMute({}, now)).toBeNull();
    expect(ringMute({ chief_voice_ring_muted_until: new Date(2026, 9, 25, 22, 0).toISOString() }, now)).toBeNull();
    expect(ringMute({ chief_voice_ring_back: false, chief_voice_ring_muted_until: new Date(2026, 9, 25, 23, 0).toISOString() }, now)).toEqual({ kind: "manual" });
    const until = new Date(2026, 9, 25, 23, 40);
    expect(ringMute({ chief_voice_ring_muted_until: until.toISOString() }, now)).toEqual({ kind: "until", until });
    expect(muteLabel({ kind: "manual" }, now)).toBe("Calls muted");
    expect(muteLabel({ kind: "until", until }, now)).toBe("Calls muted until 11:40 PM");
    expect(muteLabel({ kind: "until", until: new Date(2026, 9, 26, 8, 0) }, now)).toBe("Calls muted until Mon 8:00 AM");
  });
});
import { deviceName, endedLine, startError, type CallState } from "./store.ts";

describe("showing", () => {
  test("a pull request opens its Review page (a file in Files), changes open the chat's diff, a chat opens itself", () => {
    const base = { item_id: "ci-1", workspace_id: "ws-9", title: "Dark mode for runs", project_id: "caveman-repo:abc", caption: "The pull request for Dark mode for runs" } as const;
    expect(showingTarget({ ...base, kind: "pr", pr_number: 12 })).toEqual({ path: "/review/caveman-repo%3Aabc/12" });
    expect(showingTarget({ ...base, kind: "pr", pr_number: 12, path: "apps/web/src/Runs.tsx" })).toEqual({ path: "/review/caveman-repo%3Aabc/12?file=apps%2Fweb%2Fsrc%2FRuns.tsx" });
    expect(showingTarget({ ...base, kind: "diff", path: "apps/web/src/Runs.tsx" })).toEqual({ path: "/w/ws-9", surface: { workspaceId: "ws-9", kind: "diff", params: { path: "apps/web/src/Runs.tsx" } } });
    // A pull request the runtime could not address falls back to the chat's changes.
    expect(showingTarget({ ...base, kind: "pr" })).toEqual({ path: "/w/ws-9", surface: { workspaceId: "ws-9", kind: "diff", params: {} } });
    expect(showingTarget({ ...base, kind: "chat" })).toEqual({ path: "/w/ws-9" });
    expect(showingKey({ ...base, kind: "pr", pr_number: 12 })).not.toBe(showingKey({ ...base, kind: "pr", pr_number: 12, path: "a.ts" }));
    expect(showingKey(undefined)).toBe("");
  });
});

const state = (patch: Partial<CallState> = {}): CallState => ({
  phase: "idle", call: null, muted: false, talking: false, speaking: "none", thinking: false, caption: null, handedAt: null,
  answered: false, liveAt: null, error: null, elsewhere: null, incoming: null, missed: [], ended: null, chiefId: undefined, ...patch,
});

describe("the stage", () => {
  test("rings until the Chief picks up, then follows who is talking", () => {
    expect(callMode(state({ phase: "calling" }))).toBe("ringing");
    expect(callMode(state({ phase: "live" }))).toBe("ringing");
    const live = state({ phase: "live", answered: true, liveAt: 0 });
    expect(callMode(live)).toBe("listening");
    expect(callMode({ ...live, speaking: "chief" })).toBe("speaking");
    expect(callMode({ ...live, speaking: "person" })).toBe("hearing");
    expect(callMode({ ...live, thinking: true })).toBe("thinking");
    expect(callMode({ ...live, muted: true })).toBe("muted");
    // Held Space while muted: it hears you.
    expect(callMode({ ...live, muted: true, talking: true, speaking: "person" })).toBe("hearing");
    expect(callMode(state({ phase: "ending" }))).toBe("ended");
    expect(callMode(state({ ended: { reason: "person", ms: 1_000 } }))).toBe("ended");
    expect(callMode(state())).toBe("idle");
  });

  test("its line draws the Chief's voice while it speaks and the microphone otherwise, the call's own sounds as it rings and ends, and nothing while muted", () => {
    expect(waveOf("ringing")).toEqual({ source: "sounds", rest: "drift", bright: true });
    expect(waveOf("speaking")).toEqual({ source: "voice", rest: "drift", bright: true });
    // The microphone is drawn before the engine says you are speaking: the line answers your first word.
    expect(waveOf("listening")).toEqual({ source: "mic", rest: "drift", bright: false });
    expect(waveOf("hearing")).toEqual(waveOf("listening"));
    expect(waveOf("thinking")).toEqual({ source: "mic", rest: "think", bright: false });
    expect(waveOf("ended")).toEqual({ source: "sounds", rest: "flat", bright: false });
    expect(waveOf("muted")).toEqual({ source: null, rest: "flat", bright: false });
    expect(waveOf("idle")).toEqual(waveOf("muted"));
  });

  test("says one short line", () => {
    expect(statusLine(state({ phase: "calling" }), 0, true)).toBe("Calling…");
    const live = state({ phase: "live", answered: true, liveAt: 0 });
    expect(statusLine({ ...live, handedAt: 1_000 }, 3_000, true)).toBe("Handed to the Chief");
    expect(statusLine({ ...live, handedAt: 1_000 }, 6_000, true)).toBe("Listening");
    expect(statusLine({ ...live, muted: true }, 0, true)).toBe("Muted · hold Space to talk");
    expect(statusLine({ ...live, muted: true }, 0, false)).toBe("Muted");
    expect(statusLine({ ...live, speaking: "chief" }, 0, true)).toBe("Speaking");
    expect(statusLine(state({ ended: { reason: "quiet", ms: 75_000 } }), 0, true)).toBe("Hung up after a quiet spell · 1:15");
    expect(statusLine(state({ phase: "ending" }), 0, true)).toBe("Hanging up…");
  });

  test("a phone's stage keeps the caption's line before any words come, so the first caption moves nothing", () => {
    const runtime = { client: null, engines: [], workspaces: [], raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
    const caption = (s: CallState) => {
      const html = renderToStaticMarkup(createElement(RuntimeContext.Provider, { value: runtime }, createElement(CallStage, { state: s })));
      const [, classes = "", text = ""] = /<p class="call-caption-in ([^"]*)"[^>]*>(.*?)<\/p>/.exec(html) ?? [];
      return [classes, text] as const;
    };
    const live = state({ phase: "live", answered: true, liveAt: 0 });
    for (const before of [state({ phase: "calling" }), live]) {
      const [classes, text] = caption(before);
      expect(text).toBe("");
      expect(classes.split(" ")).toContain("min-h-7");
    }
    expect(caption({ ...live, caption: { who: "chief", text: "On it." } })[1]).toBe("On it.");
  });

  test("reads a length like a phone", () => {
    expect([clock(0), clock(9_999), clock(61_000), clock(3_725_000), clock(-5)]).toEqual(["0:00", "0:09", "1:01", "1:02:05", "0:00"]);
    expect([endedLine("person"), endedLine("max_length"), endedLine("something new")]).toEqual(["Call ended", "Call ended after 30 minutes", "Call ended"]);
  });
});

describe("starting", () => {
  test("names this device for the others", () => {
    expect(deviceName({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)" })).toBe("iPhone");
    expect(deviceName({ userAgent: "Mozilla/5.0 (Linux; Android 16)" })).toBe("Android");
    expect(deviceName({ userAgent: "Mozilla/5.0 (Macintosh)" })).toBe("a browser");
  });

  test("a refusal says the one thing that fixes it, in the engine's own name", () => {
    expect(startError(new Error("no_key: calls need a Caveman plan or credits, or a Deepgram key (Settings > Chief > Calls)"))).toEqual({ text: "Calls need a Caveman plan or credits, or a Deepgram key.", fix: "key" });
    expect(startError(new Error("no_key: calls need a Deepgram key (Settings > Chief > Calls)"))).toEqual({ text: "Calls need a Deepgram key.", fix: "key" });
    // A refusal reads as one, never as the network: the runtime's words say which it was.
    const refused = new SessionProtocolError({ code: -32005, message: "Caveman Code credits are used up until 1 December.", data: { reason: "engine_unavailable" } } as never);
    expect(startError(refused)).toEqual({ text: "Caveman Code credits are used up until 1 December." });
    // Calls on credits not on yet: Cloud's words, and the way to a key of their own.
    expect(startError(new Error("not_offered: Calls and dictation on Caveman credits aren't on yet. Add a key of your own to use them now."))).toEqual({
      text: "Calls and dictation on Caveman credits aren't on yet. Add a key of your own to use them now.",
      fix: "key",
    });
    expect(startError(new Error("no_key: calls need an OpenAI key (Settings > Chief > Calls)"))).toEqual({ text: "Calls need an OpenAI key.", fix: "key" });
    expect(startError(new Error("busy: on a call on iPhone"))?.text).toBe("You're on a call on iPhone already.");
    expect(startError(new Error("cap: today's limit for the Chief is reached"))?.text).toBe("Today's limit for the Chief is reached.");
    expect(startError(new Error("socket closed"))?.text).toBe("Couldn't call the Chief: socket closed");
  });

  test("refused by whoever pays, it says their words and the way to a key", () => {
    const revoked = "Deepgram refused the key. Check it in the Deepgram console under API Keys.";
    expect(startError(new SessionProtocolError({ code: -32016, message: revoked, data: { reason: "key_refused" } }))).toEqual({ text: revoked, fix: "key" });
  });
});

describe("the call's socket closing", () => {
  class Socket {
    static last: Socket;
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    binaryType = "";
    onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      Socket.last = this;
    }
    send() {}
    close() {}
  }
  const media = { onFrame: null, onPlaying: null, play() {}, flush() {}, hold() {}, playing: false } as unknown as CallMedia;
  const open = () => {
    vi.stubGlobal("WebSocket", Socket);
    const closed: Array<[string, boolean]> = [];
    openEngine({ transport: "websocket", url: "wss://gateway.test/v1/code/voice/socket", protocols: ["bearer", "cvt_x"], settings: {}, input_rate: 16_000, output_rate: 24_000 }, media, { message() {}, cue() {}, closed: (reason, said) => void closed.push([reason, said]) });
    vi.unstubAllGlobals();
    return { socket: Socket.last, closed };
  };

  test("words the far end closed with (Cloud's relay: credits ran out) are the person's to read; a drop is not", () => {
    const relay = open();
    relay.socket.onclose?.({ code: 4402, reason: "Your Caveman credits ran out." });
    expect(relay.closed).toEqual([["Your Caveman credits ran out.", true]]);
    const dropped = open();
    dropped.socket.onclose?.({ code: 1006, reason: "" });
    expect(dropped.closed).toEqual([["closed (1006)", false]]);
    const bare = open();
    bare.socket.onclose?.({ code: 4400, reason: "" });
    expect(bare.closed).toEqual([["closed (4400)", false]]);
    const restarting = open();
    restarting.socket.onclose?.({ code: 1012, reason: "Caveman is restarting this server. Start the call again." });
    expect(restarting.closed).toEqual([["Caveman is restarting this server. Start the call again.", true]]);
  });
});

describe("the engine adapter", () => {
  test("turns Deepgram's messages into the stage's cues, and nothing else into one", () => {
    expect(deepgramCue({ type: "SettingsApplied" })).toEqual({ type: "live" });
    expect(deepgramCue({ type: "ConversationText", role: "user", content: " add dark mode " })).toEqual({ type: "turn", role: "person", text: "add dark mode" });
    expect(deepgramCue({ type: "ConversationText", role: "assistant", content: "On it." })).toEqual({ type: "turn", role: "voice", text: "On it." });
    expect(deepgramCue({ type: "ConversationText", role: "user", content: "  " })).toBeNull();
    expect(deepgramCue({ type: "FunctionCallRequest", functions: [{ id: "f1", name: "hand_to_chief" }] })).toEqual({ type: "handoff" });
    expect(deepgramCue({ type: "FunctionCallRequest", functions: [{ id: "f2", name: "end_call" }] })).toBeNull();
    expect([deepgramCue({ type: "UserStartedSpeaking" }), deepgramCue({ type: "AgentThinking" }), deepgramCue({ type: "AgentStartedSpeaking" })]).toEqual([{ type: "person_speaking" }, { type: "thinking" }, { type: "voice_speaking" }]);
    expect(deepgramCue({ type: "History" })).toBeNull();
  });
});

describe("the voice lab's microphone", () => {
  test("hear draws the microphone, and close lets go of its node and every track of it", () => {
    const stopped: string[] = [];
    let connected = 0;
    const node = { connect: () => void (connected += 1), disconnect: () => void (connected -= 1) };
    const analyser = { fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 48_000 }, getFloatTimeDomainData: (into: Float32Array) => void into.fill(0.1), getByteFrequencyData: () => undefined };
    const ctx = { createMediaStreamSource: () => node, createAnalyser: () => analyser } as unknown as AudioContext;
    const stream = { getTracks: () => ["mic", "monitor"].map((id) => ({ stop: () => void stopped.push(id) })) } as unknown as MediaStream;
    const mic = hear(ctx, stream);
    expect(connected).toBe(1);
    expect(mic.level()).toBeGreaterThan(0);
    mic.close();
    expect(connected).toBe(0);
    expect(stopped).toEqual(["mic", "monitor"]);
  });
});

describe("the line's canvas", () => {
  test("is sized only when its box or the screen's pixels change: setting a size clears it, so a call's change of mode never blanks the line", () => {
    const sets: string[] = [];
    let width = 0;
    let height = 0;
    const el = {
      clientWidth: 220,
      clientHeight: 56,
      get width() { return width; },
      set width(v: number) { sets.push(`width ${v}`); width = v; },
      get height() { return height; },
      set height(v: number) { sets.push(`height ${v}`); height = v; },
    };
    expect(fitCanvas(el, 2)).toBe(true);
    expect(sets).toEqual(["width 440", "height 112"]);
    // The line changes what it draws (its effect runs again): the same box, nothing set, the frame stays.
    expect(fitCanvas(el, 2)).toBe(false);
    expect(sets).toHaveLength(2);
    // Dragged to a 1x screen: sized again.
    expect(fitCanvas(el, 1)).toBe(true);
    expect(sets.slice(2)).toEqual(["width 220", "height 56"]);
  });
});
