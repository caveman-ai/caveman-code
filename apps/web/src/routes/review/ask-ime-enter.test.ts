// The Enter that ends an IME conversion (Japanese, Chinese, Korean) in Ask's box is part of typing: it starts no chat
// on the half-converted words. Chromium and Electron send it with isComposing; Safari fires compositionend first, so
// its Enter has isComposing false and keyCode 229 (chrome.tsx isComposing).
import { buttons, click, render, type, window } from "../dom.test-support.ts";
import { act, createElement } from "react";
import { expect, test } from "vitest";
import type { AskMode } from "./Ask.tsx";
import { AskMenu } from "./PrPage.tsx";

const CHROME_IME_ENTER = { keyCode: 229, isComposing: true };
const SAFARI_IME_ENTER = { keyCode: 229, isComposing: false };
const ENTER = { keyCode: 13, isComposing: false };

const enter = (
  field: Element,
  keys: { keyCode: number; isComposing: boolean },
  mods: { meta?: boolean } = {},
) =>
  act(async () => {
    const e = new (window.Event as unknown as typeof Event)("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(e, {
      key: "Enter",
      code: "Enter",
      which: keys.keyCode,
      shiftKey: false,
      metaKey: !!mods.meta,
      ctrlKey: false,
      altKey: false,
      repeat: false,
      ...keys,
    });
    field.dispatchEvent(e);
  });

test("Ask an agent: the Enter of a conversion starts no chat, Ask or Fix; a plain Enter asks with the whole question", async () => {
  const spawned: Array<[AskMode, string]> = [];
  const view = await render(
    createElement(AskMenu, {
      onSpawn: async (mode, text) => void spawned.push([mode, text]),
      onOpenChange: () => undefined,
      place: null,
    }),
  );
  await click(buttons(view.host, /Ask/)[0]);
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask an agent"]')!;

  await type(field, "このハンドルはどこで");
  for (const ime of [CHROME_IME_ENTER, SAFARI_IME_ENTER]) {
    await enter(field, ime);
    await enter(field, ime, { meta: true });
  }
  expect(spawned).toEqual([]);

  await type(field, "このハンドルはどこで閉じる？");
  await enter(field, ENTER);
  expect(spawned).toEqual([["ask", "このハンドルはどこで閉じる？"]]);
});
