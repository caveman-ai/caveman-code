// Pushes: notes matched to a file, a failure or a message without a model, few at a time, once each.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, expect, test, vi } from "vitest";

import { render, runCopyTool, sessionBrief, startSession, type RenderContext } from "./MemoryCopy.ts";
import { MemoryStore, newId, type NoteRow, type WriterContext } from "./MemoryStore.ts";
import { anchorsOf, changedSince, codexReads, COMPACT_FILES_MAX, compactNotes, keepAsk, names, PUSH_MAX, PUSH_SESSION_MAX, PushIndex, PushLedger, readsOf, renderChangedFiles, renderPush, repoRelative, score } from "./MemoryPush.ts";

// Reads come back absolute on the host: Windows puts the current drive in front of a rooted path.
const abs = (...files: ReadonlyArray<string>) => files.map((file) => path.resolve(file));

let serial = 0;
const note = (text: string, extra: Partial<Omit<NoteRow, "meta">> & { meta?: Record<string, unknown> } = {}): NoteRow => {
  serial++;
  const { meta, ...rest } = extra;
  return {
    vid: `v${String(serial).padStart(4, "0")}`,
    store: "me",
    id: `n${String(serial).padStart(9, "0")}`,
    path: `repos/github.com/acme/app/note-${serial}.md`,
    text,
    added: "2026-10-12",
    until: null,
    source: "session:old",
    meta: JSON.stringify(meta ?? {}),
    authority: "draft",
    tainted: 0,
    by: "session:old",
    at: "2026-10-12T00:00:00Z",
    ...rest,
  };
};

test("a note's anchors: the paths it names, its code, its error names and its title words", () => {
  const a = anchorsOf(note("run `pnpm schema` after editing packages/session-protocol/src/protocol.ts, or the schema test fails with ERR_SCHEMA_DRIFT", { meta: { name: "Session protocol schema", cites: ["src/db.ts:42"] } }));
  expect(a.paths).toEqual(expect.arrayContaining(["packages/session-protocol/src/protocol.ts", "src/db.ts"]));
  expect(a.spans).toEqual(["pnpm schema"]);
  expect(a.errors).toEqual(["ERR_SCHEMA_DRIFT"]);
  expect([...a.title]).toEqual(expect.arrayContaining(["session", "protocol", "schema"]));
  expect(anchorsOf(note("see https://example.com/docs.html and version 1.2.3")).paths).toEqual([]);
});

test("a path names its file, a suffix of it, or a directory above it; common file names only at the root", () => {
  expect(names("src/db.ts", "src/db.ts")).toBe(true);
  expect(names("test/day.test.js", "pkg/test/day.test.js")).toBe(true);
  expect(names("packages/session-protocol", "packages/session-protocol/src/protocol.ts")).toBe(true);
  expect(names("packages/session-protocol/", "packages/session-protocol/src/protocol.ts")).toBe(true);
  expect(names("day.test.js", "pkg/test/day.test.js")).toBe(true);
  expect(names("package.json", "package.json")).toBe(true);
  expect(names("package.json", "packages/web/package.json")).toBe(false);
  expect(names("src/db.ts", "src/db.tsx")).toBe(false);
  expect(names("protocol", "packages/session-protocol/src/protocol.ts")).toBe(false);
});

test("a failure matches the note's command, its error name or the file it names; the command's name alone doesn't", () => {
  const tz = anchorsOf(note("test/day.test.js needs `TZ=UTC node --test` or it fails near midnight"));
  expect(score(tz, "failure", { command: "node --test test/day.test.js", output: "not ok 1" })).toBeGreaterThan(0);
  const busy = anchorsOf(note("SQLITE_BUSY in the store tests means another runtime holds the file; stop it first"));
  expect(score(busy, "failure", { command: "pnpm test", output: "Error: SQLITE_BUSY: database is locked" })).toBeGreaterThan(0);
  const schema = anchorsOf(note("run `pnpm schema` after editing the protocol"));
  expect(score(schema, "failure", { command: "pnpm schema --check", output: "drift" })).toBeGreaterThan(0);
  const vague = anchorsOf(note("pnpm test is slow on this machine"));
  expect(score(vague, "failure", { command: "pnpm test --filter web", output: "1 failed" })).toBe(0);
});

