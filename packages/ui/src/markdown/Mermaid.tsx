// A ```mermaid fence as its diagram. ,
// apps/web/src/components/chat/MermaidDiagram.tsx @ ab3a3cd1): Mermaid (~1 MB)
// loads only once a diagram is shown, renders run one at a time (initialize()
// is global), results are cached by source and theme, and the SVG is sanitized
// on top of Mermaid's strict mode. Ours draws in the deck's tokens, so a
// diagram reads as part of the page in either theme; a diagram that doesn't
// parse shows its source and the parser's message.

import type { Mermaid as MermaidApi } from "mermaid";
import { Suspense, use, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { useDark } from "../lib/use-dark";

type Rendered = { readonly status: "rendered"; readonly svg: string } | { readonly status: "error"; readonly message: string };

let api: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let next = 0;
const MAX_CACHED = 64;
const cache = new Map<string, Promise<Rendered>>();

function load(): Promise<MermaidApi> {
  api ??= import("mermaid").then(
    (m) => m.default,
    (e: unknown) => {
      api = null;
      throw e;
    },
  );
  return api;
}

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purify: ((svg: string) => string) | null = null;

// Mermaid renders $$...$$ labels with KaTeX's MathML output (T3 #16198). These are KaTeX's MathML element
// types, without annotation (Mermaid strips it), semantics (only a wrapper, so its content is kept), and
// mglyph (a trusted-input image), and the presentation attributes KaTeX sets on them; the profiles below
// already cover class, style, width, height, display and xmlns.
const KATEX_MATHML_TAGS = new Set(["math", "menclose", "mfrac", "mi", "mlabeledtr", "mn", "mo", "mover", "mpadded", "mphantom", "mroot", "mrow", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover"]);
const KATEX_MATHML_ATTRIBUTES = new Set([
  "accent", "accentunder", "columnalign", "columnlines", "columnspacing", "depth", "displaystyle", "fence", "largeop", "linebreak", "linethickness", "lspace", "mathbackground",
  "mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "notation", "rowlines", "rowspacing", "rspace", "scriptlevel", "separator", "stretchy", "voffset",
]);

/** Nothing that can navigate, run script or fetch: no links, images or remote CSS; label text untouched. */
async function sanitize(svg: string): Promise<string> {
  if (!purify) {
    const { default: DOMPurify } = await import("dompurify");
    const p = DOMPurify(window);
    p.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && node.textContent) node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
    });
    p.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style") data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
    });
    purify = (s) =>
      p
        .sanitize(s, {
          // DOMPurify still only accepts <math> under an HTML parent (the label <div> inside <foreignObject>)
          // and checks every MathML child's namespace.
          ADD_TAGS: ["foreignObject", ...KATEX_MATHML_TAGS],
          ADD_ATTR: (attribute, tagName) => KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
          HTML_INTEGRATION_POINTS: { foreignobject: true },
          FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
          FORBID_TAGS: ["a", "img", "image", "script"],
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
        })
        // XML has no &nbsp; entity, and KaTeX writes the spaces in math as U+00A0.
        .replaceAll("&nbsp;", "&#160;");
  }
  return purify(svg);
}

/** A token as a colour Mermaid can mix: `--border: 216 9% 15%` → `hsl(216, 9%, 15%)`. */
function token(styles: CSSStyleDeclaration, name: string): string {
  const [h = "0", s = "0%", l = "50%"] = styles.getPropertyValue(`--${name}`).trim().split(/\s+/);
  return `hsl(${h}, ${s}, ${l})`;
}

function themeVariables(dark: boolean) {
  const css = getComputedStyle(document.documentElement);
  const fg = token(css, "foreground");
  const line = token(css, "muted-foreground");
  const node = token(css, "secondary");
  const border = token(css, "input");
  return {
    darkMode: dark,
    background: token(css, "background"),
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: "13px",
    primaryColor: node,
    primaryTextColor: fg,
    primaryBorderColor: border,
    secondaryColor: token(css, "muted"),
    secondaryTextColor: fg,
    secondaryBorderColor: border,
    tertiaryColor: token(css, "card"),
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    lineColor: line,
    textColor: fg,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: token(css, "card"),
    clusterBorder: token(css, "border"),
    edgeLabelBackground: token(css, "background"),
    noteBkgColor: token(css, "accent"),
    noteTextColor: fg,
    noteBorderColor: border,
    actorBkg: node,
    actorBorder: border,
    actorTextColor: fg,
    signalColor: line,
    signalTextColor: fg,
    labelBoxBkgColor: node,
    labelBoxBorderColor: border,
    labelTextColor: fg,
  };
}

async function render(source: string, dark: boolean): Promise<Rendered> {
  const id = `mermaid-${next++}`;
  let mermaid: MermaidApi;
  try {
    mermaid = await load();
  } catch {
    return { status: "error", message: "The diagram renderer failed to load." };
  }
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Labels and theme CSS mount while Mermaid lays out, before sanitizing: a diagram's own directives can't set them.
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "themeCSS", "themeVariables", "fontFamily"],
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "base",
      themeVariables: themeVariables(dark),
    });
    const { svg } = await mermaid.render(id, source);
    return { status: "rendered", svg: await sanitize(svg) };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "The diagram could not be drawn." };
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

function rendered(source: string, dark: boolean): Promise<Rendered> {
  const key = `${dark ? "dark" : "light"}\n${source}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // most recently used again
    cache.set(key, hit);
    return hit;
  }
  const result = queue.then(() => render(source, dark));
  queue = result;
  cache.set(key, result);
  // Settled entries go first; a pending one must stay, use() asks for the same promise again.
  void result.then(() => {
    for (const k of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      if (k !== key) cache.delete(k);
    }
  });
  return result;
}

/**
 * `settle`: draw only once the source has held still this long (ms). A chat
 * reply streams its fence in a character at a time; a document is whole.
 */
export function Mermaid({ source, settle = 0, className }: { source: string; settle?: number; className?: string }) {
  const trimmed = source.trim();
  const [settled, setSettled] = useState(settle ? null : trimmed);
  useEffect(() => {
    if (!settle) return setSettled(trimmed);
    const t = setTimeout(() => setSettled(trimmed), settle);
    return () => clearTimeout(t);
  }, [trimmed, settle]);
  const waiting = <div role="status" aria-label="Drawing the diagram" className="h-24 animate-pulse rounded-md bg-muted" />;
  return (
    <div data-slot="mermaid" data-mermaid-source={trimmed} className={cn("my-4 overflow-x-auto rounded-lg border border-border bg-card px-4 py-5 first:mt-0 last:mb-0", className)}>
      {settled === null ? waiting : <Suspense fallback={waiting}><Diagram source={settled} /></Suspense>}
    </div>
  );
}

function Diagram({ source }: { source: string }) {
  const result = use(rendered(source, useDark()));
  if (result.status === "error") {
    return (
      <div>
        <p className="text-[12.5px] text-destructive">This diagram doesn't parse: {result.message.split("\n")[0]}</p>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-muted-foreground">{source}</pre>
      </div>
    );
  }
  // Mermaid labels its SVG itself (graphics-document roles, accTitle and accDescr when the diagram sets them).
  return <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: result.svg }} />;
}
