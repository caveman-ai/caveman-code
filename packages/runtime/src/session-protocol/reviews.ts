// The Review page's pr.* methods over upstream pull request services (pullRequest/*): what the page draws,
// mapped from the provider-neutral shapes the host's own CLI (gh, glab, ...) was read into. Reads and
// writes go through PullRequestService, guides through PullRequestReviewGuideService; neither is
// re-implemented here. pr.symbol alone reads this computer's own checkout, with git, never the host.
import {
  ProjectId,
  type ModelSelection,
  type PullRequestActivity,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestRef,
  type PullRequestReviewDecision,
  type PullRequestReviewGuide,
  type PullRequestReviewGuideResult,
  type PullRequestState,
  type PullRequestSummary,
} from "@caveman-app/protocol";
import type { PrActor, PrCheck, PrDetail, PrDiscussionItem, PrGuide, PrGuideResult, PrSummary } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type { PullRequestError, PullRequestService } from "../pullRequest/PullRequestService.ts";
import type { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { guideWriterLabel, isGuideComment } from "../pullRequest/pullRequestReviewGuideComment.ts";
import { type Handler, ProtocolError } from "./handlers.ts";
import { rerunFailed } from "./pullRequestCi.ts";
import { git } from "./lifecycle.ts";
import type { WorkspaceRecord } from "./store.ts";

type ReviewMethod = "pr.list" | "pr.get" | "pr.diff" | "pr.discussion" | "pr.guide" | "pr.post_guide" | "pr.comment" | "pr.resolve" | "pr.review" | "pr.merge" | "pr.rerun" | "pr.ready" | "pr.viewed" | "pr.file" | "pr.symbol";

/** One git run in a checkout: its exit code and output, stdout cut at the byte limit it was given. */
export interface GitRead {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
}

/** Git in a checkout. A non-zero exit fails unless `allowNonZeroExit`; stdout past `maxOutputBytes` is cut, not failed. */
export type ReviewGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowNonZeroExit?: boolean; readonly maxOutputBytes?: number },
) => Effect.Effect<GitRead, ProtocolError>;

export interface ReviewDeps {
  readonly pullRequests: Option.Option<PullRequestService["Service"]>;
  readonly guides: Option.Option<PullRequestReviewGuideService["Service"]>;
  /** The project's own `owner/name` on its host, for a reference that names no repository. */
  readonly projectRepository: (projectId: string) => Effect.Effect<string | undefined>;
  readonly workspaces: Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** A model as the person would name it ("Claude Haiku 5.5"). */
  readonly modelLabel: (selection: ModelSelection) => Effect.Effect<string>;
  /** This computer's checkout of the project (its root folder), for pr.symbol; undefined when it has none. */
  readonly projectRoot: (projectId: string) => Effect.Effect<string | undefined>;
  /** Git in that checkout, for pr.symbol: `checkoutGit` over the runtime's GitVcsDriver. */
  readonly git: ReviewGit;
  /** The person's github.com sign-in, for pr.rerun (GitHub's Actions API); absent, pr.rerun answers unsupported. */
  readonly githubToken?: () => Effect.Effect<string | undefined>;
  /**
   * Whether this is a Cloud computer whose person's credentials stay outside it (cloudLink/credentialRule.ts): it is
   * given no GitHub sign-in, so the page says where pull requests are read and changed instead of how to sign in here.
   */
  readonly outside?: () => boolean;
  /** For tests: GitHub's API is fetched with this. */
  readonly fetch?: typeof fetch;
}

/**
 * Git that only reads what this computer already has: a partial clone's missing object fails rather than being
 * fetched from its promisor remote (GIT_NO_LAZY_FETCH, Git 2.44+), nothing prompts, and no optional lock is taken.
 */
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

export const checkoutGit =
  (driver: GitVcsDriver.GitVcsDriver["Service"]): ReviewGit =>
  (cwd, args, options = {}) =>
    git(driver, cwd, args, {
      env: READ_ONLY_GIT_ENV,
      ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    }).pipe(
      Effect.map((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated })),
      Effect.mapError((error) => new ProtocolError({ reason: "internal", message: error.message })),
    );

/** Slices of a diff read for one answer; GitHub serves 300 files a slice. */
// ponytail: a change past 20 slices (~6000 files) answers its first 20; page pr.diff if one ever matters.
const MAX_DIFF_SLICES = 20;

// ---------------------------------------------------------------- mappers

export const actorOf = (actor: PullRequestActor | null | undefined): PrActor | undefined =>
  actor ? { login: actor.login, ...(actor.avatarUrl ? { avatar_url: actor.avatarUrl } : {}), ...(actor.isBot ? { bot: true } : {}) } : undefined;

export const stateOf = (state: PullRequestState, isDraft: boolean | undefined): PrSummary["state"] => (state === "open" && isDraft ? "draft" : state);

export const reviewOf = (decision: PullRequestReviewDecision | null | undefined): PrSummary["review"] =>
  decision === "changes-requested" ? "changes_requested" : decision === "review-required" ? "review_required" : decision === "approved" ? "approved" : undefined;

