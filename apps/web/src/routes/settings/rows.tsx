// The pieces every Settings section is built from. The shell draws the page's
// title and centres a 720px column; a section is a stack of these and nothing
// hand-laid. A list page (Computers, Models & keys, Plan, Environments) fills
// the pane instead and is a FlatList of FlatRows:
//
//   <SettingsCard title actions>          a small grey label above one card
//     <SettingRow label description id>{control}</SettingRow>
//     <SettingRow label to="…">{status}</SettingRow>   a link row with a chevron
//     <SettingRow label stacked>{textarea}</SettingRow> a full-width control
//     <SettingsCardBody>…</SettingsCardBody>            anything that is not a row
//     <SettingsLine>…</SettingsLine>                    nothing here yet, loading, an error
//
// Few words: a label names the setting, and its line says what it does in one
// short sentence, or is left out when the label says it (copy.test.ts).
import type { Params } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { createContext, useContext, useEffect, useId, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Link } from "react-router";
import { isComposing } from "../../panels/chrome.tsx";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { SaveLeftBehind, saveFailure } from "../../state/settings-saves.ts";
import { ReportButton } from "../../components/ReportButton.tsx";

/**
 * True under a Settings page. Other pages build from these cards too (the automation editor, an agent's page, the
 * Chief's sheet), beside their own 14px headings: there a card keeps that heading, and only Settings wears the small
 * grey label on the page's edge.
 */
const InSettings = createContext(false);

/**
 * The page: its title, then its cards. The shell renders it; a phone's bar carries the title instead. One left edge
 * and one right edge run down the whole page: the title, every card's label and every row's words start on the same
 * pixel (21px in: a card's 1px edge and its rows' 20px), and a card's verb ends where its rows' controls end.
 * `note`: one line under the title, for a fact the whole page owes (in Cloud that keeps nothing of its person's: a
 * change made there stays there).
 * `wide`: a list page (Computers, Models & keys, Plan, Environments). It fills the pane and its lists are rows on
 * hairlines with no box, so its title sits on the pane's own edge, level with them.
 */
export function SettingsPage({ title, note, wide, children }: { title: string; note?: ReactNode; wide?: boolean; children: ReactNode }) {
  if (wide) {
    return (
      <InSettings.Provider value>
        <Flat.Provider value={true}>
          <div className="flex w-full flex-col pb-16">
            <h1 aria-live="polite" className="mb-4 text-[20px] font-semibold tracking-[-0.01em] max-md:hidden">
              {title}
            </h1>
            <div className="flex flex-col gap-8">{children}</div>
          </div>
        </Flat.Provider>
      </InSettings.Provider>
    );
  }
  return (
    <InSettings.Provider value>
      <div className="mx-auto w-full max-w-[720px] pb-16">
        <div className={cn("mb-6 px-[21px]", note ? "max-md:mb-4" : "max-md:hidden")}>
          {/* Read out when the section changes; focus stays in the nav so the next section is one key away. */}
          <h1 aria-live="polite" className="text-[20px] font-semibold tracking-[-0.01em] max-md:hidden">
            {title}
          </h1>
          {note ? <p className="mt-1 text-pretty text-[12.5px] leading-[18px] text-muted-foreground max-md:mt-0">{note}</p> : null}
        </div>
        <div className="flex flex-col gap-8">{children}</div>
      </div>
    </InSettings.Provider>
  );
}

/** Inside a list page: a section is rows on hairlines across the pane, never a box, and its rows are 44px. */
const Flat = createContext(false);
export const useFlat = (): boolean => useContext(Flat);

/** How a state reads: its dot's colour. A dot never says a state alone: its word beside it does (STYLE.md 12). */
export type StateTone = "ok" | "busy" | "warn" | "idle" | "bad";
const STATE_DOT: Record<StateTone, string> = {
  ok: "bg-success",
  busy: "bg-warning animate-pulse motion-reduce:animate-none",
  warn: "bg-warning",
  idle: "bg-muted-foreground/50",
  bad: "bg-destructive",
};

