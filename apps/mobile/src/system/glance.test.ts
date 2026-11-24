// What the Lock Screen, the Dynamic Island and the widget say (glance.ts): one mood, most urgent first, the oldest ask,
// and which buttons act in place and which open the app (a locked phone unlocks before anything goes ahead).
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

import type { Chat } from "../board/model";
import { freshState } from "../store/store";
import { glanceOf, isLive } from "./glance";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return { id, title: id, repo: "app", device: "mbp", engine: "claude", model: "opus", phase: "done", line: "", items: [], startedAt: NOW - 60 * MIN, updatedAt: NOW - 10 * MIN, ...over };
}

function state(chats: Chat[]) {
  const s = freshState(NOW);
  return { ...s, board: { ...s.board, chats }, inbox: { ...s.inbox, archived: {} } };
}

describe("glanceOf", () => {
  it("leads with the oldest ask, in words, and counts the rest", () => {
    const g = glanceOf(
      state([
        chat("new-ask", { phase: "needs", need: { kind: "approval", command: "pnpm add zod", summary: "", at: NOW - MIN }, ask: "pnpm add zod" }),
        chat("old-ask", { phase: "needs", need: { kind: "approval", command: "pnpm i", summary: "", at: NOW - 30 * MIN }, ask: "pnpm i" }),
        chat("busy", { phase: "working", line: "Reading the relay" }),
      ]),
      null,
    );
    expect(g.mood).toBe("needs");
    expect(g.link).toBe("caveman://chat/old-ask");
    expect(g.detail).toBe("1 of 2");
    expect(g.count).toBe(2);
    expect(isLive(g)).toBe(true);
  });

  it("acts on Deny in place, and opens the app to Allow", () => {
    const g = glanceOf(state([chat("ask", { phase: "needs", need: { kind: "approval", command: "rm -rf dist", summary: "", at: NOW }, ask: "rm -rf dist" })]), null);
    expect(g.choices).toEqual([
      { label: "Deny", target: "deny:ask", tone: "quiet" },
      { label: "Allow", open: "caveman://chat/ask?answer=allow", tone: "strong" },
    ]);
  });

  it("offers a question's two options by name, the recommended one strong, both through the app", () => {
    const need = { kind: "question" as const, question: "Keep the flag?", options: [{ label: "Remove it", recommended: true }, { label: "Keep it" }], summary: "", at: NOW };
    const g = glanceOf(state([chat("q", { phase: "needs", need })]), null);
    expect(g.choices.map((c) => [c.label, c.tone, c.open, c.target])).toEqual([
      ["Keep it", "quiet", "caveman://chat/q?answer=1", undefined],
      ["Remove it", "strong", "caveman://chat/q?answer=0", undefined],
    ]);
  });

  it("opens the chat for a question with more than two options", () => {
    const need = { kind: "question" as const, question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], summary: "", at: NOW };
    expect(glanceOf(state([chat("q", { phase: "needs", need })]), null).choices).toEqual([]);
  });

  it("puts a call before everything, with Mute and End in place", () => {
    const g = glanceOf(state([chat("ask", { phase: "needs", ask: "pnpm i", need: { kind: "approval", command: "pnpm i", summary: "", at: NOW } })]), {
      kind: "call",
      who: "Oona",
      chief: "oona",
      since: NOW - 90_000,
      muted: true,
      state: "Listening",
    });
    expect(g.mood).toBe("talk");
    expect(g.line).toBe("Muted");
    expect(g.link).toBe("caveman://chief/oona");
    expect(g.choices.map((c) => c.target)).toEqual(["mute", "end"]);
    expect(g.choices.every((c) => !c.open)).toBe(true);
  });

  it("says all done, on the home Chief's face, when nothing is going on", () => {
    const g = glanceOf(state([chat("over")]), null);
    expect(g.mood).toBe("done");
    expect(g.chief).toBe("home");
    expect(isLive(g)).toBe(false);
  });
});
