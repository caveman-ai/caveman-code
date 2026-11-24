// ), packages/provider-core/src/server/textGeneration.ts @ ab3a3cd1.
import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@caveman-app/protocol";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource, ThreadTitleTopic } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  /** The person's existing topics and their emoji, most recent first (ThreadTitlePromptInput.topics). */
  topics?: ReadonlyArray<ThreadTitleTopic> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
  /** Its topic (OrchestrationV2ThreadTopic), cleaned; an existing topic in that topic's own spelling. */
  topic?: string | undefined;
  /** The writer's emoji for `topic` (cleanThreadTopicIcon), only with a topic. */
  icon?: string | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  /** The layer's head in the checkout, null where it could not be fetched. */
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

/** What one text generation call used, as the provider reported it. */
export interface TextGenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** The provider's own dollar figure, when it gives one (Claude's list price, even on a plan). */
  readonly costUsd?: number | undefined;
}

export interface ReviewGuideGenerationInput {
  /**
   * A disposable checkout of the change's head, which the model investigates read-only. For a
   * single pass (`diff` set) the model runs with no tools and this is only the process's cwd.
   */
  cwd: string;
  /**
   * The change computed per file (kind, path, +/-, the symbols its hunk headers name), placed at
   * the top of the prompt so the model reads less. Mechanical files appear only here.
   */
  changeMap?: string | undefined;
  /**
   * Set for a single pass: the change's diff (code and tests), inline as labelled chunks the model
   * cites by id. The model answers from the prompt alone, with no tools and no checkout.
   */
  diff?: string | undefined;
  /**
   * "tldr" for a short change: one call over `diff` that writes only the TL;DR and the one call a
   * maintainer should make, no stops. "tour" (or absent) for the stops. A provider that cannot
   * write a TL;DR alone writes the tour of a single pass.
   */
  depth?: "tldr" | "tour" | undefined;
  /** Told the call's token usage when the provider reports it. */
  onUsage?: ((usage: TextGenerationUsage) => void) | undefined;
  number: number;
  title: string;
  /** The author's own description, which states intent the diff cannot. */
  description: string;
  baseBranch: string;
  /** The commit the change is measured from, present in `cwd`. */
  baseCommit: string;
  /**
   * What review already settled: resolved conversations, reduced to who raised what. The guide
   * leaves these alone rather than raising them again.
   */
  settledReview: string;
  /** The maintainer's preferences for guides (tone, emphasis, ordering). Empty for none. */
  instructions?: string | undefined;
  /**
   * The TL;DR the chat that made the change wrote as it linked the pull request: the author's own
   * summary, which the guide checks against the diff rather than trusts.
   */
  chatTldr?: string | undefined;
  /**
   * The stack the change is a layer of, bottom first, when it is in one. Another layer's head is
   * fetched into `cwd` where the host served it, so the model can read across a seam.
   */
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/**
 * A problem report the person is about to send Caveman (docs/). Everything here is
 * already redacted on this computer; the model only reads it and writes the description.
 */
export interface BugReportGenerationInput {
  /** Where the model runs: an empty folder, since it only reads what the prompt carries. */
  cwd: string;
  /** Where the app showed the problem: chat, onboarding, the runtime... */
  surface: string;
  /** The error, redacted: its type, message and stack. Empty when the person reported without one. */
  error: string;
  /** The newest log lines, redacted. */
  logs: string;
  appVersion: string;
  platform: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/** A chat a model may pick for what a person is looking for (chat.find): what they would know it by. */
export interface ChatFindCandidate {
  readonly title: string;
  /** Where and when, one line: project, engine, last active, archived. */
  readonly about: string;
  /** Places in it the search found, each a short passage led by who said it ("You: …"). */
  readonly places: ReadonlyArray<string>;
}

export interface ChatFindInput {
  /** Where the run starts; the prompt carries everything, so nothing there is read. */
  cwd: string;
  /** What the person typed. */
  query: string;
  /** Today with its weekday ("2026-11-05, Thursday"), for "yesterday" and "last week". */
  today: string;
  /** Numbered from 1 in the prompt, in this order. */
  chats: ReadonlyArray<ChatFindCandidate>;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BugReportGenerationResult {
  title: string;
  /** What happened, the likely cause, and the steps to reproduce, as plain text under those headings. */
  summary: string;
}

export interface ChatFindResult {
  /** Best first, at most CHAT_FIND_PICKS, none when no chat fits: an index into `chats`, and in a line why. */
  readonly picks: ReadonlyArray<{ readonly index: number; readonly why: string }>;
}

/** A guide as the model wrote it, before the server holds it to the change. */
export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection" | "writer" | "threadId"
>;

/** Commit, change request, branch, and title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate change request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /** Explain a change request to the maintainer deciding whether it lands. */
  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;

  /** Pick the chats a person is looking for from candidates the search found (chat.find). */
  readonly findChats: (input: ChatFindInput) => Effect.Effect<ChatFindResult, TextGenerationError>;

  /**
   * Describe a problem report from its redacted error and logs, for the person to edit before sending.
   * Absent where a provider runs no one-shot prompts (the report keeps its template description).
   */
  readonly generateBugReport?: (
    input: BugReportGenerationInput,
  ) => Effect.Effect<BugReportGenerationResult, TextGenerationError>;

  /**
   * False when this provider cannot read a checkout read-only for a review guide, so it only writes
   * one pass over a diff in the prompt. Absent means it can.
   */
  readonly readsCheckout?: boolean;
}
