// ), apps/server/src/vcs/GitVcsDriverCore.ts @ ab3a3cd1; perf from d6888999db, e2cc34f1e4, b8d9637003, be21de48bc, cfbd463110, c1c6be8b87, 8de7e3502c.
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  type GitCommandFailureReason,
  T3_PROJECT_FILE_NAME,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewInput,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewSource,
  type VcsRef,
} from "@caveman-app/protocol";
import { dedupeRemoteBranchesWithLocalMatches, normalizeGitRemoteUrl } from "@caveman-app/shared/git";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { compactTraceAttributes } from "@caveman-app/shared/observability";
import { decodeJsonResult } from "@caveman-app/shared/schemaJson";
import { resolveSpawnCommand } from "@caveman-app/shared/shell";
import { parseT3ProjectFile } from "@caveman-app/shared/t3ProjectFile";
import { resolveProjectFileBackedSetting } from "@caveman-app/shared/projectSettings";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import { toolsIndex, toolsSocket } from "../cloudLink/tools.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeEmptyDirectory } from "./removeEmptyDirectory.ts";
import { explicitBareRepositoryEnv, gitConfigEnv } from "./VcsProcess.ts";
import { recoverWorktreeTrash, removeLinkedWorktree } from "./worktreeRemoval.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const gitProcesses = Semaphore.makeUnsafe(8);
// `git worktree add` itself has no deadline (a large checkout or a slow post-checkout hook
// may run for many minutes, and killing it leaves an orphaned worktree). The best-effort
// index refresh that follows still stops a genuinely hung git.
const WORKTREE_REFRESH_INDEX_TIMEOUT_MS = 300_000;
const WORKTREE_REMOVE_TIMEOUT_MS = Duration.toMillis(Duration.minutes(5));
// A `git worktree add` run as a plain command (a Cloud computer's chats, automation runs) is still a whole
// checkout: it gets at least this long, which also keeps it off the 8-process limit. One asked for with no
// deadline, as createWorktree's is, keeps none.
const WORKTREE_ADD_MIN_TIMEOUT_MS = 300_000;
// One lock per repository, by its git common dir, taken by every `git worktree add`, `remove` and `prune` the
// runtime runs (changeWorktrees). Here rather than in a driver, so every driver in the process shares it.
const worktreeLocks = new Map<string, Semaphore.Semaphore>();
// How long one worktree command keeps the others of its repository waiting. Quick ones run one at a time, which
// on a Mac is also the faster order: checkouts written side by side slow each other down. A longer one lets the
// next begin: a checkout or its post-checkout hook has no deadline, and removing a worktree with installed
// dependencies takes minutes.
const WORKTREE_LOCK_MAX_HOLD = Duration.seconds(2);
// How often a command that lost a race to another git process runs again, and how long it waits first. Each
// later wait doubles, and all are jittered so the losers of one race do not meet again.
const LOST_RACE_RERUNS = 4;
const WORKTREE_RACE_FIRST_WAIT_MS = 40;
const REF_LOCK_FIRST_WAIT_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Every status refresh adds the untracked files to a temporary index, and git add's cost grows
// much faster than the file count (50k files took about 30 seconds). Past this many, the
// totals are reported incomplete instead.
const REVIEW_UNTRACKED_MAX_FILES = 5_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
// Patches the clients render are parsed against git's default a/ and b/ path
// prefixes. A repository or global diff.noprefix or diff.mnemonicPrefix would
// otherwise leak into the patch and leave every parsed file unnamed.
export const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;
// Shared by review previews and status totals, so the Changes row matches the Changes view.
// Client patch parsers drop blank context lines under diff.suppressBlankEmpty and summaries under diff.submodule.
const REVIEW_DIFF_ARGS = [
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--find-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  ...PATCH_RENDER_PREFIX_ARGS,
];
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_FETCH_TIMEOUT = Duration.minutes(5);

const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_CAPACITY = 2_048;
const REPOSITORY_PATHS_CACHE_TTL = Duration.minutes(10);
const REPOSITORY_PATHS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const NON_REPOSITORY_PATHS_CACHE_TTL = Duration.seconds(1);
const LIST_REFS_SNAPSHOT_CACHE_CAPACITY = 64;
const LIST_REFS_SNAPSHOT_CACHE_TTL = Duration.minutes(2);
const LIST_REFS_REFRESH_COALESCE_TTL = Duration.seconds(5);
const LIST_REFS_REFRESH_FAILURE_COOLDOWN = Duration.seconds(30);
const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);
const STATUS_ORIGIN_EXISTS_CACHE_TTL = Duration.minutes(5);
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  defaultBranch: null,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

function statusUpstreamRefreshFailureCooldown(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN);
}

class GitRefsSnapshotCacheKey extends Data.Class<{
  gitCommonDir: string;
  epoch: number;
}> {}

class GitRefsRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  generation: number;
}> {}

interface GitRepositoryPaths {
  readonly gitCommonDir: string;
  readonly worktreeRoot: string | null;
  readonly currentBranch: string | null;
}

interface GitRefsSnapshot {
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | null | undefined;
  forceKillAfterMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
  writesSharedConfig?: boolean | undefined;
  movesWorkingTree?: boolean | undefined;
  /** The command writes files out of the repository and reaches no remote of its own. */
  checksOutFiles?: boolean | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

// -z preserves tabs/newlines in paths and gives renames two separate path fields.
function parseReviewNumstat(stdout: string): ReviewDiffFileStat[] {
  const fields = stdout.split("\0");
  const files: ReviewDiffFileStat[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const previousPath = match[3] === "" ? fields[++index]! : null;
    const path = previousPath !== null ? fields[++index]! : match[3]!;
    files.push({
      path,
      previousPath,
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return files;
}

// Space-separated fields precede the path in each porcelain v2 record type. The path itself
// may contain spaces, so it is everything after them.
const PORCELAIN_V2_FIELDS_BEFORE_PATH: Record<string, number> = {
  "1": 8,
  "2": 9,
  u: 10,
  "?": 1,
  "!": 1,
};

function parsePorcelainPath(record: string): string | null {
  const fieldsBeforePath = PORCELAIN_V2_FIELDS_BEFORE_PATH[record[0] ?? ""];
  if (fieldsBeforePath === undefined) return null;
  const filePath = record.split(" ").slice(fieldsBeforePath).join(" ");
  return filePath.length > 0 ? filePath : null;
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

/**
 * Refuses a ref name with a leading "-" before it reaches checkout or `worktree add`. Git refuses
 * such branch and tag names, and both commands, or the `git branch` that `worktree add` runs, read
 * one as an option. `--end-of-options` cannot guard them: Git before 2.44 reads it like `--`.
 * A lone "-" is the previous checkout, which both commands read as a ref.
 */
const refuseOptionLikeRefName = (operation: string, cwd: string, refName: string | undefined) =>
  refName !== undefined && refName !== "-" && refName.startsWith("-")
    ? Effect.fail(
        new GitCommandError({
          operation,
          command: "git",
          cwd,
          detail: "Ref names cannot start with '-'.",
        }),
      )
    : Effect.void;

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // A partial clone's fetch line ends in its filter: "origin\thttps://… (fetch) [blob:none]".
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]*\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
  return {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const;
}

// Git states the actual cause on stderr, but stderr never leaves this module:
// it echoes argv and remote URLs, which can carry credentials. Matching it
// against fixed patterns yields a tag the caller can act on and a message that
// quotes none of the matched text. Patterns run in order, specific first.
const GIT_FAILURE_REASON_PATTERNS: ReadonlyArray<readonly [RegExp, GitCommandFailureReason]> = [
  // A filter marked required (as `git lfs install` marks LFS) that could not run stops git on this line.
  [/^fatal: .+: (?:clean|smudge) filter .+ failed$/im, "filter_failed"],
  [/would clobber existing tag/i, "tag_would_be_clobbered"],
  [/is already (?:used by worktree at|checked out at)/i, "branch_checked_out_in_worktree"],
  [/a branch named .+ already exists/i, "branch_already_exists"],
  // The same prefix also reports permission errors, which retrying cannot fix.
  [/could not lock config file .+: File exists/i, "config_locked"],
  // ssh names the methods it tried, so the parenthesized list varies:
  // `(publickey)`, `(publickey,password)`, `(keyboard-interactive)`.
  [
    /(?:authentication failed|could not read Username|could not read Password|permission denied \([a-z-]+(?:,[a-z-]+)*\)|permission denied, please try again)/i,
    "authentication_failed",
  ],
  // Distinct from a credential failure: the remote answered and the key it
  // presented is untrusted, so pointing the user at credentials would misdirect.
  [/host key verification failed/i, "host_key_unverified"],
  [
    /(?:could not read from remote repository|does not appear to be a git repository|repository .+ not found)/i,
    "remote_unreachable",
  ],
  // Quoted-path forms only: an unquoted `fatal: <thing> already exists` also
  // covers tag and ref collisions, which are not path collisions.
  [/fatal: '[^']+' already exists|destination path .+ already exists/i, "path_already_exists"],
  // Ambiguous revision/path and pathspec failures can name files, so omit them.
  // Anchor to a diagnostic line to avoid matching quoted paths in other errors.
  [
    /^fatal: (?:invalid reference: |not a valid object name|needed a single revision|bad revision |'.+' is not a commit and a branch '.+' cannot be created from it)/im,
    "ref_not_found",
  ],
  // `[remote rejected]` is only printed for a push. The remote's explanation
  // follows in parentheses; it is server text, so it is never quoted.
  [/^[ \t]*![ \t]+\[remote rejected\]/im, "push_rejected_by_remote"],
  // A fetch into a diverged local branch prints the same `[rejected]` line, but
  // only a push goes on to report "failed to push some refs".
  [
    /^[ \t]*![ \t]+\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)[\s\S]*^error: failed to push some refs/im,
    "push_rejected_non_fast_forward",
  ],
];

// Reasons the user can act on get a sentence in place of the generic detail, a caller's included.
const GIT_FAILURE_REASON_DETAILS: Partial<Record<GitCommandFailureReason, string>> = {
  push_rejected_by_remote:
    "The remote rejected the push. Push this branch from a terminal to see the server's message.",
  push_rejected_non_fast_forward:
    "The remote has commits this branch doesn't have. Pull or rebase, then push again.",
  config_locked:
    "Another Git process kept the repository's config locked. Wait for it to finish, then retry.",
  // Any command that reads or writes files runs filters (a checkout smudges, staging cleans), so it names none.
  filter_failed:
    "Git could not run a filter this repository needs, such as Git LFS. Install it where Caveman Code runs git, " +
    "then try again.",
};

function gitFailureDetail(reason: GitCommandFailureReason | null, fallback?: string): string {
  return (
    (reason === null ? undefined : GIT_FAILURE_REASON_DETAILS[reason]) ??
    fallback ??
    "Git command exited with a non-zero status."
  );
}

// Existing non-commit objects share the missing-ref fatal diagnostic; Git
// distinguishes them with a separate error line.
const GIT_NOT_A_COMMIT_PATTERN = /^error: .+(?:, not a commit|expected commit type)/im;

// Hooks write to the same stream git does, and nothing distinguishes their
// text from git's: a pre-push hook echoing "authentication failed" would
// otherwise be read as a credential failure. Git prefixes its own diagnostics
// and states a push rejection on a `! [rejected]` line, so only those are
// classified. `remote:` is deliberately excluded — git prefixes every byte the
// server sends that way, remote hook output included, so trusting it would
// reintroduce the same false positive from the other end of the connection.
const GIT_DIAGNOSTIC_LINE_PATTERN = /^(?:fatal|error):|^!\s|^\s+!\s/;
// ssh reports the refusal itself, unprefixed, and git only adds a generic
// "Could not read from remote repository" after it. Dropping ssh's line would
// leave that generic one to be read as an unreachable remote when the real
// cause is credentials, so these specific refusals are classified too.
const SSH_TRANSPORT_REFUSAL_PATTERN =
  /Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|Host key verification failed/i;

// A long-running filter process (LFS's `filter-process`) that exits before its handshake leaves git reading a closed
// pipe, which it reports in the words of a dropped connection. A checkout reaches a remote only to fetch a partial
// clone's missing objects, and that failure names the promisor remote.
const GIT_FILTER_PROCESS_GONE_PATTERN = /^fatal: the remote end hung up unexpectedly$/m;
const GIT_PROMISOR_FETCH_PATTERN = /^fatal: could not fetch .+ from promisor remote$/m;

function classifyGitFailure(
  stderr: string,
  options: { readonly checksOutFiles?: boolean } = {},
): GitCommandFailureReason | null {
  const diagnostics = stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        GIT_DIAGNOSTIC_LINE_PATTERN.test(line) ||
        // A remote hook can echo ssh's wording; only the local ssh's line counts.
        (!/^remote:/.test(line) && SSH_TRANSPORT_REFUSAL_PATTERN.test(line)),
    )
    .join("\n");
  if (diagnostics.length === 0) return null;
  if (isNonRepositoryGitStderr(diagnostics)) return "not_a_repository";
  for (const [pattern, reason] of GIT_FAILURE_REASON_PATTERNS) {
    if (!pattern.test(diagnostics)) continue;
    if (reason === "ref_not_found" && GIT_NOT_A_COMMIT_PATTERN.test(diagnostics)) continue;
    return reason;
  }
  if (
    options.checksOutFiles &&
    GIT_FILTER_PROCESS_GONE_PATTERN.test(diagnostics) &&
    !GIT_PROMISOR_FETCH_PATTERN.test(diagnostics)
  ) {
    return "filter_failed";
  }
  return null;
}

/** What a command that exited non-zero fails with, unless its caller asked for the exit code. */
function nonZeroExitError(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  result: Pick<GitVcsDriver.ExecuteGitResult, "exitCode" | "stdout" | "stderr">,
): GitCommandError {
  const reason = classifyGitFailure(result.stderr);
  return new GitCommandError({
    ...gitCommandContext(input),
    ...(reason === null ? {} : { reason }),
    detail: gitFailureDetail(reason),
    exitCode: result.exitCode,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
}

// `--short` and `--abbrev-ref` print `heads/<name>` when a tag shares the branch's name, so
// branch reads take the full ref and strip the prefix themselves.
function branchNameFromHeadRef(value: string): string | null {
  const ref = value.trim();
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length
    ? ref.slice("refs/heads/".length)
    : null;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.cause.reason;
  if (reason._tag === "NotFound") {
    return reason.pathOrDescriptor === error.cwd;
  }

  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}
function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
}

// Matches `git worktree remove` on a path git no longer tracks: "is not a
// working tree" when the registration is gone, "cannot remove working tree"
// when older gits fail validation on a registered-but-deleted directory.
function isMissingWorktreeStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  );
}

// Fetch stderr can contain remote credentials. Only fixed diagnoses may enter
// persisted errors; unrecognized output keeps the generic failure message.
function fetchFailureDetail(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  if (
    lines.some((line) =>
      /^(?:fatal: (?:Authentication failed|could not read (?:Username|Password))\b|\S+: Permission denied \(publickey)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  }
  if (
    lines.some((line) =>
      /^(?:(?:fatal: |ssh: )?Could not resolve host(?:name)?\b|fatal: unable to access .+: (?:Could not resolve host|Failed to connect)\b|ssh: connect to host \S+ port \d+: (?:Connection timed out|Connection refused|Network is unreachable)\b)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not reach the remote. Check the server's network connection and remote host, then retry.";
  }
  if (
    lines.some((line) =>
      /^(?:remote: Repository not found\.?$|fatal: repository .+ not found$|fatal: .+ does not appear to be a git repository$)/i.test(
        line,
      ),
    )
  ) {
    return "Git could not access the remote repository. Check the remote URL and repository permissions on the server.";
  }
  if (isRefLockFailure(stderr)) {
    return "Git could not update a local reference. Another Git operation or a stale lock may be blocking the fetch; check the repository on the server, then retry.";
  }
  return undefined;
}

// Matches a fetch that lost a ref update to another Git process. Git 2.53+
// reports it as "fetching ref <ref> failed: ..."; older Git says "cannot lock ref".
function isRefLockFailure(stderr: string): boolean {
  return stderr
    .split(/\r?\n/)
    .some((line) =>
      /^(?:(?:error|fatal): cannot lock ref\b|fatal: Unable to create ['"].+\.lock['"]:|error: fetching ref \S+ failed: (?:incorrect old value provided|reference already exists)$)/i.test(
        line.trim(),
      ),
    );
}

// Git's own options that take their value as the next argument, ahead of the subcommand.
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

/** Where the subcommand starts in `args`, past git's own options. */
function gitSubcommandIndex(args: ReadonlyArray<string>): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]!) ? 2 : 1;
  }
  return index;
}

/**
 * Which change to a repository's registered worktrees `args` asks git for: `git worktree add`, `remove` or
 * `prune`, with any of git's own options ahead of it (`-c core.hooksPath=/dev/null worktree add …`). Null for
 * every other command.
 */
export function worktreeChange(args: ReadonlyArray<string>): "add" | "remove" | "prune" | null {
  const index = gitSubcommandIndex(args);
  if (args[index] !== "worktree") return null;
  const verb = args[index + 1];
  // A move rewrites a registration as a prune does, and is as quick: it holds the lock to its end.
  if (verb === "move") return "prune";
  return verb === "add" || verb === "remove" || verb === "prune" ? verb : null;
}

// `git worktree add` registers a worktree in several writes with no lock of its own, and a git that lists the
// worktrees in between dies on the unfinished one: "fatal: failed to read .git/worktrees/<id>/commondir: …".
// Matched by the path, which reads the same in every locale.
function metHalfRegisteredWorktree(stderr: string): boolean {
  return /^fatal: .*[\\/]worktrees[\\/][^\\/]+[\\/]commondir\b/m.test(stderr);
}

/**
 * For `git worktree add -b <branch> … <path> [<start>]`: the branch, where it starts, and the same command
 * checking that branch out instead of making it. Null when `args` makes no branch this way.
 */
function newBranchOfWorktreeAdd(args: ReadonlyArray<string>): {
  readonly branch: string;
  readonly start: string;
  readonly checkOut: ReadonlyArray<string>;
} | null {
  const add = gitSubcommandIndex(args) + 1;
  const options: Array<string> = [];
  const positional: Array<string> = [];
  let branch: string | undefined;
  for (let index = add + 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-b") branch = args[++index];
    else if (arg === "-B" || arg === "--orphan") return null;
    else if (arg === "--reason") options.push(arg, args[++index] ?? "");
    // Only allowed beside a new branch, whose tracking the first try already wrote.
    else if (arg === "--track" || arg === "--no-track") continue;
    else (arg.startsWith("-") ? options : positional).push(arg);
  }
  const [path, start = "HEAD"] = positional;
  if (branch === undefined || path === undefined) return null;
  return { branch, start, checkOut: [...args.slice(0, add + 1), ...options, "--", path, branch] };
}

// With GIT_PROGRESS_DELAY=0 a checkout names every file it writes; none of that belongs in a caller's stderr.
const withoutCheckoutProgress = (stderr: string) =>
  stderr.replace(/Updating files:[^\r\n]*(?:\r\n|\r|\n)?/g, "");

/**
 * Runs `attempt` again while its result is one `lostRace` recognises, up to LOST_RACE_RERUNS more times. It waits
 * `firstWaitMs` before the first rerun and twice as long before each later one, every wait jittered by half.
 */
const rerunLostRaces = <E, R>(
  attempt: (rerun: number) => Effect.Effect<GitVcsDriver.ExecuteGitResult, E, R>,
  lostRace: (result: GitVcsDriver.ExecuteGitResult) => boolean,
  firstWaitMs: number,
) =>
  Effect.gen(function* () {
    let result = yield* attempt(0);
    for (let rerun = 1; rerun <= LOST_RACE_RERUNS && lostRace(result); rerun++) {
      const jitter = yield* Random.nextBetween(0.5, 1.5);
      yield* Effect.sleep(Duration.millis(firstWaitMs * 2 ** (rerun - 1) * jitter));
      result = yield* attempt(rerun);
    }
    return result;
  });

/**
 * Runs `use` holding `lock`, with a way to give it back before `use` ends; it is back when `use` ends either way.
 */
const holdingLock = <A, E, R>(
  lock: Semaphore.Semaphore,
  use: (letGo: Effect.Effect<void>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(lock.take(1)).pipe(
      Effect.flatMap(() => {
        let held = true;
        const letGo = Effect.suspend(() => {
          if (!held) return Effect.void;
          held = false;
          return Effect.asVoid(lock.release(1));
        });
        return restore(use(letGo)).pipe(Effect.ensuring(letGo));
      }),
    ),
  );

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.void,
    }),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);
