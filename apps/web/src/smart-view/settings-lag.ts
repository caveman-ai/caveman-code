// Its own module: the runtime provider (state/runtime.tsx) reads it, and nothing else of Smart View should load there.

/**
 * Whether a window's settings (as it last read them, JSON) lag behind Smart View's state the runtime just pushed
 * (ChiefView.on): then the window reads its settings again at once (state/runtime.tsx). Nothing read yet: no.
 */
export function settingsLag(heldSettings: string, on: boolean): boolean {
  if (!heldSettings) return false;
  try {
    return ((JSON.parse(heldSettings) as { chief_smart_view?: boolean }).chief_smart_view !== false) !== on;
  } catch {
    return false;
  }
}
