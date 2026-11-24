// A queued message says who sent it when it was not the person (upstream #26159).
import { expect, test } from "vitest";
import { queuedSender } from "./queue-sender.ts";

test("an agent's and a scheduled task's queued messages name their sender; the person's own say nothing", () => {
  expect(queuedSender({ from: { workspace_id: "w2", title: "Release lead" } })).toEqual({ sender: "From Release lead" });
  expect(queuedSender({ scheduled_task: { task_id: "task-1", title: "Nightly triage" } })).toEqual({ sender: "Scheduled Nightly triage" });
  expect(queuedSender({ scheduled_task: { task_id: "gone" } })).toEqual({ sender: "Scheduled" });
  expect(queuedSender({})).toEqual({});
});
