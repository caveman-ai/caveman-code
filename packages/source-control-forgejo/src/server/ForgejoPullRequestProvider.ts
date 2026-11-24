// ), packages/source-control-forgejo/src/server/ForgejoPullRequestProvider.ts @ 13aa882c22.
import { SourceControlProviderKind } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@caveman-app/protocol";
import { decodeJsonResult } from "@caveman-app/shared/schemaJson";
import * as ForgejoCli from "./ForgejoCli.ts";
import { parseDiffFileRevisions } from "@caveman-app/source-control-core/server/diffFileRevisions";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@caveman-app/source-control-core/server/PullRequestProvider";
import {
  ForgejoPullRequest,
  ForgejoRepository,
  ForgejoUser,
  ForgejoComment,
  ForgejoReview,
  ForgejoReviewComment,
  ForgejoCommit,
  ForgejoStatus,
  ForgejoLabel,
  ForgejoReaction,
  FORGEJO_REACTIONS,
  forgejoChangeRequest,
  forgejoActor,
  forgejoComment,
  forgejoReview,
  forgejoReviewThread,
  forgejoCommit,
  forgejoChecks,
  forgejoReactions,
} from "./forgejoPullRequestJson.ts";
import { ForgejoBranchStatusChecks, markRequiredForgejoChecks } from "./forgejoRequiredChecks.ts";
import { definition } from "../client/definition.ts";

const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  viewedFiles: "environment",
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: false,
  reactions: true,
  labels: true,
  // Forgejo's public API has no thread replies/resolution or draft conversion endpoint.
  review: {
    inlineComment: true,
    reply: false,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};
