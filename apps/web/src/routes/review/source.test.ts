// Where the Review page reads from (source.ts): a browser window with no Mac reads Cloud's Review routes on the
// person's own session, in the shapes a runtime answers; a Mac's window and the desktop read This Mac as before.
import { expect, test } from "vitest";
import {
  CLOUD_DOES_NOT,
  cloudReviewClient,
  NO_REPOSITORY,
  reviewFrom,
  sourceTag,
} from "./source.ts";

test("a browser window reads Cloud unless it is on a Mac; the desktop (no web window) reads its own Mac", () => {
  expect(reviewFrom(null)).toBe("mac");
  expect(reviewFrom({ home: { kind: "mac", name: "Studio" } })).toBe("mac");
  expect(reviewFrom({ home: { kind: "cloud", name: "Cloud" } })).toBe("cloud");
  expect(reviewFrom({ home: null })).toBe("cloud");
});

function recorder() {
  const sent: Array<{ path: string; method: string; body: unknown }> = [];
  const request = async (path: string, init: RequestInit = {}) => {
    sent.push({
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({ prs: [], viewers: {}, errors: [], github: "connected", ok: true }),
      { status: 200 },
    );
  };
  return { sent, client: cloudReviewClient(request) };
}

test("each read and change the page makes goes to Cloud's Review route for that pull request", async () => {
  const { sent, client } = recorder();
  const pr = { project_id: "p-cloud", number: 7, repo: "acme/api", host: "github.com" };
  const call = client.call as unknown as (method: string, params?: unknown) => Promise<unknown>;
  await call("pr.list", { state: "open" });
  await call("pr.get", pr);
  await call("pr.diff", pr);
  await call("pr.discussion", pr);
  await call("pr.review", { ...pr, request_id: "r1", verdict: "approve" });
  await call("pr.review", {
    ...pr,
    request_id: "r2",
    verdict: "request_changes",
    body: "Split it.",
  });
  await call("pr.comment", { ...pr, request_id: "r3", body: "Nice." });
  await call("pr.comment", {
    ...pr,
    request_id: "r4",
    body: "Here?",
    path: "src/login.ts",
    line: 3,
    side: "new",
  });
  await call("pr.comment", { ...pr, request_id: "r5", body: "Thanks.", thread_id: "61" });
  await call("pr.merge", { ...pr, request_id: "r6", method: "squash", head_sha: "abc" });
  const base = "/api/v1/code/reviews/acme/api/7";
  expect(sent).toEqual([
    { path: "/api/v1/code/reviews", method: "GET", body: undefined },
    { path: base, method: "GET", body: undefined },
    { path: `${base}/diff`, method: "GET", body: undefined },
    { path: `${base}/discussion`, method: "GET", body: undefined },
    // The request id and the address stay here: Cloud's route names the pull request, and the person is the session's.
    { path: `${base}/review`, method: "POST", body: { verdict: "approve" } },
    {
      path: `${base}/review`,
      method: "POST",
      body: { verdict: "request_changes", body: "Split it." },
    },
    { path: `${base}/comments`, method: "POST", body: { body: "Nice." } },
    {
      path: `${base}/comments`,
      method: "POST",
      body: { body: "Here?", path: "src/login.ts", line: 3, side: "new" },
    },
    { path: `${base}/comments`, method: "POST", body: { body: "Thanks.", thread_id: "61" } },
    { path: `${base}/merge`, method: "POST", body: { method: "squash", head_sha: "abc" } },
  ]);
});

test("what Cloud does not do is refused without asking it, and a pull request with no repository is not guessed", async () => {
  const { sent, client } = recorder();
  const call = client.call as unknown as (method: string, params?: unknown) => Promise<unknown>;
  const pr = { project_id: "p", number: 7, repo: "acme/api" };
  for (const method of [
    "pr.guide",
    "pr.viewed",
    "pr.resolve",
    "pr.ready",
    "pr.rerun",
    "pr.file",
    "pr.symbol",
    "pr.post_guide",
    "turn.submit",
  ]) {
    await expect(call(method, pr)).rejects.toThrow(CLOUD_DOES_NOT);
  }
  await expect(call("pr.get", { project_id: "p", number: 7 })).rejects.toThrow(NO_REPOSITORY);
  expect(sent).toEqual([]);
});

test("Cloud's queue is cached apart from a Mac's", () => {
  expect(sourceTag(recorder().client)).toBe(":cloud");
  expect(sourceTag({ call: async () => ({}) } as never)).toBe("");
  expect(sourceTag(null)).toBe("");
});
