import type { ColorTheme } from "../../state/themes.ts";

export type ThemeKind = "all" | "wallpapers" | "colors";

export function filterThemeGallery(
  themes: ReadonlyArray<ColorTheme>,
  query: string,
  kind: ThemeKind,
  category = "All styles",
  darkOnly = false,
): ReadonlyArray<ColorTheme> {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return themes.filter((theme) => {
    if (darkOnly && !theme.wallpaper?.dark) return false;
    if (kind === "wallpapers" && !theme.wallpaper) return false;
    if (kind === "colors" && theme.wallpaper) return false;
    if (category !== "All styles" && theme.wallpaper?.category !== category) return false;
    const text = [
      theme.name,
      theme.family,
      theme.source,
      theme.wallpaper?.category,
      theme.wallpaper?.tags,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Keep the current selection in sight, alongside varied wallpapers and the original look. */
export function featuredThemes(
  themes: ReadonlyArray<ColorTheme>,
  selected: string,
): ReadonlyArray<ColorTheme> {
  const ids = [
    "caveman",
    "super-visuals-dune-above-blue-sea",
    "super-visuals-midnight-currents",
    "super-visuals-mint-drift",
    "super-visuals-painted-twilight",
    "super-visuals-pixel-river-valley",
  ];
  if (!ids.includes(selected)) ids[0] = selected;
  return [...new Set(ids)]
    .flatMap((id) => themes.find((theme) => theme.id === id) ?? [])
    .slice(0, 6);
}

/** Fixed discovery order shows different styles up front and never moves cards after a pick. */
export function orderedGalleryThemes(themes: ReadonlyArray<ColorTheme>): ReadonlyArray<ColorTheme> {
  const front = [
    ...[
      "night-atmospheric-glow",
      "super-visuals-midnight-currents",
      "night-starry-night",
      "super-visuals-moonlit-acacia-desert",
      "night-steens-starlight",
      "super-visuals-crimson-moon-portal",
    ].flatMap((id) => themes.find((theme) => theme.id === id) ?? []),
    ...featuredThemes(themes, "caveman").filter((theme) => theme.wallpaper),
    ...themes.filter((theme) => theme.id === "super-visuals-sunlit-green-valley"),
  ];
  const wallpapers = [
    ...new Map(
      [...front, ...themes.filter((theme) => theme.wallpaper)].map((theme) => [theme.id, theme]),
    ).values(),
  ];
  return [...wallpapers, ...themes.filter((theme) => !theme.wallpaper)];
}
