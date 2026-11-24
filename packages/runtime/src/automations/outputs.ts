// What a run writes when it ends (SEMANTICS §7): only the runtime writes, never an agent. A comment is
// upserted by its marker on the subject issue or pull request, so later runs edit it instead of stacking
// new ones; a pull request comes from the run's caveman/* branch, pushed after the diff is checked for
// paths an automation may never change (SEMANTICS §13 rule 4). A manual run records exactly what it would
// write (a dry run) until automation.run_apply.
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { CAVEMAN_PR_FOOTER } from "../git/coAuthor.ts";
import { gitOk, type Git } from "./steps.ts";

export class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly retryable: boolean;
  /** no_changes: nothing to propose (the output is dropped, not failed); no_remote: nowhere to open it (a dry run drops it). */
  readonly kind?: "no_changes" | "no_remote";
}> {}

/** The GitHub REST calls outputs make; production signs them with the person's GitHub login. */
export interface GitHubRest {
  readonly request: (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Effect.Effect<unknown, OutputError>;
}

export function gitHubRest(credentials: GitHubCredentials.GitHubCredentials["Service"]): GitHubRest {
  return {
    request: (method, route, body) =>
      Effect.gen(function* () {
        const credential = yield* credentials.get("github.com").pipe(Effect.mapError(() => new OutputError({ message: "Sign in to GitHub in Settings so automations can write to it.", retryable: false })));
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`https://api.github.com${route}`, {
              method,
              headers: {
                authorization: `Bearer ${Redacted.value(credential.token)}`,
                accept: "application/vnd.github+json",
                "user-agent": "caveman-code",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          catch: (cause) => new OutputError({ message: `GitHub did not answer: ${String(cause)}`, retryable: true }),
        });
        const text = yield* Effect.promise(() => response.text());
        if (!response.ok) {
          const said = (() => {
            try {
              return (JSON.parse(text) as { message?: string }).message ?? text;
            } catch {
              return text;
            }
          })();
          return yield* new OutputError({ message: `GitHub answered ${response.status} to ${method} ${route}: ${said.slice(0, 300)}`, retryable: response.status >= 500 || response.status === 429 });
        }
        return text === "" ? {} : (JSON.parse(text) as unknown);
      }),
  };
}

// ------------------------------------------------------------------ pure parts

/** §7.4: one comment per (automation, subject). */
export const commentMarker = (automation: string, subject: string): string => `<!-- caveman:automation=${automation} subject=${subject} -->`;

/** The issue or pull request a GitHub subject names (`github:<owner>/<repo>#<n>`, optionally `/comment/<id>`). */
export function issueOf(subject: string): { readonly owner: string; readonly repo: string; readonly number: number } | undefined {
  const match = /^github:([\w.-]+)\/([\w.-]+)#(\d+)(?:\/comment\/\d+)?$/.exec(subject);
  return match === null ? undefined : { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** The commit a push subject names (`github:<owner>/<repo>@<sha>`). */
export function commitOf(subject: string): { readonly owner: string; readonly repo: string; readonly sha: string } | undefined {
  const match = /^github:([\w.-]+)\/([\w.-]+)@([0-9a-f]{7,40})$/i.exec(subject);
  return match === null ? undefined : { owner: match[1]!, repo: match[2]!, sha: match[3]! };
}

/** owner/repo from a GitHub remote URL (https or ssh). */
export function repoOfRemote(url: string): { readonly owner: string; readonly repo: string } | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? undefined : { owner: match[1]!, repo: match[2]! };
}

/**
 * SEMANTICS §13 rule 4: no automation may change CI workflows, its own definitions, or a computer's config. Compared
 * without case (a case-insensitive disk or host treats `.GitHub/Workflows` as the workflows folder); a deleted or
 * renamed-away protected file counts, since the list is `--no-renames`.
 */
export function forbiddenPaths(paths: ReadonlyArray<string>): string[] {
  return paths.filter((p) => {
    const l = p.toLowerCase();
    return l.startsWith(".github/workflows/") || l.startsWith(".caveman/") || l === "computer.toml" || l.endsWith("/computer.toml");
  });
}

/** Test files by the usual names: a step that changes or deletes one says so where people review it (rule 5). */
export const isTestFile = (p: string): boolean =>
  /(^|\/)(tests?|__tests__|specs?|e2e)\//i.test(p) || /\.(test|spec)\.[^./]+$/i.test(p) || /(^|\/)test_[^/]*\.py$/i.test(p) || /_(test|spec)\.[^./]+$/i.test(p) || /(^|\/)conftest\.py$/i.test(p);

/** "Tests this change modifies: …" lines, or nothing when it changes no test it did not add. */
export function testChangesNote(changed: { readonly modified: ReadonlyArray<string>; readonly deleted: ReadonlyArray<string> }): string {
  const lines: string[] = [];
  if (changed.modified.length > 0) lines.push(`Tests this change modifies: ${changed.modified.join(", ")}.`);
  if (changed.deleted.length > 0) lines.push(`Tests this change deletes: ${changed.deleted.join(", ")}.`);
  return lines.join("\n");
}

/** The test files `sha` modifies or deletes against `base` (added ones are not listed). */
export const changedTests = (git: Git, root: string, base: string, sha: string) =>
  git(root, ["diff", "-z", "--no-renames", "--name-status", base, sha]).pipe(
    Effect.map((r) => {
      const parts = r.code === 0 ? r.stdout.split("\0").filter((x) => x.length > 0) : [];
      const modified: string[] = [];
      const deleted: string[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const [status, file] = [parts[i]!, parts[i + 1]!];
        if (!isTestFile(file)) continue;
        if (status.startsWith("D")) deleted.push(file);
        else if (!status.startsWith("A")) modified.push(file);
      }
      return { modified, deleted };
    }),
    Effect.orElseSucceed(() => ({ modified: [] as string[], deleted: [] as string[] })),
  );

export const branchAllowed = (branch: string): boolean => /^caveman\/[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes("..");

export const commentBody = (text: string, marker: string): string => `${text.trim()}\n\n${marker}`;

/** The first line of the summary, markdown heading marks off, at most 72 characters. */
export function prTitle(summary: string, automation: string, step: string): string {
  const line = summary.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l.length > 0);
  if (line === undefined) return `${automation}: ${step}`;
  return line.length <= 72 ? line : `${line.slice(0, 71).trimEnd()}…`;
}

export function prBody(input: { readonly summary: string; readonly automation: string; readonly run: string; readonly coAuthor: boolean; readonly tests?: string }): string {
  const footer = `Opened by the ${input.automation} automation, run ${input.run}.${input.coAuthor ? `\n${CAVEMAN_PR_FOOTER}` : ""}`;
  return `${input.summary.trim()}${input.tests ? `\n\n${input.tests}` : ""}\n\n---\n${footer}`;
}

// ------------------------------------------------------------------ comment

/** The signed-in GitHub login: only its own comments are ever edited (§7.4), never one that only quotes the marker. */
const signedIn = (gh: GitHubRest) =>
  gh.request("GET", "/user").pipe(
    Effect.flatMap((user) => {
      const login = (user as { login?: unknown }).login;
      return typeof login === "string" && login.length > 0 ? Effect.succeed(login) : Effect.fail(new OutputError({ message: "GitHub did not say who is signed in, so no comment was edited.", retryable: true }));
    }),
  );

type Comment = { id: number; body?: string; html_url: string; user?: { login?: string } | null };

/** Finds this login's comment carrying the marker, page by page (a resume searches before it creates, §7.3). */
const findComment = (gh: GitHubRest, list: string, marker: string, login: string) =>
  Effect.gen(function* () {
    for (let page = 1; page <= 10; page++) {
      const comments = (yield* gh.request("GET", `${list}?per_page=100&page=${page}`)) as Comment[];
      const found = comments.find((c) => c.user?.login === login && c.body?.includes(marker));
      if (found !== undefined) return found;
      if (comments.length < 100) return undefined;
    }
    return undefined;
  });

/** B7: the pull request that merged a pushed commit, when GitHub knows one. */
const pullOfCommit = (gh: GitHubRest, commit: NonNullable<ReturnType<typeof commitOf>>) =>
  gh.request("GET", `/repos/${commit.owner}/${commit.repo}/commits/${commit.sha}/pulls`).pipe(
    Effect.map((pulls) => {
      const list = Array.isArray(pulls) ? (pulls as Array<{ number?: number; merged_at?: string | null }>) : [];
      return (list.find((p) => p.merged_at) ?? list[0])?.number;
    }),
  );

/**
 * §7.4: edits this automation's comment on the subject when there is one (only the signed-in login's), else posts
 * it. A push subject comments on the pull request that merged the commit, else on the commit itself (B7).
 */
export const upsertComment = (gh: GitHubRest, input: { readonly automation: string; readonly subject: string; readonly text: string }) =>
  Effect.gen(function* () {
    const marker = commentMarker(input.automation, input.subject);
    const body = commentBody(input.text, marker);
    const login = yield* signedIn(gh);
    const write = (list: string, edit: (id: number) => string) =>
      Effect.gen(function* () {
        const existing = yield* findComment(gh, list, marker, login);
        const written = (existing === undefined ? yield* gh.request("POST", list, { body }) : yield* gh.request("PATCH", edit(existing.id), { body })) as { id: number; html_url: string };
        return { url: written.html_url, remoteId: String(written.id) };
      });
    const issue = issueOf(input.subject);
    if (issue !== undefined) return yield* write(`/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`, (id) => `/repos/${issue.owner}/${issue.repo}/issues/comments/${id}`);
    const commit = commitOf(input.subject);
    if (commit === undefined) return yield* new OutputError({ message: "This run's trigger has no issue, pull request or commit to comment on.", retryable: false });
    const pull = yield* pullOfCommit(gh, commit);
    if (pull !== undefined) return yield* write(`/repos/${commit.owner}/${commit.repo}/issues/${pull}/comments`, (id) => `/repos/${commit.owner}/${commit.repo}/issues/comments/${id}`);
    return yield* write(`/repos/${commit.owner}/${commit.repo}/commits/${commit.sha}/comments`, (id) => `/repos/${commit.owner}/${commit.repo}/comments/${id}`);
  });

/**
 * Where a hosted run's github.comment goes (Caveman Cloud posts it): the issue or pull request its subject names, else
 * the commit its subject or its event names (push `after`, a check's or workflow's head), in the event's repository.
 */
export function commentPlace(subject: string, payload: unknown): { readonly repo: string; readonly issue?: number; readonly commit?: string } | undefined {
  const issue = issueOf(subject);
  if (issue !== undefined) return { repo: `${issue.owner}/${issue.repo}`, issue: issue.number };
  const commit = commitOf(subject);
  if (commit !== undefined) return { repo: `${commit.owner}/${commit.repo}`, commit: commit.sha };
  const at = (...keys: string[]): string | undefined => {
    let v: unknown = payload;
    for (const k of keys) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const repo = at("repo") ?? at("repository", "full_name") ?? /^github:([\w.-]+\/[\w.-]+)/.exec(subject)?.[1];
  const sha = at("push", "after") ?? at("after") ?? at("workflow_run", "head_sha") ?? at("check_suite", "head_sha");
  return repo === undefined || sha === undefined || !/^[0-9a-f]{7,40}$/i.test(sha) ? undefined : { repo, commit: sha };
}

/** Where a comment output goes, in words, for a dry run. */
export function commentTarget(subject: string): string | undefined {
  const issue = issueOf(subject);
  if (issue !== undefined) return `${issue.owner}/${issue.repo}#${issue.number}`;
  const commit = commitOf(subject);
  return commit === undefined ? undefined : `the pull request that merged ${commit.sha.slice(0, 12)} on ${commit.owner}/${commit.repo}, else that commit`;
}

// ------------------------------------------------------------------ pull request

export interface PullRequestPlan {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  /** The branch it is proposed into: the default branch, or a same-repo pull request's head branch (F-6). */
  readonly base: string;
  /** Exactly the commit the guard checked: what is pushed. */
  readonly sha: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  /** The files the branch changes against its base. */
  readonly files: ReadonlyArray<string>;
  readonly diff: string;
}

const DIFF_PREVIEW_MAX = 64 * 1024;
export const NO_REMOTE = "This repository has no GitHub remote named origin, so a pull request can't be opened from here.";

/**
 * What a pull request output would write: `sha` against `base`, refusing any branch but caveman/* and any change to
 * a protected path. The file list is NUL-separated and never renamed (so names are exact and a moved-away workflow
 * shows as deleted), and a list too long to read whole is refused rather than half-checked. Git runs in the
 * project's own checkout, never in the run's worktree.
 */
export const planPullRequest = (
  git: Git,
  input: {
    readonly root: string;
    readonly subject: string;
    readonly branch: string;
    readonly base: string;
    readonly baseBranch: string;
    readonly sha: string;
    readonly title: string;
    readonly body: (tests: string) => string;
    readonly draft: boolean;
  },
) =>
  Effect.gen(function* () {
    if (!branchAllowed(input.branch)) return yield* new OutputError({ message: `Automations push caveman/* branches only, not ${input.branch}.`, retryable: false });
    const named = issueOf(input.subject) ?? commitOf(input.subject);
    const remote = named ?? repoOfRemote(yield* gitOk(git, input.root, ["remote", "get-url", "origin"]).pipe(Effect.orElseSucceed(() => "")));
    if (remote === undefined) return yield* new OutputError({ message: NO_REMOTE, retryable: false, kind: "no_remote" });
    const asOutput = (e: { readonly message: string }) => new OutputError({ message: e.message, retryable: false });
    const listed = yield* git(input.root, ["diff", "-z", "--no-renames", "--name-only", input.base, input.sha]).pipe(Effect.mapError(asOutput));
    if (listed.code !== 0) return yield* new OutputError({ message: `git diff failed: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`, retryable: false });
    if (listed.truncated === true) return yield* new OutputError({ message: "The change lists more files than the runtime can check, so it was not pushed.", retryable: false });
    const files = listed.stdout.split("\0").filter((f) => f.length > 0);
    if (files.length === 0) return yield* new OutputError({ message: "No changes to propose: the step changed no files.", retryable: false, kind: "no_changes" });
    const forbidden = forbiddenPaths(files);
    if (forbidden.length > 0) {
      return yield* new OutputError({ message: `The change touches paths an automation may not change (${forbidden.slice(0, 5).join(", ")}), so it was not pushed.`, retryable: false });
    }
    const tests = testChangesNote(yield* changedTests(git, input.root, input.base, input.sha));
    const full = yield* gitOk(git, input.root, ["diff", input.base, input.sha]).pipe(Effect.mapError(asOutput));
    const diff = Buffer.byteLength(full) > DIFF_PREVIEW_MAX ? `${Buffer.from(full).subarray(0, DIFF_PREVIEW_MAX).toString("utf8")}\n[The diff goes on; ${files.length} files in all.]` : full;
    return {
      owner: remote.owner,
      repo: remote.repo,
      branch: input.branch,
      base: input.baseBranch.replace(/^origin\//, ""),
      sha: input.sha,
      title: input.title,
      body: input.body(tests),
      draft: input.draft,
      files,
      diff,
    } satisfies PullRequestPlan;
  });

export const pullRequestPreview = (plan: PullRequestPlan): string =>
  [`Would push ${plan.branch} and open a ${plan.draft ? "draft " : ""}pull request into ${plan.base} on ${plan.owner}/${plan.repo} (or edit the open one for that branch).`, `Title: ${plan.title}`, plan.body, `Diff:\n${plan.diff}`].join(
    "\n\n",
  );

/**
 * §7.4: push exactly the checked commit to the branch (forced with lease: a later run on the subject replaces it),
 * then edit the open pull request for it or open one. Pushed from the project's checkout, not the run's worktree.
 */
export const applyPullRequest = (gh: GitHubRest, git: Git, root: string, plan: PullRequestPlan) =>
  Effect.gen(function* () {
    const pushed = yield* git(root, ["push", "--force-with-lease", "origin", `${plan.sha}:refs/heads/${plan.branch}`]).pipe(Effect.mapError((e) => new OutputError({ message: e.message, retryable: true })));
    if (pushed.code !== 0) return yield* new OutputError({ message: `git push failed: ${(pushed.stderr || pushed.stdout).trim().slice(0, 300)}`, retryable: true });
    const open = (yield* gh.request("GET", `/repos/${plan.owner}/${plan.repo}/pulls?head=${encodeURIComponent(`${plan.owner}:${plan.branch}`)}&state=open`)) as Array<{ number: number; html_url: string }>;
    const written = (
      open[0] === undefined
        ? yield* gh.request("POST", `/repos/${plan.owner}/${plan.repo}/pulls`, { title: plan.title, head: plan.branch, base: plan.base, body: plan.body, draft: plan.draft })
        : yield* gh.request("PATCH", `/repos/${plan.owner}/${plan.repo}/pulls/${open[0].number}`, { title: plan.title, body: plan.body })
    ) as { number: number; html_url: string };
    return { url: written.html_url, remoteId: String(written.number) };
  });
