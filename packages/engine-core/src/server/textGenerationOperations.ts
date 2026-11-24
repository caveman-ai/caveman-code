// ), packages/provider-core/src/server/textGenerationOperations.ts @ ab3a3cd1.
/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, and output sanitizing live here so providers cannot drift
 * on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@caveman-app/protocol";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@caveman-app/shared/git";
import { extractJsonObject } from "@caveman-app/shared/schemaJson";

import type {
  ChatFindResult,
  ProviderTextGeneration,
  ReviewGuideGenerationResult,
  TextGenerationUsage,
} from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildBugReportPrompt,
  buildChatFindPrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildReviewGuideChunkPrompt,
  buildReviewGuidePrompt,
  buildReviewGuideTldrPrompt,
  buildThreadTitlePrompt,
  cleanThreadTopic,
  cleanThreadTopicIcon,
  CHAT_FIND_PICKS,
  type ThreadTitleTopic,
} from "./textGenerationPrompts.ts";
import { type ReviewGuideChunk, resolveChunkStop, reviewGuideChunks } from "./reviewGuideChunks.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

/**
 * A title result's topic and its emoji, both cleaned: none when the writer named no topic, and no emoji without a
 * topic.
 */
export const withTopic = (
  generated: { readonly topic: string | null; readonly icon: string | null },
  topics: ReadonlyArray<ThreadTitleTopic> | undefined,
): { topic?: string; icon?: string } => {
  const topic = cleanThreadTopic(generated.topic, topics);
  if (topic === undefined) return {};
  const icon = cleanThreadTopicIcon(generated.icon);
  return icon === undefined ? { topic } : { topic, icon };
};

export type Operation = Exclude<keyof ProviderTextGeneration, "readsCheckout">;

/** A problem report's title: one line, the contract's 120 characters at most. */
const sanitizeBugReportTitle = (title: string) => {
  const line = title.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "");
  return line.length <= 120 ? line : `${line.slice(0, 119).trimEnd()}…`;
};

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /**
   * Set when the model must investigate `cwd` before answering: it may read files and run
   * read-only commands there, over as many turns as it needs, and must change nothing. Absent,
   * the prompt carries everything and the model runs with no tools at all. A runner that cannot
   * guarantee read-only tools fails rather than answering blind.
   */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
  /** Told the call's token usage, by runners that can read it from their CLI's output. */
  readonly onUsage?: ((usage: TextGenerationUsage) => void) | undefined;
}

/** How long an investigating run may take; a large change needs far longer than a title. */
const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

/** The refusal a runner gives when it has no read-only tool mode to investigate with. */
export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/**
 * For a runner with no read-only tool mode: it answers prompts that carry everything, and
 * refuses an investigation rather than answering one blind.
 */
export const withoutInvestigation = (provider: string, run: Runner): Runner & { readonly readsCheckout: false } =>
  Object.assign<Runner, { readonly readsCheckout: false }>(
    (request) =>
      request.investigate ? Effect.fail(investigationUnsupported(request.operation, provider)) : run(request),
    { readsCheckout: false },
  );

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

type ReviewGuideReply = ReturnType<typeof buildReviewGuidePrompt>["outputSchema"]["Type"];
type ReviewGuideChunkReply = ReturnType<typeof buildReviewGuideChunkPrompt>["outputSchema"]["Type"];
type ReviewGuideTldrReply = ReturnType<typeof buildReviewGuideTldrPrompt>["outputSchema"]["Type"];

/** The model writes snake_case and a null stop for context; the guide keeps camelCase and omits it. */
export const reviewGuideFromReply = ({
  tldr,
  overview,
  before_after,
  ...guide
}: ReviewGuideReply): ReviewGuideGenerationResult => ({
  ...guide,
  tldr,
  overview,
  beforeAfter: {
    title: before_after.title,
    rows: before_after.rows.map(({ stop, ...row }) => (stop === null ? row : { ...row, stop })),
  },
});

/** A single pass's reply: cited chunks become excerpts and quoted lines become notes' lines. */
export const reviewGuideFromChunkReply = (
  { stops, ...reply }: ReviewGuideChunkReply,
  chunks: ReadonlyArray<ReviewGuideChunk>,
): ReviewGuideGenerationResult =>
  reviewGuideFromReply({ ...reply, stops: stops.map((stop) => resolveChunkStop(stop, chunks)) });

/** A TL;DR guide: no stops, and its one call, if any, at the top. */
export const reviewGuideFromTldrReply = ({ tldr, attention }: ReviewGuideTldrReply): ReviewGuideGenerationResult => ({
  depth: "tldr",
  tldr,
  ...(attention === null ? {} : { attention }),
  stops: [],
});

type ChatFindReply = ReturnType<typeof buildChatFindPrompt>["outputSchema"]["Type"];

/** The model's picks held to the candidates: numbers that name one, each chat once, the reason one short line. */
export const chatFindFromReply = ({ picks }: ChatFindReply, count: number): ChatFindResult => {
  const seen = new Set<number>();
  const held = picks.flatMap(({ chat, why }) => {
    const index = chat - 1;
    if (index < 0 || index >= count || seen.has(index)) return [];
    seen.add(index);
    const line = why.replace(/\s+/g, " ").trim();
    return [{ index, why: line.length <= 140 ? line : `${line.slice(0, 139).trimEnd()}…` }];
  });
  return { picks: held.slice(0, CHAT_FIND_PICKS) };
};

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(name: string, run: Runner & { readonly readsCheckout?: boolean }): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
        topics: input.topics,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      ...withTopic(generated, input.topics),
    };
  });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    const request = {
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      onUsage: input.onUsage,
    } as const;
    if (input.diff === undefined) {
      return reviewGuideFromReply(
        yield* run({
          ...request,
          investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
          ...buildReviewGuidePrompt(input),
        }),
      );
    }
    // A short change's TL;DR reads the diff as it is: there are no stops to cite chunks from.
    if (input.depth === "tldr") {
      return reviewGuideFromTldrReply(yield* run({ ...request, ...buildReviewGuideTldrPrompt(input, input.diff) }));
    }
    // A single pass carries the diff in the prompt, cut into chunks it cites, and runs with no tools.
    const chunks = reviewGuideChunks(input.diff);
    return reviewGuideFromChunkReply(
      yield* run({ ...request, ...buildReviewGuideChunkPrompt(input, chunks) }),
      chunks,
    );
  });

  const generateBugReport: NonNullable<ProviderTextGeneration["generateBugReport"]> = Effect.fn(
    `${name}.generateBugReport`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBugReport",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildBugReportPrompt(input),
    });
    return { title: sanitizeBugReportTitle(generated.title), summary: generated.summary.trim() };
  });

  const findChats: ProviderTextGeneration["findChats"] = Effect.fn(`${name}.findChats`)(function* (input) {
    const reply = yield* run({
      operation: "findChats",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildChatFindPrompt(input),
    });
    return chatFindFromReply(reply, input.chats.length);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateBugReport,
    findChats,
    readsCheckout: run.readsCheckout !== false,
  } satisfies ProviderTextGeneration;
}