const sameLogin = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** The newest chat of ours (not archived) in that project on that branch. */
export function workspaceFor(records: ReadonlyArray<WorkspaceRecord>, projectId: string, branch: string): string | undefined {
  let newest: WorkspaceRecord["workspace"] | undefined;
  for (const { workspace } of records) {
    if (workspace.project_id !== projectId || workspace.branch !== branch || workspace.status === "archived" || workspace.kind !== undefined) continue;
    if (!newest || workspace.created_at > newest.created_at) newest = workspace;
  }
  return newest?.id;
}

/**
 * `owner/name` as the host spells it. The service names a repository by its canonical, lowercased key;
 * the pull request's own URL keeps the host's casing ("JuliusBrussee/caveman"), so that wins when it
 * names the same repository, whatever the host's path shape (`/pull/7`, `/-/merge_requests/7`).
 */
export function repoOf(url: string, repository: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
    const lower = repository.toLowerCase();
    const at = path.toLowerCase().indexOf(lower);
    const end = path[at + lower.length];
    return at >= 0 && (at === 0 || path[at - 1] === "/") && (end === undefined || end === "/") ? path.slice(at, at + lower.length) : repository;
  } catch {
    return repository;
  }
}

const labelsOf = (labels: ReadonlyArray<{ readonly name: string; readonly color: string | null }>) =>
  labels.length === 0 ? {} : { labels: labels.map((l) => ({ name: l.name, ...(l.color ? { color: l.color } : {}) })) };

export function summaryOf(entry: PullRequestListEntry, viewers: Readonly<Record<string, string>>, workspaceId: string | undefined, guideReady = false): PrSummary {
  const author = actorOf(entry.author);
  const review = reviewOf(entry.reviewDecision);
  return {
    project_id: entry.projectId,
    repo: repoOf(entry.url, entry.repository),
    host: entry.host,
    number: entry.number,
    title: entry.title,
    url: entry.url,
    ...(author ? { author } : {}),
    head_branch: entry.headBranch,
    base_branch: entry.baseBranch,
    state: stateOf(entry.state, entry.isDraft),
    additions: entry.additions,
    deletions: entry.deletions,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    review_requested: entry.viewerReviewRequested,
    mine: sameLogin(author?.login, viewers[entry.host]),
    ...(review ? { review } : {}),
    ...(entry.checksState ? { checks: entry.checksState } : {}),
    ...labelsOf(entry.labels),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(guideReady ? { guide_ready: true } : {}),
  };
}

export const checkOf = (check: PullRequestCheck): PrCheck => ({
  name: check.name,
  status:
    check.status === "success" ? "passed" : check.status === "pending" ? "pending" : check.status === "skipped" || check.status === "neutral" ? "skipped" : "failed",
  ...(check.url ? { url: check.url } : {}),
});

/** One verdict over a list of checks: any failed fails, then any running is pending; none says nothing. */
export function checksStateOf(checks: ReadonlyArray<PrCheck>): PullRequestChecksState | undefined {
  if (checks.length === 0) return undefined;
  if (checks.some((c) => c.status === "failed")) return "failing";
  return checks.some((c) => c.status === "pending") ? "pending" : "passing";
}

export interface PatchFile {
  path: string;
  old_path?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

/** A unified diff, one entry per file: its `diff --git` section as the patch, with what it adds and removes. */
export function parsePatch(diff: string): Array<PatchFile> {
  const files: Array<PatchFile> = [];
  const lines = diff.split("\n");
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const section = lines.slice(start, end);
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(section[0]!);
    let oldPath = header?.[1];
    let newPath = header?.[2];
    let status: PatchFile["status"] = "modified";
    let additions = 0;
    let deletions = 0;
    let inHunks = false;
    for (const line of section.slice(1)) {
      if (inHunks) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        continue;
      }
      if (line.startsWith("@@")) inHunks = true;
      else if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) (status = "renamed"), (oldPath = line.slice(12));
      else if (line.startsWith("rename to ")) newPath = line.slice(10);
      else if (line.startsWith("--- a/")) oldPath = line.slice(6);
      else if (line.startsWith("+++ b/")) newPath = line.slice(6);
    }
    const path = status === "deleted" ? oldPath : newPath;
    if (path) {
      const text = section.join("\n");
      files.push({
        path,
        ...(status === "renamed" && oldPath ? { old_path: oldPath } : {}),
        status,
        additions,
        deletions,
        patch: text.endsWith("\n") ? text : `${text}\n`,
      });
    }
    start = -1;
  };
  lines.forEach((line, i) => {
    if (line.startsWith("diff --git ")) {
      close(i);
      start = i;
    }
  });
  close(lines.length);
  return files;
}

/**
 * The diff lines a comment on `line` (on `side`) was written against, ending at that line, as the
 * host's own diff hunk would show them: the hunk header and up to `context` lines before it.
 */
