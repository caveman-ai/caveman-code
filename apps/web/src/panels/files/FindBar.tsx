// Find in what a panel shows (a document, a file, an artifact): the chat's find
// bar and matching (components/find), floating at the panel's top right. Matches
// are lit with the CSS Custom Highlight API, so nothing rewrites the DOM React
// owns, and follow the content as it changes (a refreshed file, a diagram drawn
// late).

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { FindBar as Bar } from "../../components/find/FindBar.tsx";
import { stepHit, textRanges } from "../../components/find/chat-find.ts";

const ALL = "panel-find";
const CURRENT = "panel-find-current";
const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null);

export function FindBar({ root, onClose, label = "Find" }: { root: RefObject<HTMLElement | null>; onClose: () => void; label?: string }) {
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);

  // Matches, again whenever the content under `root` changes.
  useEffect(() => {
    const el = root.current;
    const q = query.trim();
    if (!el || !q) return setRanges([]);
    let frame = 0;
    const scan = () => {
      frame = 0;
      setRanges(textRanges(el, q));
    };
    scan();
    const mo = new MutationObserver(() => (frame ||= requestAnimationFrame(scan)));
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [root, query]);
  useEffect(() => setAt(0), [query]);

  const current = ranges.length ? Math.min(at, ranges.length - 1) : -1;
  useLayoutEffect(() => {
    const reg = highlights();
    if (!reg) return;
    reg.set(ALL, new Highlight(...ranges));
    if (current >= 0) {
      reg.set(CURRENT, new Highlight(ranges[current]!));
      const box = ranges[current]!.getBoundingClientRect();
      const host = ranges[current]!.startContainer.parentElement;
      // Into view only when it isn't: stepping through visible matches keeps the page still.
      if (host && (box.top < 0 || box.bottom > innerHeight || box.height === 0)) host.scrollIntoView({ block: "center" });
      else host?.scrollIntoView({ block: "nearest" });
    } else reg.delete(CURRENT);
    return () => {
      reg.delete(ALL);
      reg.delete(CURRENT);
    };
  }, [ranges, current]);

  return (
    // Over the content's top right; takes no height of its own.
    <div className="relative z-30 h-0">
      <div className="pointer-events-none absolute right-3 top-2 flex">
        <Bar query={query} index={Math.max(0, current)} total={ranges.length} onQuery={setQuery} onStep={(delta) => setAt(stepHit(current, ranges.length, delta))} onClose={onClose} focusKey={0} label={label} />
      </div>
    </div>
  );
}

/** ⌘F (Ctrl+F elsewhere) inside a panel surface. */
export const isFindChord = (e: KeyboardEvent | React.KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";
