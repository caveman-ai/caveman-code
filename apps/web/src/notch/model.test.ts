// What the notch marks, which chat becomes its card, when it opens by itself, and what a card's keys do.
import { expect, test } from "vitest";
import {
  chatStatuses,
  type ActivityView,
  type InboxView,
  type WorkspaceView,
} from "../state/model.ts";
import type { SessionView } from "../state/transcript-model.ts";
import {
  askToken,
  cardChat,
  heldChats,
  answerOf,
  cardKeys,
  notchChats,
  pressLedger,
  pressOf,
  previewOf,
  seenWaits,
  SETTLE_MS,
  settledWaits,
  sightings,
  unseenWaits,
  waitKey,
} from "./model.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const activity = (over: Partial<ActivityView> = {}): ActivityView => ({
  ask: null,
  turnStartedAt: null,
  lastOutcome: null,
  turnEndedAt: null,
  todos: null,
  readyToBuild: false,
  ...over,
});
const inbox = (over: Partial<InboxView>): InboxView => ({
  doneAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...over,
});
const w = (id: string, over: Partial<WorkspaceView>): WorkspaceView =>
  ({
    id,
    title: id,
    repo: "app",
    state: "completed",
    asleep: false,
    parentId: null,
    sessionId: `s-${id}`,
    createdAt: "2026-11-13T09:00:00Z",
    updatedAt: "2026-11-13T10:00:00Z",
    unread: false,
    ...over,
  }) as WorkspaceView;
const chats = (list: WorkspaceView[]) => notchChats(list, chatStatuses(list), NOW);
/** A chat's wait key, as the notch marks it alone. */
const wk = (x: WorkspaceView) => waitKey(chats([x]).waiting[0]!);
const ids = (list: ReadonlyArray<{ workspace: WorkspaceView }>) => list.map((c) => c.workspace.id);

const asking = (id: string, at: string) =>
  w(id, {
    state: "needs_input",
    updatedAt: at,
    activity: activity({ ask: { kind: "approval", prompt: "Allow rm?" } }),
  });
const working = (id: string, started: string) =>
  w(id, { state: "working", activity: activity({ turnStartedAt: started }) });
const finished = (id: string, at: string, over: Partial<WorkspaceView> = {}) =>
  w(id, {
    state: "completed",
    unread: true,
    updatedAt: at,
    activity: activity({ lastOutcome: "completed" }),
    ...over,
  });

test("it marks what waits and what works, the waiting first, and nothing that is read, archived, snoozed or done", () => {
  const { marked } = chats([
    working("late", "2026-11-13T11:00:00Z"),
    working("early", "2026-11-13T10:30:00Z"),
    finished("fin", "2026-11-13T11:30:00Z"),
    asking("ask", "2026-11-13T11:40:00Z"),
    w("read", { state: "completed" }),
    w("gone", { state: "archived" }),
    finished("snoozed", "2026-11-13T09:30:00Z", {
      inbox: inbox({ snoozedUntil: "2026-11-13T15:00:00Z", snoozedAt: "2026-11-13T11:00:00Z" }),
    }),
    finished("put-away", "2026-11-13T09:30:00Z", {
      inbox: inbox({ doneAt: "2026-11-13T11:00:00Z" }),
    }),
    w("step", { state: "working", automationStep: true }),
  ]);
  // A working chat keeps its place from its turn's start: marks never reshuffle as events land.
  expect(ids(marked)).toEqual(["ask", "early", "late", "fin"]);
});

test("a failed turn is marked until somebody has looked at it", () => {
  const at = "2026-11-13T11:00:00Z";
  expect(ids(chats([w("f", { state: "failed", unread: true, updatedAt: at })]).marked)).toEqual([
    "f",
  ]);
  expect(ids(chats([w("f", { state: "failed", unread: false, updatedAt: at })]).marked)).toEqual(
    [],
  );
});

