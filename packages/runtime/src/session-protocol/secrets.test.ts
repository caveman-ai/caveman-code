// Project secrets end to end on the Session Protocol: stored write-only,
// injected into the processes the runtime starts, scrubbed from everything a
// client receives, and refused as chat text (16-SECRETS.md).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { OrchestrationV2DomainEvent } from "@caveman-app/protocol";
import { connect, createScrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as TerminalManager from "../terminal/Manager.ts";
import { emptyThreadState, projectEvent, type DraftEvent } from "./projector.ts";
import { followingStream, makeCommandOutputScrub, makeOutputScrub, makeSecretHandlers, repoEnv, secretInInput } from "./secrets.ts";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ownerOf, writeChoices } from "../cloudLink/cloudSync.ts";
import { loadIdentity } from "../cloudLink/identity.ts";
import { linkDirOf } from "../cloudLink/index.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { DatabaseSync } from "node:sqlite";
import { CavemanRewriter } from "./services.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { leakIn, productionScrubber, SECRET } from "../secrets/testing.ts";
import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const CANARY = "cnry-7Qx9vL2mZp4tR8wY";
const STRIPE = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3");
const forms = (value: string) => [value, Buffer.from(value).toString("base64").slice(0, 24)];

test("tool.output split across events is caught; the held tail goes out before tool.done", () => {
  const scrub = makeOutputScrub();
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const out = (type: string, payload: unknown) => ({ at: "t", type, item_id: "i1", payload }) as DraftEvent;
  const events = [
    ...scrub(scrubber, [out("tool.output", { text: `token=${CANARY.slice(0, 6)}` })]),
    ...scrub(scrubber, [out("tool.output", { text: `${CANARY.slice(6)} ok\nnext ${CANARY.slice(0, 3)}` })]),
    ...scrub(scrubber, [out("tool.done", { status: "completed" })]),
  ];
  expect(events.map((e) => e.type)).toEqual(["tool.output", "tool.output", "tool.output", "tool.done"]);
  expect(events.map((e) => (e.payload as { text?: string }).text ?? "").join("")).toBe(`token=[secret:CANARY] ok\nnext ${CANARY.slice(0, 3)}`);
});

test("item streams follow a scrubber change: a value set while a command runs is caught, the held tail kept", () => {
  const NEW = "nw-9Kd2Lm7Qp3Xz5Rt8";
  const before = createScrubber([{ name: "CANARY", value: CANARY }]);
  const after = createScrubber([
    { name: "CANARY", value: CANARY },
    { name: "NEW", value: NEW },
  ]);
  const scrub = makeOutputScrub();
  const out = (type: string, payload: unknown) => ({ at: "t", type, item_id: "i2", turn_id: "r1", payload }) as DraftEvent;
  const events = [
    ...scrub(before, [out("tool.output", { text: `a ${CANARY.slice(0, 5)}` })]),
    ...scrub(after, [out("tool.output", { text: `${CANARY.slice(5)} b ${NEW} c` })]),
    ...scrub(after, [out("tool.done", { status: "completed" })]),
  ];
  expect(events.map((e) => (e.payload as { text?: string }).text ?? "").join("")).toBe("a [secret:CANARY] b [secret:NEW] c");
});

test("message and reasoning deltas are stream-scrubbed per item; reasoning's tail goes out before turn.done", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const scrub = makeOutputScrub();
  const ev = (type: string, item: string | undefined, payload: unknown) => ({ at: "t", type, turn_id: "r1", ...(item ? { item_id: item } : {}), payload }) as DraftEvent;
  const events = [
    ...scrub(scrubber, [ev("message.delta", "m1", { text: `key ${CANARY.slice(0, 7)}` }), ev("reasoning.delta", "th1", { text: `think ${CANARY.slice(0, 4)}` })]),
    ...scrub(scrubber, [ev("message.delta", "m1", { text: `${CANARY.slice(7)} end` }), ev("reasoning.delta", "th1", { text: CANARY.slice(4) })]),
    ...scrub(scrubber, [ev("message.done", "m1", { role: "assistant", text: "key [secret:CANARY] end" }), ev("turn.done", undefined, { status: "completed" })]),
  ];
  const text = (type: string) => events.filter((e) => e.type === type).map((e) => (e.payload as { text: string }).text).join("");
  expect(text("message.delta")).toBe("key [secret:CANARY] end");
  expect(text("reasoning.delta")).toBe("think [secret:CANARY]");
  expect(events.at(-1)!.type).toBe("turn.done");
});

