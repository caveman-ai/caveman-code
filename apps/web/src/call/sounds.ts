// A call's sounds, synthesized on the call's own AudioContext (no files to fetch, so the ring starts on the click).
// Everything is one soft, round note in a low register: slow to start, no click, no noise, a long quiet tail in a room.
// The ring is two of them rising a fifth, which loops while the call connects and always plays through once, so a fast
// connect never sounds like a glitch. The Chief ringing back is the same two a little higher. Hanging up is the two
// falling. Mute and unmute are one short note each.
import { analyserOn, meter } from "./media.ts";
import type { WaveSource } from "./wave.ts";

/** E4 and B4. */
const LOW = 329.63;
const HIGH = 493.88;
/** The Chief calling you: the same fifth, a fourth up (A4, E5). */
const BACK = 4 / 3;
/** Seconds between a ring's two notes. */
const NOTE_GAP_S = 0.24;
/** One ring, first note to where the second has mostly died: the voice may speak from here. */
export const RING_CYCLE_S = 1;
/** A ring that keeps going starts again this often. */
const RING_EVERY_S = 3;
/** How loud everything a call plays is, beside the voice. */
const OUT_GAIN = 0.2;

export interface Ring {
  /** Resolves once the first ring has played through: the voice speaks after it. */
  readonly first: Promise<void>;
  /** Stops at once, with a short fade (no click). */
  readonly stop: () => void;
}

/** The call's speakers: a master gain, a top cut and a soft room. Everything a call plays goes through here. */
export class CallSounds {
  readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly bus: GainNode;
  /** What these sounds look like right now: the stage's wave draws the ring and the hang-up as they play. */
  readonly heard: WaveSource;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = OUT_GAIN;
    const analyser = analyserOn(ctx);
    this.out.connect(analyser);
    // Read after the master gain, so it is lifted back to how the sounds were written.
    this.heard = meter(analyser, 1 / OUT_GAIN);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3_200;
    const room = ctx.createConvolver();
    room.buffer = roomOf(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    this.bus = ctx.createGain();
    this.bus.connect(tone);
    tone.connect(this.out);
    tone.connect(room).connect(wet).connect(this.out);
    this.out.connect(ctx.destination);
  }

  /** The browser plays nothing until a gesture resumes the context: call this from the click. */
  unlock(): void {
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
  }

  /**
   * One soft note: the fundamental, a copy a few cents sharp (a slow shimmer instead of a flat beep) and a quiet octave
   * that dies first. It swells in over `attack` seconds, so there is no click, and falls away with time constant `decay`.
   */
  private note(at: number, freq: number, level: number, decay: number, into: AudioNode, attack = 0.02): void {
    const { ctx } = this;
    const partial = (hz: number, gain: number, tau: number) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(gain, at + attack);
      env.gain.setTargetAtTime(0, at + attack, tau);
      osc.connect(env).connect(into);
      osc.start(at);
      osc.stop(at + attack + tau * 8);
    };
    partial(freq, level * 0.62, decay);
    partial(freq * 1.0023, level * 0.3, decay);
    partial(freq * 2, level * 0.08, decay * 0.5);
  }

  /** Rings until stopped: two notes, rising. `back` is the ring back (the Chief calling you): the same two, a little higher. */
  ring(options: { readonly back?: boolean } = {}): Ring {
    const { ctx } = this;
    const voice = ctx.createGain();
    voice.gain.value = 1;
    voice.connect(this.bus);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let stopped = false;
    const key = options.back ? BACK : 1;
    const cycle = (at: number) => {
      this.note(at, LOW * key, 0.5, 0.26, voice);
      this.note(at + NOTE_GAP_S, HIGH * key, 0.6, 0.36, voice);
    };
    const start = ctx.currentTime + 0.02;
    let next = start;
    // Each ring is scheduled a beat ahead of when it plays, on the audio clock: no drift, no gaps.
    const schedule = () => {
      if (stopped) return;
      cycle(next);
      next += RING_EVERY_S;
      timers.push(setTimeout(schedule, Math.max(0, (next - ctx.currentTime - 0.25) * 1000)));
    };
    schedule();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => (resolveFirst = resolve));
    timers.push(setTimeout(resolveFirst, (start + RING_CYCLE_S - ctx.currentTime) * 1000));
    return {
      first,
      stop: () => {
        if (stopped) return;
        stopped = true;
        timers.forEach(clearTimeout);
        resolveFirst();
        // Fades under whatever comes next (the voice, the hang-up) instead of being cut.
        const t = ctx.currentTime;
        voice.gain.cancelScheduledValues(t);
        voice.gain.setValueAtTime(voice.gain.value, t);
        voice.gain.setTargetAtTime(0, t, 0.07);
        setTimeout(() => voice.disconnect(), 700);
      },
    };
  }

  /** Hanging up: the ring's two notes, falling. */
  hangUp(): void {
    const at = this.ctx.currentTime + 0.02;
    this.note(at, HIGH, 0.45, 0.2, this.bus);
    this.note(at + 0.2, LOW, 0.5, 0.4, this.bus);
  }

  /** The call picked up: one quiet, short note right before the voice. */
  pickUp(): void {
    this.note(this.ctx.currentTime + 0.01, HIGH * BACK, 0.2, 0.09, this.bus, 0.01);
  }

  /** Mute (lower) and unmute (higher). */
  tick(on: boolean): void {
    this.note(this.ctx.currentTime + 0.01, on ? HIGH : LOW, 0.3, 0.06, this.bus, 0.008);
  }
}

/** A soft room to ring in: 1.2 s of noise dying away, different in each ear. Seeded, so every call has the same room. */
function roomOf(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.round(ctx.sampleRate * 1.2);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 7;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.22));
    }
  }
  return buffer;
}
