// A code span in an answer: a chip with the file's mark when it names a file, else code.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { CodePath, copiedPath, FileRefsContext, type FileRefActions } from "./FileChip.tsx";

test("copied paths keep the chip's line and the computer's separators (T3 #21497, #19201)", () => {
  expect(copiedPath("/repo/.claude/worktrees/topic", { path: "src/main.ts", line: 12 }, false)).toBe("src/main.ts:12");
  expect(copiedPath("/repo/.claude/worktrees/topic/", { path: "src/main.ts", line: 12 }, true)).toBe("/repo/.claude/worktrees/topic/src/main.ts:12");
  expect(copiedPath("/repo", { path: "src", directory: true }, true)).toBe("/repo/src");
  expect(copiedPath("C:\\Users\\me\\repo", { path: "src/main.ts", line: 3 }, false)).toBe("src\\main.ts:3");
  expect(copiedPath("C:\\Users\\me\\repo\\", { path: "src/main.ts" }, true)).toBe("C:\\Users\\me\\repo\\src\\main.ts");
  expect(copiedPath(null, { path: "src/main.ts" }, true)).toBe("src/main.ts");
  // A host path outside the chat's folder is already whole: never joined to the folder.
  expect(copiedPath("/repo", { path: "/tmp/result.txt" }, true)).toBe("/tmp/result.txt");
  expect(copiedPath("/repo", { path: "/tmp/result.txt", line: 4 }, false)).toBe("/tmp/result.txt:4");
});

const actions: FileRefActions = {
  open: () => undefined,
  edit: null,
  editor: null,
  reveal: null,
  copy: () => undefined,
  canCopyFull: false,
  outside: () => false,
  touched: (name) => (name === "pilot.md" ? "notes/pilot.md" : null),
};
const render = (text: string) =>
  renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      { value: { client: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue },
      createElement(FileRefsContext.Provider, { value: actions }, createElement(CodePath, { text, root: "/repo", workspaceId: "w1" })),
    ),
  );

test("a bare name the chat touched is a chip with its file mark; any other bare name stays code", () => {
  const chip = render("pilot.md");
  expect(chip).toContain('data-file-icon="markdown"');
  expect(chip).toContain('title="notes/pilot.md"');
  expect(render("questions.md")).toMatch(/^<code[^>]*>questions\.md<\/code>$/);
  // A path was a chip before and still is.
  expect(render("docs/plan.md")).toContain("data-file-icon");
});
