/**
 * A skill the person picks in the composer is sent as `$name` (Codex's
 * mention). Codex runs it natively and Claude Agent's adapter turns it into
 * the skill's slash command; to the Caveman engine it was prose, left to the
 * model to follow with load_skill, which a small model does not do. A mention
 * of a skill the session loaded becomes the SDK's explicit invocation
 * instead: the skill's body in the turn, then the person's words.
 *
 * @module provider-caveman/server/skillMentions
 */
import type { AgentEnvironment } from "@caveman-ai/agent/plugins";

import type { CavemanEngine } from "./engine.ts";

/** The composer's token shape (apps/web composer-complete `skillMentions`): `$` after a space or the start, up to a space or the end. */
const MENTION = /(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export function expandSkillMentions(plugins: CavemanEngine["plugins"], text: string, environment: AgentEnvironment | undefined): string {
  if (environment === undefined || environment.skills.length === 0 || !text.includes("$")) return text;
  const known = new Set(environment.skills.map((skill) => skill.id));
  const ids: Array<string> = [];
  for (const match of text.matchAll(MENTION)) {
    const id = match[2]!;
    if (known.has(id) && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return text;
  const rest = text.replace(MENTION, (all, space: string, id: string) => (known.has(id) ? space : all)).trim();
  return [...ids.map((id) => plugins.renderAgentSkillInvocation(environment, id)), ...(rest === "" ? [] : ["User request:", text.trim()])].join("\n\n");
}