/** One state: its dot and its word or short line, which wraps rather than cut off. */
export function State({ tone, children, className }: { tone: StateTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-baseline gap-2", className)}>
      <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", STATE_DOT[tone])} aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/**
 * A flat list on a list page (Computers, Models & keys): rows on hairlines across the pane, no box and no heading,
 * after minimal settings lists. The first on a page has no line above it: Settings' bar is right there.
 */
export function FlatList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("divide-y divide-border/60 border-y border-border/60 first:border-t-0", className)}>
      {children}
    </div>
  );
}

/**
 * One row of a flat list, 44px: a mark, the name, what it says in grey beside it, and at most one control at the
 * right. In a narrow pane the grey part goes under the name, so nothing is cut off. `indent`: a line under an
 * opened row. `stack`: a setting, whose name is a label and whose control is wide (a dropdown): in a narrow pane the
 * control goes under the label at full width, and the label is never cut.
 */
export function FlatRow({ icon, name, children, action, indent, stack, className }: { icon?: ReactNode; name: ReactNode; children?: ReactNode; action?: ReactNode; indent?: boolean; stack?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 py-2", stack && "max-sm:gap-y-1.5", indent && "pl-6", className)}>
      {icon ? <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span> : null}
      <div className={cn("min-w-0 truncate text-[13px] text-foreground lg:shrink-0", stack ? "max-sm:basis-full sm:max-lg:flex-1" : "max-lg:flex-1", icon ? "lg:w-40" : indent ? "lg:w-[10.5rem]" : "lg:w-48")}>{name}</div>
      <div className="flex min-w-0 items-baseline gap-x-4 text-[13px] text-muted-foreground max-lg:order-last max-lg:basis-full lg:flex-1">{children}</div>
      {action ? <div className={cn("ml-auto flex shrink-0 items-center gap-1", stack && "max-sm:ml-0 max-sm:w-full max-sm:[&>*]:w-full")}>{action}</div> : null}
    </div>
  );
}

/**
 * A save that failed, over the top of the page every section shares, so it shows wherever the control was and however
 * far the page has scrolled (useSaveSettings). Always mounted, so a screen reader hears it arrive.
 */
