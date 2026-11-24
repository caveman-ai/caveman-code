// What a chat's branch has on its git host (Workspace.pull_request), for the sidebar's pill and the Chief's board.
// Every chat with a worktree on this computer is looked up through GitManager.branchPullRequest, upstream cached lookup
// that backs off when the host throttles: each minute from its cache, and fresh when the chat's turn ends (an agent
// may just have opened one). On a Cloud computer, which holds no GitHub login, Cloud answers instead from its pull
// request table (kept current by the App's webhooks), on the computer's own link identity. A workspace is written and
// published only when its pull request changed.
//
// The same lookup reads what the worktree holds that its base does not (Workspace.unmerged): uncommitted files and
// commits on the branch, from two local git reads, so the queue can tell a finished chat with work still to land
// from one with nothing left.
//
// Its checks and review decision come from the pull request the chat's thread links (link_pull_request, or the one it
// created): upstream PullRequestSyncReactor reads every open linked pull request in one batched host read a minute, slower
// once it sits quiet, and pauses while the host rate-limits; each change lands as a thread.pull-request-link-updated
// event, which the projector (daemon.ts followThread) folds onto the pill here. The branch lookup above knows nothing
// of checks, so it keeps the ones the pill has for the same pull request.
import * as fs from "node:fs";

import type { ThreadPullRequestLink } from "@caveman-app/protocol";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type { PullRequest, Workspace } from "@caveman-app/session-protocol";

import { readIdentity } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { branchPullRequest } from "../cloudLink/pullRequests.ts";
import { GitManager, type GitBranchPullRequest } from "../git/GitManager.ts";
import { makeBaseCi, sameBaseCi } from "./pullRequestCi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { git } from "./lifecycle.ts";
import { gitCheckoutsOf, severalSources, withCheckout } from "./sources.ts";
import { SessionStore, type WorkspaceRecord } from "./store.ts";

/** At most this many host lookups at once. */
const CONCURRENCY = 4;

/**
 * A lookup's answer as the protocol says it: a draft is its own state. The branch lookup reports no checks or review,
 * so the pill keeps the ones it has (`current`, from the linked pull request's sync) while it is the same pull request.
 */
export function pullRequestOf(found: GitBranchPullRequest | null, current?: PullRequest): PullRequest | undefined {
  if (!found) return undefined;
  const kept =
    current?.number === found.number
      ? { ...(current.checks ? { checks: current.checks } : {}), ...(current.review ? { review: current.review } : {}), ...(current.base_ci && current.checks === "failing" ? { base_ci: current.base_ci } : {}) }
      : {};
  return { number: found.number, url: found.url, state: found.state === "open" && found.isDraft ? "draft" : found.state, ...kept };
}

const REVIEW: Readonly<Record<string, NonNullable<PullRequest["review"]>>> = { approved: "approved", "changes-requested": "changes_requested", "review-required": "review_required" };

/** A thread's linked pull request, from its host snapshot (null until the first sync: nothing is known yet). */
export function pullRequestOfLink(link: ThreadPullRequestLink): PullRequest | undefined {
  const snapshot = link.snapshot;
  if (snapshot === null) return undefined;
  return {
    number: link.number,
    url: link.url,
    state: snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state,
    ...(snapshot.checksState ? { checks: snapshot.checksState } : {}),
    ...(snapshot.reviewDecision && REVIEW[snapshot.reviewDecision] ? { review: REVIEW[snapshot.reviewDecision]! } : {}),
  };
}

/**
 * The workspace after one of its thread's links synced: the pill takes the link when it is the chat's own pull request
 * (the one it created or linked as its own, or the one the pill already shows). A stack sibling or a pull request linked
 * by hand beside the chat's own leaves the pill alone.
 */
export function followLinkedPullRequest(workspace: Workspace, link: ThreadPullRequestLink): Workspace {
  const pr = pullRequestOfLink(link);
  if (pr === undefined) return workspace;
  const own = workspace.pull_request === undefined ? link.source === "created" || link.source === "agent" : workspace.pull_request.number === link.number;
  if (!own) return workspace;
  // The link knows nothing of the base's CI: its comparison (pullRequestCi.ts) stays while the same checks still fail.
  const current = workspace.pull_request;
  const next = current?.number === pr.number && current.base_ci && pr.checks === "failing" ? { ...pr, base_ci: current.base_ci } : pr;
  return samePullRequest(next, current) ? workspace : withPullRequest(workspace, next);
}

export function samePullRequest(a: PullRequest | undefined, b: PullRequest | undefined): boolean {
  return a?.number === b?.number && a?.state === b?.state && a?.url === b?.url && a?.checks === b?.checks && a?.review === b?.review && sameBaseCi(a?.base_ci, b?.base_ci);
}

