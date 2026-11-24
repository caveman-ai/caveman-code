import { expect, test } from "vitest";
import {
  findSettings,
  holdsHere,
  SETTINGS_SECTIONS,
  settingsGroups,
  settingsHome,
  settingsRedirect,
} from "./sections.ts";

const ids = (query: string) => findSettings(query).map((s) => s.id);

test("⌘K finds a Settings section by its name, its line or its keywords", () => {
  expect(ids("appearance")).toEqual(["appearance"]);
  // Words people type for a page whose name is different.
  expect(ids("theme")).toEqual(["appearance"]);
  expect(ids("api key")).toEqual(["models"]);
  expect(ids("shortcuts")).toEqual(["keyboard"]);
  expect(ids("spend")).toEqual(["usage"]);
  // The one way back to an archived chat besides its address.
  expect(ids("archived")).toEqual(["archived"]);
  // Where keys and tokens point at 1Password.
  expect(ids("1password")).toEqual(["secret-providers"]);
  expect(ids("restore chat")).toEqual(["archived"]);
  // Where a team's unattended agents are set up: the Platform's pages, linked from Account.
  expect(ids("service account")).toEqual(["account"]);
  expect(ids("code policy")).toEqual(["account"]);
  // Each repo's Cloud setup, the way Codex names it.
  expect(ids("cloud environment")).toEqual(["environments"]);
  expect(ids("snapshot")).toEqual(["environments"]);
  // The pull request guide's depth and writer.
  expect(ids("tldr")).toEqual(["review"]);
  // Agents Caveman Code did not launch, which operate it over MCP: by the page's name, its old one, the verb, or the agent.
  expect(ids("caveman mcp")).toEqual(["caveman-mcp"]);
  expect(ids("outside agents")).toEqual(["caveman-mcp"]);
  expect(ids("connect grok")).toEqual(["caveman-mcp"]);
  expect(ids("mcp server")).toEqual(["caveman-mcp"]);
  expect(ids("claude code operate")).toEqual(["caveman-mcp"]);
  expect(ids("install vs code")).toEqual(["caveman-mcp"]);
  // Agents using this Mac's apps: by the page's name and the macOS permissions it takes.
  expect(ids("computer use")).toEqual(["computer-use"]);
  expect(ids("accessibility")).toEqual(["computer-use"]);
  expect(ids("screen recording")).toEqual(["computer-use"]);
  // What the runtime's messages send people to: "(Settings, Devices)" and "(Settings, Remote control)".
  expect(ids("devices")).toEqual(["devices"]);
  expect(ids("remote control")).toEqual(["devices"]);
  // Nothing typed: no Settings rows, so the empty list stays short.
  expect(ids("")).toEqual([]);
  expect(ids("   ")).toEqual([]);
});

test("section ids are unique, and every one is a page Settings draws", async () => {
  const all = SETTINGS_SECTIONS.flatMap((g) => g.sections.map((s) => s.id));
  expect(new Set(all).size).toBe(all.length);
  expect(all).toHaveLength(21);
});

test("the nav opens on the app's own basics with no heading, then one heading per group", () => {
  expect(SETTINGS_SECTIONS.map((g) => g.label)).toEqual(["", "You", "Agents", "Code", "Cloud"]);
  expect(SETTINGS_SECTIONS[0].sections.map((s) => s.id)).toEqual([
    "general",
    "appearance",
    "keyboard",
    "computer-use",
    "reports",
  ]);
  // No group is a dump: the old Work held twelve.
  for (const g of SETTINGS_SECTIONS) expect(g.sections.length).toBeLessThanOrEqual(7);
});

test("an old section id lands where it moved, an unknown one on General, a real one stays", () => {
  expect(settingsRedirect("engines")).toBe("/settings/models");
  expect(settingsRedirect("spaces")).toBe("/plugins/yours");
  expect(settingsRedirect("outside-agents")).toBe("/settings/caveman-mcp");
  // What Caveman holds is under Account now, opened.
  expect(settingsRedirect("cloud")).toBe("/settings/account#held");
  expect(ids("held by caveman")).toEqual(["account"]);
  expect(ids("who read")).toEqual(["account"]);
  expect(settingsRedirect("cloud-console")).toBe("/settings/account");
  expect(settingsRedirect("remote")).toBe("/settings/devices");
  // It used to draw General under /settings/nonexistent, with no section lit in the nav.
  expect(settingsRedirect("nonexistent")).toBe("/settings/general");
  expect(settingsRedirect("constructor")).toBe("/settings/general");
  expect(settingsRedirect("appearance")).toBeNull();
  expect(settingsRedirect("general")).toBeNull();
});

test("in Cloud where nothing of its person's is kept, the sections with their own settings say a change stays there", () => {
  const note = "Changes here stay in Cloud. Change a setting on your Mac to change it everywhere.";
  const all = SETTINGS_SECTIONS.flatMap((g) => g.sections.map((s) => s.id as string));
  // The person's settings, which a Mac sends to every computer of theirs: the look, new chats, the Chiefs' limits, agents, reviews, memory.
  expect(all.filter((id) => holdsHere(id, true) !== null)).toEqual([
    "general",
    "appearance",
    "keyboard",
    "chief",
    "agents",
    "memory",
    "review",
  ]);
  for (const id of ["general", "appearance", "keyboard", "chief", "agents", "review", "memory"])
    expect(holdsHere(id, true)).toBe(note);
  // A Mac, or Cloud that syncs: nothing to say.
  expect(all.filter((id) => holdsHere(id, false) !== null)).toEqual([]);
});

test("a browser window lists Cloud's own pages, and a computer's pages only while it uses one, under whose they are", () => {
  const ids = (
    home?: Parameters<typeof settingsGroups>[0],
  ): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
    settingsGroups(home).map((g) => [g.label, g.sections.map((s) => s.id)] as const);
  // The app: every page, as grouped.
  expect(ids().map(([label]) => label)).toEqual(["", "You", "Agents", "Code", "Cloud"]);
  expect(settingsHome()).toBe("/settings/general");
  // No computer behind the window: only what Cloud alone answers, and Settings opens on one of them.
  expect(ids(null)).toEqual([["You", ["account", "plan", "models", "computers"]]]);
  expect(settingsHome(null)).toBe("/settings/computers");
  expect(settingsRedirect("general", null)).toBe("/settings/computers");
  expect(settingsRedirect("models", null)).toBeNull();
  expect(settingsRedirect("nonexistent", null)).toBe("/settings/computers");
  expect(settingsRedirect("cloud", null)).toBe("/settings/account#held");
  // A Mac of theirs behind it: its pages are there, under its name; Cloud says "In Cloud".
  const studio = ids({ kind: "mac", name: "Studio" });
  expect(studio.map(([label]) => label)).toEqual(["You", "On Studio"]);
  expect(studio[1]![1]).toContain("general");
  expect(studio[1]![1]).not.toContain("computers");
  expect(new Set(studio.flatMap(([, list]) => list)).size).toBe(
    SETTINGS_SECTIONS.reduce((n, g) => n + g.sections.length, 0),
  );
  expect(ids({ kind: "cloud", name: "Cloud" })[1]![0]).toBe("In Cloud");
  expect(settingsRedirect("general", { kind: "mac", name: "Studio" })).toBeNull();
  expect(settingsHome({ kind: "mac", name: "Studio" })).toBe("/settings/computers");
});
