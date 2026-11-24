// A Cloud computer's Caveman chats pay from its person's credits (agent-continuity.md "Caveman · credits or plan"),
// end to end inside the runtime: the computer's ProviderHost (ProviderHostLive, as server.ts builds it) asks the Cloud
// for a credits key with the computer's runtime token, holds it in memory only, puts it in the computer's scrubber,
// and the Caveman engine's credits models send it, current, on every request to the gateway that Cloud named. This
// Mac's ProviderHost holds none. Against the test Cloud's credits route (testCloud.ts), Caveman Cloud's own
// runtime/credits/key in the real-stack test (computerCredits.e2e.test.ts).
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { cavemanModels, readCavemanKeys } from "@caveman-app/provider-caveman/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import { tempRoot } from "../session-protocol/testHarness.ts";
import { CloudValues } from "./computerSecrets.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A stand-in gateway: every request's credential, answered with one streamed chat completion. */
async function gateway() {
  const keys: Array<string | undefined> = [];
  const server = http.createServer(async (request, response) => {
    for await (const _ of request);
    keys.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: "paid by credits" }));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, keys };
}

const hostOf = async (computer: Layer.Layer<never> | Layer.Layer<CloudComputer | CloudLinkState | CloudValues>, stateDir: string) => {
  const layer = ProviderHostLive.layer.pipe(
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    // The runtime's own secret store, on the state dir: the key must reach neither it nor anything else on disk.
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(computer),
    // NodeCrypto: what the secret store draws its key from, as server.ts provides it.
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ) as Layer.Layer<ProviderHost.ProviderHost | CloudValues, never, never>;
  const context = await Effect.runPromise(Effect.scoped(Layer.build(layer)));
  return { host: Context.get(context, ProviderHost.ProviderHost), context };
};

const filesHolding = (dir: string, needle: string): Array<string> =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const file = path.join(entry.parentPath, entry.name);
    return fs.readFileSync(file).includes(needle) ? [file] : [];
  });

test("a Cloud computer's Caveman engine pays from its person's credits: a key Cloud mints its runtime, in memory only, sent current on every request", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const gw = await gateway();
  cloud.state.environments.credits.on = true;
  cloud.state.environments.credits.gateway = gw.url;
  const linkDir = path.join(tempRoot("credits-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const values = { seen: new Map<string, string>(), version: 0 };
  const stateDir = tempRoot("credits-computer-");
  const computer = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: tempRoot("credits-workspace-") }),
    Layer.succeed(CloudLinkState, {}),
    Layer.succeed(CloudValues, values),
  );
  const { host } = await hostOf(computer, stateDir);
  expect(host.credits).toBeDefined();

  // The engine's keys on the computer: credits are offered, and reading them (a model list, a status probe) asks Cloud
  // for nothing.
  const keys = await Effect.runPromise(readCavemanKeys(ProviderInstanceId.make("caveman")).pipe(Effect.provideService(ProviderHost.ProviderHost, host)));
  const minted = cloud.state.environments.credits.minted;
  expect(keys.caveman).toBeDefined();
  expect(minted).toHaveLength(0);

  // A credits model's first request asks for the key Cloud mints this runtime, and sends it to the gateway Cloud named.
  const models = await Effect.runPromise(cavemanModels(keys));
  const model = models.getModel("caveman", "deepseek/deepseek-flash")!;
  const ask = (m = models) => m.complete(m.getModel("caveman", "deepseek/deepseek-flash")!, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
  expect(model).toBeDefined();
  expect((await ask()).content).toEqual([expect.objectContaining({ type: "text", text: "paid by credits" })]);
  expect(minted).toHaveLength(1);
  expect(minted[0]!.runtimeId).toBe(identity.runtimeId);
  expect(gw.keys).toEqual([`Bearer ${minted[0]!.key}`]);
  // It joined the computer's scrubber, and nothing of it reached the disk.
  expect([...values.seen.values()]).toContain(minted[0]!.key);
  expect(filesHolding(stateDir, minted[0]!.key)).toEqual([]);
  expect(filesHolding(linkDir, minted[0]!.key)).toEqual([]);
  // Held now: a read shows it, and the next request sends it, nothing minted again.
  const held = await Effect.runPromise(readCavemanKeys(ProviderInstanceId.make("caveman")).pipe(Effect.provideService(ProviderHost.ProviderHost, host)));
  expect({ key: held.caveman?.key, gateway: held.caveman?.gateway }).toEqual({ key: minted[0]!.key, gateway: gw.url });
  await ask();
  expect(gw.keys).toEqual([`Bearer ${minted[0]!.key}`, `Bearer ${minted[0]!.key}`]);
  expect(minted).toHaveLength(1);

  // The runtime builds more than one ProviderHost: they share this computer's key, and nothing is minted again.
  const again = await hostOf(computer, tempRoot("credits-computer-again-"));
  expect(again.host.credits).toBe(host.credits);

  // Cloud refuses a computer (its computer shared with another person's work): its first request fails, sending
  // nothing, and from then on it offers no credits.
  cloud.state.environments.credits.refusal = { status: 403, code: "cave_code_computer_shared" };
  const otherLink = path.join(tempRoot("credits-link-2-"), "link");
  const other = await enroll({ dir: otherLink, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "shared computer" });
  const refused = await hostOf(
    Layer.mergeAll(
      Layer.succeed(CloudComputer, { linkDir: otherLink, computerId: other.computerId, workspaceRoot: tempRoot("credits-workspace-2-") }),
      Layer.succeed(CloudLinkState, {}),
      Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
    ),
    tempRoot("credits-computer-2-"),
  );
  const offered = await Effect.runPromise(readCavemanKeys(ProviderInstanceId.make("caveman")).pipe(Effect.provideService(ProviderHost.ProviderHost, refused.host)));
  const failed = await ask(await Effect.runPromise(cavemanModels(offered)));
  expect(failed.stopReason).toBe("error");
  expect(gw.keys).toHaveLength(2);
  const after = await Effect.runPromise(readCavemanKeys(ProviderInstanceId.make("caveman")).pipe(Effect.provideService(ProviderHost.ProviderHost, refused.host)));
  expect(after.caveman).toBeUndefined();
}, 60_000);

test("This Mac's engine has no computer's credits: its ProviderHost holds none and asks Cloud nothing", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.environments.credits.on = true;
  const { host } = await hostOf(Layer.succeed(CloudComputer, undefined) as never, tempRoot("credits-mac-"));
  expect(host.credits).toBeUndefined();
  const keys = await Effect.runPromise(readCavemanKeys(ProviderInstanceId.make("caveman")).pipe(Effect.provideService(ProviderHost.ProviderHost, host)));
  expect(keys.caveman).toBeUndefined();
  expect(cloud.state.environments.credits.minted).toEqual([]);
});
