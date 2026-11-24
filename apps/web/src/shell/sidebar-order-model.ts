/** Stored rows still present, then newly discovered rows in their default order. */
export function arrangedSidebarRows(ids: readonly string[], saved: readonly string[]): string[] {
  const available = new Set(ids);
  return [...new Set([...saved.filter((id) => available.has(id)), ...ids])];
}

/** Reorder visible slots without moving hidden rows, including before any order has been saved. */
export function mergeSidebarRows(
  fullOrder: readonly string[],
  visibleOrder: readonly string[],
  next: readonly string[],
): string[] {
  const visible = new Set(visibleOrder);
  let at = 0;
  return fullOrder.map((id) => (visible.has(id) ? next[at++]! : id));
}
