// A page for Review tests that click through real components (Radix dialogs included): linkedom's document on
// globalThis, with the gaps React DOM and Radix trip on filled. Import it before the components under test.
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { onTestFinished } from "vitest";

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

// The app's modules read the address and storage as they load (state/runtime.tsx).
Object.assign(w, {
  location: {
    href: "http://localhost/#/",
    hash: "#/",
    pathname: "/",
    search: "",
    origin: "http://localhost",
    host: "localhost",
    hostname: "localhost",
    protocol: "http:",
  },
  history: { state: null, length: 1, pushState() {}, replaceState() {} },
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
// Radix's focus scope walks the tabbables with a TreeWalker; linkedom has the walker but not NodeFilter's constants.
w.NodeFilter ??= {
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_TEXT: 0x4,
};
// No layout here: every style reads as unset (Radix's scroll lock measures the body's margins with it).
w.getComputedStyle ??= () =>
  new Proxy(
    { getPropertyValue: () => "" },
    { get: (target, k) => (k in target ? target[k as "getPropertyValue"] : "") },
  );
for (const k of [
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "ShadowRoot",
  "MutationObserver",
  "customElements",
  "getComputedStyle",
])
  if (w[k] !== undefined) g[k] = w[k];
// Radix dispatches its own events (focus scope, dismissable layer): they must be the document's, not Node's.
for (const k of ["Event", "CustomEvent"]) g[k] = w[k];
for (const k of [
  "location",
  "history",
  "NodeFilter",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ResizeObserver",
])
  g[k] = w[k];
const storage = memoryStorage();
for (const target of [g, w])
  Object.defineProperty(target, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
g.window = win;
g.document = doc;
g.IS_REACT_ACT_ENVIRONMENT = true;

/** Lets the calls a click started answer, and React render what they set. */
export const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** Renders `node` into a fresh element of the page; the test's end takes it down (a dialog's portal included). */
export async function render(node: ReactNode): Promise<HTMLElement> {
  // Loaded here, after the page is up: React DOM picks its event paths from the document it finds as it loads.
  const { createRoot } = await import("react-dom/client");
  const host = doc.body.appendChild(doc.createElement("div")) as unknown as HTMLElement;
  const root = createRoot(host);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(node));
  return host;
}

/** A primary-button click, as a person makes it. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    const e = new (w.Event as typeof Event)("click", { bubbles: true, cancelable: true });
    Object.assign(e, { button: 0, buttons: 0, detail: 1 });
    el.dispatchEvent(e);
  });
  await settle();
}

/** The buttons under `root` whose text is `label`. */
export const buttons = (root: ParentNode, label: string): HTMLButtonElement[] =>
  [...root.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement[];

export { doc as document };
