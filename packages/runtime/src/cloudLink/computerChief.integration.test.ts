// The Chief on a Cloud computer that holds no repository (a person's Chief computer, Caveman Cloud the spec
// addendum 2026-10-29): the runtime boots on an empty workspace, makes the home Chief on chief.get, syncs its
// summary to Cloud as a Chief's, takes notes onto its board, and runs its turns there on the Caveman engine. Real
// runtime, tools exec channel, test Cloud; the Caveman engine's model scripted (no network), as chief.test.ts does.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, CavemanAdapterV2Driver, makeCavemanAdapterV2 } from "@caveman-app/provider-caveman/server";
import { createAssistantMessageEventStream, fauxModel, type AssistantMessage, type ModelContext } from "@caveman-app/provider-caveman/testing";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll, type Identity } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

// Skipped on Windows: a Cloud computer is Linux, and its tools run in a tools container over a Unix socket.
const onComputer = test.skipIf(process.platform === "win32");
const cleanups: Array<() => unknown> = [];

type Turn = { readonly text?: string; readonly tools?: ReadonlyArray<{ readonly name: string; readonly args: unknown }> };
/** The Chief's answers, one per model call, in order; "Noted." when they run out. */
const chiefTurns: Array<(context: ModelContext) => Turn> = [];
/** Every model call: the tools it offered and its newest user input. */
const calls: Array<{ readonly tools: ReadonlyArray<string>; readonly input: string }> = [];
const lastUser = (context: ModelContext) => {
  const user = [...context.messages].reverse().find((m) => m.role === "user") as { content?: unknown } | undefined;
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};
const noteItem = (context: ModelContext) => /item=\\?"(ci-[0-9a-f]{8})/.exec(lastUser(context))?.[1];
/** The tools a model call offers: those its system messages added, less those they removed. */
const offered = (context: ModelContext) => {
  const names = new Set((context.tools ?? []).map((t) => t.name));
  for (const m of context.messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) names.add(t.name);
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
  }
  return [...names];
};

const streamFn = ((model: { api: string; provider: string; id: string }, context: ModelContext) => {
  calls.push({ tools: offered(context), input: lastUser(context) });
  const turn = chiefTurns.shift()?.(context) ?? { text: "Noted." };
  const content: AssistantMessage["content"] = [
    ...(turn.text === undefined ? [] : [{ type: "text" as const, text: turn.text }]),
    ...(turn.tools ?? []).map((t, i) => ({ type: "toolCall" as const, id: `call-${calls.length}-${i}`, name: t.name, arguments: JSON.parse(JSON.stringify(t.args)) as never })),
  ];
  const stopReason = (turn.tools ?? []).length > 0 ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api as never,
    provider: model.provider,
    model: model.id,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 } },
    stopReason,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  setTimeout(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  }, 0);
  return stream;
}) as never;

let cloud: TestCloud;
let tools: ChildProcess;
let identity: Identity;
let checkout: string;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  const socket = path.join(tempRoot("computer-chief-tools-"), "tools.sock");
  tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  for (const deadline = Date.now() + 10_000; !fs.existsSync(socket) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // A computer the computers service made with no repository: its workspace mounted and empty, no repository anywhere.
  const linkDir = path.join(tempRoot("computer-chief-link-"), "link");
  identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  checkout = path.join(tempRoot("computer-chief-"), "workspace");
  fs.mkdirSync(checkout);
  const host = Layer.succeedContext(await Effect.runPromise(Effect.scoped(Layer.build(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))))));
  const scripted: typeof CavemanAdapterV2Driver = {
    ...CavemanAdapterV2Driver,
    create: (input) =>
      makeCavemanAdapterV2({ instanceId: input.instanceId, settings: { ...input.config, enabled: input.enabled }, engine: { streamFn, model: fauxModel({ priced: true }) } }).pipe(Effect.orDie),
  };
  const registry = ProviderAdapterRegistry.layerFromDrivers({
    drivers: [scripted],
    configMap: { [ProviderInstanceId.make("caveman")]: { driver: CAVEMAN_PROVIDER, config: { optimization: "off" } } },
  }).pipe(Layer.provide(Layer.mergeAll(host, IdAllocator.layer, NodeServices.layer)), Layer.orDie);
  const provide = Layer.mergeAll(
    host,
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide, registry });
  client = connect(runtime.url, runtime.token);
  cleanups.push(async () => {
    client.close();
    await runtime.close();
  });
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let requests = 0;
const rid = () => `chief-${++requests}`;