export function hunkAt(patch: string, line: number, side: "new" | "old", context = 3): string | undefined {
  let oldLine = 0;
  let newLine = 0;
  let header: string | undefined;
  let body: Array<string> = [];
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      header = text;
      body = [];
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (header === undefined || text.startsWith("\\")) continue;
    const kind = text[0];
    if (kind !== "+" && kind !== "-" && kind !== " ") continue;
    body.push(text);
    const at = kind === "+" ? newLine : kind === "-" ? oldLine : side === "new" ? newLine : oldLine;
    const onSide = side === "new" ? kind !== "-" : kind !== "+";
    if (onSide && at === line) return [header, ...body.slice(-(context + 1))].join("\n");
    if (kind !== "+") oldLine++;
    if (kind !== "-") newLine++;
  }
  return undefined;
}

const VERDICTS: Record<string, "approved" | "changes_requested" | "commented"> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented" };

/** Comments and reviews, then threads, oldest first; a line comment lives in its thread, not twice. */
export function discussionOf(activity: PullRequestActivity, patches: ReadonlyMap<string, string>): Array<PrDiscussionItem> {
  const items: Array<PrDiscussionItem & { readonly sortAt: string }> = [];
  for (const comment of activity.comments) {
    if (comment.kind === "review-comment") continue;
    const author = actorOf(comment.author);
    const verdict = comment.kind === "review" ? VERDICTS[(comment.reviewState ?? "").toUpperCase()] : undefined;
    items.push({
      type: "comment",
      id: comment.id,
      ...(author ? { author } : {}),
      body: comment.body,
      at: comment.createdAt,
      ...(verdict ? { verdict } : {}),
      ...(comment.url ? { url: comment.url } : {}),
      ...(comment.kind === "issue-comment" && isGuideComment(comment.body) ? { guide: true } : {}),
      sortAt: comment.createdAt,
    });
  }
  for (const thread of activity.reviewThreads) {
    const side = thread.side === "left" ? "old" : "new";
    const patch = patches.get(thread.path);
    const hunk = thread.line !== null && !thread.isOutdated && patch ? hunkAt(patch, thread.line, side) : undefined;
    const comments = thread.comments.map((c) => {
      const author = actorOf(c.author);
      return { id: c.id, ...(author ? { author } : {}), body: c.body, at: c.createdAt };
    });
    items.push({
      type: "thread",
      id: thread.id,
      path: thread.path,
      ...(thread.line !== null ? { line: thread.line } : {}),
      side,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      ...(hunk ? { hunk } : {}),
      comments,
      sortAt: comments[0]?.at ?? "",
    });
  }
  return items.sort((a, b) => a.sortAt.localeCompare(b.sortAt)).map(({ sortAt: _, ...item }) => item as PrDiscussionItem);
}

const MERGE_METHODS = ["squash", "merge", "rebase"] as const;

export function detailOf(input: {
  readonly detail: PullRequestDetail;
  readonly host: string;
  readonly summary: PullRequestSummary | null;
  readonly activity: PullRequestActivity | null;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly files: ReadonlyArray<PatchFile>;
  readonly viewed: ReadonlySet<string>;
  readonly workspaceId: string | undefined;
}): PrDetail {
  const { detail, activity } = input;
  const author = actorOf(detail.author);
  const review = reviewOf(input.summary?.reviewDecision);
  const checksList = input.checks.map(checkOf);
  const checks = input.summary?.checksState ?? checksStateOf(checksList);
  // Each reviewer's own latest verdict; asked and not answered yet is pending.
  const latest = new Map<string, "approved" | "changes_requested" | "commented">();
  for (const comment of activity?.comments ?? []) {
    const verdict = comment.kind === "review" && comment.author ? VERDICTS[(comment.reviewState ?? "").toUpperCase()] : undefined;
    if (verdict) latest.set(comment.author!.login.toLowerCase(), verdict);
  }
  const reviewers = (activity?.reviewers ?? detail.reviewers).map((actor) => ({
    ...actorOf(actor)!,
    state: latest.get(actor.login.toLowerCase()) ?? ("pending" as const),
  }));
  const permissions = detail.viewerPermissions;
  const canMerge = detail.capabilities.actions.includes("merge") && permissions.actions.includes("merge");
  const requiredUnmet = input.checks.some((c) => c.required === true && c.status !== "success" && c.status !== "skipped" && c.status !== "neutral");
  const mergeable =
    detail.mergeability === "conflicting"
      ? "conflicting"
      : detail.mergeability === "unknown"
        ? "unknown"
        : review === "changes_requested" || review === "review_required" || requiredUnmet
          ? "blocked"
          : "clean";
  return {
    project_id: detail.projectId,
    repo: repoOf(detail.url, detail.repository),
    host: input.host,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    ...(author ? { author } : {}),
    head_branch: detail.headBranch,
    base_branch: detail.baseBranch,
    state: stateOf(detail.state, detail.isDraft),
    additions: detail.additions,
    deletions: detail.deletions,
    created_at: detail.createdAt,
    updated_at: detail.updatedAt,
    review_requested: reviewers.some((r) => sameLogin(r.login, detail.viewer) && r.state === "pending"),
    mine: sameLogin(author?.login, detail.viewer),
    ...(review ? { review } : {}),
    ...(checks ? { checks } : {}),
    ...labelsOf(detail.labels),
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    ...(detail.diffStatTruncated ? { diff_stat_truncated: true } : {}),
    body: detail.body,
    ...(detail.headSha ? { head_sha: detail.headSha } : {}),
    mergeable,
    checks_list: checksList,
    reviewers,
    commits: activity?.commits.length ?? 0,
    files: input.files.map(({ patch: _, ...file }) => ({ ...file, viewed: input.viewed.has(file.path) })),
    can: {
      merge: canMerge,
      review: detail.capabilities.review.verdicts.length > 0 && permissions.verdicts.length > 0,
      comment: detail.capabilities.comment && permissions.comment,
      merge_methods: canMerge
        ? MERGE_METHODS.filter((m) => detail.mergeCapabilities[m] && detail.capabilities.mergeMethods.includes(m))
        : [],
      ready: detail.isDraft && detail.capabilities.actions.includes("ready") && permissions.actions.includes("ready"),
    },
  };
}

