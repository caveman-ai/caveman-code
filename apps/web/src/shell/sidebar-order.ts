// Device-local sidebar arrangements, like TopicList's order. Pointer capture and a 4px threshold follow upstream
// sidebar dragging: a press remains a click, only a completed drop writes, and Escape restores the untouched list.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { announce } from "../panes/store.ts";
import { arrangedSidebarRows, mergeSidebarRows } from "./sidebar-order-model.ts";

function moveRow(ids: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids];
  const next = ids.filter((it) => it !== id);
  next.splice(next.indexOf(target) + Number(after), 0, id);
  return next;
}

type Placement = { id: string; after: boolean };
export type SidebarOrder = ReturnType<typeof useSidebarOrder>;

export function useSidebarOrder(
  ids: readonly string[],
  key: string,
  allIds: readonly string[] = ids,
) {
  const [saved, setSaved] = useState<readonly string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === "string"))]
        : [];
    } catch {
      return [];
    }
  });
  const fullOrder = arrangedSidebarRows(allIds, saved);
  const visible = new Set(ids);
  const order = fullOrder.filter((id) => visible.has(id));
  const rows = useRef(new Map<string, HTMLElement>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [landing, setLanding] = useState<Placement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressed = useRef<string | null>(null);
  const latest = useRef({ order, fullOrder, key });
  useEffect(() => {
    latest.current = { order, fullOrder, key };
  });
  useEffect(() => () => cleanup.current?.(), []);
  const save = (next: string[]) => {
    // Keep filtered-out rows in their slots; arranging a filtered list never discards their order.
    const merged = mergeSidebarRows(latest.current.fullOrder, latest.current.order, next);
    try {
      localStorage.setItem(latest.current.key, JSON.stringify(merged));
    } catch {
      /* Still usable in memory. */
    }
    setSaved(merged);
  };
  const keyDown = (id: string, e: KeyboardEvent<HTMLElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return false;
    e.preventDefault();
    e.stopPropagation();
    const at = order.indexOf(id);
    const target = order[at + (e.key === "ArrowUp" ? -1 : 1)];
    if (target) {
      save(moveRow(order, id, target, e.key === "ArrowDown"));
      announce(
        `Moved ${rows.current.get(id)?.getAttribute("data-order-name") ?? "row"} ${e.key === "ArrowUp" ? "up" : "down"}.`,
      );
    }
    return true;
  };
  const pointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary || cleanup.current) return;
    suppressed.current = null;
    const control = (e.target as HTMLElement).closest("button, a, input");
    if (control && !control.matches("[data-sidebar-row], [data-order-handle]")) return;
    const source = rows.current.get(id);
    if (!source) return;
    const pointer = e.pointerId;
    const x0 = e.clientX,
      y0 = e.clientY;
    let active = false;
    let place: Placement | null = null;
    let frame = 0;
    let x = x0,
      y = y0;
    const measure = () => {
      frame = 0;
      // Scroll only the containing list, never the page or another project.
      let scroller = source.parentElement;
      while (
        scroller &&
        !(
          scroller.scrollHeight > scroller.clientHeight &&
          /auto|scroll/.test(getComputedStyle(scroller).overflowY)
        )
      )
        scroller = scroller.parentElement;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        // A clipped row still has a rectangle below/above the list. It cannot accept a drop there,
        // nor should pointing at the checklist or other surrounding chrome scroll this list.
        if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) {
          if (place !== null) {
            place = null;
            setLanding(null);
          }
          return;
        }
        if (y < box.top + 28) scroller.scrollTop -= 12;
        if (y > box.bottom - 28) scroller.scrollTop += 12;
      }
      const boxes = latest.current.order.flatMap((it) => {
        const row = rows.current.get(it);
        if (!row || row.closest("[inert]")) return [];
        const box = row.getBoundingClientRect();
        // Chiefs' grips sit on the folder rule, outside the name row. Include that same gutter on every
        // sibling so a vertical drag from grip to grip lands without asking the hand to move sideways.
        const grip = row
          .querySelector<HTMLElement>(":scope > [data-order-handle]")
          ?.getBoundingClientRect();
        return [
          {
            id: it,
            box,
            left: Math.min(box.left, grip?.left ?? box.left),
            right: Math.max(box.right, grip?.right ?? box.right),
          },
        ];
      });
      const hit = boxes.find(
        ({ box, left, right }) => x >= left && x <= right && y >= box.top && y <= box.bottom,
      );
      const next =
        hit && hit.id !== id ? { id: hit.id, after: y >= hit.box.top + hit.box.height / 2 } : null;
      if (next?.id !== place?.id || next?.after !== place?.after) {
        place = next;
        setLanding(next);
      }
    };
    const stop = (commit = false) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      source.removeEventListener("lostpointercapture", cancel);
      if (source.hasPointerCapture(pointer)) source.releasePointerCapture(pointer);
      cleanup.current = null;
      setDragging(null);
      setLanding(null);
      if (!active) return;
      // The release must never fold the folder or open its Chief, including after cancellation.
      suppressed.current = id;
      if (commit && place) {
        save(moveRow(latest.current.order, id, place.id, place.after));
        announce("Order saved.");
      } else announce("Drag cancelled.");
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      x = event.clientX;
      y = event.clientY;
      if (!active && Math.hypot(x - x0, y - y0) < 4) return;
      if (!active) {
        active = true;
        try {
          source.setPointerCapture(pointer);
        } catch {
          /* Window listeners still handle a pointer already released. */
        }
        setDragging(id);
        announce(`Dragging ${source.getAttribute("data-order-name") ?? "row"}. Escape cancels.`);
      }
      event.preventDefault();
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointer) {
        if (active) {
          x = event.clientX;
          y = event.clientY;
          cancelAnimationFrame(frame);
          measure();
        }
        stop(true);
      }
    };
    const cancel = () => stop();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        stop();
      }
    };
    cleanup.current = cancel;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    source.addEventListener("lostpointercapture", cancel);
  };
  return {
    order,
    dragging,
    landing,
    keyDown,
    pointerDown,
    clickCapture: (
      id: string,
      e: { detail: number; preventDefault(): void; stopPropagation(): void },
    ) => {
      if (suppressed.current !== id || e.detail === 0) return;
      suppressed.current = null;
      e.preventDefault();
      e.stopPropagation();
    },
    ref: (id: string, node: HTMLElement | null) => {
      if (node) rows.current.set(id, node);
      else rows.current.delete(id);
    },
  };
}
