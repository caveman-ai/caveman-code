// Several Chiefs share one board: each page shows only its own items, and a one-Chief runtime's items are home's.
import type { ChiefBoard, ChiefItem } from "@caveman-app/session-protocol";
import { isValidElement, type ReactNode } from "react";
import { expect, test } from "vitest";
import { highlight } from "../components/MarkdownField.tsx";
import { itemsOf } from "./chief.ts";
import { chiefFor, chiefPath, latestOf } from "./chiefs.ts";

const item = (id: string, chief_id?: string): ChiefItem => ({
  id,
  ...(chief_id ? { chief_id } : {}),
  text: id,
  state: "queued",
  rank: 1,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: [],
  created_at: "2026-10-23T00:00:00.000Z",
  updated_at: "2026-10-23T00:00:00.000Z",
});
const board: ChiefBoard = { items: [item("a", "home"), item("b", "rev"), item("c")], change_sets: [] };
const home = { id: "home", home: true };
const rev = { id: "rev", home: false };

test("a Chief's page shows its own items; an item with no chief_id is the home Chief's", () => {
  expect(itemsOf(board, home, false).map((i) => i.id)).toEqual(["a", "c"]);
  expect(itemsOf(board, rev, false).map((i) => i.id)).toEqual(["b"]);
});

test("before chief.get says who it is, a Chief shows nothing; a runtime with one Chief shows the whole board", () => {
  expect(itemsOf(board, null, false)).toEqual([]);
  expect(itemsOf(board, null, true).map((i) => i.id)).toEqual(["a", "b", "c"]);
});

test("the home Chief keeps /chief; another is found by its id, and an unknown id falls back to home", () => {
  const chiefs = [{ ...home, name: "Chief" }, { ...rev, name: "Grok" }] as never;
  expect(chiefPath(home)).toBe("/chief");
  expect(chiefPath(rev)).toBe("/chief/rev");
  expect(chiefFor(chiefs, "rev")?.id).toBe("rev");
  expect(chiefFor(chiefs, "gone")?.id).toBe("home");
  expect(chiefFor(chiefs, undefined)?.id).toBe("home");
});

test("a Chief's row says its latest reply, dated by its latest turn, else by its last change", () => {
  const at = "2026-11-17T09:00:00.000Z";
  expect(latestOf({ updated_at: at })).toEqual({ reply: undefined, at });
  expect(latestOf({ updated_at: at, activity: { last_reply: "Merged the fix.", turn_started_at: "2026-11-17T10:00:00.000Z" } })).toEqual({ reply: "Merged the fix.", at: "2026-11-17T10:00:00.000Z" });
  // A rename moves updated_at; its last turn still dates it.
  expect(latestOf({ updated_at: "2026-11-17T12:00:00.000Z", activity: { turn_ended_at: "2026-11-17T10:05:00.000Z" } }).at).toBe("2026-11-17T10:05:00.000Z");
});

/** The highlighted copy's text, which must be the soul exactly, or the textarea above it drifts off its letters. */
const textOf = (nodes: ReactNode): string =>
  Array.isArray(nodes) ? nodes.map(textOf).join("") : isValidElement<{ children?: ReactNode }>(nodes) ? textOf(nodes.props.children) : nodes == null ? "" : String(nodes);

test("the soul's highlighted copy is its text, character for character", () => {
  const soul = "# Soul\n\n## Crew rules\n- Run `pnpm -w test` first\n  1. nested\n> quoted\nplain `x` and `` empty\n";
  expect(textOf(highlight(soul))).toBe(soul);
});
