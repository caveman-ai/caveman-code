// A send queued in Caveman Cloud shows in the transcript as the person's message, dimmed, with its status; the
// runtime's own message for that request id takes its place, so it never shows twice.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { SessionModel } from "./transcript.ts";

const userDone = (cursor: number, id: string, text: string): SessionEvent =>
  ({ session_id: "s1", cursor, at: "2026-10-21T12:00:00.000Z", type: "message.done", item_id: id, payload: { role: "user", text } }) as SessionEvent;
const users = (m: SessionModel) => m.snapshot().items.filter((i) => i.kind === "user");

test("a queued send shows dimmed with its line, updates in place, and the runtime's message replaces it", () => {
  const m = new SessionModel();
  expect(m.queued("sp-msg:1", "Also run it on Safari", "Queued · waking api-box")).toBe(true);
  expect(users(m)).toMatchObject([{ id: "sp-msg:1", text: "Also run it on Safari", pending: true, queued: "Queued · waking api-box" }]);
  expect(m.queued("sp-msg:1", "Also run it on Safari", "Queued · waking api-box")).toBe(false); // nothing changed
  expect(m.queued("sp-msg:1", "Also run it on Safari", "Delivered · api-box")).toBe(true);
  expect(users(m)[0]).toMatchObject({ queued: "Delivered · api-box" });
  m.apply(userDone(1, "sp-msg:1", "Also run it on Safari"));
  expect(users(m)).toHaveLength(1);
  expect(users(m)[0]).not.toHaveProperty("queued");
  expect(users(m)[0]).not.toHaveProperty("pending");
  // A late status for it changes nothing: the runtime's message is there.
  expect(m.queued("sp-msg:1", "Also run it on Safari", "Queued · waking api-box")).toBe(false);
  expect(users(m)).toHaveLength(1);
});

test("a send whose message already arrived is never shown again as queued", () => {
  const m = new SessionModel();
  m.apply(userDone(1, "sp-msg:2", "hi"));
  expect(m.queued("sp-msg:2", "hi", "Queued · waking api-box")).toBe(false);
  expect(users(m)).toHaveLength(1);
  expect(users(m)[0]).not.toHaveProperty("queued");
});

test("the composer's own echo of a send becomes the queued one in place", () => {
  const m = new SessionModel();
  m.echo("sp-msg:3", "hi");
  expect(m.queued("sp-msg:3", "hi", "Waiting for Julius's MacBook")).toBe(true);
  expect(users(m)).toMatchObject([{ id: "sp-msg:3", pending: true, queued: "Waiting for Julius's MacBook" }]);
});

test("a stop shows at once, the turn's end settles it, and a refused stop is taken back", () => {
  const m = new SessionModel();
  m.apply({ session_id: "s1", cursor: 1, at: "2026-10-21T12:00:00.000Z", type: "turn.started", payload: { engine: "caveman" } } as SessionEvent);
  expect(m.snapshot().stopping).toBeUndefined();
  m.stop("stop-1");
  expect(m.snapshot()).toMatchObject({ running: true, stopping: true });
  m.unstop("stop-1");
  expect(m.snapshot().stopping).toBeUndefined();
  m.stop("stop-2");
  m.apply({ session_id: "s1", cursor: 2, at: "2026-10-21T12:00:01.000Z", type: "turn.done", payload: { status: "interrupted" } } as SessionEvent);
  expect(m.snapshot()).toMatchObject({ running: false });
  expect(m.snapshot().stopping).toBeUndefined();
  // Nothing to stop: a stop with no turn running shows nothing.
  m.stop("stop-3");
  expect(m.snapshot().stopping).toBeUndefined();
});
