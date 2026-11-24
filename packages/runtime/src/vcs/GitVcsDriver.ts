// ), apps/server/src/vcs/GitVcsDriver.ts @ ab3a3cd1; perf from e2cc34f1e4, 67e05acf81, 55ba1baa55, ce87dc79fb, 87ae8d5815.
import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { isMissingExecutable } from "@caveman-app/source-control-core/server/discovery";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import {
  GitCommandError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@caveman-app/protocol";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import { toolsRun, toolsSocket } from "../cloudLink/tools.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly forceKillAfterMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /**
   * With `appendTruncationMarker`, keep invoking the line callbacks after the
   * buffered copy is full. For long-running commands whose output is only
   * consumed through `progress`.
   */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
  /** Writes .git/config, which every worktree shares and Git locks without waiting. */
  readonly writesSharedConfig?: boolean;
  /**
   * Rewrites tracked files: a checkout, fast-forward or reset. Git stopped partway leaves the
   * tree between two commits and refuses every retry, so once started it runs to its end: no
   * timeout applies, and an interrupted caller waits for it.
   */
  readonly movesWorkingTree?: boolean;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  branchChanges?: VcsStatusResult["branchChanges"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitLocalStatusOptions {
  /** Skip revision walks and return zero divergence counts for local-only consumers. */
  readonly includeDivergence?: boolean;
  /** Also read the diff panel's Changes totals. Failures leave them out. */
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

/**
 * Progress callbacks for `createWorktree`. Git prints `Updating files: 78% (2104/2700)`
 * to stderr during checkout, and `Submodule path 'x': checked out` during
 * submodule init. The tracker uses these to drive the worktree setup card.
 */
export interface CreateWorktreeProgress {
  /**
   * Fires once `git worktree add` has created and registered the directory,
   * before the (possibly long) submodule step. Git refuses an existing path,
   * so a path reported here belongs to this call and is safe to remove on
   * cancel.
   */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  /** Fires when `.gitmodules` exists but the resolved submodule mode is `"none"`. */
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "t3.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /**
   * The project-over-environment `worktreeSubmodules` setting. Null (or
   * omitted, for callers without settings access) defers to the checkout's
   * own t3.json.
   */
  readonly submodules?: WorktreeSubmodules | null;
  /** The `worktreesDirectory` setting, used when the input has no explicit path. */
  readonly worktreesDirectory?: string;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
  /** Stage the current working tree immediately before committing. */
  readonly stage?: { readonly filePaths?: readonly string[] };
}

export interface GitDeleteLocalBranchInput {
  readonly cwd: string;
  readonly refName: string;
  readonly force?: boolean;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  /** Fail on a name collision instead of appending a numeric suffix. */
  exactName?: boolean;
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestHeadCommitInput {
  cwd: string;
  prNumber: number;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /**
   * Commit the checkout is allowed to be hard-reset away from: the upstream commit read before
   * the fetch. HEAD sitting there means the checkout holds no work of its own.
   */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitCreateBranchInput {
  readonly cwd: string;
  readonly branch: string;
  readonly startPoint: string;
}

export interface GitWriteConfigValueInput {
  readonly cwd: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Branch config key for the exact ref a branch was cut from (`refs/heads/...` or
 * `refs/remotes/<remote>/...`). gh's `gh-merge-base` holds only a provider branch
 * name, which loses the remote when several remotes share a branch name.
 */
export const mergeBaseRefConfigKey = (branch: string) => `branch.${branch}.caveman-merge-base-ref`;

export interface GitFetchWorktreeBaseCommitInput {
  cwd: string;
  refName: string;
}

export interface GitWorktreeBaseRemote {
  remoteName: string;
  branchName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (
      cwd: string,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
      options?: { readonly includePatch?: boolean },
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    /** Returns the branch name of a local or remote-tracking ref, excluding tags and commits. */
    readonly resolveBranchName: (
      cwd: string,
      refName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Fetches `refs/pull/<n>/head` without writing a branch, for heads that exist nowhere else. */
    readonly fetchPullRequestHeadCommit: (
      input: GitFetchPullRequestHeadCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    /** Moves the branch checked out in `cwd` onto `targetCommit`, from inside that worktree. */
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly resolveWorktreeBaseRemote: (
      input: GitFetchWorktreeBaseCommitInput,
    ) => Effect.Effect<GitWorktreeBaseRemote | null, GitCommandError>;
    /**
     * Fetches the configured upstream, explicit remote ref, or origin; null uses the local base.
     * A caller that already ran `resolveWorktreeBaseRemote` passes its result as `remote`.
     */
    readonly fetchWorktreeBaseCommit: (
      input: GitFetchWorktreeBaseCommitInput & { readonly remote?: GitWorktreeBaseRemote },
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult | null, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Tracks the start point like `git branch` does. */
    readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;
    readonly writeConfigValue: (
      input: GitWriteConfigValueInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Drops worktree admin entries whose directory is already gone (`git worktree prune`). */
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    /**
     * Absolute paths of every live worktree of the repository at `cwd`, the
     * main checkout included. Worktrees whose directory is gone are left out.
     */
    readonly listWorktreePaths: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FLAGGED_INDEX_ENTRIES_MAX_BYTES = 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
/** Who checkpoint commits are by. */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "Caveman Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Caveman Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // A partial clone's fetch line ends in its filter: "origin\thttps://… (fetch) [blob:none]".
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]*\])?$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = Effect.fn("GitVcsDriver.gitCommand")(
  (
    process: VcsProcess.VcsProcess["Service"],
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
      readonly appendTruncationMarker?: boolean;
    },
  ) =>
    process.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
      ...(options?.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
    }),
);

/** How many of the paths in a checkpoint restore's way its refusal names; it counts the rest. */
const IN_THE_WAY_NAMED_AT_MOST = 20;

const namedInTheWay = (paths: ReadonlyArray<string>) => {
  const sorted = [...new Set(paths)].sort();
  const more = sorted.length - IN_THE_WAY_NAMED_AT_MOST;
  return `${sorted.slice(0, IN_THE_WAY_NAMED_AT_MOST).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

const inTheWayDetail = (survey: RestoreSurvey) => {
  const { inTheWay: ignored, writtenOver, repositories, changedRepositories } = survey;
  const what =
    repositories.length === 0
      ? "ignored files"
      : ignored.length === 0
        ? "git repositories"
        : "ignored files and git repositories";
  const clauses = [
    ...(ignored.length + repositories.length > 0
      ? [`delete ${what} this checkpoint never saved: ${namedInTheWay([...ignored, ...repositories])}`]
      : []),
    ...(writtenOver.length > 0
      ? [`write over ignored files changed since this checkpoint saved them: ${namedInTheWay(writtenOver)}`]
      : []),
    ...(changedRepositories.length > 0
      ? [`change files inside git repositories this checkpoint never saved: ${namedInTheWay(changedRepositories)}`]
      : []),
  ];
  return `Restoring would ${clauses.join(". It would also ")}. Move them elsewhere, then restore again.`;
};

/** Whether restoring would delete or change anything that neither the checkpoint nor a snapshot keeps. */
const restoreInTheWay = ({ inTheWay, writtenOver, repositories, changedRepositories }: RestoreSurvey) =>
  inTheWay.length + writtenOver.length + repositories.length + changedRepositories.length > 0;

/** A required filter that could not run stops git on one of these lines; hash-object reaches no remote of its own. */
const GIT_FILTER_FAILED_PATTERN =
  /^fatal: (?:.+: (?:clean|smudge) filter .+ failed|the remote end hung up unexpectedly)$/m;

/**
 * The most bytes of patterns and pathspecs one git clean of a checkpoint restore is given: a Windows command line ends
 * near 32K characters. Past it, the clean runs per directory.
 */
const CLEAN_ARGUMENTS_MAX_BYTES = 16 * 1024;
/** An argument's bytes on a command line, with room for quoting and the `-e` before a pattern. */
const cleanArgumentBytes = (argument: string) => Buffer.byteLength(argument) + 8;
/** A gitignore pattern matching exactly this path from the repository's top (a directory with a trailing slash). */
const exactIgnorePattern = (fromTop: string) => `/${fromTop.replace(/[\\*?[]/g, "\\$&")}`;

/** Whether git restore removes what is there to write an entry of this kind: a directory for a blob, else a file. */
const conflictsWith = (kind: string, there: "directory" | "other" | "absent") =>
  kind === "blob" ? there === "directory" : there === "other";

/** The directory of `directories` that `key` is or is under, if any. */
const within = (key: string, directories: ReadonlyMap<string, string>) => {
  if (directories.has("")) return "";
  for (let slash = key.indexOf("/"); ; slash = key.indexOf("/", slash + 1)) {
    const above = slash === -1 ? key : key.slice(0, slash);
    if (directories.has(above)) return above;
    if (slash === -1) return undefined;
  }
};

/** A file or symlink the checkpoint holds at a path under the workspace: its mode and blob. */
interface HeldFile {
  readonly entry: string;
  readonly mode: string;
  readonly oid: string;
}

/** What git ignores in a workspace before a checkpoint is restored there. */
interface RestoreSurvey {
  /** The ignored files and directories restoring would delete: see `makeIgnoredInTheWay`. */
  readonly inTheWay: ReadonlyArray<string>;
  /** The ignored files restoring would write the checkpoint's older copy over: see `makeIgnoredInTheWay`. */
  readonly writtenOver: ReadonlyArray<string>;
  /**
   * Git repositories under the workspace (relative to it, with a trailing slash) in directories restoring would remove
   * to write a file or symlink there. The checkpoint and the snapshot taken before a restore keep a repository as a
   * commit id at most: its history, other branches and uncommitted work would be gone.
   */
  readonly repositories: ReadonlyArray<string>;
  /**
   * Git repositories under the workspace, as `repositories`, holding a path where restoring would write the
   * checkpoint's file or symlink over another, or remove a directory that holds something: the person's version there
   * is in neither the checkpoint nor the snapshot.
   */
  readonly changedRepositories: ReadonlyArray<string>;
  /**
   * Everything under the workspace git ignores, relative to it, a directory ignored as a whole with a trailing slash.
   * What the workspace's ancestors' rules ignore is left out: a restore never changes those rules.
   */
  readonly ignored: ReadonlyArray<string>;
  /** The workspace relative to the repository's top, with a trailing slash ("" at the top). */
  readonly prefix: string;
  readonly ignoreCase: boolean;
}

const makeRestoreSurvey = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const operation = VcsProcess.CHECKPOINT_RESTORE_OPERATION;
  // As the restore itself: paths past Windows' MAX_PATH, whatever the person's git configuration says.
  const longPaths = hostPlatform === "win32" ? ["-c", "core.longpaths=true"] : [];

  // Effect's stat follows a symlink; readLink first sees the link itself, as git's lstat does.
  const kindAt = (at: string) =>
    fileSystem.readLink(at).pipe(
      Effect.as("other" as const),
      Effect.catch(() =>
        fileSystem.stat(at).pipe(
          Effect.map((info) => (info.type === "Directory" ? ("directory" as const) : ("other" as const))),
          Effect.orElseSucceed(() => "absent" as const),
        ),
      ),
    );
  // Removing a directory of only empty directories loses nothing. One that cannot be read counts as holding something.
  const holdsAnything = (directory: string): Effect.Effect<boolean> =>
    fileSystem.readDirectory(directory).pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* (names) {
          for (const name of names) {
            const at = path.join(directory, name);
            if ((yield* kindAt(at)) !== "directory" || (yield* holdsAnything(at))) return true;
          }
          return false;
        }),
      ),
      Effect.orElseSucceed(() => true),
    );
  /**
   * Of these files, each at a path the checkpoint holds as a file or symlink, those git restore would change by writing
   * the checkpoint's copy over them: another kind, other contents, or, where git keeps execute bits, another one.
   */
  const changedByRestore = Effect.fn("GitVcsDriver.restoreSurvey.changedByRestore")(function* (
    cwd: string,
    files: ReadonlyArray<HeldFile>,
    git: { readonly fileMode: boolean; readonly symlinks: boolean },
  ) {
    const changed: Array<string> = [];
    const contents: Array<{ readonly entry: string; readonly oid: string }> = [];
    for (const file of files) {
      const at = path.join(cwd, file.entry);
      const target = yield* fileSystem.readLink(at).pipe(Effect.option);
      if (Option.isSome(target)) {
        const linked =
          file.mode === "120000" &&
          (yield* gitCommand(vcsProcess, operation, cwd, ["hash-object", "--stdin"], { stdin: target.value }))
            .stdout.trim() === file.oid;
        if (!linked) changed.push(file.entry);
        continue;
      }
      const info = yield* fileSystem.stat(at).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type !== "File") {
        changed.push(file.entry);
        continue;
      }
      // Where git writes symlinks as plain files holding their targets (core.symlinks off), it reads them back so.
      if (file.mode === "120000") {
        if (git.symlinks) changed.push(file.entry);
        else contents.push(file);
        continue;
      }
      // As git records it: the owner's execute bit alone, and only where git keeps execute bits.
      const mode =
        git.fileMode && hostPlatform !== "win32" ? (info.value.mode & 0o100 ? "100755" : "100644") : file.mode;
      if (mode !== file.mode) changed.push(file.entry);
      else contents.push(file);
    }
    // Hashed as git add would (its filters run), so an unchanged file matches the blob the capture made of it.
    for (let start = 0; start < contents.length; ) {
      let end = start + 1;
      let bytes = cleanArgumentBytes(contents[start]!.entry);
      while (end < contents.length && bytes + cleanArgumentBytes(contents[end]!.entry) <= CLEAN_ARGUMENTS_MAX_BYTES)
        bytes += cleanArgumentBytes(contents[end++]!.entry);
      const batch = contents.slice(start, end);
      const hashed = yield* gitCommand(
        vcsProcess,
        operation,
        cwd,
        [...longPaths, "hash-object", "--", ...batch.map((file) => file.entry)],
        { allowNonZeroExit: true, maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES, outputMode: "error" },
      );
      if (hashed.exitCode !== 0) {
        if (GIT_FILTER_FAILED_PATTERN.test(hashed.stderr))
          return yield* new VcsUnsupportedOperationError({
            operation,
            kind: "git",
            detail:
              "Git could not run a filter this repository needs, such as Git LFS, to compare the files restoring " +
              "would write over with this checkpoint's. Install it where Caveman Code runs git, then restore again.",
          });
        return yield* new VcsProcessExitError({
          operation,
          command: "git hash-object",
          cwd,
          exitCode: hashed.exitCode,
          detail: hashed.stderr.trim() || "git hash-object failed",
        });
      }
      const oids = hashed.stdout.split("\n");
      batch.forEach((file, index) => {
        if (oids[index] !== file.oid) changed.push(file.entry);
      });
      start = end;
    }
    return changed;
  });
  /**
   * The paths under the workspace where the checkpoint holds a file or symlink and the index or the worktree has
   * something else (a directory, a gitlink, nothing): git restore writes each, removing what is there.
   */
  const heldOverOther = Effect.fn("GitVcsDriver.restoreSurvey.heldOverOther")(function* (
    cwd: string,
    commitOid: string,
  ) {
    const found: Array<HeldFile> = [];
    let partial = Buffer.alloc(0);
    let change: string | undefined;
    yield* vcsProcess.run({
      operation,
      command: "git",
      cwd,
      // Against the worktree, not --cached: an index path the worktree has as a directory reads as deleted or, a
      // repository with commits there, a type change.
      args: [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        ...longPaths,
        "diff-index",
        "-z",
        "--no-renames",
        "--relative",
        commitOid,
        "--",
        ".",
      ],
      maxOutputBytes: 4_096,
      outputMode: "truncate",
      onStdoutChunk: (chunk) => {
        const bytes = Buffer.concat([partial, chunk]);
        let start = 0;
        for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
          const field = bytes.toString("utf8", start, end);
          start = end + 1;
          if (change === undefined) {
            change = field;
            continue;
          }
          // ":<mode> <mode> <oid> <oid> <status>", the checkpoint's side first.
          const [mode, , oid, , kind] = change.slice(1).split(" ") as [string, string, string, string, string];
          change = undefined;
          if ((kind === "D" || kind === "T") && /^1(?:00644|00755|20000)$/.test(mode))
            found.push({ entry: field, mode, oid });
        }
        partial = bytes.subarray(start);
      },
    });
    return found;
  });

  return Effect.fn("GitVcsDriver.restoreSurvey")(function* (cwd: string, commitOid: string) {
    const [prefix, ignoreCase, fileMode, symlinks, status, written] = yield* Effect.all(
      [
        gitCommand(vcsProcess, operation, cwd, ["rev-parse", "--show-prefix"]),
        gitCommand(vcsProcess, operation, cwd, ["config", "--bool", "core.ignorecase"], {
          allowNonZeroExit: true,
        }),
        gitCommand(vcsProcess, operation, cwd, ["config", "--bool", "core.filemode"], {
          allowNonZeroExit: true,
        }),
        gitCommand(vcsProcess, operation, cwd, ["config", "--bool", "core.symlinks"], {
          allowNonZeroExit: true,
        }),
        gitCommand(
          vcsProcess,
          operation,
          cwd,
          [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...longPaths,
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
            // Not ls-files --ignored --directory: it skips ignored files inside untracked directories.
            "--ignored=matching",
            "--",
            ".",
          ],
          { maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES, outputMode: "error" },
        ),
        heldOverOther(cwd, commitOid),
      ],
      { concurrency: 6 },
    );
    const top = prefix.stdout.replace(/\n$/, "");
    // Where the filesystem ignores case (git found so at init), the checkpoint's spelling of a path reaches the
    // workspace's.
    const caseInsensitive = ignoreCase.stdout.trim() === "true";
    const keyOf = caseInsensitive
      ? (at: string) => at.normalize("NFC").toLowerCase()
      : (at: string) => at;
    const git = { fileMode: fileMode.stdout.trim() !== "false", symlinks: symlinks.stdout.trim() !== "false" };
    const survey = (
      inTheWay: ReadonlyArray<string>,
      writtenOver: ReadonlyArray<string>,
      ignored: ReadonlyArray<string>,
      found: Pick<RestoreSurvey, "repositories" | "changedRepositories">,
    ): RestoreSurvey => ({
      inTheWay,
      writtenOver,
      ignored,
      ...found,
      prefix: top,
      ignoreCase: caseInsensitive,
    });

    // Each ignored file and each directory above an ignored entry: whether it is a directory, and the entries that
    // removing it would take.
    const along = new Map<string, { readonly directory: boolean; readonly entries: Array<string> }>();
    // Directories whose untracked contents are all ignored: status names one without its contents ("" is the
    // workspace).
    const ignoredDirectories = new Map<string, string>();
    // Index paths the worktree no longer has as files (or unmerged ones, whatever it has). Status leaves out an ignored
    // directory sitting at a path the index holds.
    const gone = new Map<string, string>();
    const ignored: Array<string> = [];
    for (const record of splitNullSeparatedGitStdoutPaths(status)) {
      if (!record.startsWith(top, 3)) {
        // A folder above the workspace ignored as a whole (nothing under it in the index): status names only it.
        if (record.startsWith("!! ") && record.endsWith("/") && top.startsWith(record.slice(3)))
          ignoredDirectories.set("", "");
        continue;
      }
      const entry = record.slice(3 + top.length);
      if (!record.startsWith("!! ")) {
        if (/^(?:.D|U.|.U|AA) /.test(record)) gone.set(keyOf(entry), entry);
        continue;
      }
      if (entry !== "") ignored.push(entry);
      const name = entry.replace(/\/$/, "");
      if (name !== entry || name === "") ignoredDirectories.set(keyOf(name), entry);
      const parts = name.split("/");
      for (let depth = 1; name !== "" && depth <= parts.length; depth++) {
        const directory = depth < parts.length;
        if (!directory && name !== entry) break;
        const key = keyOf(parts.slice(0, depth).join("/"));
        const at = along.get(key) ?? { directory, entries: [] };
        at.entries.push(entry);
        along.set(key, at);
      }
    }

    /**
     * The git repositories under the workspace that git restore would delete (at or below a directory where it writes a
     * file or symlink) or change (holding a path it writes over). What git ignores as a whole is left to the ignored
     * entries in the way. A symlink is no directory: git restore removes the link and leaves what it points at alone.
     */
    const repositoriesInTheWay = Effect.fnUntraced(function* () {
      const repositoriesIn = (directory: string): Effect.Effect<Array<string>> =>
        Effect.gen(function* () {
          const at = path.join(cwd, directory);
          if ((yield* kindAt(at)) !== "directory") return [];
          if ((yield* kindAt(path.join(at, ".git"))) !== "absent") return [`${directory}/`];
          const found: Array<string> = [];
          for (const name of yield* fileSystem.readDirectory(at).pipe(Effect.orElseSucceed(() => []))) {
            const child = `${directory}/${name}`;
            if (!ignoredDirectories.has(keyOf(child))) found.push(...(yield* repositoriesIn(child)));
          }
          return found;
        });
      // Each folder above a written path: whether it is a repository, a plain directory, or neither (git restore
      // replaces a file or symlink there, and nothing below it is reached).
      const above = new Map<string, "repository" | "directory" | "neither">();
      const deleted = new Set<string>();
      const changed = new Set<string>();
      const inside: Array<HeldFile & { readonly repository: string }> = [];
      const look = Effect.fnUntraced(function* (file: HeldFile) {
        if (within(keyOf(file.entry), ignoredDirectories) !== undefined) return;
        const parts = file.entry.split("/");
        let repository: string | undefined;
        for (let depth = 1; depth < parts.length && repository === undefined; depth++) {
          const directory = parts.slice(0, depth).join("/");
          let state = above.get(keyOf(directory));
          if (state === undefined) {
            const at = path.join(cwd, directory);
            state =
              (yield* kindAt(at)) !== "directory"
                ? "neither"
                : (yield* kindAt(path.join(at, ".git"))) === "absent"
                  ? "directory"
                  : "repository";
            above.set(keyOf(directory), state);
          }
          if (state === "neither") return;
          if (state === "repository") repository = `${directory}/`;
        }
        const there = yield* kindAt(path.join(cwd, file.entry));
        if (repository === undefined) {
          if (there === "directory") for (const found of yield* repositoriesIn(file.entry)) deleted.add(found);
        } else if (there === "directory") {
          if (yield* holdsAnything(path.join(cwd, file.entry))) changed.add(repository);
        } else if (there === "other") inside.push({ ...file, repository });
      });
      // A checkpoint of a project never committed holds every file here.
      yield* Effect.forEach(written, look, { concurrency: 16, discard: true });
      const repositoryOf = new Map(inside.map((file) => [file.entry, file.repository]));
      for (const entry of yield* changedByRestore(cwd, inside, git)) changed.add(repositoryOf.get(entry)!);
      return {
        repositories: [...deleted].sort(),
        changedRepositories: [...changed].filter((repository) => !deleted.has(repository)).sort(),
      };
    });

    if (along.size === 0 && ignoredDirectories.size === 0 && gone.size === 0)
      return survey([], [], [], yield* repositoriesInTheWay());
    // What the checkpoint holds there, parents before children, read as git lists it.
    const held: Array<{
      readonly at: string;
      readonly mode: string;
      readonly kind: string;
      readonly oid: string;
      readonly key: string;
      readonly within?: string;
    }> = [];
    let partial = Buffer.alloc(0);
    yield* vcsProcess.run({
      operation,
      command: "git",
      cwd,
      args: ["ls-tree", "-r", "-t", "-z", commitOid],
      maxOutputBytes: 4_096,
      outputMode: "truncate",
      onStdoutChunk: (chunk) => {
        const bytes = Buffer.concat([partial, chunk]);
        let start = 0;
        for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
          const record = bytes.toString("utf8", start, end);
          start = end + 1;
          const tab = record.indexOf("\t");
          const at = record.slice(tab + 1);
          // Listed from a subdirectory, git names that directory's own tree "./".
          if (at === "./") continue;
          const [mode, kind, oid] = record.slice(0, tab).split(" ") as [string, string, string];
          const key = keyOf(at);
          const base = along.has(key) ? undefined : (within(key, ignoredDirectories) ?? within(key, gone));
          if (along.has(key) || base !== undefined)
            held.push({ at, mode, kind, oid, key, ...(base === undefined ? {} : { within: base }) });
        }
        partial = bytes.subarray(start);
      },
    });

    // Every one, not only those the checkpoint holds paths in: the restore's clean must also keep what they hold.
    const goneDirectories: Array<string> = [];
    for (const [key, entry] of gone) {
      if (ignoredDirectories.has(key)) continue;
      if ((yield* kindAt(path.join(cwd, entry))) === "directory") goneDirectories.push(key);
    }
    // check-ignore reads each path as a pathspec, a leading ":" as magic; after "./" it is a plain name. It answers
    // with the path as asked.
    for (const chunk of chunkPathsForGitCheckIgnore(goneDirectories.map((key) => `./${gone.get(key)!}/`))) {
      const ignoredHere = yield* gitCommand(
        vcsProcess,
        operation,
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          outputMode: "error",
        },
      );
      if (ignoredHere.exitCode !== 0 && ignoredHere.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git check-ignore",
          cwd,
          exitCode: ignoredHere.exitCode,
          detail: ignoredHere.stderr.trim() || "git check-ignore failed",
        });
      }
      for (const asked of splitNullSeparatedGitStdoutPaths(ignoredHere)) {
        const directory = asked.slice("./".length);
        ignoredDirectories.set(keyOf(directory.slice(0, -1)), directory);
        ignored.push(directory);
      }
    }

    const inTheWay = new Set<string>();
    // Ignored files where the checkpoint holds a file or symlink: git restore writes its copy over each.
    const overwritten: Array<HeldFile> = [];
    let skipBelow: string | undefined;
    for (const record of held) {
      if (skipBelow !== undefined && record.at.startsWith(`${skipBelow}/`)) continue;
      skipBelow = undefined;
      if (record.within === undefined) {
        const at = along.get(record.key)!;
        if (!conflictsWith(record.kind, at.directory ? "directory" : "other")) {
          if (record.kind === "blob" && !at.directory)
            overwritten.push({ entry: at.entries[0]!, mode: record.mode, oid: record.oid });
          continue;
        }
        for (const entry of at.entries)
          if (!entry.endsWith("/") || (yield* holdsAnything(path.join(cwd, entry)))) inTheWay.add(entry);
        continue;
      }
      // Inside a directory whose contents are all ignored, git's own lstat of the checkpoint's path decides.
      const base = ignoredDirectories.get(record.within);
      if (base === undefined) continue;
      const there = yield* kindAt(path.join(cwd, record.at));
      if (there === "directory" && record.kind === "tree") continue;
      skipBelow = record.at;
      const depth = record.within === "" ? 0 : record.within.split("/").length;
      const name = [base.replace(/\/$/, ""), ...record.at.split("/").slice(depth)]
        .filter((part) => part !== "")
        .join("/");
      if (!conflictsWith(record.kind, there)) {
        if (record.kind === "blob" && there === "other")
          overwritten.push({ entry: name, mode: record.mode, oid: record.oid });
        continue;
      }
      if (there === "directory" && !(yield* holdsAnything(path.join(cwd, record.at)))) continue;
      inTheWay.add(there === "directory" ? `${name}/` : name);
    }
    const writtenOver = yield* changedByRestore(cwd, overwritten, git);
    return survey([...inTheWay].sort(), [...writtenOver].sort(), ignored, yield* repositoriesInTheWay());
  });
});

/**
 * Lists, sorted, the ignored files and directories under a workspace (relative to it, a directory with a trailing
 * slash) that restoring a checkpoint there would delete (`inTheWay`) or write over (`writtenOver`). git restore removes
 * a directory's whole subtree to write a file or symlink in its place, and a file or symlink to make a directory; it
 * writes the checkpoint's copy over a file git ignores only since the capture, which counts where the person changed it
 * since. The snapshot taken before a restore is a git tree that leaves ignored files out, so nothing could bring them
 * back.
 */
export const makeIgnoredInTheWay = Effect.map(
  makeRestoreSurvey,
  (survey) => (cwd: string, commitOid: string) =>
    survey(cwd, commitOid).pipe(
      Effect.map(({ inTheWay, writtenOver }) => ({ inTheWay, writtenOver })),
    ),
);

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const restoreSurvey = yield* makeRestoreSurvey;
  const random = yield* SecureRandom.SecureRandom;
  const hostPlatform = yield* HostProcess.Platform;
  // On a Cloud computer git runs in the tools container and .git is the agent's (cloudLink/tools.ts).
  const tools = toolsSocket();
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(
      Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
      Effect.catchIf(isMissingExecutable, () => Effect.succeed(false)),
    );

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    // One spawn answers all three; outside a work tree it exits non-zero or prints "false".
    const result = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository",
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      },
    ).pipe(Effect.catchIf(isMissingExecutable, () => Effect.succeed(null)));
    if (result === null || result.exitCode !== 0) return null;
    const lines = result.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (lines[0]?.trim() !== "true") return null;
    // A newline inside a path breaks the line framing; ask for each path on its own.
    if (lines.length !== 3) {
      const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const gitCommonDir = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository", cwd, [
        "rev-parse",
        "--git-common-dir",
      ]).pipe(Effect.orElseSucceed(() => null));
      return {
        kind: "git" as const,
        rootPath: root.stdout.trim(),
        metadataPath: gitCommonDir?.stdout.trim() || null,
        freshness: yield* nowFreshness(),
      };
    }

    return {
      kind: "git" as const,
      rootPath: lines[1]!.trim(),
      metadataPath: lines[2]!.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  // Git reports relative paths from the physical cwd, which can differ from a symlink.
  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      if (path.isAbsolute(gitCommonDir)) return gitCommonDir;
      const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
      return path.resolve(physicalCwd, gitCommonDir);
    });

  // --verify prints HEAD after the paths; --quiet leaves only paths for an unborn HEAD.
  const resolveCaptureRepository = Effect.fn("GitVcsDriver.resolveCaptureRepository")(function* (
    cwd: string,
  ) {
    const result = yield* execute({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      args: [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "index",
        "--verify",
        "--quiet",
        "HEAD",
      ],
      allowNonZeroExit: true,
    });
    const headExists = result.exitCode === 0;
    const headChecked = headExists || result.exitCode === 1;
    const lines = result.stdout.split("\n");
    const [gitCommonDir = "", indexPath = ""] = lines;
    if (headChecked && lines.length === (headExists ? 4 : 3) && lines.at(-1) === "") {
      return {
        gitCommonDir: gitCommonDir.trim(),
        indexPath: indexPath.trim(),
        headExists,
      };
    }
    // Git before 2.31 echoes --path-format, and a path containing a newline spans lines.
    // Separate commands read the paths as before and report a failure the same way.
    return {
      gitCommonDir: yield* resolveGitCommonDir(cwd),
      indexPath: undefined,
      headExists: headChecked ? headExists : yield* hasHeadCommit(cwd),
    };
  });

  // Git renames loose objects and refs into place without fsync by default, so
  // an unclean restart can leave 0-byte files under refs/t3/** that break every
  // later fetch and push. Checkpoint writes flush before they are published;
  // macOS defaults to writeout-only, which does not reach the disk either.
  // Set fsync first: Git 2.36 ignores unknown batch without resetting the method.
  // Git documents batch/fsync equivalence on macOS HFS+/APFS and Windows NTFS/ReFS;
  // keep per-object fsync on other platforms. Batch still fully flushes refs.
  // On macOS, VcsProcess retries unsupported full flushes with plain fsync.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
    ...(hostPlatform === "darwin" || hostPlatform === "win32"
      ? ["-c", "core.fsyncMethod=batch"]
      : []),
  ] as const;

  /** Commits a checkpoint's tree (HEAD its parent, when there is one) and points its ref at it. */
  const publishCheckpoint = (cwd: string, checkpointRef: string, tree: string, headExists: boolean) =>
    Effect.gen(function* () {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      const message = `t3 checkpoint ref=${checkpointRef}`;
      // HEAD is the parent so listAuthoredPaths can see how HEAD moved between checkpoints.
      const commitTreeResult = yield* execute({
        operation,
        cwd,
        args: [...durableWrite, "commit-tree", tree, ...(headExists ? ["-p", "HEAD"] : []), "-m", message],
        env: { ...process.env, ...CHECKPOINT_IDENTITY },
      });
      const commitOid = commitTreeResult.stdout.trim();
      if (commitOid.length === 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git commit-tree",
          cwd,
          exitCode: 0,
          detail: "git commit-tree returned an empty commit oid.",
        });
      }
      yield* execute({ operation, cwd, args: [...durableWrite, "update-ref", checkpointRef, commitOid] });
    });

  /**
   * Whether the worktree under `cwd` is exactly HEAD: nothing modified, staged, untracked or ignored there (whatever
   * the person's status config hides), and no index entry flagged assume-unchanged or skip-worktree, which would
   * hide a change from that status. Read without taking the index lock.
   */
  const cleanAtHead = (cwd: string) =>
    Effect.all(
      [
        execute({
          operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
          cwd,
          args: [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignored=traditional",
            "--ignore-submodules=none",
            "--",
            ".",
          ],
          maxOutputBytes: 1,
          outputMode: "truncate",
        }).pipe(Effect.map((status) => status.stdout.length === 0 && !status.stdoutTruncated)),
        Effect.gen(function* () {
          let flagged = false;
          let recordStart = true;
          yield* vcsProcess.run({
            operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
            command: "git",
            cwd,
            args: ["--no-optional-locks", "ls-files", "-v", "-z", "--", "."],
            maxOutputBytes: 4_096,
            outputMode: "truncate",
            // Every entry of a plain index is tagged H.
            onStdoutChunk: (chunk) => {
              for (const byte of chunk) {
                if (recordStart && byte !== 72) flagged = true;
                recordStart = byte === 0;
              }
            },
          });
          return !flagged;
        }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([clean, unflagged]) => clean && unflagged));

  // Checkpoints must handle existing paths beyond Windows MAX_PATH, even when
  // core.longpaths is disabled in the user's Git configuration.
  const longPaths = hostPlatform === "win32" ? ["-c", "core.longpaths=true"] : [];

  /** Of the paths git ignored before a restore, those the ignore files the restore brought back no longer ignore. */
  const noLongerIgnored = Effect.fn("GitVcsDriver.checkpoints.noLongerIgnored")(function* (
    cwd: string,
    ignored: ReadonlyArray<string>,
  ) {
    const still = new Set<string>();
    // check-ignore reads a leading ":" as pathspec magic. A path left unasked stays on the list, which only costs the
    // clean a pattern: git ignores it either way.
    for (const chunk of chunkPathsForGitCheckIgnore(ignored.filter((entry) => !entry.startsWith(":")))) {
      const result = yield* gitCommand(
        vcsProcess,
        VcsProcess.CHECKPOINT_RESTORE_OPERATION,
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          outputMode: "error",
        },
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (result === undefined || (result.exitCode !== 0 && result.exitCode !== 1)) continue;
      for (const entry of splitNullSeparatedGitStdoutPaths(result)) still.add(entry);
    }
    return ignored.filter((entry) => !still.has(entry));
  });

  interface CleanRun {
    readonly pathspecs: ReadonlyArray<string>;
    readonly patterns: ReadonlyArray<string>;
  }
  interface Kept {
    /** Relative to the workspace, a directory with a trailing slash. */
    readonly entry: string;
    readonly pattern: string;
  }
  /**
   * The git cleans that keep `kept` in a workspace (or a directory in it), none given more than
   * CLEAN_ARGUMENTS_MAX_BYTES: one clean of it all when the patterns fit; else its entries in batches, each with the
   * patterns for what it holds, going into an entry whose own patterns do not fit.
   */
  const planClean = (
    cwd: string,
    kept: ReadonlyArray<Kept>,
    nameKey: (name: string) => string,
    directory = "",
  ): Effect.Effect<Array<CleanRun>, VcsProcessExitError> =>
    Effect.gen(function* () {
      const patternBytes = (some: ReadonlyArray<Kept>) =>
        some.reduce((sum, one) => sum + cleanArgumentBytes(one.pattern), 0);
      if (patternBytes(kept) <= CLEAN_ARGUMENTS_MAX_BYTES) {
        const pathspec = directory === "" ? "." : `:(literal)${directory}`;
        return [{ pathspecs: [pathspec], patterns: kept.map((one) => one.pattern) }];
      }
      const depth = directory === "" ? 0 : directory.split("/").length;
      const byName = new Map<string, Array<Kept>>();
      for (const one of kept) {
        const key = nameKey(one.entry.split("/")[depth]!);
        const under = byName.get(key) ?? [];
        under.push(one);
        byName.set(key, under);
      }
      const names = yield* fileSystem.readDirectory(path.join(cwd, directory)).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed([])
            : Effect.fail(
                new VcsProcessExitError({
                  operation: VcsProcess.CHECKPOINT_RESTORE_OPERATION,
                  command: "git clean",
                  cwd,
                  exitCode: 0,
                  detail: `Could not read the checkpoint workspace: ${cause.message}`,
                }),
              ),
        ),
      );
      const runs: Array<CleanRun> = [];
      let batch = { pathspecs: [] as Array<string>, patterns: [] as Array<string> };
      let batchBytes = 0;
      for (const name of names.toSorted()) {
        if (name === ".git") continue;
        const at = directory === "" ? name : `${directory}/${name}`;
        const inside = byName.get(nameKey(name)) ?? [];
        if (inside.some((one) => one.entry === at || one.entry === `${at}/`)) continue;
        const pathspec = `:(literal)${at}`;
        const cost = cleanArgumentBytes(pathspec) + patternBytes(inside);
        if (cost > CLEAN_ARGUMENTS_MAX_BYTES) {
          runs.push(...(yield* planClean(cwd, inside, nameKey, at)));
          continue;
        }
        if (batchBytes + cost > CLEAN_ARGUMENTS_MAX_BYTES) {
          runs.push(batch);
          batch = { pathspecs: [], patterns: [] };
          batchBytes = 0;
        }
        batch.pathspecs.push(pathspec);
        batch.patterns.push(...inside.map((one) => one.pattern));
        batchBytes += cost;
      }
      if (batch.pathspecs.length > 0) runs.push(batch);
      return runs;
    });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      if (input.fresh === true) {
        // A freshly made worktree that is exactly HEAD (and not sparse, whose index the snapshot treats apart):
        // its checkpoint is HEAD's own tree.
        const [headExists, sparse, clean] = yield* Effect.all(
          [
            hasHeadCommit(input.cwd),
            execute({ operation, cwd: input.cwd, args: ["config", "--bool", "core.sparseCheckout"], allowNonZeroExit: true }),
            cleanAtHead(input.cwd),
          ],
          { concurrency: 3 },
        );
        if (headExists && sparse.stdout.trim() !== "true" && clean) {
          return yield* publishCheckpoint(input.cwd, input.checkpointRef, "HEAD^{tree}", true);
        }
      }
      // core.splitIndex governs every index Git writes, so an unguarded write to the
      // scratch index can expire the sharedindex.* the real .git/index still uses.
      const indexConfig = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "sparse.expectFilesOutsideOfPatterns=false",
        "-c",
        "core.splitIndex=false",
        "-c",
        "splitIndex.sharedIndexExpire=never",
      ];
      const { gitCommonDir, indexPath, headExists } = yield* resolveCaptureRepository(input.cwd);
      const indexId = yield* random.uuidV4();
      const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${indexId}`);
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        ...CHECKPOINT_IDENTITY,
      };

      // Forced process termination can leave Git's private index lock behind.
      const cleanupTempIndex =
        tools !== undefined
          ? Effect.promise(() => toolsRun(tools, "/", ["rm", "-f", "--", tempIndexPath, `${tempIndexPath}.lock`])).pipe(Effect.asVoid)
          : Effect.forEach(
              [tempIndexPath, `${tempIndexPath}.lock`],
              (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
              { discard: true },
            );

      yield* Effect.gen(function* () {
        const sparseConfig = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["config", "--bool", "core.sparseCheckout"],
          allowNonZeroExit: true,
        });
        let sparseCheckout = sparseConfig.stdout.trim() === "true";
        if (sparseCheckout) {
          const help = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["add", "-h"],
            allowNonZeroExit: true,
          });
          sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
        }
        if (headExists) {
          const reusedIndex = yield* Effect.gen(function* () {
            // Reuse copies .git/index and resets its times as this uid; on a Cloud computer the
            // checkpoint index starts fresh in tools instead (git rehashes the tree).
            if (tools !== undefined) return false;
            const userIndexPath =
              indexPath ??
              (yield* execute({
                operation,
                cwd: input.cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
              })).stdout.trim();
            const { mtime } = yield* fileSystem.stat(userIndexPath);
            if (Option.isNone(mtime)) return false;
            // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
            const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
            if (indexTime <= 0) return false;
            yield* fileSystem.copyFile(userIndexPath, tempIndexPath);
            // Retain stat data only where the copied index already matches HEAD.
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "read-tree", "--reset", "HEAD"],
              env: commitEnv,
            });
            // read-tree can rewrite the index, so restore its racy timestamp afterward.
            yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            // Manually flagged entries hide edits from add -A, so they are re-added below
            // with no stat cache. Every other entry keeps its stat data and is not rehashed.
            let fallback = false;
            let flaggedBytes = 0;
            let recordStart = true;
            let collect: "flagged" | "skipped" | undefined;
            let record: Uint8Array[] = [];
            const flagged: string[] = [];
            const skipped: string[] = [];
            yield* vcsProcess.run({
              operation,
              command: "git",
              cwd: input.cwd,
              args: [...indexConfig, "ls-files", "--full-name", "--sparse", "--stage", "-v", "-z"],
              env: commitEnv,
              maxOutputBytes: 4_096,
              outputMode: "truncate",
              // Only tags and flagged or skip-worktree records matter; scan NUL-delimited records.
              onStdoutChunk: (chunk) => {
                let start = 0;
                while (start < chunk.length && !fallback) {
                  const end = chunk.indexOf(0, start);
                  if (recordStart) {
                    const tag = chunk[start]!;
                    record = [];
                    // Sparse skip-worktree bits are expected; only in-cone ones are manual.
                    collect =
                      tag === 83 && sparseCheckout
                        ? "skipped"
                        : (tag >= 97 && tag <= 122) || tag === 83
                          ? "flagged"
                          : undefined;
                    // index-info cannot keep skip-worktree while dropping assume-unchanged.
                    if (tag === 115 && sparseCheckout) fallback = true;
                  }
                  if (collect !== undefined && !fallback) {
                    const piece = chunk.subarray(start, end === -1 ? undefined : end);
                    record.push(Buffer.from(piece));
                    if (
                      collect === "flagged" &&
                      (flaggedBytes += piece.length) > FLAGGED_INDEX_ENTRIES_MAX_BYTES
                    )
                      fallback = true;
                    if (end !== -1 && !fallback) {
                      const full = Buffer.concat(record);
                      record = [];
                      // Sparse directory entries stay collapsed.
                      if (collect === "flagged" || full.at(-1) !== 47) {
                        // Drop the "<tag> " prefix, leaving index-info's "<mode> <oid> <stage>\t<path>".
                        const entry = full.subarray(2);
                        if (!NodeBuffer.isUtf8(entry)) fallback = true;
                        else
                          (collect === "flagged" ? flagged : skipped).push(entry.toString("utf8"));
                      }
                    }
                  }
                  recordStart = end !== -1;
                  if (!recordStart) break;
                  start = end + 1;
                }
              },
            });
            if (fallback) return false;
            if (skipped.length > 0) {
              const paths = skipped.map((entry) => entry.slice(entry.indexOf("\t") + 1));
              const stdin = paths.join("\0") + "\0";
              // check-rules echoes a subset of its input, so the input size bounds its output.
              const rules = yield* execute({
                operation,
                cwd: input.cwd,
                args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                stdin,
                env: commitEnv,
                maxOutputBytes: Buffer.byteLength(stdin),
                outputMode: "error",
              });
              const selected = new Set(rules.stdout.split("\0"));
              skipped.forEach((entry, index) => {
                if (selected.has(paths[index]!)) flagged.push(entry);
              });
            }
            if (flagged.length > 0) {
              // Flagged gitlinks keep the fresh-index behaviour rather than a guessed one.
              if (flagged.some((entry) => entry.startsWith("160000 "))) return false;
              yield* execute({
                operation,
                cwd: input.cwd,
                // core.ignorestat would mark these assume-unchanged, hiding edits from add -A.
                args: [
                  ...indexConfig,
                  "-c",
                  "core.ignorestat=false",
                  "update-index",
                  "-z",
                  "--index-info",
                ],
                stdin: flagged.join("\0") + "\0",
                env: commitEnv,
              });
              yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            }
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (!reusedIndex) {
            if (sparseCheckout) {
              const cone = yield* execute({
                operation,
                cwd: input.cwd,
                args: ["config", "--bool", "core.sparseCheckoutCone"],
                allowNonZeroExit: true,
              });
              // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
              if (cone.stdout.trim() !== "true") {
                return yield* new VcsProcessExitError({
                  operation,
                  command: "git read-tree",
                  cwd: input.cwd,
                  exitCode: 1,
                  detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                });
              }
            }
            yield* cleanupTempIndex;
            yield* execute({
              operation,
              cwd: input.cwd,
              // A fresh sparse index represents excluded directories without marking them deleted.
              args: sparseCheckout
                ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                : [...indexConfig, "read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        const workspaceIgnored = (yield* filterIgnoredPaths(input.cwd, ["."])).length === 0;
        if (workspaceIgnored) {
          // HEAD omits staged-only paths. Seed just this workspace's additions, keeping
          // unrelated staged changes and the scratch index's sparse flags untouched.
          const additions = yield* execute({
            operation,
            cwd: input.cwd,
            args: [
              "-c",
              "core.quotePath=true",
              "diff",
              "--cached",
              "--raw",
              "--no-abbrev",
              "--no-renames",
              "--no-relative",
              "--ignore-submodules=none",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--ita-visible-in-index",
              "--diff-filter=A",
              "--",
              ".",
            ],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
          if (additions.stdout.length > 0) {
            // Git's quoted paths round-trip through index-info, including non-UTF-8 names.
            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "-c", "index.sparse=false", "update-index", "--index-info"],
              stdin: additions.stdout.replace(
                /^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A\t/gm,
                "$1 $2\t",
              ),
              env: commitEnv,
            });
          }
          const tracked = yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "ls-files", "--cached", "-z", "--", "."],
            env: commitEnv,
            maxOutputBytes: 1,
            outputMode: "truncate",
          });
          if (tracked.stdout.length === 0) {
            return yield* new VcsUnsupportedOperationError({
              operation,
              kind: "git",
              detail: "The workspace directory is ignored by its Git repository.",
            });
          }
        }

        const stageFiles = (exclusions: ReadonlyArray<string>) =>
          execute({
            operation,
            cwd: input.cwd,
            // Preserve absent skipped entries, but capture present nonignored files outside the cone.
            args: [
              ...indexConfig,
              ...durableWrite,
              ...longPaths,
              // safecrlf=true refuses LF files under CRLF conversion; capture them as Git's default does.
              "-c",
              "core.safecrlf=false",
              "add",
              ...(sparseCheckout ? ["--sparse"] : []),
              // add -A rejects ignored directories even when they contain tracked files.
              workspaceIgnored ? "-u" : "-A",
              "--",
              ".",
              ...exclusions,
            ],
            env: commitEnv,
          });
        yield* stageFiles([]).pipe(
          Effect.catchTags({
            VcsProcessExitError: (error) =>
              Effect.gen(function* () {
                // Git cannot stage an embedded repository until it has a commit. Discover these
                // only after staging fails so ordinary checkpoints do not need another file scan.
                const untracked = yield* execute({
                  operation,
                  cwd: input.cwd,
                  args: [
                    ...longPaths,
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                  ],
                  env: commitEnv,
                  maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                });
                if (untracked.stdoutTruncated) return yield* error;
                const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                  entry.endsWith("/"),
                );
                // Refuse excessive recovery work before probing any nested repositories.
                if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                // Discover each child's repository instead of inheriting the server's Git bindings.
                const nestedRepoEnv: NodeJS.ProcessEnv = {
                  ...process.env,
                  GIT_DIR: undefined,
                  GIT_WORK_TREE: undefined,
                  GIT_COMMON_DIR: undefined,
                  GIT_INDEX_FILE: undefined,
                  GIT_OBJECT_DIRECTORY: undefined,
                  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                };
                const exclusions: Array<string> = [];
                for (const entry of candidates) {
                  const nestedCwd = path.join(input.cwd, entry);
                  if (
                    (yield* fileSystem
                      .exists(path.join(nestedCwd, ".git"))
                      .pipe(Effect.mapError(() => error))) &&
                    !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                  ) {
                    exclusions.push(`:(exclude,literal)${entry}`);
                  }
                }
                if (exclusions.length === 0) return yield* error;
                return yield* stageFiles(exclusions);
              }).pipe(
                // One budget covers discovery, queued Git admission, probes, and the staging retry.
                Effect.timeoutOrElse({
                  duration: CHECKPOINT_RECOVERY_TIMEOUT,
                  orElse: () => Effect.fail(error),
                }),
              ),
          }),
        );

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: [...indexConfig, ...durableWrite, "write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        yield* publishCheckpoint(input.cwd, input.checkpointRef, treeOid, headExists);
      }).pipe(Effect.ensuring(cleanupTempIndex));
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = VcsProcess.CHECKPOINT_RESTORE_OPERATION;

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
      });
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      const restoresTracked = tracked.stdout.length > 0;
      const survey = restoresTracked ? yield* restoreSurvey(input.cwd, commitOid) : undefined;
      if (survey !== undefined && restoreInTheWay(survey)) {
        return yield* new VcsUnsupportedOperationError({ operation, kind: "git", detail: inTheWayDetail(survey) });
      }
      if (input.dryRun === true) return true;
      if (restoresTracked) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...longPaths,
            "restore",
            "--source",
            commitOid,
            "--worktree",
            "--staged",
            "--",
            ".",
          ],
        });
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      const recreateWorkspace = fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      yield* recreateWorkspace;
      // git restore can bring back older .gitignore files, and clean judges by those: it would delete what git ignored
      // until now (an .env ignored since the checkpoint), which no checkpoint or snapshot holds. It keeps that too.
      const kept =
        survey === undefined
          ? []
          : (yield* noLongerIgnored(input.cwd, survey.ignored)).map((entry) => ({
              entry,
              pattern: exactIgnorePattern(`${survey.prefix}${entry}`),
            }));
      const nameKey = survey?.ignoreCase
        ? (name: string) => name.normalize("NFC").toLowerCase()
        : (name: string) => name.normalize("NFC");
      for (const run of yield* planClean(input.cwd, kept, nameKey)) {
        const cleaned = yield* execute({
          operation,
          cwd: input.cwd,
          args: [
            ...longPaths,
            "clean",
            "-fd",
            ...run.patterns.flatMap((pattern) => ["-e", pattern]),
            "--",
            ...run.pathspecs,
          ],
          allowNonZeroExit: true,
        });
        if (cleaned.exitCode === 0) continue;
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          run.pathspecs[0] === "." &&
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace)
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
      }
      // On Windows the same clean can remove './' and exit 0.
      yield* recreateWorkspace;

      yield* execute({
        operation,
        cwd: input.cwd,
        args: [...longPaths, "reset", "--quiet", "--", "."],
      });

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          // Not --no-relative, which Git before 2.28 rejects.
          "-c",
          "diff.relative=false",
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--submodule=short",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        allowNonZeroExit: true,
        maxOutputBytes: input.maxOutputBytes ?? VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    listAuthoredPaths: Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
      const heads = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%P %ct",
          `${input.fromCheckpointRef}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
      });
      // Each line is "<parent> <committer time>". The parent is the HEAD at capture.
      const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
      const [startHead = "", capturedAt = ""] = fromLine.split(" ");
      const [endHead = ""] = toLine.split(" ");
      if (startHead === "" || endHead === "" || startHead === endHead) {
        return null;
      }

      const listPaths = (args: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [
            "-c",
            "diff.relative=false",
            // log.showSignature prints verification text into the path list.
            "-c",
            "log.showSignature=false",
            ...args,
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
          ],
          maxOutputBytes: VcsDriver.CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\0")));
      // Remerge diff lists a merge's paths only where the result differs from Git's
      // automatic merge, so a merge keeps its conflict fixes and drops clean upstream changes.
      const pathLists = yield* Effect.all(
        [
          listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
          listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
          listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
          listPaths([
            "log",
            "--format=",
            "--diff-merges=remerge",
            `--since=@${capturedAt}`,
            `${startHead}..${endHead}`,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      return new Set(pathLists.flat().filter((path) => path.length > 0));
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        // Git exits 0 for a ref that is already gone, so a non-zero exit means the ref
        // survived: a held packed-refs.lock, say. A kept ref becomes the next run's baseline.
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
