// The Chief's picker (chief.get's `picker`) beside the composer's: a favorite is "<section>/<model>", and the composer
// makes Claude Agent one section per login (`claude-agent#<account>`) as soon as engine.list lists more than one login
// (apps/web runner.ts sectionOf). The Chief's Claude sections must name their login then too, or a star made in one
// picker is not a star in the other. Every signed-in login is the Chief's to pick, a plan's or a key's.
import { ClaudeSettings, ProviderInstanceId, type ServerProvider } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makePendingClaudeProvider } from "../provider/ClaudeProvider.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot } from "./testHarness.ts";

const { probePending: _pending, ...claude } = Effect.runSync(
  makePendingClaudeProvider(Schema.decodeSync(ClaudeSettings)({})),
);
const login = (instanceId: string, auth: ServerProvider["auth"]): ServerProvider => ({
  ...claude,
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
  installed: true,
  status: "ready",
  auth,
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
});

test("with one Claude plan beside a Claude login on an API key, the Chief's Claude sections are the composer's: one per login", async () => {
  const plan = login(ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID, {
    status: "authenticated",
    email: "ada@work.example",
    type: "max",
  });
  const apiKey = login("claudeAgent-account-1a2b3c4d", {
    status: "authenticated",
    type: "apiKey",
    label: "Claude API Key",
  });
  let providers = [plan, apiKey];
  const registry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.sync(() => providers),
    refreshInstance: () => Effect.sync(() => providers),
  } as never);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: registry,
  });
  const client = connect(runtime.url, runtime.token);
  // A project, so it has a Chief.
  await client.call("project.create", {
    request_id: "chief-project",
    path: makeRepo(tempRoot("chief-picker-"), { "README.md": "chief\n" }),
    name: "chief-project",
  });
  /** Each picker's Claude Agent sections for a pick on the plan's login: the composer's (runner.ts sectionOf), the Chief's. */
  const sections = async () => {
    const engine = (await client.call("engine.list", {})).engines.find(
      (e) => e.id === "claude-agent",
    )!;
    const composer =
      engine.auth.accounts.length > 1 ? "claude-agent#claudeAgent:default" : "claude-agent";
    const { picker } = await client.call("chief.get", {});
    const chief = (picker ?? [])
      .filter((o) => o.engine === "claude-agent")
      .map((o) => (o.account_id ? `${o.engine}#${o.account_id}` : o.engine));
    return { composer: [composer], chief };
  };
  try {
    expect(await sections()).toEqual({
      composer: ["claude-agent#claudeAgent:default"],
      chief: ["claude-agent#claudeAgent:default", "claude-agent#claudeAgent-account-1a2b3c4d"],
    });
    // Only the plan wears the plan's quiet label.
    const { picker } = await client.call("chief.get", {});
    expect((picker ?? []).filter((o) => o.engine === "claude-agent").map((o) => o.label)).toEqual([
      "Plan · via Claude Code",
      undefined,
    ]);
    // The plan alone: one section in each, named by its engine.
    providers = [plan];
    expect(await sections()).toEqual({ composer: ["claude-agent"], chief: ["claude-agent"] });
  } finally {
    client.close();
    await runtime.close();
  }
});
