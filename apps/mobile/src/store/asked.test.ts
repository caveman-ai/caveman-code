// An approval prints its command once (asked.ts): the step for the command that waits is held back while the card is
// up and comes back once it is answered, and an ask whose words are only its command is told apart from one that says
// what the command is for.
import { describe, expect, it } from "vitest";
import type { Item, Step } from "../board/model";
import { askedStep, heldBack, saysOnly, stepsBeforeAsk } from "./asked";

const run = (text: string): Step => ({ tool: "run", text });
const work = (id: string, steps: readonly Step[]): Item => ({
  kind: "work",
  id,
  steps,
  startedAt: 1,
});
const you: Item = { kind: "you", id: "you", text: "say: smoke", at: 0 };

describe("an ask's words", () => {
  it("say only the command when they are the command, or the command after Run", () => {
    expect(saysOnly("echo smoke?", "echo smoke")).toBe(true);
    expect(saysOnly("Run echo smoke?", "echo smoke")).toBe(true);
    expect(saysOnly("Ran echo smoke", "echo smoke")).toBe(true);
    expect(saysOnly("$ echo  smoke", "echo smoke")).toBe(true);
    expect(saysOnly("Echo Smoke", "echo smoke")).toBe(true);
  });
  it("keep a command that itself starts with run, or ends on a question mark", () => {
    expect(saysOnly("run tests?", "run tests")).toBe(true);
    expect(saysOnly("ls build?", "ls build?")).toBe(true);
  });
  it("say more than the command when they say what it is for", () => {
    expect(saysOnly("Run a migration on staging?", "pnpm db:migrate --env staging")).toBe(false);
    expect(saysOnly("Add a package?", "pnpm add react-native-keyboard-controller")).toBe(false);
    expect(saysOnly("Bash", "echo smoke")).toBe(false);
  });
  it("never match an empty command", () => {
    expect(saysOnly("", "")).toBe(false);
    expect(saysOnly("Keep the legacy flag?", "")).toBe(false);
  });
});

describe("the step an open approval would print twice", () => {
  const step = run("echo smoke");
  const read: Step = { tool: "read", text: "Read smoke.md" };

  it("is the last step above the ask, when it is the command that waits", () => {
    const items: Item[] = [
      you,
      work("w", [read, step]),
      { kind: "ask", id: "a", command: "echo smoke" },
    ];
    expect(askedStep(items)).toBe(step);
  });
  it("comes back once the ask is answered, allowed or denied", () => {
    expect(
      askedStep([
        you,
        work("w", [step]),
        { kind: "ask", id: "a", command: "echo smoke", answer: "allowed" },
      ]),
    ).toBeNull();
    expect(
      askedStep([
        you,
        work("w", [step]),
        { kind: "ask", id: "a", command: "echo smoke", answer: "denied" },
      ]),
    ).toBeNull();
  });
  it("comes back once you answered, before its computer has heard", () => {
    expect(
      askedStep([
        you,
        work("w", [step]),
        { kind: "ask", id: "a", command: "echo smoke", pending: "Allow queued · waking Cloud" },
      ]),
    ).toBeNull();
  });
  it("comes back when the ask goes without an answer", () => {
    expect(askedStep([you, work("w", [step])])).toBeNull();
  });
  it("is nothing when the step above is another command, or not a command", () => {
    expect(
      askedStep([
        you,
        work("w", [run("pnpm test")]),
        { kind: "ask", id: "a", command: "echo smoke" },
      ]),
    ).toBeNull();
    expect(
      askedStep([
        you,
        work("w", [{ tool: "read", text: "echo smoke" }]),
        { kind: "ask", id: "a", command: "echo smoke" },
      ]),
    ).toBeNull();
  });
  it("is only ever the last step: the same command earlier in the run stays", () => {
    const earlier = run("echo smoke");
    const items: Item[] = [
      you,
      work("w", [earlier, read, step]),
      { kind: "ask", id: "a", command: "echo smoke" },
    ];
    expect(askedStep(items)).toBe(step);
    expect(askedStep(items)).not.toBe(earlier);
  });
  it("is nothing for a question, and when words stand between the step and the ask", () => {
    expect(
      askedStep([
        you,
        work("w", [step]),
        { kind: "ask", id: "a", command: "", question: "Keep the legacy flag?" },
      ]),
    ).toBeNull();
    expect(
      askedStep([
        you,
        work("w", [step]),
        { kind: "text", id: "t", text: "One more thing first.", at: 2 },
        { kind: "ask", id: "a", command: "echo smoke" },
      ]),
    ).toBeNull();
  });
  it("reads the ask that waits now, not one answered before it", () => {
    const again = run("echo smoke");
    const items: Item[] = [
      you,
      work("w1", [step]),
      { kind: "ask", id: "a1", command: "echo smoke", answer: "allowed" },
      work("w2", [again]),
      { kind: "ask", id: "a2", command: "echo smoke" },
    ];
    expect(askedStep(items)).toBe(again);
  });
});

describe("what the board holds back", () => {
  const step = run("echo smoke");
  const items: Item[] = [you, work("w", [step]), { kind: "ask", id: "a", command: "echo smoke" }];

  it("is the step of each chat that waits on you", () => {
    const held = heldBack([{ phase: "needs", items }]);
    expect(held.has(step)).toBe(true);
    expect(held.size).toBe(1);
  });
  it("is nothing for a chat that no longer waits, whatever its transcript still holds", () => {
    expect(heldBack([{ phase: "working", items }]).size).toBe(0);
    expect(heldBack([{ phase: "done", items }]).size).toBe(0);
  });
  it("never holds back the same words in another chat", () => {
    const other = run("echo smoke");
    const held = heldBack([
      { phase: "needs", items },
      { phase: "done", items: [you, work("w", [other])] },
    ]);
    expect(held.has(other)).toBe(false);
  });
});

describe("the steps a card lists over an ask", () => {
  const read: Step = { tool: "read", text: "Read smoke.md" };
  const step = run("echo smoke");

  it("are what it did since your last message, without the command the ask's own chip says", () => {
    const earlier = work("w0", [run("pnpm install")]);
    const items: Item[] = [
      earlier,
      you,
      work("w1", [read]),
      work("w2", [run("pnpm test"), step]),
      { kind: "ask", id: "a", command: "echo smoke" },
    ];
    // The command reads once, on the ask; nothing from before your message is listed.
    expect(stepsBeforeAsk(items)).toEqual([read, run("pnpm test")]);
  });
  it("keep every step where the ask says what the command is for, or asks a question", () => {
    expect(
      stepsBeforeAsk([
        you,
        work("w", [read, step]),
        { kind: "ask", id: "a", command: "pnpm db:migrate --env staging" },
      ]),
    ).toEqual([read, step]);
    expect(
      stepsBeforeAsk([
        you,
        work("w", [read, step]),
        { kind: "ask", id: "a", command: "", question: "Keep the legacy flag?" },
      ]),
    ).toEqual([read, step]);
  });
  it("list the command again once the ask is answered: the step is then its one place", () => {
    expect(
      stepsBeforeAsk([
        you,
        work("w", [read, step]),
        { kind: "ask", id: "a", command: "echo smoke", answer: "allowed" },
      ]),
    ).toEqual([read, step]);
  });
});
