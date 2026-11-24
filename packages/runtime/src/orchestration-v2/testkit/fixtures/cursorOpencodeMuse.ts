// Harness replays (provider-cursor, provider-opencode, provider-muse): upstream (MIT) recorded
// transcripts for fixtures we share, from apps/server/src/orchestration-v2/testkit/fixtures/index.ts
// @ 13aa882c22. index.ts merges these: whole scenarios, and variants of shared scenarios by name.
import { ProviderDriverKind } from "@caveman-app/protocol";

import { assertCursorMessageSteeringOutput } from "./message_steering/cursor_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { assertMuseMultiTurnOutput } from "./multi_turn/muse_output.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { CURSOR_MODEL_SELECTION, MUSE_MODEL_SELECTION, OPENCODE2_MODEL_SELECTION, OPENCODE_MODEL_SELECTION, READ_ONLY_NEVER_POLICY, WORKSPACE_NEVER_POLICY, type OrchestratorReplayFixture, type ProviderOrchestratorReplayVariant } from "./shared.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { assertCursorSubagentOutput } from "./subagent/cursor_output.ts";
import { assertMuseSubagentV2Output } from "./subagent_v2/muse_output.ts";
import { assertTodoListCursorOutput } from "./todo_list/cursor_output.ts";
import { assertToolCallReadOnlyCursorOutput } from "./tool_call_read_only/cursor_output.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { assertMuseTurnInterruptOutput } from "./turn_interrupt/muse_output.ts";
import { assertTurnInterruptMidToolCursorOutput } from "./turn_interrupt_mid_tool/cursor_output.ts";

import { MUSE_PERMISSION_DECLINED_FILE, musePermissionInput } from "./muse_permission/input.ts";
import { assertMusePermissionOutput } from "./muse_permission/output.ts";
import { museSubagentApprovalInput } from "./muse_subagent_approval/input.ts";
import { assertMuseSubagentApprovalOutput } from "./muse_subagent_approval/output.ts";
import { museSubagentInterruptInput } from "./muse_subagent_interrupt/input.ts";
import { assertMuseSubagentInterruptOutput } from "./muse_subagent_interrupt/output.ts";
import { museWorkflowInput } from "./muse_workflow/input.ts";
import { assertMuseWorkflowOutput } from "./muse_workflow/output.ts";
import { openCode2BackgroundInput } from "./opencode2_background/input.ts";
import { assertOpenCode2BackgroundOutput } from "./opencode2_background/output.ts";
import { openCode2CommandInput } from "./opencode2_command/input.ts";
import { assertOpenCode2CommandOutput } from "./opencode2_command/output.ts";
import { openCode2CompactionInput } from "./opencode2_compaction/input.ts";
import { assertOpenCode2CompactionOutput } from "./opencode2_compaction/output.ts";
import { openCode2InboxInput } from "./opencode2_inbox/input.ts";
import { assertOpenCode2InboxOutput } from "./opencode2_inbox/output.ts";
import { openCode2InterruptInput } from "./opencode2_interrupt/input.ts";
import { assertOpenCode2InterruptOutput } from "./opencode2_interrupt/output.ts";
import { openCode2NestedBackgroundInput } from "./opencode2_nested_background/input.ts";
import { assertOpenCode2NestedBackgroundOutput } from "./opencode2_nested_background/output.ts";
import { openCode2PermissionInput } from "./opencode2_permission/input.ts";
import { assertOpenCode2PermissionOutput } from "./opencode2_permission/output.ts";
import { openCode2QuestionInput } from "./opencode2_question/input.ts";
import { assertOpenCode2QuestionOutput } from "./opencode2_question/output.ts";
import { openCode2ResumeAfterRestartInput } from "./opencode2_resume_after_restart/input.ts";
import { assertOpenCode2ResumeAfterRestartOutput } from "./opencode2_resume_after_restart/output.ts";
import { openCode2RevertInput } from "./opencode2_revert/input.ts";
import { assertOpenCode2RevertOutput } from "./opencode2_revert/output.ts";
import { openCode2SimpleInput } from "./opencode2_simple/input.ts";
import { assertOpenCode2SimpleOutput } from "./opencode2_simple/output.ts";
import { openCode2SkillInput } from "./opencode2_skill/input.ts";
import { assertOpenCode2SkillOutput } from "./opencode2_skill/output.ts";
import { openCode2SubagentInput } from "./opencode2_subagent/input.ts";
import { assertOpenCode2SubagentOutput } from "./opencode2_subagent/output.ts";
import { openCode2ToolCallInput } from "./opencode2_tool_call/input.ts";
import { assertOpenCode2ToolCallOutput } from "./opencode2_tool_call/output.ts";
import { openCodeChildApprovalInput } from "./opencode_child_approval/input.ts";
import { assertOpenCodeChildApprovalOutput } from "./opencode_child_approval/output.ts";
import { openCodeRunningChildApprovalInput } from "./opencode_running_child_approval/input.ts";
import { assertOpenCodeRunningChildApprovalOutput } from "./opencode_running_child_approval/output.ts";
import { openCodeSubagentInput } from "./opencode_subagent/input.ts";
import { assertOpenCodeSubagentOutput } from "./opencode_subagent/output.ts";

