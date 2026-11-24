// A long transcript paints its last rows first; the older rows follow in a transition (an effect, so a
// static render shows the first paint only). Rows out of view skip layout via content-visibility.
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

vi.mock("../panes/drag.ts", () => ({}));
vi.mock("../panes/store.ts", () => ({ panes: {} }));
vi.mock("../panels/store.ts", async (real) => ({ ...(await real<object>()), usePanel: () => ({ open: false, tabs: [] }) }));
import type { SessionEvent } from "@caveman-app/session-protocol";
import { SessionModel } from "../state/transcript.ts";
import type { TranscriptItem } from "../state/transcript-model.ts";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import { setLiveSteps } from "../state/live-steps.ts";
import { TurnChanges } from "./transcript/TurnChanges.tsx";
import { ASK_ARM_MS, askAnnouncement, askKey, askTakes, editPoints, fillGap, foldsUserMessage, holdTop, holdWindow, jumpWindow, openingWindow, railMessages, sentAt, Transcript, turnAnnouncement, turnAnswers, turnCheckpoints, type TranscriptProps } from "./Transcript.tsx";

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: "user", id: `u${i}`, text: `turn-${i}-marker`, at: "2026-10-16T00:00:00.000Z", delivery: "message" }) as TranscriptItem);

const render = (items: ReadonlyArray<TranscriptItem>, props: Partial<TranscriptProps> = {}, engines: ReadonlyArray<{ id: string; label: string }> = []) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        MemoryRouter,
        null,
        createElement(
          RuntimeContext.Provider,
          { value: { client: null, engines, workspaces: [], raw: new Map(), refresh: async () => undefined } as unknown as RuntimeContextValue },
          createElement(Transcript, { items, engineLabel: "Claude Agent", engineIsCaveman: false, running: false, onAnswer: () => undefined, cavemanVersion: null, ...props }),
        ),
      ),
    ),
  );

// A turn's speaker: the mark's name on its "worked for" line, or the speaker mark of a turn with no line yet.
const speakerLabels = (html: string) => [...html.matchAll(/<span>(Claude Agent|Codex|Caveman|Muse)<\/span>|role="img" aria-label="(Claude Agent|Codex|Caveman|Muse)"/g)].map((m) => m[1] ?? m[2]);

// The same public reducer the client uses for session.attach replay and live events.
const harnessLog = () => {
  const events: SessionEvent[] = [];
  const emit = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}) => {
    events.push({ session_id: "s1", cursor: events.length + 1, at: "2026-10-18T10:00:00.000Z", type, payload, ...extra } as SessionEvent);
  };
  return { events, emit };
};

test.each(["streamed", "done-only"])("turn harness attribution: replayed %s replies keep Claude → Codex Luna → Codex Sol → Claude labels", (delivery) => {
  const { events, emit } = harnessLog();
  const expected = ["Claude Agent", "Codex", "Codex", "Claude Agent"];
  for (const [i, engine] of ["claude-agent", "codex", "codex", "claude-agent"].entries()) {
    const turn_id = `t${i}`;
    emit("message.done", { role: "user", text: `request ${i}` }, { turn_id, item_id: `u${i}` });
    // Sol deliberately omits model: harness identity does not depend on model metadata.
    emit("turn.started", { engine, ...(i === 2 ? {} : { model: i === 1 ? "gpt-6.1-luna" : "claude-opus-5-5" }) }, { turn_id });
    if (delivery === "streamed") emit("message.delta", { text: `reply ${i}` }, { turn_id, item_id: `a${i}` });
    emit("message.done", { role: "assistant", text: `reply ${i}` }, { turn_id, item_id: `a${i}` });
    emit("turn.done", { status: "completed" }, { turn_id });
  }
  const live = new SessionModel();
  const replay = new SessionModel();
  // Backlog mode guarding must not suppress the authoritative engine on turn.started.
  replay.setMode("default", events.length);
  for (const event of events) {
    live.apply(event);
    replay.apply(event);
    if (event.type === "turn.done") {
      const completed = live.snapshot().items.filter((i) => i.kind === "turn_end").length;
      expect(speakerLabels(render(live.snapshot().items))).toEqual(expected.slice(0, completed));
    }
  }
  for (const model of [live, replay]) {
    for (const engine of ["claude-agent", "codex"]) {
      expect(speakerLabels(render(model.snapshot().items, { engine, engineLabel: engine === "codex" ? "Codex" : "Claude Agent" }))).toEqual(expected);
    }
  }
});

