// The model picker of a chat started in Cloud from a browser window (cloud-models.ts): the plan's models as Cloud
// lists them, under the ids the Caveman engine runs them by, and what cannot be picked yet listed over the way to it.
import { expect, test } from "vitest";
import {
  AGENT_DEFAULT,
  AUTO_MODEL,
  cloudPickerEngines,
  shownModel,
  modelName,
  planModels,
  startModel,
} from "./cloud-models.ts";

/** Plan catalog v14's nine models, as GET /api/v1/code/credits/models answers them (provider-caveman credits.ts BUNDLED_CREDITS_MODELS). */
const SOLD = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "moonshot/kimi-k3",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-flash",
];
const answer = {
  basis: "list_price",
  models: SOLD.map((model) => ({ model, included: true, list_price: {} })),
};

test("the plan's models carry the ids the Caveman engine runs them by, in Cloud's order", () => {
  expect(planModels(answer).map((m) => m.id)).toEqual([
    "caveman/anthropic/claude-opus-5-5",
    "caveman/anthropic/claude-sonnet-5-5",
    "caveman/anthropic/claude-haiku-5-5",
    "caveman/openai/gpt-6.1-sol",
    "caveman/openai/gpt-6-luna",
    // The engine's own names for these two providers, not Cloud's catalog ids.
    "caveman/moonshotai/kimi-k3",
    "caveman/zai/glm-5.3",
    "caveman/zai/glm-5.3-flash",
    "caveman/deepseek/deepseek-flash",
  ]);
});

test("each is named from its id, as the engine's own list names it", () => {
  expect(planModels(answer).map((m) => m.label)).toEqual([
    "Claude Opus 5.5",
    "Claude Sonnet 5.5",
    "Claude Haiku 5.5",
    "GPT-6.1 Sol",
    "GPT-6 Luna",
    "Kimi K3",
    "GLM 5.3",
    "GLM 5.3 Flash",
    "DeepSeek Flash",
  ]);
  // A dated id keeps its date apart from the version.
  expect(modelName("claude-opus-5-5-20261001")).toBe("Claude Opus 5.5 20261001");
});

test("anything that is not a sold model is dropped: another shape, a provider the engine has no route for, a repeat", () => {
  expect(planModels(null)).toEqual([]);
  expect(planModels({ models: "no" })).toEqual([]);
  expect(
    planModels({
      models: [
        { model: "newlab/model-1" },
        { model: "../etc" },
        { nope: 1 },
        { model: "openai/gpt-6-luna" },
        { model: "openai/gpt-6-luna" },
      ],
    }).map((m) => m.id),
  ).toEqual(["caveman/openai/gpt-6-luna"]);
});

test("with no computer to ask: Caveman's Auto over the plan's models, and each other agent's own model", () => {
  const engines = cloudPickerEngines({ live: [], plan: planModels(answer), locks: {} });
  expect(engines.map((e) => [e.id, e.label, e.models.length, e.locked])).toEqual([
    ["caveman", "Caveman", 10, undefined],
    ["claude-agent", "Claude Agent", 1, undefined],
    ["codex", "Codex", 1, undefined],
  ]);
  expect(shownModel(engines, "caveman")).toBe(AUTO_MODEL);
  expect(shownModel(engines, "codex")).toBe(AGENT_DEFAULT);
  // Before Cloud answers, Auto is there to start on.
  expect(
    cloudPickerEngines({ live: [], plan: null, locks: {} })[0]!.models.map((m) => m.id),
  ).toEqual([AUTO_MODEL]);
});

test("a Cloud computer's own list of an agent's models takes the place of what the window worked out", () => {
  const live = [
    {
      id: "claude-agent",
      label: "Claude Agent",
      models: [
        {
          id: "claude-fable-5-2",
          label: "Claude Fable 5.2",
          efforts: ["low", "high"],
          default_effort: "high",
        },
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      models: [{ id: "composer-2", label: "Composer 2", efforts: [] }],
    },
  ];
  const engines = cloudPickerEngines({ live, plan: [], locks: {} });
  // Only the agents Cloud runs, and only where that computer listed something.
  expect(engines.map((e) => e.id)).toEqual(["caveman", "claude-agent", "codex"]);
  expect(engines[1]!.models).toEqual(live[0]!.models);
  expect(engines[2]!.models.map((m) => m.id)).toEqual([AGENT_DEFAULT]);
});

test("what cannot be picked yet is still listed, with why and the way to it", () => {
  const lock = {
    title: "Connect your Claude plan to use Claude Agent in Cloud.",
    action: { label: "Connect Claude", run: () => undefined },
  };
  const engines = cloudPickerEngines({
    live: [],
    plan: planModels(answer),
    locks: { "claude-agent": lock },
  });
  expect(engines.find((e) => e.id === "claude-agent")).toMatchObject({
    locked: lock,
    models: [{ id: AGENT_DEFAULT }],
  });
  expect(engines.find((e) => e.id === "caveman")?.locked).toBeUndefined();
});

test("a start names a model only when the person picked one: the agent's own pick is the computer's to make", () => {
  expect(startModel(null)).toBeUndefined();
  expect(startModel(AUTO_MODEL)).toBeUndefined();
  expect(startModel(AGENT_DEFAULT)).toBeUndefined();
  expect(startModel("caveman/moonshotai/kimi-k3")).toBe("caveman/moonshotai/kimi-k3");
});

test("with nothing picked the box shows what the chat will start on: a Cloud computer's own default, else the first listed", () => {
  const live = [
    {
      id: "claude-agent",
      label: "Claude Agent",
      default_model: "sonnet",
      models: [
        { id: "opus", label: "Opus", efforts: [] },
        { id: "sonnet", label: "Sonnet", efforts: [] },
      ],
    },
  ];
  const engines = cloudPickerEngines({ live, plan: [], locks: {} });
  // Its default, not the first it lists.
  expect(shownModel(engines, "claude-agent", live)).toBe("sonnet");
  // A default the list does not have, or no word on one: the first listed.
  expect(shownModel(engines, "claude-agent", [{ ...live[0]!, default_model: "gone" }])).toBe(
    "opus",
  );
  expect(shownModel(engines, "claude-agent")).toBe("opus");
  expect(shownModel(engines, "nobody")).toBeNull();
});
