// Test-only: one runtime process for signInOnce.e2e.test.ts, the real runtime (session protocol, engine accounts,
// egress scrub, a real pty) as This Mac (SIO_ROLE=mac: enrolled with SIO_BEARER when given, else not signed in to
// Caveman) or as a Cloud computer's runtime under the credential rule (SIO_ROLE=cloud: SIO_LINK_DIR holds the
// identity the test enrolled, SIO_WORKSPACE the checkout). A process of its own because a Mac's link state is one per
// process, and so that HOME and PATH are the test's: HOME is a scratch folder (this Mac's real ~/.claude and ~/.codex
// are never there to open) and the only `claude` and `codex` on PATH are the stand-ins (scripts/fake-plan-clis.mjs,
// scripts/smoke-claude.mjs).
//
// The providers are the test Cloud's (SIO_CLOUD_URL, /__provider/...): where the egress scrub sends a request it
// attached a credential to. Writes {url, token, stateDir, control, runtimeId} to SIO_OUT once it serves.
//
// `control` is one more local endpoint, for what the test harness has no engine for: POST /codex {session, words}
// launches Codex the way the Codex adapter does (the same launch environment, the same model provider arguments
// through the scrub) and makes one model request with the stand-in `codex`, as codex makes it.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { appProxy, codexProxy } from "../router/proxyLauncher.ts";
import { routeCodexLaunch } from "../secrets/EngineEgress.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { makeConfig, startRuntime } from "../session-protocol/testHarness.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { CloudValues, layerBroker } from "./computerSecrets.ts";
import { withEngineKey } from "./engineKeys.ts";
import { enroll, readIdentity } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf, type LinkState } from "./index.ts";
import { publishTestRuntimeReady } from "./testRuntimeReady.ts";

const role = process.env.SIO_ROLE;
const cloudUrl = process.env.SIO_CLOUD_URL!;
const bin = process.env.SIO_BIN!;
const out = process.env.SIO_OUT!;

// The providers' own APIs, as the scrub reaches them once it holds the credential itself.
(appProxy as { url: () => string | undefined }).url = () => `${cloudUrl}/__provider/claude`;
(codexProxy as { url: () => string | undefined }).url = () => `${cloudUrl}/__provider/codex`;

const config = await makeConfig();
const link: LinkState =
  role === "cloud"
    ? {}
    : await Effect.runPromise(
        Effect.gen(function* () {
          return yield* CloudLinkState;
        }),
      );
const computer =
  role === "cloud"
    ? {
        linkDir: process.env.SIO_LINK_DIR!,
        computerId: readIdentity(process.env.SIO_LINK_DIR!)!.computerId,
        workspaceRoot: process.env.SIO_WORKSPACE!,
      }
    : undefined;
if (role === "mac" && process.env.SIO_BEARER)
  await enroll({
    dir: linkDirOf(config.stateDir),
    cloudUrl,
    bearer: process.env.SIO_BEARER,
    name: process.env.SIO_NAME ?? "A Mac",
  });
const runtimeId = (
  computer ? readIdentity(computer.linkDir) : readIdentity(linkDirOf(config.stateDir))
)?.runtimeId;

const runtime = await startRuntime(config, "fake-claude", undefined, {
  egress: true,
  claudeBinary: path.join(bin, "claude"),
  // A real pty, as the desktop app's runtime has: the official CLIs' sign-ins run in it.
  provide: NodePtyAdapter.layer.pipe(Layer.orDie),
  ...(computer ? { cloudComputer: { computer, link } } : {}),
});
const egress = Context.get(runtime.context as unknown as Context.Context<EgressRoute>, EgressRoute);
// What server.ts gives a Cloud computer beside the route: its broker, which joins the engines' launches to Cloud.
if (computer) {
  await Effect.runPromise(
    Layer.buildWithScope(
      layerBroker.pipe(
        Layer.provideMerge(ServerSettingsModule.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(CloudComputer, computer),
            Layer.succeed(CloudLinkState, link),
            Layer.succeed(CloudValues, { seen: new Map(), version: 0 }),
          ),
        ),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ) as Layer.Layer<any, unknown, never>,
      await Effect.runPromise(Scope.make()),
    ),
  );
}

/** Codex's default account's home here: the runtime's own, where its adapter launches it. */
const codexHome = path.join(config.stateDir, "providers", "codex", "codex", "home");
const codexTurn = async (session: string, words: string) => {
  fs.mkdirSync(codexHome, { recursive: true });
  const launch = await Effect.runPromise(
    Effect.result(
      withEngineKey(
        "codex",
        { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: codexHome },
        undefined,
        session,
      ).pipe(
        Effect.provideService(CloudLinkState, link),
        Effect.provideService(CloudComputer, computer),
        Effect.provideService(EgressRoute, egress),
      ) as Effect.Effect<
        Record<string, string | undefined> | undefined,
        { readonly detail?: string }
      >,
    ),
  );
  if (launch._tag === "Failure") return { unavailable: launch.failure.detail ?? "unavailable" };
  const env = launch.success ?? {};
  const routed = routeCodexLaunch({
    egress,
    configText: "",
    launchArgs: undefined,
    environment: env,
  });
  if ("unroutable" in routed) return { unavailable: routed.unroutable };
  return new Promise<{ out: string; code: number; home: string | undefined; stoodIn: boolean }>(
    (resolve) => {
      execFile(
        path.join(bin, "codex"),
        [...routed.args, "exec", words],
        { env: env as NodeJS.ProcessEnv },
        (error, stdout) => {
          const auth =
            env.CODEX_HOME && fs.existsSync(path.join(env.CODEX_HOME, "auth.json"))
              ? fs.readFileSync(path.join(env.CODEX_HOME, "auth.json"), "utf8")
              : "";
          resolve({
            out: stdout.trim(),
            code: error ? 1 : 0,
            home: env.CODEX_HOME,
            stoodIn: auth.includes("caveman-stand-in"),
          });
        },
      );
    },
  );
};

const control = http.createServer((request, response) => {
  const chunks: Array<Buffer> = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const asked = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      session?: string;
      words?: string;
    };
    void codexTurn(asked.session ?? "s", asked.words ?? "say where you ran").then(
      (answer) => (
        response.writeHead(200, { "content-type": "application/json" }),
        response.end(JSON.stringify(answer))
      ),
      (error: unknown) => (
        response.writeHead(500, { "content-type": "application/json" }),
        response.end(JSON.stringify({ error: String(error) }))
      ),
    );
  });
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));

fs.mkdirSync(path.dirname(out), { recursive: true });
publishTestRuntimeReady(out, {
  url: runtime.url,
  token: runtime.token(),
  stateDir: config.stateDir,
  baseDir: config.baseDir,
  control: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
  runtimeId,
});
setInterval(() => {}, 1 << 30);