test("a terminal's idle flush sends a short held echo but never a held prefix of a value; the end masks one", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const typing = followingStream(() => scrubber);
  expect(typing.push(`$ ${CANARY[0]}`)).toBe("$ ");
  expect(typing.idle()).toBe(CANARY[0]);
  const slow = followingStream(() => scrubber);
  expect(slow.push(`value ${CANARY.slice(0, 10)}`)).toBe("value ");
  expect(slow.idle()).toBe("");
  expect(slow.push(`${CANARY.slice(10)}\n`) + slow.idle()).toBe("[secret:CANARY]\n");
  const cut = followingStream(() => scrubber);
  expect(cut.push(`head ${CANARY.slice(0, 12)}`) + cut.end()).toBe("head [secret]");
});

test("a value whose output pauses within its first characters never reaches a terminal or tool.live whole", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const terminal = followingStream(() => scrubber);
  const typed = [terminal.push(`$ echo ${CANARY.slice(0, 3)}`), terminal.idle(), terminal.push(`${CANARY.slice(3)}\n$ `), terminal.end()];
  expect(typed[1]).toBe(CANARY.slice(0, 3));
  expect(typed.join("")).toBe(`$ echo ${CANARY.slice(0, 3)}[secret:CANARY]\n$ `);

  const live = makeCommandOutputScrub(() => scrubber);
  const frames = [
    live({ kind: "replace" as const, text: `token ${CANARY.slice(0, 5)}`, truncated: false, running: true }).text,
    live.idle(),
    live({ kind: "append" as const, text: `${CANARY.slice(5)} ok\n`, truncated: false, running: false }).text,
  ];
  expect(frames.join("")).toBe(`token ${CANARY.slice(0, 5)}[secret:CANARY] ok\n`);

  // A secret set during the pause hands the stream to a new scrubber, which must still know what went out.
  let current = scrubber;
  const rotating = followingStream(() => current);
  const rotated = [rotating.push(`key=${CANARY.slice(0, 2)}`), rotating.idle()];
  current = createScrubber([{ name: "CANARY", value: CANARY }, { name: "STRIPE", value: STRIPE }]);
  rotated.push(rotating.push(`${CANARY.slice(2)};`), rotating.end());
  expect(rotated.join("")).toBe(`key=${CANARY.slice(0, 2)}[secret:CANARY];`);

  // The scrubber production hands out chains the store's with the egress tokens'; a provider key goes through both.
  const chained = followingStream(() => productionScrubber());
  const keyed = [chained.push("ok:sk-a"), chained.idle(), chained.push(`${SECRET.PROVIDER_API_KEY!.slice(4)};`), chained.end()].join("");
  expect(leakIn(keyed)).toBeUndefined();
  expect(keyed).toBe("ok:sk-a[secret:PROVIDER_API_KEY];");
});

test("live command output frames never carry a secret value, split or whole", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const scrub = makeCommandOutputScrub(() => scrubber);
  const frames = [
    scrub({ kind: "replace" as const, text: `start ${CANARY}\nnext ${CANARY.slice(0, 9)}`, truncated: false, running: true }),
    scrub({ kind: "append" as const, text: `${CANARY.slice(9)} done\n`, truncated: false, running: true }),
    scrub({ kind: "append" as const, text: `tail ${CANARY.slice(0, 12)}`, truncated: false, running: false }),
  ];
  const text = frames.map((f) => f.text).join("");
  expect(text).not.toContain(CANARY.slice(0, 9));
  expect(text).toBe("start [secret:CANARY]\nnext [secret:CANARY] done\ntail [secret]");
  expect(frames.map((f) => f.running)).toEqual([true, true, false]);
});

test("a replace frame whose window starts inside a value masks what the cut left of it, in each form", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const basic = Buffer.from(`u:${CANARY}`).toString("base64");
  const wrapped = JSON.stringify(Buffer.from(CANARY).toString("base64").replace(/(.{6})/g, "$1\r\n")).slice(1, -1);
  const cuts = [
    { form: "raw", text: CANARY.slice(5) },
    { form: "JSON-escaped twice", text: JSON.stringify(JSON.stringify(`"${CANARY}"`)).slice(9, -1) },
    { form: "inside Basic auth", text: basic.slice(6) },
    // A cut inside an escaped break leaves its letter, the backslash went with the cut.
    { form: "wrapped base64, cut inside an escaped break", text: wrapped.slice(wrapped.indexOf("\\r\\n") + 1) },
  ];
  for (const { form, text } of cuts) {
    const sent = makeCommandOutputScrub(() => scrubber)({ kind: "replace", text: `${text}; next`, truncated: true, running: false }).text;
    // What follows the value in its form (closing escapes, base64 padding) still goes out.
    expect(sent, form).toMatch(/^\[secret\].{0,6}; next$/);
    expect(leakIn(sent), form).toBeUndefined();
  }
  // Fewer characters than any value has can be anything's end: they go as they are, as an idle's held start does.
  const short = { kind: "replace", text: `${CANARY.slice(-7)}; next`, truncated: true, running: false } as const;
  expect(makeCommandOutputScrub(() => scrubber)(short).text).toBe(short.text);
  // A window nothing cut is the start of the output.
  const uncut = { kind: "replace", text: `${CANARY.slice(5)}; next`, truncated: false, running: false } as const;
  expect(makeCommandOutputScrub(() => scrubber)(uncut).text).toBe(uncut.text);
});

