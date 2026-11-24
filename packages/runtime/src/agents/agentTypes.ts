// Subagent types delegate_task can start by name, and the agents automation steps
// run: Claude-compatible agent markdown (frontmatter name, description, model,
// tools, disallowedTools, effort, isolation, plus Caveman's engine, decides,
// returns and role; the body is the agent's instructions) from the project's
// .caveman/agents and .claude/agents, the user's ~/.caveman/agents, enabled Space
// plugins, then the built-in presets. The first definition of a name wins in that
// order. One loader: every file parses through @caveman-app/automations.
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseAgentFile } from "@caveman-app/automations";
import type { OrchestratorMcpTaskRole } from "@caveman-app/protocol";

export type AgentTypeSource = "project" | "user" | "plugin" | "builtin";

export interface AgentType {
  readonly name: string;
  readonly description: string;
  /** A model id or Claude's aliases (haiku, sonnet, opus, inherit); absent inherits. */
  readonly model?: string;
  /** Tools the agent should keep to, as named in the file. Told to the agent, not enforced. */
  readonly tools?: ReadonlyArray<string>;
  /** Tools the agent must not use. Told to the agent, not enforced. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** The child's effort when nothing else picks one (the lead's options, a role pin, Auto). */
  readonly effort?: string;
  /** `worktree`: the child gets its own checkout unless the lead asks for shared. */
  readonly isolation?: "worktree";
  /** The harness it runs on (an engine id); absent: the new-chat default. */
  readonly engine?: string;
  /** The values its final `decision:` line may take, for automation steps that branch on it. */
  readonly decides?: ReadonlyArray<string>;
  /** A JSON Schema file next to the agent, for a typed result. */
  readonly returns?: string;
  readonly instructions: string;
  /** The kind of work sent to Cloud, or matched to the person's role pin. */
  readonly role: OrchestratorMcpTaskRole;
  readonly source: AgentTypeSource;
}

export const BUILTIN_AGENT_TYPES: ReadonlyArray<AgentType> = [
  {
    name: "investigator",
    description: "Reads code, docs and history to answer a question. Changes nothing.",
    role: "research",
    instructions:
      "You investigate and report. Read, search and run read-only commands; never edit files, commit or push. Answer with what you found, where (file:line), and how sure you are.",
    source: "builtin",
  },
  {
    name: "builder",
    description: "Implements a scoped change and checks it with the repo's tests.",
    role: "implementation",
    instructions:
      "You implement the change described below and nothing else. Run the affected tests or checks before you finish. End with what changed, what you verified, and anything left open.",
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "Reviews a change for bugs and missed requirements. Changes nothing.",
    role: "review",
    decides: ["approve", "request_changes"],
    instructions:
      "You review; never edit files. Report concrete defects first (file:line, what breaks, how to fix), then gaps against the brief. Say plainly when you find nothing. Finish with one line: `decision: approve` when nothing you found would break or miss the brief, or `decision: request_changes` when something would.",
    source: "builtin",
  },
  {
    name: "tester",
    description: "Checks a web change in the browser and leaves the passing checks behind as tests.",
    role: "test",
    instructions: [
      "You check that the change described below works in the running app, and leave proof that lasts. Don't fix product code: report what fails.",
      "1. Plan from the diff and the code first. List each check with the result you expect before you touch the browser.",
      "2. Start the app with the workspace's run command if it isn't running (its ports are in CAVEMAN_PORT_*).",
      "3. Drive it with the preview_* tools. Act on snapshot refs; ask for an image only when the check is visual. After each step read the snapshot's console errors and failed requests: a check with a new error fails.",
      "4. Never force a page into the expected state with preview_evaluate. If you used it to read something, say so next to that check.",
      "5. Once every check passes, record one clean run with preview_recording_start and preview_recording_stop, and save screenshots of the key states (preview_snapshot with save=true).",
      "6. If the repo has Playwright (or another browser test runner), write each passing flow as a test next to its existing tests, run it, and keep it only if it passes. If it has none, put the flows in your report as steps instead; don't add a test framework.",
      "End with a table of checks (expected, seen, pass or fail), the recording and screenshot paths, and the test files you added.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "scout",
    description: "Reads this project's memory notes and recent chat titles, and drafts automations for work the person keeps repeating; writes nothing.",
    role: "research",
    instructions: [
      "You find work this person keeps doing by hand that an automation could do for them, and draft those automations. Never edit files, commit or push.",
      "1. Read this project's memory notes and the titles of its chats from the last 30 days. Look for work that repeats: the same kind of request every week, after every merge, or for every new issue or pull request.",
      "2. Pick at most three, the ones that would save the most time. Skip one-offs and anything that needs the person's judgement each time.",
      "3. For each, write one line on why (what repeats and how often), then the draft automation file in a fenced yaml block: a complete .caveman/automations/<name>.yaml in the v1 format, with a description, a trigger (on.github, or on.schedule with a timezone), a budget, and steps. Use agents that exist (builder, reviewer, investigator) or a prompt: step. Use model: fast for triage and summaries and base for code, with escalate: frontier only where a retry needs it. Give a step computer: full only when it has to change files.",
      "4. If nothing repeats, say so in one line instead of inventing work.",
    ].join("\n"),
    source: "builtin",
  },
];

/** One agent markdown file; undefined when it has no usable name. Problems in it are `check`'s to report. */
export function parseAgentType(markdown: string, fallbackName: string, source: AgentTypeSource): AgentType | undefined {
  const { agent } = parseAgentFile({ path: `${fallbackName}.md`, text: markdown }, source);
  if (agent === undefined) return undefined;
  return {
    name: agent.name,
    description: agent.description,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.isolation ? { isolation: agent.isolation } : {}),
    ...(agent.engine ? { engine: agent.engine } : {}),
    ...(agent.decides ? { decides: agent.decides } : {}),
    ...(agent.returns ? { returns: agent.returns } : {}),
    instructions: agent.instructions,
    role: agent.role ?? "general",
    source,
  };
}

