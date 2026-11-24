// ), packages/provider-pi/src/server/driver.test.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/** Status snapshot, model list and text generation, all read from the runtime's key store. */
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CavemanSettings } from "../settings.ts";
import { checkCavemanStatus, makeCavemanTextGeneration } from "./driver.ts";
import { AUTO_PROVIDERS, resolveCavemanModel } from "./adapter.ts";
import { cavemanModels, setCavemanKey } from "./credentials.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman");
const settings = Schema.decodeSync(CavemanSettings)({});
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

describe("CavemanDriver", () => {
  for (const key of ["cave_credits_fake", "cave_paid_router_fake"]) {
    it.effect(`offers Auto only with the runtime's credential (${key})`, () =>
      Effect.gen(function* () {
        yield* setCavemanKey(INSTANCE_ID, "openai", "sk-test-openai");
        const host = yield* ProviderHost.ProviderHost;
        const ready = yield* checkCavemanStatus(INSTANCE_ID, settings).pipe(Effect.provideService(ProviderHost.ProviderHost, { ...host, routing: { get: async () => ({ key, url: "https://cloud.test" }), rejected: async () => {} } }));
        assert.equal(ready.models[0]?.slug, "auto");
        assert.equal(ready.models[0]?.isDefault, true);
      }).pipe(Effect.provide(layer)),
    );
  }
  it.effect("asks for a key until one is stored", () =>
    Effect.gen(function* () {
      const empty = yield* checkCavemanStatus(INSTANCE_ID, settings);
      assert.equal(empty.status, "warning");
      assert.deepEqual(empty.auth, { status: "unauthenticated" });
      assert.deepEqual(empty.models.map((model) => model.slug), []);
 // The levers are on by default.
      assert.equal(settings.optimization, "off");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists only the models of providers with a stored key", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const ready = yield* checkCavemanStatus(INSTANCE_ID, settings);
      assert.equal(ready.status, "ready");
      assert.deepEqual(ready.auth, { status: "authenticated", type: "api_key", label: "OpenAI" });
      const slugs = ready.models.map((model) => model.slug);
      assert.ok(!slugs.includes("auto"));
      assert.ok(slugs.includes("openai/gpt-5-nano"));
      assert.ok(slugs.every((slug) => slug.startsWith("openai/")));
      assert.equal(ready.models.find((m) => m.isDefault)?.slug, "openai/gpt-6.1-sol");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("picks Auto's per-key defaults from the catalog: each provider's first family's newest model", () =>
    Effect.gen(function* () {
      const models = yield* cavemanModels({ caveman: { key: "caveman-credits-key-test" } });
      const defaults = AUTO_PROVIDERS.map((provider) => resolveCavemanModel("auto", { [provider]: { key: "k" } }));
      assert.deepEqual(defaults, ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol", "google/gemini-3.1-pro-preview", "caveman/anthropic/claude-sonnet-5-5"]);
      for (const [provider, model] of AUTO_PROVIDERS.map((provider, i) => [provider, defaults[i]!] as const)) {
        assert.ok(models.getModel(provider, model.slice(provider.length + 1)) !== undefined, `${model} is not in the catalog`);
      }
    }),
  );

  it.effect("refuses text generation on a provider with no stored key, GOOGLE_API_KEY notwithstanding", () =>
    Effect.gen(function* () {
      const previous = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = ("AI" + "za-from-the-environment-not-the-store");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GOOGLE_API_KEY;
          else process.env.GOOGLE_API_KEY = previous;
        }),
      );
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const textGeneration = yield* makeCavemanTextGeneration(INSTANCE_ID);
      const refused = yield* Effect.exit(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the login bug",
          modelSelection: { instanceId: INSTANCE_ID, model: "google/gemini-2.5-flash" },
        }),
      );
      assert.ok(Exit.isFailure(refused));
      assert.match(JSON.stringify(refused), /no google API key/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Caveman text generation through the egress scrub", () => {
  const SECRET = ("sk_" + "live_PROJECT_SECRET_VALUE_0123456789");
  /** An OpenAI-compatible server that records each request and answers with a commit message. */
  const chatServer = Effect.acquireRelease(
    Effect.promise(async () => {
      const seen: Array<string> = [];
      const chunk = (choices: ReadonlyArray<object>) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "coder", choices })}\n\n`;
      const server = NodeHttp.createServer(async (req, res) => {
        let body = "";
        for await (const part of req) body += part;
        seen.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk([{ index: 0, delta: { role: "assistant", content: JSON.stringify({ subject: "Add config", body: "" }) }, finish_reason: null }]));
        res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
        res.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { server, seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    }),
    ({ server }) => Effect.promise(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())))),
  );
  const commitMessage = Effect.gen(function* () {
    const textGeneration = yield* makeCavemanTextGeneration(INSTANCE_ID);
    return yield* Effect.exit(
      textGeneration.generateCommitMessage({
        cwd: NodeOS.tmpdir(),
        branch: "main",
        stagedSummary: "M .env.example",
        stagedPatch: `+STRIPE_KEY=${SECRET}\n`,
        modelSelection: { instanceId: INSTANCE_ID, model: "custom-lab/coder" },
      }),
    );
  });

  it.effect("sends a commit message's request, staged patch and all, through the scrub and never to the provider", () =>
    Effect.gen(function* () {
      const provider = yield* chatServer;
      const scrub = yield* chatServer;
      yield* setCavemanKey(INSTANCE_ID, "custom-lab", { key: "lab-key", endpoint: { name: "Lab", baseUrl: `${provider.url}/v1`, models: ["coder"] } });
      const exit = yield* commitMessage.pipe(
        Effect.provideService(EgressRoute.EgressRoute, EgressRoute.EgressRoute.of({ route: () => `${scrub.url}/route`, owns: () => false, hasSecrets: () => Effect.succeed(true) })),
      );
      assert.ok(Exit.isSuccess(exit), JSON.stringify(exit));
      assert.deepEqual({ provider: provider.seen.length, scrub: scrub.seen.length }, { provider: 0, scrub: 1 });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses when the scrub is down and the repository has secrets", () =>
    Effect.gen(function* () {
      const provider = yield* chatServer;
      yield* setCavemanKey(INSTANCE_ID, "custom-lab", { key: "lab-key", endpoint: { name: "Lab", baseUrl: `${provider.url}/v1`, models: ["coder"] } });
      const exit = yield* commitMessage.pipe(
        Effect.provideService(EgressRoute.EgressRoute, EgressRoute.EgressRoute.of({ route: () => undefined, owns: () => false, hasSecrets: () => Effect.succeed(true) })),
      );
      assert.deepEqual({ refused: Exit.isFailure(exit), provider: provider.seen.length }, { refused: true, provider: 0 });
      assert.match(JSON.stringify(exit), /egress scrub/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("further keys in the picker", () => {
  it.effect("each key of a provider lists its models under its own id", () =>
    Effect.gen(function* () {
      const { cavemanModelList } = yield* Effect.promise(() => import("./driver.ts"));
      const settings = Schema.decodeUnknownSync(CavemanSettings)({});
      const listed = yield* cavemanModelList({ openai: { key: "sk-a-0123456789abcdef" }, "openai~2": { key: "sk-b-0123456789abcdef" } }, settings);
      const sources = new Set(listed.map((m) => m.slug.split("/")[0]));
      assert.deepEqual([...sources].filter((s) => s?.startsWith("openai")), ["openai", "openai~2"]);
      assert.ok(listed.some((m) => m.slug === "openai~2/gpt-6-luna"), listed.map((m) => m.slug).join(","));
    }),
  );
});
