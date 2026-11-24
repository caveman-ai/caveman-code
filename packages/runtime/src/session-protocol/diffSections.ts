import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";

/**
 * `git diff`, written the way splitDiffSections and the Changes pane read it whatever the person's git config says:
 * paths from the repository root (diff.relative), blank context lines kept as " " (diff.suppressBlankEmpty), no
 * colour (color.ui=always), no external diff tool (diff.external), a moved submodule as its "Subproject commit" line
 * change rather than a log (diff.submodule), and a/ b/ prefixes (diff.noprefix, diff.mnemonicPrefix). Follows the
 * guards upstream puts on its checkpoint diffs.
 */
export const PARSEABLE_DIFF: ReadonlyArray<string> = [
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--submodule=short",
  ...PATCH_RENDER_PREFIX_ARGS,
];

/** A whole `git diff`'s output, one string per file: each "diff --git" section, in the order git wrote them. */
export function splitDiffSections(diff: string): Array<string> {
  const out: Array<string> = [];
  // No line of a patch body starts with "diff --git" (its lines start with " ", "+", "-" or "@@").
  let start = diff.startsWith("diff --git ") ? 0 : -1;
  while (start !== -1) {
    const next = diff.indexOf("\ndiff --git ", start);
    out.push(diff.slice(start, next === -1 ? diff.length : next + 1));
    start = next === -1 ? -1 : next + 1;
  }
  return out;
}
