// Many builders, several repositories (SPEC §2 and §8.5 of cloud-computers-2026-11-09), end to end on a Cloud
// computer's real runtime against the stand-in Cloud, with the stand-in Claude CLI (no model). A lead that works in
// two repositories of its project starts three builders: each is a chat in the same two repositories, cut from the
// lead's branch in each. When they finish, the integration step merges each builder's branch into the lead's in
// every repository or in none (one of them conflicts in one repository, is sent back, and goes in whole on the next
// pass), and it ends in one pull request per repository, each naming the other.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { workspaceSources, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";

import { makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn, userTexts } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const { startTools, githubWith, checkoutOf, computerRuntime, delegate } = builderKit(cleanups);

// Skipped on Windows: a Cloud computer is Linux, and its tools channel is a Unix socket.
test.skipIf(process.platform === "win32")(
  "a lead in two repositories: its builders work in both, a builder goes into both or neither, and it ends in one pull request per repository",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    await startTools();
    // Room for the lead and three builders beside it.
    process.env.CAVEMAN_COMPUTER_CPUS = "8";
    process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "32";
    cleanups.push(
      () => (
        delete process.env.CAVEMAN_COMPUTER_CPUS,
        delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
      ),
    );

    // GitHub behind the git proxy: acme/widgets (the computer's own checkout) and acme/site, one project.
    const backend = githubWith(
      makeRepo(tempRoot("sources-widgets-"), {
        "README.md": "widgets\n",
        "shared.txt": "shared list\n",
      }),
    );
    execFileSync("git", [
      "clone",
      "--bare",
      "--quiet",
      makeRepo(tempRoot("sources-site-"), { "README.md": "site\n" }),
      path.join(backend, "acme", "site.git"),
    ]);
    cloud.state.gitBackend = backend;
    for (const repo of ["acme/widgets", "acme/site"])
      cloud.state.chats.projectRepos.set(repo, "project-1");
    const bare = (repo: string) => gitIn(path.join(backend, "acme", `${repo}.git`));

    const computer = await computerRuntime(cloud, checkoutOf(backend, "sources-lead-"), "lead");
    const { client } = computer;
    // The person started the lead with both repositories: Cloud's rows say so, and the proxy serves by them alone.
    cloud.state.chats.markCloud(computer.identity.computerId, "Project computer");
    cloud.state.chats.placed.set(computer.identity.computerId, {
      repo: "acme/widgets",
      checkouts: [{ repo: "acme/site", base_branch: "main", branch: "" }],
    });
    cloud.state.chats.gitScoped = true;

    const created = await client.call("workspace.create", {
      request_id: "lead",
      repo: { url: "https://github.com/acme/widgets" },
      sources: ["acme/site"],
      title: "Ship both",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: created.id })).status !== "starting",
      60_000,
    );
    const lead = await client.call("workspace.get", { workspace_id: created.id });
    expect(lead.status).not.toBe("failed");
    expect(workspaceSources(lead).map((s) => s.name)).toEqual(["widgets", "site"]);
    const leadEvents: Array<SessionEvent> = [];
    await client.attach(lead.session_id, 0, (event) => leadEvents.push(event));

    // Where git put each chat's worktree of a repository, by branch.
    const siteClone = path.join(computer.config.worktreesDir, "sources", "acme__site");
    const worktreeOf = (clone: string, branch: string) => {
      const entry = gitIn(clone)("worktree", "list", "--porcelain")
        .split("\n\n")
        .find(
          (one) =>
            one.includes(`branch refs/heads/${branch}\n`) ||
            one.endsWith(`branch refs/heads/${branch}`),
        );
      return /^worktree (.+)$/m.exec(entry ?? "")?.[1];
    };
    // The computer's git has no identity of its own in a clone it just made: the agents' commits need one.
    gitIn(siteClone)("config", "user.email", "t@t");
    gitIn(siteClone)("config", "user.name", "t");
    const leadIn = {
      widgets: worktreeOf(computer.checkout, lead.branch)!,
      site: worktreeOf(siteClone, lead.branch)!,
    };
    expect(path.dirname(leadIn.widgets)).toBe(path.dirname(leadIn.site));
    // The lead's own commit in each repository, before any builder: builders start from it, and it stays under the merges.
    const planned: Record<string, string> = {};
    for (const [name, at] of Object.entries(leadIn)) {
      fs.writeFileSync(path.join(at, "plan.md"), `the plan for ${name}\n`);
      gitIn(at)("add", "plan.md");
      gitIn(at)("commit", "-qm", "the lead's plan");
      planned[name] = gitIn(at)("rev-parse", "HEAD");
    }

    // Each builder commits in both repositories. 01 and 02 both add a line to widgets/shared.txt: the second conflicts
    // there (and nowhere in site), is told so, merges the lead's branch in each repository and keeps both lines.
    const commitIn = (repo: string, n: number, change: string) =>
      `(cd ${repo} && ${change} && git add -A && git commit -qm "builder 0${n}: ${repo}")`;
    const resolve = `when /does not merge/: sh: (cd widgets && (git merge ${lead.branch} || (git show ${lead.branch}:shared.txt > shared.txt && echo "from builder 02" >> shared.txt && git add shared.txt && git commit -qm "builder 02: merged the lead's branch"))) && (cd site && git merge --no-edit ${lead.branch}) => Builder 02 merged the lead's branch into its own in both repositories.`;
    const taskOf = (n: number) =>
      [
        `sh: ${commitIn("widgets", n, n === 0 ? 'echo "builder 00" > area-00.txt' : `echo "from builder 0${n}" >> shared.txt`)} && ${commitIn("site", n, `echo "builder 0${n}" > page-0${n}.txt`)}`,
        ...(n === 2 ? [resolve] : []),
        `say: Builder 0${n} changed both repositories.`,
      ].join("\n");
    const started: Array<Awaited<ReturnType<typeof delegate>>> = [];
    for (let n = 0; n < 3; n++)
      started.push(
        await delegate(computer.builders, lead, `k0${n}`, `Builder 0${n}`, { task: taskOf(n) }),
      );
    expect(started.map((s) => s?.where)).toEqual(["here", "here", "here"]);

    // Every builder is a chat in the same two repositories, on its own branch in each, cut from the lead's branch there.
    const children = async () =>
      (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces;
    await until(
      async () => (await children()).filter((w) => w.status !== "starting").length === 3,
      60_000,
    );
    for (const child of await children()) {
      expect(child.status).not.toBe("failed");
      expect(workspaceSources(child).map((s) => [s.name, s.branch, s.base_ref])).toEqual([
        ["widgets", child.branch, lead.branch],
        ["site", child.branch, lead.branch],
      ]);
      expect(child.branch).not.toBe(lead.branch);
      const at = {
        widgets: worktreeOf(computer.checkout, child.branch)!,
        site: worktreeOf(siteClone, child.branch)!,
      };
      expect(path.dirname(at.widgets)).toBe(path.dirname(at.site));
      expect(path.dirname(at.widgets)).not.toBe(path.dirname(leadIn.widgets));
      // From the lead's own commit in each.
      execFileSync("git", ["merge-base", "--is-ancestor", planned.widgets!, child.branch], {
        cwd: computer.checkout,
      });
      execFileSync("git", ["merge-base", "--is-ancestor", planned.site!, child.branch], {
        cwd: siteClone,
      });
    }

    const summary = () =>
      userTexts(leadEvents).find((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      );
    await until(() => summary() !== undefined, 300_000);

    // ---- one branch per repository: every builder's work, exactly once, on top of the lead's own commit.
    for (const [name, at] of Object.entries(leadIn)) {
      const git = gitIn(at);
      expect(git("symbolic-ref", "--short", "HEAD")).toBe(lead.branch);
      expect(git("status", "--porcelain")).toBe("");
      execFileSync("git", ["merge-base", "--is-ancestor", planned[name]!, "HEAD"], { cwd: at });
      expect(
        git("log", "--first-parent", "--format=%s", `${planned[name]}..HEAD`)
          .split("\n")
          .map((subject) => subject.replace(/ \(.*$/, "")),
      ).toEqual(["Merge Builder 02", "Merge Builder 01", "Merge Builder 00"]);
      for (let n = 0; n < 3; n++)
        expect(
          git("log", "--format=%s", `${planned[name]}..HEAD`)
            .split("\n")
            .filter((subject) => subject === `builder 0${n}: ${name}`),
        ).toHaveLength(1);
    }
    expect(
      fs.readFileSync(path.join(leadIn.widgets, "shared.txt"), "utf8").trim().split("\n"),
    ).toEqual(["shared list", "from builder 01", "from builder 02"]);
    expect(fs.readFileSync(path.join(leadIn.widgets, "area-00.txt"), "utf8")).toBe("builder 00\n");
    for (let n = 0; n < 3; n++)
      expect(fs.readFileSync(path.join(leadIn.site, `page-0${n}.txt`), "utf8")).toBe(
        `builder 0${n}\n`,
      );

    // Builder 02 conflicted in widgets alone and was told so with the file under its repository's folder. Its work in
    // site, which merges cleanly, stayed out with it: what went into site later is its branch after it had merged the
    // lead's (a merge commit of its own), not the commit it first made.
    const second = (await children()).find((w) => w.title === "Builder 02")!;
    const secondEvents: Array<SessionEvent> = [];
    await client.attach(second.session_id, 0, (event) => secondEvents.push(event));
    const conflict = () =>
      userTexts(secondEvents).find((text) => text.startsWith("[Caveman Code] Your branch "));
    await until(() => conflict() !== undefined, 30_000);
    const told = conflict()!;
    expect(told).toContain(`both changed widgets/shared.txt.`);
    expect(told).toContain("in each repository's folder (widgets, site)");
    const siteGit = gitIn(leadIn.site);
    expect(siteGit("log", "-1", "--format=%s", "HEAD^2")).toMatch(/^Merge branch /);
    execFileSync(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        siteGit("rev-parse", "HEAD~1"),
        siteGit("rev-parse", "HEAD^2"),
      ],
      { cwd: leadIn.site },
    );

    // ---- one pull request in each repository, through Cloud, from the lead's branch as it stands; each names the other.
    const opened = cloud.state.automations.pullRequests;
    expect(opened.map((one) => [one.repo, one.head, one.base, one.session_id])).toEqual([
      ["acme/widgets", lead.branch, "main", lead.session_id],
      ["acme/site", lead.branch, "main", lead.session_id],
    ]);
    const [widgetsPr, sitePr] = opened;
    expect(widgetsPr!.sha).toBe(gitIn(leadIn.widgets)("rev-parse", "HEAD"));
    expect(sitePr!.sha).toBe(siteGit("rev-parse", "HEAD"));
    expect(bare("widgets")("rev-parse", `refs/heads/${lead.branch}`)).toBe(widgetsPr!.sha);
    expect(bare("site")("rev-parse", `refs/heads/${lead.branch}`)).toBe(sitePr!.sha);
    for (const pr of opened)
      for (let n = 0; n < 3; n++)
        expect(pr.body).toMatch(
          new RegExp(`- \\*\\*Builder 0${n}\\*\\* \\(\`caveman/builder-0${n}-[0-9a-f]{6}\`\\): `),
        );
    expect(widgetsPr!.body).toContain(
      `- acme/site: https://github.com/acme/site/pull/${sitePr!.number}`,
    );
    expect(sitePr!.body).toContain(
      `- acme/widgets: https://github.com/acme/widgets/pull/${widgetsPr!.number}`,
    );

    // The lead heard once, with both pull requests.
    expect(
      userTexts(leadEvents).filter((text) =>
        text.startsWith("[Caveman Code] Your builders have finished."),
      ),
    ).toHaveLength(1);
    expect(summary()!).toContain(`3 of 3 branches are merged into ${lead.branch}`);
    expect(summary()!).toContain(
      "One pull request in each repository carries it, each naming the others",
    );
    expect(summary()!).toContain(`https://github.com/acme/widgets/pull/${widgetsPr!.number}`);
    expect(summary()!).toContain(`https://github.com/acme/site/pull/${sitePr!.number}`);

    // Nothing left the caveman/ namespace, nothing was asked of a repository outside Cloud's rows, and nothing the
    // runtime sent was a body Cloud refuses.
    expect(cloud.state.gitRefused).toEqual([]);
    expect(cloud.state.chats.gitOutOfScope).toEqual([]);
    expect(cloud.state.tree.refused).toEqual([]);
    expect(cloud.state.chats.refused).toEqual([]);
    expect((await Effect.runPromise(computer.builders.tree(`caveman:${lead.id}`))).running).toBe(0);
  },
  420_000,
);
