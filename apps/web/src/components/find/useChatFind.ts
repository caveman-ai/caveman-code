// A chat's find state (⌘F): the bar, its matches over the chat's messages, the row of the current match mounted and
// scrolled to, and the mounted matches painted (CSS Custom Highlight API; styles.css ::highlight(chat-find*)).

import { createContext, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import { chord } from "../../state/keybindings.ts";
import { matchesChord } from "../../panels/chrome.tsx";
import { ownsFocus } from "../../panes/focus.ts";
import { scrollParent } from "../message-rail/MessageRail.tsx";
import { rows, type Row } from "../transcript/rows.ts";
import { findHits, shownText, stepHit, textRanges, type FindHit } from "./chat-find.ts";
import { onJump, takeJump } from "./jump.ts";

/** Whether `row` is, or folds away, the item `id` (a message, an answer, or a tool call in a work run). */
export function rowHolds(row: Row, id: string): boolean {
  if (row.kind === "item") return row.item.id === id;
  if (row.kind === "work" || row.kind === "agents") return row.items.some((i) => i.id === id);
  return row.rows.some((r) => rowHolds(r, id));
}

/** What a chat's find looks for, so a folded long message opens when it holds a match. */
export const FindQuery = createContext("");
/** The item holding the current match, so the "Worked for" fold around it opens. */
export const FindCurrent = createContext<string | null>(null);

/**
 * The rows the find reads: the person's messages, the answers, and what each tool call worked on (a path, a command,
 * a query), the ones a finished turn's "Worked for" folds away included: stepping to one opens what hides it.
 * Thoughts and tool output are not read.
 */
export function findable(items: ReadonlyArray<TranscriptItem>): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const read = (list: ReadonlyArray<Row>) => {
    for (const r of list) {
      if (r.kind === "fold") read(r.rows);
      else if (r.kind === "work") for (const t of r.items) t.kind === "tool" && t.subject && out.push({ id: t.id, text: t.subject });
      else if (r.kind === "agents") continue;
      else if (r.item.kind === "user" || r.item.kind === "assistant") out.push({ id: r.item.id, text: r.item.kind === "user" ? (r.item.generated?.line ?? r.item.text) : shownText(r.item.text) });
    }
  };
  read(rows(items));
  return out;
}

const ALL = "chat-find";
const CURRENT = "chat-find-current";
/** How long a jump to a match keeps it in view while the rows around it lay out. */
const SETTLE_MS = 600;
/** One chat paints at a time (the highlight registry is the page's): the last one opened. */
let painter: symbol | null = null;

export interface ChatFind {
  readonly open: boolean;
  readonly query: string;
  readonly index: number;
  readonly total: number;
  readonly focusKey: number;
  /** The item holding the current match. */
  readonly current: string | null;
  readonly setQuery: (query: string) => void;
  readonly step: (delta: 1 | -1) => void;
  readonly close: () => void;
}

