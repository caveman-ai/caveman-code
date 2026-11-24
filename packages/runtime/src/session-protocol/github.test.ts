// github.status and github.issues over the runtime's real GitHub client and a fake GitHub (no network): the login's
// name from GET /user (kept a while), the project's open issues newest first without pull requests, every request
// carrying the login's own token (never this computer's gh one), and empty lists where there is nothing to read.
import * as SourceControlRateLimit from "@caveman-app/source-control-core/server/SourceControlRateLimit";
import * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@caveman-app/source-control-github/server/GitHubQuota";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, it } from "vitest";

import { CloudError } from "../cloudLink/identity.ts";
import type { GitHubLogin } from "../plugins/connectors.ts";
import type { ProjectRef } from "./environments.ts";
import { issueLimit, LOGIN_TTL_MS, makeGitHubHandlers, OUTSIDE_RECONNECT_TEXT, OUTSIDE_SCOPE_TEXT } from "./github.ts";
import { ProtocolError } from "./handlers.ts";

const CLOUD_TOKEN = ("gh" + "o_cloudlease0123456789");
const GH_TOKEN = "gho_thismacgh0123456789";
const ctx = { connectionId: "c1", principal: "local" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The handlers over the real GitHubApi and a fake GitHub (`respond`). This computer's gh holds GH_TOKEN, which no
 * request may carry: every one goes out with the login's own token.
 */
const handlersWith = async (
  respond: (url: URL) => Response,
  options: {
    login?: Effect.Effect<GitHubLogin, string>;
    connect?: Effect.Effect<string | undefined, ProtocolError>;
    projects?: Record<string, ProjectRef>;
    now?: () => number;
  } = {},
) => {
  const requests: Array<{ url: URL; authorization: string | undefined }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      requests.push({ url, authorization: request.headers.authorization });
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(url)));
    }),
  );
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) => Effect.succeed({ host, token: Redacted.make(GH_TOKEN), source: "gh" as const, fingerprint: `${host}:gh` }),
      invalidate: () => Effect.void,
    }),
  );
  const layer = GitHubApi.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  const api = await Effect.runPromise(Effect.gen(function* () {
    return yield* GitHubApi.GitHubApi;
  }).pipe(Effect.provide(layer)));
  const handlers = makeGitHubHandlers({
    login: options.login ?? Effect.succeed({ token: Redacted.make(CLOUD_TOKEN), source: "cloud" }),
    connect: options.connect ?? Effect.succeed(undefined),
    api,
    project: (id) => Effect.succeed(options.projects?.[id]),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { handlers, requests };
};

const widget: ProjectRef = {
  id: "caveman-repo:widget",
  path: "/code/widget",
  repository: { host: "github.com", full_name: "acme/widget", web_url: "https://github.com/acme/widget", clone_url: "https://github.com/acme/widget.git" },
};

it("github.status names the login's GitHub user, from the login's own token, and asks GitHub again only once the name is old", async () => {
  let clock = 1_000_000;
  const { handlers, requests } = await handlersWith(() => json({ login: "Octocat", id: 1 }), { now: () => clock });

  const first = await Effect.runPromise(handlers["github.status"]({}, ctx));
  const again = await Effect.runPromise(handlers["github.status"]({}, ctx));
  expect(first).toEqual({ login: "Octocat", source: "cloud" });
  expect(again).toEqual(first);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.href).toBe("https://api.github.com/user");
  expect(requests[0]!.authorization).toBe(`Bearer ${CLOUD_TOKEN}`);

  clock += LOGIN_TTL_MS + 1;
  await Effect.runPromise(handlers["github.status"]({}, ctx));
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(first)).not.toContain(CLOUD_TOKEN);
});

