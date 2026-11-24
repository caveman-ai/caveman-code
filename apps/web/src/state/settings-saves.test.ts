import type { Settings } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { SettingsSaves, saveFailure } from "./settings-saves.ts";

const base = { default_engine: "caveman", theme: "system", text_size: "default", density: "comfortable" } as unknown as Settings;

test("a control shows its new value before the runtime answers, then the runtime's answer", () => {
  const saves = new SettingsSaves();
  saves.polled(base, saves.asking());
  const id = saves.begin({ text_size: "large" });
  expect(saves.view()?.text_size).toBe("large");
  saves.succeed(id, { ...base, text_size: "large" });
  expect(saves.view()?.text_size).toBe("large");
  expect(saves.saving).toBe(false);
});

test("a refused save takes back only its own change; a later one stays", () => {
  const saves = new SettingsSaves();
  saves.polled(base, saves.asking());
  const first = saves.begin({ text_size: "large" });
  saves.begin({ density: "compact" });
  saves.fail(first);
  expect(saves.view()?.text_size).toBe("default");
  expect(saves.view()?.density).toBe("compact");
});

test("an answer to an earlier save keeps the later unanswered change showing", () => {
  const saves = new SettingsSaves();
  saves.polled(base, saves.asking());
  const first = saves.begin({ theme: "dark" });
  saves.begin({ theme: "light" });
  saves.succeed(first, { ...base, theme: "dark" });
  expect(saves.view()?.theme).toBe("light");
});

test("a poll that answers mid-save never undoes the change; after it, polls are taken again", () => {
  const saves = new SettingsSaves();
  saves.polled(base, saves.asking());
  const id = saves.begin({ density: "compact" });
  expect(saves.polled(base, saves.asking())).toBe(false);
  expect(saves.view()?.density).toBe("compact");
  saves.succeed(id, { ...base, density: "compact" });
  expect(saves.polled({ ...base, density: "comfortable" }, saves.asking())).toBe(true);
  expect(saves.view()?.density).toBe("comfortable");
});

test("a poll asked before a save that was answered before the poll came back never undoes it", () => {
  const saves = new SettingsSaves();
  saves.polled(base, saves.asking());
  const asked = saves.asking();
  const id = saves.begin({ density: "compact" });
  saves.succeed(id, { ...base, density: "compact" });
  expect(saves.polled(base, asked)).toBe(false);
  expect(saves.view()?.density).toBe("compact");
  // Nor one asked before a save that was refused: what the runtime holds comes with the next poll.
  const before = saves.asking();
  saves.fail(saves.begin({ theme: "dark" }));
  expect(saves.polled(base, before)).toBe(false);
  expect(saves.polled(base, saves.asking())).toBe(true);
});

test("a patch replaces whole keys, as settings.set does", () => {
  const saves = new SettingsSaves();
  saves.polled({ ...base, notifications: { needs_input: true, turn_done: true } } as unknown as Settings, saves.asking());
  saves.begin({ notifications: { needs_input: false, turn_done: true } } as never);
  expect(saves.view()?.notifications).toEqual({ needs_input: false, turn_done: true });
});

test("nothing shows before the first Settings arrive", () => {
  const saves = new SettingsSaves();
  saves.begin({ theme: "dark" });
  expect(saves.view()).toBeNull();
});

test("Settings the runtime already said (a launch snapshot) are what a save shows over and a refusal goes back to", () => {
  const saves = new SettingsSaves(base);
  const id = saves.begin({ theme: "dark" });
  expect(saves.view()).toEqual({ ...base, theme: "dark" });
  saves.fail(id);
  expect(saves.view()).toEqual(base);
});

test("a failed save says what failed and that the control went back, in plain words", () => {
  expect(saveFailure(new Error("chief_daily_turns must be at most 100000."))).toBe("Couldn't save that change: chief_daily_turns must be at most 100000. It's back to what was saved.");
  expect(saveFailure(undefined)).toBe("Couldn't save that change. It's back to what was saved.");
});