export const CURSOR_OPENCODE_MUSE_REPLAY_VARIANTS: Readonly<Record<string, ReadonlyArray<ProviderOrchestratorReplayVariant>>> = {
  simple: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./simple/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      assertOutput: assertSimpleOutput,
    },
    {
      driver: ProviderDriverKind.make("opencode"),
      transcriptFile: new URL("./simple/opencode_transcript.ndjson", import.meta.url),
      modelSelection: OPENCODE_MODEL_SELECTION,
      assertOutput: assertSimpleOutput,
    },
    {
      driver: ProviderDriverKind.make("muse"),
      transcriptFile: new URL("./simple/muse_transcript.ndjson", import.meta.url),
      modelSelection: MUSE_MODEL_SELECTION,
      assertOutput: assertSimpleOutput,
    },
  ],
  tool_call_read_only: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./tool_call_read_only/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
      assertOutput: assertToolCallReadOnlyCursorOutput,
    },
  ],
  subagent: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./subagent/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
      assertOutput: assertCursorSubagentOutput,
    },
  ],
  subagent_v2: [
    {
      driver: ProviderDriverKind.make("muse"),
      transcriptFile: new URL("./subagent_v2/muse_transcript.ndjson", import.meta.url),
      modelSelection: MUSE_MODEL_SELECTION,
      assertOutput: assertMuseSubagentV2Output,
    },
  ],
  multi_turn: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./multi_turn/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      assertOutput: assertMultiTurnOutput,
    },
    {
      driver: ProviderDriverKind.make("muse"),
      transcriptFile: new URL("./multi_turn/muse_transcript.ndjson", import.meta.url),
      modelSelection: MUSE_MODEL_SELECTION,
      assertOutput: assertMuseMultiTurnOutput,
    },
  ],
  queued_turn: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./queued_turn/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      assertOutput: assertQueuedTurnOutput,
    },
  ],
  todo_list: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./todo_list/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
      assertOutput: assertTodoListCursorOutput,
    },
  ],
  message_steering: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL("./message_steering/cursor_transcript.ndjson", import.meta.url),
      modelSelection: CURSOR_MODEL_SELECTION,
      assertOutput: assertCursorMessageSteeringOutput,
    },
  ],
  turn_interrupt: [
    {
      driver: ProviderDriverKind.make("opencode"),
      transcriptFile: new URL("./turn_interrupt/opencode_transcript.ndjson", import.meta.url),
      modelSelection: OPENCODE_MODEL_SELECTION,
      runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
      assertOutput: assertTurnInterruptOutput,
    },
    {
      driver: ProviderDriverKind.make("muse"),
      transcriptFile: new URL("./turn_interrupt/muse_transcript.ndjson", import.meta.url),
      modelSelection: MUSE_MODEL_SELECTION,
      assertOutput: assertMuseTurnInterruptOutput,
    },
  ],
  turn_interrupt_mid_tool: [
    {
      driver: ProviderDriverKind.make("cursor"),
      transcriptFile: new URL(
        "./turn_interrupt_mid_tool/cursor_transcript.ndjson",
        import.meta.url,
      ),
      modelSelection: CURSOR_MODEL_SELECTION,
      runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
      assertOutput: assertTurnInterruptMidToolCursorOutput,
    },
  ],
};