it("github.status without a login says what to do, and one GitHub refuses says so by where it came from", async () => {
  const none = await handlersWith(() => json({}), { login: Effect.fail("Run `gh auth login` in a terminal, or connect GitHub through Caveman.") });
  expect(await Effect.runPromise(none.handlers["github.status"]({}, ctx))).toEqual({
    login: null,
    source: null,
    problem: "Run `gh auth login` in a terminal, or connect GitHub through Caveman.",
  });
  expect(none.requests).toHaveLength(0);

  const refused = await handlersWith(() => json({ message: "Bad credentials" }, 401), {
    login: Effect.succeed({ token: Redacted.make("gho_revoked0123456789"), source: "gh" }),
  });
  expect(await Effect.runPromise(refused.handlers["github.status"]({}, ctx))).toEqual({
    login: null,
    source: "gh",
    problem: "GitHub refused this computer's gh login: run `gh auth login` in a terminal.",
  });

  const env = await handlersWith(() => json({ login: "robot" }), { login: Effect.succeed({ token: Redacted.make("ghp_env0123456789"), source: "env" }) });
  expect(await Effect.runPromise(env.handlers["github.status"]({}, ctx))).toEqual({ login: "robot", source: "env" });
});

it("github.issues lists the repository's open issues newest first, leaves pull requests out, and marks the ones assigned to the login", async () => {
  const issues = [
    {
      number: 42,
      title: "Crash on save",
      html_url: "https://github.com/acme/widget/issues/42",
      created_at: "2026-10-25T10:00:00Z",
      labels: [{ name: "bug" }, { name: "good first issue" }],
      assignees: [{ login: "octocat" }],
    },
    { number: 41, title: "Bump deps", html_url: "https://github.com/acme/widget/pull/41", created_at: "2026-10-24T10:00:00Z", labels: [], pull_request: { url: "x" } },
    { number: 40, title: "Docs", html_url: "https://github.com/acme/widget/issues/40", created_at: "2026-10-23T10:00:00Z", labels: ["docs"], assignee: { login: "someone" }, assignees: [{ login: "someone" }] },
    { number: 39, title: "Old", html_url: "https://github.com/acme/widget/issues/39", created_at: "2026-10-22T10:00:00Z", labels: [] },
  ];
  const { handlers, requests } = await handlersWith((url) => (url.pathname === "/user" ? json({ login: "Octocat" }) : json(issues)), { projects: { [widget.id]: widget } });

  const out = await Effect.runPromise(handlers["github.issues"]({ project_id: widget.id, limit: 2 }, ctx));
  expect(out.issues).toEqual([
    { number: 42, title: "Crash on save", url: "https://github.com/acme/widget/issues/42", created_at: "2026-10-25T10:00:00Z", labels: ["bug", "good first issue"], assigned_to_me: true },
    { number: 40, title: "Docs", url: "https://github.com/acme/widget/issues/40", created_at: "2026-10-23T10:00:00Z", labels: ["docs"], assigned_to_me: false },
  ]);
  const list = requests.find((r) => r.url.pathname === "/repos/acme/widget/issues")!;
  expect(Object.fromEntries(list.url.searchParams)).toEqual({ state: "open", sort: "created", direction: "desc", per_page: "30" });
  expect(requests.every((r) => r.authorization === `Bearer ${CLOUD_TOKEN}`)).toBe(true);
  expect(JSON.stringify(out)).not.toContain(CLOUD_TOKEN);

  const all = await Effect.runPromise(handlers["github.issues"]({ project_id: widget.id }, ctx));
  expect(all.issues.map((i) => i.number)).toEqual([42, 40, 39]);
});

