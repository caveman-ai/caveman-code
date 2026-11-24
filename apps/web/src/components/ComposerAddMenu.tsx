import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { fadeEdges, Keycap, menuEmpty, menuSurface } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import type { PluginSummary } from "../routes/plugins/api.ts";
import { PluginLogo } from "../routes/plugins/PluginLogo.tsx";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/*
 * The composer's "+" / "@" menu, in the look of ⌘K and Arc's command bar
 *: a header with
 * what is being looked for, rows of [mark] label — description, no section
 * headers, and the selected row saying at its right what Enter does. Its scale
 * is ⌘K's, compact search: the
 * menu row of STYLE.md section 5, 32px with a 16px mark and 13px words. It
 * opens upward over the composer; the textarea keeps focus and drives it (type
 * to filter, arrows, Enter or Tab, Esc). The "/" menu (composer-complete.ts)
 * uses the same rows with the matched letters lit, a command's arguments as a
 * grey hint, where a skill comes from on the right, and a footer naming the
 * keys. Either list shows seven and a half rows before it scrolls, so the menu
 * covers less of the chat above it.
 */

export type AddItem = {
  id: string;
  label: string;
  description?: string;
  /** Why it cannot be used here; the row shows but cannot be picked. */
  unavailable?: string;
  /** A path: label and description in mono. */
  mono?: boolean;
  /** The label's characters the query matched: lit, the rest a step dimmer (none lit: it matched by its description). */
  hits?: readonly number[];
  /** What a command takes after its name, in grey after the label ("new title"). */
  hint?: string;
  /** A grey tag at the right: where a skill comes from. */
  meta?: string;
  /** The footer's line for this row while it is active: a skill's file, a command's other names. */
  detail?: string;
  /** A plugin: its logo instead of the icon, when it has one. */
  plugin?: Pick<PluginSummary, "name" | "interface">;
} & ({ icon: IconSvgElement; engine?: never } | { /** A chat's harness: its logo instead of an icon. */ engine: string; icon?: never });
export type AddSection = { title: string; items: AddItem[] };
export type AddRow = { section: string; item: AddItem };

/**
 * Rows where every typed token is inside the label or starts a word of the
 * description ("su" finds supabase, not "pursuing"); sections kept in order.
 */
export function filterAddMenu(sections: readonly AddSection[], query: string): AddRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sections.flatMap((s) =>
    s.items
      .filter((item) => {
        const label = item.label.toLowerCase();
        const words = (item.description ?? "").toLowerCase().split(/[^a-z0-9]+/);
        return tokens.every((t) => label.includes(t) || words.some((w) => w.startsWith(t)));
      })
      .map((item) => ({ section: s.title, item })),
  );
}

/** What Enter does to a row, said at the selected row's right ("Attach", "Mention"); none where the footer names it. */
export function addVerb(item: Pick<AddItem, "id">): string {
  const id = item.id;
  if (id === "files" || id === "images") return "Choose";
  if (id === "goal") return "Set";
  if (id === "grill") return "Switch";
  if (id === "skill") return "Record";
  if (id.startsWith("plugin:") || id.startsWith("chat:")) return "Mention";
  if (id.startsWith("file:") || id.startsWith("skill:")) return "Add";
  return "";
}

