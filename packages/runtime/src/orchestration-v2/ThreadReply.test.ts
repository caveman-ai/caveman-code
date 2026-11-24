import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";

import { answeringRun, threadReplyText } from "./ThreadReply.ts";

const run = (id: string, extra: Partial<OrchestrationV2Run> = {}) =>
  ({ id: RunId.make(id), status: "completed", ...extra }) as OrchestrationV2Run;

const receiver = (text: string) =>
  ({
    thread: { id: ThreadId.make("thread:answerer"), title: "Answerer" },
    messages: [
      {
        id: MessageId.make("message:answer"),
        runId: RunId.make("run:1"),
        role: "assistant",
        text,
        updatedAt: DateTime.makeUnsafe(0),
      },
    ],
    turnItems: [],
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;

it("caps a long answer at 8000 characters with a pointer to the rest", () => {
  const text = threadReplyText(receiver("x".repeat(9_000)), run("run:1"));
  assert.equal(text.length, 8_000);
  assert.isTrue(
    text.endsWith('\n[truncated — read the rest with thread_read(threadId="thread:answerer")]'),
  );
  assert.equal(threadReplyText(receiver("short"), run("run:1")), "short");
  // The cut lands between an emoji's two code units: neither half is kept.
  const pointerLength = 8_000 - text.indexOf("\n[truncated");
  const split = threadReplyText(
    receiver("x".repeat(8_000 - pointerLength - 1) + "😀".repeat(1_000)),
    run("run:1"),
  );
  assert.isFalse(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(split));
  assert.equal(split.indexOf("\n[truncated"), 8_000 - pointerLength - 1);
});

it("answers with the restart continuation that resumed the question's run", () => {
  const runs = [
    run("run:1", { status: "interrupted" }),
    run("run:2", { restartContinuationOfRunId: RunId.make("run:1") }),
  ];
  assert.equal(answeringRun(runs, RunId.make("run:1"))?.id, RunId.make("run:2"));
  assert.equal(answeringRun(runs, null), undefined);
});
