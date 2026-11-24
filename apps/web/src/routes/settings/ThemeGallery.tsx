import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { SearchField } from "@caveman-app/ui/components/input";
import { Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import type { ThemePalette } from "@caveman-app/session-protocol";
import { useRef, useState, type KeyboardEvent } from "react";
import { palette, themeHalf, type ColorTheme, type ThemeAppearance } from "../../state/themes.ts";
import { WALLPAPER_CREDIT, WALLPAPERS } from "../../state/wallpaper-catalog.ts";
import {
  featuredThemes,
  filterThemeGallery,
  orderedGalleryThemes,
  type ThemeKind,
} from "./theme-gallery-model.ts";

const CAVEMAN_PREVIEW: Record<ThemeAppearance, ThemePalette> = {
  dark: palette({
    shell: "#09090a",
    panel: "#121213",
    text: "#e3e4e6",
    dim: "#959597",
    accent: "#e3e4e6",
    red: "#e5636a",
    orange: "#e69500",
    yellow: "#f0a12e",
    green: "#3ecf7a",
    cyan: "#8cbcfb",
    blue: "#1a8cf5",
    purple: "#9a7ce8",
    pink: "#d45d94",
  }),
  light: palette({
    shell: "#f5f5f5",
    panel: "#ffffff",
    text: "#1f1f21",
    dim: "#5c5c5e",
    accent: "#1f1f21",
    red: "#c8323b",
    orange: "#c07f00",
    yellow: "#995b13",
    green: "#1fa06b",
    cyan: "#519dfa",
    blue: "#0077e6",
    purple: "#9a7ce8",
    pink: "#d45d94",
  }),
};

type Props = {
  themes: ReadonlyArray<ColorTheme>;
  selected: string;
  wanted: ThemeAppearance;
  error: string | null;
  onSelect: (id: string) => void;
  onRemove: (theme: ColorTheme) => void;
  wallpaperOnly?: boolean;
  matchingWallpaper?: boolean;
};

/** The same selection and save path in a small shelf and a spacious, searchable gallery. */
export function ThemeGallery(props: Props) {
  const wallpaperOnly = props.wallpaperOnly ?? false;
  const description = wallpaperOnly
    ? "Choose any picture. Theme colors stay."
    : props.matchingWallpaper === false
      ? "Theme colors only. Your wallpaper stays."
      : "Wallpapers and matching colors.";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ThemeKind>("all");
  const [category, setCategory] = useState("All styles");
  const [darkOnly, setDarkOnly] = useState(false);
  const galleryThemes = orderedGalleryThemes(props.themes);
  const shown = filterThemeGallery(
    galleryThemes,
    query,
    wallpaperOnly ? "wallpapers" : kind,
    category,
    darkOnly,
  );
  const featured = featuredThemes(props.themes, props.selected);
  const categories = [...new Set(WALLPAPERS.map((art) => art.category))];
  return (
    <>
      {wallpaperOnly ? (
        <Button ref={trigger} variant="ghost" onClick={() => setOpen(true)}>
          View all <span className="text-muted-foreground">{WALLPAPERS.length}</span>
        </Button>
      ) : (
        <div className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-[12.5px] text-muted-foreground">{description}</p>
            <Button ref={trigger} variant="ghost" onClick={() => setOpen(true)}>
              View all <span className="text-muted-foreground">{props.themes.length}</span>
            </Button>
          </div>
          <ThemeGrid {...props} themes={featured} compact />
          <ArtworkCredit className="mt-4" />
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          size="wide"
          className="h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
        >
          <div className="border-b border-border px-6 pb-4 pt-6 max-sm:px-4">
            <DialogHeader>
              <DialogTitle className="text-[22px] font-medium tracking-[-0.02em]">
                {wallpaperOnly ? "Wallpapers" : "Themes"}
              </DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              {!wallpaperOnly ? (
                <div className="flex gap-1" aria-label="Theme types">
                  {(
                    [
                      ["all", "All"],
                      ["wallpapers", "Wallpapers"],
                      ["colors", "Color themes"],
                    ] as const
                  ).map(([id, label]) => (
                    <Button
                      key={id}

                      variant="ghost"
                      aria-pressed={kind === id}
                      className={cn(kind === id && "bg-accent text-foreground")}
                      onClick={() => {
                        setKind(id);
                        setCategory("All styles");
                        setDarkOnly(false);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              ) : null}
              <SearchField
                aria-label={wallpaperOnly ? "Search wallpapers" : "Search themes"}
                placeholder={
                  wallpaperOnly
                    ? "Find a color, style, or picture…"
                    : "Find a color, style, or theme…"
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                containerClassName="w-64 max-sm:w-full"
              />
            </div>
            {kind !== "colors" ? (
              <div className="mt-3 flex flex-wrap gap-1" aria-label="Wallpaper styles">
                <Button
                  variant="ghost"
                  aria-pressed={darkOnly}
                  className={cn("text-[12px]", darkOnly && "bg-accent text-foreground")}
                  onClick={() => setDarkOnly(!darkOnly)}
                >
                  Dark wallpapers
                </Button>
                {["All styles", ...categories].map((style) => (
                  <Button
                    key={style}

                    variant="ghost"
                    aria-pressed={category === style}
                    className={cn("text-[12px]", category === style && "bg-accent text-foreground")}
                    onClick={() => {
                      setCategory(style);
                      if (style !== "All styles") setKind("wallpapers");
                    }}
                  >
                    {style}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 overflow-y-auto px-6 py-5 max-sm:px-4">
            <p role="status" aria-live="polite" className="mb-3 text-[12px] text-muted-foreground">
              {shown.length}{" "}
              {wallpaperOnly
                ? shown.length === 1
                  ? "wallpaper"
                  : "wallpapers"
                : shown.length === 1
                  ? "theme"
                  : "themes"}
            </p>
            {shown.length ? (
              <ThemeGrid {...props} themes={shown} />
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-[13px]">
                <p className="text-muted-foreground">
                  {wallpaperOnly
                    ? "No wallpapers match these filters."
                    : "No themes match these filters."}
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setKind("all");
                    setCategory("All styles");
                    setDarkOnly(false);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4 max-sm:px-4">
            <ArtworkCredit />
            <p className="text-[12px] text-muted-foreground">
              {wallpaperOnly ? "Only changes wallpaper." : "Select to apply."}
            </p>
            {props.error ? (
              <p role="alert" className="w-full text-[12.5px] text-destructive">
                {props.error}
              </p>
            ) : null}
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArtworkCredit({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11.5px] leading-5 text-muted-foreground", className)}>
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href={WALLPAPER_CREDIT.sourceUrl}
        target="_blank"
        rel="noreferrer"
      >
        Super Visuals by {WALLPAPER_CREDIT.author}
      </a>{" "}
      ·{" "}
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href={WALLPAPER_CREDIT.licenseUrl}
        target="_blank"
        rel="noreferrer"
      >
        {WALLPAPER_CREDIT.license}
      </a>
    </p>
  );
}

function ThemeGrid({
  themes,
  selected,
  wanted,
  onSelect,
  onRemove,
  compact = false,
  wallpaperOnly = false,
}: Omit<Props, "error"> & { compact?: boolean }) {
  const selectedVisible = themes.some((theme) => theme.id === selected);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : step === undefined
            ? -1
            : (at + step + buttons.length) % buttons.length;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  };
  return (
    <div
      role="radiogroup"
      aria-label={wallpaperOnly ? "Wallpaper" : "Colour theme"}
      onKeyDown={move}
      className={cn(
        "grid gap-4",
        compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {themes.map((theme, index) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          wanted={wanted}
          checked={selected === theme.id}
          tabbable={selected === theme.id || (!selectedVisible && index === 0)}
          onSelect={() => onSelect(theme.id)}
          onRemove={theme.id.startsWith("custom:") ? () => onRemove(theme) : undefined}
          compact={compact}
          wallpaperOnly={wallpaperOnly}
        />
      ))}
    </div>
  );
}

function ThemeCard({
  theme,
  wanted,
  checked,
  tabbable,
  onSelect,
  onRemove,
  compact,
  wallpaperOnly,
}: {
  theme: ColorTheme;
  wanted: ThemeAppearance;
  checked: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onRemove: (() => void) | undefined;
  compact: boolean;
  wallpaperOnly: boolean;
}) {
  const half = themeHalf(theme, wanted);
  const p = half.palette ?? CAVEMAN_PREVIEW[half.appearance];
  return (
    <div className="group/theme relative min-w-0">
      <button
        type="button"
        role="radio"
        aria-label={theme.name}
        aria-checked={checked}
        tabIndex={tabbable ? 0 : -1}
        onClick={checked ? undefined : onSelect}
        className={cn(
          "block w-full select-none rounded-xl text-left outline-none transition-transform duration-100 ease-snap active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        <span
          className={cn(
            "relative block aspect-[16/10] overflow-hidden rounded-xl border transition-colors duration-150",
            checked
              ? "border-foreground/70 ring-1 ring-foreground/40"
              : "border-border/60 group-hover/theme:border-foreground/35",
          )}
          style={{ background: p.shell }}
        >
          {theme.wallpaper ? (
            <>
              <img
                src={theme.wallpaper.thumbnail}
                alt=""
                loading="lazy"
                decoding="async"
                width="640"
                height="400"
                className="absolute inset-0 h-full w-full object-cover"
              />
              {!wallpaperOnly ? (
                <span
                  className="absolute bottom-2 right-2 w-[40%] overflow-hidden rounded-md border shadow-sm"
                  style={{ borderColor: p.border }}
                >
                  <PalettePreview p={p} mini />
                </span>
              ) : null}
            </>
          ) : (
            <span
              className="absolute inset-[12%] overflow-hidden rounded-lg border shadow-sm"
              style={{ borderColor: p.border }}
            >
              <PalettePreview p={p} />
            </span>
          )}
          {checked ? (
            <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-background text-foreground shadow-sm">
              <Icon icon={Tick02Icon} className="size-3.5" />
            </span>
          ) : null}
        </span>
        <span className="mt-2 flex items-center gap-2 px-0.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              compact ? "text-[12px]" : "text-[13px]",
            )}
          >
            {theme.name}
          </span>
          {!wallpaperOnly ? (
            <span aria-hidden className="flex shrink-0 -space-x-0.5">
              {(
                [
                  ["panel", p.panel],
                  ["accent", p.accent],
                  ["cyan", p.cyan],
                ] as const
              ).map(([role, color]) => (
                <span
                  key={role}
                  className="size-2.5 rounded-full ring-1 ring-background"
                  style={{ background: color }}
                />
              ))}
            </span>
          ) : null}
        </span>
        {!compact ? (
          <span className="mt-1 block truncate px-0.5 text-[11.5px] text-muted-foreground">
            {theme.wallpaper?.category ??
              (theme.source ? "Imported color theme" : `${theme.family} · Color theme`)}
          </span>
        ) : null}
      </button>
      {!compact && theme.wallpaper ? (
        <p className="mt-1 truncate px-0.5 text-[11px] text-muted-foreground">
          <a
            href={theme.wallpaper.credit.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {theme.wallpaper.credit.author}
          </a>
          {" · "}
          <a
            href={theme.wallpaper.credit.licenseUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            {theme.wallpaper.credit.license}
          </a>
        </p>
      ) : null}
      {onRemove ? (
        <Button
          variant="secondary"
          aria-label={`Remove ${theme.name}`}
          onClick={onRemove}
          className="absolute left-2 top-2 text-[12px] opacity-0 focus-visible:opacity-100 group-hover/theme:opacity-100 max-sm:opacity-100"
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
}

/** Decorative app sample: mostly wallpaper on artwork cards, a full palette for color-only themes. */
function PalettePreview({ p, mini = false }: { p: ThemePalette; mini?: boolean }) {
  const line = (color: string, width: string) => (
    <span className="block h-[3px] rounded-full" style={{ background: color, width }} />
  );
  return (
    <span
      aria-hidden
      className={cn("flex w-full", mini ? "aspect-[16/10]" : "h-full")}
      style={{ background: p.shell }}
    >
      <span
        className="flex w-[26%] flex-col gap-1.5 p-[8%]"
        style={{ padding: mini ? "8% 4%" : "10% 5%" }}
      >
        {line(p.dim, "65%")}
        {line(p.accent, "90%")}
        {line(p.dim, "75%")}
      </span>
      <span
        className="my-[5%] mr-[5%] flex flex-1 flex-col gap-1.5 rounded p-[6%]"
        style={{ background: p.panel }}
      >
        {line(p.purple, "55%")}
        {line(p.cyan, "80%")}
        {line(p.green, "65%")}
        {!mini ? line(p.dim, "70%") : null}
        <span
          className="mt-auto block h-1.5 w-[38%] self-end rounded"
          style={{ background: p.accent }}
        />
      </span>
    </span>
  );
}
