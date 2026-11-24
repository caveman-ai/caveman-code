// ), apps/server/src/vcs/GitVcsDriverCore.test.ts @ ab3a3cd1; perf from d6888999db, e2cc34f1e4, b8d9637003, be21de48bc, cfbd463110, c1c6be8b87, 8de7e3502c.
// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { writeFakeCli } from "@caveman-app/engine-testing/fakeCli";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";

import {
  GitCommandError,
  ReviewDiffPreviewInput,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@caveman-app/protocol";
import { symlinksSupported } from "@caveman-app/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import { gitCommandDuration } from "../observability/Metrics.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  windowsLongPathConfigEnv,
  worktreeChange,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitConfigEnv } from "./VcsProcess.ts";
import { emptyWorktreeTrash } from "./worktreeRemoval.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

// Releases the lock as soon as a matching git command fails on it, before the driver retries.
const makeDriverReleasingLock = (
  matches: (args: ReadonlyArray<string>) => boolean,
  lockPath: string,
) =>
  Effect.gen(function* () {
    const failures = yield* Ref.make(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const handle = yield* delegate.spawn(command);
        if (!ChildProcess.isStandardCommand(command) || !matches(command.args.map(String)))
          return handle;
        return ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: handle.exitCode.pipe(
            Effect.tap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Ref.update(failures, (count) => count + 1).pipe(
                    Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                    Effect.orDie,
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
    return { driver, failures };
  });

describe("Git output collection", () => {
  // Git writes in arbitrary chunk sizes; one byte per chunk splits every
  // multibyte character across reads.
  const byteChunks = (text: string) =>
    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
  const makeDriver = (output: { stdout?: string; stderr?: string }) =>
    makeGitVcsDriverCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              stdout: byteChunks(output.stdout ?? ""),
              stderr: byteChunks(output.stderr ?? ""),
            }),
          ),
        ),
      ),
    );

  it.effect("returns the same split UTF-8 and NUL output with and without line callbacks", () =>
    Effect.gen(function* () {
      const stdout = "a\\b\0雪\nlast ";
      const stderr = "Receiving é\r\nUpdating 雪\rdone";
      const driver = yield* makeDriver({ stdout, stderr });
      const input = { operation: "test.chunkedGitOutput", cwd: "/repo", args: ["status"] };
      const expected = {
        exitCode: 0,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };

      assert.deepEqual(yield* driver.execute(input), expected);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const withCallbacks = yield* driver.execute({
        ...input,
        progress: {
          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
        },
      });
      assert.deepEqual(withCallbacks, expected);
      assert.deepEqual(stdoutLines, ["a\\b\0雪", "last "]);
      assert.deepEqual(stderrLines, ["Receiving é", "Updating 雪", "done"]);
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("caps output without line callbacks", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver({ stderr: "é雪\rdone" });
      const input = {
        operation: "test.cappedGitOutput",
        cwd: "/repo",
        args: ["status"],
        maxOutputBytes: 3,
      };

      const truncated = yield* driver.execute({ ...input, appendTruncationMarker: true });
      assert.equal(truncated.stderr, "é\uFFFD");
      assert.isTrue(truncated.stderrTruncated);

      const error = yield* driver.execute(input).pipe(Effect.flip);
      assert.equal(error.outputLength, 4);
      assert.include(error.detail, "exceeded 3 bytes");
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.effect("bounds Git bursts across drivers without timing out queued commands", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const starts = yield* Queue.unbounded<number>();
    let active = 0;
    let peak = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          peak = Math.max(peak, ++active);
          yield* Queue.offer(starts, active);
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulHandle("ok"),
            exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          });
        }),
        () => Effect.sync(() => active--),
      ),
    );
    const drivers = yield* Effect.all(
      Array.from({ length: 16 }, () =>
        makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    const burst = yield* Effect.forEach(
      drivers,
      (driver, index) =>
        driver.execute({
          operation: "test.gitBurst",
          cwd: "/repo",
          args: ["rev-parse", "HEAD"],
          ...(index < 4 ? {} : { timeoutMs: index < 8 ? 30_000 : 1_000 }),
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("2 seconds");
    assert.equal(yield* Queue.size(starts), 8);
    assert.equal(peak, 8);
    yield* Deferred.succeed(gate, undefined);
    const results = yield* Fiber.join(burst);
    assert.equal(results.length, 16);
    assert.isTrue(results.every((result) => result.stdout === "ok" && result.exitCode === 0));
    assert.equal(peak, 8);
    assert.equal(active, 0);
    const duration = yield* Metric.value(
      Metric.withAttributes(gitCommandDuration, [["operation", "test.gitBurst"]]),
    );
    assert.equal(duration.count, 16);
    assert.equal(duration.sum, 16_000);
  }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))),
);

it.effect.each([{ timeoutMs: null }, { timeoutMs: 30_001 }])(
  "keeps all Git slots available with a pending command whose timeout is $timeoutMs",
  ({ timeoutMs }) =>
    Effect.gen(function* () {
      const slowGate = yield* Deferred.make<void>();
      const fastGate = yield* Deferred.make<void>();
      const starts = yield* Queue.unbounded<void>();
      let active = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            active++;
            yield* Queue.offer(starts, undefined);
            const gate =
              ChildProcess.isStandardCommand(command) && command.args[0] === "push"
                ? slowGate
                : fastGate;
            return ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle("ok"),
              exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
          () => Effect.sync(() => active--),
        ),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const slow = yield* driver
        .execute({ operation: "test.slowGit", cwd: "/repo", args: ["push"], timeoutMs })
        .pipe(Effect.forkChild);
      yield* Queue.take(starts);
      const burst = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          driver.execute({ operation: "test.fastGit", cwd: "/repo", args: ["status"] }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("0 seconds");
      assert.equal(yield* Queue.size(starts), 8);
      assert.equal(active, 9);
      yield* Deferred.succeed(fastGate, undefined);
      assert.equal((yield* Fiber.join(burst)).length, 8);
      assert.equal(active, 1);
      yield* Deferred.succeed(slowGate, undefined);
      assert.equal((yield* Fiber.join(slow)).stdout, "ok");
      assert.equal(active, 0);
    }).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))),
);

describe("worktree changes of one repository", () => {
  const checkoutProgress = new TextEncoder().encode("Updating files:   0% (1/100)\r");

  // A stand-in git. Each of `folders` is a repository of its own, or a worktree of the repository it names. A
  // `git worktree` command runs until the test ends it, and prints a checkout's first progress line when the
  // test says its checkout began.
  const makeGit = (folders: Readonly<Record<string, string | null>> = { "/repo": null }) =>
    Effect.gen(function* () {
      const running = new Map<
        string,
        { readonly checkoutBegan: Deferred.Deferred<void>; readonly ended: Deferred.Deferred<void> }
      >();
      const started: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            return yield* Effect.die("expected Git command");
          const cwd = String(command.options.cwd);
          if (!command.args.includes("worktree")) {
            return makeSuccessfulHandle(
              command.args.includes("--git-common-dir") ? `${folders[cwd] ?? cwd}/.git\n` : "",
            );
          }
          const name = String(command.args.at(-1));
          if (name === "found") return makeSuccessfulHandle("");
          const run = {
            checkoutBegan: yield* Deferred.make<void>(),
            ended: yield* Deferred.make<void>(),
          };
          running.set(name, run);
          started.push(name);
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulHandle(""),
            exitCode: Deferred.await(run.ended).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            // Ends with the command at the latest, as a real git's stderr does.
            stderr: Stream.fromEffect(
              Effect.raceFirst(
                Deferred.await(run.checkoutBegan).pipe(Effect.as(checkoutProgress)),
                Deferred.await(run.ended).pipe(Effect.as(new Uint8Array())),
              ),
            ),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const run = (cwd: string, verb: "add" | "remove" | "prune", name: string) =>
        driver.execute({ operation: "test.worktree", cwd, args: ["worktree", verb, name], timeoutMs: null });
      // Each folder's repository is found once, ahead of the test: finding it reads the disk, which no step of
      // the test clock waits for, and it is remembered for ten minutes.
      yield* Effect.forEach(Object.keys(folders), (cwd) => run(cwd, "prune", "found"));
      const change = (cwd: string, verb: "add" | "remove" | "prune", name: string) =>
        run(cwd, verb, name).pipe(Effect.forkChild);
      const checkoutBegins = (name: string) => Deferred.succeed(running.get(name)!.checkoutBegan, undefined);
      const ends = (name: string) => Deferred.succeed(running.get(name)!.ended, undefined);
      // What git has been asked to run so far, once every fiber has gone as far as it can.
      const startedAfter = (duration: Duration.Input) =>
        TestClock.adjust(duration).pipe(Effect.map(() => [...started]));
      return { change, checkoutBegins, ends, startedAfter };
    });
  const provided = Effect.provide(
    layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("run one at a time, whichever of its folders they are asked from", () =>
    Effect.gen(function* () {
      const git = yield* makeGit({ "/repo": null, "/worktrees/chat": "/repo", "/other-repo": null });
      const first = yield* git.change("/repo", "add", "first");
      assert.deepEqual(yield* git.startedAfter(0), ["first"]);
      const second = yield* git.change("/worktrees/chat", "prune", "second");
      yield* git.startedAfter(0);
      const third = yield* git.change("/repo", "remove", "third");
      yield* git.startedAfter(0);
      const elsewhere = yield* git.change("/other-repo", "add", "elsewhere");
      // Another repository's never wait; this one's do, for however long a quick command takes.
      assert.deepEqual(yield* git.startedAfter("1 second"), ["first", "elsewhere"]);

      yield* git.ends("first");
      assert.deepEqual(yield* git.startedAfter(0), ["first", "elsewhere", "second"]);
      yield* git.ends("second");
      assert.deepEqual(yield* git.startedAfter(0), ["first", "elsewhere", "second", "third"]);
      yield* git.ends("third");
      yield* git.ends("elsewhere");
      yield* Fiber.joinAll([first, second, third, elsewhere]);
    }).pipe(provided),
  );

  it.effect("let the next begin once a long add is checking out", () =>
    Effect.gen(function* () {
      const git = yield* makeGit();
      const slow = yield* git.change("/repo", "add", "slow");
      const next = yield* git.change("/repo", "add", "next");
      // However long it takes: until its checkout begins, the worktree may still be half registered.
      assert.deepEqual(yield* git.startedAfter("5 minutes"), ["slow"]);
      yield* git.checkoutBegins("slow");
      assert.deepEqual(yield* git.startedAfter(0), ["slow", "next"]);

      // One whose checkout begins at once still keeps the others out for the hold's two seconds.
      const last = yield* git.change("/repo", "add", "last");
      yield* git.checkoutBegins("next");
      assert.deepEqual(yield* git.startedAfter("1 second"), ["slow", "next"]);
      assert.deepEqual(yield* git.startedAfter("1 second"), ["slow", "next", "last"]);

      yield* Effect.forEach(["slow", "next", "last"], git.ends);
      yield* Fiber.joinAll([slow, next, last]);
    }).pipe(provided),
  );

  it.effect("let the next begin two seconds into a long remove, and wait out a prune", () =>
    Effect.gen(function* () {
      const git = yield* makeGit();
      const removal = yield* git.change("/repo", "remove", "removal");
      const prune = yield* git.change("/repo", "prune", "prune");
      assert.deepEqual(yield* git.startedAfter("1 second"), ["removal"]);
      assert.deepEqual(yield* git.startedAfter("1 second"), ["removal", "prune"]);

      const add = yield* git.change("/repo", "add", "add");
      assert.deepEqual(yield* git.startedAfter("5 minutes"), ["removal", "prune"]);
      yield* git.ends("prune");
      assert.deepEqual(yield* git.startedAfter(0), ["removal", "prune", "add"]);

      yield* Effect.forEach(["removal", "add"], git.ends);
      yield* Fiber.joinAll([removal, prune, add]);
    }).pipe(provided),
  );

  it.effect("give a plain worktree add a checkout's deadline and keep it off the process limit", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const progressDelays: Array<string> = [];
      let statuses = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) return makeSuccessfulHandle("");
          if (command.args.includes("--git-common-dir")) return makeSuccessfulHandle(".git\n");
          if (command.args.includes("add")) progressDelays.push(String(command.options.env?.GIT_PROGRESS_DELAY));
          else if (command.args.includes("status")) statuses++;
          else return makeSuccessfulHandle("");
          // The add and every status run until their deadline.
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulHandle(""),
            exitCode: Deferred.await(never).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      // The repository is found ahead of the test: that reads the disk, which the test clock does not wait for.
      yield* driver.pruneWorktrees({ cwd: "/repo" });
      // As session-protocol's git runs it on a Cloud computer: no timeout of its own.
      const add = yield* driver
        .execute({
          operation: "session-protocol.-c",
          cwd: "/repo",
          args: ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "chat", "--", "/wt", "main"],
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(0);
      // Started, and told to name the files of its checkout from the first one on.
      assert.deepEqual(progressDelays, ["0"]);

      // It holds none of the eight process slots: eight short commands all start beside it.
      yield* Effect.all(
        Array.from({ length: 8 }, () =>
          driver.execute({ operation: "test.status", cwd: "/repo", args: ["status"] }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(0);
      assert.equal(statuses, 8);

      // Their 30 seconds pass, and it runs on to the five minutes a checkout gets.
      yield* TestClock.adjust("299 seconds");
      assert.isUndefined(add.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.join(add);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "Git command timed out.");
    }).pipe(provided),
  );

  it.effect("keep a checkout's progress out of the stderr a caller did not ask it for", () =>
    Effect.gen(function* () {
      const stderr =
        "Preparing worktree (new branch 'chat')\nUpdating files:   0% (1/2)\rUpdating files: 100% (2/2)\rUpdating files: 100% (2/2), done.\nerror: unable to create file a.txt: Permission denied\n";
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr))),
        ),
      );
      const add = (env?: NodeJS.ProcessEnv) =>
        driver.execute({
          operation: "test.worktree",
          cwd: "/repo",
          args: ["worktree", "add", "/wt", "main"],
          allowNonZeroExit: true,
          ...(env ? { env } : {}),
        });

      assert.equal(
        (yield* add()).stderr,
        "Preparing worktree (new branch 'chat')\nerror: unable to create file a.txt: Permission denied\n",
      );
      assert.equal((yield* add({ GIT_PROGRESS_DELAY: "0" })).stderr, stderr);
    }).pipe(provided),
  );

  it("are told from every other git command by their subcommand", () => {
    assert.equal(worktreeChange(["worktree", "add", "--", "/wt", "main"]), "add");
    assert.equal(
      worktreeChange(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "x", "--", "/wt", "main"]),
      "add",
    );
    assert.equal(worktreeChange(["-c", "status.showUntrackedFiles=normal", "worktree", "remove", "--force", "--", "/wt"]), "remove");
    assert.equal(worktreeChange(["--git-dir", "/repo/.git", "--work-tree", "/repo", "--no-pager", "worktree", "prune"]), "prune");
    assert.equal(worktreeChange(["-C", "worktree", "status"]), null);
    assert.equal(worktreeChange(["worktree", "list", "--porcelain"]), null);
    assert.equal(worktreeChange(["commit", "-m", "worktree add"]), null);
    assert.equal(worktreeChange(["worktree"]), null);
    assert.equal(worktreeChange([]), null);
  });
});

it.effect.each(["root", "nested", "worktree"] as const)(
  "skips clean filters while the %s index is locked and resumes after unlock",
  (location) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* makeTmpDir();
      yield* initRepoWithCommit(repository);
      const cwd = location === "worktree" ? yield* makeTmpDir() : repository;
      if (location === "worktree") {
        yield* git(repository, ["worktree", "add", "--detach", cwd]);
      }
      yield* git(cwd, ["config", "filter.probe.clean", "echo clean >> .filter-runs; cat"]);
      yield* writeTextFile(cwd, ".gitattributes", "asset.bin filter=probe\n");
      yield* writeTextFile(cwd, ".gitignore", ".filter-runs\n");
      yield* writeTextFile(cwd, "asset.bin", "original\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "filtered asset"]);
      NodeFS.utimesSync(path.join(cwd, "asset.bin"), 1, 1);
      const runsPath = path.join(cwd, ".filter-runs");
      yield* fs.remove(runsPath, { force: true });
      const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const lockPath = `${path.resolve(cwd, indexPath)}.lock`;
      yield* fs.writeFileString(lockPath, "");
      const statusCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
      yield* fs.makeDirectory(statusCwd, { recursive: true });

      for (let poll = 0; poll < 3; poll++) {
        const result = yield* driver.statusDetailsLocal(statusCwd).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.include(result.failure.detail, "index is locked");
      }
      assert.isFalse(yield* fs.exists(runsPath));
      assert.isTrue(yield* fs.exists(lockPath));

      yield* fs.remove(lockPath);
      const status = yield* driver.statusDetailsLocal(statusCwd);
      assert.isFalse(status.hasWorkingTreeChanges);
      assert.include(yield* fs.readFileString(runsPath), "clean");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("uses stable diagnostics for every parsed non-repository command", () => {
  const commands: Array<{ readonly args: ReadonlyArray<string>; readonly language?: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        return assert.fail("expected a standard Git command");
      }
      commands.push({
        args: command.args.map(String),
        ...(command.options.env?.LANGUAGE ? { language: String(command.options.env.LANGUAGE) } : {}),
      });
      return makeNonRepositoryHandle();
    }),
  );
  const layerNodeServices = Layer.merge(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(layerServerConfig),
    Layer.provideMerge(layerNodeServices),
  );

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = "/repo";

    yield* driver.statusDetailsLocal(cwd);
    yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
    yield* driver.listRefs({ cwd });

    // Status reads run side by side, so their order is not fixed. The default-branch and origin reads only look at
    // the exit code, so they keep the person's locale.
    const byArgs = (list: typeof commands) =>
      list.toSorted((a, b) => a.args.join(" ").localeCompare(b.args.join(" ")));
    assert.deepStrictEqual(byArgs(commands), byArgs([
      { args: ["rev-parse", "--git-path", "index"], language: "C" },
      { args: ["rev-parse", "--git-common-dir"], language: "C" },
      { args: ["status", "--porcelain=2", "--branch", "-z"], language: "C" },
      { args: ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"], language: "C" },
      { args: ["symbolic-ref", "refs/remotes/origin/HEAD"] },
      { args: ["remote", "get-url", "--", "origin"] },
      { args: ["rev-parse", "--symbolic-full-name", "HEAD"], language: "C" },
    ]));
  }).pipe(Effect.provide(layer));
});

