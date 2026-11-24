// Punctuation right after a file chip stays on the chip's line. ),
// apps/web/src/components/chat/markdownChipPunctuation.ts @ fd08b170b6 (#26871).
// A chip is an inline-flex button (apps/web FileChip), and browsers allow a wrap after one even
// before punctuation: "see `retry.go`." could leave the period alone at the start of the next line.
// The chip (an inline `code` or a link) and the punctuation after it go into one span that keeps them
// together, only when it holds a chip: a long plain link still wraps.
type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const LEADING_PUNCTUATION = /^[.,:;!?…)\]}"'’”]+/;

/** The class on the pair: no wrap inside it, when it holds a file chip (data-slot="file-chip"). */
export const CHIP_PAIR_CLASS = "has-[[data-slot=file-chip]]:whitespace-nowrap";

export function rehypeChipPunctuation() {
  const visit = (node: HastNode): void => {
    if (node.tagName === "pre" || !node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      visit(child);
      const previous = children.at(-1);
      const punctuation =
        child.type === "text" && (previous?.tagName === "a" || previous?.tagName === "code")
          ? LEADING_PUNCTUATION.exec(child.value ?? "")?.[0]
          : undefined;
      if (!previous || !punctuation) {
        children.push(child);
        continue;
      }
      children[children.length - 1] = {
        type: "element",
        tagName: "span",
        properties: { className: [CHIP_PAIR_CLASS] },
        children: [previous, { type: "text", value: punctuation }],
      };
      const rest = (child.value ?? "").slice(punctuation.length);
      if (rest) children.push({ ...child, value: rest });
    }
    node.children = children;
  };
  return visit;
}
