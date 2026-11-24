/*
 * Motion vocabulary for the deck (STYLE.md §8).
 *
 * One place so everything opens, arrives and leaves the same way: out of the
 * thing you clicked, fast in, faster out, on the `ease-snap` curve. The curves,
 * the duration scale and the entrances are tokens in ../styles/motion.json;
 * tailwind-preset.cjs builds the classes below from the same file.
 *
 * Rules encoded here:
 *  - Never scale from 0. Nothing in the world appears out of nothing.
 *  - Popovers scale from their trigger, not the viewport centre (modals are the
 *    exception — dialog.tsx anchors its own origin to the click).
 *  - Exit is quicker than enter. The user has already decided; get out of the way.
 *  - Arrow-key-driven highlights never transition — a fade there reads as lag.
 *  - Transform and opacity only, so every entrance runs on the compositor.
 */

import tokens from "../styles/motion.json";

type Curve = keyof typeof tokens.ease;
export type Entrance = keyof typeof tokens.enter;

/** The curves as control points, for motion/react's `ease`. */
export const easeCurve = tokens.ease as Record<Curve, [number, number, number, number]>;

/** The curves as CSS, for the Web Animations API and inline styles. None overshoots: there is no spring. */
export const ease = Object.fromEntries(
  Object.entries(easeCurve).map(([name, [a, b, c, d]]) => [name, `cubic-bezier(${a}, ${b}, ${c}, ${d})`]),
) as Record<Curve, string>;

/** The duration scale, in milliseconds. */
export const duration = tokens.duration;

/*
 * Popper-family surfaces: dropdown menu, select, popover, context menu.
 * Radix sets --radix-popper-transform-origin on every Popper content node, so
 * one class covers all of them.
 *
 * Scale only, no slide: the origin already says "this came from the trigger",
 * and a translate stacked on a scale moves the box two ways at once on a
 * front-loaded curve, which reads as a shake. The exit is a plain fade, so a
 * menu closing while another opens never jitters in place.
 *
 * `transition-none` is load-bearing. `duration-*` sets transition-duration as
 * well as the animation's, and transition-property defaults to `all`, so
 * without it every property eases, transform-origin included. Radix fills the
 * origin in a frame after mount, so the origin would glide from the centre to
 * the trigger while the box scales: the menu skids sideways as it opens.
 * Every class string below carries it for the same reason.
 */
export const popperMotion = [
  "transition-none origin-[var(--radix-popper-transform-origin)]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=open]:duration-150 data-[state=open]:ease-snap",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100 data-[state=closed]:ease-snap",
  "motion-reduce:animate-none",
].join(" ");

/*
 * Tooltips are the same shape but Radix reports data-state as
 * delayed-open / instant-open / closed, so they can't share the string above.
 * `instant-open` is the second tooltip in a hover run: it should appear with no
 * animation at all, which is what makes a whole toolbar feel fast.
 */
export const tooltipMotion = [
  "transition-none origin-[var(--radix-popper-transform-origin)]",
  "animate-in fade-in-0 zoom-in-[0.96] duration-150 ease-snap",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] data-[state=closed]:duration-100",
  "data-[state=instant-open]:animate-none",
  "data-[side=top]:slide-in-from-bottom-1 data-[side=bottom]:slide-in-from-top-1",
  "data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
  "motion-reduce:animate-none",
].join(" ");

/*
 * Hand-built Radix dialogs (add project, new workspace, What's new). Pair with
 * `ref={clickOrigin}` from dialog.tsx so they grow out of the click, and place
 * them with inset + margin, never translate: the animation owns `transform`,
 * and a translate-centered box slides sideways while it scales.
 */
export const modalMotion = [
  "transition-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200 data-[state=open]:ease-snap",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] data-[state=closed]:duration-150 data-[state=closed]:ease-snap",
  "motion-reduce:animate-none",
].join(" ");

/*
 * The command bar (⌘K, shell/GoTo.tsx). Opened by a key many times a day, and a wide box of text: it only fades,
 * like a view. Scaled, its edges travelled 18px, its text shimmered, and after a click anywhere it grew out of that
 * click. No `clickOrigin` with this one.
 */
export const paletteMotion = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=open]:ease-snap",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-75",
  "motion-reduce:animate-none",
].join(" ");

export const overlayMotion =
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 motion-reduce:animate-none";

/*
 * Rows inside a menu or command list. Walked with arrow keys dozens of times a
 * session, so the highlight is effectively instant — 75ms is enough to smooth a
 * mouse sweep and short enough that keyboard nav still feels direct.
 */
export const menuItemMotion = "transition-colors duration-75 ease-snap";

/*
 * Pressable surfaces that aren't <Button> (cards, tiles, icon triggers).
 * Transform is in the transition list on purpose — without it the press scale
 * snaps instead of settling. A trigger that just opened something stays full
 * size: Radix opens on pointerdown and measures the trigger then, so a pressed
 * (shrunken) trigger would place the menu off by a pixel or two and it would
 * jump when the press releases.
 */
export const pressMotion =
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-snap active:scale-[0.98] data-[state=open]:active:scale-100";

