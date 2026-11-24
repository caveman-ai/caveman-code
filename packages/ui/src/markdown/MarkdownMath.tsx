// A formula in markdown (`$x$`, `$$x$$`, `\(x\)`, `\[x\]`, a ```math fence),
// typeset with KaTeX. ),
// apps/web/src/components/chat/MarkdownMath.tsx @ cb0553ea39. KaTeX (~280 KB
// with its fonts) loads in its own chunk the first time a formula shows; until
// then, and for TeX it can't parse (mid-stream, or unsupported), the formula
// shows as its source. A wide one scrolls sideways in its own box.
import { memo, Suspense, use, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Typeset = (tex: string, display: boolean) => string;
let typesetter: Promise<Typeset | null> | null = null;

function load(): Promise<Typeset | null> {
  typesetter ??= import("./math-typeset").then(
    (m) => m.typeset,
    () => {
      // Offline or a stale deploy: the source stays, and the next formula tries again.
      typesetter = null;
      return null;
    },
  );
  return typesetter;
}

export const MarkdownMath = memo(function MarkdownMath({ tex, display }: { tex: string; display: boolean }) {
  // A formula is a Tab stop only while it is wider than its box, so the arrows can scroll it; one that fits is passed
 // over, as text is (upstream #23954). Typesetting and streamed TeX change the width without resizing the box.
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const box = viewport.current;
    const inner = content.current;
    if (!box || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  const t = tex.trim();
  const source = display ? `\\[\n${t}\n\\]` : `\\(${t}\\)`;
  const fallback = <span className="whitespace-pre-wrap font-mono text-[0.88em] text-muted-foreground">{source}</span>;
  return (
    <span
      data-slot="math"
      data-math={display ? "display" : "inline"}
      data-math-source={source}
      role="group"
      aria-label={display ? "Display equation" : "Inline equation"}
      dir="ltr"
      className={display ? "my-3 block first:mt-0 last:mb-0 [&_.katex-display]:m-0" : "inline-block max-w-full whitespace-nowrap align-middle"}
    >
      <span
        ref={viewport}
        tabIndex={overflows ? 0 : undefined}
        aria-label={overflows ? (display ? "Scroll display equation" : "Scroll inline equation") : undefined}
        className="block max-w-full overflow-x-auto overflow-y-hidden rounded-sm px-0.5 py-[3px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span ref={content} className={display ? "inline-block w-max min-w-full" : "inline-block w-max"}>
          <Suspense fallback={fallback}>
            <Typeset tex={t} display={display} fallback={fallback} />
          </Suspense>
        </span>
      </span>
    </span>
  );
});

function Typeset({ tex, display, fallback }: { tex: string; display: boolean; fallback: ReactNode }) {
  const html = use(load())?.(tex, display) ?? "";
  // KaTeX escapes the TeX it renders, and `trust: false` keeps it from emitting links or attributes.
  return html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : fallback;
}