test("a turn that ended over two hours ago is old news and leaves the notch; an ask stays while it waits", () => {
  const { marked } = chats([
    finished("fin-new", "2026-11-13T10:30:00Z"),
    finished("fin-old", "2026-11-13T09:59:00Z"),
    w("failed-old", { state: "failed", unread: true, updatedAt: "2026-11-12T12:00:00Z" }),
    w("plan-old", {
      updatedAt: "2026-11-12T12:00:00Z",
      activity: activity({ readyToBuild: true }),
    }),
    asking("ask-old", "2026-11-12T12:00:00Z"),
    working("busy", "2026-11-12T12:00:00Z"),
  ]);
  expect(ids(marked)).toEqual(["ask-old", "busy", "fin-new"]);
});

test("a turn that ended while its delegate, a background task or a pull request watch still runs is at work, never a wait", () => {
  const awaiting = (id: string) =>
    finished(id, "2026-11-13T11:30:00Z", {
      activity: activity({
        lastOutcome: "completed",
        turnEndedAt: "2026-11-13T11:30:00Z",
        awaiting: true,
      }),
    });
  const lead = awaiting("lead");
  const { marked, waiting } = chats([
    awaiting("watch"),
    lead,
    { ...working("child", "2026-11-13T11:00:00Z"), parentId: "lead" },
    finished("fin", "2026-11-13T11:40:00Z"),
  ]);
  expect(waiting.map((c) => c.workspace.id)).toEqual(["fin"]);
  expect(marked.map((c) => [c.workspace.id, c.status.id])).toEqual([
    ["watch", "working"],
    ["lead", "agents"],
    ["fin", "done"],
  ]);
  // The work settled: now it finished, and the notch says so.
  const settled = {
    ...lead,
    activity: activity({ lastOutcome: "completed", turnEndedAt: "2026-11-13T11:30:00Z" }),
  };
  expect(chats([settled]).waiting.map((c) => c.status.id)).toEqual(["done"]);
});

test("an agent's agent speaks only to ask the person, its lead listed or not; a stopped turn is not a wait", () => {
  const delegate = (id: string, over: Partial<WorkspaceView>) =>
    finished(id, "2026-11-13T11:30:00Z", { parentId: "gone-lead", ...over });
  const { marked } = chats([
    delegate("child-done", {}),
    w("child-failed", {
      state: "failed",
      unread: true,
      parentId: "gone-lead",
      updatedAt: "2026-11-13T11:30:00Z",
    }),
    finished("outside", "2026-11-13T11:30:00Z", { startedBy: "Claude Code" }),
    { ...asking("child-asks", "2026-11-13T11:40:00Z"), parentId: "gone-lead" },
    finished("stopped", "2026-11-13T11:30:00Z", {
      activity: activity({ lastOutcome: "interrupted" }),
    }),
  ]);
  expect(ids(marked)).toEqual(["child-asks"]);
});

test("an agent under a lead is its lead's to speak for, unless it waits on the person itself", () => {
  const lead = working("lead", "2026-11-13T10:00:00Z");
  expect(
    ids(chats([lead, { ...working("child", "2026-11-13T10:05:00Z"), parentId: "lead" }]).marked),
  ).toEqual(["lead"]);
  expect(
    ids(chats([lead, { ...asking("child", "2026-11-13T10:05:00Z"), parentId: "lead" }]).waiting),
  ).toEqual(["child"]);
});

test("the waits go asks first, then each kind the newest first: the order the card's arrows page in", () => {
  const { waiting } = chats([
    finished("fin-old", "2026-11-13T10:30:00Z"),
    finished("fin-new", "2026-11-13T11:30:00Z"),
    asking("ask-new", "2026-11-13T11:50:00Z"),
    asking("ask-old", "2026-11-13T11:10:00Z"),
    working("busy", "2026-11-13T11:00:00Z"),
  ]);
  expect(ids(waiting)).toEqual(["ask-new", "ask-old", "fin-new", "fin-old"]);
});

