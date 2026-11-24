import { buttons, click, container, submit, type } from "../../lib/dom.test-support.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import type { BrowserState, InputEvent, LiveSource } from "../live/source.ts";
import { BrowserDialog } from "./BrowserDialog.tsx";

type Dialog = NonNullable<BrowserState["dialog"]>;

async function mount(dialog: Dialog, driving: boolean) {
  const sent: InputEvent[] = [];
  const source = {
    input: (...events: InputEvent[]) => void sent.push(...events),
  } as unknown as LiveSource<BrowserState>;
  const host = container();
  const root = createRoot(host);
  await act(async () => root.render(createElement(BrowserDialog, { dialog, driving, source })));
  return {
    host,
    sent,
    form: () => host.querySelector("form"),
    unmount: () => act(async () => root.unmount()),
  };
}

test("the person driving answers the page's confirm with Cancel or OK", async () => {
  const { host, sent, form, unmount } = await mount(
    { type: "confirm", message: "Delete row?", default_value: "" },
    true,
  );
  expect(host.querySelector("[role='alertdialog']")?.textContent).toContain("Delete row?");
  await click(buttons(host, "Cancel")[0]);
  await submit(form());
  expect(sent).toEqual([
    { type: "dialog", accept: false },
    { type: "dialog", accept: true },
  ]);
  await unmount();
});

test("a prompt starts from the page's default and answers with what the person typed", async () => {
  const { host, sent, form, unmount } = await mount(
    { type: "prompt", message: "Your name?", default_value: "Grace" },
    true,
  );
  const field = host.querySelector<HTMLInputElement>("input[aria-label='Answer']");
  expect(field?.value).toBe("Grace");
  await type(field, "Ada");
  await submit(form());
  expect(sent).toEqual([{ type: "dialog", accept: true, text: "Ada" }]);
  await unmount();
});

test("an alert has only OK, and a leave-page check asks to stay or leave", async () => {
  const alert = await mount({ type: "alert", message: "Saved", default_value: "" }, true);
  expect(buttons(alert.host, "Cancel")).toEqual([]);
  expect(buttons(alert.host, "OK")).toHaveLength(1);
  await alert.unmount();
  const leave = await mount({ type: "beforeunload", message: "", default_value: "" }, true);
  expect(leave.host.textContent).toContain("Leave this page?");
  await click(buttons(leave.host, "Stay")[0]);
  expect(buttons(leave.host, "Leave")).toHaveLength(1);
  expect(leave.sent).toEqual([{ type: "dialog", accept: false }]);
  await leave.unmount();
});

test("a window not in control sees the dialog and is told to take over to answer it", async () => {
  const { host, sent, unmount } = await mount(
    { type: "confirm", message: "Delete row?", default_value: "" },
    false,
  );
  expect(host.textContent).toContain("Delete row?");
  expect(host.textContent).toContain("Take over to answer.");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(sent).toEqual([]);
  await unmount();
});
