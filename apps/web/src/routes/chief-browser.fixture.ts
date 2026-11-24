// A browser page for tests that drive the Chief's page and its parts: linkedom's document as the globals React DOM
// and the app's modules read as they load. A test imports this before the page it renders.
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");

const storage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
};
const local = storage();
const session = storage();

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const style = () =>
  new Proxy({ getPropertyValue: () => "" } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : ""),
  });

Object.assign(window, {
  name: "",
  location: new URL("http://localhost/"),
  history: { state: null, replaceState: () => undefined, pushState: () => undefined },
  localStorage: local,
  sessionStorage: session,
  innerWidth: 1440,
  innerHeight: 900,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
  getComputedStyle: style,
  ResizeObserver: Observer,
  IntersectionObserver: Observer,
  requestAnimationFrame: (run: (t: number) => void) => setTimeout(() => run(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
// React picks its onChange path by `"oninput" in document` as it loads; a browser has it, linkedom does not.
(document as unknown as Record<string, unknown>).oninput = null;
const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
  .HTMLElement.prototype;
proto.scrollIntoView ??= function () {};
proto.scrollTo ??= function () {};

const g = globalThis as Record<string, unknown>;
const w = window as unknown as Record<string, unknown>;
for (const k of [
  "window",
  "document",
  "customElements",
  "Node",
  "Element",
  ...[
    "",
    "Anchor",
    "Button",
    "Canvas",
    "Div",
    "IFrame",
    "Image",
    "Input",
    "Span",
    "Template",
    "TextArea",
  ].map((n) => `HTML${n}Element`),
  "SVGElement",
  "SVGSVGElement",
  "ShadowRoot",
  "Text",
  "DocumentFragment",
  "MutationObserver",
  "NodeFilter",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "matchMedia",
  "getComputedStyle",
  "ResizeObserver",
  "IntersectionObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  if (w[k] !== undefined)
    Object.defineProperty(g, k, { value: w[k], configurable: true, writable: true });
}
g.NodeFilter ??= { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
g.IS_REACT_ACT_ENVIRONMENT = true;

/** Lets the page's calls answer and React draw what they set. */
export const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Renders `element` into a fresh container on the page; `unmount` takes it and its window listeners away. */
export async function mount(element: ReactElement) {
  // React DOM decides whether it has a DOM as it loads: only once the globals above are in place.
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(element));
  await settle();
  return {
    container: container as unknown as HTMLElement,
    rerender: async (next: ReactElement) => {
      await act(async () => root.render(next));
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** A person's click on `el`. */
export async function click(el: Element) {
  await act(async () => void el.dispatchEvent(new window.Event("click", { bubbles: true })));
  await settle();
}

/** A key pressed with nothing focused: the window's keydown listeners get it, as on a page. */
export async function press(key: string) {
  await act(async () => {
    const e = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(e, {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      repeat: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
    });
    document.body.dispatchEvent(e);
  });
  await settle();
}
