// The connected set Auto and the Chief choose from: every kind of source, and nothing that is not connected.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { connectedModels, connectedSources } from "./connected.ts";
import { cavemanModels, type CavemanKeys } from "./credentials.ts";
import { cheapCavemanModel } from "./rewriter.ts";
import { startProviderSignIn } from "./signIn.ts";

const sources = (keys: CavemanKeys) => Effect.map(cavemanModels(keys), (models) => ({ models, list: connectedSources(keys, models) }));

describe("connectedSources", () => {
  it.effect("lists keys, endpoints, credits and a linked plan, each with its own models, in Models & keys order", () =>
    Effect.gen(function* () {
      const keys: CavemanKeys = {
        caveman: { key: "cvk-credits-0123456789" },
        "custom-lab": { endpoint: { name: "Lab", baseUrl: "http://lab.local/v1", models: ["qwen-coder", "glm-local"] } },
        openai: { key: "sk-openai-0123456789abcdef" },
        chatgpt: { key: "cvplan-chatgpt-0123456789" },
        anthropic: { key: ("sk-" + "ant-0123456789abcdef") },
      };
      const { list } = yield* sources(keys);
      assert.deepEqual(
        list.map((source) => [source.id, source.kind]),
        [["anthropic", "key"], ["openai", "key"], ["custom-lab", "endpoint"], ["chatgpt", "plan"], ["caveman", "credits"]],
      );
      const by = Object.fromEntries(list.map((source) => [source.id, source.models]));
      assert.equal(by.anthropic![0], "anthropic/claude-opus-5-5");
      assert.deepEqual(by["custom-lab"], ["custom-lab/qwen-coder", "custom-lab/glm-local"]);
      assert.ok(by.chatgpt!.every((id) => id.startsWith("chatgpt/openai/gpt-")), JSON.stringify(by.chatgpt));
      assert.ok(by.caveman!.includes("caveman/anthropic/claude-sonnet-5-5"));
    }),
  );

  it.effect("has nothing for what is not connected: no key, a stored entry the registry dropped, an endpoint with no models", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* sources({})).list, []);
      const { list, models } = yield* sources({
        "custom-empty": { endpoint: { name: "Empty", baseUrl: "http://x/v1", models: [] } },
        "no-such-provider": { key: "x" },
      });
      assert.deepEqual(list, []);
      assert.deepEqual(connectedModels({}, models), []);
    }),
  );

  it.effect("the Chief's fast floor is always a connected model, whatever the source", () =>
    Effect.gen(function* () {
      for (const keys of [{ chatgpt: { key: "cvplan-0123456789" } }, { deepseek: { key: "sk-ds-0123456789" } }, { "custom-lab": { endpoint: { name: "Lab", baseUrl: "http://lab/v1", models: ["m1"] } } }] as const) {
        const { list, models } = yield* sources(keys);
        const connected = list.flatMap((source) => source.models);
        const floor = cheapCavemanModel(keys, connected, models);
        assert.ok(floor !== undefined && connected.includes(floor), `${JSON.stringify(keys)} -> ${floor}`);
      }
      // A key the cheap table names: its pick, as before.
      const { list, models } = yield* sources({ anthropic: { key: ("sk-" + "ant-0123456789abcdef") } });
      assert.equal(cheapCavemanModel({ anthropic: { key: "k" } }, list.flatMap((source) => source.models), models), "anthropic/claude-haiku-5-5");
    }),
  );

  it.effect("two keys of one provider are two sources: their own models, their own key on the wire, removed one at a time", () =>
    Effect.gen(function* () {
      const keys: CavemanKeys = {
        openai: { key: "sk-openai-first-0123456789" },
        "openai~2": { key: "sk-openai-second-0123456789" },
        anthropic: { key: ("sk-" + "ant-first-0123456789") },
        "anthropic~2": { key: ("sk-" + "ant-second-0123456789") },
      };
      const { list, models } = yield* sources(keys);
      assert.deepEqual(list.map((source) => [source.id, source.kind]), [["anthropic", "key"], ["anthropic~2", "key"], ["openai", "key"], ["openai~2", "key"]]);
      const by = Object.fromEntries(list.map((source) => [source.id, source.models]));
      // The same current models under each key's own id.
      assert.deepEqual(by["openai~2"], by.openai!.map((id) => id.replace(/^openai\//, "openai~2/")));
      assert.ok(by["anthropic~2"]!.includes("anthropic~2/claude-sonnet-5-5"));
      // Each model pays with its own key, and goes out as the provider's own.
      for (const [slot, key] of [["openai", "sk-openai-first-0123456789"], ["openai~2", "sk-openai-second-0123456789"], ["anthropic~2", ("sk-" + "ant-second-0123456789")]] as const) {
        const model = models.getModels(slot)[0]!;
        const auth = yield* Effect.promise(() => models.getAuth(model));
        assert.equal(auth?.auth.apiKey, key, slot);
      }
      // Removing the first OpenAI key leaves the second, and Anthropic's, as they were.
      const { ["openai"]: _gone, ...rest } = keys;
      const after = (yield* sources(rest)).list.map((source) => source.id);
      assert.deepEqual(after, ["anthropic", "anthropic~2", "openai~2"]);
    }),
  );

  it.effect("two Claude logins and two ChatGPT logins are four sources, each its own account, never the engine's own models", () =>
    Effect.gen(function* () {
      const keys: CavemanKeys = { openai: { key: "sk-openai-0123456789abcdef" } };
      const models = yield* cavemanModels(keys);
      const claude = ["claude-opus-5-5", "claude-sonnet-5-5"];
      const logins = [
        { engine: "claude-agent", account: "claudeAgent:default", models: claude },
        { engine: "claude-agent", account: "claudeAgent-account-1a2b3c4d", models: claude },
        { engine: "codex", account: "codex", models: ["gpt-6-astra"] },
        { engine: "codex", account: "codex-account-chatgpt-5e6f7a8b", models: ["gpt-6-astra"] },
        // Signed in but with no model to run: nothing to pick.
        { engine: "claude-agent", account: "claudeAgent-account-00000000", models: [] },
      ];
      const list = connectedSources(keys, models, logins);
      assert.deepEqual(
        list.map((source) => [source.id, source.kind, source.engine]),
        [
          ["openai", "key", undefined],
          ["claudeAgent:default", "login", "claude-agent"],
          ["claudeAgent-account-1a2b3c4d", "login", "claude-agent"],
          ["codex", "login", "codex"],
          ["codex-account-chatgpt-5e6f7a8b", "login", "codex"],
        ],
      );
      // Same models, told apart by the account: the Chief's Claude-plan route names which login it runs on.
      assert.deepEqual(list[2]!.models, claude);
      // The Caveman engine's own Auto never routes to a harness login.
      assert.ok(connectedModels(keys, models).every((id) => id.startsWith("openai/")));
      // Removing one login leaves the other.
      assert.deepEqual(
        connectedSources(keys, models, logins.filter((login) => login.account !== "claudeAgent:default")).filter((s) => s.engine === "claude-agent").map((s) => s.id),
        ["claudeAgent-account-1a2b3c4d"],
      );
    }),
  );

  it.effect("only the offered plan sign-ins are reachable from the engine's catalog, never pi-ai's Claude Pro/Max OAuth", () =>
    Effect.gen(function* () {
      const models = yield* cavemanModels({ anthropic: { key: ("sk-" + "ant-0123456789abcdef") }, openai: { key: "sk-0123456789abcdef" } });
      const withOAuth = models.getProviders().filter((provider) => provider.auth.oauth !== undefined).map((provider) => provider.id);
 // compact, GitHub Copilot and SuperGrok; never claude.ai's or the legacy Codex login.
      assert.deepEqual(withOAuth.sort(), ["github-copilot", "openai", "xai"]);
      // The keys still work as keys.
      assert.ok(models.getModel("anthropic", "claude-sonnet-5-5") !== undefined);
    }),
  );

  it("nor does its sign-in flow start for claude.ai or the legacy Codex login", async () => {
    for (const provider of ["anthropic", "openai-codex"]) {
      const started = await startProviderSignIn(provider, "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d").then(
        () => "started",
        (error: Error) => error.message,
      );
      assert.match(started, /has no sign-in here; paste an API key\.$/);
    }
  });
});
