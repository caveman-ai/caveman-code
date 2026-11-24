// Pi replay fixtures, ),
// apps/server/src/orchestration-v2/testkit/fixtures/index.ts @ 13aa882c22.
// index.ts merges these: whole scenarios, and variants of shared scenarios by name.
import { ProviderDriverKind } from "@caveman-app/protocol";

import { assertPiMessageSteeringOutput } from "./message_steering/pi_output.ts";
import { assertPiMultiTurnOutput } from "./multi_turn/pi_output.ts";
import { piCompactionInput } from "./pi_compaction/input.ts";
import { assertPiCompactionOutput } from "./pi_compaction/output.ts";
import { providerThreadResumeInput } from "./provider_thread_resume/input.ts";
import { assertPiProviderThreadResumeOutput } from "./provider_thread_resume/pi_output.ts";
import { PI_MODEL_SELECTION } from "./shared.ts";
import { assertPiSimpleOutput } from "./simple/pi_output.ts";
import { assertPiThreadRollbackOutput } from "./thread_rollback/pi_output.ts";
import { threadRollbackAfterStopInput } from "./thread_rollback_after_stop/input.ts";
import { assertPiThreadRollbackAfterStopOutput } from "./thread_rollback_after_stop/pi_output.ts";
import { assertTurnInterruptMidToolPiOutput } from "./turn_interrupt_mid_tool/pi_output.ts";
import type { OrchestratorReplayFixture } from "./shared.ts";

export const PI_REPLAY_SCENARIOS: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "pi_compaction",
    buildInput: piCompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./pi_compaction/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiCompactionOutput,
      },
    ],
  },
  {
    name: "provider_thread_resume",
    buildInput: providerThreadResumeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL("./provider_thread_resume/pi_transcript.ndjson", import.meta.url),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiProviderThreadResumeOutput,
      },
    ],
  },
  {
    name: "thread_rollback_after_stop",
    buildInput: threadRollbackAfterStopInput,
    providers: [
      {
        driver: ProviderDriverKind.make("pi"),
        transcriptFile: new URL(
          "./thread_rollback_after_stop/pi_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: PI_MODEL_SELECTION,
        assertOutput: assertPiThreadRollbackAfterStopOutput,
      },
    ],
  },
];

export const PI_REPLAY_VARIANTS: Readonly<Record<string, ReadonlyArray<OrchestratorReplayFixture["providers"][number]>>> = {
  simple: [
    {
      driver: ProviderDriverKind.make("pi"),
      transcriptFile: new URL("./simple/pi_transcript.ndjson", import.meta.url),
      modelSelection: PI_MODEL_SELECTION,
      assertOutput: assertPiSimpleOutput,
    },
  ],
  multi_turn: [
    {
      driver: ProviderDriverKind.make("pi"),
      transcriptFile: new URL("./multi_turn/pi_transcript.ndjson", import.meta.url),
      modelSelection: PI_MODEL_SELECTION,
      assertOutput: assertPiMultiTurnOutput,
    },
  ],
  message_steering: [
    {
      driver: ProviderDriverKind.make("pi"),
      transcriptFile: new URL("./message_steering/pi_transcript.ndjson", import.meta.url),
      modelSelection: PI_MODEL_SELECTION,
      assertOutput: assertPiMessageSteeringOutput,
    },
  ],
  turn_interrupt_mid_tool: [
    {
      driver: ProviderDriverKind.make("pi"),
      transcriptFile: new URL("./turn_interrupt_mid_tool/pi_transcript.ndjson", import.meta.url),
      modelSelection: PI_MODEL_SELECTION,
      assertOutput: assertTurnInterruptMidToolPiOutput,
    },
  ],
  thread_rollback: [
    {
      driver: ProviderDriverKind.make("pi"),
      transcriptFile: new URL("./thread_rollback/pi_transcript.ndjson", import.meta.url),
      modelSelection: PI_MODEL_SELECTION,
      assertOutput: assertPiThreadRollbackOutput,
    },
  ],
};
