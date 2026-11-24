import type { MemoryNote } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { groupNotes, repoLabel } from "./memory-model.ts";

const note = (id: string, scope: "me" | "project", repo: string | null, at: string): MemoryNote => ({
  id, scope, repo, path: "x.md", name: id, text: id, authority: "told", tainted: false, pinned: false, suspect: null,
  added: at.slice(0, 10), updated_at: at, by: "user", thread: null, vid: id,
});

test("groups notes for you first, then each repository, newest first", () => {
  const notes = [note("b", "project", "github.com/acme/web", "2026-10-02"), note("a", "me", null, "2026-10-01"), note("c", "me", null, "2026-10-03"), note("d", "project", "github.com/acme/api", "2026-10-04")];
  expect(groupNotes(notes, "all").map((g) => [g.title, g.notes.map((n) => n.id)])).toEqual([
    ["Me, in every repository", ["c", "a"]],
    ["github.com/acme/api", ["d"]],
    ["github.com/acme/web", ["b"]],
  ]);
  expect(groupNotes(notes, "me").map((g) => g.key)).toEqual(["me"]);
  expect(groupNotes(notes, "project").map((g) => g.key)).toEqual(["repo:github.com/acme/api", "repo:github.com/acme/web"]);
});

test("names a local repository by its first commit", () => {
  expect(repoLabel("local/31312f644f28546b25aca920986056c3abaf0e50")).toBe("Local repository 31312f6");
  expect(repoLabel("github.com/acme/web")).toBe("github.com/acme/web");
});
