// What a finished turn changed, using compact styling, upstream
// src/features/sessions/ui/SessionReview.tsx): "Changed 3 files" with the lines added and removed, Undo, Keep and
// Review, then each file with its counts. Only the latest settled turn has the card (Transcript decides); Keep closes
// it, Undo puts the files back (checkpoint.undo, which refuses when a file changed again since), Review and a file's
// row open the turn's diff. Files no checkpoint saw (outside the chat's folder, an engine without checkpoints) get
// the same card from the turn's own edits, without Undo and Keep; a row opens that edit. Under every finished turn,
// the footer: copy, fork, restore, the turn's changes, its time. A chat in several sources lists its files under
// their source (its name, branch and pull request), each path inside its source.
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { ArrowDown01Icon, ArrowRight01Icon, ArrowTurnBackwardIcon, Copy01Icon, FileDiffIcon, GitForkIcon, Icon, Tick02Icon, Undo02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useContext, useEffect, useState } from "react";
import { BarButton } from "../../panels/chrome.tsx";
import { FileRefsContext } from "../../panels/files/FileChip.tsx";
import { useFileMenu } from "../../panels/files/FileMenu.tsx";
import { isAbsolutePath } from "../../state/workspace-paths.ts";
import { groupChanges, type ChatSources } from "../../state/sources.ts";
import { SourceHeading } from "../sources/parts.tsx";

/** Files shown before "Show N more files" (compact three). */
const SHOWN = 3;

