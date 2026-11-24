// Settings > Appearance > Theme: light/dark, the theme gallery, and themes
// from VS Code (a .json or .vsix file, or Open VSX). The choice and the
// imported themes live in the runtime's Settings, so every client of the
// runtime wears them.
import { Button } from "@caveman-app/ui/components/button";
import { SearchField } from "@caveman-app/ui/components/input";
import { Switch } from "@caveman-app/ui/components/switch";
import { cn } from "@caveman-app/ui/lib/cn";
import { MAX_CUSTOM_THEMES, type CustomTheme, type Settings } from "@caveman-app/session-protocol";
import { Icon, Download04Icon, PaintBoardIcon, Tick02Icon, Upload04Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { previewThemeSelection } from "../../state/theme-selection.ts";
import { setWallpaperMatchingTheme, useWallpaper } from "../../wallpaper/store.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { installOpenVsx, searchOpenVsx, themesFromFile, type OpenVsxExtension } from "../../state/theme-import.ts";
import { CAVEMAN_THEME_ID, allThemes, findTheme, onlyAppearance, type ColorTheme, type ThemeAppearance } from "../../state/themes.ts";
import { ThemeGallery } from "./ThemeGallery.tsx";
import { Segmented, SettingRow, SettingsCard, useSaveSettings } from "./rows.tsx";

const darkQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
function subscribeOs(onChange: () => void) {
  const media = darkQuery();
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

/** The side the light/dark setting asks for right now. */
function useWantedAppearance(mode: Settings["theme"]): ThemeAppearance {
  const osDark = useSyncExternalStore(subscribeOs, () => darkQuery()?.matches ?? true);
  return mode === "system" ? (osDark ? "dark" : "light") : mode;
}

/** Light/dark and the gallery. */
export function ThemeSettingsCard() {
  const wallpaper = useWallpaper();
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  // A theme pick paints before it saves, so it takes its own failure back and says so under the gallery.
  const saveTheme = useSaveSettings({ throws: true });
  const mode = settings?.theme ?? "system";
  const wanted = useWantedAppearance(mode);
  const custom = settings?.custom_themes ?? [];
  const selected = findTheme(settings?.color_theme, custom);
  const only = onlyAppearance(selected);
  const [error, setError] = useState<string | null>(null);
  // The Settings as of now, for work that finishes later (an install): never the render's copy.
  const latest = useRef(settings);
  latest.current = settings;
  const generation = useRef(0);

  /** Paint at once, then save; a failed save paints the saved Settings back, unless a newer pick has painted since. */
  const apply = async (patch: Pick<Settings, "color_theme" | "custom_themes">) => {
    const current = latest.current;
    if (!current) return;
    const mine = ++generation.current;
    setError(null);
    const preview = previewThemeSelection(current, patch);
    try {
      await saveTheme(patch);
      preview.commit();
    } catch (cause) {
      preview.rollback(latest.current ?? current);
      if (mine !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "The runtime didn't save the theme.");
    }
  };
  const themes = allThemes(custom);
  const remove = (theme: ColorTheme) =>
    void apply({
      custom_themes: (latest.current?.custom_themes ?? []).filter((t) => t.id !== theme.id),
      ...(theme.id === selected.id ? { color_theme: CAVEMAN_THEME_ID } : {}),
    });

  return (
    <>
      <SettingsCard title="Theme">
        <SettingRow label="Light or dark" description={only ? `${selected.name} is ${only} only.` : undefined}>
          <Segmented
            label="Light or dark"
            value={mode}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={(theme) => void save({ theme })}
          />
        </SettingRow>
        <SettingRow label="Use matching wallpaper" description="Off keeps your picture when theme colors change.">
          <Switch aria-label="Use matching wallpaper" checked={wallpaper.matchTheme} onCheckedChange={setWallpaperMatchingTheme} />
        </SettingRow>
        <ThemeGallery themes={themes} selected={selected.id} wanted={wanted} error={error} matchingWallpaper={wallpaper.matchTheme} onSelect={(id) => void apply({ color_theme: id })} onRemove={remove} />
        {error ? <p className="px-5 pb-4 text-[12.5px] text-destructive">{error}</p> : null}
      </SettingsCard>
      <MoreThemesCard
        custom={custom}
        onInstall={async (added) => {
          // A reinstall replaces what the same extension or file brought before, renamed themes included.
          const ids = new Set(added.map((t) => t.id));
          const sources = new Set(added.flatMap((t) => (t.source ? [t.source] : [])));
          const kept = (latest.current?.custom_themes ?? []).filter((t) => !ids.has(t.id) && !(t.source && sources.has(t.source)));
          const next = [...kept, ...added];
          if (next.length > MAX_CUSTOM_THEMES) throw new Error(`You can keep ${MAX_CUSTOM_THEMES} imported themes. Remove some first.`);
          await apply({ custom_themes: next, color_theme: added[0]!.id });
        }}
      />
    </>
  );
}

const SUGGESTIONS = ["Material", "Synthwave", "Palenight", "Vitesse", "Moonlight", "Poimandres"];
const DOWNLOADS = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** VS Code themes: a file from disk, or an extension from Open VSX. */
function MoreThemesCard({ custom, onInstall }: { custom: ReadonlyArray<CustomTheme>; onInstall: (themes: CustomTheme[]) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVsxExtension[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const installed = new Set(custom.map((t) => t.source));

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      searchOpenVsx(q, controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return;
          setResults(r);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? `Open VSX search failed: ${cause.message}` : "Open VSX search failed.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const run = async (key: string, load: () => Promise<CustomTheme[]>) => {
    setInstalling(key);
    setError(null);
    try {
      await onInstall(await load());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme couldn't be imported.");
    } finally {
      setInstalling(null);
    }
  };

  return (
    <SettingsCard title="VS Code themes">
      <div className="flex items-center gap-2 px-5 py-3.5">
        <SearchField aria-label="Search Open VSX themes" placeholder="Search Open VSX themes" value={query} onChange={(e) => setQuery(e.target.value)} containerClassName="flex-1" />
        <input
          ref={file}
          type="file"
          accept=".json,.jsonc,.vsix,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run("file", () => themesFromFile(f));
          }}
        />
        <Button variant="outline" disabled={installing !== null} onClick={() => file.current?.click()}>
          <Icon icon={Upload04Icon} />
          {installing === "file" ? "Importing…" : "Import file"}
        </Button>
      </div>
      {error ? <p className="px-5 py-3 text-[12.5px] text-destructive">{error}</p> : null}
      {results === null && !searching ? (
        <div className="flex flex-wrap items-center gap-1.5 px-5 py-3 text-[12.5px] text-muted-foreground">
          Try
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => setQuery(s)} className="rounded-md border border-border px-2 py-0.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {searching && results === null ? <p className="px-5 py-3 text-[12.5px] text-muted-foreground">Searching Open VSX…</p> : null}
      {results?.length === 0 ? <p className="px-5 py-3 text-[12.5px] text-muted-foreground">No themes on Open VSX match “{query.trim()}”.</p> : null}
      {results && results.length > 0 ? (
        <ul aria-label="Open VSX themes" aria-busy={searching} className={cn("divide-y divide-border/60", searching && "opacity-60")}>
          {results.map((ext) => (
            <li key={ext.id} className="flex items-center gap-3 px-5 py-2.5">
              <ExtensionIcon url={ext.iconUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px]">{ext.name}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {ext.publisher} · {DOWNLOADS.format(ext.downloads)}
                  </span>
                </div>
                {ext.description ? <p className="truncate text-[12.5px] text-muted-foreground">{ext.description}</p> : null}
              </div>
              <Button
                variant={installed.has(ext.id) ? "ghost" : "outline"}
                disabled={installing !== null}
                aria-label={`${installed.has(ext.id) ? "Reinstall" : "Install"} ${ext.name}`}
                onClick={() => void run(ext.id, () => installOpenVsx(ext))}
              >
                {installing === ext.id ? (
                  "Installing…"
                ) : installed.has(ext.id) ? (
                  <>
                    <Icon icon={Tick02Icon} /> Installed
                  </>
                ) : (
                  <>
                    <Icon icon={Download04Icon} /> Install
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsCard>
  );
}

function ExtensionIcon({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
      {url && !failed ? <img alt="" src={url} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} /> : <Icon icon={PaintBoardIcon} className="size-4" />}
    </span>
  );
}
