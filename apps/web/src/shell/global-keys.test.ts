import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// ⌘K (Search and go to) and ? (Keyboard shortcuts) work on every screen: Settings is not inside the shell
// (main.tsx: settings/:section is AppShell's sibling), so they mount above both, beside What's new.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Search and the shortcut sheet mount above the shell and Settings, not inside the shell", () => {
  const gate = read("../routes/FirstRun.tsx");
  expect(gate).toContain("<GlobalSearch />");
  expect(gate).toContain("<ShortcutHelp />");
  // They used to live in the sidebar and AppShell, so in Settings ⌘K and ? did nothing.
  expect(read("./Sidebar.tsx")).not.toContain("<GoTo");
  expect(read("./AppShell.tsx")).not.toContain("<ShortcutHelp");
  // Settings really is outside the shell: that is why the move matters.
  const main = read("../main.tsx");
  expect(main.indexOf('path: "settings/:section"')).toBeGreaterThan(main.lastIndexOf("element: <AppShell />"));
});

test("a chat starts in one place: ⌘K offers New chat and no second way in, and the shell holds no dialog for one", () => {
  const goTo = read("./GoTo.tsx");
  expect(goTo).toContain('label: "New chat"');
  expect(goTo).not.toContain("New workspace");
  for (const file of ["./GlobalSearch.tsx", "./AppShell.tsx", "./GoTo.tsx"]) expect(read(file), file).not.toMatch(/NewWorkspace|newWorkspace|NEW_WORKSPACE/);
});
