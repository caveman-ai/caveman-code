// The Files surface: both `files` (the tree, full width) and `file` (one
// file, with the tree beside it on the right). Layout 
// preview (MIT, apps/web/src/components/files/FilePreviewPanel.tsx,
// FileBreadcrumbs.tsx @ ab3a3cd1): a bar with breadcrumbs that scroll with
// edge fades and the view's toggles; the file left; the tree an aside on the
// right, hidden on request (remembered), floating over the file in a narrow
// pane. Agent edits refresh the open file and the listed folders in place.

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowRight01Icon, CodeIcon, Copy01Icon, Folder01Icon, FolderTreeIcon, LinkSquare02Icon, Search01Icon, TextWrapIcon, Tick02Icon, ViewIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton, BarGroup, formatChord, Keycap, launchChord, SurfaceBar } from "../chrome.tsx";
import type { SurfaceProps } from "../registry.ts";
import { openFile } from "../openFile.ts";
import { isHtmlFile } from "../browser/htmlFile.ts";
import { openSurface, type SurfaceParams } from "../store.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { FileTree, fileIcon } from "./FileTree.tsx";
import { openInEditor, preferredEditor, revealFile, revealLabel, useEditors } from "./editors.ts";
import { useFileContent, useFilesVersion, useFileWriter } from "./fileContent.tsx";
import { FindBar, isFindChord } from "./FindBar.tsx";
import { RevealButton } from "./FileMenu.tsx";
import { FileView, type ViewMode } from "./FileView.tsx";
import { absolutePath, baseName, dirName, fileKind, nativePath, parentDirs, resolveLink } from "./tree.ts";
import { treeStore } from "./treeStore.ts";

/** Below this surface width the tree floats over the file instead of sharing the row. */
const NARROW = 560;

type Open = (path: string, options?: { newTab?: boolean; line?: number }) => void;

export default function FileSurface({ workspaceId, tab }: SurfaceProps) {
  const file = tab.kind === "file" ? (tab.params as SurfaceParams["file"]) : null;
  const { client, connection } = useRuntimeClient();
  const editors = useEditors();
  const [revealError, setRevealError] = useState<string | null>(null);
  const w = usePanelWorkspace();
  const sessionId = w?.session_id ?? null;
  const repo = w ? ("path" in w.repo ? (w.repo.path.split("/").filter(Boolean).pop() ?? w.repo.path) : w.repo.url.replace(/^.*[/:]([^/]+?)(\.git)?$/, "$1")) : "Workspace";
  const root = w?.root_path;
  const { version, watch } = useFilesVersion(sessionId, connection);
  // A tree click navigates this tab (like a browser tab); ⌘-click, a middle click or a link opens a new one.
  const open: Open = (path, { newTab = false, line } = {}) => void openFile(workspaceId, path, line, newTab ? {} : { replace: tab.id });
  // Also upgrade persisted/source tabs and callers that still open a generic file.
  const htmlPage = file && !file.ref && isHtmlFile(file.path);
  useEffect(() => {
    if (htmlPage && file) openFile(workspaceId, file.path, file.line, { replace: tab.id });
  }, [workspaceId, tab.id, htmlPage, file?.path, file?.line]);
  const folder = tab.kind === "files" ? (tab.params as SurfaceParams["files"]).path : undefined;

  // A folder named elsewhere (a chip in the chat): show it once the tree below has its connection.
  useEffect(() => {
    if (folder !== undefined) void treeStore(workspaceId).reveal(folder, true);
  }, [workspaceId, folder, tab.reveal]);

  if (htmlPage) return null;
  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] text-muted-foreground">
          {folder !== undefined ? <><Icon icon={Folder01Icon} className="size-3.5 shrink-0" /><span title={folder || repo} className="min-w-0 flex-1 truncate">{folder || repo}</span></> : <span className="min-w-0 flex-1">Open a file from the tree or search <Keycap>{formatChord(launchChord())}</Keycap></span>}
          {editors.reveal ? <button type="button" onClick={() => {
            setRevealError(null);
            void revealFile(client, workspaceId, folder || ".").catch((cause: unknown) => setRevealError(cause instanceof Error ? cause.message : String(cause)));
          }} className="shrink-0 rounded px-1.5 py-1 text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{revealLabel()}</button> : null}
        </div>
        {revealError ? <p role="alert" className="px-3 py-2 text-xs text-destructive">Couldn't reveal this folder. {revealError}</p> : null}
        <FileTree workspaceId={workspaceId} root={root} selected={null} reveal={tab.reveal} version={version} onOpen={(path, o) => open(path, o)} autoFocus className="flex-1" />
        {watch}
      </div>
    );
  }
  return (
    <>
      <OpenFile workspaceId={workspaceId} repo={repo} root={root} reveal={tab.reveal} file={file} version={version} open={open} />
      {watch}
    </>
  );
}

