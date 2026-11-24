// ⌘K runs things too, not only goes places: light or dark, a colour theme,
// text size, the sidebar. One palette, not a second one for commands (a
// common complaint about editors that have both). Shown once something is
// typed, like Settings sections, so the empty list stays short.
import type { Settings } from "@caveman-app/session-protocol";
import { matches } from "../lib/search.ts";
import type { SettingsPatch } from "../state/settings-saves.ts";
import { allThemes } from "../state/themes.ts";

export interface GoToAction {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** A Settings change, or the sidebar. */
  readonly act: { readonly settings: SettingsPatch } | { readonly sidebar: "toggle" } | { readonly report: true };
}

const SIZES = ["small", "default", "large", "larger"] as const satisfies ReadonlyArray<NonNullable<Settings["text_size"]>>;

/** ⌘K's filters, the strip under its field: everything, or one kind of row. */
export const GOTO_FILTERS = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "actions", label: "Actions" },
  { id: "pages", label: "Pages" },
  { id: "settings", label: "Settings" },
] as const;
export type GoToFilter = (typeof GOTO_FILTERS)[number]["id"];
/** The kind of row a filter keeps. */
export type GoToGroup = Exclude<GoToFilter, "all">;

/** The filter one step left (-1) or right (1) of `from`, going round at either end. */
export function stepFilter(from: GoToFilter, by: -1 | 1): GoToFilter {
  const n = GOTO_FILTERS.length;
  return GOTO_FILTERS[(GOTO_FILTERS.findIndex((f) => f.id === from) + by + n) % n]!.id;
}

/**
 * The actions whose words hold every word of `query`; none before Settings arrive. An empty query has none either,
 * unless `browse` is set (the Actions filter with nothing typed), which lists every one but the colour themes.
 */
export function goToActions(query: string, settings: Settings | null, sidebarHidden: boolean, sidebarKeys: string, browse = false): ReadonlyArray<GoToAction> {
  if ((!query.trim() && !browse) || !settings) return [];
  const theme = settings.theme ?? "system";
  const size = SIZES.indexOf(settings.text_size ?? "default");
  const candidates: Array<GoToAction & { readonly words: string }> = [
    ...(theme !== "light" ? [{ key: "theme:light", label: "Light mode", description: "Switch the app to light", words: "theme appearance bright day", act: { settings: { theme: "light" as const } } }] : []),
    ...(theme !== "dark" ? [{ key: "theme:dark", label: "Dark mode", description: "Switch the app to dark", words: "theme appearance night", act: { settings: { theme: "dark" as const } } }] : []),
    ...(theme !== "system"
      ? [{ key: "theme:system", label: "Follow the system's light or dark", description: "Light or dark as your computer is set", words: "theme appearance auto mode", act: { settings: { theme: "system" as const } } }]
      : []),
    ...(size < SIZES.length - 1 ? [{ key: "text:bigger", label: "Bigger text", description: `Text size ${SIZES[size + 1]}`, words: "font larger zoom in increase", act: { settings: { text_size: SIZES[size + 1]! } } }] : []),
    ...(size > 0 ? [{ key: "text:smaller", label: "Smaller text", description: `Text size ${SIZES[size - 1]}`, words: "font zoom out decrease", act: { settings: { text_size: SIZES[size - 1]! } } }] : []),
    ...(size !== 1 ? [{ key: "text:default", label: "Default text size", description: "Text back to its usual size", words: "font reset zoom", act: { settings: { text_size: "default" as const } } }] : []),
    {
      key: "sidebar",
      label: sidebarHidden ? "Show sidebar" : "Hide sidebar",
      description: `Projects and chats (${sidebarKeys})`,
      words: "toggle collapse panel",
      act: { sidebar: "toggle" },
    },
    // Help > Report a Problem… in the browser too, which has no Help menu (shell/ReportProblem.tsx).
    { key: "report", label: "Report a problem", description: "Send the team the logs, after you've read them", words: "bug feedback crash error issue broken help logs support", act: { report: true } },
  ];
  // A colour theme only when its own name is typed ("dracula", "nord theme"): "theme" alone would list all twenty.
  const named = allThemes(settings.custom_themes ?? [])
    .filter((t) => t.id !== (settings.color_theme ?? "caveman"))
    .filter((t) => query.toLowerCase().split(/\s+/).some((w) => w && `${t.name} ${t.family}`.toLowerCase().includes(w)))
    .map((t) => ({ key: `color:${t.id}`, label: `${t.name} theme`, description: "Colour theme", words: `colour color palette ${t.family}`, act: { settings: { color_theme: t.id } } }));
  return [...candidates, ...named].filter((a) => !query.trim() || matches(query, `${a.label} ${a.description} ${a.words}`)).map(({ words: _, ...a }) => a);
}

/**
 * Arc's inline completion: when the top row's name begins with what was typed, the rest of it, to show typed ahead
 * and selected in the field (Enter opens that row; → or End keeps the words). Nothing when it does not.
 */
export function completion(query: string, label: string): string {
  if (!query.trim() || !label.toLowerCase().startsWith(query.toLowerCase())) return "";
  return label.slice(query.length);
}

/**
 * Whether New chat leads the list (and Enter starts it): something is typed, the search has answered, and nothing
 * matched it by its words. A chat found only by meaning is a guess; it stays below, one arrow away.
 */
export function newChatLeads(query: string, settled: boolean, rows: ReadonlyArray<{ readonly byMeaning?: boolean }>): boolean {
  return query.trim() !== "" && settled && rows.every((r) => r.byMeaning === true);
}

/**
 * The list as its sections ("Top hit", "This chat", "Recent", "Go to"): each run of rows under one name, every row
 * with its place in the whole list, which is what the arrows step through.
 */
export function sections<R extends { readonly section: string }>(rows: ReadonlyArray<R>): ReadonlyArray<{ readonly name: string; readonly rows: ReadonlyArray<{ readonly row: R; readonly index: number }> }> {
  const out: Array<{ name: string; rows: Array<{ row: R; index: number }> }> = [];
  for (const [index, row] of rows.entries()) {
    const last = out[out.length - 1];
    if (last && last.name === row.section) last.rows.push({ row, index });
    else out.push({ name: row.section, rows: [{ row, index }] });
  }
  return out;
}
