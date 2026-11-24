// Marking up a picture before it goes to the agent: circle the button, point
// an arrow at the gap, write two words beside it. One surface for an image
// (an attachment in the box, a screenshot in the chat) and for a video, where
// the frame under the marks is the one the scrubber stands on. The bar under
// the picture is the whole tool: pen, shape, text, ink, weight, undo, redo,
// clear, then the one white button that keeps the copy (model.ts holds the
// marks, paint.ts draws them, here and in the saved copy alike).
import { Button, type ButtonProps } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { menuDescription, menuSurface } from "@caveman-app/ui/components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { Icon, ArrowDown01Icon, ArrowUpRight01Icon, Cancel01Icon, CircleIcon, Delete02Icon, ImageNotFound01Icon, PauseIcon, Pen01Icon, PlayIcon, Redo02Icon, SolidLine01Icon, SquareIcon, TextIcon, Undo02Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { formatChord, isComposing } from "../../panels/chrome.tsx";
import { clock, commit, copyName, EMPTY, fitScale, halo, INKS, isSlip, LINE, MAX_PIXELS, redo, SHAPES, toolForKey, undo, WEIGHTS, withText, type Drawn, type History, type Mark, type Point, type ShapeKind, type TextEdit, type Tool } from "./model.ts";
import { FONT_FAMILY, FONT_WEIGHT, HALO, paintMark, renderMarked, textBox } from "./paint.ts";

export interface AnnotateMedia {
  readonly kind: "image" | "video";
  /** Its bytes, held here: a picture of this origin, so its marked-up copy can always be saved. */
  readonly blob: Blob;
  /** Its file name; the copy is named after it. */
  readonly name: string;
  /** The second a video opens on: where its player stood. */
  readonly time?: number;
}

/** The mark under the pointer: a pen line still takes points. */
type Draft = { readonly kind: "pen"; readonly color: string; readonly width: number; readonly points: Point[] } | Extract<Mark, { kind: ShapeKind }>;

const SHAPE_ICONS: Readonly<Record<ShapeKind, IconSvgElement>> = { rect: SquareIcon, ellipse: CircleIcon, arrow: ArrowUpRight01Icon, line: SolidLine01Icon };
/** Room around the picture in the stage. */
const PAD = 24;
/** One frame of most video; the arrow keys step by it. */
const FRAME = 1 / 30;

