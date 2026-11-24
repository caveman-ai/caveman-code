// Caveman's credit on the work it helped make (Settings > General > Git, on
// by default): a co-author trailer on commits and a footer on pull requests.
// The runtime adds both to the commits and pull requests it makes itself
// (git.commit, git.pr). Engines' own commits get the trailer from git, through
// the runtime's commit hooks (coAuthorHooks.ts); every engine is also asked to
// add both. The user's own trailers, Claude's included, are never touched.

/** No Caveman GitHub App identity is public yet, so the trailer names Caveman's noreply address. */
export const CAVEMAN_CO_AUTHOR = "Co-Authored-By: Caveman <noreply@caveman.so>";
export const CAVEMAN_PR_FOOTER = "Made with [Caveman Code](https://caveman.so)";

/** For every engine's instructions while the setting is on. */
export const CO_AUTHOR_INSTRUCTION = `<caveman_attribution>
When you make a git commit, end its message with this trailer on its own line: ${CAVEMAN_CO_AUTHOR}
Keep every other trailer as it is, your own Co-Authored-By included. When you open a pull request, end its body with this line: ${CAVEMAN_PR_FOOTER}
</caveman_attribution>`;

const TRAILER = /^[A-Za-z0-9-]+: \S/;

/** The setting from the stored Settings JSON: absent means on. */
export function coAuthorOn(settingsJson: string | undefined): boolean {
  if (settingsJson === undefined) return true;
  try {
    return (JSON.parse(settingsJson) as { git_co_author?: unknown }).git_co_author !== false;
  } catch {
    return true;
  }
}

/** The message with Caveman's trailer, once. A trailer block already at the end gets it as its last line. */
export function withCoAuthor(message: string): string {
  const text = message.replace(/\s+$/, "");
  const lines = text.split("\n");
  if (lines.some((line) => line.trim().toLowerCase() === CAVEMAN_CO_AUTHOR.toLowerCase())) return text;
  const lastBlank = lines.lastIndexOf("");
  const tail = lines.slice(lastBlank + 1);
  // Only a paragraph after the subject can be a trailer block.
  const inTrailers = lastBlank > 0 && tail.length > 0 && tail.every((line) => TRAILER.test(line));
  return inTrailers ? `${text}\n${CAVEMAN_CO_AUTHOR}` : `${text}\n\n${CAVEMAN_CO_AUTHOR}`;
}

/** The body with the footer, once. */
export function withPrFooter(body: string | undefined): string {
  const text = (body ?? "").replace(/\s+$/, "");
  if (text.includes(CAVEMAN_PR_FOOTER)) return text;
  return text === "" ? CAVEMAN_PR_FOOTER : `${text}\n\n${CAVEMAN_PR_FOOTER}`;
}