/** A file the card lists: a checkpoint's TurnFile, or an edit whose engine didn't count its lines (null). */
export interface ChangedFile {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

const counted = (f: ChangedFile) => f.additions !== null || f.deletions !== null;

/** The lines the counted files added and removed; null when none was counted. */
const sum = (files: ReadonlyArray<ChangedFile>) =>
  files.some(counted) ? files.reduce((t, f) => ({ additions: t.additions + (f.additions ?? 0), deletions: t.deletions + (f.deletions ?? 0) }), { additions: 0, deletions: 0 }) : null;

/** A row's path: an absolute one (outside the chat's folder) keeps its last three names, so the file's own name shows. */
const shown = (path: string) => {
  const names = path.split(/[\\/]/).filter(Boolean);
  return isAbsolutePath(path) && names.length > 3 ? `…/${names.slice(-3).join("/")}` : path;
};

/**
 * Lines added and removed in the diff inks (globals.css --diff-*: compact emerald and rose), a true minus. A zero
 * says nothing: "+5", as the diff's own headers count it, not "+5 −0". In a list (`column`) each count keeps its own
 * slot, so a "+5" never sits where the row below has its "−1".
 */
function Counts({ additions, deletions, column, className }: { additions: number; deletions: number; column?: boolean; className?: string }) {
  const slot = column ? "min-w-[4ch] text-right" : undefined;
  const add = additions > 0 || deletions === 0 ? `+${additions.toLocaleString()}` : null;
  const del = deletions > 0 ? `−${deletions.toLocaleString()}` : null;
  return (
    <span className={cn("flex shrink-0 gap-1.5 text-[11px] font-semibold tabular-nums", className)}>
      {add || column ? <span className={cn("text-diff-add-ink", slot)}>{add}</span> : null}
      {del || column ? <span className={cn("text-diff-del-ink", slot)}>{del}</span> : null}
    </span>
  );
}

/** The card's buttons: quiet text that washes in on hover; Review alone sits on a wash. */
const button = "h-7 rounded-md px-2.5 text-[11px] outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35";
const quiet = cn(button, "text-[hsl(var(--subtle-foreground))] hover:bg-foreground/[0.08]");

export function TurnChanges({
  files,
  total,
  enter = false,
  leaving = false,
  onGone,
  onKeep,
  onUndo,
  onReview,
  sources = null,
  projectId = null,
  workspaceId = null,
}: {
  readonly files: ReadonlyArray<ChangedFile>;
  /** A chat in several sources: its files go under a heading per source. Null: a chat in one, listed as they are. */
  readonly sources?: ChatSources | null;
  /** For a source's pull request: the project it is read through, and the chat whose side panel it opens in. */
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  /**
   * Every file the turn changed, when `files` is only the first 200 (checkpoint.created files_total): the card counts
   * them all and says how many more the list leaves out.
   */
  readonly total?: { readonly count: number; readonly additions: number; readonly deletions: number } | undefined;
  /** Arriving while the reader watches: its height opens in, so what's under it glides down (styles.css .turn-changes-open). */
  readonly enter?: boolean;
  /** Taken away without a Keep or an Undo (a new turn started): it folds shut, then `onGone` lets it unmount. */
  readonly leaving?: boolean;
  readonly onGone?: () => void;
  /**
   * checkpoint.keep / checkpoint.undo: they reject with the runtime's reason, which the card then shows. Without them
   * (no checkpoint saw these files) the card has neither button.
   */
  readonly onKeep?: (() => Promise<unknown>) | undefined;
  readonly onUndo?: (() => Promise<unknown>) | undefined;
  /** The turn's diff, at a file when given; null when the Changes tab can't show this turn on its own. */
  readonly onReview: ((path?: string) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  // A row, right-clicked: the file's menu (open it, in the editor, Reveal in Finder, its path).
  const { onContextMenu, menu } = useFileMenu(useContext(FileRefsContext));
  // The open-in plays once: its class goes when it ends, or the chat shown again (display: none restarts a CSS
  // animation) would open the card in a second time and push the chat down by its height.
  const [entering, setEntering] = useState(enter);
  const [acting, setActing] = useState<"keep" | "undo" | null>(null);
  // Which action the runtime refused: a refused Undo stays off (it would refuse again), a refused Keep leaves Undo be.
  const [refused, setRefused] = useState<{ readonly action: "keep" | "undo"; readonly reason: string } | null>(null);
  const undoRefused = refused?.action === "undo" ? refused.reason : null;
  // Keep folds the card shut first, then tells the runtime: what's under it glides up rather than jumping.
  const [closing, setClosing] = useState(false);
  const totals = total ? { additions: total.additions, deletions: total.deletions } : sum(files);
  const count = total?.count ?? files.length;
  // The files in the order they show: under their source for a chat in several (`head`: the first of its source).
  const ordered = sources
    ? groupChanges(sources, files, (f) => f.path).flatMap((group) => group.items.map(({ item, path }, i) => ({ file: item, path, head: i === 0 ? group : null })))
    : files.map((file) => ({ file, path: file.path, head: null }));
  const listed = open ? ordered : ordered.slice(0, SHOWN);
  const more = files.length - SHOWN;
  // Files past the list's end (a capped one): said once the whole list shows; Review has them all.
  const unlisted = count - files.length;
  const run = (action: "keep" | "undo") => {
    setActing(action);
    setRefused(null);
    (action === "keep" ? onKeep!() : onUndo!()).then(
      // The card closes when checkpoint.resolved lands; until then the buttons stay held.
      () => undefined,
      (error: unknown) => {
        setActing(null);
        setClosing(false);
        setRefused({ action, reason: reasonOf(error) });
      },
    );
  };
  const keep = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return run("keep");
    setActing("keep");
    setClosing(true);
  };
  return (
    <div
      className={cn(closing || leaving ? "turn-changes-close" : entering && "turn-changes-open")}
      {...(leaving ? { inert: true, "aria-hidden": true } : {})}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (leaving) onGone?.();
        else if (closing) run("keep");
        else setEntering(false);
      }}
    >
    {/* The gap above the card sits inside the clipped row: folded shut, the card takes no height at all, so taking it
        away after it folds moves nothing (a padding here stayed 8px tall and dropped the chat by 8px as it went). */}
    <div className="min-h-0 overflow-hidden">
    <div className="pt-2">
    <div data-turn-changes className="overflow-hidden rounded-xl border border-foreground/[0.06] bg-foreground/[0.03]">
      <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.08] text-foreground/55">
          <Icon icon={FileDiffIcon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground/80" title="What this turn changed">
            Changed {count.toLocaleString()} {count === 1 ? "file" : "files"}
          </div>
          {totals ? <Counts {...totals} className="-mt-0.5" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {onUndo ? (
            <button
              type="button"
              className={quiet}
              disabled={acting !== null || undoRefused !== null}
              title={undoRefused ?? "Put these files back as they were before this turn"}
              onClick={() => run("undo")}
            >
              {acting === "undo" ? "Undoing…" : "Undo"}
            </button>
          ) : null}
          {onKeep ? (
            <button type="button" className={quiet} disabled={acting !== null} title="Keep the changes and close this card" onClick={keep}>
              Keep
            </button>
          ) : null}
          {onReview ? (
            <button type="button" className={cn(button, "bg-foreground/[0.08] font-medium text-foreground/75 hover:bg-foreground/[0.12]")} onClick={() => onReview()}>
              Review
            </button>
          ) : null}
        </div>
      </div>
      {refused ? (
        <p role="alert" className="-mt-1 px-3 pb-2.5 text-[11px] leading-4 text-diff-del-ink">
          {refused.reason}
        </p>
      ) : null}
      <ul className={cn("border-t border-foreground/[0.05] py-1", open && "max-h-64 overflow-y-auto")}>
        {listed.map(({ file: f, path, head }) => (
          <li key={f.path}>
            {head ? <SourceHeading name={head.name} source={head.source} projectId={projectId} workspaceId={workspaceId} className="h-7 px-3" /> : null}
            {/* The menu on a wrapper, not the button: a row that opens nothing (a disabled button gets no events) still offers the file's. */}
            <div onContextMenu={onContextMenu({ path: f.path, exact: true })}>
              <button
                type="button"
                title={f.path}
                disabled={!onReview}
                onClick={() => onReview?.(f.path)}
                className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-foreground/65 outline-none transition-colors duration-75 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:bg-foreground/[0.05] disabled:pointer-events-none"
              >
                <FileTypeIcon path={f.path} className="size-[15px]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{shown(path)}</span>
                {counted(f) ? <Counts additions={f.additions ?? 0} deletions={f.deletions ?? 0} column className="gap-2" /> : null}
              </button>
            </div>
          </li>
        ))}
        {unlisted > 0 && (open || more <= 0) ? (
          <li className="flex h-8 items-center px-3 text-[11px] text-[hsl(var(--subtle-foreground))]">
            {unlisted.toLocaleString()} more {unlisted === 1 ? "file" : "files"} not listed{onReview ? ": Review shows them all" : ""}
          </li>
        ) : null}
      </ul>
      {menu}
      {more > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 w-full items-center gap-1.5 border-t border-foreground/[0.05] px-3 text-left text-[11px] text-[hsl(var(--subtle-foreground))] outline-none transition-colors duration-75 hover:bg-foreground/[0.05] hover:text-foreground/70 focus-visible:bg-foreground/[0.05]"
        >
          <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3.5" />
          {open ? "Show fewer files" : `Show ${more.toLocaleString()} more ${more === 1 ? "file" : "files"}`}
        </button>
      ) : null}
    </div>
    </div>
    </div>
    </div>
  );
}

