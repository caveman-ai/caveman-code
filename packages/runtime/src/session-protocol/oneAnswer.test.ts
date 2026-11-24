// One answer per ask (K3, CHAOS-13): answers racing in the same instant while the engine's record lags behind them.
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import { oneAnswerPerAsk } from "./oneAnswer.ts";

test("two answers to one ask in the same instant: one goes through, the other hears it was answered, though the engine's record lags", async () => {
  const answerOnce = oneAnswerPerAsk();
  // The engine's record of the ask (the projection) shows the first answer only well after both arrived.
  const dispatched: Array<string> = [];
  const answer = (device: string) =>
    Effect.gen(function* () {
      yield* Effect.sleep("30 millis");
      dispatched.push(device);
      return device;
    });
  const already = Effect.fail("this ask was already answered");
  const outcomes = await Promise.all(
    ["desktop", "phone", "web"].map((device) => Effect.runPromise(answerOnce("s1\0ask-1", answer(device), already).pipe(Effect.match({ onSuccess: (d) => `ok ${d}`, onFailure: (e) => e })))),
  );
  expect(outcomes.filter((o) => o.startsWith("ok"))).toHaveLength(1);
  expect(outcomes.filter((o) => !o.startsWith("ok"))).toEqual(["this ask was already answered", "this ask was already answered"]);
  // The engine was sent one answer.
  expect(dispatched).toHaveLength(1);
  // Another ask is its own.
  expect(await Effect.runPromise(answerOnce("s1\0ask-2", answer("phone"), already))).toBe("phone");
});

test("an answer that fails leaves the ask open for the next one", async () => {
  const answerOnce = oneAnswerPerAsk();
  const already = Effect.fail("this ask was already answered");
  await expect(Effect.runPromise(answerOnce("s1\0ask-1", Effect.fail("engine gone"), already))).rejects.toThrow();
  expect(await Effect.runPromise(answerOnce("s1\0ask-1", Effect.succeed("ok"), already))).toBe("ok");
  await expect(Effect.runPromise(answerOnce("s1\0ask-1", Effect.succeed("again"), already))).rejects.toThrow();
});
