// Streamed words, let out at the stream's pace and faded in one by one.
// using compact styling.
// A provider sends text in uneven bursts: thirty characters, a pause, two hundred, a pause. Shown as it
// arrives, the reply lurches. Here the reveal runs a little behind the wire and closes on what has arrived
// with an exponential catch-up, never slower than a floor speed, stopping only at whole words; each word
// the reveal lets out is a new span that fades in. Words already on screen keep their span, so nothing
// fades twice. Text already there when a view opens is shown whole. Reduced motion shows text as it
// arrives, unfaded.
import * as React from "react";
import { useStreamView } from "./stream-view.tsx";

/** How long one word takes to fade in. */
export const WORD_FADE_MS = 150;
/** The slowest the reveal goes, in characters a second, so the tail of a finished reply never crawls out. */
export const REVEAL_MIN_CPS = 90;
/** The reveal closes on what has arrived over about this long: a steady stream runs this far behind the wire and a burst spreads over it. */
export const REVEAL_CATCHUP_S = 0.22;
/** How long a word still being written is held back once the reveal has caught up to it; past this the stream paused on it, so it shows as is. */
export const REVEAL_HOLD_MS = 150;
/** Parsing markdown is main-thread work, unlike the compositor's fades: at most one commit per this long, however fast the display. */
export const REVEAL_FRAME_MS = 30;

const isSpace = (code: number) => code === 32 || code === 10 || code === 9 || code === 13;

/**
 * Where to stop revealing `text` for a reveal that has reached `at`: the end of the word `at` falls in, so a
 * word is never shown half written. A stream still mid-word holds back at the last whole word; a finished one
 * runs out.
 */
export function revealEnd(text: string, at: number, streaming: boolean): number {
  for (let i = Math.max(0, Math.ceil(at)); i < text.length; i++) if (isSpace(text.charCodeAt(i))) return i;
  if (!streaming) return text.length;
  let end = text.length;
  while (end > 0 && !isSpace(text.charCodeAt(end - 1))) end--;
  return end;
}

/** The reveal's next position after `dt` seconds with `length` characters arrived: an exponential catch-up on the backlog, never below the floor speed. */
export function revealStep(position: number, length: number, dt: number): number {
  const backlog = length - position;
  return Math.min(length, position + Math.max(REVEAL_MIN_CPS * dt, backlog * (1 - Math.exp(-dt / REVEAL_CATCHUP_S))));
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pageHidden = () => typeof document !== "undefined" && document.hidden;
const subscribeMotion = (changed: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
};
const serverMotion = () => false;
const useReducedMotion = () => React.useSyncExternalStore(subscribeMotion, reducedMotion, serverMotion);

/**
 * Pace new output: `text` as far as the reveal has got, and whether it is still behind. `revealOnMount`: the
 * reply arrived while the reader watched (its first chunk, or the whole of one that finished before its first
 * paint), so it plays in from nothing; a reply already there when the view opened is history and shows whole.
 * A stream that ends ahead of the reveal still finishes at pace. A hidden page catches up at once.
 */
export function usePacedText(text: string, streaming: boolean, revealOnMount = streaming, enabled = true): { text: string; revealing: boolean } {
  const view = useStreamView();
  const previousView = React.useRef(view);
  const reduce = useReducedMotion();
  const active = enabled && !reduce;
  const shown = React.useRef(revealOnMount ? 0 : text.length);
  const pacing = React.useRef(streaming || revealOnMount);
  const latest = React.useRef({ text, streaming });
  latest.current = { text, streaming };
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);

  if (previousView.current !== view) {
    previousView.current = view;
    shown.current = text.length;
  }
  if (streaming) pacing.current = true;
  if (!active || !pacing.current || pageHidden()) shown.current = text.length;
  shown.current = Math.min(shown.current, text.length);
  const behind = shown.current < text.length;

  React.useEffect(() => {
    if (!active || !pacing.current) return;
    if (!behind) {
      if (!streaming) pacing.current = false;
      return;
    }
    let position = shown.current;
    let last = performance.now();
    let heldText = "";
    let heldAt = 0;
    let frame = 0;
    const finishHidden = () => {
      if (!pageHidden()) return;
      cancelAnimationFrame(frame);
      shown.current = latest.current.text.length;
      rerender();
    };
    const tick = (now: number) => {
      const { text, streaming } = latest.current;
      if (pageHidden()) return finishHidden();
      if (now - last < REVEAL_FRAME_MS) {
        frame = requestAnimationFrame(tick);
        return;
      }
      position = revealStep(position, text.length, (now - last) / 1000);
      last = now;
      const end = revealEnd(text, position, streaming);
      if (end > shown.current) {
        shown.current = end;
        rerender();
      }
      // Caught up with what has arrived: a word still being written waits a beat, then shows as it is.
      if (position >= text.length && shown.current < text.length) {
        if (heldText !== text) {
          heldText = text;
          heldAt = now;
        }
        if (now - heldAt >= REVEAL_HOLD_MS) {
          shown.current = text.length;
          rerender();
        }
      }
      // Let the caught-up render cancel the loop. A new chunk can be batched with the rerender above,
      // leaving `behind` true and this effect alive; it still needs a frame even though this tick caught up.
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", finishHidden);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", finishHidden);
    };
    // New chunks move the target without restarting the reveal's clock.
  }, [active, streaming, behind]);

  return { text: behind ? text.slice(0, shown.current) : text, revealing: behind };
}