test.each(["claude-agent", "codex", "caveman"])("turn harness attribution: running activity and questions use %s, not the selected harness", (engine) => {
  // With its steps shown (live-steps.ts): the running step names its file.
  setLiveSteps(true);
  const { events, emit } = harnessLog();
  emit("message.done", { role: "user", text: "check this" }, { item_id: "u1" });
  emit("turn.started", { engine });
  emit("reasoning.delta", { text: "Checking." }, { item_id: "r1" });
  emit("tool.started", { name: "Read", title: "Read src/main.ts", kind: "read", input: {} }, { item_id: "tool1" });
  emit("subagent.started", { title: "Explore" }, { item_id: "sub1" });
  emit("ask.user", { kind: "question", questions: [{ id: "q1", prompt: "Ship it?", options: [], multi_select: false, allow_text: true }] }, { item_id: "ask1", parent_item_id: "sub1" });
  const model = new SessionModel();
  for (const event of events) model.apply(event);
  const selected = engine === "claude-agent" ? "Codex" : "Claude Agent";
  const html = render(model.snapshot().items, { running: model.snapshot().running, engine: selected === "Codex" ? "codex" : "claude-agent", engineLabel: selected });
  const label = engine === "claude-agent" ? "Claude Agent" : engine === "codex" ? "Codex" : "Caveman";
  expect(html).toContain(`>${label}</span> asks`);
  expect(html).not.toContain(`>${selected}</span>`);
  expect(html).toContain("Working");
  expect(html).toContain("src/main.ts");
});

test("turn harness attribution: catalog labels survive replay and legacy items still use the caller's identity", () => {
  const { events, emit } = harnessLog();
  emit("turn.started", { engine: "acp:muse" });
  // Activity can carry the speaker mark before the answer does.
  emit("model.routed", { model: "muse-model" }, { item_id: "route1" });
  emit("message.done", { role: "assistant", text: "Done." }, { item_id: "a1" });
  emit("turn.done", { status: "completed" });
  const model = new SessionModel();
  for (const event of events) model.apply(event);
  expect(speakerLabels(render(model.snapshot().items, {}, [{ id: "acp:muse", label: "Muse" }]))).toEqual(["Muse"]);

  const legacy = new SessionModel();
  legacy.apply({ session_id: "s1", cursor: 1, at: events[0]!.at, type: "message.done", item_id: "old", payload: { role: "assistant", text: "Old reply." } });
  expect(legacy.snapshot().items[0]).not.toHaveProperty("engine");
  expect(speakerLabels(render(legacy.snapshot().items))).toEqual(["Claude Agent"]);
  expect(speakerLabels(render(legacy.snapshot().items, { engine: "codex", engineLabel: "Codex" }))).toEqual(["Codex"]);
});

test("a long transcript's first paint is its last 20 rows, older rows out of view skip layout", () => {
  const html = render(turns(100));
  expect(html).not.toContain("turn-79-marker");
  expect(html).toContain("turn-80-marker");
  expect(html).toContain("turn-99-marker");
  expect(html.match(/content-visibility:auto/g)).toHaveLength(14);
});

test("long completed replies keep the full answer without a Caveman version button, even with a rewriter available", () => {
  const rewrite = vi.fn(async () => "Short rewrite");
  const text = "The original answer stays visible. ".repeat(40);
  const html = render([{ kind: "assistant", id: "answer", text, at: "2026-10-16T00:00:00.000Z", streaming: false }], { cavemanVersion: rewrite });
  expect(html).toContain(text.trim());
  expect(html).not.toContain("Caveman version");
  expect(html).not.toContain("Full version");
  expect(rewrite).not.toHaveBeenCalled();
});

test("a short transcript renders whole", () => {
  const html = render(turns(20));
  expect(html).toContain("turn-0-marker");
  expect(html).toContain("turn-19-marker");
});

