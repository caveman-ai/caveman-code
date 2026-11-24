// An app-saved webhook automation's request rules (upstream #22194, #22234, #23282): which requests start a run
// (filters, all of which must hold) and how it treats repeats and bursts (a replay key; a coalescing key and window).
// It reads as sentences; Edit opens the rows, and Save sends only what changed (automation.set_webhook_rules), so the
// rest of what it stores (its model, permissions, secret) stays as it is.
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Input } from "@caveman-app/ui/components/input";
import { Add01Icon, ArrowDown01Icon, Cancel01Icon, Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState } from "react";
import { SectionHeader } from "../../panels/chrome.tsx";
import { requestId, useRuntimeSelector } from "../../state/runtime.tsx";
import { say } from "./actions.tsx";
import { LIST, message, refresh } from "./data.ts";
import type { Automation } from "./model.ts";
import {
  dedupeChanged,
  dedupeDraft,
  dedupeWords,
  emptyFilter,
  filterDrafts,
  filtersChanged,
  filterWords,
  MAX_FILTERS,
  OPS,
  opLabel,
  parseDedupe,
  parseFilters,
  WINDOW,
  type DedupeDraft,
  type FilterDraft,
} from "./webhook-rules.ts";

type Hook = Extract<Automation["trigger"], { type: "webhook" }>;

