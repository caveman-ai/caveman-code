// How the chaos order check reads a reversal from a chat's journal (scenario.ts ranIn and reversals): which ones the
// runtime caused by design (a held queue), which one is CHAOS-20, and which ones are violations. Journals as the
// runtime writes them in the runs that found each case, and the reviews' probes.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { judgeOrder, ranIn, reversals, type Holds, type Sent } from "./scenario.ts";

const thread = "run:thread:caveman%3A01242733";
const sent = (id: string): Sent => ({
  id,
  requestId: `web-2-${id}`,
  sessionId: "s",
  device: "web-2",
  text: `slow 300: ${id}`,
  at: 0,
  owner: "box-b",
  outcome: "ok",
});
/** Each event is written one second after the one before it: cursor n at second n. */
const T0 = Date.parse("2026-11-07T11:00:00.000Z");
const at = (cursor: number) => new Date(T0 + cursor * 1_000).toISOString();
const queue = (
  cursor: number,
  turns: ReadonlyArray<readonly [string, number, boolean?]>,
  on = thread,
) =>
  ({
    type: "queue.updated",
    cursor,
    at: at(cursor),
    payload: {
      turns: turns.map(([id, ordinal, held]) => ({
        turn_id: `${on}:ordinal:${ordinal}`,
        text: `slow 300: ${id}`,
        queued_at: "2026-11-07T00:00:00.000Z",
        ...(held ? { held } : {}),
      })),
    },
  }) as unknown as SessionEvent;
const said = (cursor: number, id: string, ordinal: number, delivery?: string, on = thread) =>
  ({
    type: "message.done",
    cursor,
    at: at(cursor),
    turn_id: `${on}:ordinal:${ordinal}`,
    payload: { role: "user", text: `slow 300: ${id}`, ...(delivery ? { delivery } : {}) },
  }) as unknown as SessionEvent;
const started = (cursor: number, ordinal: number) =>
  ({
    type: "turn.started",
    cursor,
    at: at(cursor),
    turn_id: `${thread}:ordinal:${ordinal}`,
    payload: {},
  }) as unknown as SessionEvent;
const ended = (cursor: number, ordinal: number, status: "completed" | "interrupted") =>
  ({
    type: "turn.done",
    cursor,
    at: at(cursor),
    turn_id: `${thread}:ordinal:${ordinal}`,
    payload: { status },
  }) as unknown as SessionEvent;
const judged = (
  ids: ReadonlyArray<string | Sent>,
  events: ReadonlyArray<SessionEvent>,
  holds: Holds = {},
) =>
  reversals(
    ranIn(
      ids.map((id) => (typeof id === "string" ? sent(id) : id)),
      events,
    ),
    events,
    holds,
  ).map(({ before, after, how }) => `${after.sent.id} before ${before.sent.id}: ${how}`);
/** What the order check does with each reversal (judgeOrder). */
const verdicts = (
  ids: ReadonlyArray<string | Sent>,
  events: ReadonlyArray<SessionEvent>,
  holds: Holds = {},
  avoidKnown = true,
) =>
  judgeOrder(
    ranIn(
      ids.map((id) => (typeof id === "string" ? sent(id) : id)),
      events,
    ),
    events,
    holds,
    avoidKnown,
  ).map(
    ({ before, after, how, verdict }) =>
      `${after.sent.id} before ${before.sent.id}: ${how}, ${verdict}`,
  );
/** Half a second after the event at `cursor` was written. */
const after = (cursor: number) => Date.parse(at(cursor)) + 500;

test("two follow-ups made in the order sent and run reversed are CHAOS-20", () => {
  // Seed 301 at load 26: s2's run made first (ordinal 3), s3 moved ahead of it.
  expect(
    judged(
      ["s2", "s3"],
      [
        queue(8, [["s2", 3]]),
        queue(9, [
          ["s3", 4],
          ["s2", 3],
        ]),
        said(14, "s3", 4, "queue"),
        said(21, "s2", 3, "queue"),
      ],
    ),
  ).toEqual(["s3 before s2: chaos20"]);
});

test("two the runtime made in the reverse of the order sent came in reversed, both queued or not, a Stop beside them or not", () => {
  // The reviewer's client reversal: s3 reached box-b first (ordinal 3), and ran first.
  const journal = [
    queue(8, [["s3", 3]]),
    queue(9, [
      ["s3", 3],
      ["s2", 4],
    ]),
    said(20, "s3", 3, "queue"),
    said(28, "s2", 4, "queue"),
  ];
  expect(judged(["s2", "s3"], journal)).toEqual(["s3 before s2: came-in-reversed"]);
  // A Stop between them, ending a turn interrupted with both queued: a hold explains no reversal of their arrival.
  expect(
    judged(
      ["s2", "s3"],
      [...journal.slice(0, 2), ended(10, 1, "interrupted"), ...journal.slice(2)],
      { stops: [after(9)] },
    ),
  ).toEqual(["s3 before s2: came-in-reversed"]);
});

