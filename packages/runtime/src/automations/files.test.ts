import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { templates } from "@caveman-app/automations";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AutomationProjects,
  checkSources,
  createFromTemplate,
  createFromText,
  defaultBranchOf,
  editablePath,
  ensureGitignore,
  layer,
  readBranch,
  readWorkingTree,
  registryAgents,
  revisionFrom,
  TRACKED_ME_FILE,
} from "./files.ts";
import { AutomationFiles } from "./services.ts";
import { DIGEST, gitFailing, projectStoreFor, testRepo, type TestRepo } from "./testing.ts";

const repos: TestRepo[] = [];
const repo = (...args: Parameters<typeof testRepo>) => {
  const r = testRepo(...args);
  repos.push(r);
  return r;
};
afterEach(() => repos.splice(0).forEach((r) => r.remove()));

const REVIEWER = "---\ndescription: Reviews\ndecides: [approve, request_changes]\n---\nReview it.\n";
const REVIEW = `on: { github: { event: pull_request.opened } }
steps:
  review:
    agent: my-reviewer
    model: base
outputs:
  github.comment: review.summary
`;

describe("reading automation files", () => {
  it("reads every .caveman file check needs, skips state and other Me folders, and reports links out of the repository", async () => {
    const r = repo({
      ".caveman/automations/digest.yaml": DIGEST,
      ".caveman/automations/sub/nested.yaml": DIGEST,
      ".caveman/.gitignore": "local/\nstate/\n",
      ".caveman/local/automations/mine.yaml": DIGEST,
      ".caveman/local/notes.txt": "not read",
      ".caveman/state/run.json": "{}",
      ".caveman/agents/my-reviewer.md": REVIEWER,
      ".caveman/computer.toml": "[setup]\n",
      ".claude/agents/helper.md": "---\ndescription: Helps\n---\nHelp.\n",
    });
    fs.writeFileSync(path.join(path.dirname(r.root), `${path.basename(r.root)}-secret`), "secret");
    fs.symlinkSync(path.join(path.dirname(r.root), `${path.basename(r.root)}-secret`), path.join(r.root, ".caveman/agents/leak.md"));
    const read = await readWorkingTree(r.root);
    expect(read.files.map((f) => f.path).sort()).toEqual([
      ".caveman/.gitignore",
      ".caveman/agents/my-reviewer.md",
      ".caveman/automations/digest.yaml",
      ".caveman/automations/sub/nested.yaml",
      ".caveman/computer.toml",
      ".caveman/local/automations/mine.yaml",
    ]);
    expect(read.claude.map((f) => f.path)).toEqual([".claude/agents/helper.md"]);
    expect(read.problems).toEqual([expect.objectContaining({ path: ".caveman/agents/leak.md", code: "file-unrecognized", severity: "error" })]);
    const check = checkSources({ sources: read, registry: await registryAgents({ home: r.root }) });
    // The subfolder file is reported, never skipped silently; Claude's agents resolve in place.
    expect(check.diagnostics.map((d) => d.path)).toEqual(expect.arrayContaining([".caveman/agents/leak.md", ".caveman/automations/sub/nested.yaml"]));
    expect(check.agents.some((a) => a.name === "helper")).toBe(true);
    expect(check.automations.map((a) => `${a.scope}:${a.name}`).sort()).toEqual(["me:mine", "project:digest"]);
  });

  it("never reads a Me file git tracks (F-1), and keeps Me files out of git however they got there (B16)", async () => {
    // Committed before any .gitignore, as a pull request branch carries it.
    const r = repo({ ".caveman/local/automations/evil.yaml": DIGEST });
    expect(r.git("ls-files", ".caveman")).toContain("evil.yaml");
    r.write(".caveman/local/automations/mine.yaml", DIGEST);
    const read = await readWorkingTree(r.root);
    expect(read.files.map((f) => f.path)).toEqual([".caveman/.gitignore", ".caveman/local/automations/mine.yaml"]);
    expect(read.problems).toEqual([
      expect.objectContaining({ path: ".caveman/local/automations/evil.yaml", code: "me-file-tracked", severity: "error", message: TRACKED_ME_FILE }),
    ]);
    const check = checkSources({ sources: read, registry: [] });
    expect(check.automations.map((a) => a.name)).toEqual(["mine"]);
    // Written on read: the hand-made Me file stays out of the next git add -A.
    expect(fs.readFileSync(path.join(r.root, ".caveman/.gitignore"), "utf8")).toContain("local/");
    r.git("add", "-A");
    expect(r.git("ls-files", ".caveman/local")).not.toContain("mine.yaml");
  });

  it("checks unsaved editor text in place of the file on disk", async () => {
    const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
    const read = await readWorkingTree(r.root);
    const registry = await registryAgents({ home: r.root });
    expect(checkSources({ sources: read, registry }).diagnostics).toEqual([]);
    const broken = checkSources({ sources: read, registry, overrides: [{ path: ".caveman/automations/digest.yaml", text: DIGEST.replace("model:", "modle:") }] });
    expect(broken.diagnostics).toEqual([expect.objectContaining({ code: "unknown-key", line: 5, message: expect.stringContaining('Did you mean "model"?') })]);
    const added = checkSources({ sources: read, registry, overrides: [{ path: ".caveman/automations/new.yaml", text: "steps: {}\n" }] });
    expect(added.diagnostics.map((d) => d.path)).toEqual([".caveman/automations/new.yaml"]);
  });
});