export function WebhookRules({ automation: a, hook }: { automation: Automation; hook: Hook }) {
  const [editing, setEditing] = useState(false);
  const filters = hook.filters ?? [];
  const dedupe = dedupeWords(hook.dedupe);
  return (
    <section aria-label="Which requests run it">
      <div className="mb-2 flex items-center gap-2">
        <SectionHeader as="h2" className="px-0 pb-0">
          Which requests run it
        </SectionHeader>
        {editing ? null : (
          <Button size="sm" variant="ghost" className="-my-1 ml-auto" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <RulesForm automation={a} hook={hook} onDone={() => setEditing(false)} />
      ) : (
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
          {filters.length === 0 ? (
            <p className="text-muted-foreground">Every request to its URL starts a run.</p>
          ) : (
            <>
              <p className="text-muted-foreground">Only a request where {filters.length === 1 ? "this holds" : "all of these hold"}; the rest are skipped and listed below.</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {filters.map((f, i) => (
                  <li key={i} className="min-w-0 truncate font-mono text-[12.5px] text-foreground" title={filterWords(f)}>
                    {filterWords(f)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-2.5 border-t border-border/60 pt-2.5 text-muted-foreground">
            {dedupe.length === 0 ? (
              <p>Every request runs, a repeat too.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {dedupe.map((line) => (
                  <li key={line}>{line}.</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const label = "mb-1 block text-[12.5px] text-muted-foreground";

function RulesForm({ automation: a, hook, onDone }: { automation: Automation; hook: Hook; onDone: () => void }) {
  const client = useRuntimeSelector((v) => v.client);
  // What the form opened with: a save sends only what changed, so it never undoes another device's edit of the other.
  const [savedRows] = useState(() => filterDrafts(hook.filters));
  const [savedDedupe] = useState(() => dedupeDraft(hook.dedupe));
  const [rows, setRows] = useState<ReadonlyArray<FilterDraft>>(savedRows);
  const [d, setD] = useState<DedupeDraft>(savedDedupe);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (id: string, patch: Partial<FilterDraft>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async () => {
    const f = parseFilters(rows);
    if ("error" in f) return setError(f.error);
    const k = parseDedupe(d);
    if ("error" in k) return setError(k.error);
    const sendFilters = filtersChanged(savedRows, rows);
    const sendDedupe = dedupeChanged(savedDedupe, d);
    if (!sendFilters && !sendDedupe) return onDone();
    if (!client) return setError("Not connected to Caveman Code's runtime.");
    setSaving(true);
    setError(null);
    try {
      await client.call("automation.set_webhook_rules", {
        request_id: requestId(),
        id: a.id,
        ...(sendFilters ? { filters: f.filters } : {}),
        ...(sendDedupe ? { dedupe: k.dedupe } : {}),
      });
      refresh(client, LIST);
      say("Saved. Requests it skips show under Recent requests.");
      onDone();
    } catch (e) {
      setError(`Couldn't save: ${message(e)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="rounded-xl border border-border bg-card px-4 py-3.5 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={saving} className="min-w-0">
        <legend className="mb-1 text-[13px] text-foreground">Filters</legend>
        <p className="mb-2.5 text-muted-foreground">
          A run starts only when every filter holds. A path names a request value as a prompt placeholder does: <code className="font-mono text-[12px]">headers.x-github-event</code>,{" "}
          <code className="font-mono text-[12px]">body.issue.labels[].name</code>. Separate "is one of" values with commas.
        </p>
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={r.id} className="flex min-w-0 items-center gap-2">
              <Input aria-label={`Filter ${i + 1} path`} placeholder="body.action" value={r.path} onChange={(e) => update(r.id, { path: e.target.value })} className="min-w-0 flex-[1.2] font-mono text-[12.5px]" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Filter ${i + 1} test: ${opLabel(r.op)}`}
                    className="inline-flex h-8 w-[8.5rem] shrink-0 items-center justify-between gap-1.5 rounded-md border border-input bg-control px-2.5 text-[13px] text-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.05] focus-visible:border-ring data-[state=open]:bg-foreground/[0.05]"
                  >
                    {opLabel(r.op)}
                    <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[180px]">
                  {OPS.map((o) => (
                    <DropdownMenuItem key={o.op} onSelect={() => update(r.id, { op: o.op })}>
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {r.op === "exists" ? (
                <span className="min-w-0 flex-1" />
              ) : (
                <Input
                  aria-label={`Filter ${i + 1} value`}
                  placeholder={r.op === "in" ? "opened, reopened" : "opened"}
                  value={r.value}
                  onChange={(e) => update(r.id, { value: e.target.value })}
                  className="min-w-0 flex-1 font-mono text-[12.5px]"
                />
              )}
              <button
                type="button"
                aria-label={`Remove filter ${i + 1}`}
                onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={Cancel01Icon} className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={rows.length >= MAX_FILTERS}
          onClick={() => setRows((all) => [...all, emptyFilter()])}
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hidden"
        >
          <Icon icon={Add01Icon} className="size-3.5" />
          Add filter
        </button>
      </fieldset>
      <fieldset disabled={saving} className="mt-3.5 min-w-0 border-t border-border/60 pt-3.5">
        <legend className="sr-only">Repeats and bursts</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="min-w-0">
            <span className={label}>Skip repeats of (7 days)</span>
            <Input placeholder="{{headers.x-github-delivery}}" value={d.replay} onChange={(e) => setD({ ...d, replay: e.target.value })} className="font-mono text-[12.5px]" />
          </label>
          <div className="flex min-w-0 gap-2">
            <label className="min-w-0 flex-1">
              <span className={label}>Fold bursts by</span>
              <Input placeholder="{{body.issue.number}}" value={d.coalesce} onChange={(e) => setD({ ...d, coalesce: e.target.value })} className="font-mono text-[12.5px]" />
            </label>
            <label className="w-24 shrink-0">
              <span className={label}>Window, s</span>
              <Input
                type="number"
                inputMode="numeric"
                min={WINDOW.min}
                max={WINDOW.max}
                placeholder={String(WINDOW.default)}
                value={d.window}
                disabled={d.coalesce.trim() === ""}
                onChange={(e) => setD({ ...d, window: e.target.value })}
                className="tabular-nums"
              />
            </label>
          </div>
        </div>
        <p className="mt-2 text-[12.5px] text-muted-foreground">Requests with the same key inside the window become one run, on the latest. Leave a key empty to turn it off.</p>
      </fieldset>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className={cn("mt-3.5 flex items-center justify-end gap-2")}>
        <Button type="button" variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