test("injected env never sets a name that changes how the process runs", async () => {
  const secrets = {
    keyOf: () => Effect.succeed("k"),
    resolve: () =>
      Effect.succeed([
        { name: "PATH", value: "/evil/bin" },
        { name: "BASH_ENV", value: "/evil/rc" },
        { name: "GIT_SSH_COMMAND", value: "evil" },
        { name: "API_TOKEN", value: CANARY },
      ]),
  } as unknown as ProjectSecrets["Service"];
  expect(await Effect.runPromise(repoEnv(secrets, { path: "/r" }))).toEqual({ API_TOKEN: CANARY });
});

// Skipped on Windows: no FIFOs in its filesystem (named pipes live in their own namespace, never in a repo).
test.skipIf(process.platform === "win32")("a FIFO swapped in for a .env file is refused, not read (the runtime would block on it)", () => {
  const dir = tempRoot("sp-fifo-");
  execFileSync("mkfifo", [path.join(dir, ".env")]);
  const script = `import { readEnvFile } from ${JSON.stringify(path.join(import.meta.dirname, "secrets.ts"))};
try { readEnvFile(${JSON.stringify(dir)}, ".env"); console.log("read"); } catch { console.log("refused"); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(child.stdout.trim().split("\n").at(-1)).toBe("refused");
});

test("only this computer's clients and the runtime's own Cloud user may use secrets; others are forbidden", async () => {
  const cfg = await makeConfig();
  const layer = Layer.mergeAll(ProjectSecretsLive.layer.pipe(Layer.provide(ServerSecretStore.layer)), GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))).pipe(
    Layer.provide(Layer.succeed(ServerConfig.ServerConfig, cfg)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const repo = makeRepo(root, { "README.md": "owned\n" });
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const handlers = yield* makeSecretHandlers((principal) => principal === "local" || principal === "cloud:owner");
      const reason = <A, E extends { reason: string }>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.match({ onFailure: (e) => e.reason, onSuccess: () => "ok" }));
      const list = (principal: string) => reason(handlers["secret.list"]({ repo: { path: repo } }, { connectionId: "c", principal }));
      const set = (principal: string) =>
        reason(handlers["secret.set"]({ request_id: principal, repo: { path: repo }, secrets: [{ name: "OWNED", value: "owned-value-12345" }] }, { connectionId: "c", principal }));
      return [yield* list("local"), yield* list("cloud:owner"), yield* list("cloud:intruder"), yield* set("cloud:intruder"), yield* set("cloud:owner")];
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  expect(outcome).toEqual(["ok", "ok", "forbidden", "forbidden", "ok"]);
});

test("the runtime's owner is the Cloud user its runtime.json names", () => {
  const dir = tempRoot("sp-identity-");
  fs.writeFileSync(path.join(dir, "runtime.key"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  const record = { cloud_url: "https://app.caveman.so", runtime_id: randomUUID(), organization_id: randomUUID(), computer_id: randomUUID() };
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify(record));
  expect(loadIdentity(dir).userId).toBeUndefined();
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ ...record, user_id: "user-1" }));
  expect(loadIdentity(dir).userId).toBe("user-1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("secret.list names the values Cloud holds for a repository added to Cloud one value at a time", async () => {
  const pinned = process.env.CAVEMAN_CLOUD_URL;
  delete process.env.CAVEMAN_CLOUD_URL;
  const cfg = await makeConfig();
  const link = linkDirOf(cfg.stateDir);
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, "runtime.key"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(path.join(link, "runtime.json"), JSON.stringify({ cloud_url: "https://app.caveman.so", runtime_id: randomUUID(), organization_id: randomUUID(), computer_id: randomUUID(), user_id: "user-1" }));
  const owner = ownerOf(loadIdentity(link));
  // secret.list reads the choices beside the state dir, so the handlers get the config too.
  const layer = Layer.mergeAll(ProjectSecretsLive.layer.pipe(Layer.provide(ServerSecretStore.layer)), GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))).pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, cfg)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const gadgets = { url: "https://github.com/acme/gadgets" };
  const widgets = { url: "https://github.com/acme/widgets" };
  // What cloud.secrets.set_available leaves behind: gadgets by name (Add from this Mac; GONE was deleted here since), widgets whole.
  writeChoices(cfg.stateDir, () => ({ owner, repositories: ["github.com/acme/widgets"], names: { "github.com/acme/gadgets": ["GONE", "STRIPE_KEY"] } }));
  const [byName, whole] = await Effect.runPromise(
    Effect.gen(function* () {
      const handlers = yield* makeSecretHandlers(() => true);
      const ctx = { connectionId: "c", principal: "local" };
      for (const repo of [gadgets, widgets]) {
        yield* handlers["secret.set"]({ request_id: `set:${repo.url}`, repo, secrets: [{ name: "STRIPE_KEY", value: "stripe-value-12345" }, { name: "AWS_SECRET", value: "aws-value-12345" }] }, ctx);
      }
      return [yield* handlers["secret.list"]({ repo: gadgets }, ctx), yield* handlers["secret.list"]({ repo: widgets }, ctx)] as const;
    }).pipe(Effect.provide(layer), Effect.scoped),
  ).finally(() => {
    if (pinned !== undefined) process.env.CAVEMAN_CLOUD_URL = pinned;
  });
  // The repository's switch is off, yet Cloud computers read STRIPE_KEY: the list says so.
  expect({ cloud_available: byName.cloud_available, cloud_names: byName.cloud_names }).toEqual({ cloud_available: undefined, cloud_names: ["STRIPE_KEY"] });
  expect({ cloud_available: whole.cloud_available, cloud_names: whole.cloud_names }).toEqual({ cloud_available: true, cloud_names: undefined });
});

test("the send backstop: known credential shapes and stored values, not env-shaped text the user chose to send", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  expect(secretInInput(scrubber, `use ${STRIPE} for billing`)).toBe(true);
  expect(secretInInput(scrubber, `the token is ${CANARY}`)).toBe(true);
  expect(secretInInput(scrubber, "FOO=bar\nBAZ=qux-local-only")).toBe(false);
  expect(secretInInput(scrubber, "fix the build")).toBe(false);
});

test("an agent's request_secret is an ask.user of kind secret, resolved without a value", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-15T00:00:00.000Z", displayText: () => undefined, repo: { path: "/code/widgets" } };
  const item = (secretStatus: string) =>
    projectEvent(
      state,
      { type: "turn-item.updated", payload: { type: "secret_request", id: "ti-1", runId: "r1", parentItemId: null, label: "Stripe secret key", reason: "To call Stripe", secretStatus } } as unknown as OrchestrationV2DomainEvent,
      ctx,
    ).events;
  expect(item("pending")).toEqual([
    { at: ctx.at, type: "ask.user", turn_id: "r1", item_id: "ti-1", payload: { kind: "secret", repo: { path: "/code/widgets" }, name: "STRIPE_SECRET_KEY", reason: "To call Stripe" } },
  ]);
  expect(item("pending")).toEqual([]);
  expect(item("saved")).toMatchObject([{ type: "ask.resolved", payload: { outcome: "answered", response: { kind: "secret", provided: true } } }]);
});

// ------------------------------------------------------------- the runtime

/** upstream terminal manager stand-in: records each open's env and plays output the test writes. */
const terminal = {
  opened: [] as Array<{ terminalId: string; threadId: string; env: Record<string, string> | undefined }>,
  listeners: new Set<(event: never) => Effect.Effect<void>>(),
  history: "",
  emit(data: string) {
    const { terminalId, threadId } = terminal.opened.at(-1)!;
    return Promise.all([...terminal.listeners].map((l) => Effect.runPromise(l({ type: "output", threadId, terminalId, data } as never))));
  },
};
const layerTerminal = Layer.mock(TerminalManager.TerminalManager)({
  open: (input) => Effect.sync(() => (terminal.opened.push({ terminalId: input.terminalId!, threadId: input.threadId, env: input.env }), {} as never)),
  getShell: () => Effect.succeed("/bin/zsh"),
  write: () => Effect.void,
  close: () => Effect.void,
  subscribe: (listener) => Effect.sync(() => (terminal.listeners.add(listener as never), () => terminal.listeners.delete(listener as never))),
  observeStream: (_input, listener) => listener({ type: "snapshot", snapshot: { history: terminal.history } } as never).pipe(Effect.as(() => undefined)),
});

const root = tempRoot("sp-secrets-");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
/** Every frame any client of this runtime received. */
const frames: Array<string> = [];
/** What the "Caveman version" side request was asked to rewrite. */
const rewritten: Array<string> = [];

beforeAll(async () => {
  const Base = globalThis.WebSocket;
  globalThis.WebSocket = class extends Base {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("message", (event) => frames.push(String(event.data)));
    }
  } as typeof WebSocket;
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(
      layerTerminal,
      Layer.succeed(CavemanRewriter, { rewrite: (text: string) => Effect.sync(() => (rewritten.push(text), { text: "short" })) }),
    ),
  });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );

test("env files: only git-ignored .env* at the top; import refuses every other path", async () => {
  const repo = makeRepo(root, { ".gitignore": ".env*\n!.env.example\nsub/\n", ".env.example": "EXAMPLE=committed-1234\n" });
  fs.writeFileSync(path.join(repo, ".env"), `# app\nAPI_TOKEN=${CANARY}\nEMPTY=\nPORT=3000\n`);
  fs.writeFileSync(path.join(repo, ".env.local"), "LOCAL_ONLY=zz-local-8f3k2m9q\n");
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub/.env"), "NESTED=nested-secret-1\n");
  fs.writeFileSync(path.join(root, "outside.env"), "OUTSIDE=outside-secret-1\n");
  fs.symlinkSync(path.join(root, "outside.env"), path.join(repo, ".env.link"));
  const r = { path: repo };

  expect((await client.call("secret.env_files", { repo: r })).files).toEqual([
    { path: ".env", names: ["API_TOKEN", "PORT"] },
    { path: ".env.local", names: ["LOCAL_ONLY"] },
  ]);
  for (const bad of [".env.example", ".env.link", "sub/.env", "../outside.env", path.join(repo, ".env"), "./.env", "README.md"]) {
    expect(await failure(client.call("secret.import", { request_id: `bad:${bad}`, repo: r, path: bad }))).toBe("invalid_params");
  }
  // Not a repository; a repository given by URL has no files here.
  expect(await failure(client.call("secret.import", { request_id: "nope", repo: { path: root }, path: ".env" }))).toBe("invalid_params");
  expect(await failure(client.call("secret.import", { request_id: "url", repo: { url: "https://github.com/acme/widgets" }, path: ".env" }))).toBe("invalid_params");
  expect((await client.call("secret.env_files", { repo: { url: "https://github.com/acme/widgets" } })).files).toEqual([]);

  const imported = await client.call("secret.import", { request_id: "imp", repo: r, path: ".env" });
  expect(imported.secrets.map((s) => [s.name, s.hidden])).toEqual([["API_TOKEN", true], ["PORT", false]]);
  // Stored names drop out of the listing.
  expect((await client.call("secret.env_files", { repo: r })).files).toEqual([{ path: ".env.local", names: ["LOCAL_ONLY"] }]);
  // Keyed by the repository: a subfolder (or a worktree) of it reads the same secrets.
  expect(await client.call("secret.list", { repo: { path: path.join(repo, "sub") } })).toMatchObject({ repository: `local:${fs.realpathSync(repo)}` });
  expect((await client.call("secret.list", { repo: { path: path.join(repo, "sub") } })).secrets.map((s) => s.name)).toEqual(["API_TOKEN", "PORT"]);
  await client.call("secret.delete", { request_id: "del", repo: r, name: "API_TOKEN" });
  await client.call("secret.delete", { request_id: "del2", repo: r, name: "PORT" });
});

