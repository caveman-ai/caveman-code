import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("../routes/inbox-vitals.tsx", () => ({ ContextMeter: () => null, Peek: () => null }));
vi.mock("../panes/store.ts", () => ({ panes: {}, pins: {}, usePins: () => [] }));
vi.mock("../panes/drag.ts", () => ({}));
import { StatusMark } from "./StatusMark.tsx";
import { RowGlyph } from "../routes/inbox-parts.tsx";
import type { ChatStatus, ChatStatusId, WorkspaceView } from "../state/model.ts";

const status = (id: ChatStatusId = "working"): ChatStatus => ({ id, label: id, detail: null, action: false, since: null, progress: null, agents: 0 });
const render = (props: Parameters<typeof StatusMark>[0]) => renderToStaticMarkup(createElement(StatusMark, props));

test("working marks loop by default, including compact folder rollups", () => {
  for (const id of ["working", "agents"] as const) {
    for (const compact of [false, true]) {
      expect(render({ status: status(id), compact })).toContain('data-play="loop"');
    }
  }
  expect(render({ status: status(), animate: false })).not.toContain("px-strip-track");
});

test("the inbox/queue row uses the same looping wheel as the sidebar", () => {
  const workspace = { state: "working" } as WorkspaceView;
  const html = renderToStaticMarkup(createElement(RowGlyph, { workspace, status: status(), context: null }));
  expect(html).toContain('data-play="loop"');
  expect(html).toContain("px-strip-track");
});

test("whatever a chat waits on you for, its mark is one amber dot with no word, the ask in its name", () => {
  for (const id of ["approve", "secret", "answer", "ready"] as const) {
    for (const compact of [false, true]) {
      const html = render({ status: { ...status(id), action: true, label: "Approve", detail: "Run rm -rf build?" }, compact });
      expect(html.replace(/<[^>]*>/g, ""), id).toBe("");
      expect(html, id).toContain('aria-label="Approve: Run rm -rf build?"');
      expect(html, id).toContain("text-warning");
    }
  }
});

test("idle, queued and attention states do not become loading animations", () => {
  for (const id of ["approve", "secret", "answer", "ready", "failed", "queued", "done", "stopped", "asleep"] as const) {
    expect(render({ status: status(id) })).not.toContain("px-strip-track");
  }
});

test("two or more agents at work turn a comet each on the ring, four at most, working or waiting", () => {
  // The strip alone: the label around it names the status.
  const ring = (id: "working" | "agents", agents: number) => render({ status: { ...status(id), agents }, compact: true }).replace(/^<span[^>]*>/, "");
  for (const id of ["working", "agents"] as const) {
    const [two, three, four] = [ring(id, 2), ring(id, 3), ring(id, 4)];
    expect(new Set([two, three, four]).size, id).toBe(3);
    expect(ring(id, 9), id).toBe(four);
    for (const html of [two, three, four]) expect(html).toContain('data-play="loop"');
  }
  // Two agents read the same whether the lead still works or waits on them.
  expect(ring("working", 2)).toBe(ring("agents", 2));
  // One agent keeps the lead's own ring.
  expect(ring("working", 1)).toBe(ring("working", 0));
});
