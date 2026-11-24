// Secret containment on every stream surface, model-checked (.claude/skills/secret-containment): a text holding a
// planted secret is cut into at most four pushes (BOUNDS) in every possible way, with idle (the 30 ms flush), a scrubber
// change and the end inserted at every boundary, and each schedule is replayed on the real stream. The concatenated
// output must hold no known encoding of any secret, and the ordinary text around it must still come out.
import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import { createScrubber, type Scrubber } from "@caveman-app/session-protocol";
import { check, formatTrace, type Verdict } from "@caveman-app/model-check";
import { describe, expect, it } from "vitest";

import { findProjectedThreadItems } from "../orchestration-v2/ThreadFind.ts";
import { TRUNCATED_FOR_TRANSPORT } from "../orchestration-v2/WireProjection.ts";
import {
  commandOutputScrub,
  scrubForClient,
  terminalEventsScrub,
  textForClient,
  type TerminalStreamEvent,
} from "../secrets/ClientScrub.ts";
import {
  ALL,
  leakIn,
  LONG_TEXTS,
  MIN_HIDDEN,
  type Planted,
  plantedText,
  productionScrubber,
  SHORT_TEXTS,
  textForms,
  valueStarts,
} from "../secrets/testing.ts";
import type { DraftEvent } from "./projector.ts";
import { followingStream, makeCommandOutputScrub, makeOutputScrub } from "./secrets.ts";

/**
 * The bound: pushes per schedule (short texts, long texts) and secrets set mid-stream. Rotation multiplies the
 * schedules most, so it runs with one piece fewer.
 */
const BOUNDS = [
  { pieces: 4, longPieces: 3, rotations: 0 },
  { pieces: 3, longPieces: 2, rotations: 1 },
] as const;
type Bound = (typeof BOUNDS)[number];

/** One schedule step, as its trace prints it. `rotate` is a secret set mid-stream: ProjectSecrets hands out a new scrubber. */
type Action = `push ${string}` | "idle" | "rotate" | "end";

interface Schedule {
  readonly at: number;
  readonly pushes: number;
  readonly rotations: number;
  readonly ended: boolean;
  readonly actions: ReadonlyArray<Action>;
}

/** How a stream surface consumes a schedule; `output` replays it on a fresh instance of the real code. */
interface Surface {
  readonly name: string;
  readonly idles: boolean;
  readonly rotates: boolean;
  /** No separate end call: the last push carries it (a frame with running: false). */
  readonly endRidesLastPush: boolean;
  /** Promises to mask a value the end cuts off (followingStream's end); a bare scrubber stream's flush does not. */
  readonly masksCutValue: boolean;
  readonly output: (actions: ReadonlyArray<Action>) => string;
}

const pushed = (action: Action) => JSON.parse(action.slice("push ".length)) as string;

const scrubberStream = (scrubber: Scrubber, name: string): Surface => ({
  name,
  idles: false,
  rotates: false,
  endRidesLastPush: false,
  masksCutValue: false,
  output: (actions) => {
    const stream = scrubber.stream();
    return actions
      .map((a) =>
        a === "end" ? stream.flush() : a.startsWith("push ") ? stream.push(pushed(a)) : "",
      )
      .join("");
  },
});

const followingStreamSurface: Surface = {
  name: "followingStream (terminals: push, idle after 30 ms, end at exit)",
  idles: true,
  rotates: true,
  endRidesLastPush: false,
  masksCutValue: true,
  output: (actions) => {
    let generation = 0;
    let current = productionScrubber(0);
    const stream = followingStream(() => current);
    let out = "";
    for (const a of actions) {
      if (a === "rotate") current = productionScrubber(++generation);
      else if (a === "idle") out += stream.idle();
      else if (a === "end") out += stream.end();
      else out += stream.push(pushed(a));
    }
    return out;
  },
};

const commandOutputSurface: Surface = {
  name: "makeCommandOutputScrub (tool.live: a replace frame, appends, idle, the last frame running: false)",
  idles: true,
  rotates: true,
  endRidesLastPush: true,
  masksCutValue: true,
  output: (actions) => {
    let generation = 0;
    let current = productionScrubber(0);
    const scrub = makeCommandOutputScrub(() => current);
    let out = "";
    let first = true;
    actions.forEach((a, i) => {
      if (a === "rotate") current = productionScrubber(++generation);
      else if (a === "idle") out += scrub.idle();
      else if (a.startsWith("push ")) {
        out += scrub({
          kind: first ? "replace" : "append",
          text: pushed(a),
          truncated: false,
          running: actions[i + 1] !== "end",
        }).text;
        first = false;
      }
    });
    return out;
  },
};

