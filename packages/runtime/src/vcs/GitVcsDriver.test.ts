// ), apps/server/src/vcs/GitVcsDriver.test.ts @ ab3a3cd1; perf from 67e05acf81, 55ba1baa55, ce87dc79fb.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as Metric from "effect/Metric";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@caveman-app/shared/HostProcess";

import { CheckpointRef, GitCommandError, VcsProcessExitError } from "@caveman-app/protocol";
import { symlinksSupported } from "@caveman-app/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import { gitCommandDuration, gitCommandsTotal } from "../observability/Metrics.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";
import { snapshotTree, treeDiff } from "../testUtils/fileTree.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerGitCaptureContract = Layer.merge(
  layerGitContract,
  ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

const makeCaptureStore = Effect.fn("test.makeCaptureStore")(function* (
  driver: VcsDriver.VcsDriver["Service"],
  cwd: string,
) {
  const repository = yield* driver.detectRepository(cwd);
  if (repository === null) return yield* Effect.die("Expected a test Git repository");
  const handle = { kind: repository.kind, repository, driver };
  return yield* CheckpointStore.make.pipe(
    Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
      get: () => Effect.succeed(driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
});

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: layerGitContract,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("lists the fetch and push URLs of a partial clone remote", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-partial-clone-remotes-",
    });
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["remote", "add", "origin", "https://github.com/acme/example-app.git"]);
    yield* runGit(cwd, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "git@github.com:octocat/t3code.git",
    ]);
    yield* runGit(cwd, ["config", "remote.origin.promisor", "true"]);
    yield* runGit(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

    const result = yield* driver.listRemotes(cwd);
    assert.deepEqual(result.remotes, [
      {
        name: "origin",
        url: "https://github.com/acme/example-app.git",
        pushUrl: Option.some("git@github.com:octocat/t3code.git"),
        isPrimary: true,
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect("checkpoint capture skips untracked nested repositories without a commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-unborn-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const nested = "scratch/empty [repo]";
    yield* git(["init", nested]);
    yield* git(["init", "another empty"]);
    yield* fileSystem.writeFileString(path.join(cwd, nested, "private.txt"), "nested\n");
    yield* git(["init", "committed"]);
    yield* git([
      "-C",
      "committed",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const nestedHead = (yield* git(["-C", "committed", "rev-parse", "HEAD"])).stdout.trim();
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", nested])).stdout, "");
    assert.strictEqual((yield* git(["ls-tree", checkpointRef, "--", "another empty"])).stdout, "");
    assert.strictEqual(
      (yield* git(["ls-tree", checkpointRef, "--", "committed"])).stdout,
      `160000 commit ${nestedHead}\tcommitted\n`,
    );
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(cwd, nested, "private.txt")),
      "nested\n",
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(!symlinksSupported)(
  "checkpoint capture writes its index into the real git dir when cwd is a symlinked subdirectory",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveRunner = yield* ProcessRunner.ProcessRunner;
      const indexFiles: string[] = [];
      const captureProcess = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            const indexFile = input.env?.GIT_INDEX_FILE;
            if (indexFile !== undefined) indexFiles.push(indexFile);
            return liveRunner.run(input);
          },
        }),
      );
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, captureProcess),
      );
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-checkpoint-symlink-",
      });
      const repo = path.join(sandbox, "repo");
      const subdir = path.join(repo, "sub", "dir");
      const link = path.join(sandbox, "nest", "link");
      yield* fileSystem.makeDirectory(subdir, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
      yield* fileSystem.symlink(subdir, link);
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, repo);
      // Git returns ../../.git from the target; resolving it against the link reaches the decoy.
      yield* git(["-C", sandbox, "init"]);
      yield* fileSystem.writeFileString(path.join(subdir, "nested.txt"), "from-link\n");
      const realCommonDir = yield* fileSystem.realPath(path.join(repo, ".git"));

      yield* driver.checkpoints.captureCheckpoint({ cwd: link, checkpointRef });

      assert.isTrue(indexFiles.length > 0);
      for (const indexFile of indexFiles) {
        assert.strictEqual(yield* fileSystem.realPath(path.dirname(indexFile)), realCommonDir);
      }
      assert.strictEqual(
        (yield* git(["show", `${checkpointRef}:sub/dir/nested.txt`])).stdout,
        "from-link\n",
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitCaptureContract)),
);

