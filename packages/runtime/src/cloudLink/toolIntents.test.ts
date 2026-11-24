// A step's intent, written ahead of its effect (toolIntents.ts; docs/ SPEC §7.3, R11;
// formal/NothingLost.tla's Intent and NoSilentRerun): when an intent closes, what a copy's head says of them, what the
// computer a chat lands on tells its engine, and what a park counts as a running tool while the gate holds one.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { decodeSegment, planSegments, type SegmentHead } from "./copySegments.ts";
import { openTurn, rerunNote, restartNote } from "./moveEngines.ts";
import { mergeBundles, type MoveBundle } from "./moves.ts";
import { toolRuns } from "./parking.ts";
import {
  intentsAfter,
  intentsFor,
  intentsKept,
  intentsParagraph,
  MAY_HAVE_RUN,
  readIntents,
  toolGateOn,
  unresolvedIntents,
  type OpenIntent,
} from "./toolIntents.ts";

let cursor = 0;
const ev = (type: string, payload: unknown, item_id?: string, at = "2026-11-09T10:00:10.000Z") =>
  ({
    session_id: "s",
    cursor: ++cursor,
    at,
    type,
    payload,
    ...(item_id ? { item_id } : {}),
  }) as SessionEvent;
const push: OpenIntent = {
  items: ["t-push"],
  title: "git push origin HEAD",
  at: "2026-11-09T10:00:05.000Z",
};
const deploy: OpenIntent = {
  items: ["t-deploy"],
  title: "pnpm deploy --prod",
  at: "2026-11-09T10:00:08.000Z",
};

test("an intent closes where the journal says how its step ended, never on an event older than it", () => {
  cursor = 10;
  // Its own tool.done closes it, at that cursor; another tool's does not.
  const done = intentsAfter([push, deploy], ev("tool.done", { status: "completed" }, "t-push"));
  expect(done).toEqual([{ ...push, closed: 11 }, deploy]);
  expect(intentsAfter([push], ev("tool.done", { status: "completed" }, "other"))).toEqual([push]);
  // A turn that ended by itself closes every step of it; one that was stopped leaves them open for wherever it carries on.
  expect(intentsAfter([deploy], ev("turn.done", { status: "completed" }))).toEqual([
    { ...deploy, closed: 13 },
  ]);
  expect(intentsAfter([deploy], ev("turn.done", { status: "interrupted" }))).toEqual([deploy]);
  // The next turn's start closes what is left: that turn was told.
  expect(intentsAfter([deploy], ev("turn.started", { engine: "caveman" }))).toEqual([
    { ...deploy, closed: 15 },
  ]);
  // The journal can run behind the gate: this turn's own start, journaled after its first tool's intent, closes nothing.
  expect(
    intentsAfter(
      [deploy],
      ev("turn.started", { engine: "caveman" }, undefined, "2026-11-09T10:00:01.000Z"),
    ),
  ).toEqual([deploy]);
  // Nothing open: the same list back, so nothing is written.
  const none: ReadonlyArray<OpenIntent> = [];
  expect(intentsAfter(none, ev("turn.done", { status: "completed" }))).toBe(none);
});

test("a copy names an intent until it holds the step's result", () => {
  const closed = { ...push, closed: 12 };
  // A segment through cursor 11 does not hold the tool.done at 12: the intent rides in its head. One through 12 does.
  expect(intentsFor([closed, deploy], 11)).toEqual([
    { items: push.items, title: push.title, at: push.at },
    { items: deploy.items, title: deploy.title, at: deploy.at },
  ]);
  expect(intentsFor([closed, deploy], 12)).toEqual([
    { items: deploy.items, title: deploy.title, at: deploy.at },
  ]);
  // And this computer forgets it once the copy is through it.
  expect(intentsKept([closed, deploy], 11)).toEqual([closed, deploy]);
  expect(intentsKept([closed, deploy], 12)).toEqual([deploy]);
});

const head: SegmentHead = {
  runtime_id: "r",
  repo: "octocat/hello",
  record: {
    workspace: {},
    session: {},
    internal: { threadId: "t" },
  } as unknown as MoveBundle["record"],
  epoch: 1,
};

