import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import type { AccountSession, AccountStore } from "../cloudLink/account.ts";
import { appProxyTokens } from "./proxyLauncher.ts";
import { makeRouterKey } from "./routerKey.ts";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });
async function setup() {
  let now = Date.parse("2026-10-18T00:00:00Z");
  let status = 201;
  let count = 0;
  let credits: string | undefined;
  const requests: Array<{ url: string | undefined; method: string | undefined; authorization: string | undefined; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    count++;
    res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "90" } : {}) });
    res.end(JSON.stringify(status === 201 ? { id: `id-${count}`, full_key: `cave_router_fake_${count}`, scopes: ["router:write"], expires_at: new Date(now + 60 * 60_000).toISOString() } : { error: "refused" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let session: AccountSession | undefined = { cloud_url: url, access_token: "cave_fake_login" };
  const store: AccountStore = { load: async () => session, save: async (value) => { session = value; } };
  const owner = makeRouterKey({ store, credits: async () => credits, now: () => now });
  return { owner, store, requests, url, advance: (ms: number) => { now += ms; }, status: (value: number) => { status = value; }, credits: (value: string | undefined) => { credits = value; } };
}

test("mints once with Code bearer, no body; refreshes before expiry and seals the result", async () => {
  const s = await setup();
  expect(await s.owner.get()).toBeUndefined();
  await Promise.all([s.owner.refresh(), s.owner.refresh(), s.owner.refresh()]);
  expect(s.requests).toEqual([{ url: "/api/v1/code/router/keys", method: "POST", authorization: "Bearer cave_fake_login", body: "" }]);
  expect(await s.owner.get()).toEqual({ key: "cave_router_fake_1", url: s.url });
  expect((await s.store.load())?.routing_key).toBe("cave_router_fake_1");
  expect(appProxyTokens.has("cave_router_fake_1")).toBe(true);
  await s.owner.refresh();
  await s.owner.get();
  expect(s.requests).toHaveLength(1);
  s.advance(56 * 60_000);
  await s.owner.refresh();
  expect((await s.owner.get())?.key).toBe("cave_router_fake_2");
  expect(s.requests).toHaveLength(2);
});

test("credits take precedence without minting; turning credits off gets paid-plan key", async () => {
  const s = await setup();
  s.credits("cave_credits_fake");
  await s.owner.refresh();
  expect((await s.owner.get())?.key).toBe("cave_credits_fake");
  expect(s.requests).toHaveLength(0);
  s.credits(undefined);
  await s.owner.refresh();
  expect((await s.owner.get())?.key).toBe("cave_router_fake_1");
  await s.owner.clear();
  await s.store.save(undefined);
  expect(await s.owner.get()).toBeUndefined();
  await s.owner.refresh();
  expect(s.requests).toHaveLength(1);
});

test.each([429, 500, 503])("backs off mint failures (%s), honors Retry-After", async (status) => {
  const s = await setup();
  s.status(status);
  await s.owner.refresh();
  await s.owner.refresh();
  expect(s.requests).toHaveLength(1);
  s.advance(status === 429 ? 89_000 : 29_000);
  await s.owner.refresh();
  expect(s.requests).toHaveLength(1);
  s.advance(2_000);
  s.status(201);
  await s.owner.refresh();
  expect(s.requests).toHaveLength(2);
  expect((await s.owner.get())?.key).toBe("cave_router_fake_2");
});

test("402 clears held key and never offers Auto to a free signed-in account", async () => {
  const s = await setup();
  await s.owner.refresh();
  s.advance(56 * 60_000);
  s.status(402);
  await s.owner.refresh();
  expect(await s.owner.get()).toBeUndefined();
  expect((await s.store.load())?.routing_key).toBeUndefined();
  await s.owner.refresh();
  expect(s.requests).toHaveLength(2);
});

test.each([401, 403])("re-mints a rejected key once; stale failures cannot rotate the new key (%s)", async (status) => {
  const s = await setup();
  await s.owner.refresh();
  await s.owner.rejected("cave_router_fake_1", status);
  expect((await s.owner.get())?.key).toBe("cave_router_fake_2");
  await s.owner.rejected("cave_router_fake_1", status);
  expect(s.requests).toHaveLength(2);
  await s.owner.rejected("cave_router_fake_2", 402);
  expect(await s.owner.get()).toBeUndefined();
  expect(s.requests).toHaveLength(2);
});

test("sign-out during mint cannot restore the account", async () => {
  const s = await setup();
  let answer!: (response: Response) => void;
  const owner = makeRouterKey({ store: s.store, credits: async () => undefined, fetch: (async () => new Promise<Response>((resolve) => { answer = resolve; })) as typeof fetch });
  const pending = owner.refresh();
  while (!answer) await new Promise((resolve) => setImmediate(resolve));
  await owner.clear();
  await s.store.save(undefined);
  answer(Response.json({ full_key: "cave_old_account", scopes: ["router:write"], expires_at: "2099-01-01T00:00:00Z" }, { status: 201 }));
  await pending;
  expect(await s.store.load()).toBeUndefined();
  expect(await owner.get()).toBeUndefined();
});

test("Auto asks the gateway a Cloud named at sign-in; a sign-in kept without one asks its own origin, as before", async () => {
  const s = await setup();
  s.credits("cave_live_credits_fake_0123456789");
  const session = (await s.store.load())!;
  expect(await s.owner.get()).toEqual({ key: "cave_live_credits_fake_0123456789", url: s.url });
  await s.store.save({ ...session, gateway_url: "https://gateway.customer.example" });
  expect(await s.owner.get()).toEqual({ key: "cave_live_credits_fake_0123456789", url: "https://gateway.customer.example" });
});

test("a refresh or a refused key settles while the app proxies are still taking the new credential, and they are told", async () => {
  const s = await setup();
  let told = 0;
  // The proxies' start (spawn plus readiness poll, twice) that never finishes here.
  const owner = makeRouterKey({ store: s.store, credits: async () => undefined, now: () => Date.parse("2026-10-18T00:00:00Z"), changed: () => { told++; return new Promise<void>(() => {}); } });
  const settled = (promise: Promise<void>) => Promise.race([promise.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("waiting on the proxies"), 1_000))]);
  expect(await settled(owner.refresh())).toBe("settled");
  expect((await owner.get())?.key).toBe("cave_router_fake_1");
  expect(told).toBe(1);
  expect(await settled(owner.rejected("cave_router_fake_1", 401))).toBe("settled");
  expect((await owner.get())?.key).toBe("cave_router_fake_2");
  expect(told).toBe(2);
});

