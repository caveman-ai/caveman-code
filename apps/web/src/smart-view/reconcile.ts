// What this app does when a Chief's Smart View list changes (chief.view.updated), as a pure function of the list,
// what this device has shown of it, and which tabs still exist. The runtime decides what may open (smartView.ts
// `admit`); this only brings its list and the panel into step:
//   an open entry this device hasn't shown at its seq: show it (useSmartView.ts places it front or behind);
//   an open entry whose tab the person closed: tell the runtime (chief.view.dismiss), so the Chief leaves it closed;
//   a closed entry whose tab is still here (the Chief closed it, or the person did on another device): close the tab,
//   only if the person never looked at it (sidebar.ts closeUnseen); otherwise the tab is theirs now and stays.
// The person's own tabs are never closed: a tab that was theirs before is recorded as adopted, and only pulsed.
import type { ChiefView, SmartViewEntry } from "@caveman-app/session-protocol";

/**
 * What this device showed of one entry: its tab, and the entry's seq when it did. `adopted`: the tab was the
 * person's own before Smart View showed the entry there (the same pull request, chat or file): never closed or
 * renamed by Smart View, only pulsed.
 */
export interface ShownRecord {
  readonly tab: string;
  readonly seq: number;
  readonly adopted?: true;
}
export type Shown = Readonly<Record<string, ShownRecord>>;

export type Action =
  /** `tab`: the tab already showing it, to bring forward again (a higher seq); absent, open a new one. */
  | { readonly kind: "show"; readonly entry: SmartViewEntry; readonly tab?: string }
  /** The entry closed while its tab is here: close it if the person never looked at it and it was never theirs (sidebar.ts). */
  | { readonly kind: "close"; readonly id: string; readonly tab: string; readonly adopted: boolean }
  | { readonly kind: "dismiss"; readonly id: string }
  | { readonly kind: "forget"; readonly id: string };

export function reconcile(view: Pick<ChiefView, "entries">, shown: Shown, hasTab: (tabId: string) => boolean): ReadonlyArray<Action> {
  const out: Array<Action> = [];
  const listed = new Set(view.entries.map((e) => e.id));
  for (const entry of view.entries) {
    const rec = shown[entry.id];
    const here = rec !== undefined && hasTab(rec.tab);
    if (entry.state === "open") {
      if (rec === undefined || rec.seq < entry.seq) out.push(here ? { kind: "show", entry, tab: rec.tab } : { kind: "show", entry });
      // Its record stays until the runtime lists it closed: a pass before then would show it again. A second dismiss is harmless.
      else if (!here) out.push({ kind: "dismiss", id: entry.id });
    } else if (rec !== undefined) {
      out.push(...(here ? [{ kind: "close" as const, id: entry.id, tab: rec.tab, adopted: rec.adopted === true }] : []), { kind: "forget", id: entry.id });
    }
  }
  // Entries the runtime no longer lists (pruned): forget them, and leave their tabs to the person.
  for (const id of Object.keys(shown)) if (!listed.has(id)) out.push({ kind: "forget", id });
  return out;
}