test("a rail jump far above the tail mounts its target's chunk on its own; the gap fills from the reader's side and closes", () => {
  // 4000 rows, the tail is the last 60 (from 3940).
  expect(jumpWindow(0, 3940, 4000)).toEqual({ head: { a: 0, b: 60 }, shown: 60 });
  // Within a chunk of the tail: the tail grows down to it instead.
  expect(jumpWindow(3900, 3940, 4000)).toEqual({ head: null, shown: 100 });
  // Scrolling down, the head grows; scrolling up, the tail does.
  expect(fillGap({ a: 0, b: 60 }, 3940, 4000, false)).toEqual({ head: { a: 0, b: 120 }, shown: 60 });
  expect(fillGap({ a: 0, b: 60 }, 3940, 4000, true)).toEqual({ head: { a: 0, b: 60 }, shown: 120 });
  // The last chunk joins them: the tail starts at the head's first row.
  expect(fillGap({ a: 0, b: 3880 }, 3940, 4000, false)).toEqual({ head: null, shown: 4000 });
  expect(fillGap({ a: 100, b: 3900 }, 3940, 4000, true)).toEqual({ head: null, shown: 3900 });
});

test("a chat opens on its last screen, or with the row its reader left it at mounted too", () => {
  // No place, or one already on the last screen: the last 20 rows.
  expect(openingWindow(-1, 4000)).toEqual({ head: null, shown: 20 });
  expect(openingWindow(3990, 4000)).toEqual({ head: null, shown: 20 });
  // A place a little above it: the tail down to that row.
  expect(openingWindow(3950, 4000)).toEqual({ head: null, shown: 50 });
  // Far above: that row's own chunk, the gap between filling as the reader scrolls.
  expect(openingWindow(100, 4000)).toEqual({ head: { a: 100, b: 160 }, shown: 20 });
  // A short chat shows whole.
  expect(openingWindow(-1, 5)).toEqual({ head: null, shown: 20 });
});

test("an ask card's keycaps answer: a digit picks its option, arrows move focus and wrap", () => {
  expect(askKey("1", -1, 2)).toEqual({ index: 0, pick: true });
  expect(askKey("2", 0, 2)).toEqual({ index: 1, pick: true });
  expect(askKey("3", 0, 2)).toBeNull();
  expect(askKey("ArrowDown", -1, 2)).toEqual({ index: 0, pick: false });
  expect(askKey("ArrowDown", 1, 2)).toEqual({ index: 0, pick: false });
  expect(askKey("ArrowUp", 0, 2)).toEqual({ index: 1, pick: false });
  expect(askKey("Enter", 0, 2)).toBeNull();
  expect(askKey("1", -1, 0)).toBeNull();
});

test("an ask ignores the click that lands as it shows or as the window comes forward, and a second answer while one is out", () => {
  const shown = 1_000;
  const armedAt = shown + ASK_ARM_MS;
  // The second click of a double-click lands on the ask that took the answered one's place.
  expect(askTakes(shown + 120, armedAt, false)).toBe(false);
  expect(askTakes(armedAt, armedAt, false)).toBe(true);
  expect(askTakes(shown + 2_000, armedAt, false)).toBe(true);
  // Answered and waiting for the runtime: another pick on the same card does nothing.
  expect(askTakes(shown + 2_000, armedAt, true)).toBe(false);
  expect(ASK_ARM_MS).toBeGreaterThanOrEqual(300);
});

test("an ask that starts waiting is read out once: who asks, what for, and the keys that answer it", () => {
  const ask = { askKind: "approval" as const, prompt: "Run the webhook tests\ngo test ./webhook/...", options: [{ id: "a", label: "Allow", description: null }, { id: "d", label: "Deny", description: null }] };
  expect(askAnnouncement(ask, "Claude Agent")).toBe("Claude Agent wants approval: Run the webhook tests. Press 1 to 2 in the card to answer.");
  expect(askAnnouncement({ ...ask, askKind: "question", options: [] }, "Codex")).toBe("Codex asks: Run the webhook tests.");
  expect(askAnnouncement({ askKind: "secret", prompt: "to deploy", options: [], secret: { name: "FLY_TOKEN", repo: { path: "/r" } } }, "Caveman")).toBe("Caveman needs a secret: FLY_TOKEN.");
});

