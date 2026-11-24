// The pages a workspace's browser tabs visited, newest first, for the empty
// state's "Recently used". localStorage only; nothing leaves the device.

const KEY = "caveman.browser.recents.v1";
const PER_WORKSPACE = 8;
/** Workspaces kept, most recently touched last. */
const WORKSPACES = 40;

export interface Recent {
  readonly url: string;
  readonly title?: string;
}

function read(): Record<string, Recent[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Recent[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function write(workspaceId: string, list: Recent[]): void {
  // Re-insert so the touched workspace sorts last; keep the newest WORKSPACES.
  const { [workspaceId]: _, ...rest } = read();
  const all = Object.entries({ ...rest, ...(list.length ? { [workspaceId]: list } : {}) }).slice(-WORKSPACES);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(all)));
  } catch {
    // Full or blocked storage: recents are a convenience.
  }
}

export function recents(workspaceId: string): ReadonlyArray<Recent> {
  const list = read()[workspaceId];
  return Array.isArray(list) ? list.filter((r) => typeof r?.url === "string" && URL.canParse(r.url)) : [];
}

/** Web pages only; a page seen again moves to the top and keeps its title if the new visit has none. */
export function remember(workspaceId: string, url: string, title?: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const list = recents(workspaceId);
  const kept = title || list.find((r) => r.url === url)?.title;
  write(workspaceId, [{ url, ...(kept ? { title: kept } : {}) }, ...list.filter((r) => r.url !== url)].slice(0, PER_WORKSPACE));
}

export function forget(workspaceId: string, url: string): ReadonlyArray<Recent> {
  const list = recents(workspaceId).filter((r) => r.url !== url);
  write(workspaceId, list);
  return list;
}
