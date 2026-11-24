import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import { ciStatus } from "./environmentCi.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** GitHub as a table of routes: a body (200), a status number, or "throw" for a network error. */
function github(routes: { status?: unknown; checks?: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = href.includes("/check-runs") ? routes.checks : routes.status;
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    if (typeof answer === "number") return new Response("{}", { status: answer });
    return new Response(JSON.stringify(answer ?? {}), { status: 200 });
  }) as typeof fetch;
  return { fake, calls };
}

const run = (gh: ReturnType<typeof github>, options: { token?: string | undefined; repo?: string; commit?: string; timeoutMs?: number } = {}) =>
  Effect.runPromise(
    ciStatus({
      repo: options.repo ?? "acme/app",
      commit: options.commit ?? SHA,
      token: () => Effect.succeed("token" in options ? options.token : "ghs_test"),
      fetch: gh.fake,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
  );

const status = (...statuses: Array<[string, string, string?]>) => ({ sha: SHA, statuses: statuses.map(([context, state, target_url]) => ({ context, state, target_url })) });
const checks = (...runs: Array<[string, string, (string | null)?, string?]>) => ({
  check_runs: runs.map(([name, s, conclusion, html_url]) => ({ name, status: s, conclusion: conclusion ?? null, html_url })),
});

describe("ciStatus", () => {
  test("statuses and check runs merge: failing names both kinds, once each, and links the first", async () => {
    const gh = github({
      status: status(["ci/circleci: build", "error", "https://circleci.com/x"], ["vercel", "success"]),
      checks: checks(["test", "completed", "failure", "https://github.com/acme/app/runs/1"], ["lint", "completed", "timed_out"], ["test", "completed", "failure"], ["docs", "completed", "cancelled"]),
    });
    expect(await run(gh)).toEqual({ commit: SHA, state: "failing", failing: ["ci/circleci: build", "test", "lint"], url: "https://circleci.com/x" });
    // Both of GitHub's endpoints for the commit, with the token as a bearer.
    expect(gh.calls.map((c) => c.url).sort()).toEqual([
      `https://api.github.com/repos/acme/app/commits/${SHA}/check-runs?per_page=100`,
      `https://api.github.com/repos/acme/app/commits/${SHA}/status`,
    ]);
    expect(gh.calls[0]!.headers.authorization).toBe("Bearer ghs_test");
  });

  test("passing, pending and unknown", async () => {
    expect(await run(github({ status: status(["vercel", "success"]), checks: checks(["test", "completed", "success"], ["e2e", "completed", "skipped"]) }))).toEqual({
      commit: SHA,
      state: "passing",
      failing: [],
      url: `https://github.com/acme/app/commit/${SHA}`,
    });
    expect((await run(github({ status: status(), checks: checks(["test", "completed", "success"], ["build", "in_progress"]) })))?.state).toBe("pending");
    expect((await run(github({ status: status(["deploy", "pending"]), checks: checks() })))?.state).toBe("pending");
    // No CI at all, or only cancelled runs: GitHub says nothing either way.
    expect((await run(github({ status: status(), checks: checks() })))?.state).toBe("unknown");
    expect((await run(github({ status: status(), checks: checks(["test", "completed", "cancelled"]) })))?.state).toBe("unknown");
  });

  test("a token without the checks permission still reads the statuses", async () => {
    expect(await run(github({ status: status(["ci", "failure"]), checks: 403 }))).toMatchObject({ state: "failing", failing: ["ci"] });
    expect(await run(github({ status: 403, checks: checks(["test", "completed", "success"]) }))).toMatchObject({ state: "passing" });
  });

  test("no token, a 404, a network error, refusals or a hang: null, never an error", async () => {
    const quiet = github({ status: status(["ci", "success"]), checks: checks() });
    expect(await run(quiet, { token: undefined })).toBeNull();
    expect(quiet.calls).toEqual([]);
    expect(await run(github({ status: 404, checks: 404 }))).toBeNull();
    expect(await run(github({ status: status(["ci", "success"]), checks: 404 }))).toBeNull();
    expect(await run(github({ status: "throw", checks: "throw" }))).toBeNull();
    expect(await run(github({ status: 500, checks: 502 }))).toBeNull();
    const started = Date.now();
    expect(await run(github({ status: "hang", checks: "hang" }), { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    // A failing token lookup is no token.
    expect(await Effect.runPromise(ciStatus({ repo: "acme/app", commit: SHA, token: () => Effect.die(new Error("vault")), fetch: quiet.fake }))).toBeNull();
  });

  test("a repo or commit that isn't one never reaches GitHub", async () => {
    const gh = github({ status: status(["ci", "success"]) });
    for (const repo of ["acme/app/../../user", "../user", "acme/..", "acme"]) expect(await run(gh, { repo }), repo).toBeNull();
    expect(await run(gh, { commit: "HEAD" })).toBeNull();
    expect(gh.calls).toEqual([]);
  });
});