test("a canary set with secret.set reaches setup, archive and terminals, and never a client, a log of the call, or the database", async () => {
  const repo = makeRepo(root, {
    ".caveman/computer.toml": [
      "[setup]",
      `run = ["echo setup saw $CANARY_TOKEN; printf %s \\"$CANARY_TOKEN\\" | base64; exit 3"]`,
      "[env]",
      'CANARY_TOKEN = "from-computer-toml"',
    ].join("\n"),
  });
  const repository = `local:${fs.realpathSync(repo)}`;
  const changed: Array<unknown> = [];
  client.on("secret.changed", (p) => changed.push(p));
  const set = await client.call("secret.set", { request_id: "c-set", repo: { path: repo }, secrets: [{ name: "CANARY_TOKEN", value: CANARY }] });
  expect(set.secrets).toMatchObject([{ name: "CANARY_TOKEN", repository, hidden: true }]);
  expect((await client.call("secret.list", { repo: { path: repo } })).secrets.map((s) => s.name)).toEqual(["CANARY_TOKEN"]);
  await until(() => changed.length > 0);
  expect(changed).toContainEqual({ repository, names: ["CANARY_TOKEN"] });

  // Setup: the secret wins over [env], and its output (raw and base64) comes back scrubbed.
  const w = await client.call("workspace.create", { request_id: "c-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<{ type: string; payload: unknown }> = [];
  await client.attach(w.session_id, 0, (event) => events.push(event));
  await until(() => events.some((e) => e.type === "notification" && JSON.stringify(e.payload).includes("Setup failed")));
  const setup = JSON.stringify(events.find((e) => e.type === "notification" && JSON.stringify(e.payload).includes("Setup failed"))!.payload);
  expect(setup).toContain("setup saw [secret:CANARY_TOKEN]");
  expect(setup).not.toContain("from-computer-toml");

  // A terminal (the Run button is one) gets it as env; output split mid-value and the scrollback come back scrubbed.
  const terminalOutput: Array<string> = [];
  client.on("term.output", (p) => terminalOutput.push(p.data));
  const { terminal_id } = await client.call("term.open", { request_id: "c-t", workspace_id: w.id, cols: 80, rows: 24, command: "env" });
  expect(terminal.opened.at(-1)!.env?.CANARY_TOKEN).toBe(CANARY);
  await terminal.emit(`CANARY_TOKEN=${CANARY.slice(0, 8)}`);
  await terminal.emit(`${CANARY.slice(8)}\r\n$ `);
  await until(() => terminalOutput.join("").endsWith("$ "));
  expect(terminalOutput.join("")).toBe("CANARY_TOKEN=[secret:CANARY_TOKEN]\r\n$ ");
  terminal.history = `old ${CANARY} line`;
  expect((await client.call("term.attach", { terminal_id })).scrollback).toBe("old [secret:CANARY_TOKEN] line");
  // Attached between two reads that split a value: the scrollback stops before the value's start, which the output
  // that completes it brings masked.
  await terminal.emit(`CANARY_TOKEN=${CANARY.slice(0, 10)}`);
  await until(() => terminalOutput.join("").endsWith("CANARY_TOKEN="));
  terminalOutput.length = 0;
  terminal.history = `$ env\r\nCANARY_TOKEN=${CANARY.slice(0, 10)}`;
  expect((await client.call("term.attach", { terminal_id })).scrollback).toBe("$ env\r\nCANARY_TOKEN=");
  await terminal.emit(`${CANARY.slice(10)}\r\n$ `);
  await until(() => terminalOutput.join("").endsWith("$ "));
  expect(terminalOutput.join("")).toBe("[secret:CANARY_TOKEN]\r\n$ ");

  // The backstop: neither a stored value nor a known credential becomes chat text, and nothing of it is kept.
  const before = events.length;
  for (const [id, text] of [["c-s1", `here: ${CANARY}`], ["c-s2", `stripe ${STRIPE}`]]) {
    expect(await failure(client.call("turn.submit", { request_id: id!, session_id: w.session_id, kind: "queue", input: { text: text! } }))).toBe("secret_in_input");
  }
  expect(await failure(client.call("workspace.create", { request_id: "c-w2", repo: { path: repo }, task: { text: CANARY } }))).toBe("secret_in_input");

  await client.call("workspace.archive", { request_id: "c-a", workspace_id: w.id });
  await new Promise((r) => setTimeout(r, 200));
  expect(events.slice(before).some((e) => e.type === "message.done")).toBe(false);

  for (const form of forms(CANARY)) {
    expect(frames.filter((f) => f.includes(form))).toEqual([]);
    for (const file of [config.dbPath, `${config.dbPath}-wal`].filter((f) => fs.existsSync(f))) {
      expect(fs.readFileSync(file).includes(form)).toBe(false);
    }
  }
  expect(frames.some((f) => f.includes("[secret:CANARY_TOKEN]"))).toBe(true);
  git(repo, "status");
});

test("a terminal opened before a secret is set scrubs it once it is; attachments, goals, answers and mail are checked too", async () => {
  const NEW = "nw-9Kd2Lm7Qp3Xz5Rt8";
  const repo = makeRepo(root, { "README.md": "later\n" });
  const w = await client.call("workspace.create", { request_id: "l-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const terminalOutput: Array<string> = [];
  client.on("term.output", (p) => terminalOutput.push(p.data));
  await client.call("term.open", { request_id: "l-t", workspace_id: w.id, cols: 80, rows: 24 });
  await client.call("secret.set", { request_id: "l-set", repo: { path: repo }, secrets: [{ name: "LATE_TOKEN", value: NEW }] });
  await terminal.emit(`late ${NEW}\r\n$ `);
  await until(() => terminalOutput.join("").includes("$ "));
  expect(terminalOutput.join("")).toContain("late [secret:LATE_TOKEN]");

  const file = (text: string) => ({ type: "file" as const, name: ".env", mime_type: "text/plain", data: Buffer.from(text).toString("base64") });
  for (const [id, attachment] of [["l-a1", file(`STRIPE_SECRET_KEY=${STRIPE}\n`)], ["l-a2", { ...file(`TOKEN=${NEW}`), data: `data:text/plain;base64,${Buffer.from(`TOKEN=${NEW}`).toString("base64")}` }]] as const) {
    expect(await failure(client.call("turn.submit", { request_id: id, session_id: w.session_id, kind: "queue", input: { text: "see the file", attachments: [attachment] } }))).toBe("secret_in_input");
  }
  expect(await failure(client.call("goal.set", { request_id: "l-g", session_id: w.session_id, objective: `ship with ${NEW}` }))).toBe("secret_in_input");
  expect(
    await failure(
      client.call("ask.respond", { request_id: "l-r", session_id: w.session_id, ask_id: "nope", response: { kind: "question", answers: [{ question_id: "q", option_ids: [], text: STRIPE }] } }),
    ),
  ).toBe("secret_in_input");
  expect(await failure(client.call("mail.note", { request_id: "l-m", session_id: w.session_id, to_workspace_id: w.id, body: `here ${NEW}` }))).toBe("secret_in_input");
  for (const form of forms(NEW)) expect(frames.filter((f) => f.includes(form))).toEqual([]);
});

test("a checkout whose origin changes keeps its secrets withheld until the person repins it", async () => {
  const repo = makeRepo(root, { "README.md": "pinned\n" });
  const repository = `local:${fs.realpathSync(repo)}`;
  await client.call("secret.set", { request_id: "p-set", repo: { path: repo }, secrets: [{ name: "PINNED_TOKEN", value: "pinned-token-value-1" }] });
  git(repo, "remote", "add", "origin", "https://github.com/acme/payments");
  expect(await failure(client.call("secret.list", { repo: { path: repo } }))).toBe("invalid_state");
  expect(await client.call("secret.repin", { request_id: "p-re", repo: { path: repo } })).toEqual({ repository: "github.com/acme/payments" });
  expect(await client.call("secret.list", { repo: { path: repo } })).toEqual({ repository: "github.com/acme/payments", secrets: [] });
  // The local repository's secrets stay where they were, under the key it had.
  expect(repository.startsWith("local:")).toBe(true);
});

test("the Caveman version of a message stored before its value became a secret sends the model no value", async () => {
  const OLD = "od-4Hs8Kq2Wm6Zx9Pv3";
  const repo = makeRepo(root, { "README.md": "older\n" });
  const w = await client.call("workspace.create", { request_id: "cv-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  // An answer that quoted the value, journaled before anyone stored it.
  const at = new Date().toISOString();
  const db = new DatabaseSync(config.dbPath);
  try {
    const event = { session_id: w.session_id, cursor: 900_000, at, type: "message.done", item_id: "m-old", payload: { role: "assistant", text: `the key is ${OLD}` } };
    db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)").run(w.session_id, 900_000, "message.done", at, JSON.stringify(event));
  } finally {
    db.close();
  }
  await client.call("secret.set", { request_id: "cv-set", repo: { path: repo }, secrets: [{ name: "OLD_KEY", value: OLD }] });
  expect(await client.call("message.caveman_version", { session_id: w.session_id, item_id: "m-old" })).toEqual({ text: "short" });
  expect(rewritten.at(-1)).toBe("the key is [secret:OLD_KEY]");
});

test("a backlog stored before its values became secrets replays scrubbed, batched or not", async () => {
  const OLD = 'rp-8Zt"3Kw\\5Qm7Vx2';
  const repo = makeRepo(root, { "README.md": "replayed\n" });
  const w = await client.call("workspace.create", { request_id: "rp-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const at = new Date().toISOString();
  const drafts = [
    { type: "tool.started", item_id: "t-old", payload: { name: "Bash", title: "Run", kind: "command", input: { command: `export K=${OLD}`, [OLD]: 1 } } },
    { type: "reasoning.delta", item_id: "r-old", payload: { text: "nothing to hide" } },
    { type: "tool.done", item_id: "t-old", payload: { status: "completed", result: { stdout: JSON.stringify({ k: OLD }) } } },
  ];
  // Journaled at the head in one write, as an append would be (the new chat's setup appends beside it).
  const db = new DatabaseSync(config.dbPath, { timeout: 5_000 });
  let head = 0;
  let stored: Array<{ session_id: string; cursor: number; at: string; type: string }> = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    head = (db.prepare("SELECT json_extract(session, '$.head') AS head FROM caveman_sp_workspaces WHERE session_id = ?").get(w.session_id) as { head: number }).head;
    stored = drafts.map((e, i) => ({ session_id: w.session_id, cursor: head + i + 1, at, ...e }));
    for (const e of stored) db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)").run(w.session_id, e.cursor, e.type, at, JSON.stringify(e));
    db.prepare("UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?").run(head + stored.length, w.session_id);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  await client.call("secret.set", { request_id: "rp-set", repo: { path: repo }, secrets: [{ name: "OLD_KEY", value: OLD }] });
  const expected = createScrubber([{ name: "OLD_KEY", value: OLD }]).scrubDeep(stored);
  const replayed: unknown[] = [];
  // Only the rows stored here: the new chat's own setup may append behind them.
  const mine = new Set(stored.map((e) => e.cursor));
  await client.attach(w.session_id, head, (event) => mine.has(event.cursor) && replayed.push(event));
  await until(() => replayed.length === stored.length);
  expect(replayed).toEqual(expected);
  expect(JSON.stringify(replayed)).not.toContain("rp-8Zt");
  expect(replayed[1]).toEqual(stored[1]);
});

test("a message's Caveman version is rewritten once, and again only when what the model would be sent changes", async () => {
  const VALUE = "cv-9Lp2Rt5Xw8Nq4Bz7";
  const repo = makeRepo(root, { "README.md": "cached\n" });
  const w = await client.call("workspace.create", { request_id: "cvc-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const at = new Date().toISOString();
  const db = new DatabaseSync(config.dbPath);
  try {
    const event = { session_id: w.session_id, cursor: 900_001, at, type: "message.done", item_id: "m-cached", payload: { role: "assistant", text: `deploy with ${VALUE}` } };
    db.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)").run(w.session_id, 900_001, "message.done", at, JSON.stringify(event));
  } finally {
    db.close();
  }
  const ask = () => client.call("message.caveman_version", { session_id: w.session_id, item_id: "m-cached" });
  const before = rewritten.length;
  expect(await ask()).toEqual({ text: "short" });
  expect(await ask()).toEqual({ text: "short" });
  expect(rewritten.length - before).toBe(1);
  // The value became a secret: the model gets the scrubbed text, never a rewrite made from the old one.
  await client.call("secret.set", { request_id: "cvc-set", repo: { path: repo }, secrets: [{ name: "DEPLOY_KEY", value: VALUE }] });
  expect(await ask()).toEqual({ text: "short" });
  expect(rewritten.length - before).toBe(2);
  expect(rewritten.at(-1)).toBe("deploy with [secret:DEPLOY_KEY]");
});

test("a secret.set retried under the same request_id with another value is a conflict, not a silent no-op", async () => {
  const repo = makeRepo(root, { "README.md": "receipts\n" });
  const set = (value: string) => client.call("secret.set", { request_id: "rcpt-1", repo: { path: repo }, secrets: [{ name: "ROTATED", value }] });
  await set("first-rotated-value-1");
  expect(await failure(set("first-rotated-value-1"))).toBe("ok");
  expect(await failure(set("second-rotated-value-2"))).toBe("request_id_conflict");
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT params_hash, result FROM caveman_sp_receipts WHERE method = 'secret.set'").all() as Array<{ params_hash: string; result: string }>;
    expect(rows.some((r) => r.result.includes("first-rotated-value-1") || r.params_hash.includes("first-rotated"))).toBe(false);
  } finally {
    db.close();
  }
});

test("a name that changes how processes run can't be stored; an engine login name can", async () => {
  const repo = makeRepo(root, { ".gitignore": ".env*\n" });
  fs.writeFileSync(path.join(repo, ".env.local"), "API_TOKEN=api-token-value-12\nBASH_ENV=/tmp/evil-rc\n");
  const r = { path: repo };
  for (const name of ["PATH", "BASH_ENV", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "HTTPS_PROXY", "NODE_OPTIONS"]) {
    expect(await failure(client.call("secret.set", { request_id: `rsv-${name}`, repo: r, secrets: [{ name, value: "reserved-value-123" }] }))).toBe("invalid_params");
  }
  expect(await failure(client.call("secret.import", { request_id: "rsv-imp", repo: r, path: ".env.local" }))).toBe("invalid_params");
  expect((await client.call("secret.list", { repo: r })).secrets).toEqual([]);
  // Picking names stores only those: leaving the reserved one out lets the rest in.
  const picked = await client.call("secret.import", { request_id: "rsv-pick", repo: r, path: ".env.local", names: ["API_TOKEN"] });
  expect(picked.secrets.map((s) => s.name)).toEqual(["API_TOKEN"]);
  await client.call("secret.delete", { request_id: "rsv-pick-del", repo: r, name: "API_TOKEN" });
  expect(await failure(client.call("secret.set", { request_id: "rsv-ok", repo: r, secrets: [{ name: "ANTHROPIC_API_KEY", value: "project-own-key-1234" }] }))).toBe("ok");
});

test("an empty reasoning delta (a thought's line, before its text) goes out; a delta the stream holds back does not", () => {
  const scrubber = createScrubber([{ name: "CANARY", value: CANARY }]);
  const scrub = makeOutputScrub();
  const ev = (text: string) => ({ at: "t", type: "reasoning.delta", turn_id: "r1", item_id: "th2", payload: { text } }) as DraftEvent;
  expect(scrub(scrubber, [ev("")])).toMatchObject([{ type: "reasoning.delta", payload: { text: "" } }]);
  expect(scrub(scrubber, [ev(CANARY.slice(0, 6))])).toEqual([]);
});