describe("revisions", () => {
  it("a trigger's revision is the default branch's copy; a manual run's is the working tree's", async () => {
    const r = repo({ ".caveman/automations/review.yaml": REVIEW, ".caveman/agents/my-reviewer.md": REVIEWER });
    r.write(".caveman/automations/review.yaml", REVIEW.replace("model: base", "model: frontier"));
    const registry = await registryAgents({ home: r.root });
    expect(await defaultBranchOf(r.root)).toEqual({ name: "main", ref: "main" });
    const branch = await readBranch(r.root, "main");
    const onMain = revisionFrom({ sources: branch, registry, check: checkSources({ sources: branch, registry }), name: "review", scope: "project", from: "default_branch" })!;
    const working = await readWorkingTree(r.root);
    const here = revisionFrom({ sources: working, registry, check: checkSources({ sources: working, registry }), name: "review", scope: "project", from: "working_tree" })!;
    expect(onMain.automation.text).toContain("model: base");
    expect(here.automation.text).toContain("model: frontier");
    expect(onMain.digest).not.toBe(here.digest);
    expect(onMain.agents.find((a) => a.name === "my-reviewer")?.instructions).toBe("Review it.");
    expect(onMain.from).toBe("default_branch");
  });

  it("an edit to an agent the automation uses is a new revision; an unrelated agent is not", async () => {
    const r = repo({ ".caveman/automations/review.yaml": REVIEW, ".caveman/agents/my-reviewer.md": REVIEWER, ".caveman/agents/other.md": "---\ndescription: x\n---\nx\n" });
    const registry = await registryAgents({ home: r.root });
    const digest = async () => {
      const s = await readWorkingTree(r.root);
      return revisionFrom({ sources: s, registry, check: checkSources({ sources: s, registry }), name: "review", scope: "project", from: "working_tree" })!.digest;
    };
    const first = await digest();
    r.write(".caveman/agents/other.md", "---\ndescription: y\n---\ny\n");
    expect(await digest()).toBe(first);
    r.write(".caveman/agents/my-reviewer.md", REVIEWER.replace("Review it.", "Review it twice."));
    expect(await digest()).not.toBe(first);
  });

  it("carries each agent's returns schema, parsed, from the same copy as the agent (K1)", async () => {
    const schema = { type: "object", properties: { risk: { type: "string" } }, required: ["risk"] };
    const r = repo({
      ".caveman/automations/review.yaml": REVIEW,
      ".caveman/agents/my-reviewer.md": REVIEWER.replace("decides:", "returns: my-reviewer.json\ndecides:"),
      ".caveman/agents/my-reviewer.json": JSON.stringify(schema),
    });
    r.write(".caveman/agents/my-reviewer.json", JSON.stringify({ type: "object" }));
    const registry = await registryAgents({ home: r.root });
    const branch = await readBranch(r.root, "main");
    const onMain = revisionFrom({ sources: branch, registry, check: checkSources({ sources: branch, registry }), name: "review", scope: "project", from: "default_branch" })!;
    expect(onMain.returnsSchemas).toEqual({ "my-reviewer": schema });
    const working = await readWorkingTree(r.root);
    expect(revisionFrom({ sources: working, registry, check: checkSources({ sources: working, registry }), name: "review", scope: "project", from: "working_tree" })!.returnsSchemas).toEqual({
      "my-reviewer": { type: "object" },
    });
  });

  it("finds the default branch from the remote's HEAD, and knows the Caveman workflow on it", async () => {
    const origin = repo({ ".github/workflows/caveman.yml": "on: push\n", ".caveman/automations/digest.yaml": DIGEST });
    const clone = repo({}, { commit: false });
    fs.rmSync(clone.root, { recursive: true, force: true });
    origin.git("clone", "-q", origin.root, clone.root);
    expect(await defaultBranchOf(clone.root)).toEqual({ name: "main", ref: "origin/main" });
    const branch = await readBranch(clone.root, "origin/main");
    expect(branch.workflow).toBe(true);
    expect(branch.files.map((f) => f.path)).toEqual([".caveman/automations/digest.yaml"]);
  });

  it("after the remote renames its default branch, reads the one that exists, not the name the clone's HEAD still points at", async () => {
    const origin = repo({ ".caveman/automations/digest.yaml": DIGEST });
    origin.git("branch", "-m", "main", "master");
    const clone = repo({}, { commit: false });
    fs.rmSync(clone.root, { recursive: true, force: true });
    origin.git("clone", "-q", origin.root, clone.root);
    origin.git("branch", "-m", "master", "main");
    clone.git("fetch", "-q", "--prune", "origin");
    expect(clone.git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim()).toBe("origin/master");
    expect(await defaultBranchOf(clone.root)).toEqual({ name: "main", ref: "origin/main" });
  });
});

