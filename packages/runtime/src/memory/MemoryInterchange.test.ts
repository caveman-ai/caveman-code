// The one-time import of Claude Agent's own memories: drafts through the commit path, matched to opened repositories.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createScrubber } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { importClaudeMemories, sanitizeClaudePath } from "./MemoryInterchange.ts";
import { MemoryStore, type WriterContext } from "./MemoryStore.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-import-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const note = (type: string, body: string) =>
  `---\nname: imported\ndescription: "An imported note"\nmetadata:\n  node_type: memory\n  type: ${type}\n  originSessionId: 5b9a20ee\n---\n\n${body}\n`;

test("imports Claude's notes as drafts: matched repositories, and notes that hold everywhere", () => {
  const home = path.join(root, "claude");
  const opened = "/Users/me/code/widgets";
  const write = (project: string, file: string, text: string) => {
    fs.mkdirSync(path.join(home, "projects", project, "memory"), { recursive: true });
    fs.writeFileSync(path.join(home, "projects", project, "memory", file), text);
  };
  write(sanitizeClaudePath(opened), "project_build.md", note("project", "Build with `make all`."));
  write(sanitizeClaudePath(opened), "MEMORY.md", "- [Build](project_build.md) — build\n");
  write("-Users-me-code-elsewhere", "feedback_terse.md", note("feedback", "Keep answers terse."));
  write("-Users-me-code-elsewhere", "project_other.md", note("project", "A repo never opened here."));
  expect(importClaudeMemories.count(home)).toBe(3);
  const store = new MemoryStore(path.join(root, "store.db"), Buffer.alloc(32, 3));
  const ctx: WriterContext = { kind: "import", session: "import:claude", knownRepos: ["github.com/me/widgets"], teamStores: [], userMessages: [], brokerSecrets: [] };
  const result = importClaudeMemories(store, ctx, home, new Map([[opened, "github.com/me/widgets"]]));
  expect(result).toEqual({ imported: 2, skipped: 1 });
  expect(store.current({ teamStores: [] }).map((d) => [d.path, d.authority, d.text]).sort()).toEqual([
    ["repos/github.com/me/widgets/project-build.md", "draft", "Build with `make all`."],
    ["user/feedback-terse.md", "draft", "Keep answers terse."],
  ]);
  store.close();
});

test("masks a secret before it cuts a long note or names its file: no part of the value is kept, and a note the mask lengthens still comes in", () => {
  const secret = "Zq8vR2mXw7LpT4nB9cKd";
  const home = path.join(root, "claude-secret");
  const dir = path.join(home, "projects", "-Users-me-code-elsewhere", "memory");
  fs.mkdirSync(dir, { recursive: true });
  // The value straddles the 500-character cut; the other note is 496 characters until its value is masked.
  fs.writeFileSync(path.join(dir, `feedback_${secret}.md`), note("feedback", `${"a".repeat(489)} ${secret} tail.`));
  fs.writeFileSync(path.join(dir, "feedback_short.md"), note("feedback", `${"b".repeat(470)} ${secret} end.`));
  const store = new MemoryStore(path.join(root, "secret-store.db"), Buffer.alloc(32, 3));
  const scrubber = createScrubber([{ name: "STAGING_DEPLOY_TOKEN", value: secret }]);
  const ctx: WriterContext = { kind: "import", session: "import:claude", knownRepos: [], teamStores: [], userMessages: [], brokerSecrets: [], scrubber };
  const result = importClaudeMemories(store, ctx, home, new Map());
  const rows = store.visible({ teamStores: [] }, true);
  // Nor a cut of it in any case: a note's file name is lowercased.
  const cuts = Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8).toLowerCase());
  expect({
    result,
    holding: rows.filter((r) => cuts.some((cut) => JSON.stringify(r).toLowerCase().includes(cut))).map((r) => r.path),
    notes: rows.map((r) => [r.path, r.text.slice(-12)]).sort(),
  }).toEqual({
    result: { imported: 2, skipped: 0 },
    holding: [],
    notes: [
      ["user/feedback-secret-staging-deploy-token-.md", "aaaaaaaaaaa…"],
      ["user/feedback-short.md", "bbbbbbbbbbb…"],
    ],
  });
  store.close();
});
