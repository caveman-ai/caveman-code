/**
 * How long, in one unit: "12s", "4m", "2h", "3d". On its own, with no imports: the notch's page (notch/Notch.tsx)
 * draws a chat's clock with it and loads none of the app's state.
 */
export function short(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
