// A browser page for tests that click through a settings page: linkedom's document as the globals React DOM and the
// app's modules read as they load, so a test imports this before react-dom/client and the page it renders. Like a
// browser's popup blocker and clipboard, window.open and clipboard.writeText work only inside a click (its transient
// activation), never in what runs after an await.
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/** A tab window.open gave the page: where it points now, and whether it was closed. */
export interface Tab {
  url: string;
  closed: boolean;
  opener: unknown;
  readonly location: { href: string };
  close(): void;
}

let activation = false;
/** Every tab the page opened, and every window.open the blocker refused. */
export const popups = { tabs: [] as Tab[], refused: [] as string[] };
/** Every clipboard write: what, and whether the browser allowed it. */
export const clipboard: Array<{ text: string; ok: boolean }> = [];

Object.assign(window, {
  name: "",
  location: new URL("http://localhost/"),
  history: { replaceState: () => undefined },
  localStorage: storage,
  sessionStorage: storage,
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
  open: (url = "", _target?: string, features = "") => {
    if (!activation) {
      popups.refused.push(url);
      return null;
    }
    const tab: Tab = {
      url,
      closed: false,
      opener: window,
      location: {
        get href() {
          return tab.url;
        },
        set href(next: string) {
          tab.url = next;
        },
      },
      close: () => void (tab.closed = true),
    };
    popups.tabs.push(tab);
    return /noopener/.test(features) ? null : tab;
  },
});
// React picks its onChange path by `"oninput" in document` as it loads; a browser has it, linkedom does not.
(document as unknown as Record<string, unknown>).oninput = null;

const g = globalThis as Record<string, unknown>;
for (const k of [
  "document",
  "customElements",
  "Node",
  "Element",
  ...[
    "",
    "Anchor",
    "Button",
    "Div",
    "Form",
    "IFrame",
    "Image",
    "Input",
    "Label",
    "Select",
    "Span",
    "Template",
    "TextArea",
  ].map((n) => `HTML${n}Element`),
  "SVGElement",
  "ShadowRoot",
  "Text",
  "DocumentFragment",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
]) {
  g[k] = (window as unknown as Record<string, unknown>)[k];
}
// Radix's presence reads a mounting element's animation (a checkbox's tick); linkedom computes no styles.
g.getComputedStyle ??= () => ({ animationName: "none", getPropertyValue: () => "" });
// Radix's focus scope (a sheet, a dialog) walks the tabbables with a TreeWalker; linkedom has the walker but not NodeFilter's constants.
g.NodeFilter ??= {
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_TEXT: 0x4,
};
g.requestAnimationFrame ??= (run: (t: number) => void) => setTimeout(() => run(0), 0);
g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
g.window = window;
g.localStorage = storage;
g.sessionStorage = storage;
g.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => {
      clipboard.push({ text, ok: activation });
      return activation
        ? Promise.resolve()
        : Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    },
  },
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");

/** Lets the page's calls answer and React draw what they set. */
export const settle = () => React.act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** Renders `element` into a fresh container on the page. */
export async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await React.act(async () => root.render(element));
  await settle();
  return {
    container: container as unknown as HTMLElement,
    rerender: (next: React.ReactElement) => React.act(async () => root.render(next)),
    unmount: async () => {
      await React.act(async () => root.unmount());
      container.remove();
      popups.tabs.length = 0;
      popups.refused.length = 0;
      clipboard.length = 0;
    },
  };
}

/** The button whose text (or aria-label) is `name`. */
export function button(container: HTMLElement, name: string | RegExp): HTMLButtonElement {
  const all = [...container.querySelectorAll("button")];
  const found = all.find((b) => {
    const text = b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "";
    return typeof name === "string"
      ? text === name || b.textContent?.trim() === name
      : name.test(text) || name.test(b.textContent ?? "");
  });
  if (!found)
    throw new Error(
      `no button ${String(name)} in: ${all.map((b) => b.textContent?.trim()).join(" | ")}`,
    );
  return found;
}

/** A person's click: its handler runs inside the click's activation; whatever it awaits runs after it. */
export async function click(el: Element) {
  await React.act(async () => {
    activation = true;
    try {
      el.dispatchEvent(new window.Event("click", { bubbles: true }));
    } finally {
      activation = false;
    }
  });
  await settle();
}

/** Types `text` into a field, as an input event a browser sends. */
export async function type(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  let proto = Object.getPrototypeOf(field);
  while (proto && !Object.getOwnPropertyDescriptor(proto, "value"))
    proto = Object.getPrototypeOf(proto);
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** What React last rendered on a node (a controlled field's value, a button's disabled): linkedom does not mirror them all. */
export function rendered(el: Element): Record<string, unknown> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error("not a node React rendered");
  return (el as unknown as Record<string, Record<string, unknown>>)[key]!;
}

/** A call the test answers when it chooses. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
