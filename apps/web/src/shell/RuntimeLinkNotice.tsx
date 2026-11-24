import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useState } from "react";
import { useUpdateNow } from "../panels/live/OlderImage.tsx";
import { CLOUD_HOSTED, forgetRuntime, linkNotice, useComputersCloud, useRuntimeLink, useRuntimeSkew } from "../state/runtime.tsx";
import { ReportButton } from "../components/ReportButton.tsx";
import { skewSentence, type SkewedRuntime } from "../state/skew.ts";

/** A start or a blip shorter than this says nothing. */
const GRACE_MS = 2_500;

const NOTICE = "pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-popover py-1.5 pl-3 pr-1.5 text-[13px] text-popover-foreground shadow-overlay";

/**
 * One line over the app while this computer's runtime is out of reach: the
 * client keeps retrying and the screen keeps what it last showed, so without it
 * a refused link or a stopped runtime looked like an empty app. Served by
 * Caveman Cloud, the relay's own errors say it instead (FirstRun.tsx). While the
 * link is up, it says when a runtime this window talks to runs a Caveman Code
 * this client doesn't work with (state/skew.ts), here and on the web alike.
 */
export function RuntimeLinkNotice() {
  const link = useRuntimeLink();
  const text = CLOUD_HOSTED ? null : linkNotice(link, window.cavemanDesktop !== undefined);
  const skewed = useRuntimeSkew();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!text) return;
    // A refusal is the answer, not a blip: say it at once.
    const timer = setTimeout(() => setShown(true), link.refused ? 0 : GRACE_MS);
    return () => clearTimeout(timer);
  }, [text, link.refused]);
  if (CLOUD_HOSTED) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      {shown && text ? (
        <div className={NOTICE}>
          {/* Pulsing while it retries; still once refused, since nothing more is tried. */}
          <span aria-hidden className={link.refused ? "size-1.5 shrink-0 rounded-full bg-destructive" : "size-1.5 shrink-0 animate-pulse rounded-full bg-warning motion-reduce:animate-none"} />
          <span>{text}</span>
          <ReportButton request={{ surface: "runtime", error: { name: "RuntimeUnreachable", message: text } }} />
          {/* A browser tab can take a new link (the runtime prints one each start); the desktop restarts its own. */}
          {window.cavemanDesktop ? null : (
            <Button
              size="sm"
              variant={link.refused ? "default" : "ghost"}
              onClick={() => {
                forgetRuntime();
                window.location.reload();
              }}
            >
              Use another link
            </Button>
          )}
        </div>
      ) : link.open && skewed ? (
        // Keyed by computer: Update now's state belongs to the one it was asked for.
        <SkewNotice key={`${skewed.computerId ?? skewed.name}:${skewed.skew}`} skewed={skewed} />
      ) : null}
    </div>
  );
}

/** The sentence, and the one thing to do about it this client can do: Update now on a Cloud computer, a page's reload. */
function SkewNotice({ skewed }: { skewed: SkewedRuntime }) {
  const desktop = window.cavemanDesktop !== undefined;
  const cloudApi = useComputersCloud();
  const older = skewed.skew === "runtime_older" && skewed.kind === "cloud";
  const { state, ask } = useUpdateNow(older ? skewed.computerId : undefined, cloudApi ? (id) => cloudApi.update(id) : undefined);
  const said = state.step === "asked" ? `${skewed.name} restarts on the new image when it is idle.` : state.step === "failed" ? state.message : skewSentence(skewed, desktop);
  return (
    <div className={NOTICE}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span>{said}</span>
      {ask ? (
        <Button size="sm" variant="ghost" onClick={ask} disabled={state.step === "asking"}>
          {state.step === "asking" ? "Updating" : "Update now"}
        </Button>
      ) : skewed.skew === "client_older" && !desktop ? (
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          Reload
        </Button>
      ) : null}
    </div>
  );
}
