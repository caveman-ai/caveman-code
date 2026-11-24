// Line comments on the Changes tab (Claude Desktop's review comments, upstream): click a line, say what to change,
// and the comments go to the chat's box as one message the person sends. Nothing new in the protocol: the agent reads
// them as an ordinary message.

export interface LineComment {
  readonly path: string;
  /** "new" for an added or unchanged line (its line in the file now), "old" for a deleted one. */
  readonly side: "new" | "old";
  readonly line: number;
  /** The line's text when commented, so the agent finds it even after the numbers move. */
  readonly code: string;
  readonly text: string;
}

export const commentKey = (c: Pick<LineComment, "path" | "side" | "line">): string => `${c.path}\0${c.side}\0${c.line}`;

/** A line holds any number of comments: saving one adds it under those already shown there. */
export const withComment = (comments: ReadonlyArray<LineComment>, anchor: Omit<LineComment, "text">, text: string): ReadonlyArray<LineComment> => [...comments, { ...anchor, text }];

/** Remove takes away the one comment it stands beside, not the rest of its line's. */
export const withoutComment = (comments: ReadonlyArray<LineComment>, comment: LineComment): ReadonlyArray<LineComment> => comments.filter((c) => c !== comment);

/** The message the comments become, in file and line order. */
export function reviewMessage(comments: ReadonlyArray<LineComment>): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side));
  const blocks = sorted.map((c) => {
    const where = c.side === "old" ? `${c.path}, removed line ${c.line}` : `${c.path}:${c.line}`;
    const code = c.code.trim() ? `\n\`${c.code.trim().replace(/`/g, "'")}\`` : "";
    return `${where}${code}\n${c.text.trim()}`;
  });
  return `Review comments on the changes:\n\n${blocks.join("\n\n")}`;
}

/** Comments kept per chat while the app is open, so closing the Changes tab doesn't lose them. */
const kept = new Map<string, ReadonlyArray<LineComment>>();
export const keptComments = (workspaceId: string): ReadonlyArray<LineComment> => kept.get(workspaceId) ?? [];
export const keepComments = (workspaceId: string, comments: ReadonlyArray<LineComment>): void => {
  if (comments.length) kept.set(workspaceId, comments);
  else kept.delete(workspaceId);
};
