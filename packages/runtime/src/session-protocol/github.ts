// github.status, github.issues and github.connect (docs/): GitHub as this runtime sees
// it, for first run's GitHub row and its "start from an issue" list, and connecting it to Caveman Cloud from there. The login is Connectors.github's: Caveman Cloud's lease of the
// person's GitHub login while signed in and connected there, else this computer's gh or GH_TOKEN. Every read goes
// through the runtime's GitHub client pinned to that login (PinnedGitHubCredential), so a request never carries
// another account's token. Only the login's name leaves the runtime; the token is never returned, logged or traced.
//
// On a Cloud computer whose person's sign-ins stay outside it there is no token to pin: the same two reads go through
// Cloud's connector proxy (cloudLink/connectorProxy.ts, CONTRACT §3.2), which attaches the login outside the computer
// and lets through only reads of the repositories Cloud placed on it. GitHub's own refusals arrive as their status
// with Cloud's words; the proxy's own say what a person can do.
import { createHash } from "node:crypto";

import type { GitHubIssue, Result } from "@caveman-app/session-protocol";
import * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { UPSTREAM, refusalText } from "../cloudLink/connectorProxy.ts";
import { onYourMac } from "../cloudLink/credentialRule.ts";
import { CloudError } from "../cloudLink/identity.ts";
import type { GitHubLogin } from "../plugins/connectors.ts";
import type { ProjectRef } from "./environments.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

const HOST = "github.com";
/** A login's name is kept this long per token, so a screen asking github.status again asks GitHub at most this often. */
export const LOGIN_TTL_MS = 5 * 60_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const TIMEOUT = "8 seconds";
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

export interface GitHubHandlerDeps {
  /** Connectors.github: the login, or what the person can do without one. */
  readonly login: Effect.Effect<GitHubLogin, string>;
  /** Connectors.connectGitHub: Cloud's page to connect GitHub there, undefined while not signed in to Caveman Cloud. */
  readonly connect: Effect.Effect<string | undefined, ProtocolError>;
  /** The runtime's GitHub client; without one nothing is read. */
  readonly api: GitHubApi.GitHubApi["Service"] | undefined;
  /** A project and its repository; undefined for no such project. */
  readonly project: (id: string) => Effect.Effect<ProjectRef | undefined>;
  readonly now?: () => number;
}

/** A read through Cloud's connector proxy that only its own words explain: the proxy's refusal, or no answer through it. */
export class ProxiedReadError {
  readonly _tag = "ProxiedReadError";
  readonly message: string;
  /** Cloud's code, when the proxy itself refused (`cave_code_github_scope`, `cave_code_connection_reconnect`). */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    this.message = message;
    this.code = code;
  }
}

/** GitHub's API reads on a Cloud computer are of the repositories it works in: what a read of any other says. */
export const OUTSIDE_SCOPE_TEXT = "Cloud reads GitHub only for this chat's repositories. Add the repository to the chat first.";
/** Cloud holds no GitHub sign-in that GitHub still takes (the proxy's 409): only the person's own device makes a new one. */
export const OUTSIDE_RECONNECT_TEXT = `GitHub's sign-in expired. Reconnect GitHub ${onYourMac()}.`;

/**
 * What a refused read through the proxy is, as the handlers read GitHub's own: GitHub's status behind Cloud's words
 * (`cave_code_upstream`) becomes the client's error of that status; anything else is the proxy's, in a sentence.
 */
export function proxiedFailure(cause: unknown, operation: string, now: number): GitHubApi.GitHubApiError | ProxiedReadError {
  const tags = { host: HOST, operation };
  if (!(cause instanceof CloudError)) return new ProxiedReadError(`Caveman did not answer for GitHub: ${cause instanceof Error ? cause.message : String(cause)}`);
  if (cause.code !== UPSTREAM) return new ProxiedReadError(cause.code === "cave_code_github_scope" ? OUTSIDE_SCOPE_TEXT : cause.code === "cave_code_connection_reconnect" ? OUTSIDE_RECONNECT_TEXT : refusalText(cause), cause.code);
  if (cause.status === 404) return new GitHubApi.GitHubApiNotFoundError(tags);
  if (cause.status === 429 || (cause.status === 403 && cause.retryAfterMs !== undefined)) {
    return new GitHubApi.GitHubApiRateLimitError({ ...tags, ...(cause.retryAfterMs === undefined ? {} : { retryAt: now + cause.retryAfterMs }) });
  }
  // 502: GitHub did not answer through Cloud, in Cloud's words. A failure, not a state of the person's: no code.
  if (cause.status === 502) return new ProxiedReadError(cause.message);
  return new GitHubApi.GitHubApiResponseError({ ...tags, status: cause.status });
}

