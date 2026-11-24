// A file named in a chat or a document, ,
// apps/web/src/components/ChatMarkdown.tsx @ ab3a3cd1): a chip with the file's
// glyph and its name (and line); the full path on hover. A click opens it in the
// side panel's viewer at its line, ⌘-click (Ctrl elsewhere) in the user's
// editor, and the context menu offers both, Reveal in Finder and the paths to
// copy. A bare name (`retry.go:12`) is looked up first: a file this chat
// touched, else the shortest exact match the workspace search finds.

import { cn } from "@caveman-app/ui/lib/cn";
import { copyText } from "@caveman-app/ui/lib/copy-text";
import { inlineCodeClass, selectInlineCode } from "@caveman-app/ui/ai/response";
import { Icon, Folder01Icon } from "@caveman-app/ui/icons/huge";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { useOpenFile, useOpenSurface } from "../navigation.tsx";
import { openInEditor, preferredEditor, revealFile, useEditors } from "./editors.ts";
import { useFileMenu } from "./FileMenu.tsx";
import { fileIcon } from "./fileIcon.tsx";
import { codeRef, folderCandidate, touchedFile, type FileRef } from "./fileRefs.ts";
import { isDirectory, resolveReference } from "./workspaceRefs.ts";
import { absolutePath, baseName, nativePath } from "./tree.ts";
import { isAbsolutePath, outsideWorkspace } from "../../state/workspace-paths.ts";

/** What a file reference can do, in one workspace. */
export interface FileRefActions {
  readonly open: (target: FileRef) => void;
  /** In the preferred editor; null when this computer has none. Settles once the host opened it. */
  readonly edit: ((target: FileRef) => Promise<void>) | null;
  readonly editor: string | null;
  /** Select it in Finder (File Explorer, the file manager); null when this computer can't. */
  readonly reveal: ((target: FileRef) => Promise<void>) | null;
  readonly copy: (target: FileRef, full: boolean) => void;
  readonly canCopyFull: boolean;
  /** Outside the chat's folder: only its path to copy (the workspace calls refuse it). */
  readonly outside: (path: string) => boolean;
  /** The one file this chat touched that a bare name means (`pilot.md`), else null: such a name is a chip only then. */
  readonly touched: (name: string) => string | null;
}

/**
 * The actions for references in one workspace; `known` lists the files this chat touched (a bare name prefers those).
 * `root` is the folder paths read relative to; `own`, the one a full path is copied from: the chat's own folder, never
 * the checkout a moved chat had on this Mac (Transcript's formerRoot).
 */
export function useFileRefActions(workspaceId: string | null, root: string | null | undefined, known: () => ReadonlyArray<string> = () => [], own: string | null | undefined = root): FileRefActions | null {
  const openSurface = useOpenSurface();
  const openFile = useOpenFile();
  const { client } = useRuntimeClient();
  const editors = useEditors();
  const latest = useRef({ client, known });
  latest.current = { client, known };
  const editor = preferredEditor(editors);
  return useMemo(() => {
    if (!workspaceId) return null;
    const resolve = (t: FileRef) => (t.exact ? Promise.resolve(t) : resolveReference(latest.current.client, workspaceId, t, latest.current.known(), root));
    return {
      open: (t) => void resolve(t).then((r) => r.directory ? openSurface(workspaceId, "files", { path: r.path }) : openFile(workspaceId, r.path, r.line)),
      edit: editor ? (t) => resolve(t).then((r) => openInEditor(latest.current.client, workspaceId, r.path, { line: r.line, editor: editor.id })) : null,
      editor: editor?.label ?? null,
      reveal: editors.reveal ? (t) => resolve(t).then((r) => revealFile(latest.current.client, workspaceId, r.path)) : null,
      // Relative to the chat's folder (the only place a chip points), with the line the chip names (T3 #21497), in the computer's separators.
      copy: (t, full) => void resolve(t).then((r) => copyText(copiedPath(own, r, full))).catch(() => {}),
      canCopyFull: Boolean(own),
      outside: (path) => outsideWorkspace(path, root),
      touched: (name) => touchedFile(name, latest.current.known()),
    };
  }, [workspaceId, root, own, editor?.id, editor?.label, editors.reveal, openSurface, openFile]);
}

