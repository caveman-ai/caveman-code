import { expect, test } from "vitest";
import { amendPin, pinLabel, pinnedRoles } from "./agents-model.ts";

test("each role pin picker has a name of its own, not six 'Choose a model'", () => {
  expect(pinLabel("implementation", null, "Auto")).toBe("Model for implementation agents: Auto");
  expect(pinLabel("test", null, "Auto")).toBe("Model for test agents: Auto");
  expect(pinLabel("review", "GPT-6-Luna, Codex", "Auto")).toBe("Model for review agents: GPT-6-Luna, Codex");
  expect(pinLabel("research", null, "Same as the chat")).toBe("Model for research agents: Same as the chat");
});

test("a role pin tags its model's row in the section its login has", () => {
  const engines = [
    { id: "claude-agent", auth: { accounts: [{ id: "work", active: true }, { id: "home", active: false }] } },
    { id: "codex", auth: { accounts: [{ id: "codex", active: true }] } },
    { id: "caveman", auth: { accounts: [{ id: "caveman:anthropic", active: true }, { id: "caveman:openai", active: false }] } },
  ];
  const pins = {
    review: { engine: "claude-agent", instance_id: "home", model: "claude-sonnet-5-5" },
    implementation: { engine: "codex", instance_id: "codex", model: "gpt-5.5-codex", effort: "high" },
    test: { engine: "caveman", instance_id: "caveman:openai", model: "openai/gpt-5.5" },
    research: null,
  } as const;
  expect(pinnedRoles(engines as never, pins)).toEqual([
    { model: { engine: "codex", model: "gpt-5.5-codex" }, label: "Implementation" },
    { model: { engine: "claude-agent#home", model: "claude-sonnet-5-5" }, label: "Review" },
    { model: { engine: "caveman", model: "openai/gpt-5.5" }, label: "Tests" },
  ]);
  // A role's own picker leaves its own pin out; no pins, no tags.
  expect(pinnedRoles(engines as never, pins, "review").map((r) => r.label)).toEqual(["Implementation", "Tests"]);
  expect(pinnedRoles(engines as never, undefined)).toEqual([]);
  // A task kind's pin tags its model too, after the roles'; its own picker leaves it out.
  const tasks = { frontend_ui: { engine: "claude-agent", instance_id: "work", model: "claude-opus-5-5", always: true } } as const;
  expect(pinnedRoles(engines as never, pins, undefined, tasks).map((r) => r.label)).toEqual(["Implementation", "Review", "Tests", "Frontend & UI"]);
  expect(pinnedRoles(engines as never, undefined, "frontend_ui", tasks)).toEqual([]);
});

test("Prefer/Always and effort change a pin as it is, its login kept even while signed out", () => {
  const pin = { engine: "claude-agent", instance_id: "home", model: "claude-opus-5-5", effort: "high" } as const;
  expect(amendPin(pin, { always: true })).toEqual({ ...pin, always: true });
  expect(amendPin({ ...pin, always: true }, { always: false })).toEqual(pin);
  expect(amendPin({ ...pin, always: true }, { effort: "low" })).toEqual({ ...pin, effort: "low", always: true });
});
