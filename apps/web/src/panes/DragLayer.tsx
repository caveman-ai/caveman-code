import { createPortal } from "react-dom";
import { setFloating, useDrag, type DropTarget } from "./drag.ts";
import "./panes.css";

const INSET = 4;

/**
 * What a drag shows: the target region (blue outline, blurred and dimmed
 * content behind it, a hint) and, following the pointer on its own
 * composited layer, the "Split view" pill and a small preview of the chat.
 * Mounted once per window; renders nothing at rest.
 */
export function DragLayer() {
  const { payload, target } = useDrag();
  if (!payload) return null;
  const words = labels(target, payload.fromPaneId !== null, payload.tab !== undefined);
  return createPortal(
    // Covers the window: the grabbing cursor everywhere, no hover underneath.
    <div aria-hidden className="fixed inset-0 z-[90] cursor-grabbing">
      {/* A pin, a composer or a Chief marks itself. */}
      {/* Arranging the sidebar: a line where the row lands, or a ring round the group it joins. */}
      {target?.kind === "arrange" ? (
        target.place === "into" ? (
          <div className="absolute rounded-[10px] ring-2 ring-target" style={{ left: target.box.left, top: target.box.top, width: target.box.width, height: target.box.height }} />
        ) : (
          <div className="absolute h-0.5 rounded-full bg-target" style={{ left: target.box.left + 8, top: (target.place === "before" ? target.box.top : target.box.top + target.box.height) - 1, width: target.box.width - 16 }} />
        )
      ) : null}
      {target && target.kind !== "pin" && target.kind !== "composer" && target.kind !== "chief" && target.kind !== "arrange" ? (
        <div
          // A new region fades in where it lands instead of morphing: no layout animates during a drag.
          // Keyed by where it lands: a corner that lands as its edge keeps the edge's region (no fade between the two).
          key={target.kind === "pane" ? `${target.paneId}:${target.lands}` : target.kind}
          className="pane-zone absolute rounded-xl border-2 border-target"
          style={{
            left: target.box.left + INSET,
            top: target.box.top + INSET,
            width: target.box.width - INSET * 2,
            height: target.box.height - INSET * 2,
          }}
        >
          {words.hint ? (
            <span className="pane-hint absolute top-1/2 -translate-y-1/2 rounded-md bg-popover px-2.5 py-1 text-[13px] text-foreground shadow-overlay">{words.hint}</span>
          ) : null}
        </div>
      ) : null}
      <div ref={setFloating} className="pane-float absolute left-0 top-0">
        <div className="pane-float-inner flex flex-col items-start gap-2 pl-3 pt-3.5">
          {words.pill ? <span className="rounded-full bg-target-strong px-2.5 py-[3px] text-[12px] font-medium text-target-foreground shadow-overlay">{words.pill}</span> : null}
          <div className="w-[240px] origin-top-left scale-95 rounded-xl border border-border bg-popover px-3 py-2.5 shadow-overlay">
            <div className="truncate text-[13px] font-medium text-foreground">{payload.title}</div>
            {payload.meta ? <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{payload.meta}</div> : null}
            {payload.detail ? <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{payload.detail}</div> : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function labels(target: DropTarget | null, moving: boolean, tab: boolean): { pill: string | null; hint: string | null } {
  if (!target) return { pill: null, hint: null };
  if (target.kind === "pin") return { pill: "Pin", hint: null };
  if (target.kind === "arrange") return { pill: target.place === "into" ? "Add to group" : null, hint: null };
  if (target.kind === "composer") return { pill: target.label ?? "Reference", hint: null };
  if (target.kind === "chief") return { pill: `Add to ${target.name}`, hint: null };
  if (target.kind === "panel") return { pill: target.label, hint: null };
  if (target.kind === "main") return tab ? { pill: "Split view", hint: "Open in split view" } : { pill: "Open", hint: "Open here" };
  if (target.kind === "strip") return { pill: "New tab", hint: null };
  if (target.open) return { pill: "Already open", hint: "Go to this pane" };
  if (target.zone === "center") return moving ? { pill: "Swap", hint: "Swap panes" } : { pill: "Replace", hint: "Open here instead" };
  if (target.lands.includes("-")) return { pill: "Split view", hint: moving ? "Move to this corner" : "Open in this corner" };
  return { pill: "Split view", hint: moving ? "Move here" : "Open in split view" };
}
