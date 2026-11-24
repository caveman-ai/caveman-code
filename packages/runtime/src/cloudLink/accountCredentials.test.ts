// A service account's credentials on its computer (C2-5): each reaches only its own target, every value is scrubbed,
// and Cloud closing the computer (a disabled account, a shared computer) withdraws them all at once.
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { accountHeaders } from "../plugins/McpHub.ts";
import { makeRepo, tempRoot } from "../session-protocol/testHarness.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { accountVault, hostAllowed, urlMatches } from "./accountCredentials.ts";
import { CloudValues, makeProjectSecrets } from "./computerSecrets.ts";
import { batchesOf } from "./eventOutbox.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";

const TOKEN = "sat_live_7f3a9c2e5b8d1f4a6c0e3b7d9f2a5c8e";
const STRIPE = ("sk_" + "live_51HxQ2c3d4e5f6g7h8i9j0kLmNoPqRsTuV");

afterEach(() => accountVault.clear());

test("urlMatches: same scheme, host and port, and a path at or below match_url's; never a look-alike host", () => {
  expect(urlMatches("https://mcp.linear.app/sse", "https://mcp.linear.app")).toBe(true);
  expect(urlMatches("https://MCP.linear.app:443/mcp/tools", "https://mcp.linear.app/mcp")).toBe(true);
  expect(urlMatches("https://mcp.linear.app/mcp", "https://mcp.linear.app/mcp/")).toBe(true);
  expect(urlMatches("https://mcp.linear.app.attacker.net/mcp", "https://mcp.linear.app")).toBe(false);
  expect(urlMatches("https://mcp.linear.app/mcpx", "https://mcp.linear.app/mcp")).toBe(false);
  expect(urlMatches("http://mcp.linear.app/mcp", "https://mcp.linear.app/mcp")).toBe(false);
  expect(urlMatches("https://mcp.linear.app:8443/mcp", "https://mcp.linear.app/mcp")).toBe(false);
  expect(urlMatches("https://user@evil.example/", "https://mcp.linear.app")).toBe(false);
  expect(urlMatches("not a url", "https://mcp.linear.app")).toBe(false);
});

test("hostAllowed: exact names, and *. for subdomains only", () => {
  expect(hostAllowed("api.stripe.com", ["api.stripe.com"])).toBe(true);
  expect(hostAllowed("API.Stripe.com", ["api.stripe.com"])).toBe(true);
  expect(hostAllowed("files.stripe.com", ["*.stripe.com"])).toBe(true);
  expect(hostAllowed("stripe.com", ["*.stripe.com"])).toBe(false);
  expect(hostAllowed("api.stripe.com.evil.net", ["api.stripe.com", "*.stripe.com"])).toBe(false);
  expect(hostAllowed("evilstripe.com", ["*.stripe.com"])).toBe(false);
});

