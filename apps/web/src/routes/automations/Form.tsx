// An automation's Settings: its file as a form. Triggers, then its instructions (each step's prompt with its model and
// effort), then where and how a run works, then the rest folded under Advanced. Every control edits the file's text
// through draft.ts, which changes only the node it names; Save writes the text. Anything the form has no control for
// stays in the file, and the File tab edits all of it.
import type { AutomationDiagnostic, AutomationExplanation } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { effortLabel, EFFORT_TIER_TEXT, effortTier } from "@caveman-app/ui/components/effort";
import { Input } from "@caveman-app/ui/components/input";
import { menuDescription } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, ArrowDown01Icon, ArrowRight01Icon, Cancel01Icon, Clock01Icon } from "@caveman-app/ui/icons/huge";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import { isComposing } from "../../panels/chrome.tsx";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { Segmented, SettingRow, SettingsCard } from "../settings/rows.tsx";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { type Location, useBlocker } from "react-router";
import { say } from "./actions.tsx";
import { message, useFileText } from "./data.ts";
import {
  COMPUTER_LABEL,
  daysWord,
  EFFORTS,
  endsWord,
  everyWord,
  EVENT_WORD,
  CLOUD_ONLY_EVENTS,
  GITHUB_EVENTS,
  modelWord,
  localDay,
  nextAt,
  readForm,
  scheduleAs,
  scheduleKindOf,
  setBudget,
  setGitHub,
  setHost,
  setPrompt,
  setSchedule,
  setStepKey,
  setWebhook,
  stepOf,
  WEEKDAYS,
  type Computer,
  type Form,
  type GitHub,
  type Schedule,
  type ScheduleKind,
  type Step,
  type Weekday,
} from "./draft.ts";
import { TriggerMark } from "./marks.tsx";
import { LOCAL_ZONE, leverView, monthDaysWord, nextRunWord, plural, SCOPE_HINT, stepCards, zoneWord, type Scope } from "./model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export interface FormProps {
  /** The file's text as it stands (unsaved edits included). */
  readonly text: string;
  readonly onText: (text: string) => void;
  /** What the runtime says the saved file does: resolved models, levers. Absent for a new one. */
  readonly explanation?: AutomationExplanation | undefined;
  /** The saved schedule's next run, when the runtime has one: shown when the page can't work it out itself. */
  readonly nextRunAt?: string | null | undefined;
  /** Whose it is: a new one picks; a saved one says. */
  readonly scope: Scope;
  readonly onScope?: ((scope: Scope) => void) | undefined;
  /** Check's problems with this file, live. */
  readonly problems: ReadonlyArray<AutomationDiagnostic>;
  readonly onOpenFile?: (() => void) | undefined;
  /** Above Triggers: a Cloud automation's deploy panel. */
  readonly lead?: ReactNode;
}

export function SettingsForm({ text, onText, explanation, nextRunAt, scope, onScope, problems, onOpenFile, lead }: FormProps) {
  const read = readForm(text);
  if ("error" in read) {
    return (
      <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
        <Glyph name="state-failed" className="shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="text-[14px] font-medium text-foreground">The file doesn't read as YAML</p>
          <p className="mt-0.5 text-muted-foreground">{read.error}. Fix it in the file, and this form comes back.</p>
        </div>
        {onOpenFile ? (
          <Button size="sm" variant="secondary" onClick={onOpenFile}>
            Open the file
          </Button>
        ) : null}
      </div>
    );
  }
  const f = read.form;
  const single = f.steps.length === 1 ? f.steps[0]! : null;
  const resolved = new Map(explanation ? stepCards(explanation).map((c) => [c.name, c.model.model] as const) : []);
  return (
    <div className="flex flex-col gap-10">
      <Problems problems={problems} onOpenFile={onOpenFile} />
      {lead}
      <Triggers form={f} text={text} onText={onText} nextRunAt={nextRunAt} />
      <Instructions form={f} text={text} onText={onText} resolved={resolved} />
      <SettingsCard title="Session">
        {single && single.kind !== "run" && single.kind !== "wait" ? (
          <SettingRow label="Working copy" description={COMPUTER_LABEL[single.computer ?? "readonly"].hint}>
            <ComputerMenu value={single.computer} onChange={(c) => onText(setStepKey(text, single.name, "computer", c === "readonly" ? undefined : c))} />
          </SettingRow>
        ) : null}
        <SettingRow label="Budget per run" description="The most one run may spend, every step and retry together.">
          <BudgetField value={f.budget} onCommit={(v) => onText(setBudget(text, v))} />
        </SettingRow>
        <SettingRow label="Who it's for" description={SCOPE_HINT[scope]}>
          {onScope ? (
            <Segmented<Scope>
              label="Who it's for"
              value={scope}
              options={[
                { value: "me", label: "Just me" },
                { value: "project", label: "Everyone on the repo" },
              ]}
              onChange={onScope}
            />
          ) : (
            <span className="text-[13px] text-muted-foreground">{scope === "me" ? "Just me" : "Everyone on the repo"}</span>
          )}
        </SettingRow>
        <SettingRow label="Runs on" description={f.host === "cloud" ? "Cloud fires its triggers on its own computers, once you deploy it." : `Caveman Code on ${thisComputer} fires its triggers while it's open.`}>
          <Segmented<Form["host"]>
            label="Runs on"
            value={f.host}
            options={[
              { value: "this-mac", label: THIS_COMPUTER },
              { value: "cloud", label: "Cloud" },
            ]}
            onChange={(h) => onText(setHost(text, h))}
          />
        </SettingRow>
      </SettingsCard>
      <Advanced form={f} single={single} text={text} onText={onText} explanation={explanation} onOpenFile={onOpenFile} />
    </div>
  );
}

