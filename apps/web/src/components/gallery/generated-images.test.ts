import type { SessionEvent } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// Browser-only pane stores are unrelated to the production transcript/media flow under test.
vi.mock("../../panes/drag.ts", () => ({}));
vi.mock("../../panes/store.ts", () => ({ panes: {} }));
vi.mock("../../panels/store.ts", async (real) => ({ ...(await real<object>()), usePanel: () => ({ open: false, tabs: [] }) }));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SessionModel } from "../../state/transcript.ts";
import { Transcript } from "../Transcript.tsx";

function render(state: "running" | "completed" | "failed", closed = false, count = 1) {
  const model = new SessionModel();
  let cursor = 0;
  const apply = (type: SessionEvent["type"], payload: unknown, item_id = "image") => model.apply({ session_id: "images", turn_id: "turn", cursor: ++cursor, at: "2026-10-22T12:00:00Z", type, payload, item_id } as SessionEvent);
  apply("turn.started", { engine: "codex" });
  apply("message.done", { role: "user", text: "Make an image" }, "user");
  // Two work rows make a real finished-turn fold (a single settled tool intentionally stays a line).
  if (closed) apply("plan.updated", { kind: "todos", steps: [{ text: "Generate artwork", status: "completed" }] }, "plan");
  apply("tool.started", { name: "image_generation", title: "image_generation", kind: "other", input: { prompt: "A moon above a lake" } });
  if (state !== "running") apply("tool.done", { status: state, result: { content: Array.from({ length: count }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" })), revised_prompt: "A moon above a lake" }, ...(state === "failed" ? { error: "Limit reached" } : {}) });
  if (closed) {
    apply("message.done", { role: "assistant", text: "Here is your image." }, "answer");
    apply("turn.done", { status: state });
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(MemoryRouter, null,
    createElement(RuntimeContext.Provider, { value: { client: null, engines: [], workspaces: [], raw: new Map(), refresh: async () => undefined } as unknown as RuntimeContextValue },
      createElement(Transcript, { items: model.snapshot().items, engine: "codex", engineLabel: "Codex", engineIsCaveman: false, running: !closed, onAnswer: () => undefined, cavemanVersion: null })))));
}

test("the actual live transcript shows image-generation progress even while ordinary work cards wait for the fold", () => {
  const html = render("running");
  expect(html).toContain('data-image-generation="running"');
  expect(html).toContain("This may take a moment.");
  expect(html).not.toContain("No image was returned");
});

test("a completed image shows immediately, before the model's turn finishes", () => {
  const html = render("completed");
  expect(html.match(/data-image-generation="done"/g)).toHaveLength(1);
  expect(html).toContain("Save image");
  expect(html).toContain("A moon above a lake");
  expect(html).toContain("object-contain");
});

test("the actual folded turn retains exactly one generated image outside the hidden tool trace", () => {
  const html = render("completed", true);
  // The fold's line names who worked: "Codex worked for 2s".
  expect(html).toMatch(/worked for/i);
  expect(html.match(/data-image-generation="done"/g)).toHaveLength(1);
  expect(html.match(/<figure /g)).toHaveLength(1);
  expect(html).toContain('aria-label="Open image: Generated image"');
});

test("multiple returned images have distinct visible cards, each attached to the shared viewer", () => {
  const html = render("completed", true, 2);
  expect(html.match(/<figure /g)).toHaveLength(2);
  expect(html).toContain('aria-label="Open image: Generated image 1"');
  expect(html).toContain('aria-label="Open image: Generated image 2"');
});

test("completion without a usable image reports availability, not a fabricated generation failure", () => {
  const html = render("completed", true, 0);
  expect(html).toContain('data-image-generation="done"');
  expect(html).toContain("Generated image isn&#x27;t available");
  expect(html).not.toContain("Image wasn&#x27;t generated");
  expect(html).not.toContain("Save image");
  expect(html).not.toContain("<figure");
});

test("failure is visible outside the folded trace, without a misleading image or save action", () => {
  const html = render("failed", true);
  // The fold's line names who worked: "Codex worked for 2s".
  expect(html).toMatch(/worked for/i);
  expect(html).toContain('data-image-generation="failed"');
  expect(html).toContain("Image wasn&#x27;t generated");
  expect(html).toContain("Limit reached");
  expect(html).not.toContain("Save image");
  expect(html).not.toContain("<figure");
});
