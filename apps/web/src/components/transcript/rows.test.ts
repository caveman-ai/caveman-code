import { expect, test, vi } from "vitest";
import type { ToolPart } from "../../state/tool-actions.ts";
import type { ToolItem, TranscriptItem } from "../../state/transcript-model.ts";
import {
  expandHeld,
  foldLines,
  joinWatched,
  liveSteps,
  openTurn,
  rows,
  turnHeads,
  turnLine,
  waitLine,
  workedFor,
  type Row,
} from "./rows.ts";
import { summarize, thoughtTitle } from "./WorkRun.tsx";

// WorkRun names threads as their pills do; the window's pane store is browser-only and unrelated here.
vi.mock("../../panes/store.ts", () => ({ panes: {} }));

const t0 = Date.parse("2026-10-17T10:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

const user = (id: string, s: number): TranscriptItem => ({
  kind: "user",
  id,
  text: "fix it",
  at: at(s),
  delivery: "message",
});
const thought = (id: string, streaming = false): TranscriptItem => ({
  kind: "reasoning",
  id,
  text: "Look first.",
  streaming,
});
const say = (id: string, s: number, text = "Done."): TranscriptItem => ({
  kind: "assistant",
  id,
  text,
  streaming: false,
  at: at(s),
});
const end = (
  id: string,
  s: number,
  outcome: "completed" | "interrupted" = "completed",
): TranscriptItem => ({ kind: "turn_end", id, outcome, at: at(s), cursor: s });
const ask = (id: string): TranscriptItem => ({
  kind: "ask",
  id,
  askKind: "question",
  prompt: "Which part?",
  options: [],
  resolution: "answered",
  questions: [],
  round: 1,
  answers: null,
});
const tool = (
  id: string,
  s: number,
  status: ToolItem["status"] = "done",
  name = "bash",
): ToolItem => ({
  kind: "tool",
  id,
  verb: status === "running" ? "Running" : "Ran",
  subject: "go test ./...",
  parts: [{ action: "test", subject: "./..." }],
  command: "go test ./...",
  status,
  startedAt: at(s),
  finishedAt: status === "running" ? null : at(s + 1),
  added: null,
  removed: null,
  output: "",
  name,
  input: {},
  result: null,
  icon: "run",
});

const shape = (rs: ReadonlyArray<Row>): unknown[] =>
  rs.map((r) =>
    r.kind === "fold"
      ? { fold: shape(r.rows), ms: r.ms }
      : r.kind === "work" || r.kind === "agents"
        ? `${r.kind}:${r.items.map((i) => i.id).join(",")}`
        : r.id,
  );

test("thoughts and tool calls in a row are one work run", () => {
  expect(
    shape(
      rows([
        user("u", 0),
        thought("r1"),
        tool("t1", 1),
        thought("r2"),
        ask("k"),
        thought("r3", true),
      ]),
    ),
  ).toEqual(["u", "work:r1,t1,r2", "k", "work:r3"]);
});

test("a thought with no tool call beside it shows only while it streams, as in Codex", () => {
  expect(
    shape(
      rows([user("u", 0), thought("r1"), say("a1", 2, "Checking."), thought("r2"), tool("t1", 3)]),
    ),
  ).toEqual(["u", "a1", "work:r2,t1"]);
  expect(shape(rows([user("u", 0), thought("r1", true)]))).toEqual(["u", "work:r1"]);
  // The engine's next row takes the speaker mark the hidden thought would have had.
  expect(rows([user("u", 0), thought("r1"), say("a1", 2)]).map((r) => r.speaker)).toEqual([
    false,
    true,
  ]);
});

test("a live turn never folds", () => {
  expect(
    shape(
      rows([
        user("u", 0),
        thought("r1"),
        tool("t1", 1),
        say("a1", 3, "Checking."),
        tool("t2", 4, "running"),
      ]),
    ),
  ).toEqual(["u", "work:r1,t1", "a1", "work:t2"]);
});

test("a running turn keeps its steps behind its line: what will fold, its replies but the latest among them", () => {
  const live = rows([
    user("u", 0),
    thought("r1"),
    tool("t1", 1),
    say("a1", 3, "Checking."),
    tool("t2", 4),
    say("a2", 5, "Now the tests."),
    tool("t3", 6, "running"),
  ]);
  const turn = live.slice(openTurn(live));
  expect([...liveSteps(turn)].sort()).toEqual(["a1", "r1", "t2", "t3"]);
  // The Chief's replies are never steps.
  expect([...liveSteps(turn, undefined, true)].sort()).toEqual(["r1", "t2", "t3"]);
  // What the person must see stays: an ask, and the latest reply.
  const asking = rows([user("u", 0), tool("t1", 1), say("a1", 2, "One question."), ask("k")]);
  const steps = liveSteps(asking.slice(openTurn(asking)));
  expect(steps.has("k")).toBe(false);
  expect(steps.has("a1")).toBe(false);
  expect(steps.size).toBe(1);
});

test("a single completed tool folds above the final answer too", () => {
  expect(shape(rows([user("u", 0), tool("t", 1), say("a", 5), end("e", 6)]))).toEqual([
    "u",
    { fold: ["work:t"], ms: 5_000 },
    "a",
    "e",
  ]);
});

test("a progress message folds above the answer: the turn is the message, its line, the answer", () => {
  expect(
    shape(rows([user("u", 0), say("p", 1, "Checking the tests."), say("a", 5), end("e", 6)])),
  ).toEqual(["u", { fold: ["p"], ms: 5_000 }, "a", "e"]);
});

test("pictures and files a reply attached make it a reply: the last one is the answer", () => {
  const shot: TranscriptItem = {
    kind: "assistant",
    id: "a",
    text: "",
    streaming: false,
    at: at(5),
    attachments: [{ type: "image", name: "shot.png", mime_type: "image/png", data: "" }],
  };
  expect(
    shape(rows([user("u", 0), tool("t", 1), say("p", 2, "Here."), shot, end("e", 6)])),
  ).toEqual(["u", { fold: ["work:t", "p"], ms: 5_000 }, "a", "e"]);
});

test("a thought explicitly opened while streaming survives completion", () => {
  expect(
    shape(
      rows(
        [user("u", 0), thought("r"), say("a", 5), end("e", 6)],
        undefined,
        false,
        (key) => key === "detail:r",
      ),
    ),
  ).toEqual(["u", { fold: ["work:r"], ms: 5_000 }, "a", "e"]);
});

const compaction = (id: string, s: number): TranscriptItem => ({
  kind: "compaction",
  id,
  status: "done",
  before: 100,
  after: 10,
  at: at(s),
});

test("a finished turn folds everything before its answer into one line, which counts from the message", () => {
  const out = rows([
    user("u", 0),
    thought("r1"),
    tool("t1", 1),
    compaction("c", 3),
    tool("t2", 4),
    say("a1", 5, "Now the tests."),
    tool("t2b", 6),
    say("a2", 72),
    end("e", 73),
  ]);
  // The reply on the way folds with the steps; the answer is what stays.
  expect(shape(out)).toEqual([
    "u",
    { fold: ["work:r1,t1", "c", "work:t2", "a1", "work:t2b"], ms: 72_000 },
    "a2",
    "e",
  ]);
  // The fold opens the turn: it carries the speaker mark, its rows don't.
  const fold = out[1]!;
  expect(fold.speaker).toBe(true);
  expect(fold.kind === "fold" && fold.rows.some((r) => r.speaker)).toBe(false);
});

test("a Chief turn that answers, updates its items, then signs off shows the answer, not only the sign-off", () => {
  // The Windows report (2026-11-08): text, then three "Updated an item" calls, then "All set.", folded to "All set." alone.
  const steer: TranscriptItem = { kind: "user", id: "s", text: "s", at: at(2), delivery: "steer" };
  // What a steer cut off is withdrawn as an empty reply (ClaudeAdapterV2 withdrawCutAnswers): no row, no stray half line.
  const cut: TranscriptItem = {
    kind: "assistant",
    id: "cut",
    text: "",
    streaming: false,
    at: at(3),
  };
  const answer = say(
    "a1",
    6,
    "I'm the Chief. I coordinate your work: you type notes, and I sort each one.",
  );
  const items = [
    user("u", 0),
    steer,
    cut,
    answer,
    tool("i1", 7, "done", "chief_item_update"),
    tool("i2", 8, "done", "chief_item_update"),
    tool("i3", 9, "done", "chief_item_update"),
    say("a2", 10, "All set. Let me know what you'd like to work on."),
    end("e", 11),
  ];
  const out = rows(items, () => false, true);
  expect(shape(out)).toEqual(["u", "s", "a1", { fold: ["work:i1,i2,i3"], ms: 3_000 }, "a2", "e"]);
  // The answer opens the turn (its speaker mark), and only the item updates fold.
  expect(out.find((r) => r.id === "a1")?.speaker).toBe(true);
  // A plain chat reads as the message, its line and the sign-off, which answered it.
  expect(shape(rows(items))).toEqual([
    "u",
    "s",
    { fold: ["a1", "work:i1,i2,i3"], ms: 8_000 },
    "a2",
    "e",
  ]);
  // While it streams, an empty reply is a row: the engine began speaking.
  expect(
    shape(
      rows([user("u", 0), { kind: "assistant", id: "live", text: "", streaming: true, at: at(1) }]),
    ),
  ).toEqual(["u", "live"]);
});

test("what the person watches: a run at work, the open turn's other rows, and the fold its end makes; never history", () => {
  const working = (row: Extract<Row, { kind: "work" }>) =>
    row.items.some((i) => i.kind === "tool" && i.status === "running");
  // The open turn: its running run and its reply join; the run that settled before the chat opened does not.
  const live = rows([
    user("u0", 0),
    tool("h1", 1),
    tool("h2", 2),
    say("a0", 3),
    end("e0", 4),
    user("u", 10),
    tool("t1", 11),
    tool("t2", 12),
    say("a1", 13),
    tool("t3", 14, "running"),
  ]);
  expect(joinWatched(live, new Set(), working, new Set(["t1", "a1", "t3"]))).toEqual(["t3", "a1"]);
  expect(joinWatched(live, new Set(["t3", "a1"]), working, new Set(["t1", "a1", "t3"]))).toEqual(
    [],
  );
  // The turn ends: its fold joins, since it holds a row the person watched.
  const ended = rows([
    user("u0", 0),
    tool("h1", 1),
    tool("h2", 2),
    say("a0", 3),
    end("e0", 4),
    user("u", 10),
    tool("t1", 11),
    tool("t2", 12),
    compaction("c", 12),
    say("a1", 13),
    tool("t3", 14),
    say("a2", 20),
    end("e", 21),
  ]);
  const fold = ended.find((r) => r.kind === "fold" && r.rows.some((x) => x.id === "t1"))!;
  expect(joinWatched(ended, new Set(["t1", "a1"]), working, new Set())).toEqual([fold.id]);
  // One fold holds the turn's steps and the reply on the way; the answer it ended on was never folded.
  expect(fold.kind === "fold" && fold.rows.some((x) => x.id === "t3")).toBe(true);
  expect(joinWatched(ended, new Set(["a1"]), working, new Set())).toEqual([fold.id]);
  expect(joinWatched(ended, new Set(["a2"]), working, new Set())).toEqual([]);
  // A turn that ended before the chat opened stays folded, and so does one before the person's latest message.
  expect(joinWatched(ended, new Set(), working, new Set())).toEqual([]);
  expect(
    joinWatched([...ended, ...rows([user("u2", 30)])], new Set(["a1"]), working, new Set()),
  ).toEqual([]);
});

test("a fold the person still watches is laid back out as the rows the live turn showed", () => {
  const items = [
    user("u", 0),
    thought("r1"),
    tool("t1", 1),
    compaction("c", 3),
    tool("t2", 4),
    say("a1", 5, "Now the tests."),
    tool("t3", 6),
    say("a2", 72),
    end("e", 73),
  ];
  const live = rows(items.slice(0, -2));
  const ended = rows(items);
  const { rows: back, held } = expandHeld(ended, () => true);
  // The same rows, with the same speaker marks, the live turn had, then its answer and end.
  expect(back.slice(0, live.length)).toEqual(live);
  expect(shape(back)).toEqual(["u", "work:r1,t1", "c", "work:t2", "a1", "work:t3", "a2", "e"]);
  expect(held).toEqual([{ id: ended[1]!.id, rows: ["r1", "c", "t2", "a1", "t3"] }]);
  // Not held, it stays the fold, the very array.
  expect(expandHeld(ended, () => false)).toEqual({ rows: ended, held: [] });
});

test("asks stay in view, after the turn's one fold", () => {
  const out = rows([
    user("u", 0),
    thought("r1"),
    tool("t1", 1),
    compaction("c", 3),
    ask("k"),
    tool("t2", 5),
    say("a1", 9),
    end("e", 10),
  ]);
  expect(shape(out)).toEqual([
    "u",
    { fold: ["work:r1,t1", "c", "work:t2"], ms: 9_000 },
    "k",
    "a1",
    "e",
  ]);
});

test("a stopped turn with no answer folds all of its work, up to the turn's end", () => {
  const compacted: TranscriptItem = {
    kind: "compaction",
    id: "c",
    status: "done",
    before: 100,
    after: 10,
    at: at(3),
  };
  expect(
    shape(
      rows([
        user("u", 0),
        thought("r1"),
        tool("t1", 1),
        compacted,
        tool("t2", 4),
        end("e", 20, "interrupted"),
      ]),
    ),
  ).toEqual(["u", { fold: ["work:r1,t1", "c", "work:t2"], ms: 20_000 }, "e"]);
  // Its last words stay in view; the work on either side is one fold before them.
  expect(
    shape(
      rows([
        user("u", 0),
        thought("r1"),
        tool("t1", 1),
        say("a0", 3, "Trying again."),
        tool("t2", 4),
        end("e", 20, "interrupted"),
      ]),
    ),
  ).toEqual(["u", { fold: ["work:r1,t1", "work:t2"], ms: 5_000 }, "a0", "e"]);
});

test("the caller's own tool cards (the Chief's) stay in view after the fold", () => {
  const chief = tool("c1", 2, "done", "chat_send");
  const out = rows(
    [
      user("u", 0),
      thought("r1"),
      tool("t1", 1),
      compaction("c", 2),
      chief,
      say("a1", 5),
      end("e", 6),
    ],
    (tools) => tools.every((t) => t.name === "chat_send"),
  );
  expect(shape(out)).toEqual(["u", { fold: ["work:r1,t1", "c"], ms: 5_000 }, "work:c1", "a1", "e"]);
});

test("the Chief's turns (foldAll) show only the answer and what is kept: one step and a wake's line fold too", () => {
  const started = tool("c1", 2, "done", "chat_start");
  const asked = tool("c2", 3, "done", "ask");
  const keep = (tools: ReadonlyArray<ToolItem>) => tools.some((t) => t.name === "ask");
  // One step alone folds under the answer in Chiefs and ordinary chats.
  expect(shape(rows([user("u", 0), started, say("a1", 5), end("e", 6)], keep, true))).toEqual([
    "u",
    { fold: ["work:c1"], ms: 5_000 },
    "a1",
    "e",
  ]);
  expect(shape(rows([user("u", 0), started, say("a1", 5), end("e", 6)], keep))).toEqual([
    "u",
    { fold: ["work:c1"], ms: 5_000 },
    "a1",
    "e",
  ]);
  // A question stays in view.
  expect(
    shape(rows([user("u", 0), started, asked, say("a1", 5), end("e", 6)], keep, true)),
  ).toEqual(["u", "work:c1,c2", "a1", "e"]);
  // A wake ("1 chat changed") folds with the turn it opened; a warning never does.
  const wake: TranscriptItem = { kind: "notice", id: "n", tone: "info", text: "1 chat changed" };
  const warn: TranscriptItem = { kind: "notice", id: "w", tone: "warning", text: "Rate limited" };
  expect(
    shape(
      rows(
        [user("u", 0), say("a0", 1), end("e0", 2), wake, say("a1", 5), end("e1", 6)],
        keep,
        true,
      ),
    ),
  ).toEqual(["u", "a0", "e0", { fold: ["n"], ms: null }, "a1", "e1"]);
  expect(
    shape(
      rows(
        [user("u", 0), say("a0", 1), end("e0", 2), warn, say("a1", 5), end("e1", 6)],
        keep,
        true,
      ),
    ),
  ).toEqual(["u", "a0", "e0", "w", "a1", "e1"]);
});

const sub = (id: string, workspaceId: string | null): TranscriptItem => ({
  kind: "subagent",
  id,
  title: "Explore",
  workspaceId,
  agent: null,
  runner: null,
  summary: null,
  status: "done",
  startedAt: at(1),
  finishedAt: at(4),
  items: [],
});

test("a turn's subagents, native and delegated, are one group that stays in view once it ends", () => {
  expect(
    shape(
      rows([
        user("u", 0),
        tool("t1", 0),
        sub("s1", null),
        sub("s2", "w2"),
        say("a1", 8),
        end("e", 9),
      ]),
    ),
  ).toEqual(["u", { fold: ["work:t1"], ms: 8_000 }, "agents:s1,s2", "a1", "e"]);
});

test("subagents with only work between them join the first one's group; a reply between starts another", () => {
  const out = rows([
    user("u", 0),
    sub("s1", "w1"),
    tool("t1", 2),
    tool("t2", 3),
    sub("s2", "w2"),
    say("a0", 5, "Both started."),
    sub("s3", null),
    say("a1", 8),
    end("e", 9),
  ]);
  // The work between and the reply on the way fold; the groups and the answer stay in view.
  expect(shape(out)).toEqual([
    "u",
    "agents:s1,s2",
    { fold: ["work:t1,t2", "a0"], ms: 8_000 },
    "agents:s3",
    "a1",
    "e",
  ]);
});

test("a message steered into a running turn stays in view: each part of the turn folds up to its own answer", () => {
  const steer: TranscriptItem = {
    kind: "user",
    id: "s",
    text: "and the docs",
    at: at(10),
    delivery: "steer",
  };
  const out = rows([
    user("u", 0),
    thought("r1"),
    tool("t1", 1),
    say("a0", 5, "Running the tests."),
    tool("t2", 6),
    steer,
    thought("r2"),
    tool("t3", 12),
    say("a1", 20),
    end("e", 21),
  ]);
  // The reply before the steer answered the message; the fold after the steer counts from its own first step.
  expect(shape(out)).toEqual([
    "u",
    { fold: ["work:r1,t1", "work:t2"], ms: 7_000 },
    "a0",
    "s",
    { fold: ["work:r2,t3"], ms: 8_000 },
    "a1",
    "e",
  ]);
  // A queued message is a turn of its own.
  const queued: TranscriptItem = {
    kind: "user",
    id: "q",
    text: "then ship",
    at: at(30),
    delivery: "queue",
  };
  expect(
    shape(
      rows([
        user("u", 0),
        say("a0", 2),
        end("e", 3),
        queued,
        thought("r1"),
        tool("t1", 31),
        say("a1", 40),
        end("e2", 41),
      ]),
    ),
  ).toEqual(["u", "a0", "e", "q", { fold: ["work:r1,t1"], ms: 10_000 }, "a1", "e2"]);
});

test("Worked for, in whole seconds, minutes and hours", () => {
  expect([
    workedFor(null),
    workedFor(400),
    workedFor(42_000),
    workedFor(192_000),
    workedFor(180_000),
    workedFor(3_840_000),
  ]).toEqual([
    "Worked",
    "Worked for 1s",
    "Worked for 42s",
    "Worked for 3m 12s",
    "Worked for 3m",
    "Worked for 1h 4m",
  ]);
});

test("notes recalled for the agent fold with the turn's work; what memory saved stays in view, with no speaker mark", () => {
  const recalled: TranscriptItem = {
    kind: "memory",
    id: "m1",
    action: "recalled",
    notes: [{ id: "n1", name: "Day test midnight" }],
    at: at(2),
  };
  const remembered: TranscriptItem = {
    kind: "memory",
    id: "m2",
    action: "remembered",
    notes: [{ id: "n2", name: "Tests in UTC" }],
    at: at(4),
  };
  const out = rows([
    user("u", 0),
    tool("t1", 1),
    recalled,
    tool("t2", 3),
    remembered,
    say("a", 9),
    end("e", 10),
  ]);
  expect(shape(out)).toEqual([
    "u",
    { fold: ["work:t1", "m1", "work:t2"], ms: 9_000 },
    "m2",
    "a",
    "e",
  ]);
  const live = rows([user("u", 0), remembered]);
  expect(live.map((r) => r.speaker)).toEqual([false, false]);
});

test("the open turn starts after the person's last message; a steer stays inside it; an ended turn is not open", () => {
  const steer: TranscriptItem = {
    kind: "user",
    id: "s",
    text: "and the docs",
    at: at(10),
    delivery: "steer",
  };
  expect(
    openTurn(
      rows([user("u", 0), say("a0", 2), end("e", 3), user("u2", 4), tool("t1", 5, "running")]),
    ),
  ).toBe(4);
  expect(openTurn(rows([user("u", 0), tool("t1", 1), steer, tool("t2", 11, "running")]))).toBe(1);
  expect(openTurn(rows([user("u", 0), say("a0", 2), end("e", 3)]))).toBe(-1);
  expect(openTurn(rows([user("u", 0)]))).toBe(-1);
});

test("Working for, on the open turn's clock", () => {
  expect([workedFor(null, "Working"), workedFor(36_000, "Working")]).toEqual([
    "Working",
    "Working for 36s",
  ]);
});

test("a run's summary says what every call did, each kind once in order; one file or search keeps its name", () => {
  const t = (id: string, ...parts: Array<[ToolPart["action"], string?]>): ToolItem => ({
    ...tool(id, 0),
    parts: parts.map(([action, subject = "x"]) => ({ action, subject })),
  });
  expect(
    summarize([t("1", ["mcp"]), t("2", ["read", "a/b.go"]), t("3", ["read"]), t("4", ["command"])]),
  ).toBe("Called a connector, read 2 files, ran a command");
  expect(
    summarize([
      t("1", ["command"]),
      t("2", ["command"]),
      t("3", ["edit", "web/retry.go"]),
      t("4", ["search"]),
      t("5", ["search"]),
    ]),
  ).toBe("Ran 2 commands, edited retry.go, searched 2 times");
  // A shell command's every step counts: it read a file and searched; the next ran the tests and checked git status.
  expect(
    summarize([
      t("1", ["read", "src/retry.go"], ["search", "retryPolicy in src"]),
      t("2", ["test", ""], ["git_status", ""]),
      t("3", ["read", "src/retry.go"]),
    ]),
  ).toBe("Read retry.go, searched for retryPolicy in src, ran tests, checked git status");
});

test("a thought's title is its reasoning summary's latest heading", () => {
  expect(thoughtTitle("**Planning**\n\nfirst\n\n**Locating app process**\n\nps")).toBe(
    "Locating app process",
  );
  expect(thoughtTitle("Let me look at retry.go first, **carefully**.")).toBeNull();
});

test("a finished turn's head carries its whole time and its model; the router's pick names it", () => {
  const items: TranscriptItem[] = [
    { ...user("u", 0) },
    { ...tool("t1", 2), engine: "caveman", turnModel: "caveman/auto" },
    { ...tool("t2", 5), engine: "caveman", turnModel: "caveman/auto" },
    {
      kind: "route",
      id: "rt",
      model: "openrouter/x-ai/grok-4.7",
      at: at(6),
      engine: "caveman",
      turnModel: "caveman/auto",
    } as TranscriptItem,
    { ...say("a", 40), engine: "caveman", turnModel: "caveman/auto" },
    { ...end("e", 43), engine: "caveman", turnModel: "caveman/auto" },
  ];
  const all = rows(items);
  const heads = turnHeads(all);
  const fold = all.find((r) => r.kind === "fold")!;
  expect(heads.get(fold.id)).toEqual({
    ms: 43_000,
    engine: "caveman",
    model: "openrouter/x-ai/grok-4.7",
    folds: false,
  });
  // The open turn has no head yet: its line still ticks.
  expect(turnHeads(rows(items.slice(0, 3))).size).toBe(0);
});

test("a turn with nothing folded still gets a head on its first row", () => {
  const all = rows([
    user("u", 0),
    { ...say("a", 3), engine: "claude-agent", turnModel: "claude-opus-5-5" },
    { ...end("e", 3), engine: "claude-agent", turnModel: "claude-opus-5-5" },
  ]);
  expect([...turnHeads(all)]).toEqual([
    ["a", { ms: 3000, engine: "claude-agent", model: "claude-opus-5-5", folds: false }],
  ]);
});

test("a turn that spoke before its work folded says so, so a quiet head leaves the time to the fold", () => {
  const items = [
    user("u", 0),
    say("a1", 2, "Here's the answer."),
    tool("i1", 3),
    tool("i2", 4),
    say("a2", 6, "All set."),
    end("e", 7),
  ];
  expect(turnHeads(rows(items, () => false, true)).get("a1")?.folds).toBe(true);
  // A turn whose fold comes first: the fold is its head, and says the turn's time.
  const first = rows([user("u", 0), tool("i1", 1), say("a", 3), end("e", 4)], () => false, true);
  expect(turnHeads(first).get(first[1]!.id)).toMatchObject({ ms: 4_000, folds: false });
});

test("turn lines show the model, then working or worked for", () => {
  expect(turnLine("Grok 4.7", 43_000)).toBe("Grok 4.7 worked for 43s");
  expect(turnLine("Opus 5.5", 72_000, true)).toBe("Opus 5.5 working for 1m 12s");
  expect(turnLine("Codex", null)).toBe("Codex worked");
  expect(turnLine("", 5_000, true)).toBe("Working for 5s");
});

test("a turn waiting on the person says what it waits for, and no time", () => {
  expect(waitLine("approval")).toBe("waiting for your approval");
  expect(waitLine("question")).toBe("waiting for your answer");
  expect(waitLine("secret")).toBe("waiting for you");
  expect(waitLine("tool")).toBe("waiting for you");
});

test("a long command an approval waits on folds in its middle: the first lines, how many between, and the last", () => {
  const heredoc = [
    "cat >> tasks.test.js <<'EOF'",
    "",
    "test('a', () => {",
    "  x;",
    "});",
    "",
    "test('b', () => {",
    "  y;",
    "});",
    "EOF",
    "node --test",
  ].join("\n");
  const fold = foldLines(heredoc)!;
  expect(fold.head.split("\n")).toHaveLength(4);
  expect(fold.hidden).toBe(4);
  // The run step at its end is on screen before Allow.
  expect(fold.tail).toBe("});\nEOF\nnode --test");
  expect(foldLines("a\nb\nc\nd\ne\nf\ng\nh")).toBeNull();
});

test("the Chief: a turn that says nothing draws nothing, a wake's line included; the person's own note stays", () => {
  const wake: TranscriptItem = {
    kind: "user",
    id: "w",
    text: "<chat_update …>",
    at: at(0),
    delivery: "followup",
    generated: { line: "1 chat changed: Login form done" },
  };
  const quiet = [
    wake,
    tool("d1", 1, "done", "chat_digest"),
    tool("q1", 2, "done", "queue_update"),
    end("e", 3),
  ];
  expect(shape(rows(quiet, () => false, true))).toEqual([]);
  // An ordinary chat keeps its fold.
  expect(shape(rows(quiet))).toEqual(["w", { fold: ["work:d1,q1"], ms: 3_000 }, "e"]);
  // A wake that answers shows as before: its line, its work folded, its words.
  expect(
    shape(
      rows(
        [
          wake,
          tool("d1", 1, "done", "chat_digest"),
          say("a", 4, "Login form is ready for review."),
          end("e", 5),
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["w", { fold: ["work:d1"], ms: 4_000 }, "a", "e"]);
  // The person's note with a silent turn: the note, nothing under it.
  expect(
    shape(
      rows([user("u", 0), tool("q1", 1, "done", "queue_update"), end("e", 2)], () => false, true),
    ),
  ).toEqual(["u"]);
  // A question it keeps for the person, or a failed turn, is not silence.
  const kept = (tools: ReadonlyArray<ToolItem>) => tools.some((t) => t.name === "ask_person");
  expect(shape(rows([wake, tool("k", 1, "done", "ask_person"), end("e", 2)], kept, true))).toEqual([
    "w",
    "work:k",
    "e",
  ]);
  expect(shape(rows([wake, tool("d1", 1), end("e", 2, "interrupted")], () => false, true))).toEqual(
    ["w", { fold: ["work:d1"], ms: 2_000 }, "e"],
  );
  // Running: a wake shows nothing until it speaks; the person's own turn keeps its rows (its "Working" line).
  expect(
    shape(rows([say("a0", -5), end("e0", -4), wake, tool("d1", 1, "running")], () => false, true)),
  ).toEqual(["a0", "e0"]);
  expect(
    shape(
      rows(
        [
          wake,
          tool("d1", 1),
          { kind: "assistant", id: "a", text: "Login", streaming: true, at: at(2) },
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["w", "work:d1", "a"]);
  expect(shape(rows([user("u", 0), tool("d1", 1, "running")], () => false, true))).toEqual([
    "u",
    "work:d1",
  ]);
  // What the reader opened by hand in a turn that then ends silently stays, with the turn (STYLE.md section 0, rule 7).
  const silent = [user("u", 0), thought("r1"), tool("q1", 1, "done", "queue_update"), end("e", 2)];
  expect(
    shape(
      rows(
        silent,
        () => false,
        true,
        (key) => key === "detail:r1",
      ),
    ),
  ).toEqual(["u", { fold: ["work:r1,q1"], ms: 2_000 }, "e"]);
  expect(
    shape(
      rows(
        silent,
        () => false,
        true,
        (key) => key === "r1",
      ),
    ),
  ).toEqual(["u", { fold: ["work:r1,q1"], ms: 2_000 }, "e"]);
  expect(
    shape(
      rows(
        silent,
        () => false,
        true,
        () => false,
      ),
    ),
  ).toEqual(["u"]);
});

test("the Chief: a note sent while a turn runs is a message of its own, in order; the silent work before it goes", () => {
  const wake: TranscriptItem = {
    kind: "user",
    id: "w",
    text: "<chat_update …>",
    at: at(0),
    delivery: "followup",
    generated: { line: "1 chat changed" },
  };
  const note: TranscriptItem = {
    kind: "user",
    id: "s",
    text: "and add dark mode",
    at: at(10),
    delivery: "steer",
  };
  const out = rows(
    [
      wake,
      tool("d1", 1),
      note,
      tool("q1", 11, "done", "chat_start"),
      say("a", 14, "Started [[3]]."),
      end("e", 15),
    ],
    () => false,
    true,
  );
  expect(shape(out)).toEqual(["s", { fold: ["work:q1"], ms: 4_000 }, "a", "e"]);
  // Drawn as the person's message, not "You added · this turn"; the same item while the turn streams on.
  const steered = out[0]!;
  expect(steered.kind === "item" && steered.item.kind === "user" && steered.item.delivery).toBe(
    "message",
  );
  const again = rows(
    [
      wake,
      tool("d1", 1),
      note,
      tool("q1", 11, "done", "chat_start"),
      say("a", 14, "Started [[3]]."),
      end("e", 15),
    ],
    () => false,
    true,
  )[0]!;
  expect(again.kind === "item" && steered.kind === "item" && again.item === steered.item).toBe(
    true,
  );
  // Its turn is the rest: the turn's line counts from the note, and the open turn starts after it.
  expect(turnHeads(out).get(out[1]!.id)?.ms).toBe(5_000);
  expect(
    openTurn(
      rows([user("u", 0), tool("t1", 1), note, tool("t2", 11, "running")], () => false, true),
    ),
  ).toBe(2);
  // What the turn said before the note stays, as it was said.
  expect(
    shape(
      rows(
        [user("u", 0), tool("t1", 1), say("a0", 3, "On it."), note, say("a1", 12), end("e", 13)],
        () => false,
        true,
      ),
    ),
  ).toEqual(["u", { fold: ["work:t1"], ms: 3_000 }, "a0", "s", "a1", "e"]);
});

test("the Chief: a reaction adds no card or blank row", () => {
  const reaction: TranscriptItem = {
    kind: "moment",
    id: "reaction-1",
    at: at(1),
    text: "Reacted 👍",
    moment: { kind: "reaction", message_id: "u", emoji: "👍" },
  };
  expect(shape(rows([user("u", 0), reaction]))).toEqual(["u"]);
  expect(shape(rows([user("u", 0), reaction], () => false, true))).toEqual(["u"]);
});

test("the Chief: a moment stays in view, never folds, has no speaker mark and is never its words", () => {
  const wake: TranscriptItem = {
    kind: "user",
    id: "w",
    text: "<chat_update …>",
    at: at(0),
    delivery: "followup",
    generated: { line: "1 chat changed" },
  };
  const moment = (id: string, s: number): TranscriptItem => ({
    kind: "moment",
    id,
    at: at(s),
    moment: { kind: "result", workspace_id: "ws-1" },
    text: "Login form: done",
  });
  // A silent wake: no "Worked" line, no steps, no wake line; its moments stay.
  expect(
    shape(
      rows(
        [
          wake,
          tool("d1", 1, "done", "chat_digest"),
          moment("m1", 2),
          tool("q1", 3, "done", "queue_update"),
          end("e", 4),
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["m1"]);
  // The person's silent turn: the note, then its moments.
  expect(
    shape(rows([user("u", 0), moment("m1", 1), tool("q1", 2), end("e", 3)], () => false, true)),
  ).toEqual(["u", "m1"]);
  // Between turns, where the runtime writes most of them, and before a running wake has spoken.
  expect(
    shape(
      rows(
        [user("u", 0), say("a", 1), end("e", 2), moment("m1", 3), moment("m2", 4)],
        () => false,
        true,
      ),
    ),
  ).toEqual(["u", "a", "e", "m1", "m2"]);
  expect(shape(rows([wake, moment("m1", 1), tool("d1", 2, "running")], () => false, true))).toEqual(
    ["m1"],
  );
  // A turn that answers: the moment sits before its work's one fold, which still counts from the turn's start.
  const answered = rows(
    [
      user("u", 0),
      tool("d1", 1),
      moment("m1", 2),
      tool("d2", 3),
      say("a", 6, "Login form is ready."),
      end("e", 7),
    ],
    () => false,
    true,
  );
  expect(shape(answered)).toEqual([
    "u",
    "m1",
    { fold: ["work:d1", "work:d2"], ms: 6_000 },
    "a",
    "e",
  ]);
  expect(answered.find((r) => r.id === "m1")?.speaker).toBe(false);
  // A wake right after a result's card is its narration: only its words, under the card, no wake line or "Worked" line.
  const result: TranscriptItem = {
    kind: "moment",
    id: "m2",
    at: at(1),
    moment: { kind: "result", workspace_id: "ws-1" },
    text: "Login form: done",
  };
  const narration = rows(
    [
      say("a0", -5),
      end("e0", -4),
      result,
      wake,
      tool("d1", 2, "done", "chat_digest"),
      say("a", 4, "Login form is ready."),
      end("e", 5),
    ],
    () => false,
    true,
  );
  expect(shape(narration)).toEqual(["a0", "e0", "m2", "a", "e"]);
  expect(turnHeads(narration).size).toBe(1);
  // A Chief's wake as every engine journals it: the runtime's notification line, then its turn, with no message to open
  // it. Its narration sits under the card the same way, the wake line and its work folded away, running or done.
  const line: TranscriptItem = {
    kind: "notice",
    id: "n",
    tone: "info",
    text: "1 chat changed: Login form for review",
  };
  const told = [
    say("a0", -5),
    end("e0", -4),
    result,
    line,
    tool("d1", 2, "done", "chat_digest"),
    say("a", 4, "Login form is ready."),
    end("e", 5),
  ];
  expect(shape(rows(told, () => false, true))).toEqual(["a0", "e0", "m2", "a", "e"]);
  expect(
    shape(
      rows(
        [
          ...told.slice(0, 5),
          { kind: "assistant", id: "a", text: "Login form", streaming: true, at: at(4) },
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["a0", "e0", "m2", "a"]);
  // Silent, it leaves the card alone.
  expect(shape(rows([...told.slice(0, 5), end("e", 5)], () => false, true))).toEqual([
    "a0",
    "e0",
    "m2",
  ]);
  // After any other moment, a wake that speaks shows as before.
  const started: TranscriptItem = {
    kind: "moment",
    id: "m3",
    at: at(1),
    moment: { kind: "started", workspace_id: "ws-1" },
    text: "Started Login form",
  };
  expect(
    shape(rows([started, wake, say("a", 4, "Noted."), end("e", 5)], () => false, true)),
  ).toEqual(["m3", "w", "a", "e"]);
  // Another chat's card between the result's and its wake (written in the wake's quiet spell): still its narration.
  expect(
    shape(
      rows(
        [
          say("a0", -5),
          end("e0", -4),
          result,
          started,
          wake,
          tool("d1", 2, "done", "chat_digest"),
          say("a", 4, "Login form is ready."),
          end("e", 5),
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["a0", "e0", "m2", "m3", "a", "e"]);
  expect(
    shape(
      rows(
        [
          say("a0", -5),
          end("e0", -4),
          result,
          started,
          line,
          tool("d1", 2, "done", "chat_digest"),
          say("a", 4, "Login form is ready."),
          end("e", 5),
        ],
        () => false,
        true,
      ),
    ),
  ).toEqual(["a0", "e0", "m2", "m3", "a", "e"]);
  // Never a step behind a running turn's line.
  const live = rows(
    [user("u", 0), tool("d1", 1), moment("m1", 2), tool("d2", 3, "running")],
    () => false,
    true,
  );
  expect(liveSteps(live.slice(openTurn(live)), () => false, true).has("m1")).toBe(false);
});