const outputScrubSurface = (
  type: "tool.output" | "reasoning.delta",
  done: "tool.done" | "turn.done",
): Surface => ({
  name: `makeOutputScrub (${type} deltas, the held tail before ${done})`,
  idles: false,
  rotates: true,
  endRidesLastPush: false,
  masksCutValue: true,
  output: (actions) => {
    const scrub = makeOutputScrub();
    let generation = 0;
    let current = productionScrubber(0);
    const draft = (t: string, payload: unknown, item = true) =>
      ({
        at: "t",
        type: t,
        turn_id: "r1",
        ...(item ? { item_id: "i1" } : {}),
        payload,
      }) as DraftEvent;
    const events: Array<DraftEvent> = [];
    for (const a of actions) {
      if (a === "rotate") current = productionScrubber(++generation);
      else if (a === "end")
        events.push(
          ...scrub(current, [draft(done, { status: "completed" }, done === "tool.done")]),
        );
      else if (a.startsWith("push "))
        events.push(...scrub(current, [draft(type, { text: pushed(a) })]));
    }
    return events
      .filter((e) => e.type === type)
      .map((e) => (e.payload as { text: string }).text)
      .join("");
  },
});

const liveCommandOutputSurface: Surface = {
  name: "scrubCommandOutput (/ws subscribeCommandOutput: a replace frame, appends, idle once quiet, the last frame running: false)",
  idles: true,
  rotates: true,
  endRidesLastPush: true,
  masksCutValue: true,
  output: (actions) => {
    let generation = 0;
    let current = productionScrubber(0);
    const scrub = commandOutputScrub(() => current);
    let out = "";
    let first = true;
    actions.forEach((a, i) => {
      if (a === "rotate") current = productionScrubber(++generation);
      // liveScrubbed waits for a pause only while something may be held.
      else if (a === "idle")
        out += scrub.pending()
          ? scrub
              .idle()
              .map((frame) => frame.text)
              .join("")
          : "";
      else if (a.startsWith("push ")) {
        const frame = {
          kind: first ? "replace" : "append",
          text: pushed(a),
          truncated: false,
          running: actions[i + 1] !== "end",
        } as const;
        out += scrub
          .push([frame])
          .map((sent) => sent.text)
          .join("");
        first = false;
      }
    });
    return out;
  },
};

const TERMINAL = { threadId: "thread-1", terminalId: "default" };
const NEIGHBOUR = { threadId: "thread-1", terminalId: "neighbour" };
const terminalSnapshot = (terminal: typeof TERMINAL, history: string): TerminalStreamEvent => ({
  type: "snapshot",
  snapshot: {
    ...terminal,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "zsh",
    updatedAt: "2026-11-07T00:00:00.000Z",
  },
});

const terminalEventsSurface: Surface = {
  name: "scrubTerminalEvents (/ws terminals: a snapshot's history, outputs beside another terminal's, idle once quiet, the exit)",
  idles: true,
  rotates: true,
  endRidesLastPush: false,
  masksCutValue: true,
  output: (actions) => {
    let generation = 0;
    let current = productionScrubber(0);
    const scrub = terminalEventsScrub(() => current);
    const sent: Array<TerminalStreamEvent> = [];
    let first = true;
    for (const a of actions) {
      if (a === "rotate") current = productionScrubber(++generation);
      else if (a === "idle") sent.push(...(scrub.pending() ? scrub.idle() : []));
      else if (a === "end")
        sent.push(...scrub.push([{ type: "exited", ...TERMINAL, exitCode: 0, exitSignal: null }]));
      else {
        const text = pushed(a);
        // The terminal's first push is its scrollback; a neighbour prints a value's false start in the same batch.
        sent.push(
          ...scrub.push(
            first
              ? [terminalSnapshot(TERMINAL, text), terminalSnapshot(NEIGHBOUR, "")]
              : [
                  { type: "output", ...TERMINAL, data: text },
                  { type: "output", ...NEIGHBOUR, data: "Ab3d" },
                ],
          ),
        );
        first = false;
      }
    }
    return sent
      .map((event) =>
        event.type === "snapshot" && event.snapshot.terminalId === TERMINAL.terminalId
          ? event.snapshot.history
          : event.type === "output" && event.terminalId === TERMINAL.terminalId
            ? event.data
            : "",
      )
      .join("");
  },
};

