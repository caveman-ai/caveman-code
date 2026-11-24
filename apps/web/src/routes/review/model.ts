// The Review page's pure logic: how the queue groups, which diff rows an excerpt shows, which files a reader can
// skim, and what a spawned agent is told. No React, no wire calls.
import type { PrGuide, PrGuideStop, PrSummary } from "@caveman-app/session-protocol";
import type { DiffLine } from "../../panels/diff/parsePatch.ts";

/** A pull request: through a project of ours; `repo`/`host` when it lives in another repository on that host. */
export interface PrAddress {
  readonly project_id: string;
  readonly number: number;
  readonly repo?: string | undefined;
  readonly host?: string | undefined;
}

/** A merge method as its button says it (the Review page's, the Chief's Work list's confirmation). */
export const METHOD_LABEL = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" } as const;

export const prKey = (pr: PrAddress): string => `${pr.project_id}#${pr.repo ?? ""}#${pr.number}`;

/** The pull request's page in Review; another repository's rides in the query (PrPage reads `repo` and `host`). */
export function prPath(pr: PrAddress): string {
  const q = new URLSearchParams();
  if (pr.repo) q.set("repo", pr.repo);
  if (pr.host) q.set("host", pr.host);
  const query = q.toString();
  return `/review/${encodeURIComponent(pr.project_id)}/${pr.number}${query ? `?${query}` : ""}`;
}

/**
 * Where a pull request widget opens: beside the chat it was clicked in (that chat's side panel), else the Review
 * page. The side panel is the chat's; outside one (the sidebar, the inbox, the Chief's own transcript) there is none.
 */
export function prDestination(workspaceId: string | null | undefined, pr: PrAddress): { kind: "panel"; workspaceId: string } | { kind: "page"; path: string } {
  return workspaceId ? { kind: "panel", workspaceId } : { kind: "page", path: prPath(pr) };
}

