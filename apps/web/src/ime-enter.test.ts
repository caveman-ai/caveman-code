// The Enter that commits an IME candidate belongs to the IME. WebKit fires compositionend before that keydown, which
// then says isComposing false and keyCode 229; Chrome's says isComposing true. A field that acts on Enter asks
// isComposing(), which knows both, so a Japanese or Chinese word committed in Safari does not also step, save or pick.
import { document, fire } from "./testing/dom.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { FindBar } from "./components/find/FindBar.tsx";
import { SecretSheet } from "./components/secrets/SecretSheet.tsx";

const unmounts: Array<() => void> = [];
afterEach(() => unmounts.splice(0).forEach((u) => u()));

async function mount(content: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(content));
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

/** Enter on `el`: Chrome's composing form, then Safari's committing form, then a plain one. */
async function enters(el: Element, after: () => void) {
  const enter = (fields: Record<string, unknown>) =>
    act(
      async () =>
        void fire(el, "keydown", {
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
  await enter({ keyCode: 229, isComposing: true });
  after();
  await enter({ keyCode: 229, isComposing: false });
  after();
}

test("Enter that commits an IME candidate in find does not step to the next match", async () => {
  const onStep = vi.fn();
  const host = await mount(
    createElement(FindBar, {
      query: "にほんご",
      index: 0,
      total: 3,
      onQuery: () => undefined,
      onStep,
      onClose: () => undefined,
      focusKey: 0,
    }),
  );
  const field = host.querySelector("input")!;
  await enters(field, () => expect(onStep, "stepped by an IME's Enter").not.toHaveBeenCalled());
  await act(
    async () =>
      void fire(field, "keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        isComposing: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
      }),
  );
  expect(onStep.mock.calls).toEqual([[1]]);
});

test("Enter that commits an IME candidate in a caught secret's name does not save it", async () => {
  const onSave = vi.fn();
  const host = await mount(
    createElement(SecretSheet, {
      entries: [{ name: "STRIPE_KEY", value: ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3") }],
      existing: new Set<string>(),
      repoLabel: "acme/app",
      mode: "paste",
      busy: false,
      error: null,
      onSave,
      onCancel: () => undefined,
    }),
  );
  const name = host.querySelector('input[data-row="0"]')!;
  await enters(name, () => expect(onSave, "saved by an IME's Enter").not.toHaveBeenCalled());
  await act(
    async () =>
      void fire(name, "keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        isComposing: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
      }),
  );
  expect(onSave.mock.calls).toEqual([
    [[{ name: "STRIPE_KEY", value: ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3") }]],
  ]);
});

const WEB = fileURLToPath(new URL(".", import.meta.url));
const UI = fileURLToPath(new URL("../../../packages/ui/src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("no key handler in the app or its kit reads nativeEvent.isComposing itself: Safari's committing Enter says false there", () => {
  const hits = [WEB, UI].flatMap((root) =>
    sources(root).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\bnativeEvent\.isComposing\b/.test(line)
            ? [`${relative(join(WEB, "../../.."), file)}:${i + 1}`]
            : [],
        ),
    ),
  );
  expect(hits).toEqual([]);
});
