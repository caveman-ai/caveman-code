import { expect, test } from "vitest";
import { exportName, transcriptMarkdown } from "./transcript-export.ts";
import type { TranscriptItem } from "./transcript-model.ts";

const tool = (verb: string, subject: string, extra: Partial<Record<"added" | "removed", number>> & { status?: string } = {}) => ({
  kind: "tool",
  id: subject,
  verb,
  subject,
  parts: [],
  command: null,
  status: extra.status ?? "done",
  added: extra.added ?? null,
  removed: extra.removed ?? null,
});

test("a chat as Markdown: messages in full, tools one line each, plans as checklists, reasoning left out", () => {
  const items = [
    { kind: "user", id: "u1", text: "Fix it like [Auth flow](t3-context://v1/thread/w_1) did", at: "", delivery: "message" },
    { kind: "reasoning", id: "r1", text: "secret thoughts", streaming: false },
    tool("Read", "src/auth.ts"),
    tool("Edited", "src/auth.ts", { added: 3, removed: 1 }),
    tool("Ran", "pnpm `test`", { status: "failed" }),
    { kind: "plan", id: "p1", steps: [{ text: "Patch", status: "completed" }, { text: "Ship", status: "pending" }] },
    { kind: "assistant", id: "a1", text: "Done.", streaming: false, at: "" },
    { kind: "turn_end", id: "e1", outcome: "completed", at: "", cursor: 9 },
    { kind: "user", id: "u2", text: "Thanks", at: "", delivery: "message" },
  ] as unknown as TranscriptItem[];
  expect(transcriptMarkdown("Fix auth", "Claude Agent", items, new Date("2026-10-17T12:00:00Z"))).toBe(
    [
      "# Fix auth",
      "_Exported from Caveman Code on 2026-10-17. Engine: Claude Agent._",
      "## You",
      "Fix it like @Auth flow did",
      "## Claude Agent",
      "- Read `src/auth.ts`\n- Edited `src/auth.ts` (+3 −1)\n- Ran `pnpm 'test'` (failed)",
      "- [x] Patch\n- [ ] Ship",
      "Done.",
      "## You",
      "Thanks",
    ].join("\n\n") + "\n",
  );
});

test("the file is named after the chat", () => {
  expect(exportName("Fix webhook retry storm!")).toBe("fix-webhook-retry-storm.md");
  expect(exportName("???")).toBe("chat.md");
});
