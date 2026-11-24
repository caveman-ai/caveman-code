/** message.caveman_version on the Caveman engine: one harness turn on a scripted model, never a network or a paid call. */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import type * as Harness from "@caveman-ai/harness";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";

import { setCavemanKey } from "./credentials.ts";
import { CAVEMAN_VERSION_INSTRUCTIONS, makeCavemanRewriter } from "./rewriter.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

type Reply = { readonly text: string } | { readonly error: string } | { readonly hang: true };

/** A model that answers each call with the next reply (pi-ai's own events), and records what each call was sent. */
function scripted(replies: ReadonlyArray<Reply>, usage = { input: 120, output: 8 }) {
  const calls: Array<{ readonly model: Model<Api>; readonly context: Context }> = [];
  let aborted = false;
  const streamFn: Harness.HarnessStreamFn = (model: Model<Api>, context: Context, options?: { readonly signal?: AbortSignal }) => {
    const reply = replies[calls.length];
    calls.push({ model, context: structuredClone(context) });
    if (reply === undefined) throw new Error(`script exhausted at call ${calls.length}`);
    const stream = createAssistantMessageEventStream();
    const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...usage, cacheRead: 0, cacheWrite: 0, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      timestamp: Date.now(),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
    void (async () => {
      stream.push({ type: "start", partial: message([], "stop") });
      if ("hang" in reply) {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        aborted = true;
        stream.push({ type: "error", reason: "aborted", error: message([], "aborted", "aborted") });
        stream.end();
        return;
      }
      if ("error" in reply) {
        stream.push({ type: "error", reason: "error", error: message([], "error", reply.error) });
        stream.end();
        return;
      }
      const content: AssistantMessage["content"] = [{ type: "text", text: reply.text }];
      stream.push({ type: "text_start", contentIndex: 0, partial: message([], "stop") });
      stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message(content, "stop") });
      stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message(content, "stop") });
      const final = message(content, "stop");
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end(final);
    })();
    return stream;
  };
  return { streamFn, calls, aborted: () => aborted };
}

describe("Caveman version rewriter", () => {
  it.effect("fails with no stored key, even with OPENAI_API_KEY in the environment", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-from-the-environment-not-the-store";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = previous;
        }),
      );
      const { streamFn, calls } = scripted([{ text: "never" }]);
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID, { streamFn });
      const error = yield* Effect.flip(rewriter.rewrite("Hello there."));
      assert.match(error.message, /no key or sign-in/);
      assert.equal(calls.length, 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rewrites one message on the cheapest keyed model, in one harness turn with no tools, and prices it", () =>
    Effect.gen(function* () {
      // Two keys: the cheaper model wins, not the first provider.
      yield* setCavemanKey(INSTANCE_ID, "anthropic", ("sk-" + "ant-stored-anthropic-key-0123456789"));
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const { streamFn, calls } = scripted([{ text: "Fix done. Test pass." }]);
      // No model override: the rewriter's own pick reaches the stream.
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID, { streamFn });
      const { text, usage } = yield* rewriter.rewrite("I have fixed the bug and all of the tests are now passing.");
      assert.equal(text, "Fix done. Test pass.");
      // Its usage goes to Settings -> Spend under the Caveman engine.
      assert.include(usage, { engine: "caveman", model: "openai/gpt-5-nano", input_tokens: 120, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 0 });
      // Priced by the harness at the catalog's list price ($0.05 / $0.40 per MTok), labelled so.
      assert.strictEqual(usage?.cost?.basis, "list_price");
      assert.closeTo(usage?.cost?.usd ?? 0, (120 * 0.05 + 8 * 0.4) / 1e6, 1e-12);
      assert.isUndefined(usage?.billing);
      assert.equal(calls.length, 1);
      const [{ model, context }] = calls as [(typeof calls)[number]];
      assert.equal(`${model.provider}/${model.id}`, "openai/gpt-5-nano");
      // The instructions are the whole system text, and the message travels in its tags after the harness's env block.
      assert.deepInclude(context.messages[0], { role: "system", content: CAVEMAN_VERSION_INSTRUCTIONS });
      const prompt = JSON.stringify(context.messages[1]);
      assert.include(prompt, "</env>\\n\\n<message>\\nI have fixed the bug and all of the tests are now passing.\\n</message>");
      // A side request: no tools.
      assert.deepStrictEqual(context.tools ?? [], []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("with only Caveman credits, rewrites on the credits' Haiku through the Cloud gateway, priced at its public list price", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "caveman", "ck-credits-key-0123456789");
      const { streamFn, calls } = scripted([{ text: "<message>\nDone.\n</message>" }]);
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID, { streamFn });
      const { text, usage } = yield* rewriter.rewrite("It is done now.");
      // A model that kept the tags: the text inside them.
      assert.equal(text, "Done.");
      assert.equal(calls.length, 1);
      assert.equal(`${calls[0]!.model.provider}/${calls[0]!.model.id}`, "caveman-anthropic/claude-haiku-5-5");
      assert.match(calls[0]!.model.baseUrl, /gateway/);
      assert.strictEqual(usage?.model, "caveman/anthropic/claude-haiku-5-5");
      assert.strictEqual(usage?.cost?.basis, "list_price");
      assert.isAbove(usage?.cost?.usd ?? 0, 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("says the provider's own words when the model call fails", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const { streamFn } = scripted([{ error: "401 Incorrect API key provided" }]);
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID, { streamFn });
      const error = yield* Effect.flip(rewriter.rewrite("Hello there."));
      assert.match(error.message, /^The Caveman version failed: 401 Incorrect API key provided/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("gives up on a stalled provider after 30 seconds and aborts the turn", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", "sk-stored-openai-key-0123456789");
      const { streamFn, calls, aborted } = scripted([{ hang: true }]);
      const rewriter = yield* makeCavemanRewriter(INSTANCE_ID, { streamFn });
      const fiber = yield* Effect.forkChild(Effect.flip(rewriter.rewrite("Hello there.")));
      // The turn reaches the model before the clock moves.
      while (calls.length === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(fiber);
      assert.match(error.message, /timed out/);
      while (!aborted()) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      assert.isTrue(aborted());
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
