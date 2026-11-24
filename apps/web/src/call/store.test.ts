// A call on this client against a fake runtime, microphone, audio graph and voice engine: what the runtime is told,
// what is left open, and which Chief the screen says the call is with.
import type { ChiefProfile, VoiceCall } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ client: null as unknown }));

// useCall read outside a render: its snapshot as it is now, and its effect (the runtime's notifications) run at once.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => void effect(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../state/runtime.tsx", () => ({
  requestId: () => "req",
  useRuntimeClient: () => ({ client: h.client }),
}));
vi.mock("../dictation/store.ts", () => ({ stopDictation: async () => undefined }));
vi.mock("./sounds.ts", () => ({
  CallSounds: class {
    unlock() {}
    ring() {
      return { first: new Promise(() => undefined), stop() {} };
    }
    hangUp() {}
    pickUp() {}
    tick() {}
  },
}));
vi.mock("./media.ts", () => {
  class MicBlocked extends Error {}
  return { MicBlocked, microphone: vi.fn(), openMedia: vi.fn() };
});
vi.mock("./engine.ts", () => ({ openEngine: vi.fn() }));

import { callChief } from "../state/chiefs.ts";
import { openEngine, type EngineEvents } from "./engine.ts";
import { MicBlocked, microphone, openMedia, type CallMedia } from "./media.ts";
import { answerIncoming, callStageOn, endCall, startCall, useCall } from "./store.ts";

const UGG = "chief-ugg";
const chiefs = [
  { id: "chief-home", name: "Home", home: true },
  { id: UGG, name: "Ugg", home: false },
] as unknown as ChiefProfile[];
/** Which Chief's page shows the call's stage (ChiefPane), and which Chief the pill names. */
const shownWith = (state: ReturnType<typeof useCall>) => ({
  homePage: callStageOn(state, chiefs[0]!),
  uggPage: callStageOn(state, chiefs[1]!),
  pill: callChief(chiefs, state.chiefId).name,
});

function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeRuntime() {
  const sent: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  const start = later<unknown>();
  const listeners = new Map<string, (params: unknown) => void>();
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return method === "chief.voice.start" ? start.promise : Promise.resolve({});
    },
    on: (method: string, listener: (params: unknown) => void) => {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
  } as unknown as Client;
  h.client = client;
  return {
    client,
    sent,
    answer: (call: Partial<VoiceCall> = {}) =>
      start.resolve({
        call: {
          id: "vc-1",
          state: "connecting",
          engine: "deepgram",
          started_at: "2026-11-06T10:00:00.000Z",
          device: "a browser",
          muted: false,
          ...call,
        },
        connect: {
          transport: "websocket",
          url: "wss://voice.test",
          protocols: [],
          settings: {},
          input_rate: 16_000,
          output_rate: 24_000,
        },
      }),
    refuse: (error: Error) => start.reject(error),
    notify: (method: string, params: unknown) => listeners.get(method)?.(params),
    ended: () => sent.filter((c) => c.method === "chief.voice.end").map((c) => c.params.call_id),
  };
}

function fakeMicrophone() {
  const granted = later<MediaStream>();
  vi.mocked(microphone).mockReturnValue(granted.promise);
  const track = { stop: vi.fn() };
  return {
    grant: () => granted.resolve({ getTracks: () => [track] } as unknown as MediaStream),
    refuse: () => granted.reject(new MicBlocked()),
    track,
  };
}

function fakeMedia() {
  return {
    onFrame: null,
    onPlaying: null,
    play() {},
    flush() {},
    hold() {},
    playing: false,
    drained: async () => undefined,
    levels: () => ({ mic: 0, voice: 0 }),
    bands() {},
    close: vi.fn(),
  } as unknown as CallMedia & { close: ReturnType<typeof vi.fn> };
}

