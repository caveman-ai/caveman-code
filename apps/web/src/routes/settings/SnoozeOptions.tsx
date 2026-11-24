// Settings > General > Snooze: the choices in a chat's Snooze menu (upstream
// snooze presets, #26208), kept in upstream settings through settings.set's
// inbox_snooze_options. A wait from the pick or a local time on a day; up to 8.

import type { SnoozeOption } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { useState, type FormEvent } from "react";
import { BarButton } from "../../panels/chrome.tsx";
import { DEFAULT_SNOOZE_OPTIONS, MAX_SNOOZE_OPTIONS, snoozeOptionFrom, snoozeOptionId, snoozeOptionText, snoozePresets, withSnoozeOption } from "../../state/inbox-state.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { SettingsCard, useSaveSettings } from "./rows.tsx";

type Day = Extract<SnoozeOption, { kind: "at" }>["day"];
const DAYS: ReadonlyArray<Day> = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const UNITS = ["minutes", "hours", "days"] as const;
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const same = (a: ReadonlyArray<SnoozeOption>, b: ReadonlyArray<SnoozeOption>) => a.length === b.length && a.every((o, i) => snoozeOptionId(o) === snoozeOptionId(b[i]!));

export function SnoozeOptionsCard() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings({ throws: true });
  const options = settings?.inbox_snooze_options ?? DEFAULT_SNOOZE_OPTIONS;
  const [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<"after" | "at">("after");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("minutes");
  const [day, setDay] = useState<Day>("friday");
  const [time, setTime] = useState("16:00");
  const draft = snoozeOptionFrom(kind === "after" ? { kind, amount, unit } : { kind, day, time });
  const full = options.length >= MAX_SNOOZE_OPTIONS;
  const known = draft !== null && options.some((o) => snoozeOptionId(o) === snoozeOptionId(draft));

  const put = (next: ReadonlyArray<SnoozeOption>) => {
    setProblem(null);
    save({ inbox_snooze_options: [...next] }).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (draft && !known && !full) put(withSnoozeOption(options, draft));
  };
  // What the menu would show now, for the description: the person sees the order it takes.
  const menu = snoozePresets(new Date(), options);

  return (
    <SettingsCard
      title="Snooze menu"
      actions={
        !same(options, DEFAULT_SNOOZE_OPTIONS) ? (
          <Button type="button" variant="ghost" disabled={!settings} onClick={() => put(DEFAULT_SNOOZE_OPTIONS)}>
            Reset
          </Button>
        ) : undefined
      }
    >
      <ul aria-label="Snooze options">
        {options.map((o) => {
          const shown = menu.find((p) => p.id === snoozeOptionId(o));
          return (
            <li key={snoozeOptionId(o)} className="group/snooze flex h-10 items-center gap-3 border-b border-border/60 px-5 text-[13px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{snoozeOptionText(o)}</span>
              {/* A wait's clock time if picked now; a time of day today that has passed is left out of the menu. */}
              <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">{!shown ? "Passed for today" : o.kind === "after" ? `Until ${shown.when}` : null}</span>
              <BarButton size="sm" className="-mr-1" label={`Remove ${snoozeOptionText(o)}`} disabled={!settings} onClick={() => put(options.filter((x) => snoozeOptionId(x) !== snoozeOptionId(o)))}>
                <Icon icon={Cancel01Icon} />
              </BarButton>
            </li>
          );
        })}
        {options.length === 0 ? <li className="px-5 py-3 text-[13px] text-muted-foreground">None. The menu still offers Pick a date and time.</li> : null}
      </ul>
      <form onSubmit={add} aria-label="Add a snooze option" className="flex flex-wrap items-center gap-2 px-5 py-3">
        <Select value={kind} onValueChange={(v) => setKind(v as "after" | "at")}>
          <SelectTrigger aria-label="Kind" className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="after">After</SelectItem>
            <SelectItem value="at">On</SelectItem>
          </SelectContent>
        </Select>
        {kind === "after" ? (
          <>
            <Input aria-label="How many" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-8 w-20 tabular-nums" />
            <Select value={unit} onValueChange={(v) => setUnit(v as (typeof UNITS)[number])}>
              <SelectTrigger aria-label="Unit" className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {capital(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : (
          <>
            <Select value={day} onValueChange={(v) => setDay(v as Day)}>
              <SelectTrigger aria-label="Day" className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {capital(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input aria-label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-8 w-28 tabular-nums" />
          </>
        )}
        <Button type="submit" variant="secondary" disabled={!settings || draft === null || known || full}>
          Add
        </Button>
        <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
          {full ? `${MAX_SNOOZE_OPTIONS} is the most` : known ? "Already there" : draft === null ? (kind === "after" ? "1 minute to 30 days" : "A time like 16:00") : null}
        </span>
      </form>
      {problem ? (
        <p role="alert" className="px-5 py-2 text-[12.5px] text-destructive">
          {problem}
        </p>
      ) : null}
    </SettingsCard>
  );
}