/** The host page of a pull request: `https://github.com/owner/name/pull/12` (any host of that shape). */
const PR_URL = /^https:\/\/([^/?#]+)\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)(?:[/?#]|$)/i;

/**
 * A pull request on GitHub (or GitHub Enterprise, the same page shape), whose text keeps GitHub's rules: every
 * newline breaks the line, and #12, owner/name#12, @name and commit ids link.
 */
export const onGithub = (url: string): boolean => PR_URL.test(url);

/** The projects a pull request can be read through: a project's repository on its host. */
export interface PrProject {
  readonly id: string;
  readonly repository?: { readonly host: string; readonly full_name: string } | undefined;
}

/**
 * Where a pull request link opens in the app: the project that is that repository, else (the host reads any
 * repository the signed-in person can see) a project on the same host with the repository named; null when no
 * project is on that host, or the link is not a pull request. The link then stays the host's.
 */
export function prFromUrl(url: string, projects: ReadonlyArray<PrProject>): PrAddress | null {
  const m = PR_URL.exec(url.trim());
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const repo = m[2]!.replace(/\.git$/i, "");
  const number = Number(m[3]);
  const same = (p: PrProject) => p.repository?.host.toLowerCase() === host;
  const own = projects.find((p) => same(p) && p.repository!.full_name.toLowerCase() === repo.toLowerCase());
  if (own) return { project_id: own.id, number };
  const near = projects.find(same);
  return near ? { project_id: near.id, number, repo, host } : null;
}

/**
 * Where a queue row opens: through its project, naming the repository only when it is not the project's own, as
 * prFromUrl does. The runtime names the repository on every row, and an own pull request opened with it named would
 * be a second address (another prKey: other read marks, part marks and cached reads) for the same pull request.
 */
export function summaryAddress(pr: PrSummary, projects: ReadonlyArray<PrProject>): PrAddress {
  const repository = projects.find((p) => p.id === pr.project_id)?.repository;
  const own = repository !== undefined && repository.host.toLowerCase() === pr.host.toLowerCase() && repository.full_name.toLowerCase() === pr.repo.toLowerCase();
  return own ? { project_id: pr.project_id, number: pr.number } : { project_id: pr.project_id, number: pr.number, repo: pr.repo, host: pr.host };
}

export type QueueGroupId = "needs_you" | "guides_ready" | "yours" | "drafts" | "others" | "closed";
export interface QueueGroup {
  readonly id: QueueGroupId;
  readonly label: string;
  readonly prs: ReadonlyArray<PrSummary>;
}

const GROUP_LABEL: Record<QueueGroupId, string> = {
  needs_you: "Needs your review",
  guides_ready: "Guides ready",
  yours: "Yours",
  drafts: "Drafts",
  others: "Everything else open",
  closed: "Merged and closed",
};

/** One group per pull request, first match wins: asked of you, a guide ready to read, yours, drafts, the rest; empty groups drop. */
export function groupQueue(prs: ReadonlyArray<PrSummary>): QueueGroup[] {
  const by: Record<QueueGroupId, PrSummary[]> = { needs_you: [], guides_ready: [], yours: [], drafts: [], others: [], closed: [] };
  for (const pr of prs) {
    const id: QueueGroupId =
      pr.state === "merged" || pr.state === "closed"
        ? "closed"
        : pr.state === "draft"
          ? "drafts"
          : pr.review_requested && !pr.mine
            ? "needs_you"
            : pr.guide_ready
              ? "guides_ready"
              : pr.mine
                ? "yours"
                : "others";
    by[id].push(pr);
  }
  return (Object.keys(by) as QueueGroupId[]).filter((id) => by[id].length > 0).map((id) => ({ id, label: GROUP_LABEL[id], prs: by[id] }));
}

/** How the queue is cut into sections: by what each pull request asks of you, or by its repository. */
export type QueueGrouping = "status" | "repo";

/** One repository's section of the queue. */
export interface RepoGroup {
  /** owner/name, as the host names it. */
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly prs: ReadonlyArray<PrSummary>;
  /** Open, asking for your review, not yours. */
  readonly needsYou: number;
  readonly failing: number;
}

/** It asks for your review and is open: the one thing a row must say when the sections no longer do. */
export const asksYou = (pr: PrSummary): boolean => pr.state === "open" && pr.review_requested && !pr.mine;

/**
 * One section per repository. Repositories with pull requests waiting on you come first, most first, then the one
 * updated last; within a section rows keep the order they came in (the sort the person picked).
 */
export function groupByRepo(prs: ReadonlyArray<PrSummary>): RepoGroup[] {
  const by = new Map<string, PrSummary[]>();
  for (const pr of prs) {
    const key = `${pr.host}/${pr.repo}`;
    const list = by.get(key);
    if (list) list.push(pr);
    else by.set(key, [pr]);
  }
  const latest = (list: ReadonlyArray<PrSummary>) => list.reduce((at, pr) => (pr.updated_at > at ? pr.updated_at : at), "");
  return [...by.values()]
    .map((list) => {
      const repo = list[0]!.repo;
      const slash = repo.indexOf("/");
      return {
        repo,
        owner: slash < 0 ? "" : repo.slice(0, slash),
        name: slash < 0 ? repo : repo.slice(slash + 1),
        prs: list,
        needsYou: list.filter(asksYou).length,
        failing: list.filter((pr) => pr.checks === "failing").length,
        latest: latest(list),
      };
    })
    .sort((a, b) => b.needsYou - a.needsYou || b.latest.localeCompare(a.latest) || a.repo.localeCompare(b.repo))
    .map(({ latest: _latest, ...group }) => group);
}

/** How many ask for you now: the sidebar's count. */
export const needsYou = (prs: ReadonlyArray<PrSummary>): number => prs.filter((pr) => pr.state === "open" && pr.review_requested && !pr.mine).length;

/**
 * The rows of one excerpt: from the first to the last row on `side` inside [start, end], with the other side's rows
 * that fall between them, so a reader sees what an added block replaced. Never a hunk header.
 */
export function excerptRows(rows: ReadonlyArray<DiffLine>, side: "new" | "old", start: number, end: number): DiffLine[] {
  const no = (row: DiffLine) => (side === "new" ? row.newNo : row.oldNo);
  let first = -1;
  let last = -1;
  rows.forEach((row, i) => {
    const n = no(row);
    if (row.kind === "hunk" || n === null || n < start || n > end) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? [] : rows.slice(first, last + 1).filter((row) => row.kind !== "hunk");
}

export type FileKind = "code" | "test" | "generated";

// Evals count as tests, and _generated/ and __generated__/ folders as generated (upstream #26563).
const TEST = /(^|\/)(__tests__|tests?|spec|e2e|evals?|fixtures?|__snapshots__|testdata)\/|[._-](test|spec|eval)\.[a-z0-9]+$|_test\.go$|\.snap$/i;
const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.generated\.|\.gen\.|(^|\/)(dist|build|vendor|generated|_generated|__generated__)\/|\.min\.(js|css)$|\.pb\.go$|schema\/[^/]+\.json$/i;

/** Code first; tests and generated files (lockfiles, vendored, built) fold to the bottom of Files. */
export function fileKind(path: string): FileKind {
  if (GENERATED.test(path)) return "generated";
  if (TEST.test(path)) return "test";
  return "code";
}

/** Snapshots read as tests in Files, but the guide writer counts them as mechanical (the runtime's ladder). */
const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/i;

/**
 * Lines of code and tests a change touches, as the guide writer counts them: lockfiles, generated, vendored and
 * snapshot files left out, so a lockfile bump never makes a small change long.
 */
export function guideLines(files: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number }>): number {
  return files.reduce((n, f) => (fileKind(f.path) === "generated" || SNAPSHOT.test(f.path) ? n : n + f.additions + f.deletions), 0);
}

/** Settings > Review's short-change limit when the runtime reports none (`review_short_lines`). */
export const DEFAULT_SHORT_LINES = 30;

/** A change whose guide is its TL;DR and the diff: some code or tests changed, at most `limit` lines; 0 turns it off. */
export const isShortChange = (lines: number, limit: number): boolean => limit > 0 && lines > 0 && lines <= limit;

/**
 * What the Guide tab draws. A tour once one is written (guides older than depth are tours). Otherwise the size
 * decides, by the rule the runtime writes by: a short change shows its TL;DR and diff at once, never a wait, and a
 * long one that so far has only the TL;DR its chat wrote shows the tour on its way.
 */
export function guideDepth(guide: Pick<PrGuide, "depth"> | null | undefined, short: boolean): "tldr" | "tour" {
  if (guide && (guide.depth ?? "tour") === "tour") return "tour";
  return short ? "tldr" : "tour";
}

/** A stop that only accounts for mechanical files: no code to show, so it reads as one folded line. */
export const isSkimStop = (stop: PrGuideStop): boolean => stop.excerpts.length === 0 && stop.files.length > 0;

/** The file at the pull request's head on its host (GitHub's blob URL), at a line, else the pull request's page. */
export function fileUrl(pr: { url: string; head_sha?: string | undefined }, path: string, line?: number): string {
  return pr.head_sha ? blobUrl(pr.url, pr.head_sha, path, line) : pr.url;
}

/** A file at any commit of the pull request's repository on its host, at a line; the pull request's page when its URL is not GitHub's shape. */
export function blobUrl(prUrl: string, commit: string, path: string, line?: number): string {
  const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl);
  return m && commit ? `${m[1]}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}` : prUrl;
}

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** Where a highlighted passage came from, said in the agent's task. */
export interface Passage {
  /** "guide stop 2 “Merge gate blocks red CI”", "src/a.ts:12-30", "@codex on projects.ts:678". */
  readonly where: string;
  readonly quote: string;
}

const QUOTE_MAX = 1200;

/**
 * What a chat started from the Review page is told: the pull request by reference (the agent reads the code itself
 * on the head it starts on), where the passage came from, the passage, then the person's words. Short on purpose.
 */
export function agentTask(input: { pr: Pick<PrSummary, "number" | "title" | "repo" | "url" | "head_branch">; mode: "ask" | "fix"; passage?: Passage | undefined; text: string }): string {
  const { pr, mode, passage, text } = input;
  const lines = [`Pull request #${pr.number} “${pr.title}” in ${pr.repo} (${pr.url}); you are on its head branch \`${pr.head_branch}\`.`];
  lines.push(
    mode === "fix"
      ? "Make the change below on this branch, keep it small, run the checks that cover it, then commit and push so the pull request updates."
      : "Answer the question below about this pull request. Read the code; change nothing.",
  );
  if (passage) {
    const quote = passage.quote.length > QUOTE_MAX ? `${passage.quote.slice(0, QUOTE_MAX)}…` : passage.quote;
    lines.push("", `From ${passage.where}:`, ...quote.split("\n").map((l) => `> ${l}`));
  }
  const ask = text.trim();
  lines.push("", ask || (mode === "fix" ? "Fix this." : "Explain this: what it does and why."));
  return lines.join("\n");
}

/** A chat title for what was asked: the person's words, else the passage's place. */
export function agentTitle(mode: "ask" | "fix", text: string, passage?: Passage): string {
  const words = text.trim().replace(/\s+/g, " ") || passage?.where || "this pull request";
  const head = mode === "fix" ? "Fix" : "Ask";
  return `${head}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}`;
}

/**
 * A host comment as people read it: bots wrap theirs in HTML comments, badges and <details>, which Markdown shows as
 * raw text. Comments go, tags go (their text stays), and the blank runs they leave collapse.
 */
export function readableBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:a|img|picture|source|sup|sub|br|p|div|span|details|summary|kbd|b|i|em|strong)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
