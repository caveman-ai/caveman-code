// One pass of Smart View in the app: a Chief's list (ChiefView) applied to its side panel. reconcile.ts says what to
// do; the rules (session-protocol smartView.ts `placement`) say front or behind; sidebar.ts does it. What this device
// has shown is kept per Chief across reloads, as the panel's tabs are.
import type { ChiefView } from "@caveman-app/session-protocol";
import { placement } from "@caveman-app/session-protocol/smart-view";
import { reconcile, type Shown, type ShownRecord } from "./reconcile.ts";
import { closeUnseen, hasTab, lastTouched, showTarget, sidebarNow } from "./sidebar.ts";
import { targetOf } from "./targets.ts";

const STORAGE_KEY = "caveman.smartView.v1";
const memory = new Map<string, Shown>();

function loadShown(chiefId: string): Shown {
  const held = memory.get(chiefId);
  if (held) return held;
  try {
    return typeof localStorage === "undefined" ? {} : ((JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Shown>)[chiefId] ?? {});
  } catch {
    return {};
  }
}

function saveShown(chiefId: string, shown: Shown): void {
  memory.set(chiefId, shown);
  if (typeof localStorage === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Shown>;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [chiefId]: shown }));
  } catch {
    // Storage full or blocked: this session still knows; after a reload an entry may show once more.
  }
}

export interface ApplyContext {
  /** The Chief's side panel (its workspace id). */
  readonly panelId: string;
  /** The panel floats over the conversation (a phone, a narrow window). */
  readonly narrow: boolean;
  /** The Chief's page is on screen in a visible window, and was already when this arrived (not just opened). */
  readonly visible: boolean;
  /** Tells the runtime the person closed it (chief.view.dismiss). */
  readonly dismiss: (id: string) => void;
}

export function applyView(view: ChiefView, ctx: ApplyContext): void {
  let shown: Record<string, ShownRecord> = { ...loadShown(view.chief_id) };
  for (const action of reconcile(view, shown, (tab) => hasTab(ctx.panelId, tab))) {
    switch (action.kind) {
      case "show": {
        // Smart View off: nothing new shows, whatever the list held before it was turned off.
        if (!view.on) break;
        const target = targetOf(action.entry);
        if (!target) break;
        const now = sidebarNow(ctx.panelId);
        const how = placement({ asked: action.entry.asked, visible: ctx.visible, open: now.open, narrow: ctx.narrow, home: now.home, touchedAt: lastTouched(), now: Date.now() });
        const before = action.tab === undefined ? undefined : shown[action.entry.id];
        const placed = showTarget(ctx.panelId, target, how, action.entry.asked, action.tab === undefined ? undefined : { id: action.tab, adopted: before?.adopted === true });
        shown[action.entry.id] = { tab: placed.tab, seq: action.entry.seq, ...(placed.adopted ? { adopted: true as const } : {}) };
        break;
      }
      case "close":
        closeUnseen(ctx.panelId, action.tab, action.adopted);
        break;
      case "dismiss":
        ctx.dismiss(action.id);
        break;
      case "forget": {
        const { [action.id]: _, ...rest } = shown;
        shown = rest;
        break;
      }
    }
  }
  saveShown(view.chief_id, shown);
}

/** A Smart View tab gave its place to another (a page's Load turns the gate into a browser tab): its record follows. */
export function retargetShown(fromTab: string, toTab: string): void {
  let all: Record<string, Shown> = {};
  try {
    all = typeof localStorage === "undefined" ? {} : (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Shown>);
  } catch {
    all = {};
  }
  for (const chiefId of new Set([...Object.keys(all), ...memory.keys()])) {
    const shown = loadShown(chiefId);
    if (!Object.values(shown).some((r) => r.tab === fromTab)) continue;
    saveShown(chiefId, Object.fromEntries(Object.entries(shown).map(([id, r]) => [id, r.tab === fromTab ? { ...r, tab: toTab } : r])));
  }
}

/** Test hook: forget what was shown. */
export function resetShown(): void {
  memory.clear();
}