export function ComposerAddMenu({
  id,
  rows,
  active,
  query,
  onHover,
  onPick,
  label = "Add to this message",
  empty,
  keys,
  column = false,
  search,
}: {
  id: string;
  rows: readonly AddRow[];
  active: number;
  query: string;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  label?: string;
  /** What an empty list says instead of "Nothing matches". */
  empty?: ReactNode;
  /** A footer with the active row's detail and these keys ([key, what it does]). */
  keys?: ReadonlyArray<readonly [string, string]>;
  /** Descriptions start in one column (the "/" menu: a list of names to scan). */
  column?: boolean;
  /** Arc's field at the top: what was typed after "@", else this line saying what can be found. */
  search?: string;
}) {
  const detail = rows[active]?.item.detail;
  const list = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  // A short pane clips what runs past its top (it is overflow-hidden): the list gives up rows to fit under it, keeping
  // two at least. Elsewhere the window's top is the edge.
  useLayoutEffect(() => {
    const el = surface.current;
    const scroller = list.current;
    if (!el || !scroller) return;
    scroller.style.maxHeight = "";
    const edge = el.closest(".pane-slot")?.getBoundingClientRect().top ?? 0;
    // From its bottom: it opens scaled up from there, so its top is still moving.
    const over = edge + 8 - (el.getBoundingClientRect().bottom - el.offsetHeight);
    if (over > 0) scroller.style.maxHeight = `${Math.max(76, scroller.offsetHeight - over)}px`;
  }, [rows]);

  useLayoutEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    fadeEdges(list.current);
  }, [active, rows, id]);

  return (
    <div
      ref={surface}
      // Keep focus in the textarea: it drives the menu.
      onPointerDown={(e) => e.preventDefault()}
      className={cn(menuSurface, "absolute inset-x-0 bottom-full z-20 mb-2 origin-bottom animate-in fade-in-0 zoom-in-[0.97] duration-150 ease-snap motion-reduce:animate-none")}
    >
      {search !== undefined ? (
        <>
          <div aria-hidden className="flex h-10 items-center gap-2 pl-3.5 pr-2.5">
            <Glyph name="search" className="shrink-0 text-muted-foreground" />
            <span className={cn("min-w-0 flex-1 truncate text-[14px]", query ? "text-foreground" : "text-[hsl(var(--subtle-foreground))]")}>{query || search}</span>
            <Keycap>esc</Keycap>
          </div>
          <div className="mx-2 h-px bg-border" />
        </>
      ) : null}
      <div ref={list} id={id} role="listbox" aria-label={label} onScroll={(e) => fadeEdges(e.currentTarget)} className="max-h-[252px] overflow-y-auto overscroll-contain p-1.5">
        {rows.length === 0 ? (
          <div className={menuEmpty}>{empty ?? <>Nothing matches “{query}”.</>}</div>
        ) : (
          rows.map((row, i) => {
            const on = i === active;
            const off = Boolean(row.item.unavailable);
            const verb = keys ? "" : addVerb(row.item);
            return (
              <div
                key={row.item.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={on}
                aria-disabled={off ? true : undefined}
                title={row.item.unavailable}
                data-active={on}
                onPointerMove={() => !on && !off && onHover(i)}
                onClick={() => onPick(i)}
                className={cn(
                  "px-play-hover flex h-8 select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors duration-75",
                  on && "bg-foreground/[0.07]",
                  off ? "cursor-default" : "cursor-pointer",
                )}
              >
                <span className={cn("grid size-4 shrink-0 place-items-center transition-colors duration-75", on ? "text-foreground" : "text-muted-foreground", off && "opacity-50")}>
                  {row.item.engine !== undefined ? (
                    <EngineLogo engine={row.item.engine} />
                  ) : row.item.plugin?.interface.logo ? (
                    <PluginLogo plugin={row.item.plugin} size="xs" />
                  ) : (
                    <Icon icon={row.item.icon} className="size-4 shrink-0" />
                  )}
                </span>
                <span className={cn("shrink-0", column && "min-w-[8.5rem]", off ? "text-muted-foreground" : "text-foreground", row.item.mono && "font-mono text-[12px]")}>
                  {row.item.hits && query && !off ? <Lit text={row.item.label} hits={row.item.hits} /> : row.item.label}
                  {row.item.hint ? <span className="ml-1.5 font-normal text-[hsl(var(--subtle-foreground))]">{row.item.hint}</span> : null}
                </span>
                {row.item.description ? (
                  <span className={cn("min-w-0 truncate text-muted-foreground", row.item.mono && "font-mono text-[12px]")}>
                    {column ? null : <span aria-hidden>— </span>}
                    {row.item.description}
                  </span>
                ) : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-[12px] text-[hsl(var(--subtle-foreground))]">
                  {off ? (
                    <span>{row.item.unavailable}</span>
                  ) : on ? (
                    <>
                      {verb ? <span className="text-foreground">{verb}</span> : null}
                      <Keycap className="text-foreground">↵</Keycap>
                    </>
                  ) : row.item.meta ? (
                    <span className="max-w-[12rem] truncate">{row.item.meta}</span>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
      {keys ? (
        <div className="flex h-8 items-center gap-3 border-t border-border px-3.5 text-[12px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">{detail}</span>
          {keys.map(([key, what]) => (
            <span key={key} className="flex shrink-0 items-center gap-1.5">
              <Keycap>{key}</Keycap>
              {what}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The label with the matched letters lit and the rest a step dimmer: what you typed stands out as you type it. */
function Lit({ text, hits }: { text: string; hits: readonly number[] }) {
  const lit = new Set(hits);
  const runs: Array<{ on: boolean; text: string }> = [];
  for (let i = 0; i < text.length; i++) {
    const on = lit.has(i);
    if (runs.at(-1)?.on === on) runs.at(-1)!.text += text[i];
    else runs.push({ on, text: text[i]! });
  }
  return (
    <>
      {runs.map((r, i) => (
        <span key={i} className={r.on ? "text-foreground" : "text-foreground/60"}>
          {r.text}
        </span>
      ))}
    </>
  );
}
