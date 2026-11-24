import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterAll, expect, test } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ProjectSecrets, secretNameFor } from "./ProjectSecrets.ts";
import * as ProjectSecretsLive from "./ProjectSecretsLive.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-project-secrets-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const STRIPE = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3");
/** A fresh service on a state dir (`base` unless named) each run: what a restarted runtime sees. */
const runIn = <A, E>(
  stateDir: string,
  body: (secrets: ProjectSecrets["Service"], secretsDir: string) => Effect.Effect<A, E, Scope.Scope>,
  options: { readonly store?: typeof ServerSecretStore.layer; readonly logs?: Array<string> } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* ProjectSecrets, (yield* ServerConfig.ServerConfig).secretsDir);
    }).pipe(
      Effect.provide(
        ProjectSecretsLive.layer.pipe(
          Layer.provideMerge(options.store ?? ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), stateDir))),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
      options.logs === undefined ? (effect) => effect : Effect.provide(Logger.layer([Logger.make(({ message }) => void options.logs!.push(JSON.stringify(message)))], { mergeWithExisting: false })),
    ),
  );
const run = <A, E>(body: (secrets: ProjectSecrets["Service"], secretsDir: string) => Effect.Effect<A, E, Scope.Scope>) => runIn(base, body);
const freshDir = (name: string) => fs.mkdtempSync(path.join(base, `${name}-`));
const bytesOnDisk = (dir: string) => Buffer.concat(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f))));

test("values go in, come out only through resolve, and are sealed on disk", async () => {
  await run((secrets, dir) =>
    Effect.gen(function* () {
      const changed = yield* secrets.changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      const set = yield* secrets.set("p1", [
        { name: "STRIPE_SECRET_KEY", value: Redacted.make(STRIPE) },
        { name: "NODE_ENV", value: Redacted.make("development") },
      ]);
      expect(set.map((s) => [s.name, s.hidden])).toEqual([["NODE_ENV", false], ["STRIPE_SECRET_KEY", true]]);
      const listed = yield* secrets.list("p1");
      expect(JSON.stringify(listed)).not.toContain(STRIPE);
      expect(listed.every((s) => s.repository === "p1")).toBe(true);
      expect([...(yield* Fiber.join(changed))]).toEqual([{ repository: "p1", names: ["NODE_ENV", "STRIPE_SECRET_KEY"] }]);
      expect(yield* secrets.resolve("p1")).toContainEqual({ name: "STRIPE_SECRET_KEY", value: STRIPE });
      expect(yield* secrets.has("p2")).toBe(false);
      // Sealed: neither the value nor the repository and name are readable on disk.
      expect(bytesOnDisk(dir).includes(STRIPE)).toBe(false);
      expect((yield* secrets.scrubber).scrub(`key=${STRIPE}`)).toBe("key=[secret:STRIPE_SECRET_KEY]");
    }),
  );
  // A restarted runtime reads them back.
  await run((secrets) =>
    Effect.gen(function* () {
      expect(yield* secrets.resolve("p1")).toContainEqual({ name: "STRIPE_SECRET_KEY", value: STRIPE });
      yield* secrets.remove("p1", "STRIPE_SECRET_KEY");
      // Deleted, but processes started before may still hold it: it stays scrubbed until the runtime exits.
      expect((yield* secrets.scrubber).scrub(STRIPE)).toBe("[secret:STRIPE_SECRET_KEY]");
      expect(yield* secrets.resolve("p1")).toEqual([{ name: "NODE_ENV", value: "development" }]);
      expect((yield* secrets.list("p1")).map((s) => s.name)).toEqual(["NODE_ENV"]);
    }),
  );
});

test("a sealed value moved to another repository's slot does not open", async () => {
  await run((secrets, dir) =>
    Effect.gen(function* () {
      yield* secrets.set("a", [{ name: "TOKEN", value: Redacted.make("a-token-value-1234") }]);
      yield* secrets.set("b", [{ name: "TOKEN", value: Redacted.make("b-token-value-5678") }]);
      const file = (repository: string) => path.join(dir, `${ProjectSecretsLive.repositorySecretKey(repository, "TOKEN")}.bin`);
      fs.copyFileSync(file("a"), file("b"));
    }),
  );
  await run((secrets) =>
    Effect.gen(function* () {
      expect(yield* secrets.resolve("a")).toEqual([{ name: "TOKEN", value: "a-token-value-1234" }]);
      expect(yield* secrets.resolve("b")).toEqual([]);
    }),
  );
});