const decodeTrace2Record = decodeJsonResult(Trace2Record);

// Untraced because it runs on every git spawn and returns at once without hook
// callbacks. Its errors fail the runGitCommand span.
const createTrace2Monitor = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeTrace2Record(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const GIT_CHECKOUT_PROGRESS_LINE = /Updating files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/;

/** Parses `Updating files:  78% (2104/2700)` from git's stderr progress output. */
export function parseGitCheckoutProgressLine(
  line: string,
): { percent: number; completed: number; total: number } | null {
  const match = GIT_CHECKOUT_PROGRESS_LINE.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  const completed = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(percent) || !Number.isFinite(completed) || !Number.isFinite(total)) {
    return null;
  }
  return { percent: Math.max(0, Math.min(100, percent)), completed, total };
}

const OUTPUT_LINE_SEPARATOR = /\r\n|\r|\n/;

const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
  keepLineCallbacksAfterTruncation = false,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  // ignoreBOM keeps a leading byte-order mark: it is part of what git printed (a file's contents).
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  // With callbacks continuing past the cap, lines are decoded by their own
  // decoder from the first byte so no character is ever split at the cap.
  const lineDecoder = keepLineCallbacksAfterTruncation && onLine ? new TextDecoder() : null;
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;
  // A separator-free stream past the cap must not grow the line buffer
  // without bound; a line longer than this is not one the callbacks want.
  const maxPendingLineBytes = 64 * 1024;

  // Git redraws progress with a bare `\r` between updates and only ends the
  // line once the step is done, so `\r` has to count as a line break here.
  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    while (separator) {
      const line = lineBuffer.slice(0, separator.index);
      lineBuffer = lineBuffer.slice(separator.index + separator[0].length);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      separator = OUTPUT_LINE_SEPARATOR.exec(lineBuffer);
    }

    if (flush) {
      const trailing = lineBuffer;
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      if (lineDecoder) {
        lineBuffer += lineDecoder.decode(chunk, { stream: true });
        yield* emitCompleteLines(false);
        if (lineBuffer.length > maxPendingLineBytes) lineBuffer = "";
      }
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        ...gitCommandContext(input),
        detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
        outputLength: nextBytes,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    if (onLine) {
      lineBuffer += lineDecoder ? lineDecoder.decode(chunk, { stream: true }) : decoded;
      yield* emitCompleteLines(false);
    }
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new GitCommandError({
          ...gitCommandContext(input),
          detail: "Failed to read Git process output.",
          cause,
        }),
    }),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  if (onLine) {
    lineBuffer += remainder;
    if (lineDecoder) lineBuffer += lineDecoder.decode();
    yield* emitCompleteLines(true);
  }
  return {
    text,
    truncated,
  };
});

/**
 * Git on Windows cannot create or delete a path longer than MAX_PATH (260)
 * unless `core.longpaths` is set. The OS-level LongPathsEnabled setting does not
 * cover it, and git leaves it off by default, so deep worktrees fail to check
 * out and fail midway through removal.
 *
 * Passed through `GIT_CONFIG_*` rather than `-c` so argv stays the same on every
 * platform and nothing is written to the user's config. The entry is appended
 * after any inherited ones. Windows env names are case-insensitive, so the
 * inherited count is found regardless of casing and updated under its own name.
 * A count git would reject is left alone so git still reports it.
 */