test("a message matches a note it names by path, by code, or by its whole title", () => {
  const a = anchorsOf(note("the staging Redis is shared: never `FLUSHALL` it", { meta: { name: "Shared staging Redis" } }));
  expect(score(a, "prompt", { prompt: "can you clear the shared staging redis cache?" })).toBeGreaterThan(0);
  expect(score(a, "prompt", { prompt: "run FLUSHALL on redis" })).toBe(0);
  expect(score(a, "prompt", { prompt: "what does redis do here" })).toBe(0);
  const file = anchorsOf(note("src/billing/invoice.ts rounds half-even on purpose"));
  expect(score(file, "prompt", { prompt: "fix the rounding in src/billing/invoice.ts" })).toBeGreaterThan(0);
});

test("a shell command's reads: cat, head, sed and grep file arguments, never their scripts or patterns", () => {
  const cwd = "/repo";
  expect(readsOf("cat src/a.ts", cwd)).toEqual(abs("/repo/src/a.ts"));
  expect(readsOf("sed -n 1,80p src/b.ts && head -n 20 README.md", cwd)).toEqual(abs("/repo/src/b.ts", "/repo/README.md"));
  expect(readsOf("grep -n 'export' src/c.ts | wc -l", cwd)).toEqual(abs("/repo/src/c.ts"));
  // A search over a directory reads no one file.
  expect(readsOf("rg -A 3 pattern src", cwd)).toEqual([]);
  expect(readsOf("rg -A 3 pattern src/e.ts", cwd)).toEqual(abs("/repo/src/e.ts"));
  expect(readsOf("pnpm test src/d.ts", cwd)).toEqual([]);
  expect(readsOf("LANG=C cat /etc/hosts", cwd)).toEqual(abs("/etc/hosts"));
});

test("git, jq, xxd and folder listings read files too: the file at a revision, after --, or by name; never a revision or range", () => {
  const cwd = "/repo";
  expect(readsOf("git show HEAD:src/a.ts", cwd)).toEqual(abs("/repo/src/a.ts"));
  expect(readsOf("git show :src/a.ts | head -40", cwd)).toEqual(abs("/repo/src/a.ts"));
  expect(readsOf("git diff HEAD~1 -- src/b.ts db", cwd)).toEqual(abs("/repo/src/b.ts", "/repo/db"));
  expect(readsOf("git log -p -n 5 src/c.ts", cwd)).toEqual(abs("/repo/src/c.ts"));
  expect(readsOf("git --no-pager blame -L 10,20 src/d.ts", cwd)).toEqual(abs("/repo/src/d.ts"));
  expect(readsOf("git -C packages/web diff src/e.tsx", cwd)).toEqual(abs("/repo/packages/web/src/e.tsx"));
  expect(readsOf("git -c core.pager=cat show abc1234", cwd)).toEqual([]);
  expect(readsOf("git diff main..topic && git log v1.2.3", cwd)).toEqual([]);
  // Not a read: committing, checking out, pushing.
  expect(readsOf("git add src/a.ts && git commit -m 'fix src/a.ts' && git checkout src/b.ts", cwd)).toEqual([]);
  expect(readsOf("jq -r '.scripts' package.json", cwd)).toEqual(abs("/repo/package.json"));
  expect(readsOf("jq '.a/.b' data/x.json", cwd)).toEqual(abs("/repo/data/x.json"));
  expect(readsOf("xxd assets/logo.png | head", cwd)).toEqual(abs("/repo/assets/logo.png"));
  expect(readsOf("ls -la packages/session-protocol/", cwd)).toEqual(abs("/repo/packages/session-protocol"));
  expect(readsOf("find packages/runtime/src -name '*.ts' -newer x.ts", cwd)).toEqual(abs("/repo/packages/runtime/src"));
});