test("the next message goes ahead of a held queue: a reversal the hold explains is the runtime's design", () => {
  // Seed 1: s3 queued; the Mac restarted and held the queue; s18, sent after, ran first.
  expect(
    judged(
      ["s3", "s18"],
      [
        queue(9, [["s3", 3]]),
        queue(18, [["s3", 3, true]]),
        said(22, "s18", 5),
        said(36, "s3", 3, "queue"),
      ],
    ),
  ).toEqual(["s18 before s3: held"]);
  // Both held together: the hold does not explain their order.
  expect(
    judged(
      ["s1", "s4"],
      [
        queue(8, [["s1", 2]]),
        queue(20, [
          ["s4", 4, true],
          ["s1", 2, true],
        ]),
        said(29, "s4", 4),
        said(37, "s1", 2, "queue"),
      ],
    ),
  ).toEqual(["s4 before s1: chaos20"]);
});

test("a move makes the queued runs again in another thread: the first runs say when each came in", () => {
  // Seed 1: s4 moved ahead of s1 on the Mac (ordinals 4 and 2), then the chat moved and box-a made them again, s4 first.
  const moved = "run:thread:claude-agent%3A01242733%3A9b563d75";
  expect(
    judged(
      ["s1", "s4"],
      [
        queue(8, [["s1", 2]]),
        queue(20, [
          ["s4", 4, true],
          ["s1", 2, true],
        ]),
        said(29, "s4", 1, undefined, moved),
        said(37, "s1", 2, "queue", moved),
      ],
    ),
  ).toEqual(["s4 before s1: chaos20"]);
  // Only ever seen in different threads: when each came in cannot be read.
  expect(
    judged(["s1", "s4"], [said(29, "s4", 1, undefined, moved), said(37, "s1", 7, "queue")]),
  ).toEqual(["s4 before s1: unknown"]);
});

test("every pair is judged, so one CHAOS-20 pair cannot hide a reversal beside it", () => {
  // a (ordinal 2), b (3, moved ahead of a), c (1: it came in first); they ran b, c, a. Neighbours alone see a/b
  // (CHAOS-20) and b/c (in order).
  expect(
    judged(
      ["a", "b", "c"],
      [
        queue(5, [
          ["c", 1],
          ["b", 3],
          ["a", 2],
        ]),
        said(10, "b", 3, "queue"),
        said(11, "c", 1),
        said(12, "a", 2, "queue"),
      ],
    ),
  ).toEqual(["b before a: chaos20", "c before a: came-in-reversed"]);
});

test("made in the order sent and run reversed, with no reorder to show for it, is not CHAOS-20 (probe A)", () => {
  // s1 queued (ordinal 2); s2 (ordinal 3) started at once, never in the queue; s1 ran from the queue after it.
  expect(
    judged(["s1", "s2"], [queue(8, [["s1", 2]]), said(14, "s2", 3), said(20, "s1", 2, "queue")]),
  ).toEqual(["s2 before s1: unexplained"]);
});

test("a hold the queue let go of before the later one came does not explain it (probe B)", () => {
  // s3 held at 18, let go at 23, then s4 queued and moved ahead of it: CHAOS-20, not the hold.
  expect(
    judged(
      ["s3", "s4"],
      [
        queue(18, [["s3", 3, true]]),
        queue(23, [["s3", 3]]),
        queue(25, [
          ["s4", 4],
          ["s3", 3],
        ]),
        said(30, "s4", 4, "queue"),
        said(36, "s3", 3, "queue"),
      ],
    ),
  ).toEqual(["s4 before s3: chaos20"]);
});

test("a restart holds the queue without a word in the journal: the next message after it runs ahead, by design", () => {
  // CHAOS_LONG seed 301 (trace 1794051231873): s22 queued (ordinal 9); the Mac was killed and came back with its queue
  // held, writing no snapshot; s25, sent after, arrived first after the restart and ran ahead.
  const events = [
    queue(31, [
      ["s13", 6],
      ["s22", 9],
    ]),
    queue(38, [
      ["s13", 6],
      ["s22", 9],
      ["s24", 10],
    ]),
    started(39, 11),
    said(40, "s25", 11),
    said(82, "s22", 9, "queue"),
  ];
  expect(judged(["s22", "s25"], events, { restarts: [after(38)] })).toEqual([
    "s25 before s22: held",
  ]);
  // Without the restart nothing explains it.
  expect(judged(["s22", "s25"], events)).toEqual(["s25 before s22: unexplained"]);
  // Only the first message after the restart goes ahead of the held queue: one after it does not.
  const later = [
    ...events.slice(0, 2),
    started(39, 11),
    said(40, "s24x", 11),
    started(41, 12),
    said(42, "s25", 12),
    said(82, "s22", 9, "queue"),
  ];
  expect(judged(["s22", "s25"], later, { restarts: [after(38)] })).toEqual([
    "s25 before s22: unexplained",
  ]);
});

