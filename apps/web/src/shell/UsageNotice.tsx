import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useState } from "react";
import type { TelemetryChoice } from "../state/desktop.ts";

/**
 * Once, for an install whose onboarding showed an older usage line: what is sent now that it did not name. Turn stats
 * (docs/ "Privacy") count, and crash reports with their stack go
 * (docs/), only from the moment this, the onboarding line or Settings has named them; until
 * then the desktop holds crash reports in memory. Turn off stops all of it.
 */
export function UsageNotice() {
  const telemetry = window.cavemanDesktop?.telemetry;
  const [choice, setChoice] = useState<TelemetryChoice | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void telemetry?.choice().then((next) => {
      setChoice(next);
      if (
        next &&
        next.enabled &&
        !next.envOff &&
        !next.dryRun &&
        (next.turnsDisclosed === false || next.reportsDisclosed === false)
      )
        setOpen(true);
    });
  }, [telemetry]);
  // It counts as shown once the window is: a window that opened hidden (at login) shows it later.
  useEffect(() => {
    if (!open) return;
    const shown = () => {
      if (document.visibilityState !== "visible") return false;
      telemetry?.disclosed?.();
      return true;
    };
    if (shown()) return;
    const onChange = () => {
      if (shown()) document.removeEventListener("visibilitychange", onChange);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [open, telemetry]);
  if (!telemetry || !choice || !open) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-[640px] items-center gap-3 rounded-xl border border-border bg-popover py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px] text-popover-foreground shadow-overlay">
        <span>{noticeText(choice)}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void telemetry.set(false).then(() => setOpen(false))}
          >
            Turn off
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What the notice names: whichever of turn stats and crash reports an older line left out. */
export const noticeText = (
  choice: Pick<TelemetryChoice, "turnsDisclosed" | "reportsDisclosed">,
): string => {
  const turns = choice.turnsDisclosed === false;
  const reports = choice.reportsDisclosed === false;
  if (turns && reports)
    return "Usage stats now include how each turn went (engine, model, effort, timings and counts), and crash reports where the app failed: the error and its stack, with secrets and your home folder taken out. Never prompts or code.";
  if (reports)
    return "Crash reports now include where the app failed: the error and its stack, with secrets, emails and your home folder taken out, sent to Sentry, our crash service. Never prompts or code.";
  return "Usage stats now include how each turn went: engine, model, effort, timings and counts. Never prompts, code or paths.";
};
