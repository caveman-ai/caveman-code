// The fold as data (fold.ts): a finished turn keeps only its answer out of the fold (and a roster still out), an
// opened turn says each item once in order, and a search hit finds its turn and the fold to open.
import { describe, expect, it } from "vitest";
import type { Item } from "../board/model";
import { locate, planChat, planTurn, stoppedAfter, turnsOf } from "./fold";

const T0 = 1_700_000_000_000;
const you = (id: string, text: string, at: number): Item => ({ kind: "you", id, text, at });
const said = (id: string, text: string, at: number, phase?: "commentary" | "final"): Item => ({ kind: "text", id, text, at, phase });
const run = (id: string, startedAt: number, endedAt?: number): Item => ({ kind: "work", id, steps: [{ tool: "edit", text: "Edited ChiefChat.tsx", detail: "+3 −40" }], startedAt, endedAt });

// The fold chat's "Sorry, wrong one" turn: commentary that says what it will do, its run, a short final answer.
const shortAnswer: Item[] = [
  you("u1", "Sorry, wrong one. Leave the Chief for now, just the thread.", T0),
  said("c1", "Okay. I'll put ChiefChat.tsx back the way it was.", T0 + 2_000, "commentary"),
  run("w1", T0 + 3_000, T0 + 170_000),
  said("a1", "ChiefChat.tsx is back as it was; only the thread folds. Nothing else moved.", T0 + 180_000, "final"),
];

describe("a finished turn", () => {
  it("keeps only its final answer out of the fold, however short the answer", () => {
    const [plan] = planChat({ items: shortAnswer, phase: "ready" });
    expect(plan!.state).toBe("finished");
    const kept = plan!.segments.flatMap((s) => s.kept.map((k) => k.item.id));
    expect(kept).toEqual(["a1"]);
  });

  it("keeps a roster out of the fold only while one of its children is still out", () => {
    const items: Item[] = [...shortAnswer.slice(0, 3), { kind: "agents", id: "g1", children: ["k1", "k2"] }, shortAnswer[3]!];
    const working = planChat({ items, phase: "ready" }, (id) => (id === "k2" ? "working" : "done"))[0]!;
    expect(working.segments.flatMap((s) => s.kept.map((k) => k.item.id))).toEqual(["g1", "a1"]);
    const done = planChat({ items, phase: "ready" }, () => "done")[0]!;
    expect(done.segments.flatMap((s) => s.kept.map((k) => k.item.id))).toEqual(["a1"]);
  });

  it("opened, says each item exactly once, in the order it happened", () => {
    const [plan] = planChat({ items: shortAnswer, phase: "ready" });
    const order: string[] = [];
    for (const seg of plan!.segments) {
      for (const item of seg.folded) order.push(item.id);
      for (const k of seg.kept) order.push(k.item.id);
    }
    expect(order).toEqual(["c1", "w1", "a1"]);
    expect(new Set(order).size).toBe(order.length);
  });

  it("splits at a steer, the steer itself in neither fold", () => {
    const items: Item[] = [
      you("u1", "Fold the turns", T0),
      run("w1", T0 + 1_000, T0 + 60_000),
      { kind: "you", id: "s1", text: "Also the Chief", at: T0 + 90_000, steer: true },
      run("w2", T0 + 91_000, T0 + 150_000),
      said("a1", "Both fold now.", T0 + 160_000, "final"),
    ];
    // Marked a steer when it was sent, it joins the turn it steered.
    const turn = turnsOf(items)[0]!;
    const plan = planTurn(turn, { latest: true, chat: { phase: "ready" }, before: null });
    expect(plan.segments.map((s) => s.folded.map((i) => i.id))).toEqual([["w1"], ["w2"]]);
    expect(plan.segments[1]!.steer?.id).toBe("s1");
  });
});

describe("a search hit inside a chat", () => {
  const chat = [
    ...shortAnswer,
    you("u2", "Add a date line", T0 + 4_000_000),
    said("c2", "I'll measure the gap in 48s.", T0 + 4_001_000, "commentary"),
    run("w2", T0 + 4_002_000, T0 + 4_050_000),
    said("a2", "Done.", T0 + 4_060_000, "final"),
    you("u3", "Thanks", T0 + 5_000_000),
    said("a3", "Any time.", T0 + 5_001_000, "final"),
  ];
  it("finds its turn, and the fold to open when it is folded away", () => {
    const plans = planChat({ items: chat, phase: "ready" });
    // The turn before the latest, which the chat opens without (it is paged in), its commentary under the fold.
    expect(locate(plans, "c2")).toEqual({ index: 1, key: "u2", folds: ["u2:0"] });
  });
  it("finds words that are out of any fold without opening one", () => {
    const plans = planChat({ items: chat, phase: "ready" });
    expect(locate(plans, "a2")).toEqual({ index: 1, key: "u2", folds: [] });
    expect(locate(plans, "u1")).toEqual({ index: 0, key: "u1", folds: [] });
    expect(locate(plans, "nope")).toBeNull();
  });
});

describe("the line a stopped turn ends on", () => {
  it("says you stopped it where you did, and only that it stopped where nobody is known to have", () => {
    expect(stoppedAfter(41_000)).toBe("You stopped after 41s");
    expect(stoppedAfter(null)).toBe("You stopped it");
    // A computer's chat: its runtime does not say who stopped a turn (you on another device, or the computer itself).
    expect(stoppedAfter(41_000, true)).toBe("Stopped after 41s");
    expect(stoppedAfter(null, true)).toBe("Stopped");
  });
});
