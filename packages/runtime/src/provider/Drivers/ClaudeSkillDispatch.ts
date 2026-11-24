// ), apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts @ ab3a3cd1.
/**
 * ClaudeSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * slash invocation Claude Code actually runs.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not, and treats it as prose. Claude Code's only user-side
 * invocation is a text block whose first character is `/`: the harness
 * expands `/name args` into the SKILL.md body, and every character after the
 * name (newlines included) arrives as `ARGUMENTS`. Verified against the CLI in
 * stream-json mode, which is what the Agent SDK uses:
 *
 *  - The check runs on the LAST text block of the message. Earlier text
 *    blocks are preserved verbatim, and image blocks may sit before it.
 *  - Leading whitespace, or a `/name` that starts a later line of the same
 *    block, is literal text.
 *  - Only one skill expands per message; a second `/x` becomes argument text
 *    (anthropics/claude-code#87113). The model still starts the rest through
 *    its Skill tool when it reads `/name` in the prompt, so earlier mentions
 *    are rewritten to `/name` inline.
 *
 * So one mention anywhere in the prompt becomes a guaranteed invocation, and
 * the user's text on either side is kept in order.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export interface ClaudeSkillDispatch {
  /** The whole prompt with mentions as `/name`, or `undefined` when the mention opens it. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * A skill a mention dispatches: the command Claude runs, and for a user or
 * project skill its SKILL.md and whether only the user may start it
 * (`disable-model-invocation`).
 */
export interface ClaudeSkillTarget {
  readonly command: string;
  readonly path?: string;
  readonly userInvocationOnly?: boolean;
}

/**
 * The skills a mention can name: a set where the mention is the command
 * (user and project skills, `/name`), or a map from the mention to the
 * command Claude runs (a plugin's skill is `/plugin:folder`, ClaudeSkills
 * `discoverClaudePluginSkills`) or to its whole target.
 */
export type ClaudeSkillNames =
  | ReadonlySet<string>
  | ReadonlyMap<string, string | ClaudeSkillTarget>;

const targetFor = (skillNames: ClaudeSkillNames, name: string): ClaudeSkillTarget | undefined => {
  if (!("get" in skillNames)) return skillNames.has(name) ? { command: name } : undefined;
  const target = skillNames.get(name);
  return typeof target === "string" ? { command: target } : target;
};

const commandFor = (skillNames: ClaudeSkillNames, name: string): string | undefined =>
  targetFor(skillNames, name)?.command;

/** Whether `prompt` has a `$name` token at all: without one, which skills exist changes nothing it sends. */
export function hasClaudeSkillMention(prompt: string): boolean {
  return prompt.search(SKILL_MENTION_PATTERN) !== -1;
}

/** `prompt` with every `$skill` mention that names a known skill as an inline `/name`. */
export function inlineClaudeSkillMentions(prompt: string, skillNames: ClaudeSkillNames): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, space: string, name: string) => {
    const command = commandFor(skillNames, name);
    return command === undefined ? match : `${space}/${command}`;
  });
}

/**
 * Split `prompt` around the last `$skill` mention that names a known skill.
 * Returns `undefined` when there is nothing to dispatch, in which case the
 * prompt should go out unchanged. Mentions that do not match a discovered
 * skill stay literal: a `$HOME` in prose must not become a command.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ClaudeSkillNames,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const skill = targetFor(skillNames, match[2] ?? "");
    if (skill === undefined) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name: skill.command, skill, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  // Only the final skill gets native expansion. Earlier user-only skills need
  // a fallback to their raw file because Claude's Skill tool refuses them.
  const annotated = new Set([last.name]);
  let promptWithInlineSlashes = "";
  let cursor = 0;
  for (const mention of mentions) {
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}/${mention.name}`;
    if (
      mention.skill.userInvocationOnly === true &&
      mention.skill.path !== undefined &&
      !annotated.has(mention.name)
    ) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
    skillName: last.name,
  };
}
