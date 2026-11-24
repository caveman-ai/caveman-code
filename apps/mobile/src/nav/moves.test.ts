// The stack's one rule for opening a chat or a Chief (moves.ts), on the stacks the Chief-to-chat hand-off produced:
// the From link in a subagent went back over its own parent and pushed it again, a Chief opened from a chat's Details
// stacked a second live copy of itself, and two taps in one frame pushed the same screen twice.
import { describe, expect, it } from "vitest";
import { chatMove, chiefMove, type Stack } from "./moves";

/** A stack from its screens bottom to top, "Chief:oona" or "Thread:audit", the last one on top. */
const stack = (...names: string[]): Stack => ({
  index: names.length - 1,
  routes: names.map((n, i) => {
    const [name, id] = n.split(":");
    return { name: name!, key: `${name}-${i}`, params: id ? { id } : undefined };
  }),
});

/** Applies a move the way nav/ref.ts does, for reading the stack after it. */
function after(s: Stack, move: ReturnType<typeof chatMove>, name: "Thread" | "Chief", id: string): string[] {
  const names = s.routes.slice(0, s.index + 1).map((r) => `${r.name}${(r.params as { id?: string } | undefined)?.id ? `:${(r.params as { id: string }).id}` : ""}`);
  if (move.kind === "stay") return names;
  if (move.kind === "back") return names.slice(0, names.length - move.count);
  if (move.kind === "replace") return [...names.slice(0, -1), `${name}:${id}`];
  return [...names, ...move.ids.map((chat) => `${name}:${chat}`)];
}

describe("opening a chat", () => {
  it("goes back to a parent that sits right under its subagent, never pushes it again", () => {
    const s = stack("Home", "Chief:home", "Thread:audit", "Thread:audit-composer");
    const move = chatMove(s, ["audit"]);
    expect(move).toEqual({ kind: "back", count: 1, key: "Thread-2" });
    expect(after(s, move, "Thread", "audit")).toEqual(["Home", "Chief:home", "Thread:audit"]);
  });

  it("does nothing for the chat on top: a second tap in the same frame", () => {
    const s = stack("Home", "Chief:grug", "Thread:audit", "Thread:audit-thread");
    expect(chatMove(s, ["audit", "audit-thread"])).toEqual({ kind: "stay", key: "Thread-3" });
  });

  it("pushes a subagent over its parent on top", () => {
    const s = stack("Home", "Chief:home", "Thread:audit");
    const move = chatMove(s, ["audit", "audit-thread"]);
    expect(move).toEqual({ kind: "push", ids: ["audit-thread"] });
    expect(after(s, move, "Thread", "audit-thread")).toEqual(["Home", "Chief:home", "Thread:audit", "Thread:audit-thread"]);
  });

  it("puts a subagent's parents in under it when they aren't on top", () => {
    const s = stack("Home", "Chief:home");
    expect(chatMove(s, ["audit", "audit-composer"])).toEqual({ kind: "push", ids: ["audit", "audit-composer"] });
  });

  it("starts from the nearest relative on top in a deeper family", () => {
    expect(chatMove(stack("Home", "Thread:a"), ["a", "b", "c"])).toEqual({ kind: "push", ids: ["b", "c"] });
    expect(chatMove(stack("Home", "Thread:b"), ["a", "b", "c"])).toEqual({ kind: "push", ids: ["c"] });
  });

  it("pushes over a Chief, and over a chat of another family", () => {
    expect(chatMove(stack("Home", "Chief:oona"), ["hero"])).toEqual({ kind: "push", ids: ["hero"] });
    expect(chatMove(stack("Home", "Thread:hero"), ["audit"])).toEqual({ kind: "push", ids: ["audit"] });
  });

  it("leaves a chat further down where it is, so a link never throws away the screens you came through", () => {
    expect(chatMove(stack("Home", "Thread:audit", "Chief:oona", "Thread:hero"), ["audit"])).toEqual({ kind: "push", ids: ["audit"] });
  });

  it("never puts a parent on again from a sibling on top (Search, a toast, a link to another of its agents)", () => {
    const s = stack("Home", "Chief:home", "Thread:audit", "Thread:audit-thread");
    const move = chatMove(s, ["audit", "audit-composer"]);
    expect(move).toEqual({ kind: "push", ids: ["audit-composer"] });
    expect(after(s, move, "Thread", "audit-composer")).toEqual(["Home", "Chief:home", "Thread:audit", "Thread:audit-thread", "Thread:audit-composer"]);
  });

  it("puts a chat on again when it sits deeper in the run of chats, never pushing nothing", () => {
    expect(chatMove(stack("Home", "Thread:x", "Thread:y", "Thread:z"), ["x"])).toEqual({ kind: "push", ids: ["x"] });
  });

  it("matches by id, not by name: another chat right under is no reason to go back", () => {
    expect(chatMove(stack("Home", "Thread:hero", "Thread:audit"), ["copy"])).toEqual({ kind: "push", ids: ["copy"] });
  });

  describe("in the top's place (the strip's up arrow, a sibling, Next)", () => {
    it("goes back to the parent under it", () => {
      expect(chatMove(stack("Home", "Thread:audit", "Thread:audit-composer"), ["audit"], "inPlace")).toEqual({ kind: "back", count: 1, key: "Thread-1" });
    });
    it("takes the top's place when it isn't under it", () => {
      const s = stack("Home", "Thread:audit-composer");
      const move = chatMove(s, ["audit"], "inPlace");
      expect(move).toEqual({ kind: "replace" });
      expect(after(s, move, "Thread", "audit")).toEqual(["Home", "Thread:audit"]);
    });
    it("never replaces a screen with itself", () => {
      expect(chatMove(stack("Home", "Thread:audit-thread"), ["audit", "audit-thread"], "inPlace")).toEqual({ kind: "stay", key: "Thread-1" });
    });
    it("goes back rather than leave the same chat twice in a row", () => {
      expect(chatMove(stack("Home", "Thread:x", "Chief:grug"), ["x"], "inPlace")).toEqual({ kind: "back", count: 1, key: "Thread-1" });
    });
  });
});

