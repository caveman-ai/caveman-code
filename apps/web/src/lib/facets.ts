// Faceted filtering for a list page: chips grouped by facet, any-of within a facet and combined across them,
// each chip counted against the others and the search, offered only where it would change the list. Pure;
// the Plugins and Review pages build their facets on it and components/FilterBar.tsx draws them.

export interface Facet<T> {
  readonly key: string;
  readonly label: string;
  /** The values an item has in this facet; none for most flags. */
  readonly values: (item: T) => ReadonlyArray<string>;
  /** Chips in this order, by value; values not listed follow by first appearance. */
  readonly order?: ReadonlyArray<string> | undefined;
  /** What a chip says; the value itself otherwise. */
  readonly labelOf?: ((value: string) => string) | undefined;
  /** At most this many chips, the most common first (authors, labels). */
  readonly max?: number | undefined;
}

/** What is picked, by facet key. */
export type Picked = Readonly<Record<string, ReadonlyArray<string>>>;

export interface Chip {
  readonly value: string;
  readonly label: string;
  /** How many the list would show with this chip on, the other facets and the search as they are. */
  readonly count: number;
}

export interface ChipGroup {
  readonly key: string;
  readonly label: string;
  readonly chips: ReadonlyArray<Chip>;
}

export interface Filters {
  readonly query: string;
  readonly picked: Picked;
  readonly sort: string;
}

export const picks = (f: Filters): number => Object.values(f.picked).reduce((n, v) => n + v.length, 0);

/** Whether anything narrows the list (the sort alone does not). */
export const isFiltering = (f: Filters): boolean => f.query.trim() !== "" || picks(f) > 0;

/** `value` toggled in facet `key`. */
export function toggled(f: Filters, key: string, value: string): Filters {
  const now = f.picked[key] ?? [];
  const next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
  const picked = { ...f.picked };
  if (next.length === 0) delete picked[key];
  else picked[key] = next;
  return { ...f, picked };
}

const has = <T>(facet: Facet<T>, item: T, want: ReadonlyArray<string> | undefined): boolean => !want || want.length === 0 || facet.values(item).some((v) => want.includes(v));

/** Whether `item` passes every facet (but `except`) as picked. */
export function passes<T>(facets: ReadonlyArray<Facet<T>>, picked: Picked, item: T, except?: string): boolean {
  return facets.every((f) => f.key === except || has(f, item, picked[f.key]));
}

/**
 * The chips, by facet. Offered from what the page holds, not what the search leaves, so chips stay put while
 * you type: a chip only where some items have it and some do not (so it would change the list), a facet
 * only when a chip is left. Counts take the other facets and the search as they are.
 */
export function chipGroups<T>(items: ReadonlyArray<T>, facets: ReadonlyArray<Facet<T>>, picked: Picked, matches: (item: T) => boolean): ReadonlyArray<ChipGroup> {
  const total = items.length;
  return facets
    .map((facet) => {
      const present = new Map<string, number>();
      for (const item of items) for (const v of facet.values(item)) present.set(v, (present.get(v) ?? 0) + 1);
      let values = [...present].filter(([, n]) => n > 0 && n < total).map(([v]) => v);
      if (facet.max !== undefined && values.length > facet.max) values = values.sort((a, b) => present.get(b)! - present.get(a)! || a.localeCompare(b)).slice(0, facet.max);
      const order = facet.order ?? [];
      values.sort((a, b) => rank(order, a) - rank(order, b));
      const chips = values.map((value) => ({
        value,
        label: facet.labelOf?.(value) ?? value,
        count: items.filter((item) => facet.values(item).includes(value) && matches(item) && passes(facets, picked, item, facet.key)).length,
      }));
      return { key: facet.key, label: facet.label, chips };
    })
    .filter((g) => g.chips.length > 0);
}

const rank = (order: ReadonlyArray<string>, v: string) => {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
};

/**
 * The picks with chips the page does not offer dropped: a category picked on one tab must not narrow another
 * where there is no chip to see or clear. Chips with a count of zero stay: they are visible, one click clears them.
 */
export function offered(f: Filters, groups: ReadonlyArray<ChipGroup>): Filters {
  const picked: Record<string, ReadonlyArray<string>> = {};
  for (const g of groups) {
    const keep = (f.picked[g.key] ?? []).filter((v) => g.chips.some((c) => c.value === v));
    if (keep.length > 0) picked[g.key] = keep;
  }
  return { ...f, picked };
}

/** The filters read back from storage; anything odd falls back to none. */
export function parseFilters(raw: string | null, sorts: ReadonlyArray<string>): Filters {
  const none: Filters = { query: "", picked: {}, sort: sorts[0] ?? "" };
  if (!raw) return none;
  try {
    const o = JSON.parse(raw) as { query?: unknown; picked?: unknown; sort?: unknown };
    const picked: Record<string, ReadonlyArray<string>> = {};
    if (o.picked && typeof o.picked === "object")
      for (const [k, v] of Object.entries(o.picked as Record<string, unknown>)) {
        const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        if (list.length > 0) picked[k] = list;
      }
    return {
      query: typeof o.query === "string" ? o.query : "",
      picked,
      sort: typeof o.sort === "string" && sorts.includes(o.sort) ? o.sort : none.sort,
    };
  } catch {
    return none;
  }
}
