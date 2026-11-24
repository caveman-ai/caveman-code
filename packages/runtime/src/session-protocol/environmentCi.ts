// CI on a commit, as GitHub reports it (docs/ D11): whether a failing check is
// the repo's own, not the Cloud setup's. Both of GitHub's kinds of CI count: commit statuses (the combined status)
// and check runs (Actions and apps). No token, a repo or commit GitHub doesn't show this account, or GitHub not
// answering within a few seconds: null, never an error. A setup is never judged on a guess.
import type { EnvironmentCi } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

/** How long GitHub gets to answer both requests. */
export const CI_TIMEOUT_MS = 5_000;

/** owner/name, neither of them dots alone. */
const REPO = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
/** A branch, as GitHub's commits/{ref} reads one (its head): no `..`, no leading dash, never a symbolic HEAD. */
const BRANCH = /^(?!-)(?!HEAD$)(?!.*\.\.)[A-Za-z0-9._/+-]{1,255}$/;

interface CombinedStatus {
  readonly sha?: string;
  readonly statuses?: ReadonlyArray<{ readonly context?: string; readonly state?: string; readonly target_url?: string | null }>;
}
interface CheckRuns {
  readonly check_runs?: ReadonlyArray<{ readonly name?: string; readonly status?: string; readonly conclusion?: string | null; readonly html_url?: string | null }>;
}

/** A check run's conclusion that means the repo's own CI failed; cancelled, skipped, neutral and stale don't. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const PASSED = new Set(["success", "neutral", "skipped"]);

/**
 * Merges GitHub's two answers: failing when any status or check failed (names deduplicated, statuses first),
 * else pending when any is still running, else passing when any passed, else unknown (none, or only cancelled).
 */
export function mergeCi(repo: string, commit: string, status: CombinedStatus | undefined, checks: CheckRuns | undefined): EnvironmentCi {
  const failing: string[] = [];
  let failingUrl: string | undefined;
  let pending = false;
  let passed = false;
  const fail = (name: string | undefined, url: string | null | undefined) => {
    if (name && !failing.includes(name)) failing.push(name);
    failingUrl ??= url ?? undefined;
  };
  for (const s of status?.statuses ?? []) {
    if (s.state === "failure" || s.state === "error") fail(s.context, s.target_url);
    else if (s.state === "pending") pending = true;
    else if (s.state === "success") passed = true;
  }
  for (const run of checks?.check_runs ?? []) {
    if (run.status !== "completed") pending = true;
    else if (FAILED.has(run.conclusion ?? "")) fail(run.name, run.html_url);
    else if (PASSED.has(run.conclusion ?? "")) passed = true;
  }
  const sha = status?.sha && COMMIT.test(status.sha) ? status.sha : commit;
  const state = failing.length > 0 ? "failing" : pending ? "pending" : passed ? "passing" : "unknown";
  return { commit: sha, state, failing, url: failingUrl ?? `https://github.com/${repo}/commit/${sha}` };
}

/** CI on a commit, or on a branch's head (`commit` a branch name: the pull request board compares with its base). */
export function ciStatus(input: {
  readonly repo: string;
  readonly commit: string;
  readonly token: () => Effect.Effect<string | undefined>;
  /** For tests: GitHub's API is fetched with this, within this long. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): Effect.Effect<EnvironmentCi | null> {
  const { repo, commit } = input;
  if (!REPO.test(repo) || !(COMMIT.test(commit) || BRANCH.test(commit))) return Effect.succeed(null);
  const get = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? CI_TIMEOUT_MS;
  return Effect.gen(function* () {
    const token = yield* input.token();
    if (!token) return null;
    const signal = AbortSignal.timeout(timeoutMs);
    // 404: GitHub doesn't show this account the repo or the commit. Any other refusal (a token without the checks
    // permission is a 403) leaves that half out.
    const api = <T>(route: string) =>
      get(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(commit)}/${route}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "caveman-code" },
        signal,
      }).then(async (r): Promise<T | "not_found" | undefined> => (r.status === 404 ? "not_found" : r.ok ? ((await r.json()) as T) : undefined));
    // ponytail: the first 100 check runs; a commit with more still shows its first failing ones.
    const [status, checks] = yield* Effect.tryPromise(() => Promise.all([api<CombinedStatus>("status"), api<CheckRuns>("check-runs?per_page=100")]));
    if (status === "not_found" || checks === "not_found" || (status === undefined && checks === undefined)) return null;
    return mergeCi(repo, commit, status, checks);
  }).pipe(
    // A fetch that ignores its signal still can't hold the caller.
    Effect.timeout(timeoutMs + 1_000),
    Effect.catchCause(() => Effect.succeed(null)),
  );
}
