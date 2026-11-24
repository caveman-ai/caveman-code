import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * An IME is composing, so the key belongs to it (Enter commits a candidate). Safari fires compositionend before the
 * committing keydown, which then says isComposing false; only its keyCode, 229, gives it away.
 */
export function isComposing(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  const n = "nativeEvent" in e ? e.nativeEvent : e;
  return n.isComposing || n.keyCode === 229;
}
