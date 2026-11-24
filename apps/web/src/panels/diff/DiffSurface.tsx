// What the agent changed: fs.diff against the base, every file in one
// scrolling list with sticky headers, and a file list aside on the right.
// Layout and controls , apps/web/src/
// components/DiffPanel.tsx @ ab3a3cd1). Reloads when the session reports a
// diff change, when the window regains focus, and on Refresh; a reload
// keeps every unchanged file's object, so only changed files re-render.

import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { Icon, ArrowDown01Icon, ListTreeIcon, RefreshCwIcon, TextWrapIcon, FoldVerticalIcon, UnfoldVerticalIcon, FileDiffIcon } from "@caveman-app/ui/icons/huge";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useRuntimeClient, useSession } from "../../state/runtime.tsx";
import { BarButton, QuietButton, SurfaceBar, SurfaceEmpty } from "../chrome.tsx";
import type { SurfaceProps } from "../registry.ts";
import { openSurface } from "../store.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { useFileRefActions } from "../files/FileChip.tsx";
import { useFileMenu } from "../files/FileMenu.tsx";
import { FileDiff, splitPath, type Review } from "./FileDiff.tsx";
import { commentKey, keepComments, keptComments, reviewMessage, withComment, withoutComment, type LineComment } from "./comments.ts";
import { composeIn } from "../../components/compose-event.ts";
import { LARGE_LINES, patchLines, type DiffFile } from "./parsePatch.ts";
import { answered, answerFor, failed, rangeOf, type Answer } from "./answer.ts";
import { scopeLabel, turnScope, turnScopes } from "./turn-scope.ts";
import { StepDiff } from "./StepDiff.tsx";
import { useActionRuns, useActionsList } from "../../state/actions.ts";
import { ACTION_ICONS } from "../actions/icons.ts";
import { runInTerminal } from "../terminal/run.ts";
import { arriveMotion } from "@caveman-app/ui/motion";
import { SourceHeading, useChatSources } from "../../components/sources/parts.tsx";
import { groupChanges, type ChatSources } from "../../state/sources.ts";
import { OpenWakeLine, useOpenWake } from "../../components/cloud/OpenWake.tsx";

function useStoredFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored === "1";
  });
  return [
    value,
    (next) => {
      setValue(next);
      localStorage.setItem(key, next ? "1" : "0");
    },
  ];
}

/** Rows the Changes surface builds on its first render; files after them wait until scrolled near (FileDiff). */
const EAGER_ROWS = 300;

/**
 * The narrowest surface the file list (16rem) opens beside on its own: under it the list would leave the code its
 * first fifty columns or so, cut mid-line, so a side panel opens on the code alone (each file's sticky header names
 * it). Claude and compact give a diff its pane's width the same way.
 */
const LIST_ROOM_PX = 900;

/** Whether the surface is wide enough for the file list beside the code, kept current as the panel resizes. */
function useRoomForList(el: RefObject<HTMLElement | null>): boolean {
  const [roomy, setRoomy] = useState(true);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const fit = (width: number) => setRoomy(width >= LIST_ROOM_PX);
    fit(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => fit(entries[0]?.contentRect.width ?? node.getBoundingClientRect().width));
    ro.observe(node);
    return () => ro.disconnect();
  }, [el]);
  return roomy;
}

const STATUS: Record<DiffFile["status"], { letter: string; tone: string; label: string }> = {
  added: { letter: "A", tone: "text-diff-add-ink", label: "Added" },
  modified: { letter: "M", tone: "text-warning", label: "Modified" },
  deleted: { letter: "D", tone: "text-diff-del-ink", label: "Deleted" },
  renamed: { letter: "R", tone: "text-[hsl(var(--subtle-foreground))]", label: "Renamed" },
};

/**
 * The workspace is read here only for the session id and, for a chat in several sources, what they are (kept the same
 * object while they are the same); the body re-renders only when its own props change.
 */
export default function DiffSurface(props: SurfaceProps<"diff">) {
  const workspace = usePanelWorkspace();
  const sessionId = workspace?.session_id ?? null;
  const sources = useChatSources(workspace);
  // One edit step's own diff (its tool row), else the checkout's changes.
  if (props.tab.params.item) return <StepDiff key={props.tab.params.item} workspaceId={props.workspaceId} item={props.tab.params.item} />;
  return <Changes {...props} sessionId={sessionId} sources={sources} projectId={workspace?.project_id ?? null} />;
}

/**
 * `sources`: a chat in several sources lists its files under a heading per source (its name, branch and pull
 * request), each file's path inside its source; null, a chat in one source, lists them as they are.
 */
