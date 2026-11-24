// A call's audio, both ways, on one AudioContext: the microphone, cleaned by the browser (echo cancellation, noise
// suppression, gain) and cut into 20 ms frames of 16-bit PCM at the engine's rate; and the voice, played from a small
// jitter buffer that stops the instant the person talks over it. Both run in AudioWorklets, off the main thread.
// What the call's wave draws comes from two analysers (meter), read once a frame without touching React. Dictation
// takes the microphone half alone (openCapture).
import { BANDS, type WaveSource } from "./wave.ts";

// The worklets are a file of the app's own (public/), not a blob: URL. Chromium checks a worklet module against
// script-src, and the desktop's CSP allows only 'self' there.
const WORKLETS_URL = "./call-worklets.js";

/** The microphone as the browser hands it over for a call: one channel, echo cancelled, noise suppressed. */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
};

/** The microphone, asked for the way the desktop needs (macOS's own permission first). MicBlocked: refused. */
export async function microphone(): Promise<MediaStream> {
  const desktop = window.cavemanDesktop?.microphone;
  if (desktop) {
    const status = await desktop.status();
    if (status === "not-determined" ? !(await desktop.ask()) : status === "denied" || status === "restricted") throw new MicBlocked();
  }
  try {
    return await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) throw new MicBlocked();
    throw error;
  }
}
export class MicBlocked extends Error {}

/** An analyser over 21 ms of sound: long enough that a low voice's own pitch doesn't flutter its level. */
export function analyserOn(ctx: BaseAudioContext): AnalyserNode {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.55;
  return analyser;
}

/**
 * What a wave draws from an analyser: the root-mean-square of its last frame, shaped so speech sits in the middle of
 * 0..1, and its spectrum below 4 kHz (where speech lives) in bands. `gain` lifts a quiet bus into the same range.
 */
export function meter(analyser: AnalyserNode, gain = 1): WaveSource {
  const samples = new Float32Array(analyser.fftSize);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const top = Math.max(BANDS, Math.round((4_000 / (analyser.context.sampleRate / 2)) * bins.length));
  return {
    level: () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4.5 * gain);
    },
    bands: (into) => {
      analyser.getByteFrequencyData(bins);
      for (let b = 0; b < into.length; b++) {
        const from = Math.floor((b / into.length) * top);
        const to = Math.max(from + 1, Math.floor(((b + 1) / into.length) * top));
        let sum = 0;
        for (let i = from; i < to; i++) sum += bins[i]!;
        into[b] = Math.min(1, (sum / (to - from) / 200) * gain);
      }
    },
  };
}

/** The microphone as a wave and nothing more (the voice lab's): `close` lets go of its node and the microphone. */
export function hear(ctx: AudioContext, stream: MediaStream): WaveSource & { close(): void } {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = analyserOn(ctx);
  source.connect(analyser);
  return {
    ...meter(analyser),
    close: () => {
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

export interface CallMedia {
  /** Each 20 ms frame of the person's voice, as 16-bit PCM at the input rate. */
  onFrame: ((pcm: ArrayBuffer) => void) | null;
  /** The voice started or stopped sounding. */
  onPlaying: ((playing: boolean) => void) | null;
  /** The voice's audio, 16-bit PCM at the output rate. */
  play(pcm: ArrayBuffer): void;
  /** Silence the voice now (the person talked over it). */
  flush(): void;
  /** Hold the voice back (the ring plays through first), then let it go. */
  hold(held: boolean): void;
  readonly playing: boolean;
  /** Resolves once the voice has played out what it was given (at most `maxMs`). */
  drained(maxMs: number): Promise<void>;
  /** For the stage's wave: the person's side and the voice's, as they sound right now. */
  readonly mic: WaveSource;
  readonly voice: WaveSource;
  close(): void;
}

/** The microphone alone: 20 ms frames of 16-bit PCM at `rate`, and how it sounds right now (for the mic's wave). */
export interface Capture extends WaveSource {
  onFrame: ((pcm: ArrayBuffer) => void) | null;
  /** Lets go of the nodes and the microphone. */
  close(): void;
}

/** The capture half of a call's audio, wired on `ctx`: the mic into the capture worklet, and an analyser for its level. */
async function micChain(ctx: AudioContext, stream: MediaStream, rate: number) {
  await ctx.audioWorklet.addModule(WORKLETS_URL);
  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, "caveman-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate } });
  const analyser = analyserOn(ctx);
  // The capture node has to be pulled to run: into a muted gain, so the person never hears themselves.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  source.connect(capture).connect(sink).connect(ctx.destination);
  return { source, capture, analyser, sink };
}

export async function openCapture(ctx: AudioContext, stream: MediaStream, rate: number): Promise<Capture> {
  const { source, capture, analyser, sink } = await micChain(ctx, stream, rate);
  const mic: Capture = {
    onFrame: null,
    ...meter(analyser),
    close: () => {
      for (const node of [source, capture, analyser, sink]) node.disconnect();
      capture.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
    },
  };
  capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => mic.onFrame?.(e.data);
  return mic;
}

export async function openMedia(ctx: AudioContext, stream: MediaStream, rates: { readonly input: number; readonly output: number }): Promise<CallMedia> {
  const { source, capture, analyser: micAnalyser, sink } = await micChain(ctx, stream, rates.input);
  const player = new AudioWorkletNode(ctx, "caveman-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate: rates.output } });
  const voiceAnalyser = analyserOn(ctx);
  player.connect(voiceAnalyser);
  player.connect(ctx.destination);

  let playing = false;
  let waiting: Array<() => void> = [];
  const media: CallMedia = {
    onFrame: null,
    onPlaying: null,
    play: (pcm) => player.port.postMessage(pcm, [pcm]),
    flush: () => player.port.postMessage("flush"),
    hold: (held) => player.port.postMessage(held ? "hold" : "release"),
    get playing() {
      return playing;
    },
    drained: (maxMs) =>
      playing
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, maxMs);
            waiting.push(() => (clearTimeout(timer), resolve()));
          })
        : Promise.resolve(),
    mic: meter(micAnalyser),
    voice: meter(voiceAnalyser),
    close: () => {
      for (const node of [source, capture, player, micAnalyser, voiceAnalyser, sink]) node.disconnect();
      capture.port.onmessage = null;
      player.port.onmessage = null;
      for (const track of stream.getTracks()) track.stop();
      waiting.forEach((done) => done());
      waiting = [];
    },
  };
  capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => media.onFrame?.(e.data);
  player.port.onmessage = (e: MessageEvent<string>) => {
    playing = e.data === "playing";
    media.onPlaying?.(playing);
    if (!playing) {
      waiting.forEach((done) => done());
      waiting = [];
    }
  };
  return media;
}
