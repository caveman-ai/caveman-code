import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, test } from "vitest";

import { git, makeRepo, tempRoot } from "../session-protocol/testHarness.ts";
import { clearProject, type ProjectLine, projectEvidence } from "./prompt.ts";
import { makeRepoProfiles, profileOf, readmeSummary, repoFacts, sameRemote, termsOf } from "./repos.ts";

describe("profileOf", () => {
  test("a README's opening prose, languages by file count, modules with their areas, and path terms stemmed", () => {
    const profile = profileOf(
      [
        "packages/runtime/src/chief/Chief.ts",
        "packages/runtime/src/chief/Board.ts",
        "packages/runtime/src/chief/pullRequests.ts",
        "packages/runtime/src/voice/Call.ts",
        "apps/web/src/shell/Sidebar.tsx",
        "apps/web/src/routes/chief-cards.tsx",
        "docs/chief.md",
        "node_modules/x/index.js",
        ".github/workflows/ci.yml",
        "README.md",
      ],
      "# Caveman Code app\n\n[![ci](https://x/badge.svg)](https://x)\n\nPrivate. Desktop, web and the [runtime](docs/runtime.md) for Caveman Code.\n\n- more\n",
    );
    expect(profile.summary).toBe("Private. Desktop, web and the runtime for Caveman Code.");
    expect(profile.languages).toEqual(["TypeScript 75%", "Markdown 25%"]);
    expect(profile.areas).toEqual(["packages/runtime (chief, voice)", "apps/web (shell, routes)", "docs"]);
    // "chief" from folders and file names, each file once; where most of them live.
    expect(profile.terms.get("chief")).toEqual({ files: 5, at: ["packages/runtime/src/chief"] });
    expect(profile.terms.get("sidebar")).toEqual({ files: 1, at: ["apps/web/src/shell/Sidebar.tsx"] });
    expect(profile.terms.get("request")).toMatchObject({ files: 1 });
    // Built and dot folders are never read; README words count as a few files.
    expect(profile.terms.has("workflow")).toBe(false);
    expect(profile.terms.get("desktop")).toEqual({ files: 3, at: ["README"] });
    expect(profile.files).toBe(8);
  });
  test("terms drop filler and code-plumbing words, fold plurals, and read PR as pull request", () => {
    expect(termsOf("let chiefs merge PRs themselves")).toEqual(["chief", "merge", "pull", "request"]);
    expect(termsOf("pullRequests chief-cards.tsx replies")).toEqual(["pull", "request", "chief", "card", "reply"]);
  });
  test("a README summary skips headings, badges, HTML and code; one remote however it is cloned", () => {
    expect(readmeSummary("# T\n\n<p align=center><img src=x></p>\n\n```sh\nnpm i\n```\n\nA coding agent with a terminal interface.")).toBe("A coding agent with a terminal interface.");
    expect(readmeSummary("# Only a title\n")).toBeUndefined();
    expect(sameRemote("git@github.com:caveman-ai/caveman-code.git")).toBe("github.com/caveman-ai/caveman-code");
    expect(sameRemote("https://token@github.com/caveman-ai/caveman-code/")).toBe("github.com/caveman-ai/caveman-code");
    expect(sameRemote("ssh://git@host:2222/a/b.git")).toBe("host:2222/a/b");
  });
});

