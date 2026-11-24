// A pull request's red CI against its base's, and the re-run, over a fake GitHub.
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import {
  actionsRunOf,
  compareWithBase,
  githubRepoOf,
  makeBaseCi,
  onlyBaseFailing,
  rerunFailed,
} from "./pullRequestCi.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

/** GitHub's CI per ref: the failing check names (empty: all green), counting each read. */
function github(ci: Record<string, ReadonlyArray<string>>) {
  const reads: string[] = [];
  const fake = (async (url: string) => {
    const m = /\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/(status|check-runs)/.exec(url)!;
    const ref = decodeURIComponent(m[1]!);
    if (m[2] === "status") return new Response(JSON.stringify({ statuses: [] }));
    reads.push(ref);
    const failing = ci[ref] ?? [];
    const runs = [
      { name: "build", status: "completed", conclusion: "success" },
      ...failing.map((name) => ({ name, status: "completed", conclusion: "failure" })),
    ];
    return new Response(JSON.stringify({ check_runs: runs }));
  }) as typeof fetch;
  return { fake, reads };
}

describe("compareWithBase", () => {
  test("a check counts as the base's when it fails there too, or did last time against the same base", () => {
    const red = { failing: ["test", "e2e"], state: "failing" } as const;
    expect(compareWithBase({ failing: ["test"] }, red, "main")).toEqual({
      base: "main",
      failing: ["test"],
      on_base: ["test"],
      base_state: "failing",
    });
    expect(compareWithBase({ failing: ["test", "lint"] }, red, "main")?.on_base).toEqual(["test"]);
    // Main went green since: the failure this run saw was still main's, until it is run again here.
    const before = compareWithBase({ failing: ["test"] }, red, "main");
    const green = { failing: [], state: "passing" } as const;
    expect(compareWithBase({ failing: ["test"] }, green, "main", before)).toEqual({
      base: "main",
      failing: ["test"],
      on_base: ["test"],
      base_state: "passing",
    });
    // Against another base, the memory doesn't count.
    expect(compareWithBase({ failing: ["test"] }, green, "release", before)?.on_base).toEqual([]);
    // Nothing failing here: nothing to compare.
    expect(compareWithBase({ failing: [] }, red, "main")).toBeUndefined();
  });

  test("only-base failing means every failing check is the base's", () => {
    expect(
      onlyBaseFailing({
        base: "main",
        failing: ["a", "b"],
        on_base: ["a", "b"],
        base_state: "failing",
      }),
    ).toBe(true);
    expect(
      onlyBaseFailing({ base: "main", failing: ["a", "b"], on_base: ["a"], base_state: "failing" }),
    ).toBe(false);
    expect(onlyBaseFailing(undefined)).toBe(false);
  });

  test("a pull request is GitHub's when its url says so, and an Actions run is read from its check's page", () => {
    expect(githubRepoOf("https://github.com/caveman-ai/caveman-code")).toBe(
      "caveman-ai/caveman-code",
    );
    expect(githubRepoOf("https://gitlab.com/a/b/-/merge_requests/3")).toBeUndefined();
    expect(actionsRunOf("https://github.com/o/r/actions/runs/42071020228/job/9")).toBe(
      "42071020228",
    );
    expect(actionsRunOf("https://ci.example.com/build/9")).toBeUndefined();
  });
});

describe("makeBaseCi", () => {
  test("ten red pull requests into main read main once, and each head once, within the cache's life", async () => {
    const gh = github({ main: ["test"], [HEAD]: ["test"], [OTHER]: ["test", "lint"] });
    let now = 0;
    const compare = makeBaseCi({
      token: () => Effect.succeed("t"),
      fetch: gh.fake,
      now: () => now,
    });
    const run = (head: string) =>
      Effect.runPromise(compare({ url: "https://github.com/o/r/pull/1", head, base: "main" }));
    expect(await run(HEAD)).toMatchObject({
      failing: ["test"],
      on_base: ["test"],
      base_state: "failing",
    });
    expect(await run(OTHER)).toMatchObject({ failing: ["test", "lint"], on_base: ["test"] });
    expect(await run(HEAD)).toMatchObject({ on_base: ["test"] });
    expect(gh.reads.filter((r) => r === "main")).toHaveLength(1);
    expect(gh.reads.filter((r) => r === HEAD)).toHaveLength(1);
    // Past its life, main is read again.
    now = 3 * 60_000;
    await run(HEAD);
    expect(gh.reads.filter((r) => r === "main")).toHaveLength(2);
  });

  test("no sign-in, or another host: null, never a guess", async () => {
    const gh = github({});
    const none = makeBaseCi({ token: () => Effect.succeed(undefined), fetch: gh.fake });
    expect(
      await Effect.runPromise(
        none({ url: "https://github.com/o/r/pull/1", head: HEAD, base: "main" }),
      ),
    ).toBeNull();
    const some = makeBaseCi({ token: () => Effect.succeed("t"), fetch: gh.fake });
    expect(
      await Effect.runPromise(
        some({ url: "https://gitlab.com/o/r/-/merge_requests/1", head: HEAD, base: "main" }),
      ),
    ).toBeNull();
    // GitHub shows nothing failing on the head (a re-run under way): no comparison.
    expect(
      await Effect.runPromise(
        some({ url: "https://github.com/o/r/pull/1", head: HEAD, base: "main" }),
      ),
    ).toBeUndefined();
    expect(gh.reads).toEqual([HEAD, "main"]);
  });
});

describe("rerunFailed", () => {
  const actions = (
    runs: ReadonlyArray<{ conclusion: string; details_url: string }>,
    refuse = false,
  ) => {
    const posted: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(url);
        return new Response(null, { status: refuse ? 403 : 201 });
      }
      if (/\/pulls\/7$/.test(url)) return new Response(JSON.stringify({ head: { sha: HEAD } }));
      if (url.includes(`/commits/${HEAD}/check-runs`))
        return new Response(JSON.stringify({ check_runs: runs }));
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    return { fake, posted };
  };

  test("each failed Actions run on the head has its failed jobs run again, once", async () => {
    const gh = actions([
      { conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/11/job/1" },
      { conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/11/job/2" },
      { conclusion: "timed_out", details_url: "https://github.com/o/r/actions/runs/12/job/3" },
      { conclusion: "success", details_url: "https://github.com/o/r/actions/runs/13/job/4" },
    ]);
    expect(
      await Effect.runPromise(rerunFailed({ repo: "o/r", number: 7, token: "t", fetch: gh.fake })),
    ).toBe(2);
    expect(gh.posted).toEqual([
      "https://api.github.com/repos/o/r/actions/runs/11/rerun-failed-jobs",
      "https://api.github.com/repos/o/r/actions/runs/12/rerun-failed-jobs",
    ]);
  });

  test("nothing re-runnable, no sign-in or a refusal says so", async () => {
    const outside = actions([{ conclusion: "failure", details_url: "https://ci.example.com/b/1" }]);
    await expect(
      Effect.runPromise(rerunFailed({ repo: "o/r", number: 7, token: "t", fetch: outside.fake })),
    ).rejects.toThrow("no failed GitHub Actions run");
    await expect(
      Effect.runPromise(
        rerunFailed({ repo: "o/r", number: 7, token: undefined, fetch: outside.fake }),
      ),
    ).rejects.toThrow("Sign in to GitHub");
    const refused = actions(
      [{ conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/11/job/1" }],
      true,
    );
    await expect(
      Effect.runPromise(rerunFailed({ repo: "o/r", number: 7, token: "t", fetch: refused.fake })),
    ).rejects.toThrow("refused");
  });
});
