// The first run's building blocks: the window (title band with the step bars, a centred column that scrolls, a
// footer), a step's head (a figure, a title, one grey line), cards and rows in the kit's menu-row hierarchy, and
// the pixel flame (the app icon's FLAME). docs/ "The window".

import { Button } from "@caveman-app/ui/components/button";
import { PixelAppear, StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { useEffect, type ReactNode } from "react";
import { MascotOnFloor } from "../../components/EmptyState.tsx";
import { TitleBar } from "../../shell/TitleBar.tsx";

/** The whole first run: the title band with one short bar per step, the step, and its footer. */
export function Frame({ steps, step, children }: { steps: ReadonlyArray<string>; step: number; children: ReactNode }) {
  return (
    <div className="dashboard-scope flex h-full flex-col bg-sidebar text-foreground">
      <TitleBar className="relative justify-center">
        <Bars steps={steps} step={step} />
      </TitleBar>
      {/* In a browser there is no title band: the bars sit at the top on their own. */}
      {typeof window !== "undefined" && !window.cavemanDesktop ? (
        <div className="flex h-10 shrink-0 items-center justify-center">
          <Bars steps={steps} step={step} />
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Bars({ steps, step }: { steps: ReadonlyArray<string>; step: number }) {
  return (
    <ol aria-label="Setup steps" className="flex gap-1">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === step ? "step" : undefined}
          aria-label={`${s}${i < step ? ", done" : ""}`}
          className={cn("h-[3px] w-5 rounded-full transition-colors duration-200 ease-snap", i === step ? "bg-foreground/85" : i < step ? "bg-foreground/40" : "bg-foreground/[0.12]")}
        />
      ))}
    </ol>
  );
}

/** One step: the column (scrolling, faded at its edges) over the footer. */
export function Page({ head, width = 344, children, foot }: { head: ReactNode; width?: number; children?: ReactNode; foot: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-24px),transparent)]">
        {/* Each step comes in with a short rise: a new Page mounts per step. */}
        <div className="my-auto flex w-full flex-col items-center pb-7 pt-5 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-snap motion-reduce:animate-none" style={{ maxWidth: width }}>
          {head}
          {children}
        </div>
      </div>
      {foot}
    </div>
  );
}

/** A step's head: its figure, a title and one grey line. Focus moves to the title when the step changes. */
export function Head({ figure, title, desc }: { figure: ReactNode; title: string; desc: ReactNode }) {
  return (
    <div className="flex w-full max-w-[380px] flex-col items-center text-center">
      <div className="mb-5 flex min-h-[62px] items-end justify-center">{figure}</div>
      <h1 tabIndex={-1} className="text-[22px] font-semibold leading-7 tracking-[-0.012em] outline-none">
        {title}
      </h1>
      <p className="mt-2 text-balance text-[13px] leading-5 text-muted-foreground">{desc}</p>
    </div>
  );
}

/** The caveman at the head of a step; a new pose plays from its first frame. */
export function Caveman({ pose }: { pose: MascotPose }) {
  return <MascotOnFloor key={pose} pose={pose} scale={3} />;
}

/**
 * The footer: Back, a quiet line, a way past the step (`skip`, never on Enter; ghost, or the kit's secondary button when
 * it is a real choice beside the white action), and the step's one white action (Enter presses it).
 */
export function Nav({
  onBack,
  onNext,
  next = "Continue",
  disabled,
  aside,
  skip,
}: {
  onBack?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  next?: string;
  disabled?: boolean;
  aside?: ReactNode;
  skip?: { readonly label: string; readonly onClick: () => void; readonly variant?: "ghost" | "secondary" } | undefined;
}) {
  useEffect(() => {
    if (!onNext || disabled) return;
    // Only from the page itself (nothing focused, or the step's title), once per press: a held Enter must not run
    // the next step's Continue, and Enter on a link, a field or a button belongs to it.
    const go = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Enter" || e.repeat || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (t && t !== document.body && t.tagName !== "H1") return;
      e.preventDefault();
      onNext();
    };
    addEventListener("keydown", go);
    return () => removeEventListener("keydown", go);
  }, [onNext, disabled]);
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-sidebar-border px-4 py-3">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : null}
      {aside ? <span className="min-w-0 truncate text-[12px] text-[hsl(var(--subtle-foreground))]">{aside}</span> : null}
      {skip ? (
        <Button variant={skip.variant ?? "ghost"} className="ml-auto shrink-0" onClick={skip.onClick}>
          {skip.label}
        </Button>
      ) : null}
      {onNext ? (
        <Button className={skip ? "shrink-0" : "ml-auto"} onClick={onNext} disabled={disabled}>
          {next}
          <kbd aria-hidden className="ml-1 rounded border border-primary-foreground/25 px-1 text-[11px] leading-4">↵</kbd>
        </Button>
      ) : null}
    </footer>
  );
}

export function Card({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("w-full rounded-xl border border-border bg-card p-1", className)}>
      {title ? (
        <header className="flex h-[30px] items-center gap-2 px-2.5 pt-0.5 text-[12px] text-muted-foreground">
          <span>{title}</span>
          {aside ? <span className="ml-auto text-[hsl(var(--subtle-foreground))]">{aside}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The kit's row: a 16px mark, the label in white, a description in grey, a state at the right. The label and the
 * description sit side by side while they fit. A description that does not (the gh line at 390px, or in the 540px
 * project card) goes under the label and wraps there, whole, so it stays readable. A label longer than the row (an
 * issue's title at 390px) is cut short with its whole text in `title`, so the state at the right stays inside the card.
 */
export function Row({ icon, label, desc, right, mono }: { icon: ReactNode; label: ReactNode; desc?: ReactNode; right?: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] animate-in fade-in duration-150 ease-snap">
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="max-w-full truncate whitespace-nowrap text-foreground" title={typeof label === "string" ? label : undefined}>
          {label}
        </span>
        {desc ? <span className={cn("min-w-0 text-muted-foreground [overflow-wrap:anywhere]", mono && "font-mono text-[12px]")}>{desc}</span> : null}
      </span>
      {right ? <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-muted-foreground">{right}</span> : null}
    </div>
  );
}

/** A state that landed: the done mark dithers in green beside the word. */
export function Ready({ text = "Ready" }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-success">
      <PixelAppear name="state-done" className="[--px-accent:hsl(var(--success))]" />
      {text}
    </span>
  );
}

/** Work in progress: the ring turns beside the word. */
export function Working({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <StateMark name="state-working" animate />
      {text}
    </span>
  );
}

// ------------------------------------------------------------------ the flame

/** The app icon's flame (apps/desktop/scripts/make-icon.py FLAME): 8x8 cells. */
const FLAME = ["00011000", "00111100", "00111100", "01100110", "01100110", "11000011", "01100110", "00111100"];
const TIP = "hsl(var(--id-tunic))";
const EMBER = "#f36716"; // the brand ember (Caveman Cloud pixel.tsx), the flame's body

/**
 * The flame as a mark beside a label (cells with no gutters): 16px in a row; larger, in the text colour (`mono`), it
 * is the logo beside the name. Keep `size` a multiple of 8 so the cells stay whole pixels.
 */
export function FlameMark({ size = 16, mono = false }: { size?: number; mono?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden className="px-art shrink-0">
      {FLAME.flatMap((row, r) => [...row].map((ch, c) => (ch === "1" ? <rect key={`${r}-${c}`} x={c * 2} y={r * 2} width={2} height={2} fill={mono ? "currentColor" : r < 3 ? TIP : EMBER} /> : null)))}
    </svg>
  );
}
