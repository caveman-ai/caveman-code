// A browser for tests that mount components with React DOM, so their effects, observers and events run: the web
// package's tests run in node. linkedom gives the window and the document; this fills in what it leaves out. Import
// it before anything that loads React DOM, which looks for a document as it loads.
import { parseHTML } from "linkedom";

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
  getComputedStyle: () => ({
    fontSize: "16px",
    lineHeight: "22px",
    overflowY: "visible",
    getPropertyValue: () => "",
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
  CSS: { escape: (s: string) => String(s).replace(/["\\]/g, "\\$&"), supports: () => false },
  AudioContext: class {
    resume = async () => undefined;
    suspend = async () => undefined;
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
const w = window as unknown as Record<string, unknown>;
w.MutationObserver ??= NoopObserver;
for (const k of [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLTemplateElement",
  "HTMLIFrameElement",
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
  "MutationObserver",
  "customElements",
]) {
  const v = (window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) define(globalThis, k, v);
}
define(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const element = window.Element.prototype as unknown as Record<string, unknown>;
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
element.getAnimations ??= () => [];
element.animate ??= () => ({
  cancel() {},
  finish() {},
  play() {},
  pause() {},
  finished: Promise.resolve(),
  onfinish: null,
  addEventListener() {},
  removeEventListener() {},
});
element.scrollIntoView ??= () => undefined;
element.focus ??= () => undefined;
const input = window.HTMLInputElement.prototype as unknown as Record<string, unknown>;
input.select ??= () => undefined;
const doc = document as unknown as Record<string, unknown>;
doc.execCommand = () => false;
// linkedom leaves these unset; KaTeX warns of quirks mode without the first.
Object.defineProperty(document, "compatMode", { value: "CSS1Compat" });
Object.defineProperty(document, "fonts", {
  value: { load: async () => [], ready: Promise.resolve() },
});
// React DOM tracks input through `input` events only when the document says it has them.
doc.oninput = null;

export { document, window };

/** An event as the browser dispatches it, with the fields it carries (`key`, `keyCode`, `isComposing`) set. */
export function fire(
  target: EventTarget,
  type: string,
  fields: Record<string, unknown> = {},
): boolean {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
  return target.dispatchEvent(e);
}
