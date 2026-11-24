import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { loadCavemanEngineAfterStart } from "./cavemanEngineLoad.ts";
import * as CloudLink from "./cloudLink/index.ts";

const computer = (computerId: string): CloudLink.CloudComputerInfo => ({ linkDir: "/link", computerId, workspaceRoot: "/workspace" });

it.live("loads the engine on a Cloud computer only once its relay is connected, and then not before the first turn's start is past", () =>
  Effect.gen(function* () {
    let loads = 0;
    let connected = false;
    const link: CloudLink.LinkState = { connected: () => connected };
    const fiber = yield* loadCavemanEngineAfterStart(async () => void loads++, 600).pipe(
      Effect.provideService(CloudLink.CloudComputer, computer("computer-1")),
      Effect.provideService(CloudLink.CloudLinkState, link),
      Effect.forkChild,
    );
    yield* Effect.sleep("350 millis");
    assert.strictEqual(loads, 0);
    connected = true;
    // The message that woke the computer is handed over now: the import does not stand in its turn's way.
    yield* Effect.sleep("350 millis");
    assert.strictEqual(loads, 0);
    yield* Fiber.join(fiber);
    assert.strictEqual(loads, 1);
  }),
);

it.live("loads it at once on This Mac and on a warm pod waiting for its claim", () =>
  Effect.gen(function* () {
    let loads = 0;
    const load = async () => void loads++;
    const unlinked: CloudLink.LinkState = { connected: () => false };
    yield* loadCavemanEngineAfterStart(load).pipe(
      Effect.provideService(CloudLink.CloudComputer, undefined),
      Effect.provideService(CloudLink.CloudLinkState, unlinked),
    );
    yield* loadCavemanEngineAfterStart(load).pipe(
      Effect.provideService(CloudLink.CloudComputer, computer("")),
      Effect.provideService(CloudLink.CloudLinkState, unlinked),
    );
    assert.strictEqual(loads, 2);
  }),
);

it.live("logs a failed load instead of failing", () =>
  Effect.gen(function* () {
    yield* loadCavemanEngineAfterStart(() => Promise.reject(new Error("no engine"))).pipe(Effect.provideService(CloudLink.CloudComputer, undefined));
  }),
);