/** The workspace carrying `pr`, or none: `updated_at` stays, so a pill appearing never reorders a list. */
export function withPullRequest(workspace: Workspace, pr: PullRequest | undefined): Workspace {
  const { pull_request: _old, ...rest } = workspace;
  return pr ? { ...rest, pull_request: pr } : rest;
}

type Unmerged = NonNullable<Workspace["unmerged"]>;

/** `git status --porcelain -z` entries (a rename carries its old path as a second field) and `rev-list --count`. */
export function unmergedOf(status: string, commits: string): Unmerged | undefined {
  const fields = status.split("\0");
  let files = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    files++;
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  const ahead = Number.parseInt(commits.trim(), 10);
  const counted = { files, commits: Number.isFinite(ahead) && ahead > 0 ? ahead : 0 };
  return counted.files + counted.commits === 0 ? undefined : counted;
}

const sameUnmerged = (a: Unmerged | undefined, b: Unmerged | undefined) => a?.files === b?.files && a?.commits === b?.commits;

/** The workspace carrying `unmerged`, or none; `updated_at` stays, like the pull request's pill. */
export function withUnmerged(workspace: Workspace, unmerged: Unmerged | undefined): Workspace {
  const { unmerged: _old, ...rest } = workspace;
  return unmerged ? { ...rest, unmerged } : rest;
}

