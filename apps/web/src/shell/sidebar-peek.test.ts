// The sidebar's hover card: a project's counts share one base, and a long path keeps the project's own folder.
import { expect, test } from "vitest";
import { chatStatuses, engineLine, foldersForSidebar, type WorkspaceView } from "../state/model.ts";
import { fitPath, projectTally } from "./SidebarPeek.tsx";

const chat = (id: string, over: Partial<WorkspaceView> = {}): WorkspaceView =>
  ({ id, title: id, repo: "/r", state: "idle", asleep: false, parentId: null, projectId: "p", unread: false, updatedAt: "2026-10-23T10:00:00Z", createdAt: "2026-10-23T09:00:00Z", computer: { kind: "this_mac", label: "This Mac" }, engine: { id: "codex", label: "Codex" }, ...over }) as WorkspaceView;

const tally = (workspaces: WorkspaceView[]) => {
  const [folder] = foldersForSidebar([{ id: "p", name: "p", path: "/r" }], workspaces);
  return projectTally(folder!, chatStatuses(workspaces));
};

test("a project counts chats, not their agents: a lead whose agents work is one chat at work", () => {
  const lead = chat("lead");
  const agents = [chat("a1", { parentId: "lead", state: "working" }), chat("a2", { parentId: "lead", state: "working" })];
  expect(tally([lead, ...agents, chat("other")])).toMatchObject({ needs: 0, atWork: 1 });
});

test("a chat whose agent asks something needs you, and is not also counted at work", () => {
  const lead = chat("lead", { state: "working" });
  const asking = chat("a1", { parentId: "lead", state: "needs_input", activity: { ask: { kind: "approval", prompt: "Run it?" }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false } });
  expect(tally([lead, asking])).toMatchObject({ needs: 1, atWork: 0 });
});

test("a project's last activity is its newest chat or agent", () => {
  expect(tally([chat("a"), chat("b", { parentId: "a", updatedAt: "2026-10-23T11:00:00Z" })]).newest).toBe("2026-10-23T11:00:00Z");
  expect(projectTally({ project: { id: "p", name: "p", path: null }, rows: [], count: 0 }, new Map())).toEqual({ needs: 0, atWork: 0, newest: null });
});

test("a long path folds its middle folders and keeps its own", () => {
  expect(fitPath("~/Desktop/GitHub/Caveman Cloud")).toBe("~/Desktop/GitHub/Caveman Cloud");
  expect(fitPath("~/Documents/work/clients/acme-industries/platform/sdk-python")).toBe("~/…/platform/sdk-python");
  expect(fitPath("C:\\Users\\me\\Documents\\work\\clients\\acme-industries\\platform\\sdk")).toBe("C:\\…\\acme-industries\\platform\\sdk");
  // A folder name longer than the card still shows whole; the line's own truncation takes over.
  expect(fitPath("~/a/a-very-long-folder-name-that-alone-is-wider-than-the-card")).toBe("~/…/a-very-long-folder-name-that-alone-is-wider-than-the-card");
});

test("a chat an outside agent started names it beside the engine, never in its place", () => {
  expect(engineLine(chat("a", { startedBy: "Claude Code" }), "Claude Agent")).toBe("Claude Agent · Claude Code");
  expect(engineLine(chat("b"), "Codex")).toBe("Codex");
});
