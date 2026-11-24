// A browser for tests that mount components with React DOM, so their effects and events run: this package's tests
// run in node. linkedom gives the window and the document; this fills in what it leaves out, focus included. Import
// it before anything that loads React DOM, which looks for a document as it loads.
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
const browser: Record<string, unknown> = {
  getComputedStyle: () => ({ fontSize: "16px", lineHeight: "22px", getPropertyValue: () => "" }),
  ResizeObserver: NoopObserver,
  CSS: { escape: (s: string) => String(s).replace(/["\\]/g, "\\$&") },
  // React DOM reads the selection on a key pressed in a focused field (its onSelect).
  getSelection: () => ({
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    rangeCount: 0,
  }),
};
for (const [k, v] of Object.entries(browser)) {
  define(window, k, v);
  define(globalThis, k, v);
}
define(globalThis, "window", window);
define(globalThis, "document", document);
for (const k of [
  "HTMLElement",
  "HTMLInputElement",
  "SVGElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "InputEvent",
]) {
  const v = (window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) define(globalThis, k, v);
}
define(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const element = window.HTMLElement.prototype as unknown as Record<string, unknown>;
element.getAnimations ??= () => [];
element.getBoundingClientRect ??= () => ({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
});
element.scrollIntoView ??= () => undefined;

// Focus as a browser moves it: the element left gets blur and focusout, the one taken focus and focusin (React's onFocus).
let focused: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
  configurable: true,
  get: () => (focused?.isConnected ? focused : document.body),
});
element.focus = function (this: HTMLElement) {
  if (focused === this) return;
  const left = focused;
  focused = this;
  left?.dispatchEvent(new window.Event("blur"));
  left?.dispatchEvent(new window.Event("focusout", { bubbles: true }));
  this.dispatchEvent(new window.Event("focus"));
  this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
};
// linkedom's selector engine knows no :focus-visible; focus here never comes from a keyboard.
const matches = element.matches as (this: Element, selector: string) => boolean;
element.matches = function (this: Element, selector: string) {
  return selector === ":focus-visible" ? false : matches.call(this, selector);
};
const input = window.HTMLInputElement.prototype as unknown as Record<string, unknown>;
input.select ??= () => undefined;
// A browser's input.type defaults to "text", and React reads its `input` events as onChange only for text types.
Object.defineProperty(input, "type", {
  configurable: true,
  get(this: HTMLInputElement) {
    return this.getAttribute("type") ?? "text";
  },
  set(this: HTMLInputElement, type: string) {
    this.setAttribute("type", type);
  },
});
// React DOM tracks input through `input` events only when the document says it has them.
(document as unknown as Record<string, unknown>).oninput = null;

export { document, window };

/** An event as the browser dispatches it: bubbling and cancelable. */
export function fire(target: EventTarget, type: string): boolean {
  return target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

/** Types `value` into a field as a person does: the new value, then an `input` event React reads as onChange. */
export function typeInto(field: HTMLInputElement, value: string): void {
  // Through the prototype's setter, so React's value tracker sees a change.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
  fire(field, "input");
}
