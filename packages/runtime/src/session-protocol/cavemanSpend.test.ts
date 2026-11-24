// A Caveman engine turn over the Session Protocol emits one usage event with
// its tokens and the engine's measured list price, and spend.summary counts it
// under the Caveman engine. The engine is real; only its model is scripted (no
// network, no paid call).
import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, CavemanAdapterV2Driver, makeCavemanAdapterV2 } from "@caveman-app/provider-caveman/server";
import { fauxModel, scriptedStream } from "@caveman-app/provider-caveman/testing";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "./testHarness.ts";

let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let root: string;

beforeAll(async () => {
  root = tempRoot("sp-caveman-spend-");
  const host = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
  const scripted: typeof CavemanAdapterV2Driver = {
    ...CavemanAdapterV2Driver,
    create: (input) =>
      makeCavemanAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        engine: {
          streamFn: scriptedStream([{ text: "Caveman done.", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 } }]),
          model: fauxModel({ priced: true }),
        },
      }).pipe(Effect.orDie),
  };
  const registry = ProviderAdapterRegistry.layerFromDrivers({
    drivers: [scripted],
    configMap: { [ProviderInstanceId.make("caveman")]: { driver: CAVEMAN_PROVIDER, config: { optimization: "off" } } },
  }).pipe(Layer.provide(Layer.mergeAll(host, IdAllocator.layer, NodeServices.layer)), Layer.orDie);
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: host, registry });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a finished Caveman turn emits one priced usage event and spend.summary counts it under the Caveman engine", async () => {
  await client.call("engine.account.add", { request_id: "k1", engine: "caveman", provider: "anthropic", key: ("sk-" + "ant-caveman-spend-test-0123456789") });
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", {
    request_id: "w1",
    repo: { path: repo },
    title: "caveman spend",
    engine: "caveman",
    options: { model: "anthropic/claude-haiku-4-5" },
    task: { text: "say done" },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  expect(events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []))).toEqual(["Caveman done."]);
  await until(() => events.some((e) => e.type === "usage"), 5_000);

  const usage = events.filter((e) => e.type === "usage");
  expect(usage).toHaveLength(1);
  const payload = usage[0]!.payload;
  // Input is reported apart from cache reads and writes.
  expect(payload).toMatchObject({ engine: "caveman", input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 10 });
  expect(payload.cost?.basis).toBe("list_price");
  expect(payload.cost?.usd).toBeGreaterThan(0);

  const byEngine = await client.call("spend.summary", { group_by: "engine" });
  expect(byEngine.rows.find((r) => r.key === "caveman")).toMatchObject({
    input_tokens: 100,
    output_tokens: 20,
    measured_usd: payload.cost!.usd,
    basis: "list_price",
  });
});