it.effect("checkpoint capture keeps the shared index a split index still uses", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-split-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["config", "core.splitIndex", "true"]);
    yield* git(["config", "splitIndex.sharedIndexExpire", "now"]);
    yield* git(["update-index", "--split-index"]);
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    // The real index points at a sharedindex.* file. Reading it fails if the capture expired it.
    assert.strictEqual((yield* git(["ls-files", "--cached"])).stdout, "file.txt\n");
    assert.strictEqual((yield* git(["diff", "--cached", "--name-only"])).stdout, "file.txt\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint recovery discovers nested HEAD independently of inherited GIT_DIR", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-git-dir-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.GIT_DIR;
        process.env.GIT_DIR = path.join(cwd, ".git");
        return previous;
      }),
      () => driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GIT_DIR;
          else process.env.GIT_DIR = previous;
        }),
    );
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", "empty"])).stdout, "");
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture still fails when a clean filter rejects a file", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-checkpoint-filter-failure-",
    });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "file.txt filter=reject\n");
    yield* git(["config", "filter.reject.clean", "false"]);
    yield* git(["config", "filter.reject.required", "true"]);
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    const result = yield* Effect.result(
      driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "VcsProcessExitError");
    }
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("a rollback's ref deletion fails while Git keeps the ref, and succeeds on retry", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-delete-" });
    yield* makeCheckpointFixture(driver, cwd);
    const checkpointRefs = [3, 4].map((ordinal) =>
      CheckpointRef.make(`refs/t3/checkpoints/test/turn/${ordinal}`),
    );
    for (const checkpointRef of checkpointRefs) {
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    }
    // A gc, pack-refs or fetch --prune in another process holds this past Git's one-second wait.
    const packedRefsLock = path.join(cwd, ".git", "packed-refs.lock");
    yield* fileSystem.writeFileString(packedRefsLock, "");

    const locked = yield* Effect.result(
      driver.checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs }),
    );

    assert.strictEqual(locked._tag, "Failure");
    if (locked._tag === "Failure") {
      assert.strictEqual(locked.failure._tag, "VcsProcessExitError");
    }
    for (const checkpointRef of checkpointRefs) {
      assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    }

    yield* fileSystem.remove(packedRefsLock);
    yield* driver.checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs });
    for (const checkpointRef of checkpointRefs) {
      assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    }
    // A retried rollback deletes refs an earlier attempt already removed.
    yield* driver.checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs });
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([
  { change: "none", fresh: true, snapshot: false },
  { change: "none", fresh: false, snapshot: true },
  { change: "untracked", fresh: true, snapshot: true },
  { change: "untracked, hidden by status config", fresh: true, snapshot: true },
  { change: "ignored", fresh: true, snapshot: true },
  { change: "modified", fresh: true, snapshot: true },
  { change: "staged", fresh: true, snapshot: true },
  { change: "modified, flagged assume-unchanged", fresh: true, snapshot: true },
] as const)(
  "a worktree's baseline is HEAD's tree only when it is fresh and verifiably clean (change: $change, fresh: $fresh)",
  ({ change, fresh, snapshot }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-fresh-" });
      const repo = path.join(root, "repo");
      const cwd = path.join(root, "chat");
      yield* fs.makeDirectory(repo);
      const git = (at: string, args: ReadonlyArray<string>) => driver.execute({ operation: "checkpoint-test", cwd: at, args });
      yield* git(repo, ["init"]);
      yield* git(repo, ["config", "user.name", "Test"]);
      yield* git(repo, ["config", "user.email", "test@test.com"]);
      yield* fs.writeFileString(path.join(repo, "file.txt"), "initial\n");
      yield* fs.writeFileString(path.join(repo, ".gitignore"), "*.log\n");
      yield* git(repo, ["add", "."]);
      yield* git(repo, ["commit", "-m", "initial"]);
      // The chat's worktree, as the app makes it.
      yield* git(repo, ["worktree", "add", "-b", "chat", cwd]);
      if (change === "untracked") yield* fs.writeFileString(path.join(cwd, "new.txt"), "new\n");
      if (change === "untracked, hidden by status config") {
        yield* git(cwd, ["config", "status.showUntrackedFiles", "no"]);
        yield* fs.writeFileString(path.join(cwd, "new.txt"), "new\n");
      }
      if (change === "ignored") yield* fs.writeFileString(path.join(cwd, "debug.log"), "setup wrote this\n");
      if (change === "modified") yield* fs.writeFileString(path.join(cwd, "file.txt"), "changed\n");
      if (change === "staged") {
        yield* fs.writeFileString(path.join(cwd, "file.txt"), "staged\n");
        yield* git(cwd, ["add", "file.txt"]);
      }
      if (change === "modified, flagged assume-unchanged") {
        yield* git(cwd, ["update-index", "--assume-unchanged", "file.txt"]);
        yield* fs.writeFileString(path.join(cwd, "file.txt"), "hidden from status\n");
      }
      let snapshots = 0;
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            if (input.args.includes("add") && input.args.includes("-A")) snapshots++;
            return liveProcess.run(input);
          },
        }),
      );
      const baseline = CheckpointRef.make("refs/t3/checkpoints/baseline");
      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef: baseline, fresh });
      assert.strictEqual(snapshots, snapshot ? 1 : 0);
      // Exactly what a snapshot holds, HEAD its parent.
      const full = CheckpointRef.make("refs/t3/checkpoints/full");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: full });
      const read = (rev: string) => git(cwd, ["rev-parse", rev]).pipe(Effect.map((result) => result.stdout.trim()));
      assert.strictEqual(yield* read(`${baseline}^{tree}`), yield* read(`${full}^{tree}`));
      assert.strictEqual(yield* read(`${baseline}^`), yield* read("HEAD"));
      if (!snapshot) assert.strictEqual(yield* read(`${baseline}^{tree}`), yield* read("HEAD^{tree}"));
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture keeps LF files that core.safecrlf would refuse to commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-safecrlf-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "*.txt text eol=crlf\n");
    yield* git(["config", "core.safecrlf", "true"]);
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture refuses a truncated nested repository listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-truncated-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          liveProcess
            .run(input)
            .pipe(
              Effect.map((result) =>
                input.args.includes("--others") ? { ...result, stdoutTruncated: true } : result,
              ),
            ),
      }),
    );

    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture skips an ignored project while keeping its allowed sibling", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ignored-" });
    const { git } = yield* makeCheckpointFixture(driver, parent);
    yield* fs.writeFileString(
      path.join(parent, ".gitignore"),
      "*\n!.gitignore\n!file.txt\n!keep/\n!keep/**\n",
    );
    const ignoredCwd = path.join(parent, "ignored");
    const keepCwd = path.join(parent, "keep");
    yield* fs.makeDirectory(ignoredCwd);
    yield* fs.makeDirectory(keepCwd);
    yield* fs.writeFileString(path.join(ignoredCwd, "secret.txt"), "private\n");
    yield* fs.writeFileString(path.join(keepCwd, "new.txt"), "new\n");
    const originalIndex = yield* fs.readFile(path.join(parent, ".git", "index"));
    const ignoredRef = CheckpointRef.make("refs/t3/checkpoints/ignored");
    const keepRef = CheckpointRef.make("refs/t3/checkpoints/keep");

    const ignored = yield* Effect.result(
      driver.checkpoints.captureCheckpoint({ cwd: ignoredCwd, checkpointRef: ignoredRef }),
    );
    yield* driver.checkpoints.captureCheckpoint({ cwd: keepCwd, checkpointRef: keepRef });

    assert.strictEqual((yield* git(["show", `${keepRef}:keep/new.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", keepRef, "--", "ignored"])).stdout, "");
    assert.isFalse(
      yield* driver.checkpoints.hasCheckpointRef({ cwd: parent, checkpointRef: ignoredRef }),
    );
    assert.deepEqual(yield* fs.readFile(path.join(parent, ".git", "index")), originalIndex);
    assert.strictEqual(ignored._tag, "Failure");
    if (ignored._tag === "Failure") {
      assert.strictEqual(ignored.failure._tag, "VcsUnsupportedOperationError");
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([
  { tracking: "committed-only", committed: ["committed.txt"], staged: [] },
  { tracking: "staged-only", committed: [], staged: ["staged.txt"] },
  { tracking: "mixed", committed: ["committed.txt"], staged: ["staged.txt"] },
])(
  "checkpoint capture keeps $tracking tracked edits but excludes new files in a project ignored later",
  ({ committed, staged }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ignored-later-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, parent);
      const cwd = path.join(parent, "sub");
      yield* fs.makeDirectory(cwd);
      for (const file of committed) {
        yield* fs.writeFileString(path.join(cwd, file), "committed\n");
        yield* git(["add", `sub/${file}`]);
      }
      if (committed.length > 0) {
        yield* git(["commit", "-m", "track project"]);
      }
      for (const file of staged) {
        yield* fs.writeFileString(path.join(cwd, file), "staged\n");
        yield* git(["add", `sub/${file}`]);
      }
      const tracked = [...committed, ...staged];
      yield* fs.writeFileString(path.join(parent, ".gitignore"), "sub/\n");
      for (const file of tracked) {
        yield* fs.writeFileString(path.join(cwd, file), `${file} working\n`);
      }
      yield* fs.writeFileString(path.join(cwd, "secret.txt"), "private\n");
      const originalIndex = yield* fs.readFile(path.join(parent, ".git", "index"));

      const captured = yield* Effect.result(
        driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
      );

      assert.deepEqual(yield* fs.readFile(path.join(parent, ".git", "index")), originalIndex);
      if (captured._tag === "Failure") return yield* captured.failure;
      assert.strictEqual(
        (yield* git(["ls-tree", "-r", "--name-only", checkpointRef, "--", "sub"])).stdout,
        tracked.map((file) => `sub/${file}\n`).join(""),
      );
      for (const file of tracked) {
        assert.strictEqual(
          (yield* git(["show", `${checkpointRef}:sub/${file}`])).stdout,
          `${file} working\n`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint recovery refuses excessive candidates before probing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-cap-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty0"]);
    for (let i = 1; i < 65; i++)
      yield* fs.copy(path.join(cwd, "empty0"), path.join(cwd, `empty${i}`));
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    let stageError: VcsProcessExitError | undefined;
    let nestedProbes = 0;
    let stageAttempts = 0;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.cwd !== cwd && input.args.includes("rev-parse")) nestedProbes++;
          if (input.args.includes("add") && input.args.includes("-A")) stageAttempts++;
          return liveProcess.run(input).pipe(
            Effect.tapError((error) => {
              if (error._tag === "VcsProcessExitError") stageError = error;
              return Effect.void;
            }),
          );
        },
      }),
    );
    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );
    assert.strictEqual(nestedProbes, 0);
    assert.strictEqual(stageAttempts, 1);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure, stageError);
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([
  { phase: "add", nestedRecovery: false, expireRecovery: false },
  { phase: "update-ref", nestedRecovery: false, expireRecovery: false },
  { phase: "update-ref", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: true },
])(
  "checkpoint handles a $phase lock with nestedRecovery=$nestedRecovery, expireRecovery=$expireRecovery",
  ({ phase, nestedRecovery, expireRecovery }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveRunner = yield* ProcessRunner.ProcessRunner;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ref-race-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      if (nestedRecovery) yield* git(["init", "empty"]);
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
      const refLockPath = path.join(cwd, ".git", `${checkpointRef}.lock`);
      const failed = yield* Deferred.make<void>();
      const retryReached = yield* Deferred.make<void>();
      const allowRetry = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      const privateIndexes = new Set<string>();
      let racedAttempts = 0;
      let discoveries = 0;
      let stageError: VcsProcessExitError | undefined;
      const captureProcess = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.args.includes("--others")) discoveries += 1;
            if (input.env?.GIT_INDEX_FILE) privateIndexes.add(input.env.GIT_INDEX_FILE);
            const initialStage =
              phase === "add" &&
              nestedRecovery &&
              !input.args.some((arg) => arg.startsWith(":(exclude,literal)"));
            if (!input.args.includes(phase) || initialStage || ++racedAttempts !== 1) {
              return liveRunner.run(input);
            }
            const lockPath = phase === "add" ? `${input.env!.GIT_INDEX_FILE!}.lock` : refLockPath;
            return Effect.gen(function* () {
              yield* fs
                .makeDirectory(path.dirname(lockPath), { recursive: true })
                .pipe(Effect.orDie);
              yield* fs.writeFileString(lockPath, "concurrent ref writer").pipe(Effect.orDie);
              return yield* liveRunner.run(input).pipe(
                Effect.ensuring(fs.remove(lockPath).pipe(Effect.orDie)),
                Effect.tap(() => Deferred.succeed(failed, undefined)),
              );
            });
          },
        }),
      );
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            captureProcess.run(input).pipe(
              Effect.tapError((error) => {
                if (input.args.includes("add") && error._tag === "VcsProcessExitError")
                  stageError = error;
                return Effect.void;
              }),
            ),
        }),
      );
      const captureStore = yield* makeCaptureStore(captureDriver, cwd);
      const fiber = yield* captureStore.captureCheckpoint({ cwd, checkpointRef }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Duration.toMillis(duration) === 75
              ? Deferred.succeed(retryReached, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRetry)),
                )
              : clock.sleep(duration),
        }),
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Deferred.await(failed);
      yield* Deferred.await(retryReached);
      if (expireRecovery) yield* TestClock.adjust("5 seconds");
      else yield* Deferred.succeed(allowRetry, undefined);
      const result = yield* Fiber.join(fiber);
      if (expireRecovery) {
        if (Exit.isSuccess(result))
          return yield* Effect.die("Expected the recovery deadline to expire");
        const error = Cause.findErrorOption(result.cause);
        assert.isTrue(error._tag === "Some");
        if (error._tag === "Some") assert.strictEqual(error.value, stageError);
      } else assert.isTrue(Exit.isSuccess(result));
      assert.strictEqual(racedAttempts, expireRecovery ? 1 : 2);
      assert.strictEqual(discoveries, nestedRecovery ? 1 : 0);
      assert.strictEqual(privateIndexes.size, 1);
      assert.strictEqual(
        yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }),
        !expireRecovery,
      );
      for (const index of privateIndexes) {
        assert.isFalse(yield* fs.exists(index));
        assert.isFalse(yield* fs.exists(`${index}.lock`));
      }
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitCaptureContract)),
);

it.effect.each(["discovery", "probe", "retry"] as const)(
  "checkpoint recovery has one deadline including %s",
  (blockedPhase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-timeout-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* git(["init", "empty"]);
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
      const entered = yield* Deferred.make<void>();
      const discovered = yield* Deferred.make<void>();
      let stageError: VcsProcessExitError | undefined;
      let privateIndex: string | undefined;
      let interrupted = false;
      let stagingAttempts = 0;
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            const staging = input.args.includes("add") && input.args.includes("-A");
            if (staging) {
              privateIndex = input.env?.GIT_INDEX_FILE;
              stagingAttempts += 1;
            }
            const block =
              (blockedPhase === "discovery" && input.args.includes("--others")) ||
              (blockedPhase === "probe" && input.cwd !== cwd && input.args.includes("rev-parse")) ||
              (blockedPhase === "retry" &&
                staging &&
                input.args.some((arg) => arg.startsWith(":(exclude,literal)")));
            if (block)
              return (
                blockedPhase === "retry"
                  ? fs
                      .writeFileString(
                        `${input.env!.GIT_INDEX_FILE!}.lock`,
                        "interrupted index write",
                      )
                      .pipe(Effect.orDie)
                  : Effect.void
              ).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              );
            return liveProcess.run(input).pipe(
              Effect.tap(() =>
                blockedPhase === "probe" && input.args.includes("--others")
                  ? Deferred.succeed(discovered, undefined).pipe(
                      Effect.andThen(Effect.sleep("3 seconds")),
                    )
                  : Effect.void,
              ),
              Effect.tapError((error) => {
                if (staging && error._tag === "VcsProcessExitError") stageError = error;
                return Effect.void;
              }),
            );
          },
        }),
      );
      const captureStore = yield* makeCaptureStore(captureDriver, cwd);
      const fiber = yield* captureStore
        .captureCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.flip, Effect.forkScoped);
      if (blockedPhase === "probe") {
        yield* Deferred.await(discovered);
        yield* TestClock.adjust("3 seconds");
      }
      yield* Deferred.await(entered);
      yield* TestClock.adjust(blockedPhase === "probe" ? "2 seconds" : "5 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error, stageError);
      assert.strictEqual(stagingAttempts, blockedPhase === "retry" ? 2 : 1);
      assert.isTrue(interrupted);
      assert.isDefined(privateIndex);
      assert.isFalse(yield* fs.exists(privateIndex!));
      assert.isFalse(yield* fs.exists(`${privateIndex!}.lock`));
      assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint recovery preserves interruption and removes the private index", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-interrupt-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const entered = yield* Deferred.make<void>();
    let privateIndex: string | undefined;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("add") && input.args.includes("-A"))
            privateIndex = input.env?.GIT_INDEX_FILE;
          return input.args.includes("--others")
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : liveProcess.run(input);
        },
      }),
    );
    const fiber = yield* captureDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isDefined(privateIndex);
    assert.isFalse(yield* fs.exists(privateIndex!));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture does not rerun clean filters for unchanged indexed files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-cache-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(
      path.join(cwd, ".gitattributes"),
      "stable.txt filter=probe\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "stable.txt"), "unchanged\n");
    yield* fileSystem.writeFileString(
      path.join(cwd, ".git", "filter.cjs"),
      'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
    );
    yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
    yield* fileSystem.utimes(path.join(cwd, "stable.txt"), 1_700_000_000, 1_700_000_000);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record stable file"]);
    yield* fileSystem.writeFileString(path.join(cwd, ".git", "filter-runs"), "");
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, ".git", "filter-runs")), "");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "changed\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:stable.txt`])).stdout, "unchanged\n");
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  [false, true].flatMap((nested) =>
    (["sparse", "flags", "manual-skip", "missing", "non-cone-missing"] as const).map(
      (indexState) => ({ nested, indexState }),
    ),
  ),
)(
  "sparse checkpoint preserves two captures (nested=$nested, index=$indexState)",
  ({ nested, indexState }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      let freshReadTrees = 0;
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            if (input.args.includes("read-tree") && input.args.includes("index.sparse=true"))
              freshReadTrees++;
            return liveProcess.run(input);
          },
        }),
      );
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sparse-" });
      const { git } = yield* makeCheckpointFixture(driver, cwd);
      const write = Effect.fn(function* (name: string, contents: string) {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, name), contents);
      });
      for (const name of [
        "scope/in/edit",
        "scope/in/delete",
        "scope/out/deep/absent",
        "scope/out/present",
        "elsewhere/file",
      ]) {
        yield* write(name, "original\n");
      }
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "sparse fixture"]);
      yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "scope/in", "elsewhere"]);
      if (indexState === "non-cone-missing")
        yield* git(["sparse-checkout", "set", "--no-cone", "/scope/in/", "/elsewhere/"]);
      yield* write("scope/in/edit", "staged\n");
      yield* write("elsewhere/file", "staged outside\n");
      yield* git(["add", "."]);
      if (indexState === "flags")
        yield* git(["update-index", "--assume-unchanged", "scope/in/delete"]);
      if (indexState === "manual-skip")
        yield* git(["update-index", "--skip-worktree", "scope/in/delete"]);
      yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
      yield* write("scope/in/edit", "working\n");
      yield* write("scope/out/present", "modified skipped\n");
      yield* write("scope/out/new file", "new outside cone\n");
      yield* write("elsewhere/file", "working outside\n");
      yield* fs.remove(path.join(cwd, "scope/in/delete"));
      const indexPath = path.join(cwd, ".git/index");
      if (indexState.endsWith("missing")) yield* fs.remove(indexPath);
      const originalIndex = yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null));
      const captureCwd = nested ? path.join(cwd, "scope") : cwd;
      for (const turn of [1, 2]) {
        const ref = CheckpointRef.make(`refs/t3/checkpoints/sparse/${turn}`);
        if (turn === 2) {
          yield* write("scope/in/edit", "second\n");
          yield* fs.remove(path.join(cwd, "scope/out/new file"));
          yield* write("scope/out/second", "second addition\n");
        }
        const capture = driver.checkpoints.captureCheckpoint({
          cwd: captureCwd,
          checkpointRef: ref,
        });
        if (indexState === "non-cone-missing") {
          assert.strictEqual((yield* capture.pipe(Effect.flip))._tag, "VcsProcessExitError");
          assert.isFalse(
            yield* driver.checkpoints.hasCheckpointRef({ cwd: captureCwd, checkpointRef: ref }),
          );
          assert.isFalse(yield* fs.exists(indexPath));
          break;
        }
        yield* capture;
        for (const [name, content] of [
          ["scope/out/deep/absent", "original\n"],
          ["scope/out/present", "modified skipped\n"],
          ["scope/in/edit", turn === 1 ? "working\n" : "second\n"],
          ["elsewhere/file", nested ? "original\n" : "working outside\n"],
          [
            turn === 1 ? "scope/out/new file" : "scope/out/second",
            turn === 1 ? "new outside cone\n" : "second addition\n",
          ],
        ]) {
          assert.strictEqual((yield* git(["show", `${ref}:${name}`])).stdout, content);
        }
        const files = (yield* git(["ls-tree", "-rz", "--name-only", ref])).stdout.split("\0");
        assert.notInclude(files, "scope/in/delete");
        if (turn === 2) assert.notInclude(files, "scope/out/new file");
        assert.deepEqual(
          yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
          originalIndex,
        );
        assert.isFalse(yield* fs.exists(path.join(cwd, "scope/out/deep/absent")));
        assert.strictEqual(
          yield* fs.readFileString(path.join(cwd, "elsewhere/file")),
          "working outside\n",
        );
      }
      assert.strictEqual(freshReadTrees, indexState === "missing" ? 2 : 0);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture keeps the legacy path when Git lacks add --sparse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-legacy-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["sparse-checkout", "set", "--cone", "included"]);
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("-h"))
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(129),
              stdout: "usage: git add",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          return liveProcess.run(
            input.args.includes("--sparse")
              ? {
                  ...input,
                  args: input.args.map((arg) =>
                    arg === "--sparse" ? "--unsupported-sparse" : arg,
                  ),
                }
              : input,
          );
        },
      }),
    );
    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  (["normal", "skip-worktree", "assume-unchanged", "sparse"] as const).flatMap((indexMode) =>
    [1, 3, 4096].map((chunkSize) => ({ indexMode, chunkSize })),
  ),
)(
  "checkpoint index inspection handles entries beyond the output cap (index=$indexMode, chunk=$chunkSize)",
  ({ indexMode, chunkSize }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-inspection-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* fs.writeFileString(path.join(cwd, ".gitattributes"), "stable filter=probe\n");
      yield* fs.writeFileString(path.join(cwd, "stable"), "unchanged\n");
      yield* fs.writeFileString(path.join(cwd, "z-skipped"), "original\n");
      yield* fs.writeFileString(path.join(cwd, "z-deleted"), "original\n");
      yield* fs.makeDirectory(path.join(cwd, "excluded"));
      yield* fs.writeFileString(path.join(cwd, "excluded/file"), "absent\n");
      yield* fs.writeFileString(
        path.join(cwd, ".git/filter.cjs"),
        'require("node:fs").appendFileSync(".git/reads", "read\\n"); process.stdin.pipe(process.stdout);',
      );
      yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
      yield* git(["config", "core.trustctime", "false"]);
      yield* fs.utimes(path.join(cwd, "stable"), 1_700_000_000, 1_700_000_000);
      yield* fs.utimes(path.join(cwd, "z-skipped"), 1_700_000_000, 1_700_000_000);
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "inspection fixture"]);
      const flagged = indexMode === "skip-worktree" || indexMode === "assume-unchanged";
      if (flagged) {
        yield* git(["update-index", `--${indexMode}`, "z-skipped", "z-deleted"]);
        yield* git(["config", "core.ignorestat", "true"]);
        yield* fs.remove(path.join(cwd, "z-deleted"));
      }
      if (indexMode === "sparse")
        yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "included"]);
      yield* fs.writeFileString(path.join(cwd, "z-skipped"), "modified\n");
      // A flagged edit with the indexed size and mtime is invisible to Git's stat check.
      if (flagged) yield* fs.utimes(path.join(cwd, "z-skipped"), 1_700_000_000, 1_700_000_000);
      yield* fs.writeFileString(path.join(cwd, ".git/reads"), "");
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
      let freshReadTrees = 0;
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            if (input.args.includes("read-tree") && !input.args.includes("--reset"))
              freshReadTrees++;
            return liveProcess.run(
              input.args.includes("ls-files")
                ? {
                    ...input,
                    maxOutputBytes: 8,
                    onStdoutChunk: (chunk) => {
                      for (let i = 0; i < chunk.length; i += chunkSize)
                        input.onStdoutChunk?.(chunk.subarray(i, i + chunkSize));
                    },
                  }
                : input,
            );
          },
        }),
      );
      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.strictEqual((yield* git(["show", `${checkpointRef}:z-skipped`])).stdout, "modified\n");
      const files = (yield* git(["ls-tree", "-z", "--name-only", checkpointRef])).stdout.split(
        "\0",
      );
      if (flagged) assert.notInclude(files, "z-deleted");
      else assert.include(files, "z-deleted");
      assert.strictEqual(freshReadTrees, 0);
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/reads")), "");
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([1_700_000_000, 1_700_000_000.9999])(
  "checkpoint capture preserves same-size edits with racy index timestamps (%s)",
  (timestamp) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const filePath = path.join(cwd, "file.txt");
      const indexPath = path.join(cwd, ".git", "index");
      yield* git(["config", "core.trustctime", "false"]);
      yield* fileSystem.writeFileString(filePath, "before\n");
      yield* fileSystem.utimes(filePath, timestamp, timestamp);
      yield* git(["add", "file.txt"]);
      yield* git(["commit", "-m", "record racy file"]);
      yield* fileSystem.utimes(indexPath, timestamp, timestamp);
      const originalIndex = yield* fileSystem.readFile(indexPath);
      const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
      yield* fileSystem.writeFileString(filePath, "after!\n");
      yield* fileSystem.utimes(filePath, timestamp, timestamp);

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "after!\n");
      assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
      assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
