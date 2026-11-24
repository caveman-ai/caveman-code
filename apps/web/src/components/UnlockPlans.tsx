// Unlock: the one plan offer, everywhere a plan unlocks something (docs/
// "Unlock"). Every plan a person can buy alone sits side by side, one raised, each led by its headline ("up to $60 of
// usage") and how it compares in plain words; no other dollars about what a plan holds (docs/ section 9).
// Picking one opens checkout in the browser; when the plan lands, its slots unlock like items in a game:
// padlocks open, icons dither in, sparks fly. Pixel motion only (held frames, ordered dither, whole-pixel sparks) on
// plain deck chrome; reduced motion shows the end at once.

import type { AccountSummary } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@caveman-app/ui/components/dialog";
import { Switch } from "@caveman-app/ui/components/switch";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { openSoon } from "../panels/browser/BrowserBar.tsx";
import { funnelStep } from "../state/desktop.ts";
import { CLOUD_HOSTED, requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { freeWay } from "../state/sync/web-window.ts";
import { canManageBilling, planPrice, yearlySaving } from "../routes/settings/account-model.ts";
import { COLUMN_STATS, grew, paidPlan, planColumns, recommended, unlockedLine, usageSlot, type AccountSource, type PlanColumn } from "./unlock-model.ts";
import { MascotOnFloor } from "./EmptyState.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

// ------------------------------------------------------------ the padlock (16x16, '#' ink)

export const LOCK_SHUT = [
  "................",
  "................",
  ".....######.....",
  "....##....##....",
  "....#......#....",
  "....#......#....",
  "....#......#....",
  "...##########...",
  "...##########...",
  "...####..####...",
  "...####..####...",
  "...####..####...",
  "...##########...",
  "...##########...",
  "...##########...",
  "................",
];
/** The shackle a pixel up: the hover hop and the first frame of opening. */
const LOCK_LIFT = [LOCK_SHUT[0]!, ...LOCK_SHUT.slice(2, 7), LOCK_SHUT[6]!, ...LOCK_SHUT.slice(7)];
/** Open: the shackle up two and its right leg out of the body. */
const LOCK_OPEN = [
  ".....######.....",
  "....##....##....",
  "....#......#....",
  "....#......#....",
  "....#...........",
  "....#...........",
  "....#...........",
  ...LOCK_SHUT.slice(7),
];

function Grid({ rows, scale = 1, style }: { rows: ReadonlyArray<string>; scale?: number; style?: CSSProperties }) {
  return (
    <svg width={16 * scale} height={16 * scale} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden className="px-art shrink-0" style={style}>
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null)))}
    </svg>
  );
}

/** The padlock beside "Unlock"; its shackle hops once while `hop`. */
export function LockGlyph({ hop = false, scale = 1 }: { hop?: boolean; scale?: number }) {
  return <Grid rows={hop ? LOCK_LIFT : LOCK_SHUT} scale={scale} />;
}

/** Every plan touchpoint says Unlock, with the padlock (it hops on hover). */
export function UnlockButton({ onClick, variant = "default", label = "Unlock" }: { onClick: () => void; variant?: "default" | "secondary"; label?: string }) {
  const hop = useHop();
  return (
    <Button size="sm" variant={variant} onClick={onClick} onMouseEnter={hop.play}>
      <LockGlyph hop={hop.on} />
      {label}
    </Button>
  );
}

function useHop() {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    on,
    play: () => {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), 140);
    },
  };
}

// ------------------------------------------------------------ ordered dither (Bayer 4x4), one cell per sprite pixel

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** A mask that shows `level` of 16 cells of every 4x4 block of `cell` px; 16 shows everything. */
function dither(level: number, cell: number): CSSProperties {
  if (level >= 16) return {};
  const rects = BAYER.flatMap((row, y) => row.map((v, x) => (v < level ? `<rect x='${x * cell}' y='${y * cell}' width='${cell}' height='${cell}'/>` : ""))).join("");
  const url = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${4 * cell}' height='${4 * cell}'>${rects}</svg>`)}")`;
  return { maskImage: url, WebkitMaskImage: url, maskSize: `${4 * cell}px`, WebkitMaskSize: `${4 * cell}px` };
}

