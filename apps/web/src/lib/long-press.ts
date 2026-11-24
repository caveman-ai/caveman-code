// Press and hold, on a touch screen: what a right-click opens with a mouse. Android turns a long press into a
// `contextmenu` event on its own; Safari on iOS never does, so a row with a menu listens for the hold itself. A finger
// that moves first is scrolling, and a hold that opened the menu is not also a tap.

import { useRef, type MouseEvent, type PointerEvent } from "react";

const HOLD_MS = 450;
/** Further than this and the finger is scrolling, not holding. */
const SLOP_PX = 8;

/** `onHold` gets where the finger is, for a menu that opens there. */
export function useLongPress(onHold: (x: number, y: number) => void) {
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false);
  const clear = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      // Any new press starts clean: a hold that ended without a tap never swallows the next click.
      held.current = false;
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      clear();
      const { clientX: x, clientY: y } = e;
      const timer = setTimeout(() => {
        press.current = null;
        held.current = true;
        navigator.vibrate?.(8);
        onHold(x, y);
      }, HOLD_MS);
      press.current = { id: e.pointerId, x, y, timer };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // The tap that ends a hold: the menu is open, the row does not also open its chat.
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!held.current) return;
      held.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