export function useChatFind({
  box,
  items,
  reveal,
  enabled,
  sessionId,
}: {
  box: RefObject<HTMLElement | null>;
  items: ReadonlyArray<TranscriptItem>;
  reveal: RefObject<((id: string) => void) | null>;
  enabled: boolean;
  /** The chat's session, for the jumps ⌘K asks for (jump.ts). */
  sessionId?: string | undefined;
}): ChatFind {
  const [state, setState] = useState<{ query: string; index: number; focusKey: number } | null>(null);
  const me = useRef(Symbol("chat-find"));
  const open = state !== null;
  const query = state?.query ?? "";
  const messages = useMemo(() => (open ? findable(items) : []), [open, items]);
  const hits = useMemo(() => findHits(messages, query), [messages, query]);
  const index = Math.min(state?.index ?? 0, Math.max(0, hits.length - 1));
  const current: FindHit | null = hits[index] ?? null;

  // ⌘F opens the bar (or selects its text again) in the chat whose pane has the keys; never from the side panel,
  // which holds its own surfaces (a file, a terminal).
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !matchesChord(e, chord("app.findInChat"))) return;
      const el = box.current;
      if (!el || el.closest("[data-side-panel]") || !ownsFocus(el)) return;
      if ((e.target as Element | null)?.closest?.("[data-side-panel], [role=dialog]")) return;
      e.preventDefault();
      painter = me.current;
      const picked = window.getSelection()?.toString().trim() ?? "";
      setState((s) => ({ query: picked && !picked.includes("\n") && picked.length <= 120 ? picked : (s?.query ?? ""), index: 0, focusKey: (s?.focusKey ?? 0) + 1 }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, box]);

  // ⌘K opened this chat at a place: the bar shows the words that matched there, on that match. With no words to
  // find (a match by meaning), the item's row is mounted and brought into view.
  const [jumps, setJumps] = useState(0);
  useEffect(() => (sessionId ? onJump(sessionId, () => setJumps((n) => n + 1)) : undefined), [sessionId]);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    // Read only for a jump that is waiting: this runs on every change to the chat (each streamed token), and reading
    // walks every answer's markdown.
    let found: ReturnType<typeof findable> | null = null;
    const read = () => {
      if (found === null) found = findable(items);
      return found;
    };
    const jump = takeJump(sessionId, (item) => read().some((m) => m.id === item) || items.some((i) => i.id === item));
    if (!jump) return;
    const readable = read();
    painter = me.current;
    // On that item's match; a command or a plan holds no message, so the words' first match in the chat.
    const hits = jump.query ? findHits(readable, jump.query) : [];
    if (hits.length > 0) {
      const at = hits.findIndex((h) => h.id === jump.item);
      setState((s) => ({ query: jump.query, index: Math.max(0, at), focusKey: (s?.focusKey ?? 0) + 1 }));
      return;
    }
    reveal.current?.(jump.item);
    let frames = 0;
    const find = () => {
      const row = box.current?.querySelector(`[data-find-id="${CSS.escape(jump.item)}"]`);
      if (row) row.scrollIntoView({ block: "center" });
      else if (++frames < 30) requestAnimationFrame(find);
    };
    requestAnimationFrame(find);
  }, [enabled, sessionId, items, jumps, reveal, box]);

  // The current match's row is mounted (the transcript window may not hold it yet), then painted and scrolled to.
  useEffect(() => {
    if (current) reveal.current?.(current.id);
  }, [current, reveal]);

  const scrolled = useRef({ key: "", until: 0 });
  useEffect(() => {
    const el = box.current;
    if (!open || !el || typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (painter !== me.current) return;
      const all = new Highlight();
      let active: Range | null = null;
      if (query.trim()) {
        for (const scope of el.querySelectorAll<HTMLElement>("[data-find-id]")) {
          const ranges = textRanges(scope, query);
          for (const r of ranges) all.add(r);
          if (current && scope.dataset.findId === current.id) active = ranges[Math.min(current.occurrence, ranges.length - 1)] ?? null;
        }
      }
      if (active) all.delete(active);
      CSS.highlights.set(ALL, all);
      CSS.highlights.set(CURRENT, active ? new Highlight(active) : new Highlight());
      // Scroll to a new match, and again while the rows around it settle (a row mounted by the jump lays out after
      // it); streaming text later repaints without moving the reader.
      const key = current ? `${query}\0${current.id}\0${current.occurrence}` : "";
      if (key !== scrolled.current.key) scrolled.current = { key, until: performance.now() + SETTLE_MS };
      if (active && performance.now() < scrolled.current.until) {
        const parent = scrollParent(el);
        if (parent) {
          const r = active.getBoundingClientRect();
          const p = parent.getBoundingClientRect();
          if (r.top < p.top + 48 || r.bottom > p.bottom - 96) parent.scrollTop += r.top - p.top - p.height / 2;
        }
        settle = setTimeout(schedule, 50);
      }
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    schedule();
    // Rows mount as the window grows, and answers stream in: repaint after each change.
    const observer = new MutationObserver(schedule);
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [open, query, current, box]);

  // Closed or gone: nothing stays painted.
  useEffect(() => {
    if (open) return;
    if (painter === me.current && typeof CSS !== "undefined" && "highlights" in CSS) {
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CURRENT);
    }
  }, [open]);
  useEffect(
    () => () => {
      if (painter === me.current && typeof CSS !== "undefined" && "highlights" in CSS) {
        CSS.highlights.delete(ALL);
        CSS.highlights.delete(CURRENT);
        painter = null;
      }
    },
    [],
  );

  const total = hits.length;
  const setQuery = useCallback((q: string) => setState((s) => (s ? { ...s, query: q, index: 0 } : s)), []);
  const step = useCallback((delta: 1 | -1) => setState((s) => (s ? { ...s, index: stepHit(Math.min(s.index, total - 1), total, delta) } : s)), [total]);
  const close = useCallback(() => {
    const pane = box.current?.closest("[data-pane]");
    setState(null);
    scrolled.current = { key: "", until: 0 };
    pane?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [box]);
  return { open, query, index, total, focusKey: state?.focusKey ?? 0, current: current?.id ?? null, setQuery, step, close };
}
