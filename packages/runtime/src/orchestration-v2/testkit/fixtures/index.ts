// ), apps/server/src/orchestration-v2/testkit/fixtures/index.ts @ ab3a3cd1.
import { ProviderDriverKind } from "@caveman-app/protocol";

import { claudeBackgroundSubagentAfterRootInput } from "./claude_background_subagent_after_root/input.ts";
import { assertClaudeBackgroundSubagentAfterRootOutput } from "./claude_background_subagent_after_root/output.ts";
import { claudeBackgroundTaskAfterRootInput } from "./claude_background_task_after_root/input.ts";
import { assertClaudeBackgroundTaskAfterRootOutput } from "./claude_background_task_after_root/output.ts";
import { claudeBackgroundSubagentLifecycleInput } from "./claude_background_subagent_lifecycle/input.ts";
import { assertClaudeBackgroundSubagentLifecycleOutput } from "./claude_background_subagent_lifecycle/output.ts";
import { claudeBackgroundTaskInterruptInput } from "./claude_background_task_interrupt/input.ts";
import { claudeBackgroundWakeBeforeQueuedPromptInput } from "./claude_background_wake_before_queued_prompt/input.ts";
import { assertClaudeBackgroundWakeBeforeQueuedPromptOutput } from "./claude_background_wake_before_queued_prompt/output.ts";
import { claudeBackgroundWakeBeforeQueuedPromptNoEchoInput } from "./claude_background_wake_before_queued_prompt_no_echo/input.ts";
import { assertClaudeBackgroundWakeBeforeQueuedPromptNoEchoOutput } from "./claude_background_wake_before_queued_prompt_no_echo/output.ts";
import { assertClaudeBackgroundTaskInterruptOutput } from "./claude_background_task_interrupt/output.ts";
import { claudeBackgroundMonitorWakeInput } from "./claude_background_monitor_wake/input.ts";
import { assertClaudeBackgroundMonitorWakeOutput } from "./claude_background_monitor_wake/output.ts";
import { claudeBackgroundTaskWakeInput } from "./claude_background_task_wake/input.ts";
import { assertClaudeBackgroundTaskWakeOutput } from "./claude_background_task_wake/output.ts";
import {
  claudeCompactAfterPeerTurnInput,
  claudeCompactAfterPeerTurnNoEchoInput,
} from "./claude_compact_after_peer_turn/input.ts";
import { assertClaudeCompactAfterPeerTurnOutput } from "./claude_compact_after_peer_turn/output.ts";
import { assertClaudeCompactAfterPeerTurnNoEchoOutput } from "./claude_compact_after_peer_turn_no_echo/output.ts";
import { claudeCompactAfterResumeWakeInput } from "./claude_compact_after_resume_wake/input.ts";
import { assertClaudeCompactAfterResumeWakeOutput } from "./claude_compact_after_resume_wake/output.ts";
import { claudeIdleResumeInput } from "./claude_idle_resume/input.ts";
import { assertClaudeIdleResumeOutput } from "./claude_idle_resume/output.ts";
import { claudeLocalBashTaskInput } from "./claude_local_bash_task/input.ts";
import { assertClaudeLocalBashTaskOutput } from "./claude_local_bash_task/output.ts";
import { claudeNestedBackgroundSubagentWakeInput } from "./claude_nested_background_subagent_wake/input.ts";
import { assertClaudeNestedBackgroundSubagentWakeOutput } from "./claude_nested_background_subagent_wake/output.ts";
import { claudeNestedSubagentModelInput } from "./claude_nested_subagent_model/input.ts";
import { assertClaudeNestedSubagentModelOutput } from "./claude_nested_subagent_model/output.ts";
import { claudeMcpToolPresentationInput } from "./claude_mcp_tool_presentation/input.ts";
import { assertClaudeMcpToolPresentationOutput } from "./claude_mcp_tool_presentation/output.ts";
import { claudeResultIsErrorInput } from "./claude_result_is_error/input.ts";
import { assertClaudeResultIsErrorOutput } from "./claude_result_is_error/output.ts";
import { assertClaudeMessageSteeringOutput } from "./message_steering/claude_output.ts";
import { assertMessageSteeringOutput } from "./message_steering/codex_output.ts";
import { messageSteeringInput } from "./message_steering/input.ts";
import { providerThreadResumeInput } from "./provider_thread_resume/input.ts";
import { assertMultiTurnClaudeOutput } from "./multi_turn/claude_output.ts";
import { assertMultiTurnOutput } from "./multi_turn/codex_output.ts";
import { multiTurnInput } from "./multi_turn/input.ts";
import { assertPlanQuestionsOutput } from "./plan_questions/codex_output.ts";
import { planQuestionsInput } from "./plan_questions/input.ts";
import { assertQueuedCancelledWhileActiveOutput } from "./queued_cancelled_while_active/codex_output.ts";
import { queuedCancelledWhileActiveInput } from "./queued_cancelled_while_active/input.ts";
import { assertQueuedTurnOutput } from "./queued_turn/codex_output.ts";
import { queuedTurnInput } from "./queued_turn/input.ts";
import { assertSimpleClaudeOutput } from "./simple/claude_output.ts";
import { skillInvocationInput } from "./skill_invocation/input.ts";
import { assertSimpleOutput } from "./simple/codex_output.ts";
import { simpleInput } from "./simple/input.ts";
import { malformedSessionUpdateInput } from "./malformed_session_update/input.ts";
import { assertMalformedSessionUpdateOutput } from "./malformed_session_update/output.ts";
import { assertSubagentOutput } from "./subagent/codex_output.ts";
import { assertClaudeSubagentOutput } from "./subagent/claude_output.ts";
import { subagentInput } from "./subagent/input.ts";
import { assertSubagentContinueOutput } from "./subagent_continue/codex_output.ts";
import { subagentContinueInput } from "./subagent_continue/input.ts";
import { assertSubagentV2Output } from "./subagent_v2/codex_output.ts";
import { subagentV2Input, subagentV2NestedInput } from "./subagent_v2/input.ts";
import { assertSubagentV2ApprovalOutput } from "./subagent_v2_approval/codex_output.ts";
import {
  SUBAGENT_V2_APPROVAL_POLICY,
  subagentV2ApprovalInput,
} from "./subagent_v2_approval/input.ts";
import { assertSubagentV2NestedOutput } from "./subagent_v2_nested/codex_output.ts";
import { assertSubagentV2NestedApprovalOutput } from "./subagent_v2_nested_approval/codex_output.ts";
import { subagentV2NestedApprovalInput } from "./subagent_v2_nested_approval/input.ts";
import { assertClaudeThreadRollbackOutput } from "./thread_rollback/claude_output.ts";
import { assertThreadRollbackOutput } from "./thread_rollback/codex_output.ts";
import { threadRollbackInput } from "./thread_rollback/input.ts";
import { assertThreadRollbackAfterRestartOutput } from "./thread_rollback_after_restart/codex_output.ts";
import { threadRollbackAfterRestartInput } from "./thread_rollback_after_restart/input.ts";
import { threadRollbackAfterStopInput } from "./thread_rollback_after_stop/input.ts";
import { assertThreadRollbackToStoppedTurnOutput } from "./thread_rollback_to_stopped_turn/codex_output.ts";
import { threadRollbackToStoppedTurnInput } from "./thread_rollback_to_stopped_turn/input.ts";
import { assertTodoListOutput } from "./todo_list/codex_output.ts";
import { todoListInput } from "./todo_list/input.ts";
import { assertToolCallDeniedWriteClaudeOutput } from "./tool_call_denied_write/claude_output.ts";
import {
  DENIED_WRITE_POLICY,
  TOOL_CALL_DENIED_WRITE_TARGET,
  toolCallDeniedWriteInput,
} from "./tool_call_denied_write/input.ts";
import { assertToolCallReadOnlyClaudeOutput } from "./tool_call_read_only/claude_output.ts";
import { assertToolCallReadOnlyCursorOutput } from "./tool_call_read_only/cursor_output.ts";
import { assertTodoListGrokOutput } from "./todo_list/grok_output.ts";
import { assertGrokMessageSteeringOutput } from "./message_steering/grok_output.ts";
import { toolCallReadOnlyInput } from "./tool_call_read_only/input.ts";
import {
  assertToolCallReadOnlyOnRequestGrokOutput,
  assertToolCallReadOnlyOnRequestOutput,
} from "./tool_call_read_only_on_request/output.ts";
import { toolCallReadOnlyOnRequestInput } from "./tool_call_read_only_on_request/input.ts";
import {
  stopBackgroundWorkAfterFailedTurnInput,
  stopBackgroundWorkAfterReleaseInput,
} from "./stop_background_work_after_failed_turn/input.ts";
import { assertStopBackgroundWorkAfterFailedTurnOutput } from "./stop_background_work_after_failed_turn/output.ts";
import { assertToolCallRestrictedGranularClaudeOutput } from "./tool_call_restricted_granular/claude_output.ts";
import { assertToolCallRestrictedGranularOutput } from "./tool_call_restricted_granular/codex_output.ts";
import { toolCallRestrictedGranularInput } from "./tool_call_restricted_granular/input.ts";
import { assertToolCallWorkspaceNeverClaudeOutput } from "./tool_call_workspace_never/claude_output.ts";
import { assertToolCallWorkspaceNeverOutput } from "./tool_call_workspace_never/codex_output.ts";
import { toolCallWorkspaceNeverInput } from "./tool_call_workspace_never/input.ts";
import { assertTurnInterruptClaudeOutput } from "./turn_interrupt/claude_output.ts";
import { assertCommandOutputStreamingOutput } from "./command_output_streaming/output.ts";
import { commandOutputStreamingInput } from "./command_output_streaming/input.ts";
import { assertTurnInterruptOutput } from "./turn_interrupt/codex_output.ts";
import { turnInterruptInput } from "./turn_interrupt/input.ts";
import { assertTurnInterruptMidToolClaudeOutput } from "./turn_interrupt_mid_tool/claude_output.ts";
import { assertTurnInterruptMidToolCodexOutput } from "./turn_interrupt_mid_tool/codex_output.ts";
import { turnInterruptMidToolInput } from "./turn_interrupt_mid_tool/input.ts";
import { assertTurnInterruptRestartClaudeOutput } from "./turn_interrupt_restart/claude_output.ts";
import { turnInterruptRestartInput } from "./turn_interrupt_restart/input.ts";
import { assertClaudeWebSearchOutput } from "./web_search/claude_output.ts";
import { assertWebSearchOutput } from "./web_search/codex_output.ts";
import { webSearchInput } from "./web_search/input.ts";
import {
  ACP_REGISTRY_MODEL_SELECTION,
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  READ_ONLY_ON_REQUEST_POLICY,
  RESTRICTED_GRANULAR_POLICY,
  type OrchestratorReplayFixture,
  WORKSPACE_NEVER_POLICY,
} from "./shared.ts";
import { CLAUDE_LIVE_MODEL_SELECTION } from "./claude_live.ts";
import { claudeLiveToolApprovalInput } from "./claude_live_tool_approval/input.ts";
import { assertClaudeLiveToolApprovalOutput } from "./claude_live_tool_approval/output.ts";
import { claudeSpacePluginInput } from "./claude_space_plugin/input.ts";
import { assertClaudeSpacePluginOutput } from "./claude_space_plugin/output.ts";
import { PI_REPLAY_SCENARIOS, PI_REPLAY_VARIANTS } from "./pi.ts";
import { CURSOR_OPENCODE_MUSE_REPLAY_SCENARIOS, CURSOR_OPENCODE_MUSE_REPLAY_VARIANTS } from "./cursorOpencodeMuse.ts";
import { GROK_REPLAY_SCENARIOS, GROK_REPLAY_VARIANTS } from "./grok.ts";

