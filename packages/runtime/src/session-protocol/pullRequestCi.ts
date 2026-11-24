// A pull request's red CI set against its base branch's, so nobody is told a pull request broke what its base broke
// (Workspace.pull_request.base_ci; the Chief's board reads it). GitHub only, on the person's own sign-in, through the
// same two reads environment.ci makes (environmentCi.ts ciStatus: commit statuses and check runs). Each side's answer
// is kept a couple of minutes, and a base's is shared by every pull request into it, so a board of ten red pull
// requests into main costs one read of main. Also the re-run: the failed jobs of each failed Actions run on a head.
import type { EnvironmentCi, PullRequest } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { ciStatus } from "./environmentCi.ts";

export type BaseCi = NonNullable<PullRequest["base_ci"]>;

/** How long one side's CI answer is kept. */
export const CI_TTL_MS = 2 * 60_000;

/** owner/name of a github.com pull request, from its url; undefined for any other host. */
export const githubRepoOf = (url: string): string | undefined =>
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+/.exec(url)?.[1];

/**
 * Its failing checks against its base's. A check counts as the base's when it fails there now, or did when last
 * compared (`previous`, same base): a base fixed since is still why this pull request's old run is red, until that
 * check is run again here. Undefined while this pull request's own read shows nothing failing.
 */
export function compareWithBase(
  head: Pick<EnvironmentCi, "failing">,
  base: Pick<EnvironmentCi, "failing" | "state">,
  branch: string,
  previous?: BaseCi,
): BaseCi | undefined {
  if (head.failing.length === 0) return undefined;
  const remembered = new Set(previous?.base === branch ? previous.on_base : []);
  const red = new Set(base.failing);
  return {
    base: branch,
    failing: [...head.failing],
    on_base: head.failing.filter((name) => red.has(name) || remembered.has(name)),
    base_state: base.state,
  };
}

/** Every failing check also failed on its base: CI is red, but not because of this pull request. */
export const onlyBaseFailing = (ci: BaseCi | undefined): boolean =>
  ci !== undefined &&
  ci.failing.length > 0 &&
  ci.failing.every((name) => ci.on_base.includes(name));

/** Two comparisons that say the same. */
export const sameBaseCi = (a: BaseCi | undefined, b: BaseCi | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.base === b.base &&
    a.base_state === b.base_state &&
    a.failing.join("\n") === b.failing.join("\n") &&
    a.on_base.join("\n") === b.on_base.join("\n"));

/**
 * The comparer, with its cache. `head` is the pull request's head commit (or its branch), `base` the branch it merges
 * into. Null when GitHub can't say (no sign-in, not GitHub, no answer): the board then knows only "failing".
 * Undefined when GitHub shows nothing failing on the head (a re-run under way).
 */
export function makeBaseCi(deps: {
  readonly token: () => Effect.Effect<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, { readonly at: number; readonly ci: EnvironmentCi | null }>();
  const read = (repo: string, ref: string) =>
    Effect.gen(function* () {
      const key = `${repo}@${ref}`;
      const hit = kept.get(key);
      if (hit !== undefined && now() - hit.at < CI_TTL_MS) return hit.ci;
      const ci = yield* ciStatus({
        repo,
        commit: ref,
        token: deps.token,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      // ponytail: entries are never swept; a computer's pull requests and their bases number in the dozens.
      kept.set(key, { at: now(), ci });
      return ci;
    });
  return (input: {
    readonly url: string;
    readonly head: string;
    readonly base: string;
    readonly previous?: BaseCi | undefined;
  }): Effect.Effect<BaseCi | undefined | null> =>
    Effect.gen(function* () {
      const repo = githubRepoOf(input.url);
      if (repo === undefined) return null;
      const [head, base] = yield* Effect.all([read(repo, input.head), read(repo, input.base)], {
        concurrency: 2,
      });
      if (head === null || base === null) return null;
      return compareWithBase(head, base, input.base, input.previous);
    });
}

/** A check run's conclusion that means it failed (environmentCi.ts says the same). */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** The Actions run a check run belongs to, from its page's url (…/actions/runs/123/job/456). */
export const actionsRunOf = (url: string | null | undefined): string | undefined =>
  url ? /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url)?.[1] : undefined;

/**
 * Re-runs the failed jobs of every failed Actions run on a pull request's head (GitHub's rerun-failed-jobs, on the
 * person's own sign-in), and says how many runs it started again. Checks outside Actions (another app, a commit
 * status) can't be re-run from here: they are left out, and a head with only those fails, saying so.
 */
export function rerunFailed(input: {
  readonly repo: string;
  readonly number: number;
  readonly token: string | undefined;
  readonly fetch?: typeof fetch;
}): Effect.Effect<number, Error> {
  const get = input.fetch ?? fetch;
  const { repo, number, token } = input;
  return Effect.gen(function* () {
    if (!token)
      return yield* Effect.fail(
        new Error("Sign in to GitHub on this computer to re-run its checks."),
      );
    if (githubRepoOf(`https://github.com/${repo}/pull/${number}`) !== repo)
      return yield* Effect.fail(new Error(`${repo} is not a GitHub repository.`));
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "caveman-code",
    };
    const api = (path: string, method = "GET") =>
      Effect.tryPromise({
        try: () =>
          get(`https://api.github.com/repos/${repo}${path}`, {
            method,
            headers,
            signal: AbortSignal.timeout(10_000),
          }),
        catch: () => new Error("GitHub didn't answer."),
      });
    const json = <T>(response: Response) => Effect.promise(() => response.json() as Promise<T>);
    const pull = yield* api(`/pulls/${number}`);
    if (!pull.ok)
      return yield* Effect.fail(new Error(`GitHub won't show #${number} (${pull.status}).`));
    const sha = (yield* json<{ head?: { sha?: string } }>(pull)).head?.sha;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha))
      return yield* Effect.fail(new Error(`GitHub didn't say #${number}'s head commit.`));
    const runs = yield* api(`/commits/${sha}/check-runs?per_page=100&filter=latest`);
    if (!runs.ok)
      return yield* Effect.fail(
        new Error(`GitHub won't list #${number}'s checks (${runs.status}).`),
      );
    const checks =
      (yield* json<{
        check_runs?: ReadonlyArray<{
          conclusion?: string | null;
          html_url?: string | null;
          details_url?: string | null;
        }>;
      }>(runs)).check_runs ?? [];
    const ids = [
      ...new Set(
        checks.flatMap((c) =>
          FAILED.has(c.conclusion ?? "")
            ? [actionsRunOf(c.details_url) ?? actionsRunOf(c.html_url)].filter(
                (id): id is string => id !== undefined,
              )
            : [],
        ),
      ),
    ];
    if (ids.length === 0)
      return yield* Effect.fail(
        new Error(`#${number} has no failed GitHub Actions run to re-run.`),
      );
    let started = 0;
    for (const id of ids) {
      const rerun = yield* api(`/actions/runs/${id}/rerun-failed-jobs`, "POST");
      if (rerun.ok) started++;
      else if (started === 0 && id === ids.at(-1))
        return yield* Effect.fail(
          new Error(`GitHub refused to re-run #${number}'s checks (${rerun.status}).`),
        );
    }
    return started;
  });
}
