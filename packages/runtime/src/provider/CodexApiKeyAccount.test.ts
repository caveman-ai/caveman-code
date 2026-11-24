// API-key accounts: the launch an instance gets, and Codex's own login into
// the app-managed home, run against the installed `codex` (skipped when it is
// not on PATH). A fake key is enough: Codex stores it without calling OpenAI,
// and the key check after the login goes to a fake OpenAI on 127.0.0.1.
import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@caveman-app/protocol";
import { tokenizeCliArgs } from "@caveman-app/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  AMBIENT_CODEX_VARIABLES,
  CODEX_API_KEY_METHOD_ID,
  codexHomeIsReal,
  ensureCodexManagedHome,
  loginCodexApiKey,
  makeCodexApiKeyAuth,
  removeCodexAccount,
  resolveCodexLaunch,
  type CodexLaunch,
} from "./CodexApiKeyAccount.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";

const settings = Schema.decodeSync(CodexSettings)({});
const instanceId = ProviderInstanceId.make("codex_work");
const FAKE_KEY = "sk-caveman-test-not-a-real-key";
const MANAGED_ARGV = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'forced_login_method="api"',
];

const probeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-key-probe-"));
const hasCodex =
  spawnSync("codex", ["--version"], {
    env: { ...process.env, CODEX_HOME: probeHome, HOME: probeHome, XDG_CONFIG_HOME: probeHome },
    timeout: 10_000,
  }).status === 0;
NodeFS.rmSync(probeHome, { recursive: true, force: true });
const FAKE_CODEX = NodePath.join(import.meta.dirname, "../../scripts/fake-codex.mjs");

/**
 * A stand-in for OpenAI's GET /v1/models: 401 for a key containing "bad", 401
 * "Missing scopes" for one containing "scoped" (a restricted key), no answer
 * for one containing "hang", else 200.
 */
