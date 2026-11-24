import { describe, expect, it } from "vitest";
import { waitingLine } from "../components/pane/WaitingOn.tsx";
import { agentsAtWork, agentsOf, clock, latestStep, newestActivity, type AtWork } from "./now.ts";
import type { ToolItem, TranscriptItem } from "./transcript-model.ts";

const item = (x: Partial<TranscriptItem> & { kind: TranscriptItem["kind"] }) => x as TranscriptItem;
const tool = (id: string, status: ToolItem["status"], over: Partial<ToolItem> = {}) =>
  item({ kind: "tool", id, verb: status === "running" ? "Running" : "Ran", subject: `cmd ${id}`, status, icon: "run", startedAt: "2026-10-17T10:00:05Z", output: "", ...over });
const sub = (id: string, status: "running" | "done", items: TranscriptItem[], over: Record<string, unknown> = {}) =>
  item({ kind: "subagent", id, title: `agent ${id}`, workspaceId: null, agent: null, runner: null, summary: null, status, startedAt: "", finishedAt: null, items, ...over });

describe("subagents", () => {
  it("lists nested ones after their parent, with depth, steps, an open question and their own transcript", () => {
    const ask = item({ kind: "ask", id: "k", askKind: "approval", prompt: "?", options: [], resolution: null });
    const inner = sub("i", "running", [ask]);
    const outer = sub("o", "done", [tool("a", "done"), inner], { workspaceId: "w2", summary: "did it" });
    const list = agentsOf([item({ kind: "user" }), outer]);
    expect(list.map((a) => [a.id, a.depth, a.steps, a.asking])).toEqual([
      ["o", 1, 1, false],
      ["i", 2, 0, true],
    ]);
    expect(list[0]!.step).toBeNull();
    expect(list[0]!.items).toHaveLength(2);
  });

  it("says what a running one is doing this second", () => {
    const [a] = agentsOf([sub("x", "running", [tool("x1", "done"), tool("x2", "running", { verb: "Reading", subject: "retry.go" })])]);
    expect(a!.step).toEqual({ text: "Reading retry.go", icon: "run", live: true });
  });
});

describe("agents at work", () => {
  const chat = (id: string, status: "working" | "needs_input" | "idle") => ({ id, title: `chat ${id}`, status, created_at: "2026-10-17T09:00:00Z" });

  it("lists running subagents, nested ones included, and the chats still at work, each once", () => {
    const nested = sub("n", "running", [], { startedAt: "2026-10-17T10:02:00Z" });
    const native = sub("a", "running", [nested], { startedAt: "2026-10-17T10:01:00Z" });
    const delegated = sub("d", "done", [], { workspaceId: "w1", startedAt: "2026-10-17T10:00:00Z" });
    const list = agentsAtWork([native, delegated, sub("x", "done", [])], [chat("w1", "working"), chat("w2", "needs_input"), chat("w3", "idle")]);
    expect(list.map((a) => [a.id, a.startedAt, a.asking])).toEqual([
      // The delegated agent's chat says it still works; its transcript row says when it started.
      ["w1", "2026-10-17T10:00:00Z", false],
      ["w2", "2026-10-17T09:00:00Z", true],
      ["a", "2026-10-17T10:01:00Z", false],
      ["n", "2026-10-17T10:02:00Z", false],
    ]);
  });

  it("is empty once everything stopped", () => {
    expect(agentsAtWork([sub("d", "running", [], { workspaceId: "w1" })], [chat("w1", "idle")])).toEqual([]);
  });

  it("says what each is doing, and which step is newest", () => {
    const early = sub("e", "running", [tool("e1", "running", { verb: "Running", subject: "go test ./...", startedAt: "2026-10-17T10:00:05Z" })]);
    const late = sub("l", "running", [tool("l1", "running", { verb: "Reading", subject: "retry.go", startedAt: "2026-10-17T10:03:00Z" })]);
    const quiet = sub("q", "running", []);
    const list = agentsAtWork([late, early, quiet], []);
    expect(list.map((a) => [a.id, a.activity])).toEqual([
      ["l", "Reading retry.go"],
      ["e", "Running go test ./..."],
      ["q", null],
    ]);
    expect(newestActivity(list)?.id).toBe("l");
    expect(newestActivity([list[2]!])).toBeNull();
  });
});

describe("the waiting strip's line", () => {
  const at = (id: string, activity: string | null, activityAt = ""): AtWork => ({ id, title: `agent ${id}`, startedAt: "", asking: false, activity, activityAt });
  it("one agent: its name and what it does", () => {
    expect(waitingLine([at("a", "Reading retry.go")])).toEqual({ who: "agent a", activity: "Reading retry.go" });
    expect(waitingLine([at("a", null)])).toEqual({ who: "agent a", activity: null });
  });
  it("several: the newest activity, else every name", () => {
    expect(waitingLine([at("a", "Ran tests", "2026-10-17T10:00:00Z"), at("b", "Reading retry.go", "2026-10-17T10:01:00Z")])).toEqual({ who: "agent b:", activity: "Reading retry.go" });
    expect(waitingLine([at("a", null), at("b", null)])).toEqual({ who: "agent a, agent b", activity: null });
  });
});

describe("latest step", () => {
  it("is the newest thing since the person last spoke", () => {
    const said = item({ kind: "assistant", text: "Old plan", streaming: false });
    expect(latestStep([said, item({ kind: "user" }), tool("t", "running", { subject: "go test ./..." })])).toEqual({ text: "Running go test ./...", icon: "run", live: true });
    expect(latestStep([said, item({ kind: "user" })])).toBeNull();
    expect(latestStep([item({ kind: "reasoning", text: "", streaming: true })])).toEqual({ text: "Thinking", icon: "thinking", live: true });
  });
});

describe("clock", () => {
  it("never changes width within a unit", () => {
    expect(clock(8_000)).toBe("8s");
    expect(clock(248_000)).toBe("4m 08s");
    expect(clock(3_840_000)).toBe("1h 04m");
  });
});
