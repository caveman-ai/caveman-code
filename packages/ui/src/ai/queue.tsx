// AI Elements Queue (shadcn ai-elements, MIT), laid out like upstream QueuedRunsControl (MIT): the inputs waiting
// behind the running turn, as rows of the tray on the composer's top edge (the same tray as "Waiting on"; the
// composer draws its border). A header row ("Queued", the count, a chevron) folds the whole list away; it stays
// open until the person folds it. Each row is a grip, its words, then edit and remove. Drag the grip to move a
// row, or focus it and press the arrow keys (Alt+Up and Alt+Down work anywhere in the row). Editing swaps the
// words for a field (Enter saves, Esc cancels). After Stop the queue waits: `onResume` shows it as paused, with Resume.
import { Icon, ArrowDown01Icon, Cancel01Icon, DragDropVerticalIcon, PencilEdit02Icon } from "../icons/huge";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { isComposing } from "../lib/ime";

export interface QueueEntry {
  readonly id: string;
  readonly text: string;
  /** Who sent it when it was not the person ("From Release lead", "Scheduled Nightly triage"), before its words. */
  readonly sender?: string;
  /** Why it has not gone yet, after its words ("Waits for a free chat", "Starts at 9:00"). */
  readonly status?: string;
}

/** upstream banner grid: a 24px icon column, the words, then the actions. */
const ROW = "grid w-full min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-1 text-left";

