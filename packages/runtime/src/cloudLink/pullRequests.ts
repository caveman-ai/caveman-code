// A Cloud computer's pull requests (DESIGN 2026-10-21 S9, CONTRACT §3/§4). Nothing on a computer holds a GitHub
// credential: the tools container has no login, and git reaches GitHub only through Cloud's git proxy, which takes
// pushes to caveman/* branches. So the runtime asks Cloud, with the computer's own link identity (never a
// person's), and Cloud acts as the repository's GitHub App after checking that the chat's person has push access:
// open (or update) a pull request, read one to start a chat on it, move a pull request's own branch to what the
// chat pushed, and say which pull request a branch has, for the sidebar's pill.
import type { PullRequest } from "@caveman-app/session-protocol";

import { call } from "./computers.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

const STATES = new Set<PullRequest["state"]>(["open", "draft", "merged", "closed"]);

/**
 * Cloud's word for a branch's checks on its head commit (Caveman Cloud `BranchPullRequest.checks`: what the App's
 * check deliveries, or its own read of the head's check suites, add up to) as the protocol says it. "none" and
 * anything else say nothing: the pill shows no checks, as on a Mac before the first sync.
 */
const CHECKS = new Map<string, NonNullable<PullRequest["checks"]>>([["pass", "passing"], ["fail", "failing"], ["pending", "pending"]]);

/**
 * Cloud's answer as the protocol says a pull request: number, url and state (a draft is its own state), and its
 * checks when Cloud names them. A Cloud computer holds no GitHub login to read them with itself, so this is where a
 * chat there learns its pull request went red or green.
 */
export function pullRequestFrom(answer: unknown, draft = false): PullRequest | undefined {
  if (answer === null || typeof answer !== "object") return undefined;
  const a = answer as { number?: unknown; url?: unknown; html_url?: unknown; state?: unknown; draft?: unknown; merged?: unknown; checks?: unknown };
  const number = typeof a.number === "number" ? a.number : typeof a.number === "string" && /^[1-9][0-9]*$/.test(a.number) ? Number(a.number) : undefined;
  const url = typeof a.url === "string" && a.url !== "" ? a.url : typeof a.html_url === "string" ? a.html_url : undefined;
  if (number === undefined || url === undefined) return undefined;
  const said = typeof a.state === "string" ? a.state.toLowerCase() : "open";
  const state: PullRequest["state"] =
    a.merged === true ? "merged" : said === "open" && (a.draft === true || draft) ? "draft" : STATES.has(said as PullRequest["state"]) ? (said as PullRequest["state"]) : "open";
  const checks = typeof a.checks === "string" ? CHECKS.get(a.checks) : undefined;
  return { number, url, state, ...(checks === undefined ? {} : { checks }) };
}

export interface OpenPullRequest {
  readonly session_id: string;
  /** `owner/name`; Cloud checks it is the bound repository of the session's workspace on this computer. */
  readonly repo: string;
  /** A `caveman/*` branch already pushed through the git proxy. */
  readonly head: string;
  readonly base: string;
  readonly sha: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  /** The request id that asked: a retry opens nothing twice. */
  readonly idempotency_key: string;
}

/** `POST /code/runtime/pull-requests`: opens the pull request, or updates the one this head already has. */
export async function openPullRequest(identity: Identity, state: LinkState, input: OpenPullRequest, fetchImpl?: typeof fetch): Promise<PullRequest> {
  const answer = await call<unknown>(identity, state, "POST", "pull-requests", input, fetchImpl);
  const pr = pullRequestFrom(answer, input.draft);
  if (pr === undefined) throw new Error("Caveman opened the pull request but did not say which");
  return pr;
}

/**
 * `GET /code/runtime/pull-requests?branch=`: the pull request a branch of this computer's repository has, or none.
 * `repo` (owner/name): another repository one of this computer's workspaces checks out (CONTRACT §7); absent, the
 * request is what it was, for the computer's own.
 */
export async function branchPullRequest(identity: Identity, state: LinkState, branch: string, repo?: string, fetchImpl?: typeof fetch): Promise<PullRequest | undefined> {
  const answer = await call<{ pull_request?: unknown }>(identity, state, "GET", `pull-requests?branch=${encodeURIComponent(branch)}${repo === undefined ? "" : `&repo=${encodeURIComponent(repo)}`}`, undefined, fetchImpl);
  return pullRequestFrom(answer?.pull_request ?? null);
}

export interface PullRequestInfo {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly base: string;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly head_repo: string;
  readonly is_fork: boolean;
  readonly maintainer_can_modify: boolean;
}

/** `POST /code/runtime/pull-request-info`: a pull request of the session's repository, read by Cloud's App. */
export async function pullRequestInfo(identity: Identity, state: LinkState, input: { readonly session_id: string; readonly number: number }, fetchImpl?: typeof fetch): Promise<PullRequestInfo> {
  const a = await call<Partial<PullRequestInfo> | undefined>(identity, state, "POST", "pull-request-info", input, fetchImpl);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (a === undefined || typeof a.number !== "number" || text(a.head_sha) === "" || text(a.base) === "") throw new Error(`Caveman could not read pull request #${input.number}`);
  return {
    number: a.number,
    title: text(a.title),
    url: text(a.url),
    state: text(a.state) || "open",
    base: text(a.base),
    head_ref: text(a.head_ref),
    head_sha: text(a.head_sha),
    head_repo: text(a.head_repo),
    is_fork: a.is_fork === true,
    maintainer_can_modify: a.maintainer_can_modify === true,
  };
}

/**
 * `POST /code/runtime/pull-requests/{n}/update-head`: Cloud fast-forwards the pull request's own branch to `sha`,
 * which the chat pushed as its caveman/pr-N-* branch, only from `expected_head_sha`.
 */
export const updatePullRequestHead = (
  identity: Identity,
  state: LinkState,
  number: number,
  input: { readonly session_id: string; readonly sha: string; readonly expected_head_sha: string },
  fetchImpl?: typeof fetch,
) => call<unknown>(identity, state, "POST", `pull-requests/${number}/update-head`, input, fetchImpl);
