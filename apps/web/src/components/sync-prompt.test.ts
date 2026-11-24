// Sync is a setting: its prompt never opens by itself, only from Getting started's step (components/SyncPrompt.tsx,
// state/getting-started.ts cardSteps).
import type { CloudStatus } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { showsSyncPrompt, syncAnswer } from "./SyncPrompt.tsx";

const status = (sync: CloudStatus["sync"], moves?: CloudStatus["moves"]) =>
  ({ state: "connected", ...(sync ? { sync } : {}), ...(moves ? { moves } : {}) }) as CloudStatus;
const ASK = status({ available: true, on: false, ask: true });

test("the prompt never shows by itself: only when something opened it, while sync is offered", () => {
  // Offered and unanswered, but nobody asked: nothing on screen, in any session.
  expect(showsSyncPrompt(ASK, false, false)).toBe(false);
  // Getting started's step opened it.
  expect(showsSyncPrompt(ASK, true, false)).toBe(true);
  // Answered in Settings, not offered by this Cloud, or not signed in at all: nothing to ask, opened or not.
  expect(showsSyncPrompt(status({ available: true, on: true }), true, false)).toBe(false);
  expect(showsSyncPrompt(status({ available: false, on: false }), true, false)).toBe(false);
  expect(showsSyncPrompt(status(undefined), true, false)).toBe(false);
  expect(showsSyncPrompt(null, true, false)).toBe(false);
  // Never in a browser window: sync is this Mac's to turn on.
  expect(showsSyncPrompt(ASK, true, true)).toBe(false);
});

test("turning sync on turns remote control on with it, and answers a lid move still asking", () => {
  expect(syncAnswer(true, ASK)).toEqual({ sync_chats: true, remote_control: true });
  expect(syncAnswer(false, ASK)).toEqual({ sync_chats: false, remote_control: false });
  expect(syncAnswer(true, status({ available: true, on: false, ask: true }, "ask"))).toEqual({
    sync_chats: true,
    remote_control: true,
    move_to_cloud: true,
  });
});