// ------------------------------------------------------------ problems

function Problems({ problems, onOpenFile }: { problems: ReadonlyArray<AutomationDiagnostic>; onOpenFile?: (() => void) | undefined }) {
  if (problems.length === 0) return null;
  const errors = problems.filter((p) => p.severity === "error");
  const first = errors[0] ?? problems[0]!;
  return (
    <div role="status" className={cn("-mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-[13px] ring-1 ring-inset", errors.length > 0 ? "bg-destructive/[0.06] ring-destructive/20" : "bg-warning/[0.06] ring-warning/20")}>
      <Glyph name={errors.length > 0 ? "state-failed" : "state-needs-input"} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className={cn("font-medium", errors.length > 0 ? "text-destructive" : "text-warning")}>
          {errors.length > 0 ? `${errors.length === 1 ? "1 error" : `${errors.length} errors`} keep it from running.` : `${problems.length === 1 ? "1 warning" : `${problems.length} warnings`}.`}
        </span>{" "}
        <span className="text-foreground/85">
          Line {first.line}: {first.message}
        </span>
      </span>
      {onOpenFile ? (
        <button type="button" onClick={onOpenFile} className="shrink-0 rounded text-[12.5px] text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Open the file
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ triggers

/** One trigger as a row: its mark, its words with their controls in line, and a remove button at the end. */
function TriggerRow({ mark, children, onRemove, label }: { mark: ReactNode; children: ReactNode; onRemove?: (() => void) | undefined; label: string }) {
  return (
    <div className="group flex min-h-[60px] flex-wrap items-center gap-x-2 gap-y-2 px-5 py-3 text-[14px] text-foreground">
      <span className="mr-1 grid size-5 shrink-0 place-items-center text-muted-foreground">{mark}</span>
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,background-color] duration-75 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** A value inside a sentence that opens a menu: the time in "Every weekday at 09:00". */
const CHIP =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.05] px-2.5 text-[13.5px] text-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.09] dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05)]";

function Chip({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={CHIP} {...rest}>
      {children}
      <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
    </button>
  );
}

export const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const EVERY = ["15m", "30m", "1h", "2h", "3h", "6h", "12h"];

function Triggers({ form: f, text, onText, nextRunAt }: { form: Form; text: string; onText: (t: string) => void; nextRunAt: string | null | undefined }) {
  const has = (k: string) => f.triggers.some((t) => t.kind === k);
  return (
    <SettingsCard title="Triggers" description={f.triggers.length === 0 ? "None yet: it runs only when you press Run now." : undefined}>
      {f.triggers.map((t) =>
        t.kind === "schedule" ? (
          <ScheduleRow key="schedule" schedule={t.schedule} nextRunAt={nextRunAt} onChange={(s) => onText(setSchedule(text, s))} />
        ) : t.kind === "github" ? (
          <GitHubRow key="github" github={t.github} cloud={f.host === "cloud"} onChange={(g) => onText(setGitHub(text, g))} />
        ) : t.kind === "webhook" ? (
          <TriggerRow key="webhook" label="the webhook" mark={<TriggerMark mark="webhook" />} onRemove={() => onText(setWebhook(text, false))}>
            <span>A signed request to its URL</span>
            <span className="text-[13px] text-muted-foreground">{f.host === "cloud" ? "Deploy it to get the URL." : "Webhooks fire on Cloud: set Runs on to Cloud."}</span>
          </TriggerRow>
        ) : (
          <TriggerRow key={t.kind} label={t.kind} mark={<Glyph name="connector" className="size-4" />}>
            <span>{t.kind === "slack" ? "A Slack message that mentions @caveman" : t.kind === "linear" ? "A Linear issue or comment" : "A Jira issue"}</span>
            <span className="text-[13px] text-muted-foreground">Its channels and labels are in the file.</span>
          </TriggerRow>
        ),
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={has("schedule") && has("github") && has("webhook")} className="flex h-12 w-full items-center gap-2.5 px-5 text-[13.5px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.03] hover:text-foreground focus-visible:bg-foreground/[0.04] disabled:hidden data-[state=open]:text-foreground">
            <Icon icon={Add01Icon} className="size-4" />
            Add trigger
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[300px]">
          {has("schedule") ? null : (
            <DropdownMenuItem onSelect={() => onText(setSchedule(text, { at: "09:00", timezone: LOCAL_ZONE, weekdays: ["mon", "tue", "wed", "thu", "fri"] }))}>
              <TriggerMark mark="schedule" />
              <span className="shrink-0">Schedule</span>
              <span className={menuDescription}>Once, on days, every few hours</span>
            </DropdownMenuItem>
          )}
          {has("github") ? null : (
            <DropdownMenuItem onSelect={() => onText(setGitHub(text, { events: ["issues.labeled"], labels: ["caveman"], mention: false }))}>
              <TriggerMark mark="github" />
              <span className="shrink-0">GitHub event</span>
              <span className={menuDescription}>An issue, a pull request, a push</span>
            </DropdownMenuItem>
          )}
          {has("webhook") ? null : (
            <DropdownMenuItem onSelect={() => onText(setWebhook(text, true))}>
              <TriggerMark mark="webhook" />
              <span className="shrink-0">Webhook</span>
              <span className={menuDescription}>A signed request, on Cloud</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsCard>
  );
}

const KIND: Record<ScheduleKind, { label: string; hint: string }> = {
  days: { label: "Days of the week", hint: "Every day, weekdays, every other Monday" },
  monthly: { label: "Days of the month", hint: "The 1st, the 15th, the last day" },
  interval: { label: "Every few hours", hint: "Counts time from the last run" },
  once: { label: "Once", hint: "One date and time" },
  cron: { label: "Cron expression", hint: "Anything else, in five fields" },
};
const WEEK_STEPS = [1, 2, 3, 4];
const DAY_STEPS = [2, 3, 4, 5, 6, 7, 14];
const DAY_NAME = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;

/**
 * The schedule as a sentence of chips: its kind, then its days and time (or its date, or its expression), then for a
 * repeat when it starts and ends. Every chip edits one key of the file.
 */
function ScheduleRow({ schedule: s, nextRunAt, onChange }: { schedule: Schedule; nextRunAt: string | null | undefined; onChange: (s: Schedule | null) => void }) {
  const kind = scheduleKindOf(s);
  // The page works out simple next runs in this computer's zone; the rest come from the runtime, once saved.
  const next = nextAt(s, new Date(), LOCAL_ZONE);
  const shown = next ?? (nextRunAt ? new Date(nextRunAt) : null);
  const zoned = kind !== "interval" || Boolean(s.start || s.until);
  return (
    <TriggerRow label="the schedule" mark={<Icon icon={Clock01Icon} aria-label="Schedule" className="size-4 shrink-0" />} onRemove={() => onChange(null)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip aria-label={`Repeats: ${KIND[kind].label}`}>{KIND[kind].label}</Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[300px]">
          <DropdownMenuRadioGroup value={kind} onValueChange={(k) => onChange(scheduleAs(k as ScheduleKind, s))}>
            {(Object.keys(KIND) as ScheduleKind[]).map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                <span className="shrink-0">{KIND[k].label}</span>
                <span className={menuDescription}>{KIND[k].hint}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {kind === "days" ? <WeekDays s={s} onChange={onChange} /> : null}
      {kind === "monthly" ? <MonthDays s={s} onChange={onChange} /> : null}
      {kind === "once" ? (
        <>
          <DateField value={s.once!.slice(0, 10)} label="Date" onCommit={(day) => onChange({ ...s, once: `${day} ${s.once!.slice(11)}` })} />
          <span className="text-muted-foreground">at</span>
          <TimeMenu value={s.once!.slice(11)} onChange={(at) => onChange({ ...s, once: `${s.once!.slice(0, 10)} ${at}` })} />
        </>
      ) : null}
      {kind === "cron" ? (
        <CommitInput
          value={s.cron ?? ""}
          onCommit={(cron) => cron !== "" && onChange({ ...s, cron })}
          spellCheck={false}
          aria-label="Cron expression: minute hour day-of-month month day-of-week"
          placeholder="0 9 * * 1-5"
          className="h-8 w-[160px] font-mono text-[13px]"
        />
      ) : null}
      {kind === "interval" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip>{everyWord(s.every ?? "1h")}</Chip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[220px]">
            <DropdownMenuRadioGroup value={s.every ?? "1h"} onValueChange={(every) => onChange({ ...s, every })}>
              {(EVERY.includes(s.every ?? "") ? EVERY : [s.every ?? "1h", ...EVERY]).map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {everyWord(e)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* The zone only when it isn't this computer's, by its city: the full name is the hover. */}
      {zoned && s.timezone && s.timezone !== LOCAL_ZONE ? (
        <span className="text-[13px] text-muted-foreground" title={s.timezone}>
          {zoneWord(s.timezone)}
        </span>
      ) : null}
      {kind !== "once" ? <Ends s={s} onChange={onChange} /> : null}
      {shown ? <span className="ml-1 text-[13px] text-[hsl(var(--subtle-foreground))]">{nextRunWord(shown, zoned ? s.timezone : undefined)}</span> : null}
    </TriggerRow>
  );
}

/** Days of the week and the time; every N days or weeks counts from a start, so choosing one sets today as it. */
function WeekDays({ s, onChange }: { s: Schedule; onChange: (s: Schedule) => void }) {
  const step = stepOf(s);
  const days = s.weekdays ?? [];
  const everyDays = step?.unit === "d" && step.n > 1 ? step.n : null;
  const withStart = (next: Schedule): Schedule => (stepOf(next) && stepOf(next)!.n > 1 && !next.start ? { ...next, start: localDay(new Date()) } : next);
  const setDays = (weekdays: ReadonlyArray<Weekday>) => {
    const { every: _every, ...rest } = s;
    const keepWeeks = step?.unit === "w" && weekdays.length > 0 && weekdays.length < 7;
    onChange(keepWeeks ? { ...rest, every: s.every!, weekdays } : { ...rest, weekdays });
  };
  const subset = everyDays === null && days.length > 0 && days.length < 7;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip aria-label={`Days: ${everyDays ? `Every ${everyDays} days` : daysWord(days)}`}>{everyDays ? `Every ${everyDays} days` : daysWord(days)}</Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[420px] w-[220px] overflow-y-auto">
          <DropdownMenuItem onSelect={() => setDays([])}>Every day</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDays(["mon", "tue", "wed", "thu", "fri"])}>Every weekday</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDays(["sat", "sun"])}>Weekends</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Every few days</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[160px]">
              <DropdownMenuRadioGroup value={everyDays ? String(everyDays) : ""} onValueChange={(n) => onChange(withStart({ ...s, weekdays: [], every: `${n}d` }))}>
                {DAY_STEPS.map((n) => (
                  <DropdownMenuRadioItem key={n} value={String(n)}>
                    Every {n} days
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {WEEKDAYS.map((d) => (
            <DropdownMenuCheckboxItem
              key={d}
              checked={everyDays === null && (days.length === 0 || days.includes(d))}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => {
                const all = everyDays !== null ? [] : days.length === 0 ? [...WEEKDAYS] : [...days];
                const out = on ? [...all, d] : all.filter((x) => x !== d);
                if (out.length > 0) setDays(out.length === 7 ? [] : out);
              }}
            >
              {DAY_NAME[d]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {subset ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip aria-label="How often">{step?.unit === "w" && step.n > 1 ? `every ${step.n} weeks` : "every week"}</Chip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[180px]">
            <DropdownMenuRadioGroup
              value={String(step?.unit === "w" ? step.n : 1)}
              onValueChange={(n) => {
                const { every: _every, ...rest } = s;
                onChange(n === "1" ? rest : withStart({ ...rest, every: `${n}w` }));
              }}
            >
              {WEEK_STEPS.map((n) => (
                <DropdownMenuRadioItem key={n} value={String(n)}>
                  {n === 1 ? "Every week" : `Every ${n} weeks`}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <span className="text-muted-foreground">at</span>
      <TimeMenu value={s.at ?? "09:00"} onChange={(at) => onChange({ ...s, at })} />
    </>
  );
}

/** Days of the month (1 to 31, and the last day) and the time. A month without a day skips it. */
function MonthDays({ s, onChange }: { s: Schedule; onChange: (s: Schedule) => void }) {
  const days = s.monthdays && s.monthdays.length > 0 ? s.monthdays : [1];
  const toggle = (d: number | "last", on: boolean) => {
    const out = on ? [...days.filter((x) => x !== d), d] : days.filter((x) => x !== d);
    if (out.length > 0) onChange({ ...s, monthdays: out });
  };
  const word = `On the ${monthDaysWord(days.map((d) => (d === "last" ? -1 : d)))}`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip aria-label={`Days of the month: ${word}`}>{word}</Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[360px] w-[200px] overflow-y-auto">
          <DropdownMenuCheckboxItem checked={days.includes("last")} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => toggle("last", on)}>
            <span className="shrink-0">Last day</span>
            <span className={menuDescription}>28th to 31st</span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <DropdownMenuCheckboxItem key={d} checked={days.includes(d)} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => toggle(d, on)} className="tabular-nums">
              {monthDaysWord([d])}
              {d >= 29 ? <span className={menuDescription}>skips shorter months</span> : null}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-muted-foreground">at</span>
      <TimeMenu value={s.at ?? "09:00"} onChange={(at) => onChange({ ...s, at })} />
    </>
  );
}

/** When a repeat starts and stops: a first day, then no end, a last day, or a number of runs. */
function Ends({ s, onChange }: { s: Schedule; onChange: (s: Schedule) => void }) {
  const today = localDay(new Date());
  const ends = s.until ? "until" : s.count !== undefined ? "count" : "never";
  // A start and an until are days in the schedule's zone; an interval gets this computer's when it takes one.
  const zone = s.timezone ?? LOCAL_ZONE;
  const { until: _until, count: _count, ...open } = s;
  return (
    <>
      {s.start || (stepOf(s)?.n ?? 1) > 1 ? (
        <>
          <span className="text-muted-foreground">from</span>
          <DateField value={s.start ?? today} label="First day" onCommit={(start) => onChange({ ...s, start, timezone: zone })} />
        </>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip aria-label={`Ends: ${endsWord(s)}`}>{ends === "never" ? "No end" : ends === "until" ? "until" : "for"}</Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          <DropdownMenuRadioGroup
            value={ends}
            onValueChange={(v) =>
              onChange(v === "never" ? open : v === "until" ? { ...open, until: s.until ?? localDay(new Date(), 30), timezone: zone } : { ...open, count: s.count ?? 10 })
            }
          >
            <DropdownMenuRadioItem value="never">No end</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="until">
              <span className="shrink-0">Until a date</span>
              <span className={menuDescription}>Its last day</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="count">
              <span className="shrink-0">For a number of runs</span>
              <span className={menuDescription}>Runs by hand don't count</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {!s.start && (stepOf(s)?.n ?? 1) <= 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange({ ...s, start: localDay(new Date(), 1), timezone: zone })}>
                <span className="shrink-0">Start later</span>
                <span className={menuDescription}>Pick a first day</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {ends === "until" ? <DateField value={s.until!} label="Last day" onCommit={(until) => onChange({ ...s, until })} /> : null}
      {ends === "count" ? (
        <>
          <CommitInput
            value={String(s.count)}
            onCommit={(v) => /^[1-9]\d{0,5}$/.test(v) && onChange({ ...s, count: Number(v) })}
            inputMode="numeric"
            aria-label="Number of runs"
            className="h-8 w-[64px] text-right tabular-nums"
          />
          <span className="text-muted-foreground">{s.count === 1 ? "run" : "runs"}</span>
        </>
      ) : null}
    </>
  );
}

/** A day, picked on the calendar or typed; it writes once the day is whole. */
function DateField({ value, label, onCommit }: { value: string; label: string; onCommit: (day: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      type="date"
      aria-label={label}
      value={draft}
      onChange={(e) => {
        const day = e.currentTarget.value;
        setDraft(day);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day !== value) onCommit(day);
      }}
      className="h-8 w-[150px] tabular-nums"
    />
  );
}

function TimeMenu({ value, onChange }: { value: string; onChange: (at: string) => void }) {
  const times = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Opened, the menu shows the time it holds, not midnight.
  useLayoutEffect(() => {
    if (open) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>("[data-state=checked]")?.scrollIntoView({ block: "center" }));
  }, [open]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Chip aria-label={`Time: ${value}`}>
          <span className="tabular-nums">{value}</span>
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={list} align="start" className="max-h-[288px] w-[120px] overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {times.map((t) => (
            <DropdownMenuRadioItem key={t} value={t} className="tabular-nums">
              {t}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LABELLED = (events: ReadonlyArray<string>) => events.some((e) => e.endsWith(".labeled"));

function GitHubRow({ github: g, cloud, onChange }: { github: GitHub; cloud: boolean; onChange: (g: GitHub | null) => void }) {
  const [labels, setLabels] = useState(g.labels.join(", "));
  useEffect(() => setLabels(g.labels.join(", ")), [g.labels]);
  const commitLabels = () => {
    const next = labels.split(",").map((l) => l.trim()).filter(Boolean);
    if (next.join() !== g.labels.join()) onChange({ ...g, labels: next });
  };
  const first = g.events[0] ?? "issues.opened";
  return (
    <TriggerRow label="the GitHub trigger" mark={<TriggerMark mark="github" />} onRemove={() => onChange(null)}>
      <span className="text-muted-foreground">When</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip>
            {(EVENT_WORD[first] ?? first).replace(/^An? |^Someone /, (w) => w.toLowerCase())}
            {g.events.length > 1 ? <span className="text-muted-foreground">+{g.events.length - 1}</span> : null}
          </Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[300px]">
          <DropdownMenuLabel>Any of these</DropdownMenuLabel>
          {GITHUB_EVENTS.map((e) => {
            const cloudOnly = CLOUD_ONLY_EVENTS.includes(e);
            return (
              <DropdownMenuCheckboxItem
                key={e}
                checked={g.events.includes(e)}
                disabled={cloudOnly && !cloud && !g.events.includes(e)}
                onSelect={(ev) => ev.preventDefault()}
                onCheckedChange={(on) => {
                  const events = on ? [...g.events, e] : g.events.filter((x) => x !== e);
                  if (events.length > 0) onChange({ ...g, events });
                }}
              >
                <span className="shrink-0">{EVENT_WORD[e]}</span>
                {cloudOnly && !cloud ? <span className={menuDescription}>Cloud only</span> : null}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {LABELLED(g.events) ? (
        <>
          <span className="text-muted-foreground">with label</span>
          <Input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            onBlur={commitLabels}
            onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && (e.preventDefault(), commitLabels())}
            placeholder="caveman"
            aria-label="Labels, separated by commas"
            className="h-8 w-[160px] rounded-lg text-[13px]"
          />
        </>
      ) : null}
      {g.events.includes("issue_comment.created") ? (
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={g.mention} onChange={(e) => onChange({ ...g, mention: e.target.checked })} className="size-3.5 accent-[hsl(var(--primary))]" />
          only when it mentions @caveman
        </label>
      ) : null}
    </TriggerRow>
  );
}

// ------------------------------------------------------------ instructions

function Instructions({ form: f, text, onText, resolved }: { form: Form; text: string; onText: (t: string) => void; resolved: ReadonlyMap<string, string> }) {
  const many = f.steps.length > 1;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="instructions-title">
      <header>
        <h3 id="instructions-title" className="text-[14px] font-medium">
          Instructions
        </h3>
        {many ? <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{f.steps.length} steps, each with its own model.</p> : null}
      </header>
      {f.steps.map((s, i) => (
        <Fragment key={s.name}>
          {i > 0 ? <Then when={s.when} /> : null}
          <StepCard step={s} n={many ? i + 1 : null} resolved={resolved.get(s.name)} text={text} onText={onText} />
        </Fragment>
      ))}
      <p className="text-[12.5px] leading-[18px] text-[hsl(var(--subtle-foreground))]">Caveman reads this on every run, with the repo and whatever started it. Say what to look at, what to change and what to report.</p>
    </section>
  );
}

/** Between two steps: when the next one runs. */
function Then({ when }: { when: string | undefined }) {
  return (
    <div className="-my-1 flex items-center gap-2 pl-5 text-[12.5px] text-muted-foreground">
      <span aria-hidden className="h-4 w-px bg-border" />
      {when ? <span className="font-mono text-[12px]">if {when}</span> : <span>then</span>}
    </div>
  );
}

function StepCard({ step: s, n, resolved, text, onText }: { step: Step; n: number | null; resolved: string | undefined; text: string; onText: (t: string) => void }) {
  const set = (key: Parameters<typeof setStepKey>[2]) => (v: string | number | undefined) => onText(setStepKey(text, s.name, key, v));
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card focus-within:border-foreground/20">
      {n !== null ? (
        <div className="flex h-10 items-center gap-2.5 border-b border-border/60 px-4">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-[11px] font-medium tabular-nums text-muted-foreground ring-1 ring-inset ring-foreground/10">{n}</span>
          <span className="text-[13px] font-medium text-foreground">{s.name}</span>
          {s.decides ? <span className="truncate text-[12.5px] text-muted-foreground">decides {s.decides.join(" or ")}</span> : null}
        </div>
      ) : null}
      {s.kind === "prompt" ? (
        <Prompt value={s.prompt ?? ""} onChange={(v) => onText(setPrompt(text, s.name, v))} />
      ) : s.kind === "agent" ? (
        <p className="flex items-center gap-2 px-4 py-4 text-[14px] text-foreground">
          <Glyph name="tool-subagent" />
          <span className="font-medium">{s.agent}</span>
          <span className="text-muted-foreground">does this step, from its own agent file.</span>
        </p>
      ) : s.kind === "run" ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="font-mono text-[13px] text-[hsl(var(--subtle-foreground))]">$</span>
          <CommitInput value={s.run ?? ""} onCommit={set("run")} aria-label={`${s.name}'s command`} className="h-8 border-transparent bg-transparent px-1 font-mono text-[13px] focus-visible:border-input" />
        </div>
      ) : (
        <p className="px-4 py-4 text-[13.5px] text-muted-foreground">Only waits, then the run goes on.</p>
      )}
      {s.kind === "prompt" || s.kind === "agent" ? (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-3">
          <ModelMenu value={s.model} resolved={resolved} onChange={set("model")} />
          <EffortMenu value={s.effort} onChange={set("effort")} />
          {n !== null ? <ComputerMenu value={s.computer} onChange={(c) => set("computer")(c === "readonly" ? undefined : c)} quiet /> : null}
          {s.checks.length > 0 ? (
            <span className="ml-auto flex flex-wrap items-center gap-1">
              {s.checks.map((c) => (
                <span key={c} className="inline-flex h-6 items-center gap-1 rounded-[5px] bg-foreground/[0.05] px-1.5 text-[12px] text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
                  {/* An agent check by its name; a command check is a command, so it keeps the code face. */}
                  {c.startsWith("agent:") ? (
                    <>
                      <Glyph name="tool-subagent" className="size-3" />
                      {c.slice("agent:".length)}
                    </>
                  ) : (
                    <span className="font-mono text-[11.5px]">
                      <span className="text-[hsl(var(--subtle-foreground))]">$ </span>
                      {c}
                    </span>
                  )}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The prompt: a quiet textarea that grows with what is written. */
function Prompt({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(132, el.scrollHeight)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={"Review the commits since yesterday for bugs that could lose data.\n\nOnly report what you can show in the code. Fix it when the fix is small and safe."}
      aria-label="Instructions"
      spellCheck
      className="block w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[14.5px] leading-[23px] text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))]"
    />
  );
}

/** A quiet chip in the instructions' foot: the model, the effort, the copy it works in. */
const FOOT =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.06] bg-foreground/[0.04]";

export const CLASS_HINT: Record<string, string> = {
  auto: "Caveman Auto picks per turn",
  fast: "Quick and cheap: triage, summaries",
  base: "The everyday model",
  frontier: "The strongest, for hard changes",
};

function ModelMenu({ value, resolved, onChange }: { value: string | undefined; resolved: string | undefined; onChange: (v: string | undefined) => void }) {
  const pinned = value && !(value in CLASS_HINT) ? value : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={FOOT} aria-label={`Model: ${modelWord(value)}`}>
          <Glyph name="engine-caveman" className="size-3.5" />
          {modelWord(value)}
          {resolved && value && value in CLASS_HINT && value !== "auto" ? <span className="text-muted-foreground">{resolved}</span> : null}
          <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[300px]">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v === "" ? undefined : v)}>
          {pinned ? (
            <DropdownMenuRadioItem value={pinned}>
              <span className="shrink-0">{modelWord(pinned)}</span>
              <span className={menuDescription}>Pinned in the file</span>
            </DropdownMenuRadioItem>
          ) : null}
          {Object.entries(CLASS_HINT).map(([cls, hint]) => (
            <DropdownMenuRadioItem key={cls} value={cls}>
              <span className="shrink-0">{modelWord(cls)}</span>
              <span className={menuDescription}>{cls === value && resolved && cls !== "auto" ? `${resolved} here` : hint}</span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="">
            <span className="shrink-0">Default</span>
            <span className={menuDescription}>The engine's own</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1.5 pt-2 text-[11.5px] leading-4 text-muted-foreground">Fast, base and frontier become the models set for them in Settings, on whichever engine runs the step.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EffortMenu({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(FOOT, value && effortTier(value) !== "base" && EFFORT_TIER_TEXT[effortTier(value)])} aria-label={`Effort: ${value ? effortLabel(value) : "default"}`}>
          <Glyph name="state-thinking" className="size-3.5" />
          {value ? effortLabel(value) : "Effort"}
          <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v === "" ? undefined : v)}>
          <DropdownMenuRadioItem value="">
            <span className="shrink-0">Default</span>
            <span className={menuDescription}>The model's own</span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {EFFORTS.map((e) => (
            <DropdownMenuRadioItem key={e} value={e} className={cn(effortTier(e) !== "base" && EFFORT_TIER_TEXT[effortTier(e)])}>
              {effortLabel(e)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ComputerMenu({ value, onChange, quiet = false }: { value: Computer | undefined; onChange: (c: Computer) => void; quiet?: boolean }) {
  const current = value ?? "readonly";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {quiet ? (
          <button type="button" className={FOOT} aria-label={`Working copy: ${COMPUTER_LABEL[current].label}`}>
            <Glyph name={current === "full" ? "branch" : current === "readonly" ? "tool-read" : "tool-other"} className="size-3.5" />
            {COMPUTER_LABEL[current].label}
            <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
          </button>
        ) : (
          <Button variant="secondary" size="sm" aria-label={`Working copy: ${COMPUTER_LABEL[current].label}`}>
            {COMPUTER_LABEL[current].label}
            <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={quiet ? "start" : "end"} className="w-[320px]">
        <DropdownMenuRadioGroup value={current} onValueChange={(v) => onChange(v as Computer)}>
          {(["readonly", "full", "none"] as const).map((c) => (
            <DropdownMenuRadioItem key={c} value={c} className="items-start py-2">
              <span className="flex min-w-0 flex-col">
                <span>{COMPUTER_LABEL[c].label}</span>
                <span className="whitespace-normal text-[12px] leading-4 text-muted-foreground">{COMPUTER_LABEL[c].hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------ fields

/** A field that writes its value once the person is done with it (Enter or leaving it), not on every key. */
function CommitInput({ value, onCommit, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft.trim());
  return <Input {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => (isComposing(e) ? undefined : e.key === "Enter" ? (e.preventDefault(), commit()) : e.key === "Escape" ? setDraft(value) : undefined)} />;
}

function BudgetField({ value, onCommit }: { value: string | undefined; onCommit: (v: string) => void }) {
  const bare = value?.replace(/^\$/, "") ?? "";
  const valid = (v: string) => v === "" || /^\d+(\.\d{1,2})?$/.test(v);
  return (
    <span className="relative flex items-center">
      <span aria-hidden className="pointer-events-none absolute left-2.5 text-[13px] text-muted-foreground">
        $
      </span>
      <CommitInput value={bare} onCommit={(v) => valid(v.replace(/^\$/, "")) && onCommit(v)} inputMode="decimal" placeholder="No limit" aria-label="Budget per run, in dollars" className="h-8 w-[112px] pl-6 text-right tabular-nums" />
    </span>
  );
}

// ------------------------------------------------------------ advanced

const TIMEOUTS = ["5m", "10m", "30m", "1h", "2h"];

function Advanced({ form: f, single, text, onText, explanation, onOpenFile }: { form: Form; single: Step | null; text: string; onText: (t: string) => void; explanation: AutomationExplanation | undefined; onOpenFile?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const levers = explanation ? leverView(explanation) : null;
  const tunable = single && (single.kind === "prompt" || single.kind === "agent");
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex h-14 w-full items-center gap-2 px-5 text-left outline-none transition-colors duration-75 hover:bg-foreground/[0.025] focus-visible:bg-foreground/[0.04]">
        <span className="text-[14px] font-medium text-foreground">Advanced</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {[tunable ? `${single.retries ?? 0} ${single.retries === 1 ? "retry" : "retries"}` : null, tunable ? (single.timeout ? `${single.timeout} per try` : "default time limit") : null, f.outputs.length > 0 ? `${f.outputs.length} ${f.outputs.length === 1 ? "output" : "outputs"}` : null, levers ? `${plural(levers.main.filter((l) => l.on).length, "optimization")} on` : null]
            .filter(Boolean)
            .join(", ")}
        </span>
        <Icon icon={ArrowRight01Icon} className={cn("size-4 text-muted-foreground transition-transform duration-150 ease-snap", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="divide-y divide-border/60 border-t border-border/60">
          {tunable ? (
            <>
              <SettingRow label="Retries" description="More tries when its checks fail, each told why the last one did.">
                <Segmented
                  label="Retries"
                  value={String(single.retries ?? 0)}
                  options={["0", "1", "2", "3"].map((v) => ({ value: v, label: v }))}
                  onChange={(v) => onText(setStepKey(text, single.name, "retries", v === "0" ? undefined : Number(v)))}
                />
              </SettingRow>
              <SettingRow label="Time limit" description="Per try, checks included. Default: 30 minutes in a worktree, else 10.">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="sm">
                      {single.timeout ?? "Default"}
                      <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[160px]">
                    <DropdownMenuRadioGroup value={single.timeout ?? ""} onValueChange={(v) => onText(setStepKey(text, single.name, "timeout", v || undefined))}>
                      <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
                      {TIMEOUTS.map((t) => (
                        <DropdownMenuRadioItem key={t} value={t}>
                          {t}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SettingRow>
            </>
          ) : null}
          {levers && levers.main.length > 0 ? (
            <SettingRow stacked label="Optimizations" description="On by default where there is evidence they help. Hover one for what it is known to do.">
              <span className="flex flex-wrap gap-1.5">
                {[...levers.main, ...levers.detail].map((l) => (
                  <span key={l.label} title={l.evidence} className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] ring-1 ring-inset", l.on ? "bg-success/[0.08] text-foreground ring-success/20" : "bg-foreground/[0.04] text-muted-foreground ring-foreground/[0.08]")}>
                    <span aria-hidden className={cn("size-1.5 rounded-full", l.on ? "bg-success" : "bg-foreground/30")} />
                    {l.label}
                  </span>
                ))}
              </span>
            </SettingRow>
          ) : null}
          {f.outputs.length > 0 ? (
            <SettingRow label="Outputs" description="What it posts when a run works. A run you start by hand waits for you to apply them.">
              <span className="font-mono text-[12.5px] text-muted-foreground">{f.outputs.join(", ")}</span>
            </SettingRow>
          ) : null}
          {onOpenFile ? (
            <SettingRow label="Everything else" description="Inputs, checks, escalation and approvals live in the file.">
              <Button variant="secondary" size="sm" onClick={onOpenFile}>
                <Glyph name="artifact-code" className="size-3.5" />
                Edit the file
              </Button>
            </SettingRow>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ live check

/** Check's problems with one file as it is typed: 250 ms after the text stops changing, only the newest answer counts. */
export function useLiveCheck(projectId: string | null, path: string | null, text: string, dirty: boolean): { problems: ReadonlyArray<AutomationDiagnostic>; error: string | null } {
  const client = useRuntimeSelector((v) => v.client);
  const [problems, setProblems] = useState<ReadonlyArray<AutomationDiagnostic>>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!client || !projectId || !path) return;
    const n = ++seq.current;
    const timer = setTimeout(() => {
      client.call("automation.check", { project_id: projectId, ...(dirty ? { files: [{ path, text }] } : {}) }).then(
        (r) => n === seq.current && (setProblems(r.diagnostics.filter((d) => d.path === path)), setError(null)),
        (e) => n === seq.current && setError(message(e)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [client, projectId, path, text, dirty]);
  return { problems, error };
}


// ------------------------------------------------------------ editing a file

/**
 * A file's text being edited over the text on disk. Edits survive a reread; a save elsewhere (the File tab, a chat)
 * is taken in while there are none, and said when there are (`changedOnDisk`: Save would overwrite it). Saves run one
 * at a time, each writing the newest text; what is typed while one is in flight stays.
 */
export function useFileBuffer(projectId: string, path: string, { write, label }: { write: (text: string) => Promise<void>; label: string }) {
  const file = useFileText(projectId, path);
  const [buf, setBuf] = useState<{ base: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef(buf);
  latest.current = buf;
  const writer = useRef(write);
  writer.current = write;
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  useEffect(() => {
    if (file.value === undefined) return;
    setBuf((b) => (!b || b.text === b.base ? { base: file.value!, text: file.value! } : b));
  }, [file.value]);
  const save = (): Promise<boolean> => {
    const run = chain.current.then(async () => {
      const b = latest.current;
      if (!b || b.text === b.base) return true;
      const text = b.text;
      setSaving(true);
      try {
        await writer.current(text);
        latest.current = latest.current && { ...latest.current, base: text };
        setBuf((cur) => cur && { base: text, text: cur.text });
        return true;
      } catch (e) {
        say(`Couldn't save ${label}: ${message(e)}`, "error");
        return false;
      } finally {
        setSaving(false);
      }
    });
    chain.current = run;
    return run;
  };
  const dirty = buf !== null && buf.text !== buf.base;
  return {
    text: buf?.text,
    error: file.error,
    dirty,
    saving,
    changedOnDisk: dirty && file.value !== undefined && file.value !== buf!.base,
    set: (text: string) => setBuf((b) => (b ? { ...b, text } : b)),
    /** Drops the edits for the file as it is on disk now. */
    discard: () => setBuf((b) => (b && file.value !== undefined ? { base: file.value, text: file.value } : b)),
    save,
  };
}

/** Leaving with unsaved edits asks first; going between tabs of the same one never does. */
export function useLeaveGuard(dirty: boolean, what = "this automation", leaves: (current: Location, next: Location) => boolean = (current, next) => current.pathname !== next.pathname) {
  // Leaving is a new path by default: a tab or filter in the query stays on the page. A page named by its query (a
  // rule's ?path=) says so through `leaves`.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && leaves(currentLocation, nextLocation));
  // The dialog closes before it confirms: a close stays put only when Leave did not follow it.
  const leaving = useRef(false);
  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => !open && queueMicrotask(() => !leaving.current && blocker.state === "blocked" && blocker.reset())}
      title="Leave without saving?"
      description={`Your changes to ${what} aren't saved. Leaving drops them.`}
      confirmLabel="Leave"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => {
        leaving.current = true;
        if (blocker.state === "blocked") blocker.proceed();
      }}
    />
  );
}

/** ⌘S saves, from anywhere on the page; an editor that saves itself (it prevents the key) wins. */
export function useSaveKey(on: boolean, save: () => void) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "s" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
}

/** Under the header when the file changed on disk beneath unsaved edits. */
export function ChangedOnDisk({ onLoad }: { onLoad: () => void }) {
  return (
    <div role="status" className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card py-2.5 pl-4 pr-2.5 text-[13px]">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="min-w-0 flex-1 text-foreground">
        The file changed on disk while you were editing. <span className="text-muted-foreground">Save writes yours over it.</span>
      </span>
      <Button size="sm" variant="secondary" onClick={onLoad}>
        Load the new one
      </Button>
    </div>
  );
}