it.effect("invalidates origin remote cache when a driver mutation adds origin", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    const before = yield* driver.statusDetailsLocal(cwd);
    assert.equal(before.hasOriginRemote, false);

    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });

    const after = yield* driver.statusDetailsLocal(cwd);
    assert.equal(after.hasOriginRemote, true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("re-reads origin remote status after cache TTL expiry and bypassed invalidation", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    // First call caches hasOriginRemote = false (5-min TTL)
    assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);

    // Add origin via raw git (bypasses invalidation hook)
    yield* git(cwd, ["remote", "add", "origin", remote]);

    // Cache still has the stale false (TTL not yet expired)
    const stillCached = yield* driver.statusDetailsLocal(cwd);
    assert.equal(stillCached.hasOriginRemote, false);

    // Advance past the 5-minute TTL so the cache entry expires
    yield* TestClock.adjust("6 minutes");

    // After expiry, the next call re-executes and picks up the remote
    const afterExpiry = yield* driver.statusDetailsLocal(cwd);
    assert.equal(afterExpiry.hasOriginRemote, true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("coalesces concurrent ref pages into one repository snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const remoteNamesScanCompleted = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          yield* Ref.update(spawnedArgs, (current) => [...current, command.args.map(String)]);
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          const shouldDelay =
            isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false));
          if (shouldDelay) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Effect.sleep("8 seconds");
          }
          const handle = yield* delegate.spawn(command);
          const isRemoteNamesScan =
            command.args.length === 3 &&
            command.args[0] === "--git-dir" &&
            command.args[2] === "remote";
          return isRemoteNamesScan
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(remoteNamesScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const cwd = yield* makeTmpDir();
      const runGit = (args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.coalescedListRefs",
          cwd,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(["config", "user.email", "test@test.com"]);
      yield* runGit(["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(["add", "."]);
      yield* runGit(["commit", "-m", "initial commit"]);
      yield* Ref.set(spawnedArgs, []);

      const initialRequest = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(remoteNamesScanCompleted);
      yield* TestClock.adjust("6 seconds");
      const laterRequests = yield* Effect.all(
        Array.from({ length: 30 }, (_, index) =>
          driver.listRefs({
            cwd,
            refresh: true,
            query: `missing-${index}`,
            limit: 100,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(initialRequest);
      yield* Fiber.join(laterRequests);
      yield* driver.listRefs({ cwd, cursor: 1, limit: 100 });

      const firstSnapshotCommands = yield* Ref.get(spawnedArgs);
      const snapshotRefScans = firstSnapshotCommands.filter(
        (args) =>
          args.includes("for-each-ref") &&
          args.includes("refs/heads") &&
          args.includes("refs/remotes"),
      );
      const worktreeScans = firstSnapshotCommands.filter(
        (args) => args.includes("worktree") && args.includes("--porcelain"),
      );
      assert.equal(snapshotRefScans.length, 1);
      assert.equal(worktreeScans.length, 1);

      yield* driver.createRef({ cwd, refName: "feature/cache-invalidation" });
      const refreshed = yield* driver.listRefs({ cwd, limit: 100 });
      assert.equal(
        refreshed.refs.some((ref) => ref.name === "feature/cache-invalidation"),
        true,
      );
      const allCommands = yield* Ref.get(spawnedArgs);
      assert.equal(
        allCommands.filter(
          (args) =>
            args.includes("for-each-ref") &&
            args.includes("refs/heads") &&
            args.includes("refs/remotes"),
        ).length,
        2,
      );
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))),
);

it.effect.each([
  { hookExitCode: 0, commonDirFailure: "none" },
  { hookExitCode: 1, commonDirFailure: "none" },
  { hookExitCode: 0, commonDirFailure: "error" },
  { hookExitCode: 1, commonDirFailure: "error" },
  { hookExitCode: 0, commonDirFailure: "non-repository" },
  { hookExitCode: 1, commonDirFailure: "non-repository" },
])(
  "invalidates sibling worktree refs and status after checkout hook exit $hookExitCode with common-dir failure $commonDirFailure",
  ({ hookExitCode, commonDirFailure }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        let invalidationFailure = "none";
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            spawnedArgs.push(command.args.map(String));
            if (invalidationFailure !== "none" && command.args.includes("--git-common-dir")) {
              if (invalidationFailure === "non-repository") return makeNonRepositoryHandle();
              return ChildProcessSpawner.makeHandle({
                ...makeNonRepositoryHandle(),
                stderr: Stream.encodeText(Stream.make("fatal: could not read repository metadata")),
              });
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const siblingPath = path.join(yield* makeTmpDir("git-worktrees-"), "sibling");
        yield* git(cwd, ["worktree", "add", "-b", "cache-sibling", siblingPath, "HEAD"]);

        const before = yield* driver.listRefs({ cwd: siblingPath, refresh: true });
        assert.isTrue(before.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusBefore = yield* driver.statusDetailsLocal(siblingPath);
        assert.isFalse(statusBefore.hasOriginRemote);
        assert.isFalse(statusBefore.isDefaultBranch);
        yield* driver.listRefs({ cwd, refresh: true });
        yield* git(cwd, ["checkout", "-b", "creator-current"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\n" +
            "git remote add origin https://example.invalid/repo.git || exit 2\n" +
            "git update-ref refs/remotes/origin/cache-sibling HEAD || exit 2\n" +
            "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/cache-sibling || exit 2\n" +
            `exit ${hookExitCode}\n`,
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "created");
        spawnedArgs.length = 0;
        invalidationFailure = commonDirFailure;

        const created = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/cache-created",
          })
          .pipe(Effect.result);

        assert.equal(Result.isSuccess(created), hookExitCode === 0);
        if (Result.isFailure(created)) {
          assert.equal(created.failure.operation, "GitVcsDriver.createWorktree");
          assert.equal(created.failure.detail, "git worktree add failed");
          assert.equal(created.failure.exitCode, hookExitCode);
        }
        const metadataQueries = spawnedArgs.filter((args) => args.includes("--git-common-dir"));
        assert.deepStrictEqual(metadataQueries, [["rev-parse", "--git-common-dir"]]);
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        invalidationFailure = "none";

        spawnedArgs.length = 0;
        const creatorStatus = yield* driver.statusDetailsLocal(cwd);
        assert.equal(creatorStatus.branch, "creator-current");
        assert.isTrue(spawnedArgs.some((args) => args.includes("--git-common-dir")));
        const siblingRefs = yield* driver.listRefs({ cwd: siblingPath });
        const createdRef = siblingRefs.refs.find((ref) => ref.name === "feature/cache-created");
        assert.isDefined(createdRef?.worktreePath);
        assert.equal(
          NodeFS.realpathSync.native(createdRef!.worktreePath!),
          NodeFS.realpathSync.native(worktreePath),
        );
        assert.isTrue(siblingRefs.hasPrimaryRemote);
        assert.isTrue(siblingRefs.refs.find((ref) => ref.name === "cache-sibling")?.current);
        const statusAfter = yield* driver.statusDetailsLocal(siblingPath);
        assert.isTrue(statusAfter.hasOriginRemote);
        assert.isTrue(statusAfter.isDefaultBranch);
        const creatorRefs = yield* driver.listRefs({ cwd });
        assert.isTrue(creatorRefs.refs.find((ref) => ref.name === "creator-current")?.current);
        assert.isFalse(creatorRefs.refs.find((ref) => ref.name === initialBranch)?.current);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["branch", "detached", "nested", "aliased-root", "aliased-nested"] as const)(
  "discovers only the common directory during worktree creation from %s",
  (location) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        if (location === "detached") yield* git(cwd, ["checkout", "--detach"]);
        const isNested = location === "nested" || location === "aliased-nested";
        const physicalCwd = isNested ? path.join(cwd, "nested") : cwd;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(physicalCwd, { recursive: true });
        const isAliased = location === "aliased-root" || location === "aliased-nested";
        const creationCwd = isAliased
          ? path.join(yield* makeTmpDir("git-alias-"), "link")
          : physicalCwd;
        if (isAliased) NodeFS.symlinkSync(physicalCwd, creationCwd, "junction");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "cold");

        yield* driver.createWorktree({
          cwd: creationCwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/cold",
        });

        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        assert.isFalse(spawnedArgs.some((args) => args.includes("--show-toplevel")));
        assert.isFalse(spawnedArgs.some((args) => args.includes("symbolic-ref")));
        spawnedArgs.length = 0;
        const originalStatus = yield* driver.statusDetailsLocal(creationCwd);
        assert.equal(originalStatus.branch, location === "detached" ? null : initialBranch);
        const originalRefs = yield* driver.listRefs({ cwd: creationCwd });
        assert.deepStrictEqual(
          originalRefs.refs.filter((ref) => ref.current).map((ref) => ref.name),
          location === "detached" ? [] : [initialBranch],
        );
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        const refs = yield* driver.listRefs({ cwd: worktreePath });
        assert.isTrue(refs.refs.find((ref) => ref.name === "feature/cold")?.current);
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each(["bare", "unborn"] as const)(
  "invalidates a %s repository after worktree creation",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* makeTmpDir();
        const cwd = yield* makeTmpDir("git-discovery-fallback-");
        if (state === "bare") {
          yield* initRepoWithCommit(source);
          yield* git(source, ["clone", "--bare", source, cwd]);
        } else {
          yield* git(cwd, ["init"]);
        }
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
          return delegate.spawn(
            state === "bare" ? ChildProcess.setEnv(command, { GIT_DIR: cwd }) : command,
          );
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "fallback");
        const result = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/fallback",
          })
          .pipe(Effect.result);
        assert.equal(Result.isSuccess(result), state === "bare");
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.createWorktree.createBranch");
          assert.equal(result.failure.detail, "git worktree add failed");
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
        assert.isFalse(spawnedArgs.some((args) => args[0] === "symbolic-ref"));
        spawnedArgs.length = 0;
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.isRepo);
        if (state === "bare") {
          assert.isTrue(refs.refs.some((ref) => ref.name === "feature/fallback"));
        } else {
          assert.isEmpty(refs.refs);
        }
        assert.equal(spawnedArgs.filter((args) => args.includes("--git-common-dir")).length, 1);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves embedded newlines in repository paths after worktree creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const cwd = path.join(yield* makeTmpDir(), "repo\nwith-newline");
        yield* fs.makeDirectory(cwd);
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "newline");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/newline",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/newline"));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "preserves a trailing carriage return in the repository root after creation through an alias",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const sandbox = yield* makeTmpDir();
        const repository = path.join(sandbox, "repo\r");
        const cwd = path.join(sandbox, "alias");
        yield* fs.makeDirectory(repository);
        const { initialBranch } = yield* initRepoWithCommit(repository);
        NodeFS.symlinkSync(repository, cwd, "junction");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "created"),
          refName: initialBranch,
          newRefName: "feature/carriage-return",
        });
        const status = yield* driver.statusDetailsLocal(cwd);
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(repository));
        assert.equal(status.branch, initialBranch);
        const refs = yield* driver.listRefs({ cwd });
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/carriage-return"));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reads fresh metadata when another mutation completes during common-directory discovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const discoveryComplete = yield* Deferred.make<void>();
        const releaseDiscovery = yield* Deferred.make<void>();
        let holdDiscovery = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (
              !holdDiscovery ||
              !ChildProcess.isStandardCommand(command) ||
              !command.args.includes("--git-common-dir")
            )
              return handle;
            holdDiscovery = false;
            const output = yield* Stream.runCollect(handle.stdout);
            yield* handle.exitCode;
            yield* Deferred.succeed(discoveryComplete, undefined);
            yield* Deferred.await(releaseDiscovery);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              stdout: Stream.fromIterable(output),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* driver.listRefs({ cwd, refresh: true });
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "concurrent");
        holdDiscovery = true;
        const creation = yield* driver
          .createWorktree({
            cwd,
            path: worktreePath,
            refName: "HEAD",
            newRefName: "feature/concurrent",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.gen(function* () {
          yield* Deferred.await(discoveryComplete);
          yield* driver.switchRef({ cwd, refName: commit });
        }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
        const created = yield* Fiber.join(creation);
        assert.equal(created.worktree.path, worktreePath);
        const refs = yield* driver.listRefs({ cwd });
        assert.isEmpty(refs.refs.filter((ref) => ref.current));
        assert.isTrue(refs.refs.some((ref) => ref.name === "feature/concurrent"));
        assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, null);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("invalidates cached metadata after interrupted worktree creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const discoveryComplete = yield* Deferred.make<void>();
      const releaseDiscovery = yield* Deferred.make<void>();
      let holdDiscovery = false;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (
            !holdDiscovery ||
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("--git-common-dir")
          )
            return handle;
          holdDiscovery = false;
          const output = yield* Stream.runCollect(handle.stdout);
          yield* handle.exitCode;
          yield* Deferred.succeed(discoveryComplete, undefined);
          yield* Deferred.await(releaseDiscovery);
          return ChildProcessSpawner.makeHandle({ ...handle, stdout: Stream.fromIterable(output) });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* driver.listRefs({ cwd, refresh: true });
      yield* driver.statusDetailsLocal(cwd);
      yield* git(cwd, ["checkout", "-b", "creator-current"]);
      const path = yield* Path.Path;
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "interrupted");
      holdDiscovery = true;
      const creation = yield* driver
        .createWorktree({
          cwd,
          path: worktreePath,
          refName: "HEAD",
          newRefName: "feature/interrupted",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const cancellation = yield* Effect.gen(function* () {
        yield* Deferred.await(discoveryComplete);
        return yield* Fiber.interrupt(creation).pipe(Effect.forkChild({ startImmediately: true }));
      }).pipe(Effect.ensuring(Deferred.succeed(releaseDiscovery, undefined)));
      yield* Fiber.join(cancellation);
      const exit = yield* Fiber.await(creation);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.find((ref) => ref.name === "creator-current")?.current);
      const interruptedRef = refs.refs.find((ref) => ref.name === "feature/interrupted");
      assert.isDefined(interruptedRef?.worktreePath);
      assert.equal(
        NodeFS.realpathSync.native(interruptedRef!.worktreePath!),
        NodeFS.realpathSync.native(worktreePath),
      );
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, "creator-current");
      const nextPath = path.join(yield* makeTmpDir("git-worktrees-"), "after-interruption");
      yield* driver.createWorktree({
        cwd,
        path: nextPath,
        refName: "HEAD",
        newRefName: "feature/after",
      });
      assert.isTrue(
        (yield* driver.listRefs({ cwd })).refs.some((ref) => ref.name === "feature/after"),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

describe("pullCurrentBranch", () => {
  const controlledStatusFetch = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* makeTmpDir();
    yield* fs.makeDirectory(`${cwd}/.git`);
    const started = yield* Queue.unbounded<{
      cwd: string;
      release: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
    }>();
    const finalized = yield* Queue.unbounded<string>();
    const warnings = yield* Queue.unbounded<void>();
    const attempts = yield* Ref.make(0);
    const pulls = yield* Ref.make(0);
    const fetching = yield* Ref.make(false);
    const head = yield* Ref.make("before");
    const pullRemoteRead = yield* Deferred.make<void>();
    const logger = Logger.make<unknown, void>(() => {
      Queue.offerUnsafe(warnings, undefined);
    });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) return makeNonRepositoryHandle();
        const workingDirectory = command.options.cwd ?? cwd;
        const args = command.args;
        if (args[0] === "--git-dir" && args.includes("fetch")) {
          const release = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Ref.set(fetching, true);
          yield* Ref.update(attempts, (count) => count + 1);
          yield* Queue.offer(started, { cwd: workingDirectory, release });
          yield* Effect.addFinalizer(() => Queue.offer(finalized, workingDirectory));
          yield* Effect.addFinalizer(() => Ref.set(fetching, false));
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulHandle(""),
            stderr: Stream.encodeText(Stream.make("fatal: remote unavailable\n")),
            exitCode: Deferred.await(release),
          });
        }
        // The pull's own fetch.
        if (args[0] === "fetch") {
          yield* Ref.update(pulls, (count) => count + 1);
          if (yield* Ref.get(fetching)) {
            return ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              stderr: Stream.encodeText(
                Stream.make("error: cannot lock ref 'refs/remotes/origin/main': File exists\n"),
              ),
            });
          }
          return makeSuccessfulHandle("");
        }
        if (args[0] === "merge") {
          yield* Ref.set(head, "after");
          return makeSuccessfulHandle("");
        }
        if (args.includes("branch.main.remote")) {
          yield* Deferred.succeed(pullRemoteRead, undefined);
          return makeSuccessfulHandle("origin\n");
        }
        if (args[0] === "status")
          return makeSuccessfulHandle(
            "# branch.oid before\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -1\0",
          );
        if (args[0] === "diff-index") return makeSuccessfulHandle("");
        if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD")
          return makeSuccessfulHandle(`${yield* Ref.get(head)}\n`);
        if (args.includes("--git-common-dir"))
          return makeSuccessfulHandle(`${workingDirectory}/.git\n`);
        if (args.includes("--show-toplevel")) return makeSuccessfulHandle(`${workingDirectory}\n`);
        if (args.includes("@{upstream}")) return makeSuccessfulHandle("origin/main\n");
        if (args.includes("--format=%(upstream:remotename)"))
          return makeSuccessfulHandle("origin\n");
        if (args[0] === "remote") return makeSuccessfulHandle("origin\n");
        if (args[0] === "rev-list") return makeSuccessfulHandle("0\t0\n");
        if (args.includes("refs/remotes/origin/HEAD"))
          return makeSuccessfulHandle("refs/remotes/origin/main\n");
        return makeSuccessfulHandle("main\n");
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const status = Effect.fn("test.controlledStatusFetch.status")((directory = cwd) =>
      driver
        .statusDetailsRemote(directory)
        .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
    );
    return { cwd, driver, status, started, finalized, warnings, attempts, pulls, pullRemoteRead };
  });

  it.effect.each([0, 128])(
    "waits for an existing status fetch before pulling after fetch exit %s",
    (exitCode) =>
      Effect.gen(function* () {
        const fixture = yield* controlledStatusFetch;
        const status = yield* fixture.status().pipe(Effect.forkScoped);
        const fetch = yield* Queue.take(fixture.started);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(status);

        const pull = yield* fixture.driver.pullCurrentBranch(fixture.cwd).pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.pullRemoteRead);
        yield* TestClock.adjust("30 seconds");
        assert.equal(yield* Ref.get(fixture.pulls), 0);
        yield* Deferred.succeed(fetch.release, ChildProcessSpawner.ExitCode(exitCode));

        assert.equal((yield* Fiber.join(pull)).status, "pulled");
        assert.equal(yield* Ref.get(fixture.pulls), 1);
        assert.equal(yield* Ref.get(fixture.attempts), 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
      ),
  );

  it.effect("does not start a status fetch while pulling", () =>
    Effect.gen(function* () {
      const fixture = yield* controlledStatusFetch;

      assert.equal((yield* fixture.driver.pullCurrentBranch(fixture.cwd)).status, "pulled");
      assert.equal(yield* Ref.get(fixture.pulls), 1);
      assert.equal(yield* Ref.get(fixture.attempts), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
    ),
  );

  it.effect("backs off failures after the status waiter has returned", () =>
    Effect.gen(function* () {
      const fixture = yield* controlledStatusFetch;
      const firstStatus = yield* fixture.status().pipe(Effect.forkScoped);
      const first = yield* Queue.take(fixture.started);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(firstStatus);
      yield* Deferred.succeed(first.release, ChildProcessSpawner.ExitCode(128));
      yield* Queue.take(fixture.finalized);
      yield* Queue.take(fixture.warnings);

      yield* TestClock.adjust("15 seconds");
      yield* fixture.status();
      assert.equal(yield* Ref.get(fixture.attempts), 1);

      yield* TestClock.adjust("15 seconds");
      const secondStatus = yield* fixture.status().pipe(Effect.forkScoped);
      const second = yield* Queue.take(fixture.started);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(secondStatus);
      yield* Deferred.succeed(second.release, ChildProcessSpawner.ExitCode(128));
      yield* Queue.take(fixture.finalized);
      yield* Queue.take(fixture.warnings);

      for (let i = 0; i < 3; i++) {
        yield* TestClock.adjust("15 seconds");
        yield* fixture.status();
        assert.equal(yield* Ref.get(fixture.attempts), 2);
      }
      yield* TestClock.adjust("15 seconds");
      const recoveredStatus = yield* fixture.status().pipe(Effect.forkScoped);
      const recovered = yield* Queue.take(fixture.started);
      yield* Deferred.succeed(recovered.release, ChildProcessSpawner.ExitCode(0));
      yield* Fiber.join(recoveredStatus);
      assert.equal(yield* Ref.get(fixture.attempts), 3);

      yield* TestClock.adjust("15 seconds");
      const failedAgainStatus = yield* fixture.status().pipe(Effect.forkScoped);
      const failedAgain = yield* Queue.take(fixture.started);
      yield* Deferred.succeed(failedAgain.release, ChildProcessSpawner.ExitCode(128));
      yield* Fiber.join(failedAgainStatus);
      yield* Queue.take(fixture.warnings);
      yield* TestClock.adjust("15 seconds");
      yield* fixture.status();
      assert.equal(yield* Ref.get(fixture.attempts), 4);

      yield* TestClock.adjust("15 seconds");
      const resetStatus = yield* fixture.status().pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(resetStatus);
      assert.equal(yield* Ref.get(fixture.attempts), 5);
      const reset = yield* Queue.take(fixture.started);
      yield* Deferred.succeed(reset.release, ChildProcessSpawner.ExitCode(0));
    }).pipe(
      Effect.scoped,
      Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
    ),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "bounds cleanup when a Git subprocess ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const directory = yield* makeTmpDir();
        const probe = yield* makeProcessProbe;
        writeFakeCli({
          directory,
          name: "git",
          source: `process.on("SIGTERM", () => {}); ${processProbeSource(probe.port)}`,
        });
        const run = yield* driver
          .execute({
            operation: "test.stalledStatusFetch",
            cwd: directory,
            args: ["fetch"],
            env: { PATH: `${directory}:${process.env.PATH ?? ""}` },
            timeoutMs: 1_000,
            forceKillAfterMs: 100,
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* probe.started;

        yield* TestClock.adjust("1 second");

        yield* probe.exited;
        assert.equal((yield* Fiber.join(run)).detail, "Git command timed out.");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("releases stalled background worker slots at their lifetime limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* controlledStatusFetch;
      yield* fixture.driver.listRefs({ cwd: fixture.cwd });
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const cwd = `${fixture.cwd}/repo-${i}`;
        yield* fs.makeDirectory(`${cwd}/.git`, { recursive: true });
        statuses.push(yield* fixture.status(cwd).pipe(Effect.forkScoped));
        yield* Queue.take(fixture.started);
      }
      yield* TestClock.adjust("5 seconds");
      yield* Effect.forEach(statuses, Fiber.join);
      const waiting = yield* fixture.status().pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(waiting);
      assert.equal(yield* Ref.get(fixture.attempts), 4);

      yield* TestClock.adjust(290_000);
      assert.equal(yield* Ref.get(fixture.attempts), 5);
      for (let i = 0; i < 4; i++) yield* Queue.take(fixture.finalized);
      const healthy = yield* Queue.take(fixture.started);
      assert.equal(
        NodeFS.realpathSync.native(healthy.cwd),
        NodeFS.realpathSync.native(fixture.cwd),
      );
      yield* Deferred.succeed(healthy.release, ChildProcessSpawner.ExitCode(0));
      yield* Queue.take(fixture.finalized);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
    ),
  );

  // A fast-forward that prints over 1 MB takes thousands of files, so the real pull's output is
  // padded past the cap instead.
  const withPaddedPull = (
    stream: "stdout" | "stderr",
    onPull?: (args: ReadonlyArray<string>) => void,
  ) =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const padding = new Uint8Array(1_000_001).fill(0x20);
      const paddingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          // The pull's fast-forward, which prints the diffstat.
          const isPull =
            ChildProcess.isStandardCommand(command) &&
            command.args[0] === "merge" &&
            command.args.includes("--ff-only");
          if (isPull) onPull?.(command.args.map(String));
          return isPull
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                [stream]: Stream.concat(handle[stream], Stream.make(padding)),
              })
            : handle;
        }),
      );
      return yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, paddingSpawner),
      );
    });

  const cloneBehindRemote = Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    const updater = yield* makeTmpDir("git-vcs-driver-updater-");
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", initialBranch]);
    yield* git(updater, ["clone", remote, "."]);
    yield* git(updater, ["config", "user.email", "test@test.com"]);
    yield* git(updater, ["config", "user.name", "Test"]);
    yield* writeTextFile(updater, "remote.txt", "remote\n");
    yield* git(updater, ["add", "remote.txt"]);
    yield* git(updater, ["commit", "-m", "remote commit"]);
    yield* git(updater, ["push", "origin", initialBranch]);
    return {
      cwd,
      remote,
      updater,
      initialBranch,
      remoteHead: yield* git(updater, ["rev-parse", "HEAD"]),
    };
  });

  it.effect("pulls into a branch with no commit yet once its upstream has one", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const updater = yield* makeTmpDir("git-vcs-driver-updater-");
      yield* git(remote, ["init", "--bare", "--initial-branch=main"]);
      // Cloned while the repository was empty: `main` tracks origin/main and has no commit.
      yield* git(cwd, ["clone", remote, "."]);
      yield* initRepoWithCommit(updater);
      yield* git(updater, ["push", remote, "HEAD:refs/heads/main"]);

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.deepStrictEqual(result, {
        status: "pulled",
        refName: "main",
        upstreamRef: "origin/main",
      });
      assert.equal(
        yield* git(cwd, ["rev-parse", "HEAD"]),
        yield* git(updater, ["rev-parse", "HEAD"]),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  // notes.txt is edited on both sides, on lines far enough apart to stash and reapply cleanly.
  const behindWithLocalEdit = (settings: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const updater = yield* makeTmpDir("git-vcs-driver-updater-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "notes.txt", "1\n2\n3\n4\n5\n");
      yield* git(cwd, ["add", "notes.txt"]);
      yield* git(cwd, ["commit", "-m", "notes"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(updater, ["clone", remote, "."]);
      yield* git(updater, ["config", "user.email", "test@test.com"]);
      yield* git(updater, ["config", "user.name", "Test"]);
      yield* writeTextFile(updater, "notes.txt", "1\n2\n3\n4\nfive\n");
      yield* git(updater, ["commit", "-am", "remote edit"]);
      yield* git(updater, ["push", "origin", initialBranch]);
      yield* writeTextFile(cwd, "notes.txt", "one\n2\n3\n4\n5\n");
      for (const [key, value] of settings) yield* git(cwd, ["config", key, value]);
      return cwd;
    });

  const checkoutState = (cwd: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return {
        head: yield* git(cwd, ["log", "-1", "--format=%s"]),
        notes: yield* fileSystem.readFileString(`${cwd}/notes.txt`),
        status: yield* git(cwd, ["status", "--porcelain"]),
      };
    });

  const pullStashSettings: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
    [["pull.autoStash", "true"]],
    [
      ["pull.autoStash", "false"],
      ["merge.autoStash", "true"],
    ],
    [
      ["pull.rebase", "true"],
      ["rebase.autoStash", "true"],
    ],
    [
      ["pull.rebase", "true"],
      ["merge.autoStash", "true"],
    ],
    [["merge.autoStash", "true"]],
    [],
  ];

  it.effect.each(
    pullStashSettings.map((settings) => ({
      settings,
      name: settings.map(([key, value]) => `${key}=${value}`).join(" ") || "no settings",
    })),
  )("stashes local edits around a pull as git pull does with $name", ({ settings }) =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const reference = yield* behindWithLocalEdit(settings);
      yield* git(reference, ["pull", "--ff-only"]).pipe(Effect.ignore);
      const cwd = yield* behindWithLocalEdit(settings);

      const pulled = yield* driver.pullCurrentBranch(cwd).pipe(Effect.result);

      assert.deepStrictEqual(yield* checkoutState(cwd), yield* checkoutState(reference));
      assert.equal(
        Result.isSuccess(pulled),
        (yield* checkoutState(reference)).head === "remote edit",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("updates submodules on a pull under submodule.recurse, as git pull does", () =>
    Effect.gen(function* () {
      const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
      process.env.GIT_ALLOW_PROTOCOL = "file";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousAllowedProtocol === undefined) {
            delete process.env.GIT_ALLOW_PROTOCOL;
          } else {
            process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
          }
        }),
      );
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const submoduleRepo = yield* makeTmpDir("git-submodule-");
      const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(submoduleRepo);
      const { initialBranch } = yield* initRepoWithCommit(upstream);
      yield* git(upstream, ["submodule", "add", submoduleRepo, "shared"]);
      yield* git(upstream, ["commit", "-m", "add submodule"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(upstream, ["push", remote, `${initialBranch}:refs/heads/${initialBranch}`]);
      yield* git(cwd, ["clone", "--recurse-submodules", "--branch", initialBranch, remote, "."]);
      yield* git(cwd, ["config", "submodule.recurse", "true"]);
      yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
      yield* git(submoduleRepo, ["add", "SHARED.md"]);
      yield* git(submoduleRepo, ["commit", "-m", "shared"]);
      const submoduleHead = yield* git(submoduleRepo, ["rev-parse", "HEAD"]);
      yield* git(`${upstream}/shared`, ["pull", "--ff-only"]);
      yield* git(upstream, ["commit", "-am", "move submodule"]);
      yield* git(upstream, ["push", remote, `${initialBranch}:refs/heads/${initialBranch}`]);

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.equal(result.status, "pulled");
      assert.deepStrictEqual(
        {
          submodule: yield* git(`${cwd}/shared`, ["rev-parse", "HEAD"]),
          status: yield* git(cwd, ["status", "--porcelain"]),
        },
        { submodule: submoduleHead, status: "" },
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("still fetches other branches on the first pull", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { cwd, updater, remoteHead } = yield* cloneBehindRemote;
      yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);

      const result = yield* driver.pullCurrentBranch(cwd);

      assert.equal(result.status, "pulled");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      assert.equal(yield* git(cwd, ["rev-parse", "refs/remotes/origin/other"]), remoteHead);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "pulls past an unrelated lock with custom fetch mapping=%s",
    (customMapping) =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const { cwd, updater, initialBranch, remoteHead } = yield* cloneBehindRemote;
        yield* git(cwd, ["tag", initialBranch]);
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        const remoteName = customMapping ? "team/upstream" : "origin";
        const refPrefix = customMapping
          ? `refs/remotes/${remoteName}/mapped`
          : "refs/remotes/origin";
        if (customMapping) {
          yield* git(cwd, ["remote", "rename", "origin", remoteName]);
          yield* git(cwd, ["config", `remote.${remoteName}.fetch`, `+refs/heads/*:${refPrefix}/*`]);
          yield* git(cwd, ["update-ref", `${refPrefix}/${initialBranch}`, "HEAD"]);
        }
        const lock = `.git/${refPrefix}/other.lock`;
        yield* writeTextFile(cwd, lock, "");

        const result = yield* driver.pullCurrentBranch(cwd);

        assert.equal(result.status, "pulled");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(yield* git(cwd, ["rev-parse", `${refPrefix}/${initialBranch}`]), remoteHead);
        assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
        assert.equal(yield* fs.readFileString(`${cwd}/${lock}`), "");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports an upstream lock after the fallback without removing it", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const { cwd, initialBranch } = yield* cloneBehindRemote;
      const before = yield* git(cwd, ["rev-parse", "HEAD"]);
      const lock = `.git/refs/remotes/origin/${initialBranch}.lock`;
      yield* writeTextFile(cwd, lock, "");

      const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

      assert.include(error.detail, "could not update a local reference");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), before);
      assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["branch", "HEAD"] as const)(
    "does not retry a failed fetch if another operation moved %s",
    (moved) =>
      Effect.gen(function* () {
        const fixtureDriver = yield* GitVcsDriver.GitVcsDriver;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd, updater } = yield* cloneBehindRemote;
        yield* git(updater, ["push", "origin", "HEAD:refs/heads/other"]);
        yield* writeTextFile(cwd, ".git/refs/remotes/origin/other.lock", "");
        let pulls = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "fetch") {
              return handle;
            }
            pulls += 1;
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.tap(() =>
                  git(
                    cwd,
                    moved === "branch"
                      ? ["checkout", "-b", "moved"]
                      : ["commit", "--allow-empty", "-m", "concurrent commit"],
                  ).pipe(
                    Effect.provideService(GitVcsDriver.GitVcsDriver, fixtureDriver),
                    Effect.orDie,
                  ),
                ),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

        assert.include(error.detail, "could not update a local reference");
        assert.equal(pulls, 1);
      }).pipe(Effect.scoped, Effect.provide(layerServerConfig.pipe(Layer.provideMerge(layerTest)))),
  );

  it.effect.each(["deadline", "subscriber cancellation"] as const)(
    "lets a background fetch finish after %s without leaving its lock behind",
    (interruption) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd } = yield* cloneBehindRemote;
        const lockPath = `${cwd}/.git/refs/remotes/origin/in-flight.lock`;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command) || !command.args.includes("fetch")) {
              return yield* delegate.spawn(command);
            }
            // Model Git's gap between creating a lock and registering signal cleanup.
            yield* fs.writeFileString(lockPath, "");
            yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
            yield* Deferred.succeed(started, undefined);
            return ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.await(release).pipe(
                Effect.andThen(fs.remove(lockPath)),
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const status = yield* driver.statusDetailsRemote(cwd).pipe(Effect.forkScoped);
        yield* Deferred.await(started);

        if (interruption === "deadline") {
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(status);
        } else {
          yield* Fiber.interrupt(status);
        }

        assert.isFalse(yield* Deferred.isDone(finalized));
        assert.isTrue(yield* fs.exists(lockPath));

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finalized);
        assert.isFalse(yield* fs.exists(lockPath));
      }).pipe(Effect.scoped, Effect.provide(layerServerConfig.pipe(Layer.provideMerge(layerTest)))),
  );

  it.effect("reuses a background fetch across status wait deadlines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* makeTmpDir();
      yield* fs.makeDirectory(`${cwd}/.git`);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) return makeNonRepositoryHandle();
          if (command.args.includes("fetch")) {
            yield* Ref.update(attempts, (count) => count + 1);
            yield* Deferred.succeed(started, undefined);
            yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
            return ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }
          const args = command.args;
          return makeSuccessfulHandle(
            args.includes("--git-common-dir")
              ? `${cwd}/.git\n`
              : args.includes("--show-toplevel")
                ? `${cwd}\n`
                : args.includes("@{upstream}")
                  ? "origin/main\n"
                  : args[0] === "remote"
                    ? "origin\n"
                    : args[0] === "rev-list"
                      ? "0\t0\n"
                      : args.includes("refs/remotes/origin/HEAD")
                        ? "refs/remotes/origin/main\n"
                        : "main\n",
          );
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const first = yield* driver.statusDetailsRemote(cwd).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(first);

      yield* TestClock.adjust("15 seconds");
      const second = yield* driver.statusDetailsRemote(cwd).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(second);

      assert.equal(yield* Ref.get(attempts), 1);
      assert.isFalse(yield* Deferred.isDone(finalized));
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finalized);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
    ),
  );

  it.effect.each(["stdout", "stderr"] as const)(
    "reports a fast-forward whose %s passes the cap as pulled",
    (stream) =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* withPaddedPull(stream);
          yield* Effect.gen(function* () {
            const { cwd, remoteHead } = yield* cloneBehindRemote;

            const result = yield* driver.pullCurrentBranch(cwd);

            assert.equal(result.status, "pulled");
            assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
          }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
        }),
      ).pipe(
        Effect.provide(
          layerServerConfig.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );

  it.effect("still fails a pull that Git rejects, whatever its output size", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pulls: ReadonlyArray<string>[] = [];
        const driver = yield* withPaddedPull("stderr", (args) => pulls.push(args));
        yield* Effect.gen(function* () {
          const { cwd } = yield* cloneBehindRemote;
          // A local commit the remote lacks: `pull --ff-only` cannot fast-forward and exits 128.
          yield* writeTextFile(cwd, "local.txt", "local\n");
          yield* git(cwd, ["add", "local.txt"]);
          yield* git(cwd, ["commit", "-m", "local commit"]);

          const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

          assert.equal(error.operation, "GitVcsDriver.pullCurrentBranch.pull");
          assert.equal(error.exitCode, 128);
          assert.notInclude(error.detail, "exceeded");
          assert.lengthOf(pulls, 1);
        }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      }),
    ).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args.at(-1) === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("fails a ref snapshot when for-each-ref exits unsuccessfully", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const snapshotAttempts = yield* Ref.make(0);
      const failingSnapshotSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("for-each-ref")) {
            yield* Ref.update(snapshotAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSnapshotSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const error = yield* driver.listRefs({ cwd, refresh: true }).pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.listRefs.snapshotRefs",
        detail: "Git ref snapshot enumeration failed.",
        exitCode: 128,
      });
      assert.equal(yield* Ref.get(snapshotAttempts), 1);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("reads worktrees from git that rejects worktree list -z", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.36 has no `worktree list -z` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("worktree") && command.args.includes("-z")) {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(129)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.encodeText(Stream.make("error: unknown switch `z'")),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      const worktreePath = NodeFS.realpathSync.native(yield* makeTmpDir());
      yield* git(cwd, ["worktree", "add", "-b", "feature/old-git", worktreePath]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const listedPath = refs.refs.find((ref) => ref.name === "feature/old-git")?.worktreePath;
      assert.equal(listedPath && NodeFS.realpathSync.native(listedPath), worktreePath);

      const paths = yield* driver.listWorktreePaths(cwd);
      assert.include(
        paths.map((listed) => NodeFS.realpathSync.native(listed)),
        worktreePath,
      );
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("does not report a separate git dir as the worktree of its branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const gitDir = yield* makeTmpDir();
      yield* git(cwd, ["init", `--separate-git-dir=${gitDir}`]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "init"]);

      const refs = yield* driver.listRefs({ cwd, refresh: true });
      const worktreePath = refs.refs.find((ref) => ref.current)?.worktreePath;

      assert.equal(
        worktreePath && NodeFS.realpathSync.native(worktreePath),
        NodeFS.realpathSync.native(cwd),
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refreshes the current branch after an external checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "external-checkout"]);

      const initialRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(initialRefs.refs.find((ref) => ref.name === initialBranch)?.current);

      // Raw execute intentionally bypasses the driver's mutation invalidation,
      // matching a checkout performed by another process.
      yield* driver.execute({
        operation: "GitVcsDriver.test.externalCheckout",
        cwd,
        args: ["checkout", "external-checkout"],
        timeoutMs: 10_000,
      });
      yield* TestClock.adjust("6 seconds");

      const refreshedRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(refreshedRefs.refs.find((ref) => ref.name === "external-checkout")?.current);
      assert.isFalse(refreshedRefs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("backs off and logs failed fetch attempts across linked worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchAttempts = yield* Ref.make(0);
      const failingFetchSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("fetch") && command.args.includes("--quiet")) {
            yield* Ref.update(fetchAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingFetchSpawner),
      );
      const warnings: string[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        warnings.push(String(message));
      });
      const readRemoteStatus = (workingDirectory: string) =>
        driver
          .statusDetailsRemote(workingDirectory)
          .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(worktreesRoot, "linked");
      const runGit = (workingDirectory: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.upstreamRefreshBackoff",
          cwd: workingDirectory,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "initial commit"]);
      const initialBranch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      yield* runGit(remote, ["init", "--bare"]);
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", initialBranch]);
      yield* runGit(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* runGit(worktreePath, [
        "branch",
        "--set-upstream-to",
        `origin/${initialBranch}`,
        "feature/linked",
      ]);
      const rootCommonDir = (yield* runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
      const linkedCommonDir = (yield* runGit(worktreePath, [
        "rev-parse",
        "--git-common-dir",
      ])).stdout.trim();
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      assert.equal(
        NodeFS.realpathSync.native(pathService.resolve(cwd, rootCommonDir)),
        NodeFS.realpathSync.native(pathService.resolve(worktreePath, linkedCommonDir)),
      );
      yield* Ref.set(fetchAttempts, 0);

      yield* readRemoteStatus(cwd);
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);
      assert.lengthOf(warnings, 1);
      assert.include(warnings[0], "Background Git fetch failed");

      yield* TestClock.adjust("29 seconds");
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);
      assert.lengthOf(warnings, 1);

      yield* TestClock.adjust("1 second");
      yield* readRemoteStatus(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 2);
      assert.lengthOf(warnings, 2);

      yield* TestClock.adjust("59 seconds");
      yield* readRemoteStatus(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 2);
      assert.lengthOf(warnings, 2);

      yield* TestClock.adjust("1 second");
      yield* readRemoteStatus(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 3);
      assert.lengthOf(warnings, 3);
    }),
  ).pipe(Effect.provide(layerServerConfig.pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))),
);

