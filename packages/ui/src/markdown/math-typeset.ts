// KaTeX and its stylesheet and fonts, in their own chunk: only a reply or a
// document that holds a formula loads them (MarkdownMath). 
// (MIT), apps/web/src/components/chat/MathTypeset.tsx @ cb0553ea39.
import katex from "katex";
import "katex/dist/katex.min.css";

// Rendered markup by formula, so a block that renders again doesn't typeset again; "" records a parse error.
const MAX_CACHED = 1000;
const cache = new Map<string, string>();

/** A formula as KaTeX's HTML (with MathML for screen readers); "" when it doesn't parse, unfinished mid-stream or unsupported. */
export function typeset(tex: string, display: boolean): string {
  const key = `${display ? "display" : "inline"}:${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let html = "";
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      // No \href, \url, \htmlClass, or any other command that emits active HTML.
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    // Shown as its TeX.
  }
  cache.set(key, html);
  for (const k of cache.keys()) {
    if (cache.size <= MAX_CACHED) break;
    cache.delete(k);
  }
  return html;
}