test("the card shows the chat it is told to while that waits, else the first, with its neighbours for the arrows", () => {
  const { waiting } = chats([
    asking("ask", "2026-11-13T11:50:00Z"),
    finished("fin-new", "2026-11-13T11:30:00Z"),
    finished("fin-old", "2026-11-13T10:30:00Z"),
  ]);
  expect(cardChat(waiting, "fin-new")).toMatchObject({ index: 1, prev: "ask", next: "fin-old" });
  expect(cardChat(waiting, "fin-new")?.chat.workspace.id).toBe("fin-new");
  // It stopped waiting (read, answered, put away): the first takes the card.
  expect(cardChat(waiting, "gone")).toMatchObject({ index: 0, prev: null, next: "fin-new" });
  expect(cardChat([], "ask")).toBeNull();
});

test("a rename moves updated_at, never how old a wait is: an old turn stays gone and is not announced again", () => {
  const ended = "2026-11-13T09:00:00Z";
  const old = finished("old", "2026-11-13T11:59:00Z", {
    activity: activity({ lastOutcome: "completed", turnEndedAt: ended }),
  });
  expect(ids(chats([old]).marked)).toEqual([]);
  const fresh = finished("fresh", "2026-11-13T11:00:00Z", {
    activity: activity({ lastOutcome: "completed", turnEndedAt: "2026-11-13T11:00:00Z" }),
  });
  const renamed = { ...fresh, title: "Renamed", updatedAt: "2026-11-13T11:58:00Z" };
  expect(wk(renamed)).toBe(wk(fresh));
});

test("the unseen waits are those the person has not had in front of them, the one that came last first", () => {
  const a = asking("a", "2026-11-13T11:10:00Z");
  const b = finished("b", "2026-11-13T11:50:00Z");
  const { waiting } = chats([a, b]);
  expect(unseenWaits(waiting, new Set())).toEqual([wk(b), wk(a)]);
  expect(unseenWaits(waiting, new Set([wk(b)]))).toEqual([wk(a)]);
  expect(unseenWaits(waiting, new Set([wk(a), wk(b)]))).toEqual([]);
  // It asks again later: a new wait under a new key, which the notch has not announced.
  const again = { ...a, updatedAt: "2026-11-13T11:55:00Z" };
  expect(unseenWaits(chats([again, b]).waiting, new Set([wk(a), wk(b)]))).toEqual([wk(again)]);
});

test("a wait counts once it has held SETTLE_MS; one that goes before then never counts", () => {
  const t = 1_000_000;
  const first = sightings(new Map(), ["a"], t);
  expect(settledWaits(["a"], first, t + SETTLE_MS - 1)).toEqual([]);
  // Seen again later, it keeps its first sighting: an unchanged set is the same map.
  expect(sightings(first, ["a"], t + 500)).toBe(first);
  expect(settledWaits(["a"], first, t + SETTLE_MS)).toEqual(["a"]);
  // It went (a queued message started) and came back: it holds from its return.
  const gone = sightings(first, [], t + 1_000);
  const back = sightings(gone, ["a"], t + 2_000);
  expect(settledWaits(["a"], back, t + SETTLE_MS)).toEqual([]);
  expect(settledWaits(["a"], back, t + 2_000 + SETTLE_MS)).toEqual(["a"]);
});

test("a wait that has not held takes no card and stays at work in the rows; everything else stays", () => {
  const ask = asking("ask", "2026-11-13T11:50:00Z");
  const fin = finished("fin", "2026-11-13T11:30:00Z");
  const busy = working("busy", "2026-11-13T11:00:00Z");
  const all = chats([ask, fin, busy]);
  expect(heldChats(all, new Set())).toBe(all);
  const held = heldChats(all, new Set([wk(ask)]));
  expect(ids(held.waiting)).toEqual(["fin"]);
  // Still counted, as at work, among those at work: the mark at rest does not drop it.
  expect(held.marked.map((c) => [c.workspace.id, c.status.id])).toEqual([
    ["ask", "working"],
    ["busy", "working"],
    ["fin", "done"],
  ]);
  expect(cardChat(held.waiting, null)?.chat.workspace.id).toBe("fin");
});

