// The one predicate (credentialRule.ts): whether a person's credentials stay outside this computer, as Cloud says in
// `GET runtime`, and as its refusal of a credential route says later.
import * as path from "node:path";

import { afterEach, expect, test } from "vitest";

import { tempRoot } from "../session-protocol/testHarness.ts";
import { call } from "./computers.ts";
import { CredentialRule, OUTSIDE_COMPUTER, ruleOf } from "./credentialRule.ts";
import { askCredentialsOutside } from "./credentialsOutside.ts";
import { CloudError, enroll } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const refusal = (code = OUTSIDE_COMPUTER) => new CloudError(403, code, code);

test("a Mac's rule is never joined and never applies, whatever Cloud refuses", async () => {
  const rule = new CredentialRule();
  expect(rule.known()).toBe(false);
  expect(await rule.outside()).toBe(false);
  expect(rule.refusedBy(refusal())).toBe(true);
  expect(await rule.outside()).toBe(false);
});

test("a Cloud computer asks once, however many ask at once, and the answer stands", async () => {
  for (const answer of [true, false]) {
    const rule = new CredentialRule();
    let asks = 0;
    let fired = 0;
    rule.onOutside(() => fired++);
    rule.join(async () => {
      asks++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return answer;
    });
    expect(rule.known()).toBeUndefined();
    expect(await Promise.all([rule.outside(), rule.outside(), rule.outside()])).toEqual([
      answer,
      answer,
      answer,
    ]);
    expect(await rule.outside()).toBe(answer);
    expect([asks, rule.known(), fired]).toEqual([1, answer, answer ? 1 : 0]);
  }
});

test("while Cloud cannot say, nothing is guessed: the ask fails and is made again", async () => {
  const rule = new CredentialRule();
  let asks = 0;
  rule.join(async () => {
    if (++asks < 3) throw new CloudError(503, "unreachable");
    return true;
  });
  // The join's own ask failed, and so does the next caller's.
  await expect(rule.outside()).rejects.toThrow("unreachable");
  await expect(rule.outside()).rejects.toThrow("unreachable");
  expect(rule.known()).toBeUndefined();
  expect(await rule.outside()).toBe(true);
});

test("Cloud refusing a credential route with the rule's code turns the rule on, once, for good", async () => {
  const rule = new CredentialRule();
  rule.join(async () => false);
  expect(await rule.outside()).toBe(false);
  let fired = 0;
  rule.onOutside(() => fired++);
  // Another 403 (a shared computer, a disabled account) says nothing of the rule.
  expect(rule.refusedBy(refusal("cave_code_computer_shared"))).toBe(false);
  expect(rule.refusedBy(new Error("boom"))).toBe(false);
  expect(rule.known()).toBe(false);
  expect(rule.refusedBy(refusal())).toBe(true);
  expect(rule.refusedBy(refusal())).toBe(true);
  expect([await rule.outside(), rule.known(), fired]).toEqual([true, true, 1]);
  // A listener that comes later hears it at once.
  rule.onOutside(() => fired++);
  expect(fired).toBe(2);
});

