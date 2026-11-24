// Every system after a Cloud computer sleeps and wakes (cloud-computers CONTRACT §5.3: Cloud mints a new identity at
// each wake, a new runtime id on the same computer and disk, and refuses the old one). The computer is under the rule:
// its person's credentials stay outside it. What it settles, with nobody doing anything in between:
//
// - A chat's changes read the same after the wake, and Undo of a turn made before the sleep puts its files back: both
//   are the disk's own git.
// - The chat's pull request is still its pull request, and the pill follows Cloud's word again, checks included.
// - The Caveman engine's Auto is still offered. The credits key the runtime held went with its memory: the first ask
//   after the wake has Cloud mint one for the runtime the computer woke as, never the one it stopped under.
// - Not one route the rule closes is called, before or after.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import type { SessionEvent } from "@caveman-app/session-protocol";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { routingCredential } from "../router/routerKey.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit } from "./builders.kit.ts";
import { CLAUDE_PLAN, everySystemKit, OPENAI_KEY, watch } from "./everySystem.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { computer, wake } = everySystemKit(cleanups);
const { startTools, githubWith, checkoutOf } = builderKit(cleanups);

const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.succeed([
    {
      instanceId: "claudeAgent",
      installed: true,
      auth: { status: "authenticated" },
      models: [
        { slug: MODEL, name: "Sonnet", isDefault: true, capabilities: { optionDescriptors: [] } },
      ],
    },
    {
      instanceId: "caveman",
      installed: true,
      auth: { status: "authenticated" },
      models: [
        {
          slug: "deepseek/deepseek-flash",
          name: "DeepSeek Flash",
          isDefault: true,
          capabilities: { optionDescriptors: [] },
        },
      ],
    },
  ]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"]);

const checkpoints = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((event) => (event.type === "checkpoint.created" ? [event.payload] : []));
const FILES = { "README.md": "widgets\n", "src/api.ts": "export const v = 1;\n" };

test.skipIf(process.platform === "win32")(
  "a Cloud computer under the rule sleeps and wakes under a new runtime id: a chat's changes, Undo, its pull request and Auto are as they were",
  async () => {
    const inner = await startTestCloud();
    cleanups.push(inner.close);
    await startTools();
    inner.state.gitBackend = githubWith(makeRepo(tempRoot("every-system-wake-source-"), FILES));
    inner.state.environments.credits.on = true;
    inner.state.environments.credits.gateway = "https://gateway.example";
    const minted = inner.state.environments.credits.minted;
    const asleep = await computer({
      inner,
      checkout: checkoutOf(inner.state.gitBackend, "every-system-wake-"),
      connections: [CLAUDE_PLAN, OPENAI_KEY],
      alsoAs: ["caveman"],
      provide: providers,
    });
    const cavemanModels = async (client: typeof asleep.client) =>
      (await client.call("engine.list", {})).engines
        .find((engine) => engine.id === "caveman")!
        .models.map((model) => model.id);

    // ---- Before the sleep: a committed change with its pull request, a second change not yet kept, and Auto asked once.
    const chat = await createReady(asleep.client, {
      request_id: "chat",
      repo: asleep.where,
      title: "Raise the version",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const seen = await watch(asleep.client, chat);
    await seen.turn("sh: printf 'export const v = 2;\\n' > src/api.ts");
    await asleep.client.call("git.commit", {
      request_id: "commit",
      workspace_id: chat.id,
      message: "Raise the version",
    });
    const pr = await asleep.client.call("git.pr", {
      request_id: "pr",
      workspace_id: chat.id,
      title: "Raise the version",
      body: "To 2.",
    });
    // A pull request Cloud opens is in its table at once (Cloud's pull_requests_state.go); the stand-in is told.
    inner.state.chats.pullRequests.set(chat.branch, {
      number: pr.number,
      url: pr.url,
      state: "open",
      checks: "none",
    });
    await seen.turn("sh: printf 'two\\n' > NOTES.md");
    await until(
      () =>
        checkpoints(seen.events).some((made) =>
          made.files?.some((file) => file.path === "NOTES.md"),
        ),
      60_000,
    );
    const second = checkpoints(seen.events).findLast((made) =>
      made.files?.some((file) => file.path === "NOTES.md"),
    )!;
    const read = async (client: typeof asleep.client) => ({
      status: (await client.call("git.status", { workspace_id: chat.id })).files
        .map((file) => file.path)
        .sort(),
      diff: (
        await client.call("fs.diff", { workspace_id: chat.id, to: second.checkpoint_id })
      ).files
        .map((file) => [file.path, file.status])
        .sort(),
      pill: (await client.call("workspace.get", { workspace_id: chat.id })).pull_request,
    });
    const before = await read(asleep.client);
    expect(before).toEqual({
      status: ["NOTES.md"],
      diff: expect.arrayContaining([["NOTES.md", "added"]]),
      pill: { number: pr.number, url: pr.url, state: "open" },
    });
    expect((await cavemanModels(asleep.client))[0]).toBe("auto");
    const held = await routingCredential.get();
    expect(minted.map((made) => made.runtimeId)).toEqual([asleep.identity.runtimeId]);
    expect(held?.key).toBe(minted[0]!.key);

    // ---- It sleeps, and wakes as another runtime on the same disk.
    const awake = await wake(asleep);
    expect(awake.identity.computerId).toBe(asleep.identity.computerId);
    expect(awake.identity.runtimeId).not.toBe(asleep.identity.runtimeId);
    const { client } = awake;

    // The chat, its changes and its pull request, as they were. Nobody opened, picked or signed in to anything.
    expect((await client.call("workspace.get", { workspace_id: chat.id })).session_id).toBe(
      chat.session_id,
    );
    expect(await read(client)).toEqual(before);
    // Undo of the turn made before the sleep: its file is gone again.
    expect(
      await client.call("checkpoint.undo", {
        request_id: "undo",
        session_id: chat.session_id,
        checkpoint_id: second.checkpoint_id,
      }),
    ).toMatchObject({ files: ["NOTES.md"] });
    expect((await client.call("git.status", { workspace_id: chat.id })).files).toEqual([]);
    // The chat carries on, and its pill follows Cloud's word again: red, then merged and green.
    const after = await watch(client, chat, "awake-");
    // Its journal is the one written before the sleep: both turns are in it.
    await until(
      () => after.events.filter((event) => event.type === "turn.done").length === 2,
      30_000,
    );
    expect(after.said()).toEqual(seen.said());
    inner.state.chats.pullRequests.set(chat.branch, {
      number: pr.number,
      url: pr.url,
      state: "open",
      checks: "fail",
    });
    await after.turn("how are the checks?");
    expect(after.said().at(-1)).toBe("smoke ok: how are the checks?");
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: chat.id })).pull_request?.checks ===
        "failing",
      30_000,
    );
    inner.state.chats.pullRequests.set(chat.branch, {
      number: pr.number,
      url: pr.url,
      state: "merged",
      checks: "pass",
    });
    await after.turn("and now?");
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: chat.id })).pull_request?.state ===
        "merged",
      30_000,
    );
    expect((await client.call("workspace.get", { workspace_id: chat.id })).pull_request).toEqual({
      ...pr,
      state: "merged",
      checks: "passing",
    });

    // Auto: still offered, and listing it asked Cloud for nothing. The key held before the sleep is gone with the
    // runtime's memory; the first ask has Cloud mint one for the runtime the computer woke as.
    expect((await cavemanModels(client))[0]).toBe("auto");
    expect(minted).toHaveLength(1);
    const now = await routingCredential.get();
    expect(minted.map((made) => made.runtimeId)).toEqual([
      asleep.identity.runtimeId,
      awake.identity.runtimeId,
    ]);
    expect(now).toEqual({ key: minted[1]!.key, url: "https://gateway.example" });
    expect(now?.key).not.toBe(held?.key);

    // The rule held on both sides of the sleep.
    expect((await awake.cloud.report()).closed).toEqual([]);
  },
  300_000,
);