test("a host-bound variable is a stand-in to processes and its value only toward its hosts; a bearer only under its match_url", () => {
  const entries = accountVault.take(
    [{ name: "PLAIN", value: "plain-value-1234567890" }, { name: "STRIPE_KEY", value: STRIPE, hosts: ["api.stripe.com"] }],
    [{ type: "static_bearer", match_url: "https://mcp.linear.app/mcp", token: TOKEN }, { type: "mcp_oauth", match_url: "https://mcp.notion.com" }],
  );
  const standIn = entries.find((e) => e.name === "STRIPE_KEY")!.value;
  expect(entries.find((e) => e.name === "PLAIN")!.value).toBe("plain-value-1234567890");
  expect(standIn).not.toBe(STRIPE);
  // Stable for the run: a process started before the next resolve keeps working.
  expect(accountVault.take([{ name: "STRIPE_KEY", value: STRIPE, hosts: ["api.stripe.com"] }], []).at(0)!.value).toBe(standIn);
  accountVault.take([{ name: "STRIPE_KEY", value: STRIPE, hosts: ["api.stripe.com"] }], [{ type: "static_bearer", match_url: "https://mcp.linear.app/mcp", token: TOKEN }, { type: "mcp_oauth", match_url: "https://mcp.notion.com" }]);
  const headers = { authorization: `Bearer ${standIn}`, "x-other": "keep" };
  expect(accountVault.swap(headers, new URL("https://api.stripe.com/v1/charges"))).toEqual({ authorization: `Bearer ${STRIPE}`, "x-other": "keep" });
  expect(accountVault.swap(headers, new URL("https://api.stripe.com.evil.net/v1/charges"))).toEqual(headers);
  expect(accountVault.swap(headers, new URL("https://api.openai.com/v1/responses"))).toEqual(headers);
  // The MCP hub: the bearer on a server under match_url only, and never over a server's own sign-in.
  expect(accountHeaders("https://mcp.linear.app/mcp", {}, false)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  expect(accountHeaders("https://mcp.linear.app.evil.net/mcp", {}, false)).toEqual({});
  expect(accountHeaders("https://other.example/mcp", { "x-key": standIn }, false)).toEqual({ "x-key": standIn });
  expect(accountHeaders("https://api.stripe.com/mcp", { "x-key": standIn }, false)).toEqual({ "x-key": STRIPE });
  expect(accountHeaders("https://mcp.linear.app/mcp", {}, true)).toEqual({});
  expect(accountVault.oauthFor("https://mcp.notion.com/mcp")).toBe("https://mcp.notion.com");
  expect(accountVault.oauthFor("https://mcp.notion.com.evil.net/mcp")).toBeUndefined();
  // What the scrubber is given: every real value.
  expect(accountVault.values().map((v) => v.value).sort()).toEqual([STRIPE, TOKEN].sort());
  const before = accountVault.generation();
  accountVault.clear();
  expect(accountVault.generation()).toBeGreaterThan(before);
  expect(accountHeaders("https://mcp.linear.app/mcp", {}, false)).toEqual({});
  expect(accountVault.swap(headers, new URL("https://api.stripe.com/v1/charges"))).toEqual(headers);
});

test("under the rule the account's credentials come as names only: the proxy's id for a server under match_url, and no value", () => {
  const before = accountVault.generation();
  const entries = accountVault.take(
    [{ name: "PLAIN", value: "plain-value-1234567890" }],
    undefined,
    [
      { id: "cred-linear", type: "static_bearer", match_url: "https://mcp.linear.app" },
      { id: "cred-linear-mcp", type: "static_bearer", match_url: "https://mcp.linear.app/mcp" },
      { id: "conn-notion", type: "mcp_oauth", match_url: "https://mcp.notion.com" },
      // What cannot name a route to the proxy is dropped: an id with a path in it, an address that is not one, a kind Cloud does not have.
      { id: "../github/api", type: "static_bearer", match_url: "https://evil.example" },
      { id: "cred-bad", type: "static_bearer", match_url: "not a url" },
      { id: "cred-kind", type: "api_key" as never, match_url: "https://kind.example" },
      // A value Cloud should never send is not kept either.
      { id: "cred-extra", type: "static_bearer", match_url: "https://extra.example", token: TOKEN } as never,
    ],
  );
  expect(entries).toEqual([{ name: "PLAIN", value: "plain-value-1234567890" }]);
  expect(accountVault.generation()).toBeGreaterThan(before);
  // The most specific match_url names the server; a look-alike host or path names none.
  expect(accountVault.proxiedFor("https://mcp.linear.app/mcp/tools")).toEqual({ id: "cred-linear-mcp", type: "static_bearer", match_url: "https://mcp.linear.app/mcp" });
  expect(accountVault.proxiedFor("https://mcp.linear.app/sse")).toEqual({ id: "cred-linear", type: "static_bearer", match_url: "https://mcp.linear.app" });
  expect(accountVault.proxiedFor("https://mcp.notion.com/mcp")?.id).toBe("conn-notion");
  expect(accountVault.proxiedFor("https://mcp.linear.app.evil.net/mcp")).toBeUndefined();
  expect(accountVault.proxiedFor("https://evil.example/mcp")).toBeUndefined();
  expect(accountVault.proxiedFor("https://kind.example/mcp")).toBeUndefined();
  expect(accountVault.proxiedFor("https://extra.example/mcp")).toEqual({ id: "cred-extra", type: "static_bearer", match_url: "https://extra.example" });
  // Nothing is held: no bearer, no header, no sign-in to lease, nothing for the scrubber.
  expect(accountVault.bearerFor("https://mcp.linear.app/mcp")).toBeUndefined();
  expect(accountVault.oauthFor("https://mcp.notion.com/mcp")).toBeUndefined();
  expect(accountHeaders("https://mcp.linear.app/mcp", {}, false)).toEqual({});
  expect(accountVault.values()).toEqual([]);
  // The same names again change nothing; Cloud closing the computer withdraws them.
  const same = accountVault.generation();
  accountVault.take([], undefined, [
    { id: "cred-linear", type: "static_bearer", match_url: "https://mcp.linear.app" },
    { id: "cred-linear-mcp", type: "static_bearer", match_url: "https://mcp.linear.app/mcp" },
    { id: "conn-notion", type: "mcp_oauth", match_url: "https://mcp.notion.com" },
    { id: "cred-extra", type: "static_bearer", match_url: "https://extra.example" },
  ]);
  expect(accountVault.generation()).toBe(same);
  accountVault.clear();
  expect(accountVault.generation()).toBeGreaterThan(same);
  expect(accountVault.proxiedFor("https://mcp.linear.app/mcp")).toBeUndefined();
});

describe_computer();

function describe_computer() {
  let cloud: TestCloud;
  let run: <A>(effect: Effect.Effect<A, unknown, ProjectSecrets>) => Promise<A>;
  beforeAll(async () => {
    cloud = await startTestCloud();
    const linkDir = path.join(tempRoot("account-link-"), "link");
    const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
    cloud.state.parity.computers.add(identity.runtimeId);
    const workspace = makeRepo(tempRoot("account-checkout-"), { "README.md": "x\n" });
    const layer = Layer.effect(ProjectSecrets, makeProjectSecrets).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: workspace }),
          Layer.succeed(CloudLinkState, {}),
          Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
        ),
      ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    run = (effect) => Effect.runPromise(Effect.provide(effect, context) as Effect.Effect<never>);
  });
  afterAll(() => cloud.close());

  test("on the computer: processes get the stand-in, the scrubber hides every value, and a disabled account or shared computer withdraws them at once", async () => {
    cloud.state.parity.account = {
      secrets: [{ name: "STRIPE_KEY", value: STRIPE, hosts: ["api.stripe.com"] }],
      credentials: [{ type: "static_bearer", match_url: "https://mcp.linear.app/mcp", token: TOKEN }],
    };
    const entries = await run(Effect.flatMap(ProjectSecrets, (s) => s.resolve("github.com/acme/app")));
    expect(entries.map((e) => e.name)).toEqual(["STRIPE_KEY"]);
    expect(JSON.stringify(entries)).not.toContain(STRIPE);
    const scrubber = await run(Effect.flatMap(ProjectSecrets, (s) => s.scrubber));
    expect(scrubber.scrub(`key ${STRIPE} token ${TOKEN}`)).toBe("key [secret:STRIPE_KEY] token [secret:SERVICE_ACCOUNT_TOKEN]");
    // A public event a tool's output put them in leaves without either.
    const posted = JSON.stringify(batchesOf([{ seq: 1, type: "tool.completed", created_at: new Date(0).toISOString(), data: { output: `curl -H "Authorization: Bearer ${TOKEN}" -d key=${STRIPE}` } }], scrubber));
    expect(posted).not.toContain(TOKEN);
    expect(posted).not.toContain(STRIPE);
    expect(accountVault.bearerFor("https://mcp.linear.app/mcp")).toBe(TOKEN);

    for (const refuse of [{ status: 409, code: "cave_code_service_account_inactive" }, { status: 403, code: "cave_code_computer_shared" }]) {
      cloud.state.parity.account = { ...cloud.state.parity.account, refuse };
      // The next resolve Cloud answers (each repository is resolved on its own, so a fresh one asks again).
      const answered = await run(Effect.flatMap(ProjectSecrets, (s) => s.resolve(`github.com/acme/closed-${refuse.status}`)));
      expect(answered).toEqual([]);
      expect(accountVault.bearerFor("https://mcp.linear.app/mcp")).toBeUndefined();
      expect(accountHeaders("https://mcp.linear.app/mcp", {}, false)).toEqual({});
      // Back on: the account's credentials return with the next resolve.
      const { refuse: _closed, ...open } = cloud.state.parity.account;
      cloud.state.parity.account = open;
      await run(Effect.flatMap(ProjectSecrets, (s) => s.resolve(`github.com/acme/again-${refuse.status}`)));
      expect(accountVault.bearerFor("https://mcp.linear.app/mcp")).toBe(TOKEN);
    }
  });
}
