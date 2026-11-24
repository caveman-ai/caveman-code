// "Open anything": one query field that opens a tool, a URL or a file. The
// `+` menu and the new tab both use it. Typing filters the tools (so "t ⏎"
// opens a terminal), a URL-ish query offers the browser first, and anything
// else searches the workspace's files (fs.search).

import { Popover, PopoverAnchor, PopoverContent } from "@caveman-app/ui/components/popover";
import { cn } from "@caveman-app/ui/lib/cn";
import { menuDescription, menuHeading, menuItem } from "@caveman-app/ui/components/menu";
import { Icon, CornerDownLeftIcon, Search01Icon, BrowserIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRuntimeClient } from "../state/runtime.tsx";
import { formatChord, isComposing, Keycap } from "./chrome.tsx";
import { launcherSurfaces } from "./registry.ts";
import { openSurface, type OpenOptions, type SurfaceKind, type SurfaceParams } from "./store.ts";
import { fileIcon } from "./files/fileIcon.tsx";

const BrowserGlyph = ({ className }: { className?: string }) => <Icon icon={BrowserIcon} className={cn("size-4", className)} />;

export interface LaunchItem {
  readonly key: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly description?: string;
  readonly chord?: string;
  readonly section: "Tools" | "Open" | "Files";
  readonly open: (options?: OpenOptions) => void;
}

/**
 * "localhost:3000", ":3000", "10.0.0.5:8080", "example.com/x", "http://..." -> a URL to load; anything else -> null.
 * Strict (the launcher, where "main.go" and "README.md" are files): a dotted host only with a common web TLD.
 * Loose (an address bar, where everything typed is meant as an address): any dotted host.
 */
