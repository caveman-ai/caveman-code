/** The Caveman engine's side calls: Record a skill as one harness turn on a scripted model, and the usage row every side call records. */
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import type * as Harness from "@caveman-ai/harness";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { setCavemanKey, type CavemanSignIn } from "./credentials.ts";
import { cavemanSideText, sideCallUsage } from "./sideText.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman-side");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

/** A model that answers every call with `text`, and records what each call was sent. */
function answering(text: string, usage = { input: 300, output: 40, cacheRead: 0, cacheWrite: 0 }) {
  const calls: Array<{ readonly model: Model<Api>; readonly context: Context }> = [];
  const streamFn: Harness.HarnessStreamFn = (model: Model<Api>, context: Context) => {
    calls.push({ model, context: structuredClone(context) });
    const stream = createAssistantMessageEventStream();
    const content: AssistantMessage["content"] = [{ type: "text", text }];
    const final: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        ...usage,
        totalTokens: usage.input + usage.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...final, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...final, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end(final);
    });
    return stream;
  };
  return { streamFn, calls };
}

const chatGpt = (): CavemanSignIn => ({
  access: "chatgpt-access",
  refresh: "chatgpt-refresh",
  expires: Date.now() + 3_600_000,
});

describe("Record a skill", () => {
  it.effect(
    "writes the skill in one harness turn on Auto's model, its instructions the whole system text, with its usage",
    () =>
      Effect.gen(function* () {
        yield* setCavemanKey(INSTANCE_ID, "anthropic", ("sk-" + "ant-stored-anthropic-key-0123456789"));
        const { streamFn, calls } = answering("---\nname: deploy\n---\nRun the deploy.");
        const cwd = NodeOS.tmpdir();
        const { text, usage } = yield* cavemanSideText(
          {
            instanceId: INSTANCE_ID,
            instructions: "Write the skill.",
            prompt: "We deployed by hand.",
            cwd,
          },
          { streamFn },
        );
        assert.strictEqual(text, "---\nname: deploy\n---\nRun the deploy.");
        assert.strictEqual(calls.length, 1);
        const [{ model, context }] = calls as [(typeof calls)[number]];
        assert.strictEqual(`${model.provider}/${model.id}`, "anthropic/claude-sonnet-5-5");
        assert.deepInclude(context.messages[0], { role: "system", content: "Write the skill." });
        // The env block names the directory the skill is about, then the prompt.
        const prompt = JSON.stringify(context.messages[1]);
        assert.include(prompt, JSON.stringify(`cwd: ${cwd}`).slice(1, -1));
        assert.include(prompt, "We deployed by hand.");
        assert.deepStrictEqual(context.tools ?? [], []);
        // A key's call, priced by the harness from the catalog.
        assert.include(usage, {
          engine: "caveman",
          model: "anthropic/claude-sonnet-5-5",
          input_tokens: 300,
          output_tokens: 40,
        });
        assert.strictEqual(usage?.cost?.basis, "list_price");
        assert.isAbove(usage?.cost?.usd ?? 0, 0);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("makes no call with no key", () =>
    Effect.gen(function* () {
      const { streamFn, calls } = answering("never");
      const error = yield* Effect.flip(
        cavemanSideText(
          {
            instanceId: ProviderInstanceId.make("caveman-none"),
            instructions: "i",
            prompt: "p",
            cwd: NodeOS.tmpdir(),
          },
          { streamFn },
        ),
      );
      assert.match(error.message, /no key or sign-in/);
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("a side call's usage row", () => {
  const turn = { requests: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 };

  it("prices a key's call at the harness's list price, and leaves a plan's unpriced", () => {
    assert.deepStrictEqual(sideCallUsage("openai/gpt-5-nano", turn, { openai: { key: "sk-x" } }), {
      engine: "caveman",
      model: "openai/gpt-5-nano",
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      cost: { usd: 0.01, basis: "list_price" },
    });
    const onChatGpt = sideCallUsage("openai/gpt-5-nano", turn, { openai: { oauth: chatGpt() } });
    assert.strictEqual(onChatGpt?.cost, null);
    assert.strictEqual(onChatGpt?.billing, "plan");
  });

  it("prices a turn the harness could not at the catalog's public price, and records nothing the provider did not report", () => {
    const unpriced = sideCallUsage(
      "caveman/anthropic/claude-haiku-5-5",
      { ...turn, cacheRead: 0, cacheWrite: 0, costUsd: null },
      { caveman: { key: "ck-x" } },
    );
    assert.strictEqual(unpriced?.cost?.basis, "list_price");
    assert.closeTo(unpriced?.cost?.usd ?? 0, (10 * 0.1 + 2 * 0.5) / 1e6, 1e-12);
    assert.strictEqual(
      sideCallUsage(
        "custom-ollama/llama3",
        { ...turn, costUsd: null },
        { "custom-ollama": { key: "k" } },
      )?.cost,
      null,
    );
    assert.isUndefined(
      sideCallUsage(
        "openai/gpt-5-nano",
        { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        { openai: { key: "sk-x" } },
      ),
    );
    assert.isUndefined(
      sideCallUsage(
        "openai/gpt-5-nano",
        { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        { openai: { key: "sk-x" } },
      ),
    );
  });
});
