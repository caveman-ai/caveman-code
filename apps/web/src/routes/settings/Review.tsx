import type { EngineId, PrSummary } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { findModel, ModelPicker } from "@caveman-app/ui/components/model-picker";
import { RunnerBadge } from "@caveman-app/ui/components/runner-badge";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { withModelSources } from "../../components/Composer.tsx";
import { instanceOf, loginEngines, runnerFor, sectionOf } from "../../state/runner.ts";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { engineReady } from "../../state/engines.ts";
import { useQueue } from "../review/data.ts";
import { DEFAULT_SHORT_LINES } from "../review/model.ts";
import { ADVANCED_DEFAULTS, advancedSummary, rulerAt, rulerLanes, stepStop, stopAt } from "./review-model.ts";
import { InstructionsCard, NumberInput, PICKER, SettingRow, SettingsCard, SettingsCardBody, useSaveSettings } from "./rows.tsx";

const TASTE_HINT = "Start with anything that changes a public API or a migration.\nSkip test-only stops; one line on what the tests prove is enough.";

/**
 * Settings > Work > Review: when a pull request gets its guide, how deep it goes and who writes it. Every number the
 * runtime writes guides by is here; the runtime holds them, settings.get reports the values in force.
 */
export function ReviewSettings() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const saveTaste = useSaveSettings({ throws: true });
  const on = settings?.review_guides !== false;
  const ahead = settings?.review_prewarm !== false;
  const limit = settings?.review_short_lines ?? DEFAULT_SHORT_LINES;
  return (
    <>
      <SettingsCard>
        <SettingRow id="review-guides" label="Write guides" description="A tour of each pull request, on its Guide tab.">
          <Switch id="review-guides" disabled={!settings} checked={on} onCheckedChange={(v) => void save({ review_guides: v })} />
        </SettingRow>
        <SettingRow
          id="review-prewarm"
          label="Write ahead"
          description="Before you open a pull request that is yours or asks for your review."
        >
          <Switch id="review-prewarm" disabled={!settings || !on} checked={on && ahead} onCheckedChange={(v) => void save({ review_prewarm: v })} />
        </SettingRow>
        <SettingRow
          id="review-post"
          label="Post on the pull request"
          description="Posts the guide as a GitHub comment on pull requests your chats open, and keeps it current."
        >
          <Switch id="review-post" disabled={!settings || !on} checked={on && settings?.review_post !== false} onCheckedChange={(v) => void save({ review_post: v })} />
        </SettingRow>
      </SettingsCard>

      <Dimmed off={!on}>
        <SettingsCard title="Short changes">
          <SettingRow id="review-short" label="TL;DR only up to" description="Smaller changes get a TL;DR, not a tour. 0 always writes the tour.">
            <NumberInput id="review-short" value={limit} min={0} max={2000} unit="lines" onCommit={(v) => void save({ review_short_lines: v })} />
          </SettingRow>
          <ShortRuler limit={limit} onCommit={(v) => void save({ review_short_lines: v })} />
          <SettingRow
            id="review-chat-tldr"
            label="TL;DR from the chat that opened it"
            description="Its model already holds the change, so it costs a few dozen tokens."
          >
            <Switch id="review-chat-tldr" disabled={!settings} checked={settings?.review_chat_tldr !== false} onCheckedChange={(v) => void save({ review_chat_tldr: v })} />
          </SettingRow>
        </SettingsCard>
      </Dimmed>

      <Dimmed off={!on}>
        <SettingsCard title="Who writes">
          <WriterModel />
        </SettingsCard>
      </Dimmed>

      <Dimmed off={!on}>
        <Taste value={settings?.review_instructions ?? ""} disabled={!settings} onSave={(review_instructions) => saveTaste({ review_instructions })} />
      </Dimmed>

      <Dimmed off={!on}>
        <AdvancedSettings ahead={ahead} />
      </Dimmed>
    </>
  );
}