test("an intent's segment carries its head alone, and the copy's last head is what a chat lands with", () => {
  cursor = 0;
  const events = [
    ev("turn.started", { engine: "caveman" }),
    ev("message.done", { role: "user", text: "ship it" }),
  ];
  const first = planSegments({
    head: { ...head, pending: "ship it" },
    after: 0,
    events,
    display: [],
    lastWip: null,
  });
  // No event, no boundary, and still one segment: the head is what it carries.
  const ahead = planSegments({
    head: { ...head, pending: "ship it", intents: [push] },
    after: 2,
    events: [],
    display: [],
    lastWip: null,
    always: true,
  });
  expect(ahead.segments).toHaveLength(1);
  expect(ahead.segments[0]).toMatchObject({ from: 3, through: 2, boundary: false });
  // Without `always` a copy with nothing to carry writes nothing, as before.
  expect(
    planSegments({ head, after: 2, events: [], display: [], lastWip: null }).segments,
  ).toHaveLength(0);
  const merged = mergeBundles(
    [...first.segments, ...ahead.segments].map((segment) => decodeSegment(segment.body)),
  );
  expect(merged.events.map((e) => e.cursor)).toEqual([1, 2]);
  expect(readIntents(merged.intents)).toEqual([
    { items: push.items, title: push.title, at: push.at },
  ]);
  // A copy from before intents, or one that says something else there, has none.
  expect(readIntents(undefined)).toEqual([]);
  expect(readIntents([{ title: 3 }, "x", null])).toEqual([]);
});

test("where a chat lands: every intent the copy holds no result for is said to have maybe finished, each step once", () => {
  cursor = 0;
  const copy = [
    ev("turn.started", { engine: "caveman" }),
    ev("message.done", { role: "user", text: "ship it" }),
    ev("tool.started", { name: "bash", title: "pnpm test", kind: "command", input: {} }, "t-test"),
    ev("tool.done", { status: "completed" }, "t-test"),
    ev(
      "tool.started",
      { name: "bash", title: "git push origin HEAD", kind: "command", input: {} },
      "t-push",
    ),
  ];
  // The copy holds the push's start and no end, and the deploy's intent alone (it began after the copy's last event).
  const intents = unresolvedIntents(
    [{ items: ["t-test"], title: "pnpm test", at: push.at }, push, deploy],
    copy,
  );
  expect(intents.map((intent) => intent.title)).toEqual([
    "git push origin HEAD",
    "pnpm deploy --prod",
  ]);
  const note = restartNote(openTurn(copy)!, { intents });
  expect(note).toContain("- pnpm test (completed)");
  expect(note).toContain(`- git push origin HEAD (${MAY_HAVE_RUN})`);
  expect(note).toMatch(
    /copy holds no result for them\. For each, this may or may not have finished: check before doing it again\.\n- pnpm deploy --prod/,
  );
  // Named once: the push is among the turn's tools, never again among the steps the copy holds no event of.
  expect(note.match(/git push origin HEAD/g)).toHaveLength(1);
  // Without the write-ahead the copy says nothing of the deploy, and the push reads as a tool that was cut (R11).
  const before = restartNote(openTurn(copy)!);
  expect(before).not.toContain("pnpm deploy");
  expect(before).toContain("- git push origin HEAD (stopped before it finished)");
  // The same for a turn stopped here and carried on here, and for a computer rebuilt from the copy.
  expect(restartNote(openTurn(copy)!, { cause: "stopped", intents })).toContain(
    "- pnpm deploy --prod",
  );
  expect(restartNote(openTurn(copy)!, { cause: "rebuilt", filesAt: 0, intents })).toContain(
    "- pnpm deploy --prod",
  );
  // A copy that holds the person's message and no event of its turn: the message runs again, told what may have run.
  expect(rerunNote("ship it", [])).toBe("ship it");
  const rerun = rerunNote("ship it", [deploy], true);
  expect(rerun).toMatch(/^\[Caveman Code\] This computer was rebuilt/);
  expect(rerun).toContain("- pnpm deploy --prod");
  expect(rerun).toContain("The person asked:\nship it");
  expect(intentsParagraph([])).toBeUndefined();
});

test("a tool the gate holds has not run: a park finds a boundary there, and waits for one that runs beside it", () => {
  const turn = [
    { type: "turn.started" },
    { type: "tool.started", item_id: "running" },
    { type: "tool.started", item_id: "held" },
  ];
  expect(toolRuns(turn)).toBe(true);
  expect(toolRuns(turn, new Set(["held"]))).toBe(true);
  expect(toolRuns([...turn, { type: "tool.done", item_id: "running" }], new Set(["held"]))).toBe(
    false,
  );
  expect(
    toolRuns(
      [{ type: "turn.started" }, { type: "tool.started", item_id: "held" }],
      new Set(["held"]),
    ),
  ).toBe(false);
});

test("the switch a test turns off to show the finding", () => {
  expect(toolGateOn({})).toBe(true);
  expect(toolGateOn({ CAVEMAN_TOOL_GATE: "off" })).toBe(false);
});
