// The integration step's git (integration.ts) on real repositories: clean branches merge in order onto the lead's
// head, a conflicting one is named and left for its author, nothing is merged twice, and a pass cut short anywhere
// can simply run again.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import {
  conflictText,
  describeResult,
  leadSummary,
  leftOutForConflict,
  mergeAcrossSources,
  mergeBranches,
  shortNote,
  type Candidate,
  type IntegrationGit,
} from "./integration.ts";
import { makeRepo, tempRoot } from "./testHarness.ts";

/** git in `cwd`, as the runtime's driver runs it for the step: real git, exit code and output. */
const gitAt =
  (cwd: string, seen: Array<string> = []): IntegrationGit =>
  (args, options = {}) =>
    Effect.suspend(() => {
      seen.push(args[0]!);
      const ran = spawnSync("git", [...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...options.env },
      });
      const out = { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
      return out.exitCode === 0 || options.allowNonZeroExit
        ? Effect.succeed(out)
        : Effect.fail({ message: ran.stderr.trim() });
    });
const sh = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A lead's checkout on caveman/lead with one commit of its own, and builders' branches cut from it. */
function leadWith(builders: Record<string, Record<string, string>>) {
  const repo = makeRepo(tempRoot("integration-"), {
    "README.md": "widgets\n",
    "shared.txt": "one\ntwo\nthree\n",
  });
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "checkout", "-q", "-b", "caveman/lead");
  fs.writeFileSync(path.join(repo, "plan.md"), "the plan\n");
  sh(repo, "add", "plan.md");
  sh(repo, "commit", "-qm", "the lead's plan");
  const planned = sh(repo, "rev-parse", "HEAD");
  for (const [name, files] of Object.entries(builders)) {
    sh(repo, "checkout", "-q", "-b", `caveman/${name}`, planned);
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", `${name}: its work`);
  }
  sh(repo, "checkout", "-q", "caveman/lead");
  return { repo, planned };
}
const candidate = (name: string): Candidate => ({
  key: name,
  title: name,
  branch: `caveman/${name}`,
  ref: `refs/heads/caveman/${name}`,
});
const merge = (repo: string, names: ReadonlyArray<string>, seen?: Array<string>) =>
  Effect.runPromise(mergeBranches(gitAt(repo, seen), names.map(candidate)));

test("clean branches merge onto the lead's head in the order given; a conflicting one is named and stays out", async () => {
  const { repo, planned } = leadWith({
    alpha: { "a/alpha.txt": "alpha\n" },
    beta: { "b/beta.txt": "beta\n", "shared.txt": "one\ntwo beta\nthree\n" },
    // Changes the line beta changed: whichever of the two comes second conflicts.
    gamma: { "c/gamma.txt": "gamma\n", "shared.txt": "one\ntwo gamma\nthree\n" },
    delta: { "d/delta.txt": "delta\n" },
  });
  const merged = await merge(repo, ["alpha", "beta", "gamma", "delta", "nobody"]);
  expect(merged.held).toBeUndefined();
  expect(merged.outcomes.map((o) => [o.key, o.kind])).toEqual([
    ["alpha", "merged"],
    ["beta", "merged"],
    ["gamma", "conflict"],
    ["delta", "merged"],
    ["nobody", "missing"],
  ]);
  expect(merged.outcomes[2]).toMatchObject({
    files: ["shared.txt"],
    sha: sh(repo, "rev-parse", "caveman/gamma"),
  });
  // One branch: the lead's, moved by fast-forward to the last merge, its worktree with it.
  expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("caveman/lead");
  expect(sh(repo, "rev-parse", "HEAD")).toBe(merged.head);
  expect(sh(repo, "status", "--porcelain")).toBe("");
  expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe("one\ntwo beta\nthree\n");
  for (const file of ["a/alpha.txt", "b/beta.txt", "d/delta.txt"])
    expect(fs.existsSync(path.join(repo, file))).toBe(true);
  expect(fs.existsSync(path.join(repo, "c/gamma.txt"))).toBe(false);
  // The lead's own commit is under the merges, as it was: nothing of the lead's was rewritten.
  expect(sh(repo, "log", "--first-parent", "--format=%s", `${planned}..HEAD`).split("\n")).toEqual([
    "Merge delta (caveman/delta)",
    "Merge beta (caveman/beta)",
    "Merge alpha (caveman/alpha)",
  ]);
  expect(sh(repo, "rev-parse", "HEAD~3")).toBe(planned);
  // The same branches in the other order: gamma is in, and beta is the one that conflicts.
  const other = leadWith({
    beta: { "shared.txt": "one\ntwo beta\nthree\n" },
    gamma: { "shared.txt": "one\ntwo gamma\nthree\n" },
  });
  expect((await merge(other.repo, ["gamma", "beta"])).outcomes.map((o) => [o.key, o.kind])).toEqual(
    [
      ["gamma", "merged"],
      ["beta", "conflict"],
    ],
  );
});