test("a replaced or deleted value stays scrubbed for the runtime's lifetime: running processes still hold it", async () => {
  await run((secrets) =>
    Effect.gen(function* () {
      yield* secrets.set("rot", [{ name: "API_KEY", value: Redacted.make("old-api-key-value-0001") }]);
      yield* secrets.set("rot", [{ name: "API_KEY", value: Redacted.make("new-api-key-value-0002") }]);
      yield* secrets.remove("rot", "API_KEY");
      expect(yield* secrets.resolve("rot")).toEqual([]);
      expect((yield* secrets.scrubber).scrub("old-api-key-value-0001 / new-api-key-value-0002")).toBe("[secret:API_KEY] / [secret:API_KEY]");
    }),
  );
});

test("a value with a lone surrogate is hidden as its processes print it, and later secrets are still hidden", async () => {
  // What JSON.parse makes of a secret.set value sent as "correct-horse-battery\ud83d".
  const lone = JSON.parse('"correct-horse-battery\\ud83d"') as string;
  await runIn(freshDir("surrogate"), (secrets) =>
    Effect.gen(function* () {
      yield* secrets.set("p1", [{ name: "API_KEY", value: Redacted.make(lone) }]);
      const env = Object.fromEntries((yield* secrets.resolve("p1")).map((e) => [e.name, e.value]));
      const printed = execFileSync("/bin/sh", ["-c", 'printf %s "$API_KEY"'], { env, encoding: "utf8" });
      expect(printed).toBe("correct-horse-battery�");
      expect((yield* secrets.scrubber).scrub(`key=${printed}`)).toBe("key=[secret:API_KEY]");
      yield* secrets.set("p2", [{ name: "STRIPE_SECRET_KEY", value: Redacted.make(STRIPE) }]);
      expect((yield* secrets.scrubber).scrub(`key=${STRIPE}`)).toBe("key=[secret:STRIPE_SECRET_KEY]");
      yield* secrets.remove("p1", "API_KEY");
      expect(yield* secrets.resolve("p1")).toEqual([]);
    }),
  );
});

test("secrets an older runtime sealed under a key in the OS keychain are dropped at start, and new ones go in", async () => {
  const dir = freshDir("keychain");
  let secretsDir = "";
  await runIn(dir, (secrets, sd) =>
    Effect.gen(function* () {
      secretsDir = sd;
      yield* secrets.set("a", [{ name: "TOKEN", value: Redacted.make("keychain-token-value-01") }]);
      yield* secrets.set("b", [{ name: "OTHER", value: Redacted.make("keychain-other-value-02") }]);
    }),
  );
  // As an older runtime left them: the key in the keychain (never in the store), the index saying so.
  const indexFile = path.join(secretsDir, "project-secrets-index.bin");
  fs.rmSync(path.join(secretsDir, "project-secrets-key.bin"));
  fs.writeFileSync(indexFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(indexFile, "utf8")), key: "keychain", pins: { "/code/a": "a" } }));
  await runIn(dir, (secrets) =>
    Effect.gen(function* () {
      expect(yield* secrets.has("a")).toBe(false);
      expect(yield* secrets.list("b")).toEqual([]);
      expect(fs.readdirSync(secretsDir).some((f) => f.startsWith("project-secret-"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(indexFile, "utf8"))).toEqual({ repositories: {}, pins: { "/code/a": "a" } });
      yield* secrets.set("a", [{ name: "TOKEN", value: Redacted.make("fresh-token-value-03") }]);
    }),
  );
  await runIn(dir, (secrets) => Effect.map(secrets.resolve("a"), (values) => expect(values).toEqual([{ name: "TOKEN", value: "fresh-token-value-03" }])));
});

