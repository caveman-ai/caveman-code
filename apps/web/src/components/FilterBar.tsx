// The filter bar a list page wears: search (⁄ or ⌘F focuses it, Esc clears, then leaves), one filter button
// in the sidebar's style whose menu holds the facets with their counts and the sort, and the picked filters
// as small removable pills. State lives in sessionStorage per page (useStoredFilters), so leaving for a
// row's page and coming back finds it as it was. The facets themselves come from lib/facets.ts.
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { SearchField } from "@caveman-app/ui/components/input";
import { Tag } from "@caveman-app/ui/components/tag";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, ListFilterIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { type ChipGroup, type Filters, isFiltering, parseFilters, picks, toggled } from "../lib/facets.ts";
import { pieces, type Range } from "../lib/fuzzy.ts";
import { landsNowhere } from "./type-to-focus.ts";

/** A page's filters, kept for the session under `key`. */
export function useStoredFilters(key: string, sorts: ReadonlyArray<string>): [Filters, (f: Filters | ((f: Filters) => Filters)) => void] {
  const [filters, setFilters] = useState<Filters>(() => parseFilters(sessionStorage.getItem(key), sorts));
  useEffect(() => {
    if (!isFiltering(filters) && filters.sort === sorts[0]) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(filters));
  }, [key, filters, sorts]);
  return [filters, setFilters];
}

/** The search box: ⁄ (where nothing else takes it) or ⌘F focuses it; Esc clears, then leaves. */
export function FilterSearch({
  value,
  onChange,
  placeholder = "Search",
  label = "Search",
  onKeyDown,
  className,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
  label?: string;
  onKeyDown?: ((e: ReactKeyboardEvent<HTMLInputElement>) => void) | undefined;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const focus = (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && landsNowhere(e.target, document)) || ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f");
      if (!focus || e.isComposing) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <span className={cn("group/search relative flex min-w-0", className)}>
      <SearchField
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.key !== "Escape") return;
          e.preventDefault();
          if (value !== "") onChange("");
          else e.currentTarget.blur();
        }}
        containerClassName="w-full"
        className="pr-8"
      />
      {value === "" ? (
        <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-background px-1 font-mono text-[10.5px] leading-[16px] text-[hsl(var(--subtle-foreground))] group-focus-within/search:opacity-0">
          /
        </kbd>
      ) : (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => (onChange(""), input.current?.focus())}
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      )}
    </span>
  );
}

/**
 * The filter button: a quiet icon that fills while anything is picked. Its menu reads as groups split by rules, no
 * headings: one row per facet naming its pick in grey ("Checks  Failing ›"; inside, each value with its count, and
 * picking keeps the menu open so several go in one visit), then Sort the same way, then Reset.
 */
export function FilterMenu({
  groups,
  filters,
  onChange,
  sorts,
  className,
}: {
  groups: ReadonlyArray<ChipGroup>;
  filters: Filters;
  onChange: (f: Filters) => void;
  /** Sort keys to their labels, the first the default. */
  sorts: Readonly<Record<string, string>>;
  className?: string;
}) {
  const picked = picks(filters);
  const sortKeys = Object.keys(sorts);
  const on = picked > 0 || filters.sort !== sortKeys[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={picked > 0 ? `Filter and sort, ${picked} filter${picked === 1 ? "" : "s"} on` : "Filter and sort"}
        title="Filter and sort"
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-lg border border-border/70 text-muted-foreground outline-none transition-colors duration-75",
          "hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground",
          on && "border-transparent bg-accent text-foreground",
          className,
        )}
      >
        <Icon icon={ListFilterIcon} className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[232px]">
        {groups.map((g) => {
          const on = filters.picked[g.key] ?? [];
          return (
            <DropdownMenuSub key={g.key}>
              <DropdownMenuSubTrigger value={on.length === 0 ? "Any" : on.length === 1 ? (g.chips.find((c) => c.value === on[0])?.label ?? "1") : `${on.length} picked`}>
                {g.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[320px] w-[220px] overflow-y-auto">
                {g.chips.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.value}
                    checked={on.includes(c.value)}
                    onCheckedChange={() => onChange(toggled(filters, g.key, c.value))}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className={cn("min-w-0 flex-1 truncate", c.count === 0 && !on.includes(c.value) && "text-muted-foreground")}>{c.label}</span>
                    <span className="tabular-nums text-muted-foreground">{c.count}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        {groups.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={sorts[filters.sort] ?? sorts[sortKeys[0] ?? ""]}>Sort</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[200px]">
            <DropdownMenuRadioGroup value={filters.sort} onValueChange={(sort) => onChange({ ...filters, sort })}>
              {Object.entries(sorts).map(([key, label]) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {on ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange({ ...filters, picked: {}, sort: sortKeys[0] ?? filters.sort })}>Reset filters and sort</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What is picked, as small removable pills ("Checks  Failing, Pending  ×"), with how many rows are left and
 * Clear. Nothing at all while nothing is picked, so an unfiltered page looks as it always did.
 */
export function ActiveFilters({
  groups,
  filters,
  onChange,
  shown,
  total,
  className,
}: {
  groups: ReadonlyArray<ChipGroup>;
  filters: Filters;
  onChange: (f: Filters) => void;
  shown: number;
  total: number;
  className?: string;
}) {
  const active = groups.flatMap((g) => {
    const on = filters.picked[g.key] ?? [];
    if (on.length === 0) return [];
    const labels = on.map((v) => g.chips.find((c) => c.value === v)?.label ?? v);
    return [{ key: g.key, label: g.label, values: labels.join(", ") }];
  });
  if (active.length === 0) return null;
  return (
    <div role="group" aria-label="Filters on" className={cn("flex min-w-0 flex-wrap items-center gap-1.5 animate-panel-in motion-reduce:animate-none", className)}>
      {active.map((a) => (
        <Tag key={a.key} asChild className="max-w-full pr-1">
          <span>
            <span className="tag-label">
              <span className="text-muted-foreground">{a.label}</span> <span className="text-foreground">{a.values}</span>
            </span>
            <button
              type="button"
              aria-label={`Remove the ${a.label} filter`}
              onClick={() => {
                const picked = { ...filters.picked };
                delete picked[a.key];
                onChange({ ...filters, picked });
              }}
              className="tag-remove ml-1 text-muted-foreground outline-none transition-colors duration-75 hover:bg-foreground/10 hover:text-foreground"
            >
              <Icon icon={Cancel01Icon} className="size-3" />
            </button>
          </span>
        </Tag>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...filters, picked: {} })}
        className="h-6 rounded-md px-1.5 text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Clear
      </button>
      <span className="ml-auto text-[12.5px] tabular-nums text-[hsl(var(--subtle-foreground))]" aria-live="polite">
        {shown} of {total}
      </span>
    </div>
  );
}

/** `text` with the query's hits marked, the way Find in chat marks its matches. */
export function Highlight({ text, ranges }: { text: string; ranges: ReadonlyArray<Range> | undefined }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  return (
    <>
      {pieces(text, ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[2px] bg-[hsl(var(--warning)/0.28)] text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
