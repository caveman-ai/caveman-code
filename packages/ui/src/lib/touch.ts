/**
 * A screen with no hover: a phone or a tablet. Focusing a text field there raises the keyboard over whatever just
 * opened, so a picker's search waits for a tap instead of taking focus on open.
 */
export const touchScreen = (): boolean => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;
