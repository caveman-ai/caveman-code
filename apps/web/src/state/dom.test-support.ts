// React DOM on linkedom's document, for tests of hooks whose effects matter: they run, and clean up on unmount, as in
// a page. The package's tests run in node, where renderToStaticMarkup runs no effects at all.
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { onTestFinished } from "vitest";

export interface Mounted {
  readonly render: (node: ReactNode) => Promise<void>;
  readonly unmount: () => Promise<void>;
  /** Lets pending promises (a call's answer, what it sets) and the renders they cause run. */
  readonly settle: () => Promise<void>;
}

/**
 * Mounts `node` for this test. The page's `window` and `document` are global until the test ends (React reads them),
 * then put back: a module that reads them as it loads, imported in a later test, finds none.
 */
export async function mount(node: ReactNode): Promise<Mounted> {
  const before = { window: globalThis.window, document: globalThis.document };
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>",
  );
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  onTestFinished(async () => {
    await unmount();
    Object.assign(globalThis, before);
  });
  const render = (next: ReactNode) => act(async () => root.render(next));
  await render(node);
  return {
    render,
    unmount,
    settle: () =>
      act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }),
  };
}
