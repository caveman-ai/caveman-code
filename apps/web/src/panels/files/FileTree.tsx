// The workspace's file tree: a refresh button, "Search files" and expand or
// collapse all on top; below, one flat list of the visible rows (windowed
// past 400), with tree semantics and the keyboard of a native tree. Ignored
// entries are dimmed, the open file is outlined, folders expand in place with
// a guide line per level, files carry their language's coloured mark (the
// same Pierre set as upstream tree). Searching swaps the rows for fs.search's matches.
// The look , apps/web/src/components/
// files/FileBrowserPanel.tsx, pierre-tree-theme.ts @ ab3a3cd1); the tree is ours.

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Skeleton } from "@caveman-app/ui/components/skeleton";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon, Cancel01Icon, RefreshCwIcon, FoldVerticalIcon, UnfoldVerticalIcon } from "@caveman-app/ui/icons/huge";
import { fileIcon } from "./fileIcon.tsx";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton, formatChord, isComposing, QuietButton, SurfaceEmpty } from "../chrome.tsx";
import { absolutePath, baseName, dirName, matchIndices, nativePath, typeAhead, visibleRows, type Row } from "./tree.ts";
import { revealFile, revealLabel, useEditors } from "./editors.ts";
import { treeStore, useTreeState } from "./treeStore.ts";

const ROW = 24;
const INDENT = 12;
const PAD = 8;
/** Render every row up to this many; window past it. */
const WINDOW_AFTER = 400;
const OVERSCAN = 16;

export interface FileTreeProps {
  readonly workspaceId: string;
  /** The absolute worktree root (This Mac only): adds Copy absolute path. */
  readonly root?: string | undefined;
  /** The open file: outlined, and revealed when it changes or `reveal` bumps. */
  readonly selected: string | null;
  readonly reveal: number;
  /** Agent edits so far (null: not known yet); a change re-lists what is on screen. */
  readonly version: number | null;
  readonly onOpen: (path: string, options: { newTab: boolean }) => void;
  readonly autoFocus?: boolean;
  readonly className?: string;
}

