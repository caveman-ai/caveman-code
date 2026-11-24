// ), apps/web/src/hooks/useStableCallback.ts @ 7e850a03c2
import { useInsertionEffect, useRef, useState } from "react";

/**
 * A function whose identity never changes and that always runs the latest `fn`: a handler a memoized child (or the
 * React Compiler) can keep while the parent re-renders on every streamed token. Only call it from event handlers and
 * effects; during render it would see the previous commit's `fn`. The forwarder is created once so its identity does
 * not depend on the React Compiler, and it keeps no render scope alive: V8 shares one scope between all closures of a
 * render.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(fn);
  // Insertion effects run before every layout effect in the commit, so a
  // child's layout effect already calls this render's fn.
  useInsertionEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  );
  return stable;
}
