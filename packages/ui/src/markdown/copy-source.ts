// Copying rendered markdown that holds a drawing of its source: a Mermaid
// diagram (its SVG labels) or a formula (KaTeX's glyphs and hidden MathML).
// The clipboard gets the source instead (T3 #16249, #18735): a selection inside
// one copies its source; one around it copies the text with each in its place,
// a diagram as its fence and a formula between its TeX delimiters.
import type { ClipboardEvent } from "react";

const SOURCE = "[data-mermaid-source],[data-math-source]";

function sourceOf(element: HTMLElement, alone: boolean): string {
  const diagram = element.dataset.mermaidSource;
  if (diagram !== undefined) return alone ? diagram : `\`\`\`mermaid\n${diagram}\n\`\`\``;
  return element.dataset.mathSource ?? "";
}

/** Put on the element that holds the markdown (`onCopy`). */
export function copyMarkdownSource(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const held = [...event.currentTarget.querySelectorAll<HTMLElement>(SOURCE)].some((d) => selection.containsNode(d, true));
  if (!held) return;
  const texts: string[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const ancestor = range.commonAncestorContainer;
    const inside = (ancestor instanceof Element ? ancestor : ancestor.parentElement)?.closest<HTMLElement>(SOURCE);
    if (inside) {
      texts.push(sourceOf(inside, true));
      continue;
    }
    // Lay the copy out off-screen so its text keeps the page's line breaks, each drawing as its source.
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-99999px;top:0;white-space:normal;";
    holder.appendChild(range.cloneContents());
    for (const element of holder.querySelectorAll<HTMLElement>(SOURCE)) {
      const block = element.dataset.mermaidSource !== undefined || element.dataset.math === "display";
      const replacement = document.createElement(block ? "pre" : "span");
      replacement.textContent = sourceOf(element, false);
      element.replaceWith(replacement);
    }
    document.body.appendChild(holder);
    texts.push(holder.innerText);
    holder.remove();
  }
  event.clipboardData.setData("text/plain", texts.join("\n"));
  event.preventDefault();
}
