// One file tree per workspace, kept outside React: every file the user opens
// is its own tab, so the surface remounts on each open, and the tree has to
// come back exactly as it was (folders, scroll, search, cursor) on the first
// frame. Listings load lazily per folder, at most four at a time, and stay
// cached after a collapse; an agent edit re-lists what is on screen and
// forgets the rest. Modelled on upstream useDirectoryEntries (MIT,
// apps/web/src/components/files/useDirectoryEntries.ts @ ab3a3cd1).

import type { Client } from "@caveman-app/session-protocol/client";
import { useSyncExternalStore } from "react";
import { dirName, parentDirs, type Listing } from "./tree.ts";

export interface TreeState {
  readonly listings: ReadonlyMap<string, Listing>;
  readonly expanded: ReadonlySet<string>;
  /** First loads only; a refresh keeps showing the cached children. */
  readonly loading: ReadonlySet<string>;
  readonly errors: ReadonlyMap<string, string>;
  readonly query: string;
  /** The last fs.search answer; `version` is the agent-edit count it was fetched at. */
  readonly results: { readonly query: string; readonly paths: ReadonlyArray<string>; readonly truncated: boolean; readonly version: number } | null;
  /** A path whose row should scroll to the centre and take the cursor once it is listed. */
  readonly scrollTo: string | null;
}

interface Draft {
  listings?: Map<string, Listing>;
  errors?: Map<string, string>;
  loading?: Set<string>;
}

type Frame = ReturnType<typeof setTimeout> | number;
const raf = typeof requestAnimationFrame === "function";
const nextFrame = (f: () => void): Frame => (raf ? requestAnimationFrame(f) : setTimeout(f, 16));
const cancelFrame = (h: Frame) => (raf ? cancelAnimationFrame(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>));

const MAX_CONCURRENT = 4;
/** Expand all stops after this many folders. */
const EXPAND_ALL_CAP = 1500;

export class TreeStore {
  state: TreeState = { listings: new Map(), expanded: new Set(), loading: new Set(), errors: new Map(), query: "", results: null, scrollTo: null };
  // React must only see published snapshots. A parent render can read the
  // store before a pending frame flush; exposing its mutable draft maps then
  // would make memoized rows miss the later listing update.
  private snapshot: TreeState = this.state;
  getSnapshot = (): TreeState => this.snapshot;

  client: Client | null = null;
  /** UI memory across remounts; not rendered from, so not in `state`. */
  scrollTop = 0;
  cursor: string | null = null;
  /** The file a tree click just opened: its tab should not re-reveal it. */
  openedFromTree: string | null = null;
  /** The agent-edit count the cached listings reflect; null before the first mount. */
  version: number | null = null;
  /** Where focus was when the tree opened a file; the remounted tree puts it back. */
  refocus: "tree" | "search" | null = null;
  /** `path:reveal` of the last open the tree handled, so a remount doesn't reveal it again. */
  revealed: string | null = null;

  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** The one fresh listing queued behind a folder's request in flight. */
  private readonly followUps = new Map<string, Promise<void>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private generation = 0;
  private expandRun = 0;
  private frame: Frame | null = null;
  private draft: Draft = {};