/** Four sparks flying out of a `size` box on the diagonals, three held frames; -1 shows none. */
function Sparks({ frame, size }: { frame: number; size: number }) {
  if (frame < 0 || frame > 2) return null;
  const d = [10, 16, 21][frame]!;
  const c = size / 2 - 2;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: [1, 0.85, 0.4][frame] }}>
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sy], i) => (
        <i key={i} className="absolute size-1 bg-[hsl(var(--id-tunic))]" style={{ left: c + sx! * d, top: c + sy! * d }} />
      ))}
    </span>
  );
}

/** Ms since `on` turned true, ticking until `until`; reduced motion jumps to the end. */
function useSince(on: boolean, until: number): number {
  const [t, setT] = useState(-1);
  useEffect(() => {
    if (!on) return setT(-1);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setT(until);
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now() - t0;
      setT(now);
      if (now < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, until]);
  return t;
}

// ------------------------------------------------------------ the columns

/** 1 to 4 notched pips: a plan's rank, like an item's rarity. */
function Pips({ n, of, lit }: { n: number; of: number; lit: boolean }) {
  return (
    <span aria-hidden className="inline-flex gap-[3px]">
      {Array.from({ length: of }, (_, i) => (
        <i
          key={i}
          className={cn("size-1.5", i < n ? (lit ? "bg-[hsl(var(--id-tunic))]" : "bg-foreground") : "bg-input")}
          style={{ clipPath: "polygon(1px 0, 5px 0, 6px 1px, 6px 5px, 5px 6px, 1px 6px, 0 5px, 0 1px)" }}
        />
      ))}
    </span>
  );
}

/** `action`: Unlock, or the plan held ("Current"); `disabled` while a checkout starts, or when this person can't buy. */
function Column({ columns, index, raised, yearly, current, disabled, onUnlock }: { columns: ReadonlyArray<PlanColumn>; index: number; raised: boolean; yearly: boolean; current: boolean; disabled: boolean; onUnlock: () => void }) {
  const c = columns[index]!;
  const hop = useHop();
  const price = planPrice(c.offered, yearly ? "year" : "month");
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border p-3.5 transition-colors duration-150 ease-snap",
        raised ? "border-foreground/45 bg-accent/55 shadow-[inset_0_2px_0_hsl(var(--id-tunic))]" : "border-border bg-card hover:border-input",
      )}
      onMouseEnter={hop.play}
    >
      <div className="flex h-[18px] items-center gap-2">
        <Pips n={index + 1} of={columns.length} lit={raised} />
        {raised ? <span className="rounded-[5px] bg-foreground px-1.5 text-[11px] font-medium leading-[18px] text-background">Recommended</span> : null}
        <span className="ml-auto grid text-muted-foreground">
          <LockGlyph hop={hop.on} />
        </span>
      </div>
      <div className="mt-3 text-[13px] font-medium text-muted-foreground">{c.family}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span key={price.amount} className="text-[26px] font-semibold leading-8 tracking-[-0.015em] tabular-nums animate-in fade-in slide-in-from-bottom-1 duration-300 ease-snap">
          {price.amount}
        </span>
        <span className="text-[12px] text-muted-foreground">/ month</span>
      </div>
      <div className="text-[12px] text-[hsl(var(--subtle-foreground))]">{price.billed ?? "Billed monthly"}</div>
      <ul className="mb-4 mt-3.5 flex flex-1 flex-col gap-[9px] border-t border-border pt-3">
        {COLUMN_STATS.map((s, i) => {
          const label = s.label(c);
          if (label === null) return null;
          return (
            <li key={i} className={cn("flex flex-col text-[12.5px] leading-[17px]", grew(columns, index, s.value) ? "text-foreground" : "text-muted-foreground")}>
              <span>{label}</span>
              {s.sub ? <span className="text-[11.5px] text-[hsl(var(--subtle-foreground))]">{s.sub(c)}</span> : null}
            </li>
          );
        })}
      </ul>
      {current ? (
        <Button size="lg" variant="secondary" className="w-full" disabled>
          Current plan
        </Button>
      ) : (
        <Button size="lg" variant={raised ? "default" : "secondary"} className="w-full" disabled={disabled} onClick={onUnlock}>
          <LockGlyph hop={hop.on} />
          Unlock
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the slots that unlock

type Slot = { icon: PixelIconName; title: (c: PlanColumn) => string; desc: (c: PlanColumn) => string };
const SLOTS: Slot[] = [
  { icon: "engine-caveman", title: (c) => usageSlot(c).title, desc: (c) => usageSlot(c).desc },
  { icon: "computer-cloud", title: () => "Cloud computers", desc: () => "Work goes on with your laptop shut." },
  { icon: "computer-vpc", title: (c) => (c.cpus === null ? "Bigger computers" : `${c.cpus} CPUs, ${c.gib} GB`), desc: () => "The biggest Cloud computer you can run." },
  { icon: "chief", title: () => "Chief, always on", desc: () => "Runs on your plan's usage. No key to paste." },
];
const TILE_START = 520;
const TILE_GAP = 150;
const DONE_AT = TILE_START + SLOTS.length * TILE_GAP + 260;

function SlotTile({ slot, column, t }: { slot: Slot; column: PlanColumn; t: number }) {
  // t: ms since this slot began to unlock; negative while it waits.
  const open = t >= 0;
  const level = !open ? 8 : t < 62 ? 10 : t < 124 ? 13 : 16;
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border bg-card p-3", open && t < 320 ? "border-foreground/50" : "border-border transition-colors duration-300 ease-snap")}>
      <span className="relative grid size-12 shrink-0 place-items-center rounded-[10px] bg-secondary">
        <span className={cn("grid place-items-center", open ? "text-foreground" : "text-muted-foreground")} style={dither(level, 2)}>
          <Glyph name={slot.icon} scale={2} />
        </span>
        {!open ? (
          <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-md bg-popover text-muted-foreground shadow-[0_0_0_1px_hsl(var(--border))]">
            <LockGlyph />
          </span>
        ) : null}
        <Sparks frame={open && t < 210 ? Math.floor(t / 70) : -1} size={48} />
      </span>
      <span className="flex min-w-0 flex-col gap-[3px] pt-0.5">
        <span className={cn("text-[13px] font-medium transition-colors duration-200 ease-snap", open ? "text-foreground" : "text-muted-foreground")}>{slot.title(column)}</span>
        <span className="text-[12px] leading-[17px] text-[hsl(var(--subtle-foreground))]">{slot.desc(column)}</span>
      </span>
    </div>
  );
}

/** The big padlock: shut, its shackle lifts, swings open with sparks, then it dithers away. */
function BigLock({ t }: { t: number }) {
  const rows = t < 0 ? LOCK_SHUT : t < 90 ? LOCK_LIFT : LOCK_OPEN;
  const level = t < 260 ? 16 : t < 320 ? 12 : t < 380 ? 8 : t < 440 ? 4 : 0;
  return (
    <span className="relative block text-foreground" style={dither(level, 3)}>
      <Grid rows={rows} scale={3} />
      <Sparks frame={t >= 90 ? Math.floor((t - 90) / 70) : -1} size={48} />
    </span>
  );
}

// ------------------------------------------------------------ the free way

/**
 * In a browser window, the option beside the plans for someone who holds none: run it free on their own computer, on
 * their own subscriptions and keys (state/sync/web-window.ts freeWay). Where this browser cannot get the desktop app it
 * says so plainly, with nothing to press. Never on the desktop app itself: it already is that computer.
 */
export function FreeWayRow({ canMac }: { canMac?: boolean | undefined }) {
  const way = freeWay(canMac);
  return (
    <div className="mt-3.5 flex items-center gap-3 px-1 text-[12.5px] leading-[17px]">
      <span className="min-w-0">
        <span className="font-medium text-foreground">{way.title}</span>
        <span className="ml-2 text-[hsl(var(--subtle-foreground))]">{way.line}</span>
      </span>
      {way.action ? (
        <Button asChild variant="secondary" size="sm" className="ml-auto shrink-0">
          <a href={way.action.url} target="_blank" rel="noreferrer">
            {way.action.label}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ the sheet

type Stage = "offer" | "checkout" | "unlocking";

/** True once the account holds `plan` (checkout went through, or the change applied at once). */
const heldPlan = (account: AccountSummary | null): string | null => {
  const set = account?.credits?.plan;
  return paidPlan(account)?.plan ?? (set !== undefined && set !== "free" ? set : null);
};
const holds = (account: AccountSummary | null, plan: string) => heldPlan(account) === plan;

/** Why this person can't buy here, or null when they can: a Cloud that takes no payments, or a member without billing. */
function cannotBuy(account: AccountSummary | null): string | null {
  if (!account?.offer) return null;
  if (!account.offer.purchasable) return "This Caveman server takes no payments.";
  if (!canManageBilling(account.role)) return `Only an owner or billing admin of ${account.organization_name ?? "your organization"} can buy a plan.`;
  return null;
}

/**
 * The plan offer. It sells a first plan: someone who holds one sees it as Current and changes plans in Settings > Plan,
 * where a change says when it takes effect. `onUnlocked` runs once the account holds the plan bought, open or not.
 * `source`: where the account comes from when it is not this computer's runtime.
 */
export function UnlockPlans({ open, onOpenChange, onUnlocked, source }: { open: boolean; onOpenChange: (open: boolean) => void; onUnlocked?: (plan: string) => void; source?: AccountSource }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const viaRuntime = useMemo<AccountSource | null>(
    () =>
      client
        ? {
            get: () => client.call("account.get", {}),
            checkout: (plan, interval) => client.call("account.checkout", { request_id: requestId(), kind: "plan", plan, interval }),
          }
        : null,
    [client],
  );
  const src = source ?? viaRuntime;
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("offer");
  const [chosen, setChosen] = useState<string | null>(null);
  const [yearly, setYearly] = useState(false);
  const [busy, setBusy] = useState(false);
  // Checkout opened in the browser (else Cloud is confirming a change made at once).
  const [opened, setOpened] = useState(false);
  const reported = useRef<string | null>(null);
  const held = heldPlan(account);
  const blocked = cannotBuy(account);
  const columns = useMemo(() => (account?.offer ? planColumns(account.offer) : []), [account]);
  const raised = recommended(columns);
  const saving = account?.offer ? yearlySaving(account.offer) : 0;
  const column = columns.find((c) => c.plan === chosen) ?? null;
  const t = useSince(stage === "unlocking", DONE_AT + 100);
  const done = stage === "unlocking" && t >= DONE_AT;

  useEffect(() => {
    if (!open) return;
    funnelStep("unlock_shown");
    setStage("offer");
    setFailed(null);
    if (!src) return;
    let live = true;
    src.get().then(
      (r) => live && setAccount(r),
      (e) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [open, src]);

  // Checkout is in the browser: look again every 2 s while the sheet is open, and whenever the window comes back
  // (closed too, so a payment finished later still unlocks), until the plan is there.
  useEffect(() => {
    if (stage !== "checkout" || !src || !chosen) return;
    let live = true;
    const look = () =>
      src.get().then(
        (r) => {
          if (!live) return;
          setAccount(r);
          if (!holds(r, chosen)) return;
          setStage("unlocking");
          if (reported.current !== chosen) {
            reported.current = chosen;
            // A plan bought runs this computer's Caveman engine at once: Cloud mints its credits key, then the engines
            // are read again. If that fails, Your setup and Settings > Plan offer it again. (On the hosted client before a
            // computer is picked there is no engine here: the plan is the organization's, and that is all.)
            void (client && !source ? client.call("account.credits", { request_id: requestId(), enabled: true }).then(() => refresh()) : Promise.resolve())
              .catch(() => undefined)
              .finally(() => onUnlocked?.(chosen));
          }
        },
        () => undefined,
      );
    const timer = open ? setInterval(look, 2000) : undefined;
    window.addEventListener("focus", look);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", look);
    };
  }, [stage, src, client, source, chosen, open, onUnlocked, refresh]);

  useEffect(() => {
    if (done) funnelStep("unlocked");
  }, [done]);

  const unlock = async (plan: string) => {
    if (!src || busy || held || blocked) return;
    setBusy(true);
    setChosen(plan);
    setFailed(null);
    funnelStep("unlock_started");
    // The checkout's tab opens inside the click (a browser blocks one opened after the call).
    const go = openSoon();
    try {
      const r = await src.checkout(plan, yearly ? "year" : "month");
      go(r.url);
      setOpened(Boolean(r.url));
      // Either way the plan unlocks when the account holds it, never on the checkout's word alone.
      setStage("checkout");
    } catch (e) {
      go(null);
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = (next: boolean) => {
    if (!next && stage === "unlocking" && !done) return; // let the unlock finish
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {stage === "offer" ? (
        <DialogContent size="wide" className="max-w-[880px] gap-0 p-5">
          <div className="flex items-start gap-3.5 pr-8">
            <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-secondary text-foreground">
              <LockGlyph scale={2} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-[17px] font-semibold leading-[22px] tracking-[-0.01em]">Unlock more</DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">Every plan unlocks Cloud computers and the Caveman engine. Bigger plans go further.</DialogDescription>
            </div>
            <label className="ml-auto mt-1 flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] text-muted-foreground">
              <Switch checked={yearly} onCheckedChange={setYearly} aria-label="Pay yearly" />
              {saving > 0 ? `Yearly, save ${saving}%` : "Yearly"}
            </label>
          </div>
          {columns.length > 0 ? (
            <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
              {columns.map((c, i) => (
                <Column key={c.plan} columns={columns} index={i} raised={i === raised} yearly={yearly} current={c.plan === held} disabled={busy || held !== null || blocked !== null} onUnlock={() => void unlock(c.plan)} />
              ))}
            </div>
          ) : (
            <p className="mt-6 text-[13px] text-muted-foreground">
              {failed ?? (account === null ? "Loading the plans…" : !account.signed_in ? "Sign in to Caveman to see the plans." : (account.error ?? "Caveman lists no plans right now."))}
            </p>
          )}
          {CLOUD_HOSTED && held === null ? <FreeWayRow /> : null}
          <div className="mt-3.5 flex items-center gap-3 px-1 text-[12px] leading-[17px] text-[hsl(var(--subtle-foreground))]">
            {failed && columns.length > 0 ? (
              <span role="alert" className="text-destructive">
                {failed}
              </span>
            ) : held ? (
              <span>You're on {columns.find((c) => c.plan === held)?.label ?? "a plan"}. Change plans in Settings &gt; Plan.</span>
            ) : blocked ? (
              <span>{blocked}</span>
            ) : (
              <span>Opens checkout in your browser. Your own Claude and ChatGPT plans keep working as they do. Change or cancel any time in Settings &gt; Plan.</span>
            )}
            <Button variant="ghost" className="ml-auto shrink-0" onClick={() => close(false)}>
              Not now
            </Button>
          </div>
        </DialogContent>
      ) : (
        <DialogContent size="md" className="max-w-[520px] gap-0 px-5 pb-[18px] pt-6">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-20 items-end justify-center">{stage === "unlocking" && t >= 440 ? <MascotOnFloor pose="done" scale={3} /> : <BigLock t={stage === "unlocking" ? t : -1} />}</div>
            <DialogTitle className="mt-4 text-[17px] font-semibold leading-[22px] tracking-[-0.01em]">
              {done ? `${column?.label ?? "Your plan"} unlocked` : stage === "checkout" ? (opened ? "Finish in your browser" : "One moment") : `Unlocking ${column?.label ?? ""}`}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[13px] leading-[19px] text-muted-foreground">
              {done && column
                ? unlockedLine(column)
                : stage === "checkout"
                  ? opened
                    ? `Checkout for ${column?.label ?? "your plan"} is open in your browser. This unlocks the moment you're done.`
                    : `Waiting for Caveman to confirm ${column?.label ?? "your plan"}.`
                  : "One moment."}
            </DialogDescription>
          </div>
          {column ? (
            <div className="mt-5 grid grid-cols-2 gap-2">
              {SLOTS.map((s, i) => (
                <SlotTile key={s.icon} slot={s} column={column} t={stage === "unlocking" ? t - TILE_START - i * TILE_GAP : -1} />
              ))}
            </div>
          ) : null}
          <div className={cn("mt-5 flex flex-col gap-1.5", stage === "unlocking" && !done && "invisible")}>
            {done ? (
              <Button size="lg" className="w-full" autoFocus onClick={() => close(false)}>
                Keep going
              </Button>
            ) : (
              <Button size="lg" variant="ghost" className="w-full" onClick={() => setStage("offer")}>
                Back to plans
              </Button>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