test("keyOf pins a checkout's repository at first use; a changed origin is withheld until the person repins", async () => {
  const dir = freshDir("pins");
  const repo = fs.mkdtempSync(path.join(base, "repo-"));
  const real = fs.realpathSync(repo);
  const sh = (...args: Array<string>) => execFileSync("git", args, { cwd: repo });
  sh("init", "-q", "-b", "main");
  sh("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  fs.mkdirSync(path.join(repo, "src"));
  const worktree = path.join(base, `wt-${path.basename(repo)}`);
  sh("worktree", "add", "-q", "-b", "side", worktree);
  const keyWith = (secrets: ProjectSecrets["Service"]) => (r: Parameters<ProjectSecrets["Service"]["keyOf"]>[0]) =>
    secrets.keyOf(r).pipe(Effect.match({ onFailure: (e) => `failed:${e.reason ?? ""}`, onSuccess: (k) => k }));

  await runIn(dir, (secrets) =>
    Effect.gen(function* () {
      const key = keyWith(secrets);
      expect(yield* key({ path: path.join(repo, "src") })).toBe(`local:${real}`);
      expect(yield* key({ path: worktree })).toBe(`local:${real}`);
      // A remote added later (by the agent, or a downloaded .git/config) does not move the secrets.
      sh("remote", "add", "origin", "git@github.com:Acme/Widgets.git");
      expect(yield* key({ path: worktree })).toBe("failed:origin_changed");
      expect((yield* Effect.flip(secrets.keyOf({ path: repo }))).message).toContain(`origin changed from local:${real} to github.com/acme/widgets`);
      expect(yield* key({ url: "https://github.com/acme/widgets" })).toBe("github.com/acme/widgets");
      expect(yield* secrets.repin({ path: worktree })).toBe("github.com/acme/widgets");
      expect(yield* key({ path: repo })).toBe("github.com/acme/widgets");
      expect(yield* key({ path: base })).toBe("failed:not_a_repository");
      expect(yield* key({ path: "relative/path" })).toBe("failed:not_a_repository");
    }),
  );
  // The pin outlives a restart, and a later origin change is withheld again.
  await runIn(dir, (secrets) =>
    Effect.gen(function* () {
      expect(yield* keyWith(secrets)({ path: repo })).toBe("github.com/acme/widgets");
      sh("remote", "set-url", "origin", "https://github.com/acme/payments");
      expect(yield* keyWith(secrets)({ path: repo })).toBe("failed:origin_changed");
    }),
  );
});

/** The real store, except that a write to a name in `failing` fails as a full disk does. */
const storeFailingOn = (failing: ReadonlySet<string>): typeof ServerSecretStore.layer =>
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.map(ServerSecretStore.make, (real) =>
      ServerSecretStore.ServerSecretStore.of({
        ...real,
        set: (name, value) =>
          failing.has(name)
            ? Effect.fail(new ServerSecretStore.SecretStorePersistError({ resource: `secret ${name}`, cause: new Error("ENOSPC: no space left on device") }))
            : real.set(name, value),
      }),
    ),
  );
/** The names of values resolve would hand a process that the scrubber lets through. */
const unscrubbed = (secrets: ProjectSecrets["Service"], repository: string) =>
  Effect.gen(function* () {
    const scrubber = yield* secrets.scrubber;
    return (yield* secrets.resolve(repository)).filter((e) => scrubber.scrub(`env ${e.value}`) === `env ${e.value}`).map((e) => e.name);
  });
const GITHUB = ("gh" + "p_Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1Jh0GfEdCbA9");

test("a save the disk refuses partway leaves no value a process can get unscrubbed, and only what a restart reads", async () => {
  const dir = freshDir("full-disk");
  const failing = new Set<string>();
  const store = storeFailingOn(failing);
  await runIn(
    dir,
    (secrets) =>
      Effect.gen(function* () {
        yield* secrets.set("p", [{ name: "API_KEY", value: Redacted.make("old-api-key-value-0001") }]);
        // The disk fills at the third file: API_KEY's new value is on disk (its file is what a restart reads), the new
        // STRIPE_SECRET_KEY's file too, but no index names it.
        failing.add(ProjectSecretsLive.repositorySecretKey("p", "GITHUB_TOKEN"));
        const exit = yield* Effect.exit(
          secrets.set("p", [
            { name: "API_KEY", value: Redacted.make("new-api-key-value-0002") },
            { name: "STRIPE_SECRET_KEY", value: Redacted.make(STRIPE) },
            { name: "GITHUB_TOKEN", value: Redacted.make(GITHUB) },
          ]),
        );
        failing.clear();
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* unscrubbed(secrets, "p")).toEqual([]);
        expect(yield* secrets.resolve("p")).toEqual([{ name: "API_KEY", value: "new-api-key-value-0002" }]);
        expect((yield* secrets.list("p")).map((s) => s.name)).toEqual(["API_KEY"]);
        // The value it replaced may still be in a running process.
        expect((yield* secrets.scrubber).scrub("old-api-key-value-0001")).toBe("[secret:API_KEY]");
      }),
    { store },
  );
  await runIn(dir, (secrets) =>
    Effect.gen(function* () {
      expect(yield* secrets.resolve("p")).toEqual([{ name: "API_KEY", value: "new-api-key-value-0002" }]);
      expect((yield* secrets.list("p")).map((s) => s.name)).toEqual(["API_KEY"]);
    }),
  );
});