/**
 * Whether a reply's words may fade: while it streams or is being let out, and for one fade after, so the last
 * word finishes. Outside that the spans come off: an animation replays whenever its element is hidden and
 * shown again, and a finished reply folded away and reopened must not fade in all over again.
 */
export function useWordFading(active: boolean, fadeMs = WORD_FADE_MS): boolean {
  const reduce = useReducedMotion();
  const [lingering, setLingering] = React.useState(false);
  React.useEffect(() => {
    if (active) return void setLingering(true);
    const timer = window.setTimeout(() => setLingering(false), fadeMs);
    return () => window.clearTimeout(timer);
  }, [active, fadeMs]);
  return !reduce && (active || lingering);
}

/**
 * Marks every word on screen under `root` as already faded in. Showing a `display: none` subtree (a pane
 * React's Activity hid) restarts its CSS animations, so a reply still fading when it was hidden would fade in
 * whole again. Words let out after this are new spans and fade as usual.
 */
export function settleWordFades(root: ParentNode): void {
  for (const word of root.querySelectorAll("[data-word-fade]:not([data-word-settled])")) word.setAttribute("data-word-settled", "");
}

// The few hast shapes the plugin touches (react-markdown's tree), so this package needs no @types/hast of its own.
type Position = { position?: { start?: { offset?: number } } };
type HastText = { type: "text"; value: string } & Position;
type HastElement = { type: "element"; tagName: string; properties: Record<string, unknown>; children: HastNode[] } & Position;
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };
type HastRoot = { type: "root"; children: HastNode[] };

/** Text here is not prose (code, a drawing) or is read whole by what renders it (a link, a key). */
const UNFADED_TAGS = new Set(["pre", "svg", "math", "annotation", "kbd"]);
// Keep semantic content intact: InlineCode reads a string to render file chips.
const FADE_AS_ONE = new Set(["a", "code", "img"]);

/**
 * One ledger per reply. Keep each source position's first paint time,
 * including across reparses and across the reply regrouping its blocks (a
 * definition arriving parses it whole). A remounted span resumes its remaining
 * fade; a settled position is fully opaque. No timers or React state per word.
 */
export function createWordFade(settledThrough = 0, now = () => performance.now()) {
  const born = new Map<number, number>();
  const properties = (offset: number): Record<string, unknown> => {
    if (offset < settledThrough) return { dataWordFade: "", dataWordSettled: "" };
    const at = now();
    let start = born.get(offset);
    if (start === undefined) born.set(offset, (start = at));
    const age = Math.max(0, at - start);
    return age >= WORD_FADE_MS
      ? { dataWordFade: "", dataWordSettled: "" }
      : { dataWordFade: "", dataWordBorn: start };
  };
  return {
    /** The rehype plugin; its option is where the parsed text starts in the reply (`[fade.plugin, start]` for a block). */
    plugin: (start = 0) => wordFadeTree((offset) => properties(start + offset)),
    /** Everything before `length` is faded in. */
    settle(length: number) {
      if (length <= settledThrough) return;
      settledThrough = length;
      for (const offset of born.keys()) if (offset < length) born.delete(offset);
    },
  };
}
export type WordFade = ReturnType<typeof createWordFade>;

/** Align even a reparented word with its original fade clock, before paint. */
export function resumeWordFades(root: ParentNode): void {
  const now = performance.now();
  for (const word of root.querySelectorAll<HTMLElement>("[data-word-born]:not([data-word-settled])")) {
    const age = Math.max(0, now - Number(word.dataset.wordBorn));
    if (age >= WORD_FADE_MS) word.setAttribute("data-word-settled", "");
    else for (const animation of word.getAnimations()) if (animation instanceof CSSAnimation && animation.animationName === "word-fade-in") animation.currentTime = age;
  }
}

/**
 * Wraps every word in a span that fades in as it is added to the page. Stateless: a word already on screen
 * keeps its element however often its block re-renders (React keys count element children by position), so
 * it never fades twice, and a word the reveal has just let out is a new element, so it does. That holds only
 * because every word gets a span: a bare word would shift the keys of every word after it and fade them again.
 */
export function rehypeWordFade() {
  return wordFadeTree(() => ({ dataWordFade: "" }));
}

function wordFadeTree(properties: (offset: number) => Record<string, unknown>) {
  let fallbackOffset = 0;
  const wrap = (text: HastText): HastNode[] => {
    const start = text.position?.start?.offset ?? fallbackOffset;
    fallbackOffset = start + text.value.length;
    return [...text.value.matchAll(/\s+|\S+/gu)].map((match) => /^\s/u.test(match[0])
      ? { type: "text", value: match[0] }
      : { type: "element", tagName: "span", properties: properties(start + match.index), children: [{ type: "text", value: match[0] }] });
  };
  const walk = (parent: HastRoot | HastElement) => {
    const children: HastNode[] = [];
    for (const child of parent.children) {
      if (child.type === "text") children.push(...wrap(child as HastText));
      else {
        const element = child as HastElement;
        if (child.type === "element" && FADE_AS_ONE.has(element.tagName)) {
          children.push({ type: "element", tagName: "span", properties: properties(element.position?.start?.offset ?? fallbackOffset++), children: [child] });
        } else {
          if (child.type === "element" && !UNFADED_TAGS.has(element.tagName)) walk(element);
          children.push(child);
        }
      }
    }
    parent.children = children;
  };
  return (tree: HastRoot) => {
    fallbackOffset = 0;
    walk(tree);
  };
}
