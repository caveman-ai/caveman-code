// Settings > Models & keys > Web search over the Session Protocol: a key is checked, kept sealed and shown only by
// its tail; one the provider refuses is key_refused and not stored; a limited provider keeps the key with a note;
// clear forgets it. `credits` follows the Caveman credits key. No key ever comes back or lands in the journal. The
// keys are the runtime's owner's, as its other secrets are: another person's device reaches none of web.keys.*.
import * as fs from "node:fs";

import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { setCavemanKey } from "@caveman-app/provider-caveman/server";
import { connect } from "@caveman-app/session-protocol";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { OUTSIDE_WEB_KEY } from "../cloudLink/credentialRule.ts";
import { cloudComputerUnderRule } from "../cloudLink/credentialRule.testkit.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import { allowedStream } from "./devices.testkit.ts";
import { makeInsideComputer } from "./insideComputer.ts";
import { makeConfig, startRuntime, until } from "./testHarness.ts";
import { makeWebKeyHandlers } from "./webKeys.ts";

const KEY = "BSA-web-test-key-0123456789abcd";

describe("web search keys over the Session Protocol", () => {
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  let host!: ProviderHost.ProviderHost["Service"];

  beforeAll(async () => {
    const hostLayer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
    const capture = Layer.effectDiscard(
      Effect.gen(function* () {
        host = yield* ProviderHost.ProviderHost;
      }),
    ).pipe(Layer.provide(hostLayer));
    config = await makeConfig();
    // The harness stubs the check search: "refused" is refused, "limited" is rate limited, any other works.
    runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(hostLayer, capture) });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
  });

  const reason = (promise: Promise<unknown>) =>
    promise.then(
      () => ({ reason: "ok", message: "" }),
      (error: { error?: { data?: { reason?: string }; message?: string } }) => ({ reason: error.error?.data?.reason, message: error.error?.message }),
    );
  const none = [
    { id: "brave", configured: false },
    { id: "perplexity", configured: false },
    { id: "exa", configured: false },
    { id: "firecrawl", configured: false },
  ];

  test("set, refuse, note, clear, and credits", async () => {
    expect(await client.call("web.keys.status", {})).toEqual({ providers: none, credits: false, firecrawl_local: false });

    const set = await client.call("web.keys.set", { request_id: "wk1", provider: "brave", key: KEY });
    expect(set).toEqual({ providers: [{ id: "brave", configured: true, hint: "...abcd" }, none[1], none[2], none[3]], credits: false, firecrawl_local: false });

    expect(await reason(client.call("web.keys.set", { request_id: "wk2", provider: "perplexity", key: "pplx-refused-key-000000" }))).toEqual({
      reason: "key_refused",
      message: "Perplexity refused the key (401: invalid key). It was not saved.",
    });
    expect((await client.call("web.keys.status", {})).providers[1]).toEqual({ id: "perplexity", configured: false });

    const limited = await client.call("web.keys.set", { request_id: "wk3", provider: "exa", key: "exa-limited-key-000000" });
    expect(limited.note).toBe("Saved. Exa is rate limiting it right now: 429: slow down");
    expect(limited.providers[2]).toEqual({ id: "exa", configured: true, hint: "...0000" });

    await Effect.runPromise(setCavemanKey(ProviderInstanceId.make("caveman"), "caveman", "cave_live_credits_key_0123").pipe(Effect.provideService(ProviderHost.ProviderHost, host)));
    expect((await client.call("web.keys.status", {})).credits).toBe(true);

    expect((await client.call("web.keys.clear", { request_id: "wk4", provider: "brave" })).providers[0]).toEqual({ id: "brave", configured: false });

    // The key never reached the runtime's database (journal, receipts, settings).
    for (const file of [config.dbPath, `${config.dbPath}-wal`]) {
      if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(KEY)).toBe(false);
    }
  });
});

describe("web search keys on a Cloud computer that keeps nothing of its person's", () => {
  test("a key is refused before it is checked with its provider; one an earlier run kept still shows and can be cleared", async () => {
    // The rule comes on while the computer runs (Cloud refuses a credential route).
    const computer = cloudComputerUnderRule(false);
    const checked: Array<string> = [];
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const handlers = makeWebKeyHandlers(Option.some(yield* ProviderHost.ProviderHost), async (_provider, key) => (checked.push(key), { ok: true }), () => true, yield* makeInsideComputer, () => undefined);
        const ctx = { connectionId: "c" };
        const before = yield* handlers["web.keys.set"]({ request_id: "w1", provider: "brave", key: KEY }, ctx);
        computer.turnOn();
        const refused = yield* Effect.flip(handlers["web.keys.set"]({ request_id: "w2", provider: "exa", key: "exa-web-test-key-0123456789abcd" }, ctx));
        const status = yield* handlers["web.keys.status"]({}, ctx);
        const cleared = yield* handlers["web.keys.clear"]({ request_id: "w3", provider: "brave" }, ctx);
        return { before, refused: { reason: refused.reason, message: refused.message }, status, cleared };
      }).pipe(Effect.provide(computer.layer), Effect.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))), Effect.scoped),
    );
    expect(out.before.providers[0]).toEqual({ id: "brave", configured: true, hint: "...abcd" });
    expect(out.refused).toEqual({ reason: "unsupported", message: OUTSIDE_WEB_KEY });
    // The refused key went nowhere: only the first was ever sent to a provider, and only it is kept.
    expect(checked).toEqual([KEY]);
    expect(out.status.providers).toEqual([{ id: "brave", configured: true, hint: "...abcd" }, { id: "perplexity", configured: false }, { id: "exa", configured: false }, { id: "firecrawl", configured: false }]);
    expect(out.cleared.providers[0]).toEqual({ id: "brave", configured: false });
  });
});

describe("web search keys belong to the runtime's owner", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const reasonIn = (reply: { error?: unknown }) => (reply.error as { data?: { reason?: string } } | undefined)?.data?.reason ?? "ok";

  test("a device This Mac allowed for another person of the org can neither read, replace nor clear them", async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    // A Mac that names its owner takes no other person's device at all (devices.ts). One whose sign-in names nobody
    // still asks its screen about any device, so there a person its screen let in is not its owner.
    cloud.state.enrollWithoutPerson = true;
    const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)) });
    cleanups.push(runtime.close);
    const local = connect(runtime.url, runtime.token);
    cleanups.push(() => local.close());
    await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
    await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
    await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
    const relay = cloud.state.relays[0]!;
    await local.call("web.keys.set", { request_id: "owner-brave", provider: "brave", key: KEY });

    // The screen allowed a device of user-2, in the owner's org: its calls run as cloud:user-2.
    const other = await allowedStream(relay, local, undefined, relay.open({ user_id: "user-2", organization_id: cloud.state.organizationId }));
    const status = await other.call("web.keys.status", {});
    const cleared = await other.call("web.keys.clear", { request_id: "other-clear", provider: "brave" });
    const planted = await other.call("web.keys.set", { request_id: "other-exa", provider: "exa", key: "exa-other-person-key-0000" });
    expect({ status: reasonIn(status), clear: reasonIn(cleared), set: reasonIn(planted), owners: (await local.call("web.keys.status", {})).providers }).toEqual({
      status: "forbidden",
      clear: "forbidden",
      set: "forbidden",
      owners: [
        { id: "brave", configured: true, hint: "...abcd" },
        { id: "perplexity", configured: false },
        { id: "exa", configured: false },
        { id: "firecrawl", configured: false },
      ],
    });
  }, 120_000);
});