it.effect.each([
  {
    name: "HTTPS credentials",
    stderr: "fatal: Authentication failed for",
    expected: "could not authenticate",
  },
  {
    name: "SSH credentials",
    stderr: "git@example.com: Permission denied (publickey).",
    expected: "could not authenticate",
  },
  {
    name: "disabled prompts",
    stderr: "fatal: could not read Username: terminal prompts disabled",
    expected: "could not authenticate",
  },
  {
    name: "DNS failure",
    stderr: "fatal: Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "connection failure",
    stderr: "ssh: connect to host example.com port 22: Connection refused",
    expected: "could not reach the remote",
  },
  {
    name: "missing remote",
    stderr: "remote: Repository not found.",
    expected: "could not access the remote repository",
  },
  {
    name: "invalid remote",
    stderr: "fatal: remote does not appear to be a git repository",
    expected: "could not access the remote repository",
  },
  {
    name: "reference lock",
    stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def",
    expected: "could not update a local reference",
    attempts: 5,
  },
  {
    name: "lock file",
    stderr: "fatal: Unable to create '/repo/.git/FETCH_HEAD.lock': File exists.",
    expected: "could not update a local reference",
    attempts: 5,
  },
  {
    name: "reference race on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
    expected: "could not update a local reference",
    attempts: 5,
  },
  {
    name: "held reference lock on Git 2.53",
    stderr: "error: fetching ref refs/remotes/origin/main failed: reference already exists",
    expected: "could not update a local reference",
    attempts: 5,
  },
  {
    name: "unrelated remote chatter",
    stderr:
      "remote: Help: authentication failed, connection refused, cannot lock ref\nremote: unrelated service error",
    expected: "git fetch origin failed",
  },
  {
    name: "HTTPS DNS failure",
    stderr:
      "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host: example.com",
    expected: "could not reach the remote",
  },
  {
    name: "unknown failure",
    stderr: "fatal: unexpected remote failure",
    expected: "git fetch origin failed",
  },
] as const)("reports $name during fetch without retaining remote output", (scenario) =>
  Effect.gen(function* () {
    const secret = "secret-fetch-token";
    const stderr = `${scenario.stderr}\nhttps://user:${secret}@example.com/private?token=${secret}`;
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        assert.deepEqual(command.args, ["fetch", "--quiet", "--", "origin"]);
        assert.equal(command.options.env?.LANGUAGE, "C");
        assert.equal(command.options.env?.GIT_TERMINAL_PROMPT, "0");
        yield* Ref.update(attempts, (count) => count + 1);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(secret)),
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    // A fetch that keeps losing a ref waits between its reruns, on the real clock.
    const error = yield* TestClock.withLive(
      driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip),
    );
    assert.include(error.detail, scenario.expected);
    assert.equal(error.exitCode, 128);
    assert.equal(error.stderrLength, stderr.length);
    assert.equal(error.stdoutLength, secret.length);
    assert.notInclude(error.message, secret);
    assert.notInclude(yield* encodeGitCommandError(error), secret);
    assert.notProperty(error, "stderr");
    assert.notProperty(error, "args");
    assert.equal(yield* Ref.get(attempts), "attempts" in scenario ? scenario.attempts : 1);
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

// With many agents fetching one repository, the rerun of a fetch that lost a ref can lose it too.
it.effect.each([1, 3])("reruns a fetch that lost a ref update to another Git process %i time(s)", (losses) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (command.args[0] !== "fetch") return makeNonRepositoryHandle();
        const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
        if (attempt > losses) return makeSuccessfulHandle("");
        return ChildProcessSpawner.makeHandle({
          ...makeNonRepositoryHandle(),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          stderr: Stream.encodeText(
            Stream.make(
              "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    yield* TestClock.withLive(driver.fetchRemote({ cwd, remoteName: "origin", refName: "main" }));
    assert.equal(yield* Ref.get(attempts), losses + 1);
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("does not fetch for status when the branch tracks a local branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
          fetches.push(command.args.map(String));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "feature", remote]);
      yield* git(cwd, ["branch", "feature/base"]);
      yield* git(cwd, ["checkout", "-b", "stacked", "--track", "feature/base"]);

      const status = yield* driver.statusDetailsRemote(cwd);

      assert.equal(status.upstreamRef, "feature/base");
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("lets a worktree checkout that is still working run past five minutes", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const checkoutFinished = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("expected Git command");
        if (!command.args.includes("worktree")) return makeSuccessfulHandle("");
        yield* Deferred.succeed(checkoutStarted, undefined);
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulHandle(""),
          exitCode: Deferred.await(checkoutFinished).pipe(
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
          stderr: Stream.encodeText(
            Stream.concat(
              Stream.make("Updating files:  40% (49052/122629)\n"),
              Stream.fromEffect(
                Deferred.await(checkoutFinished).pipe(
                  Effect.as("Updating files: 100% (122629/122629), done.\n"),
                ),
              ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const path = yield* Path.Path;
    const cwd = yield* makeTmpDir();
    const worktreePath = path.join(cwd, "worktree");

    const creation = yield* driver
      .createWorktree({ cwd, refName: "main", newRefName: "t3/slow-checkout", path: worktreePath })
      .pipe(Effect.forkChild);
    yield* Deferred.await(checkoutStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Deferred.succeed(checkoutFinished, undefined);

    const result = yield* Fiber.join(creation);
    assert.equal(result.worktree.path, worktreePath);
    assert.equal(result.worktree.refName, "t3/slow-checkout");
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("cancels a slow submodule checkout without reporting best-effort success", () =>
  Effect.gen(function* () {
    const updateStarted = yield* Deferred.make<void>();
    const updateStopped = yield* Deferred.make<void>();
    const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
    const claimed = yield* Ref.make<string | null>(null);
    const spawner = ChildProcessSpawner.make((command) => {
      if (
        ChildProcess.isStandardCommand(command) &&
        command.args[0] === "submodule" &&
        command.args[1] === "update"
      ) {
        return Effect.acquireRelease(
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              exitCode: Deferred.succeed(updateStarted, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            }),
          ),
          () => Deferred.succeed(updateStopped, undefined),
        );
      }
      return Effect.succeed(makeSuccessfulHandle(""));
    });
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const cwd = yield* makeTmpDir();
    const path = yield* Path.Path;
    const worktreePath = path.join(cwd, "worktree");
    yield* writeTextFile(worktreePath, ".gitmodules", "");
    const creation = yield* driver
      .createWorktree(
        { cwd, refName: "main", newRefName: "bugfix/cancel-submodules", path: worktreePath },
        {
          progress: {
            onWorktreeClaimed: (value) => Ref.set(claimed, value),
            onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
          },
        },
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(updateStarted);
    yield* TestClock.adjust("6 minutes");
    yield* Fiber.interrupt(creation);
    const exit = yield* Fiber.await(creation);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isTrue(yield* Deferred.isDone(updateStopped));
    assert.equal(yield* Ref.get(claimed), worktreePath);
    assert.isEmpty(yield* Ref.get(finished));
  }).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

describe("rejected git refs", () => {
  const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";
  const failedPush = `error: failed to push some refs to '${remoteUrl}'`;
  const leakedText = [
    "token-123",
    "secret-repo",
    "git.example.invalid",
    "private-branch",
    "workflow scope",
  ];

  const failWith = (stderr: string) => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver
        .execute({
          operation: "GitVcsDriver.test.rejectedRef",
          cwd: "/repo",
          args: ["push", "origin", "HEAD"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    {
      label: "a ref the remote refused",
      stderr: [
        "remote: Unable to determine if workflow can be created; workflow scope may be required.",
        `To ${remoteUrl}`,
        " ! [remote rejected] private-branch -> private-branch (workflow scope may be required.)",
        failedPush,
      ],
      reason: "push_rejected_by_remote" as const,
      detail: "The remote rejected the push.",
    },
    {
      label: "a non-fast-forward push",
      stderr: [
        `To ${remoteUrl}`,
        " ! [rejected]        private-branch -> private-branch (non-fast-forward)",
        failedPush,
      ],
      reason: "push_rejected_non_fast_forward" as const,
      detail: "Pull or rebase",
    },
  ])("names $label without quoting stderr", ({ stderr, reason, detail }) =>
    Effect.gen(function* () {
      const error = yield* failWith(stderr.join("\n"));

      assert.deepInclude(error, { reason });
      assert.include(error.detail, detail);
      for (const text of leakedText) assert.notInclude(error.message, text);
    }),
  );

  // A fetch into a diverged local branch prints the same rejected line, but
  // never "failed to push some refs".
  it.effect("leaves a rejected fetch unclassified", () =>
    Effect.gen(function* () {
      const error = yield* failWith(
        [`From ${remoteUrl}`, " ! [rejected]        main       -> side  (non-fast-forward)"].join(
          "\n",
        ),
      );

      assert.equal(error.reason, undefined);
      assert.equal(error.detail, "Git command exited with a non-zero status.");
    }),
  );
});

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("process environment", () => {
    it.effect("preserves the caller locale for general Git subprocesses", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();

        const locale = yield* git(
          cwd,
          ["-c", 'alias.print-locale=!printf "%s" "$LC_ALL"', "print-locale"],
          { LC_ALL: "zh_CN.UTF-8" },
        );

        assert.equal(locale, "zh_CN.UTF-8");
      }),
    );
  });

  it.effect("keeps large change sets available for status and commit preparation", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      const files = Array.from(
        { length: 6_000 },
        (_, index) => `file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
      );
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "before\n"), {
        concurrency: 16,
        discard: true,
      });
      yield* git(cwd, ["add", "."]);
      const unborn = yield* driver.statusDetailsLocal(cwd);
      assert.lengthOf(unborn.workingTree.files, files.length);
      assert.equal(unborn.workingTree.insertions, files.length);
      const initial = yield* driver.commit(cwd, "initial", "");
      assert.match(initial.commitSha, /^[a-f0-9]{40}$/);
      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasWorkingTreeChanges);
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "after\n"), {
        concurrency: 16,
        discard: true,
      });
      const status = yield* driver.statusDetailsLocal(cwd);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.lengthOf(status.workingTree.files, files.length);
      assert.equal(status.workingTree.insertions, files.length);
      assert.equal(status.workingTree.deletions, files.length);
      const context = yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false });
      assert.isNotNull(context);
      assert.isAbove(context!.stagedSummary.length, 1_000_000);
      assert.lengthOf(context!.stagedSummary.split("\n"), files.length);
    }),
  );

  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
        assert.notProperty(error, "reason");
      }),
    );

    it.effect("names the branch conflict behind a failed worktree add", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        const firstWorktree = pathService.join(parent, "first");
        yield* git(cwd, ["worktree", "add", firstWorktree, "-b", "shared-branch"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.worktreeAddConflict",
            cwd,
            args: ["worktree", "add", pathService.join(parent, "second"), "shared-branch"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.worktreeAddConflict",
          reason: "branch_checked_out_in_worktree",
        });
        assert.include(error.message, "(branch_checked_out_in_worktree)");
        assert.notInclude(error.message, firstWorktree);
      }),
    );

    it.effect("names a missing repository behind a failed command", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.notARepository",
            cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.notARepository",
          reason: "not_a_repository",
        });
        assert.include(error.message, "(not_a_repository)");
      }),
    );

    it.effect("appends the reason tag to a caller-supplied detail", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, [
          "worktree",
          "add",
          pathService.join(parent, "taken"),
          "-b",
          "taken-branch",
        ]);

        const error = yield* driver
          .createWorktree({
            cwd,
            refName: "taken-branch",
            path: pathService.join(parent, "second"),
          })
          .pipe(Effect.flip);

        assert.equal(error.detail, "git worktree add failed");
        assert.include(error.message, "git worktree add failed (branch_checked_out_in_worktree)");
      }),
    );

    // `git lfs install` configures a long-running filter process; git stops in its handshake when the program is
    // missing. A plain smudge filter fails per file instead.
    it.effect.each([
      { form: "filter process", key: "process", command: "caveman-test-missing-filter filter-process" },
      { form: "smudge filter", key: "smudge", command: "caveman-test-missing-filter smudge -- %f" },
    ])("tells the person a required $form that cannot run is why a worktree cannot be made", ({ key, command }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const parent = yield* makeTmpDir("git-worktrees-");
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitattributes", "*.bin filter=missing -text\n");
        yield* writeTextFile(cwd, "asset.bin", "large\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "track assets"]);
        yield* git(cwd, ["config", `filter.missing.${key}`, command]);
        yield* git(cwd, ["config", "filter.missing.required", "true"]);

        const error = yield* driver
          .createWorktree({
            cwd,
            refName: "HEAD",
            newRefName: "t3/new-thread",
            path: pathService.join(parent, "worktree"),
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          reason: "filter_failed",
          detail:
            "Git could not run a filter this repository needs, such as Git LFS. Install it where Caveman Code runs " +
            "git, then try again.",
        });
        assert.notInclude(error.message, "caveman-test-missing-filter");
        assert.notInclude(error.message, "asset.bin");
      }),
    );

    // Staging runs the clean side of the same filter: the sentence fits that command too.
    it.effect("tells the person a required clean filter that cannot run is why changes cannot be committed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitattributes", "*.bin filter=missing -text\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "track assets"]);
        yield* writeTextFile(cwd, "asset.bin", "large\n");
        yield* git(cwd, ["config", "filter.missing.clean", "caveman-test-missing-filter clean -- %f"]);
        yield* git(cwd, ["config", "filter.missing.required", "true"]);

        const error = yield* driver.prepareCommitContext(cwd).pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          reason: "filter_failed",
          detail:
            "Git could not run a filter this repository needs, such as Git LFS. Install it where Caveman Code runs " +
            "git, then try again.",
        });
        assert.notInclude(error.message, "caveman-test-missing-filter");
      }),
    );

    it.effect.each([
      { action: "worktree add", detail: "git worktree add failed" },
      { action: "worktree add -b", detail: "git worktree add failed" },
      { action: "switch", detail: "git checkout failed" },
    ])(
      "reports a missing ref during $action with stable, redacted diagnostics",
      ({ action, detail }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const path = yield* Path.Path;
          const refName = "private/deleted-base";
          const locales: Array<CommandLine.Word | undefined> = [];
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) => {
            if (
              ChildProcess.isStandardCommand(command) &&
              (command.args.includes("worktree") ||
                command.args[0] === "branch" ||
                command.args[0] === "checkout")
            ) {
              locales.push(command.options.env?.LANGUAGE);
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const error =
            action === "switch"
              ? yield* driver.switchRef({ cwd, refName }).pipe(Effect.flip)
              : yield* driver
                  .createWorktree({
                    cwd,
                    refName,
                    ...(action === "worktree add -b" ? { newRefName: "t3/new-thread" } : {}),
                    path: path.join(cwd, "worktree"),
                  })
                  .pipe(Effect.flip);

          assert.deepInclude(error, { _tag: "GitCommandError", detail, reason: "ref_not_found" });
          assert.include(error.message, `${detail} (ref_not_found)`);
          assert.notInclude(error.message, refName);
          assert.notInclude(yield* encodeGitCommandError(error), refName);
          assert.deepEqual(locales, ["C"]);
          assert.notProperty(error, "stderr");
          assert.notProperty(error, "args");
        }),
    );

    it.effect.each([
      // Git cannot tell a missing revision from a missing file in these.
      { label: "an argument that may be a path", args: ["log", "-1", "missing"] },
      {
        label: "a pathspec worded like a diagnostic",
        args: ["checkout", "HEAD", "--", "fatal: invalid reference: missing"],
      },
      // The tag exists; it names a tree, which git reports in the same words.
      {
        label: "a worktree from a non-commit",
        args: ["worktree", "add", "tree-worktree", "tree-tag"],
      },
    ])("leaves $label unclassified rather than calling it a missing ref", ({ args }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        if (args.includes("tree-tag")) {
          yield* git(cwd, ["tag", "tree-tag", "HEAD^{tree}"]);
        }

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.ambiguousMissingName",
            cwd,
            args,
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
      }),
    );

    it.effect.each([
      {
        label: "a refused key",
        sshMessage: "git@example.invalid: Permission denied (publickey).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused key among several methods",
        sshMessage: "git@example.invalid: Permission denied (publickey,password).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a refused keyboard-interactive attempt",
        sshMessage: "git@example.invalid: Permission denied (keyboard-interactive).",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "a rejected password",
        sshMessage: "Permission denied, please try again.",
        expectedReason: "authentication_failed" as const,
        expectedText: "(authentication_failed)",
      },
      {
        label: "an untrusted host key",
        sshMessage: "Host key verification failed.",
        expectedReason: "host_key_unverified" as const,
        expectedText: "(host_key_unverified)",
      },
    ])(
      "names $label rather than an unreachable remote",
      ({ sshMessage, expectedReason, expectedText }) =>
        Effect.gen(function* () {
          const parent = yield* makeTmpDir();
          const pathService = yield* Path.Path;
          const cwd = pathService.join(parent, "repo");
          const fileSystem = yield* FileSystem.FileSystem;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* fileSystem.makeDirectory(cwd);
          yield* initRepoWithCommit(cwd);
          yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
          // Stands in for ssh, which prints its refusal unprefixed and leaves
          // git to add only a generic "could not read" line after it.
          const fakeSsh = pathService.join(parent, "fake-ssh");
          yield* writeTextFile(
            parent,
            "fake-ssh",
            `#!/bin/sh\necho "${sshMessage}" >&2\nexit 255\n`,
          );
          yield* fileSystem.chmod(fakeSsh, 0o755);

          const error = yield* driver
            .execute({
              operation: "GitVcsDriver.test.sshRefusal",
              cwd,
              args: ["fetch", "origin"],
              // git runs this through its shell (Git Bash's on Windows), which reads `\` as an escape.
              env: { LC_ALL: "C", GIT_SSH_COMMAND: `'${fakeSsh.replaceAll("\\", "/")}'` },
            })
            .pipe(Effect.flip);

          assert.deepInclude(error, { reason: expectedReason });
          assert.include(error.message, expectedText);
        }),
    );

    it.effect("does not read a filesystem permission error as an ssh refusal", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "repo");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "git@example.invalid:owner/repo.git"]);
        const fakeSsh = pathService.join(parent, "fake-ssh");
        yield* writeTextFile(
          parent,
          "fake-ssh",
          '#!/bin/sh\necho "fatal: cannot open backup file: Permission denied (os error 13)" >&2\nexit 255\n',
        );
        yield* fileSystem.chmod(fakeSsh, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.osPermission",
            cwd,
            args: ["fetch", "origin"],
            // git runs this through its shell (Git Bash's on Windows), which reads `\` as an escape.
            env: { LC_ALL: "C", GIT_SSH_COMMAND: `'${fakeSsh.replaceAll("\\", "/")}'` },
          })
          .pipe(Effect.flip);

        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("reads a hook-declined push from git's rejection line, not the hook's output", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        // Git prefixes everything the server says with `remote:`, so a remote
        // hook can put arbitrary text in front of the classifier.
        const preReceive = pathService.join(remote, "hooks", "pre-receive");
        yield* writeTextFile(
          remote,
          "hooks/pre-receive",
          '#!/bin/sh\necho "authentication failed" >&2\necho "Permission denied (publickey)." >&2\necho "Host key verification failed." >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(preReceive, 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.remoteHookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, { reason: "push_rejected_by_remote" });
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("does not read hook output as a git failure reason", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const remote = pathService.join(parent, "origin.git");
        const cwd = pathService.join(parent, "work");
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* fileSystem.makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["init", "--bare", remote]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/pre-push",
          '#!/bin/sh\necho "authentication failed" >&2\nexit 1\n',
        );
        yield* fileSystem.chmod(pathService.join(cwd, ".git/hooks/pre-push"), 0o755);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.hookOutput",
            cwd,
            args: ["push", "origin", "HEAD"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(authentication_failed)");
      }),
    );

    it.effect("leaves a tag collision unclassified rather than calling it a path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["tag", "v1"]);

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.tagCollision",
            cwd,
            args: ["tag", "v1"],
            env: { LC_ALL: "C" },
          })
          .pipe(Effect.flip);

        assert.notProperty(error, "reason");
        assert.notInclude(error.message, "(path_already_exists)");
      }),
    );

    it.effect("keeps line callbacks flowing past the output cap when asked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // 4 KiB of multi-byte lines, well past a 512-byte cap; the last line
        // is the one a failure surface would need.
        const lines: Array<string> = [];
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.callbacksPastCap",
          cwd,
          args: [
            "-c",
            'alias.spew=!for i in $(seq 1 128); do printf "é%03d\\n" $i >&2; done; echo fatal: last line >&2',
            "spew",
          ],
          maxOutputBytes: 512,
          appendTruncationMarker: true,
          keepLineCallbacksAfterTruncation: true,
          progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
        });

        assert.isTrue(result.stderrTruncated);
        assert.isAtMost(result.stderr.length, 600);
        assert.equal(lines.length, 129);
        assert.equal(lines[0], "é001");
        assert.equal(lines[127], "é128");
        assert.equal(lines.at(-1), "fatal: last line");
        // No replacement characters: the cap landing inside "é" is invisible to callbacks.
        assert.isFalse(lines.some((line) => line.includes("\uFFFD")));
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const notAWorktree = pathService.join(cwd, "not-a-worktree");
        yield* fileSystem.makeDirectory(notAWorktree);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver.removeWorktree({ cwd, path: notAWorktree }).pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 6,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notProperty(error, "stderr");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("loads repository-relative files from a nested project directory", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/nested"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "committed\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "changed\n");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const nestedCwd = path.join(cwd, "nested");
        const preview = yield* driver.getReviewDiffPreview({
          cwd: nestedCwd,
          baseRef: initialBranch,
        });
        assert.equal(
          preview.sources.find((source) => source.kind === "working-tree")!.files!.length,
          2,
        );
        for (const source of preview.sources) {
          for (const file of source.files ?? []) {
            const scoped = yield* driver.getReviewDiffPreview({
              cwd: nestedCwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = scoped.sources.find((item) => item.kind === source.kind)!;
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
          }
        }
      }),
    );

    it.effect("reads complete tracked and untracked manifests beyond 1 MB", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const mergeBase = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked content\n");
        const paths = Array.from({ length: 5000 }, (_, index) => `${"a".repeat(220)}-${index}.txt`);
        const stats = paths.map((path) => `1\t0\t${path}\0`).join("");
        const untracked = [...paths, "untracked.txt"].join("\0") + "\0";
        assert.isAbove(stats.length, 1024 * 1024);
        assert.isAbove(untracked.length, 1024 * 1024);
        let readLargeUntracked = false;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            if (command.args.includes("--numstat") && command.args.includes(mergeBase)) {
              return Effect.succeed(makeSuccessfulHandle(stats));
            }
            if (command.args.includes("ls-files") && command.args.includes("--others")) {
              return Effect.succeed(makeSuccessfulHandle(readLargeUntracked ? untracked : ""));
            }
          }
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const branch = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const files = branch.sources.find((source) => source.kind === "branch-range")!.files!;
        assert.equal(files.length, paths.length);
        assert.equal(files.at(-1)?.path, paths.at(-1));
        assert.equal(
          files.reduce((total, file) => total + file.additions, 0),
          paths.length,
        );
        readLargeUntracked = true;
        const dirty = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
        });
        const source = dirty.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(source.diff, "+untracked content");
      }),
    );

    it.effect("propagates patch failures instead of reporting an empty complete diff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "changed\n");
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--patch")
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const result = yield* driver.getReviewDiffPreview({ cwd }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.getReviewDiffPreview.patch");
        }
      }),
    );

    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.deepStrictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.files,
          [],
        );
        assert.deepStrictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.files,
          [],
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );

    it.effect("keeps the patch format clients parse when the repository changes it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.noprefix", "true"]);
        yield* git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(cwd, ["config", "diff.suppressBlankEmpty", "true"]);
        yield* git(cwd, ["checkout", "-b", "feature/noprefix"]);
        yield* writeTextFile(cwd, "README.md", "# test\n\ncommitted change\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "committed change"]);
        yield* writeTextFile(cwd, "README.md", "# test\n\ndirty change\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });

        const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
        const branchRange = preview.sources.find((source) => source.kind === "branch-range")?.diff;
        assert.include(workingTree, "diff --git a/README.md b/README.md");
        assert.include(workingTree, " # test\n \n-committed change\n+dirty change\n");
        assert.include(workingTree, "+++ b/untracked.txt");
        assert.include(branchRange, "diff --git a/README.md b/README.md");
      }),
    );

    it.effect("keeps a moved submodule in the review under diff.submodule=log", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const path = yield* Path.Path;
        const sub = path.join(cwd, "sub");
        yield* git(cwd, ["init", "sub"]);
        yield* initRepoWithCommit(sub);
        yield* git(cwd, ["-c", "advice.addEmbeddedRepo=false", "add", "sub"]);
        yield* git(cwd, ["commit", "-m", "add sub"]);
        yield* git(cwd, ["config", "diff.submodule", "log"]);
        yield* git(sub, ["commit", "--allow-empty", "-m", "moved"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });

        const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
        assert.include(workingTree, "diff --git a/sub b/sub");
        assert.include(workingTree, "+Subproject commit ");
      }),
    );

    // Skipped on Windows: `:` cannot be in a file name there, so this name cannot exist.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps untracked filenames with pathspec magic in the review",
      () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, ":(exclude)after.ts", "literal pathspec contents\n");
        yield* writeTextFile(cwd, "ordinary.ts", "ordinary contents\n");
        const indexBefore = yield* git(cwd, ["ls-files", "--stage"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "+literal pathspec contents");
        assert.include(diff, "+ordinary contents");
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: {
            path: ":(exclude)after.ts",
            previousPath: null,
            sourceKind: "working-tree",
          },
        });
        const scopedSource = scoped.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, [
          { path: ":(exclude)after.ts", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(scopedSource.diff, "+literal pathspec contents");
        assert.notInclude(scopedSource.diff, "ordinary.ts");
        assert.strictEqual(yield* git(cwd, ["ls-files", "--stage"]), indexBefore);
      }),
    );

    it.effect("detects an unstaged rename with edits without mutating a split index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "before.ts", "one\ntwo\nthree\nfour\nfive\n");
        yield* git(cwd, ["add", "before.ts"]);
        yield* git(cwd, ["commit", "-m", "add source file"]);
        yield* git(cwd, ["config", "core.splitIndex", "true"]);
        yield* git(cwd, ["config", "splitIndex.sharedIndexExpire", "now"]);
        yield* git(cwd, ["update-index", "--split-index"]);
        const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
        const indexHashBefore = yield* git(cwd, ["hash-object", indexPath]);
        const gitDirValue = yield* git(cwd, ["rev-parse", "--git-dir"]);
        const gitDir = pathService.isAbsolute(gitDirValue)
          ? gitDirValue
          : pathService.resolve(cwd, gitDirValue);
        const sharedIndexesBefore = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();
        yield* fileSystem.rename(
          pathService.join(cwd, "before.ts"),
          pathService.join(cwd, "after.ts"),
        );
        yield* writeTextFile(cwd, "after.ts", "one\ntwo\nTHREE\nfour\nfive\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";
        const indexHashAfter = yield* git(cwd, ["hash-object", indexPath]);
        const sharedIndexesAfter = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();

        const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          { path: "after.ts", previousPath: "before.ts", additions: 1, deletions: 1 },
        ]);
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "after.ts", previousPath: "before.ts", sourceKind: "working-tree" },
        });
        const scopedSource = scoped.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, source.files);
        assert.equal(scopedSource.diff, diff);
        assert.include(diff, "rename from before.ts");
        assert.include(diff, "rename to after.ts");
        assert.include(diff, "-three");
        assert.include(diff, "+THREE");
        assert.strictEqual(diff.match(/^diff --git /gm)?.length, 1);
        assert.strictEqual(indexHashAfter, indexHashBefore);
        assert.deepStrictEqual(sharedIndexesAfter, sharedIndexesBefore);
      }),
    );

    it.effect("keeps tracked changes visible when untracked discovery fails", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const failingLsFilesSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("expected a standard Git command");
          }
          return command.args[0] === "ls-files" && command.args[1] === "--others"
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingLsFilesSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
        );
        yield* writeTextFile(cwd, "README.md", "# tracked change\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "-# test");
        assert.include(diff, "+# tracked change");
      }),
    );

    it.effect("preserves a staged deletion when the removed path still exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "removed.txt", "remove me\n");
        yield* git(cwd, ["add", "removed.txt"]);
        yield* git(cwd, ["commit", "-m", "add removable file"]);
        yield* git(cwd, ["rm", "--cached", "removed.txt"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

        assert.include(diff, "deleted file mode");
        assert.include(diff, "-remove me");
        assert.notInclude(diff, "new file mode");
      }),
    );

    it.effect("keeps untracked files visible before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* writeTextFile(cwd, "untracked.txt", "visible before HEAD\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

        assert.include(source?.diff, "visible before HEAD");
        assert.equal(source?.truncated, false);
      }),
    );

    it.effect.each([false, true])(
      "keeps the preceding second cached in review previews (split: %s)",
      (splitIndex) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".gitattributes", "stable.txt filter=probe\n");
          yield* writeTextFile(cwd, "stable.txt", "unchanged\n");
          yield* writeTextFile(
            cwd,
            ".git/filter.cjs",
            'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
          );
          yield* git(cwd, ["config", "filter.probe.clean", "node .git/filter.cjs"]);
          yield* fs.utimes(path.join(cwd, "stable.txt"), 1_699_999_999.5, 1_699_999_999.5);
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "cache stable file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          const indexPath = path.join(cwd, ".git", "index");
          yield* fs.utimes(indexPath, 1_700_000_000, 1_700_000_000);
          const originalIndex = yield* fs.readFile(indexPath);
          const originalMtime = (yield* fs.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, ".git/filter-runs", "");
          yield* writeTextFile(cwd, "untracked.txt", "new\n");
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "working-tree")!.files,
            [{ path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
          assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/filter-runs")), "");
          assert.deepStrictEqual(yield* fs.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fs.stat(indexPath)).mtime, originalMtime);
        }),
    );

    it.effect.each([
      [1_700_000_000, false],
      [1_700_000_000.9999, false],
      [1_700_000_000, true],
      [1_700_000_000.9999, true],
    ] as const)(
      "preserves same-size edits with a racy review index (%s, split: %s)",
      ([timestamp, splitIndex]) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const filePath = path.join(cwd, "tracked.txt");
          const indexPath = path.join(cwd, ".git", "index");
          // Reproduce a same-timestamp edit without relying on filesystem clock resolution.
          yield* git(cwd, ["config", "core.trustctime", "false"]);
          yield* writeTextFile(cwd, "tracked.txt", "before\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* git(cwd, ["add", "tracked.txt"]);
          yield* git(cwd, ["commit", "-m", "record racy file"]);
          if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
          yield* fileSystem.utimes(indexPath, timestamp, timestamp);
          const originalIndex = yield* fileSystem.readFile(indexPath);
          const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
          yield* writeTextFile(cwd, "tracked.txt", "after!\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* writeTextFile(cwd, "untracked.txt", "new\n");

          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
          assert.deepStrictEqual(dirty.files, [
            { path: "tracked.txt", previousPath: null, additions: 1, deletions: 1 },
            { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
          ]);
          assert.include(dirty.diff, "-before");
          assert.include(dirty.diff, "+after!");
          assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
          assert.deepStrictEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
        }),
    );

    it.effect("keeps complete stats for files beyond the combined patch limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const largeContents = "a long line of changed content for the diff preview\n".repeat(4000);
        yield* git(cwd, ["checkout", "-b", "feature/large"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents);
        yield* writeTextFile(cwd, "z-last.txt", "last file\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "large change"]);
        yield* writeTextFile(cwd, "a-large.txt", largeContents.replaceAll("changed", "updated"));
        yield* writeTextFile(cwd, "z-last.txt", "last file updated\n");
        yield* writeTextFile(cwd, "untracked.txt", largeContents);

        const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.isTrue(branch.truncated);
        assert.isTrue(dirty.truncated);
        assert.notInclude(branch.diff, "z-last.txt");
        for (const source of [branch, dirty]) {
          for (const file of source.files ?? []) {
            const individual = yield* driver.getReviewDiffPreview({
              cwd,
              baseRef: initialBranch,
              file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
            });
            const patch = individual.sources.find((candidate) => candidate.kind === source.kind)!;
            assert.isFalse(patch.truncated);
            assert.deepStrictEqual(patch.files, [file]);
            assert.include(patch.diff, `b/${file.path}`);
            assert.isEmpty(
              individual.sources.find((candidate) => candidate.kind !== source.kind)!.diff,
            );
          }
        }

        assert.deepStrictEqual(branch.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.deepStrictEqual(dirty.files, [
          { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 4000 },
          { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("preserves renames, unusual paths, modes, and binary statistics", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "mode-only.sh", "echo unchanged\n");
        yield* git(cwd, ["add", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "add executable candidate"]);
        yield* git(cwd, ["checkout", "-b", "feature/paths"]);
        yield* git(cwd, ["mv", "README.md", "renamed.md"]);
        yield* writeTextFile(cwd, "[literal].txt", "literal\n");
        yield* writeTextFile(cwd, " leading.txt", "whitespace path\n");
        yield* writeTextFile(cwd, "l.txt", "other\n");
        yield* writeTextFile(cwd, "binary.dat", "binary\0data");
        if ((yield* HostProcess.Platform) !== "win32") {
          yield* writeTextFile(cwd, "tab\tand\nnewline.txt", "unusual path\n");
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["update-index", "--chmod=+x", "mode-only.sh"]);
        yield* git(cwd, ["commit", "-m", "rename and add files"]);
        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
        });
        const branch = preview.sources.find((source) => source.kind === "branch-range")!;
        for (const path of ["renamed.md", "[literal].txt", " leading.txt", "mode-only.sh"]) {
          const stat = branch.files!.find((file) => file.path === path)!;
          const request = yield* Schema.decodeEffect(ReviewDiffPreviewInput)({
            cwd,
            baseRef: initialBranch,
            file: { path, previousPath: stat.previousPath, sourceKind: "branch-range" },
          });
          const result = yield* driver.getReviewDiffPreview(request);
          const scoped = result.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scoped.files, [stat]);
          assert.notInclude(scoped.diff, "b/l.txt");
          if (path === "renamed.md") assert.include(scoped.diff, "rename from README.md");
          if (path === "mode-only.sh") {
            assert.include(scoped.diff, "old mode 100644");
            assert.include(scoped.diff, "new mode 100755");
          }
        }
        assert.include(branch.diff, "rename from README.md");
        assert.include(branch.diff, "rename to renamed.md");
        assert.deepInclude(branch.files ?? [], {
          path: "renamed.md",
          previousPath: "README.md",
          additions: 0,
          deletions: 0,
        });
        assert.deepInclude(branch.files ?? [], {
          path: "binary.dat",
          previousPath: null,
          additions: 0,
          deletions: 0,
        });
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.deepInclude(branch.files ?? [], {
            path: "tab\tand\nnewline.txt",
            previousPath: null,
            additions: 1,
            deletions: 0,
          });
        }
      }),
    );

    it.effect("reports staged and untracked changes before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(dirty.files, [
          { path: "staged.txt", previousPath: null, additions: 1, deletions: 0 },
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(dirty.diff, "b/staged.txt");
        assert.include(dirty.diff, "b/untracked.txt");
      }),
    );

    it.effect("loads full file contents for working-tree diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "nested/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
      }),
    );

    it.effect("does not expand the runtime's own state files", () =>
      Effect.gen(function* () {
        // A repository that holds the runtime's home, as when the person opens it as a project.
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "userdata/statev2.sqlite", "SQLite format 3\n");
        yield* writeTextFile(cwd, "userdata/secrets/example.bin", "example\n");
        yield* Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          for (const newPath of ["userdata/statev2.sqlite", "userdata/secrets/example.bin"]) {
            const error = yield* driver
              .getReviewDiffFileContents(
                makeReviewDiffFileContentsInput(cwd, { changeType: "new", oldPath: newPath, newPath }),
              )
              .pipe(Effect.flip);
            assert.strictEqual(error.detail, `Diff file '${newPath}' is not available.`);
          }
        }).pipe(
          Effect.provide(
            // Fresh: the suite's driver, memoized, knows the suite's state dir.
            Layer.fresh(GitVcsDriver.layer).pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), cwd)),
            ),
          ),
        );
      }),
    );

    it.effect.each([
      { scenario: "kept", before: "\uFEFFold\n", after: "\uFEFFnew\n" },
      { scenario: "added", before: "same\n", after: "\uFEFFsame\n" },
      { scenario: "removed", before: "\uFEFFsame\n", after: "same\n" },
    ])("preserves byte-order marks in diff expansion when $scenario", ({ before, after }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", before);
        yield* git(cwd, ["commit", "-am", "write original contents"]);
        yield* writeTextFile(cwd, "README.md", after);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd),
        );

        assert.deepStrictEqual(contents, { oldContents: before, newContents: after });
      }),
    );

    it.effect("reads a base ref that looks like an option as a revision", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const output = (yield* Path.Path).join(yield* makeTmpDir(), "out");

        yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { baseRef: `--output=${output}` }),
          )
          .pipe(Effect.flip);
        yield* driver.readRangeContext(cwd, `--output=${output}`).pipe(Effect.flip);

        assert.isFalse(yield* fileSystem.exists(`${output}:README.md`));
        assert.isFalse(yield* fileSystem.exists(`${output}..HEAD`));
      }),
    );

    it.effect("attributes working-tree filesystem failures to the failing operation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "missing.ts",
              newPath: "missing.ts",
            }),
          )
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
          command: "fs.realPath",
          cwd,
          detail: "Could not resolve diff file 'missing.ts'.",
        });
      }),
    );

    it.effect("loads new and deleted files without reading their missing side", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
        yield* fileSystem.remove(pathService.join(cwd, "README.md"));

        const [added, deleted] = yield* Effect.all([
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "added.ts",
              newPath: "added.ts",
            }),
          ),
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
          ),
        ]);

        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "export const added = true;\n",
        });
        assert.deepStrictEqual(deleted, {
          oldContents: "# test\n",
          newContents: "",
        });
      }),
    );

    it.effect("loads merge-base and disk contents for Changes expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/context"]);
        yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change readme"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: initialBranch,
            headRef: "feature/context",
          }),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# dirty change\nunchanged context\n");
      }),
    );

    it.effect("Changes combines commits, uncommitted edits, and untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const sourceFiles = (
          preview: ReviewDiffPreviewResult,
          kind: "working-tree" | "branch-range",
        ) => preview.sources.find((source) => source.kind === kind)!.files;
        yield* git(cwd, ["checkout", "-b", "feature/combined"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);

        // A fully committed branch has no uncommitted work, but Changes still shows it.
        const clean = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(sourceFiles(clean, "working-tree"), []);
        assert.deepStrictEqual(sourceFiles(clean, "branch-range"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
        ]);

        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\ndirty\n");
        yield* writeTextFile(cwd, "new.txt", "new\n");
        const dirty = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        const changes = dirty.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "README.md", previousPath: null, additions: 2, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.strictEqual(changes.diff.match(/^diff --git a\/README\.md /gm)?.length, 1);
        assert.include(changes.diff, "+dirty");
        assert.deepStrictEqual(sourceFiles(dirty, "working-tree"), [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
          { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("Changes on the default branch compares with its remote copy", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* writeTextFile(cwd, "unpushed.txt", "unpushed\n");
        yield* git(cwd, ["add", "unpushed.txt"]);
        yield* git(cwd, ["commit", "-m", "unpushed"]);

        // Without a remote there is no base, so Changes equals Uncommitted.
        const local = yield* driver.getReviewDiffPreview({ cwd });
        const localChanges = local.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(localChanges.baseRef);
        assert.deepStrictEqual(localChanges.files, []);

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]);
        yield* git(cwd, ["fetch", "origin"]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "origin/main");
        assert.deepStrictEqual(changes.files, [
          { path: "unpushed.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("honors configured remote-qualified bases for Changes and ahead counts", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["remote", "add", "canonical/team", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* writeTextFile(cwd, "upstream.txt", "unrelated upstream work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "upstream work"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["fetch", "canonical/team"]);
        yield* git(cwd, ["branch", "release/v2"]);
        yield* git(cwd, ["checkout", "-b", "feature/configured-base"]);
        yield* writeTextFile(cwd, "feature.txt", "intended branch change\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);

        for (const baseRef of ["upstream/main", "canonical/team/main", "release/v2"]) {
          yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, baseRef);
          assert.deepStrictEqual(changes.files, [
            { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
          ]);
        }

        for (const baseRef of ["origin/main", "upstream/missing", "main"]) {
          yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "origin/main",
            insertions: 2,
            deletions: 0,
          });
          assert.strictEqual(status.aheadCount, 2);
        }

        yield* git(cwd, [
          "config",
          "branch.feature/configured-base.gh-merge-base",
          "refs/remotes/upstream/main",
        ]);
        yield* writeTextFile(cwd, "upstream.txt", "feature edits upstream file\n");
        for (const shadowRef of ["refs/heads/upstream/main", "refs/tags/upstream/main"]) {
          yield* git(cwd, ["update-ref", shadowRef, "HEAD~2"]);
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, {
            baseRef: "refs/remotes/upstream/main",
            insertions: 2,
            deletions: 1,
          });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, "refs/remotes/upstream/main");
          assert.deepStrictEqual(changes.files, [
            { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
            { path: "upstream.txt", previousPath: null, additions: 1, deletions: 1 },
          ]);
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef: changes.baseRef,
              headRef: "feature/configured-base",
              oldPath: "upstream.txt",
              newPath: "upstream.txt",
            }),
          );
          assert.deepStrictEqual(contents, {
            oldContents: "unrelated upstream work\n",
            newContents: "feature edits upstream file\n",
          });
          yield* git(cwd, ["update-ref", "-d", shadowRef]);
        }
      }),
    );

    it.effect("keeps local branch bases consistent when tags share their names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        const initialCommit = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["update-ref", "refs/tags/main", initialCommit]);
        yield* git(cwd, ["update-ref", "refs/tags/release/v2", initialCommit]);
        yield* writeTextFile(cwd, "README.md", "# test\nbase work\n");
        yield* git(cwd, ["commit", "-am", "base work"]);
        yield* git(cwd, ["branch", "release/v2", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/local-base", "HEAD"]);
        yield* writeTextFile(cwd, "README.md", "# test\nbase work\nfeature work\n");
        yield* git(cwd, ["commit", "-am", "feature work"]);

        for (const configuredBase of [undefined, "main", "release/v2"]) {
          if (configuredBase !== undefined) {
            yield* git(cwd, ["config", "branch.feature/local-base.gh-merge-base", configuredBase]);
          }
          const baseRef = configuredBase ?? "main";
          const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
          assert.deepStrictEqual(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
          assert.strictEqual(status.aheadCount, 1);
          const preview = yield* driver.getReviewDiffPreview({ cwd });
          const changes = preview.sources.find((source) => source.kind === "branch-range")!;
          assert.strictEqual(changes.baseRef, baseRef);
          assert.deepStrictEqual(changes.files, [
            { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
          ]);
          const scoped = yield* driver.getReviewDiffPreview({
            cwd,
            baseRef,
            file: { path: "README.md", previousPath: null, sourceKind: "branch-range" },
          });
          const scopedChanges = scoped.sources.find((source) => source.kind === "branch-range")!;
          assert.deepStrictEqual(scopedChanges.files, changes.files);
          assert.strictEqual(scopedChanges.diff, changes.diff);
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef: changes.baseRef,
              headRef: "feature/local-base",
            }),
          );
          assert.deepStrictEqual(contents, {
            oldContents: "# test\nbase work\n",
            newContents: "# test\nbase work\nfeature work\n",
          });
        }

        for (const baseRef of ["refs/tags/main", initialCommit, "HEAD~2"]) {
          const contents = yield* driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              sourceKind: "branch-range",
              baseRef,
              headRef: "feature/local-base",
            }),
          );
          assert.strictEqual(contents.oldContents, "# test\n");
        }
      }),
    );

    it.effect("Changes accepts an explicit base on a detached HEAD and rejects a bad one", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "--detach"]);
        yield* writeTextFile(cwd, "detached.txt", "detached\n");
        yield* git(cwd, ["add", "detached.txt"]);
        yield* git(cwd, ["commit", "-m", "detached work"]);

        const explicit = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(
          explicit.sources.find((source) => source.kind === "branch-range")!.files,
          [{ path: "detached.txt", previousPath: null, additions: 1, deletions: 0 }],
        );
        const implicit = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(
          implicit.sources.find((source) => source.kind === "branch-range")!.files,
          [],
        );
        const error = yield* driver
          .getReviewDiffPreview({ cwd, baseRef: "missing-base" })
          .pipe(Effect.flip);
        assert.strictEqual(error.operation, "GitVcsDriver.resolveReviewMergeBase");
      }),
    );

    it.effect("Changes compares with the empty tree before the first commit", () =>
      Effect.gen(function* () {
        const upstream = yield* makeTmpDir();
        yield* initRepoWithCommit(upstream);
        yield* git(upstream, ["branch", "-M", "main"]);
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // An unborn main whose remote copy exists must not fail on merge-base.
        yield* git(cwd, ["init", "-b", "main"]);
        yield* git(cwd, ["remote", "add", "origin", upstream]);
        yield* git(cwd, ["fetch", "origin"]);
        yield* writeTextFile(cwd, "new.txt", "one\ntwo\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.isNull(changes.baseRef);
        assert.deepStrictEqual(changes.files, [
          { path: "new.txt", previousPath: null, additions: 2, deletions: 0 },
        ]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: null,
          insertions: 2,
          deletions: 0,
        });
      }),
    );

    it.effect("skips Changes totals instead of indexing thousands of untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* Effect.forEach(
          Array.from({ length: 5_001 }, (_, index) => `bulk/${index}.txt`),
          (file) => writeTextFile(cwd, file, "x\n"),
          { concurrency: 32, discard: true },
        );
        yield* writeTextFile(cwd, "README.md", "changed\n");

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.isTrue(status.hasWorkingTreeChanges);
        assert.isUndefined(status.branchChanges);

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        assert.isNotEmpty(preview.sources);
        assert.isTrue(preview.sources.every((source) => source.truncated));
      }),
    );

    it.effect("Changes does not show newer base commits as deletions", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/rebased"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature work"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "base moves"]);
        yield* git(cwd, ["checkout", "feature/rebased"]);

        for (const rebase of [false, true]) {
          if (rebase) yield* git(cwd, ["rebase", initialBranch]);
          const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
          assert.deepStrictEqual(
            preview.sources.find((source) => source.kind === "branch-range")!.files,
            [{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }],
          );
        }
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reads the current branch and upstream by name when other refs share them", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* git(cwd, ["push", "-u", "origin", "release"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "unpushed"]);
        yield* git(cwd, ["branch", "origin/release"]);
        yield* git(cwd, ["tag", "release"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
        assert.equal(remoteStatus.branch, "release");
        assert.equal(remoteStatus.upstreamRef, "origin/release");
        assert.equal(remoteStatus.aheadCount, 1);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const branchRange = preview.sources.find((source) => source.kind === "branch-range");
        assert.equal(branchRange?.headRef, "release");
      }),
    );

    it.effect("does not open a project folder laid out as a bare repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        // Plain files a project save or a clone can hold. Git discovers them as a bare repository.
        const planted = pathService.join(cwd, "planted");
        yield* writeTextFile(planted, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(planted, "objects/info/keep", "");
        yield* writeTextFile(planted, "refs/heads/keep", "");
        yield* writeTextFile(
          planted,
          "config",
          '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n',
        );

        yield* Effect.exit(driver.statusDetailsLocal(planted));
        assert.isFalse(yield* fileSystem.exists(pathService.join(planted, "fsmonitor-runs")));
        assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isRepo);
      }),
    );

    it.effect("reads Changes totals without minimizing and keeps review diffs minimal", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.algorithm", "myers"]);
        // Repeated lines make the default and minimal algorithms choose different edits.
        const lines = Array.from({ length: 2000 }, (_, index) => index);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 3)) % 16}\n`).join(""),
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "repeated lines"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(
          cwd,
          "repeated.txt",
          lines.map((index) => `${(index ^ (index >> 5)) % 16}\n`).join(""),
        );
        const defaultStat = yield* git(cwd, ["diff", "--numstat", "HEAD", "--"]);
        const minimalStat = yield* git(cwd, ["diff", "--minimal", "--numstat", "HEAD", "--"]);
        assert.notEqual(defaultStat, minimalStat);
        const [insertions, deletions] = defaultStat.split("\t");
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: initialBranch,
          insertions: Number(insertions),
          deletions: Number(deletions),
        });

        const [additions, removals] = minimalStat.split("\t");
        const minimalPatch = yield* git(cwd, [
          "diff",
          "--minimal",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "HEAD",
          "--",
        ]);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        for (const source of preview.sources) {
          assert.deepStrictEqual(source.files, [
            {
              path: "repeated.txt",
              previousPath: null,
              additions: Number(additions),
              deletions: Number(removals),
            },
          ]);
          assert.strictEqual(source.diff.trim(), minimalPatch);
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "lists the real repository through a symlink when a decoy repo occupies the lexical common dir",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const sandbox = yield* makeTmpDir("git-symlink-subdir-");
          yield* initRepoWithCommit(sandbox);
          yield* git(sandbox, ["branch", "-M", "decoy-only"]);
          const repo = pathService.join(sandbox, "repo");
          const link = pathService.join(sandbox, "nest", "link");
          yield* fileSystem.makeDirectory(pathService.join(repo, "sub", "dir"), {
            recursive: true,
          });
          yield* fileSystem.makeDirectory(pathService.dirname(link), { recursive: true });
          yield* fileSystem.symlink(pathService.join(repo, "sub", "dir"), link);

          yield* initRepoWithCommit(repo);
          yield* git(repo, ["checkout", "-b", "real-only"]);

          // The decoy must exist before the first lookup, which caches repository paths.
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const refs = yield* driver.listRefs({ cwd: link });
          assert.isTrue(refs.isRepo);
          assert.isFalse(refs.refs.some((ref) => ref.name === "decoy-only"));
          assert.isTrue(refs.refs.some((ref) => ref.name === "real-only"));

          yield* driver.createWorktree({
            cwd: link,
            path: pathService.join(yield* makeTmpDir("git-worktrees-"), "real"),
            refName: "real-only",
            newRefName: "feature/real-created",
          });
          const createdRefs = yield* driver.listRefs({ cwd: link });
          assert.isFalse(createdRefs.refs.some((ref) => ref.name === "decoy-only"));
          assert.isTrue(createdRefs.refs.some((ref) => ref.name === "real-only" && ref.current));
          assert.isTrue(createdRefs.refs.some((ref) => ref.name === "feature/real-created"));
        }),
    );

    it.effect("reads Changes totals with untracked files when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/totals"]);
        yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
        yield* git(cwd, ["commit", "-am", "commit edit"]);
        yield* writeTextFile(cwd, "nested/untracked.txt", "one\ntwo\n");
        yield* writeTextFile(cwd, "new [1].txt", "literal\n");

        const status = yield* driver.statusDetailsLocal(pathService.join(cwd, "nested"), {
          includeBranchChanges: true,
        });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "main",
          insertions: 4,
          deletions: 0,
        });
        assert.isUndefined((yield* driver.statusDetailsLocal(cwd)).branchChanges);
      }),
    );

    it.effect("Changes compares the default branch with its tracking upstream, not origin", () =>
      Effect.gen(function* () {
        // `origin` is a fork whose main is behind; the checkout tracks the
        // canonical repository through a second remote (#15314).
        const canonical = yield* makeTmpDir();
        yield* initRepoWithCommit(canonical);
        yield* git(canonical, ["branch", "-M", "main"]);
        const fork = yield* makeTmpDir();
        yield* git(fork, ["clone", "--quiet", canonical, "."]);
        yield* writeTextFile(canonical, "canonical.txt", "one\ntwo\nthree\n");
        yield* git(canonical, ["add", "canonical.txt"]);
        yield* git(canonical, ["commit", "-m", "canonical moves ahead"]);

        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["init", "-b", "main"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", canonical]);
        yield* git(cwd, ["fetch", "--quiet", "--all"]);
        yield* git(cwd, ["reset", "--hard", "--quiet", "upstream/main"]);
        yield* git(cwd, ["branch", "--set-upstream-to=upstream/main", "main"]);

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(status.branchChanges, {
          baseRef: "upstream/main",
          insertions: 0,
          deletions: 0,
        });
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "upstream/main");
        assert.deepStrictEqual(changes.files, []);

        // Without an upstream the primary remote's copy stays the base.
        yield* git(cwd, ["branch", "--unset-upstream", "main"]);
        const untracked = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepStrictEqual(untracked.branchChanges, {
          baseRef: "origin/main",
          insertions: 3,
          deletions: 0,
        });
      }),
    );

    it.effect(
      "counts many untracked files exactly while collapsing their directory in status",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const untrackedScanRoots: string[][] = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("ls-files") &&
              command.args.includes("--others")
            ) {
              untrackedScanRoots.push(command.args.slice(command.args.indexOf("--") + 1).map(String));
            }
            return delegate.spawn(command);
          });
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(cwd, ["checkout", "-b", "feature/many-untracked"]);
          yield* writeTextFile(cwd, ".git/info/exclude", "ignored.txt\n");
          yield* writeTextFile(cwd, "bulk[1]/ignored.txt", "ignored\n");
          yield* Effect.forEach(
            Array.from({ length: 1_001 }, (_, index) => `bulk[1]/${index}.txt`),
            (file) => writeTextFile(cwd, file, "one\ntwo\n"),
            { concurrency: 32, discard: true },
          );

          for (const scenario of ["normal", "all", "no", "long names"]) {
            if (scenario === "long names") {
              yield* Effect.forEach(
                Array.from({ length: 50 }, (_, index) => `${"a".repeat(180)}-${index}.txt`),
                (file) => writeTextFile(cwd, file, "long name\n"),
                { concurrency: 32, discard: true },
              );
            }
            const mode = scenario === "long names" ? "normal" : scenario;
            yield* git(cwd, ["config", "status.showUntrackedFiles", mode]);
            untrackedScanRoots.length = 0;
            const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
            assert.deepStrictEqual(status.branchChanges, {
              baseRef: "main",
              insertions: scenario === "long names" ? 2_052 : 2_002,
              deletions: 0,
            });
            assert.deepStrictEqual(untrackedScanRoots, [
              scenario === "normal" ? [":(top,literal)bulk[1]/"] : [],
            ]);
            if (scenario === "normal") {
              assert.deepStrictEqual(
                status.workingTree.files.map((file) => file.path),
                ["bulk[1]/"],
              );
            }
          }
        }),
    );

    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports changes to a file named HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "HEAD", "first line\n");
        yield* git(cwd, ["add", "HEAD"]);
        yield* git(cwd, ["commit", "-m", "add HEAD file"]);
        yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "HEAD",
          insertions: 1,
          deletions: 0,
        });
      }),
    );

    it.effect("reports renamed and non-ASCII files by paths that can be committed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "src/old.ts", "one\ntwo\nthree\n");
        yield* writeTextFile(cwd, "café notes.md", "draft\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add files"]);
        yield* git(cwd, ["mv", "src/old.ts", "src/new.ts"]);
        yield* writeTextFile(cwd, "src/new.ts", "one\ntwo\nthree\nfour\n");
        yield* writeTextFile(cwd, "café notes.md", "draft\nedit\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(cwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "café notes.md", insertions: 1, deletions: 0 },
          { path: "src/new.ts", insertions: 1, deletions: 0 },
          { path: "src/old.ts", insertions: 0, deletions: 0 },
        ]);
        yield* driver.commit(cwd, "Commit selection", "", {
          stage: { filePaths: status.workingTree.files.map((file) => file.path) },
        });
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
      }),
    );

    it.effect("commits selected files from a nested project directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // A root basename ending in whitespace catches a root lookup that trims Git's output.
        const cwd = path.join(yield* makeTmpDir(), "repo ");
        yield* (yield* FileSystem.FileSystem).makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\ntwo\n");
        yield* writeTextFile(cwd, "nested/new.txt", "new\n");
        yield* writeTextFile(cwd, "README.md", "# test\nleft out\n");
        const nestedCwd = path.join(cwd, "nested");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(nestedCwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
          { path: "README.md", insertions: 1, deletions: 0 },
        ]);
        // The root is what the paths above are relative to, not the nested cwd, and it keeps
        // the trailing space so the resolved editor target is the file that exists.
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(cwd));
        assert.equal(
          NodeFS.existsSync(path.join(status.workingTree.rootPath!, "nested", "new.txt")),
          true,
        );
        yield* driver.commit(nestedCwd, "Commit nested selection", "", {
          stage: { filePaths: ["nested/new.txt", "nested/tracked.txt"] },
        });
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "M README.md");
      }),
    );

    it.effect("reports the linked worktree as the root of a nested directory in it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const worktreePath = yield* makeTmpDir("git-vcs-driver-linked-");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add nested file"]);
        yield* git(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
        yield* writeTextFile(worktreePath, "nested/tracked.txt", "one\ntwo\n");
        yield* writeTextFile(worktreePath, "nested/new.txt", "new\n");
        const nestedCwd = (yield* Path.Path).join(worktreePath, "nested");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(nestedCwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
        ]);
        assert.equal(
          NodeFS.realpathSync.native(status.workingTree.rootPath!),
          NodeFS.realpathSync.native(worktreePath),
        );
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("can read local files without traversing revision history", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/local-only"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\nlocal edit\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: ReadonlyArray<string>[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            commands.push(command.args.map(String));
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        for (const hasUpstream of [false, true]) {
          if (hasUpstream) {
            yield* git(cwd, ["push", "-u", "origin", "feature/local-only"]);
          }
          commands.length = 0;
          const local = yield* driver.statusDetailsLocal(cwd, { includeDivergence: false });
          assert.isFalse(commands.some((args) => args.includes("rev-list")));
          assert.isTrue(commands.some((args) => args.includes("--no-ahead-behind")));
          assert.equal(local.hasUpstream, hasUpstream);
          assert.isTrue(local.hasWorkingTreeChanges);
          assert.deepEqual(local.workingTree.files, [
            { path: "feature.txt", insertions: 1, deletions: 0 },
            { path: "untracked.txt", insertions: 0, deletions: 0 },
          ]);

          commands.length = 0;
          const full = yield* driver.statusDetailsLocal(cwd);
          assert.isTrue(commands.some((args) => args.includes("rev-list")));
          assert.equal(full.aheadCount, hasUpstream ? 0 : 1);
          assert.equal(full.aheadOfDefaultCount, 1);
          assert.deepEqual(local, {
            ...full,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          });
        }

        yield* git(cwd, ["branch", "-f", initialBranch, "HEAD"]);
        yield* git(cwd, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
        for (const base of [initialBranch, "missing-base"]) {
          yield* git(cwd, ["config", "branch.feature/local-only.gh-merge-base", base]);
          commands.length = 0;
          const status = yield* driver.statusDetailsLocal(cwd, {
            includeDivergence: false,
            includeBranchChanges: true,
          });
          assert.deepEqual(status.branchChanges, {
            baseRef: `origin/${base === initialBranch ? initialBranch : "trunk"}`,
            insertions: base === initialBranch ? 3 : 2,
            deletions: 0,
          });
          assert.lengthOf(
            commands.filter((args) => args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD"),
            base === initialBranch ? 0 : 1,
          );
        }
      }),
    );

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "trunk"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "trunk"]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);

        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: ReadonlyArray<string>[] = [];
        let originHeadReads = 0;
        let failFirstOriginHead = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("expected a standard Git command");
            }
            commands.push(command.args.map(String));
            if (command.args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD") {
              originHeadReads++;
              if (failFirstOriginHead && originHeadReads === 1) return makeNonRepositoryHandle();
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.defaultBranch, "trunk");
        assert.equal(status.isDefaultBranch, false);
        assert.equal(status.upstreamRef, "origin/feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
        assert.deepEqual(
          commands.filter((args) => args.length === 1 && args[0] === "remote"),
          [],
          `cached remote status should not enumerate remotes: ${JSON.stringify(commands)}`,
        );
        assert.equal(originHeadReads, 1);

        // With no main/master fallback, the retry must resolve trunk to preserve the ahead count.
        originHeadReads = 0;
        failFirstOriginHead = true;
        const retried = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
        assert.deepEqual(retried, { ...status, defaultBranch: null });
        assert.equal(originHeadReads, 2);
      }),
    );

    it.effect("reports remote status on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("does not start Git auto-maintenance from background upstream fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["repack", "-d"]);
        yield* writeTextFile(cwd, "second.txt", "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "second commit"]);
        yield* git(cwd, ["push"]);
        yield* git(cwd, ["repack", "-d"]);
        // Two packs make `git gc --auto` due, and without detaching it would run inside the fetch.
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        const packCount = git(cwd, ["count-objects", "-v"]).pipe(
          Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
        );
        assert.equal(yield* packCount, "2");

        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(yield* packCount, "2");
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = yield* pathService.fromFileUrl(
          new URL("./testing/GitVcsDriverCore.fixture.sh", import.meta.url),
        );
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports combined staged and unstaged edits to the same file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* git(cwd, ["commit", "-m", "add feature"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        const file = status.workingTree.files.find((f) => f.path === "feature.ts");
        assert.ok(file);
        // HEAD has 1 line. Staged has 2 lines (+1). Unstaged has 3 lines (+2 from HEAD).
        // Combined net from HEAD: +2 insertions.
        assert.equal(file.insertions, 2);
        assert.equal(file.deletions, 0);
      }),
    );

    it.effect("reports staged file counts on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.ts", "// first file\n");
        yield* git(cwd, ["add", "initial.ts"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.workingTree.files.length, 1);
        const file = status.workingTree.files[0];
        if (file) {
          assert.equal(file.path, "initial.ts");
          assert.equal(file.insertions, 1);
        }
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("marks the origin default ref as default when no local copy exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
        yield* git(cwd, ["branch", "-D", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
        assert.equal(remoteDefault?.isRemote, true);
        assert.equal(remoteDefault?.isDefault, true);
      }),
    );

    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("preserves exact custom names and refuses collisions without a suffix", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createRef({ cwd, refName: "Julius/ABC-123" });
        const failed = yield* driver
          .renameBranch({
            cwd,
            oldBranch: initialBranch,
            newBranch: "Julius/ABC-123",
            exactName: true,
          })
          .pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: initialBranch,
          newBranch: "Julius/ABC-124.v2",
          exactName: true,
        });
        assert.equal(renamed.branch, "Julius/ABC-124.v2");
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );

    it.effect("flattens a generated name when a branch at its parent path blocks it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // A local `t3` branch is why launches start on the flat `t3-<hex>` temporary branch.
        yield* git(cwd, ["branch", "t3"]);
        yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
        yield* git(cwd, ["branch", "t3-fix-login"]);

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "t3-abcd1234",
          newBranch: "t3/fix-login",
        });

        assert.equal(renamed.branch, "t3-fix-login-1");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
      }),
    );

    it.effect("skips a flattened name that a nested branch blocks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "t3"]);
        yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
        yield* git(cwd, ["branch", "t3-fix-login/child"]);

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "t3-abcd1234",
          newBranch: "t3/fix-login",
        });

        assert.equal(renamed.branch, "t3-fix-login-1");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
      }),
    );

    it.effect("rejects a missing branch without restoring a matching dirty file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "obsolete-branch", "original\n");
        yield* git(cwd, ["add", "obsolete-branch"]);
        yield* git(cwd, ["commit", "-m", "tracked file"]);
        yield* git(cwd, ["branch", "obsolete-branch"]);
        yield* git(cwd, ["branch", "-D", "obsolete-branch"]);
        yield* writeTextFile(cwd, "obsolete-branch", "uncommitted work\n");

        const result = yield* driver
          .switchRef({ cwd, refName: "obsolete-branch" })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "obsolete-branch")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
    );

    it.effect("treats ref names that look like options as ref names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature", "HEAD:refs/heads/-M"]);
        // Git refuses such branch names, but update-ref writes them, here tracking origin/feature.
        yield* git(cwd, ["update-ref", "refs/heads/-f", "HEAD"]);
        yield* git(cwd, ["config", "branch.-f.remote", "origin"]);
        yield* git(cwd, ["config", "branch.-f.merge", "refs/heads/feature"]);
        yield* git(cwd, ["branch", "keep"]);
        yield* writeTextFile(cwd, "README.md", "uncommitted work\n");
        const branches = yield* driver.listLocalBranchNames(cwd);
        const worktrees = yield* makeTmpDir("git-worktrees-");

        yield* driver.switchRef({ cwd, refName: "-f" }).pipe(Effect.flip);
        yield* driver.switchRef({ cwd, refName: "origin/feature" }).pipe(Effect.flip);
        yield* driver.createRef({ cwd, refName: "--list" }).pipe(Effect.flip);
        for (const [refName, newRefName] of [
          ["--detach", undefined],
          ["-M", undefined],
          ["-M", "renamed"],
          ["-D", "keep"],
          ["keep", "-M"],
          ["keep", "-D"],
        ] as const) {
          yield* driver
            .createWorktree({
              cwd,
              path: pathService.join(worktrees, "wt"),
              refName,
              ...(newRefName ? { newRefName } : {}),
            })
            .pipe(Effect.flip);
        }

        assert.equal(
          yield* fileSystem.readFileString(pathService.join(cwd, "README.md")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        assert.deepEqual(yield* driver.listLocalBranchNames(cwd), branches);
        assert.isFalse(yield* fileSystem.exists(pathService.join(worktrees, "wt")));

        // A lone "-" is still the previous checkout.
        yield* git(cwd, ["checkout", "-q", "keep"]);
        yield* git(cwd, ["checkout", "-q", initialBranch]);
        assert.equal((yield* driver.switchRef({ cwd, refName: "-" })).refName, "keep");
        const previous = yield* driver.createWorktree({
          cwd,
          path: pathService.join(worktrees, "previous"),
          refName: "-",
        });
        assert.equal(
          yield* git(previous.worktree.path, ["branch", "--show-current"]),
          initialBranch,
        );
        const fromPrevious = yield* driver.createWorktree({
          cwd,
          path: pathService.join(worktrees, "from-previous"),
          refName: "-",
          newRefName: "from-previous",
        });
        assert.equal(
          yield* git(fromPrevious.worktree.path, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", initialBranch]),
        );
      }),
    );

    it.effect("still creates and reuses remote tracking branches and allows detached refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command)) commands.push(command.args.map(String));
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const assertCheckout = (
          checkoutArgs: ReadonlyArray<string>,
          existenceReads: number,
          trackingReads: number,
          branchWrites: ReadonlyArray<ReadonlyArray<string>> = [],
        ) => {
          assert.deepEqual(
            commands.filter((args) => args[0] === "checkout"),
            [checkoutArgs],
          );
          assert.equal(commands.filter((args) => args[0] === "show-ref").length, existenceReads);
          assert.equal(commands.filter((args) => args[0] === "for-each-ref").length, trackingReads);
          assert.deepEqual(
            commands.filter((args) => args[0] === "branch"),
            [...branchWrites, ["branch", "--show-current"]],
          );
        };
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/remote-only"]);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          commands.length = 0;
          const result = yield* driver.switchRef({ cwd, refName: "origin/remote-only" });
          assert.equal(result.refName, attempt === 0 ? "remote-only" : "review/renamed");
          assertCheckout(
            attempt === 0
              ? ["checkout", "remote-only", "--"]
              : ["checkout", "review/renamed", "--"],
            attempt === 0 ? 3 : 2,
            1,
            // The branch `checkout --track` would make, made before the checkout.
            attempt === 0
              ? [
                  ["branch", "--no-track", "--", "remote-only", "refs/remotes/origin/remote-only"],
                  [
                    "branch",
                    "--set-upstream-to=refs/remotes/origin/remote-only",
                    "--",
                    "remote-only",
                  ],
                ]
              : [],
          );
          assert.equal(
            yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/remote-only",
          );
          if (attempt === 0) yield* git(cwd, ["branch", "-m", "review/renamed"]);
          yield* driver.switchRef({ cwd, refName: initialBranch });
        }
        yield* git(cwd, ["branch", "origin/remote-only"]);
        commands.length = 0;
        const shadowed = yield* driver.switchRef({ cwd, refName: "origin/remote-only" });
        assert.equal(shadowed.refName, "origin/remote-only");
        assertCheckout(["checkout", "origin/remote-only", "--"], 2, 0);

        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        commands.length = 0;
        const detached = yield* driver.switchRef({ cwd, refName: commit });
        assert.equal(detached.refName, null);
        assertCheckout(["checkout", commit, "--"], 2, 0);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), commit);
      }),
    );

    // `main` and `big` differ in a.txt, m.slow and z.txt; m.slow's smudge filter holds the
    // checkout after a.txt is rewritten, the way an LFS download or a huge tree does, until the
    // test opens the gate. The clock then runs well past any bound a command would get.
    const slowCheckout = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["config", "filter.slow.clean", "cat"]);
      yield* git(cwd, ["config", "filter.slow.smudge", "cat"]);
      yield* writeTextFile(cwd, ".gitattributes", "*.slow filter=slow\n");
      for (const name of ["a.txt", "m.slow", "z.txt"]) yield* writeTextFile(cwd, name, "main\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "main"]);
      yield* git(cwd, ["checkout", "-b", "big"]);
      for (const name of ["a.txt", "m.slow", "z.txt"]) yield* writeTextFile(cwd, name, "big\n");
      yield* git(cwd, ["commit", "-am", "big"]);
      const bigCommit = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["checkout", initialBranch]);
      // Relative to the working tree's top, where git runs the filter.
      yield* git(cwd, [
        "config",
        "filter.slow.smudge",
        "touch .git/smudging; while [ ! -f .git/gate ]; do sleep 0.05; done; cat",
      ]);
      const smudging = Effect.gen(function* () {
        while (!(yield* fileSystem.exists(pathService.join(cwd, ".git/smudging")))) {
          yield* TestClock.withLive(Effect.sleep("20 millis"));
        }
      });
      const openGate = writeTextFile(cwd, ".git/gate", "");
      const runPastEveryBound = <A, E, R>(move: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const moving = yield* move.pipe(Effect.result, Effect.forkScoped);
          yield* smudging;
          yield* TestClock.adjust("10 minutes");
          yield* openGate;
          return yield* Fiber.join(moving);
        });
      // As a client that disconnects or reloads while its request moves the checkout.
      const interruptMidMove = <A, E, R>(move: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const moving = yield* move.pipe(Effect.forkScoped);
          yield* smudging;
          const interrupting = yield* Fiber.interrupt(moving).pipe(Effect.forkScoped);
          // An interrupt returns once the move has ended; a killed git gets time to die first.
          yield* TestClock.withLive(
            Fiber.await(interrupting).pipe(Effect.timeoutOption("2 seconds")),
          );
          yield* openGate;
          yield* Fiber.join(interrupting);
        });
      // `big` as the pull target of the checked-out branch.
      const trackBig = Effect.gen(function* () {
        yield* git(cwd, ["config", `branch.${initialBranch}.remote`, "."]);
        yield* git(cwd, ["config", `branch.${initialBranch}.merge`, "refs/heads/big"]);
      });
      return {
        cwd,
        initialBranch,
        bigCommit,
        smudging,
        openGate,
        runPastEveryBound,
        interruptMidMove,
        trackBig,
      };
    });

    it.effect("finishes a slow branch switch instead of leaving the checkout half switched", () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { cwd, runPastEveryBound } = yield* slowCheckout;

        const switched = yield* runPastEveryBound(driver.switchRef({ cwd, refName: "big" }));

        assert.deepStrictEqual(
          {
            switched: Result.isSuccess(switched) ? switched.success : switched.failure.detail,
            branch: yield* git(cwd, ["branch", "--show-current"]),
            status: yield* git(cwd, ["status", "--porcelain"]),
          },
          { switched: { refName: "big" }, branch: "big", status: "" },
        );
      }),
    );

    it.effect("finishes a slow pull request refresh instead of leaving the checkout half moved", () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { cwd, bigCommit, runPastEveryBound } = yield* slowCheckout;

        const refreshed = yield* runPastEveryBound(
          driver.refreshCheckedOutBranch({ cwd, targetCommit: bigCommit }),
        );

        assert.deepStrictEqual(
          {
            refreshed: Result.isSuccess(refreshed) ? refreshed.success : refreshed.failure.detail,
            head: yield* git(cwd, ["rev-parse", "HEAD"]),
            status: yield* git(cwd, ["status", "--porcelain"]),
          },
          {
            refreshed: { headCommit: bigCommit, moved: true, onTarget: true },
            head: bigCommit,
            status: "",
          },
        );
      }),
    );

    it.effect("finishes a slow pull instead of leaving the checkout half moved", () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { cwd, initialBranch, bigCommit, runPastEveryBound, trackBig } = yield* slowCheckout;
        yield* trackBig;

        const pulled = yield* runPastEveryBound(driver.pullCurrentBranch(cwd));

        assert.deepStrictEqual(
          {
            pulled: Result.isSuccess(pulled) ? pulled.success : pulled.failure.detail,
            head: yield* git(cwd, ["rev-parse", "HEAD"]),
            status: yield* git(cwd, ["status", "--porcelain"]),
          },
          {
            pulled: { status: "pulled", refName: initialBranch, upstreamRef: "big" },
            head: bigCommit,
            status: "",
          },
        );
      }),
    );

    it.effect.each(["branch switch", "pull request refresh", "pull"] as const)(
      "lets a %s its caller abandons finish moving the checkout",
      (move) =>
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const { cwd, bigCommit, interruptMidMove, trackBig } = yield* slowCheckout;
          if (move === "pull") yield* trackBig;

          yield* interruptMidMove<unknown, GitCommandError, never>(
            move === "branch switch"
              ? driver.switchRef({ cwd, refName: "big" })
              : move === "pull request refresh"
                ? driver.refreshCheckedOutBranch({ cwd, targetCommit: bigCommit })
                : driver.pullCurrentBranch(cwd),
          );

          assert.deepStrictEqual(
            {
              head: yield* git(cwd, ["rev-parse", "HEAD"]),
              status: yield* git(cwd, ["status", "--porcelain"]),
            },
            { head: bigCommit, status: "" },
          );
        }),
    );

    it.effect("leaves the shared config free while a remote branch checks out", () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { cwd, bigCommit, smudging, openGate } = yield* slowCheckout;
        yield* git(cwd, ["remote", "add", "origin", cwd]);
        yield* git(cwd, ["update-ref", "refs/remotes/origin/big", bigCommit]);
        yield* git(cwd, ["branch", "-D", "big"]);

        const switching = yield* driver
          .switchRef({ cwd, refName: "origin/big" })
          .pipe(Effect.result, Effect.forkScoped);
        yield* smudging;
        // Any other writer of the shared config: a branch, a worktree, an upstream.
        const written = yield* TestClock.withLive(
          driver
            .writeConfigValue({ cwd, key: "caveman.probe", value: "written" })
            .pipe(Effect.timeoutOption("5 seconds")),
        );
        yield* openGate;
        const switched = yield* Fiber.join(switching);

        assert.deepStrictEqual(
          {
            written: Option.isSome(written),
            switched: Result.isSuccess(switched) ? switched.success : switched.failure.detail,
            upstream: yield* git(cwd, ["rev-parse", "--abbrev-ref", "big@{upstream}"]),
            status: yield* git(cwd, ["status", "--porcelain"]),
          },
          { written: true, switched: { refName: "big" }, upstream: "origin/big", status: "" },
        );
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("uses parallel checkout without skipping filters or hooks", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "filter.test.smudge", "sed s/original/filtered/g"]);
        yield* writeTextFile(cwd, ".gitattributes", "asset.txt filter=test\n");
        yield* writeTextFile(cwd, "asset.txt", "original\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "filtered asset"]);
        yield* writeTextFile(
          cwd,
          ".git/hooks/post-checkout",
          "#!/bin/sh\ngit config checkout.workers > checkout-workers\nexit 0\n",
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "parallel");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/parallel",
          baseRefName: initialBranch,
        });

        assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "locked");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "checkout-workers")), "0\n");
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "asset.txt")), "filtered\n");
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "HEAD"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(
          yield* git(cwd, ["config", "branch.feature/parallel.gh-merge-base"]),
          initialBranch,
        );
        for (const [configured, expected] of [
          ["1", "1"],
          ["", "0"],
        ] as const) {
          yield* git(cwd, ["config", "checkout.workers", configured]);
          const configuredPath = path.join(yield* makeTmpDir("git-worktrees-"), "configured");
          yield* driver.createWorktree({
            cwd,
            path: configuredPath,
            refName: initialBranch,
            newRefName: `feature/configured-${expected}`,
          });
          assert.equal(
            yield* fs.readFileString(path.join(configuredPath, "checkout-workers")),
            `${expected}\n`,
          );
        }
      }),
    );

    // regression: #27749 hooks inherited the driver's forced LC_ALL=C
    it.effect("runs post-checkout hooks under the server's own locale", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const serverLocale = process.env.LC_ALL ?? "unset";
        const seenLocale = path.join(yield* makeTmpDir("git-hook-locale-"), "lc-all");
        yield* writeTextFile(
          cwd,
          "hooks/post-checkout",
          `#!/bin/sh\necho "\${LC_ALL-unset}" > '${seenLocale}'\n[ "\${LC_ALL-unset}" = '${serverLocale}' ]\n`,
        );
        yield* fs.chmod(path.join(cwd, "hooks/post-checkout"), 0o755);
        yield* git(cwd, ["config", "core.hooksPath", path.join(cwd, "hooks")]);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "locale");

        const result = yield* driver
          .createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "locale" })
          .pipe(Effect.result);

        assert.equal(
          (yield* fs.readFileString(seenLocale)).trim(),
          serverLocale,
          "post-checkout hook should see the server's LC_ALL",
        );
        assert.isTrue(Result.isSuccess(result), "worktree creation failed in the hook");
      }),
    );
    it.effect.each(["commit", "short-commit", "tag", "revision"] as const)(
      "creates a worktree from a %s without recording it as a PR base",
      (kind) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["tag", "v1"]);
          const baseRef =
            kind === "commit"
              ? commit
              : kind === "short-commit"
                ? commit.slice(0, 12)
                : kind === "tag"
                  ? "v1"
                  : "HEAD~0";
          const path = yield* Path.Path;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "revision");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: baseRef,
            newRefName: "feature/revision",
            baseRefName: baseRef,
          });

          assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), commit);
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/revision.gh-merge-base"),
            null,
          );
        }),
    );

    // regression: #28354 a failed worktree add left its new branch behind and blocked retries
    it.effect("removes the new branch when the worktree cannot be added", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const occupiedPath = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(occupiedPath, "existing.txt", "occupied\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const failed = yield* driver
          .createWorktree({
            cwd,
            path: occupiedPath,
            refName: initialBranch,
            newRefName: "t3/collide",
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(failed));
        assert.equal(yield* git(cwd, ["branch", "--list", "t3/collide"]), "");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "retry");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "t3/collide",
        });
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "t3/collide");
      }),
    );

    it.effect("creates parallel worktrees in one repository without racing on its config", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const path = yield* Path.Path;
        const worktrees = yield* makeTmpDir("git-worktrees-");

        // Git has no lock timeout for .git/config, which every worktree shares: a writer that
        // overlaps another fails, and a branch can then be left without its worktree.
        let configWriters = 0;
        let peakConfigWriters = 0;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const countingSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
            const writesConfig =
              (args.includes("worktree") && args.includes("add") && args.includes("-b")) ||
              (args[0] === "branch" &&
                (args[1] === "-m" || args[1]?.startsWith("--set-upstream-to"))) ||
              (args[0] === "config" && !args[1]?.startsWith("-"));
            if (!writesConfig) return yield* delegate.spawn(command);
            configWriters += 1;
            peakConfigWriters = Math.max(peakConfigWriters, configWriters);
            const handle = yield* delegate.spawn(command);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: handle.exitCode.pipe(
                Effect.ensuring(Effect.sync(() => (configWriters -= 1))),
              ),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
          Effect.provide(layerServerConfig),
        );
        const branches = Array.from({ length: 8 }, (_, index) => `feature/parallel-${index}`);

        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.createWorktree({
              cwd,
              path: path.join(worktrees, branch.replace("/", "-")),
              refName: `origin/${initialBranch}`,
              newRefName: branch,
              baseRefName: `origin/${initialBranch}`,
            }),
          { concurrency: "unbounded" },
        );
        // Launches rename their temporary branch from inside the new worktree.
        yield* Effect.forEach(
          branches,
          (branch) =>
            driver.renameBranch({
              cwd: path.join(worktrees, branch.replace("/", "-")),
              oldBranch: branch,
              newBranch: `${branch}-renamed`,
              exactName: true,
            }),
          { concurrency: "unbounded" },
        );

        assert.equal(peakConfigWriters, 1);
        for (const branch of branches) {
          const renamed = `${branch}-renamed`;
          assert.equal(yield* git(cwd, ["config", `branch.${renamed}.remote`]), "origin");
          assert.equal(
            yield* git(cwd, ["config", `branch.${renamed}.gh-merge-base`]),
            initialBranch,
          );
        }
      }),
    );

    it.effect.each(["release/v2", "refs/heads/release/v2", "deadbeef"])(
      "records the branch name when creating a worktree from %s",
      (baseRef) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const baseBranch = baseRef.replace(/^refs\/heads\//, "");
          yield* git(cwd, ["branch", baseBranch]);
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "branch"),
            refName: baseRef,
            newRefName: "feature/branch",
            baseRefName: baseRef,
          });

          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/branch.gh-merge-base"),
            baseBranch,
          );
        }),
    );

    it.effect.each(["release/v2", "origin/release/v2", "refs/remotes/origin/release/v2"])(
      "records a remote-only PR base when creating a worktree from %s",
      (baseRef) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const remote = yield* makeTmpDir("git-remote-");
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release/v2"]);
          const commit = yield* git(cwd, ["rev-parse", "origin/release/v2"]);
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "remote");
          yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: commit,
            newRefName: "feature/remote",
            baseRefName: baseRef,
          });

          const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
          const comparisonBase = preview.sources.find(
            (source) => source.kind === "branch-range",
          )!.baseRef;
          assert.equal(
            yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
            commit,
          );
        }),
    );

    it("parses checkout progress lines from git's stderr", () => {
      assert.deepStrictEqual(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)"), {
        percent: 78,
        completed: 2104,
        total: 2700,
      });
      // Progress lines arrive carriage-return separated and end with a done marker.
      assert.deepStrictEqual(
        parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done."),
        { percent: 100, completed: 2700, total: 2700 },
      );
      assert.strictEqual(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')"), null);
    });

    // NTFS rejects a newline in a file name, so there is nothing to preserve there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "preserves newline characters in worktree paths when listing refs",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
          const pathService = yield* Path.Path;
          const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
          const driver = yield* GitVcsDriver.GitVcsDriver;

          yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

          const refs = yield* driver.listRefs({ cwd, refresh: true });
          const listedPath = refs.refs.find(
            (ref) => ref.name === "feature/newline-path",
          )?.worktreePath;

          if (typeof listedPath !== "string") {
            return assert.fail("expected the linked branch to include its worktree path");
          }
          assert.equal(
            NodeFS.realpathSync.native(listedPath),
            NodeFS.realpathSync.native(worktreePath),
          );
        }),
    );

    const repoWithSubmodule = Effect.gen(function* () {
      // Git refuses `file:` submodule transports by default (CVE-2022-39253)
      // and ignores repo-level config for it, so a local fixture needs the
      // env allowance. Real submodules are https/ssh and need none of this.
      const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
      process.env.GIT_ALLOW_PROTOCOL = "file";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousAllowedProtocol === undefined) {
            delete process.env.GIT_ALLOW_PROTOCOL;
          } else {
            process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
          }
        }),
      );

      // A real submodule: `git worktree add` leaves these empty, which is
      // what silently strips shared tooling out of every new worktree.
      const submoduleRepo = yield* makeTmpDir("git-submodule-");
      yield* initRepoWithCommit(submoduleRepo);
      yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
      yield* git(submoduleRepo, ["add", "."]);
      yield* git(submoduleRepo, ["commit", "-m", "shared"]);

      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
      yield* git(cwd, ["commit", "-m", "add submodule"]);
      return { cwd, initialBranch };
    });

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const { cwd, initialBranch } = yield* repoWithSubmodule;

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("checks out submodules that take longer than the default command timeout", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const { cwd, initialBranch } = yield* repoWithSubmodule;
        // A first clone of a sizeable submodule over the network.
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const updateStarted = yield* Deferred.make<void>();
        const slowCloneSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args[0] === "submodule" &&
              command.args[1] === "update"
            ) {
              yield* Deferred.succeed(updateStarted, undefined);
              yield* Effect.sleep("45 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, slowCloneSpawner),
          Effect.provide(layerServerConfig),
        );
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "slow-submodule-worktree",
        );
        const finished: Array<{ ok: boolean; detail: string | null }> = [];

        const creating = yield* driver
          .createWorktree(
            { cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/slow-clone" },
            {
              progress: {
                onSubmodulesFinished: (result) =>
                  Effect.sync(() => {
                    finished.push(result);
                  }),
              },
            },
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(updateStarted);
        yield* TestClock.adjust("45 seconds");
        yield* Fiber.join(creating);

        assert.deepStrictEqual(finished, [{ ok: true, detail: null }]);
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        // Points at a repository that does not exist, so the checkout fails the
        // way an unreachable private remote would. Creation must still succeed.
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        const gitlink = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},missing`]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
        const created = yield* driver.createWorktree(
          {
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/broken-submodules",
          },
          {
            progress: {
              onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
            },
          },
        );

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
        const results = yield* Ref.get(finished);
        assert.lengthOf(results, 1);
        assert.isFalse(results[0]!.ok);
        assert.include(results[0]!.detail, "GitVcsDriver.createWorktree.updateSubmodules");
      }),
    );

    it.effect("creates worktrees under the configured worktrees directory", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" },
          { worktreesDirectory },
        );
        const expected = pathService.join(
          worktreesDirectory,
          pathService.basename(cwd),
          "feature-custom-dir",
        );
        assert.equal(created.worktree.path, expected);
        assert.equal(yield* fileSystem.exists(expected), true);

        const error = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/relative-dir" },
            { worktreesDirectory: "relative/worktrees" },
          )
          .pipe(Effect.flip);
        assert.match(error.detail, /must be an absolute folder on this machine/);

        const rootError = yield* driver
          .createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: "feature/root-dir" },
            { worktreesDirectory: "/" },
          )
          .pipe(Effect.flip);
        assert.match(rootError.detail, /not a drive root/);
      }),
    );

    it.effect("keeps generated worktree folders short without changing long branch names", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const folders = new Set<string>();
        const branches = [
          `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}`,
          `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"d".repeat(90)}`,
          `feature/${"a".repeat(40)}/5fac`,
          `feature/${"a".repeat(40)}/18828`,
          `${"a".repeat(22)}😀/${"b".repeat(30)}`,
          "z".repeat(40),
          "z".repeat(41),
        ];
        for (const branch of branches) {
          const created = yield* driver.createWorktree(
            { cwd, path: null, refName: initialBranch, newRefName: branch },
            { worktreesDirectory },
          );
          const folder = pathService.basename(created.worktree.path);
          assert.isAtMost(folder.length, 40);
          if (branch.length <= 40) assert.equal(folder, branch);
          assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), branch);
          assert.include(
            yield* git(cwd, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]),
            `worktree ${created.worktree.path}`,
          );
          folders.add(folder);
        }
        assert.equal(folders.size, branches.length);
      }),
    );

    it.effect("resolves the submodule mode from the option, then t3.json", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // inner -> nested, so a recursive init populates nested/NESTED.md and
        // a top-level init leaves it empty.
        const nestedRepo = yield* makeTmpDir("git-nested-");
        yield* initRepoWithCommit(nestedRepo);
        yield* writeTextFile(nestedRepo, "NESTED.md", "# nested\n");
        yield* git(nestedRepo, ["add", "."]);
        yield* git(nestedRepo, ["commit", "-m", "nested"]);
        const innerRepo = yield* makeTmpDir("git-inner-");
        yield* initRepoWithCommit(innerRepo);
        yield* writeTextFile(innerRepo, "INNER.md", "# inner\n");
        yield* git(innerRepo, ["submodule", "add", nestedRepo, "nested"]);
        yield* git(innerRepo, ["add", "."]);
        yield* git(innerRepo, ["commit", "-m", "inner"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", innerRepo, "inner"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreesDir = yield* makeTmpDir("git-worktrees-");

        const createWithMode = Effect.fn(function* (
          fileMode: WorktreeSubmodules,
          branch: string,
          submodules: WorktreeSubmodules | null = null,
        ) {
          yield* writeTextFile(cwd, "t3.json", `{ "worktreeSubmodules": "${fileMode}" }`);
          yield* git(cwd, ["add", "t3.json"]);
          // Consecutive cases may reuse a file mode to test the option alone.
          yield* git(cwd, ["commit", "--allow-empty", "-m", `submodules: ${fileMode}`]);
          const worktreePath = pathService.join(worktreesDir, branch);
          const disabled = yield* Ref.make<"settings" | "t3.json" | false>(false);
          yield* driver.createWorktree(
            { cwd, path: worktreePath, refName: initialBranch, newRefName: branch },
            {
              submodules,
              progress: { onSubmodulesDisabled: ({ source }) => Ref.set(disabled, source) },
            },
          );
          return {
            disabled: yield* Ref.get(disabled),
            inner: yield* fileSystem.exists(pathService.join(worktreePath, "inner", "INNER.md")),
            nested: yield* fileSystem.exists(
              pathService.join(worktreePath, "inner", "nested", "NESTED.md"),
            ),
          };
        });

        assert.deepEqual(yield* createWithMode("recursive", "recursive"), {
          disabled: false,
          inner: true,
          nested: true,
        });
        assert.deepEqual(yield* createWithMode("top-level", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        // A resolved setting outranks the file in both directions.
        assert.deepEqual(yield* createWithMode("recursive", "setting-none", "none"), {
          disabled: "settings",
          inner: false,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "setting-wins", "top-level"), {
          disabled: false,
          inner: true,
          nested: false,
        });
        assert.deepEqual(yield* createWithMode("none", "none"), {
          disabled: "t3.json",
          inner: false,
          nested: false,
        });
      }),
    );

    it.effect("still creates the worktree when the base-ref config stays locked", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "locked-config");
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // The base-ref write retries on the real clock before giving up.
        const created = yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/locked-config",
            baseRefName: initialBranch,
          }),
        );

        assert.deepEqual(created.worktree, {
          path: worktreePath,
          refName: "feature/locked-config",
        });
        assert.equal(
          yield* git(worktreePath, ["branch", "--show-current"]),
          "feature/locked-config",
        );
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(worktreePath, "README.md")),
          "# test\n",
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.feature/locked-config.gh-merge-base"),
          null,
        );
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, ".git/config.lock")), true);
      }),
    );

    it.effect("reports checkout progress during parallel worktree creation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        for (let index = 0; index < 200; index += 1) {
          yield* writeTextFile(cwd, `file-${index}.txt`, `${index}\n`);
        }
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add files"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "progress-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const seen = yield* Ref.make<Array<{ percent: number; completed: number; total: number }>>(
          [],
        );
        const claimed = yield* Ref.make<{ path: string; existed: boolean } | null>(null);

        yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/progress" },
          {
            progress: {
              onWorktreeClaimed: (path) =>
                Ref.set(claimed, { path, existed: NodeFS.existsSync(path) }),
              onCheckoutProgress: (update) => Ref.update(seen, (all) => [...all, update]),
            },
          },
        );
        // Claimed only once git has registered the directory.
        assert.deepEqual(yield* Ref.get(claimed), { path: worktreePath, existed: true });

        // Git separates live progress updates with `\r`, so the driver must
        // surface every intermediate percentage, not just the final line.
        const updates = yield* Ref.get(seen);
        assert.isAbove(updates.length, 1);
        assert.equal(updates.at(-1)?.percent, 100);
        assert.equal(updates.at(-1)?.total, 201);
        const completed = updates.map((update) => update.completed);
        assert.deepEqual(
          completed,
          completed.toSorted((a, b) => a - b),
        );
      }),
    );

    it.effect("creates and removes a worktree and its new local branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.deleteLocalBranch({
          cwd,
          refName: "feature/worktree",
          force: true,
        });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
        assert.notInclude(yield* driver.listLocalBranchNames(cwd), "feature/worktree");
      }),
    );

    it.effect("leaves no new branch behind when its start point cannot be read", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const resolving = yield* Deferred.make<void>();
        // The read that follows `git branch` stalls, as on an overloaded machine.
        const stallingSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args.join(" ") === `rev-parse --symbolic-full-name ${initialBranch}`
            ) {
              yield* Deferred.succeed(resolving, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stallingSpawner),
          Effect.provide(layerServerConfig),
        );

        const creating = yield* driver
          .createWorktree({
            cwd,
            path: pathService.join(yield* makeTmpDir("git-worktrees-"), "stalled"),
            refName: initialBranch,
            newRefName: "feature/stalled",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(resolving);
        yield* TestClock.adjust("31 seconds");
        const failed = yield* Fiber.join(creating);

        assert.deepStrictEqual(
          { failed: failed.detail, branches: yield* driver.listLocalBranchNames(cwd) },
          { failed: "Git command timed out.", branches: [initialBranch] },
        );
      }),
    );

    it.effect("leaves no new branch behind when git cannot check the worktree out", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitattributes", "README.md filter=lfs\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "track README.md with a filter"]);
        // As a repository using LFS when git-lfs is missing or cannot reach its server.
        yield* git(cwd, ["config", "filter.lfs.clean", "cat"]);
        yield* git(cwd, ["config", "filter.lfs.smudge", "false"]);
        yield* git(cwd, ["config", "filter.lfs.required", "true"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "unfiltered");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const create = driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/unfiltered",
        });

        const failed = yield* create.pipe(Effect.flip);
        const branchesAfterFailure = yield* driver.listLocalBranchNames(cwd);
        // The checkout works again; the same branch name must still be free.
        yield* git(cwd, ["config", "filter.lfs.smudge", "cat"]);
        const retried = yield* create.pipe(Effect.result);

        assert.equal(failed.operation, "GitVcsDriver.createWorktree");
        assert.deepStrictEqual(
          {
            branchesAfterFailure,
            retried: Result.isSuccess(retried) ? retried.success.worktree : retried.failure.detail,
          },
          {
            branchesAfterFailure: [initialBranch],
            retried: { path: worktreePath, refName: "feature/unfiltered" },
          },
        );
      }),
    );

    it.effect.each([false, true])(
      "cleans up links left by successful worktree removal, preserving ordinary files: %s",
      (keepFile) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const outside = yield* makeTmpDir("git-worktree-link-target-");
          yield* writeTextFile(outside, "keep.txt", "external target\n");
          const worktreePath = pathService.join(cwd, "leftover");
          const nested = pathService.join(worktreePath, "node_modules");
          yield* fileSystem.makeDirectory(nested, { recursive: true });
          yield* fileSystem.makeDirectory(pathService.join(worktreePath, "empty"));
          NodeFS.symlinkSync(outside, pathService.join(worktreePath, "linked"), "junction");
          NodeFS.symlinkSync(outside, pathService.join(nested, "pkg"), "junction");
          if (keepFile) {
            yield* writeTextFile(worktreePath, "notes/draft.txt", "new work\n");
          }

          // Git removes symlinks on Unix; simulate its successful Windows removal
          // leaving junctions behind so the cleanup is exercised on every platform.
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            ChildProcess.isStandardCommand(command) &&
            command.args.join(" ").includes("worktree remove")
              ? Effect.succeed(makeSuccessfulHandle(""))
              : delegate.spawn(command),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );

          yield* driver.removeWorktree({ cwd, path: worktreePath });

          assert.equal(
            yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
            "external target\n",
          );
          if (keepFile) {
            assert.deepEqual(yield* fileSystem.readDirectory(worktreePath), ["notes"]);
            assert.equal(
              yield* fileSystem.readFileString(pathService.join(worktreePath, "notes/draft.txt")),
              "new work\n",
            );
          } else {
            assert.equal(yield* fileSystem.exists(worktreePath), false);
          }
        }),
    );

    it.effect("keeps a worktree whose untracked files status is configured to hide", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "hidden");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/hidden",
        });
        yield* git(cwd, ["config", "status.showUntrackedFiles", "no"]);
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");
        assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

        assert.isTrue(Result.isFailure(result));
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(worktreePath, "notes.txt")),
          "draft\n",
        );
      }),
    );

    it.effect("leaves a folder alone that only shares the worktree's short name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "short");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/short",
        });
        // Unrelated to the worktree, but resolving "short" against cwd lands here.
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const unrelated = pathService.join(cwd, "short");
        NodeFS.mkdirSync(unrelated);
        NodeFS.symlinkSync(outside, pathService.join(unrelated, "linked"), "junction");

        yield* Effect.result(driver.removeWorktree({ cwd, path: "short" }));

        assert.isTrue(NodeFS.lstatSync(pathService.join(unrelated, "linked")).isSymbolicLink());
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

    it.effect("allows worktree removal to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const removalStarted = yield* Deferred.make<void>();
        const delayedRemovalSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args.join(" ").includes("worktree remove")
            ) {
              yield* Deferred.succeed(removalStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedRemovalSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "slow-removal");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/slow-removal",
        });

        const removal = yield* driver
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(removalStarted);
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(removal);

        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("removes the same worktree path twice without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "shared");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/shared",
        });

        // Two threads can record the same worktree path; the second delete
        // must be a no-op instead of exit 128.
        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.removeWorktree({ cwd, path: worktreePath });
      }),
    );

    it.effect("force-removes a worktree without deleting what its junctions point to", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        yield* writeTextFile(outside, "keep.txt", "keep\n");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        // Junctions on Windows, the way pnpm links packages; symlinks elsewhere.
        NodeFS.mkdirSync(pathService.join(worktreePath, "node_modules"));
        NodeFS.symlinkSync(
          outside,
          pathService.join(worktreePath, "node_modules", "dep"),
          "junction",
        );
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "shared"), "junction");

        yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });
        const commonDir = pathService.join(cwd, ".git");
        yield* emptyWorktreeTrash(commonDir);

        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), []);
        assert.deepEqual(NodeFS.readdirSync(pathService.join(commonDir, "caveman-trash")), ["pending"]);
        assert.deepEqual(NodeFS.readdirSync(pathService.join(commonDir, "caveman-trash", "pending")), []);
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
          "keep\n",
        );
      }),
    );

    it.effect("takes a worktree out of its path at once and deletes its files after", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "heavy");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/heavy" });
        yield* writeTextFile(worktreePath, "node_modules/dep/index.js", "module.exports = 1;\n");

        yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });

        // Gone from its path and from git at once; its files wait in the trash.
        assert.equal(NodeFS.existsSync(worktreePath), false);
        assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "heavy");
        const trash = pathService.join(cwd, ".git", "caveman-trash");
        yield* emptyWorktreeTrash(pathService.join(cwd, ".git"));
        assert.deepEqual(NodeFS.readdirSync(trash), ["pending"]);
        assert.deepEqual(NodeFS.readdirSync(pathService.join(trash, "pending")), []);
      }),
    );

    it.effect("puts a worktree back from the trash when git keeps it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "kept");
        const real = yield* GitVcsDriver.GitVcsDriver;
        yield* real.createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/kept" });
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");
        // A git that answers its metadata removal without making it.
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.join(" ").includes("worktree remove")
            ? Effect.succeed(makeSuccessfulHandle(""))
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        const outside = yield* makeTmpDir("git-worktree-link-target-");
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "linked"), "junction");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath, force: true }));
        yield* emptyWorktreeTrash(pathService.join(cwd, ".git"));

        // A failure, so nothing goes on as if it were gone, and nothing in it is cleaned up.
        assert.isTrue(Result.isFailure(result));
        assert.equal(NodeFS.readFileSync(pathService.join(worktreePath, "notes.txt"), "utf8"), "draft\n");
        assert.isTrue(NodeFS.lstatSync(pathService.join(worktreePath, "linked")).isSymbolicLink());
        assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), "kept");
      }),
    );

    it.effect("finishes a removal a stopped runtime left pending, so its branch can be checked out again", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktrees = yield* makeTmpDir("git-worktrees-");
        const worktreePath = pathService.join(worktrees, "crashed");
        // Plain git, so the driver first meets this repository after the stop.
        yield* git(cwd, ["worktree", "add", "-b", "feature/crashed", worktreePath]);
        // Stopped between the rename and git dropping the metadata.
        const pending = pathService.join(cwd, ".git", "caveman-trash", "pending");
        NodeFS.mkdirSync(pending, { recursive: true });
        NodeFS.renameSync(worktreePath, pathService.join(pending, "crashed-0000"));
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const restored = pathService.join(worktrees, "restored");
        yield* driver.createWorktree({ cwd, path: restored, refName: "feature/crashed" });
        yield* emptyWorktreeTrash(pathService.join(cwd, ".git"));

        assert.equal(NodeFS.existsSync(pathService.join(restored, ".git")), true);
        const listed = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.include(listed, "restored");
        assert.notInclude(listed, `worktree ${NodeFS.realpathSync(worktrees)}${pathService.sep}crashed\n`);
        assert.deepEqual(NodeFS.readdirSync(pending), []);
        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(pending)), ["pending"]);
      }),
    );

    it.effect("never sweeps a worktree git has not let go, so it can still go back", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "racing");
        const real = yield* GitVcsDriver.GitVcsDriver;
        yield* real.createWorktree({ cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/racing" });
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");
        // Its metadata removal waits while another removal's sweep runs, then git keeps it.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.join(" ").includes("worktree remove")
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(makeSuccessfulHandle("")),
              )
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        const removal = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath, force: true })).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(started);
        assert.equal(NodeFS.existsSync(worktreePath), false);
        yield* emptyWorktreeTrash(pathService.join(cwd, ".git"));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(removal);

        assert.equal(NodeFS.readFileSync(pathService.join(worktreePath, "notes.txt"), "utf8"), "draft\n");
        assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), "racing");
      }),
    );

    it.effect("keeps the junctions of a worktree that git refuses to remove", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        const link = pathService.join(worktreePath, "node_modules");
        NodeFS.symlinkSync(outside, link, "junction");
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

        assert.isTrue(Result.isFailure(result));
        assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), ["linked"]);
      }),
    );

    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        // Delete the directory behind git's back so the registration goes stale.
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("ensureRemote reuses a partial clone remote and avoids its name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "https://github.com/acme/example-app.git"]);
        yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
        yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const reused = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "git@github.com:acme/example-app.git",
        });
        assert.equal(reused, "origin");
        const added = yield* driver.ensureRemote({
          cwd,
          preferredName: "origin",
          url: "https://github.com/another-owner/t3code.git",
        });
        assert.equal(added, "origin-1");
      }),
    );

    it.effect("ensureRemote returns the remote a parallel call added for the same URL", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* git(cwd, ["init"]);
        // Hold the first add until both calls have listed remotes, so both decide to add.
        let listings = 0;
        const bothListed = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
            if (args[0] === "remote" && args[1] === "-v") {
              listings += 1;
              if (listings === 2) yield* Deferred.succeed(bothListed, undefined);
            }
            if (args[0] === "remote" && args[1] === "add") yield* Deferred.await(bothListed);
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const input = { cwd, preferredName: "fork", url: "https://github.com/fork/t3code.git" };

        const names = yield* Effect.all([driver.ensureRemote(input), driver.ensureRemote(input)], {
          concurrency: "unbounded",
        });

        assert.deepEqual(names, ["fork", "fork"]);
      }),
    );

    it.effect("retries a config write while another process holds the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = path.join(cwd, ".git", "config.lock");
        yield* fileSystem.writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args[1] === "t3.test",
          lockPath,
        );

        // The retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.writeConfigValue({ cwd, key: "t3.test", value: "written" }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(yield* git(cwd, ["config", "t3.test"]), "written");
      }),
    );

    it.effect("tracks a remote start point once another process releases the config lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = path.join(cwd, ".git", "config.lock");
        yield* fileSystem.writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        // The upstream retry waits on the real clock; the lock is already gone by then.
        yield* TestClock.withLive(
          driver.createWorktree({
            cwd,
            path: path.join(yield* makeTmpDir("git-worktrees-"), "tracked"),
            refName: `origin/${initialBranch}`,
            newRefName: "feature/tracked",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/tracked@{upstream}"]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("fetches a remote branch into a tracking branch past another process's lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/pr-head`]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver, failures } = yield* makeDriverReleasingLock(
          (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
          lockPath,
        );

        yield* TestClock.withLive(
          driver.fetchRemoteBranch({
            cwd,
            remoteName: "origin",
            remoteBranch: "pr-head",
            localBranch: "review/pr-head",
          }),
        );

        assert.equal(yield* Ref.get(failures), 1);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "review/pr-head@{upstream}"]),
          "origin/pr-head",
        );
      }),
    );

    // regression: #12485 explain fetch failures without exposing remote output
    it.effect("explains a real fetch failure for a missing local remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const missingRemote = `${cwd}/private-missing-remote`;
        yield* git(cwd, ["remote", "add", "origin", missingRemote]);
        const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
        assert.include(error.detail, "could not access the remote repository");
        assert.equal(error.exitCode, 128);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, missingRemote);
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("fetches from a configured remote whose name looks like an option", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        // Remote names come from .git/config. Read as an option, this one runs `touch` in cwd.
        const remoteName = "--upload-pack=touch${IFS}t3-marker;false";
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, [
          "push",
          remote,
          `HEAD:refs/heads/${initialBranch}`,
          "HEAD:refs/pull/7/head",
        ]);
        yield* git(cwd, ["config", `remote.${remoteName}.url`, remote]);

        assert.equal(yield* driver.resolvePrimaryRemoteName(cwd), remoteName);
        yield* driver.fetchRemoteTrackingBranch({ cwd, remoteName, remoteBranch: initialBranch });
        yield* driver.fetchRemote({ cwd, remoteName });
        const head = yield* driver.fetchPullRequestHeadCommit({ cwd, prNumber: 7 });

        assert.isFalse(yield* fileSystem.exists((yield* Path.Path).join(cwd, "t3-marker")));
        assert.equal(head.commitSha, yield* git(cwd, ["rev-parse", "HEAD"]));
        assert.equal(
          yield* git(cwd, ["rev-parse", `refs/remotes/${remoteName}/${initialBranch}`]),
          head.commitSha,
        );
      }),
    );

    it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["remote", "add", "origin", "https://github.com/acme/example-app.git"]);

        const reusedForSsh = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "git@github.com:acme/example-app.git",
        });
        assert.equal(reusedForSsh, "origin");

        const reusedForSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com/acme/example-app",
        });
        assert.equal(reusedForSshScheme, "origin");

        const reusedForBareSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://github.com/acme/example-app",
        });
        assert.equal(reusedForBareSshScheme, "origin");

        const reusedForSshPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/acme/example-app",
        });
        assert.equal(reusedForSshPort, "origin");

        const reusedForSshWithPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/acme/example-app.git",
        });
        assert.equal(reusedForSshWithPort, "origin");

        const addedForFork = yield* driver.ensureRemote({
          cwd,
          preferredName: "octocat",
          url: "git@github.com:octocat/t3code.git",
        });
        assert.equal(addedForFork, "octocat");
        assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
      }),
    );
  });

  describe("commit context", () => {
    it.effect("can omit the patch while preserving change detection and the real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
        yield* writeTextFile(cwd, "selected.txt", "selected content\n");
        yield* writeTextFile(cwd, "other.txt", "other content\n");
        yield* git(cwd, ["add", "other.txt"]);
        const before = yield* git(cwd, ["diff", "--cached"]);
        const summaryOnly = yield* driver.prepareCommitContext(cwd, ["selected.txt"], {
          includePatch: false,
        });
        assert.include(summaryOnly?.stagedSummary ?? "", "selected.txt");
        assert.notInclude(summaryOnly?.stagedSummary ?? "", "other.txt");
        assert.equal(summaryOnly?.stagedPatch, "");
        const full = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
        assert.equal(full?.stagedSummary, summaryOnly?.stagedSummary);
        assert.include(full?.stagedPatch ?? "", "+selected content");
        assert.equal(yield* git(cwd, ["diff", "--cached"]), before);
      }),
    );

    it.effect("prepares selected files without staging and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");

        const commit = yield* driver.commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } });
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );

    it.effect("stops a selected-file commit when another process holds the index lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "index.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver } = yield* makeDriverReleasingLock(
          (args) => args.includes("reset"),
          lockPath,
        );

        const error = yield* driver
          .commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } })
          .pipe(Effect.flip);

        assert.equal(error.operation, "GitVcsDriver.commit.reset");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
      }),
    );

    it.effect.each([
      { location: "root", ref: "refs/heads/MERGE_HEAD" },
      { location: "nested", ref: "refs/heads/MERGE_HEAD" },
      { location: "worktree", ref: "refs/heads/MERGE_HEAD" },
      { location: "root", ref: "refs/tags/MERGE_HEAD" },
      { location: "nested", ref: "refs/tags/MERGE_HEAD" },
      { location: "worktree", ref: "refs/tags/MERGE_HEAD" },
    ])(
      "commits selected files with a MERGE_HEAD ref and no merge ($location, $ref)",
      ({ location, ref }) =>
        Effect.gen(function* () {
          let cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["update-ref", ref, originalHead]);
          if (location === "worktree") {
            const linked = path.join(yield* makeTmpDir(), "linked");
            yield* git(cwd, ["worktree", "add", "-b", "linked", linked]);
            cwd = linked;
          }
          const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
          yield* fs.makeDirectory(commitCwd, { recursive: true });
          yield* writeTextFile(cwd, "selected.txt", "selected\n");
          yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
          const mergePath = yield* git(commitCwd, ["rev-parse", "--git-path", "MERGE_HEAD"]);
          assert.isFalse(yield* fs.exists(path.resolve(commitCwd, mergePath)));

          yield* driver.commit(commitCwd, "Selected without merge", "", {
            stage: { filePaths: ["selected.txt"] },
          });

          assert.equal(yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]), originalHead);
          assert.equal(
            yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
            "selected.txt",
          );
          assert.equal(yield* git(cwd, ["rev-parse", ref]), originalHead);
          assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? unrelated.txt");
        }),
    );

    it.effect.each([
      { location: "root", conflict: false },
      { location: "nested", conflict: false },
      { location: "worktree", conflict: false },
      { location: "root", conflict: true },
      { location: "nested", conflict: true },
      { location: "worktree", conflict: true },
    ])(
      "rejects selected-file merge commits without mutation ($location, conflict: $conflict)",
      ({ location, conflict }) =>
        Effect.gen(function* () {
          let cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* git(cwd, ["checkout", "-b", "feature"]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          if (conflict) yield* writeTextFile(cwd, "README.md", "feature version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Feature"]);
          const featureHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["checkout", initialBranch]);
          yield* writeTextFile(cwd, "main.txt", "main\n");
          if (conflict) yield* writeTextFile(cwd, "README.md", "main version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Main"]);
          const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          if (location === "worktree") {
            const worktree = path.join(yield* makeTmpDir(), "linked");
            yield* git(cwd, ["worktree", "add", "-b", "linked", worktree]);
            cwd = worktree;
          }
          const merge = yield* driver.execute({
            operation: "test.merge",
            cwd,
            args: ["merge", "--no-commit", "--no-ff", "feature"],
            allowNonZeroExit: true,
          });
          assert.equal(merge.exitCode, conflict ? 1 : 0);
          yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
          const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
          yield* fs.makeDirectory(commitCwd, { recursive: true });
          const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
          const names = ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"];
          const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));
          const files = ["README.md", "feature.txt", "main.txt", "unrelated.txt"];
          const contents = files.map((name) => NodeFS.readFileSync(path.join(cwd, name)));
          const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

          const result = yield* driver
            .commit(commitCwd, "Partial merge", "", { stage: { filePaths: ["feature.txt"] } })
            .pipe(Effect.result);
          if (Result.isSuccess(result)) {
            const parents = yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]);
            assert.fail(
              `Selected merge commit succeeded with parents ${parents}; MERGE_HEAD exists: ${NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD"))}`,
            );
          } else {
            assert.include(result.failure.detail, "Cannot commit selected files during a merge");
            assert.include(result.failure.detail, "Commit all files");
          }
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
            before,
          );
          assert.deepEqual(
            files.map((name) => NodeFS.readFileSync(path.join(cwd, name))),
            contents,
          );
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

          if (conflict) yield* writeTextFile(cwd, "README.md", "resolved version\n");
          yield* driver.commit(commitCwd, "Finish merge", "", { stage: {} });
          assert.equal(
            yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
            `${mainHead} ${featureHead}`,
          );
          assert.isFalse(NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD")));
          assert.equal(yield* git(cwd, ["show", "HEAD:feature.txt"]), "feature");
          assert.equal(yield* git(cwd, ["show", "HEAD:unrelated.txt"]), "unrelated");
          if (conflict)
            assert.equal(yield* git(cwd, ["show", "HEAD:README.md"]), "resolved version");
        }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        const context = yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.include(context?.stagedSummary ?? "", "selected[1].txt");
        assert.notInclude(context?.stagedSummary ?? "", "selected1.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
        yield* driver.commit(cwd, "Add literal path", "", {
          stage: { filePaths: ["selected[1].txt"] },
        });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
          "selected[1].txt",
        );

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );

    it.effect.each([false, true])(
      "preserves partial staging and split-index files (split: %s)",
      (split) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          if (split) yield* git(cwd, ["config", "core.splitIndex", "true"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\n");
          yield* git(cwd, ["add", "README.md"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\nunstaged\n");
          yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
          yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
          yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
          const before = NodeFS.readFileSync(`${cwd}/.git/index`);
          const shared = NodeFS.readdirSync(`${cwd}/.git`).filter((name) =>
            name.startsWith("sharedindex."),
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;
          for (const paths of [undefined, ["README.md"]]) {
            const context = yield* driver.prepareCommitContext(cwd, paths);
            assert.include(context?.stagedPatch ?? "", "unstaged");
            assert.notInclude(context?.stagedSummary ?? "", "ignored.txt");
            assert.deepEqual(NodeFS.readFileSync(`${cwd}/.git/index`), before);
            assert.deepEqual(
              NodeFS.readdirSync(`${cwd}/.git`).filter((name) => name.startsWith("sharedindex.")),
              shared,
            );
          }
        }),
    );

    it.effect("prepares an unborn repository without creating a real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.txt", "initial\n");
        for (const paths of [undefined, ["initial.txt"]]) {
          const context = yield* driver.prepareCommitContext(cwd, paths);
          assert.include(context?.stagedSummary ?? "", "initial.txt");
          assert.isFalse(NodeFS.existsSync(`${cwd}/.git/index`));
        }
        yield* driver.commit(cwd, "Initial", "", { stage: { filePaths: ["initial.txt"] } });
        assert.equal(yield* git(cwd, ["show", "HEAD:initial.txt"]), "initial");
      }),
    );

    it.effect("preserves merge metadata while preparing selected and all files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["merge", "--no-commit", "--no-ff", "feature"]);
        yield* writeTextFile(cwd, "README.md", "# test\nmerge edit\n");
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`));
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const paths of [undefined, ["README.md"]]) {
          yield* driver.prepareCommitContext(cwd, paths);
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`)),
            before,
          );
        }
      }),
    );
  });

  describe("remote operations", () => {
    it.effect.each(["offline", "auth", "timeout"] as const)(
      "does not retry a scoped fetch after %s",
      (failure) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const started = yield* Deferred.make<void>();
          const attempts: Array<ReadonlyArray<string>> = [];
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command))
                return yield* Effect.die("unexpected command");
              if (command.args[0] !== "fetch") return yield* delegate.spawn(command);
              attempts.push(command.args.map(String));
              yield* Deferred.succeed(started, undefined);
              return ChildProcessSpawner.makeHandle({
                ...makeNonRepositoryHandle(),
                exitCode:
                  failure === "timeout"
                    ? Effect.never
                    : Effect.succeed(ChildProcessSpawner.ExitCode(128)),
                stderr: Stream.encodeText(
                  Stream.make(
                    failure === "auth"
                      ? "fatal: Authentication failed"
                      : "fatal: Could not resolve host",
                  ),
                ),
              });
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const fetching = yield* driver
            .fetchRemote({ cwd, remoteName: "origin", refName: "main" })
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          if (failure === "timeout") {
            yield* TestClock.adjust("31 seconds");
            yield* TestClock.adjust("31 seconds");
          }
          const result = yield* Fiber.join(fetching);
          assert.isTrue(Result.isFailure(result));
          assert.equal(attempts.length, 1);
          if (Result.isFailure(result)) {
            assert.equal(
              result.failure.detail,
              failure === "timeout"
                ? "Git command timed out."
                : failure === "offline"
                  ? "Git could not reach the remote. Check the server's network connection and remote host, then retry."
                  : "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.",
            );
          }
        }),
    );

    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        yield* git(peer, ["push", "origin", "HEAD:refs/heads/unrelated"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({
          cwd,
          remoteName: "origin",
          refName: `origin/${initialBranch}`,
        });
        assert.isFalse(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );

        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: initialBranch,
          }),
          true,
        );
        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: "local-only",
          }),
          false,
        );

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
          remoteHead,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);

        yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "local-only" });
        assert.isTrue(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );
      }),
    );

    it.effect("fetches the selected worktree base for Changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir("git-fork-");
        const source = yield* makeTmpDir("git-source-");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "stable"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(source, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", source]);
        yield* git(cwd, ["push", "origin", "stable"]);
        yield* git(cwd, ["push", "-u", "upstream", "stable:release"]);
        const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* writeTextFile(cwd, "fork.txt", "fork-only work\n");
        yield* git(cwd, ["add", "fork.txt"]);
        yield* git(cwd, ["commit", "-m", "fork work"]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);

        // Advance the source without updating this checkout's tracking refs.
        yield* writeTextFile(cwd, "upstream.txt", "upstream-only work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "source advance"]);
        const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(source, ["--git-dir=.", "fetch", cwd, "stable:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" });
        assert.deepEqual(fetched, {
          commitSha: remoteHead,
          remoteRefName: "upstream/release",
        });
        yield* git(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);
        assert.deepEqual(
          yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "upstream/release" }),
          { commitSha: remoteHead, remoteRefName: "upstream/release" },
        );
        yield* git(cwd, ["branch", "--unset-upstream", "stable"]);
        assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" }), {
          commitSha: localHead,
          remoteRefName: "origin/stable",
        });
        assert.equal(yield* git(cwd, ["rev-parse", "stable"]), localHead);

        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: fetched!.commitSha,
          newRefName: "feature/from-upstream",
          baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
        });
        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        yield* writeTextFile(worktreePath, "feature.txt", "feature work\n");
        yield* git(worktreePath, ["add", "feature.txt"]);
        yield* git(worktreePath, ["commit", "-m", "feature work"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(changes.diff, "+feature work");
        assert.notInclude(changes.diff, "upstream-only work");
        const status = yield* driver.statusDetailsLocal(worktreePath, {
          includeBranchChanges: true,
        });
        assert.strictEqual(status.aheadCount, 1);
        assert.strictEqual(status.branchChanges?.insertions, 1);
        assert.strictEqual(status.branchChanges?.deletions, 0);
        // gh pr create consumes this setting verbatim as the hosted target branch.
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.feature/from-upstream.gh-merge-base"),
          "release",
        );
        assert.equal(changes.baseRef, "upstream/release");
      }),
    );

    it.effect("does not use a deleted remote worktree base's stale tracking commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", `${initialBranch}:release`]);
        yield* git(remote, ["--git-dir=.", "update-ref", "-d", "refs/heads/release"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.equal(
          yield* git(cwd, ["rev-parse", "refs/remotes/origin/release"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
        yield* git(cwd, ["remote", "remove", "origin"]);
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
      }),
    );

    it.effect("fetches a worktree base without downloading tags", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "tagged release"]);
        const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["tag", "v1"]);
        yield* git(cwd, ["push", "origin", initialBranch, "v1"]);
        yield* git(cwd, ["tag", "-d", "v1"]);
        yield* git(cwd, ["reset", "--hard", localHead]);
        yield* git(cwd, ["update-ref", "-d", `refs/remotes/origin/${initialBranch}`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }), {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.equal(yield* git(cwd, ["tag", "--list", "v1"]), "");
      }),
    );

    it.effect("fetches the remote a caller already resolved for the worktree base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "unpublished" }));
        assert.deepEqual(
          yield* driver.fetchWorktreeBaseCommit({
            cwd,
            refName: "unpublished",
            remote: { remoteName: "origin", branchName: initialBranch },
          }),
          { commitSha: head, remoteRefName: `origin/${initialBranch}` },
        );
      }),
    );

    it.effect("fails instead of falling back when the worktree base remote is unreachable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", `${cwd}/missing.git`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver
          .fetchWorktreeBaseCommit({ cwd, refName: initialBranch })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect("pushes new commits after the branch's remote copy was deleted and pruned", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-b", "feature/merged"]);
        yield* writeTextFile(cwd, "feature.txt", "one\n");
        yield* git(cwd, ["add", "-A"]);
        yield* git(cwd, ["commit", "-m", "First feature commit"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), { status: "pushed" });
        // The host deletes a pull request's head once it merges; a pruning fetch then drops the
        // tracking ref while the branch's remote and merge config stay.
        yield* git(remote, ["--git-dir=.", "branch", "-D", "feature/merged"]);
        yield* git(cwd, ["fetch", "--prune", "origin"]);
        yield* writeTextFile(cwd, "feature.txt", "two\n");
        yield* git(cwd, ["commit", "-am", "Second feature commit"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/merged",
          upstreamBranch: "origin/feature/merged",
        });
        assert.equal(
          yield* git(remote, [
            "--git-dir=.",
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads/feature/merged",
          ]),
          head,
        );
      }),
    );

    it.effect("pushes to the fork a branch tracks after its remote copy there was deleted and pruned", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-origin-remote-");
        const fork = yield* makeTmpDir("git-fork-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "contrib", fork]);
        // A contributor's pull request branch checked out in place: `feature` tracks `contrib/feature`.
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "one\n");
        yield* git(cwd, ["add", "-A"]);
        yield* git(cwd, ["commit", "-m", "First feature commit"]);
        yield* git(cwd, ["push", "-u", "contrib", "feature"]);
        yield* git(fork, ["--git-dir=.", "branch", "-D", "feature"]);
        yield* git(cwd, ["fetch", "--prune", "contrib"]);
        yield* writeTextFile(cwd, "feature.txt", "two\n");
        yield* git(cwd, ["commit", "-am", "Second feature commit"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        // Where plain `git push` sends it: the branch's own remote, not the primary one.
        assert.deepInclude(pushed, { status: "pushed", upstreamBranch: "contrib/feature" });
        assert.deepStrictEqual(
          {
            fork: yield* git(fork, ["--git-dir=.", "for-each-ref", "--format=%(objectname)", "refs/heads/feature"]),
            origin: yield* git(origin, ["--git-dir=.", "for-each-ref", "refs/heads/feature"]),
            remote: yield* driver.readConfigValue(cwd, "branch.feature.remote"),
          },
          { fork: head, origin: "", remote: "contrib" },
        );
      }),
    );

    it.effect("keeps a gone base upstream as the comparison base when publishing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/dev`]);
        yield* git(cwd, ["fetch", "origin"]);
        // Cut from dev and tracking it, as `git checkout -b` from a remote branch leaves it.
        yield* git(cwd, ["checkout", "-b", "feature/on-dev", "--track", "origin/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* git(cwd, ["commit", "-m", "Feature commit"]);
        yield* git(remote, ["--git-dir=.", "branch", "-D", "dev"]);
        yield* git(cwd, ["fetch", "--prune", "origin"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, { status: "pushed", upstreamBranch: "origin/feature/on-dev" });
        assert.deepStrictEqual(
          {
            base: yield* driver.readConfigValue(cwd, "branch.feature/on-dev.gh-merge-base"),
            baseRef: yield* driver.readConfigValue(
              cwd,
              GitVcsDriver.mergeBaseRefConfigKey("feature/on-dev"),
            ),
          },
          { base: "dev", baseRef: "refs/remotes/origin/dev" },
        );
      }),
    );

    it.effect("rebases a pushed branch's pulls when branch.autoSetupRebase asks for it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["config", "branch.autoSetupRebase", "always"]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/rebase"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), { setUpstream: true });
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/rebase.rebase"), "true");
      }),
    );

    it.effect("reports a push whose upstream could not be recorded", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/locked"]);
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // Recording the upstream retries on the real clock before giving up.
        const pushed = yield* TestClock.withLive(driver.pushCurrentBranch(cwd, null));

        assert.deepInclude(pushed, { status: "pushed", setUpstream: false });
        assert.include(
          yield* git(cwd, ["ls-remote", "origin", "refs/heads/feature/locked"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/locked.remote"), null);
      }),
    );

    it.effect.each(["feature/push", "origin/feature/push"])(
      "publishes %s when the configured diff base already contains HEAD",
      (branch) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const originRemote = yield* makeTmpDir("git-origin-remote-");
          const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(originRemote, ["init", "--bare"]);
          yield* git(upstreamRemote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", originRemote]);
          yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
          yield* git(cwd, ["push", "origin", "main", "main:refs/heads/feature/push"]);
          yield* git(cwd, ["checkout", "--no-track", "-b", branch]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add feature", "");
          yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/main"]);
          yield* git(cwd, ["config", `branch.${branch}.gh-merge-base`, "upstream/main"]);

          const status = yield* driver.statusDetails(cwd);
          assert.equal(status.hasUpstream, false);
          assert.equal(status.aheadCount, 0);
          assert.equal(status.behindCount, 0);
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          assert.notEqual(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          const pushed = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(pushed, {
            status: "pushed",
            branch,
            upstreamBranch: "origin/feature/push",
            setUpstream: true,
          });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          yield* git(cwd, ["branch", "--unset-upstream"]);
          const skipped = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skipped, { status: "skipped_up_to_date", branch });

          yield* writeTextFile(cwd, "remote.txt", "remote update\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Advance publish branch", "");
          yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature/push"]);
          const publishedHead = yield* git(originRemote, [
            "--git-dir=.",
            "rev-parse",
            "refs/heads/feature/push",
          ]);
          yield* git(cwd, ["reset", "--hard", head]);
          const skippedBehindRemote = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skippedBehindRemote, { status: "skipped_up_to_date", branch });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            publishedHead,
          );
        }),
    );

    it.effect("allows pushes to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const delayedPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedPushSpawner),
          Effect.provide(layerServerConfig),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* driver
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 seconds");
        const pushed = yield* Fiber.join(pushing);

        assert.deepInclude(pushed, {
          status: "pushed",
          setUpstream: true,
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstream = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "upstream", "dev"]);
        const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "upstream/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"]),
          "Add feature",
        );
        assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "dev"]), devSha);
        assert.equal(yield* git(upstream, ["--git-dir=.", "rev-parse", "dev"]), upstreamDevSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.equal(changes.baseRef, "upstream/dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        // `checkout --track my-org/upstream/effect-atom` cannot name the local
        // branch `effect-atom`, so git keeps `upstream/effect-atom`. Its
        // upstream is still its published head.
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});

