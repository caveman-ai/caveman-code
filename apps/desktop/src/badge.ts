// The Dock badge: how many sessions posted a notice (needs you, finished) while
// the app was away, 
// (apps/desktop/src/ipc/methods/notificationBadge.ts, MIT, 13aa882c22). The page
// counts (apps/web state/notifications.ts); main shows it. Electron-free, so it
// tests without Electron.

/** macOS shows big numbers whole; past this the badge says no more than it. */
export const BADGE_MAX = 99;

/** The count to show for what the page sent, or null to ignore it. Someone using the app sees no badge. */
export function badgeCount(raw: unknown, appFocused: boolean): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return appFocused ? 0 : Math.min(raw, BADGE_MAX);
}
