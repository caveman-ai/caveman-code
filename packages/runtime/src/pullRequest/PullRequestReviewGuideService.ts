// ), apps/server/src/pullRequest/PullRequestReviewGuideService.ts @ ab3a3cd1.
/**
 * Guided reviews: a maintainer-facing brief on a pull request, written by the environment's
 * source-control writer model. See `PullRequestReviewGuide` in contracts for what a guide is for.
 *
 * The cheapest tier that fits writes it (pullRequestReviewGuideLadder.ts): a template for a
 * dependency bump or mechanical files, one call over the diff when it fits, and otherwise a run
 * that reads a disposable checkout of the head, so a guide has no size limit. That takes minutes on
 * a large change, so a run belongs to the server rather than to the request that started it:
 * Generate returns as soon as the run is under way and readers watch its state through `get`.
 *
 * Generation is explicit and the result is stored per pull request, so opening a guide never
 * spends a model run. A push leaves the stored guide in place and the reader sees it as stale.
 *
 * A short change's guide is its TL;DR alone, and the chat that opened a pull request may write
 * that TL;DR itself as it links it (`fromChat`), on the context its model already holds: a short
 * change then needs no other run, and a long one's tour is written from it.
 *
 * @module pullRequest/PullRequestReviewGuideService
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type ModelSelection,
  PullRequestOperationError,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReviewGuide,
  type PullRequestReviewGuideResult,
  type PullRequestReviewGuideRun,
  type PullRequestStack,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
  type ServerProvider,
  TextGenerationError,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@caveman-app/protocol";
import type {
  ReviewGuideStackLayer,
  TextGenerationUsage,
} from "@caveman-app/engine-core/server/textGeneration";
import { reviewGuideWriterRank } from "@caveman-app/shared/serverSettings";
import { resolveProjectSettings } from "@caveman-app/shared/projectSettings";
import { sourceControlRepositorySelector } from "@caveman-app/shared/sourceControl";

import * as ServerConfig from "../config.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SessionStore } from "../session-protocol/store.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";
import { reviewGuideInputFromPullRequest } from "./pullRequestReviewGuideInput.ts";
import {
  changeMap,
  checkGuide,
  chooseTier,
  filteredDiff,
  nextModelUp,
  parseChangeFiles,
  type ReviewGuideTier,
  templateGuide,
  WIDE_SINGLE_PASS_DIFF_BYTES,
} from "./pullRequestReviewGuideLadder.ts";
import {
  clampExcerpt,
  clampLine,
  normalizeReviewGuide,
  parseReviewGuideChange,
} from "./pullRequestReviewGuideNormalize.ts";
import {
  guideWorthPosting,
  guideWriterLabel,
  isGuideComment,
  readGuideComment,
  renderGuideComment,
} from "./pullRequestReviewGuideComment.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/;
/** Slices of the host's diff read for a guide comment; GitHub serves 300 files a slice. */
const HOST_DIFF_SLICES = 20;

export class PullRequestReviewGuideService extends Context.Service<
  PullRequestReviewGuideService,
  {
    /** The stored guide, any run in progress, and the head now. Never runs a model. */
    readonly get: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewGuideResult, PullRequestService.PullRequestError>;
    /** Whether a guide is stored for the pull request, for any head. Reads no host, for a listing. */
    readonly stored: (
      input: PullRequestRef,
    ) => Effect.Effect<boolean, PullRequestService.PullRequestError>;
    /**
     * Start writing a guide for the current head and return once it is under way. Joins a run
     * already going for that head. A stored guide stays readable until the new one replaces it,
     * so a reader can rewrite one after changing the guide model or instructions. `started` says
     * whether this call began the run or joined one already going. `full` writes the tour even
     * for a short change, and replaces a run going for that head that may write only its TL;DR.
     */
    readonly generate: (
      input: PullRequestRef,
      options?: { readonly full?: boolean },
    ) => Effect.Effect<
      PullRequestReviewGuideResult & { readonly started: boolean },
      PullRequestService.PullRequestError
    >;
    /**
     * Write a guide for the current head in the background, before anyone asks, and resolve when
     * the run ends. Skipped where a guide for that head is stored, a run is going, a run for that
     * head failed, or any person's run is going: a person always goes first. `writers` are tried
     * in order, each at most once more on a checkout, never stepping up to a bigger model; with
     * none only a template guide is written, and a change that needs a model is left for later. A
     * prewarm that fails records nothing a reader sees.
     */
    readonly prewarm: (
      input: PullRequestRef,
      writers: ReadonlyArray<ModelSelection>,
    ) => Effect.Effect<ReviewGuidePrewarmOutcome, PullRequestService.PullRequestError>;
    /**
     * Store the TL;DR the chat that opened a pull request wrote as it linked it, as the guide for
     * the current head: a short change's whole guide, a long one's start (a prewarm still writes
     * its tour, checking this TL;DR against the diff). Only while guides and chat TL;DRs are on,
     * and never over a guide written for that head another way. `modelSelection` is the chat's
     * model, when known. Resolves to whether it was stored.
     */
    readonly fromChat: (
      input: PullRequestRef,
      chat: {
        readonly tldr: string;
        readonly threadId: ThreadId;
        readonly modelSelection?: ModelSelection | undefined;
      },
    ) => Effect.Effect<boolean, PullRequestService.PullRequestError>;
    /**
     * Post the guide for the current head as the pull request's guide comment, or rewrite the one the signed-in
     * person posted, and resolve to what `get` reads then. "press": a person asked, for any guide, refused with
     * the reason when it cannot be. "link": a chat here opened the pull request: posted while `reviewGuidePost`
     * is on and it is the person's own, once it is worth a comment (`guideWorthPosting`); a guide not yet worth
     * one is posted when a later one is. Either way, from then on a guide written here edits that comment.
     */
    readonly post: (
      input: PullRequestRef,
      reason: "press" | "link",
    ) => Effect.Effect<PullRequestReviewGuideResult, PullRequestService.PullRequestError>;
  }
>()("t3/pullRequest/PullRequestReviewGuideService") {}

/**
 * What a prewarm did: the tier it wrote at, or why it wrote nothing. "chat": the change is short
 * and the TL;DR its chat wrote is its whole guide.
 */
