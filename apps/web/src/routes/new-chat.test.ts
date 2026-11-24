import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { chatEngine, NO_ENGINE, needsEngine, setupHereMessage } from "../state/engines.ts";
import { SETTINGS_SECTIONS } from "./settings/sections.ts";

const engine = (id: string, state: EngineDescriptor["auth"]["state"]) => ({ id, label: id, auth: { state, accounts: [] } }) as unknown as EngineDescriptor;

test("New chat says an engine is missing only once every engine has answered and none is ready", () => {
  // A fresh install that skipped setup: everything signed out.
  expect(needsEngine([engine("caveman", "signed_out"), engine("claude-agent", "signed_out"), engine("cursor", "signed_out")])).toBe(true);
  expect(needsEngine([engine("caveman", "signed_out"), engine("claude-agent", "signed_in")])).toBe(false);
  expect(needsEngine([engine("caveman", "api_key")])).toBe(false);
  // Still checking, or not answered yet: no claim either way.
  expect(needsEngine([engine("caveman", "signed_out"), engine("claude-agent", "checking")])).toBe(false);
  expect(needsEngine([])).toBe(false);
});

test("the missing-engine message names the Settings section that exists", () => {
  const label = SETTINGS_SECTIONS.flatMap((g) => g.sections as ReadonlyArray<{ id: string; label: string }>).find((s) => s.id === "models")?.label;
  expect(label).toBe("Models & keys");
  expect(NO_ENGINE).toContain(`Settings > ${label}`);
  // The route the New chat button opens is that section.
  expect(readFileSync(new URL("./NewChat.tsx", import.meta.url), "utf8")).toContain('to="/settings/models"');
});

test("on the page that sets an engine up, its status line drops the pointer to that same page", () => {
  // The runtime's own lines (handlers.ts, provider-caveman driver.ts), as Models & keys and first run showed them.
  expect(setupHereMessage("Connect Cursor in Settings > Models & keys.")).toBe("Connect Cursor.");
  expect(setupHereMessage("Add a provider key in Settings > Models & keys to use the Caveman engine.")).toBe("Add a provider key to use the Caveman engine.");
  expect(setupHereMessage("Claude Agent is not authenticated. Run `claude auth login` and try again.")).toBe("Claude Agent is not authenticated. Run `claude auth login` and try again.");
});

test("a chat sent while the runtime still checks its engines starts on the picked or default one", () => {
  const checking = [engine("caveman", "checking"), engine("claude-agent", "checking")];
  expect(chatEngine(checking, null, "claude-agent")?.id).toBe("claude-agent");
  expect(chatEngine(checking, "caveman", "claude-agent")?.id).toBe("caveman");
  // Nothing picked and no default: no guess among engines still checking.
  expect(chatEngine(checking, null, undefined)).toBeUndefined();
  // Once answered, a ready engine wins over the default that turned out signed out.
  expect(chatEngine([engine("caveman", "api_key"), engine("claude-agent", "signed_out")], null, "claude-agent")?.id).toBe("caveman");
  expect(chatEngine([engine("caveman", "signed_out"), engine("claude-agent", "signed_out")], null, "claude-agent")).toBeUndefined();
});