test("a branch already in the lead's is merged without a second merge: a pass that ran before recording anything runs again and changes nothing", async () => {
  const { repo } = leadWith({ alpha: { "a.txt": "a\n" }, beta: { "b.txt": "b\n" } });
  const first = await merge(repo, ["alpha", "beta"]);
  // The runtime stopped here, before it wrote down what it merged. The next pass, over the same branches:
  const seen: Array<string> = [];
  const again = await merge(repo, ["alpha", "beta"], seen);
  expect(again.outcomes).toEqual(first.outcomes);
  expect(again.head).toBe(first.head);
  expect(sh(repo, "rev-parse", "HEAD")).toBe(first.head);
  // It only looked: no tree was merged, no commit made, the branch not moved.
  expect(
    seen.filter(
      (command) => command === "merge-tree" || command === "commit-tree" || command === "merge",
    ),
  ).toEqual([]);
  expect(sh(repo, "rev-list", "--merges", "--count", "HEAD")).toBe("2");
  // A builder that never left the lead's commit has nothing to merge, and counts as in.
  sh(repo, "branch", "caveman/idle", "HEAD~2");
  expect((await merge(repo, ["idle"])).outcomes).toEqual([
    { key: "idle", kind: "merged", sha: sh(repo, "rev-parse", "caveman/idle") },
  ]);
});