onComputer("chief.get makes the first Chief on this computer, with no project needed and no repository of its own, and Cloud lists it as a Chief", async () => {
  const chief = await client.call("chief.get", {});
  expect(chief.chief).toMatchObject({ name: "Chief", project_ids: [] });
  await client.call("project.create", { request_id: rid(), path: makeRepo(tempRoot("computer-chief-project-"), { "README.md": "chief\n" }), name: "chief-project" });
  expect(chief.availability).toBe("no_key");
  expect(chief.workspace).toMatchObject({ kind: "chief", engine: "caveman", base_ref: "", branch: "", computer: { kind: "caveman_cloud", id: identity.computerId } });
  expect(chief.workspace.project_id).toBeUndefined();
  expect((await client.call("chief.get", {})).workspace.id).toBe(chief.workspace.id);
  // Its summary, on this runtime and computer, with no repository.
  await until(() => cloud.state.chats.summaries.has(chief.workspace.session_id), 10_000);
  const summary = cloud.state.chats.summaries.get(chief.workspace.session_id)!;
  expect(summary).toMatchObject({ kind: "chief", workspace_id: chief.workspace.id, engine: "caveman", runtime_id: identity.runtimeId, computer_id: identity.computerId });
  expect(summary.repo).toBeUndefined();
  // Nothing was checked out: the workspace stays empty.
  expect(fs.readdirSync(checkout)).toEqual([]);
}, 60_000);

onComputer("a note to queue lands on its board with no model call", async () => {
  const before = calls.length;
  const { item } = await client.call("chief.capture", { request_id: rid(), text: "look at the flaky deploy test", mode: "queue" });
  expect(item).toMatchObject({ state: "queued", text: "look at the flaky deploy test" });
  await new Promise((r) => setTimeout(r, 500));
  expect((await client.call("chief.items.list", {})).items.map((i) => i.id)).toContain(item.id);
  expect(calls.length).toBe(before);
}, 30_000);

onComputer("with a model connected, a note to decide runs one Chief turn on the computer('s Caveman engine", async () => {
  await client.call("engine.account.add", { request_id: rid(), engine: "caveman", provider: "anthropic", key: "sk-' + 'ant-computer-chief-0123456789abcdef" });
  const chief = await client.call("chief.get", {});
  expect(chief.availability).toBe("ready");
  const events: Array<SessionEvent> = [];
  await client.attach(chief.workspace.session_id, 0, (e) => events.push(e));
  const before = calls.length;
  chiefTurns.push((context) => ({ tools: [{ name: "queue_update", args: { item_id: noteItem(context), title: "Bench the Codex arm", state: "queued" } }] }));
  chiefTurns.push(() => ({ text: "Queued." }));
  const { item } = await client.call("chief.capture", { request_id: rid(), text: "bench the codex arm on this computer", mode: "decide" });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  const started = events.find((e) => e.type === "turn.started") as Extract<SessionEvent, { type: "turn.started" }>;
  expect(started.payload.engine).toBe("caveman");
  // The Chief')s own tools only: nothing that reads, writes or runs on the computer.
  const turn = calls.slice(before);
  expect(turn.length).toBeGreaterThan(0);
  expect(turn[0]!.input).toContain(item.id);
  for (const call of turn) {
    expect(call.tools).toContain("chat_start");
    expect(call.tools.filter((name) => /^(bash|exec|read|read_file|write|write_file|edit|edit_file|grep)$/.test(name))).toEqual([]);
  }
  expect((await client.call("chief.items.list", {})).items.find((i) => i.id === item.id)).toMatchObject({ state: "queued", title: "Bench the Codex arm" });
  expect(fs.readdirSync(checkout)).toEqual([]);
}, 60_000);
