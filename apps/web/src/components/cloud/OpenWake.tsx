// Opening a Cloud chat's changes or its pull request while Cloud sleeps: the opening wakes it (SyncHub.wake "open"),
// the panel shows one line with its seconds ("Waking Cloud… 4s"), and loads by itself once Cloud answers. A chat on a
// Mac, or one whose computer is up, never sees any of it. Only the opening wakes: a panel left open never asks again
// once Cloud has answered, so a computer put to sleep stays asleep.
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSyncHub } from "../../state/runtime.tsx";
import { openWaitLine } from "../../state/sync/web-window.ts";

/** How often an opening that is still waiting asks Cloud again (wake.ts bounds it to one per computer per 30 s). */
const ASK_AGAIN_MS = 30_000;

export interface OpenWake {
  /** The chat's place cannot be reached now: read nothing from it, show `wait`. */
  readonly asleep: boolean;
  readonly wait: { readonly since: number; readonly failed: boolean } | null;
}

const AWAKE: OpenWake = { asleep: false, wait: null };
const noSubscribe = () => () => undefined;

/**
 * Wakes the chat's Cloud computer as its changes or pull request are opened, if it sleeps, and says how that goes.
 * `sessionId` null (no chat), a chat on a Mac, or one that answers: never asleep.
 */
export function useOpenWake(sessionId: string | null): OpenWake {
  const hub = useSyncHub();
  const [openedAt] = useState(() => Date.now());
  const key = useSyncExternalStore(
    hub ? (l) => hub.subscribe(l) : noSubscribe,
    () => {
      if (!hub || !sessionId || !hub.asleepInCloud(sessionId)) return "";
      const wait = hub.openWait(sessionId);
      return wait ? `${wait.since}|${wait.failed ? 1 : 0}` : `${openedAt}|0`;
    },
    () => "",
  );
  // The opening itself: once per chat shown here.
  useEffect(() => {
    if (hub && sessionId && hub.asleepInCloud(sessionId)) hub.wake(sessionId, "open");
  }, [hub, sessionId]);
  const waiting = key !== "";
  // Still waiting for the same opening: asked again now and then, within wake.ts's bounds.
  useEffect(() => {
    if (!waiting || !hub || !sessionId) return;
    const timer = setInterval(
      () => void (hub.openWait(sessionId) && hub.wake(sessionId, "open")),
      ASK_AGAIN_MS,
    );
    return () => clearInterval(timer);
  }, [waiting, hub, sessionId]);
  if (!waiting) return AWAKE;
  const [since, failed] = key.split("|");
  return { asleep: true, wait: { since: Number(since), failed: failed === "1" } };
}

/** The panel's one line while Cloud wakes for it; `now` is fixed on a fixture page. */
export function OpenWakeLine({
  wait,
  now,
  className,
}: {
  wait: NonNullable<OpenWake["wait"]>;
  now?: number;
  className?: string;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 1_000);
    const on = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, [now]);
  const line = openWaitLine(wait, now ?? tick, online);
  const trouble = wait.failed || !online;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-9 items-center gap-2 px-4 py-2 text-[13px] text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={
          trouble
            ? "size-1.5 shrink-0 rounded-[1px] bg-destructive"
            : "size-1.5 shrink-0 animate-pulse rounded-full bg-warning motion-reduce:animate-none"
        }
      />
      <span className="min-w-0 flex-1 tabular-nums">{line}</span>
    </div>
  );
}
