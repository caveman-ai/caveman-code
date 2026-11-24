// ), packages/shared/src/Array.ts @ ab3a3cd1.
export function copySorted<T>(
  values: ReadonlyArray<T>,
  compareFn?: (left: T, right: T) => number,
): T[] {
  return [...values].sort(compareFn);
}
