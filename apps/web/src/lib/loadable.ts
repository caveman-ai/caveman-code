import { createElement, useEffect, useState, type ComponentProps, type ComponentType } from "react";

/**
 * A component whose module loads on first render and shows the moment it arrives (nothing until then). Not React.lazy:
 * a Suspense boundary holds a first reveal back by React's fallback throttle (~300 ms), and a side panel tab's own
 * fetch (Changes' fs.diff) starts only once it shows. A failed load throws in render, for the nearest error boundary,
 * as lazy's does.
 */
export function loadable<C extends ComponentType<any>>(load: () => Promise<{ default: C }>): C {
  let loaded: C | undefined;
  let failed: { error: unknown } | undefined;
  let pending: Promise<void> | undefined;
  const start = () =>
    (pending ??= load().then(
      (m) => void (loaded = m.default),
      (error: unknown) => void (failed = { error }),
    ));
  return function Loadable(props: ComponentProps<C>) {
    const [, arrived] = useState(0);
    useEffect(() => {
      if (loaded === undefined && failed === undefined) void start().then(() => arrived(1));
    }, []);
    if (failed) throw failed.error;
    return loaded ? createElement(loaded, props) : null;
  } as C;
}
