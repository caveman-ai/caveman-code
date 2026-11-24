// Home's four axes add up to the same agents after every send (DECISIONS.md "Home, exactly": tiles = Chiefs plus
// chats with no Chief = workspaces = devices). A chat started from Home's bar is one of your own, so it counts under
// "Your chats" and never on the Chief that watches its workspace; one a Chief starts is that Chief's.
import { describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import { type Chat, itemId } from "../board/model";
import { world } from "../board/world";
import { boardOf, reduceBoard } from "../store/board";
import { chiefList, devices, readyOf, rows, type Seen, tiles, workspaces } from "../store/select";
import { chiefCards, yourCard } from "./model";

const NOW = 1_762_400_000_000;

function newChat(id: string, repo: string, chief: string | null): Chat {
  return { id, title: id, repo, chief, device: "mbp", engine: "claude", model: "claude-opus-5-5", phase: "working", line: "Thinking", startedAt: NOW, updatedAt: NOW, items: [{ kind: "you", id: itemId(), text: id, at: NOW }] };
}

function axes(chats: readonly Chat[]) {
  const all = rows(chats, {});
  const cards = chiefCards(all, chats, {});
  const yours = yourCard(all, chats);
  return {
    tiles: tiles(all).all.count,
    chiefs: cards.reduce((n, c) => n + c.total, 0) + (yours?.total ?? 0),
    workspaces: workspaces(all).reduce((n, w) => n + w.total, 0),
    devices: devices(all).reduce((n, d) => n + d.total, 0),
    oona: cards.find((c) => c.chief?.id === "oona")?.total ?? 0,
    yours: yours?.total ?? 0,
  };
}

describe("Home's counts", () => {
  const w = world(NOW);
  let board = boardOf(w.chats, w.said);
  const start = axes(board.chats);

  it("agree on the scripted world, with no chats of your own", () => {
    expect(start.chiefs).toBe(start.tiles);
    expect(start.workspaces).toBe(start.tiles);
    expect(start.devices).toBe(start.tiles);
    expect(start.yours).toBe(0);
  });

  it("count a chat sent from Home's bar under Your chats, not under the workspace's Chief", () => {
    board = reduceBoard(board, { type: "add", chat: newChat("from-home", "marketing", null) });
    const now = axes(board.chats);
    expect(now.tiles).toBe(start.tiles + 1);
    expect(now.oona).toBe(start.oona);
    expect(now.yours).toBe(1);
    expect(now.chiefs).toBe(now.tiles);
    expect(now.workspaces).toBe(now.tiles);
    expect(now.devices).toBe(now.tiles);
  });

  it("count a chat a Chief starts on that Chief", () => {
    board = reduceBoard(board, { type: "add", chat: newChat("from-oona", "marketing", "oona") });
    const now = axes(board.chats);
    expect(now.oona).toBe(start.oona + 1);
    expect(now.yours).toBe(1);
    expect(now.chiefs).toBe(now.tiles);
    expect(now.workspaces).toBe(now.tiles);
    expect(now.devices).toBe(now.tiles);
  });

  it("say the same ready again after Mark all seen: none new, every one still there as seen", () => {
    const all = rows(board.chats, {});
    const readyRows = all.filter((r) => r.phase === "ready");
    expect(readyRows.length).toBeGreaterThan(0);
    const before = readyOf(all);
    expect(before.unseen).toBe(readyRows.length);
    expect(tiles(all).ready.count).toBe(readyRows.length);
    // Mark all seen: each ready chat seen in the phase it is in.
    const seen: Seen = { seen: Object.fromEntries(readyRows.map((r) => [r.chat.id, "ready" as const])), unread: {} };
    const after = readyOf(all, seen);
    expect(after).toEqual({ unseen: 0, seen: readyRows.length });
    expect(tiles(all, seen).ready.count).toBe(0);
    expect(chiefList(all, {}, seen).reduce((n, c) => n + c.ready, 0)).toBe(0);
    expect(chiefList(all, {}, seen).reduce((n, c) => n + c.seenReady, 0)).toBe(readyRows.length);
    expect(workspaces(all, seen).reduce((n, w) => n + w.ready, 0)).toBe(0);
    const cards = chiefCards(all, board.chats, {}, seen);
    expect(cards.reduce((n, c) => n + c.ready, 0)).toBe(0);
    // No Chief row says "ready" once nothing is new: not in its count, not in its line.
    for (const card of cards) expect(card.line).not.toMatch(/\bready\b/i);
    // The four axes still add up to the same agents.
    expect(chiefList(all, {}, seen).reduce((n, c) => n + c.total, 0) + (yourCard(all, board.chats, seen)?.total ?? 0)).toBe(tiles(all, seen).all.count);
  });
});
