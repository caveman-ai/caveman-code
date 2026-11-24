import type { AgentInfo, EnvSnapshot } from "../src/index.ts";

/** The runtime's built-in agents as the registry passes them (packages/runtime/src/agents/agentTypes.ts). */
export const BUILTINS: ReadonlyArray<AgentInfo> = [
  { name: "investigator", description: "Reads code, docs and history to answer a question. Changes nothing.", role: "research", source: "builtin" },
  { name: "builder", description: "Implements a scoped change and checks it with the repo's tests.", role: "implementation", source: "builtin" },
  { name: "reviewer", description: "Reviews a change for bugs and missed requirements. Changes nothing.", role: "review", decides: ["approve", "request_changes"], source: "builtin" },
  { name: "tester", description: "Checks a web change in the browser and leaves the passing checks behind as tests.", role: "test", source: "builtin" },
  { name: "scout", description: "Reads this project's memory notes and recent chat titles, and drafts automations for work the person keeps repeating; writes nothing.", role: "research", source: "builtin" },
];

/** This Mac with the Caveman engine on a key and Claude Agent on a subscription. */
export const ENV: EnvSnapshot = {
  host: "this-mac",
  defaultEngine: "caveman",
  engines: [
    { id: "caveman", available: true },
    { id: "claude-agent", available: true, subscription: true },
    { id: "codex", available: false, reason: "not signed in" },
  ],
  classes: {
    caveman: { fast: "deepseek/deepseek-v4.1-flash", base: "anthropic/claude-sonnet-5-5", frontier: "anthropic/claude-opus-5-5", source: "Models & keys" },
    "claude-agent": { fast: "claude-haiku-5-5", base: "claude-sonnet-5-5", frontier: "claude-opus-5-5", source: "built-in table" },
  },
  // As the runtime reports them (runtime/src/automations/env.ts): one summary row with the measured evidence, then each lever.
  levers: [
    { engine: "caveman", id: "all", label: "Caveman harness", on: true, evidence: "vs the classic engine: Opus 5.5 at 0.47x the cost over three working days, 48/48 steps done against 44/48 (measured in the app's own runner, one run)" },
    { engine: "caveman", id: "mcpPrograms", label: "MCP tools called from programs, so raw results stay out of the conversation", on: true, evidence: "" },
    { engine: "caveman", id: "outputCaps", label: "Long tool output capped at 50 KB or 2,000 lines, the whole of it kept in a file to read", on: true, evidence: "" },
    { engine: "caveman", id: "compaction", label: "The conversation summarized at 80% of the context window", on: true, evidence: "" },
    { engine: "claude-agent", id: "none", label: "Caveman's harness levers", on: false, evidence: "they run on the caveman engine only" },
  ],
  triggerHome: "code",
  budgetCap: { usd: 25, source: "Settings > Spend" },
  servedTriggers: ["manual", "schedule", "github"],
};
