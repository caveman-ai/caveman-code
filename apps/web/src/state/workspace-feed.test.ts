import type { Workspace } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { applyWorkspaceChange, catchUpMs, withPushes } from "./workspace-feed.ts";

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, title: id, status: "idle", updated_at: "2026-10-17T10:00:00Z", ...over }) as unknown as Workspace;
const list = (...all: Workspace[]) => new Map(all.map((w) => [w.id, w]));

test("a pushed change lands at once, keeping the chat's place", () => {
  const before = list(ws("a"), ws("b"));
  const after = applyWorkspaceChange(before, ws("b", { status: "working", updated_at: "2026-10-17T10:01:00Z" }));
  expect([...after.keys()]).toEqual(["a", "b"]);
  expect(after.get("b")?.status).toBe("working");
});

test("a new chat goes first, as workspace.list orders them", () => {
  expect([...applyWorkspaceChange(list(ws("a")), ws("new")).keys()]).toEqual(["new", "a"]);
});

test("an archived chat leaves the list; the Chief never joins it", () => {
  expect([...applyWorkspaceChange(list(ws("a"), ws("b")), ws("a", { status: "archived" })).keys()]).toEqual(["b"]);
  const before = list(ws("a"));
  expect(applyWorkspaceChange(before, ws("chief", { kind: "chief" }))).toBe(before);
  expect(applyWorkspaceChange(before, ws("gone", { status: "archived" }))).toBe(before);
});

test("a push that changes nothing keeps the same list, so nothing re-renders", () => {
  const before = list(ws("a"));
  expect(applyWorkspaceChange(before, ws("a"))).toBe(before);
});

test("a poll that read the store before a push does not undo it; an older push loses to a newer poll", () => {
  const polled = list(ws("a", { status: "working", updated_at: "2026-10-17T10:00:00Z" }));
  expect(withPushes(polled, [ws("a", { status: "needs_input", updated_at: "2026-10-17T10:00:05Z" })]).get("a")?.status).toBe("needs_input");
  const newer = list(ws("a", { status: "idle", updated_at: "2026-10-17T10:00:09Z" }));
  expect(withPushes(newer, [ws("a", { status: "working", updated_at: "2026-10-17T10:00:05Z" })]).get("a")?.status).toBe("idle");
  // A chat archived while the poll was out stays gone.
  expect(withPushes(polled, [ws("a", { status: "archived", updated_at: "2026-10-17T10:00:05Z" })]).has("a")).toBe(false);
});

test("the catch-up poll is slow, slower while nobody is looking", () => {
  expect(catchUpMs(true)).toBeGreaterThanOrEqual(5_000);
  expect(catchUpMs(false)).toBeGreaterThan(catchUpMs(true));
});