export { guideWriterLabel };

/** `workspaceId`: the chat here that wrote a chat guide's TL;DR, when there is one. */
export const guideOf = (guide: PullRequestReviewGuide, model: string | undefined, workspaceId?: string): PrGuide =>
  guideWith(guide, guideWriterLabel(guide, model), workspaceId);

const guideWith = (guide: PullRequestReviewGuide, model: string | undefined, workspaceId: string | undefined): PrGuide => ({
  head_sha: guide.headSha,
  generated_at: guide.generatedAt,
  ...(model ? { model } : {}),
  ...(guide.tldr ? { tldr: guide.tldr } : {}),
  ...(guide.overview ? { overview: guide.overview } : {}),
  ...(guide.beforeAfter ? { before_after: guide.beforeAfter } : {}),
  stops: guide.stops,
  ...(guide.depth ? { depth: guide.depth } : {}),
  ...(guide.attention ? { attention: guide.attention } : {}),
  // A guide from before writers were recorded was a model's: templates came with them.
  by: guide.writer?.tier === "chat" ? "chat" : guide.writer?.tier === "template" ? "template" : "model",
  ...(guide.writer?.tier === "chat" && workspaceId ? { workspace_id: workspaceId } : {}),
  ...(guide.posted ? { posted_by: guide.posted.login } : {}),
});

/**
 * `running` and `failed` speak of a run for the head the pull request is at now, never an older one.
 * `workspaceId` as for `guideOf`.
 */
export function guideResultOf(result: PullRequestReviewGuideResult, model: string | undefined, workspaceId?: string): PrGuideResult {
  const run = result.run;
  const current = (headSha: string) => result.currentHeadSha === null || headSha === result.currentHeadSha;
  return {
    guide: result.guide ? guideOf(result.guide, model, workspaceId) : null,
    running: run?._tag === "Running" && current(run.headSha),
    ...(run?._tag === "Failed" && current(run.headSha) ? { failed: run.detail } : {}),
    ...(result.currentHeadSha ? { head_sha: result.currentHeadSha } : {}),
    ...(result.comment
      ? { comment: { url: result.comment.url, ...(result.comment.headSha ? { head_sha: result.comment.headSha } : {}), mine: result.comment.mine } }
      : {}),
    ...(result.canPost !== undefined ? { can_post: result.canPost } : {}),
  };
}

/** pr.file's status as the service names the change; a rename read whole may also have changed the file. */
export const CHANGE_TYPE = { added: "new", deleted: "deleted", renamed: "rename-changed", modified: "change" } as const;

