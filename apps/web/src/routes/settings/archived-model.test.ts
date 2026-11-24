import type { Project, Workspace } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { archivedGroups, archivedWhen } from "./archived-model.ts";

const ws = (id: string, over: Partial<Workspace>): Workspace =>
  ({ id, title: id, repo: { path: "/Users/me/src/app" }, branch: `caveman/${id}`, status: "archived", updated_at: "2026-10-17T10:00:00Z", ...over }) as unknown as Workspace;
const project = (id: string, name: string) => ({ id, name, path: `/Users/me/src/${name}` }) as unknown as Project;

test("archived chats sit under their project, newest first, the project with the newest archive on top", () => {
  const groups = archivedGroups(
    [
      ws("a", { project_id: "p1", updated_at: "2026-10-15T10:00:00Z" }),
      ws("b", { project_id: "p2", updated_at: "2026-10-16T10:00:00Z" }),
      ws("c", { project_id: "p1", updated_at: "2026-10-17T10:00:00Z" }),
    ],
    [project("p1", "web"), project("p2", "api")],
  );
  expect(groups.map((g) => [g.label, g.chats.map((c) => c.id)])).toEqual([
    ["web", ["c", "a"]],
    ["api", ["b"]],
  ]);
});

test("live chats and the Chief are not archived chats", () => {
  expect(archivedGroups([ws("live", { status: "idle" }), ws("chief", { kind: "chief" })], [])).toEqual([]);
});

test("a removed project's chats still show, under the repository's name, marked removed", () => {
  const [group] = archivedGroups([ws("a", { project_id: "gone", repo: { path: "/Users/me/src/old-repo" } as never })], [project("p1", "web")]);
  expect(group).toMatchObject({ label: "old-repo", removed: true });
  expect(archivedGroups([ws("a", { project_id: "p1" })], [project("p1", "web")])[0]!.removed).toBe(false);
});

test("the filter keeps chats whose title, project or branch holds every word", () => {
  const list = [ws("fix login", { project_id: "p1" }), ws("add billing", { project_id: "p1" })];
  expect(archivedGroups(list, [project("p1", "web")], "login").flatMap((g) => g.chats.map((c) => c.id))).toEqual(["fix login"]);
  expect(archivedGroups(list, [project("p1", "web")], "web billing").flatMap((g) => g.chats.map((c) => c.id))).toEqual(["add billing"]);
  expect(archivedGroups(list, [project("p1", "web")], "nothing")).toEqual([]);
});

test("when it was archived reads as words", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  expect(archivedWhen("2026-10-17T11:59:40Z", now)).toBe("archived just now");
  expect(archivedWhen("2026-10-17T09:00:00Z", now)).toBe("archived 3h ago");
  expect(archivedWhen("2026-05-01T09:00:00Z", now)).toMatch(/^archived May 2026$/);
});