const BASE_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  {
    name: "claude_background_subagent_after_root",
    buildInput: claudeBackgroundSubagentAfterRootInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_subagent_after_root/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundSubagentAfterRootOutput,
      },
    ],
  },
  {
    name: "claude_background_task_after_root",
    buildInput: claudeBackgroundTaskAfterRootInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_after_root/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeBackgroundTaskAfterRootOutput,
      },
    ],
  },
  {
    name: "claude_background_subagent_lifecycle",
    buildInput: claudeBackgroundSubagentLifecycleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_subagent_lifecycle/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundSubagentLifecycleOutput,
      },
    ],
  },
  {
    name: "claude_background_task_interrupt",
    buildInput: claudeBackgroundTaskInterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_interrupt/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundTaskInterruptOutput,
      },
    ],
  },
  {
    name: "claude_background_wake_before_queued_prompt",
    buildInput: claudeBackgroundWakeBeforeQueuedPromptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_wake_before_queued_prompt/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundWakeBeforeQueuedPromptOutput,
      },
    ],
  },
  {
    name: "claude_background_wake_before_queued_prompt_no_echo",
    buildInput: claudeBackgroundWakeBeforeQueuedPromptNoEchoInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_wake_before_queued_prompt_no_echo/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundWakeBeforeQueuedPromptNoEchoOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_resume_wake",
    buildInput: claudeCompactAfterResumeWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_resume_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterResumeWakeOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_peer_turn",
    buildInput: claudeCompactAfterPeerTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_peer_turn/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterPeerTurnOutput,
      },
    ],
  },
  {
    name: "claude_compact_after_peer_turn_no_echo",
    buildInput: claudeCompactAfterPeerTurnNoEchoInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_compact_after_peer_turn_no_echo/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeCompactAfterPeerTurnNoEchoOutput,
      },
    ],
  },
  {
    name: "claude_background_monitor_wake",
    buildInput: claudeBackgroundMonitorWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_monitor_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundMonitorWakeOutput,
      },
    ],
  },
  {
    name: "claude_background_task_wake",
    buildInput: claudeBackgroundTaskWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_background_task_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeBackgroundTaskWakeOutput,
      },
    ],
  },
  {
    name: "claude_local_bash_task",
    buildInput: claudeLocalBashTaskInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_local_bash_task/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeLocalBashTaskOutput,
      },
    ],
  },
  {
    name: "claude_nested_background_subagent_wake",
    buildInput: claudeNestedBackgroundSubagentWakeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_nested_background_subagent_wake/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runContinuationWorker: true,
        assertOutput: assertClaudeNestedBackgroundSubagentWakeOutput,
      },
    ],
  },
  {
    name: "claude_nested_subagent_model",
    buildInput: claudeNestedSubagentModelInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_nested_subagent_model/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeNestedSubagentModelOutput,
      },
    ],
  },
  {
    name: "claude_mcp_tool_presentation",
    buildInput: claudeMcpToolPresentationInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_mcp_tool_presentation/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeMcpToolPresentationOutput,
      },
    ],
  },
  {
    name: "claude_idle_resume",
    buildInput: claudeIdleResumeInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./claude_idle_resume/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeIdleResumeOutput,
      },
    ],
  },
  {
    name: "claude_result_is_error",
    buildInput: claudeResultIsErrorInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_result_is_error/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeResultIsErrorOutput,
      },
    ],
  },
  {
    name: "acp_elicitation",
    buildInput: planQuestionsInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./acp_elicitation/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertPlanQuestionsOutput,
      },
    ],
  },
  {
    name: "malformed_session_update",
    buildInput: malformedSessionUpdateInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./malformed_session_update/registry_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertMalformedSessionUpdateOutput,
      },
    ],
  },
  {
    name: "simple",
    buildInput: simpleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./simple/codex_transcript.ndjson", import.meta.url),
        // Caveman Code: re-recorded on codex 0.161 with an API-key account in an app-managed home.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5-nano" },
        assertOutput: assertSimpleOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./simple/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertSimpleClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./simple/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertSimpleOutput,
      },
    ],
  },
  {
    name: "tool_call_denied_write",
    buildInput: toolCallDeniedWriteInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_denied_write/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: DENIED_WRITE_POLICY,
        expectedAbsentWorkspacePaths: [TOOL_CALL_DENIED_WRITE_TARGET],
        assertOutput: assertToolCallDeniedWriteClaudeOutput,
      },
    ],
  },
  {
    name: "tool_call_read_only",
    buildInput: toolCallReadOnlyInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./tool_call_read_only/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./tool_call_read_only/registry_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertToolCallReadOnlyCursorOutput,
      },
    ],
  },
  {
    name: "tool_call_read_only_on_request",
    buildInput: toolCallReadOnlyOnRequestInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/codex_transcript.ndjson",
          import.meta.url,
        ),
        // gpt-6-luna declines the write under a read-only sandbox, so nothing asks for approval.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-6-sol" },
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./tool_call_read_only_on_request/registry_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertToolCallReadOnlyOnRequestOutput,
      },
    ],
  },
  {
    name: "tool_call_workspace_never",
    buildInput: toolCallWorkspaceNeverInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_workspace_never/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_workspace_never/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertToolCallWorkspaceNeverClaudeOutput,
      },
    ],
  },
  {
    name: "tool_call_restricted_granular",
    buildInput: toolCallRestrictedGranularInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./tool_call_restricted_granular/codex_transcript.ndjson",
          import.meta.url,
        ),
        // gpt-6 models write through the shell; gpt-5.6-terra's apply_patch raises the
        // file-change approval this fixture covers.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-terra" },
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./tool_call_restricted_granular/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: RESTRICTED_GRANULAR_POLICY,
        assertOutput: assertToolCallRestrictedGranularClaudeOutput,
      },
    ],
  },
  {
    name: "subagent",
    buildInput: subagentInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent/codex_transcript.ndjson", import.meta.url),
        // gpt-5.6-luna still runs multi-agent v1 (collabAgentToolCall); subagent_v2 covers v2.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-luna" },
        runtimePolicyOverride: READ_ONLY_ON_REQUEST_POLICY,
        assertOutput: assertSubagentOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./subagent/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeSubagentOutput,
      },
    ],
  },
  {
    name: "subagent_continue",
    buildInput: subagentContinueInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_continue/codex_transcript.ndjson", import.meta.url),
        // gpt-5.6-luna still runs multi-agent v1 (collabAgentToolCall); subagent_v2 covers v2.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5.6-luna" },
        assertOutput: assertSubagentContinueOutput,
      },
    ],
  },
  {
    name: "subagent_v2",
    buildInput: subagentV2Input,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentV2Output,
      },
    ],
  },
  {
    name: "subagent_v2_approval",
    buildInput: subagentV2ApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2_approval/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: SUBAGENT_V2_APPROVAL_POLICY,
        assertOutput: assertSubagentV2ApprovalOutput,
      },
    ],
  },
  {
    name: "subagent_v2_nested",
    buildInput: subagentV2NestedInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./subagent_v2_nested/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertSubagentV2NestedOutput,
      },
    ],
  },
  {
    name: "subagent_v2_nested_approval",
    buildInput: subagentV2NestedApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./subagent_v2_nested_approval/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: SUBAGENT_V2_APPROVAL_POLICY,
        assertOutput: assertSubagentV2NestedApprovalOutput,
      },
    ],
  },
  {
    name: "multi_turn",
    buildInput: multiTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./multi_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./multi_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./multi_turn/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertMultiTurnOutput,
      },
    ],
  },
  {
    name: "multi_turn_restart",
    buildInput: multiTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./multi_turn_restart/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertMultiTurnClaudeOutput,
      },
    ],
  },
  {
    name: "queued_cancelled_while_active",
    buildInput: queuedCancelledWhileActiveInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./queued_turn/codex_transcript.ndjson", import.meta.url),
        recordedScenario: "queued_turn",
        transcriptEntriesThroughLabel: "turn/completed",
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertQueuedCancelledWhileActiveOutput,
      },
    ],
  },
  {
    name: "queued_turn",
    buildInput: queuedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./queued_turn/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./queued_turn/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./queued_turn/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertQueuedTurnOutput,
      },
    ],
  },
  {
    name: "todo_list",
    buildInput: todoListInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./todo_list/codex_transcript.ndjson", import.meta.url),
        // Caveman Code: re-recorded on codex 0.161 with an API-key account in an app-managed home.
        modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-5-mini" },
        runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
        assertOutput: assertTodoListOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./todo_list/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertTodoListGrokOutput,
      },
    ],
  },
  {
    name: "web_search",
    buildInput: webSearchInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./web_search/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertWebSearchOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./web_search/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeWebSearchOutput,
      },
    ],
  },
  {
    name: "message_steering",
    buildInput: messageSteeringInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./message_steering/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./message_steering/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeMessageSteeringOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./message_steering/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertGrokMessageSteeringOutput,
      },
    ],
  },
  {
    name: "turn_interrupt",
    buildInput: turnInterruptInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./turn_interrupt/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./turn_interrupt/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptClaudeOutput,
      },
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL("./turn_interrupt/registry_transcript.ndjson", import.meta.url),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptOutput,
      },
    ],
  },
  {
    name: "command_output_streaming",
    buildInput: commandOutputStreamingInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./command_output_streaming/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertCommandOutputStreamingOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./command_output_streaming/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertCommandOutputStreamingOutput,
      },
    ],
  },
  {
    name: "turn_interrupt_mid_tool",
    buildInput: turnInterruptMidToolInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolCodexOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./turn_interrupt_mid_tool/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolClaudeOutput,
      },
    ],
  },
  {
    name: "turn_interrupt_restart",
    buildInput: turnInterruptRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./turn_interrupt_restart/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptRestartClaudeOutput,
      },
    ],
  },
  {
    name: "thread_rollback",
    buildInput: threadRollbackInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL("./thread_rollback/codex_transcript.ndjson", import.meta.url),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertThreadRollbackOutput,
      },
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./thread_rollback/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_MODEL_SELECTION,
        assertOutput: assertClaudeThreadRollbackOutput,
      },
    ],
  },
  {
    name: "thread_rollback_after_restart",
    buildInput: threadRollbackAfterRestartInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./thread_rollback_after_restart/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        assertOutput: assertThreadRollbackAfterRestartOutput,
      },
    ],
  },
  {
    name: "thread_rollback_to_stopped_turn",
    buildInput: threadRollbackToStoppedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        transcriptFile: new URL(
          "./thread_rollback_to_stopped_turn/codex_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CODEX_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertThreadRollbackToStoppedTurnOutput,
      },
    ],
  },
  {
    name: "stop_background_work_after_failed_turn",
    buildInput: stopBackgroundWorkAfterFailedTurnInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./stop_background_work_after_failed_turn/registry_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertStopBackgroundWorkAfterFailedTurnOutput,
      },
    ],
  },
  {
    name: "stop_background_work_after_release",
    buildInput: stopBackgroundWorkAfterReleaseInput,
    providers: [
      {
        driver: ProviderDriverKind.make("acpRegistry"),
        transcriptFile: new URL(
          "./stop_background_work_after_failed_turn/registry_transcript.ndjson",
          import.meta.url,
        ),
        recordedScenario: "stop_background_work_after_failed_turn",
        modelSelection: ACP_REGISTRY_MODEL_SELECTION,
        assertOutput: assertStopBackgroundWorkAfterFailedTurnOutput,
      },
    ],
  },
  // Recorded by Caveman Code on Claude Agent 2.1.300 + Agent SDK 0.3.300.
  {
    name: "claude_live_simple",
    buildInput: simpleInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./claude_live_simple/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_LIVE_MODEL_SELECTION,
        assertOutput: assertSimpleClaudeOutput,
      },
    ],
  },
  {
    name: "claude_live_tool_approval",
    buildInput: claudeLiveToolApprovalInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_live_tool_approval/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_LIVE_MODEL_SELECTION,
        runtimePolicyOverride: DENIED_WRITE_POLICY,
        assertOutput: assertClaudeLiveToolApprovalOutput,
      },
    ],
  },
  {
    name: "claude_live_turn_interrupt",
    buildInput: turnInterruptMidToolInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL(
          "./claude_live_turn_interrupt/claude_transcript.ndjson",
          import.meta.url,
        ),
        modelSelection: CLAUDE_LIVE_MODEL_SELECTION,
        runtimePolicyOverride: WORKSPACE_NEVER_POLICY,
        assertOutput: assertTurnInterruptMidToolClaudeOutput,
      },
    ],
  },
  {
    name: "claude_space_plugin",
    buildInput: claudeSpacePluginInput,
    providers: [
      {
        driver: ProviderDriverKind.make("claudeAgent"),
        transcriptFile: new URL("./claude_space_plugin/claude_transcript.ndjson", import.meta.url),
        modelSelection: CLAUDE_LIVE_MODEL_SELECTION,
        assertOutput: assertClaudeSpacePluginOutput,
      },
    ],
  },
];

