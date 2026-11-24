// The `$skill` mention pattern, apart from composerInlineTokens.ts so the runtime's engines can use it without
// loading that module's Markdown math parser (remark-math, and KaTeX under it).

/**
 * A skill name may start with a digit, but compact monetary amounts and
 * numeric expressions like "$20", "$20k", "$100M", and "$1e6" must stay prose:
 * the composer chips any matched `$name` token, known or not. Tokens beginning
 * with digits must not match numbers with currency/exponent suffixes, and must
 * contain at least one letter. Any currency symbol is accepted as the sigil.
 */
export const SKILL_MENTION_SOURCE =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)/u
    .source;
/**
 * Skill mentions in a sent prompt, which may also end at the end of the text.
 * Group 1 is the leading delimiter and group 2 the skill name. The pattern is
 * global, so use it with `matchAll` or `replace`, not `test` or `exec`.
 */
export const SKILL_MENTION_PATTERN = new RegExp(`${SKILL_MENTION_SOURCE}(?=\\s|$)`, "gu");
