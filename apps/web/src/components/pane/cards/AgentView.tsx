import { Conversation } from "@caveman-app/ui/ai/conversation";
import { RunnerMark, RunnerModel } from "@caveman-app/ui/components/runner-badge";
import { cn } from "@caveman-app/ui/lib/cn";
import { Markdown } from "@caveman-app/ui/markdown/Markdown";
import { Icon, ArrowLeft01Icon, ArrowRight01Icon, SquareIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, type ReactNode } from "react";
import { MARK } from "../../../panels/agents/states.ts";
import type { AskReply } from "../../../state/grill.ts";
import { clock } from "../../../state/now.ts";
import type { TranscriptItem } from "../../../state/transcript-model.ts";
import { Transcript } from "../../Transcript.tsx";
import type { AgentRowView } from "./AgentsCard.tsx";

// One agent opened from the Overview's Agents card: its own transcript, live,
// over the Overview it came from. It slides in from the right; the back
// arrow or Esc slides it away and puts focus back on its row. The pager
// steps through the other agents without going back first.

export interface AgentViewProps {
  readonly row: AgentRowView;
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly running: boolean;
  /** Its result once done (subagent.done's summary). */
  readonly summary: string | null;
  readonly engineLabel: string;
  /** Where it sits among the card's agents, for the pager. */
  readonly index: number;
  readonly count: number;
  /** Leaving: it slides out, then the Overview drops it. */
  readonly closing: boolean;
  readonly at: number;
  readonly onBack: () => void;
  readonly onStep: (by: -1 | 1) => void;
  readonly onAnswer: (askId: string, reply: AskReply) => Promise<void>;
  /** Its own chat, full size (a builder or a delegated agent). */
  readonly onOpenChat?: (() => void) | undefined;
  readonly onStop?: (() => void) | undefined;
  readonly onOpenArtifact?: ((artifactId: string) => void) | undefined;
  readonly workspaceId?: string | undefined;
  /** The folder its files live in (the chat's own, or the builder's): paths show relative to it. */
  readonly root?: string | null | undefined;
  /** Without a `root`, the checkout the chat had on this Mac before it moved (Transcript's formerRoot). */
  readonly formerRoot?: string | null | undefined;
  readonly onClosed: () => void;
  /** Takes focus as it opens (default), so Esc goes straight back. */
  readonly autoFocus?: boolean;
  /** Where the back arrow goes; default the Overview. */
  readonly backLabel?: string;
}