describe("writing", () => {
  it("keeps Me files and state out of git without rewriting what is there", async () => {
    const r = repo();
    await ensureGitignore(r.root);
    expect(fs.readFileSync(path.join(r.root, ".caveman/.gitignore"), "utf8")).toMatch(/local\/\nstate\/\n$/);
    fs.writeFileSync(path.join(r.root, ".caveman/.gitignore"), "# mine\n*.log\n/local");
    await ensureGitignore(r.root);
    expect(fs.readFileSync(path.join(r.root, ".caveman/.gitignore"), "utf8")).toBe("# mine\n*.log\n/local\nstate/\n");
  });

  it("reads and writes only the automation and agent folders, never through a link out", async () => {
    const r = repo({ ".caveman/automations/digest.yaml": DIGEST, ".caveman/computer.toml": "[setup]\n" });
    for (const bad of [".caveman/computer.toml", ".caveman/automations/../computer.toml", "src/x.ts", "/etc/passwd"]) {
      await expect(editablePath(r.root, bad, "read"), bad).rejects.toMatchObject({ reason: "invalid_params" });
    }
    // A folder outside the repository, with a file in it.
    const outside = `${r.root}-outside`;
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "hosts"), "127.0.0.1 localhost\n");
    fs.symlinkSync(outside, path.join(r.root, ".caveman/agents"));
    await expect(editablePath(r.root, ".caveman/agents/hosts", "read")).rejects.toMatchObject({ message: expect.stringContaining("link") });
    await expect(editablePath(r.root, ".caveman/agents/x.md", "write")).rejects.toMatchObject({ message: expect.stringContaining("link") });
    // A link that stays inside the repository still leads out of the agent folder: refused too.
    fs.rmSync(path.join(r.root, ".caveman/agents"));
    fs.mkdirSync(path.join(r.root, "src"));
    fs.symlinkSync(path.join(r.root, "src"), path.join(r.root, ".caveman/agents"));
    await expect(editablePath(r.root, ".caveman/agents/x.md", "write")).rejects.toMatchObject({ message: expect.stringContaining("leads through a link (.caveman/agents)") });
    fs.symlinkSync(path.join(outside, "hosts"), path.join(r.root, ".caveman/automations/hosts.yaml"));
    await expect(editablePath(r.root, ".caveman/automations/hosts.yaml", "write")).rejects.toMatchObject({ message: expect.stringContaining("link") });
    await expect(editablePath(r.root, ".caveman/automations/missing.yaml", "read")).rejects.toMatchObject({ reason: "not_found" });
    expect(await editablePath(r.root, ".caveman/local/automations/new.yaml", "write")).toBe(path.join(r.root, ".caveman/local/automations/new.yaml"));
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("creates a template's files, writes this machine's time zone, and never overwrites a different file", async () => {
    const r = repo();
    const issueToPr = templates.find((t) => t.id === "issue-to-pr")!;
    const first = await createFromTemplate(r.root, issueToPr, "project");
    expect(first).toMatchObject({ name: "issue-to-pr", path: ".caveman/automations/issue-to-pr.yaml", renamed: [] });
    expect(first.written).toEqual([".caveman/agents/clarifier.md", ".caveman/agents/issue-triage.md", ".caveman/automations/issue-to-pr.yaml"]);
    expect(fs.readFileSync(path.join(r.root, ".caveman/.gitignore"), "utf8")).toContain("local/");
    // Same files again: nothing written. A tuned agent is kept, and the new copy takes the next name.
    expect((await createFromTemplate(r.root, issueToPr, "project")).written).toEqual([]);
    r.write(".caveman/agents/clarifier.md", "---\ndescription: tuned\n---\nMine.\n");
    r.write(".caveman/automations/issue-to-pr.yaml", "steps: {}\n");
    const second = await createFromTemplate(r.root, issueToPr, "project");
    expect(second.name).toBe("issue-to-pr-2");
    expect(second.renamed).toEqual([{ from: "clarifier", to: "clarifier-2" }, { from: "issue-to-pr", to: "issue-to-pr-2" }]);
    const text = fs.readFileSync(path.join(r.root, ".caveman/automations/issue-to-pr-2.yaml"), "utf8");
    expect(text).toContain("agent: clarifier-2");
    expect(fs.readFileSync(path.join(r.root, ".caveman/agents/clarifier.md"), "utf8")).toContain("Mine.");

    const digest = templates.find((t) => t.id === "morning-digest")!;
    const me = await createFromTemplate(r.root, digest, "me", "America/Denver");
    expect(me.path).toBe(".caveman/local/automations/morning-digest.yaml");
    const written = fs.readFileSync(path.join(r.root, me.path), "utf8");
    expect(written).toBe(digest.files[0]!.text.replace("timezone: Europe/Amsterdam", "timezone: America/Denver"));
  });

  it("creates a file from text under a free name, and refuses a name that cannot be one", async () => {
    const r = repo({ ".caveman/automations/digest.yaml": "steps: {}\n" });
    expect(await createFromText(r.root, "digest", DIGEST, "project")).toMatchObject({ name: "digest-2", renamed: [{ from: "digest", to: "digest-2" }] });
    await expect(createFromText(r.root, "Bad Name", DIGEST, "me")).rejects.toMatchObject({ reason: "invalid_params" });
  });
});