const fakeOpenAi = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const server = NodeHttp.createServer((req, res) => {
      const authorization = req.headers.authorization ?? "";
      seen.push({ url: req.url, authorization: req.headers.authorization });
      if (authorization.includes("hang")) return;
      if (authorization.includes("scoped")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.model.read.","code":null}}');
      }
      res.writeHead(authorization.includes("bad") ? 401 : 200, { "content-type": "application/json" });
      res.end('{"data":[]}');
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    return { server, seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
  }),
  ({ server }) => Effect.promise(() => new Promise((closed) => (server.closeAllConnections(), server.close(closed)))),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CodexApiKeyAccount", (it) => {
  // Skipped on Windows: a Cloud computer is a Linux pod (group-shared homes, O_NOFOLLOW chmod).
  it.effect.skipIf(process.platform === "win32")("on a Cloud computer: one home for every account under providers/codex/active, never chmodded or read through a symlink", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-computer-"));
      const saved = process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = "127.0.0.1:1";
      try {
        const active = NodePath.join(stateDir, "providers", "codex", "active", "home");
        for (const id of ["codex", "codex-account-1a2b3c4d"]) {
          assert.strictEqual(resolveCodexLaunch({ path, stateDir, instanceId: ProviderInstanceId.make(id), config: settings, environment: {} }).config.homePath, active);
        }
        const launch = resolveCodexLaunch({ path, stateDir, instanceId, config: settings, environment: {} });
        yield* ensureCodexManagedHome(launch);
        assert.strictEqual(NodeFS.statSync(active).mode & 0o777, 0o770);
        assert.isTrue(codexHomeIsReal(active));
        // The agent swaps the home for a symlink to the runtime's own state: the runtime refuses it.
        const runtimeOwn = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-own-"));
        NodeFS.chmodSync(runtimeOwn, 0o700);
        NodeFS.rmSync(active, { recursive: true });
        NodeFS.symlinkSync(runtimeOwn, active);
        assert.isFalse(codexHomeIsReal(active));
        const refused = yield* Effect.flip(ensureCodexManagedHome(launch));
        assert.include(String(refused), "not a directory the runtime made");
        assert.strictEqual(NodeFS.statSync(runtimeOwn).mode & 0o777, 0o700);
        NodeFS.rmSync(runtimeOwn, { recursive: true, force: true });
      } finally {
        if (saved === undefined) delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
        else process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = saved;
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("gives API-key accounts their own managed home and drops ambient credentials", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const ambient = {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-ambient",
        CODEX_API_KEY: "sk-ambient",
        OPENAI_BASE_URL: "https://elsewhere.example",
        CODEX_HOME: "/Users/someone/.codex",
        CAVEMAN_CODE_CODEX_LAUNCH_ARGS: "-c model_provider=elsewhere",
      };
      const launch = resolveCodexLaunch({
        path,
        stateDir: "/state",
        instanceId,
        config: { ...settings, homePath: "~/.codex", launchArgs: "--enable foo" },
        environment: ambient,
      });
      assert.isTrue(launch.managed);
      assert.strictEqual(launch.config.homePath, path.join("/state", "providers", "codex", "codex_work", "home"));
      assert.strictEqual(launch.config.shadowHomePath, "");
      // The managed flags come last so the user's arguments cannot undo them.
      assert.deepEqual(tokenizeCliArgs(launch.config.launchArgs), [
        "--enable",
        "foo",
        ...MANAGED_ARGV,
      ]);
      // Set to undefined, not deleted: see the spawn test below.
      assert.strictEqual(launch.environment.PATH, "/usr/bin");
      for (const name of AMBIENT_CODEX_VARIABLES) {
        assert.isTrue(Object.hasOwn(launch.environment, name));
        assert.isUndefined(launch.environment[name]);
      }

      // An unterminated quote in the user's arguments cannot swallow the managed flags.
      const unterminated = resolveCodexLaunch({
        path,
        stateDir: "/state",
        instanceId,
        config: { ...settings, launchArgs: `-c model="gpt-5 --enable it's` },
        environment: {},
      });
      assert.deepEqual(tokenizeCliArgs(unterminated.config.launchArgs), [
        "-c",
        "model=gpt-5 --enable it's",
        ...MANAGED_ARGV,
      ]);

      const own = resolveCodexLaunch({
        path,
        stateDir: "/state",
        instanceId,
        config: { ...settings, chatGptLogin: true, homePath: "~/.codex" },
        environment: ambient,
      });
      assert.isFalse(own.managed);
      assert.strictEqual(own.config.homePath, "~/.codex");
      assert.strictEqual(own.environment, ambient);
    }),
  );

  it.effect.skipIf(process.platform === "win32")(
    "keeps ambient credentials out of a managed app-server child that inherits process.env",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-env-" });
        const dump = path.join(root, "env.txt");
        // Stands in for `codex`: writes its environment, then exits.
        const fakeCodex = path.join(root, "codex");
        yield* fs.writeFileString(fakeCodex, `#!/bin/sh\nenv > "${dump}"\n`);
        yield* fs.chmod(fakeCodex, 0o755);
        const ambient = {
          OPENAI_API_KEY: "sk-ambient-test",
          CODEX_API_KEY: "sk-ambient-test",
          OPENAI_BASE_URL: "https://elsewhere.example",
        };
        const saved = Object.fromEntries(
          Object.keys(ambient).map((name) => [name, process.env[name]]),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => Object.assign(process.env, ambient)),
          () =>
            Effect.sync(() => {
              for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
              }
            }),
        );
        const launch = resolveCodexLaunch({
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          config: { ...settings, binaryPath: fakeCodex },
          environment: { ...process.env },
        });
        // The fake exits before the handshake; only its environment matters here.
        yield* withCodexAppServerClient({
          binaryPath: launch.config.binaryPath,
          homePath: launch.config.homePath,
          launchArgs: launch.config.launchArgs,
          cwd: root,
          environment: launch.environment,
        }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.ignore);

        const childEnv = NodeFS.readFileSync(dump, "utf8");
        for (const name of Object.keys(ambient)) assert.notInclude(childEnv, `${name}=`);
        assert.notInclude(childEnv, "sk-ambient-test");
        assert.include(childEnv, `CODEX_HOME=${launch.config.homePath}\n`);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(process.platform === "win32")(
    "a Codex that exits before answering did not reject the key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-down-" });
        // Stands in for a broken npm `codex`: one error line on stderr, exit 1.
        const fakeCodex = path.join(root, "codex");
        yield* fs.writeFileString(fakeCodex, `#!/bin/sh\necho "Error: spawn vendor/codex ENOENT" >&2\nexit 1\n`);
        yield* fs.chmod(fakeCodex, 0o755);
        const launch = resolveCodexLaunch({
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          config: { ...settings, binaryPath: fakeCodex },
          environment: { ...process.env },
        });
        const error = yield* loginCodexApiKey(instanceId, launch, FAKE_KEY).pipe(Effect.flip);
        assert.strictEqual(error.detail, "Codex could not start. The runtime log has its error output.");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(process.platform === "win32")(
    "a Codex that never answers did not reject the key either",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-silent-" });
        const started = path.join(root, "started");
        const fakeCodex = path.join(root, "codex");
        yield* fs.writeFileString(fakeCodex, `#!/bin/sh\ntouch "${started}"\nexec sleep 20\n`);
        yield* fs.chmod(fakeCodex, 0o755);
        const launch = resolveCodexLaunch({
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          config: { ...settings, binaryPath: fakeCodex },
          environment: { ...process.env },
        });
        const login = yield* loginCodexApiKey(instanceId, launch, FAKE_KEY).pipe(Effect.flip, Effect.forkChild);
        // Real time until Codex runs (the 30 s timer is armed by then), then the test clock past it.
        while (!NodeFS.existsSync(started)) yield* Effect.promise(() => new Promise((done) => setTimeout(done, 20)));
        yield* TestClock.adjust("31 seconds");
        const error = yield* Fiber.join(login);
        assert.strictEqual(error.detail, "Codex did not answer within 30 seconds.");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(process.platform === "win32")(
    "checks the key with OpenAI after Codex's login: 200 or a missing scope keeps it, 401 rejects it, no answer keeps it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-key-check-" });
        const openAi = yield* fakeOpenAi;
        // A port nothing listens on: OpenAI cannot be reached.
        const closed = yield* Effect.scoped(Effect.map(fakeOpenAi, (o) => o.baseUrl));
        const login = (apiKey: string, baseUrl: string) => {
          const launch = resolveCodexLaunch({
            path,
            stateDir: path.join(root, "state"),
            instanceId,
            config: { ...settings, binaryPath: FAKE_CODEX },
            environment: { ...process.env, FAKE_CODEX_OPENAI_BASE_URL: baseUrl },
          });
          const authFile = path.join(launch.config.homePath, "auth.json");
          return loginCodexApiKey(instanceId, launch, apiKey).pipe(
            Effect.flip,
            Effect.option,
            Effect.map((error) => ({ error: Option.getOrUndefined(error), stored: NodeFS.existsSync(authFile) })),
          );
        };

        const good = yield* login("sk-good-0000", openAi.baseUrl);
        assert.isUndefined(good.error);
        assert.isTrue(good.stored);
        // The key went to Codex's base URL, in a header.
        assert.deepEqual(openAi.seen, [{ url: "/v1/models", authorization: "Bearer sk-good-0000" }]);

        const bad = yield* login("sk-bad-0000", openAi.baseUrl);
        assert.strictEqual(bad.error?.detail, "Codex did not accept the API key.");
        assert.strictEqual(bad.error?.operation, "verify");
        assert.isFalse(bad.stored);

        // A restricted key without Models read still runs Codex's turns.
        const scoped = yield* login("sk-scoped-0000", openAi.baseUrl);
        assert.isUndefined(scoped.error);
        assert.isTrue(scoped.stored);

        // Node's fetch may not reach OpenAI where Codex can (a proxy): no verdict, the key stays.
        const unreachable = yield* login("sk-good-1111", closed);
        assert.isUndefined(unreachable.error);
        assert.isTrue(unreachable.stored);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(process.platform === "win32")(
    "a sign-in cut short during the key check leaves no key in the home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-key-cut-" });
        const openAi = yield* fakeOpenAi;
        const launch = resolveCodexLaunch({
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          config: { ...settings, binaryPath: FAKE_CODEX },
          environment: { ...process.env, FAKE_CODEX_OPENAI_BASE_URL: openAi.baseUrl },
        });
        const login = yield* loginCodexApiKey(instanceId, launch, "sk-hang-0000").pipe(Effect.flip, Effect.forkChild);
        // Real time until the check is waiting on OpenAI (Codex has stored the key), then the test clock past 30 s.
        while (openAi.seen.length === 0) yield* Effect.promise(() => new Promise((done) => setTimeout(done, 20)));
        assert.isTrue(NodeFS.existsSync(path.join(launch.config.homePath, "auth.json")));
        yield* TestClock.adjust("31 seconds");
        const error = yield* Fiber.join(login);
        assert.strictEqual(error.detail, "Codex did not answer within 30 seconds.");
        assert.isFalse(NodeFS.existsSync(path.join(launch.config.homePath, "auth.json")));
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(process.platform === "win32")(
    "removing an account signs out in its managed home and deletes only the app's directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-remove-" });
        const stateDir = path.join(root, "state");
        const userCodex = path.join(root, "user", ".codex");
        yield* fs.makeDirectory(userCodex, { recursive: true });
        yield* fs.writeFileString(path.join(userCodex, "auth.json"), "{}");
        const launched = path.join(root, "launched.txt");
        // Stands in for `codex`: records where it ran, then exits before the handshake.
        const fakeCodex = path.join(root, "codex");
        yield* fs.writeFileString(fakeCodex, `#!/bin/sh\necho "$CODEX_HOME $*" >> "${launched}"\n`);
        yield* fs.chmod(fakeCodex, 0o755);
        const environment = { ...process.env, HOME: path.join(root, "user") };

        // An API-key account with a home: it is signed out there, then its directory goes.
        const home = path.join(stateDir, "providers", "codex", instanceId, "home");
        yield* fs.makeDirectory(home, { recursive: true });
        yield* fs.writeFileString(path.join(home, "auth.json"), "{}");
        yield* removeCodexAccount({
          path,
          stateDir,
          instanceId,
          config: { ...settings, binaryPath: fakeCodex },
          environment,
        }).pipe(Effect.timeout("30 seconds"));
        assert.match(NodeFS.readFileSync(launched, "utf8"), new RegExp(`^${home} .*app-server`));
        assert.isFalse(NodeFS.existsSync(path.join(stateDir, "providers", "codex", instanceId)));

        // The user's own login is never signed out; only the app's directory is removed.
        NodeFS.rmSync(launched);
        const own = ProviderInstanceId.make("codex_own");
        yield* fs.makeDirectory(path.join(stateDir, "providers", "codex", own), { recursive: true });
        yield* removeCodexAccount({
          path,
          stateDir,
          instanceId: own,
          config: { ...settings, binaryPath: fakeCodex, chatGptLogin: true, homePath: userCodex },
          environment,
        });
        assert.isFalse(NodeFS.existsSync(launched));
        assert.isFalse(NodeFS.existsSync(path.join(stateDir, "providers", "codex", own)));
        assert.isTrue(NodeFS.existsSync(path.join(userCodex, "auth.json")));

        // The default slot comes straight back: its credential goes, an empty owner-only home stays.
        const defaultHome = path.join(stateDir, "providers", "codex", "codex", "home");
        yield* fs.makeDirectory(defaultHome, { recursive: true });
        yield* fs.writeFileString(path.join(defaultHome, "auth.json"), "{}");
        yield* removeCodexAccount({
          path,
          stateDir,
          instanceId: ProviderInstanceId.make("codex"),
          config: { ...settings, binaryPath: fakeCodex },
          environment,
        }).pipe(Effect.timeout("30 seconds"));
        assert.deepEqual(NodeFS.readdirSync(defaultHome), []);
        assert.equal(NodeFS.statSync(defaultHome).mode & 0o777, 0o700);
      }).pipe(Effect.scoped),
    60_000,
  );

  it.effect.skipIf(!hasCodex)(
    "signs in with an API key through Codex's own login, then signs out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-api-key-" });
        const userHome = path.join(root, "user");
        yield* fs.makeDirectory(userHome);
        // Codex's own openai_base_url is where the runtime checks the key.
        const openAi = yield* fakeOpenAi;
        const launch: CodexLaunch = resolveCodexLaunch({
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          config: { ...settings, launchArgs: `-c openai_base_url="${openAi.baseUrl}"` },
          environment: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: userHome },
        });
        const home = launch.config.homePath;
        let changes = 0;
        const auth = yield* makeCodexApiKeyAuth({
          instanceId,
          launch,
          onChanged: Effect.sync(() => changes++),
        });
        const phase = (wanted: string) =>
          auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === wanted),
            Stream.runHead,
            Effect.timeout("30 seconds"),
          );

        yield* auth.start("owner");
        const waiting = Option.getOrThrow(yield* phase("waiting"));
        assert.deepEqual(waiting.interaction, {
          type: "credentials",
          id: CODEX_API_KEY_METHOD_ID,
          fields: [{ name: "apiKey", label: "OpenAI API key", secret: true }],
        });
        yield* auth.respond!("owner", {
          instanceId,
          flowId: waiting.flowId!,
          interactionId: CODEX_API_KEY_METHOD_ID,
          response: { type: "credentials", values: { apiKey: FAKE_KEY } },
        });
        assert.isTrue(Option.isSome(yield* phase("succeeded")));
        assert.strictEqual(changes, 1);
        assert.deepInclude(openAi.seen, { url: "/v1/models", authorization: `Bearer ${FAKE_KEY}` });

        // Codex wrote the key into the managed home only, owner-only.
        const authFile = path.join(home, "auth.json");
        assert.strictEqual(NodeFS.statSync(home).mode & 0o777, 0o700);
        assert.strictEqual(NodeFS.statSync(authFile).mode & 0o077, 0);
        assert.include(NodeFS.readFileSync(authFile, "utf8"), FAKE_KEY);
        assert.isFalse(NodeFS.existsSync(path.join(userHome, ".codex")));

 // The managed home refuses a compact login and reports the API key.
        const account = yield* Effect.gen(function* () {
          const { client } = yield* withCodexAppServerClient({
            binaryPath: launch.config.binaryPath,
            homePath: home,
            launchArgs: launch.config.launchArgs,
            cwd: home,
            environment: launch.environment,
          });
          const chatGpt = yield* client
            .request("account/login/start", { type: "chatgptDeviceCode" })
            .pipe(Effect.flip);
          assert.include(String(chatGpt.message), "ChatGPT login is disabled");
          return yield* client.request("account/read", {});
        }).pipe(Effect.scoped);
        assert.deepEqual(account.account, { type: "apiKey" });

        yield* auth.logout(Effect.void);
        assert.strictEqual(changes, 2);
        assert.isFalse(NodeFS.existsSync(authFile));
      }).pipe(Effect.scoped),
    60_000,
  );
});