it("github.issues answers an empty list with no GitHub remote, no login, a repository GitHub hides, or issues turned off; an unknown project is not_found", async () => {
  const local: ProjectRef = { id: "caveman-repo:local", path: "/code/local" };
  const gitlab: ProjectRef = { ...widget, id: "caveman-repo:gitlab", repository: { ...widget.repository!, host: "gitlab.com" } };
  const projects = { [widget.id]: widget, [local.id]: local, [gitlab.id]: gitlab };

  const ok = await handlersWith(() => json([{ number: 1, title: "x", created_at: "2026-10-25T00:00:00Z", labels: [] }]), { projects });
  expect(await Effect.runPromise(ok.handlers["github.issues"]({ project_id: local.id }, ctx))).toEqual({ issues: [] });
  expect(await Effect.runPromise(ok.handlers["github.issues"]({ project_id: gitlab.id }, ctx))).toEqual({ issues: [] });
  expect(ok.requests).toHaveLength(0);
  const missing = await Effect.runPromise(Effect.flip(ok.handlers["github.issues"]({ project_id: "caveman-repo:nope" }, ctx)));
  expect(missing).toMatchObject({ reason: "not_found" });

  const noLogin = await handlersWith(() => json([]), { projects, login: Effect.fail("Run `gh auth login` in a terminal, or connect GitHub through Caveman.") });
  expect(await Effect.runPromise(noLogin.handlers["github.issues"]({ project_id: widget.id }, ctx))).toEqual({ issues: [] });
  expect(noLogin.requests).toHaveLength(0);

  const hidden = await handlersWith((url) => (url.pathname === "/user" ? json({ login: "octocat" }) : json({ message: "Not Found" }, 404)), { projects });
  expect(await Effect.runPromise(hidden.handlers["github.issues"]({ project_id: widget.id }, ctx))).toEqual({ issues: [] });

  const off = await handlersWith((url) => (url.pathname === "/user" ? json({ login: "octocat" }) : json({ message: "Issues are disabled for this repo" }, 410)), { projects });
  expect(await Effect.runPromise(off.handlers["github.issues"]({ project_id: widget.id }, ctx))).toEqual({ issues: [] });
});