test("each finished turn's checkpoint copies that turn's last answer", () => {
  const at = "2026-10-17T10:00:00.000Z";
  const items: TranscriptItem[] = [
    { kind: "user", id: "u1", text: "fix it", at, delivery: "message" },
    { kind: "assistant", id: "a1", text: "Looking.", streaming: false, at },
    { kind: "user", id: "s1", text: "and the docs", at, delivery: "steer" },
    { kind: "assistant", id: "a2", text: "Fixed, docs too.", streaming: false, at },
    { kind: "turn_end", id: "e1", outcome: "completed", at, cursor: 5 },
    { kind: "user", id: "u2", text: "ship", at, delivery: "message" },
    { kind: "turn_end", id: "e2", outcome: "interrupted", at, cursor: 7 },
  ];
  expect([...turnAnswers(items)]).toEqual([["e1", "Fixed, docs too."]]);
});

test("the latest settled turn that changed files ends with its Changes card; any other opens its changes from the footer", () => {
  const at = "2026-10-17T10:00:00.000Z";
  const files = [
    { path: "pilot.md", additions: 45, deletions: 0 },
    { path: "questions.md", additions: 42, deletions: 0 },
  ];
  const turn = (n: number, cursor: number, checkpoint?: string, extra: Partial<Extract<TranscriptItem, { kind: "turn_end" }>> = { files }): TranscriptItem[] => [
    { kind: "user", id: `u${n}`, text: `turn ${n}`, at, delivery: "message" },
    { kind: "turn_end", id: `e${n}`, outcome: "completed", at, cursor, ...(checkpoint ? { checkpoint, ...extra } : {}) },
  ];
  const items = [...turn(1, 4, "checkpoint:a"), ...turn(2, 9, "checkpoint:b")];
  expect(turnCheckpoints(items, 0)).toEqual([
    { id: "checkpoint:a", own: true },
    { id: "checkpoint:b", own: true },
  ]);
  const html = (list: ReadonlyArray<TranscriptItem>, o: { restoreAfter?: number; session?: boolean; running?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          RuntimeContext.Provider,
          { value: { client: o.session ? {} : null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue },
          createElement(TooltipProvider, null, createElement(Transcript, { items: list, engineLabel: "Claude Agent", engineIsCaveman: false, running: o.running ?? false, onAnswer: () => undefined, cavemanVersion: null, workspaceId: "w1", restoreAfter: o.restoreAfter ?? 0, ...(o.session ? { sessionId: "s1" } : {}) })),
        ),
      ),
    );
  const buttons = (markup: string) => markup.match(/aria-label="This turn(?:&#x27;|')s changes"/g)?.length ?? 0;
  const cards = (markup: string) => markup.match(/data-turn-changes/g)?.length ?? 0;
 // A session to ask: the latest turn's card (compact), the earlier turn a button away.
  const live = html(items, { session: true });
  expect(cards(live)).toBe(1);
  expect(live).toContain("Changed 2 files");
  expect(live).toMatch(/>Undo<.*>Keep<.*>Review</s);
  expect(live).toContain("questions.md");
  expect(buttons(live)).toBe(1);
  // No session to ask Keep or Undo of: no card; both turns open their changes.
  expect(cards(html(items))).toBe(0);
  expect(buttons(html(items))).toBe(2);
  // While the next turn runs, the card waits for it to settle.
  expect(cards(html(items, { session: true, running: true }))).toBe(0);
  // A fork from turn 1: its copied turn and its first own turn (which started from the source's checkpoint) offer none.
  expect(buttons(html([...items, ...turn(3, 14, "checkpoint:c")], { restoreAfter: 4 }))).toBe(1);
  // Kept: the card closes, the changes stay a click away. Undone: one quiet line says so, and nothing to open.
  const kept = html([...turn(1, 4, "checkpoint:a", { files, resolved: "kept" })], { session: true });
  expect([cards(kept), buttons(kept)]).toEqual([0, 1]);
  const undone = html([...turn(1, 4, "checkpoint:a", { files, resolved: "undone" })], { session: true });
  expect([cards(undone), buttons(undone)]).toEqual([0, 0]);
  expect(undone).toContain("Undid the changes to 2 files");
  // Nothing changed, or no checkpoint reported (an older runtime): no card and nothing to open.
  expect(cards(html(turn(1, 4, "checkpoint:a", { files: [] }), { session: true }))).toBe(0);
  expect(buttons(html(turn(1, 4)))).toBe(0);
});