describe("which repository a note means, from real checkouts", () => {
  const root = tempRoot("chief-repos-");
  // Like caveman-code: the Chief's runtime, the board UI and the sidebar.
  const appFiles = {
    "README.md": "# Caveman Code app\n\nPrivate. Desktop, web and the runtime for Caveman Code.\n",
    "packages/runtime/src/chief/Chief.ts": "",
    "packages/runtime/src/chief/Board.ts": "",
    "packages/runtime/src/chief/tools.ts": "",
    "packages/runtime/src/chief/pullRequests.ts": "",
    "packages/runtime/src/chief/prompt.ts": "",
    "packages/runtime/src/orchestration/merge.ts": "",
    "apps/web/src/routes/Chief.tsx": "",
    "apps/web/src/routes/chief-cards.tsx": "",
    "apps/web/src/shell/Sidebar.tsx": "",
    "apps/desktop/src/main.ts": "",
  };
  const app = makeRepo(root, appFiles);
  git(app, "remote", "add", "origin", "git@github.com:caveman-ai/caveman-code.git");
  // A second clone of the same repository, somewhere else on disk.
  const clone = path.join(root, "Desktop-caveman-code");
  git(root, "clone", "-q", app, clone);
  git(clone, "remote", "set-url", "origin", "https://github.com/caveman-ai/caveman-code");
  // Like caveman-code: the engine, with its own merge bench but no Chief.
  const engine = makeRepo(root, {
    "README.md": "# Caveman Code\n\nCaveman Code is a coding agent with a terminal interface, persistent command sessions, and programmatic tools.\n",
    "packages/caveman-code/src/agent/loop.ts": "",
    "packages/caveman-code/src/tools/edit.ts": "",
    "packages/caveman-code/src/auth/login.ts": "",
    "packages/caveman-code-tui/src/render.ts": "",
    "conformance/bench/merge-feature-bench.mjs": "",
  });
  git(engine, "remote", "add", "origin", "git@github.com:caveman-ai/caveman-code.git");
  const site = makeRepo(root, { "README.md": "# Site\n\nThe marketing site.\n", "src/pages/index.astro": "", "src/components/Hero.astro": "" });
  const exists = (r: string, relative: string) => fs.existsSync(path.join(r, relative));
  const profiles = makeRepoProfiles();

  const lines = async (extra: Partial<Record<string, Partial<ProjectLine>>> = {}) => {
    const base: ReadonlyArray<ProjectLine> = [
      { id: "repo:clone", name: "caveman-code", path: clone, lastChatAt: "2026-11-08T10:00:00Z" },
      { id: "repo:app", name: "caveman-code", path: app, lastChatAt: "2026-11-09T09:00:00Z" },
      { id: "repo:engine", name: "caveman-code", path: engine, lastChatAt: "2026-11-09T08:00:00Z" },
      { id: "repo:site", name: "docs-site", path: site },
    ];
    return Promise.all(base.map(async (p) => ({ ...p, ...repoFacts(p.path), profile: (await profiles(p.path))!, ...extra[p.id] })));
  };

  test("'let chiefs merge PRs themselves' points at the repository with the Chief's code, in the clone touched last", async () => {
    const evidence = projectEvidence(await lines(), "let chiefs merge PRs themselves", exists);
    const clear = clearProject(evidence);
    // Clear: a note that names no Chief goes to this project's Chief.
    expect(clear?.id).toBe("repo:app");
    expect(clear?.strong).toBe(false);
    // Either clone is the same choice; never a guess between them.
    expect(clear?.clones).toEqual(["repo:clone"]);
    expect(evidence.filter((e) => e.id === "repo:clone")).toEqual([]);
    const engineMatch = evidence.find((e) => e.id === "repo:engine");
    expect(engineMatch === undefined || engineMatch.score * 2 <= clear!.score).toBe(true);
    expect(clear?.reasons.join(", ")).toMatch(/^its code has chief \(7 files, packages\/runtime\/src\/chief\)/);
    expect(clear?.reasons).toContain(`the clone touched most recently (same repository as repo:clone at ${clone})`);
  });

  test("a clone with no chats is older than one with any, whatever its checkout's time", async () => {
    const noChatIn = async (ids: ReadonlyArray<string>) =>
      (await lines({ "repo:clone": { touchedAt: "2026-11-09T11:00:00Z" }, "repo:app": { touchedAt: "2026-11-01T00:00:00Z" } })).map(({ lastChatAt, ...p }) =>
        ids.includes(p.id) || lastChatAt === undefined ? p : { ...p, lastChatAt },
      );
    expect(clearProject(projectEvidence(await noChatIn(["repo:clone"]), "let chiefs merge PRs themselves", exists))?.id).toBe("repo:app");
    // With no chats in either, the checkout changed last wins.
    expect(clearProject(projectEvidence(await noChatIn(["repo:clone", "repo:app"]), "let chiefs merge PRs themselves", exists))?.id).toBe("repo:clone");
  });

  test("the clone with the chat on screen wins over the one touched last, and a clone's own path wins over both", async () => {
    const onScreen = clearProject(projectEvidence(await lines(), "let chiefs merge PRs themselves", exists, "repo:clone"));
    expect(onScreen).toMatchObject({ id: "repo:clone", strong: true, clones: ["repo:app"] });
    expect(onScreen?.reasons).toContain("the chat on their screen is there");
    const said = clearProject(projectEvidence(await lines(), `fix the chief board in ${clone}`, exists));
    expect(said).toMatchObject({ id: "repo:clone", clones: ["repo:app"] });
    // The name both clones share names one repository.
    expect(clearProject(projectEvidence(await lines(), "a chief fix in caveman-code", exists))?.id).toBe("repo:app");
  });

  test("engine work points at the engine; recent chats count; vague notes settle nothing", async () => {
    expect(clearProject(projectEvidence(await lines(), "the agent loop drops tool results in the terminal interface", exists))?.id).toBe("repo:engine");
    // No code says "hero banner" in the app, but its recent chats do.
    const withChats = await lines({ "repo:app": { recentChats: ["Hero banner flickers on the board", "Sidebar alignment"] } });
    const evidence = projectEvidence(withChats, "the hero banner flickers again", exists);
    expect(evidence[0]?.reasons.some((r) => r.startsWith('recent chats "Hero banner flickers on the board"'))).toBe(true);
    expect(clearProject(projectEvidence(await lines(), "make it better", exists))).toBeUndefined();
    // Words both repositories share as much settle nothing between them.
    expect(clearProject(projectEvidence(await lines(), "merge", exists))).toBeUndefined();
  });

  test("a profile is built again when its repository changes, and kept while it does not", async () => {
    const before = await profiles(site);
    expect(await profiles(site)).toBe(before);
    expect(before?.terms.has("pricing")).toBe(false);
    fs.writeFileSync(path.join(site, "src/pages/pricing.astro"), "");
    git(site, "add", ".");
    git(site, "commit", "-qm", "pricing");
    const after = await profiles(site);
    expect(after).not.toBe(before);
    expect(after?.terms.get("pricing")).toEqual({ files: 1, at: ["src/pages/pricing.astro"] });
  });

  test("a listing git fails keeps the last profile, never an empty one, and is tried again", async () => {
    const before = await profiles(engine);
    expect(before?.files).toBeGreaterThan(0);
    const index = path.join(engine, ".git/index");
    const saved = fs.readFileSync(index);
    fs.writeFileSync(index, "not an index");
    expect(await profiles(engine)).toBe(before);
    expect(await profiles(engine)).toBe(before);
    fs.writeFileSync(index, saved);
    fs.writeFileSync(path.join(engine, "packages/caveman-code-tui/src/billing.ts"), "");
    git(engine, "add", ".");
    expect((await profiles(engine))?.terms.has("billing")).toBe(true);
  });

  test("a folder that is no checkout, with no README, is walked; one that is gone has no profile", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(path.join(plain, "notes/billing"), { recursive: true });
    fs.mkdirSync(path.join(plain, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(plain, "notes/billing/invoices.md"), "");
    fs.writeFileSync(path.join(plain, "node_modules/x/index.js"), "");
    const profile = await profiles(plain);
    expect(profile).toMatchObject({ files: 1, areas: ["notes (billing)"], languages: ["Markdown 100%"] });
    expect(profile?.summary).toBeUndefined();
    expect(await profiles(path.join(root, "never-there"))).toBeUndefined();
  });
});
