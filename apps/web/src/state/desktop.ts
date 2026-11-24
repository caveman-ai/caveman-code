// What the desktop shell's preload adds for Settings > General, Settings >
// Chief, the first run and the image viewer
// (apps/desktop/src/{updates/,cli,telemetry,capture,media}.ts). Absent in a browser. The types are the desktop
// package's own (apps/desktop/src/bridge.ts), re-exported here for the web files that name them.

import { useEffect, useState } from "react";

export type {
  AttachedRuntime,
  CaptureShortcutState,
  CliStatus,
  DesktopCapture,
  DesktopCli,
  DesktopCrashReports,
  DesktopMedia,
  DesktopPower,
  DesktopTelemetry,
  DesktopUpdates,
  PowerState,
  TelemetryChoice,
  UpdateChannel,
  UpdateReleaseNote,
  UpdateState,
} from "@caveman-app/desktop/bridge";

/** The onboarding funnel's steps, as the desktop's allow-list names them (apps/desktop src/telemetry.ts ONBOARDING_STEPS). */
export type FunnelStep =
  | "welcome_shown"
  | "first_workspace"
  | "signed_in"
  | "setup_shown"
  | "project_ready"
  | "tour_done"
  | "tour_replayed"
  | "unlock_shown"
  | "unlock_started"
  | "unlocked"
  // The later offers, each counted on its own (components/Offers.tsx).
  | "offer_window_shown"
  | "offer_window_unlock"
  | "offer_lid_shown"
  | "offer_lid_unlock"
  | "offer_chief_shown"
  | "offer_chief_unlock"
  | "offer_gift_shown"
  | "offer_gift_open";

/** One onboarding funnel step; the desktop sends each once per install and ignores names it does not know. */
export const funnelStep = (name: FunnelStep): void => window.cavemanDesktop?.telemetry?.step(name);

/** Counts one page crash by its error's name alone (TypeError, …); the desktop logs nothing else of it. */
export const countPageCrash = (error: unknown): void =>
  window.cavemanDesktop?.telemetry?.crash(error instanceof Error ? error.name : "NonError");

/** Counts uncaught page errors (countPageCrash). */
export function reportPageErrors(): void {
  if (!window.cavemanDesktop?.telemetry) return;
  window.addEventListener("error", (event) => countPageCrash(event.error));
  window.addEventListener("unhandledrejection", (event) => countPageCrash(event.reason));
}

/**
 * The downloaded update's version once a restart installs it, else null. The app rarely quits on a Mac (closing the
 * window keeps it running), so a ready update would otherwise wait in Settings > General for days.
 */
export function useUpdateReady(): string | null {
  const updates = window.cavemanDesktop?.updates;
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    const read = () =>
      void updates.state().then(
        (s) => live && setNext(s?.status === "ready" ? (s.next ?? s.version) : null),
        () => undefined,
      );
    read();
    const timer = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [updates]);
  return next;
}
