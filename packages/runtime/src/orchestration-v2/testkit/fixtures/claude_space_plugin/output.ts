import type { ProviderReplayTranscript } from "@caveman-app/protocol";
import { assert } from "@effect/vitest";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_SPACE_PLUGIN_MARKER, CLAUDE_SPACE_PLUGIN_PROMPT } from "./input.ts";

/** The live CLI loaded the Space plugin for this session and ran its command. */
export function assertClaudeSpacePluginOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_SPACE_PLUGIN_PROMPT]);
  assertAssistantTextIncludes(projection, CLAUDE_SPACE_PLUGIN_MARKER);

  const init = transcript.entries.find(
    (entry) =>
      entry.type === "emit_inbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      Reflect.get(entry.frame, "subtype") === "init",
  );
  const frame = init?.type === "emit_inbound" ? (init.frame as Record<string, unknown>) : {};
  const plugins = (frame["plugins"] ?? []) as ReadonlyArray<{ readonly name?: string }>;
  assert.include(
    plugins.map((plugin) => plugin.name),
    "caveman-space-fixture",
  );
  assert.include(frame["slash_commands"] as ReadonlyArray<string>, "caveman-space-fixture:space-ping");
}
