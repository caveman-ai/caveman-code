// InstructionsCard (General > Chat titles, Review > Your taste) on the optimistic settings view: Save shows the new
// text at once and takes it back when settings.set is refused, and what the person typed must survive that.
import { button, click, deferred, mount, rendered, settle, type } from "./browser.fixture.ts";

import type { Settings } from "@caveman-app/session-protocol";
import * as React from "react";
import { createElement, useMemo, useRef, useState } from "react";
import { afterEach, expect, test } from "vitest";

import {
  RuntimeContext,
  useRuntimeSelector,
  type RuntimeContextValue,
} from "../../state/runtime.tsx";
import { SettingsSaves, type SettingsPatch } from "../../state/settings-saves.ts";
import { InstructionsCard, useSaveSettings } from "./rows.tsx";

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The runtime provider's saveSettings (state/runtime.tsx) on the real SettingsSaves, over a settings.set the test answers. */
function Runtime({
  call,
  initial,
  poll,
  children,
}: {
  call: (patch: SettingsPatch) => Promise<Settings>;
  initial: Settings | null;
  poll: { push: (s: Settings) => void };
  children: React.ReactNode;
}) {
  const saves = useRef<SettingsSaves | null>(null);
  if (!saves.current) {
    saves.current = new SettingsSaves();
    if (initial) saves.current.polled(initial, saves.current.asking());
  }
  const [settings, setSettings] = useState(() => saves.current!.view());
  // A poll's answer, as the provider takes one.
  poll.push = (next) =>
    saves.current!.polled(next, saves.current!.asking()) && setSettings(saves.current!.view());
  const saveSettings = async (patch: SettingsPatch) => {
    const s = saves.current!;
    const id = s.begin(patch);
    setSettings(s.view());
    try {
      s.succeed(id, await call(patch));
    } catch (e) {
      s.fail(id);
      throw e;
    } finally {
      setSettings(s.view());
    }
  };
  const value = useMemo(
    () => ({
      client: { call },
      settings,
      engines: [],
      workspaces: [],
      refresh: async () => undefined,
      saveSettings,
      setSettingsSaveError: () => undefined,
    }),
    [settings],
  );
  return createElement(
    RuntimeContext.Provider,
    { value: value as unknown as RuntimeContextValue },
    children,
  );
}

/** General > Chat titles, wired as General.tsx wires it. */
function ChatTitles() {
  const settings = useRuntimeSelector((v) => v.settings);
  const saveTitles = useSaveSettings({ throws: true });
  return createElement(InstructionsCard, {
    title: "Chat titles",
    description: "How chats are named.",
    label: "How chats are named",
    placeholder: "",
    maxLength: 2000,
    value: settings?.thread_title_instructions ?? "",
    disabled: !settings,
    onSave: (thread_title_instructions: string) => saveTitles({ thread_title_instructions }),
  });
}

const OLD = { thread_title_instructions: "Old rule." } as Settings;
const TYPED = "Two to four words, no articles. Lead with the area: Billing: invoice rounding.";

async function chatTitles(initial: Settings | null) {
  const answer = deferred<Settings>();
  const call = (_patch: SettingsPatch) => answer.promise;
  const poll = { push: (_: Settings) => undefined as unknown };
  page = await mount(
    createElement(Runtime, { call, initial, poll, children: createElement(ChatTitles) }),
  );
  const field = () => page!.container.querySelector("textarea")!;
  const save = () => button(page!.container, "Save");
  const polled = (next: Settings) => React.act(async () => void poll.push(next));
  return { container: page.container, answer, field, save, polled };
}

test("a refused Save keeps the instructions the person typed, with Save there to retry", async () => {
  const c = await chatTitles(OLD);
  expect(rendered(c.field()).value).toBe("Old rule.");
  await type(c.field(), TYPED);
  await click(c.save());
  expect(rendered(c.field()).value).toBe(TYPED);
  c.answer.reject(new Error("thread_title_instructions is not supported"));
  await settle();
  expect(c.container.textContent).toContain("thread_title_instructions is not supported");
  expect({ field: rendered(c.field()).value, saveDisabled: rendered(c.save()).disabled }).toEqual({
    field: TYPED,
    saveDisabled: false,
  });
});

test("a Save the runtime takes leaves the saved text in the field and says Saved", async () => {
  const c = await chatTitles(OLD);
  await type(c.field(), `  ${TYPED}  `);
  await click(c.save());
  c.answer.resolve({ thread_title_instructions: TYPED } as Settings);
  await settle();
  expect({ field: rendered(c.field()).value, saveDisabled: rendered(c.save()).disabled }).toEqual({
    field: TYPED,
    saveDisabled: true,
  });
  expect(c.container.textContent).toContain("Saved");
});

test("instructions that arrive once Settings load fill the field", async () => {
  const c = await chatTitles(null);
  expect(rendered(c.field()).value).toBe("");
  await c.polled(OLD);
  expect({ field: rendered(c.field()).value, saveDisabled: rendered(c.save()).disabled }).toEqual({
    field: "Old rule.",
    saveDisabled: true,
  });
});