/** What to do when GitHub itself refuses the login, by where it came from. */
const refused: Record<GitHubLogin["source"], string> = {
  cloud: "GitHub refused Caveman's GitHub login: connect GitHub again.",
  gh: "GitHub refused this computer's gh login: run `gh auth login` in a terminal.",
  env: "GitHub refused the GH_TOKEN this runtime runs with: replace it, or unset it and run `gh auth login`.",
};

/** The issues page asks for this many, since pull requests come back in the same list and are dropped. */
export const issuesPerPage = (limit: number) => Math.min(100, Math.max(30, limit * 3));

/** The `limit` asked for, as a whole number from 1 to 30; anything else is the default. */
export const issueLimit = (limit: number | undefined) =>
  limit === undefined || !Number.isFinite(limit) ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));

/** GitHub's open issues as the wire has them: pull requests (an issue with `pull_request`) left out, GitHub's order kept. */
export function issuesOf(body: unknown, fullName: string, me: string | undefined, limit: number): ReadonlyArray<GitHubIssue> {
  if (!Array.isArray(body)) return [];
  const mine = me?.toLowerCase();
  const loginOf = (user: unknown) => (typeof user === "object" && user !== null && typeof (user as { login?: unknown }).login === "string" ? (user as { login: string }).login.toLowerCase() : undefined);
  return body
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && item.pull_request === undefined && typeof item.number === "number")
    .slice(0, limit)
    .map((item) => ({
      number: item.number as number,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.html_url === "string" ? item.html_url : `https://${HOST}/${fullName}/issues/${item.number as number}`,
      created_at: typeof item.created_at === "string" ? item.created_at : "",
      labels: (Array.isArray(item.labels) ? item.labels : []).flatMap((label: unknown) =>
        typeof label === "string" ? [label] : typeof label === "object" && label !== null && typeof (label as { name?: unknown }).name === "string" ? [(label as { name: string }).name] : [],
      ),
      assigned_to_me:
        mine !== undefined && [...(Array.isArray(item.assignees) ? item.assignees : []), item.assignee].some((user) => loginOf(user) === mine),
    }));
}