function OpenFile({
  workspaceId,
  repo,
  root,
  reveal,
  file,
  version,
  open,
}: {
  workspaceId: string;
  repo: string;
  /** The absolute worktree root (This Mac only). */
  root: string | undefined;
  reveal: number;
  file: SurfaceParams["file"];
  version: number | null;
  open: Open;
}) {
  const { path, ref: gitRef, line } = file;
  const kind = fileKind(path);
  const content = useFileContent(workspaceId, path, gitRef, version);
  const write = useFileWriter(workspaceId, path, gitRef, content);
 // Rendered or source is remembered (upstream renderMarkdown preference); opening at a line shows the source, where the line is.
  const [rendered, setRendered] = usePref("caveman.files.rendered", true);
  const [mode, setModeState] = useState<ViewMode>(line && kind === "markdown" ? "source" : rendered ? "preview" : "source");
  const setMode = (next: ViewMode) => {
    setModeState(next);
    setRendered(next === "preview");
  };
  const [finding, setFinding] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  // A document reads best wide: the tree starts hidden over a rendered one, and each remembers its own.
  const reading = kind === "markdown" && mode === "preview";
  const [treeOpen, setTreeOpen] = usePref(reading ? "caveman.files.docTree" : "caveman.files.tree", !reading);
  const [wrap, setWrap] = usePref("caveman.files.wrap", false);
  const [floatingTree, setFloatingTree] = useState(false);
  const [revealLine, setRevealLine] = useState(line);
  const host = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(host);

  // An open with a line (re)reveals it once; a later refresh of the content must not jump back.
  useEffect(() => {
    setRevealLine(line);
    if (line && kind === "markdown") setModeState("source");
  }, [line, reveal, kind]);
  useEffect(() => {
    if (revealLine === undefined || content.state.status !== "ready") return;
    const f = requestAnimationFrame(() => setRevealLine(undefined));
    return () => cancelAnimationFrame(f);
  }, [revealLine, content.state.status]);

  const ready = content.state.status === "ready" ? content.state.file : null;
  const text = !!ready && ready.encoding === "utf8" && kind !== "image";
  const renderable = text && (kind === "markdown" || kind === "table" || kind === "diagram");
  const showWrap = text && !(renderable && mode === "preview");
  const showTree = narrow ? floatingTree : treeOpen;

  const revealInTree = (target: string, isDir: boolean) => {
    if (narrow) setFloatingTree(true);
    else setTreeOpen(true);
    void treeStore(workspaceId).reveal(target, isDir);
  };

  const onLink = (href: string, event: MouseEvent<HTMLAnchorElement>) => {
    const target = resolveLink(path, href);
    // The renderer opens http(s) and mailto in a new tab and scrolls to a #heading.
    if (target?.kind === "external" || target?.kind === "anchor") return;
    // Everything else stays in the app: a blocked scheme or a path out of the workspace goes nowhere.
    event.preventDefault();
    if (!target || target.kind === "blocked") return;
    // A link to a folder shows it in the tree.
    const listed = treeStore(workspaceId).state.listings.get(dirName(target.path))?.entries.find((e) => e.path === target.path);
    if (href.split(/[?#]/, 1)[0]!.endsWith("/") || listed?.type === "dir") return revealInTree(target.path, true);
    open(target.path, { newTab: true, ...(target.line ? { line: target.line } : {}) });
  };

  const tree = (
    <FileTree
      workspaceId={workspaceId}
      root={root}
      selected={path}
      reveal={reveal}
      version={version}
      onOpen={(p, o) => {
        if (narrow) setFloatingTree(false);
        if (p !== path || o.newTab) open(p, o);
      }}
      className="flex-1"
    />
  );

  return (
    <div
      ref={host}
      // A click in the file takes focus here, so ⌘F finds in it rather than in the chat.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(e) => {
        if (!isFindChord(e)) return;
        e.preventDefault();
        setFinding(true);
      }}
    >
      <SurfaceBar className="gap-2 pr-1.5">
        <Breadcrumbs workspaceId={workspaceId} repo={repo} root={root} path={path} gitRef={gitRef} onReveal={revealInTree} />
        <div className="flex shrink-0 items-center gap-0.5">
          {renderable ? (
            <BarGroup className="mr-1">
              <BarButton size="sm" label="Preview" pressed={mode === "preview"} onClick={() => setMode("preview")}>
                <Icon icon={ViewIcon} />
              </BarButton>
              <BarButton size="sm" label="Source" pressed={mode === "source"} onClick={() => setMode("source")}>
                <Icon icon={CodeIcon} />
              </BarButton>
            </BarGroup>
          ) : null}
          {showWrap ? (
            <BarButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={() => setWrap(!wrap)}>
              <Icon icon={TextWrapIcon} />
            </BarButton>
          ) : null}
          <BarButton label="Find" pressed={finding} onClick={() => setFinding(!finding)}>
            <Icon icon={Search01Icon} />
          </BarButton>
          {gitRef ? null : <EditorButtons workspaceId={workspaceId} path={path} line={revealLine} />}
          {gitRef ? null : <RevealButton workspaceId={workspaceId} path={path} />}
          <CopyPathButton path={path} />
          <BarButton label={showTree ? "Hide files" : "Show files"} pressed={showTree} onClick={() => (narrow ? setFloatingTree(!floatingTree) : setTreeOpen(!treeOpen))}>
            <Icon icon={FolderTreeIcon} />
          </BarButton>
        </div>
      </SurfaceBar>
      {finding ? <FindBar root={view} onClose={() => setFinding(false)} label={`Find in ${baseName(path)}`} /> : null}
      <div className="relative flex min-h-0 flex-1">
        <div ref={view} className="flex min-w-0 flex-1 flex-col" onPointerDown={() => narrow && floatingTree && setFloatingTree(false)}>
          <FileView workspaceId={workspaceId} root={root} path={path} gitRef={gitRef} state={content.state} mode={mode} wrap={wrap} revealLine={revealLine} onLink={onLink} onRetry={content.retry} onWrite={write} onMore={content.more} version={version} />
        </div>
        {showTree && !narrow ? <aside className="flex w-[min(22rem,46%)] min-w-64 shrink-0 border-l border-border">{tree}</aside> : null}
        {showTree && narrow ? (
          <aside
            onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && setFloatingTree(false)}
            className="absolute inset-y-0 right-0 z-10 flex w-[min(100%,20rem)] border-l border-border bg-background shadow-overlay animate-in fade-in-0 slide-in-from-right-2 duration-200 ease-drawer"
          >
            {tree}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- breadcrumbs

function Breadcrumbs({ workspaceId, repo, root, path, gitRef, onReveal }: { workspaceId: string; repo: string; root: string | undefined; path: string; gitRef: string | undefined; onReveal: (path: string, isDir: boolean) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const editors = useEditors();
  const { client } = useRuntimeClient();
  const dirs = parentDirs(path);
  const Glyph = fileIcon(baseName(path));

  // The file name is what matters: keep the end in view, fade whichever edge runs over.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    measure();
    const ro = new ResizeObserver(() => {
      el.scrollLeft = el.scrollWidth;
      measure();
    });
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [path]);

  const mask = edges.start || edges.end ? `linear-gradient(to right, ${edges.start ? "transparent, #000 20px" : "#000"}, ${edges.end ? "#000 calc(100% - 20px), transparent" : "#000"})` : undefined;
  const crumb = "shrink-0 rounded px-1 py-0.5 outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  const onContextMenu = (p: string, isDir: boolean) => (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path: p, isDir });
  };
  const sep = <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-[hsl(var(--subtle-foreground))]" />;

  return (
    <nav aria-label="File path" className="min-w-0 flex-1">
      <div
        ref={scroller}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button type="button" title="Reveal in the tree" onClick={() => onReveal("", true)} className={cn(crumb, "-ml-0.5 text-[13px]")}>
          {repo}
        </button>
        {dirs.map((d) => (
          <span key={d} className="flex shrink-0 items-center gap-0.5">
            {sep}
            <button type="button" title="Reveal in the tree" onClick={() => onReveal(d, true)} onContextMenu={onContextMenu(d, true)} className={cn(crumb, "font-mono text-[12px]")}>
              {baseName(d)}
            </button>
          </span>
        ))}
        {sep}
        <span aria-current="page" onContextMenu={onContextMenu(path, false)} className="flex shrink-0 items-center gap-1.5 px-1 font-mono text-[12px] text-foreground">
          <Glyph aria-hidden strokeWidth={1.75} className="size-3.5 text-muted-foreground" />
          {baseName(path)}
          {gitRef ? <span className="text-muted-foreground">@{gitRef.slice(0, 12)}</span> : null}
        </span>
      </div>
      <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="min-w-[180px]">
          {menu ? (
            <>
              <DropdownMenuItem onSelect={() => onReveal(menu.path, menu.isDir)}>Reveal in tree</DropdownMenuItem>
              {editors.reveal && !gitRef ? (
                <DropdownMenuItem onSelect={() => void revealFile(client, workspaceId, menu.path).catch(() => {})}>{revealLabel()}</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(nativePath(root, menu.path))}>Copy path</DropdownMenuItem>
              {root ? <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(absolutePath(root, menu.path))}>Copy absolute path</DropdownMenuItem> : null}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}

/** Open in the user's editor (the last one picked), with the others one menu away: upstream "Open in". Reveal in Finder is its own button beside it. */
function EditorButtons({ workspaceId, path, line }: { workspaceId: string; path: string; line: number | undefined }) {
  const editors = useEditors();
  const { client } = useRuntimeClient();
  const editor = preferredEditor(editors);
  if (!editor) return null;
  return (
    <BarGroup>
      <BarButton label={`Open in ${editor.label}`} onClick={() => void openInEditor(client, workspaceId, path, { line, editor: editor.id })}>
        <Icon icon={LinkSquare02Icon} />
      </BarButton>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <BarButton size="sm" label="Open in…">
            <Icon icon={ArrowDown01Icon} />
          </BarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
          {editors.editors.map((e) => (
            <DropdownMenuItem key={e.id} onSelect={() => void openInEditor(client, workspaceId, path, { line, editor: e.id })}>
              <span className="flex-1">Open in {e.label}</span>
              {e.id === editor?.id ? <Icon icon={Tick02Icon} className="size-3.5 text-muted-foreground" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </BarGroup>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <BarButton label={done ? "Copied" : "Copy path"} onClick={() => void navigator.clipboard?.writeText(path).then(() => setDone(true))}>
      {done ? <Icon icon={Tick02Icon} /> : <Icon icon={Copy01Icon} />}
    </BarButton>
  );
}

// ------------------------------------------------------------------ hooks

/** A boolean kept in localStorage; a new key reads its own. */
function usePref(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const read = () => {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  };
  const [state, setState] = useState(() => ({ key, value: read() }));
  return [
    state.key === key ? state.value : read(),
    (next) => {
      setState({ key, value: next });
      localStorage.setItem(key, next ? "1" : "0");
    },
  ];
}

function useNarrow(host: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [host]);
  return narrow;
}