test("answering the newest wait leaves the older one as it was: nothing new for the notch to open on", () => {
  // A finished at 11:00 and was announced; B asks at 11:05 and takes the card. Allowing B must not announce A again.
  const a = finished("a", "2026-11-13T11:00:00Z");
  const b = asking("b", "2026-11-13T11:05:00Z");
  const both = unseenWaits(chats([a, b]).waiting, new Set());
  const after = unseenWaits(chats([a]).waiting, new Set());
  expect(both).toEqual([wk(b), wk(a)]);
  expect(after.filter((key) => !both.includes(key))).toEqual([]);
});

test("a wait on screen in the app, in front, counts as seen, and stays seen until it stops waiting", () => {
  const a = asking("a", "2026-11-13T11:10:00Z");
  const { waiting } = chats([a]);
  const none = new Set<string>();
  // The app is behind another: nothing is on screen.
  expect(seenWaits(none, waiting, null)).toBe(none);
  const seen = seenWaits(none, waiting, ["a"]);
  expect([...seen]).toEqual([wk(a)]);
  // Switching away from the app does not un-see it, and an unchanged set is the same set.
  expect(seenWaits(seen, waiting, null)).toBe(seen);
  // Answered: it no longer waits, and its key goes.
  expect(seenWaits(seen, [], null).size).toBe(0);
});

const approval = {
  id: "ask-1",
  askKind: "approval",
  options: [
    { id: "once", label: "Allow", description: null, decision: "allow" },
    { id: "no", label: "Deny", description: null, decision: "deny" },
  ],
} as unknown as NonNullable<SessionView["pendingAsk"]>;

test("an approval's card carries its own options, the first that allows in white, and a key answers with that option", () => {
  const a = asking("a", "2026-11-13T11:10:00Z");
  const status = chatStatuses([a]).get("a")!;
  const keys = cardKeys(a, status, approval);
  expect(keys.map((k) => [k.label, k.tone])).toEqual([
    ["Allow", "lit"],
    ["Deny", "card"],
  ]);
  expect(pressOf(keys[0]!.id)).toEqual({
    do: "answer",
    ask: askToken("ask-1"),
    option: askToken("once"),
  });
  expect(answerOf(approval, pressOf(keys[0]!.id) as never)).toEqual({
    kind: "approval",
    option_id: "once",
  });
  // Until its session has loaded the options, and for one with more than fit a row, the chat answers it.
  expect(cardKeys(a, status, null)).toEqual([{ id: "open", label: "Review", tone: "lit" }]);
  expect(
    cardKeys(a, status, { ...approval, options: [...approval.options, ...approval.options] }),
  ).toHaveLength(1);
});

test("a key stays short whatever the engine calls its ask, and names that ask alone", () => {
  // Claude Agent's ask id names its whole turn: hundreds of characters, which the desktop shell would drop.
  const long = `runtime-request:provider:claudeAgent:provider-turn:${"provider-turn%3Aprovider%3AclaudeAgent%3Anative-turn".repeat(6)}:native-request:toolu_01LATVg6XmsEkuwGoNH1WLpe:29ff2e0a`;
  const a = asking("a", "2026-11-13T11:10:00Z");
  const keys = cardKeys(a, chatStatuses([a]).get("a")!, { ...approval, id: long });
  expect(long.length).toBeGreaterThan(300);
  expect(Math.max(...keys.map((k) => k.id.length))).toBeLessThan(40);
  expect(pressOf(keys[0]!.id)).toEqual({
    do: "answer",
    ask: askToken(long),
    option: askToken("once"),
  });
  // The next ask of the same chat has the same options and another token: the old key does not answer it.
  expect(askToken(`${long}-next`)).not.toBe(askToken(long));
});

