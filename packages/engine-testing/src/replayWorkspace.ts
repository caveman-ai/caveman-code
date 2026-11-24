// ), packages/provider-testing/src/replayWorkspace.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off - the workspace removal uses Node's own EBUSY retries and timers.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class ReplayFixtureGitCommandError extends Schema.TaggedError<ReplayFixtureGitCommandError>()(
  "ReplayFixtureGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ReplayFixtureGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new ReplayFixtureGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
    }
  });
}

/** Workspace-relative path to file contents, committed with the initial README. */
export type ReplayWorkspaceFiles = Readonly<Record<string, string>>;

const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
  files: ReplayWorkspaceFiles = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({
    prefix: `t3-orchestrator-v2-${fixtureName}-`,
  });
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.name", "Caveman Code Test"]);
  yield* runGit(cwd, ["config", "user.email", "t3code-test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
  yield* runGit(cwd, ["add", "README.md", ...Object.keys(files)]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  // On Windows a process the replay just stopped (an agent run in this folder) keeps it busy until its handles
  // close, a moment after its tree is ended: Node retries EBUSY/EPERM for about 5 s, so one that never exits still
  // fails here. Its own timers, not Effect's: a replay's finalizers can run under the test clock, which never moves.
  yield* Effect.tryPromise(() => NodeFSP.rm(cwd, { recursive: true, maxRetries: 10, retryDelay: 100 }));
});

export const checkpointWorkspace = (fixtureName: string, files?: ReplayWorkspaceFiles) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName, files), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(
  fixtureName: string,
  files?: ReplayWorkspaceFiles,
): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName, files).pipe(Effect.provide(NodeServices.layer)),
  );
}
