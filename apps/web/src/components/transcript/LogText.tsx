// A step's log as text that links what it names (log-links.ts). An address opens in the browser beside the chat,
// as the terminal's do (⌘-click, Ctrl elsewhere: the system browser). A file opens in the side panel, an HTML page
// in the browser preview (⌘-click: the editor), as the answer's file chips do.
import { useContext, useMemo, type MouseEvent } from "react";
import { editorClick, FileRefsContext } from "../../panels/files/FileChip.tsx";
import type { FileRef } from "../../panels/files/fileRefs.ts";
import { useOpenSurface } from "../../panels/navigation.tsx";
import { logLinks } from "./log-links.ts";
import { useChatWorkspace, useWorkspaceRoot } from "./root.ts";
import { inlineCodeClass, Response, selectInlineCode } from "@caveman-app/ui/ai/response";

const LINK = "underline decoration-current/35 underline-offset-2 transition-colors duration-75 hover:text-foreground hover:decoration-current";
const mod = () => (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl");

/** Thinking uses the same Markdown stream as an answer and the log's link destinations. */
export function LogMarkdown({ text, streaming, fresh }: { text: string; streaming: boolean; fresh: boolean }) {
  const openSurface = useOpenSurface();
  const root = useWorkspaceRoot();
  const workspaceId = useChatWorkspace();
  const files = useContext(FileRefsContext);
  return (
    <Response
      streaming={streaming}
      paced
      revealOnMount={fresh}
      className="text-[13px] leading-5 text-muted-foreground"
      inlineCode={(code) => <code className={inlineCodeClass} onDoubleClick={selectInlineCode}><LogText text={code} /></code>}
      onLink={(href, event) => {
        const target = logLinks(href, root).find((piece) => typeof piece !== "string");
        if (!target || typeof target === "string") return;
        if ("url" in target) {
          if (workspaceId && !editorClick(event)) {
            event.preventDefault();
            openSurface(workspaceId, "browser", { url: target.url });
          }
        } else if (files) {
          event.preventDefault();
          if (files.edit && editorClick(event)) files.edit(target.file);
          else files.open(target.file);
        }
      }}
    >{text}</Response>
  );
}

export function LogText({ text }: { text: string }) {
  const openSurface = useOpenSurface();
  const root = useWorkspaceRoot();
  const workspaceId = useChatWorkspace();
  const files = useContext(FileRefsContext);
  const pieces = useMemo(() => logLinks(text, root), [text, root]);
  const openFile = (e: MouseEvent, target: FileRef) => {
    e.preventDefault();
    if (files?.edit && editorClick(e)) files.edit(target);
    else files?.open(target);
  };
  return (
    <>
      {pieces.map((piece, i) => {
        if (typeof piece === "string") return piece;
        if ("url" in piece)
          return (
            // Pieces never reorder: the text is cut the same way every time.
            // oxlint-disable-next-line react/no-array-index-key
            <a
              key={i}
              href={piece.url}
              target="_blank"
              rel="noreferrer"
              title={`${piece.url}\n${mod()}-click: open in your browser`}
              className={LINK}
              onClick={(e) => {
                if (!workspaceId || editorClick(e)) return;
                e.preventDefault();
                openSurface(workspaceId, "browser", { url: piece.url });
              }}
            >
              {piece.text}
            </a>
          );
        if (!files) return piece.text;
        const target = piece.file;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- pieces never reorder: the text is cut the same way every time.
          <a
            key={i}
            href={piece.text}
            title={`${target.path}${target.line ? `:${target.line}` : ""}${files.edit ? `\n${mod()}-click: open in ${files.editor}` : ""}`}
            className={LINK}
            onClick={(e) => openFile(e, target)}
            // A middle click would open the app itself at the path: the path is not a page.
            onAuxClick={(e) => e.preventDefault()}
          >
            {piece.text}
          </a>
        );
      })}
    </>
  );
}
