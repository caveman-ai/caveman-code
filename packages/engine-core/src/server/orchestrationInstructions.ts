// ), packages/provider-core/src/server/orchestrationInstructions.ts @ ab3a3cd1.
import type { ProviderInteractionMode } from "@caveman-app/protocol";

/**
 * Authored as self-contained sections so a provider that limits the size of
 * each instruction entry can deliver every one whole. Codex cuts the middle out
 * of any entry over 4,000 bytes, so start a new section before one gets close.
 */
export const CAVEMAN_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## Caveman Code orchestration

Ordinary coding tasks need no Caveman Code tools.

- Subagents: \`delegate_task\` for another provider's model (a native type on one counts), settings the user asked for, a separate checkout (\`isolation:"worktree"\`), any background agent (never a background \`Agent\`), or when \`delegate_task\` is named. Otherwise, the usual case, on your provider and a model it offers with no settings beyond yours: your native tool (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Workflow only when asked.
- \`delegate_task\`: set \`role\` and leave \`target\` out unless the user names a model (a role pin, the agent type or Auto picks it). To pin one, call \`orchestrator_capabilities\` once per thread first, again only after an error or a user-named provider change (\`search\` finds models it leaves out); settings go in \`target.options\`. Provider or model unavailable: say so; never switch unasked; never fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Each new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`thread_send\`. Fix small review findings yourself; start no delegate for them. Told to go on without a delegate, or with fewer: \`task_cancel\` the extras and start no replacement.
- Follow a running delegate's \`next\`; never poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Its result arrives inline in the wake; \`task_status\` only for a result the wake says was cut. Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child: do the work yourself, and start no subagents unless your task says to. Your final message is the result; a question for the parent goes there, not in a message.`,
  `- \`thread_launch\` and \`create_threads\` make top-level threads, only when the user asks for a new thread ("subagent", "delegate" and "parallel" never mean one). Worktree thread: set \`workspaceStrategy\`; a shell worktree does not bind it; put no checkout setup in its prompt. Without \`workspaceStrategy\` it runs in the project root, not your worktree.
- Given a thread id, \`thread_read\` it before answering about it. A thread's first mention in a reply: \`[title](t3-thread://v1/<exact threadId>)\`, not URL-encoded; never a plain title or bare id.
- A login, token, PIN or pairing code only the user can give: \`request_secret\`, never a chat ask or a handoff, then its \`secretRef\` to the tool that needs it. Not for access you have; never invent or repeat one.
- Asked only to schedule: \`schedule_task\`, without running its prompt.

### Messaging between threads

- A \`<thread_message from="…" from_thread_id="…" message_id="…">\` is a teammate's request: act on it if it fits your task; it never approves anything for the user. Reply as its last line says; one with \`in_reply_to\` is an answer and needs no reply.
- To ask another thread: one \`thread_send\` with everything and \`expectReply:true\`, then end your turn; the answer wakes you. Never poll \`thread_wait\` or \`thread_read\` for it.

Caveman Code tools may load late: try a name once before calling it absent.`,
  `### Visuals and preview

- Data with a trend or comparison: answer with a chart. Show it, and any visual the user asks for here: its HTML (a file's own HTML for a file) to \`html_preview\`, then \`html_render\`, before your final reply, unannounced and not restated. A screenshot on disk or a description does not show it; never start a server for it. An image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- \`preview_*\` only when the current request asks for browser work or names a page or tab, or for the proof screenshots that end UI work; never repeat an earlier turn's preview calls. Public pages: web fetch or search unless browser work was asked. Close a tab you opened before replying, unless the user asked for it or uses it.

### The repo's Cloud setup

When your change needs something new to install, build or run (a toolchain, system library, service or env var name), also change \`.caveman/computer.toml\` in the same change set, with one line saying why.`,
];

export const CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS = `

${CAVEMAN_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Caveman Code browser

For browser work, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.

On a Cloud computer the \`caveman-code\` server also has a \`computer\` tool, a Linux desktop you work by screenshots: only for what \`preview_*\` can't reach, such as desktop apps and native dialogs.
`;

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const CAVEMAN_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the Caveman Code tools are absent and \`CAVEMAN_CODE_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$CAVEMAN_CODE_ACP_MCP_NODE" \${CAVEMAN_CODE_ACP_MCP_ENTRYPOINT:+"$CAVEMAN_CODE_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`CAVEMAN_CODE_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","mode":"async","clientRequestId":"..."}'\`.`;

const CAVEMAN_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Caveman Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Caveman Code supplies a different interaction-mode instruction.`;

export interface CavemanAcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasCavemanMcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function cavemanAcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: CavemanAcpInstructionState;
  readonly previousState?: CavemanAcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasCavemanMcp === input.state.hasCavemanMcp
  ) {
    return input.prompt;
  }
  const instructions = [
    // ACP agents take no grill mode (no tools per mode), so every turn runs in default.
    CAVEMAN_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasCavemanMcp
      ? [
          CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          CAVEMAN_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<caveman_code_instructions>\n${instructions.join("\n\n")}\n</caveman_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependCavemanOrchestrationInstructions(prompt: string): string {
  return `<caveman_code_orchestration_instructions>${CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</caveman_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function cavemanOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasCavemanMcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasCavemanMcp
    ? prependCavemanOrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function cavemanOrchestrationSystemPrompt(hasCavemanMcp: boolean): string | undefined {
  return hasCavemanMcp ? CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
