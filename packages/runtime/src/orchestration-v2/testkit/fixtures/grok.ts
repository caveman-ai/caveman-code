// Grok replay fixtures, ),
// apps/server/src/orchestration-v2/testkit/fixtures/index.ts @ 13aa882c22.
// index.ts merges these: whole scenarios, and variants of shared scenarios by name.
import { ProviderDriverKind } from "@caveman-app/protocol";

import { grokAutoBlockedCommandInput } from "./grok_auto_blocked_command/input.ts";
import { assertGrokAutoBlockedCommandOutput } from "./grok_auto_blocked_command/output.ts";
import { grokBackgroundBashInput } from "./grok_background_bash/input.ts";
import { assertGrokBackgroundBashOutput } from "./grok_background_bash/output.ts";
import { grokBackgroundBashFastWakeInput } from "./grok_background_bash_fast_wake/input.ts";
import { assertGrokBackgroundBashFastWakeOutput } from "./grok_background_bash_fast_wake/output.ts";
import { grokBackgroundSubagentInput } from "./grok_background_subagent/input.ts";
import { assertGrokBackgroundSubagentOutput } from "./grok_background_subagent/output.ts";
import { grokMonitorInput } from "./grok_monitor/input.ts";
import { assertGrokMonitorOutput } from "./grok_monitor/output.ts";
import { grokPromptErrorInput } from "./grok_prompt_error/input.ts";
import { assertGrokPromptErrorOutput } from "./grok_prompt_error/output.ts";
import { grokSubagentLineageInput } from "./grok_subagent_lineage/input.ts";
import { assertGrokSubagentLineageOutput } from "./grok_subagent_lineage/output.ts";
import { assertGrokMessageSteeringOutput } from "./message_steering/grok_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { GROK_MODEL_SELECTION, READ_ONLY_NEVER_POLICY, READ_ONLY_ON_REQUEST_POLICY, WORKSPACE_NEVER_POLICY } from "./shared.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { assertTodoListGrokOutput } from "./todo_list/grok_output.ts";
import { assertToolCallReadOnlyCursorOutput } from "./tool_call_read_only/cursor_output.ts";
import { assertToolCallReadOnlyOnRequestGrokOutput } from "./tool_call_read_only_on_request/output.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import type { OrchestratorReplayFixture } from "./shared.ts";

export const GROK_REPLAY_SCENARIOS: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "grok_auto_blocked_command",
    buildInput: grokAutoBlockedCommandInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_auto_blocked_command/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        assertOutput: assertGrokAutoBlockedCommandOutput,
      },
    ],
  },
  {
    name: "grok_background_bash",
    buildInput: grokBackgroundBashInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_background_bash/grok_transcript.ndjson", import.meta.url),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundBashOutput,
      },
    ],
  },
  {
    name: "grok_background_bash_fast_wake",
    buildInput: grokBackgroundBashFastWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_background_bash_fast_wake/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: { ...GROK_MODEL_SELECTION, model: "grok-4.7-build-fast" },
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundBashFastWakeOutput,
      },
    ],
  },
  {
    name: "grok_background_subagent",
    buildInput: grokBackgroundSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL(
          "./grok_background_subagent/grok_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: GROK_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertGrokBackgroundSubagentOutput,
      },
    ],
  },
  {
    name: "grok_monitor",
    buildInput: grokMonitorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_monitor/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertGrokMonitorOutput,
      },
    ],
  },
  {
    name: "grok_prompt_error",
    buildInput: grokPromptErrorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_prompt_error/grok_transcript.ndjson", import.meta.url),
        modelSelection: GROK_MODEL_SELECTION,
        assertOutput: assertGrokPromptErrorOutput,
      },
    ],
  },
  {
    name: "grok_subagent_lineage",
    buildInput: grokSubagentLineageInput,
    providers: [
      {
        driver: ProviderDriverKind.make("grok"),
        transcriptFile: new URL("./grok_subagent_lineage/grok_transcript.ndjson", import.meta.url),
        modelSelection: {
          ...GROK_MODEL_SELECTION,
          model: "grok-composer-2.5-fast",
        },
        assertOutput: assertGrokSubagentLineageOutput,
      },
    ],
  },
];

export const GROK_REPLAY_VARIANTS: Readonly<Record<string, ReadonlyArray<OrchestratorReplayFixture["providers"][number]>>> = {
  simple: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./simple/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      assertOutput: assertSimpleOutput,
    },
  ],
  tool_call_read_only: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./tool_call_read_only/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
      assertOutput: assertToolCallReadOnlyCursorOutput,
    },
  ],
  tool_call_read_only_on_request: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL(
        "./tool_call_read_only_on_request/grok_transcript.ndjson",
        import.meta.url,
      ),
      modelSelection: GROK_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
      assertOutput: assertToolCallReadOnlyOnRequestGrokOutput,
    },
  ],
  multi_turn: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./multi_turn/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      assertOutput: assertMultiTurnOutput,
    },
  ],
  queued_turn: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./queued_turn/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      assertOutput: assertQueuedTurnOutput,
    },
  ],
  todo_list: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./todo_list/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      assertOutput: assertTodoListGrokOutput,
    },
  ],
  message_steering: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./message_steering/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      assertOutput: assertGrokMessageSteeringOutput,
    },
  ],
  turn_interrupt: [
    {
      driver: ProviderDriverKind.make("grok"),
      transcriptFile: new URL("./turn_interrupt/grok_transcript.ndjson", import.meta.url),
      modelSelection: GROK_MODEL_SELECTION,
      runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
      assertOutput: assertTurnInterruptOutput,
    },
  ],
};
