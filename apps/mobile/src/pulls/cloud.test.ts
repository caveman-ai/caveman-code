// The phone's seven calls to Cloud's Review routes (live/cloud.ts, CONTRACT §12), against a fetch that records what
// was asked: each call's route and method, the body it sends, the sign-in it sends it on, and what Cloud's refusals
// come back as.
import { describe, expect, it } from "vitest";

import { CloudError, phoneCloud, type SecretStore, SignedOut } from "../live/cloud";
import { detail, DIFF, PRS, TALK } from "./testing";

interface Asked {
  method: string;
  path: string;
  bearer: string | null;
  body: unknown;
}

/** Cloud's answers by "METHOD path"; anything else is 404. The person is signed in unless told otherwise. */
function cloudWith(answers: Record<string, { status?: number; body: unknown }>, signedIn = true) {
  const asked: Asked[] = [];
  const kept = new Map<string, string>(
    signedIn
      ? [
          [
            "caveman.cloud.session",
            JSON.stringify({
              access_token: "sign-in-token",
              refresh_token: "refresh",
              email: "ada@example.com",
            }),
          ],
        ]
      : [],
  );
  const secrets: SecretStore = {
    get: async (key) => kept.get(key) ?? null,
    set: async (key, value) => void kept.set(key, value),
    delete: async (key) => void kept.delete(key),
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    asked.push({
      method,
      path: url.pathname,
      bearer: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[`${method} ${url.pathname}`] ?? {
      status: 404,
      body: { error: { code: "cave_not_found", message: "cave_not_found" } },
    };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { cloud: phoneCloud({ url: "https://cloud.test", secrets, fetch: fetchImpl }), asked };
}

const PULL = "/api/v1/code/reviews/acme/api/7";

describe("reading", () => {
  it("lists what waits on the sign-in itself, never the relay's bearer", async () => {
    const { cloud, asked } = cloudWith({
      "GET /api/v1/code/reviews": {
        body: {
          prs: PRS,
          viewers: { "github.com": "ada" },
          errors: [
            {
              project_id: "p-mobile",
              repo: "acme/mobile",
              message: "Connect GitHub to see its pull requests.",
            },
          ],
          github: "connected",
        },
      },
    });
    const list = await cloud.reviews();
    expect(asked).toEqual([
      {
        method: "GET",
        path: "/api/v1/code/reviews",
        bearer: "Bearer sign-in-token",
        body: undefined,
      },
    ]);
    expect(list?.prs.map((pr) => pr.number)).toEqual([7, 12, 8, 31, 40]);
    expect(list?.errors).toEqual([
      { repo: "acme/mobile", message: "Connect GitHub to see its pull requests." },
    ]);
    expect(list?.github).toBe("connected");
    expect(list?.connect_url).toBeUndefined();
  });

  it("says GitHub is not connected, with where it connects", async () => {
    const { cloud } = cloudWith({
      "GET /api/v1/code/reviews": {
        body: {
          prs: [],
          viewers: {},
          errors: [],
          unavailable: "Connect GitHub to review pull requests here.",
          github: "not_connected",
          connect_url: "/cave-agent/code",
        },
      },
    });
    expect(await cloud.reviews()).toEqual({
      prs: [],
      errors: [],
      github: "not_connected",
      connect_url: "/cave-agent/code",
    });
  });

  it("lists nothing from a Cloud that keeps Review from this sign-in, or serves none", async () => {
    expect(
      await cloudWith({
        "GET /api/v1/code/reviews": {
          status: 403,
          body: {
            error: {
              code: "cave_agent_operation_forbidden",
              message: "cave_agent_operation_forbidden",
            },
          },
        },
      }).cloud.reviews(),
    ).toBeNull();
    expect(await cloudWith({}).cloud.reviews()).toBeNull();
  });

  it("leaves out a row it cannot name, and reads an answer with no list as an empty one", async () => {
    const { cloud } = cloudWith({
      "GET /api/v1/code/reviews": {
        body: {
          prs: [PRS[0], { title: "no number" }, null, "x"],
          errors: [{ repo: "acme/tv" }, 3],
        },
      },
    });
    const list = await cloud.reviews();
    expect(list?.prs.map((pr) => pr.number)).toEqual([7]);
    expect(list?.errors).toEqual([]);
    expect(
      (await cloudWith({ "GET /api/v1/code/reviews": { body: null } }).cloud.reviews())?.prs,
    ).toEqual([]);
  });

  it("reads one pull request by its repository and number", async () => {
    const { cloud, asked } = cloudWith({ [`GET ${PULL}`]: { body: detail() } });
    const pr = await cloud.pull("acme/api", 7);
    expect(asked).toEqual([
      { method: "GET", path: PULL, bearer: "Bearer sign-in-token", body: undefined },
    ]);
    expect(pr.title).toBe("Stop the login redirect loop");
    expect(pr.can).toEqual({
      merge: true,
      review: true,
      comment: true,
      merge_methods: ["squash", "merge"],
      ready: false,
    });
    expect(pr.checks_list.map((check) => check.name)).toEqual(["test", "lint", "typecheck"]);
  });

  it("offers nothing Cloud did not say the person may do", async () => {
    const { cloud } = cloudWith({
      [`GET ${PULL}`]: {
        body: {
          number: 7,
          title: "Bare",
          repo: "acme/api",
          state: "open",
          can: { merge: "yes", merge_methods: ["squash", "fast-forward"], ready: true },
        },
      },
    });
    const pr = await cloud.pull("acme/api", 7);
    expect(pr.can).toEqual({
      merge: false,
      review: false,
      comment: false,
      merge_methods: ["squash"],
      ready: false,
    });
    expect([pr.body, pr.mergeable, pr.checks_list, pr.files, pr.reviewers]).toEqual([
      "",
      "unknown",
      [],
      [],
      [],
    ]);
  });

  it("reads its patches and its discussion from their own routes", async () => {
    const { cloud, asked } = cloudWith({
      [`GET ${PULL}/diff`]: { body: { ...DIFF, files: [...DIFF.files, { path: "bin/logo.png" }] } },
      [`GET ${PULL}/discussion`]: { body: { items: [...TALK, { type: "guide" }] } },
    });
    const diff = await cloud.pullDiff("acme/api", 7);
    expect(diff.files.map((f) => f.path)).toEqual(["src/auth/login.ts"]);
    expect(diff.omitted).toEqual(["src/auth/next.ts"]);
    expect(diff.head_sha).toBe(DIFF.head_sha);
    expect((await cloud.pullDiscussion("acme/api", 7)).map((item) => item.id)).toEqual([
      "51",
      "review-91",
      "61",
    ]);
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual([
      `GET ${PULL}/diff`,
      `GET ${PULL}/discussion`,
    ]);
  });

  it("names a repository's owner and name each in its own part of the path", async () => {
    const { cloud, asked } = cloudWith({});
    await cloud.pull("acme co/api#1", 7).catch(() => undefined);
    expect(asked[0]?.path).toBe("/api/v1/code/reviews/acme%20co/api%231/7");
  });

  it("asks Cloud nothing for what names no pull request", async () => {
    const { cloud, asked } = cloudWith({});
    for (const [repo, number] of [
      ["api", 7],
      ["acme/api/extra", 7],
      ["acme/api", 0],
      ["acme/api", Number.NaN],
      ["/api", 7],
    ] as const) {
      await expect(cloud.pull(repo, number)).rejects.toMatchObject({
        name: "CloudError",
        status: 404,
      });
    }
    expect(asked).toEqual([]);
  });
});

describe("changing", () => {
  const ok = { body: { ok: true } };

  it("approves with no body", async () => {
    const { cloud, asked } = cloudWith({ [`POST ${PULL}/review`]: ok });
    await cloud.reviewPull("acme/api", 7, { verdict: "approve" });
    expect(asked).toEqual([
      {
        method: "POST",
        path: `${PULL}/review`,
        bearer: "Bearer sign-in-token",
        body: { verdict: "approve" },
      },
    ]);
  });

  it("asks for changes, and comments as a review, with what was said", async () => {
    const { cloud, asked } = cloudWith({ [`POST ${PULL}/review`]: ok });
    await cloud.reviewPull("acme/api", 7, {
      verdict: "request_changes",
      body: "Check the expiry first.",
    });
    await cloud.reviewPull("acme/api", 7, { verdict: "comment", body: "Reads well." });
    expect(asked.map((a) => a.body)).toEqual([
      { verdict: "request_changes", body: "Check the expiry first." },
      { verdict: "comment", body: "Reads well." },
    ]);
  });

  it("comments on the pull request, on a line of it, or in reply to a thread", async () => {
    const { cloud, asked } = cloudWith({ [`POST ${PULL}/comments`]: ok });
    await cloud.commentOnPull("acme/api", 7, { body: "Thanks." });
    await cloud.commentOnPull("acme/api", 7, {
      body: "Here.",
      path: "src/auth/login.ts",
      line: 14,
    });
    await cloud.commentOnPull("acme/api", 7, {
      body: "Was this.",
      path: "src/auth/login.ts",
      line: 11,
      side: "old",
    });
    await cloud.commentOnPull("acme/api", 7, { body: "Agreed.", thread_id: "61" });
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual(
      Array(4).fill(`POST ${PULL}/comments`),
    );
    expect(asked.map((a) => a.body)).toEqual([
      { body: "Thanks." },
      { body: "Here.", path: "src/auth/login.ts", line: 14 },
      { body: "Was this.", path: "src/auth/login.ts", line: 11, side: "old" },
      { body: "Agreed.", thread_id: "61" },
    ]);
  });

  it("merges by a method, with the head it was read at when it has one", async () => {
    const { cloud, asked } = cloudWith({ [`POST ${PULL}/merge`]: ok });
    await cloud.mergePull("acme/api", 7, { method: "squash", head_sha: "abc123" });
    await cloud.mergePull("acme/api", 7, { method: "rebase" });
    expect(asked.map((a) => [a.method, a.path, a.body])).toEqual([
      ["POST", `${PULL}/merge`, { method: "squash", head_sha: "abc123" }],
      ["POST", `${PULL}/merge`, { method: "rebase" }],
    ]);
  });
});

describe("refusals", () => {
  it("comes back as Cloud said it: GitHub's own words when GitHub refused", async () => {
    const { cloud } = cloudWith({
      [`POST ${PULL}/merge`]: {
        status: 409,
        body: {
          error: {
            code: "cave_code_github_refused",
            message: "At least 1 approving review is required.",
          },
        },
      },
    });
    const refused = await cloud
      .mergePull("acme/api", 7, { method: "squash" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CloudError);
    expect(refused).toMatchObject({
      status: 409,
      code: "cave_code_github_refused",
      message: "At least 1 approving review is required.",
    });
  });

  it("carries where GitHub connects when no link is kept for the repository", async () => {
    const { cloud } = cloudWith({
      [`GET ${PULL}`]: {
        status: 409,
        body: {
          error: {
            code: "cave_code_github_not_connected",
            message: "Connect GitHub to review pull requests here.",
            details: { connect_url: "/cave-agent/code" },
          },
        },
      },
    });
    await expect(cloud.pull("acme/api", 7)).rejects.toMatchObject({
      status: 409,
      code: "cave_code_github_not_connected",
      details: { connect_url: "/cave-agent/code" },
    });
  });

  it("is 404 for a pull request the person cannot see", async () => {
    await expect(cloudWith({}).cloud.pull("acme/api", 99)).rejects.toMatchObject({
      status: 404,
      code: "cave_not_found",
    });
    await expect(
      cloudWith({}).cloud.reviewPull("acme/api", 99, { verdict: "approve" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("asks nobody anything while nobody is signed in", async () => {
    const { cloud, asked } = cloudWith({}, false);
    await expect(cloud.reviews()).rejects.toBeInstanceOf(SignedOut);
    await expect(cloud.mergePull("acme/api", 7, { method: "squash" })).rejects.toBeInstanceOf(
      SignedOut,
    );
    expect(asked).toEqual([]);
  });
});
