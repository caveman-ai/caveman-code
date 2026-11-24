import type { Settings } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { completion, goToActions, newChatLeads, sections, stepFilter } from "./goto-actions.ts";

const settings = (over: Partial<Settings> = {}) => ({ theme: "dark", text_size: "default", color_theme: "caveman", ...over }) as unknown as Settings;
const labels = (query: string, s: Settings | null = settings(), hidden = false) => goToActions(query, s, hidden, "⌘B").map((a) => a.label);

test("⌘K switches light and dark, offering only the modes you are not in", () => {
  expect(labels("light")).toContain("Light mode");
  expect(labels("dark")).not.toContain("Dark mode");
  // "theme" alone lists the modes, not all twenty colour themes.
  expect(labels("theme")).toEqual(["Light mode", "Follow the system's light or dark"]);
  expect(goToActions("light", settings(), false, "⌘B").find((a) => a.label === "Light mode")?.act).toEqual({ settings: { theme: "light" } });
});

test("text size steps one size from where it is, and stops at either end", () => {
  expect(goToActions("bigger", settings({ text_size: "large" }), false, "⌘B")[0]?.act).toEqual({ settings: { text_size: "larger" } });
  expect(labels("bigger", settings({ text_size: "larger" }))).toEqual([]);
  expect(labels("smaller", settings({ text_size: "small" }))).toEqual([]);
  expect(labels("font")).toEqual(["Bigger text", "Smaller text"]);
});

test("a colour theme is one word away; the one you wear is not offered", () => {
  expect(labels("dracula")).toEqual(["Dracula theme"]);
  expect(goToActions("dracula", settings(), false, "⌘B")[0]?.act).toEqual({ settings: { color_theme: "dracula" } });
  expect(labels("dracula", settings({ color_theme: "dracula" }))).toEqual([]);
  expect(labels("nord theme")).toEqual(["Nord theme"]);
});

test("the sidebar row says what it will do and its key", () => {
  expect(goToActions("sidebar", settings(), false, "⌘B")).toEqual([{ key: "sidebar", label: "Hide sidebar", description: "Projects and chats (⌘B)", act: { sidebar: "toggle" } }]);
  expect(labels("sidebar", settings(), true)).toEqual(["Show sidebar"]);
});

test("nothing before something is typed or before Settings arrive", () => {
  expect(labels("")).toEqual([]);
  expect(labels("light", null)).toEqual([]);
});

test("the top row's name is typed ahead when it begins with what was typed", () => {
  expect(completion("plu", "Plugins")).toBe("gins");
  expect(completion("PLU", "Plugins")).toBe("gins");
  expect(completion("gins", "Plugins")).toBe("");
  expect(completion("Plugins", "Plugins")).toBe("");
  expect(completion("", "Plugins")).toBe("");
  expect(completion(" ", " Plugins")).toBe("");
});

test("New chat leads once the search answers and nothing matched by its words", () => {
  expect(newChatLeads("fix the login", true, [])).toBe(true);
  expect(newChatLeads("fix the login", true, [{ byMeaning: true }])).toBe(true);
  expect(newChatLeads("fix the login", true, [{ byMeaning: true }, {}])).toBe(false);
  // Before the answer, a chat about to be found must not lose Enter to New chat.
  expect(newChatLeads("fix the login", false, [])).toBe(false);
  expect(newChatLeads("  ", true, [])).toBe(false);
});

test("the list reads as sections, and the arrows still step through one list", () => {
  const rows = [{ section: "Top hit" }, { section: "Chats" }, { section: "Chats" }, { section: "Go to" }];
  expect(sections(rows).map((s) => [s.name, s.rows.map((r) => r.index)])).toEqual([
    ["Top hit", [0]],
    ["Chats", [1, 2]],
    ["Go to", [3]],
  ]);
  expect(sections([])).toEqual([]);
});

test("the Actions filter lists every action before anything is typed, without the colour themes", () => {
  expect(goToActions("", settings(), false, "⌘B", true).map((a) => a.label)).toEqual(["Light mode", "Follow the system's light or dark", "Bigger text", "Smaller text", "Hide sidebar", "Report a problem"]);
  expect(goToActions("", null, false, "⌘B", true)).toEqual([]);
});

test("the arrows step through the filters and go round", () => {
  expect(stepFilter("all", 1)).toBe("chats");
  expect(stepFilter("all", -1)).toBe("settings");
  expect(stepFilter("settings", 1)).toBe("all");
});
