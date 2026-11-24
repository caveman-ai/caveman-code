// Real Session Protocol RPCs against a runtime, its git worktrees and project preferences.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type Params } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";

const root = tempRoot("sp-fs-search-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client?.close();
  await runtime?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const workspace = (request_id: string, files: Record<string, string>) =>
  createReady(client, { request_id, repo: { path: makeRepo(root, files) }, engine: "claude-agent", options: { model: MODEL } });
const search = (workspace_id: string, params: Omit<Params<"fs.search">, "workspace_id">) =>
  client.call("fs.search", { workspace_id, ...params });
const write = (tree: string, relative: string) => {
  fs.mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
  fs.writeFileSync(path.join(tree, relative), "test\n");
};

test("directory opt-in includes tracked, untracked and empty directories without changing file-only search", async () => {
  const w = await workspace("search-directories", {
    "src/nested/parser.ts": "export {};\n",
    ".gitignore": "vendor/\nempty-ignored/\nbuild/*\n!build/keep/\n",
    ".cavemanignore": "private/\n.private/\n",
    "private/secret.txt": "secret\n",
    ".private/secret.txt": "secret\n",
    ".visible/config.json": "{}\n",
  });
  const tree = w.root_path!;
  write(tree, "drafts/deep/note.txt");
  write(tree, "vendor/kept/tracked.txt");
  git(tree, "add", "-f", "vendor/kept/tracked.txt");
  // A large ignored subtree must not be traversed just to discover empty directories.
  for (let i = 0; i < 1001; i++) fs.mkdirSync(path.join(tree, "vendor", "ignored", `pkg${i}`, "empty"), { recursive: true });
  for (const dir of ["empty", "drafts/empty", "empty-parent/child", "empty-ignored", "build/gone/empty", "build/keep/empty"]) {
    fs.mkdirSync(path.join(tree, dir), { recursive: true });
  }
  // Symlinks (including a cycle and one pointing outside the checkout) are never walked.
  write(root, "outside/secret.txt");
  fs.symlinkSync(path.join(root, "outside"), path.join(tree, "external-link"), "dir");
  fs.symlinkSync("src", path.join(tree, "internal-link"), "dir");
  fs.symlinkSync(".", path.join(tree, "loop"), "dir");

  const expectedFiles = [".gitignore", ".cavemanignore", ".visible/config.json", "src/nested/parser.ts", "drafts/deep/note.txt", "vendor/kept/tracked.txt", "external-link", "internal-link", "loop"];
  const files = await search(w.id, { query: "", limit: 500 });
  expect(files.truncated).toBe(false);
  expect(files.paths.toSorted()).toEqual(expectedFiles.toSorted());
  expect(await search(w.id, { query: "", limit: 500, include_directories: false })).toEqual(files);

  const all = await search(w.id, { query: "", limit: 500, include_directories: true });
  const expectedDirectories = ["src/", "src/nested/", ".visible/", "drafts/", "drafts/deep/", "drafts/empty/", "empty/", "empty-parent/", "empty-parent/child/", "vendor/", "vendor/kept/", "build/", "build/keep/", "build/keep/empty/"];
  expect(all.truncated).toBe(false);
  expect(all.paths.toSorted()).toEqual([...expectedFiles, ...expectedDirectories].toSorted());
  expect(new Set(all.paths).size).toBe(all.paths.length);
  expect(all.paths.some((p) => p.startsWith(".git/"))).toBe(false);
  expect(await search(w.id, { query: "srnprs", include_directories: true })).toEqual({ paths: ["src/nested/parser.ts"], truncated: false });
});

test("project hidden paths and .cavemanignore changes apply to cached directories immediately", async () => {
  const w = await workspace("search-hidden", {
    "src/app.ts": "export {};\n",
    "private/notes.txt": "private\n",
    "fixtures/deep/data.txt": "data\n",
    ".cavemanignore": "private/\n",
  });
  fs.mkdirSync(path.join(w.root_path!, "empty"));
  const params = { query: "", limit: 500, include_directories: true } as const;
  const initial = await search(w.id, params);
  expect(initial.paths).toEqual(expect.arrayContaining(["src/", "fixtures/", "fixtures/deep/", "empty/"]));
  expect(initial.paths.some((p) => p.startsWith("private/"))).toBe(false);

  await client.call("project.update", { request_id: "search-hide", project_id: w.project_id!, ignorePaths: ["src/", "/fixtures/", "empty/"] });
  const hidden = await search(w.id, params);
  expect(hidden).toEqual({ paths: [".cavemanignore"], truncated: false });
  await client.call("project.update", { request_id: "search-unhide", project_id: w.project_id!, ignorePaths: [] });
  expect(await search(w.id, params)).toEqual(initial);

  fs.writeFileSync(path.join(w.root_path!, ".cavemanignore"), "fixtures/\n");
  const changed = await search(w.id, params);
  expect(changed.paths).toEqual(expect.arrayContaining(["private/", "private/notes.txt", "src/", "empty/"]));
  expect(changed.paths.some((p) => p.startsWith("fixtures/"))).toBe(false);
});

test("git path decoding and directory ignore checks preserve spaces, unicode and special characters", async () => {
  // Windows refuses : " tab and newline in a file name (no file there can hold them), so it tests the rest.
  const names = ["space dir", "[id]", ":literal", "quote\"dir", "tab\tdir", "line\nbreak", "café", "#hash"].filter((name) => process.platform !== "win32" || !/[:"\t\n]/.test(name));
  const w = await workspace("search-special", {
    ...Object.fromEntries(names.map((name) => [`tracked/${name}/file.txt`, "test\n"])),
    ".gitignore": "[[]ignored]/\nspace ignored/\n",
  });
  for (const name of names) {
    write(w.root_path!, `untracked/${name}/file.txt`);
    fs.mkdirSync(path.join(w.root_path!, "empty", name), { recursive: true });
  }
  for (const name of ["[ignored]", "space ignored"]) fs.mkdirSync(path.join(w.root_path!, name, "empty"), { recursive: true });
  const expected = [".gitignore", "tracked/", "untracked/", "empty/", ...names.flatMap((name) => [
    `tracked/${name}/`, `tracked/${name}/file.txt`, `untracked/${name}/`, `untracked/${name}/file.txt`, `empty/${name}/`,
  ])];
  const all = await search(w.id, { query: "", limit: 500, include_directories: true });
  expect(all).toMatchObject({ truncated: false });
  expect(all.paths.toSorted()).toEqual(expected.toSorted());
  const files = await search(w.id, { query: "", limit: 500 });
  expect(files.paths.toSorted()).toEqual(expected.filter((p) => !p.endsWith("/")).toSorted());
});

test("directories and files are fuzzy ranked together before applying the limit", async () => {
  const w = await workspace("search-ranking", {
    "match/child.txt": "test\n",
    "match.ts": "test\n",
    "deep/match/child.txt": "test\n",
    "other/match.txt": "test\n",
  });
  // Same basename match strength; shorter paths win. Matches in a parent rank below basename matches.
  const expected = ["match/", "match.ts", "deep/match/", "other/match.txt", "match/child.txt", "deep/match/child.txt"];
  expect(await search(w.id, { query: "match", limit: 100, include_directories: true })).toEqual({ paths: expected, truncated: false });
  for (const limit of [0, 1, 3, expected.length, expected.length + 1]) {
    expect(await search(w.id, { query: "match", limit, include_directories: true })).toEqual({ paths: expected.slice(0, limit), truncated: expected.length > limit });
  }
  expect(await search(w.id, { query: "match", limit: 1 })).toEqual({ paths: ["match.ts"], truncated: true });
  expect(await search(w.id, { query: "dpmch", limit: 1, include_directories: true })).toEqual({ paths: ["deep/match/"], truncated: true });
  expect(await search(w.id, { query: "no-such-path", limit: 0, include_directories: true })).toEqual({ paths: [], truncated: false });
});

test("nested ignore rules, repository excludes and wide directory batches survive a cache refresh", async () => {
  const w = await workspace("search-nested-ignores", {
    ".gitignore": "root-ignored/\n",
    "nested/.gitignore": "build/*\n!build/keep/\n[[]cache]/\n",
  });
  const tree = w.root_path!;
  const globalExcludes = path.join(root, "search-global-excludes");
  fs.writeFileSync(globalExcludes, "global-ignored/\n");
  git(tree, "config", "core.excludesFile", globalExcludes);
  fs.writeFileSync(path.resolve(tree, git(tree, "rev-parse", "--git-path", "info/exclude").trim()), "info-ignored/\n");
  const allowed = ["nested/build/keep/empty", "nested/[literal]/empty"];
  const ignored = ["root-ignored/empty", "global-ignored/empty", "info-ignored/empty", "nested/build/skip/empty", "nested/[cache]/empty"];
  for (const directory of [...allowed, ...ignored]) fs.mkdirSync(path.join(tree, directory), { recursive: true });
  // More than one check-ignore stdin batch at the same depth, without pre-limiting the candidates.
  for (let i = 0; i < 1005; i++) fs.mkdirSync(path.join(tree, "wide", `pkg${String(i).padStart(4, "0")}`), { recursive: true });
  expect(await search(w.id, { query: "empty", limit: 500, include_directories: true })).toEqual({
    paths: allowed.map((directory) => `${directory}/`).sort((a, b) => a.length - b.length || a.localeCompare(b)),
    truncated: false,
  });
  expect(await search(w.id, { query: "pkg1004", include_directories: true })).toEqual({ paths: ["wide/pkg1004/"], truncated: false });
  expect(await search(w.id, { query: "pkg", limit: 500, include_directories: true })).toMatchObject({ paths: expect.any(Array), truncated: true });

  // No mocked clock: new directories use the same five-second snapshot window as file search.
  fs.mkdirSync(path.join(tree, "after-cache"));
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  expect(await search(w.id, { query: "after-cache", include_directories: true })).toEqual({ paths: ["after-cache/"], truncated: false });
});

test("the default and maximum result limits count directories as well as files", async () => {
  const w = await workspace("search-limits", { "README.md": "test\n" });
  const expected = Array.from({ length: 520 }, (_, i) => `entry-${String(i).padStart(3, "0")}/`);
  for (const dir of expected) fs.mkdirSync(path.join(w.root_path!, dir));
  expect(await search(w.id, { query: "entry", include_directories: true })).toEqual({ paths: expected.slice(0, 50), truncated: true });
  expect(await search(w.id, { query: "entry", limit: 9999, include_directories: true })).toEqual({ paths: expected.slice(0, 500), truncated: true });
  expect(await search(w.id, { query: "entry", limit: 9999 })).toEqual({ paths: [], truncated: false });
});
