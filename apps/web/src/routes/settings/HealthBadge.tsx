import type { EngineAccount } from "@caveman-app/session-protocol";
import { cn } from "@caveman-app/ui/lib/cn";

/** What a key's last test says, in a word. */
export function HealthBadge({ account }: { account: EngineAccount }) {
  const h = account.health;
  if (!h) return null;
  const [text, tone] = h.state === "ok" ? ["Working", "border-success/30 bg-success/10 text-success"] : h.state === "limited" ? ["Rate limited", "border-warning/30 bg-warning/10 text-warning"] : ["Failing", "border-destructive/30 bg-destructive/10 text-destructive"];
  return (
    <span title={h.message ? `${h.message} (checked ${new Date(h.checked_at).toLocaleString()})` : `Checked ${new Date(h.checked_at).toLocaleString()}`} className={cn("rounded-full border px-1.5 text-[11.5px] leading-[18px]", tone)}>
      {text}
    </span>
  );
}
