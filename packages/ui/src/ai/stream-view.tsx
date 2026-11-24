import * as React from "react";

const initial = {};
const View = React.createContext<object>(initial);

/**
 * A transcript returning from React Activity paints its current snapshot before
 * the browser paints. Output received while away is history, not a new stream.
 * `revision` also marks history delivered by a reattached session feed.
 */
export function StreamView({ children, revision = 0 }: { children: React.ReactNode; revision?: number }) {
  const [activation, setActivation] = React.useState(0);
  React.useLayoutEffect(() => {
    // Also cover a pane pre-rendered while hidden before its first show.
    setActivation((n) => n + 1);
  }, []);
  const snapshot = React.useMemo(() => ({ activation, revision }), [activation, revision]);
  return <View.Provider value={snapshot}>{children}</View.Provider>;
}

export const useStreamView = () => React.useContext(View);