test("a Codex command's reads: its own parsed reads and listings, and what it left unknown read by memory's rules", () => {
  expect(
    codexReads(
      [
        { type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" },
        { type: "read", command: "cat /etc/hosts", name: "hosts", path: "/etc/hosts" },
        { type: "listFiles", command: "ls packages/web", path: "packages/web" },
        { type: "search", command: "rg foo src", query: "foo", path: "src" },
        { type: "search", command: "rg foo", query: "foo", path: null },
        { type: "unknown", command: "git show HEAD:src/b.ts" },
        { type: "unknown", command: "pnpm test" },
      ],
      "/repo",
    ),
  ).toEqual(abs("/repo/src/a.ts", "/etc/hosts", "/repo/packages/web", "/repo/src/b.ts"));
});

test("a folder listing pushes the note anchored on that folder", () => {
  const folder = anchorsOf(note("everything under packages/session-protocol/ is generated: run `pnpm schema`"));
  const listed = readsOf("ls packages/session-protocol/", "/repo").map((f) => repoRelative("/repo", f));
  expect(listed).toEqual(["packages/session-protocol"]);
  expect(score(folder, "file", { file: listed[0]! })).toBe(2);
});

test("files outside the worktree, or in the memory copy, have no repository name", () => {
  expect(repoRelative("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  expect(repoRelative("/repo", "src/a.ts")).toBe("src/a.ts");
  expect(repoRelative("/repo", "/elsewhere/a.ts")).toBeUndefined();
  expect(repoRelative("/repo", "/copies/t1/memory/repo/a.md", ["/copies/t1/memory"])).toBeUndefined();
});

test("the index leaves out tainted notes, other repositories', the session's own and those its brief carries", () => {
  const rows = [
    note("about src/a.ts"),
    note("tainted about src/a.ts", { tainted: 1 }),
    note("other repo src/a.ts", { path: "repos/github.com/acme/other/x.md" }),
    note("own src/a.ts", { by: "session:now" }),
    note("briefed src/a.ts", { path: "repos/github.com/acme/app/briefed.md", authority: "told" }),
    note("everywhere src/a.ts", { path: "user/everywhere.md" }),
    note("forgotten", { text: "" }),
  ];
  let revision = "1";
  const brief = { index: "- [Briefed](repo/briefed.md) — briefed (2026-10-12)\n", notes: [`me:${rows[4]!.id}`] };
  const index = new PushIndex({ repoId: "github.com/acme/app", session: "session:now", brief }, () => ({ revision, rows }));
  expect(index.candidates().map((c) => c.row.text)).toEqual(["about src/a.ts", "everywhere src/a.ts"]);
  expect(index.match("file", { file: "src/a.ts" }).filter((s) => s.score > 0)).toHaveLength(2);
  rows.push(note("new about src/a.ts"));
  expect(index.candidates()).toHaveLength(2);
  revision = "2";
  expect(index.candidates()).toHaveLength(3);
});

// A note file with several bullets is one note per bullet at one store path; render names the second and later ones -2.md, -3.md.
const stores = fs.mkdtempSync(path.join(os.tmpdir(), "memory-push-"));
afterAll(() => fs.rmSync(stores, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());
const repoId = "github.com/acme/app";
const chat = (): RenderContext =>
  ({ session: `session:${newId()}`, kind: "live", repoId, knownRepos: [repoId], teamStores: [], userMessages: [], brokerSecrets: [], instructionFiles: "" }) as RenderContext;
const person: WriterContext = { kind: "user", session: "user", knownRepos: [repoId], teamStores: [], userMessages: [], brokerSecrets: [] };
const testing = '---\nname: "testing"\ndescription: "how tests run here"\nmetadata:\n  type: project\n---\n\n';
/** A chat's push index as MemoryService builds it: from the brief frozen when the chat started. */
const pushIndexOf = (store: MemoryStore, session: string) =>
  new PushIndex({ repoId, session, brief: store.sessionBrief(session) }, () => ({ revision: store.revision(), rows: store.current({ teamStores: [] }) }));

test("an agent's notes filed beside one the brief carries still reach later chats by push", () => {
  const store = new MemoryStore(path.join(stores, `${newId()}.db`), randomBytes(32));
  const a = chat();
  runCopyTool(store, startSession(store, a, path.join(stores, newId())), {
    tool: "Write",
    file: "repo/testing.md",
    content: `${testing}- run \`pnpm test:db\` before touching src/db.ts\n- src/cache.ts needs \`REDIS_URL\` set in tests\n- src/queue.ts tests need \`--runInBand\`\n`,
  });
  const drafts = store.current({ teamStores: [] }).filter((r) => r.path === `repos/${repoId}/testing.md`);
  expect(drafts.map((r) => r.authority)).toEqual(["draft", "draft", "draft"]);
  // The person edits one in the Memory panel: it is told now, in the next chat's brief.
  const edited = drafts.find((r) => r.text.includes("src/cache.ts"))!;
  const told = store.commit(person, [{ id: edited.id, baseVid: edited.vid, text: "src/cache.ts tests need `REDIS_URL=redis://localhost:6379`" }]).saved[0]!;
  expect(told.authority).toBe("told");

  const b = chat();
  startSession(store, b, path.join(stores, newId()));
  expect(store.sessionBrief(b.session)!.index).toContain("](repo/testing.md)");
  const others = drafts.filter((r) => r.id !== told.id).map((r) => r.id);
  const pushes = pushIndexOf(store, b.session);
  expect(pushes.candidates().map((c) => c.row.id)).toEqual(expect.arrayContaining(others));
  expect(pushes.candidates().map((c) => c.row.id)).not.toContain(told.id);
  expect(pushes.match("file", { file: "src/db.ts" }).filter((s) => s.score > 0).map((s) => s.row.text)).toEqual(["run `pnpm test:db` before touching src/db.ts"]);
  // A fork reuses its parent's brief, and so leaves out the same notes.
  const fork = chat();
  sessionBrief(store, fork, b.session);
  expect(pushIndexOf(store, fork.session).candidates().map((c) => c.row.id).sort()).toEqual([...others].sort());
});

test("a note the brief carries under a -2.md name is not pushed again", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  const store = new MemoryStore(path.join(stores, `${newId()}.db`), randomBytes(32));
  runCopyTool(store, startSession(store, chat(), path.join(stores, newId())), {
    tool: "Write",
    file: "repo/testing.md",
    content: `${testing}- src/cache.ts needs \`REDIS_URL\` set in tests\n- src/queue.ts tests need \`--runInBand\`\n`,
  });
  const first = store.current({ teamStores: [] }).find((r) => r.text.includes("src/cache.ts"))!;
  const told = store.commit(person, [{ id: first.id, baseVid: first.vid, text: "src/cache.ts tests need `REDIS_URL=redis://localhost:6379`" }]).saved[0]!;
  expect(told.authority).toBe("told");
  // The next day an agent adds a bullet to the told note's file: a newer note at its store path, which render names first.
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
  const copy = startSession(store, chat(), path.join(stores, newId()));
  expect(copy.base.get("repo/testing.md")!.notes.map((r) => r.id)).toEqual([told.id]);
  runCopyTool(store, copy, { tool: "Write", file: "repo/testing.md", content: `${copy.files["repo/testing.md"]}\n- src/worker.ts tests need \`--pool=forks\`\n` });

  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  const b = chat();
  startSession(store, b, path.join(stores, newId()));
  const index = store.sessionBrief(b.session)!.index;
  expect(index).toContain("](repo/testing-2.md)");
  expect(index).not.toContain("](repo/testing.md)");
  const pushes = pushIndexOf(store, b.session);
  expect(pushes.candidates().map((c) => c.row.id)).not.toContain(told.id);
  expect(pushes.match("file", { file: "src/cache.ts" }).filter((s) => s.score > 0)).toEqual([]);
});

test("a brief an older runtime froze, without its notes, still keeps them out of pushes by the paths its index names", () => {
  const file = path.join(stores, `${newId()}.db`);
  const key = randomBytes(32);
  let store = new MemoryStore(file, key);
  const told = store.commit({ ...person, repoId }, [{ path: "repo/deploy.md", text: "deploys go out by `make release`, never src/deploy.ts by hand" }]).saved[0]!;
  const old = chat();
  const index = render(store, old).files["MEMORY.md"]!;
  expect(index).toContain("](repo/deploy.md)");
  store.close();
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE session_brief; CREATE TABLE session_brief (session TEXT PRIMARY KEY, text TEXT NOT NULL, idx TEXT NOT NULL, at TEXT NOT NULL)");
  db.prepare("INSERT INTO session_brief VALUES (?,?,?,?)").run(old.session, "its brief", index, "2026-11-01T00:00:00Z");
  db.close();

  store = new MemoryStore(file, key);
  expect(store.sessionBrief(old.session)).toEqual({ text: "its brief", index });
  expect(pushIndexOf(store, old.session).candidates()).toEqual([]);
  const now = chat();
  startSession(store, now, path.join(stores, newId()));
  expect(store.sessionBrief(now.session)!.notes).toEqual([`me:${told.id}`]);
  store.close();
});

test("the ledger sends a note once per context, at most PUSH_MAX at a time and PUSH_SESSION_MAX a session", () => {
  const ledger = new PushLedger();
  const many = Array.from({ length: 5 }, (_, i) => ({ row: note(`n${i}`), score: 2 }));
  expect(ledger.take("session", many)).toHaveLength(PUSH_MAX);
  expect(ledger.take("session", many)).toHaveLength(2);
  expect(ledger.take("session", many)).toHaveLength(0);
  // A subagent has its own context: it hasn't seen them.
  expect(ledger.take("agent-1", many)).toHaveLength(PUSH_MAX);
  expect(ledger.shown).toHaveLength(5);
  const rest = Array.from({ length: 40 }, (_, i) => ({ row: note(`m${i}`), score: 2 }));
  let total = 8;
  for (let i = 0; i < 20; i++) total += ledger.take("session", rest).length;
  expect(total).toBe(PUSH_SESSION_MAX);
});

test("a push says what it is about and which notes nobody confirmed", () => {
  expect(renderPush("file", [note("run `pnpm schema` after editing src/schema.ts", { authority: "draft" }), note("terse answers", { authority: "told", added: "2026-10-03" })])).toBe(
    "memory · notes about this file:\n- run `pnpm schema` after editing src/schema.ts (2026-10-12, unconfirmed: check it)\n- terse answers (2026-10-03)",
  );
});

test("a file note whose file was committed to after the note was written says so", () => {
  expect(renderPush("file", [{ ...note("run `pnpm schema` after editing src/schema.ts", { authority: "told" }), changed: "src/schema.ts" }])).toBe(
    "memory · notes about this file:\n- run `pnpm schema` after editing src/schema.ts (2026-10-12, src/schema.ts changed since)",
  );
  expect(changedSince("2026-10-12T00:00:00Z", "2026-10-13T09:00:00+02:00")).toBe(true);
  expect(changedSince("2026-10-12T00:00:00Z", "2026-10-11T09:00:00+02:00")).toBe(false);
  // Never committed (a new file), or git had nothing to say: not marked.
  expect(changedSince("2026-10-12T00:00:00Z", undefined)).toBe(false);
  expect(changedSince("not a time", "2026-10-13T09:00:00Z")).toBe(false);
});

test("after compaction: the files changed in the checkout, at most 40 named", () => {
  expect(renderChangedFiles([], "main")).toBeUndefined();
  expect(renderChangedFiles(["src/a.ts", "notes.txt"], "main")).toBe("files changed in this checkout (git, against main):\n- src/a.ts\n- notes.txt");
  const many = Array.from({ length: COMPACT_FILES_MAX + 3 }, (_, i) => `f${i}.ts`);
  expect(renderChangedFiles(many, undefined)!.split("\n").at(-1)).toBe("- and 3 more");
  expect(renderChangedFiles(many, undefined)!.startsWith("files changed in this checkout (git, against HEAD):")).toBe(true);
});

test("after compaction: the notes the session saved, then the ones it was shown, newest first, alive and untainted", () => {
  const saved = [note("saved one"), note("saved two"), note("saved gone", { text: "" })];
  const shown = [note("shown one"), saved[0]!, note("shown tainted", { tainted: 1 })];
  expect(compactNotes(saved, shown).map((r) => r.text)).toEqual(["saved two", "saved one", "shown one"]);
});

test("an ask to keep something: the sentence that says remember, from now on, going forward or don't forget, never a question", () => {
  expect(keepAsk("Remember: in this repo, always run `make check` before committing.\n\nNow run `cat build.log`.")).toBe("Remember: in this repo, always run `make check` before committing.");
  expect(keepAsk("The build is slow. From now on, use pnpm.")).toBe("From now on, use pnpm.");
  expect(keepAsk("going forward we deploy on Fridays")).toBe("going forward we deploy on Fridays");
  expect(keepAsk("Don't forget the staging DB is read-only.")).toBe("Don't forget the staging DB is read-only.");
  // Asking about the past, or recalling how something went, is not an ask to keep.
  expect(keepAsk("Do you remember why the deploy failed?")).toBeUndefined();
  expect(keepAsk("Remember when we moved to pnpm? Run the tests.")).toBeUndefined();
  expect(keepAsk("I remember how this broke last week, so check the lockfile.")).toBeUndefined();
  // A reminder for this task is no ask to keep, unless it says it holds every time.
  expect(keepAsk("remember to bench the Codex arm")).toBeUndefined();
  expect(keepAsk("Don't forget to push when you're done.")).toBeUndefined();
  expect(keepAsk("Remember to always run `make check` before committing.")).toBe("Remember to always run `make check` before committing.");
  expect(keepAsk("Don't forget to bump the version every time you release.")).toBe("Don't forget to bump the version every time you release.");
  // "always" and "never" alone describe bugs; they stay MemoryStore's statement words, not an ask.
  expect(keepAsk("The day test always fails at midnight.")).toBeUndefined();
  expect(keepAsk("It never finishes.")).toBeUndefined();
});
