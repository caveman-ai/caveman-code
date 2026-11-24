import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { SaveFailure, useSaveSettings } from "./rows.tsx";

// new-chat-model.tsx reaches the composer, whose drag engine reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));

type Save = ReturnType<typeof useSaveSettings>;

/** The hook's save, from a runtime whose settings.set does what `saveSettings` says. */
function saverFor(runtime: Partial<RuntimeContextValue>, throws = false): Save {
  let save: Save | null = null;
  const Grab = () => {
    save = useSaveSettings({ throws });
    return null;
  };
  renderToStaticMarkup(createElement(RuntimeContext.Provider, { value: { client: null, settings: null, engines: [], workspaces: [], refresh: async () => undefined, ...runtime } as unknown as RuntimeContextValue }, createElement(Grab)));
  return save!;
}

test("a refused save says so in Settings' header instead of failing silently", async () => {
  const shown: Array<string | null> = [];
  const save = saverFor({ saveSettings: async () => Promise.reject(new Error("text_size is not a size")), setSettingsSaveError: (m) => shown.push(m) });
  await expect(save({ text_size: "large" })).resolves.toBeUndefined();
  expect(shown).toEqual([null, "Couldn't save that change: text_size is not a size. It's back to what was saved."]);
});

test("a card that shows its own error gets the refusal instead of the header", async () => {
  const shown: Array<string | null> = [];
  const save = saverFor({ saveSettings: async () => Promise.reject(new Error("nope")), setSettingsSaveError: (m) => shown.push(m) }, true);
  await expect(save({ text_size: "large" })).rejects.toThrow("nope");
  expect(shown).toEqual([null]);
});

test("a save goes through the runtime's saveSettings, with no reload of every list", async () => {
  const saved: unknown[] = [];
  const refresh = vi.fn(async () => undefined);
  const save = saverFor({ saveSettings: async (patch) => void saved.push(patch), refresh });
  await save({ density: "compact" });
  expect(saved).toEqual([{ density: "compact" }]);
  expect(refresh).not.toHaveBeenCalled();
});

test("Settings' header shows the failed save with a way to dismiss it", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeContext.Provider, { value: { client: null, settingsSaveError: "Couldn't save that change. It's back to what was saved." } as unknown as RuntimeContextValue }, createElement(SaveFailure)),
  );
  expect(html).toMatch(/role="alert"[^>]*>.*Couldn&#x27;t save that change\. It&#x27;s back to what was saved\./);
  expect(html).toContain(">Dismiss<");
});

test("New chats' model saves one engine's default and keeps the others; the old model's effort goes with it", async () => {
  const { settingModel } = await import("./new-chat-model.tsx");
  const { withDefaultModel } = await import("../../components/Composer.tsx");
  const settings = { engines: { "claude-agent": { model: "opus", effort: "high", account_id: "a1" }, codex: { model: "gpt-6" } } } as unknown as Parameters<typeof withDefaultModel>[0];
  expect(withDefaultModel(settings, "claude-agent", "caveman-auto")).toEqual({ "claude-agent": { model: "caveman-auto", account_id: "a1" }, codex: { model: "gpt-6" } });
  expect(withDefaultModel(settings, "caveman", "auto")).toMatchObject({ caveman: { model: "auto" } });
  // Nothing saved: the engine's default_model, Auto where offered.
  const engine = { id: "codex", label: "Codex", default_model: "caveman-auto", models: [{ id: "caveman-auto", label: "Auto", efforts: [] }, { id: "gpt-6", label: "GPT-6", efforts: [] }] };
  expect(settingModel(engine as never, { engines: {} } as never)?.id).toBe("caveman-auto");
  expect(settingModel(engine as never, settings)?.id).toBe("gpt-6");
  // In a project where Auto can't run, the default it gives way to.
  const claude = { ...engine, id: "claude-agent", models: [...engine.models, { id: "sonnet", label: "Sonnet", efforts: [] }] };
  const bedrock = { id: "p1", engine_default_models: { "claude-agent": "sonnet" } } as never;
  expect(settingModel(claude as never, { engines: {} } as never, bedrock)?.id).toBe("sonnet");
});
