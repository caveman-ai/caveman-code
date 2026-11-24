import type { EngineDescriptor, Project, Settings } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../panes/drag.ts", () => ({}));
const { turnModel, useTurnChoice } = await import("./Composer.tsx");

const auto = { id: "caveman-auto", label: "Auto", efforts: [] };
const opus = { id: "opus", label: "Opus 5.5", efforts: ["low", "high"], default_effort: "high" };
const sonnet = { id: "sonnet", label: "Sonnet 5", efforts: [] };
const old = { id: "haiku-3", label: "Haiku 3", efforts: [], legacy: true };
const claude = (models = [auto, opus, sonnet], default_model: string | undefined = "caveman-auto") =>
  ({
    id: "claude-agent",
    label: "Claude Agent",
    models,
    ...(default_model ? { default_model } : {}),
    capabilities: {},
    auth: { state: "signed_in", accounts: [] },
  }) as unknown as EngineDescriptor;

test("a turn's model: the pick, the chat's own, the project's, the setting, then the runtime's default_model", () => {
  const engine = claude();
  expect(turnModel(engine, {})?.id).toBe("caveman-auto");
  expect(turnModel(engine, { setting: "sonnet" })?.id).toBe("sonnet");
  expect(turnModel(engine, { project: "opus", setting: "sonnet" })?.id).toBe("opus");
  expect(turnModel(engine, { chat: "sonnet", project: "opus" })?.id).toBe("sonnet");
  expect(turnModel(engine, { picked: "opus", chat: "sonnet" })?.id).toBe("opus");
});

test("a saved Auto while Auto is not offered gives way to the engine's default, never to the setting under it", () => {
  const signedOut = claude([opus, sonnet], "sonnet");
  expect(turnModel(signedOut, { setting: "caveman-auto" })?.id).toBe("sonnet");
  expect(turnModel(signedOut, { project: "caveman-auto", setting: "opus" })?.id).toBe("sonnet");
  // An older runtime names no default: the first model that is not legacy.
  expect(turnModel(claude([old, opus], undefined), {})?.id).toBe("opus");
});

/** useTurnChoice's answer, from a runtime with these settings and projects; `call` stands in for the client. */
function choiceFor(scope: Parameters<typeof useTurnChoice>[1], runtime: { settings?: Partial<Settings>; projects?: Project[]; engine?: EngineDescriptor }, call = vi.fn()) {
  let choice: ReturnType<typeof useTurnChoice> | null = null;
  const Grab = () => {
    choice = useTurnChoice("claude-agent", scope);
    return null;
  };
  const value = {
    client: { call },
    engines: [runtime.engine ?? claude()],
    settings: { engines: {}, ...runtime.settings },
    projects: runtime.projects ?? [],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  renderToStaticMarkup(createElement(RuntimeContext.Provider, { value }, createElement(Grab)));
  return choice!;
}

test("a new chat starts on Auto, or on what Settings or its project says, never on the chat on screen", () => {
  expect(choiceFor({}, {}).model?.id).toBe("caveman-auto");
  expect(choiceFor({}, { settings: { engines: { "claude-agent": { model: "sonnet" } } } }).model?.id).toBe("sonnet");
  const project = { id: "p1", default_models: { "claude-agent": "opus" } } as unknown as Project;
  const inProject = choiceFor({ projectId: "p1" }, { settings: { engines: { "claude-agent": { model: "sonnet" } } }, projects: [project] });
  expect(inProject.model?.id).toBe("opus");
  expect(inProject.effort).toBe("high");
  // An open chat shows its own model and effort.
  const open = choiceFor({ model: "opus", effort: "low" }, {});
  expect([open.model?.id, open.effort]).toEqual(["opus", "low"]);
});

test("only what the person picked is sent: a default shown is the runtime's to decide", () => {
  // A new chat, and an open chat whose model the box does not know yet (before its first turn, on reopen).
  expect(choiceFor({}, {}).options).toEqual({});
  expect(choiceFor({}, { settings: { engines: { "claude-agent": { model: "opus", effort: "low" } } } }).options).toEqual({});
  expect(choiceFor({ model: "opus", effort: "low" }, {}).options).toEqual({});
  // A picked model goes with the effort shown for it; an effort alone changes the chat's own model's.
  expect(choiceFor({ picked: { model: "opus" } }, {}).options).toEqual({ model: "opus", effort: "high" });
  expect(choiceFor({ model: "opus", picked: { effort: "low" } }, {}).options).toEqual({ effort: "low" });
  expect(choiceFor({ picked: { access: "ask" } }, {}).options).toEqual({ access: "ask" });
});

test("a project where Auto can't run shows the default it starts on there, over a configured Auto", () => {
  const bedrock = { id: "p1", engine_default_models: { "claude-agent": "sonnet" } } as unknown as Project;
  expect(choiceFor({ projectId: "p1" }, { projects: [bedrock] }).model?.id).toBe("sonnet");
  expect(choiceFor({ projectId: "p1" }, { projects: [bedrock], settings: { engines: { "claude-agent": { model: "caveman-auto" } } } }).model?.id).toBe("sonnet");
  // A model the person set is theirs.
  expect(choiceFor({ projectId: "p1" }, { projects: [bedrock], settings: { engines: { "claude-agent": { model: "opus" } } } }).model?.id).toBe("opus");
  expect(turnModel(claude(), { here: "sonnet", picked: "caveman-auto" })?.id).toBe("caveman-auto");
});

test("a saved effort shows only on the model it was saved with", () => {
  const saved = { settings: { engines: { "claude-agent": { model: "opus", effort: "low" } } } };
  expect(choiceFor({}, saved).effort).toBe("low");
  const project = { id: "p1", default_models: { "claude-agent": "sonnet" } } as unknown as Project;
  const opusProject = { id: "p2", default_models: { "claude-agent": "opus" } } as unknown as Project;
  expect(choiceFor({ projectId: "p2" }, { ...saved, projects: [project, opusProject] }).effort).toBe("low");
  const other = { settings: { engines: { "claude-agent": { model: "sonnet", effort: "low" } } }, projects: [opusProject] };
  expect(choiceFor({ projectId: "p2" }, other).effort).toBe("high");
});

test("a picked harness supplies its own model and effort, not the previous turn's, and travels in TurnOptions", () => {
  const codex = { ...claude([{ id: "target", label: "Target", efforts: ["low", "high"], default_effort: "high" }], "target"), id: "codex" } as EngineDescriptor;
  const switched = choiceFor({ model: "opus", effort: "low", picked: { engine: "codex", model: "target", account_id: "codex-login" } }, { engine: codex });
  expect(switched.engine?.id).toBe("codex");
  expect(switched.effort).toBe("high");
  expect(switched.options).toEqual({ engine: "codex", model: "target", effort: "high", account_id: "codex-login" });
  expect(choiceFor({ model: "opus", picked: { engine: "codex" } }, { engine: codex }).model?.id).toBe("target");
});

test("a pick in the composer applies to that chat only: nothing is saved", () => {
  const call = vi.fn(async () => ({}));
  const choice = choiceFor({}, {}, call);
  choice.choose({ model: "opus", effort: "low" });
  expect(call).not.toHaveBeenCalled();
});
