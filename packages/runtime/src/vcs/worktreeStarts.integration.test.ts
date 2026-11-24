// Many chats starting on one repository in the same instant (docs/ SPEC §8.3,
// finding P3): real git, a repository of a few thousand files, and the runtime's own ways to make, drop and
// prune worktrees. Git registers a worktree in several unlocked steps, and each `git worktree` command first
// reads every registration, so without one lock per repository some of these die on a half-written one.
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { gitOf, makeCopy, removeCopy, SAFE_GIT_CONFIG, trustedGit } from "../automations/steps.ts";
import * as ServerConfig from "../config.ts";
import { git as lifecycleGit } from "../session-protocol/lifecycle.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";

type Driver = GitVcsDriver.GitVcsDriver["Service"];

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "worktree-starts-test-",
});
const layerPlatform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(layerPlatform),
);

const sh = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const tmpDir = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // Git lists worktrees by their real path, and macOS temp folders sit behind a symlink.
    return yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped({ prefix }));
  });

/** A repository on main with one commit of `files` files in folders of 50. */
const makeRepository = (files: number) =>
  Effect.gen(function* () {
    const repo = yield* tmpDir("worktree-starts-repo-");
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "test@caveman.so");
    sh(repo, "config", "user.name", "Test");
    for (let i = 0; i < files; i++) {
      const dir = NodePath.join(repo, "src", `module-${Math.floor(i / 50)}`);
      if (i % 50 === 0) NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(dir, `file-${i}.ts`),
        `export const value${i} = ${JSON.stringify("x".repeat(200 + (i % 7) * 40))};\n`,
      );
    }
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "init");
    return { repo, head: sh(repo, "rev-parse", "HEAD") };
  });

/** What session-protocol/handlers.ts worktreeOnComputer runs for a chat's new branch on a Cloud computer. */
const cloudWorktree = (driver: Driver, root: string, at: string, branch: string, baseRef: string) =>
  lifecycleGit(driver, root, [...SAFE_GIT_CONFIG, "worktree", "prune"], {
    allowNonZeroExit: true,
  }).pipe(
    Effect.ignore,
    Effect.andThen(
      lifecycleGit(driver, root, [
        ...SAFE_GIT_CONFIG,
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        at,
        baseRef,
      ]),
    ),
    Effect.asVoid,
  );

/** A chat's worktree on This Mac: a new branch off `baseRef`, through the driver. */
const macWorktree = (driver: Driver, root: string, at: string, branch: string, baseRef: string) =>
  driver
    .createWorktree({ cwd: root, refName: baseRef, newRefName: branch, path: at })
    .pipe(Effect.asVoid);

/** One worktree as git lists it: its path and the branch it is on (null: detached). */
type Listed = readonly [path: string, branch: string | null];
const byPath = (entries: ReadonlyArray<Listed>) =>
  entries.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** Every worktree git lists for `repo`. */
const listedWorktrees = (repo: string) =>
  byPath(
    sh(repo, "worktree", "list", "--porcelain")
      .split("\n\n")
      .map((entry): Listed => [
        /^worktree (.+)$/m.exec(entry)![1]!,
        /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] ?? null,
      ]),
  );

const failures = (
  exits: ReadonlyArray<Exit.Exit<unknown, unknown>>,
  names: ReadonlyArray<string>,
) =>
  exits.flatMap((exit, index) =>
    Exit.isFailure(exit) ? [`${names[index]}: ${Cause.pretty(exit.cause).split("\n")[0]}`] : [],
  );

