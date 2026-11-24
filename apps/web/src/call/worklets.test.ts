import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// public/call-worklets.js runs in an AudioWorkletGlobalScope: given its globals, it runs here as is.
const loadProcessors = (rate: number) => {
  const processors = new Map<string, new (options: unknown) => { port: { postMessage(data: ArrayBuffer, transfer: ArrayBuffer[]): void }; process(inputs: Float32Array[][]): boolean }>();
  const source = readFileSync(new URL("../../public/call-worklets.js", import.meta.url), "utf8");
  class AudioWorkletProcessor {
    port = { postMessage: (_data: ArrayBuffer, _transfer: ArrayBuffer[]) => {}, onmessage: null };
  }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source)(AudioWorkletProcessor, (name: string, ctor: never) => processors.set(name, ctor), rate);
  return processors;
};

describe("the capture worklet", () => {
  test("keeps sending full 20 ms frames after the first one's buffer is transferred", () => {
    const Capture = loadProcessors(48_000).get("caveman-capture")!;
    const capture = new Capture({ processorOptions: { rate: 16_000 } });
    const frames: number[] = [];
    // A real port detaches what it transfers, as structuredClone does.
    capture.port.postMessage = (data, transfer) => frames.push(new Int16Array(structuredClone(data, { transfer })).length);
    const quantum = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 4) * 0.5);
    // 100 ms of input at 48 kHz.
    for (let i = 0; i < 4_800 / 128; i++) capture.process([[quantum]]);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.every((n) => n === 320)).toBe(true);
  });
});