export function asUrl(query: string, loose = false): string | null {
  const q = query.trim();
  if (!q || /\s/.test(q)) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (/^([a-z0-9-]+\.)*(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(q)) return `http://${q}`;
  if (/^:\d{2,5}(\/.*)?$/.test(q)) return `http://localhost${q}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(q)) return `http://${q}`;
  const tld = loose ? "[a-z]{2,63}" : "(com|org|net|dev|io|app|ai|co|xyz|gg|tv|edu|gov|uk|de|nl|fr|eu|ca|au|jp)";
  return new RegExp(`^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.${tld}(:\\d+)?(\\/.*)?$`, "i").test(q) ? `https://${q}` : null;
}

function rank(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 0;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  return l.includes(q) ? 2 : -1;
}

/** The launcher's rows for a query: tools first (filtered), then the URL, then files. */
export function useLaunchItems(workspaceId: string, query: string): ReadonlyArray<LaunchItem> {
  const { client } = useRuntimeClient();
  const q = query.trim().toLowerCase();
  const url = asUrl(query);
  const [files, setFiles] = useState<{ query: string; paths: ReadonlyArray<string> }>({ query: "", paths: [] });

  useEffect(() => {
    if (!client || q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      client.call("fs.search", { workspace_id: workspaceId, query: q, limit: 20 }).then(
        (r) => live && setFiles({ query: q, paths: r.paths }),
        () => live && setFiles({ query: q, paths: [] }),
      );
    }, 90);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, q]);

  return useMemo(() => {
    const open =
      <K extends SurfaceKind>(kind: K, params: SurfaceParams[K]) =>
      (options?: OpenOptions) =>
        void openSurface(workspaceId, kind, params, options);
    const tools: LaunchItem[] = launcherSurfaces()
      .filter((d) => d.kind !== "new")
      .map((d) => ({ def: d, r: q ? rank(d.label, q) : 0 }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map(({ def }) => ({
        key: `tool:${def.kind}`,
        icon: def.icon,
        label: def.label,
        ...(def.description ? { description: def.description } : {}),
        ...(def.chord ? { chord: def.chord } : {}),
        section: "Tools",
        open: open(def.kind, {} as never),
      }));
    const items: LaunchItem[] = [];
    if (url) items.push({ key: `url:${url}`, icon: BrowserGlyph, label: url.replace(/^https?:\/\//, ""), description: "Open in browser", section: "Open", open: open("browser", { url }) });
    items.push(...tools);
    if (q.length >= 2) {
      // A query that is already a path opens as typed, even before (or without) search results.
      const typed = !/^https?:/i.test(query.trim()) && /[./]/.test(query.trim()) && !files.paths.includes(query.trim()) ? [query.trim()] : [];
      // The last results stay up while the next search runs, so the list doesn't flash empty per keystroke.
      for (const path of [...typed, ...files.paths]) {
        const slash = path.lastIndexOf("/");
        items.push({ key: `file:${path}`, icon: fileIcon(path.slice(slash + 1)), label: path.slice(slash + 1), description: slash > 0 ? path.slice(0, slash) : "", section: "Files", open: open("file", { path }) });
      }
    }
    return items;
  }, [workspaceId, q, query, url, files]);
}

/** The query field and its result list; keyboard first (↑ ↓ ⏎, Esc). */
export function LaunchList({
  workspaceId,
  placeholder = "Open a file, URL or tool…",
  autoFocus,
  onDone,
  replace,
  idle,
  className,
  fieldClassName,
  listClassName,
}: {
  workspaceId: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Called after something opened, or on Escape. */
  onDone?: () => void;
  /** The launcher tab to turn into what opens. */
  replace?: string;
  /** What to show under the field while the query is empty (the new tab's grid). Defaults to the tool rows. */
  idle?: ReactNode;
  className?: string;
  fieldClassName?: string;
  listClassName?: string;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const uid = useId();
  const items = useLaunchItems(workspaceId, query);
  const list = useRef<HTMLDivElement>(null);
  const showList = query.trim() !== "" || !idle;

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (item: LaunchItem | undefined) => {
    if (!item) return;
    item.open(replace ? { replace } : undefined);
    setQuery("");
    onDone?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (isComposing(e)) return;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[index]);
    } else if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
      } else onDone?.();
    }
  };

  let lastSection: string | null = null;
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <label className={cn("flex h-10 shrink-0 items-center gap-2 px-3", fieldClassName)}>
        <Icon icon={Search01Icon} className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={placeholder}
          aria-controls={`${uid}list`}
          aria-activedescendant={showList && items[index] ? `${uid}o${index}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      {showList ? (
        <div ref={list} id={`${uid}list`} role="listbox" className={cn("min-h-0 overflow-y-auto border-t border-border p-1", listClassName)}>
          {items.length === 0 ? <div className="px-2.5 py-2 text-[13px] text-muted-foreground">{query.trim().length < 2 ? "Keep typing to search files." : "Searching…"}</div> : null}
          {items.map((item, i) => {
            const header = item.section !== lastSection && (query.trim() !== "" || item.section !== "Tools") ? item.section : null;
            lastSection = item.section;
            const ItemIcon = item.icon;
            return (
              <div key={item.key}>
                {header ? <div className={menuHeading}>{header}</div> : null}
                <div
                  id={`${uid}o${i}`}
                  role="option"
                  aria-selected={i === index}
                  data-active={i === index}
                  data-index={i}
                  onPointerMove={() => i !== index && setIndex(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => run(item)}
                  className={menuItem}
                >
                  <ItemIcon className="size-4 shrink-0" />
                  <span className="shrink-0 text-foreground">{item.label}</span>
                  {item.description ? <span className={cn(menuDescription, item.section === "Files" && "font-mono text-[12px]")}>{item.description}</span> : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
                    {i === index && !item.chord ? <Icon icon={CornerDownLeftIcon} className="size-3.5 text-muted-foreground" /> : null}
                    {item.chord ? <Keycap>{formatChord(item.chord)}</Keycap> : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        idle
      )}
    </div>
  );
}

/** The `+` button and its launcher popover. `open`/`onOpenChange` let ⌘T drive it. */
export function LauncherPopover({
  workspaceId,
  open,
  onOpenChange,
  onClosed,
  children,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus goes somewhere sensible after it closes (the popover has no trigger to return to). */
  onClosed?: () => void;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[400px] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Radix sees Escape first (document capture): with text in the field, Escape clears it and the popover stays.
        onEscapeKeyDown={(e) => {
          const input = document.activeElement;
          if (input instanceof HTMLInputElement && input.value) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed?.();
        }}
      >
        <LaunchList workspaceId={workspaceId} autoFocus onDone={() => onOpenChange(false)} listClassName="max-h-[min(420px,60vh)]" />
      </PopoverContent>
    </Popover>
  );
}
