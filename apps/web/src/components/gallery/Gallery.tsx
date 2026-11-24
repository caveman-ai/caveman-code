// A chat's images: a quiet strip of thumbnails where they belong (under the
// reply that showed them, the message that attached them, the tools that
// took them), and one viewer for all of them. Agents finish UI work with
// screenshots as proof; the chat shows them small, the viewer shows them
// whole: arrow keys walk every image in the chat, F goes full screen, and
// each can be copied, shared, saved or opened on its own. The viewer's
// interaction , apps/web/src/
// components/chat @ ab3a3cd1): wrap-around paging, click to zoom, focus back
// to the opener. An image (or a video's frame, InlineMedia.tsx) can be marked
// up from here and added to the chat's box (annotate/Annotator.tsx): what the
// agent showed, with the problem circled, is the next message's attachment.
import { Skeleton } from "@caveman-app/ui/components/skeleton";
import { cn } from "@caveman-app/ui/lib/cn";
import * as Dialog from "@radix-ui/react-dialog";
import { Icon, ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, Copy01Icon, Download04Icon, FullScreenIcon, ImageNotFound01Icon, LinkSquare02Icon, MinimizeScreenIcon, Pen01Icon, Share03Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { mediaName, mediaRef, nameFor, useImage } from "../../state/media.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import type { Artifact } from "../../state/transcript-model.ts";
import type { AnnotateMedia } from "../annotate/Annotator.tsx";
import { LazyAnnotator } from "../annotate/LazyAnnotator.tsx";
import { fileBox, watchFileBoxes } from "../compose-event.ts";
import { canShare, copyImage, downloadImage, markable, openImage, openLabel, prepare, shareImage, type ImageTarget } from "./actions.ts";

export type ImageArtifact = Extract<Artifact, { kind: "image" | "browser" }>;
export const isImage = (a: Artifact): a is ImageArtifact => a.kind === "image" || a.kind === "browser";

/** Thumbnails a strip shows before the last one says "+N". */
const MAX_TILES = 4;

// --------------------------------------------------------------------- scope

type Annotate = (media: AnnotateMedia) => void;
const Scope = createContext<{ readonly workspaceId: string | null; readonly open: ((id: string) => void) | null; readonly annotate: Annotate | null }>({ workspaceId: null, open: null, annotate: null });

/** One viewer over the images among `artifacts` (a chat's, in order); every ChatImages inside opens it. */
export function ChatGallery({ artifacts, workspaceId, children }: { artifacts: ReadonlyArray<Artifact>; workspaceId: string | null; children: ReactNode }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [marking, setMarking] = useState<AnnotateMedia | null>(null);
  const [sent, setSent] = useState(0);
  const images = useMemo(() => artifacts.filter(isImage), [artifacts]);
  // Marking up is offered where the copy has somewhere to go: this chat's box, on screen (compose-event.ts).
  const box = useSyncExternalStore(
    watchFileBoxes,
    () => fileBox(workspaceId),
    () => null,
  );
  const scope = useMemo(() => ({ workspaceId, open: setViewing, annotate: box ? setMarking : null }), [workspaceId, box]);
  // The picture is in the box, so the caret goes there too. An effect: by then the viewer has let go of the focus.
  useEffect(() => {
    if (sent) fileBox(workspaceId)?.focus();
  }, [sent, workspaceId]);
  return (
    <Scope.Provider value={scope}>
      {children}
      <Lightbox images={images} openId={viewing} workspaceId={workspaceId} onSelect={setViewing} onClose={() => setViewing(null)} />
      {marking && box ? (
        // Over the viewer, when it came from there: closing it without adding is back on the image.
        <LazyAnnotator
          media={marking}
          saveLabel="Add to chat"
          onSave={async (file, drawn) => {
            const why = await box.take(file, drawn);
            if (why) return why;
            setMarking(null);
            setViewing(null);
            setSent((n) => n + 1);
            return null;
          }}
          onClose={() => setMarking(null)}
        />
      ) : null}
    </Scope.Provider>
  );
}

/** A strip whose thumbnails open the ChatGallery around it. */
export function ChatImages(props: { images: ReadonlyArray<Artifact>; align?: "start" | "end"; className?: string }) {
  const { workspaceId, open } = useContext(Scope);
  const images = props.images.filter(isImage);
  return <ImageStrip {...props} images={images} workspaceId={workspaceId} onOpen={open} />;
}

/** Opens the ChatGallery around the caller on one image; null outside one. */
export const useOpenImage = () => useContext(Scope).open;

/** Marks up a picture (an image, a video's frame) for the chat's box; null where no box would take it. */
export const useAnnotate = () => useContext(Scope).annotate;

// --------------------------------------------------------------------- strip

export function ImageStrip({
  images,
  workspaceId,
  onOpen,
  align = "start",
  className,
}: {
  images: ReadonlyArray<ImageArtifact>;
  workspaceId: string | null;
  onOpen: ((id: string) => void) | null;
  /** A user's attachments sit on the right, over their bubble. */
  align?: "start" | "end";
  className?: string;
}) {
  if (!images.length) return null;
  const shown = images.slice(0, MAX_TILES);
  const more = images.length - shown.length;
  return (
    <div
      role="group"
      aria-label={images.length === 1 ? "Image" : `${images.length} images`}
      // One row: equal tiles up to 148px that shrink with a narrow pane, never wrap.
      className={cn(images.length === 1 ? "flex py-1" : "grid gap-1.5 py-1", align === "end" && "justify-end", className)}
      style={images.length === 1 ? undefined : { gridTemplateColumns: `repeat(${shown.length}, minmax(0, 148px))` }}
    >
      {shown.map((image, i) =>
        images.length === 1 ? (
          <SingleTile key={image.id} image={image} workspaceId={workspaceId} onOpen={onOpen} />
        ) : (
          <Tile key={image.id} image={image} workspaceId={workspaceId} onOpen={onOpen} more={i === shown.length - 1 ? more : 0} />
        ),
      )}
    </div>
  );
}

const tileClass =
  "group/tile relative block shrink-0 overflow-hidden rounded-lg border border-border bg-muted outline-none transition-colors duration-75 hover:border-input focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default";

function Tile({ image, workspaceId, onOpen, more }: { image: ImageArtifact; workspaceId: string | null; onOpen: ((id: string) => void) | null; more: number }) {
  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.(image.id)}
      title={image.title}
      aria-label={more ? `Open image: ${image.title}, and ${more} more` : `Open image: ${image.title}`}
      className={cn(tileClass, "aspect-[16/10] w-full")}
    >
      <Thumb image={image} workspaceId={workspaceId} />
      {more ? (
        <span aria-hidden className="absolute inset-0 grid place-items-center bg-black/55 text-[15px] font-medium tabular-nums text-white">
          +{more}
        </span>
      ) : null}
    </button>
  );
}