describe("worktrees of one repository, asked for at once", () => {
  it.live(
    "gives 64 chats that start together each their own worktree, on its branch and clean",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { repo, head } = yield* makeRepository(3_000);
        const dir = yield* tmpDir("worktree-starts-");
        const starts = Array.from({ length: 64 }, (_, index) => ({
          branch: `caveman/start-${index}`,
          at: NodePath.join(dir, `start-${index}`),
          // Every other chat starts as on a Cloud computer, the rest as on This Mac.
          cloud: index % 2 === 1,
        }));

        const exits = yield* Effect.forEach(
          starts,
          (start) =>
            Effect.exit(
              (start.cloud ? cloudWorktree : macWorktree)(
                driver,
                repo,
                start.at,
                start.branch,
                "main",
              ),
            ),
          { concurrency: "unbounded" },
        );

        assert.deepEqual(
          failures(
            exits,
            starts.map((start) => start.branch),
          ),
          [],
        );
        for (const start of starts) {
          assert.equal(sh(start.at, "symbolic-ref", "--short", "HEAD"), start.branch);
          assert.equal(sh(start.at, "rev-parse", "HEAD"), head);
          assert.equal(sh(start.at, "status", "--porcelain"), "", `${start.branch} is clean`);
          assert.equal(sh(start.at, "ls-files").split("\n").length, 3_000);
        }
        assert.deepEqual(
          listedWorktrees(repo),
          byPath([[repo, "main"], ...starts.map((start): Listed => [start.at, start.branch])]),
        );
      }).pipe(Effect.provide(layerTest)),
    // Generous: 64 checkouts of 3,000 files on a machine that is doing other work.
    900_000,
  );

  it.live(
    "keeps every registration when worktrees are made, removed and pruned at once",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const automationGit = trustedGit(gitOf(driver));
        const { repo, head } = yield* makeRepository(400);
        const dir = yield* tmpDir("worktree-churn-");
        const at = (name: string) => NodePath.join(dir, name);
        // Worktrees from before: the chats' go through the driver, the automation copies through automations' git.
        const leaving = Array.from({ length: 12 }, (_, index) => `leaving-${index}`);
        for (const name of leaving) sh(repo, "worktree", "add", "-q", "--detach", at(name), "main");
        const starting = Array.from({ length: 24 }, (_, index) => `starting-${index}`);
        const copies = Array.from({ length: 8 }, (_, index) => `copy-${index}`);

        const work: ReadonlyArray<
          readonly [name: string, effect: Effect.Effect<unknown, unknown>]
        > = [
          ...starting.map(
            (name, index) =>
              [
                name,
                (index % 2 === 1 ? cloudWorktree : macWorktree)(
                  driver,
                  repo,
                  at(name),
                  `caveman/${name}`,
                  "main",
                ),
              ] as const,
          ),
          ...copies.map((name) => [name, makeCopy(automationGit, repo, at(name), head)] as const),
          ...leaving.map(
            (name, index) =>
              [
                name,
                index % 2 === 1
                  ? removeCopy(automationGit, repo, at(name))
                  : driver.removeWorktree({ cwd: repo, path: at(name), force: true }),
              ] as const,
          ),
          ...Array.from(
            { length: 8 },
            () => ["prune", driver.pruneWorktrees({ cwd: repo })] as const,
          ),
        ];
        const exits = yield* Effect.all(
          work.map(([, effect]) => Effect.exit(effect)),
          { concurrency: "unbounded" },
        );

        assert.deepEqual(
          failures(
            exits,
            work.map(([name]) => name),
          ),
          [],
        );
        assert.deepEqual(
          listedWorktrees(repo),
          byPath([
            [repo, "main"],
            ...starting.map((name): Listed => [at(name), `caveman/${name}`]),
            ...copies.map((name): Listed => [at(name), null]),
          ]),
        );
        for (const name of [...starting, ...copies])
          assert.equal(sh(at(name), "status", "--porcelain"), "", `${name} is clean`);
        for (const name of leaving) assert.isFalse(NodeFS.existsSync(at(name)), `${name} is gone`);
      }).pipe(Effect.provide(layerTest)),
    900_000,
  );
});

