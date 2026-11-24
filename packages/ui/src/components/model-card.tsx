import { cn } from "../lib/cn";
import { COST_MAX, costLevel, costPosition, MODEL_FACTS_AS_OF, runAt, SMARTS_MAX, smartsLevel, usd, type ModelFacts, type ModelRun } from "../lib/model-facts";

/*
 * How smart a model is and what it costs, at a glance (STYLE.md 11, "Smarts and cost"; 
 * "10x more simple, 10x less text, see quickly where it is"). Every row carries the glance: signal bars for
 * smarts, $ to $$$$ for a task's cost, at the effort it would run at. A row the pointer rests on shows the map:
 * every model in the list as a dot, smarter up and pricier right, this one lit and the current one ringed.
 * Facts come from model-facts.ts (Artificial Analysis, whose terms ask for the credit the map carries).
 */

const SOURCE = `Artificial Analysis, ${new Date(`${MODEL_FACTS_AS_OF}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric" })}`;

/** A row's facts in words, for a screen reader. */
export function factsSummary(facts: ModelFacts, effort: string | undefined): string {
  const run = runAt(facts, effort);
  return run ? `Intelligence ${run[0]}, ${usd(run[1])} a task` : "";
}

/** The row's glance: smarts as bars, cost as dollars. Decorative: the row says it in words (factsSummary). */
export function ModelGlance({ facts, effort, className }: { facts: ModelFacts; effort: string | undefined; className?: string }) {
  const run = runAt(facts, effort);
  if (!run) return null;
  const smarts = smartsLevel(run[0]);
  return (
    <span aria-hidden className={cn("flex items-center gap-2", className)}>
      <span className="flex h-2.5 items-end gap-px">
        {Array.from({ length: SMARTS_MAX }, (_, i) => (
          <span key={i} className={cn("w-[3px] rounded-[0.5px] bg-muted-foreground", i >= smarts && "opacity-25")} style={{ height: 3 + i * 1.75 }} />
        ))}
      </span>
      {/* A fixed slot as wide as $$$$, so the bars line up from row to row. */}
      <span className="w-[26px] text-[11px] font-medium leading-none tracking-[-0.04em] text-muted-foreground">{"$".repeat(costLevel(run[1]))}</span>
    </span>
  );
}

export type CardModel = {
  readonly label: string;
  readonly effort: string | undefined;
  readonly facts: ModelFacts | undefined;
};

// The map: x the cost scale (log, a cent to ten dollars a task), y the Intelligence Index on a fixed domain, so
// dots keep their places from row to row and a score past it pins to the edge.
const W = 216;
const H = 120;
const INSET = 10;
const Y_LOW = 5;
const Y_HIGH = 62;
const x = (cost: number) => INSET + costPosition(cost) * (W - INSET * 2);
const y = (index: number) => INSET + (1 - (Math.min(Y_HIGH, Math.max(Y_LOW, index)) - Y_LOW) / (Y_HIGH - Y_LOW)) * (H - INSET * 2);
const place = (run: ModelRun) => ({ transform: `translate(${x(run[1]).toFixed(1)}px, ${y(run[0]).toFixed(1)}px)` });
// Marks glide to their next place as the pointer moves between rows.
const GLIDE = "transition-transform duration-200 ease-swift motion-reduce:transition-none";

export function ModelCard({ model, current, others, className }: {
  model: CardModel;
  /** The model the chat runs on now, ringed; null when it is this one or none is chosen. */
  current: CardModel | null;
  /** Every other row's run, faint: where this one sits among the choices. */
  others: readonly ModelRun[];
  className?: string;
}) {
  const run = model.facts ? runAt(model.facts, model.effort) : undefined;
  const was = current?.facts ? runAt(current.facts, current.effort) : undefined;
  // On top of each other the ring alone says it; its word would sit on the lit dot.
  const apart = run && was ? Math.hypot(x(run[1]) - x(was[1]), y(run[0]) - y(was[0])) > 18 : true;
  return (
    <div className={cn("w-[240px] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-overlay dark:border-input", className)}>
      <div className="truncate text-[13px] text-foreground">{model.label}</div>
      {run ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block h-auto w-full overflow-visible rounded-md bg-background" role="img" aria-label={`${model.label}: ${factsSummary(model.facts!, model.effort)}`}>
          <text x={INSET - 2} y={INSET + 6} className="fill-[hsl(var(--subtle-foreground))] text-[10px]">Smarter</text>
          <text x={W - INSET + 2} y={H - INSET + 4} textAnchor="end" className="fill-[hsl(var(--subtle-foreground))] text-[10px]">Pricier</text>
          {others.map((o, i) => <circle key={i} r={2.5} style={place(o)} className={cn("fill-muted-foreground opacity-40", GLIDE)} />)}
          {was ? (
            <g style={place(was)} className={GLIDE}>
              <circle r={6} fill="none" strokeWidth={1.5} className="stroke-muted-foreground" />
              {apart ? <text y={17} textAnchor="middle" className="fill-muted-foreground text-[10px]">Current</text> : null}
            </g>
          ) : null}
          <circle r={4.5} style={place(run)} className={cn("fill-foreground", GLIDE)} />
        </svg>
      ) : (
        <p className="mt-1 text-[12px] text-muted-foreground">Not measured yet</p>
      )}
      <div className="mt-2 text-[10.5px] text-[hsl(var(--subtle-foreground))]">{SOURCE}</div>
    </div>
  );
}