let engine: EngineEvents | null = null;
beforeEach(() => {
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.clearAllMocks();
  engine = null;
  vi.mocked(openMedia).mockImplementation(async () => fakeMedia());
  vi.mocked(openEngine).mockImplementation((_connect, _media, on) => {
    engine = on;
    return { send() {}, setMuted() {}, close: vi.fn() };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("hanging up while it rings", () => {
  test("a start that answers after Hang up is ended on the runtime, and the microphone and the voice never open", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    void startCall(runtime.client);
    endCall(runtime.client);
    expect(useCall().phase).toBe("idle");
    // The microphone prompt is accepted and the runtime answers the start, both after the hang up.
    mic.grant();
    runtime.answer();
    await settle();
    expect({
      ended: runtime.ended(),
      micLetGo: mic.track.stop.mock.calls.length > 0,
      audioOpened: vi.mocked(openMedia).mock.calls.length > 0,
      voiceConnected: vi.mocked(openEngine).mock.calls.length > 0,
      phase: useCall().phase,
      call: useCall().call,
    }).toEqual({
      ended: ["vc-1"],
      micLetGo: true,
      audioOpened: false,
      voiceConnected: false,
      phase: "idle",
      call: null,
    });
  });

  test("hung up while the call's audio opens: the audio is closed and the voice never connects", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    const audio = later<CallMedia>();
    vi.mocked(openMedia).mockReturnValue(audio.promise);
    void startCall(runtime.client);
    mic.grant();
    runtime.answer();
    await settle();
    expect(useCall().call?.id).toBe("vc-1");
    endCall(runtime.client);
    const media = fakeMedia();
    audio.resolve(media);
    await settle();
    expect({
      ended: runtime.ended(),
      audioClosed: media.close.mock.calls.length > 0,
      voiceConnected: vi.mocked(openEngine).mock.calls.length > 0,
      phase: useCall().phase,
    }).toEqual({
      ended: ["vc-1"],
      audioClosed: true,
      voiceConnected: false,
      phase: "idle",
    });
  });

  test("hung up, then the microphone is refused: the start is still ended, and no microphone error shows", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    void startCall(runtime.client);
    endCall(runtime.client);
    mic.refuse();
    await settle();
    runtime.answer();
    await settle();
    expect({ ended: runtime.ended(), error: useCall().error }).toEqual({
      ended: ["vc-1"],
      error: null,
    });
  });

  test("hung up while it asks to keep the screen awake: the screen is let go", async () => {
    const asked = later<WakeLockSentinel>();
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone)",
      wakeLock: { request: () => asked.promise },
    });
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    void startCall(runtime.client);
    mic.grant();
    runtime.answer();
    await settle();
    expect(vi.mocked(openEngine)).toHaveBeenCalledOnce();
    endCall(runtime.client);
    const awake = { release: vi.fn(async () => undefined) };
    asked.resolve(awake as unknown as WakeLockSentinel);
    await settle();
    expect(awake.release).toHaveBeenCalledOnce();
  });
});

describe("this device's own call is never a call on another device", () => {
  // The runtime says the call is connecting before it answers the start, so that update can land while this client's
  // state has no call yet.
  async function callAnsweredAfterItsUpdate() {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    const media = fakeMedia();
    vi.mocked(openMedia).mockResolvedValue(media);
    useCall();
    void startCall(runtime.client);
    const connecting: VoiceCall = {
      id: "vc-1",
      state: "connecting",
      engine: "deepgram",
      started_at: "2026-11-06T10:00:00.000Z",
      device: "a browser",
      muted: false,
    };
    runtime.notify("chief.voice.updated", connecting);
    mic.grant();
    runtime.answer();
    await settle();
    engine?.cue({ type: "live" });
    media.onPlaying?.(true);
    return { runtime, connecting };
  }

  test("on the call, the screen does not say the call is on another device", async () => {
    await callAnsweredAfterItsUpdate();
    expect({
      phase: useCall().phase,
      call: useCall().call?.id,
      elsewhere: useCall().elsewhere,
    }).toEqual({ phase: "live", call: "vc-1", elsewhere: null });
  });

  test("the Chief ends the call with a goodbye: calling again is open, and the Chief's ring back rings", async () => {
    const { runtime, connecting } = await callAnsweredAfterItsUpdate();
    runtime.notify("chief.voice.updated", {
      ...connecting,
      state: "ended",
      ended_at: "2026-11-06T10:02:00.000Z",
      end_reason: "goodbye",
    });
    await settle();
    runtime.notify("chief.voice.ringing", {
      item_id: "ci-1",
      title: "Dark mode",
      state: "review",
      line: "Dark mode is ready for review.",
    });
    expect({
      phase: useCall().phase,
      elsewhere: useCall().elsewhere,
      incoming: useCall().incoming?.item_id,
    }).toEqual({ phase: "idle", elsewhere: null, incoming: "ci-1" });
  });
});