/** Fixtures only a harness runs: OpenCode 1.x and 2 subagents, approvals and sessions; Muse Code workflows. */
export const CURSOR_OPENCODE_MUSE_REPLAY_SCENARIOS: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "opencode_subagent",
    buildInput: openCodeSubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeSubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_simple",
    buildInput: openCode2SimpleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_simple/opencode_transcript.ndjson", import.meta.url),
        modelSelection: OPENCODE2_MODEL_SELECTION,
        assertOutput: assertOpenCode2SimpleOutput,
      },
    ],
  },
  {
    name: "opencode2_tool_call",
    buildInput: openCode2ToolCallInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_tool_call/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ToolCallOutput,
      },
    ],
  },
  {
    name: "opencode2_interrupt",
    buildInput: openCode2InterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_interrupt/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InterruptOutput,
      },
    ],
  },
  {
    name: "opencode2_inbox",
    buildInput: openCode2InboxInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_inbox/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2InboxOutput,
      },
    ],
  },
  {
    name: "opencode2_revert",
    buildInput: openCode2RevertInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_revert/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2RevertOutput,
      },
    ],
  },
  {
    name: "opencode2_permission",
    buildInput: openCode2PermissionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_permission/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2PermissionOutput,
      },
    ],
  },
  {
    name: "opencode2_question",
    buildInput: openCode2QuestionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_question/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2QuestionOutput,
      },
    ],
  },
  {
    name: "opencode2_subagent",
    buildInput: openCode2SubagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL("./opencode2_subagent/opencode_transcript.ndjson", import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2SubagentOutput,
      },
    ],
  },
  {
    name: "opencode2_background",
    buildInput: openCode2BackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        runContinuationWorker: true,
        assertOutput: assertOpenCode2BackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_nested_background",
    buildInput: openCode2NestedBackgroundInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_nested_background/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        assertOutput: assertOpenCode2NestedBackgroundOutput,
      },
    ],
  },
  {
    name: "opencode2_compaction",
    buildInput: openCode2CompactionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_compaction/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2CompactionOutput,
      },
    ],
  },
  {
    name: "opencode2_resume_after_restart",
    buildInput: openCode2ResumeAfterRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode2_resume_after_restart/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "opencode/big-pickle",
        },
        assertOutput: assertOpenCode2ResumeAfterRestartOutput,
      },
    ],
  },
  {
    name: "opencode_child_approval",
    buildInput: openCodeChildApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode_child_approval/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeChildApprovalOutput,
      },
    ],
  },
  {
    name: "opencode_running_child_approval",
    buildInput: openCodeRunningChildApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(
          "./opencode_running_child_approval/opencode_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: OPENCODE_MODEL_SELECTION,
        assertOutput: assertOpenCodeRunningChildApprovalOutput,
      },
    ],
  },
  {
    name: "muse_permission",
    buildInput: musePermissionInput,
    providers: [
      {
        driver: ProviderDriverKind.make("muse"),
        transcriptFile: new URL("./muse_permission/muse_transcript.ndjson", import.meta.url),
        modelSelection: MUSE_MODEL_SELECTION,
        expectedAbsentWorkspacePaths: [MUSE_PERMISSION_DECLINED_FILE],
        assertOutput: assertMusePermissionOutput,
      },
    ],
  },
  {
    name: "muse_subagent_approval",
    buildInput: museSubagentApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("muse"),
        transcriptFile: new URL("./muse_subagent_approval/muse_transcript.ndjson", import.meta.url),
        modelSelection: MUSE_MODEL_SELECTION,
        assertOutput: assertMuseSubagentApprovalOutput,
      },
    ],
  },
  {
    name: "muse_subagent_interrupt",
    buildInput: museSubagentInterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("muse"),
        transcriptFile: new URL(
          "./muse_subagent_interrupt/muse_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: MUSE_MODEL_SELECTION,
        assertOutput: assertMuseSubagentInterruptOutput,
      },
    ],
  },
  {
    name: "muse_workflow",
    buildInput: museWorkflowInput,
    providers: [
      {
        driver: ProviderDriverKind.make("muse"),
        transcriptFile: new URL("./muse_workflow/muse_transcript.ndjson", import.meta.url),
        modelSelection: MUSE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertMuseWorkflowOutput,
      },
    ],
  },
  ...(
    [
      ["opencode2_command", openCode2CommandInput, assertOpenCode2CommandOutput],
      ["opencode2_skill", openCode2SkillInput, assertOpenCode2SkillOutput],
    ] as const
  ).map(([name, buildInput, assertOutput]) => ({
    name,
    buildInput,
    providers: [
      {
        driver: ProviderDriverKind.make("opencode"),
        transcriptFile: new URL(`./${name}/opencode_transcript.ndjson`, import.meta.url),
        modelSelection: {
          instanceId: OPENCODE2_MODEL_SELECTION.instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
        },
        assertOutput,
      },
    ],
  })),
];