export function FileTree({ workspaceId, root, selected, reveal, version, onOpen, autoFocus, className }: FileTreeProps) {
  const { client } = useRuntimeClient();
  const store = treeStore(workspaceId);
  const state = useTreeState(store);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const uid = useId();
  const [cursor, setCursorState] = useState<string | null>(store.cursor);
  const [viewport, setViewport] = useState({ top: store.scrollTop, height: 0 });
  const [keyboard, setKeyboard] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const typed = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  const frame = useRef(0);

  const q = state.query.trim();
  const rows: Row[] = useMemo(() => {
    if (!q) return visibleRows(state.listings, state.expanded, state.errors);
    const paths = state.results?.paths ?? [];
    return paths.map((path, i) => ({ kind: "result", key: path, path, matches: matchIndices(path, q), pos: i + 1, size: paths.length }));
  }, [q, state.listings, state.expanded, state.errors, state.results]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const cursorIndex = cursor !== null ? (index.get(cursor) ?? -1) : -1;
  const activeIndex = cursorIndex >= 0 ? cursorIndex : selected !== null ? (index.get(selected) ?? 0) : 0;

  const setCursor = (key: string | null) => {
    store.cursor = key;
    setCursorState(key);
  };

  // A new connection invalidates the cache; the same one keeps it across remounts.
  useEffect(() => {
    if (store.client !== client) store.reset(client);
    if (client) void store.load("");
  }, [client, store]);

  // Agent edits: re-list what is on screen (and re-run a search) without dropping state.
  useEffect(() => {
    if (version === null || store.version === version) return;
    const first = store.version === null;
    store.version = version;
    if (!first) store.refresh();
  }, [version, store]);

  // Search: debounced fs.search; the previous answer stays up until the next one lands.
  useEffect(() => {
    if (!client || !q || version === null || (state.results?.query === q && state.results.version === version)) return;
    const timer = setTimeout(() => {
      client.call("fs.search", { workspace_id: workspaceId, query: q, limit: 100 }).then(
        (r) => store.state.query.trim() === q && store.setResults({ query: q, paths: r.paths, truncated: r.truncated, version }),
        () => store.state.query.trim() === q && store.setResults({ query: q, paths: [], truncated: false, version }),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [client, workspaceId, q, version, state.results, store]);

  // Reveal the open file when another surface opened it; a tree click already shows it.
  useEffect(() => {
    if (!selected) return;
    const key = `${selected}:${reveal}`;
    if (store.revealed === key) return;
    store.revealed = key;
    if (store.openedFromTree === selected) {
      store.openedFromTree = null;
      return;
    }
    void store.reveal(selected);
  }, [selected, reveal, store]);

  // Come back where the tree was, then follow a pending reveal once its row exists.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = store.scrollTop;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => setViewport((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [store]);

  useLayoutEffect(() => {
    const target = state.scrollTo;
    const el = scroller.current;
    const i = target === null ? undefined : index.get(target);
    if (!el || target === null || i === undefined) return;
    el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2 + ROW / 2);
    store.scrollTop = el.scrollTop;
    setViewport((v) => ({ ...v, top: el.scrollTop }));
    setCursor(target);
    store.clearScrollTo();
  }, [state.scrollTo, index, store]);

  useEffect(() => {
    const again = store.refocus;
    store.refocus = null;
    if (again === "search") search.current?.focus();
    else if (again === "tree" || autoFocus) scroller.current?.focus({ preventScroll: true });
  }, [autoFocus, store]);

  useEffect(() => () => clearTimeout(typed.current.timer ?? undefined), []);

  const windowed = rows.length > WINDOW_AFTER;
  // store.scrollTop is always current (viewport.top only re-renders while windowed), so the window is right the moment it starts.
  const top = store.scrollTop;
  const first = windowed ? Math.max(0, Math.floor(top / ROW) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((top + (viewport.height || 1000)) / ROW) + OVERSCAN) : rows.length;

  const scrollIntoView = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const previousTop = el.scrollTop;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
    if (el.scrollTop !== previousTop) {
      // Keyboard moves already know the final offset. Mount that window with
      // the cursor update instead of waiting for a scroll event and another frame.
      const top = el.scrollTop;
      store.scrollTop = top;
      if (windowed) setViewport((v) => v.top === top ? v : { ...v, top });
    }
  };

  const move = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    setCursor(row.key);
    scrollIntoView(index.get(row.key) ?? 0);
  };

  const pathOf = (row: Row) => (row.kind === "entry" ? row.entry.path : row.kind === "result" ? row.path : null);

  const activate = (row: Row, newTab: boolean) => {
    if (row.kind === "note") {
      if (row.error) void store.load(row.dir, true);
      return;
    }
    if (row.kind === "entry" && row.entry.type === "dir") return store.setExpanded(row.entry.path, !row.expanded);
    const path = pathOf(row)!;
    if (path !== selected) store.openedFromTree = path;
    // The open replaces this tab, so this tree unmounts: the next one takes the focus back.
    const a = document.activeElement;
    if (path !== selected || newTab) store.refocus = a === search.current ? "search" : scroller.current?.contains(a) ? "tree" : null;
    onOpen(path, { newTab });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    setKeyboard(true);
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isComposing(e)) return;
    const i = activeIndex;
    const row = rows[i];
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW) - 1);
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowDown":
        handled();
        return move(cursorIndex < 0 ? i : i + 1);
      case "ArrowUp":
        handled();
        if (i === 0 && q) return search.current?.focus();
        return move(i - 1);
      case "PageDown":
        handled();
        return move(i + page);
      case "PageUp":
        handled();
        return move(i - page);
      case "Home":
        handled();
        return move(0);
      case "End":
        handled();
        return move(rows.length - 1);
      case "ArrowRight":
        handled();
        if (row?.kind !== "entry" || row.entry.type !== "dir") return;
        if (!row.expanded) return store.setExpanded(row.entry.path, true);
        if (rows[i + 1]?.kind === "entry" && dirName((rows[i + 1] as Extract<Row, { kind: "entry" }>).entry.path) === row.entry.path) move(i + 1);
        return;
      case "ArrowLeft": {
        handled();
        if (row?.kind === "entry" && row.entry.type === "dir" && row.expanded) return store.setExpanded(row.entry.path, false);
        const parent = row?.kind === "entry" ? dirName(row.entry.path) : row?.kind === "note" ? row.dir : "";
        const at = parent ? index.get(parent) : undefined;
        if (at !== undefined) move(at);
        return;
      }
      case "Enter":
        handled();
        if (row) activate(row, false);
        return;
      case "Escape":
        if (!q) return;
        handled();
        e.stopPropagation();
        store.setQuery("");
        return;
    }
    if (e.key.length !== 1 || (e.key === " " && !typed.current.text)) {
      if (e.key === " " && row) {
        handled();
        activate(row, false);
      }
      return;
    }
    handled();
    const t = typed.current;
    t.text += e.key;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => (t.text = ""), 600);
    const hit = typeAhead(rows, i, t.text);
    if (hit >= 0) move(hit);
  };

  const rowAt = (e: ReactMouseEvent | React.DragEvent): Row | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    return el ? (rows[Number(el.dataset.row)] ?? null) : null;
  };

  const onClick = (e: ReactMouseEvent) => {
    const row = rowAt(e);
    if (!row) return;
    setKeyboard(false);
    setCursor(row.key);
    activate(row, e.metaKey || e.ctrlKey);
  };

  const onAuxClick = (e: ReactMouseEvent) => {
    const row = rowAt(e);
    if (e.button !== 1 || !row || row.kind === "note" || (row.kind === "entry" && row.entry.type === "dir")) return;
    e.preventDefault();
    activate(row, true);
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    const row = rowAt(e);
    if (!row || row.kind === "note") return;
    e.preventDefault();
    setCursor(row.key);
    setMenu({ x: e.clientX, y: e.clientY, row });
  };

  const onDragStart = (e: React.DragEvent) => {
    const row = rowAt(e);
    const path = row ? pathOf(row) : null;
    if (!path) return;
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "copy";
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    store.scrollTop = el.scrollTop;
    if (!windowed) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setViewport((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop })));
  };

  const rootLoading = !q && !state.listings.has("") && !state.errors.has("");
  const rootError = !q ? state.errors.get("") : undefined;
  const anyExpanded = state.expanded.size > 0;
  const showCursor = keyboard && focused;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <BarButton
          size="sm"
          label="Refresh"
          onClick={() => {
            store.refresh();
            if (q) store.setResults(null);
          }}
        >
          <Icon icon={RefreshCwIcon} />
        </BarButton>
        <label className="flex h-7 min-w-0 flex-1 items-center rounded-md pl-1.5 pr-1 transition-colors duration-75 hover:bg-accent/60 focus-within:bg-accent/60">
          <input
            ref={search}
            value={state.query}
            onChange={(e) => store.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === "Escape") {
                if (!state.query) return;
                e.preventDefault();
                e.stopPropagation();
                store.setQuery("");
                scroller.current?.focus();
              } else if (e.key === "ArrowDown" || (e.key === "Enter" && rows.length > 0)) {
                e.preventDefault();
                setKeyboard(true);
                scroller.current?.focus();
                const row = rows[0];
                if (!row) return;
                setCursor(row.key);
                if (e.key === "Enter") activate(row, e.metaKey || e.ctrlKey);
              }
            }}
            placeholder="Search files"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search files"
            aria-keyshortcuts="Meta+F"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {state.query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                store.setQuery("");
                search.current?.focus();
              }}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon icon={Cancel01Icon} className="size-3.5" />
            </button>
          ) : null}
        </label>
        <BarButton size="sm" label={anyExpanded ? "Collapse all folders" : "Expand all folders"} disabled={!!q} onClick={() => (anyExpanded ? store.collapseAll() : void store.expandAll())}>
          {anyExpanded ? <Icon icon={FoldVerticalIcon} /> : <Icon icon={UnfoldVerticalIcon} />}
        </BarButton>
      </div>

      <div
        ref={scroller}
        role="tree"
        aria-label={q ? "Search results" : "Files"}
        aria-activedescendant={rows.length > 0 && activeIndex >= first && activeIndex < last ? `${uid}-${activeIndex}` : undefined}
        aria-busy={rootLoading || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={() => setKeyboard(false)}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          setFocused(true);
          // Tabbing in shows the cursor ring at once; a click doesn't.
          if (e.currentTarget.matches(":focus-visible")) setKeyboard(true);
        }}
        onBlur={(e) => e.target === e.currentTarget && setFocused(false)}
        onClick={onClick}
        onAuxClick={onAuxClick}
        onContextMenu={onContextMenu}
        onDragStart={onDragStart}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2 outline-none [scrollbar-gutter:stable]"
      >
        {rootLoading ? <TreeSkeleton /> : null}
        {rootError !== undefined ? (
          <SurfaceEmpty title="Couldn't list this workspace" action={<QuietButton onClick={() => void store.load("", true)}>Retry</QuietButton>}>
            {rootError}
          </SurfaceEmpty>
        ) : null}
        {q && state.results?.query === q && rows.length === 0 ? <SurfaceEmpty title="No match">No file matches “{q}”.</SurfaceEmpty> : null}
        <div style={{ height: rows.length * ROW }} className="relative">
          {rows.slice(first, last).map((row, k) => {
            const i = first + k;
            return (
              <TreeRow
                key={row.key}
                id={`${uid}-${i}`}
                index={i}
                row={row}
                query={q}
                selected={row.key === selected}
                cursor={showCursor && i === activeIndex}
                busy={row.kind === "entry" && state.loading.has(row.entry.path)}
              />
            );
          })}
        </div>
        {q && state.results?.truncated ? <p className="px-3 pt-1 text-[12px] text-muted-foreground">More matches. Refine the search.</p> : null}
      </div>

      <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="min-w-[200px]" onCloseAutoFocus={(e) => (e.preventDefault(), scroller.current?.focus({ preventScroll: true }))}>
          {menu ? <RowMenu workspaceId={workspaceId} row={menu.row} root={root} onRevealed={() => setMenu(null)} activate={activate} revealInTree={(path) => void store.reveal(path)} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RowMenu({ workspaceId, row, root, activate, revealInTree, onRevealed }: { workspaceId: string; onRevealed: () => void; row: Row; root: string | undefined; activate: (row: Row, newTab: boolean) => void; revealInTree: (path: string) => void }) {
  const { client } = useRuntimeClient();
  const editors = useEditors();
  const [error, setError] = useState<string | null>(null);
  if (row.kind === "note") return null;
  const path = row.kind === "entry" ? row.entry.path : row.path;
  const dir = row.kind === "entry" && row.entry.type === "dir";
  return (
    <>
      {dir ? (
        <DropdownMenuItem onSelect={() => activate(row, false)}>{row.kind === "entry" && row.expanded ? "Collapse" : "Expand"}</DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onSelect={() => activate(row, false)}>Open</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => activate(row, true)}>
            Open in new tab
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{formatChord("mod+click")}</span>
          </DropdownMenuItem>
        </>
      )}
      {row.kind === "result" ? <DropdownMenuItem onSelect={() => revealInTree(path)}>Reveal in tree</DropdownMenuItem> : null}
      {editors.reveal ? <DropdownMenuItem onSelect={(e) => {
        // Keep the menu until the host confirms: a failed reveal stays visible and can be retried.
        e.preventDefault();
        setError(null);
        void revealFile(client, workspaceId, path).then(onRevealed, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      }}>{revealLabel()}</DropdownMenuItem> : null}
      {error ? <p role="alert" className="max-w-64 px-2 py-1 text-xs text-destructive">Couldn't reveal this path. {error}</p> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(nativePath(root, path))}>Copy path</DropdownMenuItem>
      {root ? <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(absolutePath(root, path))}>Copy absolute path</DropdownMenuItem> : null}
      <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(baseName(path))}>Copy name</DropdownMenuItem>
    </>
  );
}

