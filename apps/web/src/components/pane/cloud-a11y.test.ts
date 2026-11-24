// The Cloud computer states a chat shows (moved to Cloud, coming back, asleep, waking) reach a screen reader as they
// change: their lines sit in live regions that are mounted before the words change.
import type { Workspace } from "@caveman-app/session-protocol";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { MovedCard } from "./Moves.tsx";
import { SyncLine } from "./SyncLine.tsx";

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: { client: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, element)),
  );
const parked = { id: "w", session_id: "s", engine: "caveman", status: "parked", title: "Chat", computer: { id: "cc-1", kind: "caveman_cloud", label: "Fix login", status: "online" } } as Workspace;

test("the moved card's line is a polite live region, and Bring it back is focusable while it works", () => {
  const html = render(createElement(MovedCard, { client: { call: async () => ({}) } as never, workspace: parked, to: "cloud" }));
  expect(html).toMatch(/<div role="status" aria-live="polite"[^>]*>It keeps going on a Cloud computer/);
  // Never `disabled` (that drops keyboard focus to the page mid-move): aria-disabled while it moves.
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Bring it back/);
  expect(html).toContain("aria-disabled:opacity-50");
});

test("the chat's source line keeps its live region mounted while it has nothing to say", () => {
  const html = render(createElement(SyncLine, { workspaceId: "w", sessionId: "s", feed: null }));
  // Mounted and empty: "Asleep. Sending wakes it." and then "Waking Fix login" are read when they arrive.
  expect(html).toBe('<div class="sr-only" role="status" aria-live="polite"></div>');
});
