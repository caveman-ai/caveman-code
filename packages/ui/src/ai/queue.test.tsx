import { document, fire, typeInto, window } from "../testing/dom.ts";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { Queue, type QueueEntry } from "./queue.tsx";

const a: QueueEntry = { id: "t1", text: "run the tests" };
const b: QueueEntry = { id: "t2", text: "then open a PR" };
const c: QueueEntry = { id: "t3", text: "Nightly triage", sender: "Scheduled Nightly triage" };

/**
 * Starts editing row `index` of `items`, types `draft`, then the queue becomes `next`; what the person's field went
 * through. With `foldedAt`, the queue first held those and the person folded it.
 */
async function editWhileQueueMoves(
  items: QueueEntry[],
  index: number,
  draft: string,
  next: QueueEntry[],
  foldedAt?: QueueEntry[],
) {
  const selected: string[] = [];
  const select = vi.spyOn(window.HTMLInputElement.prototype, "select").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    selected.push(this.value);
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = (list: QueueEntry[]) =>
    React.act(() =>
      root.render(<Queue items={list} onEdit={() => {}} onRemove={() => {}} onMove={() => {}} />),
    );
  const field = () =>
    host.querySelector<HTMLInputElement>('input[aria-label="Edit queued follow-up"]');
  if (foldedAt) {
    await render(foldedAt);
    await React.act(() => void fire(host.querySelector("button[aria-expanded]")!, "click"));
  }
  await render(items);
  await React.act(
    () => void fire(host.querySelectorAll('button[aria-label="Edit"]')[index]!, "click"),
  );
  const typing = field()!;
  await React.act(() => typeInto(typing, draft));
  await render(next);
  const header = host.querySelector("button[aria-expanded]");
  const result = {
    sameField: field() === typing,
    value: field()?.value,
    focused: document.activeElement === field(),
    selected,
    expanded: header?.getAttribute("aria-expanded") ?? null,
  };
  await React.act(() => root.unmount());
  host.remove();
  select.mockRestore();
  return result;
}

test("an edit in progress keeps its field and focus, its draft unselected, when the runtime starts the follow-up ahead of it", async () => {
  expect(await editWhileQueueMoves([a, b], 1, "then open a PR against main", [b])).toEqual({
    sameField: true,
    value: "then open a PR against main",
    focused: true,
    // Starting the edit selects the original text; nothing selects the draft after that.
    selected: ["then open a PR"],
    expanded: "true",
  });
});

test("an edit in progress keeps its field when another sender queues a follow-up behind it", async () => {
  expect(await editWhileQueueMoves([a], 0, "run the tests twice", [a, c])).toEqual({
    sameField: true,
    value: "run the tests twice",
    focused: true,
    selected: ["run the tests"],
    expanded: "true",
  });
});

test("an edit in progress keeps its field while the queue grows past two", async () => {
  expect(await editWhileQueueMoves([a, b], 1, "then open a PR against main", [a, b, c])).toEqual({
    sameField: true,
    value: "then open a PR against main",
    focused: true,
    selected: ["then open a PR"],
    expanded: "true",
  });
});

test("an edit in progress keeps its field when the queue grows past one after the person folded it", async () => {
  expect(await editWhileQueueMoves([b], 0, "then open a PR against main", [b, c], [a, b])).toEqual({
    sameField: true,
    value: "then open a PR against main",
    focused: true,
    selected: ["then open a PR"],
    expanded: "true",
  });
});

// The keys that end an IME conversion (Japanese, Chinese, Korean) are part of typing: Chromium and Electron send them
// while still composing, Safari after compositionend with keyCode 229 (lib/ime.ts).
test("editing a queued follow-up: the Enter of a conversion saves nothing and its Escape keeps the edit; a plain Enter saves", async () => {
  const edits: Array<[string, string]> = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await React.act(() =>
    root.render(
      <Queue
        items={[a]}
        onEdit={(id, text) => edits.push([id, text])}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    ),
  );
  await React.act(() => void fire(host.querySelector('button[aria-label="Edit"]')!, "click"));
  const field = () =>
    host.querySelector<HTMLInputElement>('input[aria-label="Edit queued follow-up"]');
  const key = (key: string, fields: { keyCode: number; isComposing: boolean }) =>
    React.act(() => {
      const e = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(e, { key, code: key, which: fields.keyCode, ...fields });
      field()!.dispatchEvent(e);
    });

  await React.act(() => typeInto(field()!, "テストを"));
  for (const [browser, ime] of [
    ["Chromium", { keyCode: 229, isComposing: true }],
    ["Safari", { keyCode: 229, isComposing: false }],
  ] as const) {
    for (const k of ["Enter", "Escape"]) {
      await key(k, ime);
      expect(edits, `${browser}'s ${k}`).toEqual([]);
      expect(field()?.value, `${browser}'s ${k}: the edit stays open with what was typed`).toBe(
        "テストを",
      );
    }
  }

  await React.act(() => typeInto(field()!, "テストを二回走らせる"));
  await key("Enter", { keyCode: 13, isComposing: false });
  expect(edits).toEqual([["t1", "テストを二回走らせる"]]);
  expect(field()).toBeNull();
  await React.act(() => root.unmount());
  host.remove();
});

test("an arrow key on a row's grip moves it once, Alt held or not", async () => {
  const moves: Array<[string, string | null]> = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await React.act(() =>
    root.render(
      <Queue
        items={[a, b]}
        onEdit={() => {}}
        onRemove={() => {}}
        onMove={(id, before) => moves.push([id, before])}
      />,
    ),
  );
  const grip = host.querySelectorAll('button[aria-label^="Move"]')[1]!;
  for (const altKey of [false, true]) {
    await React.act(() => {
      const e = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(e, { key: "ArrowUp", altKey });
      grip.dispatchEvent(e);
    });
  }
  expect(moves).toEqual([
    ["t2", "t1"],
    ["t2", "t1"],
  ]);
  await React.act(() => root.unmount());
  host.remove();
});