test("a long message the person sent folds to a few lines until they open it", () => {
  const at = "2026-10-17T10:00:00.000Z";
  const log = Array.from({ length: 40 }, (_, i) => `ERROR line ${i}`).join("\n");
  expect(foldsUserMessage(log)).toBe(true);
  expect(foldsUserMessage("x".repeat(601))).toBe(true);
  expect(foldsUserMessage("fix the retry bug\nand the docs")).toBe(false);
  const html = render([
    { kind: "user", id: "u1", text: log, at, delivery: "message" },
    { kind: "user", id: "u2", text: "short one", at, delivery: "steer" },
  ]);
  expect(html.match(/data-folded/g)?.length).toBe(1);
  expect(html).toContain("Show full message");
  expect(html).toContain('aria-expanded="false"');
  // Steering stays attributed to this turn above the short message.
  expect(html).toContain("You added · this turn");
});

test("a turn that ends is read out: finished, stopped, or failed with the first line of why", () => {
  expect(turnAnnouncement("completed", "Claude Agent", null)).toBe("Claude Agent finished.");
  expect(turnAnnouncement("interrupted", "Codex", null)).toBe("Codex stopped.");
  expect(turnAnnouncement("failed", "Codex", "usage limit reached\nresets at 07:00")).toBe("The turn failed: usage limit reached");
  expect(turnAnnouncement("failed", "Codex", null)).toBe("The turn failed.");
});

test("an approval card shows the command Allow lets run, unless the engine's words already say it", () => {
  const ask = (prompt: string) =>
    ({ kind: "ask", id: "k1", askKind: "approval", prompt, options: [{ id: "a", label: "Allow", description: null }], resolution: null, questions: [], round: null, answers: null, waitsOn: { icon: "run", subject: "git push origin main" } }) as TranscriptItem;
  expect(render([ask("Push the branch")])).toContain("git push origin main");
  expect(render([ask("Push the branch\ngit push origin main")]).match(/git push origin main/g)?.length).toBe(1);
});

test("Edit takes a message back to the finished turn before it; never the first, a steer, a fork's copied turns or another agent's", () => {
  const at = "2026-10-17T10:00:00.000Z";
  const user = (id: string, delivery: "message" | "steer" | "queue" = "message", from?: { title: string }) => ({ kind: "user", id, text: id, at, delivery, ...(from ? { from } : {}) }) as TranscriptItem;
  const end = (cursor: number, outcome: "completed" | "interrupted" = "completed") => ({ kind: "turn_end", id: `e${cursor}`, outcome, at, cursor }) as TranscriptItem;
  const items = [user("u1"), end(4), user("u2"), user("s2", "steer"), end(9), user("q3", "queue"), end(12, "interrupted"), user("u4"), end(15), user("a5", "message", { title: "Lead" })];
  expect([...editPoints(items, 0)]).toEqual([
    ["u2", 4],
    ["q3", 9],
  ]);
  // A fork from turn 2: only what came after its copied turns.
  expect([...editPoints([...items, end(20), user("u6")], 9)]).toEqual([["u6", 20]]);
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(Transcript, { items: [user("u1"), end(4), user("u2")], engineLabel: "Claude Agent", engineIsCaveman: false, running: false, onAnswer: () => undefined, cavemanVersion: null, onEditFrom: () => undefined }),
      ),
    ),
  );
  expect(html.match(/>Edit</g)?.length).toBe(1);
});

