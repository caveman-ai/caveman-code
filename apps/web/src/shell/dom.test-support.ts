// A browser for shell tests that mount components with React DOM, so their effects run and their key handlers see the
// events a browser sends: the web package's tests run in node. linkedom gives the window and the document; this fills
// in what it leaves out. Import it before anything that loads React DOM or reads `window` as it loads.
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");

const memoryStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const browser: Record<string, unknown> = {
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  getComputedStyle: () =>
    new Proxy({ getPropertyValue: () => "" } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : ""),
    }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  ResizeObserver: NoopObserver,
  IntersectionObserver: NoopObserver,
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  location: new URL("http://localhost/"),
  history: { replaceState() {}, pushState() {}, state: null },
  name: "",
  NodeFilter: {
    SHOW_ALL: 0xffffffff,
    SHOW_ELEMENT: 0x1,
    SHOW_TEXT: 0x4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  },
};

const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
for (const [k, v] of Object.entries(browser)) {
  define(window, k, v);
  define(globalThis, k, v);
}
define(globalThis, "window", window);
define(globalThis, "document", document);
define(globalThis, "navigator", {
  userAgent: "node",
  platform: "MacIntel",
  language: "en",
  clipboard: {},
});
for (const k of [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "SVGElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "ShadowRoot",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "InputEvent",
  "UIEvent",
  "MutationObserver",
  "customElements",
]) {
  const v = (window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) define(globalThis, k, v);
}
define(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const element = window.HTMLElement.prototype as unknown as Record<string, unknown>;
element.checkVisibility ??= () => true;
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
element.focus ??= () => undefined;
// linkedom's blur() fires only "blur"; React's onBlur listens for focusout.
element.blur = function (this: HTMLElement) {
  this.dispatchEvent(new window.Event("focusout", { bubbles: true }));
};
const input = window.HTMLInputElement.prototype as unknown as Record<string, unknown>;
input.select ??= () => undefined;
// A browser's input without a type attribute is a text field; React DOM hears its `input` events only then.
Object.defineProperty(input, "type", {
  get(this: HTMLInputElement) {
    return this.getAttribute("type") || "text";
  },
  set(this: HTMLInputElement, value: string) {
    this.setAttribute("type", value);
  },
  configurable: true,
});
// React DOM listens for `input` events only when the document says it has them.
(document as unknown as Record<string, unknown>).oninput = null;

export { document, window };

/** Renders `node` into a fresh element of the page; `unmount` takes it away again. */
export async function mount(node: ReactNode): Promise<{ readonly unmount: () => Promise<void> }> {
  // Loaded once the page is here: React DOM looks at the document as it loads (which events it can listen for).
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Lets pending promises (a call's answer, what it sets) and the renders they cause run. */
export const settle = () =>
  act(async () => await new Promise<void>((resolve) => setImmediate(resolve)));

/** A keydown as the browser dispatches it, with the fields it carries (`key`, `keyCode`, `isComposing`). */
export function keydown(
  target: EventTarget,
  fields: { readonly key: string; readonly keyCode: number; readonly isComposing: boolean },
): Promise<void> {
  const e = new window.Event("keydown", { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries({ ...fields, which: fields.keyCode, code: fields.key }))
    Object.defineProperty(e, k, { value: v });
  return act(async () => void target.dispatchEvent(e));
}

/** A click as a person makes it. */
export const click = (target: HTMLElement): Promise<void> => act(async () => target.click());

/** Typing `text` into a field as React sees it: through the element's own value setter, then an `input` event. */
export function type(target: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const proto =
    target instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, text);
  return act(async () => void target.dispatchEvent(new window.Event("input", { bubbles: true })));
}