test("a hold explains a pair only when the earlier one was queued before it and the later one first showed after it", () => {
  // The earlier one was queued only after the restart: the hold held nothing of it (E19).
  expect(
    judged(["s1", "s2"], [queue(30, [["s1", 3]]), said(34, "s2", 4), said(40, "s1", 3, "queue")], {
      restarts: [after(29)],
    }),
  ).toEqual(["s2 before s1: unexplained"]);
  // The later one was queued before the restart too: held with the earlier one, the hold does not let it ahead (E20).
  expect(
    judged(
      ["s1", "s2"],
      [
        queue(25, [["s1", 3]]),
        queue(27, [
          ["s1", 3],
          ["s2", 4],
        ]),
        started(30, 4),
        said(31, "s2", 4),
        said(40, "s1", 3, "queue"),
      ],
      { restarts: [after(29)] },
    ),
  ).toEqual(["s2 before s1: unexplained"]);
});

test("a Stop or a park holds the queue before the held snapshot is written: the turn it ended, interrupted, says where", () => {
  // CHAOS_LONG seed 301 (trace 1794051342177): s10 queued (ordinal 6) behind an ask; the turn ended, s20 ran next
  // (ordinal 7), and the queue's held snapshot came only after it.
  const journal = (status: "completed" | "interrupted") => [
    queue(18, [
      ["s9", 5],
      ["s10", 6],
      ["s7", 4],
    ]),
    ended(21, 3, status),
    started(22, 7),
    said(23, "s20", 7),
    queue(28, [
      ["s9", 5, true],
      ["s10", 6, true],
    ]),
    said(67, "s10", 6, "queue"),
  ];
  // Stopped (or parked) while it ran, and ended interrupted: the hold explains it.
  expect(judged(["s10", "s20"], journal("interrupted"), { stops: [after(19)] })).toEqual([
    "s20 before s10: held",
  ]);
  // Ended interrupted with nothing that holds the queue (a lease lost while Cloud answers, a steer the engine never
  // took, a cancel, a rollback; the trace's own case, with the turn.submit race): the runtime ran it ahead of an open queue.
  expect(judged(["s10", "s20"], journal("interrupted"))).toEqual(["s20 before s10: unexplained"]);
  // A stop the turn before it took is not this one's.
  expect(
    judged(["s10", "s20"], [ended(10, 2, "interrupted"), ...journal("interrupted")], {
      stops: [after(8)],
    }),
  ).toEqual(["s20 before s10: unexplained"]);
  // Ended completed: the stop came too late to end it, and held nothing it ran ahead of.
  expect(judged(["s10", "s20"], journal("completed"), { stops: [after(19)] })).toEqual([
    "s20 before s10: unexplained",
  ]);
});

test("a send the both_paths step also posted to Cloud's queue is not judged against the ones before it when Cloud handed that copy over before they came in", () => {
  // CHAOS_LONG seed 301 run 2: s38's copy in Cloud's queue reached the runtime ahead of s37, still in the device's lane.
  const journal = [
    queue(5, [["s38", 4]]),
    queue(6, [
      ["s38", 4],
      ["s37", 5],
    ]),
    said(8, "s38", 4, "queue"),
    said(12, "s37", 5, "queue"),
  ];
  const both = (cloudCopyAt?: number): Sent => ({
    ...sent("s38"),
    bothPaths: true,
    ...(cloudCopyAt !== undefined ? { cloudCopyAt } : {}),
  });
  expect(judged(["s37", both(Date.parse(at(4)))], journal)).toEqual(["s38 before s37: both-paths"]);
  // Handed over only after s37 came in, or never: it came in after s37 whichever copy ran, and the pair is judged.
  expect(judged(["s37", both(after(6))], journal)).toEqual(["s38 before s37: came-in-reversed"]);
  expect(judged(["s37", both()], journal)).toEqual(["s38 before s37: came-in-reversed"]);
});