const SURFACES: ReadonlyArray<Surface> = [
  scrubberStream(createScrubber(ALL), "createScrubber().stream (push, flush)"),
  scrubberStream(productionScrubber(0), "chainScrubbers(store, tokens).stream (push, flush)"),
  followingStreamSurface,
  commandOutputSurface,
  outputScrubSurface("tool.output", "tool.done"),
  outputScrubSurface("reasoning.delta", "turn.done"),
  liveCommandOutputSurface,
  terminalEventsSurface,
];

/** Which boundaries may carry an idle: all of them, or all but those inside a value's first MIN_HIDDEN - 1 characters. */
type IdleAt = "anywhere" | "past a value's start";

const starts = new Map<Planted, ReadonlyArray<number>>();
/** Whether `at` characters into the planted text falls inside a value's first MIN_HIDDEN - 1 characters. */
const insideValueStart = (planted: Planted, at: number) => {
  let found = starts.get(planted);
  if (found === undefined)
    starts.set(
      planted,
      (found = [
        ...valueStarts(plantedText(planted)),
        ...(planted.cut ? [planted.before.length] : []),
      ]),
    );
  return found.some((start) => at > start && at < start + MIN_HIDDEN);
};

/** Every schedule of the planted text on `surface`, breadth-first, so a violation comes back as the shortest one. */
const checkSurface = (surface: Surface, planted: Planted, bound: Bound, idleAt: IdleAt) => {
  const maxPieces = LONG_TEXTS.includes(planted) ? bound.longPieces : bound.pieces;
  const text = plantedText(planted);
  const idleAllowed = (at: number) => idleAt === "anywhere" || !insideValueStart(planted, at);
  const outputs = new Map<string, string>();
  const output = (s: Schedule) => {
    const id = s.actions.join("\n");
    let out = outputs.get(id);
    if (out === undefined) outputs.set(id, (out = surface.output(s.actions)));
    return out;
  };
  const verdict = check<Schedule>({
    init: [{ at: 0, pushes: 0, rotations: 0, ended: false, actions: [] }],
    next: (s) => {
      if (s.ended) return [];
      const last = s.actions.at(-1);
      const steps: Array<{ action: Action; state: Schedule }> = [];
      const step = (action: Action, change: Partial<Schedule>) =>
        steps.push({ action, state: { ...s, ...change, actions: [...s.actions, action] } });
      const room = maxPieces - s.pushes;
      for (let to = s.at + 1; to <= text.length && room > 0; to++) {
        if (room === 1 && to < text.length) continue;
        step(`push ${JSON.stringify(text.slice(s.at, to))}`, { at: to, pushes: s.pushes + 1 });
      }
      if (surface.idles && s.pushes > 0 && last !== "idle" && idleAllowed(s.at)) step("idle", {});
      if (surface.rotates && s.rotations < bound.rotations && last !== "rotate")
        step("rotate", { rotations: s.rotations + 1 });
      if (s.at === text.length && (!surface.endRidesLastPush || last?.startsWith("push ")))
        step("end", { ended: true });
      return steps;
    },
    atEnd: {
      "no planted secret comes out, in any encoding": (s) => leakIn(output(s)) === undefined,
      "a value the end cuts off does not come out": (s) =>
        !(planted.cut && surface.masksCutValue && output(s).includes(planted.form)),
      "the ordinary text around it still comes out": (s) =>
        planted.form === ""
          ? output(s) === text
          : output(s).startsWith(planted.before) && output(s).endsWith(planted.after),
    },
  });
  return { verdict, output };
};

const explain = (verdict: Verdict<Schedule>, output: (s: Schedule) => string) => {
  if (verdict.ok) return "";
  return [
    `${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps:`,
    formatTrace(verdict.trace, (s) => `output so far: ${JSON.stringify(output(s))}`),
    `leak: ${leakIn(output(verdict.trace.at(-1)!.state)) ?? "none"}`,
  ].join("\n");
};

