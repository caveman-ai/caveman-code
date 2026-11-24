// A native subagent's row (Claude's Agent tool): while it runs, its line says Working once; it starts
// folded, so its steps stay behind the line until opened, never an empty list that says Working a
// second time.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

vi.mock("../../panes/drag.ts", () => ({}));
vi.mock("../../panes/store.ts", () => ({ panes: {} }));
vi.mock("../../panels/store.ts", async (real) => ({ ...(await real<object>()), usePanel: () => ({ open: false, tabs: [] }) }));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SessionModel } from "../../state/transcript.ts";
import { Transcript } from "../Transcript.tsx";
import { holdsSubagent, rowsHoldSubagent } from "./reveal-subagent.ts";
import { rows } from "./rows.ts";

let cursor = 0;
const at = "2026-10-17T08:00:00.000Z";
const ev = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({ session_id: "s1", cursor: ++cursor, at, type, payload, ...extra }) as SessionEvent;

const view = (events: ReadonlyArray<SessionEvent>) => {
  const m = new SessionModel();
  for (const e of events) m.apply(e);
  return m.snapshot();
};

const render = (events: ReadonlyArray<SessionEvent>) => {
  const v = view(events);
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines: [], workspaces: [], raw: new Map(), refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(Transcript, { items: v.items, engineLabel: "Claude Agent", engine: "claude-agent", engineIsCaveman: false, running: v.running, onAnswer: () => undefined, cavemanVersion: null }),
      ),
    ),
  );
};

const started = () => [
  ev("message.done", { role: "user", text: "grill me about caveman" }, { item_id: "u1" }),
  ev("turn.started", { engine: "claude-agent" }),
  ev("subagent.started", { title: "Map current onboarding state", agent: "claude-agent" }, { item_id: "sa1" }),
];
const working = (html: string) => html.match(/>Working</g)?.length ?? 0;

test("a native subagent with no step yet says Working once", () => {
  cursor = 0;
  const html = render(started());
  expect(html).toContain("Map current onboarding state");
  expect(working(html)).toBe(1);
});

test("a running native subagent starts folded: its row says what it does now, its steps wait behind it", () => {
  cursor = 0;
  const html = render([
    ...started(),
    ev("tool.started", { name: "Read", title: "docs/onboarding.md", kind: "read", input: { path: "docs/onboarding.md" } }, { item_id: "t1", parent_item_id: "sa1" }),
    ev("tool.done", { status: "completed" }, { item_id: "t1", parent_item_id: "sa1" }),
    ev("message.delta", { text: "Onboarding has three steps" }, { item_id: "m1", parent_item_id: "sa1" }),
  ]);
  expect(html).toContain("Map current onboarding state");
  expect(html).not.toContain("docs/onboarding.md");
  expect(html.match(/>Onboarding has three steps</g)?.length).toBe(1);
  expect(working(html)).toBe(0);
});

test("a subagent opened from the sidebar is found in its group and the subagents that hold it", () => {
  cursor = 0;
  const v = view([
    ...started(),
    ev("subagent.started", { title: "Deeper" }, { item_id: "sa2", parent_item_id: "sa1" }),
    ev("subagent.done", { status: "completed" }, { item_id: "sa2", parent_item_id: "sa1" }),
    ev("subagent.done", { status: "completed" }, { item_id: "sa1" }),
    ev("tool.started", { name: "Read", title: "a.md", kind: "read", input: {} }, { item_id: "t9" }),
    ev("tool.done", { status: "completed" }, { item_id: "t9" }),
    ev("message.done", { role: "assistant", text: "Here is what I found." }, { item_id: "a1" }),
    ev("turn.done", { status: "completed" }),
  ]);
  // The turn's subagents stay out of its fold, in their own group.
  const all = rows(v.items);
  expect(all.find((r) => r.kind === "fold")?.kind === "fold" && rowsHoldSubagent([all.find((r) => r.kind === "fold")!], "sa2")).toBe(false);
  expect(rowsHoldSubagent(all, "sa2")).toBe(true);
  expect(holdsSubagent(v.items, "sa2")).toBe(true);
  expect(holdsSubagent(v.items, "t9")).toBe(false);
});
