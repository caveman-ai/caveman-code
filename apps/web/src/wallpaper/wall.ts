// Which clicks are a living wallpaper's: the ones on the bare wall, and no others.

/** A click on one of these is the page's own business: a control, or the chat box. */
const NOT_THE_WALL =
  "button, a, input, textarea, select, label, summary, [contenteditable], [role], .glass";

/**
 * Whether a click that landed on `target` landed on the wall of `box`, the wallpaper's own element, and not on
 * something of the page's standing on it. Only what is inside the box is asked: the box may itself sit in a pane
 * or a dialog that has a role, and that says nothing about where on the wall the click was.
 */
export function onTheWall(target: EventTarget | null, box: Element): boolean {
  if (!(target instanceof Element) || !box.contains(target)) return false;
  const standing = target.closest(NOT_THE_WALL);
  return standing === null || standing === box || !box.contains(standing);
}
