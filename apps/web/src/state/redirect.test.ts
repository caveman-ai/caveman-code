// A message sent while approvals wait declines them and redirects the agent (upstream #21503).
import { describe, expect, test } from "vitest";
import { declineForRedirect, noteTarget, RedirectHeld, waitingApprovals, type WaitingApproval } from "./redirect.ts";
import type { TranscriptItem } from "./transcript-model.ts";

const approval = (id: string, resolution: string | null = null, deny = true): TranscriptItem => ({
  kind: "ask",
  id,
  askKind: "approval",
  prompt: "Run make?",
  options: [
    { id: `${id}:allow`, label: "Allow", description: null, decision: "allow" },
    ...(deny ? [{ id: `${id}:deny`, label: "Deny", description: null, decision: "deny" as const }] : []),
  ],
  resolution,
  questions: [],
  round: null,
  answers: null,
});

describe("waitingApprovals", () => {
  test("lists unanswered approvals, a native subagent's too, with their Deny", () => {
    const question: TranscriptItem = { ...(approval("q") as Extract<TranscriptItem, { kind: "ask" }>), askKind: "question" };
    const sub = { kind: "subagent", id: "s", items: [approval("inner")] } as unknown as TranscriptItem;
    expect(waitingApprovals([approval("a"), approval("b", "Allow"), question, sub, approval("c", null, false)])).toEqual([
      { askId: "a", denyId: "a:deny", feedback: false },
      { askId: "inner", denyId: "inner:deny", feedback: false },
      { askId: "c", denyId: null, feedback: false },
    ]);
  });
});

describe("noteTarget", () => {
  const takesNote = (id: string): TranscriptItem => ({ ...(approval(id) as Extract<TranscriptItem, { kind: "ask" }>), acceptsFeedback: true });
  test("a message answers the one approval waiting as its deny's note, when its engine takes one (T3's #23657)", () => {
    const waiting = waitingApprovals([takesNote("a")]);
    expect(waiting).toEqual([{ askId: "a", denyId: "a:deny", feedback: true }]);
    expect(noteTarget(waiting, 0)).toEqual({ askId: "a", denyId: "a:deny", feedback: true });
  });
  test("several waiting, one that takes no note, or a message with attachments redirects as before", () => {
    expect(noteTarget(waitingApprovals([takesNote("a"), takesNote("b")]), 0)).toBeNull();
    expect(noteTarget(waitingApprovals([approval("a")]), 0)).toBeNull();
    expect(noteTarget(waitingApprovals([takesNote("a")]), 1)).toBeNull();
    expect(noteTarget([], 0)).toBeNull();
  });
});

describe("declineForRedirect", () => {
  const nobodyFirst = () => false;
  test("declines each approval with its Deny, in order", async () => {
    const calls: string[] = [];
    const approvals: WaitingApproval[] = [
      { askId: "a", denyId: "a:deny", feedback: false },
      { askId: "b", denyId: "b:deny", feedback: false },
    ];
    await declineForRedirect(approvals, async (ask, option) => void calls.push(`${ask}=${option}`), nobodyFirst, () => approvals);
    expect(calls).toEqual(["a=a:deny", "b=b:deny"]);
  });

  test("skips an approval with no Deny", async () => {
    const calls: string[] = [];
    await declineForRedirect([{ askId: "a", denyId: null, feedback: false }], async (ask) => void calls.push(ask), nobodyFirst, () => []);
    expect(calls).toEqual([]);
  });

  test("a refused decline holds the message", async () => {
    await expect(
      declineForRedirect([{ askId: "a", denyId: "a:deny", feedback: false }], () => Promise.reject(new Error("offline")), nobodyFirst, () => []),
    ).rejects.toBeInstanceOf(RedirectHeld);
  });

  test("an approval answered first elsewhere waits no more, so the message still goes", async () => {
    const elsewhere = new Error("answered");
    await expect(
      declineForRedirect([{ askId: "a", denyId: "a:deny", feedback: false }], () => Promise.reject(elsewhere), (e) => e === elsewhere, () => []),
    ).resolves.toBeUndefined();
  });

  test("an approval that arrived during the declines holds the message for the next send", async () => {
    const declined: WaitingApproval = { askId: "a", denyId: "a:deny", feedback: false };
    await expect(
      declineForRedirect([declined], async () => undefined, nobodyFirst, () => [declined, { askId: "late", denyId: "late:deny", feedback: false }]),
    ).rejects.toThrow(/Another one arrived/);
  });
});
