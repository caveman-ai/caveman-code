// The Review queue's filter bar, on lib/facets and lib/fuzzy: what the search reads, the facets (what it asks
// of you, checks, review, repository, author, labels), the sorts. Pure; Queue.tsx renders it.
import type { PrSummary } from "@caveman-app/session-protocol";
import { type ChipGroup, chipGroups, type Facet, type Filters, passes } from "../../lib/facets.ts";
import { type FieldsMatch, matchFields, queryWords } from "../../lib/fuzzy.ts";

export const SORTS: Readonly<Record<string, string>> = { updated: "Last updated", created: "Newest", title: "Title", size: "Biggest change" };
export const SORT_KEYS: ReadonlyArray<string> = Object.keys(SORTS);

const ASK_LABEL: Record<string, string> = { needs_you: "Needs you", mine: "Yours", draft: "Draft", chat: "Has a chat" };
const CHECKS_LABEL: Record<string, string> = { passing: "Passing", failing: "Failing", pending: "Pending" };
const REVIEW_LABEL: Record<string, string> = { approved: "Approved", changes_requested: "Changes requested", review_required: "Review required" };

/** What a pull request asks of you: review asked, yours, a draft, a chat of ours on its branch. */
export const asksOf = (pr: PrSummary): ReadonlyArray<string> => [
  ...(pr.review_requested && !pr.mine ? ["needs_you"] : []),
  ...(pr.mine ? ["mine"] : []),
  ...(pr.state === "draft" ? ["draft"] : []),
  ...(pr.workspace_id ? ["chat"] : []),
];

/** The facets, each offered only where it would change the list; authors and labels capped to the most common. */
export const PR_FACETS: ReadonlyArray<Facet<PrSummary>> = [
  { key: "ask", label: "For you", values: asksOf, order: Object.keys(ASK_LABEL), labelOf: (v) => ASK_LABEL[v] ?? v },
  { key: "checks", label: "Checks", values: (pr) => (pr.checks ? [pr.checks] : []), order: Object.keys(CHECKS_LABEL), labelOf: (v) => CHECKS_LABEL[v] ?? v },
  { key: "review", label: "Review", values: (pr) => (pr.review ? [pr.review] : []), order: Object.keys(REVIEW_LABEL), labelOf: (v) => REVIEW_LABEL[v] ?? v },
  { key: "repo", label: "Repository", values: (pr) => [pr.repo], max: 8 },
  { key: "author", label: "Author", values: (pr) => (pr.author ? [pr.author.login] : []), max: 8 },
  { key: "label", label: "Label", values: (pr) => (pr.labels ?? []).map((l) => l.name), max: 8 },
];

/** Where the search hit a pull request: `ranges[0]` on the title, `ranges[1]` on the branch. */
export type PrMatch = FieldsMatch;

/** A pull request against the query: title, branch, then number, author, repository and labels (not marked). */
export function matchPrText(pr: PrSummary, query: string): PrMatch | null {
  return matchFields(query, [
    { text: pr.title, weight: 1 },
    { text: pr.head_branch, weight: 0.7 },
    { text: `#${pr.number}`, weight: 0.9 },
    { text: pr.author?.login ?? "", weight: 0.6 },
    { text: pr.repo, weight: 0.5 },
    ...(pr.labels ?? []).map((l) => ({ text: l.name, weight: 0.6 })),
  ]);
}

export interface ShownPr {
  readonly pr: PrSummary;
  readonly match: PrMatch;
}

export const prChips = (prs: ReadonlyArray<PrSummary>, f: Filters): ReadonlyArray<ChipGroup> => chipGroups(prs, PR_FACETS, f.picked, (pr) => matchPrText(pr, f.query) !== null);

const size = (pr: PrSummary) => pr.additions + pr.deletions;

/** A host's timestamp as an instant: hosts write offsets and fractions of a second, which sort wrong as text (upstream #23588). */
const instant = (at: string) => Date.parse(at) || 0;

/**
 * The pull requests the filters keep, with where the query hit each. Sorted as asked; by last updated, a query
 * puts the best match first.
 */
export function filterPrs(prs: ReadonlyArray<PrSummary>, f: Filters): ReadonlyArray<ShownPr> {
  const kept = prs.flatMap((pr) => {
    if (!passes(PR_FACETS, f.picked, pr)) return [];
    const match = matchPrText(pr, f.query);
    return match ? [{ pr, match }] : [];
  });
  const by: Record<string, (a: ShownPr, b: ShownPr) => number> = {
    updated: (a, b) => instant(b.pr.updated_at) - instant(a.pr.updated_at),
    created: (a, b) => instant(b.pr.created_at) - instant(a.pr.created_at),
    title: (a, b) => a.pr.title.localeCompare(b.pr.title, undefined, { sensitivity: "base" }),
    size: (a, b) => size(b.pr) - size(a.pr),
  };
  const searching = queryWords(f.query).length > 0;
  const cmp = f.sort === "updated" && searching ? (a: ShownPr, b: ShownPr) => b.match.score - a.match.score || by.updated!(a, b) : (by[f.sort] ?? by.updated!);
  return [...kept].sort(cmp);
}
