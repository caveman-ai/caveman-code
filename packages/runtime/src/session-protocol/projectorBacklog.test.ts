// The Session Protocol projector is the runtime's own worker, not a client: however far the event log runs ahead of
// it (agents streaming at once, a slow git diff at a turn's end), it catches up and keeps journaling every chat. A
// client's live buffer (LIVE_STREAM_MAX_ITEMS) is for RPC subscribers, which resume from their last sequence.
import * as fs from "node:fs";

import { CommandId, EventId, ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { LIVE_STREAM_MAX_ITEMS } from "../orchestration-v2/LiveStreamBudget.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

const root = tempRoot("sp-projector-backlog-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const titled = (workspaceId: string, title: string) =>
  until(
    async () => (await client.call("workspace.get", { workspace_id: workspaceId })).title === title,
    30_000,
  ).then(
    () => title,
    async () => (await client.call("workspace.get", { workspace_id: workspaceId })).title,
  );

test("the projector keeps journaling every chat after more events than a client's live buffer arrive at once", async () => {
  const orchestrator = orchestratorOf(runtime);
  const eventSink = Context.get(
    runtime.context as unknown as Context.Context<EventSink.EventSinkV2>,
    EventSink.EventSinkV2,
  );
  const w = await createReady(client, {
    request_id: "backlog",
    repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const threadId = ThreadId.make(`caveman:${w.id}`);
  const { thread } = await Effect.runPromise(orchestrator.getThreadProjection(threadId));
  const now = await Effect.runPromise(DateTime.now);
  // Published together, so they all wait on the projector at once.
  await Effect.runPromise(
    eventSink.write({
      events: Array.from({ length: LIVE_STREAM_MAX_ITEMS + 200 }, (_, i) => ({
        id: EventId.make(`event:backlog:${i}`),
        type: "thread.metadata-updated",
        threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: { ...thread, title: `Backlog ${i}` },
      })) as never,
    }),
  );
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("backlog-after"),
      threadId,
      title: "After the backlog",
    }),
  );
  expect(await titled(w.id, "After the backlog")).toBe("After the backlog");

  const later = await createReady(client, {
    request_id: "backlog-later",
    repo: { path: makeRepo(root, { "README.md": "later\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("backlog-later"),
      threadId: ThreadId.make(`caveman:${later.id}`),
      title: "Later chat renamed",
    }),
  );
  expect(await titled(later.id, "Later chat renamed")).toBe("Later chat renamed");
}, 120_000);