export function SaveFailure() {
  const settingsSaveError = useRuntimeSelector((v) => v.settingsSaveError);
  const setSettingsSaveError = useRuntimeSelector((v) => v.setSettingsSaveError);
  return (
    <div role="alert" className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4 max-md:top-14">
      {settingsSaveError ? (
        <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-popover py-1 pl-3 pr-1 shadow-overlay">
          <span className="truncate text-[12.5px] text-destructive" title={settingsSaveError}>
            {settingsSaveError}
          </span>
          <ReportButton request={{ surface: "other", error: { name: "SettingsSaveFailed", message: settingsSaveError } }} />
          <Button size="sm" variant="ghost" onClick={() => setSettingsSaveError?.(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A group of settings: a small grey label above (the app's section-header look), a group-wide verb level with it, then
 * one card of rows. `description` is for the rare group that owes the person a fact its rows can't carry (where their
 * voice goes); most have none. `headingRef`: the label takes focus by script (where focus goes once the row it was on
 * is gone). Outside a Settings page the heading is the 14px one those pages use (InSettings).
 */
export function SettingsCard({
  title,
  description,
  actions,
  children,
  className,
  headingRef,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const id = useId();
  const settings = useContext(InSettings);
  const flat = useFlat();
  const Heading = settings ? "h2" : "h3";
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("flex flex-col", flat ? "gap-1.5" : settings ? "gap-2" : "gap-3")}>
      {title || actions ? (
        <header className={cn("flex flex-wrap justify-between gap-x-4 gap-y-2", flat ? "items-center" : settings ? "items-center px-[21px]" : "items-end")}>
          <div className={cn("flex-1", settings ? "min-w-[12rem]" : "min-w-[16rem]")}>
            {title ? (
              <Heading
                id={id}
                ref={headingRef}
                tabIndex={headingRef ? -1 : undefined}
                className={cn(
                  flat ? "text-[12px] font-normal text-muted-foreground" : settings ? "text-[12.5px] font-normal text-muted-foreground" : "text-[14px] font-medium",
                  headingRef && "w-fit rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                {title}
              </Heading>
            ) : null}
            {description ? (
              <p className={cn("mt-0.5", settings ? "text-pretty text-[12.5px] leading-[18px] text-[hsl(var(--subtle-foreground))]" : "text-[13px] leading-5 text-muted-foreground")}>{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("divide-y divide-border/60", flat ? "border-y border-border/60" : "overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</div>
    </section>
  );
}

/** Content in a card that is not a row (a gallery, a table, a meter), at the rows' inset. */
export function SettingsCardBody({ children, className }: { children: ReactNode; className?: string }) {
  const flat = useFlat();
  return <div className={cn(flat ? "py-3" : "px-5 py-3.5", className)}>{children}</div>;
}

/**
 * Plain-words instructions an agent follows (a guide's taste, how chats are named): a field and its own Save, which
 * says Saved once the runtime took it, or why not. The placeholder shows what to write, so most need no description.
 */
export function InstructionsCard({
  title,
  description,
  label,
  placeholder,
  maxLength,
  value,
  disabled,
  onSave,
}: {
  title: string;
  description?: ReactNode;
  /** The field's accessible name. */
  label: string;
  placeholder: string;
  maxLength: number;
  value: string;
  disabled: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  // What the person typed and has not saved yet; until then the field shows `value`. Never copied from `value`: a save
  // moves it to the new text at once and back when the runtime refuses it, which would throw the typing away.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});
  const dirty = text !== value;
  return (
    <SettingsCard title={title} description={description}>
      <SettingsCardBody className="flex flex-col gap-3">
        <textarea
          value={text}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(e) => {
            setDraft(e.target.value);
            setState({});
          }}
          rows={3}
          aria-label={label}
          placeholder={placeholder}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-5 placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-end gap-3">
          <span aria-live="polite" className={cn("text-[12.5px]", state.error ? "text-destructive" : "text-muted-foreground")}>
            {state.error ?? (state.saved && !dirty ? "Saved" : "")}
          </span>
          <Button
            variant="secondary"
            disabled={!dirty || state.busy === true}
            onClick={() => {
              const sent = text;
              setState({ busy: true });
              onSave(sent.trim()).then(
                () => {
                  setDraft((d) => (d === sent ? null : d));
                  setState({ saved: true });
                },
                (e: unknown) => setState({ error: e instanceof Error ? e.message : String(e) }),
              );
            }}
          >
            Save
          </Button>
        </div>
      </SettingsCardBody>
    </SettingsCard>
  );
}

/**
 * One setting: the label and, when it needs one, a short line on the left, its
 * control on the right (wrapping under the copy when the card is narrow). `id`
 * ties the label to the control. `to` makes the row a link with a chevron;
 * `stacked` puts a wide control (a textarea, a list) under the copy at full width.
 */
export function SettingRow({ label, description, id, icon, to, stacked, children, className }: {
  label: ReactNode;
  description?: ReactNode;
  id?: string;
  /** A leading mark: a vendor logo, a companion. */
  icon?: ReactNode;
  to?: string;
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const flat = useFlat();
  // The mark sits with its words: the row's wide gap is between the copy and its control, never inside the copy.
  const copy = (
    <div className="flex min-w-[12rem] flex-1 items-center gap-3">
      {icon ? <span className="flex size-7 shrink-0 items-center justify-center">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {id ? (
          <label htmlFor={id} className="text-[13px]">
            {label}
          </label>
        ) : (
          <div className="text-[13px]">{label}</div>
        )}
        {description ? <div className="mt-0.5 text-pretty text-[12.5px] leading-[18px] text-muted-foreground">{description}</div> : null}
      </div>
    </div>
  );
  if (to) {
    return (
      <Link to={to} className={cn("flex items-center gap-3 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40", flat ? "min-h-11 py-2" : "min-h-14 px-5 py-3", className)}>
        {copy}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {children}
          <Icon icon={ArrowRight01Icon} className="size-4" />
        </span>
      </Link>
    );
  }
  if (stacked) {
    return (
      <div className={cn("flex flex-col gap-2.5", flat ? "py-3" : "px-5 py-3.5", className)}>
        {copy}
        {children}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-6 gap-y-2", flat ? "min-h-11 py-2" : "min-h-14 px-5 py-3", className)}>
      {copy}
      {children ? <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * A select, a field or a model picker in a row: every control in Settings is 32px tall (the kit's own height, a
 * `<Button>` at its default size included) and this one width, so a card's right column lines up on both edges.
 */
export const CONTROL = "w-60";

/**
 * A model picker in a row wears the kit Select's edge, fill and width, with its chevron at the far end: beside a
 * Select it is the same control, not a line of text.
 */
export const PICKER = "h-8 w-60 border border-input bg-control px-2.5 data-[state=open]:border-ring [&>svg:last-child]:ml-auto";

/**
 * A line of words in a card that is no setting: nothing here yet, still loading, what went wrong. As tall as a row,
 * at the rows' inset, so a card reads the same whether it holds settings or says why it holds none.
 */
export function SettingsLine({ children, tone, status }: { children: ReactNode; tone?: "bad" | "warn"; status?: boolean }) {
  return (
    <p role={tone ? "alert" : status ? "status" : undefined} className={cn("px-5 py-4 text-[13px] leading-5 text-muted-foreground", tone === "bad" && "text-destructive", tone === "warn" && "text-warning")}>
      {children}
    </p>
  );
}

/** One choice of a few, as a row of buttons (a radio group: one tab stop, arrow keys move and pick). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = (at + delta + options.length) % options.length;
    onChange(options[next]!.value);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={step} className="inline-flex h-8 items-center rounded-md border border-input bg-control p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-full rounded px-2.5 text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            o.value === value && "bg-secondary text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * settings.set. The control moves at once and only Settings reloads (the runtime answers with them).
 * A failed save puts the control back and says so in Settings' header; with `{ throws: true }` it
 * rejects instead, for a card that shows its own error beside the control.
 */
export function useSaveSettings({ throws = false }: { throws?: boolean } = {}): (patch: Params<"settings.set">["settings"]) => Promise<void> {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const saveSettings = useRuntimeSelector((v) => v.saveSettings);
  const setSettingsSaveError = useRuntimeSelector((v) => v.setSettingsSaveError);
  return async (patch) => {
    if (!saveSettings) {
      // A fixture runtime (tests, the style page): the plain call.
      if (!client) return;
      await client.call("settings.set", { request_id: requestId(), settings: patch });
      return refresh();
    }
    setSettingsSaveError?.(null);
    try {
      await saveSettings(patch);
    } catch (cause) {
      if (cause instanceof SaveLeftBehind) return;
      if (throws) throw cause;
      setSettingsSaveError?.(saveFailure(cause));
    }
  };
}

/** A whole number, saved on blur or Enter and kept within its bounds. One width, so a card of them lines up. */
export function NumberInput({
  id,
  value,
  min,
  max,
  step = 1,
  unit,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** What the number counts ("lines", "%"): inside the field, so the field still ends on the card's edge. */
  unit?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label className="flex h-8 w-24 cursor-text items-center gap-1.5 rounded-md border border-input bg-control px-2.5 text-[13px] transition-colors focus-within:border-ring">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isComposing(e)) e.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {unit ? <span className="shrink-0 text-muted-foreground">{unit}</span> : null}
    </label>
  );
}