export const makeGitHubHandlers = (
  deps: GitHubHandlerDeps,
): {
  readonly "github.status": Handler<"github.status">;
  readonly "github.issues": Handler<"github.issues">;
  readonly "github.connect": Handler<"github.connect">;
} => {
  const now = deps.now ?? Date.now;
  /** Login names by token fingerprint (never the token); a login read through Cloud's proxy has a key of its own and no token. */
  const names = new Map<string, { readonly name: string; readonly at: number }>();
  const fingerprintOf = (login: GitHubLogin) => ("proxy" in login ? `${HOST}:${login.proxy.key}` : `${HOST}:${createHash("sha256").update(Redacted.value(login.token)).digest("hex")}`);

  /**
   * One GET with this login and no other, whatever this computer's gh holds: through the runtime's GitHub client
   * pinned to the login's token, or, for a login Cloud keeps outside this computer, through Cloud's connector proxy.
   */
  const get = (api: GitHubApi.GitHubApi["Service"] | undefined, login: GitHubLogin, operation: string, path: string): Effect.Effect<{ readonly body: string }, GitHubApi.GitHubApiError | ProxiedReadError> => {
    if ("proxy" in login) {
      return Effect.tryPromise({ try: () => login.proxy.get(path), catch: (cause) => proxiedFailure(cause, operation, now()) });
    }
    if (api === undefined) return Effect.fail(new ProxiedReadError("This runtime has no GitHub client."));
    return api
      .rest({ host: HOST, operation, path, timeout: TIMEOUT })
      .pipe(Effect.provideService(GitHubApi.PinnedGitHubCredential, { host: HOST, token: login.token, credentialFingerprint: fingerprintOf(login) }));
  };

  /** The login's GitHub username (GET /user), kept LOGIN_TTL_MS; fails with what to do. */
  const nameOf = (login: GitHubLogin): Effect.Effect<string, string> => {
    const key = fingerprintOf(login);
    const kept = names.get(key);
    if (kept !== undefined && now() - kept.at < LOGIN_TTL_MS) return Effect.succeed(kept.name);
    return get(deps.api, login, "github.status", "user").pipe(
      Effect.mapError((error) => (error._tag === "GitHubApiAuthenticationError" ? refused[login.source] : error._tag === "ProxiedReadError" ? error.message : `GitHub did not answer: ${error.message}`)),
      Effect.flatMap((response) => {
        const name = Option.getOrUndefined(Option.liftThrowable(() => (JSON.parse(response.body) as { login?: unknown }).login)());
        return typeof name === "string" && name !== "" ? Effect.succeed(name) : Effect.fail("GitHub did not say which account the login is.");
      }),
      Effect.tap((name) => Effect.sync(() => names.set(key, { name, at: now() }))),
    );
  };

  return {
    "github.status": () =>
      deps.login.pipe(
        Effect.matchEffect({
          onFailure: (problem) => Effect.succeed<Result<"github.status">>({ login: null, source: null, problem }),
          onSuccess: (login) =>
            nameOf(login).pipe(
              Effect.match({
                onSuccess: (name): Result<"github.status"> => ({ login: name, source: login.source }),
                onFailure: (problem): Result<"github.status"> => ({ login: null, source: login.source, problem }),
              }),
            ),
        }),
      ),
    "github.connect": () =>
      deps.connect.pipe(
        Effect.flatMap((url) =>
          url === undefined
            ? Effect.fail(new ProtocolError({ reason: "invalid_state", message: "Sign in to Caveman first: GitHub connects through it." }))
            : Effect.succeed({ url }),
        ),
      ),
    "github.issues": (p) =>
      Effect.gen(function* () {
        const project = yield* deps.project(p.project_id);
        if (project === undefined) return yield* new ProtocolError({ reason: "not_found", message: `no project ${p.project_id}` });
        const repo = project.repository;
        const api = deps.api;
        // Not on github.com: nothing to list.
        if (repo?.host !== HOST || !FULL_NAME.test(repo.full_name)) return { issues: [] };
        const login = yield* Effect.option(deps.login);
        // No login, or one whose reads need a GitHub client this runtime does not have: nothing to list.
        if (Option.isNone(login) || (api === undefined && !("proxy" in login.value))) return { issues: [] };
        const limit = issueLimit(p.limit);
        const me = yield* nameOf(login.value).pipe(Effect.option, Effect.map(Option.getOrUndefined));
        const response = yield* get(
          api,
          login.value,
          "github.issues",
          `repos/${repo.full_name}/issues?state=open&sort=created&direction=desc&per_page=${issuesPerPage(limit)}`,
        ).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            // A login GitHub refuses is no login; a repository it cannot see (or one without issues) has none to list.
            GitHubApiAuthenticationError: () => Effect.succeed(Option.none()),
            GitHubApiNotFoundError: () => Effect.succeed(Option.none()),
            GitHubApiRateLimitError: (error) =>
              Effect.fail(
                new ProtocolError({
                  reason: "rate_limited",
                  message: "GitHub is rate limiting this login: try again in a few minutes.",
                  ...(error.retryAt === undefined ? {} : { retryAfterMs: Math.max(0, error.retryAt - now()) }),
                }),
              ),
          }),
          Effect.catch((error) =>
            // 410: the repository has issues turned off.
            error._tag === "GitHubApiResponseError" && error.status === 410
              ? Effect.succeed(Option.none())
              : error._tag === "ProxiedReadError"
                ? // Cloud's connector proxy said why, in words a person can act on (a repository this computer does not work in, GitHub to connect again).
                  Effect.fail(new ProtocolError({ reason: error.code === undefined ? "internal" : "invalid_state", message: error.message, ...(error.code === undefined ? {} : { cloudCode: error.code }) }))
                : Effect.fail(new ProtocolError({ reason: "internal", message: `GitHub did not list the issues: ${error.message}` })),
          ),
        );
        if (Option.isNone(response)) return { issues: [] };
        const body = Option.getOrUndefined(Option.liftThrowable(() => JSON.parse(response.value.body) as unknown)());
        return { issues: issuesOf(body, repo.full_name, me, limit) };
      }),
  };
};
