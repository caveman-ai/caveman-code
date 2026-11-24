// A Muse turn reports its running usage after every model call. Replayed from the recorded `subagent_v2` Muse session
// through the real Muse adapter and OrchestratorV2, then through the projector as daemon.ts projectOne feeds it: the
// Session Protocol's usage for the turn is all of it, not its first call's.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import { checkpointWorkspace } from "@caveman-app/engine-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Effect from "effect/Effect";

import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../orchestration-v2/Adapters/MuseAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../orchestration-v2/testkit/DeterministicRuntime.ts";
import {
  materializeFixtureInput,
  MUSE_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import { subagentV2Input } from "../orchestration-v2/testkit/fixtures/subagent_v2/input.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { emptyThreadState, projectEvent } from "./projector.ts";

describe("a Muse turn's usage", () => {
  it.effect("a recorded four-call Muse turn records the whole turn's tokens, once", () =>
    Effect.gen(function* () {
      const recorded = yield* readProviderReplayTranscript(
        new URL(
          "../orchestration-v2/testkit/fixtures/subagent_v2/muse_transcript.ndjson",
          import.meta.url,
        ),
      ).pipe(Effect.provide(NodeServices.layer));
      const replay = materializeReplayTranscriptRuntimeInstructions(recorded, {
        driver: "muse" as never,
        model: MUSE_MODEL_SELECTION.model,
      });
      const fixtureInput = subagentV2Input();
      const workspace = yield* checkpointWorkspace("subagent_v2", fixtureInput.workspaceFiles);
      const transcript = yield* MuseOrchestratorReplayHarness.decodeTranscript(
        yield* materializeMuseReplayWorkspace(replay, workspace),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "subagent_v2",
        fixtureInput,
        driver: "muse" as never,
        modelSelection: MUSE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "subagent_v2/muse",
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd: workspace },
        },
        MuseOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);

      const state = emptyThreadState();
      const usage = (result.domainEvents as ReadonlyArray<OrchestrationV2DomainEvent>).flatMap(
        (event) =>
          projectEvent(state, event, {
            at: "2026-11-06T00:00:00.000Z",
            displayText: () => undefined,
          }).events.filter((e) => e.type === "usage"),
      );
      // Four calls of 32,900 + 33,144 + 33,360 + 33,545 input tokens, 98,899 of them cache reads, and 370 output tokens.
      assert.deepStrictEqual(
        usage.map((e) => {
          const { input_tokens, cache_read_tokens, output_tokens } = e.payload as Record<
            string,
            number
          >;
          return { input_tokens, cache_read_tokens, output_tokens };
        }),
        [{ input_tokens: 132949 - 98899, cache_read_tokens: 98899, output_tokens: 370 }],
      );
    }).pipe(Effect.scoped),
  );
});
