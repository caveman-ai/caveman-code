// Which requests start an app-saved webhook automation, and how it treats repeats and bursts (upstream #22194,
// #22234, #23282): its filters and dedupe as words, and as the rows its editor changes. Rows are checked by the
// protocol's rules (WebhookFilter, WebhookDedupe), so what reads as valid here also saves. The runtime keeps what a
// save leaves out.
import { isWebhookKeyTemplate, type WebhookDedupe, type WebhookFilter } from "@caveman-app/session-protocol/protocol";

export type Filter = typeof WebhookFilter.Type;
export type FilterOp = Filter["op"];
export type Dedupe = typeof WebhookDedupe.Type;

export const MAX_FILTERS = 16;
/** A coalescing window's default and bounds, in seconds (the runtime's). */
export const WINDOW = { default: 120, min: 10, max: 3600 } as const;

/** Each test, as a filter's sentence says it: "body.action is one of opened, reopened". */
export const OPS: ReadonlyArray<{ readonly op: FilterOp; readonly label: string }> = [
  { op: "equals", label: "equals" },
  { op: "not_equals", label: "does not equal" },
  { op: "in", label: "is one of" },
  { op: "starts_with", label: "starts with" },
  { op: "exists", label: "exists" },
];
export const opLabel = (op: FilterOp): string => OPS.find((o) => o.op === op)?.label ?? op;

/** A filter as one line. */
export function filterWords(filter: Filter): string {
  if (filter.op === "exists") return `${filter.path} exists`;
  return `${filter.path} ${opLabel(filter.op)} ${filter.op === "in" ? filter.value.join(", ") : filter.value === "" ? '""' : filter.value}`;
}

/** "2 minutes", "90 seconds", "1 hour". */
export function windowWords(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** What its dedupe does, a line per rule; none when it has none. */
export function dedupeWords(dedupe: Dedupe | undefined): string[] {
  const out: string[] = [];
  if (dedupe?.replay_key) out.push(`Skips a request whose ${dedupe.replay_key} it saw in the last 7 days`);
  if (dedupe?.coalesce_key) out.push(`Runs once for requests with the same ${dedupe.coalesce_key} within ${windowWords(dedupe.coalesce_window_seconds ?? WINDOW.default)}, on the latest`);
  return out;
}

/** One editable filter row. An `in` list is comma-separated text, which round-trips: its values hold no commas. */
export interface FilterDraft {
  /** The row's identity in the form; never sent. */
  readonly id: string;
  readonly path: string;
  readonly op: FilterOp;
  readonly value: string;
}

let lastRow = 0;
export const emptyFilter = (): FilterDraft => ({ id: `filter-${++lastRow}`, path: "", op: "equals", value: "" });

export function filterDrafts(filters: ReadonlyArray<Filter> | undefined): FilterDraft[] {
  return (filters ?? []).map((f) => ({ id: `filter-${++lastRow}`, path: f.path, op: f.op, value: f.op === "exists" ? "" : f.op === "in" ? f.value.join(", ") : f.value }));
}

/** A request value's path (WebhookFilter's rule) and an `in` value (no commas, no surrounding spaces). */
const PATH = /^(body|headers|query)(\.|$)/;
const LIST_VALUE = /^[^,\s](?:[^,]*[^,\s])?$/;

function filterOf(d: FilterDraft): Filter | null {
  const path = d.path.trim();
  if (!PATH.test(path)) return null;
  if (d.op === "exists") return { path, op: "exists" };
  if (d.op === "in") {
    const value = d.value.split(",").map((v) => v.trim()).filter((v) => v !== "");
    return value.length > 0 && value.every((v) => LIST_VALUE.test(v)) ? { path, op: "in", value } : null;
  }
  return d.value === "" ? null : { path, op: d.op, value: d.value };
}

/** The rows as filters, or what the first row that would not save needs. */
export function parseFilters(drafts: ReadonlyArray<FilterDraft>): { readonly filters: Filter[] } | { readonly error: string } {
  if (drafts.length > MAX_FILTERS) return { error: `Use at most ${MAX_FILTERS} filters.` };
  const filters: Filter[] = [];
  for (const [i, d] of drafts.entries()) {
    const filter = filterOf(d);
    if (filter === null) {
      const needs = d.op === "exists" ? "." : d.op === "in" ? ", and at least one value." : ", and a value.";
      return { error: `Filter ${i + 1} needs a path under body, headers or query (body.action, headers.x-github-event)${needs}` };
    }
    filters.push(filter);
  }
  return { filters };
}

/** Whether the rows differ from those the form opened with: only then does a save send them. */
export function filtersChanged(saved: ReadonlyArray<FilterDraft>, rows: ReadonlyArray<FilterDraft>): boolean {
  return saved.length !== rows.length || saved.some((s, i) => s.path !== rows[i]!.path || s.op !== rows[i]!.op || (s.op !== "exists" && s.value !== rows[i]!.value));
}

export interface DedupeDraft {
  readonly replay: string;
  readonly coalesce: string;
  /** Seconds, as typed; empty is the default. */
  readonly window: string;
}

export const dedupeDraft = (d: Dedupe | undefined): DedupeDraft => ({
  replay: d?.replay_key ?? "",
  coalesce: d?.coalesce_key ?? "",
  window: d?.coalesce_window_seconds === undefined ? "" : String(d.coalesce_window_seconds),
});

/** The fields as dedupe settings (`{}` turns it off), or what is wrong with them. */
export function parseDedupe(d: DedupeDraft): { readonly dedupe: Dedupe } | { readonly error: string } {
  const replay = d.replay.trim();
  const coalesce = d.coalesce.trim();
  const window = d.window.trim();
  const seconds = Number(window);
  if (window !== "" && (!Number.isInteger(seconds) || seconds < WINDOW.min || seconds > WINDOW.max)) {
    return { error: `The window is whole seconds from ${WINDOW.min} to ${WINDOW.max}.` };
  }
  if ((replay && !isWebhookKeyTemplate(replay)) || (coalesce && !isWebhookKeyTemplate(coalesce))) {
    return { error: "A key needs a request placeholder, such as {{headers.x-github-delivery}} or {{body.issue.number}}, and nothing else in braces." };
  }
  return {
    dedupe: {
      ...(replay ? { replay_key: replay } : {}),
      ...(coalesce ? { coalesce_key: coalesce } : {}),
      // A window says nothing without a key to fold by.
      ...(coalesce && window ? { coalesce_window_seconds: seconds } : {}),
    },
  };
}

export const dedupeChanged = (saved: DedupeDraft, now: DedupeDraft): boolean =>
  saved.replay.trim() !== now.replay.trim() || saved.coalesce.trim() !== now.coalesce.trim() || saved.window.trim() !== now.window.trim();