describe("the files service", () => {
  const run = <A>(projects: Record<string, string>, body: Effect.Effect<A, never, AutomationFiles | AutomationProjects | Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(layer.pipe(Layer.provide(projectStoreFor(projects)))))));

  it("sees an edit made in any editor within a second, and answers a live check from memory", async () => {
    const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
    await run(
      { "caveman-repo:p1": r.root },
      Effect.gen(function* () {
        const files = yield* AutomationFiles;
        const projects = yield* AutomationProjects;
        expect((yield* files.load("caveman-repo:p1")).automations.map((a) => a.name)).toEqual(["digest"]);
        const changed = yield* files.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
        yield* Effect.sleep("100 millis");
        fs.writeFileSync(path.join(r.root, ".caveman/automations/second.yaml"), DIGEST);
        const started = Date.now();
        expect(yield* Fiber.join(changed)).toEqual([{ projectId: "caveman-repo:p1" }]);
        expect(Date.now() - started).toBeLessThan(1_500);
        expect((yield* files.load("caveman-repo:p1")).automations.map((a) => a.name).sort()).toEqual(["digest", "second"]);
        // Warm: a check with unsaved text reads nothing from disk.
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) yield* projects.check(r.root, [{ path: ".caveman/automations/digest.yaml", text: DIGEST.replace("6h", `${i + 6}h`) }]);
        expect((performance.now() - t0) / 20).toBeLessThan(100);
      }),
    );
  });

  it("sees, within a second and with no poll, a folder made after the watch began: .caveman, a new worktree's draft, origin's head", async () => {
    const r = repo();
    const worktree = `${r.root}-wt`;
    repos.push({ ...r, remove: () => fs.rmSync(worktree, { recursive: true, force: true }) });
    await run(
      { "caveman-repo:p1": r.root },
      Effect.gen(function* () {
        const files = yield* AutomationFiles;
        const projects = yield* AutomationProjects;
        expect((yield* files.load("caveman-repo:p1")).automations).toEqual([]);
        const seen = (change: () => void) =>
          Effect.gen(function* () {
            const next = yield* files.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
            yield* Effect.sleep("150 millis");
            const started = Date.now();
            change();
            expect(yield* Fiber.join(next)).toEqual([{ projectId: "caveman-repo:p1" }]);
            expect(Date.now() - started).toBeLessThan(1_500);
            // Settled before the next change, so its event is not this one's.
            yield* Effect.sleep("150 millis");
          });
        // .caveman did not exist when the watch began: its creation, then an edit inside it.
        yield* seen(() => r.write(".caveman/automations/digest.yaml", DIGEST));
        yield* seen(() => r.write(".caveman/automations/digest.yaml", DIGEST.replace("6h", "7h")));
        expect((yield* files.load("caveman-repo:p1")).automations.map((a) => a.name)).toEqual(["digest"]);
        // A worktree added since, and a draft written in it.
        yield* seen(() => r.git("worktree", "add", "-q", "-b", "chat-1", worktree));
        yield* seen(() => {
          fs.mkdirSync(path.join(worktree, ".caveman/automations"), { recursive: true });
          fs.writeFileSync(path.join(worktree, ".caveman/automations/draft.yaml"), DIGEST);
        });
        expect((yield* projects.drafts(r.root)).map((d) => d.path)).toEqual([".caveman/automations/draft.yaml"]);
        // A fetch moving origin's head, in a repository that had no remote refs before.
        r.commit("digest");
        yield* seen(() => r.git("update-ref", "refs/remotes/origin/main", "HEAD"));
      }),
    );
  });

  it("writes through the service and answers with what check finds", async () => {
    const r = repo();
    await run(
      { "caveman-repo:p1": r.root },
      Effect.gen(function* () {
        const files = yield* AutomationFiles;
        const diagnostics = yield* files.write("caveman-repo:p1", ".caveman/automations/digest.yaml", DIGEST.replace("computer: none", "computer: nowhere"));
        expect(diagnostics.map((d) => d.code)).toEqual(["computer-invalid"]);
        expect(yield* files.read("caveman-repo:p1", ".caveman/automations/digest.yaml")).toContain("nowhere");
        const revision = yield* files.revision("caveman-repo:p1", "digest", "project", "working_tree");
        // It saved with an error, like an editor; it does not load until fixed.
        expect(revision).toBeUndefined();
      }),
    );
  });

  describe("a git read of the default branch that fails once", () => {
    let shim: ReturnType<typeof gitFailing>;
    beforeEach(() => {
      shim = gitFailing();
    });
    afterEach(() => shim.restore());

    it("is read again on the next look, not kept until the default branch moves", async () => {
      const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
      await run(
        { "caveman-repo:p1": r.root },
        Effect.gen(function* () {
          const projects = yield* AutomationProjects;
          shim.failNext("cat-file");
          expect((yield* projects.branch(r.root)).sources).toBeUndefined();
          expect(shim.failed()).toBe(true);
          expect((yield* projects.branch(r.root)).sources?.files.map((f) => f.path)).toEqual([".caveman/automations/digest.yaml"]);
        }),
      );
    });

    it("serves the copy read last when it fails after the default branch moved", async () => {
      const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
      await run(
        { "caveman-repo:p1": r.root },
        Effect.gen(function* () {
          const projects = yield* AutomationProjects;
          const paths = (view: { readonly sources?: { readonly files: ReadonlyArray<{ readonly path: string }> } | undefined }) => view.sources?.files.map((f) => f.path);
          expect(paths(yield* projects.branch(r.root))).toEqual([".caveman/automations/digest.yaml"]);
          r.write(".caveman/automations/second.yaml", DIGEST);
          r.commit("second");
          shim.failNext("cat-file");
          const failed = yield* projects.branch(r.root);
          expect(shim.failed()).toBe(true);
          expect(failed).not.toHaveProperty("unreadable");
          expect(paths(failed)).toEqual([".caveman/automations/digest.yaml"]);
          expect(paths(yield* projects.branch(r.root))).toEqual([".caveman/automations/digest.yaml", ".caveman/automations/second.yaml"]);
        }),
      );
    });

    it("fails the read, and never crashes the runtime, when cat-file dies before it reads a list longer than a pipe holds", async () => {
      // 2000 object ids are 82 KB on cat-file's stdin, more than the 64 KiB a pipe holds before its reader takes some.
      const r = repo();
      const agents = Array.from({ length: 2000 }, (_, i) => `M 100644 inline .caveman/agents/a${i}.md\ndata <<END\n---\ndescription: Agent ${i}\n---\nDo ${i}.\nEND\n`);
      execFileSync("git", ["-C", r.root, "fast-import", "--quiet"], {
        input: `commit refs/heads/main\ncommitter Test <test@caveman.so> 1767225600 +0000\ndata <<END\nMany agents\nEND\nfrom refs/heads/main^0\n${agents.join("")}\n`,
      });
      const uncaught: unknown[] = [];
      const record = (error: unknown) => void uncaught.push(error);
      process.on("uncaughtException", record);
      try {
        shim.failNext("cat-file");
        await expect(readBranch(r.root, "main")).rejects.toThrow();
        expect(shim.failed()).toBe(true);
      } finally {
        process.removeListener("uncaughtException", record);
      }
      expect(uncaught).toEqual([]);
      expect((await readBranch(r.root, "main")).files).toHaveLength(2000);
    });

    it("is never taken for a default branch with no automation files", async () => {
      const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
      await run(
        { "caveman-repo:p1": r.root },
        Effect.gen(function* () {
          const projects = yield* AutomationProjects;
          shim.failNext("ls-tree");
          expect(yield* projects.branch(r.root)).toEqual({ branch: { name: "main", ref: "main" }, sources: undefined, workflow: false, unreadable: true });
          expect(shim.failed()).toBe(true);
          expect((yield* projects.branch(r.root)).sources?.files.map((f) => f.path)).toEqual([".caveman/automations/digest.yaml"]);
          expect((yield* projects.revisionAt(r.root, "digest", "project", "default_branch")).revision?.from).toBe("default_branch");
        }),
      );
    });
  });

  describe("a git that does not answer which branch is the default", () => {
    let shim: ReturnType<typeof gitFailing>;
    beforeEach(() => {
      shim = gitFailing();
    });
    afterEach(() => shim.restore());

    /** A clone whose origin's default branch is develop, though origin/main exists too, with older files. */
    const developClone = () => {
      const origin = repo({ ".caveman/automations/digest.yaml": DIGEST });
      origin.git("checkout", "-q", "-b", "develop");
      origin.write(".caveman/automations/second.yaml", DIGEST);
      origin.commit("second");
      const clone = repo({}, { commit: false });
      fs.rmSync(clone.root, { recursive: true, force: true });
      origin.git("clone", "-q", origin.root, clone.root);
      return clone;
    };
    /** Runs `body` with no git on PATH, so every git call fails to start, as one spawned when the process table is full does. */
    const withoutGit = async <A>(body: () => Promise<A>): Promise<A> => {
      const saved = process.env.PATH;
      process.env.PATH = path.join(path.sep, "caveman-no-git-here");
      try {
        return await body();
      } finally {
        process.env.PATH = saved;
      }
    };

    it("is unknown: never 'no default branch', and never a guess at one", async () => {
      const clone = developClone();
      expect(await defaultBranchOf(clone.root)).toEqual({ name: "develop", ref: "origin/develop" });
      shim.failNext("symbolic-ref", 1, "killed");
      await expect(defaultBranchOf(clone.root)).rejects.toThrow();
      expect(shim.failed()).toBe(true);
      await withoutGit(() => expect(defaultBranchOf(clone.root)).rejects.toMatchObject({ code: "ENOENT" }));
      // git answers for a folder that is not a checkout: it has no default branch.
      const plain = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(clone.root), "caveman-not-git-")));
      try {
        expect(await defaultBranchOf(plain)).toBeUndefined();
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
    });

    it("keeps the default branch git named last, files and all, while git cannot answer", async () => {
      const clone = developClone();
      await run(
        { "caveman-repo:p1": clone.root },
        Effect.gen(function* () {
          const projects = yield* AutomationProjects;
          const good = yield* projects.branch(clone.root);
          expect(good.branch).toEqual({ name: "develop", ref: "origin/develop" });
          expect(good.sources?.files.map((f) => f.path)).toEqual([".caveman/automations/digest.yaml", ".caveman/automations/second.yaml"]);
          // Asked again (the cache is dropped, as an edit to .caveman/ drops it): only symbolic-ref dies.
          yield* projects.invalidate(clone.root);
          shim.failNext("symbolic-ref", 1, "killed");
          expect(yield* projects.branch(clone.root)).toEqual(good);
          expect(shim.failed()).toBe(true);
          // No git call starts at all.
          yield* projects.invalidate(clone.root);
          expect(yield* Effect.promise(() => withoutGit(() => Effect.runPromise(projects.branch(clone.root))))).toEqual(good);
        }),
      );
    });

    it("is unknown, not absent, when git never named it, and is asked again on the next look", async () => {
      const r = repo({ ".caveman/automations/digest.yaml": DIGEST });
      await run(
        { "caveman-repo:p1": r.root },
        Effect.gen(function* () {
          const projects = yield* AutomationProjects;
          expect(yield* Effect.promise(() => withoutGit(() => Effect.runPromise(projects.branch(r.root))))).toEqual({ branch: undefined, sources: undefined, workflow: false, unreadable: true });
          const view = yield* projects.branch(r.root);
          expect(view.branch).toEqual({ name: "main", ref: "main" });
          expect(view.sources?.files.map((f) => f.path)).toEqual([".caveman/automations/digest.yaml"]);
        }),
      );
    });
  });
});
