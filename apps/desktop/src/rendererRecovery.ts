// A crashed or killed-for-memory page reloads instead of leaving an empty
// translucent window until the person finds View > Reload. Bounded, as T3
// Code's main window does (window/DesktopWindow.ts render-process-gone, MIT,
// 13aa882c22): a page that dies again and again at boot gets a dialog
// instead of a reload loop. Electron-free, so it tests without Electron.

export const RECOVERY_MAX = 3;
export const RECOVERY_WINDOW_MS = 5 * 60_000;
export const RECOVERY_DELAY_MS = 500;

/** Electron's RenderProcessGoneDetails reasons a reload can fix (killed: by macOS or Activity Monitor); clean-exit was meant. */
const RECOVERABLE = new Set(["crashed", "oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure"]);

/** Remembers recent recoveries; `next` says whether this one reloads. */
export class RendererRecovery {
  private times: number[] = [];

  next(reason: string, now: number): "reload" | "give-up" | "ignore" {
    if (!RECOVERABLE.has(reason)) return "ignore";
    this.times = this.times.filter((t) => now - t < RECOVERY_WINDOW_MS);
    if (this.times.length >= RECOVERY_MAX) return "give-up";
    this.times.push(now);
    return "reload";
  }
}