describe("Windows long path configuration", () => {
  const readGitConfig = Effect.fn("readGitConfig")(function* (
    platform: NodeJS.Platform,
    key: string,
  ) {
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    );
    return yield* Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir("git-longpath-test-");
      const result = yield* driver.execute({
        operation: "GitVcsDriverTest.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        // Replaces the suite's own core.longpaths=true so it cannot mask a
        // missing injection. Entry 2 sits past the count and must stay unread.
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "inherited-name",
          GIT_CONFIG_KEY_1: "core.longpaths",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "user.name",
          GIT_CONFIG_VALUE_2: "outside-count",
        },
      });
      return result.stdout.trim();
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("enables long paths for every Git command on Windows", () =>
    Effect.gen(function* () {
      assert.equal(yield* readGitConfig("win32", "core.longpaths"), "true");
      assert.equal(yield* readGitConfig("win32", "user.name"), "inherited-name");
    }),
  );

  it.effect("leaves Git config untouched on other platforms", () =>
    Effect.gen(function* () {
      assert.equal(yield* readGitConfig("linux", "core.longpaths"), "false");
      assert.equal(yield* readGitConfig("linux", "user.name"), "inherited-name");
    }),
  );

  it("extends an inherited count spelled in a different case", () => {
    // Two spellings collapse to one on spawn (the uppercase one wins), so the
    // count must be bumped under the spelling that is already there.
    assert.deepStrictEqual(windowsLongPathConfigEnv("win32", { git_config_count: "2" }), {
      git_config_count: "3",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
  });

  it("extends the per-command count when inherited and per-command casings differ", () => {
    assert.deepStrictEqual(
      windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: "0", git_config_count: "1" }),
      {
        GIT_CONFIG_COUNT: "2",
        git_config_count: "2",
        GIT_CONFIG_KEY_1: "core.longpaths",
        GIT_CONFIG_VALUE_1: "true",
      },
    );
  });

  it("reads only the exact count name outside Windows", () => {
    assert.deepStrictEqual(
      gitConfigEnv({ git_config_count: "3" }, "safe.bareRepository", "explicit", "linux"),
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.bareRepository",
        GIT_CONFIG_VALUE_0: "explicit",
      },
    );
  });

  it("appends after inherited entries, parsing the count as Git does", () => {
    for (const [count, next] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-0", 0],
      ["2", 2],
      [" 2", 2],
      ["+2", 2],
      ["02", 2],
    ] as const) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", count === undefined ? {} : { GIT_CONFIG_COUNT: count }),
        {
          GIT_CONFIG_COUNT: String(next + 1),
          [`GIT_CONFIG_KEY_${next}`]: "core.longpaths",
          [`GIT_CONFIG_VALUE_${next}`]: "true",
        },
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });

  it("leaves a count Git would reject for Git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      assert.deepStrictEqual(
        windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: count }),
        {},
        `GIT_CONFIG_COUNT=${JSON.stringify(count)}`,
      );
    }
  });
});