/** Natural sizes seen, by artifact, so a tile that mounts again takes its box at once. */
const sizes = new Map<string, readonly [number, number]>();
const MAX_SIZES = 500;
const SINGLE_W = 420;
const SINGLE_H = 280;

/** One image alone: larger, in its own proportions (clamped, so a full-page capture shows its top). */
function SingleTile({ image, workspaceId, onOpen }: { image: ImageArtifact; workspaceId: string | null; onOpen: ((id: string) => void) | null }) {
  const [size, setSize] = useState(() => sizes.get(image.id) ?? null);
  const box = size ? singleBox(size[0], size[1]) : { width: SINGLE_W, aspect: 16 / 10 };
  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.(image.id)}
      title={image.title}
      aria-label={`Open image: ${image.title}`}
      className={cn(tileClass, "max-w-full")}
      style={{ width: box.width, aspectRatio: box.aspect }}
    >
      <Thumb
        image={image}
        workspaceId={workspaceId}
        onSize={(w, h) => {
          sizes.set(image.id, [w, h]);
          if (sizes.size > MAX_SIZES) sizes.delete(sizes.keys().next().value!);
          setSize([w, h]);
        }}
      />
    </button>
  );
}

/** Never upscaled; between 3:5 and 12:5, at most 420 x 280. */
export function singleBox(w: number, h: number): { width: number; aspect: number } {
  const aspect = Math.min(2.4, Math.max(0.6, w / h));
  const height = Math.min(SINGLE_H, h, SINGLE_W / aspect);
  return { width: Math.max(1, Math.round(height * aspect)), aspect };
}

