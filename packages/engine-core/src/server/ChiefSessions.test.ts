// An engine with no Chief mode refuses a Chief's thread before its session opens, and fails closed when the host
// can't place the thread; any other thread, or a host without the Chief, opens as it always did.
import { ProviderDriverKind, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  CHIEF_ENGINE_REFUSAL,
  type ChiefProfile,
  ChiefSessions,
  refuseChiefThread,
} from "./ChiefSessions.ts";

const chiefThread = ThreadId.make("thread-chief");
const chatThread = ThreadId.make("thread-chat");
const unplaced = ThreadId.make("thread-unplaced");
const profile: ChiefProfile = { instructions: "You are the Chief.", sections: [], tools: [] };
const sessions = Option.some(
  ChiefSessions.of({
    profile: (threadId) =>
      threadId === chiefThread
        ? Effect.succeed(profile)
        : threadId === unplaced
          ? Effect.fail(new Error("the Chief's host is not up yet"))
          : Effect.succeed(undefined),
  }),
);
const input = (threadId: ThreadId) => ({
  driver: ProviderDriverKind.make("cursor"),
  threadId,
  providerSessionId: ProviderSessionId.make("provider-session-1"),
});

describe("refuseChiefThread", () => {
  it.effect("refuses a Chief's thread, and one the host can't place yet", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.exit(refuseChiefThread(sessions, input(chiefThread)));
      assert.isTrue(Exit.isFailure(refused));
      const error = Exit.isFailure(refused)
        ? Option.getOrThrow(Exit.findErrorOption(refused))
        : undefined;
      assert.equal(error?._tag, "ProviderAdapterOpenSessionError");
      assert.equal(error?.driver, "cursor");
      assert.equal((error?.cause as Error | undefined)?.message, CHIEF_ENGINE_REFUSAL);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(refuseChiefThread(sessions, input(unplaced)))),
      );
    }),
  );

  it.effect("lets any other thread open, and every thread on a host without the Chief", () =>
    Effect.gen(function* () {
      assert.isTrue(
        Exit.isSuccess(yield* Effect.exit(refuseChiefThread(sessions, input(chatThread)))),
      );
      assert.isTrue(
        Exit.isSuccess(yield* Effect.exit(refuseChiefThread(Option.none(), input(chiefThread)))),
      );
    }),
  );
});
