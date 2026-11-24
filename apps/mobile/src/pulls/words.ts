// Every sentence a person reads about a pull request on the phone, in the one vocabulary every screen shares
// (docs/ "repository", "GitHub", one sentence that says what to do and where). The
// groups, a pull request's states and the merge question are the web's Review page's own words
// (apps/web/src/routes/review: model.ts GROUP_LABEL and METHOD_LABEL, Discussion.tsx VERDICT, PrPage.tsx's confirm),
// so a person reads the same thing on both. A refusal is GitHub's own sentence where GitHub refused, and one of ours
// otherwise: never a status code, and never Cloud's raw answer. Pure: no React, nothing of the platform.
import type { PrDetail, PrSummary } from "@caveman-app/session-protocol";

/** A list that is being read for the first time. */
export const LOADING = "Loading…";

/** What Cloud says when it keeps no GitHub link of the person's (CONTRACT §12), and the button that makes one. */
export const CONNECT_GITHUB = "Connect GitHub to review pull requests here.";
export const CONNECT_BUTTON = "Connect GitHub";

/** The queue's groups, as the web names them. The phone lists the first and the third. */
export const GROUP_LABEL = {
  needs_you: "Needs your review",
  guides_ready: "Guides ready",
  yours: "Yours",
  drafts: "Drafts",
  others: "Everything else open",
  closed: "Merged and closed",
} as const;

export const STATE_WORD: Record<PrSummary["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** A review's verdict after its author's name ("carol approved"). */
export const VERDICT_WORD = {
  approved: "approved",
  changes_requested: "asked for changes",
  commented: "reviewed",
} as const;

/** A merge method as its button says it. */
export const METHOD_LABEL = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
} as const;
export type MergeMethod = keyof typeof METHOD_LABEL;

/** The changes a person makes to a pull request from the phone. */
export type Change = "approve" | "changes" | "comment" | "merge";

/** Each change's button, what it reads while it is on its way, and what the toast says once GitHub has it. */
export const BUTTON: Record<Change | "ask", string> = {
  approve: "Approve",
  changes: "Request changes",
  comment: "Comment",
  merge: "Merge",
  ask: "Ask an agent",
};
/** Ask an agent on a phone too narrow for the words beside the other buttons: the web's own short form, led by the caveman's mark. */
export const ASK_SHORT = "Ask";
export const DOING: Record<Change, string> = {
  approve: "Approving",
  changes: "Sending",
  comment: "Sending",
  merge: "Merging",
};
export const DONE: Record<Change, string> = {
  approve: "Approved",
  changes: "Changes requested",
  comment: "Commented",
  merge: "Merged",
};

/** What the field asks for, for the two changes that take words. */
export const ASKS: Record<"changes" | "comment", string> = {
  changes: "What should change?",
  comment: "Say something on the pull request",
};

/** The page's two parts under the description, and what stands in for an author GitHub does not name. */
export const PART = { discussion: "Discussion", files: "Files" } as const;
export const NOBODY = "unknown";
/** Before the names of the checks that fail. */
export const FAILING = "Failing:";

export const NO_COMMENTS = "No comments yet.";
/** A file GitHub sent no patch for. */
export const NO_PATCH = "No lines to show: renamed, binary or too large.";

/** A wait in one line: what is being done and, once a second has passed, for how long ("Merging… 3s"). */
export function waitLine(doing: string, since: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - since) / 1000);
  return seconds < 1 ? `${doing}…` : `${doing}… ${seconds}s`;
}

