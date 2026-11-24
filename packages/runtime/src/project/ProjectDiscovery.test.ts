import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import * as ProjectDiscovery from "./ProjectDiscovery.ts";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-home-")));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-outside-")));
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, encoding: "utf8" });
const repo = (dir: string, origin?: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  if (origin) git(dir, "remote", "add", "origin", origin);
  return dir;
};
const write = (file: string, text: string, ms: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, ms / 1000, ms / 1000);
};
const line = (record: object) => `${JSON.stringify(record)}\n`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).split("-");

test("links a remote to its repository on its host; clone URLs, names and errors carry no credentials", () => {
  const link = (host: string, fullName: string) => ({ host, full_name: fullName, web_url: `https://${host}/${fullName}`, clone_url: `https://${host}/${fullName}.git` });
  expect(ProjectDiscovery.repositoryLinkOf("git@github.com:acme/widget.git")).toEqual(link("github.com", "acme/widget"));
  expect(ProjectDiscovery.repositoryLinkOf("https://user:secret@GitHub.com/acme/widget.git/")).toEqual(link("github.com", "acme/widget"));
  expect(ProjectDiscovery.repositoryLinkOf("http://www.github.com/acme/widget")).toEqual(link("github.com", "acme/widget"));
  expect(ProjectDiscovery.repositoryLinkOf("ssh://git@git.example.com:2222/team/sub/tool.git")).toEqual(link("git.example.com", "team/sub/tool"));
  expect(ProjectDiscovery.repositoryLinkOf("https://github.com/acme/widget/tree/main/src")).toEqual(link("github.com", "acme/widget"));
  for (const local of ["file:///srv/widget.git", "/srv/widget", "../widget", "https://github.com/acme", "git@host:../../etc"]) {
    expect(ProjectDiscovery.repositoryLinkOf(local)).toBeUndefined();
  }

  expect(ProjectDiscovery.cloneUrlOf("acme/widget")).toBe("https://github.com/acme/widget.git");
  expect(ProjectDiscovery.cloneUrlOf("acme/widget", true)).toBe("git@github.com:acme/widget.git");
  for (const web of ["https://github.com/acme/widget/pull/7", "http://github.com/acme/widget", "https://www.github.com/acme/widget"]) {
    expect(ProjectDiscovery.cloneUrlOf(web)).toBe("https://github.com/acme/widget.git");
  }
  expect(ProjectDiscovery.cloneUrlOf("git@github.com:acme/widget.git")).toBe("git@github.com:acme/widget.git");
  expect(ProjectDiscovery.cloneUrlOf("http://example.com/a/b.git")).toBe("http://example.com/a/b.git");

  expect(ProjectDiscovery.withoutCredentials("https://user:secret@example.com/a/b.git")).toBe("https://example.com/a/b.git");
  expect(ProjectDiscovery.withoutCredentials("https://ghp_token@github.com/a/b.git")).toBe("https://github.com/a/b.git");
  expect(ProjectDiscovery.withoutCredentials("ssh://git:secret@example.com/a/b.git")).toBe("ssh://git@example.com/a/b.git");
  expect(ProjectDiscovery.withoutCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");

  // A clone's folder is one plain segment: never .git (clone_dir's own git dir), hidden, an option or a path.
  expect(ProjectDiscovery.cloneNameOf("https://evil.example/x/.git.git")).toBe("git");
  expect(ProjectDiscovery.cloneNameOf("https://evil.example/x/..")).toBe("repo");
  expect(ProjectDiscovery.cloneNameOf("https://example.com/a/-rf")).toBe("rf");
  expect(ProjectDiscovery.cloneNameOf("git@github.com:acme/my widget!.git")).toBe("my-widget-");
  expect(ProjectDiscovery.cloneNameOf(`https://example.com/a/${"x".repeat(300)}`)).toHaveLength(100);

  // A typo'd owner/name over https looks like this too: GitHub asks for a sign-in either way.
  expect(ProjectDiscovery.cloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("repository not found, or private and git has no sign-in for it here");
  expect(ProjectDiscovery.cloneFailure("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b.git/'")).toBe("authentication failed");
  expect(ProjectDiscovery.cloneFailure("git@github.com: Permission denied (publickey).")).toBe("authentication failed");
  expect(ProjectDiscovery.cloneFailure("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toBe("repository not found");
  expect(ProjectDiscovery.cloneFailure("fatal: unable to access 'https://example.com/': Could not resolve host: example.com")).toBe("network error");
  expect(ProjectDiscovery.cloneFailure("fatal: something odd at https://user:secret@example.com/a")).toBe("fatal: something odd at https://example.com/a");
});

test("ranks session repositories, their siblings, code folders and GitHub; credits worktree sessions to their checkout", async () => {
  const stuff = path.join(home, "stuff");
  const widget = repo(path.join(stuff, "widget"), "git@github.com:acme/widget.git");
  fs.mkdirSync(path.join(widget, "src"));
  const sibling = repo(path.join(stuff, "sibling"));
  const gizmo = repo(path.join(home, "code", "acme", "gizmo"), "https://github.com/acme/gizmo.git");
  const gizmoTree = path.join(home, "trees", "gizmo-task");
  git(gizmo, "worktree", "add", "-q", "-b", "task", gizmoTree);
  git(widget, "worktree", "add", "-q", "-b", "wt", path.join(stuff, "widget-wt"));
  repo(path.join(stuff, "node_modules", "dep"));
  repo(path.join(stuff, ".hidden"));
  const downloaded = repo(path.join(home, "Downloads", "unpacked"));
  const state = repo(path.join(home, "state", "repos", "inner"));
  // Outside home: offered when it is a project, but its folder is never swept.
  const elsewhere = repo(path.join(outside, "elsewhere"), "https://github.com/acme/elsewhere.git");
  repo(path.join(outside, "elsewhere-sibling"));
  // After every commit, so the sessions are the latest activity; whole seconds, which mtimes keep exactly.
  const now = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  write(path.join(claude, "projects", "-widget-src", "s1.jsonl"), line({ type: "user", cwd: path.join(widget, "src") }), now);
  write(path.join(claude, "projects", "-gizmo-task", "s2.jsonl"), line({ type: "user", cwd: gizmoTree }), now - 2000);
  write(path.join(claude, "projects", "-unpacked", "s3.jsonl"), line({ type: "user", cwd: downloaded }), now);
  write(path.join(codex, "sessions", ...day(now), "rollout-1.jsonl"), line({ type: "session_meta", payload: { cwd: widget } }), now - 1000);

  const found = await Effect.runPromise(
    ProjectDiscovery.discover({
      home,
      excluded: [path.join(home, "state")],
      now: () => now,
      sessionHomes: Effect.succeed({ claude: [claude], codex: [codex] }),
      gitHub: Effect.succeed([
        { full_name: "acme/widget", private: true, pushed_at: new Date(now - 86_400_000).toISOString() },
        { full_name: "acme/remote-only", private: false, pushed_at: new Date(now - 30 * 86_400_000).toISOString() },
        { full_name: "acme/old", archived: true, pushed_at: new Date(now).toISOString() },
      ]),
      known: Effect.succeed([state, elsewhere]),
    }),
  );
  expect(found.clone_dir).toBe(stuff);
  expect(found.candidates.map((c) => c.path ?? c.name)).toEqual([widget, gizmo, elsewhere, sibling, "remote-only"]);
  expect(found.candidates[0]).toMatchObject({ name: "widget", sources: ["claude", "codex", "folder", "github"], sessions: 2, private: true, last_active_at: new Date(now).toISOString() });
  expect(found.candidates[1]).toMatchObject({ sources: ["claude", "folder"], sessions: 1, repository: { full_name: "acme/gizmo" } });
  expect(found.candidates[3]!.repository).toBeUndefined();
  expect(found.candidates[4]).toMatchObject({ sources: ["github"], private: false, repository: { clone_url: "https://github.com/acme/remote-only.git" } });
  expect(found.candidates[4]!.path).toBeUndefined();
  // widget's ssh origin against gizmo's and elsewhere's https: GitHub clones stay on https.
  expect(found.github_ssh).toBe(false);
});

test("reads session folders from transcript heads, recent ones only, each home once", async () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const claude = path.join(home, "sessions-test", ".claude");
  const codex = path.join(home, "sessions-test", ".codex");
  // The newest transcript names no cwd in its first 64 KiB (a long queued prompt), so the next newest does.
  write(path.join(claude, "projects", "-a", "new.jsonl"), line({ type: "queue-operation", content: "x".repeat(70_000) }) + line({ cwd: "/wrong" }), now);
  write(path.join(claude, "projects", "-a", "old.jsonl"), line({ type: "user", cwd: "/work/a" }), now - 5000);
  write(path.join(claude, "projects", "-a", "ancient.jsonl"), line({ type: "user", cwd: "/work/a" }), now - 400 * 86_400_000);
  // Past the first 8 KiB, within 64 KiB.
  write(path.join(claude, "projects", "-work-b--quoted-", "only.jsonl"), line({ type: "summary", text: "y".repeat(20_000) }) + line({ cwd: '/work/b "quoted"' }), now - 9000);
  write(path.join(claude, "projects", "-stale", "s.jsonl"), line({ cwd: "/work/stale" }), now - 400 * 86_400_000);
  fs.mkdirSync(path.join(claude, "projects", "-empty"));
  write(path.join(codex, "sessions", "2026", "10", "14", "rollout-1.jsonl"), line({ type: "session_meta", payload: { id: "1", cwd: "/work/a" } }), now - 1000);
  write(path.join(codex, "sessions", "2026", "10", "15", "rollout-2.jsonl"), line({ type: "session_meta", payload: { id: "2", cwd: "/work/a" } }), now - 2000);
  write(path.join(codex, "sessions", "2025", "01", "01", "rollout-old.jsonl"), line({ type: "session_meta", payload: { id: "3", cwd: "/work/old" } }), now);

  const folders = await ProjectDiscovery.readSessions({ claude: [claude, `${claude}/`], codex: [codex, path.join(codex, "..", ".codex")] }, now);
  expect(folders.toSorted((x, y) => (x.source + x.cwd).localeCompare(y.source + y.cwd))).toEqual([
    { cwd: "/work/a", source: "claude", sessions: 2, lastMs: now },
    { cwd: '/work/b "quoted"', source: "claude", sessions: 1, lastMs: now - 9000 },
    { cwd: "/work/a", source: "codex", sessions: 2, lastMs: now - 1000 },
  ]);

  // The user's own homes always; env first, then any an instance in Settings points at.
  // Absolute on the host: Windows puts the current drive in front of a rooted path.
  const at = (dir: string) => path.resolve(dir);
  expect(ProjectDiscovery.sessionHomes("/h", {})).toEqual({ claude: [at("/h/.claude")], codex: [at("/h/.codex")] });
  expect(
    ProjectDiscovery.sessionHomes("/h", { CODEX_HOME: "/c" }, {
      work: { driver: "codex", config: { homePath: "~/work-codex" } },
      other: { driver: "claudeAgent", environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/cc", sensitive: false }] },
    } as never),
  ).toEqual({ claude: [at("/h/.claude"), at("/cc")], codex: [at("/c"), at("/h/work-codex")] });
});

test("a scan that runs out of time says it is incomplete, so a stale empty answer is never kept as the last word", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-starved-")));
  try {
    fs.mkdirSync(path.join(home, "code", "app", ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, "code", "app", ".git", "HEAD"), "ref: refs/heads/main\n");
    const run = (scanMs?: number) =>
      Effect.runPromise(
        ProjectDiscovery.discover({ home, excluded: [], sessionHomes: Effect.succeed({ claude: [], codex: [] }), gitHub: Effect.succeed([]), known: Effect.succeed([]), ...(scanMs === undefined ? {} : { scanMs }) }),
      );
    const starved = await run(0);
    expect(starved.complete).toBe(false);
    expect(starved.candidates).toEqual([]);
    const full = await run();
    expect(full.complete).toBe(true);
    expect(full.candidates.map((c) => c.path)).toEqual([path.join(home, "code", "app")]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a failing source leaves the rest; clone_dir falls back to a usual code folder", async () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-empty-")));
  try {
    fs.mkdirSync(path.join(empty, "src"));
    const found = await Effect.runPromise(
      ProjectDiscovery.discover({ home: empty, excluded: [], sessionHomes: Effect.fail("boom"), gitHub: Effect.die("boom"), known: Effect.succeed([]) }),
    );
    expect(found).toEqual({ candidates: [], clone_dir: path.join(empty, "src"), github_ssh: false, complete: true });
    // GitHub answering with anything but a list of repositories is none.
    const answer = (status: number, body: string) =>
      ProjectDiscovery.gitHubRepositories({ rest: () => Effect.succeed({ status, body, headers: {}, truncated: false, invalidUtf8: false }) } as never);
    expect(await Effect.runPromise(answer(200, '{"message":"Bad credentials"}'))).toEqual([]);
    expect(await Effect.runPromise(answer(200, "not json"))).toEqual([]);
    expect(await Effect.runPromise(answer(200, '[{"full_name":"acme/a"},{"name":"b"}]'))).toEqual([{ full_name: "acme/a" }]);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// A pending macOS privacy prompt or a FIFO blocks open() forever; a scan must not lose libuv threads to one.
test.skipIf(process.platform === "win32")("a git file that blocks its read is abandoned, then skipped for a while", async () => {
  const dir = fs.mkdtempSync(path.join(outside, "blocked-"));
  const fifo = path.join(dir, "config");
  execFileSync("mkfifo", [fifo]);
  const plain = path.join(dir, "HEAD");
  fs.writeFileSync(plain, "ref: refs/heads/main\n");

  const first = Date.now();
  await expect(ProjectDiscovery.readGitFileKillable(fifo)).rejects.toThrow();
  expect(Date.now() - first).toBeGreaterThanOrEqual(1900);
  const second = Date.now();
  await expect(ProjectDiscovery.readGitFileKillable(fifo)).rejects.toThrow(/blocked a read/);
  expect(Date.now() - second).toBeLessThan(500);
  expect(await ProjectDiscovery.readGitFileKillable(plain)).toBe("ref: refs/heads/main\n");
  // The runtime's own file reads still run.
  expect(await fs.promises.readFile(plain, "utf8")).toBe("ref: refs/heads/main\n");
});

test.skipIf(process.platform === "win32")("a session's checkout with a FIFO for .git or its config never stalls discovery", async () => {
  const scanHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-fifo-home-")));
  try {
    const pointerFifo = path.join(scanHome, "work", "fifo-pointer");
    fs.mkdirSync(pointerFifo, { recursive: true });
    execFileSync("mkfifo", [path.join(pointerFifo, ".git")]);
    const configFifo = repo(path.join(scanHome, "work", "fifo-config"), "https://github.com/acme/fifo-config.git");
    fs.rmSync(path.join(configFifo, ".git", "config"));
    execFileSync("mkfifo", [path.join(configFifo, ".git", "config")]);
    const now = Math.ceil(Date.now() / 1000) * 1000 + 1000;
    const claude = path.join(scanHome, ".claude");
    write(path.join(claude, "projects", "-pointer", "p.jsonl"), line({ type: "user", cwd: pointerFifo }), now);
    write(path.join(claude, "projects", "-config", "c.jsonl"), line({ type: "user", cwd: configFifo }), now);

    const started = Date.now();
    const found = await Effect.runPromise(
      ProjectDiscovery.discover({
        home: scanHome,
        excluded: [],
        now: () => now,
        sessionHomes: Effect.succeed({ claude: [claude], codex: [] }),
        gitHub: Effect.succeed([]),
        known: Effect.succeed([]),
      }),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(found.candidates.map((c) => c.path)).not.toContain(pointerFifo);
    const offered = found.candidates.find((c) => c.path === configFifo);
    expect(offered?.repository).toBeUndefined();
  } finally {
    fs.rmSync(scanHome, { recursive: true, force: true });
  }
});

test("the scan at start leaves the folders macOS asks about alone, on a Mac; a full scan reads them", async () => {
  const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-guarded-")));
  try {
    const inCode = repo(path.join(own, "code", "plain"));
    const inDocuments = repo(path.join(own, "Documents", "GitHub", "papers"));
    const onDesktop = repo(path.join(own, "Desktop", "code", "sketch"));
    const known = repo(path.join(own, "Documents", "client-work"));
    const now = Math.ceil(Date.now() / 1000) * 1000 + 1000;
    const claude = path.join(own, ".claude");
    write(path.join(claude, "projects", "-desktop", "s1.jsonl"), line({ type: "user", cwd: onDesktop }), now);
    const scan = (protectedFolders: boolean, platform: NodeJS.Platform = "darwin") =>
      Effect.runPromise(
        ProjectDiscovery.discover({
          home: own,
          excluded: [],
          now: () => now,
          platform,
          protectedFolders: () => protectedFolders,
          sessionHomes: Effect.succeed({ claude: [claude], codex: [] }),
          gitHub: Effect.succeed([]),
          known: Effect.succeed([known]),
        }),
      ).then((found) => found.candidates.map((c) => c.path).sort());
    // Documents and Desktop are not touched: not the code folders there, a session that ran there, nor a project.
    expect(await scan(false)).toEqual([inCode]);
    expect(await scan(true)).toEqual([inCode, known, inDocuments, onDesktop].sort());
    // Off macOS nothing asks, so the quiet scan reads everything.
    expect(await scan(false, "linux")).toEqual([inCode, known, inDocuments, onDesktop].sort());
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});
