/** The Caveman engine behind the project-secrets egress scrub: model requests, side text, the Caveman version, and leftover env files. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, afterEach, vi } from "vitest";

import { modelsThroughScrub, sweepStaleSecretEnvDirs } from "./adapter.ts";
import { cavemanModels, readCavemanKeys, setCavemanKey, type CavemanKeys } from "./credentials.ts";
import { makeCavemanRewriter } from "./rewriter.ts";
import { cavemanSideText } from "./sideText.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman-egress");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const SECRET = ("sk_" + "live_REPO_SECRET_0123456789abcdef");

/**
 * A stand-in for the runtime's scrub (runtime secrets/EgressScrub.ts): `route` keeps an upstream under an id, and a
 * request on its URL is recorded as the URL the scrub forwards it to, then answered 400 (nothing goes further).
 */
const scrub = await (async () => {
  const routes = new Map<string, string>();
  const forwarded: Array<{ readonly url: string; readonly body: string }> = [];
  const server = NodeHttp.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const raw = req.url ?? "/";
    const query = raw.indexOf("?");
    const [, , id = "", ...rest] = (query === -1 ? raw : raw.slice(0, query)).split("/");
    const upstream = routes.get(id);
    if (upstream !== undefined) forwarded.push({ url: new URL(upstream.replace(/\/+$/, "") + "/" + rest.join("/") + (query === -1 ? "" : raw.slice(query))).href, body });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "scrub stand-in" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tok`;
  return {
    forwarded,
    route: (upstream: string) => {
      const id = NodeCrypto.createHash("sha256").update(upstream).digest("hex").slice(0, 16);
      routes.set(id, upstream);
      return `${origin}/${id}`;
    },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
})();
afterAll(() => scrub.close());
afterEach(() => {
  scrub.forwarded.length = 0;
  vi.unstubAllEnvs();
});

/** One model request as the engine makes it (models.streamSimple), with a repository secret in its context. */
const requestThroughScrub = async (keys: CavemanKeys, provider: string, pick: (model: Model<Api>) => boolean = () => true) => {
  const models = modelsThroughScrub(await Effect.runPromise(cavemanModels(keys)), scrub.route);
  const model = models.getModels(provider).find(pick);
  assert.ok(model !== undefined, `a ${provider} model`);
  const reply = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: `env output:\nSTRIPE_KEY=${SECRET}`, timestamp: Date.now() }] },
    { maxTokens: 16, signal: AbortSignal.timeout(15_000) },
  );
  return { model, reply, forwarded: scrub.forwarded.map((request) => request.url) };
};

describe("Caveman engine model requests through the egress scrub", () => {
  it("goes to the route chained to the model's own base URL, and direct when the scrub is down", async () => {
    const { model, forwarded } = await requestThroughScrub({ anthropic: { key: "sk-ant-test" } }, "anthropic");
    assert.deepEqual(forwarded, ["https://api.anthropic.com/v1/messages?beta=true"]);
    const sent: Array<string> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      sent.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "stub" } }), { status: 400, headers: { "content-type": "application/json" } });
    });
    try {
      const down = modelsThroughScrub(await Effect.runPromise(cavemanModels({ anthropic: { key: "sk-ant-test" } })), () => undefined);
      await down.completeSimple(down.getModel("anthropic", model.id)!, { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] }, { maxTokens: 16 });
    } finally {
      vi.unstubAllGlobals();
    }
    assert.deepEqual({ sent, forwarded: scrub.forwarded.length }, { sent: ["https://api.anthropic.com/v1/messages?beta=true"], forwarded: 1 });
  });

  it("goes to a Cloud computer's credits gateway, named at the request, only through the scrub", async () => {
    const seen: Array<string> = [];
    const gateway = NodeHttp.createServer((req, res) => (seen.push(req.url ?? ""), res.writeHead(500), res.end()));
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    try {
      // As readCavemanKeys builds the slot on a Cloud computer with no stored credits key.
      const { forwarded } = await requestThroughScrub(
        { caveman: { key: "", live: async () => ({ key: "cave_live_computer_key", gateway: gatewayUrl }) } },
        "caveman",
        (model) => model.provider === "caveman-deepseek",
      );
      assert.deepEqual({ forwarded, direct: seen }, { forwarded: [`${gatewayUrl}/deepseek/v1/chat/completions`], direct: [] });
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });

  it("goes to a sign-in's own endpoint (GitHub Copilot's) only through the scrub", async () => {
    const { forwarded } = await requestThroughScrub(
      { "github-copilot": { oauth: { access: "copilot-token", refresh: "gho_github", expires: Date.now() + 3_600_000 } } },
      "github-copilot",
      (model) => model.api === "openai-completions",
    );
    assert.deepEqual(forwarded, ["https://api.individual.githubcopilot.com/chat/completions"]);
  });

  it("goes to an Azure OpenAI resource, from its stored name or the runtime's AZURE_OPENAI_BASE_URL, only through the scrub", async () => {
    const isResponses = (model: Model<Api>) => model.api === "azure-openai-responses";
    const named = await requestThroughScrub({ azure: { key: "azure-test-key-0123456789", env: { AZURE_OPENAI_RESOURCE_NAME: "my-resource" } } }, "azure", isResponses);
    assert.deepEqual(named.forwarded, ["https://my-resource.openai.azure.com/openai/v1/responses?api-version=v1"]);
    scrub.forwarded.length = 0;
    vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://corp-resource.openai.azure.com/openai/v1");
    const ambient = await requestThroughScrub({ azure: { key: "azure-test-key-0123456789" } }, "azure", isResponses);
    assert.deepEqual(ambient.forwarded, ["https://corp-resource.openai.azure.com/openai/v1/responses?api-version=v1"]);
  });
});

describe("a custom endpoint through the egress scrub", () => {
  /** One request to a custom OpenAI-compatible endpoint at `baseUrl`, as the engine makes it; the body the scrub forwards. */
  const sentTo = async (baseUrl: string) => {
    const keys: CavemanKeys = { "custom-host": { key: "custom-key-0123456789", endpoint: { name: "Host", baseUrl, models: ["some-model"] } } };
    const models = modelsThroughScrub(await Effect.runPromise(cavemanModels(keys)), scrub.route);
    const model = models.getModel("custom-host", "some-model");
    assert.ok(model !== undefined, "the endpoint's model");
    await models.completeSimple(
      model,
      { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] },
      { maxTokens: 16, sessionId: "thread-1", signal: AbortSignal.timeout(15_000) },
    );
    const [request, ...more] = scrub.forwarded.splice(0);
    assert.deepEqual(more, []);
    const body = JSON.parse(request!.body) as Record<string, unknown>;
    return { url: request!.url, maxTokens: body.max_tokens, maxCompletionTokens: body.max_completion_tokens, store: body.store, cacheKey: body.prompt_cache_key };
  };

  it("keeps the request shape pi-ai gives the endpoint's own host, not the scrub's loopback route", async () => {
    // Hosts that take max_tokens and refuse `store` (pi-ai's compat for them, by host).
    assert.deepEqual(await sentTo("https://llm.chutes.ai/v1"), {
      url: "https://llm.chutes.ai/v1/chat/completions",
      maxTokens: 16,
      maxCompletionTokens: undefined,
      store: undefined,
      cacheKey: undefined,
    });
    assert.deepEqual(await sentTo("https://api.deepseek.com/v1/"), {
      url: "https://api.deepseek.com/v1/chat/completions",
      maxTokens: 16,
      maxCompletionTokens: undefined,
      store: undefined,
      cacheKey: undefined,
    });
    // OpenAI's own host keeps its prompt cache key.
    assert.deepEqual(await sentTo("https://api.openai.com/v1"), {
      url: "https://api.openai.com/v1/chat/completions",
      maxTokens: undefined,
      maxCompletionTokens: 16,
      store: false,
      cacheKey: "thread-1",
    });
  });
});

describe("Caveman engine model requests through the egress scrub, to the endpoint the credential names", () => {
  it("Cloudflare AI Gateway goes to the person's account and gateway, not the catalog's placeholders", async () => {
    const { forwarded } = await requestThroughScrub(
      { "cloudflare-ai-gateway": { key: "cf-token-test", env: { CLOUDFLARE_ACCOUNT_ID: "acct123", CLOUDFLARE_GATEWAY_ID: "gw456" } } },
      "cloudflare-ai-gateway",
      (model) => model.api === "anthropic-messages",
    );
    assert.deepEqual(forwarded, ["https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic/v1/messages?beta=true"]);
  });

  it("Cloudflare Workers AI goes to the person's account, not the catalog's placeholder", async () => {
    const { forwarded } = await requestThroughScrub(
      { "cloudflare-workers-ai": { key: "cf-token-test", env: { CLOUDFLARE_ACCOUNT_ID: "acct123" } } },
      "cloudflare-workers-ai",
      (model) => model.api === "openai-completions",
    );
    assert.deepEqual(forwarded, ["https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions"]);
  });

  it("Google Vertex AI on an API key goes to Vertex's own host, not the catalog's {location} one", async () => {
    const { model, forwarded } = await requestThroughScrub({ "google-vertex": { key: "vertex-key-test" } }, "google-vertex");
    assert.deepEqual(forwarded, [`https://aiplatform.googleapis.com/v1/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`]);
  });

  it("Amazon Bedrock reaches the scrub (HTTP/1.1, which it speaks) and goes to the Region the person stored", async () => {
    vi.stubEnv("AWS_PROFILE", "");
    const { model, reply, forwarded } = await requestThroughScrub(
      { "amazon-bedrock": { key: "bedrock-api-key-test", env: { AWS_REGION: "eu-west-1" } } },
      "amazon-bedrock",
      (candidate) => candidate.baseUrl === "https://bedrock-runtime.us-east-1.amazonaws.com",
    );
    assert.notEqual(reply.errorMessage, "Protocol error");
    assert.deepEqual(forwarded, [`https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodeURIComponent(model.id)}/converse-stream`]);
  });
});

