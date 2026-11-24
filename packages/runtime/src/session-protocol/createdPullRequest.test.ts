import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { readBackCreatedPullRequest } from "./createdPullRequest.ts";

it.effect("reads a created pull request back once the host lists it", () =>
  Effect.gen(function* () {
    let calls = 0;
    const lookup = Effect.suspend(() => {
      calls += 1;
      if (calls === 1) return Effect.fail(new Error("list read failed"));
      return Effect.succeed(calls === 2 ? undefined : { number: 7, url: "https://host/pr/7" });
    });

    const fiber = yield* readBackCreatedPullRequest(lookup).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const found = yield* Fiber.join(fiber);

    assert.deepStrictEqual(found, Option.some({ number: 7, url: "https://host/pr/7" }));
    assert.strictEqual(calls, 3);
  }),
);

it.effect("gives up after a few tries without failing", () =>
  Effect.gen(function* () {
    let calls = 0;
    const lookup = Effect.suspend(() => {
      calls += 1;
      return Effect.fail(new Error("list read failed"));
    });

    const fiber = yield* readBackCreatedPullRequest(lookup).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 seconds");

    assert.deepStrictEqual(yield* Fiber.join(fiber), Option.none());
    assert.strictEqual(calls, 4);
  }),
);

it.effect("does not wait when the first read finds it", () =>
  Effect.gen(function* () {
    const found = yield* readBackCreatedPullRequest(Effect.succeed({ number: 1 }));
    assert.deepStrictEqual(found, Option.some({ number: 1 }));
  }),
);