/** The runtime's reason for a refused call (RpcError message), else a plain line. */
function reasonOf(error: unknown): string {
  const message = (error as { error?: { message?: unknown } })?.error?.message ?? (error instanceof Error ? error.message : null);
  if (typeof message !== "string" || !message) return "That didn't work. Try again, or review the changes.";
  return message.charAt(0).toUpperCase() + message.slice(1).replace(/([^.])$/, "$1.");
}

/** "Undid the changes to 3 files": where an undone turn's card was, so the answer above it isn't taken for what's on disk. */
export function UndoneLine({ count }: { count: number }) {
  return (
    <div className="mt-2 flex h-7 items-center gap-1.5 text-[12px] text-[hsl(var(--subtle-foreground))]">
      <Icon icon={Undo02Icon} className="size-3.5" />
      Undid the changes to {count} {count === 1 ? "file" : "files"}
    </div>
  );
}

const time = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Under a finished turn (compact turn actions): copy its answer, start a new chat from it, take files and
 * transcript back to it, open its changes when no card shows them, and when it ended.
 */
export function TurnFooter({
  answer,
  at,
  onFork,
  onRestore,
  onChanges,
}: {
  readonly answer: string | undefined;
  readonly at: string;
  readonly onFork: (() => void) | null;
  readonly onRestore: (() => void) | null;
  /** The turn's diff, when it changed files and no card is showing them. */
  readonly onChanges: (() => void) | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
 // Quiet until hovered (compact turn actions): 40% ink, a wash and 70% under the pointer.
  const icon = "size-auto p-[5px] text-[hsl(var(--subtle-foreground))] hover:bg-foreground/[0.08] hover:text-foreground/70 [&_svg]:size-3.5";
  return (
    <div data-turn-actions className="mt-1 flex h-7 min-w-0 items-center gap-2.5 text-[14px] text-[hsl(var(--subtle-foreground))]">
      <span className="flex shrink-0 items-center gap-1">
        {answer ? (
          <BarButton size="sm" className={icon} label={copied ? "Copied" : "Copy answer"} onClick={() => void navigator.clipboard.writeText(answer).then(() => setCopied(true), () => undefined)}>
            <Icon icon={copied ? Tick02Icon : Copy01Icon} />
          </BarButton>
        ) : null}
        {onChanges ? (
          <BarButton size="sm" className={icon} label="This turn's changes" onClick={onChanges}>
            <Icon icon={FileDiffIcon} />
          </BarButton>
        ) : null}
        {onFork ? (
          <BarButton size="sm" className={icon} label="Fork from here" onClick={onFork}>
            <Icon icon={GitForkIcon} />
          </BarButton>
        ) : null}
        {onRestore ? (
          <BarButton size="sm" className={icon} label="Restore to here" onClick={onRestore}>
            <Icon icon={ArrowTurnBackwardIcon} />
          </BarButton>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2.5">
        <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-foreground/25" />
        <time dateTime={at} title={new Date(at).toLocaleString()} className="tabular-nums text-[hsl(var(--subtle-foreground))]">
          {time(at)}
        </time>
      </span>
    </div>
  );
}