// A Cloud computer whose person's sign-ins stay outside it: the login is a way through Cloud's connector proxy, with
// no token and no GitHub client here. `reads` stands where connectorProxy.ts githubApiGet does; that path against a
// Cloud is plugins/connectors.outside.test.ts.
const proxied = (answer: (path: string) => unknown, options: { now?: () => number } = {}) => {
  const paths: string[] = [];
  const login: GitHubLogin = {
    source: "cloud",
    proxy: {
      key: "cloud-proxy:runtime-1",
      get: async (path) => {
        paths.push(path);
        const out = answer(path);
        if (out instanceof Error) throw out;
        return { status: 200, body: JSON.stringify(out) };
      },
    },
  };
  const handlers = makeGitHubHandlers({
    login: Effect.succeed(login),
    connect: Effect.succeed(undefined),
    api: undefined,
    project: (id) => Effect.succeed(id === widget.id ? widget : undefined),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { handlers, paths };
};
const upstream = (status: number, retryAfterMs?: number) => new CloudError(status, `GitHub answered ${status}.`, "cave_code_upstream", retryAfterMs);

it("a login Cloud keeps outside the computer reads GitHub through Cloud's proxy: the name, kept a while, and the issues, with no token and no GitHub client", async () => {
  let clock = 1_000_000;
  const issues = [
    { number: 7, title: "Proxy me", html_url: "https://github.com/acme/widget/issues/7", created_at: "2026-11-01T10:00:00Z", labels: [{ name: "bug" }], assignees: [{ login: "octo-person" }] },
    { number: 6, title: "A pull request", created_at: "2026-10-31T10:00:00Z", labels: [], pull_request: { url: "x" } },
  ];
  const { handlers, paths } = proxied((path) => (path === "user" ? { login: "octo-person" } : issues), { now: () => clock });

  expect(await Effect.runPromise(handlers["github.status"]({}, ctx))).toEqual({ login: "octo-person", source: "cloud" });
  expect(await Effect.runPromise(handlers["github.status"]({}, ctx))).toEqual({ login: "octo-person", source: "cloud" });
  expect(paths).toEqual(["user"]);
  const out = await Effect.runPromise(handlers["github.issues"]({ project_id: widget.id }, ctx));
  expect(out.issues).toEqual([{ number: 7, title: "Proxy me", url: "https://github.com/acme/widget/issues/7", created_at: "2026-11-01T10:00:00Z", labels: ["bug"], assigned_to_me: true }]);
  // The same two reads GitHub's own client makes, as paths below the API's root.
  expect(paths).toEqual(["user", "repos/acme/widget/issues?state=open&sort=created&direction=desc&per_page=30"]);
  clock += LOGIN_TTL_MS + 1;
  await Effect.runPromise(handlers["github.status"]({}, ctx));
  expect(paths.filter((path) => path === "user")).toHaveLength(2);
});

it("the proxy's own refusals say what a person can do, and GitHub's own statuses read as they do from GitHub", async () => {
  const named = (rest: unknown) => (path: string) => (path === "user" ? { login: "octo-person" } : rest);

  // A repository the computer does not work in: Cloud's 403, in a sentence, as a state and not a failure.
  const scope = proxied(named(new CloudError(403, "not this computer's repository", "cave_code_github_scope")));
  expect(await Effect.runPromise(Effect.flip(scope.handlers["github.issues"]({ project_id: widget.id }, ctx)))).toMatchObject({
    reason: "invalid_state",
    message: OUTSIDE_SCOPE_TEXT,
    cloudCode: "cave_code_github_scope",
  });

  // GitHub no longer takes the sign-in Cloud holds (or it holds none): Cloud's 409, wherever it is read.
  const stale = proxied(() => new CloudError(409, "reconnect", "cave_code_connection_reconnect"));
  expect(await Effect.runPromise(stale.handlers["github.status"]({}, ctx))).toEqual({ login: null, source: "cloud", problem: OUTSIDE_RECONNECT_TEXT });
  expect(await Effect.runPromise(Effect.flip(stale.handlers["github.issues"]({ project_id: widget.id }, ctx)))).toMatchObject({
    reason: "invalid_state",
    message: OUTSIDE_RECONNECT_TEXT,
    cloudCode: "cave_code_connection_reconnect",
  });

  // GitHub's own answers behind Cloud's words: a hidden repository and issues turned off list nothing ...
  for (const status of [404, 410]) {
    const none = proxied(named(upstream(status)));
    expect(await Effect.runPromise(none.handlers["github.issues"]({ project_id: widget.id }, ctx))).toEqual({ issues: [] });
  }
  // ... a rate limit and anything else fail the list as GitHub's, and Cloud not reaching GitHub in Cloud's words.
  for (const failure of [upstream(429, 30_000), upstream(500)]) {
    const failed = proxied(named(failure));
    expect(await Effect.runPromise(Effect.flip(failed.handlers["github.issues"]({ project_id: widget.id }, ctx)))).toMatchObject({ reason: "internal", message: expect.stringContaining("GitHub did not list the issues") });
  }
  const unreachable = proxied(named(upstream(502)));
  expect(await Effect.runPromise(Effect.flip(unreachable.handlers["github.issues"]({ project_id: widget.id }, ctx)))).toMatchObject({ reason: "internal", message: "GitHub answered 502." });

  // No answer through Cloud at all (the network, a timeout): said as that, not as GitHub's.
  const down = proxied(() => new Error("fetch failed"));
  expect(await Effect.runPromise(down.handlers["github.status"]({}, ctx))).toEqual({ login: null, source: "cloud", problem: "Caveman did not answer for GitHub: fetch failed" });
});

it("github.connect answers Cloud's page; not signed in to Caveman it refuses in a sentence, and Cloud's refusal passes through", async () => {
  const page = "https://cloud.example.com/connect/github?state=abc";
  const signedIn = await handlersWith(() => json({}), { connect: Effect.succeed(page) });
  expect(await Effect.runPromise(signedIn.handlers["github.connect"]({ request_id: "r1" }, ctx))).toEqual({ url: page });
  expect(signedIn.requests).toHaveLength(0);

  const signedOut = await handlersWith(() => json({}));
  const refused = await Effect.runPromise(Effect.flip(signedOut.handlers["github.connect"]({ request_id: "r2" }, ctx)));
  expect(refused).toMatchObject({ reason: "invalid_state", message: "Sign in to Caveman first: GitHub connects through it." });

  const cloudSaidNo = new ProtocolError({ reason: "cloud_unauthorized", message: "Sign in to Caveman again" });
  const failing = await handlersWith(() => json({}), { connect: Effect.fail(cloudSaidNo) });
  expect(await Effect.runPromise(Effect.flip(failing.handlers["github.connect"]({ request_id: "r3" }, ctx)))).toBe(cloudSaidNo);
});

it("issueLimit keeps the limit between 1 and 30, 10 by default", () => {
  expect([issueLimit(undefined), issueLimit(0), issueLimit(5), issueLimit(99)]).toEqual([10, 1, 5, 30]);
});