/** pr.symbol: lines answered when the reader names no limit, and at most whatever it names. */
const SYMBOL_LIMIT = 200;
const SYMBOL_LIMIT_MAX = 1000;
/** A line's text, cut: a minified bundle's one line is the whole file. */
const SYMBOL_TEXT_MAX = 300;
/** What one search may print; past it the output is cut and the answer says there was more. */
const SYMBOL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface SymbolHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const cutText = (text: string) => {
  if (text.length <= SYMBOL_TEXT_MAX) return text;
  const cut = text.slice(0, SYMBOL_TEXT_MAX);
  // Never half a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * `git grep -n -z` at a commit, as hits: one `<commit>:<path>\0<line>\0<text>\n` per line found, the path verbatim
 * (a colon, even a newline, is part of it; nothing is quoted) and the text ending at its newline, so a NUL in a line
 * changes nothing. A record the output limit cut short is left out. `truncated` when more lines were found than
 * `limit`, or `cut` (the output was).
 */
export function parseGrep(stdout: string, commit: string, limit: number, cut = false): { hits: Array<SymbolHit>; truncated: boolean } {
  const prefix = `${commit}:`;
  const hits: Array<SymbolHit> = [];
  let at = 0;
  while (at < stdout.length) {
    const nameEnd = stdout.indexOf("\0", at);
    const lineEnd = nameEnd < 0 ? -1 : stdout.indexOf("\0", nameEnd + 1);
    const textEnd = lineEnd < 0 ? -1 : stdout.indexOf("\n", lineEnd + 1);
    if (textEnd < 0) break;
    const name = stdout.slice(at, nameEnd);
    const line = stdout.slice(nameEnd + 1, lineEnd);
    at = textEnd + 1;
    if (!name.startsWith(prefix) || name.length === prefix.length || !/^[1-9]\d{0,9}$/.test(line)) continue;
    if (hits.length >= limit) return { hits, truncated: true };
    hits.push({ path: name.slice(prefix.length), line: Number(line), text: cutText(stdout.slice(lineEnd + 1, textEnd).replace(/\r$/, "")) });
  }
  return { hits, truncated: cut };
}

/** A host's refusal as a protocol error carrying the host's own sentence. */
export function protocolErrorOf(error: PullRequestError): ProtocolError {
  if (error._tag === "PullRequestUnavailableError") {
    return error.reason === "provider-unsupported"
      ? new ProtocolError({ reason: "unsupported", message: error.message, capability: "pull_requests" })
      : new ProtocolError({ reason: "engine_unavailable", message: error.message });
  }
  return new ProtocolError({ reason: error.reason === "not-found" ? "not_found" : "invalid_state", message: error.detail });
}

/**
 * What the Review page says on a Cloud computer whose person's credentials stay outside it. The page's reads are the
 * host's own (GitHub's GraphQL, on a sign-in of the person's), and Cloud's connector proxy serves no GraphQL and no
 * write; the computer is given no sign-in, by the rule. So it says where the page works, and what a chat there still
 * does, and never "run `gh auth login`": that would put the person's GitHub sign-in where the agent can read it.
 */
export const OUTSIDE_PULL_REQUESTS =
  "Review pull requests on your Mac (Review). A chat in Cloud still opens its own and shows its checks.";
/** The same for a change (a comment, a review, a merge, checks run again): where it is made instead. */
export const OUTSIDE_PULL_REQUEST_CHANGE =
  "Do this on your Mac (Review), or on GitHub.";

// ---------------------------------------------------------------- handlers

export const makeReviewHandlers = (deps: ReviewDeps): { readonly [M in ReviewMethod]: Handler<M> } => {
  /**
   * Under the rule with no GitHub sign-in on the computer: true, and nothing is asked of the host. A sign-in a person
   * typed into the computer themselves (theirs to give the agent) reads as on a Mac.
   */
  const outside: Effect.Effect<boolean> =
    deps.outside === undefined
      ? Effect.succeed(false)
      : Effect.suspend(() => (deps.outside!() !== true ? Effect.succeed(false) : deps.githubToken === undefined ? Effect.succeed(true) : deps.githubToken().pipe(Effect.map((token) => !token))));
  const refusedOutside = (change: boolean) => new ProtocolError({ reason: "unsupported", message: change ? OUTSIDE_PULL_REQUEST_CHANGE : OUTSIDE_PULL_REQUESTS, capability: "pull_requests" });
  const service = <A>(use: (pr: PullRequestService["Service"]) => Effect.Effect<A, PullRequestError | ProtocolError>, change = false): Effect.Effect<A, ProtocolError> =>
    outside.pipe(
      Effect.flatMap((none) =>
        none
          ? Effect.fail(refusedOutside(change))
          : Option.isNone(deps.pullRequests)
            ? Effect.fail(new ProtocolError({ reason: "unsupported", message: "This runtime reads no pull requests", capability: "pull_requests" }))
            : use(deps.pullRequests.value).pipe(Effect.mapError((e) => (e instanceof ProtocolError ? e : protocolErrorOf(e)))),
      ),
    );

  const refOf = (p: { readonly project_id: string; readonly number: number; readonly repo?: string; readonly host?: string }) =>
    Effect.gen(function* () {
      const repository = p.repo ?? (yield* deps.projectRepository(p.project_id));
      if (!repository) return yield* Effect.fail(new ProtocolError({ reason: "not_found", message: "This project has no repository on a git host" }));
      return { projectId: ProjectId.make(p.project_id), repository, number: p.number, ...(p.host ? { host: p.host } : {}) } satisfies PullRequestRef;
    });

  /**
   * Every slice of the diff, each file's patch on its own; the host's counts stand in for a file it withheld. The
   * first slice's revision is the whole walk's: a host that names one reads on at it through its cursor. The head is
   * the walk's only when every slice was read at that one: a push between slices leaves files of two heads.
   */
  const readDiff = (pr: PullRequestService["Service"], ref: PullRequestRef) =>
    Effect.gen(function* () {
      const files: Array<PatchFile> = [];
      const omitted = new Map<string, { additions: number; deletions: number }>();
      let cursor: string | undefined;
      let revision: string | undefined;
      let headSha: string | undefined;
      for (let slice = 0; slice < MAX_DIFF_SLICES; slice++) {
        const read = yield* pr.diff({ ...ref, ...(cursor ? { cursor } : {}) });
        if (slice === 0) {
          revision = read.revision;
          headSha = read.headSha;
        } else if (read.headSha !== headSha) headSha = undefined;
        files.push(...parsePatch(read.patch));
        for (const stat of read.omittedFileStats ?? []) omitted.set(stat.path, stat);
        if (read.nextCursor === null) break;
        cursor = read.nextCursor;
      }
      for (const file of files) {
        const stat = omitted.get(file.path);
        if (stat) (file.additions = stat.additions), (file.deletions = stat.deletions);
      }
      for (const [path, stat] of omitted) if (!files.some((f) => f.path === path)) files.push({ path, status: "modified", ...stat, patch: "" });
      return { files, omitted: [...omitted.keys()], revision, headSha };
    });

  const hostOf = (url: string, fallback: string | undefined) => {
    try {
      return fallback ?? new URL(url).host.toLowerCase();
    } catch {
      return fallback ?? "";
    }
  };

  const guideService = deps.guides;
  const guides = <A>(use: (g: PullRequestReviewGuideService["Service"]) => Effect.Effect<A, PullRequestError | ProtocolError>, change = false) =>
    outside.pipe(
      Effect.flatMap((none) =>
        none
          ? Effect.fail(refusedOutside(change))
          : Option.isNone(guideService)
            ? Effect.fail(new ProtocolError({ reason: "unsupported", message: "This runtime writes no review guides", capability: "pull_requests" }))
            : service(() => use(guideService.value), change),
      ),
    );

  /** A guide result as the page reads it: the writer named, and the chat whose TL;DR it is, when it is here. */
  const guideAnswer = (result: PullRequestReviewGuideResult) =>
    Effect.gen(function* () {
      const model = result.guide ? yield* deps.modelLabel(result.guide.modelSelection) : undefined;
      // The chat whose TL;DR it is, by its T3 thread; a chat since moved to another thread, or gone, is left out.
      const threadId = result.guide?.writer?.tier === "chat" ? result.guide.threadId : undefined;
      const workspaceId =
        threadId === undefined ? undefined : (yield* deps.workspaces).find((record) => record.internal.threadId === threadId)?.workspace.id;
      return guideResultOf(result, model, workspaceId);
    });

  const write = (p: Parameters<typeof refOf>[0], run: (pr: PullRequestService["Service"], ref: PullRequestRef) => Effect.Effect<void, PullRequestError>) =>
    service((pr) => refOf(p).pipe(Effect.flatMap((ref) => run(pr, ref))), true).pipe(Effect.as({}));

  const unsupported = (message: string) => new ProtocolError({ reason: "unsupported", message, capability: "pull_requests" });

  /** The full id of the commit `rev` names in the checkout, or undefined when the checkout has no such commit. */
  const commitAt = (root: string, rev: string) =>
    deps.git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { allowNonZeroExit: true }).pipe(
      Effect.map((read) => {
        const sha = read.stdout.trim();
        return read.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
      }),
    );

  /** A branch name git takes as one and nothing else: no option, refspec (`+`, `:`) or `@{...}` (a reflog, the last branch). */
  const isBranchName = (root: string, name: string) =>
    name === "" || name.startsWith("-") || name.startsWith("+") || name.includes(":") || name.includes("@{")
      ? Effect.succeed(false)
      : deps.git(root, ["check-ref-format", "--branch", name], { allowNonZeroExit: true }).pipe(Effect.map((read) => read.exitCode === 0));

  /** The pull request's head when the checkout has that commit, else its base branch as origin has it, then as a local branch. */
  const searchedCommit = (root: string, headSha: string | undefined, baseBranch: string) =>
    Effect.gen(function* () {
      if (headSha !== undefined && /^[0-9a-f]{7,64}$/i.test(headSha)) {
        const head = yield* commitAt(root, headSha);
        if (head) return { at: "head" as const, commit: head };
      }
      if (yield* isBranchName(root, baseBranch)) {
        for (const rev of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
          const base = yield* commitAt(root, rev);
          if (base) return { at: "base" as const, commit: base };
        }
      }
      return yield* Effect.fail(
        new ProtocolError({
          reason: "invalid_state",
          message: `This computer's checkout of the project has neither the pull request's head commit nor its base branch ${baseBranch}. Fetch the project there to search its code.`,
        }),
      );
    });

  return {
    "pr.list": (p) =>
      Effect.gen(function* () {
        if (yield* outside) return { prs: [], viewers: {}, errors: [], unavailable: OUTSIDE_PULL_REQUESTS };
        if (Option.isNone(deps.pullRequests)) return { prs: [], viewers: {}, errors: [], unavailable: "This runtime reads no pull requests" };
        const pr = deps.pullRequests.value;
        const listed = yield* pr
          .list({ state: p.state ?? "open", involvement: "all", ...(p.project_id ? { projectId: ProjectId.make(p.project_id) } : {}), ...(p.query?.trim() ? { query: p.query.trim() } : {}) })
          .pipe(Effect.result);
        if (Result.isFailure(listed)) {
          const error = listed.failure;
          if (error._tag === "PullRequestUnavailableError") return { prs: [], viewers: {}, errors: [], unavailable: error.message };
          return yield* Effect.fail(protocolErrorOf(error));
        }
        const result = listed.success;
        // GitHub's listing leaves counts at 0/0; one stats read fills them.
        const uncounted = result.entries.filter((e) => e.additions === 0 && e.deletions === 0).slice(0, 500);
        const stats =
          uncounted.length === 0
            ? []
            : (yield* pr
                .listStats({ refs: uncounted.map((e) => ({ projectId: e.projectId, repository: e.repository, number: e.number, host: e.host })) })
                .pipe(Effect.orElseSucceed(() => ({ stats: [] })))).stats;
        const counted = new Map(stats.map((s) => [`${s.projectId}\0${s.repository}\0${s.number}`, s]));
        const records = yield* deps.workspaces;
        // Which open ones have a guide stored: a read of this computer's own store, never the host's.
        const ready = yield* Effect.forEach(
          result.entries,
          (e) =>
            e.state !== "open" || e.isDraft || Option.isNone(guideService)
              ? Effect.succeed(false)
              : guideService.value.stored({ projectId: e.projectId, repository: e.repository, number: e.number, host: e.host }).pipe(Effect.orElseSucceed(() => false)),
          { concurrency: 8 },
        );
        const prs = result.entries.map((entry, i) => {
          const stat = counted.get(`${entry.projectId}\0${entry.repository}\0${entry.number}`);
          const filled = stat ? { ...entry, additions: stat.additions, deletions: stat.deletions } : entry;
          return summaryOf(filled, result.viewers, workspaceFor(records, entry.projectId, entry.headBranch), ready[i]);
        });
        const unconfigured = result.providers.find((provider) => !provider.configured && provider.detail);
        return {
          prs,
          viewers: { ...result.viewers },
          errors: result.errors.map((e) => ({ project_id: e.projectId, message: e.message })),
          ...(prs.length === 0 && unconfigured?.detail ? { unavailable: unconfigured.detail } : {}),
        };
      }),

    "pr.get": (p) =>
      service((pr) =>
        Effect.gen(function* () {
          const ref = yield* refOf(p);
          const [detail, summary, activity, checks, viewed, diff, records] = yield* Effect.all(
            [
              pr.detail(ref),
              pr.summary(ref).pipe(Effect.orElseSucceed(() => null)),
              pr.activity(ref).pipe(Effect.orElseSucceed(() => null)),
              pr.checks(ref).pipe(Effect.orElseSucceed(() => null)),
              pr.filesViewed(ref).pipe(Effect.orElseSucceed(() => ({ files: [], truncated: false }))),
              readDiff(pr, ref).pipe(Effect.orElseSucceed(() => ({ files: [], omitted: [] }))),
              deps.workspaces,
            ],
            { concurrency: "unbounded" },
          );
          return detailOf({
            detail,
            host: hostOf(detail.url, p.host),
            summary,
            activity,
            checks: checks?.checks ?? detail.checks,
            files: diff.files,
            viewed: new Set(viewed.files.filter((f) => f.state === "viewed").map((f) => f.path)),
            workspaceId: workspaceFor(records, detail.projectId, detail.headBranch),
          });
        }),
      ),

    "pr.diff": (p) =>
      service((pr) =>
        Effect.gen(function* () {
          const ref = yield* refOf(p);
          const diff = yield* readDiff(pr, ref);
          const wanted = p.paths ? new Set(p.paths) : undefined;
          const keep = (path: string) => wanted === undefined || wanted.has(path);
          // The head the host read these patches at, never a detail read's: a push between the two would key the
          // reader's marks and file reads to a head whose patch is not this one.
          return {
            ...(diff.headSha ? { head_sha: diff.headSha } : {}),
            ...(diff.revision ? { revision: diff.revision } : {}),
            files: diff.files.filter((f) => keep(f.path)),
            omitted: diff.omitted.filter(keep),
          };
        }),
      ),

    "pr.discussion": (p) =>
      service((pr) =>
        Effect.gen(function* () {
          const ref = yield* refOf(p);
          const activity = yield* pr.activity(ref);
          // Hunks only for threads still on the diff; a diff that cannot be read leaves them out.
          const live = activity.reviewThreads.some((t) => t.line !== null && !t.isOutdated);
          const files = live ? (yield* readDiff(pr, ref).pipe(Effect.orElseSucceed(() => ({ files: [] as Array<PatchFile> })))).files : [];
          return { items: discussionOf(activity, new Map(files.map((f) => [f.path, f.patch]))) };
        }),
      ),

    "pr.guide": (p) =>
      guides((g) =>
        Effect.gen(function* () {
          const ref = yield* refOf(p);
          return yield* guideAnswer(p.generate ? yield* g.generate(ref, { full: p.full === true }) : yield* g.get(ref));
        }),
      ),
    "pr.post_guide": (p) => guides((g) => refOf(p).pipe(Effect.flatMap((ref) => g.post(ref, "press")), Effect.flatMap(guideAnswer)), true),

    "pr.comment": (p) =>
      write(p, (pr, ref) =>
        p.thread_id !== undefined
          ? pr.replyToThread({ ...ref, threadId: p.thread_id, body: p.body })
          : p.path !== undefined && p.line !== undefined
            ? pr.submitReview({
                ...ref,
                verdict: "comment",
                body: "",
                comments: [{ path: p.path, position: p.side === "old" ? { kind: "deleted", oldLine: p.line } : { kind: "added", newLine: p.line }, body: p.body }],
              })
            : pr.comment({ ...ref, body: p.body }),
      ),
    "pr.resolve": (p) => write(p, (pr, ref) => pr.setThreadResolution({ ...ref, threadId: p.thread_id, resolved: p.resolved })),
    "pr.review": (p) =>
      write(p, (pr, ref) =>
        pr.submitReview({ ...ref, verdict: p.verdict === "request_changes" ? "request-changes" : p.verdict, body: p.body ?? "", comments: [] }),
      ),
    "pr.merge": (p) => write(p, (pr, ref) => pr.runAction({ ...ref, action: "merge", mergeMethod: p.method })),
    // A base fixed since its run needs that fix brought in (a re-run replays the same merge commit); otherwise its failed jobs run again.
    "pr.rerun": (p) =>
      p.update_branch
        ? write(p, (pr, ref) => pr.runAction({ ...ref, action: "update-branch" })).pipe(Effect.as({ rerun: 0, updated: true }))
        : Effect.gen(function* () {
            if (yield* outside) return yield* Effect.fail(refusedOutside(true));
            if (deps.githubToken === undefined) return yield* Effect.fail(unsupported("This runtime can't re-run checks"));
            if (p.host !== undefined && p.host !== "github.com") return yield* Effect.fail(unsupported("Re-running checks works on GitHub only"));
            const repo = p.repo ?? (yield* deps.projectRepository(p.project_id));
            if (!repo) return yield* Effect.fail(new ProtocolError({ reason: "not_found", message: "This project has no repository on a git host" }));
            const token = yield* deps.githubToken();
            const rerun = yield* rerunFailed({ repo, number: p.number, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).pipe(
              Effect.mapError((e) => new ProtocolError({ reason: "invalid_state", message: e.message })),
            );
            return { rerun, updated: false };
          }),
    "pr.ready": (p) => write(p, (pr, ref) => pr.runAction({ ...ref, action: "ready" })),
    "pr.viewed": (p) => write(p, (pr, ref) => pr.setFilesViewed({ ...ref, files: p.paths.map((path) => ({ path, viewed: p.viewed })) })),

    // The service reads only a file the pull request changes (anything else is its not-found), with the project's credential.
    "pr.file": (p) =>
      service((pr) =>
        Effect.gen(function* () {
          const ref = yield* refOf(p);
          const read = yield* pr.diffFileContents({
            ...ref,
            ...(p.revision ? { revision: p.revision } : {}),
            changeType: CHANGE_TYPE[p.status],
            oldPath: p.old_path ?? p.path,
            newPath: p.path,
          });
          return { old: read.oldContents, new: read.newContents };
        }),
      ),

    // Read-only and local: commits this checkout already has, never a fetch, never the working tree.
    "pr.symbol": (p) =>
      service((pr) =>
        Effect.gen(function* () {
          const [root, own] = yield* Effect.all([deps.projectRoot(p.project_id), deps.projectRepository(p.project_id)]);
          if (root === undefined) return yield* Effect.fail(unsupported("This project has no checkout on this computer to search"));
          if (p.repo !== undefined && p.repo.toLowerCase() !== own?.toLowerCase()) {
            return yield* Effect.fail(unsupported(`This computer has no checkout of ${p.repo} to search: it is not this project's repository`));
          }
          const ref = yield* refOf(p.repo === undefined && own !== undefined ? { ...p, repo: own } : p);
          const detail = yield* pr.detail(ref);
          const { at, commit } = yield* searchedCommit(root, detail.headSha, detail.baseBranch);
          const limit = Math.min(p.limit ?? SYMBOL_LIMIT, SYMBOL_LIMIT_MAX);
          // Whole word, case-sensitive, the name as written; `:(top)` and --full-name search and name from the repository's root
          // even when the project is a folder inside it. Nothing a config could turn on (columns, submodules, textconv) changes the output.
          const grep = yield* deps.git(
            root,
            ["grep", "-n", "-I", "-w", "-F", "-z", "--full-name", "--no-color", "--no-column", "--no-textconv", "--no-recurse-submodules", "-e", p.name, commit, "--", ":(top)"],
            { allowNonZeroExit: true, maxOutputBytes: SYMBOL_MAX_OUTPUT_BYTES },
          );
          // 1 is no line found.
          if (grep.exitCode !== 0 && grep.exitCode !== 1) {
            return yield* Effect.fail(new ProtocolError({ reason: "internal", message: grep.stderr.trim() || `git grep exited with ${grep.exitCode}` }));
          }
          return { at, commit, ...parseGrep(grep.stdout, commit, limit, grep.stdoutTruncated) };
        }),
      ),
  };
};

