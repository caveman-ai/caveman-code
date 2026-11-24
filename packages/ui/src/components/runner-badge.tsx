import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";
import { BrandMark, type BrandName } from "../icons/brand";
import { engineIcon } from "../icons/names";
import { PixelIcon } from "../icons/PixelIcon";
import { EFFORT_TIER_TEXT, effortTier } from "./effort";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/*
 * Who runs an agent (orchestrator v2, identity bar): the harness's real logo, the login's 2-3 letter
 * tag, the model and an effort pip, with the harness accent as a thin rule. One component for every
 * place a delegated agent shows: the transcript card, the agents rail, sidebar rows, the thread
 * header, the Agents surface, the pickers and Settings > Subagents. Caveman's own engine keeps its
 * pixel bust; any other ACP agent its pixel tile. Text stays in chrome tiers; only the rule and a
 * faint running tint take the accent (STYLE.md section 3, "Runner accents").
 *
 * Structural shapes, no protocol dependency: Session Protocol's SubagentRunner maps onto Runner.
 */

export type RunnerPick = {
  readonly by: "lead" | "user" | "auto" | "default";
  /** The task kind the agent was picked for (TaskRole): review, research, ... */
  readonly kind?: string | undefined;
  /** The kind of task (TaskKind) whose pin picked it: frontend_ui, backend_fix, ... */
  readonly task?: string | undefined;
  /** Auto could not run, so the default model ran instead, and why. */
  readonly fallback?: "not_paying" | "cloud_unlinked" | "cloud_error" | "quota" | undefined;
  /** How many connected options Auto picked among, where the runtime says. */
  readonly options?: number | undefined;
};

export type Runner = {
  readonly engine: string;
  /** The harness's name: "Claude Agent", "Codex". */
  readonly engineLabel?: string | undefined;
  readonly model?: string | undefined;
  /** The model's own label where known ("Claude Opus 5.5"); shortened for display. */
  readonly modelLabel?: string | undefined;
  /** The login it runs on (EngineAccount.tag). */
  readonly tag?: string | undefined;
  readonly effort?: string | undefined;
  readonly pick?: RunnerPick | undefined;
};

const BRAND: Partial<Record<string, BrandName>> = {
  "claude-agent": "claude",
  codex: "openai",
  cursor: "cursor",
  opencode: "opencode",
  muse: "muse",
  grok: "grok",
  pi: "pi",
  antigravity: "antigravity",
};

/** The harness's vendor mark; undefined for Caveman (its bust) and other ACP agents (their tile). */
export function engineBrand(engine: string): BrandName | undefined {
  return BRAND[engine];
}

const ACCENTS = new Set(["caveman", "claude-agent", "codex", "cursor", "opencode", "muse", "grok", "pi", "antigravity"]);

/** The harness accent (pixel.css `--runner-*`), lifted to 3:1 on the light panel. */
export function runnerAccent(engine: string): string {
  return `hsl(var(--runner-${ACCENTS.has(engine) ? engine : "acp"}))`;
}

/** The harness logo at `size` px; Caveman's bust and the ACP tile are pixel art, crisp at 16 and 32, scaled to fit otherwise. */
export function EngineLogo({ engine, size = 16, label, className }: { engine: string; size?: number; label?: string | undefined; className?: string | undefined }) {
  const brand = engineBrand(engine);
  if (brand) return <BrandMark name={brand} size={size} {...(label ? { label } : {})} className={cn("text-foreground", className)} />;
  const icon = <PixelIcon name={engineIcon(engine)} scale={size >= 32 ? 2 : 1} {...(label ? { label } : {})} className={cn("shrink-0", size % 16 !== 0 && "size-full", className)} />;
  return size % 16 === 0 ? icon : <span className="inline-grid shrink-0" style={{ width: size, height: size }}>{icon}</span>;
}

const EFFORT_STEP: Record<string, number> = { none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4, ultracode: 4, ultra: 4 };

/** 0-4 filled pips for an effort level; unknown levels read as medium. */
export function effortPips(effort: string): number {
  return EFFORT_STEP[effort.toLowerCase()] ?? 2;
}

/** Four 3px squares, filled to the effort level: a pip, never a word, beside the model; red at max, purple past it (over a caller's grey). */
export function EffortPip({ effort, className }: { effort: string; className?: string }) {
  const n = effortPips(effort);
  return (
    <span role="img" aria-label={`${effort} effort`} title={`Effort: ${effort}`} className={cn("inline-flex shrink-0 items-end gap-px", className, EFFORT_TIER_TEXT[effortTier(effort)])}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cn("w-[3px] rounded-[0.5px]", i < n ? "bg-current" : "bg-current opacity-25")} style={{ height: 4 + i * 2 }} />
      ))}
    </span>
  );
}