export function Queue({
  items,
  onEdit,
  onRemove,
  onMove,
  onResume,
  className,
}: {
  items: ReadonlyArray<QueueEntry>;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  /** Move `id` before `beforeId`; null moves it to the back. */
  onMove: (id: string, beforeId: string | null) => void;
  /** Set while Stop holds the queue: it runs again on the next message or on Resume. */
  onResume?: () => void;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // The row being dragged by its grip and the index it would land at (0..items.length), or null where it started.
  // Pointer events, not HTML drag and drop: a finger on a phone or tablet drags the grip the same as a mouse.
  const [drag, setDrag] = useState<{ id: string; at: number | null } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  if (items.length === 0) return null;

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    // Up: before the previous row. Down: before the row after the next one (or to the back).
    onMove(items[i]!.id, dir === -1 ? items[j]!.id : (items[i + 2]?.id ?? null));
  };
  const drop = () => {
    const done = drag;
    setDrag(null);
    if (!done || done.at === null) return;
    const from = items.findIndex((x) => x.id === done.id);
    // Landing right before or after itself moves nothing.
    if (from === -1 || done.at === from || done.at === from + 1) return;
    onMove(done.id, items[done.at]?.id ?? null);
  };
  const grab = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, at: null });
  };
  const follow = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || !list.current) return;
    const rows = [...list.current.children];
    // The first row whose middle is below the pointer is where it lands; past them all is the back.
    let at = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (at === -1) at = rows.length;
    if (drag.at !== at) setDrag({ id: drag.id, at });
  };
  const save = () => {
    if (editing && editing.text.trim()) onEdit(editing.id, editing.text.trim());
    setEditing(null);
  };
  const reorderable = items.length > 1;
  const label = items.length === 1 ? "Queued follow-up" : "Queued follow-ups";

  return (
    <section aria-label={label} aria-live="polite" className={cn("px-1 py-1 text-[12px] leading-4", "animate-in fade-in-0 motion-reduce:animate-none", className)}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          aria-label={open ? "Fold queued follow-ups" : "Show queued follow-ups"}
          className={cn(ROW, "min-h-6 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        >
          <span aria-hidden className="flex justify-center">
            <Mark />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            Queued
            {onResume ? <span className="truncate text-[hsl(var(--subtle-foreground))]">· paused after Stop</span> : null}
          </span>
          <span className="flex items-center">
            <span className="inline-flex min-w-6 justify-center font-medium tabular-nums text-muted-foreground">{items.length}</span>
            <span aria-hidden className="grid size-6 place-items-center text-muted-foreground">
              <Icon icon={ArrowDown01Icon} className={cn("size-3.5 transition-transform duration-150 ease-snap", !open && "rotate-180")} />
            </span>
          </span>
        </button>
        {onResume ? (
          <button
            type="button"
            onClick={onResume}
            className="ml-1 h-6 shrink-0 rounded-md px-2 text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Resume
          </button>
        ) : null}
      </div>
      {/* Folded hides the rows but keeps them mounted: a row being edited keeps its field and its draft. */}
      <div className={cn("max-h-32 overflow-y-auto", !open && "hidden")}>
        <ol ref={list} id={listId} className="grid gap-px">
          {items.map((item, i) => (
            <Row
              key={item.id}
              item={item}
              editing={editing?.id === item.id ? editing.text : null}
              onEditText={(text) => {
                setOpen(true);
                setEditing({ id: item.id, text });
              }}
              onSave={save}
              onCancel={() => setEditing(null)}
              onMove={(dir) => move(i, dir)}
              onRemove={() => onRemove(item.id)}
              grip={
                reorderable ? (
                  <button
                    type="button"
                    aria-label="Move (drag, or press the arrow keys)"
                    onPointerDown={(e) => grab(e, item.id)}
                    onPointerMove={follow}
                    onPointerUp={drop}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                      e.preventDefault();
                      // The row moves on Alt+arrow too; one press is one move.
                      e.stopPropagation();
                      move(i, e.key === "ArrowUp" ? -1 : 1);
                    }}
                    className="grid size-6 cursor-grab touch-none place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing [&_svg]:size-3.5"
                  >
                    <Icon icon={DragDropVerticalIcon} />
                  </button>
                ) : null
              }
              dragging={drag?.id === item.id}
              line={drag?.at === i ? "top" : i === items.length - 1 && drag?.at === items.length ? "bottom" : null}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The queue's mark: a dashed ring, "not started yet", beside the running agents' solid dot. */
function Mark() {
  return <span aria-hidden className="size-2 shrink-0 rounded-full border border-dashed border-muted-foreground" />;
}

function Row({
  item,
  grip,
  editing,
  onEditText,
  onSave,
  onCancel,
  onMove,
  onRemove,
  dragging,
  line,
}: {
  item: QueueEntry;
  grip: ReactNode;
  /** The field's text while this row is being edited. */
  editing: string | null;
  onEditText: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  dragging: boolean;
  /** Where a dragged row would land, drawn as a line on this row's edge. */
  line: "top" | "bottom" | null;
}) {
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <li
      tabIndex={-1}
      onKeyDown={onKey}
      aria-current={editing !== null ? "true" : undefined}
      className={cn(ROW, "relative min-h-6 rounded-sm outline-none", editing !== null && "bg-accent", dragging && "opacity-50")}
    >
      {line ? <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 h-0.5 rounded bg-primary/70", line === "top" ? "top-0" : "bottom-0")} /> : null}
      <span className="flex justify-center">{grip}</span>
      {editing !== null ? (
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={editing}
          aria-label="Edit queued follow-up"
          onChange={(e) => onEditText(e.target.value)}
          onBlur={onSave}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          className="col-span-2 h-6 min-w-0 rounded-md border border-input bg-transparent px-1.5 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            {item.sender ? <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">{item.sender}</span> : null}
            <span className="min-w-0 flex-1 truncate text-foreground/80" title={item.text}>
              {item.text}
            </span>
            {item.status ? <span className="max-w-[45%] shrink-0 truncate text-[hsl(var(--subtle-foreground))]">{item.status}</span> : null}
          </span>
          <span className="flex items-center gap-1">
            <RowButton label="Edit" onClick={() => onEditText(item.text)}>
              <Icon icon={PencilEdit02Icon} />
            </RowButton>
            <RowButton label="Remove" onClick={onRemove}>
              <Icon icon={Cancel01Icon} />
            </RowButton>
          </span>
        </>
      )}
    </li>
  );
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:stroke-[1.75]"
    >
      {children}
    </button>
  );
}
