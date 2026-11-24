import { expect, test } from "vitest";
import { placedWorkspaceId, submittedMessageId } from "./message-id.ts";

// The runtime derives both ids itself (packages/runtime session-protocol/store.ts); its store.test.ts pins the same
// values, so a device and a computer can never come to name one chat or one message differently.
test("the id a Cloud computer gives the chat Cloud placed is told here before the computer has it", async () => {
  expect(await placedWorkspaceId("0195A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B")).toBe(
    "dacebe5f-f933-4d69-abb0-bd3245cac8a4",
  );
  // Cloud's ids are read whatever their case.
  expect(await placedWorkspaceId("0195a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe(
    "dacebe5f-f933-4d69-abb0-bd3245cac8a4",
  );
});

test("a chat's first message is the request `<start's request id>:task`", async () => {
  expect(await submittedMessageId("ses-1", "req-1:task")).toMatch(/^sp-msg:[0-9a-f]{24}$/);
  expect(await submittedMessageId("ses-1", "req-1:task")).not.toBe(
    await submittedMessageId("ses-1", "req-1"),
  );
});