/** The image filling its box, read only once the box nears the view. */
/** One image filling its box (a tile, a board row's small thumbnail), loaded once it scrolls into view. */
export function Thumb({ image, workspaceId, onSize, className }: { image: ImageArtifact; workspaceId: string | null; onSize?: (w: number, h: number) => void; className?: string }) {
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const { state } = useImage(image.src, workspaceId, image.itemId, seen);
  const [broken, setBroken] = useState<string | null>(null);
  const url = state.status === "ready" ? state.url : null;
  return (
    <span ref={ref} className={cn("absolute inset-0 block", className)}>
      {state.status === "loading" ? <Skeleton className="size-full rounded-none" /> : null}
      {state.status === "error" || (url !== null && broken === url) ? (
        <span className="grid size-full place-items-center p-1.5 text-muted-foreground">
          <span className="flex w-full min-w-0 flex-col items-center gap-1">
            <Icon icon={ImageNotFound01Icon} className="size-4 shrink-0" />
            <span className="w-full truncate text-center text-[11px]">{image.title}</span>
          </span>
        </span>
      ) : url !== null ? (
        <img
          src={url}
          alt={image.alt}
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          onError={() => setBroken(url)}
          className="block size-full object-cover object-top"
        />
      ) : null}
    </span>
  );
}

/** True once the element comes within a screen of the view, and from then on. */
function useSeen<T extends Element>(): [(node: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (node: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || seen) return;
      if (typeof IntersectionObserver === "undefined") return setSeen(true);
      observer.current = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "100% 100%" });
      observer.current.observe(node);
    },
    [seen],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, seen];
}

// -------------------------------------------------------------------- viewer

