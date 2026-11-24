// Scrolling on the Review page moves only its own scroller. Element.scrollIntoView also scrolls every scrollable
// ancestor, the app shell's overflow-hidden frame included, which shoved the whole window up and left a blank band
// under it.

/** Bring `el` to the top (or middle) of the nearest Review scroller. */
export function reveal(el: Element | null | undefined, { block = "start", smooth = true }: { block?: "start" | "center"; smooth?: boolean } = {}): void {
  const scroller = el?.closest<HTMLElement>("[data-review-scroller]");
  if (!el || !scroller) return;
  const box = el.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const offset = block === "start" ? box.top - frame.top - 16 : box.top - frame.top - (frame.height - box.height) / 2;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: smooth && !still ? "smooth" : "auto" });
}
