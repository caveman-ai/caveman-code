// Type-to-focus, , or text pasted, where nothing takes it (after a
// click in the transcript, focus rests on the page) goes to the chat's box instead of nowhere.

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
const INTERACTIVE = 'button, a[href], summary, [role="button"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="switch"], [role="tab"], [role="slider"]';
/** Open layers own the keys: a dialog, a menu, a popover (each is mounted only while open; the message rail's listbox
 * is always there, so listboxes don't count). */
const LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]';

/** A key that types a character: one printable key with no ⌘, Ctrl or ⌥ (⇧ types capitals and symbols). */
export function typesCharacter(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">): boolean {
  return !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ";
}

/** Whether input landing on `target` reaches nothing that takes it: not a field, a control, the side panel or an open layer. */
export function landsNowhere(target: EventTarget | null, doc: Document): boolean {
  const el = target instanceof Element ? target : null;
  if (el?.closest(`${EDITABLE}, ${INTERACTIVE}, [data-side-panel], .xterm, .cm-editor`)) return false;
  return doc.querySelector(LAYER) === null;
}