describe("opening a Chief", () => {
  it("goes back to the one already on the stack, never a second live copy", () => {
    const s = stack("Home", "Chief:oona", "Thread:hero");
    const move = chiefMove(s, "oona");
    expect(move).toEqual({ kind: "back", count: 1, key: "Chief-1" });
    expect(after(s, move, "Chief", "oona")).toEqual(["Home", "Chief:oona"]);
  });

  it("goes back however far down it is", () => {
    expect(chiefMove(stack("Home", "Chief:oona", "Thread:hero", "Thread:hero-sub"), "oona")).toEqual({ kind: "back", count: 2, key: "Chief-1" });
  });

  it("does nothing for the Chief on top: a second tap in the same frame", () => {
    expect(chiefMove(stack("Home", "Chief:grug"), "grug")).toEqual({ kind: "stay", key: "Chief-1" });
  });

  it("matches by id, not by name: another Chief on the stack is no reason to go back", () => {
    const s = stack("Home", "Chief:grug", "Thread:audit");
    const move = chiefMove(s, "oona");
    expect(move).toEqual({ kind: "push", ids: ["oona"] });
    expect(after(s, move, "Chief", "oona")).toEqual(["Home", "Chief:grug", "Thread:audit", "Chief:oona"]);
  });

  it("goes back to the nearest when the stack somehow holds two", () => {
    expect(chiefMove(stack("Home", "Chief:oona", "Thread:hero", "Chief:oona", "Thread:copy"), "oona")).toEqual({ kind: "back", count: 1, key: "Chief-3" });
  });

  describe("in the top's place (its menu's other Chiefs, Next)", () => {
    it("goes back to it when it is on the stack", () => {
      expect(chiefMove(stack("Home", "Chief:oona", "Thread:hero", "Chief:grug"), "oona", "inPlace")).toEqual({ kind: "back", count: 2, key: "Chief-1" });
    });
    it("takes the top's place when it isn't", () => {
      expect(chiefMove(stack("Home", "Chief:grug"), "oona", "inPlace")).toEqual({ kind: "replace" });
    });
  });
});