/**
 * A model's short, human name: "Opus 5.5", "GPT-6.1 Sol", "Sonnet 4.5". From its label where the
 * engine gives one (minus the vendor's name), else from the id, without its date, version or
 * context suffix and its provider prefix. Lower-case ids stay lower case ("o3").
 */
export function shortModel(label: string | undefined, id: string | undefined): string {
  if (label) return label.replace(/^(anthropic:?\s*)?(claude|openai)\s+/i, "").trim();
  if (!id) return "";
  const bare = id
    .replace(/\[.*\]$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  // After the last `/` (provider/model), then past a dotted provider prefix (Bedrock's `us.anthropic.`).
  const tail = bare.slice(bare.lastIndexOf("/") + 1).replace(/^([a-z]+\.)+/i, "").replace(/^claude-/i, "");
  if (/^o\d/.test(tail)) return tail;
  const out: string[] = [];
  for (const p of tail.split("-").filter(Boolean)) {
    const prev = out[out.length - 1];
    if (/^\d{1,2}$/.test(p) && prev !== undefined && /(^|[^\d.])\d{1,2}$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else if (/^\d/.test(p) && prev === "GPT") out[out.length - 1] = `GPT-${p}`;
    else if (/^gpt$/i.test(p)) out.push("GPT");
    else out.push(/^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1));
  }
  return out.join(" ");
}

const KIND: Record<string, string> = {
  implementation: "implementation",
  research: "research",
  review: "review",
  design: "design",
  test: "tests",
};

/**
 * The task classifier's kinds (Session Protocol TaskKind) as Settings > Subagents names them, in its order, with what
 * each covers. One list for the settings rows and this badge.
 */
export const TASK_KINDS: ReadonlyArray<{ readonly kind: string; readonly label: string; readonly description: string }> = [
  { kind: "plan_design", label: "Planning", description: "Architecture, plans and design calls" },
  { kind: "frontend_ui", label: "Frontend & UI", description: "Screens, components and styling" },
  { kind: "backend_fix", label: "Backend fixes", description: "Servers, APIs and data bugs" },
  { kind: "general_coding", label: "Everyday coding", description: "Features and changes of ordinary size" },
  { kind: "large_refactor", label: "Large refactors", description: "Changes across many files" },
  { kind: "explore_readonly", label: "Reading code", description: "Questions about the code, no edits" },
  { kind: "terminal_ops", label: "Terminal & ops", description: "Builds, deploys, git and the shell" },
  { kind: "trivial_chat", label: "Quick asks", description: "Small questions and one-line changes" },
];

const FALLBACK_COPY: Record<NonNullable<RunnerPick["fallback"]>, { label: string; tip: string }> = {
  not_paying: { label: "Auto off · paid plan or credits needed", tip: "Auto needs a paid Caveman plan or Caveman credits. Using the lead's selection." },
  cloud_unlinked: { label: "Auto off · not signed in", tip: "Not signed in to Caveman. Using the lead's selection." },
  cloud_error: { label: "Auto off · Caveman unreachable", tip: "Caveman couldn't answer. Using the lead's selection." },
  quota: { label: "Auto off · routing paused", tip: "Caveman's routing quota is used up. Using the lead's selection." },
};

/**
 * How the agent's harness and model were chosen, as one quiet sub-label and a short tooltip. Never
 * the router's scores or reasons beyond the task kind. Null when there is nothing to say (a plain
 * default).
 */
export function pickCopy(runner: Runner): { label: string; tip: string } | null {
  const pick = runner.pick;
  if (!pick) return null;
  const who = [runner.engineLabel, shortModel(runner.modelLabel, runner.model)].filter(Boolean).join(" · ") || "this agent";
  if (pick.fallback) return FALLBACK_COPY[pick.fallback];
  if (pick.by === "auto") {
    const kind = pick.kind ? KIND[pick.kind] : undefined;
    const from = pick.options && pick.options > 1 ? `from ${pick.options} connected options` : "from what you have connected";
    return { label: kind ? `Auto · picked for ${kind}` : "Auto", tip: `Caveman picked ${who} ${from}.` };
  }
  if (pick.by === "lead") return { label: "Pinned", tip: "The lead chose this agent's harness and model." };
  if (pick.by === "user") {
    const task = TASK_KINDS.find((t) => t.kind === pick.task)?.label;
    if (task) return { label: `Pinned · ${task}`, tip: `Read as ${task.toLowerCase()} work on this computer: your pin for it, in Settings > Subagents.` };
    return { label: "Pinned", tip: pick.kind ? `Your pin for ${KIND[pick.kind] ?? pick.kind} agents, in Settings > Subagents.` : "Your pin, in Settings > Subagents." };
  }
  return null;
}

/**
 * The pick sub-label with its tooltip (pickCopy): one quiet unit in the tertiary tier, its inner dot
 * set close (thin spaces), so it never reads as a peer of the harness · model line it trails.
 * `short`: its first words only ("Auto"), where room is tight; the tooltip still says it all.
 * Needs a TooltipProvider above it (the app root has one).
 */
export function PickLabel({ runner, short = false, className }: { runner: Runner; short?: boolean; className?: string }) {
  const copy = pickCopy(runner);
  if (!copy) return null;
  const [head, ...rest] = copy.label.split(" · ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("relative z-10 min-w-0 truncate rounded-sm text-[hsl(var(--subtle-foreground))] outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
          {short || rest.length === 0 ? head : `${head}\u2009·\u2009${rest.join(" ")}`}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] text-[12px] leading-[17px]">
        {short && rest.length ? `${copy.label}. ${copy.tip}` : copy.tip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The logo with the login's tag: `under` it (rows, cards, the header; upstream place for it) or
 * `beside` it (inline chips). The logo settles in once when `settle` (a card that just landed).
 */
export function RunnerMark({
  runner,
  size = 16,
  tag = "under",
  settle = false,
  tile = false,
  className,
}: {
  runner: Runner;
  size?: number;
  tag?: "under" | "beside" | "none";
  settle?: boolean;
  /** The logo on a white tile, like an app icon (a delegated agent's card). */
  tile?: boolean;
  className?: string | undefined;
}) {
  const model = shortModel(runner.modelLabel, runner.model);
  const label = [runner.engineLabel ?? "Agent", runner.tag, model, runner.effort && `${runner.effort} effort`].filter(Boolean).join(" · ");
  return (
    <span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0 items-center", tag === "under" ? "flex-col justify-center gap-[3px]" : "gap-1", className)}>
      <span className={cn("grid place-items-center", settle && "runner-settle", tile && "runner-tile")} style={tile ? { width: size + 12, height: size + 12 } : undefined}>
        <EngineLogo engine={runner.engine} size={size} {...(tile ? { className: "text-current" } : {})} />
      </span>
      {runner.tag && tag !== "none" ? (
        <span aria-hidden className={cn("font-mono font-medium uppercase leading-none tracking-[0.04em] text-muted-foreground", tag === "under" ? "text-[10px]" : "text-[10.5px]")}>
          {runner.tag}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Model and effort pip: "Opus 5.5 ▮▮▮▯". Beside a RunnerMark, which already names both to a screen
 * reader, pass `aria-hidden` so they are heard once.
 */
export function RunnerModel({ runner, className, "aria-hidden": hidden }: { runner: Runner; className?: string | undefined; "aria-hidden"?: boolean }) {
  const name = shortModel(runner.modelLabel, runner.model);
  if (!name && !runner.effort) return null;
  return (
    <span aria-hidden={hidden || undefined} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {name ? <span className="truncate">{name}</span> : null}
      {runner.effort ? <EffortPip effort={runner.effort} className="h-[10px] text-muted-foreground" /> : null}
    </span>
  );
}

/**
 * The whole identity in one line. `chip`: inline, logo and tag beside, model, pip. `row`: the same
 * at row size with the pick label. `header`: a thread's header, larger logo, the pick label last.
 */
export function RunnerBadge({
  runner,
  size = "chip",
  className,
}: {
  runner: Runner;
  size?: "chip" | "row" | "header";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center text-muted-foreground", size === "chip" ? "gap-1.5 text-[12px]" : size === "row" ? "gap-2 text-[12px]" : "gap-2 text-[13px]", className)}>
      <RunnerMark runner={runner} size={size === "header" ? 16 : 14} tag="beside" />
      <RunnerModel runner={runner} aria-hidden className={size === "header" ? "text-secondary-foreground" : undefined} />
      {size !== "chip" && pickCopy(runner) ? (
        <>
          <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">
            ·
          </span>
          <PickLabel runner={runner} />
        </>
      ) : null}
    </span>
  );
}

/** Props that put the harness accent on any element's left edge (`runner-edge`, pixel.css). */
export function runnerEdge(engine: string, running = false): { className: string; style: CSSProperties; "data-running"?: true } {
  return { className: "runner-edge", style: { "--runner": runnerAccent(engine) } as CSSProperties, ...(running ? { "data-running": true as const } : {}) };
}

/**
 * A surface carrying the harness accent as a 3px rule on its left edge, with a faint accent wash
 * while `running`. `enter`: it arrives (a card that just landed).
 */
export function RunnerEdge({ engine, running = false, enter = false, className, children }: { engine: string; running?: boolean; enter?: boolean; className?: string; children: ReactNode }) {
  const edge = runnerEdge(engine, running);
  return (
    <div {...edge} className={cn(edge.className, enter && "runner-enter", className)}>
      {children}
    </div>
  );
}
