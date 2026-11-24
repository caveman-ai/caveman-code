// A chat's right-click menu is one list wherever it opens: the chat list's rows and the queue's both render
// ChatMenuItems, so a chat action added for one (Add to Chief, PR #35) reaches the other.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const src = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const body = (start: string) => {
  const from = src.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const next = src.slice(from + start.length).search(/\n(?:const|function|export) /);
  return src.slice(from, from + start.length + next);
};

test("the chat list's menu and the queue's share the chat actions", () => {
  const items = body("function ChatMenuItems(");
  for (const action of [
    "Open in new tab",
    "Rename",
    "Review #",
    "Fork",
    "<AddToChief",
    "<InboxItems",
    "<FolderItems",
    "Archive",
  ])
    expect(items).toContain(action);
  for (const place of [body("const WorkspaceRow = memo("), body("function Queue(")]) {
    expect(place).toContain("<ChatMenuItems");
    // No chat action of its own beside the shared list.
    for (const own of ["<AddToChief", "<InboxItems", "session.fork", "Open in new tab"])
      expect(place).not.toContain(own);
  }
});
