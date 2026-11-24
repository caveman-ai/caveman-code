// A browser for tests that click through real components: linkedom's document on globalThis, with the gaps React DOM
// and the app's stores trip on filled. Import it first: react-dom and panes/store.ts read the page as they load.
import { parseHTML } from "linkedom";
import { act } from "react";

const { window: win, document: doc } = parseHTML(
  "<!doctype html><html><head></head><body></body></html>",
);
const w = win as unknown as Record<string, unknown>;
const g = globalThis as Record<string, unknown>;

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

/** What `matchMedia` answers; a test sets it (reduced motion skips the card animations it would wait on). */
export const media: { reducedMotion: boolean } = { reducedMotion: false };

const location = new URL("http://localhost/#/");
Object.assign(w, {
  location,
  history: { state: null, replaceState() {}, pushState() {} },
  name: "",
  matchMedia: (query: string) => ({
    matches: /reduce/.test(query) && media.reducedMotion,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  CSS: { escape: (v: string) => v.replace(/["\\]/g, "\\$&"), supports: () => false },
});
// linkedom computes no styles: every property reads empty, as for an element nothing styles.
if (typeof w.getComputedStyle !== "function")
  w.getComputedStyle = () =>
    new Proxy(
      { getPropertyValue: () => "" },
      { get: (t, k) => (k in t ? t[k as keyof typeof t] : "") },
    );
const elements = [
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLIFrameElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "ShadowRoot",
  "MutationObserver",
  "customElements",
  "getComputedStyle",
];
for (const k of elements) if (w[k] !== undefined) g[k] = w[k];
// Radix dispatches its own events (focus scope, dismissable layer): they must be the document's, not Node's.
for (const k of ["Event", "CustomEvent"]) g[k] = w[k];
for (const k of [
  "location",
  "history",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ResizeObserver",
  "IntersectionObserver",
  "CSS",
])
  g[k] = w[k];
for (const target of [g, w]) {
  Object.defineProperty(target, "localStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(target, "sessionStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
}
g.window = win;
g.document = doc;
g.IS_REACT_ACT_ENVIRONMENT = true;

// The page has a doctype; linkedom doesn't say so, and KaTeX warns of quirks mode.
Object.defineProperty(doc, "compatMode", { value: "CSS1Compat", configurable: true });
// React DOM picks its onChange path from `"oninput" in document` as it loads; linkedom has no handler slot for it.
(doc as unknown as Record<string, unknown>).oninput = null;
// A browser's input without a type attribute is "text"; linkedom answers null, and React would skip its onChange.
Object.defineProperty((w.HTMLInputElement as { prototype: object }).prototype, "type", {
  get(this: Element) {
    return this.getAttribute("type") ?? "text";
  },
  set(this: Element, v: string) {
    this.setAttribute("type", v);
  },
});
const proto = (w.HTMLElement as { prototype: Record<string, unknown> }).prototype;
proto.scrollIntoView ??= () => undefined;
proto.checkVisibility ??= () => true;
proto.getBoundingClientRect ??= () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON() {},
});

/** A fresh element in the body for one test's root. */
export const container = (): HTMLElement =>
  doc.body.appendChild(doc.createElement("div")) as unknown as HTMLElement;

/** Lets the calls a click started answer, and React render what they set. */
export const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** A primary-button click, as a person makes it. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    const e = new (w.Event as typeof Event)("click", { bubbles: true, cancelable: true });
    Object.assign(e, {
      button: 0,
      buttons: 0,
      detail: 1,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    el.dispatchEvent(e);
  });
  await settle();
}

/** Types into an input as a keystroke would: through the value setter React's tracker watches, then `input`. */
export async function type(input: Element | null | undefined, text: string): Promise<void> {
  if (!input) throw new Error("nothing to type into");
  let p = Object.getPrototypeOf(input) as object | null;
  while (p && !Object.getOwnPropertyDescriptor(p, "value"))
    p = Object.getPrototypeOf(p) as object | null;
  await act(async () => {
    Object.getOwnPropertyDescriptor(p!, "value")!.set!.call(input, text);
    input.dispatchEvent(new (w.Event as typeof Event)("input", { bubbles: true }));
  });
}

/** Submits a form, as Enter in one of its fields does. */
export async function submit(form: Element | null | undefined): Promise<void> {
  if (!form) throw new Error("no form to submit");
  await act(
    async () =>
      void form.dispatchEvent(
        new (w.Event as typeof Event)("submit", { bubbles: true, cancelable: true }),
      ),
  );
  await settle();
}

/** The buttons under `root` whose text is `label`. */
export const buttons = (root: ParentNode, label: string | RegExp): HTMLButtonElement[] =>
  [...root.querySelectorAll("button")].filter((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""),
  ) as HTMLButtonElement[];

/** Every role=alert line under `root`, as read. */
export const alerts = (root: ParentNode): string[] =>
  [...root.querySelectorAll("[role='alert']")].map((a) => a.textContent?.trim() ?? "");
