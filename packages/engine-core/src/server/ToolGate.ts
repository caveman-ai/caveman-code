/**
 * The gate before each tool (docs/ SPEC §7.3, finding R11; formal/NothingLost.tla's
 * Intent, with WriteAhead). An engine asks it as the last thing before a tool's effect, after the person's approval
 * and any plugin hook: the runtime that holds the chat records that the step is about to run, gets that into Cloud's
 * copy of the chat when the step can change something outside the checkout, and only then lets it run. It holds a
 * tool that would start once the chat is being stopped (a Cloud computer going to sleep), and refuses one in a chat
 * that lives on another computer by now.
 *
 * A runtime registers its gate once (session-protocol/handlers.ts); a process that runs several runtimes (tests)
 * registers several, and the one that holds the chat answers.
 *
 * @module engine-core/server/ToolGate
 */

/** What a tool does: read only, change files in the checkout, or anything else (a command, an outside tool). */
export type ToolEffect = "read" | "write" | "external";

export interface ToolCall {
  /** The thread the call runs in. */
  readonly threadId: string;
  /** The turn items the call shows as (one, or one per file a patch touches): how the journal names it. */
  readonly itemIds: ReadonlyArray<string>;
  /** The tool as its engine names it. */
  readonly name: string;
  /** One line a person or an agent would know it by: the command, the tool and its target. */
  readonly title: string;
  readonly effect: ToolEffect;
  /** Fires when the turn is stopped: a call held here then never runs. */
  readonly signal?: AbortSignal | undefined;
}

export type ToolGateAnswer =
  | { readonly run: true }
  | { readonly run: false; readonly reason: string };
/** A runtime's gate: undefined when it holds no chat on that thread. */
export type ToolGate = (call: ToolCall) => Promise<ToolGateAnswer | undefined>;

const gates = new Set<ToolGate>();

/** Registers a runtime's gate; the function it answers takes it out again. */
export const registerToolGate = (gate: ToolGate): (() => void) => {
  gates.add(gate);
  return () => void gates.delete(gate);
};

/**
 * Asked before a tool runs: a reason when it must not (the model reads it instead of the tool's result), undefined when
 * it may. No gate, or none that holds the chat: it runs, as before the gate existed. A gate that throws never keeps a
 * tool from running.
 */
export const beforeTool = async (call: ToolCall): Promise<string | undefined> => {
  for (const gate of gates) {
    let answer: ToolGateAnswer | undefined;
    try {
      answer = await gate(call);
    } catch {
      continue;
    }
    if (answer !== undefined) return answer.run ? undefined : answer.reason;
  }
  return undefined;
};

/** Claude Code's tools that only read (Claude Agent's names): everything else it runs is a command or an outside tool. */
const CLAUDE_READS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "BashOutput",
  "TaskOutput",
  "TaskGet",
  "TaskList",
  "WebSearch",
  "WebFetch",
]);
const CLAUDE_WRITES: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A Claude Agent tool's effect, by its name. A tool it does not know (an MCP tool, Bash, a subagent) is an outside one. */
export const claudeToolEffect = (name: string): ToolEffect =>
  CLAUDE_READS.has(name) ? "read" : CLAUDE_WRITES.has(name) ? "write" : "external";
