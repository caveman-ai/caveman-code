// The running turn's live end: the "Working for" header is often scrolled away, and a running tool can sit
// above its output, screenshots or doc cards, so the bottom of the transcript says Working until the turn ends.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

vi.mock("../../panes/drag.ts", () => ({}));
vi.mock("../../panes/store.ts", () => ({ panes: {} }));
vi.mock("../../panels/store.ts", async (real) => ({ ...(await real<object>()), usePanel: () => ({ open: false, tabs: [] }) }));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { setLiveSteps } from "../../state/live-steps.ts";
import { SessionModel } from "../../state/transcript.ts";
import { Transcript } from "../Transcript.tsx";

let cursor = 0;
const at = "2026-10-17T08:00:00.000Z";
const ev = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({ session_id: "s1", cursor: ++cursor, at, type, payload, ...extra }) as SessionEvent;

const render = (events: ReadonlyArray<SessionEvent>) => {
  const m = new SessionModel();
  for (const e of events) m.apply(e);
  const v = m.snapshot();
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client: null, engines: [], workspaces: [], raw: new Map(), refresh: async () => undefined } as unknown as RuntimeContextValue },
        createElement(TooltipProvider, null, createElement(Transcript, { items: v.items, engineLabel: "Claude Agent", engine: "claude-agent", engineIsCaveman: false, running: v.running, onAnswer: () => undefined, cavemanVersion: null })),
      ),
    ),
  );
};

const editing = () => {
  cursor = 0;
  return [
    ev("message.done", { role: "user", text: "update the docs" }, { item_id: "u1" }),
    ev("turn.started", { engine: "claude-agent" }),
    ev("tool.started", { name: "Edit", title: "docs/webhooks.md", kind: "edit", input: {} }, { item_id: "t1" }),
  ];
};

// The text of the transcript's last shimmering line, if any.
const liveEnd = (html: string) => [...html.matchAll(/lucy-shimmer[^>]*>([^<]*)</g)].at(-1)?.[1];

test("while a tool runs, the transcript ends on a Working status line", () => {
  setLiveSteps(true);
  const html = render(editing());
  expect(liveEnd(html)).toBe("Working");
  expect(html.lastIndexOf(">Working<")).toBeGreaterThan(html.indexOf("docs/webhooks.md"));
});

test("between steps it says Thinking, and a finished turn says neither", () => {
  setLiveSteps(true);
  const between = [...editing(), ev("tool.done", { status: "completed" }, { item_id: "t1" })];
  expect(liveEnd(render(between))).toBe("Thinking");
  const done = [...between, ev("turn.done", { outcome: "completed" })];
  expect(liveEnd(render(done))).toBeUndefined();
});

test("before anything of the turn is back, the turn's own working line stands where its first row will, no mascot", () => {
  cursor = 0;
  const html = render([ev("message.done", { role: "user", text: "update the docs" }, { item_id: "u1" }), ev("turn.started", { engine: "claude-agent" })]);
  expect(html).toContain('role="status"');
  expect(html).toMatch(/Claude Agent working/);
  expect(html).not.toContain("mascot");
});

test("with its steps hidden, a running turn is its line: the steps stay behind it and the line opens them", () => {
  setLiveSteps(false);
  const html = render(editing());
  // No step row: the file is named once, by the live end, by its own name.
  expect(html).not.toContain("docs/webhooks.md");
  expect(html.match(/webhooks\.md/g)).toHaveLength(1);
  // The line says who is working and opens the steps; under it, the kind of work running now (step-line.ts), with
  // the file beside it.
  expect(html).toMatch(/Claude Agent working/);
  expect(liveEnd(html)).toBe("Editing files");
  expect(html).toMatch(/stream-detail[^>]*>webhooks\.md</);
  expect(html).toMatch(/aria-expanded="false"[^>]*title="Show the steps"/);
  // Its words stay in view while the work around them hides.
  const said = [...editing(), ev("tool.done", { status: "completed" }, { item_id: "t1" }), ev("message.done", { role: "assistant", text: "Docs updated." }, { item_id: "a1" })];
  const answered = render(said);
  expect(answered).toContain("Docs updated.");
  expect(answered).not.toContain("docs/webhooks.md");
  // Opened once, every turn after shows its steps.
  setLiveSteps(true);
  expect(render(editing())).toContain("docs/webhooks.md");
});

test("sent and nothing back yet: the turn's line at once, never the caveman", () => {
  setLiveSteps(false);
  cursor = 0;
  const html = render([ev("message.done", { role: "user", text: "update the docs" }, { item_id: "u1" }), ev("turn.started", { engine: "claude-agent" })]);
  expect(liveEnd(html)).toMatch(/^Claude Agent working/);
  expect(html).not.toContain("px-strip");
  expect(html).not.toMatch(/>Working</);
});
