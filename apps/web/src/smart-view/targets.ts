// Smart View in the app (docs/): which side-panel surface shows each kind of item a Chief opens.
// Adding a kind is a member of SmartViewItem (session-protocol) and a case here; the surface is any registered one.
import type { SmartViewEntry } from "@caveman-app/session-protocol";
import { autoLoads, safeUrl } from "@caveman-app/session-protocol/smart-view";
import type { SurfaceKind, SurfaceParams } from "../panels/store.ts";

export interface Target<K extends SurfaceKind = SurfaceKind> {
  readonly kind: K;
  readonly params: SurfaceParams[K];
  /** The tab's name, for surfaces that don't name their own tab. */
  readonly title?: string;
}

/** The surface for an entry, or null for one this app can't show (an unsafe address, a kind from a newer runtime). */
export function targetOf(entry: SmartViewEntry): Target | null {
  const item = entry.item;
  switch (item.kind) {
    case "pr":
      return { kind: "pr", params: { project_id: item.project_id, number: item.number, ...(item.view ? { view: item.view } : {}) } };
    case "chat":
      return { kind: "chat", params: { workspace_id: item.workspace_id, ...(entry.note ? { note: entry.note } : {}) }, title: entry.title };
    case "image":
    case "video": {
      if (item.url !== undefined) {
        const url = safeUrl(item.url);
        // Off this computer and not asked for: it waits behind a Load button (smartView.ts autoLoads).
        return url ? { kind: "media", params: { media: item.kind, url, ...(entry.asked || autoLoads(url) ? {} : { gate: true }) }, title: entry.title } : null;
      }
      return item.workspace_id && item.path ? { kind: "media", params: { media: item.kind, workspace_id: item.workspace_id, path: item.path }, title: entry.title } : null;
    }
    case "web": {
      const url = safeUrl(item.url);
      if (!url) return null;
      // A page off this computer the person didn't ask for: a Load button first, then the browser tab in its place.
      return entry.asked || autoLoads(url) ? { kind: "browser", params: { url, backend: "local" } } : { kind: "media", params: { media: "web", url }, title: entry.title };
    }
    default:
      return null;
  }
}