test("a finished turn offers Ship it only while its work is not on its base, else Done, and Later either way; a question is answered in the chat", () => {
  const landed = finished("f", "2026-11-13T11:00:00Z");
  const status = chatStatuses([landed]).get("f")!;
  expect(cardKeys(landed, status, null).map((k) => [k.label, k.tone])).toEqual([
    ["Done", "lit"],
    ["Later", "card"],
  ]);
  const open = {
    ...landed,
    pullRequest: { number: 7, url: "https://github.com/o/r/pull/7", state: "open" as const },
  };
  expect(cardKeys(open, status, null).map((k) => [k.label, k.tone])).toEqual([
    ["Ship it", "lit"],
    ["Later", "card"],
  ]);
  expect(cardKeys({ ...landed, unmerged: { files: 0, commits: 2 } }, status, null)[0]!.label).toBe(
    "Ship it",
  );
  expect(pressOf("ship")).toEqual({ do: "ship" });
  expect(pressOf("seen")).toEqual({ do: "seen" });
  expect(pressOf("later")).toEqual({ do: "later" });
  const q = w("q", {
    state: "needs_input",
    activity: activity({ ask: { kind: "question", prompt: "Which one?" } }),
  });
  expect(cardKeys(q, chatStatuses([q]).get("q")!, null)).toEqual([
    { id: "open", label: "Answer", tone: "lit" },
  ]);
  expect(pressOf("open")).toEqual({ do: "open" });
  expect(pressOf("anything else")).toEqual({ do: "open" });
});

test("a question with a few options is answered on the notch, the recommended one in white; a wider one in the chat", () => {
  const q = w("q", {
    state: "needs_input",
    activity: activity({ ask: { kind: "question", prompt: "Which one?" } }),
  });
  const status = chatStatuses([q]).get("q")!;
  const options = [
    { id: "a", label: "Keep it", description: null },
    { id: "b", label: "Drop it", description: null },
  ];
  const question = {
    id: "ask-q",
    askKind: "question",
    round: null,
    options,
    questions: [
      {
        id: "q1",
        prompt: "Which one?",
        detail: null,
        options,
        recommended: "b",
        multiSelect: false,
      },
    ],
  } as unknown as NonNullable<SessionView["pendingAsk"]>;
  const keys = cardKeys(q, status, question);
  expect(keys.map((k) => [k.label, k.tone])).toEqual([
    ["Keep it", "card"],
    ["Drop it", "lit"],
  ]);
  expect(pressOf(keys[1]!.id)).toEqual({
    do: "answer",
    ask: askToken("ask-q"),
    option: askToken("b"),
  });
  expect(answerOf(question, pressOf(keys[1]!.id) as never)).toEqual({
    kind: "question",
    answers: [{ question_id: "q1", option_ids: ["b"] }],
  });
  // No recommendation: the first is white.
  const plain = { ...question, questions: [{ ...question.questions[0]!, recommended: null }] };
  expect(cardKeys(q, status, plain)[0]!.tone).toBe("lit");
  // Several picks, several questions, a grill round, free text only: the chat answers it.
  const multi = { ...question, questions: [{ ...question.questions[0]!, multiSelect: true }] };
  const two = { ...question, questions: [...question.questions, ...question.questions] };
  for (const wide of [multi, two, { ...question, round: 1 }, { ...question, options: [] }])
    expect(cardKeys(q, status, wide)).toEqual([{ id: "open", label: "Answer", tone: "lit" }]);
});

