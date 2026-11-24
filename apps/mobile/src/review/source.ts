// Where a guide and its diff come from, pure: what an agent wrote for a branch (review/guides.ts), read as `pr.guide`
// and `pr.diff` would answer for the head the pull request is at now. Every pull request has its code: the written
// diff at the head it was written for, else the scripted world's own patch for each file (hand-written where there is
// one, sketched where not). A guide written on the phone for this head wins; then the agent's own, stale or not; then,
// for a chat's, the chat's own TL;DR. No React here.
import { type Pr, repoName } from "../screens/pages/review-model";
import type { DiffFile } from "./diff";
import { headOf, sketch } from "./fixture";
import { patchFor, type PrReview, reviewedAt } from "./guides";
import type { PrGuide, PrGuideResult, PrThread } from "./model";
import { marksKey } from "./state";
import { capTldr, firstSentence } from "./write";

/** The id a guide is opened by: the chat that made the pull request, else "repo-number" ("Caveman Cloud-612"). */
export const guideId = (pr: Pick<Pr, "chat" | "repo" | "number">) => pr.chat ?? `${repoName(pr.repo)}-${pr.number}`;

/** The pull request a guide id names: an open one first, as a chat can also have merged one before. */
export function findPr(prs: readonly Pr[], id: string): Pr | null {
  const named = prs.filter((pr) => guideId(pr) === id);
  return named.find((pr) => pr.state === "open" || pr.state === "draft") ?? named[0] ?? null;
}

export interface Review {
  result: PrGuideResult;
  /** The diff at the pull request's head now, by path. */
  files: ReadonlyMap<string, DiffFile>;
  threads: readonly PrThread[];
  reviews: readonly PrReview[];
}

const NONE: readonly never[] = [];
const EMPTY = new Map<string, DiffFile>();

/** Each file's patch at the head it is at, made once per head. */
const diffs = new Map<string, ReadonlyMap<string, DiffFile>>();

function diffOf(pr: Pr, written: readonly DiffFile[] | null): ReadonlyMap<string, DiffFile> {
  const key = marksKey(pr);
  const was = diffs.get(key);
  if (was) return was;
  const made = new Map(
    pr.files.map((f) => {
      const exact = written?.find((w) => w.path === f.path && w.additions === f.add && w.deletions === f.del) ?? patchFor(f.path, f.add, f.del);
      return [f.path, exact ?? sketch(f.path, f.add, f.del, pr.about?.length ? pr.about : [pr.title])] as const;
    }),
  );
  diffs.set(key, made);
  return made;
}

const reviews = new Map<string, Review>();

/** A pull request's guide and diff, as the runtime would send them for its head now; the same object until either changes. */
export function reviewOf(pr: Pr, draft: PrGuide | null = null, running = false): Review {
  const key = `${marksKey(pr)}|${pr.state}|${draft ? draft.generated_at : ""}|${running ? 1 : 0}`;
  const was = reviews.get(key);
  if (was) return was;
  const written = reviewedAt(pr.repo, pr.branch);
  const fresh = !!written && headOf(written.files.map((f) => ({ path: f.path, add: f.additions, del: f.deletions }))) === pr.head;
  const closed = pr.state === "merged" || pr.state === "closed";
  const files = closed && !pr.files.length ? EMPTY : fresh && written ? new Map(written.files.map((f) => [f.path, f])) : diffOf(pr, written?.files ?? null);
  // A guide written for this head wins; then the agent's own guide, stale or not; then, for a chat's, its own words.
  let guide: PrGuide | null = draft ?? written?.guide ?? null;
  if (!guide && pr.chat && !closed && (pr.tldr || pr.body)) {
    guide = { head_sha: pr.head, generated_at: new Date(pr.updatedAt).toISOString(), tldr: capTldr(pr.tldr ?? firstSentence(pr.body ?? "")), depth: "tldr", by: "chat", workspace_id: pr.chat, stops: [] };
  }
  const review: Review = {
    result: { guide, running, head_sha: pr.head },
    files,
    // Threads sit on the lines they were written on, so they show only at the head those lines are from.
    threads: fresh && written ? (written.threads ?? NONE) : NONE,
    reviews: written?.reviews ?? NONE,
  };
  reviews.set(key, review);
  return review;
}
