// Test-only: Cloud's pull request routes for a Cloud computer's own chats (CONTRACT 2026-10-21 §4), beside the
// automation route testCloud.ts already serves (`POST /runtime/pull-requests`, which opens one per head). GitHub is
// the git proxy's bare repositories when the test Cloud has them (`gitBackend`): a pull request's head is its
// `refs/pull/N/head` there, and update-head moves the pull request's own branch as the App would, refusing what
// Cloud refuses (a fork it may not write, a head that moved, anything but a fast-forward).
import { spawnSync } from "node:child_process";

export interface TestPull {
  readonly repo: string;
  readonly title: string;
  readonly base: string;
  readonly head_ref: string;
  head_sha: string;
  readonly head_repo: string;
  readonly is_fork: boolean;
  readonly maintainer_can_modify: boolean;
  state: "open" | "closed" | "merged" | "draft";
}

export function pullsState() {
  return {
    /** Pull requests on GitHub, by number. */
    byNumber: new Map<number, TestPull>(),
    /** Every pull-request-info call, as asked. */
    infoCalls: [] as Array<{ session_id: string; number: number }>,
    /** Sessions a pull request route was asked about that Cloud did not know on that computer (refused 404). */
    unknownSessions: [] as Array<string>,
    /** Every update-head call, as asked, and whether it moved the head. */
    updateHeads: [] as Array<{ number: number; session_id: string; sha: string; expected_head_sha: string; moved: boolean }>,
  };
}
export type PullsState = ReturnType<typeof pullsState>;

const gitIn = (dir: string, args: ReadonlyArray<string>) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

/**
 * `POST /runtime/pull-request-info` and `POST /runtime/pull-requests/{n}/update-head`; false for any other route. As
 * Cloud does, both act only for a session it knows on the calling runtime's computer (`knownSession`).
 */
export function pullRoutes(
  st: PullsState,
  input: {
    readonly method: string;
    readonly url: URL;
    readonly body: Record<string, unknown>;
    readonly runtime: boolean;
    readonly gitBackend: string | undefined;
    readonly knownSession: (sessionId: string) => boolean;
  },
  reply: (status: number, body: unknown) => void,
): boolean {
  const route = input.url.pathname.slice("/api/v1/code/runtime/".length);
  const update = /^pull-requests\/([0-9]+)\/update-head$/.exec(route);
  if (input.method !== "POST" || (route !== "pull-request-info" && update === null)) return false;
  if (!input.runtime) return (reply(401, { error: { code: "cave_unauthorized", message: "cave_unauthorized" } }), true);
  const refuse = (status: number, code: string, message: string) => (reply(status, { error: { code, message } }), true);
  if (!input.knownSession(String(input.body.session_id ?? ""))) {
    st.unknownSessions.push(String(input.body.session_id ?? ""));
    return refuse(404, "cave_not_found", "Session not found.");
  }
  if (route === "pull-request-info") {
    const number = Number(input.body.number);
    st.infoCalls.push({ session_id: String(input.body.session_id ?? ""), number });
    const pr = st.byNumber.get(number);
    if (pr === undefined) return refuse(404, "cave_not_found", `No pull request #${number}.`);
    return (
      reply(200, {
        number,
        title: pr.title,
        url: `https://github.com/${pr.repo}/pull/${number}`,
        state: pr.state,
        base: pr.base,
        head_ref: pr.head_ref,
        head_sha: pr.head_sha,
        head_repo: pr.head_repo,
        is_fork: pr.is_fork,
        maintainer_can_modify: pr.maintainer_can_modify,
      }),
      true
    );
  }
  const number = Number(update![1]);
  const pr = st.byNumber.get(number);
  const asked = { number, session_id: String(input.body.session_id ?? ""), sha: String(input.body.sha ?? ""), expected_head_sha: String(input.body.expected_head_sha ?? "") };
  const record = (moved: boolean) => st.updateHeads.push({ ...asked, moved });
  if (pr === undefined) return (record(false), refuse(404, "cave_not_found", `No pull request #${number}.`));
  if (pr.is_fork && !pr.maintainer_can_modify) return (record(false), refuse(403, "cave_code_pull_request_fork", "This pull request comes from a fork Caveman Cloud cannot write to."));
  // Already there: a retry after the head moved.
  if (asked.sha === pr.head_sha) return (record(false), reply(200, { number, head_sha: pr.head_sha }), true);
  if (asked.expected_head_sha !== pr.head_sha) return (record(false), refuse(409, "cave_code_pull_request_head_moved", `#${number}'s branch moved on GitHub since this chat fetched it.`));
  if (input.gitBackend !== undefined) {
    const bare = `${input.gitBackend}/${pr.repo}.git`;
    if (gitIn(bare, ["cat-file", "-e", `${asked.sha}^{commit}`]).status !== 0) return (record(false), refuse(422, "cave_code_head_missing", `${asked.sha} is not on GitHub.`));
    if (gitIn(bare, ["merge-base", "--is-ancestor", pr.head_sha, asked.sha]).status !== 0) return (record(false), refuse(409, "cave_code_pull_request_not_fast_forward", "Not a fast-forward of the pull request's branch."));
    gitIn(bare, ["update-ref", `refs/heads/${pr.head_ref}`, asked.sha]);
    gitIn(bare, ["update-ref", `refs/pull/${number}/head`, asked.sha]);
  }
  pr.head_sha = asked.sha;
  record(true);
  return (reply(200, { number, head_sha: asked.sha }), true);
}