test("a Cloud computer keeps no sign-in: Auto asks with the credits key Cloud mints its runtime, minted only by a request", async () => {
  // The computer's credits source as computerCredits.ts gives it: nothing held until a request asks.
  let held: { key: string; gateway?: string } | undefined;
  let available = true;
  let mints = 0;
  const computer = {
    available: () => available,
    peek: () => held,
    get: async () => {
      if (held === undefined) { mints++; held = { key: `cave_credits_minted_${mints}`, gateway: "https://gateway.example" }; }
      return held;
    },
  };
  // No sign-in is kept, and none is asked for.
  const store: AccountStore = { load: async () => undefined, save: async () => undefined };
  const owner = makeRouterKey({ store, credits: async () => undefined, computer });
  // A model list or a status probe: Auto is offered, and Cloud is asked for nothing.
  expect(await owner.offered()).toBe(true);
  await owner.refresh();
  expect(mints).toBe(0);
  // A route ask: the key is minted then, runs on the gateway Cloud named, and joins the scrubber like every key held.
  expect(await owner.get()).toEqual({ key: "cave_credits_minted_1", url: "https://gateway.example" });
  expect(await owner.get()).toEqual({ key: "cave_credits_minted_1", url: "https://gateway.example" });
  expect(mints).toBe(1);
  expect(appProxyTokens.has("cave_credits_minted_1")).toBe(true);
  // Cloud's router refuses it (no allowance left): Auto is off until Cloud mints the next one, never a loop of asks.
  await owner.rejected("cave_credits_minted_1", 402);
  expect(await owner.get()).toBeUndefined();
  expect(await owner.offered()).toBe(false);
  held = { key: "cave_credits_minted_2" };
  expect(await owner.offered()).toBe(true);
  expect((await owner.get())?.key).toBe("cave_credits_minted_2");
  // Cloud says this computer is not to spend credits: no Auto, and nothing asked.
  available = false;
  expect(await owner.offered()).toBe(false);
  expect(await owner.get()).toBeUndefined();
  expect(mints).toBe(1);
});

test("a Mac's Auto is offered exactly when it holds a routing credential", async () => {
  const s = await setup();
  expect(await s.owner.offered()).toBe(false);
  await s.owner.refresh();
  expect(await s.owner.offered()).toBe(true);
});
