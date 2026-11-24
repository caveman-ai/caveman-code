import * as fs from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { type AskInput, type Hist, newHist, REPLY_RUNES, replyTail } from "./features.ts";
import { lastRunes, runeCount } from "./goText.ts";
import { classifyTask } from "./index.ts";
import { loadAskModel, type Model, routedLevel } from "./model.ts";

// testdata/ is Caveman Cloud's parity fixture (gateway-managed/internal/askmodel/testdata): asks written for the test
// in the research ask-record schema, and what the research's reference binary answers for them.
interface FixtureAsk {
  readonly id: string;
  readonly source: string;
  readonly sid: string;
  readonly text: string;
  readonly prev_text: string;
  readonly prev_asst: string;
  readonly turn_idx: number;
  readonly harness: string;
  readonly slash: number;
  readonly ts: string;
  readonly n_req: number | null;
  readonly n_tool: number | null;
  readonly n_edit: number | null;
  readonly n_spawn: number | null;
  readonly files: number | null;
  readonly tok_out: number | null;
  readonly tool_err: number | null;
  readonly test_fail: number | null;
}

interface FixturePred {
  readonly id: string;
  readonly class: string;
  readonly level: string;
  readonly p_cheap: number;
  readonly p_big: number;
  readonly p_edit: number;
  readonly p_class: Readonly<Record<string, number>>;
  readonly p_level: Readonly<Record<string, number>>;
}

const jsonl = <T>(name: string): Array<T> =>
  fs
    .readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

/** An RFC 3339 time in epoch ms; undefined (Go's zero time) when it does not parse. */
const ts = (s: string): number | undefined => {
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : at;
};

/** Each ask as the model reads it, in session order: its input and the records of its session's earlier asks. */
const eachAsk = (
  asks: ReadonlyArray<FixtureAsk>,
  run: (id: string, input: AskInput, hist: ReadonlyArray<Hist>) => void,
): void => {
  let hist: Array<Hist> = [];
  let sid = "";
  const val = (x: number | null) => x ?? NaN;
  for (const a of asks) {
    const key = `${a.source}\0${a.sid}`;
    if (key !== sid) [sid, hist] = [key, []];
    run(
      a.id,
      {
        text: a.text,
        prevText: a.prev_text,
        prevAsst: a.prev_asst,
        turnIdx: a.turn_idx,
        harness: a.harness,
        slash: a.slash === 1,
        ts: ts(a.ts),
      },
      hist.slice(),
    );
    hist.push({
      ...newHist(a.text, a.slash === 1, ts(a.ts)),
      nReq: val(a.n_req),
      nTool: val(a.n_tool),
      nEdit: val(a.n_edit),
      nSpawn: val(a.n_spawn),
      files: val(a.files),
      tokOut: val(a.tok_out),
      toolErr: val(a.tool_err),
      testFail: val(a.test_fail),
    });
  }
};

