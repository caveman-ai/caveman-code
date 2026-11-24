// The annotator, loaded when a picture is first marked up, so the chat and the
// box never wait on it. A load that fails (the network dropped, or the app was
// updated under the open page and the old build's file is gone) and a crash
// inside it both stop here: a small dialog says so and offers to try again,
// and the app around it carries on. Without this the failure would unmount the
// whole app. Asking again does fetch again (checked in Chromium: a failed
// import is not kept), so a dropped connection recovers in place; a file that
// is gone for good never comes, and then a reload is offered.
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Component, lazy, Suspense, useState, type ComponentProps, type ErrorInfo, type ReactNode } from "react";
import { isStaleChunk } from "../../lib/stale-chunk.ts";
import type { Annotator } from "./Annotator.tsx";

/**
 * Shared by every opening. A lazy component keeps a failed load for good, so one that fails is replaced at once:
 * trying again, or opening another picture later, asks afresh.
 */
let shared = fresh();
function fresh() {
  return lazy(() =>
    import("./Annotator.tsx").then(
      (m) => ({ default: m.Annotator }),
      (error: unknown) => {
        shared = fresh();
        throw error;
      },
    ),
  );
}

export function LazyAnnotator(props: ComponentProps<typeof Annotator>) {
  const [Loaded, setLoaded] = useState(() => shared);
  const [retried, setRetried] = useState(false);
  return (
    <Caught
      fallback={(error, reset) => {
        // Asked again and its file still didn't come: either the connection is still down, or this page is an older
        // build's and only a reload has the new one.
        const stale = retried && isStaleChunk(error);
        return (
          <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent size="sm">
              <DialogHeader>
                <DialogTitle>{stale ? "Marking up still didn't load" : "Marking up didn't open"}</DialogTitle>
                <DialogDescription>
                  {stale
                    ? "If Caveman Code was just updated, a reload brings the new version: what you typed is kept, files you attached need attaching again."
                    : isStaleChunk(error)
                      ? "It couldn't be loaded. Check the connection, then try again."
                      : error.message || "Something went wrong in it."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
                  Close
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    if (stale) return location.reload();
                    setLoaded(shared);
                    setRetried(true);
                    reset();
                  }}
                >
                  {stale ? "Reload" : "Try again"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      }}
    >
      <Suspense fallback={null}>
        <Loaded {...props} />
      </Suspense>
    </Caught>
  );
}

/** What fails under it shows `fallback` in its place; `reset` renders what is under it again. */
class Caught extends Component<{ children: ReactNode; fallback: (error: Error, reset: () => void) => ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("annotator failed", error, info.componentStack);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}