/*
 * Headline figures (stat cards, hero numerals). Plays once when the figure
 * mounts — a page load, or data arriving after a skeleton. A value updating in
 * place (a live refresh) does not replay it: numbers that blink on every poll
 * are noise. Needs a block or flex-item host; inline spans ignore transform.
 */
export const numberMotion = "animate-number-in motion-reduce:animate-none";

/*
 * Table rows. Opacity only, all together — never a stagger. Rows keyed by id
 * fade when they arrive (new filter, next page, fresh traffic); rows that stay
 * mounted (a refresh, the same rows re-sorted) are left alone.
 */
export const rowMotion = "animate-row-in motion-reduce:animate-none";

/*
 * Inline panels a click reveals: a selection rail, a disclosure body. Fades
 * in on open, no travel; swapping what an open panel shows does not replay it. Native <details>
 * bodies get the same animation from globals.css. Not for keyboard-walked
 * detail (span-by-span inspection) — there a fade reads as lag.
 */
export const panelMotion = "animate-panel-in motion-reduce:animate-none";

/*
 * Something whose answer just landed: data replacing a skeleton or a
 * "Loading…" line, a stored turn read back. Opacity only — the layout was
 * already there.
 */
export const arriveMotion = "animate-arrive-in motion-reduce:animate-none";

/*
 * A view swapping in place: another side-panel surface, a keyed remount. A
 * short fade, no travel. A route change plays the same entrance on the page
 * from the shell; navigation settles this one so the two never stack. A chat
 * never plays it: going to one, first show or not, it is simply there
 * (PaneFrame), and one you have seen comes back still (`settleShown`).
 */
export const viewMotion = "animate-view-in motion-reduce:animate-none";

/*
 * A message that lands without being sent from this composer: it fades in where
 * it lands, 150ms, no rise and no scale. One sent here glides up out of the
 * composer instead (apps/web Transcript usePromptRise, ); a
 * turn replayed from history is simply there.
 */
export const messageMotion = "animate-message-in motion-reduce:animate-none";

/*
 * Opening the app: the shell's chrome fades in (`shellMotion`) and the main
 * frame fades in inside it (`frameMotion`), no travel. Plays once per mount of
 * the shell.
 */
export const shellMotion = "animate-shell-in motion-reduce:animate-none";
export const frameMotion = "animate-frame-in motion-reduce:animate-none";

/*
 * Every skeleton. A view you are already on never shows one (DataState holds
 * its last answer), and a cold load that lands inside 300ms never shows one
 * either: the skeleton stays at zero opacity for that long, then fades in.
 * Deliberately no motion-reduce opt-out — the wait is not motion, and the
 * global reduced-motion rule already collapses the fade itself.
 */
export const skeletonMotion = "animate-skeleton-in";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Play an entrance from script, for an element that stays mounted while what
 * it shows changes (the page on a route change). The classes above cover
 * everything that mounts. `id` names the animation for `settleEntrances`;
 * pass one outside the entrance names to keep it out.
 */
export function enter(el: Element, name: Entrance, id = `${name}-in`): Animation | null {
  if (typeof el.animate !== "function" || reducedMotion()) return null;
  const { from, duration: length } = tokens.enter[name];
  // `offset: 0` is what makes this an entrance: a lone keyframe defaults to
  // offset 1, which would animate *to* `from` — a fade-out, then a snap back.
  return el.animate([{ ...from, offset: 0 }], { duration: tokens.duration[length as keyof typeof tokens.duration], easing: ease.snap, id });
}

const ENTRANCES = new Set(Object.keys(tokens.enter).map((name) => `${name}-in`));

/**
 * Finish every entrance under `root` (not on `root` itself), and any that
 * mounts there for the next `ms`. What a navigation paints at once is already
 * there: its rows and figures skip their entrance, and the page's own
 * entrance is the only one that plays. Returns the cleanup.
 */
export function settleEntrances(root: Element, ms = 400): () => void {
  if (typeof root.getAnimations !== "function") return () => {};
  const settle = () => {
    for (const animation of root.getAnimations({ subtree: true })) {
      const name = animation instanceof CSSAnimation ? animation.animationName : animation.id;
      if (ENTRANCES.has(name) && (animation.effect as KeyframeEffect | null)?.target !== root) animation.finish();
    }
  };
  settle();
  const observer = new MutationObserver(settle);
  observer.observe(root, { childList: true, subtree: true });
  const timer = window.setTimeout(() => observer.disconnect(), ms);
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}

/**
 * A view shown again (React's Activity: hidden, then visible) restarts every
 * CSS animation under it: display:none cancels them, showing starts them over,
 * so each message, step and card would play its entrance a second time.
 * Finish every one with an end (and `root`'s own) at once, and any that the
 * view's catch-up mounts within `ms`: what was there is simply there.
 * Loops (a spinner, a shimmer) keep running. Finishing fires `animationend`,
 * so a step waiting on its entrance settles as it would have. Returns the
 * cleanup.
 */
export function settleShown(root: Element, ms = 200): () => void {
  if (typeof root.getAnimations !== "function") return () => {};
  const settle = () => {
    for (const animation of root.getAnimations({ subtree: true })) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)) animation.finish();
    }
  };
  settle();
  const observer = new MutationObserver(settle);
  observer.observe(root, { childList: true, subtree: true });
  const timer = window.setTimeout(() => observer.disconnect(), ms);
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}
