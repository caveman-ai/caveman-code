// engine.list's auth state while an engine's first probe is pending: "checking", not "unavailable".
// A probe that then fails reads "unavailable"; one that passes reads its verdict.
import { ClaudeSettings, CodexSettings, ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makePendingClaudeProvider } from "../provider/ClaudeProvider.ts";
import { makePendingCodexProvider } from "../provider/CodexProvider.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { applyProviderCompatibility } from "../provider/providerCompatibility.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";

// What the managed provider publishes for Claude Agent before its first probe.
const pending: ServerProvider = {
  ...Effect.runSync(makePendingClaudeProvider(Schema.decodeSync(ClaudeSettings)({}))),
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
};

test("the Claude Agent and Codex placeholders are marked pending; a disabled engine's is not", () => {
  expect(pending.probePending).toBe(true);
  expect(Effect.runSync(makePendingCodexProvider(Schema.decodeSync(CodexSettings)({}))).probePending).toBe(true);
  expect(Effect.runSync(makePendingClaudeProvider(Schema.decodeSync(ClaudeSettings)({ enabled: false }))).probePending).toBeUndefined();
});

test("engine.list says checking while the first probe is pending, then the probe's verdict", async () => {
  let current = pending;
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [current]),
    refreshInstance: () => Effect.sync(() => [current]),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: registry });
  const client = connect(runtime.url, runtime.token);
  const claude = async () => (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!.auth.state;
  try {
    expect(await claude()).toBe("checking");
    const { probePending: _pending, ...probed } = pending;
    current = { ...probed, installed: true, status: "error", message: "Claude Agent CLI is installed but failed to run." };
    expect(await claude()).toBe("unavailable");
    current = { ...probed, installed: true, status: "ready", auth: { status: "authenticated" } };
    expect(await claude()).toBe("signed_in");
  } finally {
    client.close();
    await runtime.close();
  }
});

test("a probe that changes engine.list's answer is pushed to every connection as engine.changed", async () => {
  let current = pending;
  const changes = Effect.runSync(PubSub.unbounded<ReadonlyArray<ServerProvider>>());
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [current]),
    refreshInstance: () => Effect.sync(() => [current]),
    streamChanges: Stream.fromPubSub(changes),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: registry });
  const client = connect(runtime.url, runtime.token);
  const pushed: Array<string> = [];
  client.on("engine.changed", (answer) => pushed.push(answer.engines.find((e) => e.id === "claude-agent")!.auth.state));
  try {
    expect((await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!.auth.state).toBe("checking");
    const { probePending: _pending, ...probed } = pending;
    current = { ...probed, installed: true, status: "ready", auth: { status: "authenticated" } };
    await Effect.runPromise(PubSub.publish(changes, [current]));
    for (let i = 0; i < 100 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pushed).toEqual(["signed_in"]);
    // A change that leaves the answer as it was sends nothing.
    await Effect.runPromise(PubSub.publish(changes, [current]));
    await new Promise((r) => setTimeout(r, 300));
    expect(pushed).toEqual(["signed_in"]);
  } finally {
    client.close();
    await runtime.close();
  }
});

test("a Codex too old for this release reads Ready with the update it needs; a supported one carries no hint", async () => {
  const { probePending: _pending, ...placeholder } = Effect.runSync(makePendingCodexProvider(Schema.decodeSync(CodexSettings)({})));
  const codexAt = (version: string): ServerProvider =>
    // What ProviderRegistry publishes: the snapshot classified against the bundled compatibility policy.
    applyProviderCompatibility(
      { ...placeholder, instanceId: ProviderInstanceId.make("codex"), driver: ProviderDriverKind.make("codex"), installed: true, version, status: "ready", auth: { status: "authenticated", type: "chatgpt" } },
      ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
    );
  let current = codexAt("0.120.0");
  expect(current.compatibilityAdvisory?.status).toBe("broken");
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [current]),
    refreshInstance: () => Effect.sync(() => [current]),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { alsoAs: ["codex"], provide: registry });
  const client = connect(runtime.url, runtime.token);
  const codex = async () => (await client.call("engine.list", {})).engines.find((e) => e.id === "codex")!;
  try {
    const old = await codex();
    expect({ state: old.auth.state, version: old.version }).toEqual({ state: "signed_in", version: "0.120.0" });
    expect(old.upgrade).toEqual({ hint: expect.stringMatching(/known to be incompatible.*Use >=0\.159\.0\./) });
    current = codexAt("0.159.0");
    expect((await codex()).upgrade).toBeUndefined();
  } finally {
    client.close();
    await runtime.close();
  }
});

