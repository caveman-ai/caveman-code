// The developer overlay for S14's latency budgets: this device's rolling p50/p95 per path and per way it went. Off by
// default; ⌃⌥⇧L (or localStorage caveman.latencyOverlay = "1") shows it. Durations only, measured on this device.
import { useEffect, useState, useSyncExternalStore } from "react";
import { latency, type LatencyPath, type LatencyStat, type LatencyVia } from "../state/sync/latency.ts";

const KEY = "caveman.latencyOverlay";
const subscribe = (listener: () => void) => latency.subscribe(listener);
const PATH: Record<LatencyPath, string> = { event: "Event, commit to here", send: "Send to accepted", open: "Open to first content", status: "Status, runtime to here" };

/** S14's budgets where this device can hold one alone (the others depend on the round trip). */
export function budgetOf(path: LatencyPath, via: LatencyVia): number | null {
  if (path === "event" && (via === "direct" || via === "loopback")) return 50;
  if (path === "open" && via === "cache") return 100;
  return null;
}

export function LatencyOverlay() {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === "KeyL")) return;
      e.preventDefault();
      setShown((was) => {
        const next = !was;
        try {
          if (next) localStorage.setItem(KEY, "1");
          else localStorage.removeItem(KEY);
        } catch {
          // A storage that refuses: the overlay still toggles for this window.
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The meter's own snapshot (one array per sample), so React re-renders on each new sample.
  const stats: ReadonlyArray<LatencyStat> = useSyncExternalStore(subscribe, latency.snapshot);
  if (!shown) return null;
  return (
    <div role="status" aria-label="Latency" className="pointer-events-auto fixed bottom-3 right-3 z-50 w-[360px] rounded-xl border border-border bg-popover p-3 text-[12px] text-popover-foreground shadow-overlay">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Latency on this device</span>
        <button type="button" className="rounded-md px-1.5 text-muted-foreground hover:bg-accent" onClick={() => latency.clear()}>
          Clear
        </button>
      </div>
      {stats.length === 0 ? (
        <div className="text-muted-foreground">Nothing measured yet.</div>
      ) : (
        <table className="w-full tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-normal">Path</th>
              <th className="text-left font-normal">Way</th>
              <th className="text-right font-normal">p50</th>
              <th className="text-right font-normal">p95</th>
              <th className="text-right font-normal">n</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => {
              const budget = budgetOf(s.path, s.via);
              return (
                <tr key={`${s.path}|${s.via}`}>
                  <td className="py-0.5 pr-2">{PATH[s.path]}</td>
                  <td className="pr-2 text-muted-foreground">{s.via}</td>
                  <td className={`text-right ${budget !== null && s.p50 > budget ? "text-destructive" : ""}`}>{s.p50} ms</td>
                  <td className="text-right">{s.p95} ms</td>
                  <td className="text-right text-muted-foreground">{s.count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
