// A reference to another thread inside TurnInput.text, in upstream composer-context
// link form: `[label](t3-context://v1/thread/<workspace_id>)`. The link carries
// position and identity; the label is display text only. The runtime resolves
// the workspace and hands the engine a digest of that thread.

const PREFIX = "t3-context://v1/thread/";
const LINK = /\[([^\]\n]{0,512})\]\(t3-context:\/\/v1\/thread\/([a-z0-9_-]{1,128})\)/gi;
const LABEL_MAX = 200;

export interface ThreadReference {
  readonly workspace_id: string;
  readonly label: string;
  /** The link's span in the text. */
  readonly start: number;
  readonly end: number;
}

/** Cut at `max` UTF-16 units, never through a surrogate pair (a lone surrogate fails provider requests). */
const truncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};

/** Labels must survive a Markdown link: no brackets, backslashes or line breaks, never empty. */
const cleanLabel = (label: string) =>
  truncate(label.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim(), LABEL_MAX) || "thread";

export const formatThreadReference = (workspace_id: string, title: string): string =>
  `[${cleanLabel(title)}](${PREFIX}${workspace_id})`;

export const parseThreadReferences = (text: string): ThreadReference[] =>
  text.includes(PREFIX)
    ? [...text.matchAll(LINK)].map((match) => ({
        workspace_id: match[2]!,
        label: cleanLabel(match[1]!),
        start: match.index,
        end: match.index + match[0].length,
      }))
    : [];