test("after a move, the earlier send first shown in the journal came in first: one moved ahead of it there is CHAOS-20", () => {
  // CHAOS_LONG seed 301 (long301-b, trace 1794055133006): s35 queued on the Mac (ordinal 14) and s37 moved ahead of it
  // there; the lid handed the chat to box-a, which made the queue again (s35 ordinal 2, last), and every later
  // follow-up went ahead of it, s57 too (ordinal 8).
  const moved = "run:thread:claude-agent%3A92935fa0%3A71809b86";
  const journal = [
    queue(50, [["s35", 14]]),
    queue(58, [
      ["s35", 14],
      ["s37", 16],
    ]),
    queue(81, [["s35", 2]], moved),
    queue(
      82,
      [
        ["s37", 3],
        ["s35", 2],
      ],
      moved,
    ),
    said(95, "s37", 3, "queue", moved),
    queue(
      99,
      [
        ["s56", 7],
        ["s57", 8],
        ["s35", 2],
      ],
      moved,
    ),
    said(145, "s57", 8, "queue", moved),
    said(159, "s35", 2, "queue", moved),
  ];
  expect(judged(["s35", "s37", "s57"], journal)).toEqual([
    "s37 before s35: chaos20",
    "s57 before s35: chaos20",
  ]);
  // Never listed ahead of it: came in after it and ran first, with nothing to show for it.
  expect(
    judged(
      ["s35", "s57"],
      journal.filter((e) => e.cursor !== 99),
    ),
  ).toEqual(["s57 before s35: unexplained"]);
  // A move that made the carried queue again in another order (s37 first, s35 put behind it), with no follow-up
  // moved ahead as it was made: not CHAOS-20, though a later snapshot shows the two reversed.
  const remade = [
    queue(50, [["s35", 14]]),
    queue(58, [
      ["s35", 14],
      ["s37", 16],
    ]),
    queue(81, [["s37", 2]], moved),
    queue(
      82,
      [
        ["s37", 2],
        ["s35", 3],
      ],
      moved,
    ),
    said(95, "s37", 2, "queue", moved),
    said(159, "s35", 3, "queue", moved),
  ];
  expect(judged(["s35", "s37"], remade)).toEqual(["s37 before s35: unexplained"]);
});

test("the order check excuses a pair only for a held queue or a both_paths copy, and CHAOS-20, fixed, is a violation: a Stop beside a pair excuses nothing", () => {
  // Sent a second apart, a Stop just after the second: the blanket excuse 02d5cb4db removed read exactly this.
  const s2: Sent = { ...sent("s2"), at: Date.parse(at(7)) };
  const s3: Sent = { ...sent("s3"), at: Date.parse(at(8)) };
  const stops = [Date.parse(at(8)) + 200];
  const cameInReversed = [
    queue(8, [["s3", 3]]),
    queue(9, [
      ["s3", 3],
      ["s2", 4],
    ]),
    said(20, "s3", 3, "queue"),
    said(28, "s2", 4, "queue"),
  ];
  expect(verdicts([s2, s3], cameInReversed, { stops })).toEqual([
    "s3 before s2: came-in-reversed, violation",
  ]);
  const unexplained = [
    queue(8, [["s2", 3]]),
    queue(9, [
      ["s2", 3],
      ["s3", 4],
    ]),
    said(20, "s3", 4, "queue"),
    said(28, "s2", 3, "queue"),
  ];
  expect(verdicts([s2, s3], unexplained, { stops })).toEqual([
    "s3 before s2: unexplained, violation",
  ]);
  const chaos20 = [
    queue(8, [["s2", 3]]),
    queue(9, [
      ["s3", 4],
      ["s2", 3],
    ]),
    said(14, "s3", 4, "queue"),
    said(21, "s2", 3, "queue"),
  ];
  expect(verdicts([s2, s3], chaos20, { stops })).toEqual(["s3 before s2: chaos20, violation"]);
  // What does excuse a pair: the runtime's held queue, and a both_paths copy Cloud last handed over before the earlier one came in.
  expect(
    verdicts(
      ["s3", "s18"],
      [
        queue(9, [["s3", 3]]),
        queue(18, [["s3", 3, true]]),
        said(22, "s18", 5),
        said(36, "s3", 3, "queue"),
      ],
    ),
  ).toEqual(["s18 before s3: held, excused"]);
  const both: Sent = { ...sent("s38"), bothPaths: true, cloudCopyAt: Date.parse(at(4)) };
  expect(
    verdicts(
      ["s37", both],
      [
        queue(5, [["s38", 4]]),
        queue(6, [
          ["s38", 4],
          ["s37", 5],
        ]),
        said(8, "s38", 4, "queue"),
        said(12, "s37", 5, "queue"),
      ],
    ),
  ).toEqual(["s38 before s37: both-paths, excused"]);
});
