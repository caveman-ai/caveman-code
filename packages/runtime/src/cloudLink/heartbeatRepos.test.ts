import { describe, expect, it } from "vitest";

import { heartbeatRepos, MAX_HEARTBEAT_REPOS, repoHash } from "./heartbeatRepos.ts";

describe("repoHash", () => {
  // The same vectors as Caveman Cloud runtime_repos_test.go TestGitHubRepoHash: Cloud hashes "github.com/<owner>/<name>".
  it("hashes every spelling of a GitHub remote as Cloud hashes its owner/name", () => {
    const widgets = "f60ecdb16e5e8e829d8346f19a25e2304ed38ace98f1c958ce4fd3792c2e8126";
    for (const remote of ["https://github.com/acme/widgets.git", "git@github.com:Acme/Widgets.git", "ssh://git@github.com/acme/widgets", "https://user:token@github.com/acme/widgets/", "https://github.com:443/acme/widgets"])
      expect(repoHash(remote), remote).toBe(widgets);
    expect(repoHash("https://github.com/octocat/Hello-World")).toBe("409d4eb48c9806c1dbc355a97835e651c55d946bc0e9d226c55cb47d68a13596");
  });
  it("hashes nothing that is not a host and a repository path", () => {
    for (const remote of ["/Users/me/code/web", "file:///Users/me/code/web", "C:\\code\\web", "", "web"]) expect(repoHash(remote), remote).toBeUndefined();
  });
  it("hashes only GitHub remotes: Cloud matches nothing else, so a Mac's other checkouts are never named to it", () => {
    for (const remote of ["https://gitlab.com/acme/widgets.git", "git@gitlab.com:acme/widgets.git", "https://git.internal.acme.dev/team/widgets", "ssh://git@bitbucket.org/acme/widgets"])
      expect(repoHash(remote), remote).toBeUndefined();
  });
});

describe("heartbeatRepos", () => {
  /** Checkouts by folder: its origin (null: none, or a folder gone) and HEAD. */
  const reading = (checkouts: Record<string, { remote: string | null; head?: string }>) => ({
    remote: async (dir: string) => checkouts[dir]?.remote,
    head: (dir: string) => checkouts[dir]?.head,
  });

  it("keeps one entry per repository, a commit head or none, never a path", async () => {
    const head = "a".repeat(40);
    const checkouts = {
      "/Users/me/code/widgets": { remote: "https://github.com/acme/widgets.git", head },
      "/Users/me/code/widgets-2": { remote: "git@github.com:acme/widgets.git", head: "b".repeat(40) },
      "/Users/me/code/local-only": { remote: "/Users/me/code/local-only", head },
      "/Users/me/code/tools": { remote: "https://gitlab.com/acme/private-tools.git", head },
      "/Users/me/code/web": { remote: "https://github.com/acme/web", head: "not a commit" },
      "/Users/me/code/no-origin": { remote: null, head },
    };
    const list = await heartbeatRepos(Object.keys(checkouts), reading(checkouts));
    expect(list).toEqual([
      { remote_hash: repoHash("https://github.com/acme/widgets")!, head },
      { remote_hash: repoHash("https://github.com/acme/web")!, head: "" },
    ]);
    expect(JSON.stringify(list)).not.toContain("/Users/me");
  });

  it("counts Cloud's cap in GitHub repositories, after other remotes, folders gone and second checkouts are left out", async () => {
    // More folders than the cap (projects first, then discovery's), most of them not GitHub repositories of their own:
    // the repository past the first 200 folders is still named, since it is the 31st repository.
    const checkouts: Record<string, { remote: string | null; head?: string }> = {};
    for (let i = 0; i < 150; i++) checkouts[`/p/gitlab-${i}`] = { remote: `https://gitlab.com/acme/r${i}` };
    for (let i = 0; i < 40; i++) checkouts[`/p/gone-${i}`] = { remote: null };
    for (let i = 0; i < 30; i++) checkouts[`/p/web-${i}`] = { remote: `https://github.com/acme/web-${i % 2 === 0 ? "a" : "b"}${Math.floor(i / 2)}` };
    checkouts["/p/past-the-folders"] = { remote: "https://github.com/acme/past", head: "c".repeat(40) };
    const list = await heartbeatRepos(Object.keys(checkouts), reading(checkouts));
    expect(Object.keys(checkouts).length).toBeGreaterThan(MAX_HEARTBEAT_REPOS);
    expect(list).toHaveLength(31);
    expect(list).toContainEqual({ remote_hash: repoHash("https://github.com/acme/past")!, head: "c".repeat(40) });
  });

  it("names none when the Mac has more repositories than Cloud keeps: a list cut short would refuse a Mac that has the chat's", async () => {
    const dirs = Array.from({ length: MAX_HEARTBEAT_REPOS + 1 }, (_, i) => `/p/r${i}`);
    const remote = async (dir: string) => `https://github.com/acme/${dir.slice(3)}`;
    expect(await heartbeatRepos(dirs, { remote, head: () => undefined })).toBeUndefined();
    expect(await heartbeatRepos(dirs.slice(0, MAX_HEARTBEAT_REPOS), { remote, head: () => undefined })).toHaveLength(MAX_HEARTBEAT_REPOS);
    // A second checkout of a repository already named never counts toward the cap.
    expect(await heartbeatRepos([...dirs.slice(0, MAX_HEARTBEAT_REPOS), "/p/r0"], { remote, head: () => undefined })).toHaveLength(MAX_HEARTBEAT_REPOS);
  });
});