/**
 * Harness packages' fixtures (grok.ts, ...), kept in files of their own: their
 * own scenarios, and their variants of shared scenarios, added by name.
 */
const HARNESS_REPLAY_FIXTURES: ReadonlyArray<
  readonly [
    ReadonlyArray<OrchestratorReplayFixture>,
    Readonly<Record<string, ReadonlyArray<OrchestratorReplayFixture["providers"][number]>>>,
  ]
> = [
  [GROK_REPLAY_SCENARIOS, GROK_REPLAY_VARIANTS],
  [PI_REPLAY_SCENARIOS, PI_REPLAY_VARIANTS],
  [CURSOR_OPENCODE_MUSE_REPLAY_SCENARIOS, CURSOR_OPENCODE_MUSE_REPLAY_VARIANTS],
];

export const ORCHESTRATOR_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  ...BASE_REPLAY_FIXTURES.map((fixture) => ({
    ...fixture,
    providers: [
      ...fixture.providers,
      ...HARNESS_REPLAY_FIXTURES.flatMap(([, variants]) => variants[fixture.name] ?? []),
    ],
  })),
  ...HARNESS_REPLAY_FIXTURES.flatMap(([scenarios]) => scenarios),
];

// TODO(claude-v2/context-transfer): add provider-switch handoff and return fixtures when portable
// context handoff is implemented. Cross-reference docs/orchestration-v2/provider-switching-and-context.md
// and docs/orchestration-v2/thread-lineage-and-context-transfer.md. The return fixture should
// prefer a delta handoff into an existing Claude provider thread.

// TODO(claude-v2/context-transfer-fixtures): register provider-switch, merge-back, and cross-provider
// fork fixtures after each path has a real provider transcript. Cross-reference
// docs/orchestration-v2/provider-switching-and-context.md and
// docs/orchestration-v2/thread-lineage-and-context-transfer.md.
