// Whether the tour is asked for, and what must not show over it. Kept apart from the tour itself (Tour.tsx: its card,
// its spotlight, its six stops) so what asks for it, or must not show over it, does not pull the tour into the startup
// bundle. The tour never runs on its own: only the person asks (Show me around in the first run, Help > Show the Tour,
// the shortcut sheet's link). docs/ "Tour".

export const PENDING_KEY = "caveman.tourPending";

export const START_EVENT = "caveman:tour";
export const END_EVENT = "caveman:tour-end";
/** The tour starting and ending, for what must not show over it (the sync prompt, components/Offers.tsx). */
export const TOUR_EVENTS = [START_EVENT, END_EVENT] as const;

/** The tour was asked for and has not ended: what must not show over it waits. Never true unless someone asked. */
export const tourPending = (): boolean => localStorage.getItem(PENDING_KEY) === "1";

/** Asks for the tour (Show me around, Help > Show the Tour); a tour already mounted starts now. */
export function startTour(): void {
  localStorage.setItem(PENDING_KEY, "1");
  window.dispatchEvent(new Event(START_EVENT));
}

/** A tour left unfinished by the last launch (the window closed over it) is not picked up again: it never runs on its own. */
export function forgetStaleTour(): void {
  localStorage.removeItem(PENDING_KEY);
}