const repoPath = (input: ProviderRepositoryRef) =>
  `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
const pullPath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/pulls/${input.number}`;
const issuePath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/issues/${input.number}`;
const ForgejoGitReference = Schema.Struct({
  ref: Schema.String,
  object: Schema.Struct({ sha: Schema.String }),
});
const isCommitSha = (value: string | undefined): value is string =>
  value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
/**
 * A pull request patch's revision: the two commits Forgejo diffed it between, the merge base it
 * stores and the commit its pull ref points at (`git diff <merge_base> refs/pull/<n>/head`).
 */
const formatPatchRevision = (base: string, head: string) => `${base}..${head}`;
const parsePatchRevision = (revision: string) => {
  const [base, head, ...rest] = revision.split("..");
  return rest.length === 0 && isCommitSha(base) && isCommitSha(head) ? { base, head } : null;
};
/** A patch read at `revision`, which names the head it was read at too. */
const atPatchRevision = <A extends object>(slice: A, revision: string) => {
  const head = parsePatchRevision(revision)?.head;
  return { ...slice, revision, ...(head === undefined ? {} : { headSha: head }) };
};
// Review IDs differ from the issue-comment IDs used by Forgejo's reactions API.
const reviewCommentId = (review: typeof ForgejoReview.Type) =>
  /#issuecomment-([1-9]\d*)$/.exec(review.html_url ?? "")?.[1];

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("forgejo"),
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const request = (input: ForgejoCli.ForgejoApiInput) =>
    cli.api(input).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: SourceControlProviderKind.make("forgejo"),
            operation: input.path,
            detail: error.detail,
            cause: error,
            reason:
              error.reason === "missing-cli"
                ? "missing-tool"
                : error.reason === "authentication"
                  ? "unauthenticated"
                  : error.reason === "rate-limit"
                    ? "rate-limited"
                    : error.reason === "not-found"
                      ? "not-found"
                      : "failed",
          }),
      ),
    );
  const read = Effect.fn("ForgejoPullRequestProvider.read")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const result = yield* request(input);
    if (result.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(schema)(result.stdout);
    return Result.isSuccess(decoded)
      ? decoded.success
      : yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
  });
  const readArray = <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
  ) => read(input, Schema.NullOr(Schema.Array(schema))).pipe(Effect.map((rows) => rows ?? []));
  const readPage = Effect.fn("ForgejoPullRequestProvider.readPage")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    index: number,
  ) {
    const result = yield* request({
      ...input,
      path: `${input.path}${input.path.includes("?") ? "&" : "?"}limit=50&page=${index}`,
    });
    if (result.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(schema)))(result.stdout);
    if (Result.isFailure(decoded))
      return yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
    const rows = decoded.success ?? [];
    const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
    return {
      rows,
      more: rows.length > 0 && (links === undefined || /rel="?next"?/i.test(links)),
    };
  });
  // Use a stable, small page size that also works with Forgejo's default maximum of 50.
  const page = Effect.fn("ForgejoPullRequestProvider.page")(function* <A>(
    input: ForgejoCli.ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    limit = 500,
  ) {
    const items: A[] = [];
    for (let index = 1; items.length < limit; index++) {
      const { rows, more } = yield* readPage(input, schema, index);
      items.push(...rows);
      if (!more) return { items, truncated: false };
    }
    return { items, truncated: true };
  });
  const write = (input: ForgejoCli.ForgejoApiInput) => request(input).pipe(Effect.asVoid);
  const getPull = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read(
      {
        cwd: input.cwd,
        repository: input.repository,
        host: input.host,
        path: pullPath(input),
      },
      ForgejoPullRequest,
    );
  /** The commit a pull request's pull ref points at in the base repository. */
  const pullRefHead = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read(
      { ...input, path: `${repoPath(input)}/git/refs/pull/${input.number}/head` },
      // One reference answering the filter exactly comes back bare, anything else as a list.
      Schema.Union([ForgejoGitReference, Schema.Array(ForgejoGitReference)]),
    ).pipe(
      Effect.map(
        (found) =>
          (Array.isArray(found) ? found : [found]).find(
            (reference) => reference.ref === `refs/pull/${input.number}/head`,
          )?.object.sha,
      ),
    );
  /**
   * The revision a pull request's patch is read at now, or null where Forgejo does not say both
   * sides. The patch itself names neither.
   */
  const patchRevisionNow = (input: ProviderRepositoryRef & { readonly number: number }) =>
    Effect.all([getPull(input), pullRefHead(input)], { concurrency: 2 }).pipe(
      Effect.map(([pr, head]) =>
        isCommitSha(pr.merge_base) && isCommitSha(head)
          ? formatPatchRevision(pr.merge_base, head)
          : null,
      ),
    );
  const getRepo = (input: ProviderRepositoryRef) =>
    read({ ...input, path: repoPath(input) }, ForgejoRepository);
  const getViewer = (input: {
    readonly cwd: string;
    readonly repository?: string;
    readonly host?: string;
  }) => read({ ...input, path: "user" }, ForgejoUser).pipe(Effect.map((user) => user.login));
  const permissions = (
    repo: typeof ForgejoRepository.Type,
    pr: typeof ForgejoPullRequest.Type,
    viewer: string,
  ): PullRequestViewerPermissions => {
    const canWrite = repo.permissions?.push ?? false;
    const canEdit = canWrite || pr.user?.login === viewer;
    const active = !repo.archived;
    return {
      actions: active
        ? CAPABILITIES.actions.filter((action) =>
            action === "merge" || action === "update-branch" ? canWrite : canEdit,
          )
        : [],
      comment: active && (!pr.is_locked || canWrite),
      resolve: false,
      verdicts: active
        ? pr.user?.login === viewer
          ? ["comment"]
          : CAPABILITIES.review.verdicts
        : [],
      requestReviewers: active && canEdit,
      labels: active && canWrite,
      updateMethods:
        active && canWrite ? (repo.allow_rebase_update ? ["merge", "rebase"] : ["merge"]) : [],
    };
  };
  const getPermissions = Effect.fn("ForgejoPullRequestProvider.getPermissions")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const [repo, pr, viewer] = yield* Effect.all(
      [getRepo(input), getPull(input), getViewer(input)],
      { concurrency: 3 },
    );
    return permissions(repo, pr, viewer);
  });
  const readChecks = Effect.fn("ForgejoPullRequestProvider.readChecks")(function* (
    input: ProviderRepositoryRef,
    pr: typeof ForgejoPullRequest.Type,
  ) {
    const branch = read(
      {
        ...input,
        path: `${repoPath(input)}/branches/${pr.base.ref.split("/").map(encodeURIComponent).join("/")}`,
      },
      ForgejoBranchStatusChecks,
    ).pipe(
      Effect.catchTags({
        PullRequestProviderError: (error) => {
          if (
            isForgejoCliError(error.cause) &&
            (error.cause.reason === "forbidden" || error.cause.reason === "not-found")
          ) {
            return Effect.succeed({});
          }
          return Effect.fail(error);
        },
      }),
    );
    const [statuses, policy] = yield* Effect.all(
      [
        page(
          {
            ...input,
            path: `${repoPath(input)}/statuses/${encodeURIComponent(pr.head.sha)}?sort=recentupdate`,
          },
          ForgejoStatus,
        ),
        branch,
      ],
      { concurrency: 2 },
    );
    return markRequiredForgejoChecks(forgejoChecks(statuses.items, pr.html_url), policy);
  });
  const unsupported = (operation: string) =>
    Effect.fail(failure(operation, `Forgejo does not expose ${operation} through its API.`));
  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("forgejo"),
    capabilities: CAPABILITIES,
    getViewer,
    listChangeRequests: Effect.fn("ForgejoPullRequestProvider.listChangeRequests")(
      function* (input) {
        const offset = input.cursor?.delivered ?? 0;
        const items: ReturnType<typeof forgejoChangeRequest>[] = [];
        const state = input.state === "merged" ? "closed" : input.state;
        const query = {
          ...input,
          path: `${repoPath(input)}/pulls?state=${state}&sort=recentupdate`,
        };
        // Self-hosted servers may cap pages below 50. Establish their actual page size before
        // translating the service's row offset into an API page number.
        const first = yield* readPage(query, Schema.NullOr(ForgejoPullRequest), 1);
        const pageSize = first.rows.length || 50;
        const firstIndex = Math.floor(offset / pageSize) + 1;
        let consumed = 0;
        let more = true;
        // Forgejo has no merged list state: `state=closed` returns merged and closed-unmerged
        // rows alike. Only rows in the requested state count toward the limit, and the cursor
        // advances past every row read.
        for (let index = firstIndex; more && items.length < input.limit; index++) {
          const result =
            index === 1 ? first : yield* readPage(query, Schema.NullOr(ForgejoPullRequest), index);
          const rows = result.rows;
          const start = index === firstIndex ? offset % pageSize : 0;
          const countBefore = consumed;
          for (const row of rows.slice(start)) {
            if (items.length >= input.limit) break;
            consumed++;
            if (!row) continue;
            const changeRequest = forgejoChangeRequest(row);
            if (input.state !== "all" && changeRequest.state !== input.state) continue;
            items.push(changeRequest);
          }
          more = result.more || rows.length - start > consumed - countBefore;
        }
        return { items, truncated: more, continues: true, cursorAdvance: consumed };
      },
    ),
    getChangeRequestPreview: (input) => getPull(input).pipe(Effect.map(forgejoChangeRequest)),
    getChangeRequestSummary: (input) => getPull(input).pipe(Effect.map(forgejoChangeRequest)),
    getChangeRequestChecks: Effect.fn("ForgejoPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pr = yield* getPull(input);
        return { state: forgejoChangeRequest(pr).state, checks: yield* readChecks(input, pr) };
      },
    ),
    getChangeRequest: Effect.fn("ForgejoPullRequestProvider.getChangeRequest")(function* (input) {
      const [pr, repo, viewer] = yield* Effect.all(
        [getPull(input), getRepo(input), getViewer(input)],
        { concurrency: 3 },
      );
      const checks = yield* readChecks(input, pr);
      return {
        ...forgejoChangeRequest(pr),
        headSha: pr.head.sha,
        body: pr.body ?? "",
        changedFiles: pr.changed_files ?? 0,
        reviewers: (pr.requested_reviewers ?? []).flatMap((user) => {
          const actor = forgejoActor(user);
          return actor ? [actor] : [];
        }),
        checks,
        baseComparison: !pr.merge_base
          ? "unknown"
          : pr.merge_base === pr.base.sha
            ? "up-to-date"
            : "behind",
        viewerPermissions: permissions(repo, pr, viewer),
        mergeCapabilities: {
          merge: repo.allow_merge_commits ?? true,
          squash: repo.allow_squash_merge ?? true,
          rebase: repo.allow_rebase ?? true,
        },
      } satisfies ProviderChangeRequestDetail;
    }),
    getViewerPermissions: getPermissions,
    getChangeRequestActivity: Effect.fn("ForgejoPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const [comments, reviews, commits, reactions, viewer] = yield* Effect.all(
          [
            // Issue comments ignore page/limit; fetch this unpaginated endpoint once.
            readArray({ ...input, path: `${issuePath(input)}/comments` }, ForgejoComment).pipe(
              Effect.map((items) => ({
                items: items.slice(0, 500),
                truncated: items.length > 500,
              })),
            ),
            page({ ...input, path: `${pullPath(input)}/reviews` }, ForgejoReview),
            // Without these, each commit lists its files and a big merge outgrows the output limit.
            page(
              { ...input, path: `${pullPath(input)}/commits?files=false&verification=false` },
              ForgejoCommit,
            ),
            page({ ...input, path: `${issuePath(input)}/reactions` }, ForgejoReaction),
            getViewer(input),
          ],
          { concurrency: 5 },
        );
        const reviewComments = yield* Effect.forEach(
          reviews.items.filter((review) => review.comments_count > 0 && review.state !== "PENDING"),
          (review) =>
            readArray(
              { ...input, path: `${pullPath(input)}/reviews/${review.id}/comments` },
              ForgejoReviewComment,
            ),
          { concurrency: 4 },
        );
        const allInline = reviewComments.flat();
        const inline = allInline.slice(0, 500);
        const entries = [
          ...comments.items.map((comment) => ({
            comment: forgejoComment(comment),
            reactionId: String(comment.id),
          })),
          ...reviews.items
            .filter((review) => review.state !== "PENDING" && review.state !== "REQUEST_REVIEW")
            .map((review) => ({
              comment: forgejoReview(review),
              reactionId: reviewCommentId(review),
            })),
          ...inline.map((comment) => ({
            comment: {
              ...forgejoComment(comment),
              kind: "review-comment" as const,
              path: comment.path,
            },
            reactionId: String(comment.id),
          })),
        ];
        const enriched = yield* Effect.forEach(
          entries,
          ({ comment, reactionId }) =>
            (reactionId === undefined
              ? Effect.succeed([])
              : readArray(
                  { ...input, path: `${repoPath(input)}/issues/comments/${reactionId}/reactions` },
                  ForgejoReaction,
                )
            ).pipe(
              Effect.map((rows) => ({ ...comment, reactions: forgejoReactions(rows, viewer) })),
            ),
          { concurrency: 4 },
        );
        const byId = new Map(enriched.map((comment) => [comment.id, comment]));
        const timeline = enriched.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
        return {
          comments: timeline,
          commentCount: timeline.length,
          commentsTruncated:
            comments.truncated || reviews.truncated || allInline.length > inline.length,
          reviewThreads: inline.map((comment) => ({
            ...forgejoReviewThread(comment),
            comments: [byId.get(String(comment.id)) ?? forgejoComment(comment)],
          })),
          commits: commits.items.map(forgejoCommit),
          reactions: forgejoReactions(reactions.items, viewer),
        };
      },
    ),
    getFileRevisions: Effect.fn("ForgejoPullRequestProvider.getFileRevisions")(function* (input) {
      const result = yield* request({ ...input, path: `${pullPath(input)}.diff` });
      if (result.stdoutTruncated) {
        return yield* failure("getFileRevisions", "Forgejo diff exceeded the output limit.");
      }
      const revisions = new Map(parseDiffFileRevisions(result.stdout));
      for (const path of input.paths) {
        if (!revisions.has(path)) revisions.set(path, "");
      }
      return { revisions, complete: true };
    }),
    getDiff: (input) => {
      const readPatch = () =>
        request({
          ...input,
          path: input.commit
            ? `${repoPath(input)}/git/commits/${encodeURIComponent(input.commit)}.diff`
            : `${pullPath(input)}.diff`,
        }).pipe(
          Effect.map((result) => ({
            patch: result.stdout,
            truncated: result.stdoutTruncated,
            nextCursor: null,
          })),
        );
      // A commit's own changes are pinned by the commit.
      if (input.commit) return readPatch();
      // Forgejo serves only the newest patch and names in it neither side it was read between,
      // so the revision is read either side of the patch: only one that did not move between the
      // two is the one the patch came from.
      return Effect.gen(function* () {
        const revision = input.revision;
        if (revision !== undefined) {
          const current = () => patchRevisionNow(input).pipe(Effect.map((now) => now === revision));
          if (parsePatchRevision(revision) !== null && (yield* current())) {
            const slice = yield* readPatch();
            if (yield* current()) return atPatchRevision(slice, revision);
          }
          return yield* new PullRequestProviderError({
            provider: SourceControlProviderKind.make("forgejo"),
            operation: "getDiff",
            reason: "not-found",
            detail:
              "The pull request has moved on from the revision this patch was read at, and " +
              "Forgejo serves only its newest patch. Read the patch again.",
          });
        }
        // Asked for the patch as it is now, a revision that cannot be read leaves it unnamed
        // rather than unread. Only a CLI or account that cannot read at all fails it.
        const revisionIfReadable = () =>
          patchRevisionNow(input).pipe(
            Effect.catch((error) =>
              error.reason === "missing-tool" ||
              error.reason === "unauthenticated" ||
              error.reason === "rate-limited"
                ? Effect.fail(error)
                : Effect.succeed(null),
            ),
          );
        const before = yield* revisionIfReadable();
        const slice = yield* readPatch();
        if (before === null) return slice;
        return (yield* revisionIfReadable()) === before ? atPatchRevision(slice, before) : slice;
      });
    },
    getDiffFileContents: Effect.fn("ForgejoPullRequestProvider.getDiffFileContents")(
      function* (input) {
        // The patch's own revision, so the lines opened match its hunks after a push. Both of its
        // commits are in the base repository, which holds the pull ref. The service opens only a
        // file the patch at this revision names, which Forgejo serves only while it is the newest.
        const named =
          input.commit || input.revision === undefined ? null : parsePatchRevision(input.revision);
        if (!input.commit && input.revision !== undefined && named === null) {
          return yield* new PullRequestProviderError({
            provider: SourceControlProviderKind.make("forgejo"),
            operation: "getDiffFileContents",
            reason: "not-found",
            detail: "Forgejo has no such revision of this pull request.",
          });
        }
        const content = (repository: string, ref: string, path: string) =>
          read(
            {
              ...input,
              repository,
              path: `${repoPath({ ...input, repository })}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
            },
            Schema.Struct({ content: Schema.String, encoding: Schema.Literal("base64") }),
          ).pipe(Effect.map((file) => Buffer.from(file.content, "base64").toString("utf8")));
        if (named !== null) {
          const [oldContents, newContents] = yield* Effect.all(
            [
              input.changeType === "new"
                ? Effect.succeed("")
                : content(input.repository, named.base, input.oldPath),
              input.changeType === "deleted"
                ? Effect.succeed("")
                : content(input.repository, named.head, input.newPath),
            ],
            { concurrency: 2 },
          );
          return { oldContents, newContents };
        }
        const pr = yield* getPull(input);
        const commit = input.commit
          ? yield* read(
              {
                ...input,
                path: `${repoPath(input)}/git/commits/${encodeURIComponent(input.commit)}?files=false&verification=false`,
              },
              ForgejoCommit,
            )
          : null;
        const oldRef = commit ? commit.parents[0]?.sha : pr.merge_base || pr.base.sha;
        const newRef = input.commit ?? pr.head.sha;
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new" || !oldRef
              ? Effect.succeed("")
              : content(input.repository, oldRef, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : content(pr.head.repo?.full_name ?? input.repository, newRef, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    runAction: (input) => {
      switch (input.action) {
        case "merge":
          return Effect.gen(function* () {
            const deleteBranch = (yield* getRepo(input)).default_delete_branch_after_merge ?? false;
            yield* write({
              ...input,
              path: `${pullPath(input)}/merge`,
              method: "POST",
              body: { Do: input.mergeMethod ?? "merge", delete_branch_after_merge: deleteBranch },
            }).pipe(
              Effect.catchTags({
                // Forgejo merges before deleting the branch, so a refused deletion still merged.
                PullRequestProviderError: (error) =>
                  deleteBranch
                    ? getPull(input).pipe(
                        Effect.mapError(() => error),
                        Effect.flatMap((pr) => (pr.merged ? Effect.void : Effect.fail(error))),
                      )
                    : Effect.fail(error),
              }),
            );
          });
        case "close":
        case "reopen":
          return write({
            ...input,
            path: pullPath(input),
            method: "PATCH",
            body: { state: input.action === "close" ? "closed" : "open" },
          });
        case "update-branch":
          return write({
            ...input,
            path: `${pullPath(input)}/update?style=${input.updateMethod ?? "merge"}`,
            method: "POST",
          });
        default:
          return unsupported(input.action);
      }
    },
    updateChangeRequest: (input) =>
      write({
        ...input,
        path: pullPath(input),
        method: "PATCH",
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),
    comment: (input) =>
      write({
        ...input,
        path: `${issuePath(input)}/comments`,
        method: "POST",
        body: { body: input.body },
      }),
    updateComment: (input) =>
      write({
        ...input,
        path: `${repoPath(input)}/issues/comments/${encodeURIComponent(input.commentId)}`,
        method: "PATCH",
        body: { body: input.body },
      }),
    submitReview: Effect.fn("ForgejoPullRequestProvider.submitReview")(function* (input) {
      const pr = yield* getPull(input);
      yield* write({
        ...input,
        path: `${pullPath(input)}/reviews`,
        method: "POST",
        body: {
          event:
            input.verdict === "approve"
              ? "APPROVED"
              : input.verdict === "request-changes"
                ? "REQUEST_CHANGES"
                : "COMMENT",
          body: input.body,
          commit_id: pr.head.sha,
          comments: input.comments.map((comment) => {
            const position = comment.position;
            const old =
              position.kind === "deleted" ||
              (position.kind === "context" && position.side === "left");
            return {
              path: old ? (comment.oldPath ?? comment.path) : comment.path,
              body: comment.body,
              old_position: old ? position.oldLine : 0,
              new_position: old ? 0 : position.newLine,
            };
          }),
        },
      });
    }),
    listReviewerCandidates: Effect.fn("ForgejoPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const [pr, users] = yield* Effect.all(
          [getPull(input), page({ ...input, path: `${repoPath(input)}/assignees` }, ForgejoUser)],
          { concurrency: 2 },
        );
        return {
          candidates: users.items
            .filter((user) => user.login !== pr.user?.login)
            .flatMap((user) => {
              const actor = forgejoActor(user);
              return actor
                ? [
                    {
                      ...actor,
                      id: user.login,
                      kind: "user" as const,
                      isRequested:
                        pr.requested_reviewers?.some((reviewer) => reviewer.login === user.login) ??
                        false,
                    },
                  ]
                : [];
            }),
          truncated: users.truncated,
        };
      },
    ),
    setReviewerRequest: (input) =>
      write({
        ...input,
        path: `${pullPath(input)}/requested_reviewers`,
        method: input.requested ? "POST" : "DELETE",
        body: { reviewers: input.reviewers.map((reviewer) => reviewer.id) },
      }),
    listLabelCandidates: Effect.fn("ForgejoPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const [pr, labels] = yield* Effect.all(
          [getPull(input), page({ ...input, path: `${repoPath(input)}/labels` }, ForgejoLabel)],
          { concurrency: 2 },
        );
        return {
          candidates: labels.items.map((label) => ({
            name: label.name,
            color: label.color ?? null,
            description: label.description ?? null,
            isApplied: pr.labels?.some((applied) => applied.id === label.id) ?? false,
          })),
          truncated: labels.truncated,
        };
      },
    ),
    setLabels: Effect.fn("ForgejoPullRequestProvider.setLabels")(function* (input) {
      const labels = yield* page({ ...input, path: `${repoPath(input)}/labels` }, ForgejoLabel);
      const selected = labels.items.filter((label) => input.labels.includes(label.name));
      if (selected.length !== input.labels.length)
        return yield* failure("setLabels", "One or more requested labels could not be found.");
      if (input.applied)
        yield* write({
          ...input,
          path: `${issuePath(input)}/labels`,
          method: "POST",
          body: { labels: selected.map((label) => label.id) },
        });
      else
        yield* Effect.forEach(
          selected,
          (label) =>
            write({ ...input, path: `${issuePath(input)}/labels/${label.id}`, method: "DELETE" }),
          { concurrency: 1 },
        );
    }),
    setReaction: Effect.fn("ForgejoPullRequestProvider.setReaction")(function* (input) {
      let commentId = input.subjectId;
      if (commentId?.startsWith("review:")) {
        const reviewId = /^review:([1-9]\d*)$/.exec(commentId)?.[1];
        if (!reviewId) return yield* failure("setReaction", "Invalid Forgejo review ID.");
        const review = yield* read(
          { ...input, path: `${pullPath(input)}/reviews/${reviewId}` },
          ForgejoReview,
        );
        commentId = reviewCommentId(review);
        if (!commentId)
          return yield* failure(
            "setReaction",
            "Forgejo did not return a comment ID for this review.",
          );
      }
      if (commentId && !/^[1-9]\d*$/.test(commentId))
        return yield* failure("setReaction", "Invalid Forgejo comment ID.");
      yield* write({
        ...input,
        path: commentId
          ? `${repoPath(input)}/issues/comments/${commentId}/reactions`
          : `${issuePath(input)}/reactions`,
        method: input.reacted ? "POST" : "DELETE",
        body: { content: FORGEJO_REACTIONS[input.content] },
      });
    }),
    replyToThread: () => unsupported("thread replies"),
    setThreadResolution: () => unsupported("thread resolution"),
  };
  return provider;
});
