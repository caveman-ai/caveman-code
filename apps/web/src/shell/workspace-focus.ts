// F6 and Shift+F6 move between the workspace's areas (upstream #25877): the sidebar, each pane's conversation and
// message box, the side panel, a page's content; in Settings its section list and the open section. An area is any
// element marked `data-focus-area`; hidden ones (a tucked sidebar, a background tab, a closed panel) are skipped,
// and an area holding others counts only when none of them shows. Moving wraps around and lands where focus last
// was in that area, else on its own first control.

const AREA = "[data-focus-area]";

/** The areas focus moves between, in reading order: the innermost of nested ones. */
export function leafAreas<T>(areas: ReadonlyArray<T>, contains: (outer: T, inner: T) => boolean): T[] {
  return areas.filter((a) => !areas.some((b) => b !== a && contains(a, b)));
}

/** The next area's index from `current` (-1: focus is in none), wrapping both ways. */
export function stepArea(count: number, current: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

const shown = (el: HTMLElement) => el.getClientRects().length > 0 && el.closest("[inert]") === null;

export function focusAreas(doc: Document = document): HTMLElement[] {
  return leafAreas([...doc.querySelectorAll<HTMLElement>(AREA)].filter(shown), (outer, inner) => outer.contains(inner));
}

const lastFocused = new WeakMap<HTMLElement, HTMLElement>();

const TABBABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const FIRST = [
  "[data-focus-first]",
  '[data-sidebar-row][aria-current="page"]',
  // Settings' section list: the open section.
  'a[aria-current="page"]',
  // The side panel: its tab in front.
  '[role="tab"][aria-selected="true"]',
  '[data-slot="conversation-viewport"]',
  '[contenteditable="true"]',
  "textarea",
];

/** Where focus goes in an area: where it last was, the area's own pick (`data-focus-first`), its first control, or the area itself. */
function target(area: HTMLElement): HTMLElement {
  const last = lastFocused.get(area);
  if (last && last.isConnected && area.contains(last) && shown(last)) return last;
  // The sidebar starts at the chat on screen; a conversation is read from its scroller (arrows and Page keys); a box
  // from its text field.
  const first =
    FIRST.map((s) => area.querySelector<HTMLElement>(s)).find((el) => el !== null && shown(el)) ?? [...area.querySelectorAll<HTMLElement>(TABBABLE)].find(shown);
  if (first) return first;
  if (!area.hasAttribute("tabindex")) area.tabIndex = -1;
  return area;
}

/** Moves focus one area on (1) or back (-1). False when there is nowhere to go. */
export function moveFocusArea(step: 1 | -1, doc: Document = document): boolean {
  const areas = focusAreas(doc);
  const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const current = active ? areas.findIndex((a) => a.contains(active)) : -1;
  const next = stepArea(areas.length, current, step);
  if (next < 0 || next === current) return false;
  target(areas[next]!).focus();
  return true;
}

/**
 * Up and Down between the sidebar's rows (`data-sidebar-row`: chats, projects, Chiefs) without opening them, Home and
 * End to the ends; Enter opens one as a click does. Returns whether the key was the sidebar's.
 */
export function moveSidebarRow(sidebar: HTMLElement, from: HTMLElement, key: string): boolean {
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return false;
  const rows = [...sidebar.querySelectorAll<HTMLElement>("[data-sidebar-row]")].filter(shown);
  const at = rows.indexOf(from);
  if (at < 0) return false;
  const to = key === "Home" ? 0 : key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)));
  rows[to]?.focus();
  return true;
}

/** Remembers the control focus reached in each area, so coming back lands there. */
export function trackFocusAreas(doc: Document = document): () => void {
  const onFocus = (e: FocusEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    const area = el?.closest<HTMLElement>(AREA);
    if (el && area && el !== area) lastFocused.set(area, el);
  };
  doc.addEventListener("focusin", onFocus);
  return () => doc.removeEventListener("focusin", onFocus);
}
