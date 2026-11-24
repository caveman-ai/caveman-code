import { expect, test } from "vitest";
import { buildPrompt, buildState, choiceKey, roundReply, sendOnce, turnMode, type SendState } from "./grill.ts";

test("a round's reply holds one answer per question, in order; typed words win while Other is the choice", () => {
  const ids = ["store", "ttl", "pw", "who"].map((id) => ({ id, multiSelect: false }));
  expect(
    roundReply(ids, {
      store: { optionIds: ["pg"], text: "", own: false },
      ttl: { optionIds: ["30d"], text: "  7 days, sliding ", own: true },
      pw: { optionIds: ["all"], text: "   ", own: true },
      // Typed, then moved back to an option: the option answers, the words wait.
      who: { optionIds: ["people"], text: "robots", own: false },
    }),
  ).toEqual({
    kind: "question",
    answers: [
      { question_id: "store", option_ids: ["pg"] },
      { question_id: "ttl", option_ids: [], text: "7 days, sliding" },
      { question_id: "pw", option_ids: ["all"] },
      { question_id: "who", option_ids: ["people"] },
    ],
  });
  // Nothing sends while a question has neither an option nor words.
  expect(roundReply(ids.slice(0, 2), { store: { optionIds: ["pg"], text: "", own: false }, ttl: { optionIds: [], text: " ", own: true } })).toBeNull();
});

test("a multi-select question answers with every option picked, and its own words beside them", () => {
  const qs = [{ id: "os", multiSelect: true }];
  expect(roundReply(qs, { os: { optionIds: ["mac", "linux"], text: "", own: false } })).toEqual({
    kind: "question",
    answers: [{ question_id: "os", option_ids: ["mac", "linux"] }],
  });
  expect(roundReply(qs, { os: { optionIds: ["mac"], text: " BSD ", own: true } })).toEqual({
    kind: "question",
    answers: [{ question_id: "os", option_ids: ["mac"], text: "BSD" }],
  });
  expect(roundReply(qs, { os: { optionIds: [], text: "", own: true } })).toBeNull();
});

test("the radio keys: arrows step through the options and Other and wrap, digits jump, nothing else is ours", () => {
  // Three options; Other is index 3.
  expect(choiceKey("ArrowDown", 0, 3)).toBe(1);
  expect(choiceKey("ArrowRight", 2, 3)).toBe(3);
  expect(choiceKey("ArrowDown", 3, 3)).toBe(0);
  expect(choiceKey("ArrowUp", 0, 3)).toBe(3);
  expect(choiceKey("ArrowLeft", 3, 3)).toBe(2);
  expect(choiceKey("1", 2, 3)).toBe(0);
  expect(choiceKey("4", 0, 3)).toBe(3);
  expect(choiceKey("5", 0, 3)).toBeNull();
  expect(choiceKey("0", 0, 3)).toBeNull();
  expect(choiceKey(" ", 0, 3)).toBeNull();
  expect(choiceKey("Enter", 0, 3)).toBeNull();
  expect(choiceKey("Tab", 0, 3)).toBeNull();
});

test("a turn asks for a mode only when the user changed it here; never re-asserts the one shown", () => {
  // Untouched (the chip matches the session as this client sees it, stale or not): no mode.
  expect(turnMode(true, "grill", true)).toEqual({});
  expect(turnMode(true, "default", false)).toEqual({});
  expect(turnMode(true, undefined, false)).toEqual({});
  // Toggled in this client.
  expect(turnMode(true, "default", true)).toEqual({ mode: "grill" });
  expect(turnMode(true, "grill", false)).toEqual({ mode: "default" });
  // Handed to an engine without grill mode, still in it: the chip's × still leaves; it never asks to grill.
  expect(turnMode(false, "grill", false)).toEqual({ mode: "default" });
  expect(turnMode(false, "grill", true)).toEqual({});
  expect(turnMode(false, "default", true)).toEqual({});
});

const settle = () => new Promise((r) => setTimeout(r));

test("Build it sends once per card: a double click, clicks after it went through, and a remounted card do nothing; a failure allows a retry", async () => {
  const states: SendState[] = [];
  let sends = 0;
  let fail = true;
  const send = () => {
    sends++;
    return fail ? Promise.reject(new Error("offline")) : Promise.resolve();
  };
  const show = (s: SendState) => void states.push(s);
  const click = () => sendOnce("s1:grill.finished:9", send, show);
  click();
  click();
  await settle();
  expect(sends).toBe(1);
  expect(states).toEqual(["sending", "idle"]);

  fail = false;
  click();
  click();
  await settle();
  click();
  await settle();
  expect(sends).toBe(2);
  expect(states).toEqual(["sending", "idle", "sending", "sent"]);

  // The pane or workspace switched and back: a new mount starts from what was sent, and its click does nothing.
  expect(buildState("s1:grill.finished:9")).toBe("sent");
  const remounted: SendState[] = [];
  sendOnce("s1:grill.finished:9", send, (s) => void remounted.push(s));
  await settle();
  expect(sends).toBe(2);
  expect(remounted).toEqual([]);
  // Another session's card with the same item id is its own.
  expect(buildState("s2:grill.finished:9")).toBe("idle");
});

test("Build it's words", () => {
  expect(buildPrompt("docs/")).toBe("Build what we agreed in docs/");
});
