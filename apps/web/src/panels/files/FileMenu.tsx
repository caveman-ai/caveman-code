// One menu for every place a file shows (a chip in the chat, a changed file, a diff's header, a file's tab):
// Open, Open in the user's editor, Reveal in Finder (File Explorer on Windows), and the paths to copy. Right-click
// opens it (or the keyboard's menu key, under the row). Opening in the editor and revealing wait for the host: a
// failure stays in the menu, where it can be tried again. And the one-click Reveal for a surface's bar.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Icon, FolderOpenIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { isHtmlFile } from "../browser/htmlFile.ts";
import { outsideWorkspace } from "../../state/workspace-paths.ts";
import { BarButton } from "../chrome.tsx";
import { usePanelWorkspace } from "../workspace.ts";
import type { FileRefActions } from "./FileChip.tsx";
import type { FileRef } from "./fileRefs.ts";
import { revealFile, revealLabel, useEditors } from "./editors.ts";

export interface FileMenuOptions {
  /** Offer Open (the side panel's viewer); off where the file already shows, its own tab. */
  readonly open?: boolean;
  /** The file is gone (a deleted file's diff): only its path to copy. */
  readonly missing?: boolean;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The menu's rows, for a menu of its own (`useFileMenu`) or to lead another (a tab's). `onDone` closes the menu. */
export function FileMenuItems({
  actions,
  target,
  onDone,
  open = true,
  missing = false,
}: { actions: FileRefActions; target: FileRef; onDone: () => void } & FileMenuOptions) {
  const [error, setError] = useState<string | null>(null);
  // A new file, not a new object for the same one (a parent's render), starts clean.
  useEffect(() => setError(null), [target.path, target.line]);
  const wait = (run: (t: FileRef) => Promise<void>, failed: string) => (e: Event) => {
    e.preventDefault();
    setError(null);
    run(target).then(onDone, (cause: unknown) => setError(`${failed} ${message(cause)}`));
  };
  // Gone, or outside the chat's folder: nothing to open or reveal, only the path.
  const there = !missing && !actions.outside(target.path);
  const lead = (there && open) || (there && actions.edit) || (there && actions.reveal);
  return (
    <>
      {there && open ? (
        <DropdownMenuItem onSelect={() => actions.open(target)}>
          {isHtmlFile(target.path) && !target.line ? "Open in browser" : "Open"}
        </DropdownMenuItem>
      ) : null}
      {there && actions.edit ? (
        <DropdownMenuItem onSelect={wait(actions.edit, "Couldn't open it.")}>
          Open in {actions.editor}
        </DropdownMenuItem>
      ) : null}
      {there && actions.reveal ? (
        <DropdownMenuItem onSelect={wait(actions.reveal, "Couldn't reveal it.")}>
          {revealLabel()}
        </DropdownMenuItem>
      ) : null}
      {error ? (
        <p role="alert" className="max-w-64 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {lead ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={() => actions.copy(target, false)}>Copy path</DropdownMenuItem>
      {actions.canCopyFull ? (
        <DropdownMenuItem onSelect={() => actions.copy(target, true)}>
          Copy full path
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** Where a context-menu event opens a menu: at the pointer, or under the element for the menu key (Shift+F10), which reports none. */
export function menuPoint(e: MouseEvent): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

/**
 * Right-click for files: `onContextMenu(target)` goes on whatever names one, `menu` is rendered once beside them.
 * Without actions (no workspace) the browser's own menu stays.
 */
export function useFileMenu(actions: FileRefActions | null): {
  onContextMenu: (target: FileRef, options?: FileMenuOptions) => (e: MouseEvent) => void;
  menu: ReactNode;
} {
  const [at, setAt] = useState<{
    x: number;
    y: number;
    target: FileRef;
    options: FileMenuOptions;
  } | null>(null);
  const onContextMenu =
    (target: FileRef, options: FileMenuOptions = {}) =>
    (e: MouseEvent) => {
      if (!actions) return;
      e.preventDefault();
      e.stopPropagation();
      setAt({ ...menuPoint(e), target, options });
    };
  const menu = actions ? (
    <DropdownMenu open={at !== null} onOpenChange={(o) => !o && setAt(null)} modal={false}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={at ? { left: at.x, top: at.y } : { left: -9999, top: -9999 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} className="min-w-[200px]">
        {at ? (
          <FileMenuItems
            actions={actions}
            target={at.target}
            onDone={() => setAt(null)}
            {...at.options}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  return { onContextMenu, menu };
}

/** One-click Reveal in Finder for a workspace path: null where the computer can't or it is outside the chat's folder; a failure names itself for 4 s. */
export function useReveal(
  workspaceId: string,
  path: string,
): { label: string; failed: boolean; run: () => void } | null {
  const editors = useEditors();
  const root = usePanelWorkspace()?.root_path;
  const { client } = useRuntimeClient();
  const [error, setError] = useState<string | null>(null);
  // Another file's button starts clean: a failure belongs to the file it was for.
  useEffect(() => setError(null), [path]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);
  if (!editors.reveal || outsideWorkspace(path, root)) return null;
  return {
    label: error ? `Couldn't reveal it. ${error}` : revealLabel(),
    failed: error !== null,
    run: () => {
      setError(null);
      revealFile(client, workspaceId, path).catch((cause: unknown) => setError(message(cause)));
    },
  };
}

/** A bar's Reveal in Finder for one workspace path (a file selected, a folder shown); nothing where the computer can't. */
export function RevealButton({
  workspaceId,
  path,
  size = "md",
  className,
}: {
  workspaceId: string;
  path: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const reveal = useReveal(workspaceId, path);
  if (!reveal) return null;
  return (
    <BarButton size={size} className={className} label={reveal.label} onClick={reveal.run}>
      <Icon icon={FolderOpenIcon} className={reveal.failed ? "text-destructive" : undefined} />
    </BarButton>
  );
}
