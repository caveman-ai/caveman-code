/**
 * A press sets a toy off (pixel.css "Toys"): pointer down, or Enter or Space,
 * on a `.px-play-hover` host gives it `data-pop`, which plays each pixel icon's
 * pop flipbook from its first frame. The attribute stays until pointer and
 * focus have both left the host, so its hover does not replay over the pop.
 * Typing in a field inside a host (the search field) sets nothing off.
 *
 * One set of listeners on the document, armed by the first PixelIcon mounted.
 */
let armed = false;

const HOST = ".px-play-hover";
const editable = (el: Element) => el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

function pop(target: EventTarget | null) {
  if (!(target instanceof Element) || editable(target)) return;
  const host = target.closest(HOST);
  if (!host || host.matches(":disabled, [aria-disabled='true'], [data-disabled]")) return;
  host.removeAttribute("data-pop");
  // Style once without it, so a second press restarts the book instead of carrying on.
  void host.getBoundingClientRect();
  host.setAttribute("data-pop", "");
}

function left(e: PointerEvent | FocusEvent) {
  if (!(e.target instanceof Element)) return;
  const host = e.target.closest("[data-pop]");
  if (!host || (e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) return;
  // :hover and :focus-visible settle after the event; check on the next frame.
  requestAnimationFrame(() => {
    if (!host.matches(":hover, :focus-visible")) host.removeAttribute("data-pop");
  });
}

export function armPops() {
  if (armed || typeof document === "undefined") return;
  armed = true;
  document.addEventListener("pointerdown", (e) => e.button === 0 && pop(e.target), true);
  document.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && !e.repeat && pop(e.target), true);
  document.addEventListener("pointerout", left, true);
  document.addEventListener("focusout", left, true);
}
