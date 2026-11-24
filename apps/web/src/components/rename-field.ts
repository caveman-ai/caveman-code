// A rename field (a chat's name in its header or the sidebar, a project's name) saves only what the person typed.
// The field opens on the title of that moment; an untouched one that saved its value on blur wrote that title back
// over a newer one that landed meanwhile (the chat's own title, made after its first turn), upstream #23171.

/** The field's onChange: the person has typed in it. */
export function markTyped(e: { readonly currentTarget: { readonly dataset: DOMStringMap } }): void {
  e.currentTarget.dataset.typed = "";
}

/** The title to save as the field closes: what was typed, trimmed; null when nothing was typed, it was cleared, or it is unchanged. */
export function renamedTo(
  field: { readonly value: string; readonly dataset: DOMStringMap },
  current: string,
): string | null {
  const title = field.value.trim();
  return field.dataset.typed !== undefined && title && title !== current ? title : null;
}
