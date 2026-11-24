// Select words in an answer and a small menu opens over them, using compact styling
//: quote them in the chat's
// box, to ask about or push back on (upstream AssistantSelectionToolbar; Zed's quote selection), save them as a note
// on the Chief's Queue, or copy them. Frosted glass over the first selected line, grown out of it; nothing is sent.

import { Icon, BubbleChatAddIcon, Copy01Icon, NoteAddIcon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";

/** The composer of `workspaceId` takes the text as a quote (Composer.tsx listens). */
export const QUOTE_EVENT = "caveman:quote";
export type QuoteDetail = { readonly workspaceId: string; readonly text: string };

/** The quote as it goes in the box: each line behind "> ", then a blank line to write under. */
export function quoteBlock(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  return `${lines.map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">")).join("\n")}\n\n`;
}

/** Where the quote goes in what is already typed: at the caret when the box has it, else at the end on its own lines. */
export function placeQuote(value: string, caret: number | null, quote: string): { at: number; insert: string } {
  const at = caret ?? value.length;
  const before = value.slice(0, at);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  return { at, insert: lead + quote };
}

/** The menu's width, for keeping it on screen before it has laid out. */
const MENU_W = 176;
/** Room the menu needs above the line; with less, it opens under the selection instead. */
const MENU_ROOM = 120;

type At = { readonly x: number; readonly top: number; readonly bottom: number; readonly text: string };

export function QuoteSelection({ box, workspaceId }: { box: RefObject<HTMLElement | null>; workspaceId: string }) {
  const [at, setAt] = useState<At | null>(null);
  const [done, setDone] = useState<"note" | "copy" | null>(null);
  const [failed, setFailed] = useState(false);
  const { client } = useRuntimeClient();
  const held = useRef(false);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      if (held.current) return;
      const sel = document.getSelection();
      const el = box.current;
      if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return setAt(null);
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const scope = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("[data-find-id]");
      // An answer's words only (not the person's own message, not across two rows).
      if (!scope || !el.contains(scope) || scope.closest('[data-from="user"]')) return setAt(null);
      const text = sel.toString().trim();
      if (!text) return setAt(null);
 // Over the first line it covers, centred on that line (compact anchors to the first non-empty client rect).
      const first = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0) ?? range.getBoundingClientRect();
      const x = Math.min(Math.max(first.left + first.width / 2, MENU_W / 2 + 8), window.innerWidth - MENU_W / 2 - 8);
      setAt({ x, top: first.top, bottom: range.getBoundingClientRect().bottom, text });
      setDone(null);
      setFailed(false);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const hide = () => {
      if (!held.current) setAt(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !document.getSelection()?.toString()) return;
      document.getSelection()?.removeAllRanges();
      setAt(null);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [box]);
  if (!at) return null;
  const below = at.top < MENU_ROOM;
  // A confirmation stays a beat, the selection kept, then the menu goes.
  const settle = (what: "note" | "copy") => {
    held.current = true;
    setDone(what);
    setTimeout(() => {
      held.current = false;
      document.getSelection()?.removeAllRanges();
      setAt(null);
      setDone(null);
    }, 900);
  };
  const quote = () => {
    window.dispatchEvent(new CustomEvent<QuoteDetail>(QUOTE_EVENT, { detail: { workspaceId, text: at.text } }));
    document.getSelection()?.removeAllRanges();
    setAt(null);
  };
  const note = () => {
    if (!client) return setFailed(true);
    client.call("chief.capture", { request_id: requestId(), text: at.text, source: "capture", mode: "queue" }).then(
      () => settle("note"),
      () => setFailed(true),
    );
  };
  const copy = () => {
    navigator.clipboard?.writeText(at.text).then(
      () => settle("copy"),
      () => setFailed(true),
    );
  };
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selected text actions"
      data-side={below ? "bottom" : "top"}
      // Keep the selection: a mousedown here would clear it before the click.
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: at.x - MENU_W / 2, width: MENU_W, ...(below ? { top: at.bottom + 6 } : { bottom: window.innerHeight - at.top + 6 }) }}
      className="selection-menu fixed z-50 flex flex-col gap-0.5 overflow-hidden glass rounded-xl p-1"
    >
      <MenuButton icon={BubbleChatAddIcon} onClick={quote}>
        Quote in chat
      </MenuButton>
      <MenuButton icon={done === "note" ? Tick02Icon : NoteAddIcon} onClick={note} done={done === "note"}>
        {done === "note" ? "Saved to the Queue" : "Save as a note"}
      </MenuButton>
      <MenuButton icon={done === "copy" ? Tick02Icon : Copy01Icon} onClick={copy} done={done === "copy"}>
        {done === "copy" ? "Copied" : "Copy"}
      </MenuButton>
      {failed ? <p className="px-2.5 pb-1 pt-0.5 text-[11.5px] leading-4 text-diff-del-ink">That didn't work. Try again.</p> : null}
      <span aria-live="polite" className="sr-only">
        {done === "note" ? "Saved to the Queue" : done === "copy" ? "Copied" : ""}
      </span>
    </div>,
    document.body,
  );
}

function MenuButton({ icon, done = false, onClick, children }: { icon: Parameters<typeof Icon>[0]["icon"]; done?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-left text-[13px] leading-none text-foreground outline-none transition-colors duration-100 hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        done && "text-diff-add-ink",
      )}
    >
      <Icon icon={icon} className={done ? undefined : "text-foreground/60"} />
      {children}
    </button>
  );
}