export type ReviewGuidePrewarmOutcome = ReviewGuideTier | "chat" | "adopted" | "skipped" | "needs-model" | "failed";

const keyString = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

/** The engine a spend row names for a harness (the session protocol's engine ids). */
export const engineOfDriver = (driver: string) => (driver === "claudeAgent" ? "claude-agent" : driver);

/**
 * A guide run's usage as a runtime-level spend row: tokens always, dollars only on an API key. A
 * login of unknown kind (Claude's own login when it does not name the plan) is not priced either:
 * the CLI's list price would overstate what a plan costs per call.
 */
export function reviewGuideSpendUsage(
  selection: ModelSelection,
  provider: ServerProvider | undefined,
  usage: TextGenerationUsage,
) {
  const rank = provider === undefined ? 1 : reviewGuideWriterRank(provider, selection.model);
  const plan = rank === 0;
  const apiKey = rank >= 2;
  return {
    engine: engineOfDriver(provider?.driver ?? selection.instanceId),
    bucket: "review-guide",
    model: selection.model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    cost:
      apiKey && usage.costUsd !== undefined
        ? { usd: usage.costUsd, basis: "list_price" as const }
        : null,
    ...(plan ? { billing: "plan" as const } : apiKey ? { billing: "api_key" as const } : {}),
  };
}

export interface ReviewGuideServiceOptions {
  /**
   * The largest filtered diff written in a single pass; larger ones read a checkout. Wins over
   * the `reviewGuideSinglePassKb` setting, for tests.
   */
  readonly singlePassDiffBytes?: number;
}

/**
 * The pull request's guide comment, by who posted it: the signed-in person's own (`mine`, the one kept current from
 * here), else one its author posted (`trusted`: read as the guide), else anyone's, which is only shown. Bots are
 * left out of the first two. Comments read oldest first, so each is the first posted.
 */
export function guideComments(detail: PullRequestDetail, activity: PullRequestActivity) {
  const posted = activity.comments.filter((comment) => comment.kind === "issue-comment" && isGuideComment(comment.body));
  const by = (login: string | undefined) =>
    login === undefined
      ? undefined
      : posted.find((comment) => comment.author?.isBot !== true && comment.author?.login.toLowerCase() === login.toLowerCase());
  const mine = by(detail.viewer);
  const trusted = mine ?? by(detail.author?.login);
  return { mine, trusted, any: trusted ?? posted[0] } satisfies Record<string, PullRequestComment | undefined>;
}

/** The TL;DR the chat that opened the pull request wrote for `headSha`, if that is what is stored. */
const chatTldrAt = (guide: PullRequestReviewGuide | null, headSha: string) =>
  guide?.headSha === headSha && guide.writer?.tier === "chat" ? guide.tldr : undefined;