/**
 * Surfaces the current code breaks, and how. Their full alphabet is still checked and must break with an idle inside
 * a value's first MIN_HIDDEN - 1 characters; every schedule without such an idle must hold. Delete an entry once its
 * fix lands: the full alphabet must then hold.
 */
const KNOWN_FINDINGS: Readonly<Record<string, string>> = {};

const CASES = [...SHORT_TEXTS, ...LONG_TEXTS];

/**
 * A surface with an idle takes about 40 s alone and over vitest's 120 s default on a busy machine: 144 to 237 s at load
 * average 94, and the two-terminal surface over 600 s at 130 to 160. Each check gets twenty minutes, so a slow machine
 * makes the run slow, not flaky.
 */
const LONG_RUN = 1_200_000;

const holdsOnEveryText = (surface: Surface, idleAt: IdleAt, cases = CASES) => {
  let states = 0;
  let transitions = 0;
  for (const bound of BOUNDS) {
    for (const planted of cases) {
      const { verdict, output } = checkSurface(surface, planted, bound, idleAt);
      if (!verdict.ok)
        expect.fail(
          `${surface.name}, ${planted.name}, ${JSON.stringify(bound)}:\n${explain(verdict, output)}`,
        );
      expect(
        verdict.exhaustive,
        `${surface.name}, ${planted.name}: a bound cut the search short`,
      ).toBe(true);
      states += verdict.states;
      transitions += verdict.transitions;
    }
  }
  console.log(
    `[secret-containment] ${surface.name}${surface.idles ? `, idle ${idleAt}` : ""}: ${cases.length} texts, ${states} states, ${transitions} transitions, exhaustive`,
  );
};

describe("secret containment on every stream surface (bounded-exhaustive chunk splits)", () => {
  it("the oracle sees every planted form in its text, and the whole-text scrub hides each one", () => {
    const scrubber = productionScrubber(0);
    for (const planted of CASES) {
      const text = plantedText(planted);
      if (planted.form !== "" && !planted.cut)
        expect(leakIn(text), `the oracle misses ${planted.name}`).toBeDefined();
      else expect(leakIn(text), `${planted.name} holds a whole secret`).toBeUndefined();
      expect(leakIn(scrubber.scrub(text)), `${planted.name}: whole-text scrub`).toBeUndefined();
    }
  });

  for (const surface of SURFACES) {
    const finding = KNOWN_FINDINGS[surface.name];
    if (finding === undefined) {
      it(
        `${surface.name}: holds for every schedule`,
        () => holdsOnEveryText(surface, "anywhere"),
        LONG_RUN,
      );
      continue;
    }
    it(
      `${surface.name}: holds unless an idle lands inside a value's first ${MIN_HIDDEN - 1} characters`,
      () =>
        holdsOnEveryText(
          surface,
          "past a value's start",
          CASES.filter((planted) => !planted.base64),
        ),
      LONG_RUN,
    );
    it(`${surface.name}: FINDING, an idle inside a value's first ${MIN_HIDDEN - 1} characters lets it out`, () => {
      let broken: ({ planted: Planted } & ReturnType<typeof checkSurface>) | undefined;
      for (const planted of CASES) {
        const run = checkSurface(surface, planted, BOUNDS[0], "anywhere");
        if (!run.verdict.ok) {
          broken = { planted, ...run };
          break;
        }
      }
      expect(
        broken,
        `${surface.name} no longer breaks with idle: the finding is fixed, delete its KNOWN_FINDINGS entry`,
      ).toBeDefined();
      const { planted, verdict, output } = broken!;
      if (verdict.ok) return;
      expect(
        verdict.trace.some(
          (step) => step.action === "idle" && insideValueStart(planted, step.state.at),
        ),
        `${surface.name}: the break is not the known one:\n${explain(verdict, output)}`,
      ).toBe(true);
      console.log(
        `[secret-containment] FINDING on ${surface.name}\n${finding}\nshortest counterexample, ${planted.name}:\n${explain(verdict, output)}`,
      );
    });
  }
});

/**
 * Where a text cut at `k` ends inside a value: each start `s` whose tail `text.slice(s, k)` is at least MIN_HIDDEN
 * characters and a proper prefix of a form the scrubber hides.
 */