test("a markdown file a turn writes gets no card of its own, finished or still running: the Changes card lists it", () => {
  const at = "2026-10-16T00:00:00.000Z";
  const user = { kind: "user", id: "u1", text: "write the spec", at, delivery: "message" } as TranscriptItem;
  const write = { kind: "tool", id: "t1", verb: "Created", subject: "docs/spec.md", parts: [], command: null, status: "done", startedAt: at, finishedAt: at, added: 3, removed: null, output: "", name: "Write", input: {}, result: null, icon: "create" } as TranscriptItem;
  const answer = { kind: "assistant", id: "a1", text: "Done.", streaming: false, at } as TranscriptItem;
  const end = { kind: "turn_end", id: "e1", outcome: "completed", at, cursor: 4 } as TranscriptItem;
  for (const html of [render([user, write, answer, end]), render([user, write], { running: true })]) {
    expect(html).not.toMatch(/aria-label="Read spec\.md/);
  }
});

test("a message's hover says the time it was sent, with the day once it is not today", () => {
  const now = new Date(2026, 9, 18, 15, 0); // Sunday
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m);
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  expect(sentAt(at(18, 14, 2).toISOString(), now)).toBe(time(at(18, 14, 2)));
  expect(sentAt(at(17, 9, 30).toISOString(), now)).toBe(`Yesterday ${time(at(17, 9, 30))}`);
  expect(sentAt(at(13, 9, 30).toISOString(), now)).toBe(`${at(13, 9, 30).toLocaleDateString(undefined, { weekday: "short" })} ${time(at(13, 9, 30))}`);
  expect(sentAt(at(1, 9, 30).toISOString(), now)).toBe(`${at(1, 9, 30).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(at(1, 9, 30))}`);
  const lastYear = new Date(2025, 11, 31, 23, 5);
  expect(sentAt(lastYear.toISOString(), now)).toBe(`${lastYear.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}, ${time(lastYear)}`);
  expect(sentAt("", now)).toBe("");
});

test("a send still queued in Cloud makes no mark on the message rail, so one message and a queued one show no rail", () => {
  const sent = { kind: "user", id: "u1", text: "The inbox filter e2e fails about one run in five.", at: "2026-10-21T12:00:00.000Z", delivery: "message" } as TranscriptItem;
  const queued = { kind: "user", id: "u2", text: "Also run it against Safari.", at: "2026-10-21T12:01:00.000Z", delivery: "message", pending: true, queued: "Queued · waking web-box" } as TranscriptItem;
  expect(railMessages([sent, queued]).map((m) => m.id)).toEqual(["u1"]);
  // Delivered: it is the chat's message now.
  const { queued: _status, ...delivered } = queued as TranscriptItem & { queued?: string };
  expect(railMessages([sent, delivered as TranscriptItem]).map((m) => m.id)).toEqual(["u1", "u2"]);
});

test("history arriving after an empty transcript opens only the first screen", () => {
  // A slow attach can expose an empty snapshot before the backlog arrives.
  // There is no mounted first row to preserve yet, even after a restore to empty.
  expect(holdTop(20, 0, 9000)).toBe(20);
  expect(holdTop(0, 0, 9000)).toBe(20);
  expect(holdTop(20, 0, 3)).toBe(3);
  expect(holdTop(20, 0, 0)).toBe(0);
  const empty = holdTop(80, 100, 0);
  expect(holdTop(empty, 0, 300)).toBe(20);
  // The first live message still grows with its reply, keeping the message mounted.
  const first = holdTop(20, 0, 1);
  expect(holdTop(first, 1, 2)).toBe(2);
});

test("rows arriving at the end, or folding together there, never move the window's first row", () => {
  // 30 rows, the last 20 mounted (from 10). A live turn adds rows: the window grows with them, from stays 10.
  expect(holdTop(20, 30, 31)).toBe(21);
  expect(30 + 1 - holdTop(20, 30, 31)).toBe(10);
  // A turn ends and its rows fold into one: the window shrinks with them, from still 10.
  expect(28 - holdTop(21, 31, 28)).toBe(10);
  // A restore that dropped every row the window held shows a first screen.
  expect(holdTop(20, 100, 50)).toBe(20);
  expect(holdTop(20, 30, 5)).toBe(5);
});

test("a restore that drops every row the tail held joins a head the tail now reaches, so no row mounts twice", () => {
  // 120 rows: a jump mounted rows 30 to 90 on their own; the tail is the last 20 (from 100).
  const head = { a: 30, b: 90 };
  // Rows arriving at the end leave the head alone.
  expect(holdWindow(head, 20, 120, 121)).toEqual({ head, shown: 21 });
  // Restored to row 30 (31 rows left): the tail's first screen starts at row 11, above the head's start.
  expect(holdWindow(head, 20, 120, 31)).toEqual({ head: null, shown: 20 });
  // Restored into the head's middle: one window from the head's first row.
  expect(holdWindow(head, 20, 120, 70)).toEqual({ head: null, shown: 40 });
  // Restored above the head: the first screen is all that is left.
  expect(holdWindow(head, 20, 120, 25)).toEqual({ head: null, shown: 20 });
});

