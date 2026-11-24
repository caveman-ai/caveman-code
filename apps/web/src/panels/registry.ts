// The surface registry: what each tab kind is called, how it looks in the
// tab strip and the `+` launcher, and the component that renders it. The
// built-in kinds register in surfaces.tsx; another module adds a kind by
// augmenting `SurfaceParams` (store.ts) and calling `defineSurface` once at
// import time. A persisted tab whose kind isn't registered (yet) renders a
// quiet "unavailable" state instead of failing.

import type { Client } from "@caveman-app/session-protocol/client";
import { useSyncExternalStore, type ComponentType, type LazyExoticComponent } from "react";
import { setTabIdentity, type SurfaceKind, type SurfaceParams, type Tab, type TabIdentity } from "./store.ts";

export interface SurfaceProps<K extends SurfaceKind = SurfaceKind> {
  readonly workspaceId: string;
  readonly tab: Tab<K>;
  /** The tab is the one showing. A kept-alive surface is mounted while hidden; it should pause work it only does for the eye. */
  readonly active: boolean;
}

export interface SurfaceDef<K extends SurfaceKind = SurfaceKind> {
  readonly kind: K;
  /** The kind's name: "Terminal". The launcher row's label. */
  readonly label: string;
  /** One short line in grey beside the label in the launcher. */
  readonly description?: string;
  /** 16px, `currentColor`. */
  readonly icon: ComponentType<{ className?: string }>;
  /** The key chord that opens it from anywhere in the pane ("ctrl+`"); shown as a keycap in the launcher. */
  readonly chord?: string;
  /** How its tabs are named (store.ts `TabIdentity`). Default `many`. */
  readonly identity?: TabIdentity<K>;
  /** The tab's title when the surface hasn't set one. */
  readonly title: (tab: Tab<K>) => string;
  readonly component: LazyExoticComponent<ComponentType<SurfaceProps<K>>> | ComponentType<SurfaceProps<K>>;
  /** The panel's width (a CSS length) while this kind is the active tab and the person has not resized it. Default: the panel's. */
  readonly defaultWidth?: string;
  /** Stays mounted (hidden) when another tab is active, so a live process or page survives the switch. */
  readonly keepAlive?: boolean;
  /** The user closed the tab: end what it owns (a terminal's process). Unmounting is not closing; a surface only detaches on unmount. */
  readonly onClose?: (ctx: { readonly client: Client | null; readonly workspaceId: string; readonly tab: Tab<K> }) => void;
  /**
   * Runs once per mounted panel for the life of the connection, whether or not a tab of this kind is open,
   * to react to the runtime (the agent starts using its browser: open the tab quietly). Returns its cleanup.
   */
  readonly watch?: (ctx: { readonly client: Client; readonly workspaceId: string }) => () => void;
  /** Listed in the `+` menu and the new-tab launcher. Default true. */
  readonly launcher?: boolean;
  /** Its tab can't be closed: no close button, and closing tabs passes it by (the Chief's Work tab). */
  readonly pinned?: boolean;
  /** Controls for the panel's own bar, at its right, while this is the active tab (the Work tab's List, Board, Library). */
  readonly bar?: ComponentType<SurfaceProps<K>>;
  /**
   * The tab shows the same in any workspace's panel (a pull request, a web page), so it may move to another chat's.
   * Default: it belongs to its workspace (a terminal runs there, Changes are its checkout's).
   */
  readonly portable?: (tab: Tab<K>) => boolean;
}

const defs = new Map<SurfaceKind, SurfaceDef<never>>();
const defined = new Set<() => void>();
let version = 0;

export function defineSurface<K extends SurfaceKind>(def: SurfaceDef<K>): void {
  defs.set(def.kind, def as unknown as SurfaceDef<never>);
  setTabIdentity(def.kind, def.identity ?? "many");
  version++;
  for (const l of defined) l();
}

export function surfaceDef<K extends SurfaceKind>(kind: K): SurfaceDef<K> | undefined {
  return defs.get(kind) as SurfaceDef<K> | undefined;
}

const registered = (): number => version;

/** `surfaceDef`, again once the kind registers: a tab restored before its module loaded (a Chief's contract) shows then. */
export function useSurfaceDef<K extends SurfaceKind>(kind: K): SurfaceDef<K> | undefined {
  useSyncExternalStore(
    (l) => {
      defined.add(l);
      return () => defined.delete(l);
    },
    registered,
    // A static render (a panel's tests) reads the kinds registered so far.
    registered,
  );
  return surfaceDef(kind);
}

/** Whether a tab can leave its panel for a pane of its own: not a launcher (it becomes what it opens) nor a pinned tab. */
export function movable(tab: Tab): boolean {
  return tab.kind !== "new" && !surfaceDef(tab.kind)?.pinned;
}

/** Whether a tab can move to another workspace's panel (SurfaceDef.portable). */
export function portable(tab: Tab): boolean {
  try {
    return movable(tab) && (surfaceDef(tab.kind)?.portable?.(tab as never) ?? false);
  } catch {
    return false;
  }
}

export function allSurfaces(): ReadonlyArray<SurfaceDef> {
  return [...defs.values()] as unknown as ReadonlyArray<SurfaceDef>;
}

/** The kinds the `+` menu lists, in registration order. */
export function launcherSurfaces(): ReadonlyArray<SurfaceDef> {
  return [...defs.values()].filter((d) => d.launcher !== false) as unknown as ReadonlyArray<SurfaceDef>;
}

export function tabTitle(tab: Tab): string {
  if (tab.title) return tab.title;
  const def = surfaceDef(tab.kind);
  try {
    return def ? def.title(tab as never) : tab.kind;
  } catch {
    // A tab saved by another version can lack what title() reads; never take the strip down for it.
    return def?.label ?? tab.kind;
  }
}

export type { SurfaceKind, SurfaceParams };