const cutInside = (text: string, k: number) => {
  const starts: Array<number> = [];
  for (const { value } of ALL) {
    for (const form of textForms(value)) {
      for (let s = Math.max(0, k - form.length + 1); s <= k - MIN_HIDDEN; s++)
        if (form.startsWith(text.slice(s, k))) starts.push(s);
    }
  }
  return starts;
};

describe("secret containment where the runtime cut a read before the /ws scrub (scrubForClient, every cut)", () => {
  it("no value, whole or cut, comes out; the text before it does; nothing grows past the length it had", () => {
    const scrubber = productionScrubber(0);
    let cuts = 0;
    for (const planted of CASES) {
      const text = plantedText(planted);
      for (let k = 0; k <= text.length; k++) {
        // The marks WireProjection's detail reads and makeProviderFailure leave; "" is a text that was not cut.
        for (const mark of [TRUNCATED_FOR_TRANSPORT, "…", ...(k === text.length ? [""] : [])]) {
          const read = text.slice(0, k) + mark;
          const sent = scrubForClient(scrubber, read);
          const where = `${planted.name}, cut at ${k}${mark === "" ? " (not cut)" : ` with ${JSON.stringify(mark)}`}: ${JSON.stringify(sent)}`;
          expect(leakIn(sent), where).toBeUndefined();
          expect(sent.length, where).toBeLessThanOrEqual(read.length);
          expect(sent.endsWith(mark), where).toBe(true);
          const inside = mark === "" ? [] : cutInside(text, k);
          for (const s of inside) {
            const start = text.slice(s, k);
            if (text.indexOf(start) === s && text.indexOf(start, s + 1) === -1)
              expect(sent, where).not.toContain(start);
          }
          expect(
            sent.startsWith(text.slice(0, Math.min(k, planted.before.length, ...inside))),
            where,
          ).toBe(true);
          if (planted.form === "" && mark === "") expect(sent, where).toBe(text);
          cuts++;
        }
      }
    }
    console.log(
      `[secret-containment] scrubForClient: ${CASES.length} texts, ${cuts} cuts (every position, both marks), exhaustive`,
    );
  });
});

/**
 * Where a text cut at `k` starts inside a value: each end `e` whose head `text.slice(k, e)` is at least MIN_HIDDEN
 * characters and a proper suffix of a form the scrubber hides.
 */
const cutInsideStart = (text: string, k: number) => {
  const ends: Array<number> = [];
  for (const { value } of ALL) {
    for (const form of textForms(value)) {
      for (let e = k + MIN_HIDDEN; e <= Math.min(text.length, k + form.length - 1); e++)
        if (form.endsWith(text.slice(k, e))) ends.push(e);
    }
  }
  return ends;
};

describe("secret containment where a tail window cut a command row's output before the scrub (every cut)", () => {
  type Frame = {
    readonly kind: "replace";
    readonly text: string;
    readonly truncated: boolean;
    readonly running: false;
  };
  // A row's frame as each surface sends it: a fresh scrub, as for a viewer that subscribes or falls behind.
  const surfaces: ReadonlyArray<{
    readonly name: string;
    readonly send: (frame: Frame) => string;
  }> = [
    {
      name: "makeCommandOutputScrub (tool.watch)",
      send: (frame) => makeCommandOutputScrub(() => productionScrubber(0))(frame).text,
    },
    {
      name: "commandOutputScrub (/ws subscribeCommandOutput)",
      send: (frame) =>
        commandOutputScrub(() => productionScrubber(0))
          .push([frame])
          .map((sent) => sent.text)
          .join(""),
    },
  ];
  // terminalOutputTail keeps the colour in force where it cuts inside a styled line.
  const STYLES = ["", "\u001b[0;31m"];

  it("no value, whole or cut, comes out; what follows it does; a window that starts outside every value is scrubbed as before", () => {
    let cuts = 0;
    let inside = 0;
    for (const surface of surfaces) {
      for (const planted of CASES) {
        const text = plantedText(planted);
        const formStart = planted.before.length;
        const formEnd = formStart + planted.form.length;
        for (let k = 0; k <= text.length; k++) {
          const ends = cutInsideStart(text, k);
          if (ends.length > 0) inside++;
          for (const style of STYLES) {
            const frame = (truncated: boolean): Frame => ({
              kind: "replace",
              text: style + text.slice(k),
              truncated,
              running: false,
            });
            const sent = surface.send(frame(k > 0));
            const where = `${surface.name}, ${planted.name}, window from ${k}${style === "" ? "" : " in colour"}: ${JSON.stringify(sent)}`;
            expect(leakIn(sent), where).toBeUndefined();
            for (const e of ends) {
              const piece = text.slice(k, e);
              if (text.indexOf(piece) === k && text.indexOf(piece, k + 1) === -1)
                expect(sent, where).not.toContain(piece);
            }
            expect(sent.startsWith(style), where).toBe(true);
            expect(sent.endsWith(text.slice(Math.max(k, formEnd))), where).toBe(true);
            if (k <= formStart || k >= formEnd)
              expect(sent, where).toBe(surface.send(frame(false)));
            cuts++;
          }
        }
      }
    }
    expect(inside, "no window starts inside a value: the check proves nothing").toBeGreaterThan(0);
    console.log(
      `[secret-containment] command output windows: ${CASES.length} texts, ${cuts} cuts (every position, plain and in colour, ${inside} inside a value), exhaustive`,
    );
  });
});