test("the live end keeps one footer-sized line while the turn runs, empty while a reply streams", () => {
  setLiveSteps(true);
  const { events, emit } = harnessLog();
  emit("message.done", { role: "user", text: "draft it" }, { item_id: "u1" });
  emit("turn.started", { engine: "caveman" });
  emit("tool.started", { name: "read", title: "deck.md", kind: "read", input: {} }, { item_id: "t1" });
  const model = new SessionModel();
  for (const event of events) model.apply(event);
  // The line's class, and the words it says in place (ai/rolling.tsx): "" while it says nothing. It is the turn's last
  // row, so the first words after it are its own.
  const end = (html: string) => {
    const at = html.indexOf("<div data-live-end");
    if (at < 0) return null;
    const line = html.slice(at);
    return [line.match(/class="([^"]*)"/)?.[1] ?? "", line.match(/<span class="lucy-shimmer[^"]*">(.*?)<\/span>/)?.[1] ?? ""];
  };
  // A step runs: the line says so.
  const stepping = end(render(model.snapshot().items, { running: true }));
  expect(stepping?.[1]).toContain("Working");
  // A reply streams: the line stays, empty, so the reply starting and ending shrinks nothing.
  emit("tool.done", { status: "completed" }, { item_id: "t1" });
  emit("message.delta", { text: "Here it is" }, { item_id: "a1" });
  for (const event of events.slice(3)) model.apply(event);
  const streaming = end(render(model.snapshot().items, { running: true }));
  expect(streaming).not.toBeNull();
  expect(streaming?.[1]).toBe("");
  // The turn's footer takes the same line (mt-1 h-7), so the turn ending swaps one for the other at no height.
  expect(stepping?.[0]).toMatch(/(^| )mt-1( |$)/);
  expect(stepping?.[0]).toMatch(/(^| )h-7( |$)/);
  emit("message.done", { role: "assistant", text: "Here it is" }, { item_id: "a1" });
  emit("turn.done", { status: "completed" });
  for (const event of events.slice(5)) model.apply(event);
  const done = render(model.snapshot().items, { running: false });
  expect(done).not.toContain("data-live-end");
  const footer = done.match(/<div data-turn-actions="[^"]*" class="([^"]*)"/)?.[1] ?? "";
  expect(footer).toMatch(/(^| )mt-1( |$)/);
  expect(footer).toMatch(/(^| )h-7( |$)/);
});

test("a Changes card taken away by a new turn folds shut, and folded it takes no height", () => {
  const files = [{ path: "pilot.md", additions: 45, deletions: 0 }];
  const card = (props: { enter?: boolean; leaving?: boolean }) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TurnChanges, { files, onKeep: async () => undefined, onUndo: async () => undefined, onReview: null, ...props })));
  const outer = (html: string) => html.match(/^<div([^>]*)>/)?.[1] ?? "";
  expect(outer(card({ enter: true }))).toContain("turn-changes-open");
  // Leaving: it folds out (no longer clickable or read out) instead of vanishing in one frame.
  const leaving = outer(card({ enter: true, leaving: true }));
  expect(leaving).toContain("turn-changes-close");
  expect(leaving).not.toContain("turn-changes-open");
  expect(leaving).toContain("inert");
  // The gap above the card is inside the clipped row: a padding on the row itself stayed 8px tall when folded.
  expect(card({})).toMatch(/^<div[^>]*><div class="min-h-0 overflow-hidden"><div class="pt-2"><div data-turn-changes/);
});

test("a model switch between turns reads as a divider: the model's label and effort on each side", () => {
  const engines = [{ id: "claude-agent", label: "Claude Agent", models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }] }];
  const html = render(
    [{ kind: "switch", id: "switch:1", from: { engine: "claude-agent", model: "claude-opus-5-5", effort: "xhigh" }, to: { engine: "claude-agent", model: "claude-sonnet-5-5", effort: "medium" } }],
    {},
    engines,
  );
  expect(html).toContain("Opus 5.5 Extra high → Sonnet 5.5 Medium");
});
