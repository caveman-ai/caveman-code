import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowUpRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { blobOf, pageHost, type Controller, type LiveSource } from "../../../panels/live/source.ts";
import { Card } from "./Card.tsx";

// A screen the agent works on outside the chat (its browser, the workspace
// computer), as a live thumbnail in the Overview: a few frames a second while
// the Overview shows, so you can glance at what it is looking at. A click
// opens the full view, where you can take over.

const THUMB_FPS = 2;

const onVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const windowVisible = () => document.visibilityState === "visible";

export function ScreenCard<S extends { readonly controller: Controller; readonly url?: string; readonly title?: string; readonly loading?: boolean }>({
  title,
  source,
  active,
  engine,
  onOpen,
}: {
  title: string;
  source: LiveSource<S>;
  /** The Overview is the tab on screen: only then does the thumbnail stream. */
  active: boolean;
  engine: string;
  onOpen: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<S | null>(() => source.state);
  const [painted, setPainted] = useState(false);
  const [status, setStatus] = useState<"live" | "unavailable" | null>(null);
  const streaming = useSyncExternalStore(onVisibility, windowVisible, () => true) && active;

  useEffect(() => source.onState(setState), [source]);

  // The newest frame wins; one decode at a time.
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let stopped = false;
    let busy = false;
    let next: Parameters<Parameters<typeof source.onFrame>[0]>[0] | null = null;
    const paint = (f: NonNullable<typeof next>) => {
      busy = true;
      createImageBitmap(blobOf(f))
        .then((bitmap) => {
          if (stopped) return;
          if (el.width !== f.width || el.height !== f.height) {
            el.width = f.width;
            el.height = f.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          setPainted(true);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          const queued = next;
          next = null;
          if (queued && !stopped) paint(queued);
        });
    };
    const off = source.onFrame((f) => (busy ? (next = f) : paint(f)));
    return () => {
      stopped = true;
      off();
    };
  }, [source]);

  useEffect(() => {
    if (!streaming) return;
    let current = true;
    const holder = {};
    source.start(holder, THUMB_FPS).then(
      (r) => current && setStatus(r),
      () => current && setStatus("unavailable"),
    );
    return () => {
      current = false;
      source.stop(holder);
    };
  }, [source, streaming]);

  const where = state?.url ? pageHost(state.url) : null;
  const who = state?.controller === "user" ? "You're in control" : state?.controller === "agent" ? `${engine} is using it` : null;
  return (
    <Card
      title={title}
      defaultOpen
      aside={
        who ? (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", state?.controller === "agent" ? "bg-success" : "bg-target")} />
            {who}
          </span>
        ) : null
      }
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open the ${title.toLowerCase()}${state?.title ? `: ${state.title}` : ""}`}
        className="group/screen mb-0.5 mt-0.5 block w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative block aspect-[16/10] overflow-hidden rounded-lg border border-border bg-muted">
          <canvas
            ref={canvas}
            aria-hidden
            className={cn("block size-full object-cover object-top transition-[opacity,transform] duration-300 ease-snap group-hover/screen:scale-[1.015]", painted ? "opacity-100" : "opacity-0")}
          />
          {!painted ? (
            <span className="absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">{status === "unavailable" ? "No picture from this computer" : "Connecting…"}</span>
          ) : null}
          {state?.loading ? (
            <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-foreground/10">
              <span className="block h-full w-1/3 animate-[screen-load_1.1s_ease-in-out_infinite] bg-foreground/60" />
            </span>
          ) : null}
        </span>
        {where || state?.title ? (
          <span className="flex h-9 items-center gap-2 px-1">
            <span className="min-w-0 flex-1">
              {state?.title ? <span className="block truncate text-[12.5px] leading-4 text-foreground">{state.title}</span> : null}
              {where ? <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">{where}</span> : null}
            </span>
            <Icon icon={ArrowUpRight01Icon} className="size-3.5 shrink-0 text-muted-foreground transition-[opacity,transform] duration-150 ease-snap group-hover/screen:-translate-y-px group-hover/screen:translate-x-px group-hover/screen:text-foreground" />
          </span>
        ) : null}
      </button>
    </Card>
  );
}
