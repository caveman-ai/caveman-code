import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { holdPlaces, localAgents, modelsLine, placesOf } from "./local-agents.ts";

const engine = (id: string, state: EngineDescriptor["auth"]["state"], accounts = 0) =>
  ({
    id,
    label: id,
    auth: {
      state,
      accounts: Array.from({ length: accounts }, (_, i) => ({
        id: `${id}:${i}`,
        label: id,
        kind: "login",
        active: i === 0,
      })),
    },
  }) as unknown as EngineDescriptor;
const ids = (list: ReadonlyArray<EngineDescriptor>) => list.map((e) => e.id);

describe("the agents on this computer", () => {
  const engines = [
    engine("cursor", "signed_out"),
    engine("claude-agent", "signed_out"),
    engine("codex", "signed_in", 1),
    engine("opencode", "signed_in", 1),
    engine("pi", "signed_out"),
    engine("muse", "signed_out"),
    engine("grok", "unavailable"),
  ];

  test("before a scan: the ready ones first, Claude Agent signed out after them, unconnected harnesses to set up", () => {
    const { here, rest } = localAgents(engines, null);
    expect(ids(here)).toEqual(["codex", "opencode", "claude-agent"]);
    expect(ids(rest)).toEqual(["cursor", "pi", "muse", "grok"]);
  });

  test("after a scan: a harness found signed out joins, one not found stays folded away", () => {
    const found = new Map([
      ["cursor", "signed_out"],
      ["pi", "not_found"],
      ["muse", "not_found"],
    ] as const);
    const { here, rest } = localAgents(engines, found);
    expect(ids(here)).toEqual(["codex", "opencode", "cursor", "claude-agent"]);
    expect(ids(rest)).toEqual(["pi", "muse", "grok"]);
  });

  test("an uninstalled Claude Agent or Codex is not here", () => {
    const { here } = localAgents(
      [engine("claude-agent", "unavailable"), engine("codex", "unavailable")],
      null,
    );
    expect(here).toEqual([]);
  });
});

describe("agents keep their place while the page is open", () => {
  test("connecting one from More agents keeps it there, its row in front of the person", () => {
    const before = [
      engine("codex", "signed_in", 1),
      engine("antigravity", "signed_out"),
      engine("pi", "signed_out"),
    ];
    const places = placesOf(localAgents(before, null));
    expect(places).toEqual({ here: ["codex"], rest: ["antigravity", "pi"] });
    const after = [
      engine("codex", "signed_in", 1),
      engine("antigravity", "signed_out", 1),
      engine("pi", "signed_out"),
    ];
    const held = holdPlaces(localAgents(after, null), places);
    expect(ids(held.here)).toEqual(["codex"]);
    expect(ids(held.rest)).toEqual(["antigravity", "pi"]);
  });

  test("signing one in does not move it above the others", () => {
    const before = [engine("codex", "signed_in", 1), engine("claude-agent", "signed_out")];
    const places = placesOf(localAgents(before, null));
    const after = [engine("codex", "signed_in", 1), engine("claude-agent", "signed_in", 1)];
    expect(ids(holdPlaces(localAgents(after, null), places).here)).toEqual([
      "codex",
      "claude-agent",
    ]);
  });

  test("an agent the page never placed goes where it sorts, after the held ones", () => {
    const places = { here: ["codex"], rest: ["pi"] };
    const now = [
      engine("codex", "signed_in", 1),
      engine("pi", "signed_out"),
      engine("opencode", "signed_in", 1),
      engine("muse", "signed_out"),
    ];
    const held = holdPlaces(localAgents(now, null), places);
    expect(ids(held.here)).toEqual(["codex", "opencode"]);
    expect(ids(held.rest)).toEqual(["pi", "muse"]);
  });
});

describe("the Models row", () => {
  const model = (label: string, legacy = false) => ({
    id: label,
    label,
    efforts: [],
    ...(legacy ? { legacy: true } : {}),
  });

  test("a short list is spelled out", () => {
    expect(modelsLine([model("GPT-5.5"), model("GPT-6 Sol")])).toBe("GPT-5.5, GPT-6 Sol");
  });

  test("hundreds of models (Pi) read as a few names and a count", () => {
    const many = Array.from({ length: 400 }, (_, i) => model(`Model ${i}`));
    expect(modelsLine(many)).toBe(
      "Model 0, Model 1, Model 2, Model 3, Model 4, Model 5 and 394 more in the picker",
    );
  });

  test("older models count toward the rest, never named", () => {
    expect(modelsLine([model("Opus 5.5"), model("Opus 4", true)])).toBe(
      "Opus 5.5 and 1 more in the picker",
    );
    expect(modelsLine([model("Opus 4", true)])).toBe("1 in the picker");
  });
});