/** "4m", "3h", "2d": how long ago, as the phone's rows say it; "" for a time that cannot be read. */
export function ageOf(at: string, now: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A row's second line: where the pull request is and how long ago it last changed ("acme/api #7 · 40m"). */
export function rowLine(
  pr: Pick<PrSummary, "repo" | "number" | "updated_at">,
  now: number,
): string {
  const age = ageOf(pr.updated_at, now);
  return `${pr.repo} #${pr.number}${age ? ` · ${age}` : ""}`;
}

/** A row's checks, for a screen reader: the mark alone says it to the eye. */
export const CHECKS_SAID: Record<NonNullable<PrSummary["checks"]>, string> = {
  passing: "checks pass",
  failing: "checks fail",
  pending: "checks running",
};

/** The repositories Cloud could not read, said once under the list, in the web's words. */
export function couldNotRead(
  errors: ReadonlyArray<{ readonly repo?: string; readonly message: string }>,
): string | null {
  const first = errors[0];
  if (!first) return null;
  const repos = [...new Set(errors.flatMap((e) => (e.repo ? [e.repo] : [])))];
  return `Could not read ${repos.length > 0 ? repos.join(", ") : "a repository"}: ${first.message}`;
}

/** After the state word: who opened it, what goes into what, and where ("bob · main ← fix-login · acme/api"). */
export function stateLine(pr: Pick<PrSummary, "author" | "base_branch" | "head_branch" | "repo">): {
  readonly author: string;
  readonly branches: string;
  readonly repo: string;
} {
  return {
    author: pr.author?.login ?? "",
    branches: `${pr.base_branch} ← ${pr.head_branch}`,
    repo: pr.repo,
  };
}

export interface ChecksSaid {
  /** How many pass, of those that ran or run ("2 of 3 checks pass"). */
  readonly line: string;
  /** Each failing check, by name. */
  readonly failing: ReadonlyArray<string>;
  readonly mark: "pass" | "fail" | "running";
}

/** A pull request's checks in a line, and each failing one by name; null where it has none. Skipped checks say nothing. */
export function checksSaid(checks: PrDetail["checks_list"]): ChecksSaid | null {
  const ran = checks.filter((c) => c.status !== "skipped");
  if (ran.length === 0) return null;
  const passed = ran.filter((c) => c.status === "passed").length;
  const failing = ran.filter((c) => c.status === "failed").map((c) => c.name);
  const running = ran.filter((c) => c.status === "pending").length;
  const line =
    ran.length === 1
      ? passed
        ? "1 check passes"
        : failing.length
          ? "1 check fails"
          : "1 check running"
      : `${passed} of ${ran.length} checks pass${running > 0 ? ` · ${running} running` : ""}`;
  return { line, failing, mark: failing.length > 0 ? "fail" : running > 0 ? "running" : "pass" };
}

/** Who reviewed it and how, then who is still asked ("carol reviewed · waiting on ada"); null where nobody was asked. */
export function reviewsSaid(reviewers: PrDetail["reviewers"]): string | null {
  const said = reviewers.flatMap((r) =>
    r.state === "pending" ? [] : [`${r.login} ${VERDICT_WORD[r.state]}`],
  );
  const asked = reviewers.filter((r) => r.state === "pending").map((r) => r.login);
  const parts = [...said, ...(asked.length > 0 ? [`waiting on ${asked.join(", ")}`] : [])];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Why an open pull request cannot be merged as it stands, in a few words; null when GitHub names nothing. */
export function mergeBar(pr: Pick<PrDetail, "state" | "mergeable" | "base_branch">): string | null {
  if (pr.state !== "open") return null;
  if (pr.mergeable === "conflicting") return `Conflicts with ${pr.base_branch}`;
  return pr.mergeable === "blocked" ? "Blocked by a branch rule" : null;
}

/**
 * The one question before a merge, which cannot be undone: what goes where, and that checks fail when they do (the
 * web's words). The method is the button's; the question itself stays short enough for the narrowest sheet's head.
 */
export function mergeQuestion(
  pr: Pick<PrDetail, "number" | "head_branch" | "base_branch" | "repo" | "checks_list">,
  method: MergeMethod,
): {
  readonly title: string;
  readonly line: string;
  readonly confirm: string;
  readonly failing: boolean;
} {
  const failing = pr.checks_list.some((c) => c.status === "failed");
  return {
    title: `${BUTTON.merge} #${pr.number}?`,
    line: `${pr.head_branch} into ${pr.base_branch} on ${pr.repo}.${failing ? " Some checks fail." : ""}`,
    confirm: METHOD_LABEL[method],
    failing,
  };
}

/** A comment as people read it: bots wrap theirs in HTML comments and tags, which Markdown would show raw (the web's readableBody). */
export function readable(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\/?(?:a|img|picture|source|sup|sub|br|p|div|span|details|summary|kbd|b|i|em|strong)\b[^>]*>/gi,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The first message of a chat started from a pull request: the pull request by reference, then the web's Ask
 * instruction and its default question (apps/web/src/routes/review/model.ts agentTask). The agent reads the code
 * itself. A chat the phone starts begins on the repository's own branch, so the message names the head branch rather
 * than saying the chat is on it. Its first clause is what the chat is titled by ("About pull request #7").
 */
export function askText(
  pr: Pick<PrSummary, "number" | "title" | "repo" | "url" | "head_branch">,
): string {
  return [
    `About pull request #${pr.number}: “${pr.title}” in ${pr.repo} (${pr.url}), head branch \`${pr.head_branch}\`.`,
    "Answer the question below about this pull request. Read the code on its head branch; change nothing.",
    "",
    "Explain this: what it does and why.",
  ].join("\n");
}

// ---------------------------------------------------------------- what could not be read or done

const SIGN_IN = "Sign in to Caveman again (Settings > Account).";
/** A Caveman that keeps Review from a phone's sign-in: the Mac's Review page reads GitHub itself. */
const ON_YOUR_MAC = "Review it on your Mac (Review).";
const NOT_FOUND = "Can't find this pull request in your projects.";

interface Failure {
  readonly name?: string;
  readonly message?: string;
  readonly status?: number;
  readonly code?: string;
}
const failureOf = (error: unknown): Failure =>
  error !== null && typeof error === "object" ? (error as Failure) : {};

/** Nothing was reached: the request itself failed, so the phone is offline or Caveman is out of reach. */
export const unreached = (error: unknown): boolean =>
  ["TypeError", "AbortError"].includes(failureOf(error).name ?? "");

/** Whether a read that failed passes by itself (no network, Caveman busy for a moment), so it is read again before anything is said. */
export function passes(error: unknown): boolean {
  const e = failureOf(error);
  if (e.name === "CloudError")
    return (e.status ?? 0) >= 500 || e.status === 429 || e.status === 408;
  return unreached(error);
}

/** Cloud keeps no GitHub link of the person's for this repository: the sentence comes with its button. */
export const notConnected = (error: unknown): boolean =>
  failureOf(error).code === "cave_code_github_not_connected";

/** What Cloud and GitHub agree on everywhere: who must sign in, connect, or look somewhere else. Null: say what failed. */
function common(error: unknown): string | null {
  const e = failureOf(error);
  if (e.name === "SignedOut") return SIGN_IN;
  if (notConnected(error)) return CONNECT_GITHUB;
  if (e.code === "cave_agent_operation_forbidden") return ON_YOUR_MAC;
  if (e.name === "CloudError" && e.status === 404) return NOT_FOUND;
  return null;
}

/** Why something could not be read, in one line. */
export function unreadWords(
  error: unknown,
  what: "list" | "pull" | "discussion" | "patch",
): string {
  const said = common(error);
  if (said) return said;
  if (unreached(error))
    return what === "list"
      ? "No network. Pull requests load when you're back online."
      : "No network. Loads when you're back online.";
  return {
    list: "Couldn't load pull requests.",
    pull: "Couldn't load this pull request.",
    discussion: "Couldn't load the discussion.",
    patch: "Couldn't load this file's lines.",
  }[what];
}

/**
 * Why a change was refused, in one line. GitHub's own words where GitHub refused it (a branch rule, a head that
 * moved): they are written for a person. Anything else is ours.
 */
export function refusedWords(error: unknown, change: Change): string {
  const e = failureOf(error);
  if (e.code === "cave_code_github_refused")
    return e.message && !/^Caveman answered \d+\.$/.test(e.message) && !/^cave_/.test(e.message)
      ? e.message
      : "GitHub refused it.";
  const said = common(error);
  if (said) return said;
  const not = {
    approve: "Not approved.",
    changes: "Not sent.",
    comment: "Not sent.",
    merge: "Not merged.",
  }[change];
  if (unreached(error)) return `No network. ${not}`;
  return {
    approve: "Couldn't approve.",
    changes: "Couldn't send.",
    comment: "Couldn't send.",
    merge: "Couldn't merge.",
  }[change];
}