export function Annotator({
  media,
  marks: marksAtOpen,
  saveLabel,
  onSave,
  onClose,
}: {
  media: AnnotateMedia;
  /** A copy opened again: the marks already on it, on the picture they were drawn on (`media`). They can be changed, or all taken off. */
  marks?: ReadonlyArray<Mark>;
  /** What the white button says: "Save" on an attachment, "Add to chat" on a picture from the chat. */
  saveLabel: string;
  /**
   * Takes the copy and its way back (null for the picture as it was, with no marks); answers with why it couldn't, or
   * null once it has it (and closes this).
   */
  onSave: (file: File, drawn: Drawn | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const url = useObjectUrl(media.blob);
  const root = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  // What opened this gets focus back: there is no Dialog.Trigger for Radix to return to.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  const [tool, setTool] = useState<Tool>("pen");
  const [shape, setShape] = useState<ShapeKind>("rect");
  const [ink, setInk] = useState<string>(INKS[0].value);
  const [weight, setWeight] = useState(1);
  const [history, setHistory] = useState<History>(() => ({ ...EMPTY, marks: marksAtOpen ?? [] }));
  const [natural, setNatural] = useState<readonly [number, number] | null>(null);
  const [box, setBox] = useState<readonly [number, number]>([0, 0]);
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  /** A video shows the frame it opened on. Until then nothing is drawn or kept: it would be on another frame. */
  const [framed, setFramed] = useState(false);
  /** The mark being drawn, between pointer down and up: painted as it grows, a step once it is let go. */
  const draft = useRef<Draft | null>(null);
  /** The words being typed, as of the last key: what a blur, a click or Save finishes. */
  const edit = useRef<TextEdit | null>(null);
  /** A video with no length yet is being read to its end to find one. */
  const measuring = useRef(false);

  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setBox([el.clientWidth, el.clientHeight]);
    observer.current = new ResizeObserver(() => setBox([el.clientWidth, el.clientHeight]));
    observer.current.observe(el);
  }, []);

  const scale = natural ? fitScale(natural[0], natural[1], box[0] - PAD * 2, box[1] - PAD * 2) : 1;
  const marks = history.marks;
  const ready = natural !== null && !broken && (media.kind === "image" || framed);

  const paint = () => {
    const canvas = overlay.current;
    if (!canvas || !natural) return;
    const [w, h] = [natural[0] * scale, natural[1] * scale];
    // As sharp as the screen, short of a canvas too large to draw (a full-page capture on a dense screen).
    const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (w * h)));
    const [cw, ch] = [Math.max(1, Math.round(w * density)), Math.max(1, Math.round(h * density))];
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(cw / natural[0], 0, 0, ch / natural[1], 0, 0);
    // Words taken up again show in their field, not under it.
    marks.forEach((mark, i) => i !== editing?.index && paintMark(ctx, mark));
    if (draft.current) paintMark(ctx, draft.current);
  };
  useLayoutEffect(paint);

  const startText = (next: TextEdit) => {
    edit.current = next;
    setEditing(next);
  };
  /** Ends the typing, if any; the marks as they stand after it. */
  const finishText = (): ReadonlyArray<Mark> => {
    const done = edit.current;
    if (!done) return marks;
    edit.current = null;
    setEditing(null);
    setHistory((h) => commit(h, withText(h.marks, done)));
    return withText(marks, done);
  };
  const step = (change: (h: History) => History) => {
    finishText();
    setHistory(change);
  };
  const pick = (next: Tool) => {
    finishText();
    setTool(next);
    if (next !== "pen" && next !== "text") setShape(next);
  };

  const pointAt = (e: { readonly clientX: number; readonly clientY: number }, size: readonly [number, number]): Point => {
    const r = overlay.current!.getBoundingClientRect();
    return [clamp(((e.clientX - r.left) / r.width) * size[0], size[0]), clamp(((e.clientY - r.top) / r.height) * size[1], size[1])];
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !natural || !ready || saving) return;
    // The click draws: it neither takes focus from the words being typed nor selects the page.
    e.preventDefault();
    const now = finishText();
    video.current?.pause();
    const at = pointAt(e, natural);
    if (tool === "text") {
      // Words under the click are taken up again; anywhere else starts new ones.
      const index = now.findLastIndex((m) => m.kind === "text" && within(at, textBox(m)));
      const old = now[index];
      startText(old?.kind === "text" ? { index, color: old.color, size: old.size, at: old.at, text: old.text } : { index: null, color: ink, size: WEIGHTS[weight]!.text / scale, at, text: "" });
      return;
    }
    // Capture keeps the stroke coming past the picture's edge; a pointer already let go has none to give.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Drawn without it: the stroke ends at the edge.
    }
    const width = Math.max(1, WEIGHTS[weight]!.stroke / scale);
    draft.current = tool === "pen" ? { kind: "pen", color: ink, width, points: [at] } : { kind: tool, color: ink, width, from: at, to: at };
    paint();
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const drawn = draft.current;
    if (!drawn || !natural) return;
    if (drawn.kind === "pen") {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const event of events.length ? events : [e.nativeEvent]) {
        const at = pointAt(event, natural);
        const last = drawn.points[drawn.points.length - 1]!;
        // A point for each pixel moved, as shown: more only makes the line slower to draw.
        if (Math.hypot(at[0] - last[0], at[1] - last[1]) >= 1 / scale) drawn.points.push(at);
      }
    } else draft.current = { ...drawn, to: pointAt(e, natural) };
    paint();
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const drawn = draft.current;
    if (!drawn) return;
    draft.current = null;
    if (e.type === "pointercancel" || (drawn.kind !== "pen" && isSlip(drawn.from, drawn.to, 4 / scale))) return paint();
    setHistory((h) => commit(h, [...h.marks, drawn]));
  };

  /** Keeps the copy; `bare` keeps the picture as it was instead, whatever is drawn on it. */
  const save = async (bare = false) => {
    const source = media.kind === "video" ? video.current : image.current;
    if (saving || !natural || !ready || !source) return;
    const typed = finishText();
    const now = bare ? [] : typed;
    setSaving(true);
    setProblem(null);
    try {
      let file: File;
      let drawn: Drawn | null = null;
      // An image with nothing drawn on it goes as it is, byte for byte.
      if (media.kind === "image" && now.length === 0) file = new File([media.blob], media.name, { type: media.blob.type });
      else {
        if (source instanceof HTMLVideoElement) await settled(source);
        const [w, h] = natural;
        const blob = await renderMarked(source, w, h, now, now.length ? scale : 1);
        file = new File([blob], copyName(media.name, now.length > 0, blob.type), { type: blob.type });
        if (now.length) {
          // What it was drawn on goes with it: an image as it came, a video's frame as it stood.
          const original = media.kind === "image" ? media.blob : await renderMarked(source, w, h, [], 1);
          drawn = { original, name: media.kind === "image" ? media.name : copyName(media.name, false, original.type), marks: now };
        }
      }
      const why = await onSave(file, drawn);
      if (why) setProblem(why);
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : "The picture couldn't be saved.");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Whether the video shows the frame it opened on yet: it has a frame to show, and is neither on its way to the second
   * its player stood on nor being read to its end for its length. Asked whenever one of those may have changed.
   */
  const onFrame = (v: HTMLVideoElement) => {
    if (!measuring.current && !v.seeking && v.readyState >= v.HAVE_CURRENT_DATA) setFramed(true);
  };
  /**
   * Sends the video to the second it opens on. Where it already stands there (its player was at the start, or at the
   * end of a recording just read to its end) no seek may follow, so the frame is asked for at once as well.
   */
  const openOn = (v: HTMLVideoElement) => {
    v.currentTime = clamp(media.time ?? 0, v.duration);
    setTime(v.currentTime);
    onFrame(v);
  };
  const seek = (to: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = clamp(to, length);
    setTime(v.currentTime);
  };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const what = media.kind === "video" ? "video" : "image";
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          ref={root}
          aria-describedby={undefined}
          // Focus the surface itself: the keys work at once, and no button wears a ring it wasn't given.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            root.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // Focus that has already gone somewhere (the box the copy was added to) stays there.
            if (opener?.isConnected && document.activeElement === document.body) opener.focus({ preventScroll: true });
          }}
          // Esc first ends what is under way (words being typed, a mark being drawn); then it closes.
          onEscapeKeyDown={(e) => {
            if (edit.current) finishText();
            else if (draft.current) {
              draft.current = null;
              paint();
            } else return;
            e.preventDefault();
          }}
          // A stray click beside the picture never throws the marks away: only Esc and the bar's × close.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            const target = e.target;
            // Words being typed and an open menu keep their keys.
            if (e.defaultPrevented || target instanceof HTMLTextAreaElement || (target instanceof Element && target.closest('[role="menu"]'))) return;
            const key = e.key.toLowerCase();
            const mod = e.metaKey || e.ctrlKey;
            if (mod && !e.altKey && key === "z") step(e.shiftKey ? redo : undo);
            else if (mod && !e.altKey && key === "y") step(redo);
            else if (mod && !e.altKey && e.key === "Enter") void save();
            else if (mod || e.altKey) return;
            else if (toolForKey(e.key)) pick(toolForKey(e.key)!);
            else if (media.kind !== "video") return;
            // The scrubber and a focused button keep their own arrow and space keys.
            else if (e.key === " " && !(target instanceof HTMLButtonElement)) togglePlay();
            else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(target instanceof HTMLInputElement)) {
              video.current?.pause();
              seek((video.current?.currentTime ?? 0) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : FRAME));
            } else return;
            e.preventDefault();
          }}
          // Solid: opened over the viewer, nothing of it shows through.
          className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none"
        >
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <Dialog.Title className="min-w-0 truncate text-[13px] font-medium text-white/90">
              <span className="sr-only">Annotate </span>
              {media.name}
            </Dialog.Title>
            {media.kind === "video" ? <span className="shrink-0 text-[12px] text-white/50">Stop on a frame, then draw on it</span> : null}
          </header>

          <div ref={measure} className="relative min-h-0 flex-1 overflow-auto">
            <div className="grid min-h-full min-w-full place-items-center" style={{ padding: PAD }}>
              {broken ? (
                <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
                  <Icon icon={ImageNotFound01Icon} strokeWidth={1.5} className="size-6 text-white/50" />
                  <div className="text-[13px] text-white/90">Couldn't open this {what}</div>
                  <div className="text-[12px] text-white/50">It isn't {media.kind === "video" ? "a video with a picture" : "an image"} this app can show.</div>
                </div>
              ) : (
                // No size until the picture says its own: it loads unseen, then takes its place at once.
                <div className={cn("relative shrink-0", !natural && "invisible overflow-hidden")} style={{ width: natural ? natural[0] * scale : 0, height: natural ? natural[1] * scale : 0 }}>
                  {url === null ? null : media.kind === "video" ? (
                    <video
                      ref={video}
                      src={url}
                      muted
                      playsInline
                      preload="auto"
                      aria-label={media.name}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (!v.videoWidth || !v.videoHeight) return setBroken(true);
                        setNatural([v.videoWidth, v.videoHeight]);
                        if (Number.isFinite(v.duration)) {
                          setLength(v.duration);
                          openOn(v);
                        } else {
                          // A recording straight from a recorder has no length until it is read to its end.
                          measuring.current = true;
                          v.currentTime = Number.MAX_SAFE_INTEGER;
                        }
                      }}
                      onDurationChange={(e) => {
                        const v = e.currentTarget;
                        if (!Number.isFinite(v.duration)) return;
                        setLength(v.duration);
                        if (!measuring.current) return;
                        measuring.current = false;
                        openOn(v);
                      }}
                      onTimeUpdate={(e) => {
                        if (measuring.current) return;
                        setTime(e.currentTarget.currentTime);
                        onFrame(e.currentTarget);
                      }}
                      onSeeked={(e) => {
                        if (measuring.current) return;
                        setTime(e.currentTarget.currentTime);
                        onFrame(e.currentTarget);
                      }}
                      onLoadedData={(e) => onFrame(e.currentTarget)}
                      onCanPlay={(e) => onFrame(e.currentTarget)}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onError={() => setBroken(true)}
                      className="block size-full select-none"
                    />
                  ) : (
                    <img
                      ref={image}
                      src={url}
                      alt={media.name}
                      draggable={false}
                      onLoad={(e) => (e.currentTarget.naturalWidth && e.currentTarget.naturalHeight ? setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight]) : setBroken(true))}
                      onError={() => setBroken(true)}
                      className="block size-full select-none"
                    />
                  )}
                  <canvas
                    ref={overlay}
                    aria-label="Draw on the picture"
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    className={cn("absolute inset-0 size-full touch-none", tool === "text" ? "cursor-text" : "cursor-crosshair")}
                  />
                  {editing ? (
                    <textarea
                      // One field per place: taking up other words is another field, focused as it mounts.
                      key={`${editing.index}:${editing.at[0]}:${editing.at[1]}`}
                      autoFocus
                      wrap="off"
                      spellCheck={false}
                      aria-label="Words on the picture"
                      value={editing.text}
                      onChange={(e) => startText({ ...editing, text: e.currentTarget.value })}
                      onBlur={finishText}
                      onKeyDown={(e) => {
                        // Enter keeps the words, as it sends a message; Shift+Enter is a new line. With ⌘ or Ctrl it
                        // keeps the copy too, as it does anywhere else on this surface.
                        if (e.key !== "Enter" || e.shiftKey || isComposing(e)) return;
                        e.preventDefault();
                        if (e.metaKey || e.ctrlKey) void save();
                        else finishText();
                      }}
                      className="absolute m-0 resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 outline-dashed outline-1 outline-offset-4 outline-white/60 [caret-color:white]"
                      style={textStyle(editing, scale)}
                    />
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {media.kind === "video" && ready ? (
            <div className="mx-auto flex w-full max-w-2xl shrink-0 items-center gap-3 px-4 pt-2">
              <BarButton label={playing ? "Pause" : "Play"} keys="Space" onClick={togglePlay} className="text-white/80 hover:bg-white/10 hover:text-white">
                <Icon icon={playing ? PauseIcon : PlayIcon} />
              </BarButton>
              <input
                type="range"
                aria-label="Frame"
                min={0}
                max={length || 0}
                step="any"
                value={time}
                onChange={(e) => {
                  video.current?.pause();
                  seek(Number(e.currentTarget.value));
                }}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
              />
              <span className="shrink-0 text-[12px] tabular-nums text-white/60">
                {clock(time)} / {clock(length)}
              </span>
            </div>
          ) : null}

          <div className="relative flex shrink-0 justify-center px-3 pb-4 pt-3">
            {problem ? (
              <div role="alert" className="absolute bottom-full left-1/2 max-w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-md bg-white/10 px-2.5 py-1.5 text-center text-[12px] text-white/90 backdrop-blur">
                {problem}
              </div>
            ) : null}
            <div role="toolbar" aria-label="Annotate" className={cn(menuSurface, "flex max-w-full items-center gap-0.5 overflow-x-auto p-1.5 [scrollbar-width:none]")}>
              <BarButton label="Pen" keys="p" pressed={tool === "pen"} disabled={!ready} onClick={() => pick("pen")}>
                <Icon icon={Pen01Icon} />
              </BarButton>
              <div className="flex shrink-0 items-center">
                <BarButton label={SHAPES.find((s) => s.kind === shape)!.label} keys={SHAPES.find((s) => s.kind === shape)!.key} pressed={tool === shape} disabled={!ready} onClick={() => pick(shape)}>
                  <Icon icon={SHAPE_ICONS[shape]} />
                </BarButton>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" aria-label="Shapes" disabled={!ready} className="h-8 w-4 rounded-md px-0">
                          <Icon icon={ArrowDown01Icon} className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top">Shapes</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent side="top" align="start" className="min-w-[176px]">
                    <DropdownMenuRadioGroup value={tool === shape ? shape : ""} onValueChange={(kind) => pick(kind as ShapeKind)}>
                      {SHAPES.map((s) => (
                        <DropdownMenuRadioItem key={s.kind} value={s.kind}>
                          <Icon icon={SHAPE_ICONS[s.kind]} />
                          {s.label}
                          {/* Its key, as the row's grey half: the check keeps the right edge. */}
                          <span className={cn(menuDescription, "touch:hidden")}>{s.key}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <BarButton label="Text" keys="t" pressed={tool === "text"} disabled={!ready} onClick={() => pick("text")}>
                <Icon icon={TextIcon} />
              </BarButton>

              <Rule />
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" aria-label={`Colour: ${INKS.find((c) => c.value === ink)?.label}`} disabled={!ready} className="h-8 gap-1 px-1.5">
                        <Swatch color={ink} />
                        <Icon icon={ArrowDown01Icon} className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Colour</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="top" align="center" className="min-w-[152px]">
                  <DropdownMenuRadioGroup value={ink} onValueChange={setInk}>
                    {INKS.map((c) => (
                      <DropdownMenuRadioItem key={c.value} value={c.value}>
                        <span className="grid size-4 shrink-0 place-items-center">
                          <Swatch color={c.value} />
                        </span>
                        {c.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" aria-label={`Weight: ${WEIGHTS[weight]!.label}`} disabled={!ready} className="h-8 gap-1 px-1.5">
                        <Stroke weight={weight} />
                        <Icon icon={ArrowDown01Icon} className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Weight</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="top" align="center" className="min-w-[152px]">
                  <DropdownMenuRadioGroup value={String(weight)} onValueChange={(i) => setWeight(Number(i))}>
                    {WEIGHTS.map((w, i) => (
                      <DropdownMenuRadioItem key={w.label} value={String(i)}>
                        <Stroke weight={i} />
                        {w.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <Rule />
              <BarButton label="Undo" keys="mod+z" disabled={history.past.length === 0} onClick={() => step(undo)}>
                <Icon icon={Undo02Icon} />
              </BarButton>
              <BarButton label="Redo" keys="mod+shift+z" disabled={history.future.length === 0} onClick={() => step(redo)}>
                <Icon icon={Redo02Icon} />
              </BarButton>
              <BarButton label="Clear" disabled={marks.length === 0} onClick={() => step((h) => commit(h, h.marks.length ? [] : h.marks))}>
                <Icon icon={Delete02Icon} />
              </BarButton>

              <Rule />
              {marksAtOpen?.length ? (
                // A copy opened again: one click puts back the picture it was drawn on.
                <Button type="button" variant="ghost" disabled={!ready || saving} onClick={() => void save(true)} className="shrink-0">
                  Revert to original
                </Button>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" disabled={!ready || saving} onClick={() => void save()} className="shrink-0">
                    {saveLabel}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="flex items-center gap-2">
                  {saveLabel}
                  <span className="text-muted-foreground">{formatChord("mod+enter")}</span>
                </TooltipContent>
              </Tooltip>
              <Dialog.Close asChild>
                <BarButton label="Close" keys="escape">
                  <Icon icon={Cancel01Icon} />
                </BarButton>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A square button of the bar, named by its tooltip; the tool in hand is the raised card. */
const BarButton = forwardRef<HTMLButtonElement, { label: string; keys?: string; pressed?: boolean; children: ReactNode } & Omit<ButtonProps, "children">>(function BarButton(
  { label, keys, pressed, children, ...props },
  ref,
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} type="button" variant={pressed ? "secondary" : "ghost"} size="icon" aria-label={label} {...(pressed === undefined ? {} : { "aria-pressed": pressed })} {...props} className={cn("shrink-0", props.className)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-2">
        {label}
        {keys ? <span className="text-muted-foreground">{formatChord(keys)}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
});

const Rule = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;

/** An ink, with an edge so white and black both show on the bar. */
const Swatch = ({ color }: { color: string }) => <span aria-hidden className="block size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-foreground/25" style={{ backgroundColor: color }} />;

/** A weight, drawn as the line it makes. */
const Stroke = ({ weight }: { weight: number }) => (
  <span aria-hidden className="grid size-4 shrink-0 place-items-center">
    <span className="block w-4 rounded-full bg-foreground" style={{ height: [2, 3.5, 6][weight] }} />
  </span>
);

/** A blob's URL while this is mounted. Made in an effect: a render that is thrown away leaves none behind. */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

/** The field words are typed in: the same face, size, colour and halo they are then painted with. */
function textStyle(edit: TextEdit, scale: number): React.CSSProperties {
  const size = edit.size * scale;
  const { w, h } = textBox(edit);
  return {
    left: edit.at[0] * scale,
    top: edit.at[1] * scale,
    // Room for the caret and the next letter.
    width: w * scale + size,
    height: h * scale,
    font: `${FONT_WEIGHT} ${size}px/${LINE} ${FONT_FAMILY}`,
    color: edit.color,
    WebkitTextStroke: `${size * HALO}px ${halo(edit.color)}`,
    paintOrder: "stroke fill",
  };
}

const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(max, 0));
const within = (p: Point, box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }) => p[0] >= box.x && p[0] <= box.x + box.w && p[1] >= box.y && p[1] <= box.y + box.h;

/** The frame a video shows once it has stopped where it was sent. */
function settled(video: HTMLVideoElement): Promise<void> {
  video.pause();
  if (!video.seeking) return Promise.resolve();
  return new Promise((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
}