describe("a worktree another git is still registering", () => {
  /**
   * A worktree as `git worktree add` leaves it partway through registering: git lists it, and dies reading its
   * empty commondir. Git run outside the runtime, such as an agent's own, can leave one for an instant.
   */
  const halfRegistered = (repo: string, name: string) => {
    const admin = NodePath.join(repo, ".git", "worktrees", name);
    NodeFS.mkdirSync(admin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(admin, "locked"), "initializing\n");
    NodeFS.writeFileSync(
      NodePath.join(admin, "gitdir"),
      `${NodePath.join(repo, "..", name, ".git")}\n`,
    );
    NodeFS.writeFileSync(NodePath.join(admin, "HEAD"), `${"0".repeat(40)}\n`);
    NodeFS.writeFileSync(NodePath.join(admin, "commondir"), "");
    return { finish: () => NodeFS.writeFileSync(NodePath.join(admin, "commondir"), "../..\n") };
  };

  /** A driver whose git, each time a `worktree add` fails, runs `afterFailure` first: the other git's next step. */
  const driverWhereAddsFail = (afterFailure: (failed: number) => void) =>
    Effect.gen(function* () {
      const failed = yield* Ref.make(0);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("worktree") ||
            !command.args.includes("add")
          )
            return handle;
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: handle.exitCode.pipe(
              Effect.tap((exitCode) =>
                exitCode === 0
                  ? Effect.void
                  : Ref.updateAndGet(failed, (count) => count + 1).pipe(
                      Effect.flatMap((count) => Effect.sync(() => afterFailure(count))),
                    ),
              ),
            ),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      return { driver, failed };
    });

  it.live("is waited out by a chat's worktree on This Mac", () =>
    Effect.gen(function* () {
      const { repo, head } = yield* makeRepository(20);
      const at = NodePath.join(yield* tmpDir("worktree-race-"), "chat");
      const other = halfRegistered(repo, "other");
      const { driver, failed } = yield* driverWhereAddsFail(() => other.finish());

      yield* driver.createWorktree({
        cwd: repo,
        refName: "main",
        newRefName: "caveman/chat",
        path: at,
      });

      assert.equal(yield* Ref.get(failed), 1);
      assert.equal(sh(at, "symbolic-ref", "--short", "HEAD"), "caveman/chat");
      assert.equal(sh(at, "rev-parse", "HEAD"), head);
      assert.equal(sh(at, "status", "--porcelain"), "");
    }).pipe(Effect.provide(layerPlatform)),
  );

  it.live(
    "is waited out by a Cloud computer's worktree, which takes the branch its first try made",
    () =>
      Effect.gen(function* () {
        const { repo, head } = yield* makeRepository(20);
        const at = NodePath.join(yield* tmpDir("worktree-race-"), "chat");
        const other = halfRegistered(repo, "other");
        // Twice: the first rerun still meets the half-written registration.
        const { driver, failed } = yield* driverWhereAddsFail((count) =>
          count === 2 ? other.finish() : undefined,
        );

        // `worktree add -b` makes its branch before it reads the registrations, so a plain rerun would be refused:
        // "a branch named 'caveman/chat' already exists".
        yield* cloudWorktree(driver, repo, at, "caveman/chat", "main");

        assert.equal(yield* Ref.get(failed), 2);
        assert.equal(sh(at, "symbolic-ref", "--short", "HEAD"), "caveman/chat");
        assert.equal(sh(at, "rev-parse", "HEAD"), head);
        assert.equal(sh(at, "status", "--porcelain"), "");
      }).pipe(Effect.provide(layerPlatform)),
  );

  it.live("never hands a chat a branch that is not the one its failed try made", () =>
    Effect.gen(function* () {
      const { repo } = yield* makeRepository(20);
      const dir = yield* tmpDir("worktree-race-");
      NodeFS.writeFileSync(NodePath.join(repo, "later.txt"), "later\n");
      sh(repo, "add", ".");
      sh(repo, "commit", "-qm", "later");
      const other = halfRegistered(repo, "other");
      // Someone else's branch of the same name, elsewhere in history, appears between the tries.
      const { driver, failed } = yield* driverWhereAddsFail(() => {
        other.finish();
        sh(repo, "update-ref", "refs/heads/caveman/chat", "main~1");
      });

      const error = yield* cloudWorktree(
        driver,
        repo,
        NodePath.join(dir, "chat"),
        "caveman/chat",
        "main",
      ).pipe(Effect.flip);

      assert.include(error.message, "branch_already_exists");
      assert.equal(yield* Ref.get(failed), 2);
      assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "chat")));
      assert.equal(sh(repo, "rev-parse", "caveman/chat"), sh(repo, "rev-parse", "main~1"));
    }).pipe(Effect.provide(layerPlatform)),
  );

  it.live("is not waited for when a branch name is simply taken", () =>
    Effect.gen(function* () {
      const { repo } = yield* makeRepository(20);
      const dir = yield* tmpDir("worktree-race-");
      sh(repo, "branch", "caveman/taken", "main");
      const { driver, failed } = yield* driverWhereAddsFail(() => undefined);

      const error = yield* cloudWorktree(
        driver,
        repo,
        NodePath.join(dir, "chat"),
        "caveman/taken",
        "main",
      ).pipe(Effect.flip);

      assert.include(error.message, "branch_already_exists");
      assert.equal(yield* Ref.get(failed), 1);
    }).pipe(Effect.provide(layerPlatform)),
  );
});