const FIND_THREAD = ThreadId.make("thread:find");
/** A transcript as the projections keep it: `text` as a message, and again as a plan, which parses as Markdown of its own. */
const transcriptOf = (text: string): ReadonlyArray<OrchestrationV2ProjectedTurnItem> => {
  const base = {
    threadId: FIND_THREAD,
    runId: RunId.make("run:find"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  } as const;
  const items = [
    {
      ...base,
      id: TurnItemId.make("message"),
      ordinal: 1,
      type: "assistant_message",
      messageId: MessageId.make("message"),
      text,
      streaming: false,
    },
    {
      ...base,
      id: TurnItemId.make("plan"),
      ordinal: 2,
      type: "proposed_plan",
      planId: PlanId.make("plan"),
      markdown: text,
      streaming: false,
    },
  ] as const;
  return items.map(
    (item, position) =>
      ({
        position,
        visibility: "local",
        sourceThreadId: FIND_THREAD,
        sourceItemId: item.id,
        item,
      }) as unknown as OrchestrationV2ProjectedTurnItem,
  );
};

const substrings = (text: string) => {
  const out = new Set<string>();
  for (let i = 0; i < text.length; i++)
    for (let j = i + 1; j <= text.length; j++) out.add(text.slice(i, j));
  return out;
};

describe("secret containment of a find in a thread (findProjectedThreadItems, every query)", () => {
  it("a transcript and the one its reader reads answer every query alike", () => {
    // The find answers about text it never sends. Two transcripts the reader reads the same must get the same answers,
    // so an answer says nothing the reader cannot read. The text a reader reads is one such pair with its source.
    const shown = textForClient(productionScrubber(0));
    const find = (text: string, query: string) =>
      findProjectedThreadItems(transcriptOf(text), { threadId: FIND_THREAD, query }, 0, shown);
    let reads = 0;
    let queries = 0;
    const alike = (stored: string, asked: Iterable<string>, where: string) => {
      const read = shown(stored);
      expect(shown(read), `${where}: the reader's own text reads as itself`).toBe(read);
      for (const query of asked) {
        expect(find(stored, query), `${where}, query ${JSON.stringify(query)}`).toEqual(
          find(read, query),
        );
        queries++;
      }
      reads++;
    };
    for (const planted of CASES) {
      const text = plantedText(planted);
      // Every piece of the stored text and of what is read: each guess of a value, whole or in part.
      alike(text, new Set([...substrings(text), ...substrings(shown(text))]), planted.name);
      // A text that ends in a cut's mark is read through maskCut: guess the value start the cut left at the end.
      for (let k = 0; k < text.length; k++) {
        for (const mark of [TRUNCATED_FOR_TRANSPORT, "…"]) {
          const cut = text.slice(0, k);
          alike(
            cut + mark,
            Array.from({ length: k }, (_, s) => cut.slice(s)),
            `${planted.name}, cut at ${k} with ${JSON.stringify(mark)}`,
          );
        }
      }
    }
    console.log(
      `[secret-containment] thread find: ${CASES.length} texts, ${reads} transcripts, ${queries} queries (every piece of each whole text, every tail of each cut), exhaustive`,
    );
  });
});