describe("the ask model", () => {
  let model: Model;
  beforeAll(async () => {
    model = await loadAskModel();
  });

  // Every ask answers what the reference binary answers: the same class and level, every probability within 1e-4
  // (the model's raw outputs: the reference applies no calibration). A record whose reply is longer than the tail
  // the records were cut to is counted, not compared: the reference read it whole, features reads the tail.
  it("answers what the reference binary answers on the parity fixture", () => {
    const want = new Map(jsonl<FixturePred>("parity_pred.jsonl").map((p) => [p.id, p]));
    const classes = new Set<string>();
    const levels = new Set<string>();
    const differences: Array<string> = [];
    let [checked, labels, long, worst] = [0, 0, 0, 0];
    const near = (id: string, what: string, got: number, ref: number) => {
      worst = Math.max(worst, Math.abs(got - ref));
      if (!(Math.abs(got - ref) <= 1e-4))
        differences.push(`${id} ${what} = ${got.toFixed(6)}, the reference says ${ref.toFixed(5)}`);
    };
    eachAsk(jsonl<FixtureAsk>("parity_asks.jsonl"), (id, input, hist) => {
      const ref = want.get(id);
      if (ref === undefined) return;
      if (runeCount(input.prevAsst) > REPLY_RUNES) {
        long++;
        return;
      }
      checked++;
      const got = model.predict(input, hist);
      if (got.class !== ref.class || got.level !== ref.level) {
        labels++;
        differences.push(
          `${id}: ${got.class}/${got.level}, the reference says ${ref.class}/${ref.level}`,
        );
      }
      near(id, "p_cheap", got.pCheap, ref.p_cheap);
      near(id, "p_big", got.pBig, ref.p_big);
      near(id, "p_edit", got.pEdit, ref.p_edit);
      model.classes.forEach((c, k) => near(id, `p_class.${c}`, got.pClass[k]!, ref.p_class[c]!));
      model.levels.forEach((l, k) => near(id, `p_level.${l}`, got.pLevel[k]!, ref.p_level[l]!));
      classes.add(ref.class);
      levels.add(ref.level);
    });
    console.info(
      `${checked} asks checked against the reference: ${labels} label differences, largest probability difference ${worst.toPrecision(2)}; ${long} with a reply past ${REPLY_RUNES} characters not compared`,
    );
    expect(differences).toEqual([]);
    expect(checked + long).toBe(want.size);
    expect(long * 1000).toBeLessThanOrEqual(want.size);
    expect(checked).toBeGreaterThanOrEqual(30);
    expect(classes.size).toBeGreaterThanOrEqual(7);
    expect(levels.size).toBe(4);
  });

  // The calibration is the model's own file: a temperature on the class probabilities (the top class stays), a Platt
  // map on P(cheap), and the risk per routing mode.
  it("calibrates as its calib.json says", () => {
    const c = model.calib;
    expect(Math.abs(c.tClass - 0.717)).toBeLessThan(1e-3);
    expect(Math.abs(c.cheap[0] - 1.0066)).toBeLessThan(1e-4);
    expect(Math.abs(c.cheap[1] - 1.3485)).toBeLessThan(1e-4);
    for (const [mode, want] of [
      ["auto-max", 0.26],
      ["auto", 0.4],
      ["auto-save", 0.54],
      ["", 0.4],
    ] as const) {
      expect(Math.abs(c.risk(mode) - want)).toBeLessThan(1e-12);
    }
    const p = [0.05, 0.4, 0.1, 0.05, 0.25, 0.1, 0.03, 0.02];
    const sum = p.reduce((s, x) => s + Math.exp(Math.log(x) / c.tClass), 0);
    expect(Math.abs(c.confidence(p) - Math.exp(Math.log(0.4) / c.tClass) / sum)).toBeLessThan(
      1e-12,
    );
    expect(c.confidence([1, 0, 0])).toBe(1);
    expect(c.pCheap(0.2)).toBeGreaterThan(0.2);
  });

  // The lowest level whose risk of being too low (the probability of the levels above it) is at most the risk.
  it("routes at the lowest level within the risk", () => {
    expect(routedLevel([0.7, 0.2, 0.07, 0.03], 0.4)).toBe(0);
    expect(routedLevel([0.5, 0.3, 0.15, 0.05], 0.4)).toBe(1);
    expect(routedLevel([0.1, 0.2, 0.35, 0.35], 0.4)).toBe(2);
    expect(routedLevel([0.05, 0.05, 0.48, 0.42], 0.4)).toBe(3);
    expect(routedLevel([0.6, 0, 0.4, 0], 0.4)).toBe(0);
    expect(routedLevel([0.25, 0.24, 0.26, 0.25], 0.5)).toBe(2);
    expect(routedLevel([NaN, NaN, NaN, NaN], 0.4)).toBe(3);
  });

  it("reads a reply as its last 2,000 characters", () => {
    expect(replyTail(["  I looked at the handler.", "", "Want me to fix it?\n"])).toBe(
      "I looked at the handler.  Want me to fix it?",
    );
    const got = replyTail(["日".repeat(3000), "done"]);
    expect(runeCount(got)).toBe(REPLY_RUNES);
    expect(got.endsWith("日 done")).toBe(true);
    const tail = lastRunes(
      "The uploader now retries twice. Want me to add a metric? ".repeat(80),
      REPLY_RUNES,
    );
    const input = {
      text: "yes",
      prevText: "add a retry to the uploader",
      prevAsst: tail,
      turnIdx: 1,
      harness: "",
      slash: false,
      ts: undefined,
    };
    const longer = {
      ...input,
      prevAsst: "An earlier paragraph about dashboards? Done. ".repeat(20_000) + tail,
    };
    expect(model.predict(longer, [])).toEqual(model.predict(input, []));
    expect(model.predict({ ...input, prevAsst: "Done." }, [])).not.toEqual(
      model.predict(input, []),
    );
  });
});

describe("classifyTask", () => {
  it("reads a task's kind from its words", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "Make the settings page's sidebar collapse on narrow screens and fix the button padding in the header",
        "frontend_ui",
      ],
      [
        "Why does the uploader retry twice before it gives up? Don't change anything, just explain.",
        "explore_readonly",
      ],
      [
        "Refactor the billing module across the whole codebase: split the 3,000-line service into separate packages and update every caller",
        "large_refactor",
      ],
    ];
    for (const [text, kind] of cases) expect((await classifyTask(text))?.kind, text).toBe(kind);
  });

  it("keeps a planning task high", async () => {
    const got = await classifyTask(
      "Brainstorm the architecture for multi-region failover and write a design doc with the trade-offs",
    );
    expect(got?.kind).toBe("plan_design");
    expect(got?.level).toBe("high");
  });

  it("leaves a harness's own text unclassified", async () => {
    expect(await classifyTask("<system-reminder>context only</system-reminder>")).toBeUndefined();
    expect(await classifyTask("   ")).toBeUndefined();
  });
});