test("GET runtime: true only when Cloud says so; a Cloud from before the rule, or one without the route, is no; and any call's refusal teaches the rule", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("credential-rule-"), "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "computer",
  });
  const link: LinkState = {
    cloudUrl: cloud.url,
    token: "ccrt_held_by_the_link",
    fresh: async () => "ccrt_held_by_the_link",
  };
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const answering = (status: number, body: unknown): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  const ask = (status: number, body: unknown) =>
    askCredentialsOutside({ linkDir, link, fetch: answering(status, body) });
  expect(
    await ask(200, { runtime_id: identity.runtimeId, hosted: true, credentials_outside: true }),
  ).toBe(true);
  expect(
    await ask(200, { runtime_id: identity.runtimeId, hosted: true, credentials_outside: false }),
  ).toBe(false);
  expect(await ask(200, { runtime_id: identity.runtimeId })).toBe(false);
  expect(await ask(200, { credentials_outside: "true" })).toBe(false);
  expect(await ask(404, { error: { code: "not_found" } })).toBe(false);
  await expect(ask(500, { error: { code: "cave_internal", message: "down" } })).rejects.toThrow(
    "down",
  );
  // The route itself, with the link's own token (never one minted for the call).
  expect(seen[0]).toEqual({
    url: `${cloud.url}/api/v1/code/runtime`,
    authorization: "Bearer ccrt_held_by_the_link",
  });

  const rule = ruleOf(link);
  rule.join(async () => false);
  expect(await rule.outside()).toBe(false);
  await expect(
    call(
      identity,
      link,
      "GET",
      "engine-logins/claude",
      undefined,
      answering(403, {
        error: { code: OUTSIDE_COMPUTER, message: "Credentials stay outside this computer." },
      }),
    ),
  ).rejects.toMatchObject({ status: 403, code: OUTSIDE_COMPUTER });
  expect(await rule.outside()).toBe(true);
});

test("before its link runs a Cloud computer asks at once, on a token minted for the call: a starting runtime is not held for a link that starts after it", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("credential-rule-start-"), "link");
  const identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "computer",
  });
  // As a runtime's link is while it starts: nothing runs it yet (no `fresh`), and it holds no token. The engines'
  // first check reads their keys then, before the runtime listens, and the link starts only once it listens.
  const link: LinkState = {};
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const answering: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    seen.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const body = url.pathname.endsWith("/token")
      ? {
          token: "ccrt_minted_for_the_call",
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        }
      : { runtime_id: identity.runtimeId, hosted: true, credentials_outside: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", date: new Date().toUTCString() },
    });
  }) as typeof fetch;
  const asked = Date.now();
  expect(await askCredentialsOutside({ linkDir, link, fetch: answering })).toBe(true);
  // It waited for the link for the whole call timeout (10 s) before it asked: every Cloud computer's start, and so
  // every wake, took that much longer (Caveman Cloud proof `ready`, 2026-11-10).
  expect(Date.now() - asked).toBeLessThan(2_000);
  expect(seen).toEqual([
    { path: `/api/v1/code/runtimes/${identity.runtimeId}/token`, authorization: null },
    { path: "/api/v1/code/runtime", authorization: "Bearer ccrt_minted_for_the_call" },
  ]);
});

test("routes_auto: Cloud's word on which agents' Auto its data plane routes, only under the rule; an older Cloud names none", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("credential-rule-auto-"), "link");
  await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "computer",
  });
  const answering = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  const heard = async (body: Record<string, unknown>) => {
    const link: LinkState = {
      cloudUrl: cloud.url,
      token: "ccrt_held_by_the_link",
      fresh: async () => "ccrt_held_by_the_link",
    };
    const rule = ruleOf(link);
    rule.join(() => askCredentialsOutside({ linkDir, link, fetch: answering(body) }));
    await rule.outside();
    return ["claude-agent", "codex"].filter((engine) => rule.routesAuto(engine));
  };
  expect(
    await heard({ credentials_outside: true, routes_auto: ["claude-agent", "codex"] }),
  ).toEqual(["claude-agent", "codex"]);
  expect(await heard({ credentials_outside: true, routes_auto: ["codex", 7, null] })).toEqual([
    "codex",
  ]);
  // Its switches off, or a Cloud from before the field: none.
  expect(await heard({ credentials_outside: true, routes_auto: [] })).toEqual([]);
  expect(await heard({ credentials_outside: true })).toEqual([]);
  expect(await heard({ credentials_outside: true, routes_auto: "claude-agent" })).toEqual([]);
  // Never where credentials are inside the computer: the app's own proxy runs Auto there, or nothing does.
  expect(
    await heard({ credentials_outside: false, routes_auto: ["claude-agent", "codex"] }),
  ).toEqual([]);
  // A Mac's rule is never joined.
  expect(new CredentialRule().routesAuto("claude-agent")).toBe(false);
});