test("a save whose index the disk refuses leaves its new values out until a save lands", async () => {
  const dir = freshDir("full-disk-index");
  const failing = new Set(["project-secrets-index"]);
  await runIn(
    dir,
    (secrets) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(secrets.set("p", [{ name: "STRIPE_SECRET_KEY", value: Redacted.make(STRIPE) }])))).toBe(true);
        expect(yield* unscrubbed(secrets, "p")).toEqual([]);
        expect(yield* secrets.resolve("p")).toEqual([]);
        expect(yield* secrets.list("p")).toEqual([]);
        failing.clear();
        yield* secrets.set("p", [{ name: "STRIPE_SECRET_KEY", value: Redacted.make(STRIPE) }]);
        expect(yield* unscrubbed(secrets, "p")).toEqual([]);
        expect(yield* secrets.resolve("p")).toEqual([{ name: "STRIPE_SECRET_KEY", value: STRIPE }]);
      }),
    { store: storeFailingOn(failing) },
  );
  await runIn(dir, (secrets) => Effect.map(secrets.resolve("p"), (values) => expect(values).toEqual([{ name: "STRIPE_SECRET_KEY", value: STRIPE }])));
});

test("a pin the disk refuses is not kept: the checkout waits for one that lands, as a restart would find it", async () => {
  const dir = freshDir("full-disk-pin");
  const repo = fs.mkdtempSync(path.join(base, "repo-"));
  const sh = (...args: Array<string>) => execFileSync("git", args, { cwd: repo });
  sh("init", "-q", "-b", "main");
  sh("remote", "add", "origin", "https://github.com/acme/widgets");
  const keyWith = (secrets: ProjectSecrets["Service"]) =>
    secrets.keyOf({ path: repo }).pipe(Effect.match({ onFailure: (e) => `failed:${e.reason ?? e.message}`, onSuccess: (k) => k }));
  const failing = new Set(["project-secrets-index"]);
  await runIn(
    dir,
    (secrets) =>
      Effect.gen(function* () {
        const refused = "failed:Failed to persist secret project-secrets-index.";
        expect(yield* keyWith(secrets)).toBe(refused);
        expect(yield* keyWith(secrets)).toBe(refused);
        failing.clear();
        expect(yield* keyWith(secrets)).toBe("github.com/acme/widgets");
        sh("remote", "set-url", "origin", "https://github.com/acme/payments");
        failing.add("project-secrets-index");
        expect(Exit.isFailure(yield* Effect.exit(secrets.repin({ path: repo })))).toBe(true);
        expect(yield* keyWith(secrets)).toBe("failed:origin_changed");
      }),
    { store: storeFailingOn(failing) },
  );
  await runIn(dir, (secrets) => Effect.map(keyWith(secrets), (key) => expect(key).toBe("failed:origin_changed")));
});

for (const [state, bytes] of [
  ["empty (a crash after its rename, before its data reached the disk)", ""],
  ["cut off mid-write", '{"repositories":{"github.com/acme/app":{"TOK'],
  ["not an index (edited by hand)", '{"repositories":"github.com/acme/app"}'],
] as const) {
  test(`an index left ${state} is set aside, named in a warning, and the runtime still starts`, async () => {
    const dir = freshDir("torn-index");
    let secretsDir = "";
    await runIn(dir, (secrets, sd) =>
      Effect.gen(function* () {
        secretsDir = sd;
        yield* secrets.set("github.com/acme/app", [{ name: "TOKEN", value: Redacted.make("acme-token-value-0001") }]);
      }),
    );
    fs.writeFileSync(path.join(secretsDir, "project-secrets-index.bin"), bytes);
    const asideFiles = () => fs.readdirSync(secretsDir).filter((f) => f.startsWith("project-secrets-index-unreadable-"));
    const logs: Array<string> = [];
    await runIn(
      dir,
      (secrets) =>
        Effect.gen(function* () {
          expect(yield* secrets.list("github.com/acme/app")).toEqual([]);
          yield* secrets.set("github.com/acme/app", [{ name: "TOKEN", value: Redacted.make("acme-token-value-0002") }]);
        }),
      { logs },
    );
    // Kept as it was, for a person (or support) to repair: the values it named are still sealed beside it.
    expect(asideFiles()).toHaveLength(1);
    expect(fs.readFileSync(path.join(secretsDir, asideFiles()[0]!), "utf8")).toBe(bytes);
    expect(logs.some((line) => line.includes(asideFiles()[0]!))).toBe(true);
    // Set aside once: the next start reads the index this one wrote.
    await runIn(dir, (secrets) =>
      Effect.map(secrets.resolve("github.com/acme/app"), (values) => expect(values).toEqual([{ name: "TOKEN", value: "acme-token-value-0002" }])),
    );
    expect(asideFiles()).toHaveLength(1);
  });
}

test("a request_secret label names its env var", () => {
  expect(secretNameFor("STRIPE_SECRET_KEY")).toBe("STRIPE_SECRET_KEY");
  expect(secretNameFor("GitHub webhook secret")).toBe("GITHUB_WEBHOOK_SECRET");
  expect(secretNameFor("1Password token")).toBe("SECRET_1PASSWORD_TOKEN");
});
