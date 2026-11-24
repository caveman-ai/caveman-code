import { expect, test } from "vitest";
import { cardFolded, cardSteps, hasConnection, setupDone, SYNC_LABEL, type Progress } from "./getting-started.ts";

const plugin = (installed: boolean, connections: number, needsConnect = false) => ({
  installed,
  needs_connect: needsConnect,
  includes: { skills: 0, mcp_servers: connections, connections, hooks: 0, commands: 0, agents: 0, rules: 0 },
});

test("a connection counts once a plugin that signs in is installed and signed in", () => {
  expect(hasConnection([])).toBe(false);
  expect(hasConnection([plugin(false, 1)])).toBe(false);
  expect(hasConnection([plugin(true, 0)])).toBe(false);
  expect(hasConnection([plugin(true, 1, true)])).toBe(false);
  expect(hasConnection([plugin(true, 0), plugin(true, 1)])).toBe(true);
});

test("the card folds to its header once the first task is done, unless the person chose otherwise", () => {
  // Untouched: open while there is nothing yet, one line once chats fill the sidebar.
  expect(cardFolded(null, false)).toBe(false);
  expect(cardFolded(null, true)).toBe(true);
  // The person's own choice stands either way.
  expect(cardFolded("open", true)).toBe(false);
  expect(cardFolded("folded", false)).toBe(true);
});

const NOTHING: Progress = { engine: false, connections: false, task: false, automation: false };
const ALL: Progress = { engine: true, connections: true, task: true, automation: true };
const ids = (steps: ReturnType<typeof cardSteps>) => steps.map((s) => `${s.id}${s.done ? ":done" : ""}${s.urgent ? "!" : ""}`);

test("a step that waits on the person keeps an untouched card open, and never unfolds one they folded", () => {
  expect(cardFolded(null, true, true)).toBe(false);
  expect(cardFolded("folded", true, true)).toBe(true);
  // Setup hidden or done: what was put off shows open.
  expect(cardFolded("done", true, true)).toBe(false);
  expect(cardFolded("hidden", true, true)).toBe(false);
});

test("the setup steps alone, where nothing was put off", () => {
  expect(ids(cardSteps({ card: null, progress: NOTHING, sync: null, syncAsk: null, devices: [] }))).toEqual(["engine", "connections", "task", "automation"]);
  // The runtime has not said what is set up: nothing to list.
  expect(cardSteps({ card: null, progress: null, sync: null, syncAsk: null, devices: [] })).toEqual([]);
  // Sync offered and not turned on: a step to open when the person wants it (the prompt never opens by itself), not an urgency.
  expect(ids(cardSteps({ card: null, progress: NOTHING, sync: "ask", syncAsk: null, devices: [] }))).toEqual(["engine", "sync", "connections", "task", "automation"]);
});

test("a sync step put off earlier on this device stays here, after the engine and marked", () => {
  const steps = cardSteps({ card: null, progress: { ...NOTHING, engine: true }, sync: "ask", syncAsk: "later", devices: [] });
  expect(ids(steps)).toEqual(["engine:done", "sync!", "connections", "task", "automation"]);
  expect(steps[1]!.label).toBe(SYNC_LABEL);
  // Turned on: ticked with the rest.
  expect(ids(cardSteps({ card: null, progress: NOTHING, sync: "on", syncAsk: "later", devices: [] }))).toEqual(["engine", "sync:done", "connections", "task", "automation"]);
  // Hidden from here too: not offered again.
  expect(ids(cardSteps({ card: null, progress: NOTHING, sync: "ask", syncAsk: "never", devices: [] }))).toEqual(["engine", "connections", "task", "automation"]);
});

test("a device whose question was closed leads the card, by its name", () => {
  const steps = cardSteps({ card: null, progress: NOTHING, sync: "ask", syncAsk: "later", devices: [{ id: "d1", name: "Chrome on Mac" }] });
  expect(ids(steps)).toEqual(["device:d1!", "engine", "sync!", "connections", "task", "automation"]);
  expect(steps[0]!.label).toBe("Allow Chrome on Mac");
});

test("setup hidden or done, the card keeps only what still waits on the person", () => {
  for (const card of ["hidden", "done"] as const) {
    expect(ids(cardSteps({ card, progress: ALL, sync: "ask", syncAsk: "later", devices: [{ id: "d1", name: "iPhone" }] }))).toEqual(["device:d1!", "sync!"]);
    // Nothing waits: no card. Sync that is on is not a step to show for.
    expect(cardSteps({ card, progress: ALL, sync: "on", syncAsk: null, devices: [] })).toEqual([]);
    expect(cardSteps({ card, progress: ALL, sync: null, syncAsk: null, devices: [] })).toEqual([]);
  }
  expect(setupDone(ALL)).toBe(true);
  expect(setupDone({ ...ALL, automation: false })).toBe(false);
  expect(setupDone(null)).toBe(false);
});