it.effect.each(
  [false, true].flatMap((nested) =>
    (["sparse", "flags", "manual-skip", "missing", "non-cone-missing"] as const).map(
      (indexState) => ({ nested, indexState }),
    ),
  ),
)(
  "sparse checkpoint preserves two captures (nested=$nested, index=$indexState)",
  ({ nested, indexState }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sparse-" });
      const { git } = yield* makeCheckpointFixture(driver, cwd);
      const write = Effect.fn(function* (name: string, contents: string) {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, name), contents);
      });
      for (const name of [
        "scope/in/edit",
        "scope/in/delete",
        "scope/out/deep/absent",
        "scope/out/present",
        "elsewhere/file",
      ]) {
        yield* write(name, "original\n");
      }
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "sparse fixture"]);
      yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "scope/in", "elsewhere"]);
      if (indexState === "non-cone-missing")
        yield* git(["sparse-checkout", "set", "--no-cone", "/scope/in/", "/elsewhere/"]);
      yield* write("scope/in/edit", "staged\n");
      yield* write("elsewhere/file", "staged outside\n");
      yield* git(["add", "."]);
      if (indexState === "flags")
        yield* git(["update-index", "--assume-unchanged", "scope/in/delete"]);
      if (indexState === "manual-skip")
        yield* git(["update-index", "--skip-worktree", "scope/in/delete"]);
      yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
      yield* write("scope/in/edit", "working\n");
      yield* write("scope/out/present", "modified skipped\n");
      yield* write("scope/out/new file", "new outside cone\n");
      yield* write("elsewhere/file", "working outside\n");
      yield* fs.remove(path.join(cwd, "scope/in/delete"));
      const indexPath = path.join(cwd, ".git/index");
      if (indexState.endsWith("missing")) yield* fs.remove(indexPath);
      const originalIndex = yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null));
      const captureCwd = nested ? path.join(cwd, "scope") : cwd;
      for (const turn of [1, 2]) {
        const ref = CheckpointRef.make(`refs/t3/checkpoints/sparse/${turn}`);
        if (turn === 2) {
          yield* write("scope/in/edit", "second\n");
          yield* fs.remove(path.join(cwd, "scope/out/new file"));
          yield* write("scope/out/second", "second addition\n");
        }
        const capture = driver.checkpoints.captureCheckpoint({
          cwd: captureCwd,
          checkpointRef: ref,
        });
        if (indexState === "non-cone-missing") {
          assert.strictEqual((yield* capture.pipe(Effect.flip))._tag, "VcsProcessExitError");
          assert.isFalse(
            yield* driver.checkpoints.hasCheckpointRef({ cwd: captureCwd, checkpointRef: ref }),
          );
          assert.isFalse(yield* fs.exists(indexPath));
          break;
        }
        yield* capture;
        for (const [name, content] of [
          ["scope/out/deep/absent", "original\n"],
          ["scope/out/present", "modified skipped\n"],
          ["scope/in/edit", turn === 1 ? "working\n" : "second\n"],
          ["elsewhere/file", nested ? "original\n" : "working outside\n"],
          [
            turn === 1 ? "scope/out/new file" : "scope/out/second",
            turn === 1 ? "new outside cone\n" : "second addition\n",
          ],
        ]) {
          assert.strictEqual((yield* git(["show", `${ref}:${name}`])).stdout, content);
        }
        const files = (yield* git(["ls-tree", "-rz", "--name-only", ref])).stdout.split("\0");
        assert.notInclude(files, "scope/in/delete");
        if (turn === 2) assert.notInclude(files, "scope/out/new file");
        assert.deepEqual(
          yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
          originalIndex,
        );
        assert.isFalse(yield* fs.exists(path.join(cwd, "scope/out/deep/absent")));
        assert.strictEqual(
          yield* fs.readFileString(path.join(cwd, "elsewhere/file")),
          "working outside\n",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture preserves racy edits made after resetting the index", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-reset-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const racyPath = path.join(cwd, "racy.txt");
    const indexPath = path.join(cwd, ".git", "index");
    const timestamp = 1_700_000_000;
    yield* git(["config", "core.trustctime", "false"]);
    yield* fileSystem.writeFileString(racyPath, "before\n");
    yield* fileSystem.utimes(racyPath, timestamp, timestamp);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record racy file"]);
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
    yield* git(["add", "file.txt"]);
    yield* fileSystem.utimes(indexPath, timestamp, timestamp);
    const originalIndex = yield* fileSystem.readFile(indexPath);
    const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
          const result = yield* liveProcess.run(input);
          if (input.args.includes("read-tree") && input.args.includes("--reset")) {
            yield* fileSystem.writeFileString(racyPath, "after!\n").pipe(Effect.orDie);
            yield* fileSystem.utimes(racyPath, timestamp, timestamp).pipe(Effect.orDie);
          }
          return result;
        }),
      }),
    );

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:racy.txt`])).stdout, "after!\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "staged\n");
    assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
    assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  [false, true].flatMap((nested) =>
    (["normal", "flags", "split"] as const).map((indexMode) => ({ nested, indexMode })),
  ),
)(
  "checkpoint index reuse preserves two turns (nested=$nested, index=$indexMode)",
  ({ nested, indexMode }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-turns-" });
      const { git } = yield* makeCheckpointFixture(driver, cwd);
      const write = (name: string, contents: string) =>
        fileSystem.writeFileString(path.join(cwd, name), contents);
      yield* fileSystem.makeDirectory(path.join(cwd, "scope"));
      for (const name of [
        "scope/staged",
        "scope/deleted",
        "scope/assumed",
        "scope/skipped",
        "outside",
      ]) {
        yield* write(name, "original\n");
      }
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial scoped files"]);
      yield* write("scope/staged", "staged\n");
      yield* write("scope/new-deleted", "staged then deleted\n");
      yield* write("outside", "staged outside\n");
      yield* git(["add", "."]);
      if (indexMode === "flags") {
        yield* git(["update-index", "--assume-unchanged", "scope/assumed"]);
        yield* git(["update-index", "--skip-worktree", "scope/skipped"]);
      }
      if (indexMode === "split") {
        yield* git(["update-index", "--split-index"]);
      }
      const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
      for (const name of ["scope/staged", "scope/assumed", "scope/skipped", "outside"]) {
        yield* write(name, "working\n");
      }
      yield* write("scope/new", "first\n");
      yield* fileSystem.remove(path.join(cwd, "scope/deleted"));
      yield* fileSystem.remove(path.join(cwd, "scope/new-deleted"));
      const captureCwd = nested ? path.join(cwd, "scope") : cwd;
      const first = CheckpointRef.make("refs/t3/checkpoints/turns/1");
      const second = CheckpointRef.make("refs/t3/checkpoints/turns/2");
      yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: first });
      for (const name of ["scope/staged", "scope/assumed", "scope/skipped"]) {
        assert.strictEqual((yield* git(["show", `${first}:${name}`])).stdout, "working\n");
      }
      assert.strictEqual(
        (yield* git(["show", `${first}:outside`])).stdout,
        nested ? "original\n" : "working\n",
      );
      const files = (yield* git(["ls-tree", "-r", "--name-only", first])).stdout.split("\n");
      assert.notInclude(files, "scope/deleted");
      assert.notInclude(files, "scope/new-deleted");
      assert.include(files, "scope/new");

      yield* write("scope/staged", "second\n");
      yield* fileSystem.remove(path.join(cwd, "scope/new"));
      yield* write("scope/second", "added in second turn\n");
      yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: second });
      assert.strictEqual(
        (yield* git(["diff", "--name-only", first, second])).stdout,
        "scope/new\nscope/second\nscope/staged\n",
      );
      assert.strictEqual((yield* git(["show", `${second}:scope/staged`])).stdout, "second\n");
      assert.strictEqual(
        (yield* git(["show", `${second}:scope/second`])).stdout,
        "added in second turn\n",
      );
      assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(["missing", "invalid"] as const)(
  "checkpoint capture falls back when the user index is %s",
  (indexState) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-index-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const indexPath = path.join(cwd, ".git", "index");
      if (indexState === "missing") {
        yield* fileSystem.remove(indexPath);
      } else {
        yield* fileSystem.writeFileString(indexPath, "invalid index");
      }

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      if (indexState === "missing") {
        assert.isFalse(yield* fileSystem.exists(indexPath));
      } else {
        assert.strictEqual(yield* fileSystem.readFileString(indexPath), "invalid index");
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

const captureRecordingGitCommands = Effect.fn("test.captureRecordingGitCommands")(function* (
  cwd: string,
  checkpointRef: CheckpointRef,
) {
  const liveProcess = yield* VcsProcess.VcsProcess;
  const commands: Array<string | undefined> = [];
  const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
    Effect.provideService(VcsProcess.VcsProcess, {
      run: (input) => {
        let index = 0;
        while (input.args[index] === "-C" || input.args[index] === "-c") index += 2;
        commands.push(input.args[index]);
        return liveProcess.run(input);
      },
    }),
  );
  yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
  return commands;
});

it.effect.each(["committed", "unborn"] as const)(
  "checkpoint capture reads the repository with one rev-parse (HEAD=%s)",
  (head) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-processes-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "checkpoint-test", cwd, args });
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
      if (head === "committed") {
        yield* makeCheckpointFixture(driver, cwd);
      } else {
        yield* git(["init"]);
        yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
      }

      const commands = yield* captureRecordingGitCommands(cwd, checkpointRef);

      assert.deepStrictEqual(commands, [
        "rev-parse",
        "config",
        ...(head === "committed" ? ["read-tree", "ls-files"] : []),
        "check-ignore",
        "add",
        "write-tree",
        "commit-tree",
        "update-ref",
      ]);
      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      const [, ...parents] = (yield* git([
        "rev-list",
        "--parents",
        "-n",
        "1",
        checkpointRef,
      ])).stdout
        .trim()
        .split(" ");
      assert.deepStrictEqual(
        parents,
        head === "committed" ? [(yield* git(["rev-parse", "HEAD"])).stdout.trim()] : [],
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture outside a repository fails with the common dir lookup error", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-no-repo-" });

    const error = yield* captureRecordingGitCommands(
      cwd,
      CheckpointRef.make("refs/t3/checkpoints/test"),
    ).pipe(Effect.flip);

    assert.instanceOf(error, VcsProcessExitError);
    assert.strictEqual(error.operation, "GitVcsDriver.checkpoints.resolveGitCommonDir");
    assert.strictEqual(error.exitCode, 128);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "checkpoint capture handles a repository path containing a newline",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-new\nline-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

      const commands = yield* captureRecordingGitCommands(cwd, checkpointRef);

      assert.deepStrictEqual(commands, [
        "rev-parse",
        "rev-parse",
        "config",
        "rev-parse",
        "read-tree",
        "ls-files",
        "check-ignore",
        "add",
        "write-tree",
        "commit-tree",
        "update-ref",
      ]);
      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
      assert.deepStrictEqual(
        (yield* fileSystem.readDirectory(path.join(cwd, ".git"))).filter((name) =>
          name.startsWith("t3-checkpoint-index-"),
        ),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("restores empty checkpoints without changing paths outside the workspace", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-empty-checkpoint-" });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "original\n");
        yield* runGit(root, ["add", "."]);
      }
      yield* runGit(root, ["commit", "--allow-empty", "-m", "initial"]);
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/empty");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "changed\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      for (const staged of [false, true]) {
        const addedPath = path.join(cwd, "added.txt");
        yield* fileSystem.writeFileString(addedPath, "new\n");
        if (staged) yield* runGit(cwd, ["add", "added.txt"]);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef,
            fallbackToHead: false,
          }),
        );
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isFalse(yield* fileSystem.exists(addedPath));
      }
      yield* fileSystem.writeFileString(
        path.join(root, ".git", "info", "exclude"),
        "ignored.txt\n",
      );
      yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "untracked"));
      yield* fileSystem.writeFileString(path.join(cwd, "untracked", "file.txt"), "remove\n");
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "ignored.txt")), "keep\n");
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "untracked")));
      if (nested) {
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(root, "outside.txt")),
          "changed\n",
        );
        const staged = yield* driver.execute({
          operation: "test",
          cwd: root,
          args: ["diff", "--cached", "--name-only"],
        });
        assert.strictEqual(staged.stdout.trim(), "outside.txt");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(!symlinksSupported)(
  "a checkpoint restore never deletes an ignored file the checkpoint does not hold",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-ignored-" });
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test", cwd: root, args });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(root, ".gitignore"), ".env\nnode_modules/\n");
      const cwd = path.join(root, "ws");
      yield* fileSystem.makeDirectory(path.join(cwd, "kept"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "kept", "a.txt"), "a\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);

      // At the checkpoint `config` is a file, `link` a symlink and `out` a directory.
      yield* fileSystem.writeFileString(path.join(cwd, "config"), "one\n");
      yield* fileSystem.symlink("kept", path.join(cwd, "link"));
      yield* fileSystem.makeDirectory(path.join(cwd, "out"));
      yield* fileSystem.writeFileString(path.join(cwd, "out", "x"), "x\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Later each turned into the other kind, holding (or being) something only the person has.
      yield* fileSystem.remove(path.join(cwd, "config"));
      yield* fileSystem.makeDirectory(path.join(cwd, "config"));
      yield* fileSystem.writeFileString(path.join(cwd, "config", "x"), "inside\n");
      yield* fileSystem.writeFileString(path.join(cwd, "config", ".env"), "SECRET=1\n");
      yield* fileSystem.remove(path.join(cwd, "link"));
      yield* fileSystem.makeDirectory(path.join(cwd, "link", "node_modules"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "link", "node_modules", "m.js"), "m\n");
      yield* fileSystem.remove(path.join(cwd, "out"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "out"), "mine\n");
      yield* fileSystem.writeFileString(path.join(root, ".git", "info", "exclude"), "/ws/out\n");
      // An ignored file in a directory the checkpoint also holds as one is in no one's way.
      yield* fileSystem.writeFileString(path.join(cwd, "kept", ".env"), "KEEP=1\n");
      yield* runGit(root, ["add", "-A", "ws"]);
      const ignored = (entry: string) =>
        ["config/.env", "kept/.env", "link/node_modules/m.js", "out"].includes(entry);
      const ignoredBefore = snapshotTree(cwd, ignored);
      const before = snapshotTree(cwd);
      const indexBefore = (yield* git(["ls-files", "--stage"])).stdout;

      const refused = yield* Effect.exit(
        driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );

      assert.deepStrictEqual(snapshotTree(cwd, ignored), ignoredBefore);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);
      assert.strictEqual((yield* git(["ls-files", "--stage"])).stdout, indexBefore);
      assert.deepStrictEqual(
        Exit.isFailure(refused)
          ? Cause.findErrorOption(refused.cause).pipe(
              Option.map((error) => ({
                _tag: error._tag,
                detail: "detail" in error ? error.detail : "",
              })),
              Option.getOrUndefined,
            )
          : refused.value,
        {
          _tag: "VcsUnsupportedOperationError",
          detail:
            "Restoring would delete ignored files this checkpoint never saved: " +
            "config/.env, link/node_modules/, out. Move them elsewhere, then restore again.",
        },
      );

      // Moved out of the way, the restore goes ahead and leaves the other ignored file alone.
      yield* fileSystem.remove(path.join(cwd, "config", ".env"));
      yield* fileSystem.remove(path.join(cwd, "link", "node_modules"), { recursive: true });
      yield* fileSystem.remove(path.join(cwd, "out"));
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );
      assert.deepStrictEqual(snapshotTree(cwd), {
        config: "644 one\n",
        "kept/.env": "644 KEEP=1\n",
        "kept/a.txt": "644 a\n",
        link: "link -> kept",
        "out/x": "644 x\n",
      });
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

/** What a restore answered: its refusal's detail, or whether it found the checkpoint. */
const restoreAnswer = (exit: Exit.Exit<boolean, unknown>) =>
  Exit.isSuccess(exit)
    ? exit.value
    : Cause.findErrorOption(exit.cause).pipe(
        Option.map((error) =>
          typeof error === "object" && error !== null && "detail" in error
            ? String(error.detail)
            : Cause.pretty(exit.cause),
        ),
        Option.getOrElse(() => Cause.pretty(exit.cause)),
      );

const ignoredRepo = Effect.fn("test.ignoredRepo")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  yield* runGit(root, ["init"]);
  yield* runGit(root, ["config", "user.email", "test@test.com"]);
  yield* runGit(root, ["config", "user.name", "Test"]);
  const cwd = path.join(root, "ws");
  yield* fileSystem.makeDirectory(cwd);
  return { root, cwd, exclude: path.join(root, ".git", "info", "exclude") };
});

it.effect(
  "a checkpoint restore never deletes what a directory ignored after the checkpoint holds",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-dir-");
      const write = (relative: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
          yield* fileSystem.writeFileString(path.join(cwd, relative), text);
        });
      const remove = (relative: string) =>
        fileSystem.remove(path.join(cwd, relative), { recursive: true });
      yield* write("build", "tracked\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);

      yield* write("out/app", "one\n");
      yield* write("deep/app/x", "x\n");
      yield* write("gen/x", "x\n");
      yield* write("gen/e", "e\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-dir");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Later each directory is ignored as a whole, and what the checkpoint holds inside changed kind.
      yield* fileSystem.writeFileString(exclude, "/ws/out/\n/ws/deep/\n/ws/build/\n/ws/gen/\n");
      yield* remove("out/app");
      yield* write("out/app/secret", "S\n");
      yield* remove("deep/app");
      yield* write("deep/app", "mine\n");
      // `build` is still in the index as a file; status leaves out an ignored directory there.
      yield* remove("build");
      yield* write("build/secret", "B\n");
      // Neither of these is in the way: an empty directory loses nothing, and gen/x is still a file.
      yield* remove("gen/e");
      yield* fileSystem.makeDirectory(path.join(cwd, "gen", "e"));
      yield* write("gen/extra", "kept\n");
      const before = snapshotTree(cwd);
      const indexBefore = (yield* driver.execute({ operation: "test", cwd: root, args: ["ls-files", "--stage"] }))
        .stdout;

      const restore = (dryRun: boolean) =>
        Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun }),
        );
      const refusal =
        "Restoring would delete ignored files this checkpoint never saved: " +
        "build/, deep/app, out/app/. Move them elsewhere, then restore again.";

      // A dry run refuses as the restore does.
      assert.deepStrictEqual(restoreAnswer(yield* restore(true)), refusal);
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);
      assert.strictEqual(
        (yield* driver.execute({ operation: "test", cwd: root, args: ["ls-files", "--stage"] })).stdout,
        indexBefore,
      );

      yield* remove("build");
      yield* remove("deep/app");
      yield* remove("out/app");
      const moved = snapshotTree(cwd);
      assert.isTrue(restoreAnswer(yield* restore(true)));
      assert.deepStrictEqual(treeDiff(moved, snapshotTree(cwd)), []);
      assert.isTrue(restoreAnswer(yield* restore(false)));
      assert.deepStrictEqual(snapshotTree(cwd), {
        build: "644 tracked\n",
        "deep/app/x": "644 x\n",
        "gen/e": "644 e\n",
        "gen/extra": "644 kept\n",
        "gen/x": "644 x\n",
        "out/app": "644 one\n",
      });
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("a checkpoint restore never deletes what the workspace, ignored after the checkpoint, holds", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-workspace-");
    yield* fileSystem.writeFileString(path.join(root, "anchor"), "a\n");
    yield* runGit(root, ["add", "."]);
    yield* runGit(root, ["commit", "-m", "initial"]);
    yield* fileSystem.writeFileString(path.join(cwd, "gen"), "one\n");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-workspace");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    yield* fileSystem.writeFileString(exclude, "/ws/\n");
    yield* fileSystem.remove(path.join(cwd, "gen"));
    yield* fileSystem.makeDirectory(path.join(cwd, "gen"));
    yield* fileSystem.writeFileString(path.join(cwd, "gen", "secret"), "S\n");

    assert.deepStrictEqual(
      restoreAnswer(
        yield* Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
        ),
      ),
      "Restoring would delete ignored files this checkpoint never saved: gen/. " +
        "Move them elsewhere, then restore again.",
    );
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "gen", "secret")), "S\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore never deletes what the workspace holds once a folder above it is ignored",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, exclude } = yield* ignoredRepo("t3-restore-ignored-above-");
      yield* fileSystem.writeFileString(path.join(root, "anchor"), "a\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      // Nothing under `a/` is ever in the index, so once `/a/` is ignored status names only `a/`.
      const cwd = path.join(root, "a", "ws");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "f"), "one\n");
      yield* fileSystem.writeFileString(path.join(cwd, "kept"), "k\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-above");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      yield* fileSystem.writeFileString(exclude, "/a/\n");
      yield* fileSystem.remove(path.join(cwd, "f"));
      yield* fileSystem.makeDirectory(path.join(cwd, "f"));
      yield* fileSystem.writeFileString(path.join(cwd, "f", "secret"), "S\n");
      const before = snapshotTree(cwd);

      const restore = (dryRun: boolean) =>
        Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun }),
        );
      const refusal =
        "Restoring would delete ignored files this checkpoint never saved: f/. " +
        "Move them elsewhere, then restore again.";
      assert.deepStrictEqual(restoreAnswer(yield* restore(true)), refusal);
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);

      yield* fileSystem.remove(path.join(cwd, "f"), { recursive: true });
      assert.isTrue(restoreAnswer(yield* restore(false)));
      assert.deepStrictEqual(snapshotTree(cwd), { f: "644 one\n", kept: "644 k\n" });

      // With `f` committed, status lists the deleted file instead, and leaves out the ignored directory there.
      yield* runGit(root, ["add", "-f", "a/ws"]);
      yield* runGit(root, ["commit", "-m", "commit the workspace"]);
      yield* fileSystem.remove(path.join(cwd, "f"));
      yield* fileSystem.makeDirectory(path.join(cwd, "f"));
      yield* fileSystem.writeFileString(path.join(cwd, "f", "secret"), "S\n");
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "f", "secret")), "S\n");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("a checkpoint restore's refusal names the first 20 paths in its way and counts the rest", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const { root, cwd } = yield* ignoredRepo("t3-restore-ignored-many-");
    yield* fileSystem.writeFileString(path.join(root, ".gitignore"), "*.log\n");
    yield* runGit(root, ["add", "."]);
    yield* runGit(root, ["commit", "-m", "initial"]);
    yield* fileSystem.writeFileString(path.join(cwd, "d"), "one\n");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-many");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    yield* fileSystem.remove(path.join(cwd, "d"));
    yield* fileSystem.makeDirectory(path.join(cwd, "d"));
    const logs = Array.from({ length: 25 }, (_, index) => `d/f${String(index).padStart(2, "0")}.log`);
    for (const log of logs) yield* fileSystem.writeFileString(path.join(cwd, log), "mine\n");

    assert.deepStrictEqual(
      restoreAnswer(
        yield* Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
        ),
      ),
      `Restoring would delete ignored files this checkpoint never saved: ${logs.slice(0, 20).join(", ")} ` +
        "and 5 more. Move them elsewhere, then restore again.",
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore never deletes an ignored file through another spelling of its path",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-case-");
      yield* fileSystem.writeFileString(path.join(root, ".gitignore"), ".env\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* fileSystem.writeFileString(path.join(root, "Probe"), "");
      const caseInsensitive = yield* fileSystem.exists(path.join(root, "probe"));
      yield* fileSystem.remove(path.join(root, "Probe"));

      yield* fileSystem.writeFileString(path.join(cwd, "Config"), "one\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "Logs"));
      yield* fileSystem.writeFileString(path.join(cwd, "Logs", "app"), "one\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-case");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // The same names in lower case now: a folder holding an ignored file, and an ignored folder.
      yield* fileSystem.remove(path.join(cwd, "Config"));
      yield* fileSystem.makeDirectory(path.join(cwd, "config"));
      yield* fileSystem.writeFileString(path.join(cwd, "config", ".env"), "SECRET=1\n");
      yield* fileSystem.remove(path.join(cwd, "Logs"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cwd, "logs", "app"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "logs", "app", "secret"), "S\n");
      yield* fileSystem.writeFileString(exclude, "/ws/logs/\n");

      const answer = restoreAnswer(
        yield* Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
        ),
      );
      // Where case matters the checkpoint's paths are other files, and the restore goes ahead.
      assert.deepStrictEqual(
        answer,
        caseInsensitive
          ? "Restoring would delete ignored files this checkpoint never saved: config/.env, logs/app/. " +
              "Move them elsewhere, then restore again."
          : true,
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "config", ".env")), "SECRET=1\n");
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "logs", "app", "secret")), "S\n");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("a checkpoint restore never deletes an ignored directory sitting at an unmerged path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-unmerged-");
    const git = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "test", cwd: root, args, allowNonZeroExit: true });
    yield* fileSystem.writeFileString(path.join(cwd, "f"), "base\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
    const main = (yield* git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    yield* git(["checkout", "-b", "other"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f"), "other\n");
    yield* git(["commit", "-am", "other"]);
    yield* git(["checkout", main]);
    yield* fileSystem.writeFileString(path.join(cwd, "f"), "main\n");
    yield* git(["commit", "-am", "main"]);
    yield* git(["merge", "other"]);
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-unmerged");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    // `f` is unmerged in the index; status leaves out an ignored directory there.
    yield* fileSystem.remove(path.join(cwd, "f"));
    yield* fileSystem.makeDirectory(path.join(cwd, "f"));
    yield* fileSystem.writeFileString(path.join(cwd, "f", "secret"), "S\n");
    yield* fileSystem.writeFileString(exclude, "/ws/f/\n");

    assert.deepStrictEqual(
      restoreAnswer(
        yield* Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
        ),
      ),
      "Restoring would delete ignored files this checkpoint never saved: f/. " +
        "Move them elsewhere, then restore again.",
    );
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "f", "secret")), "S\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore never overwrites an ignored file the person changed since the checkpoint saved it",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd } = yield* ignoredRepo("t3-restore-ignored-held-");
      const write = (relative: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
          yield* fileSystem.writeFileString(path.join(cwd, relative), text);
        });
      yield* write("app.js", "app\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      // A turn writes these before anything ignores them, so its checkpoint holds them.
      yield* write(".env", "KEY=placeholder\n");
      yield* write("same.env", "KEY=placeholder\n");
      yield* write("out/config.json", "{}\n");
      yield* write("logs", "a file\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-held");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // A later turn ignores them; the person puts their keys in `.env` and edits the config. `same.env` is unchanged.
      // `logs` becomes an ignored folder, which the restore would delete.
      yield* write(".gitignore", "*.env\nout/\nlogs/\n");
      yield* write(".env", "KEY=the person's real key\n");
      yield* write("out/config.json", '{"mine":true}\n');
      yield* fileSystem.remove(path.join(cwd, "logs"));
      yield* write("logs/today.log", "today\n");
      const before = snapshotTree(cwd);

      const restore = (dryRun: boolean) =>
        Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun }),
        );
      const refusal =
        "Restoring would delete ignored files this checkpoint never saved: logs/. " +
        "It would also write over ignored files changed since this checkpoint saved them: .env, out/config.json. " +
        "Move them elsewhere, then restore again.";
      assert.deepStrictEqual(restoreAnswer(yield* restore(true)), refusal);
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);

      yield* fileSystem.remove(path.join(cwd, ".env"));
      yield* fileSystem.remove(path.join(cwd, "out", "config.json"));
      yield* fileSystem.remove(path.join(cwd, "logs"), { recursive: true });
      assert.isTrue(restoreAnswer(yield* restore(false)));
      assert.deepStrictEqual(snapshotTree(cwd), {
        ".env": "644 KEY=placeholder\n",
        "app.js": "644 app\n",
        logs: "644 a file\n",
        "out/config.json": "644 {}\n",
        "same.env": "644 KEY=placeholder\n",
      });
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore where git writes symlinks as plain files reads an ignored one by its contents",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-nosymlinks-");
      yield* fileSystem.writeFileString(path.join(cwd, "app.js"), "app\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* fileSystem.writeFileString(path.join(cwd, "target.txt"), "t\n");
      yield* fileSystem.symlink("target.txt", path.join(cwd, "same"));
      yield* fileSystem.symlink("target.txt", path.join(cwd, "edited"));
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-nosymlinks");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // As on Windows without symlinks: git writes a symlink as a plain file holding its target. Both are ignored
      // since; the person changed `edited`.
      yield* runGit(root, ["config", "core.symlinks", "false"]);
      for (const link of ["same", "edited"]) yield* fileSystem.remove(path.join(cwd, link));
      yield* fileSystem.writeFileString(path.join(cwd, "same"), "target.txt");
      yield* fileSystem.writeFileString(path.join(cwd, "edited"), "the person's\n");
      yield* fileSystem.writeFileString(exclude, "/ws/same\n/ws/edited\n");

      const restore = () =>
        Effect.exit(driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }));
      assert.deepStrictEqual(
        restoreAnswer(yield* restore()),
        "Restoring would write over ignored files changed since this checkpoint saved them: edited. " +
          "Move them elsewhere, then restore again.",
      );
      yield* fileSystem.remove(path.join(cwd, "edited"));
      assert.isTrue(restoreAnswer(yield* restore()));
      assert.deepStrictEqual(snapshotTree(cwd), {
        "app.js": "644 app\n",
        edited: "644 target.txt",
        same: "644 target.txt",
        "target.txt": "644 t\n",
      });
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore that cannot run a filter to compare an ignored file says which, changing nothing",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-filter-");
      yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "*.bin filter=lfs\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* fileSystem.writeFileString(path.join(cwd, "model.bin"), "weights\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-filter");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // `git lfs install` marks the filter required; here git-lfs is not on the PATH, run directly or through a shell.
      yield* fileSystem.writeFileString(exclude, "*.bin\n");
      yield* fileSystem.writeFileString(path.join(cwd, "model.bin"), "the person's weights\n");
      const before = snapshotTree(cwd);
      for (const filter of [
        ["filter.lfs.clean=caveman-no-such-git-lfs clean -- %f"],
        ["filter.lfs.process=caveman-no-such-git-lfs filter-process"],
      ]) {
        yield* runGit(root, ["config", "filter.lfs.required", "true"]);
        const [key, value] = filter[0]!.split(/=(.*)/s) as [string, string];
        yield* runGit(root, ["config", key, value]);
        assert.deepStrictEqual(
          restoreAnswer(
            yield* Effect.exit(
              driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun: true }),
            ),
          ),
          "Git could not run a filter this repository needs, such as Git LFS, to compare the files restoring " +
            "would write over with this checkpoint's. Install it where Caveman Code runs git, then restore again.",
          key,
        );
        yield* runGit(root, ["config", "--unset", key]);
      }
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore never deletes a git repository sitting where the checkpoint holds a file",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd } = yield* ignoredRepo("t3-restore-nested-repo-");
      const write = (relative: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
          yield* fileSystem.writeFileString(path.join(cwd, relative), text);
        });
      const repository = (relative: string, commits = true) =>
        Effect.gen(function* () {
          const at = path.resolve(cwd, relative);
          yield* fileSystem.makeDirectory(at, { recursive: true });
          yield* runGit(at, ["init"]);
          if (commits) {
            yield* fileSystem.writeFileString(path.join(at, "pushed.txt"), "committed\n");
            yield* runGit(at, ["add", "."]);
            yield* runGit(at, ["commit", "-m", "the person's unpushed commit"]);
          }
          yield* fileSystem.writeFileString(path.join(at, "work.txt"), "uncommitted\n");
        });
      yield* write("vendor", "a file\n");
      yield* write("fresh", "a file\n");
      yield* write("pointer", "a file\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* write("lib", "a file\n");
      yield* write("tools/cli", "a file\n");
      yield* write("plain", "a file\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/nested-repo");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Each file gives way to a repository: `vendor` (status reads a type change) and `fresh` (no commit yet: status
      // reads a deletion) still in the index, `lib` holding one, `tools/cli` inside a folder status lists only as a
      // whole. `plain` becomes an ordinary folder, which the snapshot before a restore keeps, and `pointer` a symlink to
      // a repository outside the workspace, which git restore leaves alone.
      for (const file of ["vendor", "fresh", "lib", "tools/cli", "plain", "pointer"])
        yield* fileSystem.remove(path.join(cwd, file));
      yield* repository("vendor");
      yield* repository("fresh", false);
      yield* repository("../elsewhere");
      yield* fileSystem.symlink("../elsewhere", path.join(cwd, "pointer"));
      yield* repository("lib/sub");
      yield* repository("tools/cli");
      yield* write("plain/x", "x\n");
      const before = snapshotTree(cwd);

      const restore = (dryRun: boolean) =>
        Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun }),
        );
      const refusal =
        "Restoring would delete git repositories this checkpoint never saved: fresh/, lib/sub/, tools/cli/, vendor/. " +
        "Move them elsewhere, then restore again.";
      assert.deepStrictEqual(restoreAnswer(yield* restore(true)), refusal);
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);
      assert.isTrue(yield* fileSystem.exists(path.join(cwd, "vendor", ".git", "HEAD")));

      for (const moved of ["vendor", "fresh", "lib", "tools"])
        yield* fileSystem.remove(path.join(cwd, moved), { recursive: true });
      assert.isTrue(restoreAnswer(yield* restore(false)));
      assert.deepStrictEqual(snapshotTree(cwd), {
        fresh: "644 a file\n",
        lib: "644 a file\n",
        plain: "644 a file\n",
        pointer: "644 a file\n",
        "tools/cli": "644 a file\n",
        vendor: "644 a file\n",
      });
      assert.isTrue(yield* fileSystem.exists(path.join(root, "elsewhere", ".git", "HEAD")));
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore never deletes or writes into a git repository the index holds as a gitlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd } = yield* ignoredRepo("t3-restore-gitlink-");
      const gitOutput = (at: string, args: ReadonlyArray<string>) =>
        driver
          .execute({ operation: "GitVcsDriver.contract.git", cwd: at, args })
          .pipe(Effect.map((result) => result.stdout));
      const write = (relative: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
          yield* fileSystem.writeFileString(path.join(cwd, relative), text);
        });
      const repository = (relative: string, files: Record<string, string>, uncommitted?: Record<string, string>) =>
        Effect.gen(function* () {
          const at = path.join(cwd, relative);
          yield* fileSystem.makeDirectory(at, { recursive: true });
          yield* runGit(at, ["init"]);
          yield* runGit(at, ["config", "user.email", "test@test.com"]);
          yield* runGit(at, ["config", "user.name", "Test"]);
          for (const [name, text] of Object.entries(files)) yield* write(`${relative}/${name}`, text);
          yield* runGit(at, ["add", "."]);
          yield* runGit(at, ["commit", "-m", "the person's unpushed commit"]);
          for (const [name, text] of Object.entries(uncommitted ?? {})) yield* write(`${relative}/${name}`, text);
        });
      for (const file of ["vendor", "clean", "lib", "empty", "anchor"]) yield* write(file, "a file\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      yield* write("kit/lib.js", "the turn's\n");
      yield* write("same/lib.js", "the turn's\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/gitlink");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Each becomes a repository the outer index holds as a gitlink (`git add` of an embedded repository), committed:
      // `vendor` with uncommitted work too, `clean` with none (status lists nothing), `lib` a tracked folder holding
      // one, and `empty` a gitlink whose folder holds no repository. `kit` and `same` keep the checkpoint's lib.js
      // inside a repository, `kit` with the person's edit to it.
      for (const file of ["vendor", "clean", "lib", "empty"]) yield* fileSystem.remove(path.join(cwd, file));
      yield* fileSystem.remove(path.join(cwd, "kit"), { recursive: true });
      yield* fileSystem.remove(path.join(cwd, "same"), { recursive: true });
      yield* repository("vendor", { "pushed.txt": "committed\n" }, { "work.txt": "uncommitted\n" });
      yield* repository("clean", { "pushed.txt": "committed\n" });
      yield* write("lib/a.txt", "tracked\n");
      yield* repository("lib/sub", { "pushed.txt": "committed\n" });
      yield* repository("kit", { "lib.js": "the turn's\n" }, { "lib.js": "the person's edit\n" });
      yield* repository("same", { "lib.js": "the turn's\n" });
      yield* runGit(root, ["add", "ws/vendor", "ws/clean", "ws/lib", "ws/kit", "ws/same"]);
      const gitlink = (yield* gitOutput(path.join(cwd, "clean"), ["rev-parse", "HEAD"])).trim();
      yield* runGit(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},ws/empty`]);
      yield* fileSystem.makeDirectory(path.join(cwd, "empty"));
      yield* runGit(root, ["commit", "-m", "repositories"]);
      assert.strictEqual(
        yield* gitOutput(root, ["ls-files", "-s", "--", "ws/clean"]),
        `160000 ${gitlink} 0\tws/clean\n`,
      );
      const before = snapshotTree(cwd);

      const restore = (dryRun: boolean) =>
        Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false, dryRun }),
        );
      const refusal =
        "Restoring would delete git repositories this checkpoint never saved: clean/, lib/sub/, vendor/. " +
        "It would also change files inside git repositories this checkpoint never saved: kit/. " +
        "Move them elsewhere, then restore again.";
      assert.deepStrictEqual(restoreAnswer(yield* restore(true)), refusal);
      assert.deepStrictEqual(restoreAnswer(yield* restore(false)), refusal);
      assert.deepStrictEqual(treeDiff(before, snapshotTree(cwd)), []);
      for (const kept of ["vendor", "clean", "lib/sub", "kit"])
        assert.isTrue(yield* fileSystem.exists(path.join(cwd, kept, ".git", "HEAD")));

      for (const moved of ["vendor", "clean", "lib", "kit"])
        yield* fileSystem.remove(path.join(cwd, moved), { recursive: true });
      assert.isTrue(restoreAnswer(yield* restore(false)));
      assert.deepStrictEqual(snapshotTree(cwd, (relative) => !relative.startsWith("same/.git/")), {
        anchor: "644 a file\n",
        clean: "644 a file\n",
        empty: "644 a file\n",
        "kit/lib.js": "644 the turn's\n",
        lib: "644 a file\n",
        "same/lib.js": "644 the turn's\n",
        vendor: "644 a file\n",
      });
      assert.isTrue(yield* fileSystem.exists(path.join(cwd, "same", ".git", "HEAD")));
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// check-ignore reads each path it is given as a pathspec: `:cache/` as `cache/`, and `:(x)y/` as unknown magic.
it.effect.each([":cache", ":(x)y"])(
  "a checkpoint restore never deletes an ignored folder named %s sitting where the index holds a file",
  (name) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-colon-");
      yield* fileSystem.writeFileString(path.join(cwd, name), "tracked\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-colon");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Still in the index as a file; status leaves out an ignored folder there.
      yield* fileSystem.remove(path.join(cwd, name));
      yield* fileSystem.makeDirectory(path.join(cwd, name));
      yield* fileSystem.writeFileString(path.join(cwd, name, "secret"), "S\n");
      yield* fileSystem.writeFileString(exclude, `/ws/${name}/\n`);

      assert.deepStrictEqual(
        restoreAnswer(
          yield* Effect.exit(
            driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
          ),
        ),
        `Restoring would delete ignored files this checkpoint never saved: ${name}/. ` +
          "Move them elsewhere, then restore again.",
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, name, "secret")), "S\n");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("a checkpoint restore goes ahead over empty ignored directories, which lose nothing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const { root, cwd, exclude } = yield* ignoredRepo("t3-restore-ignored-empty-");
    yield* fileSystem.writeFileString(path.join(cwd, "anchor"), "a\n");
    yield* runGit(root, ["add", "."]);
    yield* runGit(root, ["commit", "-m", "initial"]);
    yield* fileSystem.writeFileString(path.join(cwd, "a"), "one\n");
    yield* fileSystem.writeFileString(path.join(cwd, "e"), "one\n");
    yield* fileSystem.writeFileString(path.join(cwd, "n"), "one\n");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/ignored-empty");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    // `a` is now a folder holding an ignored folder of empty folders; `e` is itself an empty ignored folder, and `n` an
    // ignored folder holding only empty folders.
    yield* fileSystem.remove(path.join(cwd, "a"));
    yield* fileSystem.makeDirectory(path.join(cwd, "a", "cache", "inner"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, "a", "x"), "x\n");
    yield* fileSystem.remove(path.join(cwd, "e"));
    yield* fileSystem.makeDirectory(path.join(cwd, "e"));
    yield* fileSystem.remove(path.join(cwd, "n"));
    yield* fileSystem.makeDirectory(path.join(cwd, "n", "sub", "deeper"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(cwd, "n", "other"));
    yield* fileSystem.writeFileString(exclude, "cache/\n/ws/e/\n/ws/n/\n");

    assert.isTrue(
      restoreAnswer(
        yield* Effect.exit(
          driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
        ),
      ),
    );
    assert.deepStrictEqual(snapshotTree(cwd), {
      a: "644 one\n",
      anchor: "644 a\n",
      e: "644 one\n",
      n: "644 one\n",
    });
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

for (const recorded of ["committed", "staged", "only written"] as const)
  for (const workspace of ["", "ws"] as const)
    it.effect(
      `a checkpoint restore keeps what git ignores by a rule it takes back (${recorded}, workspace ` +
        `${workspace || "at the top"})`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.makeVcsDriverShape();
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-rules-" });
          yield* runGit(root, ["init"]);
          yield* runGit(root, ["config", "user.email", "test@test.com"]);
          yield* runGit(root, ["config", "user.name", "Test"]);
          const cwd = path.join(root, workspace);
          const write = (relative: string, text: string) =>
            Effect.gen(function* () {
              yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
              yield* fileSystem.writeFileString(path.join(cwd, relative), text);
            });
          yield* write(".gitignore", "node_modules/\nkeep/\n");
          yield* write("app.js", "app\n");
          yield* runGit(root, ["add", "."]);
          yield* runGit(root, ["commit", "-m", "initial"]);
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/rules");
          yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

          // A later turn ignores more (`f[x]` only literally) and stops ignoring keep/; the person writes their files.
          yield* write(".gitignore", "node_modules/\n.env\nout/\nf\\[x\\]\n");
          if (recorded !== "only written") yield* runGit(root, ["add", "--", path.join(cwd, ".gitignore")]);
          if (recorded === "committed") yield* runGit(root, ["commit", "-m", "ignore more"]);
          yield* write(".env", "SECRET=1\n");
          yield* write("new/.env", "NEW=1\n");
          yield* write("new/x", "visible\n");
          yield* write("out/a", "built\n");
          yield* write("f[x]", "literal\n");
          yield* write("fx", "visible\n");
          yield* write("keep/k", "ignored at the checkpoint\n");
          yield* write("node_modules/m.js", "m\n");
          yield* write("plain.txt", "visible\n");

          assert.isTrue(
            restoreAnswer(
              yield* Effect.exit(
                driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
              ),
            ),
          );
          // Gone: what git ignores under neither the rules before the restore nor those it brought back.
          assert.deepStrictEqual(snapshotTree(cwd), {
            ".env": "644 SECRET=1\n",
            ".gitignore": "644 node_modules/\nkeep/\n",
            "app.js": "644 app\n",
            "f[x]": "644 literal\n",
            "keep/k": "644 ignored at the checkpoint\n",
            "new/.env": "644 NEW=1\n",
            "node_modules/m.js": "644 m\n",
            "out/a": "644 built\n",
          });
        }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
    );

it.effect(
  "a checkpoint restore keeps an ignored folder sitting where the index holds a file, by a rule it takes back",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd } = yield* ignoredRepo("t3-restore-rules-gone-");
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "*.log\n");
      yield* fileSystem.writeFileString(path.join(cwd, "x"), "a file\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      // `x` became a folder, never staged: the index still holds the file.
      yield* fileSystem.remove(path.join(cwd, "x"));
      yield* fileSystem.makeDirectory(path.join(cwd, "x"));
      yield* fileSystem.writeFileString(path.join(cwd, "x", "kept"), "k\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/rules-gone");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // Status leaves out an ignored folder at a path the index holds as a file.
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "*.log\nx/\n");
      yield* fileSystem.writeFileString(path.join(cwd, "x", "secret"), "S\n");

      assert.isTrue(
        restoreAnswer(
          yield* Effect.exit(
            driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
          ),
        ),
      );
      assert.deepStrictEqual(snapshotTree(cwd), {
        ".gitignore": "644 *.log\n",
        "x/kept": "644 k\n",
        "x/secret": "644 S\n",
      });
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "a checkpoint restore keeps hundreds of paths ignored by rules it takes back, one command line at a time",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const { root, cwd } = yield* ignoredRepo("t3-restore-rules-many-");
      const write = (relative: string, text: string) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true });
          yield* fileSystem.writeFileString(path.join(cwd, relative), text);
        });
      yield* write("app.js", "app\n");
      yield* runGit(root, ["add", "."]);
      yield* runGit(root, ["commit", "-m", "initial"]);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/rules-many");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // The project's first .gitignore comes after the checkpoint. Its patterns for the paths below, one each, would
      // not fit one command line: `flat/` alone takes more than one.
      yield* write(".gitignore", "*.env\n");
      yield* runGit(cwd, ["add", ".gitignore"]);
      yield* runGit(root, ["commit", "-m", "ignore secrets"]);
      const secrets = [
        ...Array.from(
          { length: 450 },
          (_, index) => `flat/secret-${String(index).padStart(4, "0")}-of-the-flat-folder.env`,
        ),
        ...Array.from({ length: 300 }, (_, index) => `deep/a${index % 30}/b/secret-${index}.env`),
        "top.env",
      ];
      for (const secret of secrets) yield* write(secret, "S\n");
      const visible = ["flat/visible.txt", "deep/a7/b/visible.txt", "deep/visible.txt", "fresh/c/v.txt", "top.txt"];
      for (const file of visible) yield* write(file, "visible\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "empty", "inner"), { recursive: true });

      assert.isTrue(
        restoreAnswer(
          yield* Effect.exit(
            driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
          ),
        ),
      );
      assert.deepStrictEqual(
        snapshotTree(cwd),
        Object.fromEntries([["app.js", "644 app\n"], ...secrets.map((secret) => [secret, "644 S\n"])].sort()),
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "fresh")));
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "empty")));
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("restores a checkpoint before the first commit without staging its files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-unborn-restore-" });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "staged\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "original\n");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/unborn");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
      yield* fileSystem.writeFileString(path.join(cwd, "added.txt"), "new\n");

      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
        "original\n",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "added.txt")));
      const staged = yield* driver.execute({
        operation: "test",
        cwd: root,
        args: ["diff", "--cached", "--name-only"],
      });
      assert.strictEqual(staged.stdout.trim(), nested ? "outside.txt" : "");
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// The real VCS process, spawning `command` wherever the driver runs git.
const vcsProcessSpawning = (command: string) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.map(VcsProcess.make, (vcsProcess) =>
      VcsProcess.VcsProcess.of({ run: (input) => vcsProcess.run({ ...input, command }) }),
    ),
  ).pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

