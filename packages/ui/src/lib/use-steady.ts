import { useEffect, useRef, useState } from "react";

/**
 * `value`, changing at most once every `ms`: a burst of updates (six web searches in a second, a step that starts as
 * the last one ends) reads as a steady line rather than a flicker. The latest value always lands, at most `ms` late.
 * `ms` of 0 passes `value` straight through, so a run that has ended shows exactly how it ended. `hold` keeps the
 * shown value a while longer before it becomes `value`: a step's words staying through the gap before the next step.
 */
export function useSteady<T>(value: T, ms: number, hold: (from: T, to: T) => number = () => 0): T {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  const latest = useRef(hold);
  latest.current = hold;
  useEffect(() => {
    if (ms <= 0 || Object.is(value, shown)) return;
    const wait = Math.max(latest.current(shown, value), ms - (performance.now() - at.current));
    const show = () => {
      at.current = performance.now();
      setShown(value);
    };
    if (wait <= 0) return show();
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, ms]);
  return ms <= 0 ? value : shown;
}