/** The viewer over every image in the chat, open on `openId`; closed while it names none of them. */
export function Lightbox({
  images,
  openId,
  workspaceId,
  onSelect,
  onClose,
}: {
  images: ReadonlyArray<ImageArtifact>;
  openId: string | null;
  workspaceId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const index = openId === null ? -1 : images.findIndex((a) => a.id === openId);
  return (
    <Dialog.Root open={index >= 0} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>{index >= 0 ? <Viewer images={images} index={index} workspaceId={workspaceId} onSelect={onSelect} onClose={onClose} /> : null}</Dialog.Portal>
    </Dialog.Root>
  );
}

function Viewer({
  images,
  index,
  workspaceId,
  onSelect,
  onClose,
}: {
  images: ReadonlyArray<ImageArtifact>;
  index: number;
  workspaceId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const image = images[index]!;
  const count = images.length;
  const go = (delta: number) => onSelect(images[(index + delta + count) % count]!.id);
  const root = useRef<HTMLDivElement>(null);
  // What opened the viewer (a thumbnail) gets focus back: there is no Dialog.Trigger for Radix to return to.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = root.current;
    const sync = () => setFull(document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (el && document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  const canFull = typeof document !== "undefined" && document.fullscreenEnabled;
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen().catch(() => {});
  };
  const path = (() => {
    const ref = mediaRef(image.src);
    return ref?.kind === "file" ? ref.path : null;
  })();
  return (
    <Dialog.Content
      ref={root}
      aria-describedby={undefined}
      // Focus the viewer itself: the arrows work at once, and no button wears a ring it wasn't given.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        root.current?.focus();
      }}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        // Focus that has already gone somewhere (the box a marked-up image was added to) stays there.
        if (opener?.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowLeft" && count > 1) go(-1);
        else if (e.key === "ArrowRight" && count > 1) go(1);
        else if (e.key === "Home") onSelect(images[0]!.id);
        else if (e.key === "End") onSelect(images[count - 1]!.id);
        else if ((e.key === "f" || e.key === "F") && canFull) toggleFull();
        else return;
        e.preventDefault();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white outline-none animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none"
    >
      <Dialog.Title className="sr-only">{image.title}</Dialog.Title>
      <header className="flex h-14 shrink-0 items-center gap-3 pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-white/90">{image.title}</span>
            {count > 1 ? (
              <span aria-live="polite" className="shrink-0 text-[12px] tabular-nums text-white/50">
                {index + 1} of {count}
              </span>
            ) : null}
          </div>
          {path ? (
            <div title={path} className="truncate font-mono text-[11px] text-white/45">
              {path}
            </div>
          ) : null}
        </div>
        <ViewerActions key={image.id} target={{ src: image.src, name: mediaName(image.src, image.kind === "browser" ? "screenshot" : image.title), workspaceId, scope: image.itemId }} />
        {canFull ? (
          <ViewerButton label={full ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFull}>
            {full ? <Icon icon={MinimizeScreenIcon} /> : <Icon icon={FullScreenIcon} />}
          </ViewerButton>
        ) : null}
        <Dialog.Close asChild>
          <ViewerButton label="Close (Esc)">
            <Icon icon={Cancel01Icon} />
          </ViewerButton>
        </Dialog.Close>
      </header>
      <div className="relative min-h-0 flex-1">
        <Stage key={image.id} image={image} workspaceId={workspaceId} onClose={onClose} />
        {count > 1 ? (
          <>
            <PageButton side="left" label="Previous image (←)" onClick={() => go(-1)} />
            <PageButton side="right" label="Next image (→)" onClick={() => go(1)} />
          </>
        ) : null}
      </div>
      {count > 1 ? <Filmstrip images={images} index={index} workspaceId={workspaceId} onSelect={onSelect} /> : <div className="h-4 shrink-0" />}
    </Dialog.Content>
  );
}

/** The image fit to the stage; a click shows it at full size around the point clicked, and back. */
function Stage({ image, workspaceId, onClose }: { image: ImageArtifact; workspaceId: string | null; onClose: () => void }) {
  const { state, retry } = useImage(image.src, workspaceId, image.itemId);
  const stage = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<readonly [number, number] | null>(null);
  const [box, setBox] = useState<readonly [number, number]>([0, 0]);
  const [zoom, setZoom] = useState<{ fx: number; fy: number } | null>(null);
  const [broken, setBroken] = useState(false);
  // The stage exists only once the image is ready, so it is measured when it mounts, not when the viewer opens.
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    stage.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setBox([el.clientWidth, el.clientHeight]);
    observer.current = new ResizeObserver(() => setBox([el.clientWidth, el.clientHeight]));
    observer.current.observe(el);
  }, []);
  // Zoomed in: the point clicked comes to the middle.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !zoom || !natural) return;
    el.scrollTo({ left: zoom.fx * natural[0] - el.clientWidth / 2, top: zoom.fy * natural[1] - el.clientHeight / 2 });
  }, [zoom, natural]);
  const pad = 48;
  const zoomable = natural !== null && box[0] > 0 && (natural[0] > box[0] - pad || natural[1] > box[1] - pad);

  if (state.status === "error" || broken) {
    return (
      <div className="grid size-full place-items-center p-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
          <Icon icon={ImageNotFound01Icon} strokeWidth={1.5} className="size-6 text-white/50" />
          <div className="text-[13px] text-white/90">Couldn't load this image</div>
          <div className="text-[12px] text-white/50">{state.status === "error" ? state.message : "The file isn't an image this app can show."}</div>
          <button
            type="button"
            onClick={() => {
              setBroken(false);
              retry();
            }}
            className="mt-1 h-7 rounded-md px-2.5 text-[12.5px] text-white/80 outline-none ring-1 ring-white/15 transition-colors duration-75 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div aria-busy className="grid size-full place-items-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <span className="lucy-shimmer text-[13px] text-white/60">Loading image</span>
      </div>
    );
  }
  return (
    <div
      ref={measure}
      className={cn("size-full", zoom ? "overflow-auto" : "grid place-items-center overflow-hidden px-14 py-2")}
      onClick={(e) => !zoom && e.target === e.currentTarget && onClose()}
    >
      <div className={cn(zoom ? "grid min-h-full min-w-full place-items-center" : "contents")} style={zoom && natural ? { width: Math.max(natural[0], box[0]), height: Math.max(natural[1], box[1]) } : undefined}>
        <img
          src={state.url}
          alt={image.alt}
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={(e) => setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
          onError={() => setBroken(true)}
          onClick={(e) => {
            if (zoom) return setZoom(null);
            if (!zoomable) return;
            const r = e.currentTarget.getBoundingClientRect();
            setZoom({ fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
          }}
          className={cn(
            "block select-none",
            zoom ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full object-contain animate-in fade-in-0 zoom-in-[0.98] duration-150 ease-snap motion-reduce:animate-none",
            !zoom && zoomable && "cursor-zoom-in",
          )}
        />
      </div>
    </div>
  );
}

function Filmstrip({ images, index, workspaceId, onSelect }: { images: ReadonlyArray<ImageArtifact>; index: number; workspaceId: string | null; onSelect: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>("[aria-current=true]");
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: smooth ? "smooth" : "auto" });
  }, [index]);
  return (
    <nav aria-label="Images in this chat" className="shrink-0 px-3 pb-3 pt-2">
      <div ref={strip} className="mx-auto flex w-max max-w-full gap-1.5 overflow-x-auto p-1 [scrollbar-width:none]">
        {images.map((image, i) => (
          <button
            key={image.id}
            type="button"
            aria-current={i === index}
            aria-label={`Image ${i + 1}: ${image.title}`}
            title={image.title}
            onClick={() => onSelect(image.id)}
            className={cn(
              "relative h-12 w-[72px] shrink-0 overflow-hidden rounded-md outline-none transition-opacity duration-75 focus-visible:ring-2 focus-visible:ring-white/70",
              i === index ? "ring-2 ring-white" : "opacity-50 ring-1 ring-white/10 hover:opacity-100",
            )}
          >
            <Thumb image={image} workspaceId={workspaceId} className="bg-white/5" />
          </button>
        ))}
      </div>
    </nav>
  );
}

function PageButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white/75 outline-none transition-colors duration-75 hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 [&_svg]:size-5",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {side === "left" ? <Icon icon={ArrowLeft01Icon} /> : <Icon icon={ArrowRight01Icon} />}
    </button>
  );
}

function ViewerButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-8 shrink-0 place-items-center rounded-md text-white/70 outline-none transition-colors duration-75 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40 [&_svg]:size-4"
      {...props}
    >
      {children}
    </button>
  );
}

type Done = "copied" | "shared" | "saved" | "opened";

/** Copy, share, save, open: each says it worked on its own icon, or why not under the bar. */
function ViewerActions({ target }: { target: ImageTarget }) {
  const { client } = useRuntimeClient();
  const annotate = useAnnotate();
  // Its PNG is ready before the click: a share or a tab right after it, as Safari wants.
  const { src, workspaceId, scope, name } = target;
  useEffect(() => prepare(client, { src, workspaceId, scope, name }), [client, src, workspaceId, scope, name]);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!done && !error) return;
    const t = setTimeout(() => (setDone(null), setError(null)), done ? 1600 : 5000);
    return () => clearTimeout(t);
  }, [done, error]);
  const run = (what: Done, act: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    act().then(
      () => setDone(what),
      (e: unknown) => setError(e instanceof Error && e.message ? e.message : "That didn't work."),
    ).finally(() => setBusy(false));
  };
  const sharing = canShare();
  return (
    <>
      {annotate ? (
        <ViewerButton
          label="Annotate"
          disabled={busy}
          onClick={() =>
            run("opened", async () => {
              const blob = await markable(client, target);
              // Full screen shows this viewer alone: nothing opens over it until it is left.
              if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
              // Named for the bytes it now is: an SVG marked up is a PNG, and is attached as one.
              annotate({ kind: "image", blob, name: nameFor(target.name, blob.type) });
            })
          }
        >
          <Icon icon={Pen01Icon} />
        </ViewerButton>
      ) : null}
      <ViewerButton label={done === "copied" ? "Copied" : "Copy image"} disabled={busy} onClick={() => run("copied", () => copyImage(client, target))}>
        {done === "copied" ? <Icon icon={Tick02Icon} className="text-success" /> : <Icon icon={Copy01Icon} />}
      </ViewerButton>
      {sharing ? (
        <ViewerButton label="Share" disabled={busy} onClick={() => run("shared", () => shareImage(client, target))}>
          <Icon icon={Share03Icon} />
        </ViewerButton>
      ) : null}
      <ViewerButton label={done === "saved" ? "Saved" : "Download"} disabled={busy} onClick={() => run("saved", () => downloadImage(client, target))}>
        {done === "saved" ? <Icon icon={Tick02Icon} className="text-success" /> : <Icon icon={Download04Icon} />}
      </ViewerButton>
      <ViewerButton label={openLabel()} disabled={busy} onClick={() => run("opened", () => openImage(client, target))}>
        <Icon icon={LinkSquare02Icon} />
      </ViewerButton>
      <span aria-live="polite" className="sr-only">
        {done === "copied" ? "Image copied" : done === "saved" ? "Image saved" : ""}
      </span>
      {error ? (
        <div role="alert" className="absolute right-3 top-14 z-10 max-w-sm rounded-md bg-white/10 px-2.5 py-1.5 text-[12px] text-white/90 backdrop-blur">
          {error}
        </div>
      ) : null}
    </>
  );
}