/**
 * The tuning most people never touch, folded under one row that still says every value (a changed one in full
 * ink), so nothing hides: stepping up, the one-call budget, and the limits on guides written ahead.
 */
function AdvancedSettings({ ahead }: { ahead: boolean }) {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const summary = advancedSummary({
    review_step_up: settings?.review_step_up,
    review_single_pass_kb: settings?.review_single_pass_kb,
    review_prewarm_daily: settings?.review_prewarm_daily,
    review_prewarm_plan_percent: settings?.review_prewarm_plan_percent,
    review_prewarm_idle_minutes: settings?.review_prewarm_idle_minutes,
  });
  const changed = summary.some((part) => part.changed);
  return (
    <SettingsCard>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex min-h-14 w-full items-center gap-3 px-5 py-3 text-left outline-none transition-colors duration-75 hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13px]">Advanced</span>
          <span className="mt-0.5 block text-[12.5px] leading-[18px] text-muted-foreground">
            {summary.map((part, i) => (
              <span key={part.text}>
                {i === 0 ? null : ", "}
                <span className={part.changed ? "text-foreground" : undefined}>{i === 0 ? part.text[0]!.toUpperCase() + part.text.slice(1) : part.text}</span>
              </span>
            ))}
          </span>
        </span>
        <Icon icon={ArrowDown01Icon} className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={panel} className="divide-y divide-border/60">
          <SettingRow id="review-step-up" label="Step up once" description="A guide that misses the quality check is rewritten on the next model up.">
            <Switch id="review-step-up" disabled={!settings} checked={settings?.review_step_up !== false} onCheckedChange={(v) => void save({ review_step_up: v })} />
          </SettingRow>
          <SettingRow id="review-inline" label="Read in one call up to" description="A larger diff is read from a checkout, which takes a minute or two.">
            <NumberInput id="review-inline" value={settings?.review_single_pass_kb ?? ADVANCED_DEFAULTS.review_single_pass_kb} min={8} max={512} unit="KB" onCommit={(v) => void save({ review_single_pass_kb: v })} />
          </SettingRow>
          <Dimmed off={!ahead}>
            <p className="px-5 pb-1 pt-4 text-[12.5px] text-muted-foreground">Written ahead: only on a subscription, never an API key.</p>
            <div className="divide-y divide-border/60">
              <SettingRow id="review-daily" label="Guides a day" description="Dependency bumps need no model and do not count.">
                <NumberInput id="review-daily" value={settings?.review_prewarm_daily ?? ADVANCED_DEFAULTS.review_prewarm_daily} min={0} max={200} onCommit={(v) => void save({ review_prewarm_daily: v })} />
              </SettingRow>
              <SettingRow id="review-plan" label="While your plan is under" description="Waits while the fullest window of the writer's plan is past this.">
                <NumberInput id="review-plan" value={settings?.review_prewarm_plan_percent ?? ADVANCED_DEFAULTS.review_prewarm_plan_percent} min={10} max={100} unit="%" onCommit={(v) => void save({ review_prewarm_plan_percent: v })} />
              </SettingRow>
              <SettingRow id="review-idle" label="After a quiet spell of" description="So a guide never slows a chat.">
                <NumberInput id="review-idle" value={settings?.review_prewarm_idle_minutes ?? ADVANCED_DEFAULTS.review_prewarm_idle_minutes} min={0} max={60} unit="min" onCommit={(v) => void save({ review_prewarm_idle_minutes: v })} />
              </SettingRow>
            </div>
          </Dimmed>
          {changed ? (
            <div className="flex justify-end px-5 py-3">
              <Button variant="secondary" disabled={!settings} onClick={() => void save({ ...ADVANCED_DEFAULTS })}>
                Reset to defaults
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  );
}

/** A section that does nothing while what it depends on is off: dimmed and out of the tab order. */
function Dimmed({ off, children }: { off: boolean; children: ReactNode }) {
  return (
    <div inert={off} aria-disabled={off || undefined} className={cn("transition-opacity duration-150", off && "opacity-45")}>
      {children}
    </div>
  );
}

/** The guide model: Auto (the cheapest guide model, a subscription before a key) or one login's model and effort. */
function WriterModel() {
  const all = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const engines = all.filter(engineReady);
  // Harnesses first, as in Agents' role pins: each login is its own section; the Caveman engine's models last.
  const sections = loginEngines(withModelSources(engines)).sort((a, b) => Number(a.id === "caveman") - Number(b.id === "caveman"));
  const pin = settings?.review_model ?? null;
  const value = pin ? { engine: sectionOf(engines, pin), model: pin.model } : null;
  const hit = findModel(sections, value);
  const runner = pin
    ? runnerFor(engines, { engine: pin.engine, runner: { engine: pin.engine, instance_id: pin.instance_id, model: pin.model, ...(pin.effort ? { effort: pin.effort } : {}), pick: { by: "user", kind: "review" } } })
    : null;
  const set = (next: { engine: string; model: string; effort?: string | undefined } | null) => {
    const at = next ? instanceOf(engines, next.engine) : null;
    // instanceOf names an engine the runtime listed, so its id is one of the protocol's.
    void save({ review_model: at && next ? { engine: at.engine as EngineId, instance_id: at.instance_id, model: next.model, ...(next.effort ? { effort: next.effort } : {}) } : null });
  };
  return (
    <SettingRow label="Model" description="Auto takes the cheapest model you can run, a subscription before a key.">
      <ModelPicker
        engines={sections}
        value={value}
        onChange={(r) => set({ engine: r.engine, model: r.model, effort: sections.find((e) => e.id === r.engine)?.models.find((m) => m.id === r.model)?.default_effort })}
        favorites={[]}
        effort={pin?.effort ?? hit?.model.default_effort}
        onEffortChange={(effort) => pin && set({ engine: sectionOf(engines, pin), model: pin.model, effort })}
        auto={{ label: "Auto", description: "The cheapest guide model you can run, on a subscription before a key", selected: pin === null, onPick: () => set(null) }}
        trigger={runner ? <RunnerBadge runner={runner} className="min-w-0 text-foreground" /> : <span className="truncate">Auto</span>}
        ariaLabel={`Guide model: ${hit ? `${hit.model.label}, ${hit.engine.label}` : "Auto"}`}
        className={PICKER}
      />
    </SettingRow>
  );
}

/** Lines a pull request changes, as the queue reports them (lockfiles included; the limit itself leaves them out). */
const prLines = (pr: PrSummary) => pr.additions + pr.deletions;

/**
 * The limit over the person's own open pull requests: each a tick at its size on a log scale, the limit a handle
 * that clicks through round numbers. Left of it gets the TL;DR and the diff, right of it the tour. Hidden when the
 * queue cannot be read or has nothing to show, and when every change gets the tour (0).
 */
function ShortRuler({ limit, onCommit }: { limit: number; onCommit: (lines: number) => void }) {
  const { client } = useRuntimeClient();
  const queue = useQueue(client);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [limit]);
  const prs = (queue.value?.prs ?? []).filter((pr) => prLines(pr) > 0);
  if (limit === 0 || prs.length === 0) return null;
  const value = draft ?? limit;
  const at = rulerAt(value);
  const positions = prs.map((pr) => rulerAt(prLines(pr)));
  const lanes = rulerLanes(positions, 0.012);
  const short = prs.filter((pr) => prLines(pr) <= value).length;
  const commit = () => {
    if (draft !== null && draft !== limit) onCommit(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!by) return;
    // The handle steps through round numbers; the browser's own step would move it a thousandth.
    e.preventDefault();
    setDraft(stepStop(value, by));
  };
  return (
    <SettingsCardBody className="pb-5 pt-4">
      <p className="flex items-baseline justify-between gap-4 text-[12.5px] text-muted-foreground">
        <span>Your open pull requests, by lines changed</span>
        <span className="tabular-nums" aria-live="polite">
          <span className="text-foreground">{short}</span> get a TL;DR, <span className="text-foreground">{prs.length - short}</span> a tour
        </span>
      </p>
      <div className="relative mt-3 h-[58px]">
        {/* Left of the limit: the changes that read as TL;DR and diff. */}
        <div aria-hidden className="absolute inset-y-0 left-0 rounded-l-[4px] bg-foreground/[0.045] transition-[width] duration-100 ease-snap" style={{ width: `${at * 100}%` }} />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
        {prs.map((pr, i) => {
          const isShort = prLines(pr) <= value;
          return (
            <span
              key={`${pr.project_id}#${pr.repo}#${pr.number}`}
              title={`#${pr.number} ${pr.title} · ${prLines(pr)} lines`}
              className={cn("absolute w-[2px] -translate-x-1/2 rounded-[1px] transition-colors duration-100", isShort ? "h-3 bg-foreground/85" : "h-3 bg-muted-foreground/40")}
              style={{ left: `${positions[i]! * 100}%`, bottom: 5 + lanes[i]! * 15 }}
            />
          );
        })}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-foreground" style={{ left: `${at * 100}%` }}>
          <span className="absolute -top-0.5 left-1.5 whitespace-nowrap rounded-[4px] bg-card px-1 text-[11.5px] font-medium tabular-nums leading-4 text-foreground">
            {value} {value === 1 ? "line" : "lines"}
          </span>
        </div>
        {/* The handle: a native range stretched half a thumb past each end, so its centre lands on the limit's line. */}
        <input
          type="range"
          aria-label="TL;DR only up to"
          aria-valuetext={`${value} ${value === 1 ? "line" : "lines"}`}
          min={0}
          max={1000}
          step={1}
          value={Math.round(at * 1000)}
          onChange={(e) => setDraft(stopAt(Number(e.target.value) / 1000))}
          onKeyDown={onKey}
          onKeyUp={commit}
          onPointerUp={commit}
          onBlur={commit}
          className={cn(
            "absolute -inset-x-[6px] bottom-0 top-0 h-full w-[calc(100%+12px)] cursor-ew-resize appearance-none bg-transparent outline-none",
            "[&::-webkit-slider-runnable-track]:h-full [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:mt-[18px] [&::-webkit-slider-thumb]:h-[22px] [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[3px] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-card [&::-webkit-slider-thumb]:bg-foreground",
            "[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100 active:[&::-webkit-slider-thumb]:scale-y-110",
            "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring focus-visible:[&::-webkit-slider-thumb]:ring-offset-1 focus-visible:[&::-webkit-slider-thumb]:ring-offset-card",
            "[&::-moz-range-thumb]:h-[22px] [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-[3px] [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-card [&::-moz-range-thumb]:bg-foreground",
          )}
        />
      </div>
      <div aria-hidden className="relative mt-1.5 h-4 text-[11px] tabular-nums text-[hsl(var(--subtle-foreground))]">
        {[1, 10, 100, 1000].map((n) => (
          <span key={n} className={cn("absolute", n === 1 ? "left-0" : n === 1000 ? "right-0" : "-translate-x-1/2")} style={n === 1 || n === 1000 ? undefined : { left: `${rulerAt(n) * 100}%` }}>
            {n === 1000 ? "1k+" : n}
          </span>
        ))}
      </div>
    </SettingsCardBody>
  );
}

/** The maintainer's taste for guides: tone, emphasis, order. Saved with its own button, like the Chief's rules. */
function Taste({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (text: string) => Promise<void> }) {
  return (
    <InstructionsCard
      title="Your taste"
      description="What to dwell on, skip or put first."
      label="Your taste for guides"
      placeholder={TASTE_HINT}
      maxLength={4000}
      value={value}
      disabled={disabled}
      onSave={onSave}
    />
  );
}