export function AgentView(p: AgentViewProps) {
  const back = useRef<HTMLButtonElement>(null);
  const { row } = p;
  const live = row.state.mark === "working" || row.state.mark === "needs";
  const end = live ? p.at : row.finishedAt ? Date.parse(row.finishedAt) : null;
  const time = row.startedAt && end !== null ? clock(end - Date.parse(row.startedAt)) : null;

  useEffect(() => {
    if (p.autoFocus !== false) back.current?.focus({ preventScroll: true });
  }, []);
  // Reduced motion runs no exit animation, so nothing would say it ended.
  useEffect(() => {
    if (p.closing && matchMedia("(prefers-reduced-motion: reduce)").matches) p.onClosed();
  }, [p.closing]);

  return (
    <div
      role="region"
      aria-label={row.title}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          p.onBack();
        }
      }}
      onAnimationEnd={(e) => e.target === e.currentTarget && p.closing && p.onClosed()}
      className={cn(
        "absolute inset-0 z-10 flex flex-col bg-background shadow-[-12px_0_24px_-16px_rgb(0_0_0/0.5)]",
        p.closing ? "pointer-events-none animate-out fade-out-0 duration-150 ease-snap fill-mode-forwards" : "animate-in fade-in-0 duration-200 ease-snap",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <button
          ref={back}
          type="button"
          onClick={p.onBack}
          title={`Back to the ${p.backLabel ?? "Overview"} (Esc)`}
          className="group/back flex h-7 items-center gap-0.5 rounded-md pl-1 pr-2 text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={ArrowLeft01Icon} className="size-4 transition-transform duration-150 ease-snap group-hover/back:-translate-x-0.5" />
          {p.backLabel ?? "Overview"}
        </button>
        {p.count > 1 ? (
          <span className="ml-auto flex items-center gap-0.5 text-[12px] tabular-nums text-muted-foreground">
            <PagerButton label="Previous agent" disabled={p.index === 0} onClick={() => p.onStep(-1)}>
              <Icon icon={ArrowLeft01Icon} className="size-3.5" />
            </PagerButton>
            <span className="min-w-[3.25rem] text-center">
              {p.index + 1} of {p.count}
            </span>
            <PagerButton label="Next agent" disabled={p.index === p.count - 1} onClick={() => p.onStep(1)}>
              <Icon icon={ArrowRight01Icon} className="size-3.5" />
            </PagerButton>
          </span>
        ) : null}
      </header>

      {/* Keyed by agent so stepping through them crossfades, while the frame stays put. */}
      <div key={row.key} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-200">
        <div className="flex shrink-0 items-center gap-2.5 px-3 py-2.5">
          <RunnerMark runner={row.runner} size={24} className="w-8" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13.5px] font-medium leading-5 text-foreground">{row.title}</h3>
            <p className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
              <span aria-hidden className={cn("size-1.5 shrink-0", MARK[row.state.mark])} />
              <span className={cn("shrink-0", row.state.mark === "working" && "lucy-shimmer", row.state.mark === "needs" && "text-[hsl(var(--warning))]")}>{row.state.label}</span>
              {row.runner.model || row.runner.effort ? (
                <>
                  <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">·</span>
                  <RunnerModel runner={row.runner} aria-hidden className="min-w-0 truncate" />
                </>
              ) : null}
              {time ? (
                <>
                  <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">·</span>
                  <span className="shrink-0 tabular-nums">{time}</span>
                </>
              ) : null}
            </p>
          </div>
          {p.onStop && live ? (
            <button
              type="button"
              onClick={p.onStop}
              aria-label={`Stop ${row.title}`}
              title="Stop"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={SquareIcon} className="size-3" strokeWidth={2} />
            </button>
          ) : null}
          {p.onOpenChat ? (
            <button
              type="button"
              onClick={p.onOpenChat}
              className="h-7 shrink-0 rounded-md bg-secondary px-2.5 text-[12.5px] text-secondary-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open chat
            </button>
          ) : null}
        </div>

        <Conversation className="min-h-0 flex-1 border-t border-border/70" contentClassName="px-3 pb-6 pt-3 text-[13px]">
          {p.items.length > 0 ? (
            <Transcript
              items={p.items}
              engine={row.runner.engine}
              model={row.runner.model}
              engineLabel={row.runner.engineLabel ?? p.engineLabel}
              engineIsCaveman={row.runner.engine === "caveman"}
              running={p.running}
              onAnswer={p.onAnswer}
              cavemanVersion={null}
              {...(p.workspaceId ? { workspaceId: p.workspaceId } : {})}
              root={p.root ?? null}
              formerRoot={p.formerRoot ?? null}
              {...(p.onOpenArtifact ? { onOpenArtifact: p.onOpenArtifact } : {})}
            />
          ) : (
            <p className="py-6 text-center text-[12.5px] text-muted-foreground">{live ? "Starting…" : "It has not taken a step."}</p>
          )}
          {p.summary && !live ? (
            <div className="mt-3 rounded-lg border border-border bg-card/50 px-3 py-2.5">
              <p className="mb-1 text-[12px] font-medium text-muted-foreground">Result</p>
              <Markdown source={p.summary} className="text-[13px] leading-[1.55]" />
            </div>
          ) : null}
        </Conversation>
      </div>
    </div>
  );
}

function PagerButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md outline-none transition-colors duration-75 enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
    >
      {children}
    </button>
  );
}
