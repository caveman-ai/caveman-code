// ), packages/contracts/src/pullRequestReviewGuide.ts @ ab3a3cd1.
import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * A guided review is written for the maintainer deciding whether a change should land, not for
 * someone checking it line by line. Review agents already read every line; what is left for a
 * person is intent, design, and the calls an agent cannot make on their behalf.
 *
 * So a guide is a tour of stops in reading order, each building on the ones before (contract, then
 * the service, then its callers), with the mechanical rest grouped at the end. Each stop shows only
 * the code that carries its idea and names the one call a maintainer should make there, if any;
 * that call is what tells the reader where to slow down.
 *
 * The model writes the tour; the server holds it to the change. Excerpts and notes are clamped to
 * lines the change touched, and a changed file the model left out still lands in a closing skim
 * stop, so every file is accounted for.
 */

/**
 * The one call a maintainer should make at a stop. Not a bug or a review nit; those belong to the
 * review agents. The kind says what sort of judgment it asks for.
 */
export const PullRequestReviewGuideAttention = Schema.Struct({
  kind: Schema.Literals(["tradeoff", "contract", "product", "risk", "accessibility"]),
  note: TrimmedNonEmptyString,
});
export type PullRequestReviewGuideAttention = typeof PullRequestReviewGuideAttention.Type;

/**
 * Lines worth reading, always inside the change. `old` shows removed code, for a change that is
 * mostly deletion; line numbers are on the side named.
 */
export const PullRequestReviewGuideExcerpt = Schema.Struct({
  path: TrimmedNonEmptyString,
  side: Schema.Literals(["new", "old"]),
  start: PositiveInt,
  end: PositiveInt,
  caption: Schema.String,
});
export type PullRequestReviewGuideExcerpt = typeof PullRequestReviewGuideExcerpt.Type;

/**
 * What the code at one line does not say for itself: why it is shaped this way, what it connects
 * to. An explanation, not a finding. Anchored inside one of its stop's excerpts.
 */
export const PullRequestReviewGuideNote = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
});
export type PullRequestReviewGuideNote = typeof PullRequestReviewGuideNote.Type;

export const PullRequestReviewGuideStop = Schema.Struct({
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  attention: Schema.NullOr(PullRequestReviewGuideAttention),
  excerpts: Schema.Array(PullRequestReviewGuideExcerpt),
  /**
   * Changed files the tour never excerpts, each listed by one stop. A file the tour does show may
   * be excerpted by several stops, each showing the part that stop is about.
   */
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      note: Schema.optionalKey(Schema.String),
    }),
  ),
  notes: Schema.Array(PullRequestReviewGuideNote),
  /** Questions about intent a reader might ask here, for a follow-up conversation. */
  questions: Schema.Array(TrimmedNonEmptyString),
});
export type PullRequestReviewGuideStop = typeof PullRequestReviewGuideStop.Type;

/**
 * The change's behaviour before and after as indented pseudo-code a reader grasps in seconds:
 * `op` " " is context that stays, "-" behaviour gone, "+" behaviour new. `stop` is the 1-based
 * stop that implements a row; absent for context.
 */
export const PullRequestReviewGuideBeforeAfter = Schema.Struct({
  title: TrimmedNonEmptyString,
  rows: Schema.Array(
    Schema.Struct({
      op: Schema.Literals([" ", "-", "+"]),
      depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
      text: TrimmedNonEmptyString,
      stop: Schema.optionalKey(PositiveInt),
    }),
  ),
});
export type PullRequestReviewGuideBeforeAfter = typeof PullRequestReviewGuideBeforeAfter.Type;

export const PullRequestReviewGuide = Schema.Struct({
  /** The head the guide was written against. A different head means the guide is stale. */
  headSha: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  modelSelection: ModelSelection,
  /**
   * How it was written: "template" by code with no model (a dependency bump, mechanical files only),
   * "single-pass" by one call over the diff, "checkout" by a run reading a checkout, "chat" by the
   * chat that opened the pull request, in the turn that linked it. Optional so older guides decode.
   */
  writer: Schema.optionalKey(
    Schema.Struct({ tier: Schema.Literals(["template", "single-pass", "checkout", "chat"]) }),
  ),
  /**
   * "tldr" for a short change: the TL;DR and `attention`, no stops; the diff is the rest. "tour" for
   * the stops. Absent on guides written before it existed, which are tours.
   */
  depth: Schema.optionalKey(Schema.Literals(["tldr", "tour"])),
  /** The whole change in one or two terse sentences, for the top of the page. Optional so older guides decode. */
  tldr: Schema.optionalKey(TrimmedNonEmptyString),
  /** A TL;DR guide's one call for the maintainer, when it has one; a tour puts its calls on its stops. */
  attention: Schema.optionalKey(PullRequestReviewGuideAttention),
  /** The chat that wrote a "chat" guide's TL;DR. */
  threadId: Schema.optionalKey(ThreadId),
  /**
   * Read from the guide comment `login` posted on the pull request at `url`, not written here; `label` is its
   * writer as that comment names it ("Claude Haiku 5.5 · single pass"). `modelSelection` then only names the model.
   */
  posted: Schema.optionalKey(
    Schema.Struct({
      login: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
      label: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  /** One to three short lines: what changes and why it matters. Optional so older guides decode. */
  overview: Schema.optionalKey(TrimmedNonEmptyString),
  beforeAfter: Schema.optionalKey(PullRequestReviewGuideBeforeAfter),
  stops: Schema.Array(PullRequestReviewGuideStop),
});
export type PullRequestReviewGuide = typeof PullRequestReviewGuide.Type;

/**
 * A guide run in progress or the last one that failed. A run reads the change in a checkout and
 * takes minutes on a large one, so it runs on the server and the page watches this instead of
 * holding a request open. A server restart drops a run in progress; nothing claims it.
 */
export const PullRequestReviewGuideRun = Schema.Union([
  Schema.TaggedStruct("Running", {
    headSha: TrimmedNonEmptyString,
    startedAt: IsoDateTime,
  }),
  Schema.TaggedStruct("Failed", {
    headSha: TrimmedNonEmptyString,
    failedAt: IsoDateTime,
    detail: TrimmedNonEmptyString,
  }),
]);
export type PullRequestReviewGuideRun = typeof PullRequestReviewGuideRun.Type;

/**
 * The stored guide for a pull request and the head it is now at. `guide` is null when none was
 * generated; a guide whose `headSha` differs from `currentHeadSha` was written before a push.
 * `run` is the generation in progress, or the last failed one; a finished run leaves only `guide`.
 */
export const PullRequestReviewGuideResult = Schema.Struct({
  guide: Schema.NullOr(PullRequestReviewGuide),
  run: Schema.NullOr(PullRequestReviewGuideRun),
  /** Null where the host did not report a head with the detail. */
  currentHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The guide comment on the pull request, when there is one: where it is, the head it was written for, and whether
   * the signed-in person posted it (so this runtime keeps it current). Absent where the host was not read.
   */
  comment: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        url: TrimmedNonEmptyString,
        headSha: Schema.NullOr(TrimmedNonEmptyString),
        mine: Schema.Boolean,
      }),
    ),
  ),
  /** This person may post the guide as a comment here: a host comments render on, and they may comment. */
  canPost: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestReviewGuideResult = typeof PullRequestReviewGuideResult.Type;
