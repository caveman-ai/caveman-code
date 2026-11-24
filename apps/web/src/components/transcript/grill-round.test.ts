// A grill round mounted with React DOM: where Enter in a question's own answer takes the focus.
import { document, fire, window } from "../../testing/dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { RoundCard } from "./GrillCards.tsx";

const question = (id: string, prompt: string) => ({
  id,
  prompt,
  detail: null,
  options: [
    { id: `${id}-a`, label: "Postgres", description: null },
    { id: `${id}-b`, label: "SQLite", description: null },
  ],
  recommended: `${id}-a`,
  multiSelect: false,
});

const ask = {
  kind: "ask",
  id: "round-1",
  askKind: "question",
  prompt: "Which store?",
  options: [],
  resolution: null,
  questions: [question("q1", "Which store?"), question("q2", "Which cache?")],
  round: 1,
  answers: null,
} as never;

/** A focused control as a reader meets it: its role, its words, and the question it belongs to. */
const named = (el: Element) => {
  const group = el.closest("[role=radiogroup]")?.getAttribute("aria-labelledby");
  return `${el.getAttribute("role")} ${el.textContent}, of ${group ? document.getElementById(group)?.textContent : "the round"}`;
};

const unmounts: Array<() => void> = [];
afterEach(() => {
  unmounts.splice(0).forEach((u) => u());
  vi.restoreAllMocks();
});

test("an Enter that commits an IME candidate in a question's own answer keeps the focus there, in Safari's form (keyCode 229) as in Chrome's (isComposing)", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(RoundCard, { ask, onAnswer: () => undefined })));
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const focused: Element[] = [];
  vi.spyOn(window.HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
    focused.push(this);
  });
  const other = host.querySelector<HTMLInputElement>(
    'input[aria-label="Other answer: Which store?"]',
  )!;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(other), "value")!.set!;
  await act(async () => {
    setValue.call(other, "にほんごのでーたべーす");
    fire(other, "input");
  });
  const enter = (fields: Record<string, unknown> = {}) =>
    act(
      async () =>
        void fire(other, "keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          isComposing: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          ctrlKey: false,
          ...fields,
        }),
    );

  // Chrome: keydown while composing says so.
  await enter({ keyCode: 229, isComposing: true });
  expect(focused).toEqual([]);
  // WebKit fires compositionend first, then the committing keydown with keyCode 229 and isComposing false.
  await enter({ keyCode: 229, isComposing: false });
  expect(focused.map(named), "moved on by Safari's committing Enter").toEqual([]);
  // The Enter after it goes on to the next question's choice.
  await enter();
  expect(focused.map(named)).toEqual(["radio 1PostgresRecommended, of Which cache?"]);
  expect(other.value).toBe("にほんごのでーたべーす");
});
