import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";
import { PaintingThumb } from "./Wallpaper.tsx";
import { PAINTINGS } from "./paintings.ts";
import "../styles.css";

const living = PAINTINGS.find((painting) => painting.life)!;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const task = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount() {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "300px",
    height: "120px",
    overflow: "auto",
  });
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) root.unmount();
    mounted = false;
  };
  onTestFinished(() => {
    unmount();
    host.remove();
  });
  return { host, render: (children: ReactNode) => root.render(children), unmount };
}

test("an offscreen thumbnail waits for visibility, then draws with real WebGL and keeps its cached still", async () => {
  const native = HTMLCanvasElement.prototype.getContext;
  const contexts: Array<RenderingContext | null> = [];
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement, id: string, options?: unknown) {
      const context = native.call(this, id, options);
      if (id === "webgl2") contexts.push(context);
      return context;
    });
  onTestFinished(() => getContext.mockRestore());
  const view = mount();
  const painting = { ...living, id: "thumbnail-visibility-probe" };
  const render = (key: string) =>
    view.render(
      <div style={{ height: 1200, paddingTop: 1000 }}>
        <div data-thumb-slot style={{ width: 148, height: 74 }}>
          <PaintingThumb key={key} painting={painting} className="block size-full" />
        </div>
      </div>,
    );
  render("cold");
  await expect.poll(() => view.host.querySelector("[data-thumb-slot]") !== null).toBe(true);
  await frame();
  await frame();
  await task();
  const slot = view.host.querySelector<HTMLElement>("[data-thumb-slot]")!;
  expect(slot.getBoundingClientRect().top).toBeGreaterThan(view.host.clientHeight);
  expect(contexts, "a below-fold still must not compile or draw yet").toHaveLength(0);

  view.host.scrollTop = 1000;
  await expect.poll(() => slot.querySelector("img")?.naturalWidth).toBe(296);
  expect(slot.querySelector("img")!.naturalHeight).toBe(148);
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toBeInstanceOf(WebGL2RenderingContext);
  expect(slot.getBoundingClientRect().width).toBe(148);
  expect(slot.getBoundingClientRect().height).toBe(74);

  const src = slot.querySelector("img")!.src;
  render("warm");
  await expect.poll(() => view.host.querySelector("img")?.src).toBe(src);
  expect(contexts, "remounting the same painting uses its cached still").toHaveLength(1);
});

test("unmount cancels a queued thumbnail and ignores an observer callback delivered afterwards", async () => {
  let callback: IntersectionObserverCallback | undefined;
  let target: Element | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe(node: Element) {
        target = node;
      }
      disconnect = disconnect;
    },
  );
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  onTestFinished(() => {
    getContext.mockRestore();
    vi.unstubAllGlobals();
  });
  const view = mount();
  view.render(
    <PaintingThumb
      painting={{ ...living, id: "thumbnail-unmount-probe" }}
      className="block size-full"
    />,
  );
  await expect.poll(() => target !== undefined).toBe(true);
  const visible = () =>
    callback!(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  visible();
  view.unmount();
  visible();
  await task();
  expect(disconnect).toHaveBeenCalled();
  expect(getContext).not.toHaveBeenCalled();
});
