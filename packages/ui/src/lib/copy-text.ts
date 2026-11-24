/**
 * Put text on the clipboard: the async clipboard where the page may use it, else the older `execCommand` path.
 * A page served over plain http from another address (a LAN or tailnet IP) has no `navigator.clipboard`, so
 * Copy did nothing there (T3 #25246). Rejects when neither copies.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.");
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
}