describe("the microphone refused", () => {
  test("before the start answers: the call the runtime starts anyway is ended once it answers", async () => {
    const runtime = fakeRuntime();
    vi.mocked(microphone).mockRejectedValue(new MicBlocked());
    await startCall(runtime.client);
    expect(useCall().error?.fix).toBe("mic");
    runtime.answer();
    await settle();
    expect(runtime.sent.filter((c) => c.method === "chief.voice.end").map((c) => c.params)).toEqual(
      [{ request_id: "req", call_id: "vc-1", reason: "provider" }],
    );
  });

  test("after the start answers: the call is ended at once", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    const starting = startCall(runtime.client);
    runtime.answer();
    await settle();
    mic.refuse();
    await starting;
    await settle();
    expect({ ended: runtime.ended(), fix: useCall().error?.fix }).toEqual({
      ended: ["vc-1"],
      fix: "mic",
    });
  });

  test("and the start refused too: there is no call to end, and the microphone's error shows", async () => {
    const runtime = fakeRuntime();
    vi.mocked(microphone).mockRejectedValue(new MicBlocked());
    await startCall(runtime.client);
    runtime.refuse(new Error("busy: on a call on iPhone"));
    await settle();
    expect({ ended: runtime.ended(), fix: useCall().error?.fix }).toEqual({
      ended: [],
      fix: "mic",
    });
  });
});

describe("a microphone granted to a call that goes nowhere", () => {
  test("the start refused, then the microphone granted: the microphone is let go", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    const starting = startCall(runtime.client);
    runtime.refuse(new Error("busy: on a call on iPhone"));
    await starting;
    mic.grant();
    await settle();
    expect({
      micLetGo: mic.track.stop.mock.calls.length > 0,
      error: useCall().error?.text,
    }).toEqual({ micLetGo: true, error: "You're on a call on iPhone already." });
  });

  test("hung up, the start refused, then the microphone granted: the microphone is let go", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    void startCall(runtime.client);
    endCall(runtime.client);
    runtime.refuse(new Error("busy: on a call on iPhone"));
    await settle();
    mic.grant();
    await settle();
    expect({
      micLetGo: mic.track.stop.mock.calls.length > 0,
      ended: runtime.ended(),
      error: useCall().error,
    }).toEqual({ micLetGo: true, ended: [], error: null });
  });

  test("the call's audio fails to open: the microphone is let go, and the call is ended", async () => {
    const runtime = fakeRuntime();
    const mic = fakeMicrophone();
    vi.mocked(openMedia).mockRejectedValue(new Error("the audio worklet did not load"));
    const starting = startCall(runtime.client);
    mic.grant();
    runtime.answer();
    await starting;
    await settle();
    expect({
      micLetGo: mic.track.stop.mock.calls.length > 0,
      ended: runtime.ended(),
      phase: useCall().phase,
    }).toEqual({ micLetGo: true, ended: ["vc-1"], phase: "idle" });
  });
});

describe("the Chief on the call", () => {
  test("while it rings, the call is with the Chief called: its stage and the pill are that Chief's, not the home Chief's", () => {
    const runtime = fakeRuntime();
    fakeMicrophone();
    void startCall(runtime.client, { chief_id: UGG });
    const ringing = useCall();
    expect({ phase: ringing.phase, call: ringing.call, ...shownWith(ringing) }).toEqual({
      phase: "calling",
      call: null,
      homePage: false,
      uggPage: true,
      pill: "Ugg",
    });
  });

  test("answering a ring back rings as the Chief that rang", () => {
    const runtime = fakeRuntime();
    useCall();
    runtime.notify("chief.voice.ringing", {
      item_id: "ci-1",
      title: "Dark mode",
      state: "review",
      line: "Dark mode is ready for review.",
      chief_id: UGG,
    });
    expect(useCall().incoming?.item_id).toBe("ci-1");
    fakeMicrophone();
    answerIncoming(runtime.client);
    expect(runtime.sent.find((c) => c.method === "chief.voice.start")?.params).toMatchObject({
      answer: "ci-1",
    });
    expect(shownWith(useCall())).toEqual({ homePage: false, uggPage: true, pill: "Ugg" });
  });

  test("a call that ends shows its ending on that Chief's page, then lets the Chief go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const runtime = fakeRuntime();
      const mic = fakeMicrophone();
      const media = fakeMedia();
      vi.mocked(openMedia).mockResolvedValue(media);
      void startCall(runtime.client, { chief_id: UGG });
      mic.grant();
      runtime.answer({ chief_id: UGG });
      await vi.advanceTimersByTimeAsync(0);
      engine?.cue({ type: "live" });
      media.onPlaying?.(true);
      expect(useCall()).toMatchObject({ phase: "live", answered: true });
      endCall(runtime.client);
      const ended = useCall();
      expect({ phase: ended.phase, ended: ended.ended !== null, ...shownWith(ended) }).toEqual({
        phase: "idle",
        ended: true,
        homePage: false,
        uggPage: true,
        pill: "Ugg",
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect({ ended: useCall().ended, ...shownWith(useCall()) }).toEqual({
        ended: null,
        homePage: false,
        uggPage: false,
        pill: "Home",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