describe("Caveman engine egress", () => {
  it.effect("M10: the Caveman version calls its model through the scrub", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID).pipe(
        Effect.provideService(
          EgressRoute.EgressRoute,
          EgressRoute.EgressRoute.of({ route: scrub.route, owns: () => false, hasSecrets: () => Effect.succeed(false) }),
        ),
      );
      // The stand-in answers 400, so the version fails; what matters is where its request went.
      yield* Effect.exit(rewriter.rewrite("I have fixed it."));
      assert.deepEqual([...new Set(scrub.forwarded.map((request) => request.url))], ["https://api.openai.com/v1/responses"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("M4: side text refuses when the scrub is down and the repository has secrets", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const error = yield* Effect.flip(
        cavemanSideText({ instanceId: INSTANCE_ID, instructions: "Title it.", prompt: "Hello", cwd: NodeOS.tmpdir() }).pipe(
          Effect.provideService(
            EgressRoute.EgressRoute,
            EgressRoute.EgressRoute.of({ route: () => undefined, owns: () => false, hasSecrets: () => Effect.succeed(true) }),
          ),
        ),
      );
      assert.match(error.message, /egress scrub/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("where credentials stay outside the computer, the engine's key slots are stand-ins and no stored key is read", () =>
    Effect.gen(function* () {
      // A key that sat in the computer's store from before the rule is not the engine's any more.
      yield* setCavemanKey(INSTANCE_ID, "anthropic", ("sk-" + "ant-a-key-stored-on-the-computer-0123456789"));
      const keys = yield* readCavemanKeys(INSTANCE_ID);
      assert.deepEqual(Object.keys(keys), ["openai"]);
      assert.equal(keys.openai?.key, "sk-caveman-stand-in-0");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        TestProviderHost.layer({ connections: { keys: async () => [{ provider: "openai", key: "sk-caveman-stand-in-0" }], headers: () => ({}) } }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.effect("while Cloud cannot say whether they do, the engine has no key", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "anthropic", ("sk-" + "ant-a-key-stored-on-the-computer-0123456789"));
      assert.deepEqual(Object.keys(yield* readCavemanKeys(INSTANCE_ID)), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(TestProviderHost.layer({ connections: { keys: () => Promise.reject(new Error("Cloud unreachable")), headers: () => ({}) } }).pipe(Layer.provide(NodeServices.layer))),
    ),
  );

  it.effect("on a Cloud computer the rule does not cover, the stored keys count as before", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "anthropic", ("sk-" + "ant-a-key-stored-on-the-computer-0123456789"));
      assert.deepEqual(Object.keys(yield* readCavemanKeys(INSTANCE_ID)), ["anthropic"]);
    }).pipe(Effect.scoped, Effect.provide(TestProviderHost.layer({ connections: { keys: async () => undefined, headers: () => ({}) } }).pipe(Layer.provide(NodeServices.layer)))),
  );

  it("a routed request carries the chat's name to the scrub; one that goes direct carries nothing more", async () => {
    const via = "http://127.0.0.1:9/token/route";
    const sent: Array<{ baseUrl: string; headers: unknown }> = [];
    for (const route of [() => via, () => undefined]) {
      const models = await Effect.runPromise(cavemanModels({ anthropic: { key: "sk-caveman-stand-in-0" } }));
      const capture = ((model: Model<Api>, _context: unknown, options?: { headers?: unknown }) => (sent.push({ baseUrl: model.baseUrl, headers: options?.headers }), undefined)) as never;
      models.setProvider({ ...models.getProvider("anthropic")!, stream: capture, streamSimple: capture });
      const routed = modelsThroughScrub(models, route, { "x-cave-session": "thread-1" });
      routed.getProvider("anthropic")!.stream(routed.getModels("anthropic")[0]!, { messages: [] } as never, { headers: { "x-own": "kept" } } as never);
    }
    assert.deepEqual(sent[0], { baseUrl: via, headers: { "x-own": "kept", "x-cave-session": "thread-1" } });
    assert.deepEqual(sent[1]?.headers as unknown, { "x-own": "kept" });
  });

  it("L2: removes env dirs whose runtime is gone, keeps a live one's", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "egress-sweep-"));
    try {
      for (const name of ["caveman-env-999999-dead", `caveman-env-${process.pid}-live`, "caveman-env-legacy", "other-dir"]) {
        NodeFS.mkdirSync(NodePath.join(root, name));
        NodeFS.writeFileSync(NodePath.join(root, name, "env.sh"), "export X='y'\n", { mode: 0o600 });
      }
      const removed = await sweepStaleSecretEnvDirs(root);
      assert.sameMembers([...removed], ["caveman-env-999999-dead", "caveman-env-legacy"]);
      assert.sameMembers(NodeFS.readdirSync(root), [`caveman-env-${process.pid}-live`, "other-dir"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
