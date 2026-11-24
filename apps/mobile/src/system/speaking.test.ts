// Talking out loud (system/speaking.ts): a line as it's said, the voice it's said in, the microphone's level, and the
// agent's reply to what voice chat sent.
import { describe, expect, it } from "vitest";
import type { Item } from "../board/model";
import { ackFor, bestVoice, forSpeech, levelOf, readingMs, replyTo, smooth, voiceRank, type VoiceInfo } from "./speaking";

describe("forSpeech", () => {
  it("says markdown as plain words", () => {
    expect(forSpeech("Merged **#491**. CI was `green`.")).toBe("Merged number 491. CI was green.");
    expect(forSpeech("See [the runs page](https://example.com/runs) → done")).toBe("See the runs page to done.");
    expect(forSpeech("Read https://github.com/caveman/app/pull/12 first")).toBe("Read github.com first.");
    expect(forSpeech("_quietly_ and __loudly__")).toBe("quietly and loudly.");
  });

  it("drops code and makes lines and list items sentences", () => {
    expect(forSpeech("Done:\n```ts\nconst x = 1;\n```\n- Fixed the timeout\n- Added a test")).toBe("Done: Fixed the timeout. Added a test.");
    expect(forSpeech("## Summary\n2 need you · 1 working")).toBe("Summary. 2 need you, 1 working.");
  });

  it("cuts a long reply where a sentence ends", () => {
    const long = `${"This is a sentence that goes on for a while. ".repeat(12)}`;
    const said = forSpeech(long);
    expect(said.length).toBeLessThanOrEqual(320);
    expect(said.endsWith(".")).toBe(true);
    const runOn = "word ".repeat(100);
    expect(forSpeech(runOn, 40).endsWith("…")).toBe(true);
  });

  it("says nothing for nothing", () => {
    expect(forSpeech("   \n ")).toBe("");
  });
});

describe("the voice", () => {
  const v = (identifier: string, language: string, quality = "Default", name = identifier.split(".").at(-1) ?? ""): VoiceInfo => ({ identifier, language, quality, name });
  const voices = [
    v("com.apple.voice.compact.en-US.Samantha", "en-US"),
    v("com.apple.speech.synthesis.voice.Fred", "en-US"),
    v("com.apple.eloquence.en-US.Rocko", "en-US"),
    v("com.apple.voice.enhanced.en-GB.Daniel", "en-GB", "Enhanced"),
    v("com.apple.voice.premium.en-US.Zoe", "en-US"),
    v("com.apple.voice.premium.fr-FR.Audrey", "fr-FR"),
  ];

  it("picks premium over enhanced over compact, never a novelty voice or another language", () => {
    expect(bestVoice(voices)?.identifier).toBe("com.apple.voice.premium.en-US.Zoe");
    expect(bestVoice(voices.filter((x) => !x.identifier.includes("premium")))?.identifier).toBe("com.apple.voice.enhanced.en-GB.Daniel");
    expect(voiceRank(voices[1]!)).toBeLessThan(0);
    expect(voiceRank(voices[2]!)).toBeLessThan(0);
    expect(voiceRank(voices[5]!)).toBeLessThan(0);
    expect(bestVoice([voices[1]!, voices[5]!])).toBeNull();
  });

  it("prefers the phone's own English at the same quality", () => {
    const two = [v("com.apple.voice.enhanced.en-US.Evan", "en-US", "Enhanced"), v("com.apple.voice.enhanced.en-GB.Daniel", "en-GB", "Enhanced")];
    expect(bestVoice(two)?.language).toBe("en-US");
    expect(bestVoice(two, "GB")?.language).toBe("en-GB");
  });
});

describe("the microphone's level", () => {
  it("maps decibels to 0..1", () => {
    expect(levelOf(-160)).toBe(0);
    expect(levelOf(-55)).toBe(0);
    expect(levelOf(-35)).toBeCloseTo(0.5);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(undefined)).toBe(0);
    expect(levelOf(Number.NaN)).toBe(0);
  });

  it("rises fast and falls slowly", () => {
    expect(smooth(0, 1)).toBeCloseTo(0.7);
    expect(smooth(1, 0)).toBeCloseTo(0.7);
  });
});

describe("what voice chat hears back", () => {
  const you = (text: string, at: number): Item => ({ kind: "you", id: `y${at}`, text, at });
  const said = (text: string, at: number): Item => ({ kind: "text", id: `t${at}`, text, at });

  it("finds the chat it went to, then the agent's first words after it", () => {
    const chats = [
      { id: "other", items: [you("Make the relay test stop flaking", 100), said("Old answer", 200)] },
      { id: "new", items: [you("Make the relay  test stop flaking", 1000)] },
    ];
    expect(replyTo(chats, "make the relay test stop flaking", 1000)).toEqual({ chat: "new", text: null });
    const answered = [chats[0]!, { id: "new", items: [...chats[1]!.items, { kind: "work" as const, id: "w", steps: [], startedAt: 1100 }, said("Fixed it. Try it.", 1200)] }];
    expect(replyTo(answered, "Make the relay test stop flaking", 1000)).toEqual({ chat: "new", text: "Fixed it. Try it." });
  });

  it("is nothing until the message is on the board", () => {
    expect(replyTo([{ id: "a", items: [you("Something else", 1000)] }], "Ship it", 1000)).toBeNull();
    expect(replyTo([{ id: "a", items: [you("Ship it", 10)] }], "Ship it", 5000)).toBeNull();
    expect(replyTo([{ id: "a", items: [you("Ship it", 5000)] }], "  ", 5000)).toBeNull();
  });

  it("acknowledges in turn, and reads as long as a bubble did", () => {
    expect(ackFor(0)).toBe("On it.");
    expect(ackFor(5)).not.toBe(ackFor(4));
    expect(readingMs("one two")).toBe(2800);
    expect(readingMs(Array(20).fill("w").join(" "))).toBe(5600);
  });
});
