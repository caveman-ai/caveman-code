// Small marks the Automations pages share: what starts an automation (the GitHub mark, a clock, a
// webhook), where it runs, a run's state.
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { PixelIcon, StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import type { Mark, RunStatus, StepStatus } from "./model.ts";
import { RUN_WORD, STEP_WORD } from "./model.ts";
import { CHROME_ICON } from "@caveman-app/ui/icons/Glyph";
import { Icon, Clock01Icon, WebhookIcon } from "@caveman-app/ui/icons/huge";

const MARK_LABEL: Record<Mark, string> = { github: "GitHub", schedule: "Schedule", webhook: "Webhook", manual: "By hand" };

/** What starts it: GitHub's own mark, else a clock, a webhook or the bolt. */
export function TriggerMark({ mark, scale = 1, className }: { mark: Mark; scale?: 1 | 2; className?: string }) {
  const label = MARK_LABEL[mark];
  if (mark === "github") return <BrandMark name="github" size={16 * scale} label={label} className={cn("shrink-0 text-foreground", className)} />;
  const icon = mark === "schedule" ? Clock01Icon : mark === "webhook" ? WebhookIcon : CHROME_ICON.automations;
  return <Icon icon={icon} aria-label={label} className={cn(scale === 2 ? "size-8" : "size-4", "shrink-0 text-foreground/80", className)} />;
}

/** A template's or chip's mark, from its trigger chips. */
export const chipMark = (chips: ReadonlyArray<string>): Mark => (chips.includes("GitHub") ? "github" : chips.includes("Schedule") ? "schedule" : chips.includes("Webhook") ? "webhook" : "manual");

/** On, but its triggers don't fire: the amber dot. */
export const WarnDot = ({ className }: { className?: string }) => <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-warning", className)} />;

/** A run's or step's state as its pixel glyph; a running one's wheel turns. */
export function StateGlyph({ status, className }: { status: RunStatus | StepStatus; className?: string }) {
  const word = status in RUN_WORD ? RUN_WORD[status as RunStatus] : STEP_WORD[status as StepStatus];
  const glyph =
    status === "running" ? (
      <StateMark name="state-working" animate />
    ) : (
      <PixelIcon
        name={status === "succeeded" ? "state-done" : status === "failed" ? "state-failed" : status === "cancelled" || status === "skipped" ? "state-sleeping" : "state-queued"}
        {...(status === "skipped" || status === "pending" ? { className: "opacity-50" } : {})}
      />
    );
  return (
    <span role="img" aria-label={word} title={word} className={cn("inline-flex shrink-0", className)}>
      {glyph}
    </span>
  );
}
