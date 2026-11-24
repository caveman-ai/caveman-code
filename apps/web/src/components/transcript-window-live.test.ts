// The transcript's window mounted with React DOM, so its effects and observers run: the rows a jump mounts above the
// tail (the head) hold while the chat changes under them.
import { document } from "../testing/dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import type { SessionEvent } from "@caveman-app/session-protocol";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import { SessionModel } from "../state/transcript.ts";
import type { TranscriptItem } from "../state/transcript-model.ts";
import { jumpTo } from "./find/jump.ts";
import { Transcript, type TranscriptProps } from "./Transcript.tsx";

// IntersectionObserver as a browser runs it: each observe() reports its target's state once, the target named in the
// entry (one observer may watch many: the transcript's rows). `inView` says which sentinels are within reach.
type Entry = { isIntersecting: boolean; target: Element };
const observed: Array<{
  report: (entries: Array<Entry>) => void;
  target: Element;
  off: () => boolean;
}> = [];
class Observer {
  private off = false;
  private readonly report: (entries: Array<Entry>) => void;
  constructor(report: (entries: Array<Entry>) => void) {
    this.report = report;
  }
  observe(target: Element) {
    observed.push({ report: this.report, target, off: () => this.off });
  }
  unobserve() {}
  disconnect() {
    this.off = true;
  }
  takeRecords() {
    return [];
  }
}
Object.assign(globalThis, { IntersectionObserver: Observer });

const runtime = {
  client: null,
  engines: [],
  workspaces: [],
  raw: new Map(),
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;

function mountTranscript(sessionId: string, props: Partial<TranscriptProps>) {
  document.body.innerHTML = "";
  const viewport = document.createElement("div");
  viewport.setAttribute("data-slot", "conversation-viewport");
  document.body.appendChild(viewport);
  const root = createRoot(viewport);
  const show = (items: ReadonlyArray<TranscriptItem>) =>
    act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(
              RuntimeContext.Provider,
              { value: runtime },
              createElement(Transcript, {
                items,
                sessionId,
                engineLabel: "Claude Agent",
                engineIsCaveman: false,
                running: false,
                onAnswer: () => undefined,
                cavemanVersion: null,
                ...props,
              }),
            ),
          ),
        ),
      ),
    );
  // Each sentinel observed since the last frame gets its first report.
  let reported = observed.length;
  const frame = (inView: (sentinel: Element) => boolean) =>
    act(async () => {
      for (; reported < observed.length; reported++) {
        const o = observed[reported]!;
        if (!o.off()) o.report([{ isIntersecting: inView(o.target), target: o.target }]);
      }
      await new Promise((r) => setTimeout(r, 5));
    });
  const rows = () =>
    [...viewport.querySelector("[data-transcript-rows]")!.children].flatMap(
      (c) => c.getAttribute("data-row") ?? [],
    );
  const mounted = (id: string) => viewport.querySelector(`[data-find-id="${id}"]`) !== null;
  return { show, frame, rows, mounted, unmount: () => act(() => root.unmount()) };
}

test("a streamed token, with find open on an old match, keeps the rows mounted above that match", async () => {
  const at = "2026-11-06T10:00:00.000Z";
  // 150 messages of history; the match is message 60, more than a chunk above the last rows the chat mounts first.
  const history = Array.from(
    { length: 150 },
    (_, i) =>
      ({
        kind: "user",
        id: `u${i}`,
        text: i === 60 ? "where is the needle" : `turn ${i}`,
        at,
        delivery: "message",
      }) as TranscriptItem,
  );
  const answer = (text: string) =>
    ({ kind: "assistant", id: "live", text, streaming: true, at }) as TranscriptItem;
  const t = mountTranscript("find", { running: true });
  // The top sentinel is in reach only while it sits right above the match find centred.
  const aboveMatch = (sentinel: Element) =>
    sentinel.getAttribute("aria-hidden") === "true" &&
    sentinel.nextElementSibling?.querySelector('[data-find-id="u60"]') != null;
  try {
    // ⌘K opened this chat on "needle" in message 60: find opens there and the window mounts its rows on their own.
    jumpTo("find", { item: "u60", query: "needle" });
    let text = "Working";
    await t.show([...history, answer(text)]);
    await t.frame(aboveMatch);
    expect(t.mounted("u60")).toBe(true);
    // The sentinel above the match mounted the chunk above it.
    expect(t.mounted("u20")).toBe(true);

    // The agent streams on; the reader has not moved and find stands on the same match.
    const lost: number[] = [];
    for (let token = 1; token <= 3; token++) {
      text += ` word${token}`;
      await t.show([...history, answer(text)]);
      if (!t.mounted("u20")) lost.push(token);
      await t.frame(aboveMatch);
    }
    expect(lost, "tokens after which rows u0..u59 had unmounted").toEqual([]);
  } finally {
    await t.unmount();
  }
});

test("an Edit reached through a jump far above the tail shows each row once, in order", async () => {
  // 40 finished turns: each a message, an answer and its turn end (120 rows).
  const events: SessionEvent[] = [];
  const emit = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}) =>
    events.push({
      session_id: "edit",
      cursor: events.length + 1,
      at: "2026-11-06T10:00:00.000Z",
      type,
      payload,
      ...extra,
    } as SessionEvent);
  const ends: number[] = [];
  for (let i = 0; i < 40; i++) {
    emit(
      "message.done",
      { role: "user", text: `message ${i}` },
      { turn_id: `t${i}`, item_id: `u${i}` },
    );
    emit(
      "turn.started",
      { engine: "claude-agent", model: "claude-opus-5-5" },
      { turn_id: `t${i}` },
    );
    emit(
      "message.done",
      { role: "assistant", text: `answer ${i}` },
      { turn_id: `t${i}`, item_id: `a${i}` },
    );
    emit("turn.done", { status: "completed" }, { turn_id: `t${i}` });
    ends.push(events.length);
  }
  const model = new SessionModel();
  for (const e of events) model.apply(e);
  const t = mountTranscript("edit", { onEditFrom: () => undefined });
  const keys: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) =>
    void (/same key/.test(args.map(String).join(" "))
      ? keys.push(String(args[0]))
      : error(...args));
  try {
    await t.show(model.snapshot().items);
    expect(t.rows()[0]).toBe("a33");
    // ⌘K lands on message 10, more than a chunk above the tail: its rows mount on their own, the tail stays.
    await act(async () => jumpTo("edit", { item: "u10", query: "" }));
    expect(t.rows()).toContain("u10");
    expect(t.rows()).toContain("u39");

    // Edit on message 10, confirmed: the runtime restores to the turn before it (turn 9's turn.done).
    model.apply({
      session_id: "edit",
      cursor: events.length + 1,
      at: "2026-11-06T10:05:00.000Z",
      type: "session.restored",
      payload: { at: ends[9]! },
    } as SessionEvent);
    await t.show(model.snapshot().items);
    const rows = t.rows();
    expect(
      new Set(rows).size,
      `rows mounted twice: ${rows.filter((r, i) => rows.indexOf(r) !== i).join(", ")}`,
    ).toBe(rows.length);
    expect(rows.at(-1)).toBe(`session.restored:${events.length + 1}`);
    expect(rows.slice(-2, -1)).toEqual(["turn_end:" + ends[9]]);
    expect(keys).toEqual([]);
  } finally {
    console.error = error;
    await t.unmount();
  }
});