export const runPullRequests = Effect.gen(function* () {
  const manager = yield* Effect.serviceOption(GitManager);
  const driver = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const computer = yield* CloudComputer;
  const link = yield* CloudLinkState;
  if (Option.isNone(manager) && computer === undefined) return;
  const store = yield* SessionStore;
  const credentials = yield* Effect.serviceOption(GitHubCredentials.GitHubCredentials);
  // Red checks against the base's (pullRequestCi.ts), on the person's own github.com sign-in.
  const baseCi = makeBaseCi({
    token: () =>
      Option.match(credentials, {
        onNone: () => Effect.succeed(undefined),
        onSome: (c) => c.get("github.com").pipe(Effect.map((credential) => Redacted.value(credential.token)), Effect.orElseSucceed(() => undefined)),
      }),
  });

  /** A pull request whose checks fail, with them set against its base's; any other as it is. */
  const comparedWithBase = (pr: PullRequest | undefined, found: GitBranchPullRequest | null) =>
    Effect.gen(function* () {
      if (pr === undefined || found === null) return pr;
      const { base_ci: kept, ...rest } = pr;
      if ((pr.state !== "open" && pr.state !== "draft") || pr.checks !== "failing") return rest;
      const compared = yield* baseCi({ url: pr.url, head: found.headSha ?? found.headRef, base: found.baseRef, previous: kept });
      // GitHub not answering keeps the last comparison; GitHub saying nothing fails here (a re-run under way) drops it.
      return compared === null ? pr : compared === undefined ? rest : { ...rest, base_ci: compared };
    });

 /** The branch's pull request: Cloud's answer on a Cloud computer, else the git host's through upstream lookup. */
  const find = (cwd: string, branch: string, refresh: boolean, current: PullRequest | undefined, repo?: string): Effect.Effect<PullRequest | undefined, unknown> => {
    if (computer !== undefined) {
      const identity = readIdentity(computer.linkDir);
      return identity === undefined ? Effect.fail(new Error("not linked to Caveman yet")) : Effect.tryPromise(() => branchPullRequest(identity, link, branch, repo));
    }
    return Option.isNone(manager)
      ? Effect.succeed(undefined)
      : manager.value.branchPullRequest({ cwd, branch }, { refresh }).pipe(Effect.flatMap((found) => comparedWithBase(pullRequestOf(found, current), found)));
  };

  /**
   * What the worktree holds that `base` does not; what the chat showed when git cannot say. Commits count against
   * origin's copy of the base when there is one (a local main is often far behind what landed), and a commit whose
   * patch is already there (rebased or cherry-picked in) does not count. A squash merge still counts: its merged
   * pull request says it landed.
   */
  const unmergedIn = (cwd: string, base: string, current: Unmerged | undefined): Effect.Effect<Unmerged | undefined> => {
    if (Option.isNone(driver) || !base) return Effect.succeed(current);
    const run = (args: ReadonlyArray<string>, allowNonZeroExit = false) => git(driver.value, cwd, args, { allowNonZeroExit });
    const remote = base.startsWith("origin/") ? base : `origin/${base}`;
    const ahead = run(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`], true).pipe(
      Effect.flatMap((found) => run(["rev-list", "--count", "--cherry-pick", "--right-only", "--no-merges", `${found.exitCode === 0 ? remote : base}...HEAD`])),
    );
    return Effect.all([run(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]), ahead], { concurrency: 2 }).pipe(
      Effect.map(([status, commits]) => unmergedOf(status.stdout, commits.stdout)),
      Effect.catchCause((cause) => Effect.logDebug(`Unmerged lookup in ${cwd} failed`, cause).pipe(Effect.as(current))),
    );
  };

  const lookUp = (record: WorkspaceRecord, refresh: boolean) =>
    Effect.gen(function* () {
      const cwd = record.internal.worktreePath;
      const { workspace } = record;
      if (!cwd || !workspace.branch || workspace.kind !== undefined || workspace.status === "archived" || !fs.existsSync(cwd)) return;
      if (severalSources(record)) {
        // A chat in several sources: each source's own branch, in its own worktree; the primary's on the workspace
        // itself, each other's on its checkout.
        const changes: Array<{ readonly name: string; readonly primary: boolean; readonly pr: PullRequest | undefined; readonly unmerged: Unmerged | undefined }> = [];
        for (const checkout of gitCheckoutsOf(record)) {
          if (!checkout.branch || !fs.existsSync(checkout.worktreePath)) continue;
          const shown = checkout.primary ? workspace : workspace.checkouts?.find((one) => one.name === checkout.name);
          const unmerged = yield* unmergedIn(checkout.worktreePath, checkout.baseRef, shown?.unmerged);
          const pr = yield* find(checkout.worktreePath, checkout.branch, refresh, shown?.pull_request, checkout.primary ? undefined : checkout.repository?.full_name).pipe(
            Effect.catchCause((cause) => Effect.logDebug(`Pull request lookup for ${workspace.id} (${checkout.name}) failed`, cause).pipe(Effect.as(shown?.pull_request))),
          );
          if (!samePullRequest(pr, shown?.pull_request) || !sameUnmerged(unmerged, shown?.unmerged)) changes.push({ name: checkout.name, primary: checkout.primary, pr, unmerged });
        }
        if (changes.length === 0) return;
        yield* store.append(record.session.id, (current) =>
          Effect.succeed({
            events: [],
            value: undefined,
            record: {
              ...current,
              workspace: changes.reduce(
                (shown, change) =>
                  change.primary
                    ? withUnmerged(withPullRequest(shown, change.pr), change.unmerged)
                    : withCheckout(shown, change.name, ({ pull_request: _pr, unmerged: _unmerged, ...rest }) => ({ ...rest, ...(change.pr ? { pull_request: change.pr } : {}), ...(change.unmerged ? { unmerged: change.unmerged } : {}) })),
                current.workspace,
              ),
            },
          }),
        );
        const next = yield* store.getBySession(record.session.id);
        if (next) yield* store.publishWorkspace(next.workspace);
        return;
      }
      const unmerged = yield* unmergedIn(cwd, workspace.base_ref, workspace.unmerged);
      const pr = yield* find(cwd, workspace.branch, refresh, workspace.pull_request).pipe(
        // A failed host lookup keeps the pill; GitManager backs the branch off before asking again.
        Effect.catchCause((cause) => Effect.logDebug(`Pull request lookup for ${workspace.id} failed`, cause).pipe(Effect.as(workspace.pull_request))),
      );
      if (samePullRequest(pr, workspace.pull_request) && sameUnmerged(unmerged, workspace.unmerged)) return;
      yield* store.append(record.session.id, (current) =>
        Effect.succeed({ events: [], value: undefined, record: { ...current, workspace: withUnmerged(withPullRequest(current.workspace, pr), unmerged) } }),
      );
      const next = yield* store.getBySession(record.session.id);
      if (next) yield* store.publishWorkspace(next.workspace);
    }).pipe(
      // Anything else that fails keeps what the chat last showed.
      Effect.catchCause((cause) => Effect.logDebug(`Branch lookup for ${record.workspace.id} failed`, cause)),
    );

  // Checks that just turned red (the linked pull request's sync) are set against the base's at once, not a minute on,
  // so the board never flags a pull request for its base's failures in between.
  const published = yield* PubSub.subscribe(store.workspaceChanges);
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(published).pipe(
        Effect.flatMap((workspace) =>
          workspace.pull_request?.checks === "failing" && workspace.pull_request.base_ci === undefined
            ? store.getWorkspace(workspace.id).pipe(Effect.flatMap((record) => (record ? lookUp(record, false) : Effect.void)))
            : Effect.void,
        ),
      ),
    ),
  );

  // Subscribed before the sweep starts, so no turn that ends from here on is missed.
  const events = yield* PubSub.subscribe(store.events);
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(events).pipe(
        Effect.flatMap((event) =>
          event.type === "turn.done" ? store.getBySession(event.session_id).pipe(Effect.flatMap((record) => (record ? lookUp(record, true) : Effect.void))) : Effect.void,
        ),
      ),
    ),
  );

  yield* store.listWorkspaces().pipe(
    Effect.flatMap((records) => Effect.forEach(records, (record) => lookUp(record, false), { concurrency: CONCURRENCY, discard: true })),
    Effect.repeat(Schedule.spaced("1 minute")),
  );
});