it.effect("GitVcsDriver treats a missing git executable as outside any repository", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missing-git-" });
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provide(vcsProcessSpawning(path.join(cwd, "git"))),
    );

    assert.strictEqual(yield* driver.isInsideWorkTree(cwd), false);
    assert.strictEqual(yield* driver.detectRepository(cwd), null);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver detects a repository whose path contains a newline",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-newline-repo-" });
      const cwd = path.join(parent, "multi\nline");
      yield* fileSystem.makeDirectory(cwd);
      yield* runGit(cwd, ["init"]);
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      const repository = yield* driver.detectRepository(cwd);
      assert.strictEqual(repository?.rootPath, yield* fileSystem.realPath(cwd));
      assert.strictEqual(repository?.metadataPath, ".git");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver detects a repository whose path contains a newline",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-newline-repo-" });
      const cwd = path.join(parent, "multi\nline");
      yield* fileSystem.makeDirectory(cwd);
      yield* runGit(cwd, ["init"]);
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      const repository = yield* driver.detectRepository(cwd);
      assert.strictEqual(repository?.rootPath, yield* fileSystem.realPath(cwd));
      assert.strictEqual(repository?.metadataPath, ".git");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver still fails detection when git exists but cannot be spawned",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // A file without the execute bit fails to spawn with a permission error.
      const notExecutable = yield* fileSystem.makeTempFileScoped({ prefix: "t3-git-" });
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provide(vcsProcessSpawning(notExecutable)),
      );

      const error = yield* driver.isInsideWorkTree(process.cwd()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsProcessSpawnError");
      const detectionError = yield* driver.detectRepository(process.cwd()).pipe(Effect.flip);
      assert.strictEqual(detectionError._tag, "VcsProcessSpawnError");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  { platform: "linux", fsyncMethods: ["fsync"] },
  { platform: "darwin", fsyncMethods: ["fsync", "batch"] },
  { platform: "win32", fsyncMethods: ["fsync", "batch"] },
] as const)(
  "GitVcsDriver flushes checkpoint objects and refs to disk before publishing them on $platform",
  ({ platform, fsyncMethods }) => {
    const observedArgs: ReadonlyArray<string>[] = [];

    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      yield* driver.checkpoints.captureCheckpoint({
        cwd: "/repo",
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/turn/1"),
      });

      const writeCommands = ["add", "write-tree", "commit-tree", "update-ref"];
      const writes = observedArgs.filter((args) =>
        writeCommands.some((command) => args.includes(command)),
      );
      assert.strictEqual(writes.length, 4);
      for (const args of writes) {
        const command = args.findIndex((arg) => writeCommands.includes(arg));
        assert.deepStrictEqual(
          args.filter((arg) => arg.startsWith("core.fsyncMethod=")),
          fsyncMethods.map((method) => `core.fsyncMethod=${method}`),
        );
        for (const setting of [
          "core.fsync=objects,reference",
          ...fsyncMethods.map((method) => `core.fsyncMethod=${method}`),
        ]) {
          const index = args.indexOf(setting);
          assert.strictEqual(args[index - 1], "-c", args.join(" "));
          assert.isBelow(index, command);
        }
      }
      assert.deepStrictEqual(observedArgs.at(-1), [
        "-C",
        "/repo",
        "-c",
        "core.fsync=objects,reference",
        ...fsyncMethods.flatMap((method) => ["-c", `core.fsyncMethod=${method}`]),
        "update-ref",
        "refs/t3/checkpoints/thread/turn/1",
        "commit0000",
      ]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedArgs.push(input.args);
                const stdout = input.args.includes("write-tree")
                  ? "tree0000\n"
                  : input.args.includes("commit-tree")
                    ? "commit0000\n"
                    : input.args.includes("--git-common-dir")
                      ? ".git\n"
                      : "";
                return {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect.each(["win32", "linux"] as const)(
  "checkpoint working-tree commands enable Git long paths only on Windows (%s)",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-long-paths-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      // An unborn nested repository fails the first `add`, so recovery's listing runs too.
      yield* git(["init", "empty"]);
      // Held, then ignored: the restore's survey hashes it.
      yield* fs.writeFileString(path.join(cwd, "notes.txt"), "notes\n");
      const observedArgs: ReadonlyArray<string>[] = [];
      const platformDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            observedArgs.push(input.args);
            return liveProcess.run(input);
          },
        }),
      );

      yield* platformDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "changed\n");
      yield* fs.writeFileString(path.join(cwd, ".git", "info", "exclude"), "notes.txt\n");
      assert.isTrue(yield* platformDriver.checkpoints.restoreCheckpoint({ cwd, checkpointRef }));

      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "file.txt")), "unstaged\n");
      assert.strictEqual((yield* git(["ls-tree", checkpointRef, "--", "empty"])).stdout, "");
      for (const command of ["add", "ls-files", "status", "diff-index", "hash-object", "restore", "clean", "reset"]) {
        const calls = observedArgs.filter(
          (args) => args.includes(command) && (command !== "ls-files" || args.includes("--others")),
        );
        assert.isNotEmpty(calls, `Expected checkpoint command: ${command}`);
        for (const args of calls) {
          const setting = args.indexOf("core.longpaths=true");
          if (platform === "win32") {
            assert.strictEqual(args[setting - 1], "-c", args.join(" "));
            assert.isBelow(setting, args.indexOf(command), args.join(" "));
          } else {
            assert.strictEqual(setting, -1, args.join(" "));
          }
        }
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

const gitCommandCount = (operation: string, outcome: string) =>
  Metric.value(
    Metric.withAttributes(gitCommandsTotal, [
      ["operation", operation],
      ["outcome", outcome],
    ]),
  ).pipe(Effect.map((state) => state.count));

const gitCommandTiming = (operation: string) =>
  Metric.value(Metric.withAttributes(gitCommandDuration, [["operation", operation]]));

// Keep VcsProcess's exit classification; replace only the subprocess and its clock.
const makeMeteredDriver = Effect.fn("test.makeMeteredDriver")(function* (exitCode: number) {
  const process = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () =>
        TestClock.adjust("250 millis").pipe(
          Effect.as({
            code: ChildProcessSpawner.ExitCode(exitCode),
            stdout: "git output",
            stderr: exitCode === 0 ? "" : "fatal: test failure",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        ),
    }),
  );
  return yield* GitVcsDriver.makeVcsDriverShape().pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
  );
});

