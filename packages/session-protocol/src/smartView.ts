// Smart View's rules, all of them, in one place (docs/): when a Chief may put something in the
// person's right sidebar, and whether it comes to the front or waits behind with a pulse. The runtime applies
// `admit` to every open (chief/view.ts); the app applies `placement` to every new one it shows (smart-view/). Both
// are pure, so the rules are tested here, once.
//
// The aim is the least annoying feature possible: the person's own reading is never moved, nothing reopens what
// they just closed, and a Chief that opens a lot is held back.

import type { ChiefView, SmartViewEntry, SmartViewItem } from "./protocol.ts";

export const SMART_VIEW_RULES = {
  /** Two opens the person didn't ask for are at least this far apart. */
  minGapMs: 20_000,
  /** And at most `burst` of them in `burstWindowMs`. */
  burst: 4,
  burstWindowMs: 10 * 60_000,
  /** What the person closed stays closed this long, unless they ask for it. */
  closedCooldownMs: 30 * 60_000,
  /** At most this many open at once; past it the Chief closes one of its own first. */
  maxOpen: 6,
  /** The sidebar is in use for this long after the person last touched it (a click, a scroll, a key, focus in it). */
  idleMs: 20_000,
  /** Closed entries are kept (for the cooldown and view_list) at most this many. */
  keepClosed: 20,
} as const;

/** The item's identity: one entry per pull request, chat, file or address, however often it is opened. */
export function smartViewKey(item: SmartViewItem): string {
  switch (item.kind) {
    case "pr":
      return `pr:${item.project_id}#${item.number}`;
    case "chat":
      return `chat:${item.workspace_id}`;
    case "image":
    case "video":
      return `${item.kind}:${item.url ?? `${item.workspace_id ?? ""}:${item.path ?? ""}`}`;
    case "web":
      return `web:${item.url}`;
  }
}

/** An address the sidebar may load: http or https only (never javascript:, data: or file:). The URL, normalized, or undefined. */
export function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an address may load on its own, with no click: only this computer (localhost, 127.x, ::1), where a chat's
 * preview runs. Anything else (the internet, the local network, 169.254.x) waits behind a Load button, unless the
 * person asked for it, so a Chief steered by text it read can't make the app fetch an address of its choosing.
 */
export function autoLoads(raw: string): boolean {
  const url = safeUrl(raw);
  if (url === undefined) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1";
}

/**
 * What the runtime does with a Chief's open, first rule that applies:
 *   off: Smart View is off (Settings); nothing opens, and the Chief is told.
 *   surfaced: it is already open and the person asked for it: brought forward again (seq + 1).
 *   already_open: it is already open: left as it is, no second pulse.
 *   closed_recently: the person closed it less than closedCooldownMs ago, and didn't ask for it now.
 *   too_many_open: maxOpen are open and the person didn't ask: the Chief closes one first.
 *   too_soon: an unasked open within minGapMs of the last, or past `burst` in burstWindowMs.
 *   opened: a new entry.
 * What the person asks for skips the cooldown, the cap and the rate: they asked.
 */
export type Admission =
  | { readonly kind: "off" }
  | { readonly kind: "surfaced"; readonly entry: SmartViewEntry }
  | { readonly kind: "already_open"; readonly entry: SmartViewEntry }
  | { readonly kind: "closed_recently"; readonly entry: SmartViewEntry }
  | { readonly kind: "too_many_open"; readonly open: number }
  | { readonly kind: "too_soon"; readonly retryAfterMs: number }
  | { readonly kind: "opened"; readonly entry: SmartViewEntry };

export interface OpenRequest {
  readonly item: SmartViewItem;
  readonly title: string;
  readonly note?: string | undefined;
  readonly asked: boolean;
}

/**
 * `recent`: when the Chief's last unasked opens were admitted (ms), newest last; the runtime keeps them. Returns the
 * decision; the entries to store follow from it (`applyAdmission`).
 */