test("a Claude Agent login carries a tag the person can change, like every other account", async () => {
  const { probePending: _pending, ...probed } = pending;
  const current: ServerProvider = { ...probed, installed: true, status: "ready", auth: { status: "authenticated", email: "julius@caveman.so" } };
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [current]),
    refreshInstance: () => Effect.sync(() => [current]),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: registry });
  const client = connect(runtime.url, runtime.token);
  const account = async () => (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!.auth.accounts[0];
  try {
    expect(await account()).toMatchObject({ label: "julius@caveman.so", tag: "JU" });
    const id = (await account())!.id;
    await client.call("engine.account.tag", { request_id: "t1", engine: "claude-agent", account_id: id, tag: "ME" });
    expect((await account())!.tag).toBe("ME");
  } finally {
    client.close();
    await runtime.close();
  }
});

test("Cursor's Keychain usage switch is T3's cursorKeychainUsageEnabled, and turning it on probes Cursor again", async () => {
  const refreshed: Array<string> = [];
  const cursor = { ...pending, instanceId: "cursor", driver: "cursor" } as unknown as ServerProvider;
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [pending, cursor]),
    refreshInstance: (id: string) => Effect.sync(() => (refreshed.push(id), [pending, cursor])),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.mergeAll(registry, ServerSettings.layerTest().pipe(Layer.orDie)) });
  const client = connect(runtime.url, runtime.token);
  try {
 // Only a Mac keeps native login in the Keychain: elsewhere there is nothing to switch.
    const mac = process.platform === "darwin";
    expect((await client.call("settings.get", {})).cursor_keychain_usage).toBe(mac ? false : undefined);
    const next = await client.call("settings.set", { request_id: "k1", settings: { cursor_keychain_usage: true } });
    expect(next.cursor_keychain_usage).toBe(mac ? true : undefined);
    for (let i = 0; i < 50 && !refreshed.includes("cursor"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(refreshed).toEqual(["cursor"]);
  } finally {
    client.close();
    await runtime.close();
  }
});

test("engine.commands: the chat's engine's own commands in its checkout, read for that checkout", async () => {
  const { probePending: _pending, ...probed } = pending;
  const asked: Array<{ instanceId: string; cwd: string }> = [];
  let cwd = "";
  const current = (): ServerProvider => ({
    ...probed,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    slashCommands: [{ name: "compact" }],
    workspaceSnapshots: cwd
      ? [{ cwd, checkedAt: new Date().toISOString(), slashCommands: [{ name: "compact" }, { name: "security-review", description: "Review the branch for security issues", input: { hint: "[path]" } }], skills: [] }]
      : [],
  });
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => [current()]),
    refreshInstance: () => Effect.sync(() => [current()]),
    refreshWorkspaceSnapshot: (input: { instanceId: string; cwd: string }) =>
      Effect.sync(() => {
        asked.push(input);
        cwd = input.cwd;
        return [current()];
      }),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: registry });
  const client = connect(runtime.url, runtime.token);
  try {
    const repo = makeRepo(tempRoot("sp-engine-commands-"), { "README.md": "hi\n" });
    const w = await client.call("workspace.create", { request_id: "c1", repo: { path: repo }, title: "commands", engine: "claude-agent", options: { model: MODEL } });
    const { commands } = await client.call("engine.commands", { workspace_id: w.id });
    expect(commands).toEqual([{ name: "compact" }, { name: "security-review", description: "Review the branch for security issues", hint: "[path]" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.instanceId).toBe(ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID);
    expect(asked[0]!.cwd).not.toBe(repo); // the chat's own worktree, not the repository it came from
    await expect(client.call("engine.commands", { workspace_id: "ws_missing" })).rejects.toThrow(/no workspace/);
  } finally {
    client.close();
    await runtime.close();
  }
});