it.effect("GitVcsDriver meters each git command once under its operation", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.resolveHeadCommit";
    const driver = yield* makeMeteredDriver(0);

    const result = yield* driver.execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] });
    yield* driver.execute({ operation, cwd: "/another-repo", args: ["rev-parse", "other-ref"] });

    assert.strictEqual(result.stdout, "git output");
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 2);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 2);
    assert.strictEqual(timing.sum, 500);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("GitVcsDriver counts an allowed non-zero exit as a success", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.hasHeadCommit";
    const driver = yield* makeMeteredDriver(1);

    const result = yield* driver.execute({
      operation,
      cwd: "/repo",
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    });

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("GitVcsDriver counts a failed git command as a failure", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.resolveHeadCommit";
    const driver = yield* makeMeteredDriver(128);

    const error = yield* driver
      .execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "VcsProcessExitError");
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("checkpoint capture meters every git process it starts, including streamed ones", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    let started = 0;
    let streamed = 0;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.operation === operation) {
            started++;
            if (input.onStdoutChunk !== undefined) streamed++;
          }
          return liveProcess.run(input);
        },
      }),
    );
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-metrics-" });
    const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.isAbove(streamed, 0);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), started);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    assert.strictEqual((yield* gitCommandTiming(operation)).count, started);
  }).pipe(
    Effect.scoped,
    Effect.provide(layerGitContract),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("git metrics finalize cancellation without exposing arbitrary operation labels", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, process),
    );
    const operation = "arbitrary operation /private/path";
    const fiber = yield* driver
      .execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("250 millis");
    yield* Fiber.interrupt(fiber);

    assert.strictEqual(yield* gitCommandCount("other", "interrupt"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "interrupt"), 0);
    const timing = yield* gitCommandTiming("other");
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("git metrics count fsync fallback and transient retry subprocesses separately", () =>
  Effect.gen(function* () {
    const retryReady = yield* Deferred.make<void>();
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    let attempts = 0;
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            attempts++;
            yield* TestClock.adjust("250 millis");
            if (attempts === 2) {
              assert.include(input.args, "core.fsyncMethod=writeout-only");
              yield* Deferred.succeed(retryReady, undefined);
            }
            return {
              code: ChildProcessSpawner.ExitCode(attempts < 3 ? 128 : 0),
              stdout: "",
              stderr:
                attempts === 1
                  ? "fatal: fsync error on '.git/objects/test': Operation not supported"
                  : attempts === 2
                    ? "fatal: Unable to create '/repo/.git/index.lock': File exists."
                    : "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    );
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, process),
    );
    const fiber = yield* driver
      .execute({ operation, cwd: "/repo", args: ["-c", "core.fsyncMethod=batch", "add"] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(retryReady);
    yield* TestClock.adjust("75 millis");
    yield* Fiber.join(fiber);

    assert.strictEqual(attempts, 3);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 2);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 1);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 3);
    assert.strictEqual(timing.sum, 750);
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);