function TreeSkeleton() {
  return (
    <div role="status" aria-label="Loading files" className="space-y-[9px] px-3 pt-1.5 animate-in fade-in-0 fill-mode-backwards delay-150 duration-200">
      {[62, 48, 70, 40, 56, 66, 44].map((w, i) => (
        <Skeleton key={i} className="h-[15px]" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- rows

interface TreeRowProps {
  readonly id: string;
  readonly index: number;
  readonly row: Row;
  readonly query: string;
  readonly selected: boolean;
  readonly cursor: boolean;
  readonly busy: boolean;
}

/** Equal when every row field is: rows are rebuilt on each change, but most come out the same. */
function sameRow(a: TreeRowProps, b: TreeRowProps): boolean {
  if (a.id !== b.id || a.index !== b.index || a.selected !== b.selected || a.cursor !== b.cursor || a.busy !== b.busy || a.query !== b.query) return false;
  const x = a.row as unknown as Record<string, unknown>;
  const y = b.row as unknown as Record<string, unknown>;
  return Object.keys(x).every((k) => x[k] === y[k]);
}

const TreeRow = memo(function TreeRow({ id, index, row, selected, cursor, busy }: TreeRowProps) {
  const depth = row.kind === "result" ? 0 : row.depth;
  const base = "absolute inset-x-1 flex select-none items-center rounded-md pr-2 text-[13px] leading-none";
  const style = { top: index * ROW, height: ROW, paddingLeft: PAD + depth * INDENT };
  const guides = Array.from({ length: depth }, (_, l) => <span key={l} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: PAD + l * INDENT + 7 }} />);

  if (row.kind === "note") {
    return (
      <div id={id} data-row={index} role="treeitem" aria-level={depth + 1} aria-selected={false} style={style} className={cn(base, row.error ? "cursor-pointer text-destructive" : "text-[hsl(var(--subtle-foreground))]", cursor && "ring-2 ring-inset ring-ring")}>
        {guides}
        <span className="truncate pl-[22px] text-[12px]">{row.error ? `Couldn't list this folder. Retry` : row.text}</span>
      </div>
    );
  }

  const path = row.kind === "entry" ? row.entry.path : row.path;
  const dir = row.kind === "entry" && row.entry.type === "dir";
  const ignored = row.kind === "entry" && row.entry.ignored;
  const name = baseName(path);
  const Glyph = dir ? null : fileIcon(name);
  return (
    <div
      id={id}
      data-row={index}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={row.pos}
      aria-setsize={row.size}
      aria-selected={selected}
      {...(dir ? { "aria-expanded": row.kind === "entry" && row.expanded } : {})}
      aria-busy={busy || undefined}
      title={path}
      draggable
      style={style}
      className={cn(
        base,
        "cursor-pointer transition-colors duration-75 ease-snap",
        selected ? "bg-accent text-foreground ring-1 ring-inset ring-ring/45" : cn("hover:bg-accent hover:text-foreground", ignored ? "text-[hsl(var(--subtle-foreground))]" : "text-secondary-foreground"),
        cursor && "ring-2 ring-inset ring-ring",
      )}
    >
      {guides}
      {dir ? (
        <Icon
          icon={ArrowRight01Icon}
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap motion-reduce:transition-none", row.kind === "entry" && row.expanded && "rotate-90", busy && "animate-pulse")}
        />
      ) : Glyph ? (
        <Glyph aria-hidden className={cn("size-4 shrink-0", ignored && !selected && "opacity-60")} />
      ) : null}
      {row.kind === "result" ? (
        <span className="ml-1.5 flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 truncate">{marked(name, row.matches, path.length - name.length)}</span>
          {path.length > name.length ? <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">{marked(dirName(path), row.matches, 0)}</span> : null}
        </span>
      ) : (
        <span className="ml-1.5 truncate">{name}</span>
      )}
    </div>
  );
}, sameRow);

/** `text` with the characters at `matches` (offsets into the full path, `text` starting at `offset`) in white. */
function marked(text: string, matches: ReadonlyArray<number>, offset: number) {
  const hits = new Set(matches.filter((m) => m >= offset && m < offset + text.length).map((m) => m - offset));
  if (hits.size === 0) return text;
  const out: Array<string | React.ReactElement> = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (!run) return;
    out.push(on ? <mark key={k} className="bg-transparent font-semibold text-foreground">{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += text[i];
  }
  flush(text.length);
  return out;
}

// ------------------------------------------------------------------ icons

export { fileIcon };
