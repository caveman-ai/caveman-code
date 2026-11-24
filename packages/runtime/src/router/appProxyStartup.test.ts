// The runtime keeps its app proxies and Cloud off the startup path (session-protocol/index.ts forks the proxies, and the
// routing key's first refresh runs beside the routes): every route answers while a proxy is still starting or Cloud is
// not answering. Turning credits on still returns with the proxies' credential written, whatever their start is doing.
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { connect } from "@caveman-app/session-protocol";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { AccountSession } from "../cloudLink/account.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import { makeAccountStore } from "../session-protocol/account.ts";
import { makeConfig, startRuntime, until } from "../session-protocol/testHarness.ts";
import {
  AppProxy,
  AppProxyLauncher,
  type AppProxyStates,
  ensureAppProxy,
} from "./proxyLauncher.ts";

type Config = Awaited<ReturnType<typeof makeConfig>>;

/** A sign-in an earlier run kept, sealed in the state dir's secret store as the runtime keeps it. */
const keptSignIn = (config: Config, session: AccountSession) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeAccountStore;
      yield* Effect.promise(() => store.save(session));
    }).pipe(
      Effect.provide(
        ProjectSecretsLive.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

/** App proxies whose start takes until `release`; once released they take the sign-in as the real launcher does. */
const slowProxies = () => {
  let release!: () => void;
  const up = new Promise<void>((resolve) => (release = resolve));
  const state = { launches: 0, release };
  const layer = Layer.succeed(AppProxyLauncher, async (): Promise<AppProxyStates> => {
    state.launches++;
    await up;
    const app = await ensureAppProxy(new AppProxy({ env: {} }), {});
    return { app, codex: app };
  }) as unknown as Layer.Layer<any>;
  return { state, layer };
};

const within = <A>(ms: number, promise: Promise<A>, late: string) =>
  Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve(late), ms))]);

test("the runtime serves while its app proxies are still starting", async () => {
  const proxies = slowProxies();
  const config = await makeConfig();
  const starting = startRuntime(config, "fake-claude", undefined, { provide: proxies.layer });
  try {
    expect(
      await within(
        20_000,
        starting.then(() => "serving"),
        "waiting on the proxies",
      ),
    ).toBe("serving");
    expect(proxies.state.launches).toBeGreaterThan(0);
  } finally {
    proxies.state.release();
    await (await starting).close();
    fs.rmSync(config.stateDir, { recursive: true, force: true });
  }
}, 60_000);

test("the runtime serves while Cloud never answers the refresh of a sign-in that is about to expire", async () => {
  // Cloud's packets dropped (a VPN, a firewall): it takes the connection and never says anything.
  const sockets = new Set<net.Socket>();
  let asked = 0;
  const cloud = net.createServer((socket) => {
    asked++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const config = await makeConfig();
  // Its access token expired overnight, so the routing key's refresh first refreshes the sign-in at Cloud.
  const expired = `${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url")}.sig`;
  await keptSignIn(config, {
    cloud_url: `http://127.0.0.1:${(cloud.address() as net.AddressInfo).port}`,
    access_token: expired,
    refresh_token: "cave_refresh_silent_fake",
  });
  const starting = startRuntime(config, "fake-claude");
  try {
    const served = within(
      20_000,
      starting.then(async (runtime) => {
        const client = connect(runtime.url, runtime.token);
        try {
          await client.call("settings.get", {});
          return "serving";
        } finally {
          client.close();
        }
      }),
      "waiting on Cloud",
    );
    expect(await served).toBe("serving");
    // It did ask, and goes on asking beside the routes.
    await until(() => asked > 0, 5_000);
  } finally {
    // Ends the refresh still waiting, so a runtime held at start can close.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    await (await starting).close();
    fs.rmSync(config.stateDir, { recursive: true, force: true });
  }
}, 60_000);

test("turning credits on returns with the proxies' credential carrying Auto, while the proxies are still starting", async () => {
  const creditsKey = `cave_live_${randomBytes(12).toString("hex")}`;
  const cloud = http.createServer((request, response) => {
    request.resume();
    const json = (status: number, value: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.url === "/api/v1/code/credits/keys" && request.method === "POST")
      return json(201, { id: randomUUID(), full_key: creditsKey });
    // A plan without Auto of its own: credits are what route.
    if (request.url === "/api/v1/code/router/keys")
      return json(402, { error: { code: "cave_code_router_paid_required" } });
    json(404, { error: { code: "not_found" } });
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const cloudUrl = `http://127.0.0.1:${(cloud.address() as net.AddressInfo).port}`;
  const config = await makeConfig();
  await keptSignIn(config, {
    cloud_url: cloudUrl,
    access_token: "cave_access_credits_fake",
    refresh_token: "cave_refresh_credits_fake",
    gateway_url: cloudUrl,
  });
  const proxies = slowProxies();
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(
      proxies.layer,
      TestProviderHost.layer().pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ) as Layer.Layer<any>,
  });
  const client = connect(runtime.url, runtime.token);
  try {
    expect(
      await within(
        20_000,
        client.call("account.credits", { request_id: "on", enabled: true }),
        "waiting on the proxies",
      ),
    ).toEqual({ enabled: true });
    // A chat started now finds Auto (routingConfigured reads this file), though neither proxy has finished starting.
    const home = path.join(config.stateDir, "proxy");
    expect(JSON.parse(fs.readFileSync(path.join(home, "cloud.json"), "utf8"))).toMatchObject({
      baseURL: cloudUrl,
      modules: { routing: true },
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, "credentials"), "utf8"))).toEqual({
      access_token: "cave_access_credits_fake",
      gateway_api_key: creditsKey,
    });
    expect(proxies.state.launches).toBeGreaterThan(0);
  } finally {
    proxies.state.release();
    client.close();
    await runtime.close();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    fs.rmSync(config.stateDir, { recursive: true, force: true });
  }
}, 60_000);