  readonly workspaceId: string;
  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** A change the user made: render it now. */
  private set(patch: Partial<TreeState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify() {
    this.draft = {};
    if (this.frame !== null) cancelFrame(this.frame);
    this.frame = null;
    this.snapshot = this.state;
    for (const l of this.listeners) l();
  }

  /** A change that arrives in bursts (listings, expand all): readers see it at once, the tree renders it once per frame. */
  private batch(patch: Partial<TreeState>) {
    this.state = { ...this.state, ...patch };
    this.frame ??= nextFrame(() => {
      this.frame = null;
      this.notify();
    });
  }

  /** Listings, errors and loading, copied once per frame and edited in place until the next render sees them. */
  private edit(): Required<Draft> {
    const d = this.draft;
    d.listings ??= new Map(this.state.listings);
    d.errors ??= new Map(this.state.errors);
    d.loading ??= new Set(this.state.loading);
    this.batch({ listings: d.listings, errors: d.errors, loading: d.loading });
    return d as Required<Draft>;
  }

  /** List a folder unless it is cached (or `force`). Concurrent calls share one request. */
  load(dir: string, force = false): Promise<void> {
    const pending = this.inflight.get(dir);
    if (pending) {
      if (!force) return pending;
      // A burst of refreshes while the folder is being listed (an agent writing files): one fresh listing after this
 // one, shared by every caller, never one each (upstream #18421).
      let followUp = this.followUps.get(dir);
      if (!followUp) {
        const generation = this.generation;
        const queued: Promise<void> = pending.then(() => {
          if (this.followUps.get(dir) === queued) this.followUps.delete(dir);
          return generation === this.generation ? this.load(dir, true) : undefined;
        });
        this.followUps.set(dir, (followUp = queued));
      }
      return followUp;
    }
    if (!force && this.state.listings.has(dir)) return Promise.resolve();
    const client = this.client;
    if (!client) return Promise.resolve();
    const generation = this.generation;
    const first = !this.state.listings.has(dir);
    if (first) this.edit().loading.add(dir);
    // `let`: the request's own `finally` compares itself against the in-flight entry.
    let request: Promise<void> | null = null;
    request = (async () => {
      if (this.running >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.running++;
      try {
        const r = await client.call("fs.list", { workspace_id: this.workspaceId, path: dir, include_ignored: true });
        if (generation !== this.generation) return;
        const { listings, errors } = this.edit();
        listings.set(dir, { entries: r.entries, truncated: r.truncated });
        errors.delete(dir);
      } catch (e) {
        if (generation !== this.generation) return;
        this.edit().errors.set(dir, e instanceof Error ? e.message : String(e));
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.running--;
        // After a reset a newer request may own this folder: leave its entry and its loading flag alone.
        if (this.inflight.get(dir) === request) this.inflight.delete(dir);
        if (first && generation === this.generation && this.state.loading.has(dir)) this.edit().loading.delete(dir);
      }
    })();
    this.inflight.set(dir, request);
    return request;
  }

  setExpanded(dir: string, open: boolean) {
    if (this.state.expanded.has(dir) === open) return;
    const expanded = new Set(this.state.expanded);
    if (open) expanded.add(dir);
    else expanded.delete(dir);
    this.set({ expanded });
    if (open) void this.load(dir);
  }

  /** Expand the folders above `path` (and `path` itself when it is a folder), list them in order, then scroll it into view. */
  async reveal(path: string, isDir = false) {
    const dirs = [...parentDirs(path), ...(isDir && path ? [path] : [])];
    const expanded = new Set(this.state.expanded);
    for (const d of dirs) expanded.add(d);
    // The root has no row: show its first one.
    const target = path || (this.state.listings.get("")?.entries[0]?.path ?? null);
    this.set({ expanded, scrollTo: target, query: "", results: null });
    // Every folder above it at once (load caps how many run and shares one per folder): a file six folders deep waits
 // for one round trip, not seven in a row (upstream 1ea378c6f4).
    await Promise.all(["", ...dirs].map((d) => this.load(d)));
    // Not there (deleted, or past a truncated listing): stop waiting for its row.
    if (target !== null && this.state.scrollTo === target && !this.state.listings.get(dirName(target))?.entries.some((e) => e.path === target)) this.clearScrollTo();
  }

  clearScrollTo() {
    if (this.state.scrollTo !== null) this.set({ scrollTo: null });
  }

  /** Expand every folder that isn't git-ignored, listing level by level. */
  async expandAll() {
    const run = ++this.expandRun;
    const expanded = new Set(this.state.expanded);
    let level = [""];
    while (level.length > 0 && expanded.size < EXPAND_ALL_CAP) {
      await Promise.all(level.map((d) => this.load(d)));
      if (run !== this.expandRun) return; // collapsed meanwhile
      level = level.flatMap((d) => (this.state.listings.get(d)?.entries ?? []).filter((e) => e.type === "dir" && !e.ignored).map((e) => e.path));
      level = level.slice(0, EXPAND_ALL_CAP - expanded.size);
      for (const d of level) expanded.add(d);
      this.batch({ expanded: new Set(expanded) });
    }
  }

  collapseAll() {
    this.expandRun++;
    this.set({ expanded: new Set() });
  }

  /** Re-list the root and every folder on screen; drop the cached rest so it lists fresh when opened. */
  refresh() {
    const { listings, expanded } = this.state;
    const shown = (d: string) => d === "" || (expanded.has(d) && parentDirs(d).every((p) => expanded.has(p)));
    const keep = new Map([...listings].filter(([d]) => shown(d)));
    if (keep.size !== listings.size) this.set({ listings: keep });
    // First loads (including requests waiting for a slot) and failures have no cached listing yet.
    // Always include the root; load(force) queues a fresh read after any pending stale answer.
    const requested = new Set(["", ...keep.keys(), ...this.inflight.keys(), ...this.state.errors.keys()]);
    for (const d of requested) if (shown(d)) void this.load(d, true);
  }

  setQuery(query: string) {
    if (query !== this.state.query) this.set({ query, ...(query.trim() ? {} : { results: null }) });
  }

  setResults(results: TreeState["results"]) {
    this.set({ results });
  }

  /** A new connection: everything cached may be stale. */
  reset(client: Client | null) {
    this.client = client;
    this.generation++;
    this.inflight.clear();
    this.followUps.clear();
    this.set({ listings: new Map(), loading: new Set(), errors: new Map(), results: null });
  }
}

const stores = new Map<string, TreeStore>();

export function treeStore(workspaceId: string): TreeStore {
  let s = stores.get(workspaceId);
  if (!s) stores.set(workspaceId, (s = new TreeStore(workspaceId)));
  return s;
}

export function useTreeState(store: TreeStore): TreeState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
