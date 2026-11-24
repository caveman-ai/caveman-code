import { expect, test } from "vitest";
import { placeOf, readPlace, rememberPlace } from "./place.ts";

const box = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom }) });

test("the place is the first row still in view, and how far above the view its top sits", () => {
  const view = box(100, 700);
  const rows = [
    { id: "a", el: box(-300, 40) },
    { id: "b", el: box(40, 260) },
    { id: "c", el: box(260, 500) },
  ];
  expect(readPlace(view, rows)).toEqual({ row: "b", offset: -60 });
  // A row that only reaches the top edge is out of view.
  expect(
    readPlace(view, [
      { id: "a", el: box(0, 100) },
      { id: "b", el: box(100, 300) },
    ]),
  ).toEqual({ row: "b", offset: 0 });
  expect(readPlace(view, [{ id: "a", el: box(-200, 50) }])).toBeNull();
});

test("a chat's place is kept until the reader follows its end again", () => {
  rememberPlace("chat-1", { row: "r7", offset: -12 });
  expect(placeOf("chat-1")).toEqual({ row: "r7", offset: -12 });
  rememberPlace("chat-1", null);
  expect(placeOf("chat-1")).toBeUndefined();
});

test("only the most recent chats' places are kept", () => {
  for (let i = 0; i < 101; i++) rememberPlace(`many-${i}`, { row: "r", offset: 0 });
  expect(placeOf("many-0")).toBeUndefined();
  expect(placeOf("many-100")).toBeDefined();
});