test("the lead's uncommitted work in the way holds the whole pass: nothing is merged, and it merges once the way is clear", async () => {
  const { repo, planned } = leadWith({
    alpha: { "a.txt": "a\n" },
    beta: { "shared.txt": "one\ntwo beta\nthree\n" },
  });
  // The lead has an uncommitted edit to a file a builder changed.
  fs.writeFileSync(path.join(repo, "shared.txt"), "one\ntwo\nthree\nthe lead's own note\n");
  const held = await merge(repo, ["alpha", "beta"]);
  expect(held.held).toMatch(/shared\.txt|overwritten|local changes/i);
  expect(held.head).toBe(planned);
  // All or nothing: alpha, which touches nothing of the lead's, did not go in alone, and the lead's edit is as it was.
  expect(sh(repo, "rev-parse", "HEAD")).toBe(planned);
  expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toContain("the lead's own note");
  // No merge left half done.
  expect(fs.existsSync(path.join(sh(repo, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(
    false,
  );
  // The lead commits its note: the next pass has a new head to merge onto, and both go in.
  sh(repo, "commit", "-qam", "the lead's note");
  const leadNow = sh(repo, "rev-parse", "HEAD");
  const merged = await merge(repo, ["alpha", "beta"]);
  expect(merged.held).toBeUndefined();
  expect(merged.outcomes.map((o) => o.kind)).toEqual(["merged", "merged"]);
  expect(sh(repo, "rev-parse", "HEAD~2")).toBe(leadNow);
  expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
    "one\ntwo beta\nthree\nthe lead's own note\n",
  );
});

test("an author who merges the lead's branch into its own and resolves is merged by the next pass", async () => {
  const { repo } = leadWith({
    beta: { "shared.txt": "one\ntwo beta\nthree\n" },
    gamma: { "shared.txt": "one\ntwo gamma\nthree\n" },
  });
  expect((await merge(repo, ["beta", "gamma"])).outcomes.map((o) => o.kind)).toEqual([
    "merged",
    "conflict",
  ]);
  // gamma's author does what the conflict message asks: merge, not rebase.
  sh(repo, "checkout", "-q", "caveman/gamma");
  expect(spawnSync("git", ["merge", "caveman/lead"], { cwd: repo }).status).toBe(1);
  fs.writeFileSync(path.join(repo, "shared.txt"), "one\ntwo beta and gamma\nthree\n");
  sh(repo, "commit", "-qam", "gamma: merged the lead's branch");
  sh(repo, "checkout", "-q", "caveman/lead");
  const next = await merge(repo, ["beta", "gamma"]);
  expect(next.outcomes.map((o) => o.kind)).toEqual(["merged", "merged"]);
  expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(
    "one\ntwo beta and gamma\nthree\n",
  );
});

test("a lead in several repositories: a builder's work goes into every one or into none, and each repository's branch moves by its own fast-forward", async () => {
  // delta changes the line beta changed in core, and a file of its own in web; gamma has a branch in web alone.
  const core = leadWith({
    alpha: { "a.txt": "core alpha\n" },
    beta: { "shared.txt": "one\ntwo beta\nthree\n" },
    delta: { "shared.txt": "one\ntwo delta\nthree\n" },
  });
  const web = leadWith({
    alpha: { "a.txt": "web alpha\n" },
    beta: { "b.txt": "web beta\n" },
    gamma: { "g.txt": "web gamma\n" },
    delta: { "d.txt": "web delta\n" },
  });
  const sources = (seen?: Array<string>) => [
    {
      name: "core",
      git: gitAt(core.repo, seen),
      candidates: ["alpha", "beta", "delta"].map(candidate),
    },
    {
      name: "web",
      git: gitAt(web.repo, seen),
      candidates: ["alpha", "beta", "gamma", "delta"].map(candidate),
    },
  ];
  const first = await Effect.runPromise(mergeAcrossSources(sources()));
  expect(first.held).toBeUndefined();
  expect(first.outcomes.map((o) => [o.key, o.kind])).toEqual([
    ["alpha", "merged"],
    ["beta", "merged"],
    ["delta", "conflict"],
    ["gamma", "merged"],
  ]);
  // The conflicting file is named as the lead's chat names it: under its repository's folder.
  expect(first.outcomes[2]).toMatchObject({ files: ["core/shared.txt"] });
  // delta merges cleanly in web, and is out of it all the same: half a builder's change is in no repository.
  expect(fs.existsSync(path.join(web.repo, "d.txt"))).toBe(false);
  expect(
    sh(web.repo, "log", "--first-parent", "--format=%s", `${web.planned}..HEAD`).split("\n"),
  ).toEqual([
    "Merge gamma (caveman/gamma)",
    "Merge beta (caveman/beta)",
    "Merge alpha (caveman/alpha)",
  ]);
  expect(
    sh(core.repo, "log", "--first-parent", "--format=%s", `${core.planned}..HEAD`).split("\n"),
  ).toEqual(["Merge beta (caveman/beta)", "Merge alpha (caveman/alpha)"]);
  for (const repo of [core.repo, web.repo]) {
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("caveman/lead");
    expect(sh(repo, "status", "--porcelain")).toBe("");
  }
  expect(first.head).toBe(
    `${sh(core.repo, "rev-parse", "HEAD")}+${sh(web.repo, "rev-parse", "HEAD")}`,
  );

  // delta's author merges the lead's branch in core and resolves. Meanwhile the lead has an uncommitted edit in web
  // to the file delta adds there: core moves, web is held and named, and nothing of the lead's edit is lost.
  sh(core.repo, "checkout", "-q", "caveman/delta");
  expect(spawnSync("git", ["merge", "caveman/lead"], { cwd: core.repo }).status).toBe(1);
  fs.writeFileSync(path.join(core.repo, "shared.txt"), "one\ntwo beta and delta\nthree\n");
  sh(core.repo, "commit", "-qam", "delta: merged the lead's branch");
  sh(core.repo, "checkout", "-q", "caveman/lead");
  fs.writeFileSync(path.join(web.repo, "d.txt"), "the lead's own\n");
  const webBefore = sh(web.repo, "rev-parse", "HEAD");
  const held = await Effect.runPromise(mergeAcrossSources(sources()));
  expect(held.held).toMatch(/^web: /);
  expect(fs.readFileSync(path.join(core.repo, "shared.txt"), "utf8")).toBe(
    "one\ntwo beta and delta\nthree\n",
  );
  expect(sh(web.repo, "rev-parse", "HEAD")).toBe(webBefore);
  expect(fs.readFileSync(path.join(web.repo, "d.txt"), "utf8")).toBe("the lead's own\n");

  // The way is clear: the pass runs again and finishes where it stopped, merging nothing twice in core.
  fs.rmSync(path.join(web.repo, "d.txt"));
  const coreBefore = sh(core.repo, "rev-parse", "HEAD");
  const done = await Effect.runPromise(mergeAcrossSources(sources()));
  expect(done.held).toBeUndefined();
  expect(done.outcomes.map((o) => [o.key, o.kind])).toEqual([
    ["alpha", "merged"],
    ["beta", "merged"],
    ["delta", "merged"],
    ["gamma", "merged"],
  ]);
  expect(sh(core.repo, "rev-parse", "HEAD")).toBe(coreBefore);
  expect(fs.readFileSync(path.join(web.repo, "d.txt"), "utf8")).toBe("web delta\n");
  expect(sh(core.repo, "rev-list", "--merges", "--count", `${core.planned}..caveman/lead`)).toBe(
    "4",
  );
  expect(sh(web.repo, "rev-list", "--merges", "--count", `${web.planned}..caveman/lead`)).toBe("4");
});

test("leaving a builder out is tried again: what the next one is tried against changed", async () => {
  // In core, beta and gamma change one line (gamma, the second, conflicts). In web, gamma and delta change one line:
  // with gamma out of every repository, delta no longer conflicts with anything and goes in.
  const core = leadWith({
    beta: { "shared.txt": "one\ntwo beta\nthree\n" },
    gamma: { "shared.txt": "one\ntwo gamma\nthree\n" },
    delta: { "d.txt": "core delta\n" },
  });
  const web = leadWith({
    gamma: { "shared.txt": "one\ntwo gamma\nthree\n" },
    delta: { "shared.txt": "one\ntwo delta\nthree\n" },
  });
  const merged = await Effect.runPromise(
    mergeAcrossSources([
      {
        name: "core",
        git: gitAt(core.repo),
        candidates: ["beta", "gamma", "delta"].map(candidate),
      },
      { name: "web", git: gitAt(web.repo), candidates: ["gamma", "delta"].map(candidate) },
    ]),
  );
  expect(merged.outcomes.map((o) => [o.key, o.kind])).toEqual([
    ["beta", "merged"],
    ["gamma", "conflict"],
    ["delta", "merged"],
  ]);
  expect(fs.readFileSync(path.join(web.repo, "shared.txt"), "utf8")).toBe(
    "one\ntwo delta\nthree\n",
  );
  expect(fs.readFileSync(path.join(core.repo, "shared.txt"), "utf8")).toBe(
    "one\ntwo beta\nthree\n",
  );
});

test("what the author, the pull request and the lead read", () => {
  expect(
    conflictText({
      branch: "caveman/gamma-1",
      leadBranch: "caveman/lead-1",
      files: ["core/shared.txt"],
      round: 2,
      sources: ["core", "web"],
    }),
  ).toBe(
    "[Caveman Code] Your branch caveman/gamma-1 does not merge into the lead's branch caveman/lead-1: both changed core/shared.txt. The other builders' work is in caveman/lead-1 now. Bring yours up to date: run `git merge caveman/lead-1` in each repository's folder (core, web), resolve the conflicts keeping both sides' intent, commit, and say what you did. Merge, do not rebase: your branch is shared and nothing is force-pushed. This is the last try: if it still conflicts, your work is left out of the pull requests.",
  );
  expect(
    leadSummary({
      branch: "caveman/lead-1",
      results: [{ title: "Parser", branch: "caveman/parser-1", note: "", state: "merged" }],
      pullRequest: "https://github.com/acme/core/pull/7, https://github.com/acme/web/pull/3",
      several: true,
    }),
  ).toMatch(
    /One pull request in each repository carries it, each naming the others, with a note from each builder: https:\/\/github\.com\/acme\/core\/pull\/7, https:\/\/github\.com\/acme\/web\/pull\/3$/,
  );
  expect(
    conflictText({
      branch: "caveman/gamma-1",
      leadBranch: "caveman/lead-1",
      files: ["shared.txt", "src/a.ts"],
      round: 1,
    }),
  ).toBe(
    "[Caveman Code] Your branch caveman/gamma-1 does not merge into the lead's branch caveman/lead-1: both changed shared.txt, src/a.ts. The other builders' work is in caveman/lead-1 now. Bring yours up to date: run `git merge caveman/lead-1` in your worktree, resolve the conflicts keeping both sides' intent, commit, and say what you did. Merge, do not rebase: your branch is shared and nothing is force-pushed.",
  );
  expect(conflictText({ branch: "b", leadBranch: "l", files: ["x"], round: 2 })).toMatch(
    /This is the last try: if it still conflicts, your work is left out of the pull request\.$/,
  );
  expect(shortNote("  It added\n\nthe parser.  ")).toBe("It added the parser.");
  expect(shortNote("x".repeat(500))).toHaveLength(400);
  const results = [
    {
      title: "Parser",
      branch: "caveman/parser-1",
      note: "Added the parser and its tests.",
      state: "merged" as const,
    },
    {
      title: "Printer",
      branch: "caveman/printer-2",
      note: "Wrote the printer.",
      state: "left_out" as const,
      why: leftOutForConflict(["shared.txt"], 2),
    },
    { title: "Docs", branch: "caveman/docs-3", note: "", state: "merged" as const },
  ];
  expect(describeResult(results)).toBe(
    [
      "3 agents worked on this. The work of 2 agents is in this branch; 1 agent is left out, below.",
      "",
      "## What each agent did",
      "",
      "- **Parser** (`caveman/parser-1`): Added the parser and its tests.",
      "- **Docs** (`caveman/docs-3`): It left no note.",
      "",
      "## Left out",
      "",
      "- **Printer** (`caveman/printer-2`): it still conflicts with the rest in shared.txt after 2 tries at bringing it up to date. Its work is on its own branch.",
    ].join("\n"),
  );
  expect(describeResult(results.slice(0, 1))).toBe(
    "1 agent worked on this. The work of all of them is in this branch.\n\n## What each agent did\n\n- **Parser** (`caveman/parser-1`): Added the parser and its tests.",
  );
  expect(
    leadSummary({
      branch: "caveman/lead-1",
      results,
      pullRequest: "https://github.com/acme/widgets/pull/7",
    }),
  ).toBe(
    "[Caveman Code] Your builders have finished. 2 of 3 branches are merged into caveman/lead-1: Parser, Docs. Not in: Printer (it still conflicts with the rest in shared.txt after 2 tries at bringing it up to date). One pull request carries it all, with a note from each builder: https://github.com/acme/widgets/pull/7",
  );
  expect(
    leadSummary({
      branch: "caveman/lead-1",
      results: results.slice(0, 1),
      pullRequestProblem: "no source control provider is configured",
    }),
  ).toMatch(
    /1 of 1 branch is merged into caveman\/lead-1: Parser\. No pull request was opened: no source control provider is configured$/,
  );
  // No amount of money in any of it.
  for (const text of [describeResult(results), leadSummary({ branch: "b", results })])
    expect(text).not.toMatch(/[$€£]\s?\d/);
});
