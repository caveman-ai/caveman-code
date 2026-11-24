// The island's two boxes and what its ears say.
import { expect, test } from "vitest";
import type { ChatStatus, ChatStatusId } from "../state/model.ts";
import type { NotchAgent, NotchState } from "./model.ts";
import { earMark, earPose, notchBoxes } from "./Notch.tsx";

const status = (id: ChatStatusId, action = false): ChatStatus => ({
  id,
  label: id,
  detail: null,
  action,
  since: null,
  progress: null,
  agents: 0,
});
const agent = (id: string, s: ChatStatus): NotchAgent => ({ id, title: id, status: s });
const state = (agents: NotchAgent[], card: NotchAgent | null = null): NotchState => ({
  agents,
  card: card && {
    ...card,
    line: null,
    command: null,
    image: null,
    keys: [],
    ask: null,
    trouble: null,
    index: 0,
    count: 1,
    prev: null,
    next: null,
  },
  unseen: [],
});

test("on a MacBook the island is the screen's notch with an ear either side, and as tall as it", () => {
  const { rest, open } = notchBoxes({ width: 185, height: 32 }, 33, false, 300);
  expect([rest.width, rest.height]).toEqual([265, 32]);
  // Open, the band stays and the body hangs under it.
  expect([open.width, open.height]).toEqual([380, 332]);
});

test("on a display with no notch it is a pill in the menu bar: the companion's ear, and a second once a chat is marked", () => {
  expect(notchBoxes(null, 25, false, 0).rest).toMatchObject({ width: 40, height: 28 });
  expect(notchBoxes(null, 25, true, 0).rest).toMatchObject({ width: 80, height: 28 });
  // A menu bar taller than the pill sets its height.
  expect(notchBoxes(null, 37, true, 0).rest.height).toBe(37);
});

test("the companion waves when a chat waits, works while one works, and sleeps otherwise", () => {
  const busy = agent("b", status("working"));
  expect(earPose(state([]))).toBe("sleeping");
  expect(earPose(state([busy]))).toBe("working");
  expect(earPose(state([busy], agent("a", status("approve", true))))).toBe("wave");
  expect(earPose(state([busy], agent("d", status("done"))))).toBe("done");
  expect(earPose(state([busy], agent("f", status("failed"))))).toBe("error");
});

test("the right ear shows the most pressing chat's mark and how many chats share it", () => {
  expect(earMark([])).toBeNull();
  const needs = [agent("a", status("approve", true)), agent("q", status("answer", true))];
  const work = [
    agent("w1", status("working")),
    agent("w2", status("agents")),
    agent("w3", status("queued")),
  ];
  expect(earMark([...needs, ...work])).toMatchObject({ agent: { id: "a" }, count: 2 });
  expect(earMark(work)).toMatchObject({ agent: { id: "w1" }, count: 3 });
  expect(earMark([agent("d", status("done")), ...work])).toMatchObject({
    agent: { id: "d" },
    count: 1,
  });
});