export const windowsLongPathConfigEnv = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
  platform === "win32" ? gitConfigEnv(env, "core.longpaths", "true", platform) : {};

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const digest = yield* Digest.Digest;
  const hostPlatform = yield* HostProcess.Platform;
  // On a Cloud computer git runs in the tools container and .git is the agent's: temporary indexes
  // are made, seeded and removed there, never by this uid (cloudLink/tools.ts).
  const tools = toolsSocket();
  const toolsIndexFor = (operation: string, cwd: string, seed: string) =>
    toolsIndex(tools!, seed).pipe(
      Effect.mapError(
        (cause) => new GitCommandError({ operation, command: "git", cwd, detail: "Failed to prepare a temporary index.", cause }),
      ),
    );
  const serviceScope = yield* Effect.scope;
  const statusFetches = new Map<string, Fiber.Fiber<void, GitCommandError>>();
  const statusFetchProcesses = yield* Semaphore.make(4);

  const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.movesWorkingTree
        ? null
        : input.timeoutMs === undefined
          ? DEFAULT_TIMEOUT_MS
          : input.timeoutMs;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to create Git trace monitor.",
                cause,
              }),
          ),
        );
        const baseEnv = {
          ...process.env,
          // Status polling runs beside the user's own git commands; without this,
          // `git status` takes index.lock to save its refreshed index.
          GIT_OPTIONAL_LOCKS: "0",
          ...input.env,
          ...trace2Monitor.env,
        };
        const env = { ...baseEnv, ...explicitBareRepositoryEnv(baseEnv, hostPlatform) };
        const spawnEnv = { ...env, ...windowsLongPathConfigEnv(hostPlatform, env) };
        const resolved = yield* resolveSpawnCommand("git", [], { env: spawnEnv }).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to spawn Git process.",
                cause,
              }),
          ),
        );
        // A git.cmd wrapper would need cmd.exe, which cuts multi-line commit
        // messages at the first newline; leave that case to Node's lookup.
        const executable = resolved.shell ? "git" : resolved.command;
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make(executable, commandInput.args, {
              cwd: commandInput.cwd,
              env: spawnEnv,
              forceKillAfter: input.forceKillAfterMs,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to spawn Git process.",
                  cause,
                }),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStdoutLine,
              input.keepLineCallbacksAfterTruncation,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
              input.keepLineCallbacksAfterTruncation,
            ),
            child.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to read Git process exit code.",
                    cause,
                  }),
              ),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        ...gitCommandContext(commandInput),
                        detail: "Failed to write Git process input.",
                        cause,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          return yield* nonZeroExitError(commandInput, {
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
          });
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      const execution = runGitCommand().pipe(Effect.scoped);
      if (input.movesWorkingTree) {
        return yield* Effect.uninterruptible(execution);
      }
      if (timeoutMs === null) {
        return yield* execution;
      }

      return yield* execution.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Effect.fromOption(
            result,
            () =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Git command timed out.",
              }),
          ),
        ),
      );
    },
  );

  // A repository's lock in `locks`: by its git common dir, so the checkout and every worktree of it share one.
  const repositoryLock = (locks: Map<string, Semaphore.Semaphore>, gitCommonDir: string) => {
    let lock = locks.get(gitCommonDir);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(gitCommonDir, lock);
    }
    return lock;
  };

  const sharedConfigLocks = new Map<string, Semaphore.Semaphore>();
  const withSharedConfigLock = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
    resolveRepositoryPaths(cwd).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((repositoryPaths) =>
        repositoryPaths === null
          ? effect
          : repositoryLock(sharedConfigLocks, repositoryPaths.gitCommonDir).withPermit(effect),
      ),
    );

  const executeOnce: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      (execution) =>
        input.movesWorkingTree ||
        input.timeoutMs === null ||
        (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) > DEFAULT_TIMEOUT_MS
          ? execution
          : gitProcesses.withPermits(1)(execution),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
      // Outside the process permit: resolving the repository may itself need one.
      (execution) =>
        input.writesSharedConfig ? withSharedConfigLock(input.cwd, execution) : execution,
    );

  // `git worktree add -b` makes its branch before it reads the registrations, so a try that died there left the
  // branch behind and the same command again is refused: "a branch named … already exists". When that branch
  // stands where the command would have made it, the rerun checks it out instead. Any other branch of that name
  // is someone else's, and git's refusal stands.
  const checkingOutBranchOfFailedTry = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const made = newBranchOfWorktreeAdd(args);
      if (made === null) return args;
      const commitOf = (revision: string) =>
        executeGit(
          "GitVcsDriver.changeWorktrees.resolveCommit",
          cwd,
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
          Effect.orElseSucceed(() => null),
        );
      const [branch, start] = yield* Effect.all([
        commitOf(`refs/heads/${made.branch}`),
        commitOf(made.start),
      ]);
      return branch !== null && branch === start ? made.checkOut : args;
    });

  /**
   * `git worktree add`, `remove` and `prune`, whoever runs them: one at a time per repository, since git
   * registers a worktree in several unlocked writes and each of these first reads every registration (of 48
   * chats started at once, 2 died on another's unfinished one). The lock covers what must not overlap and no
   * more than WORKTREE_LOCK_MAX_HOLD of the rest: an add gives it back that long after it started, once its
   * checkout has begun and so its registration is over (a `--quiet` add never says, and keeps it to its end); a
   * remove, which reads the registrations as it starts and unregisters only when the files are gone, that long
   * after it started. Git the runtime does not run, such as an agent's own, takes no lock, so a command that
   * still meets an unfinished registration runs again.
   */
  const changeWorktrees = (
    change: "add" | "remove" | "prune",
    input: GitVcsDriver.ExecuteGitInput,
  ) =>
    Effect.gen(function* () {
      // Outside a repository git says so itself, and nothing is there to lock.
      const gitCommonDir = yield* gitCommonDirOf(input.cwd).pipe(Effect.orElseSucceed(() => null));
      const lock = gitCommonDir === null ? null : repositoryLock(worktreeLocks, gitCommonDir);
      const attempt = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const checkoutBegan = yield* Deferred.make<void>();
          const onStderrLine = input.progress?.onStderrLine;
          const command: GitVcsDriver.ExecuteGitInput =
            change === "add"
              ? {
                  ...input,
                  args,
                  allowNonZeroExit: true,
                  timeoutMs:
                    input.timeoutMs === null
                      ? null
                      : Math.max(input.timeoutMs ?? 0, WORKTREE_ADD_MIN_TIMEOUT_MS),
                  // Git then names every file it writes, from the first: how the lock learns the checkout began.
                  env: { ...input.env, GIT_PROGRESS_DELAY: "0" },
                  progress: {
                    ...input.progress,
                    onStderrLine: (line) =>
                      (GIT_CHECKOUT_PROGRESS_LINE.test(line)
                        ? Deferred.succeed(checkoutBegan, undefined)
                        : Effect.void
                      ).pipe(Effect.andThen(onStderrLine ? onStderrLine(line) : Effect.void)),
                  },
                }
              : { ...input, args, allowNonZeroExit: true };
          if (lock === null) return yield* executeOnce(command);
          return yield* holdingLock(lock, (letGo) =>
            Effect.gen(function* () {
              if (change !== "prune") {
                yield* Effect.sleep(WORKTREE_LOCK_MAX_HOLD).pipe(
                  Effect.andThen(change === "add" ? Deferred.await(checkoutBegan) : Effect.void),
                  Effect.andThen(letGo),
                  Effect.forkScoped,
                );
              }
              return yield* executeOnce(command);
            }).pipe(Effect.scoped),
          );
        });

      let args = input.args;
      const raced = yield* rerunLostRaces(
        (rerun) =>
          rerun === 0 || change !== "add"
            ? attempt(args)
            : checkingOutBranchOfFailedTry(input.cwd, args).pipe(
                Effect.flatMap((next) => {
                  args = next;
                  return attempt(next);
                }),
              ),
        (result) => result.exitCode !== 0 && metHalfRegisteredWorktree(result.stderr),
        WORKTREE_RACE_FIRST_WAIT_MS,
      );
      const result =
        change === "add" && input.env?.GIT_PROGRESS_DELAY === undefined
          ? { ...raced, stderr: withoutCheckoutProgress(raced.stderr) }
          : raced;
      if (result.exitCode !== 0 && !input.allowNonZeroExit) {
        return yield* nonZeroExitError(input, result);
      }
      return result;
    });

  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) => {
    const change = worktreeChange(input.args);
    return change === null ? executeOnce(input) : changeWorktrees(change, input);
  };

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.forceKillAfterMs !== undefined
        ? { forceKillAfterMs: options.forceKillAfterMs }
        : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
      ...(options.writesSharedConfig ? { writesSharedConfig: true } : {}),
      ...(options.movesWorkingTree ? { movesWorkingTree: true } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        const reason = classifyGitFailure(result.stderr, { checksOutFiles: options.checksOutFiles === true });
        return Effect.fail(
          new GitCommandError({
            ...gitCommandContext({ operation, cwd, args }),
            ...(reason === null ? {} : { reason }),
            detail: gitFailureDetail(reason, options.fallbackErrorDetail),
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
        );
      }),
    );

  const executeGitWithStableDiagnostics = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    executeGit(operation, cwd, args, {
      ...options,
      env: {
        ...options.env,
        // English diagnostics without overriding LC_CTYPE, which hooks inherit.
        LANGUAGE: "C",
      },
    });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  /**
   * Runs `git worktree list --porcelain -z`. Git before 2.36 rejects `-z`, so a failed run
   * retries the line form and returns it NUL-delimited, the same shape as `-z` output.
   * The line form cannot carry paths that contain newlines.
   */
  const executeWorktreeList = Effect.fn("executeWorktreeList")(function* (
    operation: string,
    cwd: string,
    gitArgs: readonly string[],
    options: ExecuteGitOptions = {},
  ) {
    const args = [...gitArgs, "worktree", "list", "--porcelain"];
    const result = yield* executeGit(operation, cwd, [...args, "-z"], {
      ...options,
      allowNonZeroExit: true,
    });
    if (result.exitCode === 0) return result;
    const lineResult = yield* executeGit(operation, cwd, args, options);
    return { ...lineResult, stdout: lineResult.stdout.replaceAll("\n", "\0") };
  });

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    requestedBranch: string,
  ) {
    // A branch at a parent path (such as `t3`) blocks every ref nested under it, so no suffix
    // would help; flatten to a sibling the way temporary worktree branches already do.
    const segments = requestedBranch.split("/");
    let blockedByParent = false;
    for (let index = 1; index < segments.length && !blockedByParent; index += 1) {
      blockedByParent = yield* branchExists(cwd, segments.slice(0, index).join("/"));
    }
    const desiredBranch = blockedByParent ? segments.join("-") : requestedBranch;
    // A branch nested under the name (`t3-fix/child`) blocks it as surely as one with the name.
    const isBranchNameTaken = (name: string) =>
      Effect.zipWith(
        branchExists(cwd, name),
        runGitStdout(
          "GitVcsDriver.branchExists",
          cwd,
          ["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${name}/`],
          true,
        ),
        (exists, nested) => exists || nested.trim().length > 0,
      );

    const isDesiredTaken = yield* isBranchNameTaken(desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* isBranchNameTaken(candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.renameBranch",
        cwd,
        args: ["branch", "-m", "--", desiredBranch],
      }),
      detail: `Could not find an available branch name for '${desiredBranch}'.`,
    });
  });

  // `--abbrev-ref` prints `remotes/origin/<name>` when a local `origin/<name>` branch exists.
  const readCurrentUpstreamRef = Effect.fn("readCurrentUpstreamRef")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim().replace(/^refs\/(?:remotes|heads)\//, "")));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }
    return upstreamRef;
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (
    cwd: string,
    knownUpstreamRef?: string,
  ) {
    const upstreamRef = knownUpstreamRef ?? (yield* readCurrentUpstreamRef(cwd));
    if (upstreamRef === null) {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = Effect.fn("GitVcsDriver.fetchRemoteForStatus.wait")(function* (
    gitCommonDir: string,
    remoteName: string,
  ) {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    // `--no-auto-gc` (a synonym of `--no-auto-maintenance` that older Git also knows) keeps
    // this poll from starting `git gc --auto`. When that gc fails, for example on a repository
    // with missing objects, Git retries it on every fetch and leaves a full-size `tmp_pack_*`
    // behind each time, so a background poll could fill the disk.
    const args = [
      "--git-dir",
      gitCommonDir,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-auto-gc",
      "--",
      remoteName,
    ];
    const key = `${gitCommonDir}\0${remoteName}`;
    const failure = statusRemoteRefreshFailures.get(key);
    if (failure && (yield* Clock.currentTimeMillis) < failure.retryAt) return;
    const fiber = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const pending = statusFetches.get(key);
        if (pending) return pending;
        // Frequent poll deadlines and disconnected clients must not interrupt a
        // healthy writer. A separate safety limit prevents a hung transport from
        // occupying its worker slot indefinitely.
        const started = yield* executeGit("GitVcsDriver.fetchRemoteForStatus", fetchCwd, args, {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
          timeoutMs: Duration.toMillis(STATUS_UPSTREAM_FETCH_TIMEOUT),
          forceKillAfterMs: 1_000,
        }).pipe(
          Effect.asVoid,
          Effect.tap(() =>
            Effect.sync(() => {
              statusRemoteRefreshFailures.delete(key);
            }),
          ),
          Effect.tapError(() => recordStatusRemoteRefreshFailure(key)),
          Effect.tapCause((cause) => Effect.logWarning("Background Git fetch failed", cause)),
          statusFetchProcesses.withPermits(1),
          Effect.onExit(() =>
            Effect.sync(() => {
              statusFetches.delete(key);
            }),
          ),
          Effect.forkIn(serviceScope, { startImmediately: false, uninterruptible: false }),
        );
        statusFetches.set(key, started);
        return started;
      }),
    );
    const result = yield* Fiber.join(fiber).pipe(
      Effect.timeoutOption(STATUS_UPSTREAM_REFRESH_TIMEOUT),
    );
    if (Option.isNone(result)) {
      yield* Effect.logDebug(
        "Background Git fetch is still running; using the last fetched references.",
      );
    }
  });

  const readGitCommonDir = Effect.fn("readGitCommonDir")(function* (cwd: string) {
    // Git reports relative paths from the physical cwd, which can differ from a symlink.
    const commonDirResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.resolveRepositoryPaths.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    );
    if (commonDirResult.exitCode !== 0) {
      const stderr = commonDirResult.stderr.trim();
      if (isNonRepositoryGitStderr(stderr)) {
        return null;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        }),
        detail: "Failed to resolve the Git common directory.",
        exitCode: commonDirResult.exitCode,
        stdoutLength: commonDirResult.stdout.length,
        stderrLength: commonDirResult.stderr.length,
      });
    }

    const commonDirOutput = commonDirResult.stdout.trim();
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
      ? path.normalize(commonDirOutput)
      : path.resolve(physicalCwd, commonDirOutput);
    return yield* fileSystem
      .realPath(resolvedGitCommonDir)
      .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));
  });

  const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
    cwd: string,
  ) {
    const gitCommonDir = yield* readGitCommonDir(cwd);
    if (gitCommonDir === null) return null;
    const [worktreeRootResult, currentBranchResult] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
          cwd,
          ["rev-parse", "--show-toplevel"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitVcsDriver.resolveRepositoryPaths.currentBranch",
          cwd,
          ["symbolic-ref", "--quiet", "HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
      ],
      { concurrency: 2 },
    );
    // Git terminates --show-toplevel with exactly one "\n" on every platform (stdout is
    // binary mode on Windows). Whitespace before it belongs to the path and must survive,
    // because this root becomes the editor target for every repository-relative status path.
    const worktreeRootOutput = worktreeRootResult.stdout.endsWith("\n")
      ? worktreeRootResult.stdout.slice(0, -1)
      : worktreeRootResult.stdout;
    const worktreeRoot =
      worktreeRootResult.exitCode === 0 && worktreeRootOutput.length > 0
        ? path.normalize(
            path.isAbsolute(worktreeRootOutput)
              ? worktreeRootOutput
              : path.resolve(cwd, worktreeRootOutput),
          )
        : null;
    const currentBranch =
      currentBranchResult.exitCode === 0 ? branchNameFromHeadRef(currentBranchResult.stdout) : null;

    return {
      gitCommonDir,
      worktreeRoot,
      currentBranch,
    } satisfies GitRepositoryPaths;
  });

  const repositoryPathsCache = yield* Cache.makeWith(
    (cwd: string) => resolveRepositoryPathsUncached(cwd),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const repositoryPathsRefreshCache = yield* Cache.makeWith(
    (cwd: string) =>
      Cache.invalidate(repositoryPathsCache, cwd).pipe(
        Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
      ),
    {
      capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (repositoryPaths) =>
          repositoryPaths === null
            ? NON_REPOSITORY_PATHS_CACHE_TTL
            : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));
  const resolveRepositoryPaths = (cwd: string, refresh = false) => {
    const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
    return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
  };

  const gitCommonDirCache = yield* Cache.makeWith((cwd: string) => readGitCommonDir(cwd), {
    capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (gitCommonDir) =>
        gitCommonDir === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });
  /**
   * The git common dir of the repository at `cwd`, null outside one, for callers that need nothing else of it:
   * from what is already known of the folder, else from one `git rev-parse`, remembered as the full paths are.
   */
  const gitCommonDirOf = (cwd: string) => {
    const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
    return Cache.getOption(repositoryPathsCache, cacheKey).pipe(
      Effect.map((cached) => Option.getOrNull(cached)?.gitCommonDir ?? null),
      Effect.orElseSucceed(() => null),
      Effect.flatMap((known) =>
        known === null ? Cache.get(gitCommonDirCache, cacheKey) : Effect.succeed(known),
      ),
    );
  };

  const defaultBranchCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.defaultBranch",
          fetchCwd,
          ["--git-dir", gitCommonDir, "symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) return null;
            return parseDefaultBranchFromRemoteHeadRef(result.stdout, "origin");
          }),
        );
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_DEFAULT_BRANCH_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const originExistsCache = yield* Cache.makeWith(
    (gitCommonDir: string) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fetchCwd =
          path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
        return yield* executeGit(
          "GitVcsDriver.statusDetails.originExists",
          fetchCwd,
          ["--git-dir", gitCommonDir, "remote", "get-url", "origin"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.exitCode === 0));
      }),
    {
      capacity: 2_048,
      timeToLive: Exit.match({
        onSuccess: () => STATUS_ORIGIN_EXISTS_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );
  const invalidateStatusStaticCaches = (cwd: string, gitCommonDir?: string | null) =>
    Effect.gen(function* () {
      const commonDir =
        gitCommonDir === undefined
          ? (yield* resolveRepositoryPaths(cwd).pipe(
              Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
            ))?.gitCommonDir
          : gitCommonDir;
      const cacheKey = commonDir ?? normalizeRepositoryPathsCacheKey(cwd);
      yield* Cache.invalidate(defaultBranchCache, cacheKey);
      yield* Cache.invalidate(originExistsCache, cacheKey);
    });

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const repositoryPaths = yield* resolveRepositoryPaths(cwd);
    if (repositoryPaths !== null) {
      return repositoryPaths.gitCommonDir;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      }),
      detail: "Cannot resolve a Git common directory outside a repository.",
    });
  });

  const statusRemoteRefreshFailures = new Map<string, { count: number; retryAt: number }>();
  const statusRemoteRefreshFailureKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
    `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;
  const recordStatusRemoteRefreshFailure = Effect.fn(
    "GitVcsDriver.recordStatusRemoteRefreshFailure",
  )(function* (key: string) {
    const nextCount = (statusRemoteRefreshFailures.get(key)?.count ?? 0) + 1;
    const now = yield* Clock.currentTimeMillis;
    statusRemoteRefreshFailures.delete(key);
    statusRemoteRefreshFailures.set(key, {
      count: nextCount,
      retryAt: now + Duration.toMillis(statusUpstreamRefreshFailureCooldown(nextCount)),
    });
    if (statusRemoteRefreshFailures.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
      const oldestKey = statusRemoteRefreshFailures.keys().next().value;
      if (oldestKey !== undefined) {
        statusRemoteRefreshFailures.delete(oldestKey);
      }
    }
  });
  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    return yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
      Effect.as(true as const),
    );
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // A failed background fetch is intentionally cached and exponentially
    // backed off. Status reads swallow this failure and use the last fetched
    // refs, so repeated thread mounts cannot turn a slow or unavailable remote
    // into a repository-wide Git subprocess storm.
    timeToLive: (exit, cacheKey) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : statusUpstreamRefreshFailureCooldown(
            statusRemoteRefreshFailures.get(statusRemoteRefreshFailureKey(cacheKey))?.count ?? 1,
          ),
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const headRef = yield* runGitStdout(
      "GitVcsDriver.refreshStatusUpstreamIfStale.headRef",
      cwd,
      ["symbolic-ref", "--quiet", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (headRef.length === 0) return;
    const remoteName = yield* runGitStdout(
      "GitVcsDriver.refreshStatusUpstreamIfStale.upstreamRemote",
      cwd,
      ["for-each-ref", "--format=%(upstream:remotename)", headRef],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    // Empty means no upstream; `.` means the upstream is a local branch.
    if (remoteName.length === 0 || remoteName === ".") return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    // The cache loader logs failed attempts; cache hits keep using the last fetched refs.
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({ gitCommonDir, remoteName }),
    ).pipe(Effect.ignore);
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists: GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"] = (input) =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      input.cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${input.remoteName}/${input.refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const remoteExists: GitVcsDriver.GitVcsDriver["Service"]["remoteExists"] = (input) =>
    executeGit(
      "GitVcsDriver.remoteExists",
      input.cwd,
      ["remote", "get-url", "--", input.remoteName],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    remoteExists({ cwd, remoteName: "origin" });

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolvePrimaryRemoteName",
        cwd,
        args: ["remote"],
      }),
      detail: "No git remote is configured for this repository.",
    });
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
    // The remote the branch is published on, which git push itself falls back to before the primary one.
    branchRemote: string | null = null,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }
    if (branchRemote) {
      return branchRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "ensureRemote",
  )(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeGitRemoteUrl(input.url);
    const listRemoteFetchUrls = runGitStdout(
      "GitVcsDriver.ensureRemote.listRemoteUrls",
      input.cwd,
      ["remote", "-v"],
    ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));
    const findMatchingRemote = (remoteFetchUrls: Map<string, string>) =>
      Array.from(remoteFetchUrls.entries()).find(
        ([, remoteUrl]) => normalizeGitRemoteUrl(remoteUrl) === normalizedTargetUrl,
      )?.[0];

    const remoteFetchUrls = yield* listRemoteFetchUrls;
    const existing = findMatchingRemote(remoteFetchUrls);
    if (existing !== undefined) return existing;

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    return yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.ensureRemote.add",
      input.cwd,
      ["remote", "add", "--", remoteName, input.url],
      { writesSharedConfig: true },
    ).pipe(
      retryWhileConfigLocked,
      Effect.as(remoteName),
      // A parallel launch for the same fork may have added it since the listing above.
      Effect.catch((error) =>
        listRemoteFetchUrls.pipe(
          Effect.flatMap((current) => {
            const added = findMatchingRemote(current);
            return added === undefined ? Effect.fail(error) : Effect.succeed(added);
          }),
        ),
      ),
    );
  });

  const resolveComparisonBaseRef = Effect.fn("resolveComparisonBaseRef")(function* (
    cwd: string,
    baseRef: string,
  ) {
    const comparisonRef =
      baseRef.startsWith("refs/heads/") || baseRef.startsWith("refs/remotes/")
        ? baseRef
        : baseRef.includes("/") && !baseRef.startsWith("refs/")
          ? `refs/remotes/${baseRef}`
          : null;
    if (comparisonRef === null) return null;
    const resolved = yield* executeGit(
      "GitVcsDriver.resolveComparisonBaseRef",
      cwd,
      ["show-ref", "--verify", "--quiet", comparisonRef],
      { allowNonZeroExit: true },
    );
    return resolved.exitCode === 0 ? { baseRef, comparisonRef } : null;
  });

  // Tracking may point to a different remote than the primary one. Resolve its
  // full ref so a similarly named local branch or tag cannot shadow it.
  const resolveTrackedRemoteBaseRef = Effect.fn("resolveTrackedRemoteBaseRef")(function* (
    cwd: string,
    refName: string,
  ) {
    const upstream = yield* executeGit(
      "GitVcsDriver.resolveTrackedRemoteBaseRef",
      cwd,
      ["rev-parse", "--symbolic-full-name", `${refName}@{upstream}`],
      { allowNonZeroExit: true },
    );
    const comparisonRef = upstream.stdout.trim();
    if (upstream.exitCode !== 0 || !comparisonRef.startsWith("refs/remotes/")) return null;
    return { baseRef: comparisonRef.slice("refs/remotes/".length), comparisonRef };
  });

  // `allowRemoteOfCurrent` lets the review diff compare the default branch with its remote copy.
  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
    options?: {
      readonly allowRemoteOfCurrent?: boolean;
      readonly knownOriginDefaultBranch?: string | null;
    },
  ) {
    // Our worktree flow records the exact base ref, remote included; gh-merge-base
    // holds only the branch name.
    const configuredBaseRef = yield* readConfigValue(
      cwd,
      GitVcsDriver.mergeBaseRefConfigKey(refName),
    );
    if (
      configuredBaseRef?.startsWith("refs/heads/") ||
      configuredBaseRef?.startsWith("refs/remotes/")
    ) {
      const base = yield* resolveComparisonBaseRef(cwd, configuredBaseRef);
      if (base !== null) {
        const shortRef = configuredBaseRef.replace(/^refs\/remotes\//, "");
        return {
          ...base,
          baseRef: (yield* branchExists(cwd, shortRef)) ? configuredBaseRef : shortRef,
        };
      }
    }

    const configuredBaseBranch =
      (yield* readConfigValue(cwd, `branch.${refName}.gh-merge-base`)) ?? "";
    const configuredBase = yield* resolveComparisonBaseRef(cwd, configuredBaseBranch);
    if (
      configuredBase !== null &&
      configuredBaseBranch.includes("/") &&
      !configuredBaseBranch.startsWith("refs/") &&
      (yield* branchExists(cwd, configuredBaseBranch))
    ) {
      const comparisonRef = `refs/heads/${configuredBaseBranch}`;
      return { baseRef: comparisonRef, comparisonRef };
    }
    if (configuredBase !== null) return configuredBase;

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    const candidates = [
      Effect.succeed(configuredBaseBranch),
      primaryRemoteName === null
        ? Effect.succeed(null)
        : primaryRemoteName === "origin" && options?.knownOriginDefaultBranch != null
          ? Effect.succeed(options.knownOriginDefaultBranch)
          : resolveDefaultBranchName(cwd, primaryRemoteName),
      ...DEFAULT_BASE_BRANCH_CANDIDATES.map(Effect.succeed),
    ];

    for (const readCandidate of candidates) {
      const candidate = yield* readCandidate;
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0) {
        continue;
      }
      if (normalizedCandidate === refName) {
        if (options?.allowRemoteOfCurrent) {
          const trackedRemoteBase = yield* resolveTrackedRemoteBaseRef(cwd, refName);
          if (trackedRemoteBase !== null) return trackedRemoteBase;
          if (
            primaryRemoteName &&
            (yield* remoteBranchExists({
              cwd,
              remoteName: primaryRemoteName,
              refName: normalizedCandidate,
            }))
          ) {
            return {
              baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
              comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
            };
          }
        }
        continue;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists({
          cwd,
          remoteName: primaryRemoteName,
          refName: normalizedCandidate,
        }))
      ) {
        return {
          baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
          comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
        };
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return { baseRef: normalizedCandidate, comparisonRef: `refs/heads/${normalizedCandidate}` };
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    refName: string,
    options?: { readonly knownOriginDefaultBranch: string | null },
  ) {
    const base = yield* resolveBaseBranchForNoUpstream(cwd, refName, options);
    if (!base) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", "--end-of-options", `${base.comparisonRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--symbolic-full-name", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    let branch: string | null;
    if (branchResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(branchResult.stderr)) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }
      if (!isUnbornHeadStderr(branchResult.stderr)) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.statusDetailsRemote.branch",
            cwd,
            args: ["rev-parse", "--symbolic-full-name", "HEAD"],
          }),
          detail: "Git branch lookup failed.",
          exitCode: branchResult.exitCode,
          stdoutLength: branchResult.stdout.length,
          stderrLength: branchResult.stderr.length,
        });
      }

      const branchValue = yield* runGitStdout(
        "GitVcsDriver.statusDetailsRemote.unbornBranch",
        cwd,
        ["symbolic-ref", "--quiet", "HEAD"],
      );
      branch = branchNameFromHeadRef(branchValue);
    } else {
      branch = branchNameFromHeadRef(branchResult.stdout);
    }
    const currentUpstreamRef = yield* readCurrentUpstreamRef(cwd);
    let upstreamRef =
      currentUpstreamRef === null
        ? null
        : (parseUpstreamRefByFirstSeparator(currentUpstreamRef)?.upstreamRef ?? null);
    // Trimming a remote that starts with Unicode whitespace can leave a leading slash.
    if (currentUpstreamRef?.startsWith("/")) {
      upstreamRef = (yield* resolveCurrentUpstream(cwd, currentUpstreamRef))?.upstreamRef ?? null;
    }
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.orElseSucceed(() => 0),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch, {
              knownOriginDefaultBranch: defaultBranch,
            }).pipe(Effect.orElseSucceed(() => 0))
        : 0;

    return {
      isRepo: true,
      defaultBranch,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (
    cwd: string,
    options?: GitVcsDriver.GitLocalStatusOptions,
  ) {
    const includeDivergence = options?.includeDivergence !== false;
    const statusArgs = [
      "status",
      "--porcelain=2",
      "--branch",
      "-z",
      ...(includeDivergence ? [] : ["--no-ahead-behind"]),
    ];
    const indexResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.indexPath",
      cwd,
      ["rev-parse", "--git-path", "index"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (indexResult === null) return NON_REPOSITORY_STATUS_DETAILS;
    if (indexResult.exitCode === 0) {
      const lockPath = `${path.resolve(cwd, indexResult.stdout.trim())}.lock`;
      const lockError = new GitCommandError({
        operation: "GitVcsDriver.statusDetails.indexPath",
        command: "git",
        cwd,
        detail: "Git index is locked. Status will resume when the index lock is removed.",
      });
      // Status can succeed while locked, repeatedly running LFS clean filters without caching.
      if (
        yield* fileSystem.exists(lockPath).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...lockError,
                detail: "Failed to check the Git index lock.",
                cause,
              }),
          ),
        )
      ) {
        return yield* lockError;
      }
    }
    const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
      Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
    );
    const statusCacheKey = repositoryPaths?.gitCommonDir;
    const readStatus = executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.status",
      cwd,
      statusArgs,
      {
        allowNonZeroExit: true,
        maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
      },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    // diff-index does not read status output, so both spawn together; a non-repository discards it.
    const [statusResult, numstatResult, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
      [
        readStatus,
        // Plumbing, because porcelain `git diff` rewrites the index even with
        // GIT_OPTIONAL_LOCKS=0. -M keeps porcelain's rename detection.
        executeGitWithStableDiagnostics(
          "GitVcsDriver.statusDetails.numstat",
          cwd,
          ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
          { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
        ).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(parseReviewNumstat(result.stdout));
            if (isUnbornHeadStderr(result.stderr)) {
              return Effect.map(
                Effect.all([
                  runGitStdoutWithOptions(
                    "GitVcsDriver.statusDetails.numstat.unborn",
                    cwd,
                    ["diff-files", "--numstat", "-z"],
                    { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
                  ),
                  runGitStdoutWithOptions(
                    "GitVcsDriver.statusDetails.numstat.unborn.staged",
                    cwd,
                    ["diff", "--cached", "--numstat", "-z"],
                    { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
                  ),
                ]),
                ([unstagedStdout, stagedStdout]) => [
                  ...parseReviewNumstat(stagedStdout),
                  ...parseReviewNumstat(unstagedStdout),
                ],
              );
            }
            return Effect.fail(
              new GitCommandError({
                ...gitCommandContext({
                  operation: "GitVcsDriver.statusDetails.numstat",
                  cwd,
                  args: ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
                }),
                detail: "git diff-index HEAD --numstat failed.",
                exitCode: result.exitCode,
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            );
          }),
          Effect.result,
        ),
        statusCacheKey
          ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
          : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
        statusCacheKey
          ? Cache.get(originExistsCache, statusCacheKey).pipe(Effect.orElseSucceed(() => false))
          : originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
      ],
      { concurrency: "unbounded" },
    );
    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(statusResult.stderr)) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetails.status",
          cwd,
          args: statusArgs,
        }),
        detail: "Git status failed.",
        exitCode: statusResult.exitCode,
        stdoutLength: statusResult.stdout.length,
        stderrLength: statusResult.stderr.length,
      });
    }

    const numstatEntries = yield* Effect.fromResult(numstatResult);
    const statusStdout = statusResult.stdout;

    let refName: string | null = null;
    let upstreamRef: string | null = null;
    let upstreamExists = false;
    let hasCommits = true;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();
    const untrackedRoots: string[] = [];

    const statusRecords = statusStdout.split("\0");
    for (let index = 0; index < statusRecords.length; index++) {
      const line = statusRecords[index]!;
      if (line === "# branch.oid (initial)") {
        hasCommits = false;
        continue;
      }
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        upstreamExists = true;
        if (includeDivergence) {
          const parsed = parseBranchAb(line.slice("# branch.ab ".length).trim());
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
        }
        continue;
      }
      if (line.length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) {
          changedFilesWithoutNumstat.add(pathValue);
          if (line.startsWith("? ")) untrackedRoots.push(pathValue);
        }
        // A rename record is followed by its original path as a separate record. Listing it
        // keeps the deletion selectable when committing only some files.
        if (line.startsWith("2 ")) {
          const originalPath = statusRecords[++index];
          if (originalPath) changedFilesWithoutNumstat.add(originalPath);
        }
      }
    }
    // Git names a configured upstream whose ref is gone (its remote branch deleted, then
    // pruned) but leaves out `branch.ab`. Nothing is tracked then, as `@{upstream}` says;
    // read as tracked, its missing counts would pass for up to date and skip the push. A
    // branch with no commit yet never gets `branch.ab`, so its upstream stays as git names it.
    if (!upstreamExists && hasCommits) upstreamRef = null;

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    const needsFallbackAhead = includeDivergence && !upstreamRef && refName !== null;
    const needsAheadOfDefault = includeDivergence && refName !== null && !isDefaultBranch;
    const [baseAheadCount, branchChanges] = yield* Effect.all(
      [
        refName !== null && (needsFallbackAhead || needsAheadOfDefault)
          ? computeAheadCountAgainstBase(cwd, refName, {
              knownOriginDefaultBranch: defaultBranch,
            }).pipe(Effect.orElseSucceed(() => 0))
          : Effect.succeed(0),
        options?.includeBranchChanges
          ? readBranchChangeTotals(repositoryPaths?.worktreeRoot ?? cwd, refName, {
              knownOriginDefaultBranch: defaultBranch,
              untrackedRoots,
            }).pipe(Effect.orElseSucceed(() => undefined))
          : Effect.undefined,
      ],
      { concurrency: "unbounded" },
    );

    if (needsFallbackAhead) {
      aheadCount = baseAheadCount;
      behindCount = 0;
    }
    if (needsAheadOfDefault) {
      aheadOfDefaultCount = baseAheadCount;
    }

    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of numstatEntries) {
      const stat = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      stat.insertions += entry.additions;
      stat.deletions += entry.deletions;
      fileStatMap.set(entry.path, stat);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries()).map(([filePath, stat]) => {
      insertions += stat.insertions;
      deletions += stat.deletions;
      return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
    });

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        ...(repositoryPaths?.worktreeRoot ? { rootPath: repositoryPaths.worktreeRoot } : {}),
        files,
        insertions,
        deletions,
      },
      ...(branchChanges ? { branchChanges } : {}),
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd, options) {
    return yield* readStatusDetailsLocal(cwd, options);
  });

  const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
    "statusDetails",
  )(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
      }),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
    Effect.fn("statusDetailsRemote")(function* (cwd, options) {
      if (options?.refreshUpstream !== false) {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
          }),
          Effect.ignoreCause({ log: true }),
        );
      }
      return yield* readStatusDetailsRemote(cwd);
    });

  const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const stageCommitChanges = Effect.fnUntraced(function* (
    cwd: string,
    filePaths?: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) {
    const config = env
      ? ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never"]
      : [];
    if (filePaths && filePaths.length > 0) {
      if (env) {
        const head = yield* executeGit(
          "GitVcsDriver.prepareCommitContext.head",
          cwd,
          ["rev-parse", "--verify", "--quiet", "HEAD"],
          { allowNonZeroExit: true },
        );
        // Even with GIT_INDEX_FILE, reset clears the repository's merge state.
        yield* runGit(
          "GitVcsDriver.prepareCommitContext.readTree",
          cwd,
          [...config, "read-tree", ...(head.exitCode === 0 ? ["HEAD"] : ["--empty"])],
          { env },
        );
      } else {
        const mergeHeadPath = yield* runGitStdout("GitVcsDriver.commit.mergeHead", cwd, [
          "rev-parse",
          "--git-path",
          "MERGE_HEAD",
        ]);
        const isMerging = yield* fileSystem.exists(path.resolve(cwd, mergeHeadPath.trim())).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "GitVcsDriver.commit.mergeHead",
                command: "git commit",
                cwd,
                detail: "Could not check whether a merge is in progress.",
                cause,
              }),
          ),
        );
        // Like git commit --only, reject partial merges before reset can discard their ancestry.
        if (isMerging) {
          return yield* new GitCommandError({
            operation: "GitVcsDriver.commit",
            command: "git commit",
            cwd,
            detail:
              "Cannot commit selected files during a merge. Commit all files to finish the merge.",
          });
        }
        yield* runGit("GitVcsDriver.commit.reset", cwd, ["reset", "--quiet"]);
      }
      yield* runGit(
        "GitVcsDriver.commit.addSelected",
        cwd,
        // Status paths are repository-relative, while cwd can be a subdirectory.
        [...config, "add", "-A", "--", ...filePaths.map((file) => `:(top,literal)${file}`)],
        env ? { env } : {},
      );
    } else {
      yield* runGit(
        "GitVcsDriver.commit.addAll",
        cwd,
        [...config, "add", "-A"],
        env ? { env } : {},
      );
    }
  });

  const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
    Effect.fn("prepareCommitContext")(function* (cwd, filePaths, options) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const indexValue = yield* runGitStdout(
            "GitVcsDriver.prepareCommitContext.indexPath",
            cwd,
            ["rev-parse", "--git-path", "index"],
          );
          const indexPath = path.resolve(cwd, indexValue.trim());
          const scratch =
            tools === undefined
              ? undefined
              : yield* toolsIndexFor("GitVcsDriver.prepareCommitContext", cwd, indexPath);
          const directory =
            scratch?.dir ??
            (yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3code-commit-index-",
            }));
          const tempIndexPath = path.join(directory, "index");
          const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
          const config = [
            "-c",
            "core.splitIndex=false",
            "-c",
            "splitIndex.sharedIndexExpire=never",
          ];
          if (scratch ? scratch.seeded : yield* fileSystem.exists(indexPath)) {
            if (scratch === undefined) {
              const { mtime } = yield* fileSystem.stat(indexPath);
              yield* fileSystem.copyFile(indexPath, tempIndexPath);
              const indexTime = Option.isSome(mtime)
                ? Math.max(0, Math.floor(mtime.value.getTime() / 1000))
                : 0;
              yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
            }
            yield* runGit(
              "GitVcsDriver.prepareCommitContext.expandSplitIndex",
              cwd,
              [...config, "update-index", "--no-split-index"],
              { env },
            );
          } else {
            yield* runGit(
              "GitVcsDriver.prepareCommitContext.emptyIndex",
              cwd,
              [...config, "read-tree", "--empty"],
              { env },
            );
          }
          yield* stageCommitChanges(cwd, filePaths, env);

          const stagedSummary = yield* runGitStdoutWithOptions(
            "GitVcsDriver.prepareCommitContext.stagedSummary",
            cwd,
            ["diff", "--cached", "--name-status"],
            { env, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
          ).pipe(Effect.map((stdout) => stdout.trim()));
          if (stagedSummary.length === 0) {
            return null;
          }

          // A user-supplied message needs change detection, but no patch for generation.
          if (options?.includePatch === false) return { stagedSummary, stagedPatch: "" };

          const stagedPatch = yield* runGitStdoutWithOptions(
            "GitVcsDriver.prepareCommitContext.stagedPatch",
            cwd,
            ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
            {
              env,
              maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
              appendTruncationMarker: true,
            },
          );

          return {
            stagedSummary,
            stagedPatch,
          };
        }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.prepareCommitContext",
              command: "git",
              cwd,
              detail: "Failed to prepare the temporary commit index.",
              cause,
            }),
        }),
      );
    });

  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    if (options?.stage !== undefined) {
      yield* stageCommitChanges(cwd, options.stage.filePaths);
    }
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  // `push -u` exits 0 without the upstream when another writer holds the config lock.
  const recordPushedUpstream = Effect.fn("recordPushedUpstream")(
    function* (cwd: string, branch: string, remoteName: string, publishBranch: string) {
      // Without a prior upstream, Git ignores a merge ref with no remote, so losing the second
      // write leaves none rather than a wrong one.
      yield* writeConfigValue({
        cwd,
        key: `branch.${branch}.merge`,
        value: `refs/heads/${publishBranch}`,
      });
      yield* writeConfigValue({ cwd, key: `branch.${branch}.remote`, value: remoteName });
      // Matches what `push -u` sets for a remote upstream.
      const autoSetupRebase = yield* readConfigValue(cwd, "branch.autoSetupRebase");
      if (autoSetupRebase === "always" || autoSetupRebase === "remote") {
        yield* writeConfigValue({ cwd, key: `branch.${branch}.rebase`, value: "true" });
      }
      return true;
    },
    Effect.catch((cause) =>
      Effect.logWarning("pushed, but could not record the branch upstream", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  // A branch tracking a differently named ref was cut from it, the way
  // `git checkout -b feature origin/dev` and our own worktree flow leave
  // it. That upstream is the branch's base, not its publish target, and
  // pushing HEAD onto it would write feature commits to a shared branch
  // (bare `git push` refuses this under push.default=simple). The one
  // same-repo tracking setup that legitimately differs is a git-mangled
  // alias such as local `upstream/effect-atom` for my-org/upstream's
  // `effect-atom`: the branch name ends in the upstream head while the
  // upstream ref ends in the branch name.
  const isAliasOfUpstreamHead = (
    branch: string,
    upstream: { readonly branchName: string; readonly upstreamRef: string },
  ) =>
    branch === upstream.branchName ||
    (branch.endsWith(`/${upstream.branchName}`) && upstream.upstreamRef.endsWith(`/${branch}`));

  // Publishing retargets the upstream, so a base upstream is kept as the comparison base first.
  const keepUpstreamAsBase = Effect.fn("keepUpstreamAsBase")(function* (
    cwd: string,
    branch: string,
    upstream: { readonly branchName: string; readonly upstreamRef: string },
  ) {
    const configuredMergeBase = yield* runGitStdout(
      "GitVcsDriver.pushCurrentBranch.readMergeBase",
      cwd,
      ["config", "--get", `branch.${branch}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (configuredMergeBase.length > 0) return;
    yield* writeConfigValue({
      cwd,
      key: `branch.${branch}.gh-merge-base`,
      value: upstream.branchName,
    });
    if (!(yield* readConfigValue(cwd, GitVcsDriver.mergeBaseRefConfigKey(branch)))) {
      yield* writeConfigValue({
        cwd,
        key: GitVcsDriver.mergeBaseRefConfigKey(branch),
        value: `refs/remotes/${upstream.upstreamRef}`,
      });
    }
  });

  // The remote upstream a branch is configured with, even once its ref is gone.
  const readConfiguredRemoteUpstream = Effect.fn("readConfiguredRemoteUpstream")(function* (
    cwd: string,
    branch: string,
  ) {
    const stdout = yield* runGitStdout("GitVcsDriver.readConfiguredRemoteUpstream", cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(upstream)%00%(upstream:remoteref)%00%(upstream:remotename)",
      `refs/heads/${branch}`,
    ]);
    for (const line of stdout.split("\n")) {
      const [refName, upstream, remoteRef, remoteName] = line.split("\0");
      if (
        refName === `refs/heads/${branch}` &&
        upstream?.startsWith("refs/remotes/") &&
        remoteRef?.startsWith("refs/heads/") &&
        remoteName
      ) {
        return {
          upstreamRef: upstream.slice("refs/remotes/".length),
          branchName: remoteRef.slice("refs/heads/".length),
          remoteName,
        };
      }
    }
    return null;
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push from detached HEAD.",
      });
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
        cwd,
        ["push", "--", requestedRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: yield* recordPushedUpstream(cwd, branch, requestedRemoteName, publishBranch),
      };
    }

    // An upstream whose ref is gone counts as none. It still names the branch's base, or, when it carries the
    // branch's own name, the remote the branch is published on.
    const goneUpstream = details.hasUpstream
      ? null
      : yield* readConfiguredRemoteUpstream(cwd, branch).pipe(Effect.orElseSucceed(() => null));
    const goneUpstreamRemote =
      goneUpstream !== null && isAliasOfUpstreamHead(branch, goneUpstream) ? goneUpstream.remoteName : null;

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch, goneUpstreamRemote).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const publishBranch = yield* resolvePublishBranchName(cwd, branch);
        // The configured diff base can contain HEAD while the publish branch is still behind.
        const publishContainsHead = yield* executeGit(
          "GitVcsDriver.pushCurrentBranch.publishContainsHead",
          cwd,
          [
            "merge-base",
            "--is-ancestor",
            "HEAD",
            `refs/remotes/${publishRemoteName}/${publishBranch}`,
          ],
          { allowNonZeroExit: true },
        ).pipe(
          Effect.map((result) => result.exitCode === 0),
          Effect.orElseSucceed(() => false),
        );
        if (publishContainsHead) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch, goneUpstreamRemote);
      if (!publishRemoteName) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pushCurrentBranch",
            cwd,
            args: ["push"],
          }),
          detail: "Cannot push because no git remote is configured for this repository.",
        });
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      if (goneUpstream && goneUpstreamRemote === null) {
        yield* keepUpstreamAsBase(cwd, branch, goneUpstream);
      }
      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushWithUpstream",
        cwd,
        ["push", "--", publishRemoteName, `HEAD:refs/heads/${publishBranch}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: yield* recordPushedUpstream(cwd, branch, publishRemoteName, publishBranch),
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (currentUpstream) {
      if (!isAliasOfUpstreamHead(branch, currentUpstream)) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        const remoteName = publishRemoteName ?? currentUpstream.remoteName;
        const publishBranch = yield* resolvePublishBranchName(cwd, branch);
        yield* keepUpstreamAsBase(cwd, branch, currentUpstream);
        yield* runGit(
          "GitVcsDriver.pushCurrentBranch.pushOwnBranch",
          cwd,
          ["push", "--", remoteName, `HEAD:refs/heads/${publishBranch}`],
          { timeoutMs: null },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${remoteName}/${publishBranch}`,
          setUpstream: yield* recordPushedUpstream(cwd, branch, remoteName, publishBranch),
        };
      }

      yield* runGit(
        "GitVcsDriver.pushCurrentBranch.pushUpstream",
        cwd,
        ["push", "--", currentUpstream.remoteName, `HEAD:refs/heads/${currentUpstream.branchName}`],
        { timeoutMs: null },
      );
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"], { timeoutMs: null });
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  // Exit 1 is an unset key; a value that is no boolean is a rebase mode such as `merges`.
  const readPullSetting = (cwd: string, key: string) =>
    executeGit(
      "GitVcsDriver.pullCurrentBranch.readSetting",
      cwd,
      ["config", "--type=bool", "--get", key],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) =>
        result.exitCode === 0
          ? result.stdout.trim() === "true"
          : result.exitCode === 1
            ? null
            : true,
      ),
    );

  // What `git pull` gives its merge step. Autostash comes from pull.autoStash when set, else
  // from rebase.autoStash for a pull set to rebase (which `--ff-only` overrides); otherwise none
  // is passed and the merge reads merge.autoStash.
  const readPullMergeSettings = Effect.fn("readPullMergeSettings")(function* (
    cwd: string,
    refName: string,
  ) {
    const [pullAutoStash, rebaseAutoStash, branchRebase, pullRebase, recurseSubmodules] =
      yield* Effect.all(
        [
          readPullSetting(cwd, "pull.autoStash"),
          readPullSetting(cwd, "rebase.autoStash"),
          readPullSetting(cwd, `branch.${refName}.rebase`),
          readPullSetting(cwd, "pull.rebase"),
          readPullSetting(cwd, "submodule.recurse"),
        ],
        { concurrency: "unbounded" },
      );
    const rebases = branchRebase ?? pullRebase ?? false;
    return {
      autoStash: pullAutoStash ?? (rebases ? (rebaseAutoStash ?? false) : null),
      recurseSubmodules: recurseSubmodules === true,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* readStatusDetailsLocal(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Cannot pull from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Current branch has no upstream configured. Push with upstream first.",
      });
    }
    const remote = yield* readConfigValue(cwd, `branch.${refName}.remote`);
    if (remote) {
      const gitCommonDir = yield* resolveGitCommonDir(cwd);
      const pending = statusFetches.get(`${gitCommonDir}\0${remote}`);
      // The status wait can finish while its fetch still owns reference locks.
      // Let our existing writer finish before starting the pull's fetch.
      if (pending) yield* Fiber.await(pending);
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    // `git pull --ff-only` is `git fetch`, then `git merge --ff-only FETCH_HEAD` and, under
    // submodule.recurse, `git submodule update --recursive --checkout`. Run apart, only the
    // fetch, the network half, is bounded; the rest rewrites the working tree.
    const fetchOptions = { timeoutMs: 30_000, allowNonZeroExit: true };
    // After a successful pull, HEAD before and after decides the result, so its output is not
    // needed. A large fast-forward's diffstat can exceed the output cap, which must not fail a
    // pull Git applied.
    const moveOptions = {
      movesWorkingTree: true,
      appendTruncationMarker: true,
      allowNonZeroExit: true,
    };
    let args = ["fetch"];
    let result = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.pullCurrentBranch.fetch",
      cwd,
      args,
      fetchOptions,
    );
    if (result.exitCode !== 0 && isRefLockFailure(result.stderr)) {
      const [remote, mergeRefs, currentBranch, currentSha] = yield* Effect.all([
        readConfigValue(cwd, `branch.${refName}.remote`),
        runGitStdout(
          "GitVcsDriver.pullCurrentBranch.mergeRefs",
          cwd,
          ["config", "--get-all", `branch.${refName}.merge`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim().split("\n").filter(Boolean))),
        runGitStdout(
          "GitVcsDriver.pullCurrentBranch.currentBranch",
          cwd,
          ["symbolic-ref", "--quiet", "HEAD"],
          true,
        ).pipe(Effect.map(branchNameFromHeadRef)),
        runGitStdout("GitVcsDriver.pullCurrentBranch.currentSha", cwd, ["rev-parse", "HEAD"]).pipe(
          Effect.map((stdout) => stdout.trim()),
        ),
      ]);
      // A full fetch can fail on an unrelated branch's lock. Keep that fetch as the
      // default, but retry only the configured upstream before any checkout movement.
      const [mergeRef] = mergeRefs;
      if (
        remote &&
        mergeRef &&
        mergeRefs.length === 1 &&
        currentBranch === refName &&
        currentSha === beforeSha
      ) {
        args = ["fetch", "--", remote, mergeRef];
        result = yield* executeGitWithStableDiagnostics(
          "GitVcsDriver.pullCurrentBranch.fetch",
          cwd,
          args,
          fetchOptions,
        );
      }
    }
    if (result.exitCode === 0) {
      const settings = yield* readPullMergeSettings(cwd, refName);
      args = [
        "merge",
        "--ff-only",
        ...(settings.autoStash === null
          ? []
          : [settings.autoStash ? "--autostash" : "--no-autostash"]),
        "FETCH_HEAD",
      ];
      result = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.pullCurrentBranch.merge",
        cwd,
        args,
        moveOptions,
      );
      if (result.exitCode === 0 && settings.recurseSubmodules) {
        // The fetch already brought the submodules' commits, so this one never waits on the
        // network.
        args = ["submodule", "update", "--recursive", "--checkout", "--no-fetch"];
        result = yield* executeGitWithStableDiagnostics(
          "GitVcsDriver.pullCurrentBranch.updateSubmodules",
          cwd,
          args,
          moveOptions,
        );
      }
    }
    if (result.exitCode !== 0) {
      const reason = classifyGitFailure(result.stderr);
      return yield* new GitCommandError({
        ...gitCommandContext({ operation: "GitVcsDriver.pullCurrentBranch.pull", cwd, args }),
        ...(reason === null ? {} : { reason }),
        detail: fetchFailureDetail(result.stderr) ?? "git pull failed",
        exitCode: result.exitCode,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* readStatusDetailsLocal(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const commitRange = `${baseRef}..HEAD`;
    // PR diffs start at the common ancestor when the base branch has advanced.
    const diffRange = `${baseRef}...HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", "--end-of-options", commitRange],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", "--end-of-options", diffRange],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-ext-diff", "--patch", "--minimal", "--end-of-options", diffRange],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  // Use the same temporary index for patch and statistics so unstaged renames agree.
  const prepareReviewIndex = Effect.fn("prepareReviewIndex")(function* (
    cwd: string,
    untrackedPaths: ReadonlyArray<string>,
  ) {
    const [stagedDeletionsStdout, indexValue] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.stagedDeletions",
          cwd,
          ["diff", "--cached", "--name-only", "--diff-filter=D", "-z", "HEAD", "--"],
          { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
        ),
        runGitStdout("GitVcsDriver.readUnifiedWorkingTreeReviewDiff.indexPath", cwd, [
          "rev-parse",
          "--git-path",
          "index",
        ]),
      ],
      { concurrency: 2 },
    );
    const stagedDeletions = new Set(stagedDeletionsStdout.split("\0").filter(Boolean));
    const pathsToAdd = untrackedPaths.filter((relativePath) => !stagedDeletions.has(relativePath));
    if (pathsToAdd.length === 0) return undefined;

    const indexPath = path.isAbsolute(indexValue.trim())
      ? indexValue.trim()
      : path.resolve(cwd, indexValue.trim());
    const scratch =
      tools === undefined
        ? undefined
        : yield* toolsIndexFor("GitVcsDriver.prepareReviewIndex", cwd, indexPath);
    const tempIndexPath =
      scratch?.path ??
      (yield* fileSystem.makeTempFileScoped({
        prefix: `t3code-review-index-${process.pid}-`,
      }));
    const indexExists = scratch ? scratch.seeded : yield* fileSystem.exists(indexPath);
    if (indexExists && scratch === undefined) {
      const { mtime } = yield* fileSystem.stat(indexPath);
      yield* fileSystem.copyFile(indexPath, tempIndexPath);
      // Node FileSystem.stat truncates bigint timestamps to milliseconds before creating its Date.
      // Flooring preserves the source second without making preceding-second files racy.
      const indexTime = Option.isSome(mtime)
        ? Math.max(0, Math.floor(mtime.value.getTime() / 1000))
        : 0;
      yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
    }
    const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
    const tempIndexConfig = [
      "-c",
      "core.splitIndex=false",
      "-c",
      "splitIndex.sharedIndexExpire=never",
    ];
    if (!indexExists) {
      yield* executeGit("GitVcsDriver.review.emptyIndex", cwd, ["read-tree", "--empty"], { env });
    }
    yield* executeGit(
      "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.expandSplitIndex",
      cwd,
      [...tempIndexConfig, "update-index", "--no-split-index"],
      { env },
    );
    yield* executeGit(
      "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.addUntracked",
      cwd,
      [
        ...tempIndexConfig,
        // Avoid redundant tracked-entry pathspec matching in this disposable index.
        "-c",
        "core.preloadIndex=false",
        "--literal-pathspecs",
        "add",
        "--intent-to-add",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      { env, stdin: `${pathsToAdd.join("\0")}\0` },
    );
    return env;
  });

  // Before the first commit, review diffs compare with the empty tree instead of HEAD.
  const readEmptyTreeHash = Effect.fn("readEmptyTreeHash")(function* (cwd: string) {
    const stdout = yield* runGitStdout("GitVcsDriver.review.emptyTree", cwd, [
      "hash-object",
      "-t",
      "tree",
      (yield* HostProcess.Platform) === "win32" ? "NUL" : "/dev/null",
    ]);
    return stdout.trim();
  });

  // Lists untracked files and adds them to a temporary index, so a diff against any commit
  // shows them as new. Returns null when the list is too big to read or to index. Needs a Scope.
  const prepareUntrackedReviewIndex = Effect.fn("prepareUntrackedReviewIndex")(function* (
    cwd: string,
    pathArgs: ReadonlyArray<string>,
    onlyPath?: string,
  ) {
    const untracked = yield* executeGit(
      "GitVcsDriver.review.listUntracked",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathArgs],
      { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
    ).pipe(
      Effect.catchIf(
        (error) => error.outputLength === undefined,
        () => Effect.succeed(null),
      ),
    );
    if (untracked === null) return null;
    const paths = splitNullSeparatedGitStdoutPaths(untracked).filter(
      (candidate) => onlyPath === undefined || candidate === onlyPath,
    );
    if (paths.length === 0) return { env: undefined };
    if (paths.length > REVIEW_UNTRACKED_MAX_FILES) return null;
    const env = yield* prepareReviewIndex(cwd, paths).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.prepareReviewIndex",
              cwd,
              command: "git diff",
              detail: "Could not prepare the review index.",
              cause,
            }),
          ),
      }),
    );
    return { env };
  });

  // The diff panel's Changes view compares the working tree with merge-base(base, HEAD).
  // With no usable base it compares with HEAD, so Changes equals Uncommitted.
  const resolveReviewMergeBase = Effect.fn("resolveReviewMergeBase")(function* (
    cwd: string,
    branch: string | null,
    explicitBaseRef?: string,
    knownOriginDefaultBranch: string | null = null,
  ) {
    const base =
      explicitBaseRef !== undefined
        ? ((yield* resolveComparisonBaseRef(cwd, explicitBaseRef)) ?? {
            baseRef: explicitBaseRef,
            comparisonRef:
              !explicitBaseRef.startsWith("refs/") && (yield* branchExists(cwd, explicitBaseRef))
                ? `refs/heads/${explicitBaseRef}`
                : explicitBaseRef,
          })
        : branch
          ? yield* resolveBaseBranchForNoUpstream(cwd, branch, {
              allowRemoteOfCurrent: true,
              knownOriginDefaultBranch,
            }).pipe(Effect.orElseSucceed(() => null))
          : null;
    if (base === null) return { baseRef: null, mergeBase: "HEAD" };
    const { baseRef, comparisonRef } = base;
    const args = ["merge-base", "--end-of-options", comparisonRef, "HEAD"];
    const result = yield* executeGit("GitVcsDriver.resolveReviewMergeBase", cwd, args, {
      allowNonZeroExit: true,
    });
    const mergeBase = result.stdout.trim();
    if (result.exitCode !== 0 || mergeBase.length === 0) {
      // Before the first commit there is nothing to compare with, so Changes equals Uncommitted.
      const head = yield* executeGit(
        "GitVcsDriver.resolveReviewMergeBase.head",
        cwd,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        { allowNonZeroExit: true },
      );
      if (explicitBaseRef === undefined && head.exitCode !== 0) {
        return { baseRef: null, mergeBase: "HEAD" };
      }
      return yield* new GitCommandError({
        ...gitCommandContext({ operation: "GitVcsDriver.resolveReviewMergeBase", cwd, args }),
        detail: `Could not find a common commit between '${baseRef}' and HEAD.`,
        exitCode: result.exitCode,
      });
    }
    return { baseRef, mergeBase };
  });

  // Totals for the thread panel's Changes row. Same base and untracked files as the Changes view.
  const readBranchChangeTotals = Effect.fn("readBranchChangeTotals")(function* (
    cwd: string,
    branch: string | null,
    options?: {
      readonly knownOriginDefaultBranch: string | null;
      readonly untrackedRoots: ReadonlyArray<string>;
    },
  ) {
    const { baseRef, mergeBase } = yield* resolveReviewMergeBase(
      cwd,
      branch,
      undefined,
      options?.knownOriginDefaultBranch ?? null,
    );
    const roots = options?.untrackedRoots ?? [];
    // Bound pathspec matching work and stay below Windows' command-line limit.
    const pathspecs =
      roots.length <= 128 && roots.reduce((length, root) => length + root.length + 16, 0) < 8_000
        ? roots.map((root) => `:(top,literal)${root}`)
        : [];
    // Empty status can mean untracked files are hidden; retain the full scan.
    const untracked = yield* prepareUntrackedReviewIndex(cwd, pathspecs);
    if (untracked === null) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.readBranchChangeTotals",
        command: "git ls-files",
        cwd,
        detail: "Too many untracked files to count.",
      });
    }
    const readNumstat = (ref: string) =>
      executeGit(
        "GitVcsDriver.readBranchChangeTotals",
        cwd,
        [...REVIEW_DIFF_ARGS, "--numstat", "-z", ref, "--"],
        {
          allowNonZeroExit: true,
          maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
          env: untracked.env,
        },
      );
    let result = yield* readNumstat(mergeBase);
    if (result.exitCode !== 0 && mergeBase === "HEAD" && isUnbornHeadStderr(result.stderr)) {
      result = yield* readNumstat(yield* readEmptyTreeHash(cwd));
    }
    if (result.exitCode !== 0) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.readBranchChangeTotals",
        command: "git diff --numstat",
        cwd,
        detail: "Could not read Changes totals.",
        exitCode: result.exitCode,
      });
    }
    let insertions = 0;
    let deletions = 0;
    for (const file of parseReviewNumstat(result.stdout)) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return { baseRef, insertions, deletions };
  }, Effect.scoped);

  const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const pathArgs = input.file
      ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])].map(
          (path) => `:(top,literal)${path}`,
        )
      : [];
    const patchLimit = input.file
      ? REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES
      : REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES;
    const repository = yield* resolveRepositoryPathsUncached(input.cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (!repository?.worktreeRoot) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const cwd = repository.worktreeRoot;
    // A per-file request only reads its own source.
    const dirtyRef = input.file?.sourceKind === "branch-range" ? null : "HEAD";
    const review =
      input.file?.sourceKind === "working-tree"
        ? { baseRef: input.baseRef ?? null, mergeBase: null }
        : yield* resolveReviewMergeBase(cwd, repository.currentBranch, input.baseRef);

    const diffArgs = [
      ...REVIEW_DIFF_ARGS,
      "--minimal",
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const readStats = Effect.fn("GitVcsDriver.getReviewDiffPreview.stat")(function* (
      ref: string,
      env?: NodeJS.ProcessEnv,
    ) {
      const args = [...diffArgs, "--numstat", "-z"];
      const result = yield* executeGit(
        "GitVcsDriver.getReviewDiffPreview.stat",
        cwd,
        [...args, ref, "--", ...pathArgs],
        { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES, env },
      );
      if (result.exitCode === 0) return { ref, files: parseReviewNumstat(result.stdout) };
      if (ref === "HEAD" && isUnbornHeadStderr(result.stderr)) {
        const emptyTree = yield* readEmptyTreeHash(cwd);
        const stdout = yield* runGitStdoutWithOptions(
          "GitVcsDriver.getReviewDiffPreview.unbornStat",
          cwd,
          [...args, emptyTree, "--", ...pathArgs],
          { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES, env },
        );
        return { ref: emptyTree, files: parseReviewNumstat(stdout) };
      }
      return yield* new GitCommandError({
        operation: "GitVcsDriver.getReviewDiffPreview.stat",
        cwd,
        command: "git diff --numstat",
        detail: "Could not read complete diff statistics.",
        exitCode: result.exitCode,
      });
    });
    // One commit argument diffs that commit against the working tree.
    const readTrackedDiff = Effect.fn("GitVcsDriver.getReviewDiffPreview.tracked")(function* (
      ref: string | null,
      env?: NodeJS.ProcessEnv,
    ) {
      if (ref === null) return { stdout: "", stdoutTruncated: false, files: [] };
      const stat = yield* readStats(ref, env);
      if (stat.files.length === 0) return { stdout: "", stdoutTruncated: false, files: [] };
      const patch = yield* executeGit(
        "GitVcsDriver.getReviewDiffPreview.patch",
        cwd,
        [...diffArgs, "--patch", stat.ref, "--", ...pathArgs],
        { maxOutputBytes: patchLimit, appendTruncationMarker: true, env },
      );
      return { ...patch, files: stat.files };
    });
    const [dirtyTrackedResult, baseResult] = yield* Effect.gen(function* () {
      const untracked = yield* prepareUntrackedReviewIndex(cwd, pathArgs, input.file?.path);
      // With no base both sources diff HEAD, so read it once.
      const [dirty, base] =
        review.mergeBase === dirtyRef
          ? yield* readTrackedDiff(dirtyRef, untracked?.env).pipe(
              Effect.map((result) => [result, result] as const),
            )
          : yield* Effect.all(
              [
                readTrackedDiff(dirtyRef, untracked?.env),
                readTrackedDiff(review.mergeBase, untracked?.env),
              ],
              { concurrency: 2 },
            );
      if (untracked !== null) return [dirty, base] as const;
      // Too many untracked files to list: show tracked changes and mark totals incomplete.
      const incomplete = (ref: string | null, result: typeof dirty) =>
        ref === null ? result : { ...result, files: undefined, stdoutTruncated: true };
      return [incomplete(dirtyRef, dirty), incomplete(review.mergeBase, base)] as const;
    }).pipe(Effect.scoped);
    const dirtyFiles = dirtyTrackedResult.files;
    const baseFiles = baseResult.files;
    const dirtyDiff = dirtyTrackedResult.stdout;
    const baseDiff = baseResult.stdout;
    const hashDiff = (diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
      digest.digest(Digest.sha256, new TextEncoder().encode(JSON.stringify([diff, files]))).pipe(
        Effect.map(Hex.encode),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd,
              detail: "Failed to hash review diff.",
              cause,
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirtyDiff, dirtyFiles ?? []),
      hashDiff(baseDiff, baseFiles ?? []),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Uncommitted",
        baseRef: "HEAD",
        headRef: null,
        diff: dirtyDiff,
        ...(dirtyFiles === undefined ? {} : { files: dirtyFiles }),
        diffHash: dirtyDiffHash,
        truncated: dirtyTrackedResult.stdoutTruncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: review.baseRef ? `Changes vs ${review.baseRef}` : "Changes",
        baseRef: review.baseRef,
        // For display only. The new side is the working tree.
        headRef: repository.currentBranch ?? "HEAD",
        diff: baseDiff,
        ...(baseFiles === undefined ? {} : { files: baseFiles }),
        diffHash: baseDiffHash,
        truncated: baseResult.stdoutTruncated,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    };
  });

  const reviewDiffFileError = (
    input: ReviewDiffFileContentsInput,
    detail: string,
    cause?: unknown,
  ) =>
    new GitCommandError({
      operation: "GitVcsDriver.getReviewDiffFileContents",
      command: "git",
      cwd: input.cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const readReviewFileAtRevision = Effect.fn("readReviewFileAtRevision")(function* (
    input: ReviewDiffFileContentsInput,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.getReviewDiffFileContents.revision",
      input.cwd,
      ["show", "--end-of-options", `${revision}:${relativePath}`],
      { maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.stdout.includes("\0")) {
      return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
    }
    return result.stdout;
  });

  const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
  ) {
    const fileError = (stage: string, detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: `GitVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
        command: stage,
        cwd: input.cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const requestedPath = path.resolve(repositoryRoot, input.newPath);
    if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
      return yield* fileError(
        "path.resolve",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const [realRepositoryRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(requestedPath),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
      ),
    );
    if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
      return yield* fileError(
        "fs.realPath",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }
    if (yield* isServerInternalPath(realTarget)) {
      return yield* fileError("fs.realPath", `Diff file '${input.newPath}' is not available.`);
    }

    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
    }
    if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
      return yield* fileError(
        "fs.stat",
        `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
      );
    }

    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
    }
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  });

  // Both views compare a commit with the working tree: HEAD for Uncommitted,
  // merge-base(base, HEAD) for Changes. The new side always comes from disk.
  const getReviewDiffFileContents = Effect.fn("getReviewDiffFileContents")(function* (
    input: ReviewDiffFileContentsInput,
  ) {
    const repositoryRoot = yield* runGitStdout(
      "GitVcsDriver.getReviewDiffFileContents.repositoryRoot",
      input.cwd,
      ["rev-parse", "--show-toplevel"],
    ).pipe(Effect.map((value) => value.trim()));
    if (repositoryRoot.length === 0) {
      return yield* reviewDiffFileError(input, "Could not resolve the Git repository root.");
    }
    const oldRevision =
      input.sourceKind === "working-tree"
        ? (input.baseRef ?? "HEAD")
        : (yield* resolveReviewMergeBase(input.cwd, null, input.baseRef ?? undefined)).mergeBase;
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readReviewFileAtRevision(input, oldRevision, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readWorkingTreeReviewFile(input, repositoryRoot),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  // Git never waits for .git/config.lock, and git run outside the runtime, such as an
  // agent's, can hold it. Only writes that are safe to repeat retry.
  const retryWhileConfigLocked = <A>(effect: Effect.Effect<A, GitCommandError>) =>
    effect.pipe(
      Effect.retry({
        while: (error) => error.reason === "config_locked",
        times: 10,
        schedule: Schedule.spaced("50 millis"),
      }),
    );

  const writeConfigValue: GitVcsDriver.GitVcsDriver["Service"]["writeConfigValue"] = Effect.fn(
    "writeConfigValue",
  )(function* (input) {
    yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.writeConfigValue",
      input.cwd,
      ["config", input.key, input.value],
      { writesSharedConfig: true },
    ).pipe(retryWhileConfigLocked);
  });

  // `git branch` does not read a lone - as the previous checkout.
  const branchStartPoint = (input: GitVcsDriver.GitCreateBranchInput) =>
    input.startPoint === "-" ? "@{-1}" : input.startPoint;

  // `git branch` writes a remote start point's upstream itself and fails outright if the
  // config is locked, so tracking is recorded afterwards by a write that retries.
  const makeBranch = (
    operation: string,
    input: GitVcsDriver.GitCreateBranchInput,
    fallbackErrorDetail: string,
  ) =>
    executeGitWithStableDiagnostics(
      operation,
      input.cwd,
      ["branch", "--no-track", "--", input.branch, branchStartPoint(input)],
      { fallbackErrorDetail },
    );

  const trackStartPoint = Effect.fn("trackStartPoint")(function* (
    operation: string,
    input: GitVcsDriver.GitCreateBranchInput,
  ) {
    const startPoint = branchStartPoint(input);
    const startRef = yield* executeGit(
      `${operation}.resolveStartPoint`,
      input.cwd,
      ["rev-parse", "--symbolic-full-name", startPoint],
      { allowNonZeroExit: true },
    ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
    if (!startRef.startsWith("refs/remotes/")) return;
    yield* executeGitWithStableDiagnostics(
      `${operation}.track`,
      input.cwd,
      ["branch", `--set-upstream-to=${startRef}`, "--", input.branch],
      { writesSharedConfig: true },
    ).pipe(
      retryWhileConfigLocked,
      Effect.catch((cause) =>
        Effect.logWarning("created the branch without tracking its start point", { cause }),
      ),
    );
  });

  const createBranchAt = Effect.fn("createBranchAt")(function* (
    operation: string,
    input: GitVcsDriver.GitCreateBranchInput,
    fallbackErrorDetail: string,
  ) {
    yield* makeBranch(operation, input, fallbackErrorDetail);
    yield* trackStartPoint(operation, input);
  });

  // A branch made for one operation goes again when that operation fails or is interrupted,
  // so a failed attempt leaves no branch behind to block the next one under the same name.
  const withNewBranch = <A, E>(
    operation: string,
    input: GitVcsDriver.GitCreateBranchInput,
    fallbackErrorDetail: string,
    use: Effect.Effect<A, E>,
  ) =>
    Effect.acquireUseRelease(
      makeBranch(operation, input, fallbackErrorDetail),
      () => trackStartPoint(operation, input).pipe(Effect.andThen(use)),
      (_, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : deleteLocalBranch({ cwd: input.cwd, refName: input.branch, force: true }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("could not remove the branch of a failed operation", { cause }),
              ),
            ),
    );

  const createBranch: GitVcsDriver.GitVcsDriver["Service"]["createBranch"] = Effect.fn(
    "createBranch",
  )(function* (input) {
    yield* refuseOptionLikeRefName("GitVcsDriver.createBranch", input.cwd, input.startPoint);
    yield* createBranchAt("GitVcsDriver.createBranch", input, "git branch create failed");
  });

  const resolveBranchBase = Effect.fn("GitVcsDriver.resolveBranchBase")(function* (
    cwd: string,
    refName: string,
  ) {
    const result = yield* executeGit(
      "GitVcsDriver.resolveBranchName.resolveRef",
      cwd,
      ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", refName],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      // Remote-only bases are often recorded by their unqualified branch name.
      const remoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
        Effect.orElseSucceed(() => null),
      );
      return remoteName && (yield* remoteBranchExists({ cwd, remoteName, refName }))
        ? { baseRef: `refs/remotes/${remoteName}/${refName}`, branchName: refName }
        : null;
    }
    const ref = result.stdout.trim();
    if (ref.startsWith("refs/heads/")) {
      const branchName = ref.slice("refs/heads/".length);
      return { baseRef: ref, branchName };
    }
    if (!ref.startsWith("refs/remotes/")) return null;
    const remoteNames = yield* listRemoteNames(cwd);
    const remoteRef = parseRemoteRefWithRemoteNames(
      ref.slice("refs/remotes/".length),
      remoteNames.toSorted((left, right) => right.length - left.length),
    );
    return remoteRef ? { baseRef: ref, branchName: remoteRef.branchName } : null;
  });

  const resolveBranchName = Effect.fn("GitVcsDriver.resolveBranchName")(function* (
    cwd: string,
    refName: string,
  ) {
    const base = yield* resolveBranchBase(cwd, refName);
    return base?.branchName ?? null;
  });

  const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    const gitDirArgs = ["--git-dir", gitCommonDir] as const;
    const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
      [
        executeGitWithStableDiagnostics(
          "GitVcsDriver.listRefs.snapshotRefs",
          fetchCwd,
          [
            ...gitDirArgs,
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
            "refs/heads",
            "refs/remotes",
          ],
          {
            timeoutMs: 30_000,
            maxOutputBytes: 16 * 1024 * 1024,
            fallbackErrorDetail: "Git ref snapshot enumeration failed.",
          },
        ),
        executeGit(
          "GitVcsDriver.listRefs.defaultRef",
          fetchCwd,
          [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeWorktreeList("GitVcsDriver.listRefs.worktreeList", fetchCwd, gitDirArgs, {
          timeoutMs: 30_000,
          allowNonZeroExit: true,
          maxOutputBytes: 16 * 1024 * 1024,
        }),
        executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: 2 },
    );

    const remoteNames =
      remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;
    const parsedWorktreeEntries =
      worktreeListResult.exitCode === 0
        ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
            ([branchName, worktreePath]) =>
              [branchName, path.normalize(path.resolve(worktreePath))] as const,
          )
        : [];
    // Without `core.worktree`, Git reports a separate git dir as the main checkout.
    const normalizedGitCommonDir = path.normalize(path.resolve(gitCommonDir));
    const existingWorktreeEntries = yield* Effect.filter(
      parsedWorktreeEntries,
      ([, worktreePath]) =>
        worktreePath === normalizedGitCommonDir
          ? Effect.succeed(false)
          : fileSystem.stat(worktreePath).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
      { concurrency: 16 },
    );
    const worktreeMap = new Map(existingWorktreeEntries);
    const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
    const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];

    for (const line of refsResult.stdout.split("\n")) {
      if (line.length === 0) continue;
      const [fullRefName, lastCommitRaw, symbolicTarget] = line.split("\t");
      if (!fullRefName || symbolicTarget) continue;
      const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

      if (fullRefName.startsWith("refs/heads/")) {
        const name = fullRefName.slice("refs/heads/".length);
        localBranches.push({
          ref: {
            name,
            current: false,
            isRemote: false,
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          },
          lastCommit,
        });
        continue;
      }
      if (!fullRefName.startsWith("refs/remotes/")) continue;

      const name = fullRefName.slice("refs/remotes/".length);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
      const remoteBranch: VcsRef = {
        name,
        current: false,
        isRemote: true,
        isDefault:
          defaultBranch !== null &&
          parsedRemoteRef?.remoteName === "origin" &&
          parsedRemoteRef.branchName === defaultBranch,
        worktreePath: null,
        ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
      };
      remoteBranches.push({ ref: remoteBranch, lastCommit });
    }

    const byRecencyThenName = (
      left: { readonly ref: VcsRef; readonly lastCommit: number },
      right: { readonly ref: VcsRef; readonly lastCommit: number },
    ) =>
      left.lastCommit !== right.lastCommit
        ? right.lastCommit - left.lastCommit
        : left.ref.name.localeCompare(right.ref.name);

    return {
      localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
      hasPrimaryRemote: remoteNames.includes("origin"),
    } satisfies GitRefsSnapshot;
  });

  const listRefsEpochByCommonDir = new Map<string, number>();
  let listRefsEpochSequence = 0;
  const bumpListRefsEpoch = (gitCommonDir: string): number => {
    const nextEpoch = ++listRefsEpochSequence;
    listRefsEpochByCommonDir.delete(gitCommonDir);
    listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);
    if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsEpochByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsEpochByCommonDir.delete(oldestKey);
      }
    }
    return nextEpoch;
  };
  const listRefsGenerationByCommonDir = new Map<string, number>();
  let listRefsGenerationSequence = 0;
  const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
    listRefsGenerationByCommonDir.delete(gitCommonDir);
    listRefsGenerationByCommonDir.set(gitCommonDir, generation);
    if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
      const oldestKey = listRefsGenerationByCommonDir.keys().next().value;
      if (oldestKey !== undefined) {
        listRefsGenerationByCommonDir.delete(oldestKey);
      }
    }
    return generation;
  };
  const currentListRefsGeneration = (gitCommonDir: string): number => {
    const current = listRefsGenerationByCommonDir.get(gitCommonDir);
    return current === undefined
      ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
      : setListRefsGeneration(gitCommonDir, current);
  };
  const bumpListRefsGeneration = (gitCommonDir: string): number =>
    setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);
  const listRefsSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
    (cacheKey: GitRefsRefreshCacheKey) =>
      Effect.suspend(() => {
        const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);
        return Cache.get(
          listRefsSnapshotCache,
          new GitRefsSnapshotCacheKey({ gitCommonDir: cacheKey.gitCommonDir, epoch }),
        );
      }),
    {
      capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
    },
  );
  const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
    gitCommonDir: string,
    refresh: boolean,
  ) {
    while (true) {
      const generation = currentListRefsGeneration(gitCommonDir);
      const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
      const snapshot =
        refresh || currentEpoch === undefined
          ? // The refresh cache owns the complete snapshot read, rather than only the
            // epoch bump. Slow repositories therefore remain singleflight for the
            // entire Git scan even when more refresh requests arrive after the
            // coalescing TTL would otherwise have elapsed.
            yield* Cache.get(
              listRefsRefreshSnapshotCache,
              new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
            )
          : yield* Cache.get(
              listRefsSnapshotCache,
              new GitRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
            );
      if (currentListRefsGeneration(gitCommonDir) === generation) {
        return snapshot;
      }
    }
  });
  const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
    cwd: string,
    gitCommonDir?: string | null,
  ) {
    const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
    const commonDir =
      gitCommonDir === undefined
        ? (yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey))?.gitCommonDir
        : gitCommonDir;
    if (commonDir == null) return;
    const previousGeneration = currentListRefsGeneration(commonDir);
    bumpListRefsGeneration(commonDir);
    bumpListRefsEpoch(commonDir);
    yield* Cache.invalidate(
      listRefsRefreshSnapshotCache,
      new GitRefsRefreshCacheKey({
        gitCommonDir: commonDir,
        generation: previousGeneration,
      }),
    );
    yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
    yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
  });

  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const repositoryPaths = yield* resolveRepositoryPaths(input.cwd, input.refresh === true).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (repositoryPaths === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }

      const snapshot = yield* resolveListRefsSnapshot(
        repositoryPaths.gitCommonDir,
        input.refresh === true,
      );
      const hasCurrentWorktreeBranch =
        repositoryPaths.worktreeRoot !== null &&
        snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);
      const localBranches = snapshot.localBranches.map((ref) => ({
        ...ref,
        worktreePath:
          ref.worktreePath ??
          (ref.name === repositoryPaths.currentBranch ? repositoryPaths.worktreeRoot : null),
        current: hasCurrentWorktreeBranch
          ? ref.worktreePath === repositoryPaths.worktreeRoot
          : ref.name === repositoryPaths.currentBranch,
      }));
      const combinedBranches = input.includeMatchingRemoteRefs
        ? [...localBranches, ...snapshot.remoteBranches]
        : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);
      // Keep current/default refs on the first page even when the default
      // only exists as origin/<default> (remote refs sort after all locals).
      const allBranches = combinedBranches.toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        return leftPriority - rightPriority;
      });
      const branchesForKind =
        input.refKind === "local"
          ? allBranches.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allBranches.filter((ref) => ref.isRemote)
            : allBranches;
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(branchesForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: snapshot.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input, options) {
    yield* refuseOptionLikeRefName("GitVcsDriver.createWorktree", input.cwd, input.refName);
    yield* refuseOptionLikeRefName("GitVcsDriver.createWorktree", input.cwd, input.newRefName);
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    // resolve: a cwd like `<repo>/sub/..` must not name the folder `..`.
    const repoName = path.basename(path.resolve(input.cwd));
    let worktreePath = input.path;
    if (worktreePath == null) {
      const parentDir = resolveWorktreesDirectory(
        options?.worktreesDirectory ?? "",
        worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      );
      if (parentDir === null) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.createWorktree",
          command: "git worktree add",
          cwd: input.cwd,
          detail: `The worktree location "${options?.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Storage.`,
        });
      }
      let directoryName = sanitizedBranch;
      // Leave room for files beneath the worktree on Windows, regardless of branch length.
      if (directoryName.length > 40) {
        const branchDigest = yield* digest.digest(
          Digest.sha256,
          new TextEncoder().encode(targetBranch),
        );
        // Avoid splitting a surrogate pair, which Git would list back as a different path.
        const prefix = directoryName.slice(0, 23).replace(/[\uD800-\uDBFF]$/, "");
        directoryName = `${prefix}-${Hex.encode(branchDigest).slice(0, 16)}`;
      }
      worktreePath = path.join(parentDir, repoName, directoryName);
    }
    // A removal a stopped runtime left half done still holds its branch in Git (worktreeRemoval.ts).
    const commonDir = yield* gitCommonDirOf(input.cwd).pipe(Effect.orElseSucceed(() => null));
    if (commonDir !== null) {
      yield* recoverWorktreeTrash(commonDir, pruneWorktrees({ cwd: input.cwd })).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }
    const checkoutWorkers = (yield* readConfigValue(input.cwd, "checkout.workers")) ?? "0";
    const args = ["worktree", "add", "--", worktreePath, input.newRefName ?? input.refName];
    const progress = options?.progress;
    const onCheckoutProgress = progress?.onCheckoutProgress;

    const addWorktree = executeGitWithStableDiagnostics(
      "GitVcsDriver.createWorktree",
      input.cwd,
      ["-c", `checkout.workers=${checkoutWorkers}`, ...args],
      {
        fallbackErrorDetail: "git worktree add failed",
        checksOutFiles: true,
        // Large checkouts and post-checkout hooks can legitimately run for many
        // minutes; a fixed deadline kills them and leaves an orphaned worktree.
        timeoutMs: null,
        ...(onCheckoutProgress
          ? {
              // Git only prints checkout progress when stderr is a tty or the
              // delay elapsed. GIT_PROGRESS_DELAY=0 forces it through the pipe.
              env: { GIT_PROGRESS_DELAY: "0" },
              progress: {
                onStderrLine: (line) => {
                  const parsed = parseGitCheckoutProgressLine(line);
                  return parsed ? onCheckoutProgress(parsed) : Effect.void;
                },
              },
            }
          : {}),
      },
    );
    // The branch is made apart from the checkout so the shared-config lock only covers its
    // tracking write. Git removes the folder of a worktree it failed to check out, but not
    // that branch.
    yield* input.newRefName
      ? withNewBranch(
          "GitVcsDriver.createWorktree.createBranch",
          { cwd: input.cwd, branch: input.newRefName, startPoint: input.refName },
          "git worktree add failed",
          addWorktree,
        )
      : addWorktree;

    if (progress?.onWorktreeClaimed) {
      yield* progress.onWorktreeClaimed(worktreePath);
    }

    // The checkout git just wrote is racily clean (its files as new as its index), and every later git here runs with
    // GIT_OPTIONAL_LOCKS=0, so no status ever saves a refreshed index: each git status or diff in the worktree re-read
    // the whole checkout (~0.5 s a call on an 8,000-file repository, 58 ms after). One refresh with the lock, while
    // nothing else uses the new worktree yet, settles the index for good. Best-effort.
    yield* executeGit("GitVcsDriver.createWorktree.refreshIndex", worktreePath, ["update-index", "-q", "--refresh"], {
      allowNonZeroExit: true,
      env: { GIT_OPTIONAL_LOCKS: "1" },
      timeoutMs: WORKTREE_REFRESH_INDEX_TIMEOUT_MS,
    }).pipe(Effect.ignore);

    // `git worktree add` leaves submodules empty, so a repo that keeps agent
    // skills, tooling or source in one gets a worktree that is quietly missing
    // them. Best-effort: the objects are usually already in the parent's
    // `.git/modules`, but a first-ever clone needs the network, and failing to
    // populate a submodule must not roll back the caller's thread. Repos with
    // hundreds of nested submodules opt out or stop at the top level; the
    // caller resolves that from settings, or the checkout's t3.json decides.
    const hasSubmodules = yield* fileSystem
      .exists(path.join(worktreePath, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => false));
    const submoduleMode = !hasSubmodules
      ? { value: "none" as const, source: "environment" as const }
      : resolveProjectFileBackedSetting(
          "worktreeSubmodules",
          options?.submodules ?? null,
          options?.submodules != null
            ? null
            : yield* fileSystem.readFileString(path.join(worktreePath, T3_PROJECT_FILE_NAME)).pipe(
                Effect.flatMap((contents) => {
                  const file = parseT3ProjectFile(contents);
                  return file === null
                    ? Effect.logWarning("t3.json is invalid; initializing submodules recursively", {
                        worktreePath,
                      }).pipe(Effect.as(null))
                    : Effect.succeed(file);
                }),
                Effect.orElseSucceed(() => null),
              ),
        );
    if (hasSubmodules && submoduleMode.value === "none" && progress?.onSubmodulesDisabled) {
      yield* progress.onSubmodulesDisabled({
        source: submoduleMode.source === "t3.json" ? "t3.json" : "settings",
      });
    }
    if (submoduleMode.value !== "none") {
      if (progress?.onSubmodulesStarted) {
        yield* progress.onSubmodulesStarted();
      }
      const onSubmoduleLine = progress?.onSubmoduleLine;
      // Registering submodule URLs writes the shared config; the clones that follow do not.
      yield* runGit(
        "GitVcsDriver.createWorktree.initSubmodules",
        worktreePath,
        ["submodule", "init"],
        { writesSharedConfig: true },
      ).pipe(
        Effect.andThen(
          runGit(
            "GitVcsDriver.createWorktree.updateSubmodules",
            worktreePath,
            submoduleMode.value === "recursive"
              ? ["submodule", "update", "--init", "--recursive"]
              : ["submodule", "update", "--init"],
            {
              // Cloning scales with remote size; let it finish or be cancelled, like worktree add.
              timeoutMs: null,
              ...(onSubmoduleLine
                ? {
                    // English messages to parse, with the person's own encoding kept for hooks.
                    env: { LANGUAGE: "C" },
                    progress: { onStdoutLine: onSubmoduleLine, onStderrLine: onSubmoduleLine },
                  }
                : {}),
            },
          ),
        ),
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning("worktree submodule checkout failed; submodule paths are empty", {
              worktreePath,
              cause,
            }).pipe(
              Effect.andThen(
                progress?.onSubmodulesFinished
                  ? progress.onSubmodulesFinished({ ok: false, detail: cause.message })
                  : Effect.void,
              ),
            ),
          onSuccess: () =>
            progress?.onSubmodulesFinished
              ? progress.onSubmodulesFinished({ ok: true, detail: null })
              : Effect.void,
        }),
      );
    }

    if (input.newRefName && input.baseRefName) {
      const newRefName = input.newRefName;
      // A checkout can start at a commit or tag, but a PR must target a branch.
      const base = yield* resolveBranchBase(input.cwd, input.baseRefName);
      if (base) {
        yield* Effect.gen(function* () {
          yield* writeConfigValue({
            cwd: input.cwd,
            key: `branch.${newRefName}.gh-merge-base`,
            value: base.branchName,
          });
          if (base.baseRef.startsWith("refs/remotes/")) {
            // gh reads its key as a branch on the provider; Caveman Code also keeps
            // the remote that was picked, so diffs and PRs compare against it.
            yield* writeConfigValue({
              cwd: input.cwd,
              key: GitVcsDriver.mergeBaseRefConfigKey(newRefName),
              value: base.baseRef,
            });
          }
        }).pipe(
          Effect.catchTags({
            GitCommandError: () =>
              Effect.logWarning(
                "worktree base-ref configuration failed; using base-branch fallback",
              ),
          }),
        );
      }
    }

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorDetail: "git fetch pull request branch failed",
        },
      );
    });

  const resolveCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveCommit"] = Effect.fn(
    "resolveCommit",
  )(function* (input) {
    const commitSha = yield* runGitStdout("GitVcsDriver.resolveCommit", input.cwd, [
      "rev-parse",
      "--verify",
      `${input.revision}^{commit}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const fetchPullRequestHeadCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestHeadCommit"] =
    Effect.fn("fetchPullRequestHeadCommit")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      // No refspec destination: the pull head lands in FETCH_HEAD (per worktree) instead of a
      // branch, which is the only way to read it while that branch is checked out somewhere.
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestHeadCommit",
        input.cwd,
        ["fetch", "--quiet", "--no-tags", "--", remoteName, `refs/pull/${input.prNumber}/head`],
        {
          fallbackErrorDetail: "git fetch pull request head failed",
        },
      );

      return yield* resolveCommit({ cwd: input.cwd, revision: "FETCH_HEAD" });
    });

  const refreshCheckedOutBranch: GitVcsDriver.GitVcsDriver["Service"]["refreshCheckedOutBranch"] =
    Effect.fn("refreshCheckedOutBranch")(function* (input) {
      const { commitSha: headCommit } = yield* resolveCommit({ cwd: input.cwd, revision: "HEAD" });
      if (headCommit === input.targetCommit) {
        return { headCommit, moved: false, onTarget: true };
      }

      const worktreeChanges = yield* runGitStdout(
        "GitVcsDriver.refreshCheckedOutBranch.status",
        input.cwd,
        ["status", "--porcelain"],
      );
      if (worktreeChanges.trim().length > 0) {
        return { headCommit, moved: false, onTarget: false };
      }

      const isAncestor = yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.isAncestor",
        input.cwd,
        ["merge-base", "--is-ancestor", headCommit, input.targetCommit],
        { allowNonZeroExit: true },
      ).pipe(Effect.map((result) => result.exitCode === 0));
      // A rewritten head (rebase, squash, amend) does not descend from the checkout, so it can
      // only be taken by resetting. That is lossless exactly when the tree is clean and HEAD
      // never left the commit the upstream held before the fetch.
      if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
        return { headCommit, moved: false, onTarget: false };
      }

      if (!isAncestor) {
        // The commit being reset away is about to be reachable from nothing. It is only ever a
        // commit the remote already held, but "the remote held it" stops being a way back once
        // the head it belonged to has been rewritten, so a ref keeps it findable.
        yield* executeGit(
          "GitVcsDriver.refreshCheckedOutBranch.keepPrevious",
          input.cwd,
          ["update-ref", "refs/t3code/pre-refresh", headCommit],
          { fallbackErrorDetail: "git failed to record the previous checkout commit" },
        );
      }

      yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.move",
        input.cwd,
        // `--merge` rather than `--hard`: the cleanliness check above is a snapshot, and another
        // thread may edit a tracked file between it and this move. Git itself refuses a `--merge`
        // reset that would overwrite such an edit — the same guarantee `--ff-only` gives the
        // other branch — so a race loses nothing; the refresh fails and is reported instead.
        isAncestor
          ? ["merge", "--ff-only", input.targetCommit]
          : ["reset", "--merge", input.targetCommit],
        {
          movesWorkingTree: true,
          fallbackErrorDetail: "git failed to move the checkout onto the pull request head",
        },
      );

      return { headCommit: input.targetCommit, moved: true, onTarget: true };
    });

  const fetchRemote = Effect.fn("fetchRemote")(function* (input: GitVcsDriver.GitFetchRemoteInput) {
    const args = ["fetch", "--quiet", "--", input.remoteName];
    const options = {
      env: STATUS_UPSTREAM_REFRESH_ENV,
      fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
    };
    // Another fetch in the same repository, such as the background status
    // poll or one of many agents' own, can win the race for a remote-tracking
    // ref. The loser fails, and the ref is free again soon after, so it runs
    // again: a few times, since with many fetches at once the next can lose too.
    const runFetch = (fetchArgs: readonly string[]) => {
      const run = executeGitWithStableDiagnostics(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        fetchArgs,
        {
          ...options,
          allowNonZeroExit: true,
        },
      );
      return rerunLostRaces(
        () => run,
        (result) => result.exitCode !== 0 && isRefLockFailure(result.stderr),
        REF_LOCK_FIRST_WAIT_MS,
      );
    };
    const fetchAll = runFetch(args).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new GitCommandError({
                ...gitCommandContext({
                  operation: "GitVcsDriver.fetchRemote",
                  cwd: input.cwd,
                  args,
                }),
                detail: fetchFailureDetail(result.stderr) ?? options.fallbackErrorDetail,
                ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
                stdoutLength: result.stdout.length,
                stderrLength: result.stderr.length,
              }),
            ),
      ),
    );
    if (input.refName === undefined) {
      return yield* fetchAll.pipe(Effect.as(true));
    }
    const branch =
      parseRemoteRefWithRemoteNames(input.refName, [input.remoteName])?.branchName ?? input.refName;
    const scopedArgs = [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      input.remoteName,
      `+refs/heads/${branch}:refs/remotes/${input.remoteName}/${branch}`,
    ];
    const result = yield* runFetch(scopedArgs);
    if (result.exitCode === 0) return true;
    if (
      result.stderr.split(/\r?\n/).includes(`fatal: couldn't find remote ref refs/heads/${branch}`)
    ) {
      return false;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.fetchRemote",
        cwd: input.cwd,
        args: scopedArgs,
      }),
      detail: fetchFailureDetail(result.stderr) ?? options.fallbackErrorDetail,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });
  });

  const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
    Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
      const remoteNames = yield* listRemoteNames(input.cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(
        input.refName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const remoteRefName =
        parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
      const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remoteRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha, remoteRefName };
    });

  const resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"] =
    Effect.fn("resolveWorktreeBaseRemote")(function* (input) {
      const remoteNames = (yield* listRemoteNames(input.cwd)).toSorted(
        (left, right) => right.length - left.length,
      );
      // Upstream atoms read config even before the tracking ref has been fetched.
      // Match the exact local ref: for-each-ref also returns its descendants.
      const localBranch = yield* runGitStdout("GitVcsDriver.resolveWorktreeBaseRemote", input.cwd, [
        "for-each-ref",
        "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)",
        `refs/heads/${input.refName}`,
      ]).pipe(
        Effect.map((stdout) =>
          stdout
            .split("\n")
            .map((line) => line.split("\t"))
            .find(([refName]) => refName === `refs/heads/${input.refName}`),
        ),
      );
      let target: { remoteName: string; branchName: string } | null;
      if (localBranch) {
        // A remote of "." tracks another local branch; it is not a remote name.
        const [, remoteName = "", merge = ""] = localBranch;
        target =
          remoteNames.includes(remoteName) && merge.startsWith("refs/heads/")
            ? { remoteName, branchName: merge.slice("refs/heads/".length) }
            : null;
      } else {
        target = parseRemoteRefWithRemoteNames(input.refName, remoteNames);
      }
      const { remoteName, branchName } = target ?? {
        remoteName: "origin",
        branchName: input.refName,
      };
      return remoteNames.includes(remoteName) ? { remoteName, branchName } : null;
    });

  const fetchWorktreeBaseCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchWorktreeBaseCommit"] =
    Effect.fn("fetchWorktreeBaseCommit")(function* (input) {
      const target = input.remote ?? (yield* resolveWorktreeBaseRemote(input));
      if (target === null) return null;
      const { remoteName, branchName } = target;
      const remoteRefName = `${remoteName}/${branchName}`;
      // A missing remote branch can leave a stale tracking ref; never resolve it.
      if (!(yield* fetchRemote({ cwd: input.cwd, remoteName, refName: remoteRefName }))) {
        return null;
      }
      const resolved = yield* executeGit(
        "GitVcsDriver.fetchWorktreeBaseCommit",
        input.cwd,
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRefName}^{commit}`],
        { allowNonZeroExit: true },
      );
      return resolved.exitCode === 0 ? { commitSha: resolved.stdout.trim(), remoteRefName } : null;
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    if (!localBranchAlreadyExists) {
      return yield* createBranchAt(
        "GitVcsDriver.fetchRemoteBranch.materialize",
        { cwd: input.cwd, branch: input.localBranch, startPoint: targetRef },
        "git branch create failed",
      );
    }
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      ["branch", "--force", "--", input.localBranch, targetRef],
      { writesSharedConfig: true },
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
    executeGitWithStableDiagnostics(
      "GitVcsDriver.setBranchUpstream",
      input.cwd,
      [
        "branch",
        "--set-upstream-to",
        `${input.remoteName}/${input.remoteBranch}`,
        "--",
        input.branch,
      ],
      { writesSharedConfig: true },
    ).pipe(retryWhileConfigLocked, Effect.asVoid);

  /**
   * Unlinks links under `target` without following them and removes the
   * directories that leaves empty. Returns false when anything else remains.
   */
  const removeLeftoverLinks = (
    target: string,
  ): Effect.Effect<boolean, PlatformError.PlatformError | Cause.UnknownError> =>
    Effect.gen(function* () {
      if (Option.isSome(yield* fileSystem.readLink(target).pipe(Effect.option))) {
        yield* fileSystem.remove(target);
        return true;
      }
      if ((yield* fileSystem.stat(target)).type !== "Directory") return false;
      let empty = true;
      for (const name of yield* fileSystem.readDirectory(target)) {
        if (!(yield* removeLeftoverLinks(path.join(target, name)))) empty = false;
      }
      // Only an empty directory goes, so files written since the listing stay.
      return empty && (yield* removeEmptyDirectory(target));
    });

  const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    // Git also matches a worktree by its short name, which can name a different
    // folder than this path. Resolving it once keeps Git, the Windows deletion
    // in removeLinkedWorktree, and the leftover cleanup below on one directory.
    const target = path.resolve(input.cwd, input.path);
    const result = yield* removeLinkedWorktree({
      operation: "GitVcsDriver.removeWorktree",
      cwd: input.cwd,
      worktreePath: target,
      force: input.force === true,
      execute,
      run: (args) =>
        executeGitWithStableDiagnostics("GitVcsDriver.removeWorktree", input.cwd, args, {
          // Removing dependency-heavy worktrees is filesystem-bound and can take
          // minutes, especially on Windows. Keep it bounded without interrupting
          // git midway through cleanup.
          timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
          allowNonZeroExit: true,
        }).pipe(Effect.map((result) => ({ ...result, args }))),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (result.exitCode === 0) {
      // Git for Windows never descends into NTFS junctions, such as pnpm's
      // node_modules links. It reports success but leaves them and their parent
      // directories behind, so a resumed thread would find a stub instead of
      // recreating its checkout. Git has already unregistered the worktree, so
      // anything left here is logged rather than returned: a retry could never
      // succeed.
      if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) {
        const removed = yield* removeLeftoverLinks(target).pipe(
          Effect.catch((error) =>
            Effect.logWarning("GitVcsDriver.removeWorktree: failed to delete leftover links", {
              path: target,
              error,
            }).pipe(Effect.as(true)),
          ),
        );
        if (!removed) {
          yield* Effect.logWarning(
            "GitVcsDriver.removeWorktree: kept files written after git removed the worktree",
            { path: target },
          );
        }
      }
      return;
    }
    // Threads can share a worktree path, and worktrees get removed or pruned
    // outside the app, so a worktree that is already gone is a no-op rather
    // than an error. Prune so no stale registration lingers to block a later
    // `worktree add` at the same path.
    const alreadyGone =
      isMissingWorktreeStderr(result.stderr) &&
      !(yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)));
    if (alreadyGone) {
      yield* pruneWorktrees({ cwd: input.cwd });
      return;
    }
    // Raw stderr stays out of both the wire error and the log (it can carry
    // secrets); log bounded diagnostics so a genuine failure is visible
    // server-side.
    yield* Effect.logWarning(
      `GitVcsDriver.removeWorktree: git worktree remove exited with code ${result.exitCode} for ${input.path} (stderr length ${result.stderr.length}).`,
    );
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.removeWorktree",
        cwd: input.cwd,
        args: result.args,
      }),
      detail: "git worktree remove failed",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    });
  });

  const pruneWorktrees: GitVcsDriver.GitVcsDriver["Service"]["pruneWorktrees"] = Effect.fn(
    "pruneWorktrees",
  )(function* (input) {
    yield* executeGit("GitVcsDriver.pruneWorktrees", input.cwd, ["worktree", "prune"], {
      timeoutMs: 15_000,
      fallbackErrorDetail: "git worktree prune failed",
    });
  });

  const deleteLocalBranch: GitVcsDriver.GitVcsDriver["Service"]["deleteLocalBranch"] = Effect.fn(
    "deleteLocalBranch",
  )(function* (input) {
    yield* executeGit(
      "GitVcsDriver.deleteLocalBranch",
      input.cwd,
      ["branch", input.force === true ? "-D" : "-d", "--", input.refName],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch delete failed",
        // Under contention Git deletes the ref but keeps its config section.
        writesSharedConfig: true,
      },
    );
  });

  const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
    "renameBranch",
  )(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = input.exactName
      ? input.newBranch
      : yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitVcsDriver.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch rename failed",
        writesSharedConfig: true,
      },
    );

    return { branch: targetBranch };
  });

  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch =
        remoteExists && !localInputExists
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackingBranch",
              input.cwd,
              ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(
              Effect.map((result) =>
                result.exitCode === 0
                  ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                  : null,
              ),
            )
          : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && !localInputExists && !localTrackingBranch && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      // Made apart from the checkout, as `git branch` + tracking, the same branch
      // `checkout --track` would make: that writes the tracking config only once the checkout is
      // done, so it holds the shared-config lock for as long as the checkout takes.
      const trackingBranchToMake =
        !localInputExists && remoteExists && !localTrackingBranch && !localTrackedBranchTargetExists
          ? localTrackedBranchCandidate
          : null;
      const checkoutArgs = trackingBranchToMake
        ? ["checkout", trackingBranchToMake]
        : localInputExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
            ? ["checkout", input.refName]
            : remoteExists && !localTrackingBranch
              ? ["checkout", "--track", input.refName]
              : remoteExists && localTrackingBranch
                ? ["checkout", localTrackingBranch]
                : ["checkout", input.refName];

      yield* refuseOptionLikeRefName("GitVcsDriver.switchRef", input.cwd, checkoutArgs.at(-1));

      // Otherwise git makes a branch only from a name that names no commit, guessing the remote
      // branch it means.
      const checkoutMayMakeBranch =
        checkoutArgs.includes("--track") ||
        (!localInputExists &&
          !remoteExists &&
          (yield* executeGit(
            "GitVcsDriver.switchRef.refNameIsCommit",
            input.cwd,
            ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.refName}^{commit}`],
            { timeoutMs: 5_000, allowNonZeroExit: true },
          ).pipe(Effect.map((result) => result.exitCode !== 0))));

      // A stale ref must not turn into a path checkout that discards local edits.
      const checkout = executeGitWithStableDiagnostics(
        "GitVcsDriver.switchRef.checkout",
        input.cwd,
        [...checkoutArgs, "--"],
        {
          movesWorkingTree: true,
          fallbackErrorDetail: "git checkout failed",
          writesSharedConfig: checkoutMayMakeBranch,
        },
      );
      yield* trackingBranchToMake
        ? withNewBranch(
            "GitVcsDriver.switchRef.createBranch",
            {
              cwd: input.cwd,
              branch: trackingBranchToMake,
              startPoint: `refs/remotes/${input.refName}`,
            },
            "git checkout failed",
            checkout,
          )
        : checkout;

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", "--", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch create failed",
        // `branch.autoSetupMerge=always` records HEAD's branch as the upstream.
        writesSharedConfig: true,
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
    cwd,
  ) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:lstrip=2)",
    ]).pipe(
      Effect.map((stdout) => {
        const branchNames: Array<string> = [];
        for (const line of stdout.split("\n")) {
          const branchName = line.trim();
          if (branchName.length > 0) {
            branchNames.push(branchName);
          }
        }
        return branchNames;
      }),
    );

  const listWorktreePaths: GitVcsDriver.GitVcsDriver["Service"]["listWorktreePaths"] = (cwd) =>
    executeWorktreeList("GitVcsDriver.listWorktreePaths", cwd, []).pipe(
      // One record per worktree, each ended by an empty field. A `prunable`
      // record's directory is gone, and another checkout may now sit there.
      Effect.map(({ stdout }) =>
        stdout.split("\0\0").flatMap((record) => {
          const fields = record.split("\0");
          const worktree = fields.find((field) => field.startsWith("worktree "));
          return worktree === undefined || fields.some((field) => field.startsWith("prunable"))
            ? []
            : [path.resolve(cwd, worktree.slice("worktree ".length))];
        }),
      ),
    );

  const withListRefsInvalidation = <A, E>(
    cwd: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.ensuring(
        Effect.all([
          invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
          invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
        ]),
      ),
    );
  const invalidateWorktreeCreationCaches = Effect.fn(
    "GitVcsDriverCore.invalidateWorktreeCreationCaches",
  )(function* (cwd: string) {
    // What the worktree's lock read of a folder nothing else knew yet stands: one discovery a creation.
    let gitCommonDir = yield* Cache.getOption(
      gitCommonDirCache,
      normalizeRepositoryPathsCacheKey(cwd),
    ).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (gitCommonDir === null) {
      gitCommonDir = yield* readGitCommonDir(cwd).pipe(
        Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
      );
    }
    if (gitCommonDir === null) {
      gitCommonDir = yield* Cache.getOption(
        repositoryPathsCache,
        normalizeRepositoryPathsCacheKey(cwd),
      ).pipe(
        Effect.map((cached) => Option.getOrNull(cached)?.gitCommonDir ?? null),
        Effect.orElseSucceed(() => null),
      );
    }
    yield* Effect.all([
      invalidateListRefsSnapshot(cwd, gitCommonDir).pipe(Effect.ignore),
      invalidateStatusStaticCaches(cwd, gitCommonDir).pipe(Effect.ignore),
    ]);
  });
  const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
    input,
  ) =>
    initRepo(input).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
          yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
          yield* Cache.invalidate(repositoryPathsCache, cacheKey);
          yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
        }),
      ),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    prepareCommitContext,
    commit: (cwd, subject, body, options) =>
      withListRefsInvalidation(cwd, commit(cwd, subject, body, options)),
    pushCurrentBranch: (cwd, fallbackBranch, options) =>
      withListRefsInvalidation(cwd, pushCurrentBranch(cwd, fallbackBranch, options)),
    pullCurrentBranch: (cwd) => withListRefsInvalidation(cwd, pullCurrentBranch(cwd)),
    readRangeContext,
    getReviewDiffPreview,
    getReviewDiffFileContents,
    readConfigValue,
    resolveBranchName,
    listRefs,
    createWorktree: (input, options) =>
      createWorktree(input, options).pipe(
        Effect.ensuring(invalidateWorktreeCreationCaches(input.cwd)),
      ),
    fetchPullRequestBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchPullRequestBranch(input)),
    fetchPullRequestHeadCommit,
    resolveCommit,
    refreshCheckedOutBranch: (input) =>
      withListRefsInvalidation(input.cwd, refreshCheckedOutBranch(input)),
    ensureRemote: (input) => withListRefsInvalidation(input.cwd, ensureRemote(input)),
    resolvePrimaryRemoteName,
    resolveDefaultBranchName,
    fetchRemote: (input) =>
      withListRefsInvalidation(
        input.cwd,
        fetchRemote(input).pipe(
          Effect.flatMap((fetched) =>
            fetched
              ? Effect.void
              : fetchRemote({ cwd: input.cwd, remoteName: input.remoteName }).pipe(Effect.asVoid),
          ),
        ),
      ),
    remoteExists,
    remoteBranchExists,
    resolveRemoteTrackingCommit,
    resolveWorktreeBaseRemote,
    fetchWorktreeBaseCommit: (input) =>
      withListRefsInvalidation(input.cwd, fetchWorktreeBaseCommit(input)),
    fetchRemoteBranch: (input) => withListRefsInvalidation(input.cwd, fetchRemoteBranch(input)),
    fetchRemoteTrackingBranch: (input) =>
      withListRefsInvalidation(input.cwd, fetchRemoteTrackingBranch(input)),
    setBranchUpstream: (input) => withListRefsInvalidation(input.cwd, setBranchUpstream(input)),
    createBranch: (input) => withListRefsInvalidation(input.cwd, createBranch(input)),
    writeConfigValue,
    removeWorktree: (input) => withListRefsInvalidation(input.cwd, removeWorktree(input)),
    pruneWorktrees: (input) => withListRefsInvalidation(input.cwd, pruneWorktrees(input)),
    deleteLocalBranch: (input) => withListRefsInvalidation(input.cwd, deleteLocalBranch(input)),
    renameBranch: (input) => withListRefsInvalidation(input.cwd, renameBranch(input)),
    createRef: (input) => withListRefsInvalidation(input.cwd, createRef(input)),
    switchRef: (input) => withListRefsInvalidation(input.cwd, switchRef(input)),
    initRepo: initRepoWithListRefsInvalidation,
    listLocalBranchNames,
    listWorktreePaths,
  });
});
