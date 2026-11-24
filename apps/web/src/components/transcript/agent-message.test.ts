// A message another chat's agent sent folds into one line, its first, until opened (upstream #23135); the person's
// own messages stay whole bubbles.
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
import { agentMessagePreview, Transcript } from "../Transcript.tsx";

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
        createElement(Transcript, { items: v.items, engineLabel: "Claude Agent", engine: "claude-agent", engineIsCaveman: false, running: v.running, onAnswer: () => undefined, cavemanVersion: null }),
      ),
    ),
  );
};

const MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

test("another chat's agent's message shows its first line, folded, and names who sent it", () => {
  cursor = 0;
  const html = render([ev("message.done", { role: "user", text: MESSAGE, from: { title: "Review the migration" } }, { item_id: "u1" })]);
  expect(html).toContain("Review the migration");
  expect(html).toContain("Review finished");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("drops the index");
});

test("a scheduled task's prompt folds the same way, titled by its task", () => {
  cursor = 0;
  const prompt = "Triage the inbox\n\nLabel every new issue and close duplicates.";
  const html = render([ev("message.done", { role: "user", text: prompt, scheduled_task: { task_id: "task-1", title: "Nightly triage" } }, { item_id: "u1" })]);
  expect(html).toContain("Scheduled");
  expect(html).toContain("Nightly triage");
  expect(html).toContain("Triage the inbox");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("close duplicates");
  // A task since deleted: its first line still says what it was.
  expect(render([ev("message.done", { role: "user", text: prompt, scheduled_task: { task_id: "gone" } }, { item_id: "u2" })])).toContain("Triage the inbox");
});

test("the person's own message stays a whole bubble", () => {
  cursor = 0;
  const html = render([ev("message.done", { role: "user", text: MESSAGE }, { item_id: "u1" })]);
  expect(html).toContain("drops the index");
  expect(html).not.toContain('aria-expanded="false"');
});

test("the preview is the first line with words, markdown marks dropped", () => {
  expect(agentMessagePreview("\n\n## **Review** finished\nmore")).toBe("Review finished");
  expect(agentMessagePreview("- `pnpm test` passed")).toBe("pnpm test passed");
  expect(agentMessagePreview("")).toBe("");
});
