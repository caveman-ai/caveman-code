// One tab's surface, wherever it shows: the side panel's active tab, or a pane of its own in the split view
// (components/pane/TabPane.tsx). A failing surface shows its error in its own place; the rest keeps working.

import { Component, memo, Suspense, type ErrorInfo, type ReactNode } from "react";
import { QuietButton, SurfaceEmpty } from "./chrome.tsx";
import { useSurfaceDef } from "./registry.ts";
import type { Tab } from "./store.ts";
import { isStaleChunk } from "../lib/stale-chunk.ts";
import "./surfaces.tsx";

// Memoized: a title change in one tab re-renders that tab only.
export const SurfaceHost = memo(function SurfaceHost({ workspaceId, tab, active }: { workspaceId: string; tab: Tab; active: boolean }) {
  const def = useSurfaceDef(tab.kind);
  if (!def) return <SurfaceEmpty title="Unavailable">This tab's kind isn't part of this version of the app.</SurfaceEmpty>;
  const Surface = def.component;
  return (
    <SurfaceBoundary>
      <Suspense fallback={null}>
        <Surface workspaceId={workspaceId} tab={tab as never} active={active} />
      </Suspense>
    </SurfaceBoundary>
  );
});

/** One failing surface shows an error in its own tab; the panel and the other tabs keep working. */
class SurfaceBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("side panel surface failed", error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    // The app was updated under this page: retrying the tab fails again, a reload brings the new build (drafts are kept).
    if (isStaleChunk(this.state.error))
      return (
        <SurfaceEmpty title="Caveman Code was updated" action={<QuietButton onClick={() => location.reload()}>Reload</QuietButton>}>
          This tab needs the new version.
        </SurfaceEmpty>
      );
    return (
      <SurfaceEmpty title="This tab stopped working" action={<QuietButton onClick={() => this.setState({ error: null })}>Reload tab</QuietButton>}>
        {this.state.error.message}
      </SurfaceEmpty>
    );
  }
}