export const Changes = memo(function Changes({ workspaceId, tab, active, sessionId, sources, projectId }: SurfaceProps<"diff"> & { sessionId: string | null; sources: ChatSources | null; projectId: string | null }) {
  const { client } = useRuntimeClient();
  const { view } = useSession(sessionId);
  const diffVersion = view?.diffVersion ?? 0;
  // A Cloud chat whose computer sleeps: opening its changes wakes it, one line counts the wait, and they load once it answers.
  const { asleep, wait } = useOpenWake(sessionId);
  const [answer, setAnswer] = useState<Answer>({ range: "", diff: null, error: null });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // What the user chose per file; a file they haven't touched is collapsed only when it is large.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isCollapsed = (f: DiffFile) => chosen.get(f.path) ?? patchLines(f) > LARGE_LINES;
  // Lines wrap unless you turn it off: a diff beside the chat is narrow, and a cut line hides what changed at its end.
  const [wrap, setWrap] = useStoredFlag("caveman.diff.wrap", true);
  // The file list remembers two choices: beside a wide surface (open unless closed) and beside a narrow one (closed
  // unless opened), so opening it once in a side panel doesn't squeeze every diff after it.
  const root = useRef<HTMLDivElement>(null);
  const roomy = useRoomForList(root);
  const [listWide, setListWide] = useStoredFlag("caveman.diff.files", true);
  const [listNarrow, setListNarrow] = useStoredFlag("caveman.diff.files.narrow", false);
  const showList = roomy ? listWide : listNarrow;
  const setShowList = roomy ? setListWide : setListNarrow;
  const scroller = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  // The checkout's actions with the diff icon try these changes (docs/computer-config.md "Actions"): one click from here.
  const { list: actions } = useActionsList(workspaceId, active);
  const { runs, reload: reloadRuns } = useActionRuns(workspaceId);
  const tries = actions?.actions.filter((a) => a.icon === "diff") ?? [];
  // One finished turn (the checkpoint row's Changes, or the scope menu), else everything against the base.
  const checkpoints = view?.checkpoints;
  const scope = useMemo(() => (tab.params.turn && checkpoints ? turnScope(checkpoints, tab.params.turn) : null), [tab.params.turn, checkpoints]);
  const from = scope?.from;
  const to = scope?.to;
  const range = rangeOf(from, to);
  const { diff, error } = answerFor(answer, range);
  const pickScope = (turn: string | undefined) => openSurface(workspaceId, "diff", turn ? { turn } : {});
  // Line comments, kept per chat until they go to its box (or are cleared).
  const [comments, setCommentsState] = useState<ReadonlyArray<LineComment>>(() => keptComments(workspaceId));
  const [drafting, setDrafting] = useState<string | null>(null);
  const setComments = useCallback(
    (next: ReadonlyArray<LineComment>) => {
      keepComments(workspaceId, next);
      setCommentsState(next);
    },
    [workspaceId],
  );
  const review = useMemo<Review>(
    () => ({
      comments,
      drafting,
      onStart: (anchor) => setDrafting(commentKey(anchor)),
      onSave: (anchor, text) => {
        setComments(withComment(comments, anchor, text));
        setDrafting(null);
      },
      onCancel: () => setDrafting(null),
      onRemove: (comment) => setComments(withoutComment(comments, comment)),
    }),
    [comments, drafting, setComments],
  );
  const sendComments = () => {
    composeIn(workspaceId, reviewMessage(comments));
    setComments([]);
  };

  const load = useCallback(async () => {
    if (!client) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const res = await client.call("fs.diff", { workspace_id: workspaceId, ...(to ? { to, ...(from ? { from } : {}) } : {}) });
      if (n !== seq.current) return;
      setAnswer((prev) => answered(prev, range, res));
    } catch (e) {
      if (n === seq.current) setAnswer((prev) => failed(prev, range, e instanceof Error ? e.message : String(e)));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [client, workspaceId, from, to, range]);

  useEffect(() => {
    if (!asleep) void load();
  }, [load, diffVersion, asleep]);

  useEffect(() => {
    if (!active || asleep) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, load, asleep]);

  const setCollapsed = useCallback((path: string, collapsed: boolean) => setChosen((c) => new Map(c).set(path, collapsed)), []);
  const open = useCallback((path: string) => openSurface(workspaceId, "file", { path }), [workspaceId]);
  // Right-click a file (its header, its row in the list): open it, in the editor, Reveal in Finder, copy its path.
  const fileActions = useFileRefActions(workspaceId, usePanelWorkspace()?.root_path);
  const { onContextMenu: fileMenuFor, menu: fileMenu } = useFileMenu(fileActions);
  const onFileMenu = useStableCallback((f: DiffFile, e: React.MouseEvent) => fileMenuFor({ path: f.path, exact: true }, { missing: f.status === "deleted" })(e));

  const reveal = useCallback((path: string) => {
    setSelected(path);
    setCollapsed(path, false);
    // After the expand renders: the scroller is the sections' offsetParent.
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-diff-path="${CSS.escape(path)}"]`);
      if (el) scroller.current!.scrollTop = el.offsetTop;
    });
  }, [setCollapsed]);

  // Opening the tab on a file (and each re-open, `reveal`) brings that file into view once the diff is here.
  const loaded = diff !== null;
  useEffect(() => {
    if (loaded && tab.params.path) reveal(tab.params.path);
  }, [loaded, tab.params.path, tab.reveal, reveal]);

  const files = diff?.files ?? [];
  // The files in the order they show: under their source for a chat in several (`head`: the first of its source).
  const shown = sources
    ? groupChanges(sources, files, (f) => f.path).flatMap((group) => group.items.map(({ item, path }, i) => ({ file: item, path, head: i === 0 ? group : null })))
    : files.map((file) => ({ file, path: file.path, head: null }));
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const allCollapsed = files.length > 0 && files.every(isCollapsed);
  let rowsBefore = 0;

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <SurfaceBar className="gap-2 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
          <ScopeMenu label={scope ? scopeLabel(scope) : "Changes"} value={scope?.to ?? ""} turns={checkpoints ? turnScopes(checkpoints) : []} onPick={pickScope} />
          {diff ? (
            <span className="min-w-0 truncate text-[12px] text-muted-foreground">
              {scope ? null : (
                <>
                  vs <span className="font-mono">{diff.from}</span>
                </>
              )}
              {files.length > 0 ? (
                <span className="tabular-nums">
                  {scope ? null : <span className="px-1.5 text-[hsl(var(--subtle-foreground))]">·</span>}
                  {files.length} {files.length === 1 ? "file" : "files"} <span className="ml-1 text-diff-add-ink">+{additions}</span> <span className="text-diff-del-ink">−{deletions}</span>
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {client
            ? tries.map((a) => {
                const running = runs.get(a.command)?.state === "running";
                return (
                  <BarButton
                    key={`${a.source}:${a.id}`}
                    label={running ? `${a.name}: running, click to restart it with the latest changes` : a.name}
                    // Its terminal opens beside: the build's progress, and stopping it there ends the run.
                    onClick={() => void runInTerminal(client, workspaceId, a.command).then(reloadRuns, () => undefined)}
                  >
                    <Icon icon={ACTION_ICONS.diff} />
                  </BarButton>
                );
              })
            : null}
          {/* While Cloud wakes the changes load by themselves: no Refresh that could only wait. */}
          {asleep ? null : (
            <BarButton label={error && diff ? `Couldn't refresh: ${error}` : "Refresh"} onClick={() => void load()}>
              <Icon icon={RefreshCwIcon} className={cn(loading && "animate-spin")} />
            </BarButton>
          )}
          {files.length > 0 ? (
            <>
              <BarButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={() => setWrap(!wrap)}>
                <Icon icon={TextWrapIcon} />
              </BarButton>
              <BarButton label={allCollapsed ? "Expand all files" : "Collapse all files"} onClick={() => setChosen(new Map(files.map((f) => [f.path, !allCollapsed])))}>
                {allCollapsed ? <Icon icon={UnfoldVerticalIcon} /> : <Icon icon={FoldVerticalIcon} />}
              </BarButton>
              <BarButton label={showList ? "Hide file list" : "Show file list"} pressed={showList} onClick={() => setShowList(!showList)}>
                <Icon icon={ListTreeIcon} />
              </BarButton>
            </>
          ) : null}
        </div>
      </SurfaceBar>

      {!diff ? (
        asleep && wait ? (
          <OpenWakeLine wait={wait} className="px-3" />
        ) : error ? (
          <SurfaceEmpty title="Couldn't load the changes" action={<QuietButton onClick={() => void load()}>Retry</QuietButton>}>
            {error}
          </SurfaceEmpty>
        ) : null
      ) : files.length === 0 ? (
        scope ? (
          <SurfaceEmpty
            title={`No changes in ${scope.latest ? "the latest turn" : `turn ${scope.turn}`}`}
            action={<QuietButton onClick={() => pickScope(undefined)}>Show all changes</QuietButton>}
          >
            Its files are the same before and after it.
          </SurfaceEmpty>
        ) : (
          <SurfaceEmpty icon={FileDiffIcon} title="No changes yet">Edits the agent makes show up here.</SurfaceEmpty>
        )
      ) : (
        // The changes arrive where the empty surface stood; a refresh of what is shown never replays it.
        <div className={cn("flex min-h-0 flex-1", arriveMotion)}>
          <div ref={scroller} data-diff-scroller className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
            {shown.map(({ file: f, path, head }) => {
              const collapsed = isCollapsed(f);
              // The first screenful (and a bit) renders at once; later files build their rows as they scroll near.
              const eager = rowsBefore < EAGER_ROWS;
              if (!collapsed) rowsBefore += patchLines(f);
              const row = <FileDiff key={f.path} file={f} {...(sources ? { shownPath: path } : {})} collapsed={collapsed} eager={eager} wrap={wrap} onToggle={setCollapsed} onOpen={open} onMenu={onFileMenu} review={review} />;
              return head ? (
                <Fragment key={f.path}>
                  <SourceHeading name={head.name} source={head.source} projectId={projectId} workspaceId={workspaceId} branch className="h-8 border-b border-foreground/[0.06] px-3" />
                  {row}
                </Fragment>
              ) : (
                row
              );
            })}
          </div>
          {showList ? (
            <aside aria-label="Changed files" className="w-[min(16rem,40%)] min-w-40 shrink-0 overflow-y-auto border-l border-foreground/[0.06] p-1">
              {shown.map(({ file: f, path, head }) => {
                const { dir, name } = splitPath(path);
                const s = STATUS[f.status];
                const row = (
                  <button
                    key={f.path}
                    type="button"
                    title={f.path}
                    aria-current={selected === f.path ? "true" : undefined}
                    onClick={() => reveal(f.path)}
                    onContextMenu={(e) => onFileMenu(f, e)}
                    className={cn(
                      "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-100",
                      "hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected === f.path && "bg-foreground/10",
                    )}
                  >
                    <FileTypeIcon path={f.path} className="size-[15px]" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-[12.5px] font-medium text-foreground/90">{name}</span>
                      {dir ? <span className="pl-1.5 text-[11px] text-[hsl(var(--subtle-foreground))]">{dir.slice(0, -1)}</span> : null}
                    </span>
                    <span className="flex shrink-0 gap-1 text-[11px] font-semibold tabular-nums">
                      {f.additions > 0 ? <span className="text-diff-add-ink">+{f.additions}</span> : null}
                      {f.deletions > 0 ? <span className="text-diff-del-ink">−{f.deletions}</span> : null}
                    </span>
                    <span aria-hidden className={cn("w-3 shrink-0 text-right font-mono text-[11px] font-semibold", s.tone)}>
                      {s.letter}
                    </span>
                    <span className="sr-only">{s.label}</span>
                  </button>
                );
                return head ? (
                  <Fragment key={f.path}>
                    <SourceHeading name={head.name} source={head.source} projectId={projectId} workspaceId={workspaceId} className="px-2 pb-1 pt-2" />
                    {row}
                  </Fragment>
                ) : (
                  row
                );
              })}
            </aside>
          ) : null}
        </div>
      )}
      {fileMenu}
      {comments.length > 0 ? (
        // The comments go to the chat's box as one message the person reads and sends.
        <div role="region" aria-label="Line comments" className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-card px-3 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {comments.length} {comments.length === 1 ? "comment" : "comments"} on the changes
          </span>
          <QuietButton onClick={() => setComments([])}>Clear</QuietButton>
          <button
            type="button"
            onClick={sendComments}
            className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Put in the chat's box
          </button>
        </div>
      ) : null}
    </div>
  );
});

/** Changes, the latest turn, or any finished turn this chat can diff (upstream scope menu). */
function ScopeMenu({ label, value, turns, onPick }: { label: string; value: string; turns: ReturnType<typeof turnScopes>; onPick: (turn: string | undefined) => void }) {
  if (turns.length === 0) return <span className="shrink-0 font-medium text-foreground">Changes</span>;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Changes: ${label}`}
        className="-ml-1.5 inline-flex h-7 shrink-0 items-center gap-1 self-center rounded-md px-1.5 font-medium text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(v || undefined)}>
          <DropdownMenuRadioItem value="">All changes</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {turns.map((t) => (
            <DropdownMenuRadioItem key={t.to} value={t.to}>
              {t.latest ? `Latest turn (turn ${t.turn})` : `Turn ${t.turn}`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
