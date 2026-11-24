import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { instanceOf, loginEngines, runnerFor, sectionOf } from "./runner.ts";

const engine = (id: string, accounts: Array<{ id: string; tag?: string; active: boolean }>, models = ["m1"]) =>
  ({ id, label: id, models: models.map((m) => ({ id: m, label: m.toUpperCase(), efforts: ["low", "high"] })), auth: { state: "signed_in", accounts: accounts.map((a) => ({ ...a, label: a.id, kind: "login" })) } }) as unknown as EngineDescriptor;
const engines = [engine("claude-agent", [{ id: "a1", tag: "WRK", active: true }, { id: "a2", tag: "PER", active: false }], ["opus", "sonnet"]), engine("codex", [{ id: "k1", tag: "OA", active: true }])];

test("a runner names its harness, login tag, model label and how it was picked", () => {
  const r = runnerFor(engines, { engine: "claude-agent", runner: { engine: "claude-agent", instance_id: "a2", model: "opus", effort: "high", pick: { by: "auto", kind: "review", options: 9 } } });
  expect(r).toMatchObject({ engine: "claude-agent", tag: "PER", modelLabel: "OPUS", effort: "high", pick: { by: "auto", kind: "review", options: 9 } });
  // Without a runner: the engine, its one login's tag and the latest turn's model.
  expect(runnerFor(engines, { engine: "codex", model: "m1" })).toMatchObject({ engine: "codex", tag: "OA", modelLabel: "M1", pick: undefined });
  // Several logins and no runner: no tag rather than a guess.
  expect(runnerFor(engines, { engine: "claude-agent" }).tag).toBeUndefined();
});

test("each login of a harness is its own picker section under its name, and a pin finds its way back", () => {
  const sections = loginEngines(engines);
  expect(sections.map((s) => [s.id, s.harness, s.account])).toEqual([
    ["claude-agent#a1", "claude-agent", "a1"],
    ["claude-agent#a2", "claude-agent", "a2"],
    ["codex", undefined, undefined],
  ]);
  expect(instanceOf(engines, "claude-agent#a2")).toEqual({ engine: "claude-agent", instance_id: "a2" });
  expect(instanceOf(engines, "codex")).toEqual({ engine: "codex", instance_id: "k1" });
  expect(sectionOf(engines, { engine: "claude-agent", instance_id: "a2" })).toBe("claude-agent#a2");
  expect(sectionOf(engines, { engine: "codex", instance_id: "k1" })).toBe("codex");
});

test("a pin's picker drops Caveman's own Auto; each login lists its harness's models", () => {
  const caveman = engine("caveman", [{ id: "k", tag: "OA", active: true }], ["auto", "openai/gpt-6"]);
  const sections = loginEngines([caveman, engines[0]!]);
  expect(sections[0]!.models.map((m) => m.id)).toEqual(["openai/gpt-6"]);
  expect(sections.slice(1).map((s) => s.models.map((m) => m.id))).toEqual([["opus", "sonnet"], ["opus", "sonnet"]]);
});

test("a Caveman chat or pin with several keys finds its one Caveman section, so its model shows", () => {
  // Caveman credits and an OpenAI key: two accounts, still one picker section (loginEngines, chatPickerEngines).
  const caveman = engine("caveman", [{ id: "caveman:caveman", tag: "CC", active: true }, { id: "caveman:openai", tag: "OA", active: false }], ["auto", "openai/gpt-6", "caveman/deepseek/deepseek-v4-pro"]);
  const all = [caveman, ...engines];
  expect(loginEngines(all).filter((s) => (s.harness ?? s.id) === "caveman").map((s) => s.id)).toEqual(["caveman"]);
  expect(sectionOf(all, { engine: "caveman", instance_id: "caveman:openai" })).toBe("caveman");
});

test("a connection is never a login to pick: sections, pins and the picked section read this computer's own logins", () => {
  const withWhere = (id: string, accounts: Array<{ id: string; active: boolean; where?: "everywhere" | "cloud" | "this_mac" }>) =>
    ({ id, label: id, models: [{ id: "m1", label: "M1", efforts: [] }], auth: { state: "signed_in", accounts: accounts.map((a) => ({ ...a, label: a.id, kind: "login" })) } }) as unknown as EngineDescriptor;
  // A Claude plan connected once, then the Mac's own login: one section, as an engine with one login has.
  const one = [withWhere("claude-agent", [{ id: "connection:c1", active: true, where: "everywhere" }, { id: "claudeAgent:default", active: false, where: "this_mac" }])];
  expect(loginEngines(one).map((s) => s.id)).toEqual(["claude-agent"]);
  expect(sectionOf(one, { engine: "claude-agent", instance_id: "claudeAgent:default" })).toBe("claude-agent");
  // A pin names the Mac's own login, never the connection that is active.
  expect(instanceOf(one, "claude-agent")).toEqual({ engine: "claude-agent", instance_id: "claudeAgent:default" });
  // Two logins of this Mac's own beside two connections: a section per own login, none per connection.
  const two = [
    withWhere("claude-agent", [
      { id: "connection:c1", active: true, where: "everywhere" },
      { id: "connection:c2", active: false, where: "cloud" },
      { id: "claudeAgent:default", active: false, where: "this_mac" },
      { id: "claudeAgent-account-1", active: false },
    ]),
  ];
  expect(loginEngines(two).map((s) => s.id)).toEqual(["claude-agent#claudeAgent:default", "claude-agent#claudeAgent-account-1"]);
  expect(sectionOf(two, { engine: "claude-agent", instance_id: "claudeAgent-account-1" })).toBe("claude-agent#claudeAgent-account-1");
  // An engine that runs on connections alone still answers a pin with the account that runs it.
  const only = [withWhere("codex", [{ id: "connection:c3", active: true, where: "everywhere" }])];
  expect(loginEngines(only).map((s) => s.id)).toEqual(["codex"]);
  expect(instanceOf(only, "codex")).toEqual({ engine: "codex", instance_id: "connection:c3" });
});
