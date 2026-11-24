import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { RoutingCredentialSource } from "@caveman-app/engine-core/server/ProviderHost";
import { afterEach, describe, expect, it } from "vitest";
import { autoPool, CloudAutoRouter, type AutoDecideInput } from "./autoRouter.ts";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))); });
const pool = ["openai/gpt-6.1-sol", "anthropic/claude-sonnet-5-5", "openai~2/gpt-6-luna", "caveman/openai/gpt-6-luna"];
const sources = pool.map((id) => ({ id: id.split("/")[0]!, kind: id.startsWith("caveman/") ? "credits" as const : "key" as const, models: [id] }));
const input = (over: Partial<AutoDecideInput> = {}): AutoDecideInput => ({ currentModel: pool[0]!, ctxTokens: 2000, hasImages: false, toolErrorStreak: 0, ...over });
async function stub(answer: unknown, status = 200) {
  const calls: { body: any; authorization: string | undefined; url: string | undefined }[] = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({ body: JSON.parse(text), authorization: req.headers.authorization, url: req.url });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credential: RoutingCredentialSource = { get: async () => ({ key: "cave_fake_router", url }), rejected: async () => {} };
  return { calls, credential };
}

describe("CloudAutoRouter", () => {
  it("sends the connected pool and engine slug; keeps model/effort per ask and returns state", async () => {
    const { calls, credential } = await stub({ model: "claude-sonnet-5-5", pool_id: pool[1], effort: "high", effort_mode: "message", state: "rs1.fake", outcome_token: "out.fake" });
    const ask = { text: "refactor auth", seq: 1 };
    const router = new CloudAutoRouter(credential, pool, sources, () => ask, () => "medium");
    expect(await router.decide(input())).toMatchObject({ model: pool[1], reasoning: "high" });
    // One ask, one question to Cloud: the same ask decided again is the same pick.
    expect((await router.decide(input({ currentModel: pool[1]! })))?.model).toBe(pool[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ authorization: "Bearer cave_fake_router", url: "/v1/route", body: { models: ["gpt-6.1-sol", "claude-sonnet-5-5", "gpt-6-luna"], signals: { agent: "caveman-code-engine" }, request: { endpoint: "responses", effort: "medium" }, ask: { text: "refactor auth" } } });
    expect(calls[0]!.body.pool[2]).toMatchObject({ id: pool[2], host: "openai", model: "gpt-6-luna", via: "local", harness: "caveman", billing: "api_key" });
    expect(calls[0]!.body.pool[3].billing).toBe("credits");
    ask.seq++;
    ask.text = "explain it";
    await router.decide(input());
    expect(calls[1]!.body).toMatchObject({ state: "rs1.fake", ask: { prev_text: "refactor auth" } });
    await router.finish("completed");
    await router.finish("completed");
    expect(calls.filter((c) => c.url === "/v1/route/outcomes")).toHaveLength(1);
  });

  it("runs Cloud's effort as it picked it, and reports the last call", async () => {
    const { calls, credential } = await stub({ model: "claude-sonnet-5-5", pool_id: pool[1], effort: "high", effort_mode: "message" });
    const ask = { text: "fix the test", seq: 1 };
    const router = new CloudAutoRouter(credential, pool, sources, () => ask, () => "medium");
    const previousUsage = { model: "anthropic/claude-sonnet-5-5", inputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 };
    expect(await router.decide(input({ previousUsage }))).toEqual({ model: pool[1], reason: "Caveman Cloud", signals: ["caveman_cloud_router"], reasoning: "high" });
    expect(calls[0]!.body.last).toEqual({ model: "claude-sonnet-5-5", input_tokens: 10, cache_read_tokens: 900, cache_write_tokens: 50 });
  });

  it("refuses unknown pool ids, inconsistent models, errors and malformed answers", async () => {
    for (const answer of [null, [], { model: "gpt-6-luna", pool_id: "foreign" }, { model: "foreign", pool_id: pool[0] }, { model: "gpt-6.1-sol", pool_id: pool[0], reason: "billing_limit" }]) {
      const { credential } = await stub(answer);
      expect(await new CloudAutoRouter(credential, pool, sources, () => ({ text: "x", seq: 1 }), () => "medium").decide(input())).toBeUndefined();
    }
  });

  it("never calls Cloud without a credential; one connected model still gets effort", async () => {
    const { calls, credential } = await stub({ model: "gpt-6.1-sol", pool_id: pool[0], effort: "none" });
    const off = { ...credential, get: async () => undefined };
    expect(await new CloudAutoRouter(off, pool, sources, () => ({ text: "x", seq: 1 }), () => "medium").decide(input())).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(autoPool(pool[0]!, [pool[0]!])).toEqual([pool[0]]);
    expect(autoPool("absent", pool)).toEqual([]);
    const decision = await new CloudAutoRouter(credential, [pool[0]!], sources, () => ({ text: "x", seq: 1 }), () => "medium").decide(input());
    expect(decision?.reasoning).toBe("off");
    expect(autoPool(pool[0]!, [pool[0]!, ...Array.from({ length: 100 }, (_, n) => `openai/m${n}`)])).toHaveLength(64);
  });

  it("keeps effort out of a reasoning-locked run", async () => {
    const { credential } = await stub({ model: "gpt-6-luna", pool_id: pool[2], effort: "low" });
    const result = await new CloudAutoRouter(credential, pool, sources, () => ({ text: "x", seq: 1 }), () => "medium").decide(input(), false);
    expect(result?.reasoning).toBeUndefined();
  });

  it.each([401, 402, 403])("invalidates a refused credential once (%s), never loops", async (status) => {
    const { calls, credential } = await stub({}, status);
    let rejected = 0;
    let key = "cave_old";
    const url = (await credential.get())!.url;
    const source: RoutingCredentialSource = {
      get: async () => ({ key, url }),
      rejected: async (_key, code, remint) => { expect(code).toBe(status); if (remint) { rejected++; key = "cave_new"; } },
    };
    const router = new CloudAutoRouter(source, pool, sources, () => ({ text: "x", seq: 1 }), () => "medium");
    expect(await router.decide(input())).toBeUndefined();
    expect(rejected).toBe(1);
    expect(calls).toHaveLength(status === 402 ? 1 : 2);
  });
});
