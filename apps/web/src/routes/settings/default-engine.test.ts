// Models & keys, "New chats start on": a save that fails says so in Settings' header, like every other control.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";

// new-chat-model.tsx reaches the composer, whose drag engine reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));

const picked = vi.hoisted(() => ({ onValueChange: null as ((value: string) => void) | null }));
// The kit's Select as a box that hands the test its onValueChange (nothing to click without a DOM).
vi.mock("@caveman-app/ui/components/select", async () => {
  const { createElement: h } = await import("react");
  const box = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Select: (p: { onValueChange?: (value: string) => void; children?: ReactNode }) => {
      picked.onValueChange ??= p.onValueChange ?? null;
      return box(p);
    },
    SelectTrigger: box,
    SelectValue: () => null,
    SelectContent: box,
    SelectItem: box,
  };
});

const engine = (id: string, label: string) => ({
  id,
  label,
  auth: { state: "signed_in", accounts: [] },
  capabilities: {},
  models: [],
});

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  picked.onValueChange = null;
  unhandled.length = 0;
});

/** Picks `id` on a runtime whose settings.set answers `saved`; what Settings' header was told, and what went unhandled. */
async function pick(id: string, saved: () => Promise<void>) {
  const { ModelsAndKeysSettings } = await import("./ModelsAndKeys.tsx");
  process.on("unhandledRejection", onUnhandled);
  const shown: Array<string | null> = [];
  const patches: unknown[] = [];
  const runtime = {
    // The same runtime behind the client and the provider's saveSettings.
    client: { call: async () => saved() },
    settings: { default_engine: "claude-agent" },
    engines: [engine("claude-agent", "Claude Agent"), engine("codex", "Codex")],
    workspaces: [],
    refresh: async () => undefined,
    saveSettings: async (patch: unknown) => {
      patches.push(patch);
      return saved();
    },
    settingsSaveError: null,
    setSettingsSaveError: (m: string | null) => void shown.push(m),
  } as unknown as RuntimeContextValue;
  renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      { value: runtime },
      createElement(ModelsAndKeysSettings),
    ),
  );
  picked.onValueChange!(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    shown,
    patches,
    unhandled: unhandled.map((r) => (r instanceof Error ? r.message : String(r))),
  };
}

test("a refused 'New chats start on' save says so in Settings' header", async () => {
  expect(await pick("codex", () => Promise.reject(new Error("settings.set timed out")))).toEqual({
    shown: [
      null,
      "Couldn't save that change: settings.set timed out. It's back to what was saved.",
    ],
    patches: [{ default_engine: "codex" }],
    unhandled: [],
  });
});

test("picking the engine new chats already start on saves nothing", async () => {
  expect(await pick("claude-agent", () => Promise.resolve())).toEqual({
    shown: [],
    patches: [],
    unhandled: [],
  });
});
