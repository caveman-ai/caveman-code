import type { SessionEvent } from "@caveman-app/session-protocol";

/** A cache-bearing usage report, not proof that the prefix is still cached. */
export interface CacheReport {
  readonly model: string;
  readonly at: string;
}

/** Usage is reported at turn end, not at the provider's exact cache refresh time. */
export function nextCacheReport(current: CacheReport | null, event: SessionEvent): CacheReport | null {
  if (event.parent_item_id) return current;
  switch (event.type) {
    case "usage":
      return event.payload.cache_read_tokens + event.payload.cache_write_tokens > 0
        ? { model: event.payload.model, at: event.at }
        : null;
    case "session.restored":
    case "compaction.started":
      return null;
    case "compaction.done":
      return event.payload.status === "completed" ? null : current;
    case "turn.started":
    case "model.routed":
      return event.payload.model && event.payload.model !== current?.model ? null : current;
    default:
      return current;
  }
}

export function cacheExpiry(report: CacheReport | null | undefined, now: number): { label: string; detail: string } {
  if (!report) return { label: "No cache reported", detail: "An estimate appears after the engine reports cached tokens." };
  const at = Date.parse(report.at);
  const model = report.model.toLowerCase().replace(/^(anthropic|openai)\//, "");
  const claude = model.startsWith("claude-");
  const openai = /^(gpt-|o[134](?:-|$))/.test(model);
  if ((!claude && !openai) || !Number.isFinite(at) || !Number.isFinite(now) || at > now) {
    return { label: "Expiry unavailable", detail: "Cache retention or timing is not known for this report." };
  }
  const age = now - at;
  const minute = 60_000;
  const detail = claude
    ? "Estimated from the last cache report using Claude’s default 5-minute retention. Reports arrive at turn end; actual expiry may be earlier or retention longer."
    : "Estimated from the last cache report using OpenAI’s typical 5–10-minute idle retention. Reports arrive at turn end; actual expiry may be earlier or retention longer.";
  const first = 5 * minute - age;
  const last = (claude ? 5 : 10) * minute - age;
  return {
    label: last <= 0 ? "Likely expired" : first <= 0 ? `May expire within ~${duration(last)}` : `~${duration(first)}${openai ? `–${duration(last)}` : ""} remaining`,
    detail,
  };
}

function duration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}