test("a key names its option by its own token, and the answer carries the option's own id exactly, whatever it holds", () => {
  const q = w("q", {
    state: "needs_input",
    activity: activity({ ask: { kind: "question", prompt: "Which one?" } }),
  });
  const status = chatStatuses([q]).get("q")!;
  // An id with a tab, which a key would split on, and one longer than the desktop shell carries (200).
  const odd = [
    { id: "keep\tit", label: "Keep it", description: null },
    { id: "x".repeat(500), label: "Drop it", description: null },
  ];
  const question = {
    id: "ask-odd",
    askKind: "question",
    round: null,
    options: odd,
    questions: [
      { id: "q1", prompt: "?", detail: null, options: odd, recommended: null, multiSelect: false },
    ],
  } as unknown as NonNullable<SessionView["pendingAsk"]>;
  const keys = cardKeys(q, status, question);
  expect(Math.max(...keys.map((k) => k.id.length))).toBeLessThan(40);
  const ids = keys.map((k) => {
    const press = pressOf(k.id);
    if (press.do !== "answer") throw new Error(`not an answer: ${k.id}`);
    const answer = answerOf(question, press);
    return answer?.kind === "question" ? answer.answers[0]!.option_ids[0] : null;
  });
  expect(ids).toEqual(["keep\tit", "x".repeat(500)]);
  // A key drawn for another ask, or naming no option of this one, answers nothing.
  expect(
    answerOf(question, { ask: askToken("ask-other"), option: askToken("keep\tit") }),
  ).toBeNull();
  expect(answerOf(question, { ask: askToken("ask-odd"), option: askToken("gone") })).toBeNull();
  // The same ask with its options in another order: a key still answers with the option it showed, not the one now
  // standing where it stood.
  const reordered = { ...question, options: [...odd].reverse() };
  const shown = pressOf(keys[0]!.id);
  if (shown.do !== "answer") throw new Error("not an answer");
  expect(answerOf(reordered, shown)).toEqual({
    kind: "question",
    answers: [{ question_id: "q1", option_ids: ["keep\tit"] }],
  });
  // The order is part of what is drawn: the keys themselves change with it, so the notch rearms (Notch.tsx).
  expect(cardKeys(q, status, reordered).map((k) => k.id)).toEqual(keys.map((k) => k.id).reverse());
  // A key that is not one the notch drew is no answer.
  expect(pressOf(`ask\t${askToken("ask-odd")}\tkeep\tit`)).toEqual({ do: "open" });
  expect(pressOf(`ask\t${askToken("ask-odd")}\t-1`)).toEqual({ do: "open" });
});

test("a failed turn's white key marks it read, and Later snoozes it: the card itself opens the chat", () => {
  const f = w("f", { state: "failed", unread: true, updatedAt: "2026-11-13T11:00:00Z" });
  expect(cardKeys(f, chatStatuses([f]).get("f")!, null)).toEqual([
    { id: "seen", label: "Done", tone: "lit" },
    { id: "later", label: "Later", tone: "card" },
  ]);
});

test("the preview is the last picture of the latest turn, an agent's or its subagent's, and none from an earlier turn", () => {
  const image = (itemId: string, src: string) => ({
    id: `${itemId}:image`,
    itemId,
    title: src,
    meta: "",
    kind: "image",
    src,
    alt: "",
    line: null,
  });
  const view = (items: unknown[], artifacts: unknown[]) =>
    ({ items, artifacts }) as unknown as Pick<SessionView, "items" | "artifacts">;
  const items = [
    { kind: "user", id: "u1" },
    { kind: "assistant", id: "a1" },
    { kind: "user", id: "u2" },
    { kind: "subagent", id: "sub", items: [{ kind: "tool", id: "t1" }] },
    { kind: "assistant", id: "a2" },
  ];
  expect(
    previewOf(
      view(items, [image("a1", "old.png"), image("t1", "sub.png"), image("a2", "proof.png")]),
    ),
  ).toEqual({ src: "proof.png", itemId: "a2" });
  expect(previewOf(view(items, [image("a1", "old.png"), image("t1", "sub.png")]))).toEqual({
    src: "sub.png",
    itemId: "t1",
  });
  expect(previewOf(view(items, [image("a1", "old.png")]))).toBeNull();
  expect(previewOf(null)).toBeNull();
});

test("a failure from a press the person has since pressed again is stale; presses on other chats leave it current", () => {
  const ledger = pressLedger();
  const first = ledger.press("a");
  expect(first()).toBe(true);
  // Another chat's card pressed meanwhile: chat a's press is still its latest, and its failure still shows.
  const other = ledger.press("b");
  expect(first()).toBe(true);
  // The person presses chat a again (a retry, or another key): the first press's late failure is no news.
  const retry = ledger.press("a");
  expect(first()).toBe(false);
  expect(retry()).toBe(true);
  expect(other()).toBe(true);
});