const makeWith = (options: ReviewGuideServiceOptions) => Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const guides = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  // Guide runs record their usage beside the runtime's other side calls, when the store is here.
  const spendStore = yield* Effect.serviceOption(SessionStore);
  // Runs outlive the request that started them and end with the server.
  const serviceScope = yield* Effect.scope;
  // In memory on purpose: a restart drops a run in progress, and a reader presses Generate again.
  const runs = yield* Ref.make<ReadonlyMap<string, PullRequestReviewGuideRun>>(new Map());
  // Names each run's private git refs; unique for the server's lifetime, like the runs map.
  let runCounter = 0;
  // Claiming a run and storing a finished guide take turns, so a run that still owns its pull
  // request when it checks is the one whose guide is stored: a newer claim cannot land between.
  const ownership = yield* Semaphore.make(1);
  // The pull requests a prewarm run holds now, and the heads a prewarm could not write, so a
  // pass does not retry them: failed, or needing a model it was not given.
  const prewarming = new Set<string>();
  const prewarmed = new Map<string, { readonly headSha: string; readonly outcome: ReviewGuidePrewarmOutcome }>();
  // The runs a person started with `full`, which write the tour whatever the change's size.
  const touring = new WeakSet<PullRequestReviewGuideRun>();
  // The runs a person's press joined rather than started.
  const joined = new WeakSet<PullRequestReviewGuideRun>();

  const keyFor = Effect.fn("PullRequestReviewGuideService.keyFor")(function* (
    input: PullRequestRef,
  ) {
    const shell = Option.getOrUndefined(
      yield* projects.getShell(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    // Caveman Code: a shell's identity is whatever enrichment had cached, absent for a moment each
    // time that expires; it is read straight from the checkout then, as PullRequestService does.
    const project =
      shell === undefined || shell.repositoryIdentity != null || Option.isNone(identities)
        ? shell
        : { ...shell, repositoryIdentity: yield* identities.value.resolve(shell.workspaceRoot) };
    const key = pullRequestSyncKey(input, project?.repositoryIdentity ?? undefined);
    if (key === null || project === undefined) {
      return yield* new PullRequestOperationError({
        operation: "reviewGuide",
        detail: "Could not identify this pull request's host.",
      });
    }
    return { key, workspaceRoot: project.workspaceRoot, identity: project.repositoryIdentity };
  });

  /**
   * A guide reads the change in a checkout fetched from the project's own remote, so the pull
   * request has to be in that repository. One from another repository is refused rather than
   * measured against commits that are not its own.
   */
  const requireOwnRepository = Effect.fn("PullRequestReviewGuideService.requireOwnRepository")(
    function* (key: ThreadPullRequestKey, identity: RepositoryIdentity | null | undefined) {
      const own =
        identity == null
          ? null
          : pullRequestSyncKey(
              {
                projectId: ProjectId.make("own"),
                number: key.number,
                repository: sourceControlRepositorySelector(identity) ?? "",
              },
              identity,
            );
      if (
        identity == null ||
        own === null ||
        own.host !== key.host ||
        own.repository !== key.repository
      ) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail:
            "Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
        });
      }
      return identity.locator;
    },
  );

  const readStored = (key: ThreadPullRequestKey) =>
    guides.get(key).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "reviewGuide",
            detail: "Could not read the stored review guide.",
            cause,
          }),
      ),
      Effect.map(Option.getOrNull),
    );

  // ---------------------------------------------------------------- the guide on the pull request

  // Posts take turns, so two for one pull request never both create its comment.
  const posting = yield* Semaphore.make(1);
  // Pull requests a chat here opened whose guide is posted as soon as one is worth a comment.
  const postWhenWorth = new Set<string>();

  /** The host's diff of the pull request, file by file, as its reviewers see it there. */
  const hostChange = Effect.fn("PullRequestReviewGuideService.hostChange")(function* (input: PullRequestRef) {
    let patch = "";
    let cursor: string | undefined;
    for (let slice = 0; slice < HOST_DIFF_SLICES; slice++) {
      const read = yield* pullRequests.diff({ ...input, ...(cursor === undefined ? {} : { cursor }) });
      patch += read.patch === "" || read.patch.endsWith("\n") ? read.patch : `${read.patch}\n`;
      if (read.nextCursor === null) break;
      cursor = read.nextCursor;
    }
    return parseChangeFiles(patch);
  });

  /** Who wrote a guide, as its comment's footer says it: "Claude Haiku 5.5 · single pass". */
  const writerLabelOf = (guide: PullRequestReviewGuide) =>
    providerRegistry.getProviders.pipe(
      Effect.map(
        (providers) =>
          providers
            .find((provider) => provider.instanceId === guide.modelSelection.instanceId)
            ?.models.find((model) => model.slug === guide.modelSelection.model)?.name ?? guide.modelSelection.model,
      ),
      Effect.orElseSucceed(() => guide.modelSelection.model),
      Effect.map((model) => guideWriterLabel(guide, model)),
    );

  /** May this person post the guide here: a host whose comments render it, and they may comment. */
  const canPost = (detail: PullRequestDetail) => detail.provider === "github" && detail.viewerPermissions.comment;

  /**
   * The guide the author's (or this person's own) comment carries for the head now, held to the host's diff like
   * one written here and stored, so this computer spends nothing on it. Null when there is no such comment for
   * this head, or a guide for it was stored meanwhile.
   */
  const adopt = Effect.fn("PullRequestReviewGuideService.adopt")(function* (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    detail: PullRequestDetail,
    activity: PullRequestActivity,
  ) {
    const comment = guideComments(detail, activity).trusted;
    const posted = comment === undefined ? null : readGuideComment(comment.body);
    const headSha = detail.headSha;
    if (comment?.author == null || comment.url === null || posted === null || headSha === undefined || posted.headSha !== headSha) {
      return null;
    }
    const files = yield* hostChange(input);
    const shaped = normalizeReviewGuide(
      {
        stops: posted.stops,
        ...(posted.depth ? { depth: posted.depth } : {}),
        ...(posted.tldr ? { tldr: posted.tldr } : {}),
        ...(posted.attention ? { attention: posted.attention } : {}),
        ...(posted.overview ? { overview: posted.overview } : {}),
        ...(posted.beforeAfter ? { beforeAfter: posted.beforeAfter } : {}),
      },
      parseReviewGuideChange(files.map((file) => file.path).join("\0"), files.map((file) => file.patch).join("")),
    );
    const guide: PullRequestReviewGuide = {
      headSha,
      generatedAt: posted.generatedAt,
      // Only the model's id travels: the writer's provider instance is theirs.
      modelSelection: { instanceId: ProviderInstanceId.make("posted"), model: posted.model ?? "posted" },
      ...(posted.writer ? { writer: posted.writer } : {}),
      ...shaped,
      posted: { login: comment.author.login, url: comment.url, ...(posted.label ? { label: posted.label } : {}) },
    };
    return yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* readStored(key))?.headSha === headSha) return null;
        yield* guides.put(key, guide).pipe(Effect.orElseSucceed(() => undefined));
        return guide;
      }),
    );
  });

  /** What `get` answers: the stored guide (or one adopted from the pull request), its run, its comment. */
  const resultOf = Effect.fn("PullRequestReviewGuideService.resultOf")(function* (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    detail: PullRequestDetail,
  ) {
    const [stored, current, activity] = yield* Effect.all(
      [readStored(key), Ref.get(runs), pullRequests.activity(input).pipe(Effect.option)],
      { concurrency: "unbounded" },
    );
    const run = current.get(keyString(key)) ?? null;
    const behind = stored === null || (detail.headSha !== undefined && stored.headSha !== detail.headSha);
    const guide =
      behind && run?._tag !== "Running" && Option.isSome(activity)
        ? ((yield* adopt(input, key, detail, activity.value).pipe(Effect.orElseSucceed(() => null))) ?? stored)
        : stored;
    const found = Option.isNone(activity) ? null : guideComments(detail, activity.value);
    const comment = found?.any;
    return {
      guide,
      run,
      currentHeadSha: detail.headSha ?? null,
      ...(found === null
        ? {}
        : {
            comment:
              comment?.url == null
                ? null
                : { url: comment.url, headSha: readGuideComment(comment.body)?.headSha ?? null, mine: comment === found.mine },
          }),
      // Unread comments could hold this person's guide comment, and a press must not post a second.
      canPost: found !== null && canPost(detail),
    } satisfies PullRequestReviewGuideResult;
  });

  const get: PullRequestReviewGuideService["Service"]["get"] = Effect.fn(
    "PullRequestReviewGuideService.get",
  )(function* (input) {
    const { key } = yield* keyFor(input);
    return yield* resultOf(input, key, yield* pullRequests.detail(input));
  });

  /**
   * The comment for the guide stored for the head now, posted or rewritten. "refresh": a guide was just stored
   * here; it edits this person's comment, or posts one a chat's link is waiting on. Resolves to whether it wrote.
   */
  const publish = (input: PullRequestRef, key: ThreadPullRequestKey, reason: "press" | "link" | "refresh") =>
    posting.withPermits(1)(
      Effect.gen(function* () {
        const refuse = (detail: string) =>
          reason === "press"
            ? Effect.fail(new PullRequestOperationError({ operation: "postReviewGuide", detail }))
            : Effect.succeed(false);
        const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
        if (reason !== "press" && settings?.reviewGuidePost !== true) return false;
        const runKey = keyString(key);
        if (reason === "refresh" && !postWhenWorth.has(runKey)) {
          // Nothing waits on a link: only a comment of this person's own is kept current, so look for one first.
          const activity = yield* pullRequests.activity(input);
          const detail = yield* pullRequests.detail(input);
          if (guideComments(detail, activity).mine === undefined) return false;
        }
        // The head and the conversation as they are now: a comment is never written for a commit already passed,
        // nor posted twice because the last read predates the first.
        yield* pullRequests.invalidate({ reference: input });
        const [detail, activity, stored] = yield* Effect.all(
          [pullRequests.detail(input), pullRequests.activity(input), readStored(key)],
          { concurrency: "unbounded" },
        );
        const found = guideComments(detail, activity);
        if (reason === "link") {
          const viewer = detail.viewer?.toLowerCase();
          if (viewer === undefined || detail.author?.login.toLowerCase() !== viewer) return false;
        }
        if (!canPost(detail)) {
          return yield* refuse(
            detail.provider === "github"
              ? "You can't comment on this pull request."
              : "Guides are posted on GitHub pull requests for now.",
          );
        }
        if (stored === null || stored.headSha !== detail.headSha) {
          if (reason === "link") postWhenWorth.add(runKey);
          return yield* refuse("There's no guide for this push yet. Write it first.");
        }
        // Somebody else's guide comment is the pull request's guide comment; this one would be a second.
        if (found.mine === undefined && found.any !== undefined) return yield* refuse("This pull request already has a guide comment.");
        if (stored.posted !== undefined && reason !== "press") return false;
        if (reason !== "press" && !guideWorthPosting(stored)) {
          if (reason === "link") postWhenWorth.add(runKey);
          return false;
        }
        // A comment past what was read could be this person's: never post a second one unasked.
        if (reason !== "press" && found.mine === undefined && activity.commentsTruncated) return false;
        const [files, label] = yield* Effect.all([hostChange(input), writerLabelOf(stored)], { concurrency: "unbounded" });
        const body = renderGuideComment(stored, {
          url: detail.url,
          label,
          patches: new Map(files.map((file) => [file.path, file.patch])),
        });
        postWhenWorth.delete(runKey);
        if (found.mine === undefined) {
          yield* pullRequests.comment({ ...input, body });
        } else if (found.mine.body.trim() !== body.trim()) {
          yield* pullRequests.updateComment({ ...input, commentId: found.mine.id, kind: "issue-comment", body });
        } else {
          return false;
        }
        yield* Effect.logInfo("Review guide posted on its pull request", {
          key: runKey,
          reason,
          edited: found.mine !== undefined,
        });
        return true;
      }),
    );

  /** A guide was just stored: its comment follows, in the background, never failing the run that wrote it. */
  const refreshComment = (input: PullRequestRef, key: ThreadPullRequestKey) =>
    publish(input, key, "refresh").pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Review guide comment not updated", { key: keyString(key), cause: Cause.pretty(cause) }),
      ),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );

  const post: PullRequestReviewGuideService["Service"]["post"] = Effect.fn(
    "PullRequestReviewGuideService.post",
  )(function* (input, reason) {
    const { key } = yield* keyFor(input);
    yield* publish(input, key, reason);
    return yield* resultOf(input, key, yield* pullRequests.detail(input));
  });

  const stored: PullRequestReviewGuideService["Service"]["stored"] = Effect.fn(
    "PullRequestReviewGuideService.stored",
  )(function* (input) {
    // A listing names the host, so its key needs no project identity (keyFor may read the checkout).
    const key = pullRequestSyncKey(input) ?? (yield* keyFor(input)).key;
    return (yield* readStored(key)) !== null;
  });

  /**
   * The change's commits fetched into the project's repository: the base into a ref of this run's
   * own (dropped when the run ends) and the head, pinned to the reported commit so a branch checked
   * out elsewhere works and the change is exactly what the host reported.
   */
  const fetchChange = Effect.fn("PullRequestReviewGuideService.fetchChange")(function* (
    workspaceRoot: string,
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    headSha: string,
    stack: PullRequestStack | null,
    runId: string,
  ) {
    // Identity names can be stale; match effective fetch URLs, including insteadOf rewrites.
    const names = yield* git
      .execute({
        operation: "PullRequestReviewGuideService.listRemotes",
        cwd: workspaceRoot,
        args: ["remote"],
      })
      .pipe(Effect.map((result) => result.stdout.split("\n").filter((name) => name.length > 0)));
    const remote = yield* Effect.findFirst(
      [locator.remoteName, ...names.filter((name) => name !== locator.remoteName)],
      (name) =>
        git
          .execute({
            operation: "PullRequestReviewGuideService.remoteUrl",
            cwd: workspaceRoot,
            args: ["remote", "get-url", "--", name],
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() === locator.remoteUrl),
            Effect.orElseSucceed(() => false),
          ),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (remote === undefined) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This project's checkout no longer has a remote for the pull request's repository.",
      });
    }
    const fetch = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "PullRequestReviewGuideService.fetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", "--no-tags", "--", remote, ...args],
        timeoutMs: 5 * 60_000,
      });
    // The base branch is what the change is measured from; the head commit is the change.
    // The host names the base branch. A name git rejects, or one that would change the refspec
    // (a leading `+`, a `:`), is refused before it reaches `git fetch`.
    yield* git
      .execute({
        operation: "PullRequestReviewGuideService.checkBaseBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", "--branch", detail.baseBranch],
      })
      .pipe(
        Effect.filterOrFail(
          () => !detail.baseBranch.startsWith("+") && !detail.baseBranch.includes(":"),
          () =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: "The pull request's base branch name is not one git can fetch.",
            }),
        ),
      );
    // Fetched into a ref of this run's own: FETCH_HEAD is shared by every fetch in the
    // workspace, so a concurrent run could otherwise measure this change from its base.
    const baseRef = `refs/t3/review-guide/${runId}/base`;
    yield* fetch([`+refs/heads/${detail.baseBranch}:${baseRef}`]);
    yield* Effect.addFinalizer(() =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.dropBaseRef",
          cwd: workspaceRoot,
          args: ["update-ref", "-d", baseRef],
        })
        .pipe(Effect.ignore({ log: true })),
    );
    const baseTip = yield* git.resolveCommit({ cwd: workspaceRoot, revision: baseRef });
    const fetchHead = Effect.fn("PullRequestReviewGuideService.fetchHead")(function* (
      number: number,
      reportedSha: string,
      branch: string,
    ) {
      const sha = reportedSha.toLowerCase();
      if (!COMMIT_HASH_PATTERN.test(sha)) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail: `The host reported a head for #${number} that is not a commit hash.`,
        });
      }
      // Not redundant: rev-parse prefers a branch or tag named like a short hash over the commit.
      const resolveHead = git.resolveCommit({ cwd: workspaceRoot, revision: sha }).pipe(
        Effect.filterOrFail(
          ({ commitSha }) => commitSha.startsWith(sha),
          ({ commitSha }) =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: `${sha} names ${commitSha} here, a branch or tag rather than the commit.`,
            }),
        ),
      );
      const fetchAndResolve = (ref: string) => fetch([ref]).pipe(Effect.andThen(resolveHead));
      const branchRef = `refs/heads/${branch}`;
      const checkBranch = git.execute({
        operation: "PullRequestReviewGuideService.checkHeadBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", branchRef],
      });
      const sources = [
        { source: "local objects", head: resolveHead },
        ...(sha.length === 40 || sha.length === 64
          ? [{ source: "the commit", head: fetchAndResolve(sha) }]
          : []),
        {
          source: `branch ${branch}`,
          head: checkBranch.pipe(Effect.andThen(fetchAndResolve(branchRef))),
        },
        { source: `refs/pull/${number}/head`, head: fetchAndResolve(`refs/pull/${number}/head`) },
        {
          source: `refs/merge-requests/${number}/head`,
          head: fetchAndResolve(`refs/merge-requests/${number}/head`),
        },
      ];
      const failures: Array<string> = [];
      for (const { source, head } of sources) {
        const result = yield* Effect.result(head);
        if (Result.isSuccess(result)) return result.success;
        failures.push(`${source}: ${result.failure.detail}`);
      }
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: `Could not find head ${sha} of #${number}. ${failures.join(" ")}`,
      });
    });
    const resolvedHead = yield* fetchHead(detail.number, headSha, detail.headBranch);
    // The other layers of a stack are context the model may read across a seam. A layer that
    // cannot be fetched is still named in the prompt, without a head to read.
    const layers: ReadonlyArray<ReviewGuideStackLayer> = yield* Effect.forEach(
      stack?.layers ?? [],
      (layer) => {
        const described = { number: layer.number, title: layer.title ?? null, state: layer.state };
        if (layer.number === detail.number) return Effect.succeed({ ...described, headSha });
        const sha = layer.headSha;
        if (sha === undefined) return Effect.succeed({ ...described, headSha: null });
        return fetchHead(layer.number, sha, layer.headBranch).pipe(
          Effect.map(({ commitSha }) => ({ ...described, headSha: commitSha })),
          Effect.catch((error) =>
            Effect.logInfo("Review guide could not read a stack layer's head", {
              layer: layer.number,
              detail: error.detail,
            }).pipe(Effect.as({ ...described, headSha: null })),
          ),
        );
      },
      { concurrency: 4 },
    );
    // Measured from where the head left the base, so a stacked change is briefed alone rather
    // than with everything below it that the base has not taken yet.
    const mergeBase = yield* git.execute({
      operation: "PullRequestReviewGuideService.mergeBase",
      cwd: workspaceRoot,
      args: ["merge-base", baseTip.commitSha, resolvedHead.commitSha],
    });
    return {
      headCommit: resolvedHead.commitSha,
      baseCommit: mergeBase.stdout.trim(),
      stack: layers,
    };
  });

  /** A detached checkout of the head beside the project, removed when its scope ends. */
  const addCheckout = Effect.fn("PullRequestReviewGuideService.addCheckout")(function* (
    workspaceRoot: string,
    headCommit: string,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: config.worktreesDir,
      prefix: "review-guide-",
    });
    const path = `${directory}/checkout`;
    yield* git.execute({
      operation: "PullRequestReviewGuideService.addWorktree",
      cwd: workspaceRoot,
      // Scratch checkout for reading the change: repository hooks (installs, LFS) only slow or fail it.
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--detach",
        "--quiet",
        path,
        headCommit,
      ],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git
        .removeWorktree({ cwd: workspaceRoot, path, force: true })
        .pipe(Effect.ignore({ log: true })),
    );
    return path;
  });

  /**
   * The changed paths and their hunks, which a generated guide is held to, and the diff with
   * context, from which the tier, the change map and a single pass's inline diff are computed.
   */
  const readChange = Effect.fn("PullRequestReviewGuideService.readChange")(function* (
    cwd: string,
    baseCommit: string,
    headCommit: string,
  ) {
    const diff = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.readChange",
          cwd,
          // Fixed prefixes: a user's diff.noPrefix or custom prefixes would hide the headers the
          // parser reads.
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...args,
            `${baseCommit}...${headCommit}`,
          ],
          timeoutMs: 60_000,
          // Hunk headers only, but a large change still has many of them.
          maxOutputBytes: 64 * 1024 * 1024,
        })
        .pipe(Effect.map((result) => result.stdout));
    // Source lines as committed: a configured diff driver's textconv would rewrite them.
    const [nameOnly, patch, context] = yield* Effect.all(
      [
        diff(["--name-only", "-z"]),
        diff(["--unified=0", "--no-color", "--no-ext-diff", "--no-textconv"]),
        // Too large to read means too large for a single pass: the run reads the checkout.
        diff(["--unified=3", "--no-color", "--no-ext-diff", "--no-textconv"]).pipe(
          Effect.orElseSucceed(() => null),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      change: parseReviewGuideChange(nameOnly, patch),
      files: context === null ? null : parseChangeFiles(context),
    };
  });

  const canReadCheckout = (selection: ModelSelection) =>
    textGeneration.canReadCheckout?.(selection.instanceId) ?? Effect.succeed(true);

  const recordSpend = (
    selection: ModelSelection,
    provider: ServerProvider | undefined,
    usage: TextGenerationUsage,
  ) =>
    Option.isNone(spendStore)
      ? Effect.void
      : Effect.gen(function* () {
          const sql: SqlClient.SqlClient = spendStore.value.sql;
          yield* sql`INSERT INTO caveman_sp_spend (at, workspace_id, usage)
            VALUES (${yield* nowIso}, ${null}, ${JSON.stringify(reviewGuideSpendUsage(selection, provider, usage))})`;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A review guide's spend row was not recorded", cause),
          ),
        );

  const write = Effect.fn("PullRequestReviewGuideService.write")(function* (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    workspaceRoot: string,
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    headSha: string,
    runId: string,
    owns: Effect.Effect<boolean>,
    /** A prewarm's writers, no step up: empty writes a template guide only. Undefined tries every writer. */
    only: ReadonlyArray<ModelSelection> | undefined,
    /** The tour even for a short change. */
    full: boolean,
  ) {
    const [activity, settings, providers, stack, stored] = yield* Effect.all(
      [
        pullRequests.activity(input),
        serverSettings.getSettings,
        providerRegistry.getProviders,
        // A guide without its stack is still a guide; the stack only adds seams to point at.
        pullRequests.stack(input).pipe(Effect.orElseSucceed(() => null)),
        readStored(key),
      ],
      { concurrency: "unbounded" },
    );
    const chatTldr = chatTldrAt(stored, headSha);
    const projectSettings = resolveProjectSettings(settings, input.projectId).settings;
    const ranked = ServerSettings.reviewGuideWriters(projectSettings, providers, input.projectId);
    const writers = only ?? ranked;
    const providerOf = (selection: ModelSelection) =>
      providers.find((provider) => provider.instanceId === selection.instanceId);

    const written = yield* Effect.gen(function* () {
      const fetched = yield* fetchChange(workspaceRoot, locator, detail, headSha, stack, runId);
      const { change, files } = yield* readChange(
        workspaceRoot,
        fetched.baseCommit,
        fetched.headCommit,
      );
      const choice =
        files === null
          ? ({ tier: "checkout" } as const)
          : chooseTier({
              title: detail.title,
              body: detail.body,
              // The activity's author is the richer one: GitHub's detail read does not say who is a bot.
              author: activity.author ?? detail.author,
              files,
              budgetBytes: options.singlePassDiffBytes ?? settings.reviewGuideSinglePassKb * 1024,
              shortLines: full ? 0 : settings.reviewGuideShortLines,
            });
      const depth = choice.tier === "single-pass" ? choice.depth : ("tour" as const);
      yield* Effect.logInfo("Review guide tier and writers", {
        tier: choice.tier,
        depth,
        writers: writers.map((writer) => `${writer.instanceId}/${writer.model}`),
      });
      if (choice.tier === "template") {
        return {
          tier: "template" as const,
          depth: "tour" as const,
          selection: ranked[0]!,
          guide: normalizeReviewGuide(
            templateGuide({ title: detail.title, files: files ?? [], bumps: choice.bumps }),
            change,
          ),
        };
      }
      // Nobody asked, and the chat's TL;DR is a short change's whole guide: nothing to write.
      if (only !== undefined && depth === "tldr" && chatTldr !== undefined) return "chat" as const;
      // A prewarm without a writer: the change needs a model it was not given.
      if (writers.length === 0) return "needs-model" as const;
      const prompt = {
        ...reviewGuideInputFromPullRequest(detail, activity, fetched.baseCommit),
        instructions: projectSettings.reviewGuideInstructions,
        stack: fetched.stack,
        changeMap: files === null ? undefined : changeMap(files),
        chatTldr,
      };
      // The whole filtered diff, for a writer that cannot read a checkout; null when too large for one pass.
      const wideDiff = files === null ? "" : filteredDiff(files);
      const wide = wideDiff !== "" && Buffer.byteLength(wideDiff) <= WIDE_SINGLE_PASS_DIFF_BYTES ? wideDiff : null;
      /**
       * One model run at a tier. A checkout lives only as long as the model is reading it. A writer
       * that cannot read one writes a single pass over the whole diff instead, when it fits.
       */
      const run = (requested: Exclude<ReviewGuideTier, "template">, selection: ModelSelection) =>
        Effect.gen(function* () {
          const readsCheckout = requested === "single-pass" || (yield* canReadCheckout(selection));
          const diff =
            requested === "single-pass" && choice.tier === "single-pass" ? choice.diff : readsCheckout ? null : wide;
          if (!readsCheckout && diff === null) {
            return yield* new TextGenerationError({
              operation: "generateReviewGuide",
              detail: "This writer cannot read a checkout, and the change is too large to write in one pass.",
            });
          }
          const tier = diff === null ? ("checkout" as const) : ("single-pass" as const);
          // Only the first run over a short change is its TL;DR; an escalation is a tour.
          const wanted = requested === "single-pass" ? depth : ("tour" as const);
          let usage: TextGenerationUsage | undefined;
          const onUsage = (reported: TextGenerationUsage) => {
            usage = reported;
          };
          const generated =
            diff !== null
              ? textGeneration.generateReviewGuide({
                  ...prompt,
                  cwd: workspaceRoot,
                  diff,
                  depth: wanted,
                  modelSelection: selection,
                  onUsage,
                })
              : addCheckout(workspaceRoot, fetched.headCommit).pipe(
                  Effect.flatMap((path) =>
                    textGeneration.generateReviewGuide({
                      ...prompt,
                      cwd: path,
                      modelSelection: selection,
                      onUsage,
                    }),
                  ),
                  Effect.scoped,
                );
          return yield* generated.pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                usage === undefined ? Effect.void : recordSpend(selection, providerOf(selection), usage),
              ),
            ),
            Effect.flatMap((raw) => {
              const guide = normalizeReviewGuide(raw, change);
              const excerpts = raw.stops.flatMap((stop) => stop.excerpts);
              const misses = checkGuide(raw, guide, change);
              // An empty TL;DR is no guide at all: the next writer tries.
              if (guide.depth === "tldr" && misses.length > 0) {
                return Effect.fail(
                  new TextGenerationError({ operation: "generateReviewGuide", detail: "The model wrote no TL;DR." }),
                );
              }
              return Effect.logInfo("Review guide written", {
                tier,
                depth: guide.depth ?? "tour",
                excerpts: excerpts.length,
                excerptsDropped: excerpts.filter((excerpt) => clampExcerpt(excerpt, change) === null).length,
                misses,
              }).pipe(Effect.as({ tier, depth: guide.depth ?? ("tour" as const), selection, guide, misses }));
            }),
          );
        });
      // A writer that fails (signed out, rate-limited, cannot read a checkout) drops to the next.
      const firstThatWrites = Effect.fn("PullRequestReviewGuideService.firstThatWrites")(function* (
        tier: Exclude<ReviewGuideTier, "template">,
      ) {
        let failure: Effect.Error<ReturnType<typeof run>> | undefined;
        for (const selection of writers) {
          const result = yield* Effect.result(run(tier, selection));
          if (Result.isSuccess(result)) return result.success;
          failure = result.failure;
          yield* Effect.logInfo("Review guide writer failed; trying the next", {
            instanceId: selection.instanceId,
            model: selection.model,
            tier,
            detail: failureDetail(Cause.fail(result.failure)),
          });
        }
        // `writers` is never empty, so a failure was seen.
        return yield* Effect.fail(failure!);
      });
      const first = yield* firstThatWrites(choice.tier);
      if (first.misses.length === 0) return first;
      // Escalate once: a single pass reads the checkout on the same model (when it can read one); a checkout run moves
      // to the same harness's next model up, but never for a prewarm (nobody asked, and the next
      // model up draws ~12x more of the plan window) nor with step up off in settings. Never more
      // than two runs per head.
      const escalation =
        first.tier === "single-pass"
          ? (yield* canReadCheckout(first.selection))
            ? first.selection
            : null
          : only !== undefined || !settings.reviewGuideStepUp
            ? null
            : nextModelUp(first.selection, providerOf(first.selection));
      yield* Effect.logInfo("Review guide missed the check", {
        tier: first.tier,
        misses: first.misses,
        escalating: escalation !== null,
      });
      if (escalation === null) return first;
      const second = yield* Effect.result(run("checkout", escalation));
      if (Result.isFailure(second)) {
        yield* Effect.logInfo("Review guide escalation failed; keeping the first guide", {
          detail: failureDetail(Cause.fail(second.failure)),
        });
        return first;
      }
      return second.success.misses.length <= first.misses.length ? second.success : first;
    }).pipe(Effect.scoped);
    if (typeof written === "string") return written;

    const guide: PullRequestReviewGuide = {
      headSha,
      generatedAt: yield* nowIso,
      modelSelection: written.selection,
      writer: { tier: written.tier },
      depth: written.depth,
      ...written.guide,
    };
    // A newer run for this pull request, say after a push, owns its guide now; this one's result
    // is for an older head and is dropped rather than written over it.
    const kept = yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* owns)) return false;
        yield* guides.put(key, guide);
        return true;
      }),
    );
    if (kept) yield* refreshComment(input, key);
    return written.tier;
  });

  /** What a reader is told when a run fails; the full cause goes to the log. */
  const failureDetail = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.squash(cause);
    if (error instanceof Error && "detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
    return "The review guide could not be written.";
  };

  /**
   * A claimed run to its end. The run is identified by its own Running value: a later claim
   * replaces it, and from then on this run's completion leaves the newer run's state and guide
   * alone. A person's failure stays for readers to see; a prewarm's is only returned. A prewarm a
   * person joined that ends without a guide (no writer, the chat's TL;DR, or its writers failed)
   * goes on as that person's run, under the same Running value.
   */
  const runClaimed = (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    workspaceRoot: string,
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    running: PullRequestReviewGuideRun & { readonly _tag: "Running" },
    only: ReadonlyArray<ModelSelection> | undefined,
  ): Effect.Effect<ReviewGuidePrewarmOutcome> => {
    const runKey = keyString(key);
    const owns = Ref.get(runs).pipe(Effect.map((current) => current.get(runKey) === running));
    const finish = (next: PullRequestReviewGuideRun | null) =>
      Ref.update(runs, (current) => {
        if (current.get(runKey) !== running) return current;
        const updated = new Map(current);
        if (next === null) updated.delete(runKey);
        else updated.set(runKey, next);
        return updated;
      });
    // Decided in the same step that would end the run, so a press joining as the prewarm ends is
    // either handed the run or starts its own.
    const end = (outcome: ReviewGuidePrewarmOutcome, next: PullRequestReviewGuideRun | null) =>
      Ref.modify(runs, (current) => {
        if (current.get(runKey) !== running) return [false, current] as const;
        const noGuide = outcome === "needs-model" || outcome === "chat" || outcome === "failed";
        if (only !== undefined && noGuide && joined.has(running)) return [true, current] as const;
        const updated = new Map(current);
        if (next === null) updated.delete(runKey);
        else updated.set(runKey, next);
        return [false, updated] as const;
      }).pipe(
        Effect.flatMap((handOver) =>
          handOver
            ? runClaimed(input, key, workspaceRoot, locator, detail, running, undefined).pipe(
                Effect.forkIn(serviceScope),
                Effect.asVoid,
              )
            : Effect.void,
        ),
        Effect.as(outcome),
      );
    const runId = `${runCounter++}`;
    return write(input, key, workspaceRoot, locator, detail, running.headSha, runId, owns, only, touring.has(running)).pipe(
      Effect.flatMap((outcome) => end(outcome, null)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? finish(null).pipe(Effect.as("skipped" as const))
          : Effect.logWarning("Review guide generation failed", {
              key: runKey,
              prewarm: only !== undefined,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((failedAt) =>
                end(
                  "failed",
                  only !== undefined
                    ? null
                    : { _tag: "Failed", headSha: running.headSha, failedAt, detail: failureDetail(cause) },
                ),
              ),
            ),
      ),
    );
  };

  const generate: PullRequestReviewGuideService["Service"]["generate"] = Effect.fn(
    "PullRequestReviewGuideService.generate",
  )(function* (input, options) {
    const full = options?.full === true;
    // A beta the server owns, so every client and agent sees the same answer.
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "generateReviewGuide",
            detail: "Could not read the server settings.",
            cause,
          }),
      ),
    );
    if (!settings.reviewGuidesEnabled) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "Review guides are off. Turn them on in Settings → Review.",
      });
    }
    const { key, workspaceRoot, identity } = yield* keyFor(input);
    const locator = yield* requireOwnRepository(key, identity);
    const runKey = keyString(key);
    // A press asks for the head as it is now, not a read shared from the last minute, so a guide
    // is never started for a commit the pull request has already moved past.
    yield* pullRequests.invalidate({ reference: input });
    const [detail, stored] = yield* Effect.all([pullRequests.detail(input), readStored(key)], {
      concurrency: "unbounded",
    });
    const currentHeadSha = detail.headSha ?? null;
    if (currentHeadSha === null) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This host did not report the pull request's head commit.",
      });
    }
    const running = {
      _tag: "Running" as const,
      headSha: currentHeadSha,
      startedAt: yield* nowIso,
    };
    // Claimed atomically, so two readers pressing Generate start one run between them. The head
    // is read again under the claim: a press that read an older head before a push must not
    // replace a run another press started for the new one, so it asks to be pressed again.
    const claimed = yield* ownership.withPermits(1)(
      pullRequests.detail(input).pipe(
        Effect.flatMap((latest) =>
          (latest.headSha ?? null) !== currentHeadSha
            ? Effect.fail(
                new PullRequestOperationError({
                  operation: "generateReviewGuide",
                  detail: "The pull request changed while the guide was starting. Try again.",
                }),
              )
            : Ref.modify(runs, (current) => {
                const existing = current.get(runKey);
                // A press for the full tour does not join a run that may write only the TL;DR.
                if (
                  existing?._tag === "Running" &&
                  existing.headSha === currentHeadSha &&
                  (!full || touring.has(existing))
                ) {
                  joined.add(existing);
                  return [existing, current] as const;
                }
                return [running, new Map(current).set(runKey, running)] as const;
              }),
        ),
      ),
    );
    if (claimed !== running) return { guide: stored, run: claimed, currentHeadSha, started: false };

    if (full) touring.add(running);
    yield* runClaimed(input, key, workspaceRoot, locator, detail, running, undefined).pipe(
      Effect.forkIn(serviceScope),
    );
    return { guide: stored, run: running, currentHeadSha, started: true };
  });

  const prewarm: PullRequestReviewGuideService["Service"]["prewarm"] = Effect.fn(
    "PullRequestReviewGuideService.prewarm",
  )(function* (input, writers) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings?.reviewGuidesEnabled !== true) return "skipped" as const;
    const { key, workspaceRoot, identity } = yield* keyFor(input);
    const locator = yield* requireOwnRepository(key, identity);
    const runKey = keyString(key);
    // The listing's cached read is fresh enough: a push moves the head, and the next pass sees it.
    const [detail, stored] = yield* Effect.all([pullRequests.detail(input), readStored(key)], {
      concurrency: "unbounded",
    });
    const headSha = detail.headSha ?? null;
    // A guide its author posted for this head is read rather than written again.
    if (headSha !== null && stored?.headSha !== headSha) {
      const activity = yield* pullRequests.activity(input).pipe(Effect.option);
      const adopted = Option.isNone(activity)
        ? null
        : yield* adopt(input, key, detail, activity.value).pipe(Effect.orElseSucceed(() => null));
      if (adopted !== null) return "adopted" as const;
    }
    const tried = prewarmed.get(runKey);
    // A TL;DR from the chat is a guide for a short change only; a long one still gets its tour.
    if (
      headSha === null ||
      (stored?.headSha === headSha && chatTldrAt(stored, headSha) === undefined) ||
      (tried?.headSha === headSha &&
        (tried.outcome === "failed" || tried.outcome === "chat" || writers.length === 0))
    ) {
      return "skipped" as const;
    }
    const running = { _tag: "Running" as const, headSha, startedAt: yield* nowIso };
    const claimed = yield* ownership.withPermits(1)(
      Ref.modify(runs, (current) => {
        const existing = current.get(runKey);
        const personRunning = [...current].some(
          ([other, run]) => run._tag === "Running" && !prewarming.has(other),
        );
        return personRunning || existing?._tag === "Running" || existing?.headSha === headSha
          ? ([false, current] as const)
          : ([true, new Map(current).set(runKey, running)] as const);
      }),
    );
    if (!claimed) return "skipped" as const;
    prewarming.add(runKey);
    const outcome = yield* runClaimed(input, key, workspaceRoot, locator, detail, running, writers).pipe(
      Effect.ensuring(Effect.sync(() => prewarming.delete(runKey))),
    );
    if (outcome === "failed" || outcome === "needs-model" || outcome === "chat") {
      prewarmed.set(runKey, { headSha, outcome });
    }
    return outcome;
  });

  const fromChat: PullRequestReviewGuideService["Service"]["fromChat"] = Effect.fn(
    "PullRequestReviewGuideService.fromChat",
  )(function* (input, chat) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const tldr = clampLine(chat.tldr, 140);
    if (settings?.reviewGuidesEnabled !== true || !settings.reviewGuideChatTldr || tldr === undefined) return false;
    const { key } = yield* keyFor(input);
    // Linked as it is opened or pushed: the head as it is now, not a read from before the push.
    yield* pullRequests.invalidate({ reference: input });
    const headSha = (yield* pullRequests.detail(input)).headSha ?? null;
    if (headSha === null) return false;
    const modelSelection =
      chat.modelSelection ??
      ServerSettings.reviewGuideWriters(
        resolveProjectSettings(settings, input.projectId).settings,
        yield* providerRegistry.getProviders,
        input.projectId,
      )[0]!;
    const guide: PullRequestReviewGuide = {
      headSha,
      generatedAt: yield* nowIso,
      modelSelection,
      writer: { tier: "chat" },
      depth: "tldr",
      tldr,
      stops: [],
      threadId: chat.threadId,
    };
    // Under the claim lock, so a run's guide for this head that lands first is never replaced.
    return yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored(key);
        if (stored?.headSha === headSha && stored.writer?.tier !== "chat") return false;
        yield* guides.put(key, guide).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestOperationError({
                operation: "reviewGuide",
                detail: "Could not store the chat's TL;DR.",
                cause,
              }),
          ),
        );
        return true;
      }),
    );
  });

  return PullRequestReviewGuideService.of({ get, stored, generate, prewarm, fromChat, post });
});

/** The service with its ladder tuned; tests set a zero budget to exercise the checkout tier. */
export const makeLayer = (options: ReviewGuideServiceOptions = {}) =>
  Layer.effect(PullRequestReviewGuideService, makeWith(options));

export const layer = makeLayer();
