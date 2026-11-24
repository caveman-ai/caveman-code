// The kept Caveman sign-in at rest: sealed like a repository secret (never in
// the clear on disk, so an engine's shell reads only ciphertext), its tokens
// scrubbed from what agents and transcripts see, its Cloud URL left readable,
// and a sign-in an earlier build kept unsealed moved in on first read.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ACCOUNT_SECRET, type AccountSession, type AccountStore } from "../cloudLink/account.ts";
import { HOSTED_CLOUD } from "../cloudLink/hosted.ts";
import * as ServerConfig from "../config.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import { makeAccountHandlers, makeAccountStore } from "./account.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-account-store-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const SESSION = { cloud_url: "https://app.caveman.example", access_token: "cave_access_0123456789abcdef0123", refresh_token: "cave_refresh_0123456789abcdef0123", routing_key: "cave_router_secret_0123456789abcdef", routing_expires_at: "2099-01-01T00:00:00Z", gateway_url: "https://gateway.caveman.example" };

const inStateDir = <A>(stateDir: string, body: Effect.Effect<A, unknown, ProjectSecrets | ServerSecretStore.ServerSecretStore>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        ProjectSecretsLive.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), stateDir))),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

const bytesUnder = (dir: string) =>
  Buffer.concat(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => fs.readFileSync(path.join(d.parentPath, d.name))));

test("the sign-in is sealed on disk, its tokens are scrubbed, and sign-out leaves nothing", async () => {
  const stateDir = fs.mkdtempSync(path.join(base, "sealed-"));
  const scrubbed = await inStateDir(
    stateDir,
    Effect.gen(function* () {
      const store = yield* makeAccountStore;
      yield* Effect.promise(() => store.save({ ...SESSION, credits_key_id: "0b4f0d7e-1111-4222-8333-944455556666" }));
      expect(yield* Effect.promise(() => store.load())).toEqual({ ...SESSION, credits_key_id: "0b4f0d7e-1111-4222-8333-944455556666" });
      const scrubber = yield* (yield* ProjectSecrets).scrubber;
      return scrubber.scrub(`token ${SESSION.access_token} refresh ${SESSION.refresh_token} router ${SESSION.routing_key} at ${SESSION.cloud_url}`);
    }),
  );
  expect(scrubbed).not.toContain(SESSION.access_token);
  expect(scrubbed).not.toContain(SESSION.refresh_token);
  expect(scrubbed).not.toContain(SESSION.routing_key);
  expect(scrubbed).toContain(SESSION.cloud_url);
  const disk = bytesUnder(stateDir);
  expect(disk.includes(SESSION.access_token)).toBe(false);
  expect(disk.includes(SESSION.refresh_token)).toBe(false);
  expect(disk.includes(SESSION.routing_key)).toBe(false);

  // A restarted runtime reads it back; signing out removes every field.
  await inStateDir(
    stateDir,
    Effect.gen(function* () {
      const store = yield* makeAccountStore;
      expect((yield* Effect.promise(() => store.load()))?.access_token).toBe(SESSION.access_token);
      yield* Effect.promise(() => store.save(undefined));
      expect(yield* Effect.promise(() => store.load())).toBeUndefined();
    }),
  );
});

test("a sign-in an earlier build kept unsealed is sealed on first read and its plain file removed", async () => {
  const stateDir = fs.mkdtempSync(path.join(base, "legacy-"));
  await inStateDir(
    stateDir,
    Effect.gen(function* () {
      const plain = yield* ServerSecretStore.ServerSecretStore;
      yield* plain.set(ACCOUNT_SECRET, new TextEncoder().encode(JSON.stringify(SESSION)));
      const store = yield* makeAccountStore;
      expect(yield* Effect.promise(() => store.load())).toEqual({ cloud_url: SESSION.cloud_url, access_token: SESSION.access_token, refresh_token: SESSION.refresh_token });
      expect(Option.isNone(yield* plain.get(ACCOUNT_SECRET))).toBe(true);
    }),
  );
  expect(bytesUnder(stateDir).includes(SESSION.access_token)).toBe(false);
});

/** account.credits on a kept sign-in: what Cloud was asked, and what the engine's credits slot was given. */
async function creditsOn(session: AccountSession) {
  let kept: AccountSession | undefined = session;
  const store: AccountStore = { load: async () => kept, save: async (next) => void (kept = next) };
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ id: "0b4f0d7e-1111-4222-8333-944455556666", full_key: "cave_live_credits_0123456789abcdef" }), { status: 201 });
  }) as unknown as typeof fetch;
  const given: Array<[string | null, string | undefined]> = [];
  const handlers = makeAccountHandlers(store, () => true, { set: (key, gateway) => Effect.sync(() => given.push([key, gateway])), has: Effect.succeed(false) }, fetchImpl);
  const result = await Effect.runPromise(handlers["account.credits"]({ request_id: "on", enabled: true } as never, { connectionId: "c" }).pipe(Effect.result));
  return { result, asked, given };
}

test("credits: the hosted Cloud's key is kept as before; another Cloud's runs on its own gateway, and none is minted without one", async () => {
  const hosted = await creditsOn({ cloud_url: HOSTED_CLOUD, access_token: "cave_access_hosted_0123456789" });
  expect(hosted.given).toEqual([["cave_live_credits_0123456789abcdef", undefined]]);
  expect(hosted.asked).toEqual([`${HOSTED_CLOUD}/api/v1/code/credits/keys`]);

  const own = await creditsOn({ cloud_url: "https://app.customer.example", access_token: "cave_access_own_0123456789", gateway_url: "https://gateway.customer.example" });
  expect(own.given).toEqual([["cave_live_credits_0123456789abcdef", "https://gateway.customer.example"]]);
  expect(own.asked).toEqual(["https://app.customer.example/api/v1/code/credits/keys"]);

  const nowhere = await creditsOn({ cloud_url: "https://app.customer.example", access_token: "cave_access_own_0123456789" });
  expect(nowhere.result._tag).toBe("Failure");
  expect(JSON.stringify(nowhere.result)).toContain("did not say where its gateway is");
  expect([nowhere.asked, nowhere.given]).toEqual([[], []]);
});
