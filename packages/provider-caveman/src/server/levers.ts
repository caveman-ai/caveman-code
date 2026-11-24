/**
 * What the Caveman harness does in every app session, in plain words, with no heavy imports: the runtime's offline CLI
 * (automation explain) lists it without loading the engine.
 *
 * None of these is a switch. They are what the app loadouts are (`appLoadouts()` in `@caveman-ai/harness`: app-claude
 * for Claude and every model with no surface of its own, app-gpt for GPT on a Responses API, app-general for the agents
 * that do not code), measured against Claude Code and Codex and run as they are.
 * levers.test.ts checks them against the loadouts, so a loadout that drops one fails there (compaction's 80% is the
 * session's own default, which the app leaves as it is).
 *
 * @module provider-caveman/server/levers
 */
export const HARNESS_LEVERS = {
  surface: "Each model on the tool surface it was measured on: Codex's for GPT, Claude Code's for the rest",
  mcpPrograms: "MCP tools called from programs, so raw results stay out of the conversation",
  outputCaps: "Long tool output capped at 50 KB or 2,000 lines, the whole of it kept in a file to read",
  loopStop: "A stop when the same call keeps returning the same result, or the model keeps answering nothing",
  cacheKeepAlive: "Claude's prompt cache kept warm while a tool runs or a person reads",
  compaction: "The conversation summarized at 80% of the context window",
  retries: "Rate limits and outages retried with the same request",
} as const;

export type HarnessLever = keyof typeof HARNESS_LEVERS;
