// The voice lab: the production call (in the box, and a phone's stage), ring-back card and dictating mic, moving, so the wave and the mark can be
// judged by eye before they ship. No runtime or engine: the voices are a script (speech-shaped loudness and spectrum),
// or your own microphone through the call's meter; the ring and the hang-up are the call's real sounds on a real audio
// graph, silent unless Sound is on. Run the web dev server and open /src/call/voice.browser.html. A link can open on
// one moment: ?moment=Calling&phase=live&phone=1, and ?still=1.3 holds the scripted voice at that second.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Button } from "@caveman-app/ui/components/button";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { SendKey } from "../components/SendKey.tsx";
import { MicButton } from "../dictation/MicButton.tsx";
import type { DictationPhase } from "../dictation/store.ts";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import { CallBox, CallStage, IncomingCallCard } from "./CallStage.tsx";
import { hear } from "./media.ts";
import { CallSounds, type Ring } from "./sounds.ts";
import type { CallSignal, CallState } from "./store.ts";
import { SILENT, type WaveSource } from "./wave.ts";
import "../styles.css";

const runtime = {
  client: null,
  engines: [],
  workspaces: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const ASKED = new URLSearchParams(location.search);
const HELD = ASKED.get("still");

/** A voice from a script: syllables about three a second in phrases with a breath between, each with its own vowel. */
function scripted(seed: number): WaveSource {
  const at = () => (HELD === null ? performance.now() / 1000 : Number(HELD) || 1.3) + seed * 7.3;
  const syllable = (t: number) => Math.floor(t * 3.1);
  const noise = (n: number) => Math.abs(Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453) % 1;
  const level = () => {
    const t = at();
    const phrase = t % 3.4 < 2.5 ? 1 : 0;
    return (
      phrase *
      Math.max(0, Math.sin(Math.PI * ((t * 3.1) % 1))) ** 0.8 *
      (0.3 + 0.5 * noise(syllable(t)))
    );
  };
  return {
    level,
    bands: (into) => {
      const loud = level();
      const vowel = noise(syllable(at()) + 0.5) * (into.length - 3);
      for (let b = 0; b < into.length; b++) into[b] = loud * Math.exp(-(((b - vowel) / 1.6) ** 2));
    },
  };
}

const IDLE: CallState = {
  phase: "idle",
  call: null,
  muted: false,
  talking: false,
  speaking: "none",
  thinking: false,
  caption: null,
  handedAt: null,
  answered: false,
  liveAt: null,
  error: null,
  elsewhere: null,
  incoming: null,
  missed: [],
  ended: null,
  chiefId: undefined,
};
const LIVE: CallState = { ...IDLE, phase: "live", answered: true, liveAt: Date.now() - 42_000 };
const MOMENTS = {
  Calling: { ...IDLE, phase: "calling" },
  Listening: {
    ...LIVE,
    caption: { who: "chief", text: "Morning. Dark mode for runs is ready for you to look at." },
  },
  "You talking": {
    ...LIVE,
    speaking: "person",
    caption: { who: "person", text: "Add a waveform to the call screen" },
  },
  Thinking: {
    ...LIVE,
    thinking: true,
    caption: { who: "person", text: "Add a waveform to the call screen, and make it smooth." },
  },
  "Chief talking": {
    ...LIVE,
    speaking: "chief",
    caption: { who: "chief", text: "On it. I'll ring you when it's ready to look at." },
  },
  Muted: {
    ...LIVE,
    muted: true,
    caption: { who: "chief", text: "On it. I'll ring you when it's ready to look at." },
  },
  Ended: { ...IDLE, ended: { reason: "person", ms: 134_000 } },
} satisfies Record<string, CallState>;
type Moment = keyof typeof MOMENTS;
const PHASES: readonly DictationPhase[] = ["idle", "starting", "live", "finishing"];

function Lab() {
  const [moment, setMoment] = useState<Moment>(
    () =>
      (Object.keys(MOMENTS) as Moment[]).find((m) => m === ASKED.get("moment")) ?? "Chief talking",
  );
  const [phase, setPhase] = useState<DictationPhase>(
    () => PHASES.find((p) => p === ASKED.get("phase")) ?? "live",
  );
  const [phone, setPhone] = useState(ASKED.has("phone"));
  const [sound, setSound] = useState(false);
  const [mic, setMic] = useState<ReturnType<typeof hear> | null>(null);
  // The microphone it holds is let go when it is turned off or replaced, and when the lab goes.
  useEffect(() => () => mic?.close(), [mic]);
  // The call's sounds on a real audio graph, made on the first click (a page may not start audio before one).
  const audio = useRef<{ ctx: AudioContext; sounds: CallSounds } | null>(null);
  const ring = useRef<Ring | null>(null);
  const heard = useRef<WaveSource>(SILENT);

  const sounds = (loud: boolean) => {
    if (audio.current && loud === sound) return audio.current.sounds;
    void audio.current?.ctx.close();
    // Sound off: the same graph into no speaker, so the line still draws what would play.
    const ctx = new AudioContext({
      latencyHint: "interactive",
      ...(loud ? {} : { sinkId: { type: "none" } }),
    } as AudioContextOptions);
    audio.current = { ctx, sounds: new CallSounds(ctx) };
    audio.current.sounds.unlock();
    heard.current = audio.current.sounds.heard;
    return audio.current.sounds;
  };
  const show = (next: Moment, loud = sound) => {
    ring.current?.stop();
    ring.current = next === "Calling" ? sounds(loud).ring() : null;
    if (next === "Ended" && moment !== "Ended") sounds(loud).hangUp();
    if (next === "Muted" || (moment === "Muted" && next !== "Ended"))
      sounds(loud).tick(next !== "Muted");
    setMoment(next);
  };
  useEffect(() => () => void (ring.current?.stop(), audio.current?.ctx.close()), []);

  const listen = async () => {
    if (mic) return setMic(null);
    const ctx = sounds(sound).ctx;
    setMic(hear(ctx, await navigator.mediaDevices.getUserMedia({ audio: true })));
  };

  // The scripted you talks only in "You talking" (and into the mic's pill); your own microphone is always open.
  const talking = moment === "You talking";
  const you = useMemo(() => mic ?? scripted(1), [mic]);
  const signal = useMemo<CallSignal>(() => {
    return {
      mic: mic || talking ? you : SILENT,
      // With your microphone on, the Chief's line is your voice too: the bright wave, tried by talking.
      voice: mic ?? scripted(2),
      sounds: { level: () => heard.current.level(), bands: (into) => heard.current.bands(into) },
    };
  }, [mic, you, talking]);
  const state = MOMENTS[moment];

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-[260px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border p-4 text-[13px]">
        <div>
          <h1 className="text-[15px] font-semibold">Voice lab</h1>
          <p className="mt-1 text-muted-foreground">
            The call in the box, the ring-back card and the dictating mic, as they ship.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[12px] text-muted-foreground">The call</h2>
          {(Object.keys(MOMENTS) as Moment[]).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={m === moment ? "default" : "secondary"}
              onClick={() => show(m)}
            >
              {m}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[12px] text-muted-foreground">Dictation</h2>
          {PHASES.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={p === phase ? "default" : "secondary"}
              onClick={() => setPhase(p)}
            >
              {p}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[12px] text-muted-foreground">Sound</h2>
          <Button size="sm" variant={mic ? "default" : "secondary"} onClick={() => void listen()}>
            {mic ? "Using your microphone" : "Use my microphone"}
          </Button>
          <Button
            size="sm"
            variant={sound ? "default" : "secondary"}
            onClick={() => {
              setSound(!sound);
              show(moment, !sound);
            }}
          >
            {sound ? "Sound on" : "Sound off"}
          </Button>
          <Button
            size="sm"
            variant={phone ? "default" : "secondary"}
            onClick={() => setPhone(!phone)}
          >
            {phone ? "On a phone" : "In the box"}
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col items-center gap-8 overflow-y-auto p-8">
        {phone ? (
          <div className="relative h-[720px] w-[380px] shrink-0 overflow-hidden rounded-[36px] border border-border [transform:translateZ(0)]">
            <CallStage state={state} signal={signal} />
          </div>
        ) : (
          <div className="w-full max-w-[792px]">
            <CallBox state={state} signal={signal} />
          </div>
        )}
        <div className="flex w-full max-w-[792px] items-center justify-end gap-1 rounded-2xl border border-border bg-card px-3 py-2">
          <span className="mr-auto text-[13px] text-muted-foreground">
            {phase === "live" ? "Listening… talk, and the words land here" : "Ask anything"}
          </span>
          <MicButton
            phase={phase}
            shortcut="mod+shift+space"
            source={you}
            onToggle={() =>
              setPhase(phase === "idle" ? "starting" : phase === "starting" ? "live" : "idle")
            }
          />
          <SendKey
            mode="idle"
            label="Send"
            ariaLabel="Send"
            onSend={() => undefined}
            onStop={() => undefined}
          />
        </div>
        <IncomingCallCard
          inline
          line="Dark mode for runs is ready for you to look at. Want me to walk you through it?"
          onAnswer={() => show("Listening")}
          onLater={() => undefined}
          onMute={() => undefined}
        />
      </main>
    </div>
  );
}

createRoot(document.getElementById("lab")!).render(
  <MemoryRouter>
    <RuntimeContext.Provider value={runtime}>
      <TooltipProvider>
        <Lab />
      </TooltipProvider>
    </RuntimeContext.Provider>
  </MemoryRouter>,
);