async function readDir(dir: string, source: AgentTypeSource): Promise<AgentType[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const types: AgentType[] = [];
  for (const entry of entries) {
    try {
      const type = parseAgentType(await fs.readFile(path.join(dir, entry), "utf8"), entry.slice(0, -3), source);
      if (type) types.push(type);
    } catch {
      // An unreadable file is skipped, like a malformed one.
    }
  }
  return types;
}

export interface AgentTypeRoots {
  /** The checkout the delegating agent works in; absent outside a project. */
  readonly projectRoot?: string | undefined;
  readonly home: string;
  /** Agent markdown files of enabled Space plugins. */
  readonly pluginAgentFiles?: ReadonlyArray<string>;
}

export async function listAgentTypes(roots: AgentTypeRoots): Promise<ReadonlyArray<AgentType>> {
  const found: AgentType[] = [];
  if (roots.projectRoot) {
    found.push(...(await readDir(path.join(roots.projectRoot, ".caveman", "agents"), "project")));
    found.push(...(await readDir(path.join(roots.projectRoot, ".claude", "agents"), "project")));
  }
  found.push(...(await readDir(path.join(roots.home, ".caveman", "agents"), "user")));
  for (const file of roots.pluginAgentFiles ?? []) {
    try {
      const type = parseAgentType(await fs.readFile(file, "utf8"), path.basename(file, ".md"), "plugin");
      if (type) found.push(type);
    } catch {
      // As above.
    }
  }
  found.push(...BUILTIN_AGENT_TYPES);
  const byName = new Map<string, AgentType>();
  for (const type of found) if (!byName.has(type.name)) byName.set(type.name, type);
  return [...byName.values()];
}

/** The child's prompt: the type's instructions ahead of the brief. */
export function agentTypePrompt(type: AgentType, task: string): string {
  const tools = type.tools ? `\nKeep to these tools: ${type.tools.join(", ")}.` : "";
  const never = type.disallowedTools ? `\nNever use these tools: ${type.disallowedTools.join(", ")}.` : "";
  const header = `You are the ${type.name} agent.${type.instructions ? `\n\n${type.instructions}` : ""}${tools}${never}`;
  return `${header}\n\n---\n\n${task}`;
}