/** What a chip's Copy path (or Copy full path) puts on the clipboard: `src/a.ts:12`, `/repo/src/a.ts:12`, a folder without a line. */
export function copiedPath(root: string | null | undefined, target: FileRef, full: boolean): string {
  const line = target.line && !target.directory ? `:${target.line}` : "";
  // A host path (outside the chat's folder) is already whole.
  if (isAbsolutePath(target.path)) return target.path + line;
  return (full && root ? absolutePath(root, target.path) : nativePath(root, target.path)) + line;
}

/**
 * The actions chips use, provided where they render (the transcript, a document). Context, not a prop:
 * a chip inside an already-rendered markdown block still sees the editors once they are known.
 */
export const FileRefsContext = createContext<FileRefActions | null>(null);

/** ⌘-click on a Mac, Ctrl-click elsewhere: the editor, as in T3 and the terminal. */
export const editorClick = (e: MouseEvent) => (/Mac/i.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey);

export function FileChip({ text, target }: { text: string; target: FileRef }) {
  const actions = useContext(FileRefsContext);
  const Glyph = target.directory ? null : fileIcon(baseName(target.path));
  const { onContextMenu, menu } = useFileMenu(actions);
  if (!actions) return <code className="rounded-[4px] bg-foreground/[0.07] px-1 py-px font-mono text-[12.5px]" onDoubleClick={selectInlineCode}>{text}</code>;
  const label = `${baseName(target.path)}${target.directory ? "/" : target.line ? `:${target.line}` : ""}`;
  return (
    <>
      <button
        type="button"
        title={`${target.path}${target.line ? `:${target.line}` : ""}${actions.edit ? `\n${/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}-click: open in ${actions.editor}` : ""}`}
        data-markdown-copy={text}
        // The punctuation after it stays on its line (packages/ui chip-punctuation.ts looks for this).
        data-slot="file-chip"
        dir="ltr"
        onClick={(e) => (actions.edit && editorClick(e) ? void actions.edit(target).catch(() => {}) : actions.open(target))}
        onContextMenu={onContextMenu(target)}
        className={cn(
          "mx-px inline-flex max-w-full items-baseline gap-1 rounded-[0.45em] border px-[0.45em] align-baseline text-[0.88em] font-medium leading-[1.4] outline-none transition-colors duration-75",
          "border-[color-mix(in_oklab,hsl(var(--file-chip))_34%,hsl(var(--border)))] bg-[hsl(var(--file-chip)/0.11)] text-[color-mix(in_oklab,hsl(var(--file-chip))_24%,hsl(var(--foreground)))]",
          "hover:border-[color-mix(in_oklab,hsl(var(--file-chip))_50%,hsl(var(--border)))] hover:bg-[hsl(var(--file-chip)/0.18)] focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        )}
      >
        {Glyph ? <Glyph aria-hidden className="size-4 shrink-0 self-center" /> : <Icon icon={Folder01Icon} className="size-4 shrink-0 self-center" />}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {menu}
    </>
  );
}

/** Unambiguous files/folders render immediately; identifiers only become folders if the workspace says so. */
export function CodePath({ text, root, workspaceId }: { text: string; root: string | null | undefined; workspaceId: string | null }) {
  const { client } = useRuntimeClient();
  const actions = useContext(FileRefsContext);
 // A bare name (`pilot.md`) is a file only when it is one this chat touched (compact chips); else it may be code.
  const bare = codeRef(text, root) ? null : actions?.touched(text);
  const direct = codeRef(text, root) ?? (bare ? { path: bare } : null);
  const candidate = folderCandidate(text, root)?.path;
  const [directory, setDirectory] = useState<string | null>(null);
  useEffect(() => {
    setDirectory(null);
    if (direct?.directory || !candidate || !client || !workspaceId) return;
    let current = true;
    void isDirectory(client, workspaceId, candidate).then((yes) => current && yes && setDirectory(candidate));
    return () => { current = false; };
  }, [client, workspaceId, candidate, direct?.directory]);
  const target = candidate && directory === candidate ? { path: candidate, directory: true } : direct;
  return target ? <FileChip text={text} target={target} /> : <code className={inlineCodeClass} onDoubleClick={selectInlineCode}>{text}</code>;
}