export function admit(view: Pick<ChiefView, "on" | "entries">, recent: ReadonlyArray<number>, req: OpenRequest, now: number): Admission {
  if (!view.on) return { kind: "off" };
  const id = smartViewKey(req.item);
  const existing = view.entries.find((e) => e.id === id);
  if (existing?.state === "open") return req.asked ? { kind: "surfaced", entry: { ...existing, seq: existing.seq + 1, asked: true, ...noteOf(req) } } : { kind: "already_open", entry: existing };
  if (!req.asked) {
    if (existing?.closed_by === "person" && existing.closed_at !== undefined && now - Date.parse(existing.closed_at) < SMART_VIEW_RULES.closedCooldownMs) return { kind: "closed_recently", entry: existing };
    const open = view.entries.filter((e) => e.state === "open").length;
    if (open >= SMART_VIEW_RULES.maxOpen) return { kind: "too_many_open", open };
    const last = recent.at(-1);
    if (last !== undefined && now - last < SMART_VIEW_RULES.minGapMs) return { kind: "too_soon", retryAfterMs: SMART_VIEW_RULES.minGapMs - (now - last) };
    const inWindow = recent.filter((t) => now - t < SMART_VIEW_RULES.burstWindowMs);
    if (inWindow.length >= SMART_VIEW_RULES.burst) return { kind: "too_soon", retryAfterMs: SMART_VIEW_RULES.burstWindowMs - (now - inWindow[0]!) };
  }
  return {
    kind: "opened",
    entry: { id, item: req.item, title: req.title, ...noteOf(req), asked: req.asked, opened_at: new Date(now).toISOString(), seq: (existing?.seq ?? 0) + 1, state: "open" },
  };
}

const noteOf = (req: OpenRequest) => (req.note === undefined || req.note.trim() === "" ? {} : { note: req.note.trim().slice(0, 200) });

/** The entries after an admission: an opened or surfaced one replaces its old self and goes last; the closed ones past keepClosed go. */
export function applyAdmission(entries: ReadonlyArray<SmartViewEntry>, admission: Admission): ReadonlyArray<SmartViewEntry> {
  if (admission.kind !== "opened" && admission.kind !== "surfaced") return entries;
  return prune([...entries.filter((e) => e.id !== admission.entry.id), admission.entry]);
}

/** Closes one entry (by the person or the Chief); unknown or already closed ids change nothing. */
export function closeEntry(entries: ReadonlyArray<SmartViewEntry>, id: string, by: "person" | "chief", now: number): ReadonlyArray<SmartViewEntry> {
  const at = entries.findIndex((e) => e.id === id && e.state === "open");
  if (at < 0) return entries;
  return prune(entries.map((e, i) => (i === at ? { ...e, state: "closed" as const, closed_at: new Date(now).toISOString(), closed_by: by } : e)));
}

function prune(entries: ReadonlyArray<SmartViewEntry>): ReadonlyArray<SmartViewEntry> {
  const closed = entries.filter((e) => e.state === "closed");
  if (closed.length <= SMART_VIEW_RULES.keepClosed) return entries;
  const drop = new Set(closed.slice(0, closed.length - SMART_VIEW_RULES.keepClosed));
  return entries.filter((e) => !drop.has(e));
}

/** What the app knows about the sidebar when a new entry arrives (smart-view/useSmartView.ts reads it). */
export interface SidebarNow {
  /** The person asked for it (SmartViewEntry.asked). */
  readonly asked: boolean;
  /** The Chief's page is on screen, in a window that is visible. */
  readonly visible: boolean;
  /** The sidebar is showing (not hidden by the person). */
  readonly open: boolean;
  /** The sidebar would float over the conversation (a phone, a narrow window). */
  readonly narrow: boolean;
  /** Its tab in front is nothing of the person's: no tab, a launcher, or the Chief's own Work. */
  readonly home: boolean;
  /** When the person last touched the sidebar (ms), or null. */
  readonly touchedAt: number | null;
  readonly now: number;
}

/**
 * Where a new entry goes:
 *   front: it becomes the tab in front (the panel stays as the person left it, shown or hidden, unless they asked).
 *   behind: it is added as a tab behind the one in front, with a blue pulse until the person looks at it.
 * It comes to the front only when the person asked for it, or when nobody is using the sidebar: the Chief's page is
 * on screen, the sidebar shows (a hidden one is never popped open: ), it doesn't float over the
 * chat, its tab in front is nothing of the person's, and they haven't touched it for idleMs.
 */
export function placement(s: SidebarNow): "front" | "behind" {
  if (s.asked) return "front";
  if (!s.visible || !s.open || s.narrow || !s.home) return "behind";
  if (s.touchedAt !== null && s.now - s.touchedAt < SMART_VIEW_RULES.idleMs) return "behind";
  return "front";
}
