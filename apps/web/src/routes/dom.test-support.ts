// A browser page for route tests that click and type through real components: linkedom's document on globalThis, with
// the gaps React DOM, Radix and the app's stores trip on filled. Import it before the components: react-dom and
// panes/store.ts read the page as they load.
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

/**
 * The page's address and session history as a browser keeps them: the hash router writes both, Back walks the
 * entries (popstate), and both outlive a reload (a test reloads by unmounting and booting a fresh router on the page).
 */
const entries: Array<{ hash: string; state: unknown }> = [{ hash: "#/", state: null }];
let at = 0;
const urlHash = (url: string) => url.slice(url.indexOf("#"));
export const page = {
  location: {
    get hash() {
      return entries[at]!.hash;
    },
    set hash(v: string) {
      entries[at] = { hash: v.startsWith("#") ? v : `#${v}`, state: null };
    },
    pathname: "/",
    search: "",
    origin: "http://localhost",
    host: "localhost",
    hostname: "localhost",
    protocol: "http:",
    get href() {
      return `http://localhost/${entries[at]!.hash}`;
    },
    assign() {},
    replace() {},
    reload() {},
  },
  history: {
    get state() {
      return entries[at]!.state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _title: string, url?: string | null) {
      entries.splice(at + 1, entries.length, {
        hash: url ? urlHash(url) : entries[at]!.hash,
        state: structuredClone(state),
      });
      at++;
    },
    replaceState(state: unknown, _title: string, url?: string | null) {
      entries[at] = { hash: url ? urlHash(url) : entries[at]!.hash, state: structuredClone(state) };
    },
    go(delta = 0) {
      const next = Math.max(0, Math.min(entries.length - 1, at + delta));
      if (next === at) return;
      at = next;
      setTimeout(() => win.dispatchEvent(new (w.Event as typeof Event)("popstate")), 0);
    },
    back() {
      page.history.go(-1);
    },
    forward() {
      page.history.go(1);
    },
  },
  /** Starts the session history over at `hash`, as a new tab would. */
  reset(hash = "#/") {
    entries.splice(0, entries.length, { hash, state: null });
    at = 0;
  },
  /** Every URL the page opened in a new tab (window.open), in order. */
  opened: [] as string[],
};

Object.assign(w, {
  location: page.location,
  history: page.history,
  name: "",
  open: (url: string) => (page.opened.push(url), null),
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
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  CSS: { escape: (v: string) => v.replace(/["\\]/g, "\\$&"), supports: () => false },
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
const elements = [
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLFormElement",
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
  "NodeFilter",
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
proto.scrollTo ??= () => undefined;
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
const textarea = (w.HTMLTextAreaElement as { prototype: Record<string, unknown> }).prototype;
textarea.setSelectionRange ??= () => undefined;

/** Lets the calls an input started answer, and React render what they set. */
export const settle = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++)
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

/**
 * Renders `node` into a fresh element of the page; `unmount` takes it down, and the test's end does if the test did
 * not (a portal's dialog left on the page would answer the next test's queries).
 */
export async function render(node: ReactNode): Promise<{
  host: HTMLElement;
  rerender: (next: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  // Loaded here, after the page is up: React DOM picks its event paths from the document it finds as it loads.
  const { createRoot } = await import("react-dom/client");
  const host = doc.body.appendChild(doc.createElement("div")) as unknown as HTMLElement;
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
  };
  onTestFinished(unmount);
  await act(async () => root.render(node));
  return { host, rerender: (next) => act(async () => root.render(next)), unmount };
}

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

/**
 * A key pressed on `el`; `repeat` as the key's auto-repeat sends it while held. `ime` is the key that ends an IME
 * conversion: Chromium and Electron send it while still composing, Safari after compositionend, so only its keyCode,
 * 229, says so.
 */
export async function press(
  el: Element | null | undefined,
  key: string,
  mods: {
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    repeat?: boolean;
    ime?: "chrome" | "safari";
  } = {},
): Promise<void> {
  if (!el) throw new Error("nothing to press a key on");
  const keyCode = mods.ime ? 229 : key === "Enter" ? 13 : 0;
  await act(async () => {
    const e = new (w.Event as typeof Event)("keydown", { bubbles: true, cancelable: true });
    Object.assign(e, {
      key,
      code: key,
      keyCode,
      which: keyCode,
      metaKey: !!mods.meta,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
      altKey: false,
      repeat: !!mods.repeat,
      isComposing: mods.ime === "chrome",
    });
    el.dispatchEvent(e);
  });
}

/** The two ways a browser sends the key that ends an IME conversion (press's `ime`). */
export const IME = ["chrome", "safari"] as const;

/** Types into a field as a keystroke would: through the value setter React's tracker watches, then `input`. */
export async function type(field: Element | null | undefined, text: string): Promise<void> {
  if (!field) throw new Error("nothing to type into");
  let p = Object.getPrototypeOf(field) as object | null;
  while (p && !Object.getOwnPropertyDescriptor(p, "value"))
    p = Object.getPrototypeOf(p) as object | null;
  await act(async () => {
    Object.getOwnPropertyDescriptor(p!, "value")!.set!.call(field, text);
    field.dispatchEvent(new (w.Event as typeof Event)("input", { bubbles: true }));
  });
}

/** The buttons under `root` whose text is `label`. */
export const buttons = (root: ParentNode, label: string | RegExp): HTMLButtonElement[] =>
  [...root.querySelectorAll("button")].filter((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""),
  ) as HTMLButtonElement[];

/** Every role=alert under `root`, as read. */
export const alerts = (root: ParentNode): string[] =>
  [...root.querySelectorAll("[role='alert']")].map((a) => a.textContent?.trim() ?? "");

export { win as window };
