// Settings > Appearance > Wallpaper: what is behind a new chat. A painting that ships with the app (the living ones,
// which answer the pointer, in a group of their own) or the person's own image, the effect over it, and its dials;
// kept on this device (wallpaper/store.ts). The stage at the top is the pick itself with a line of words and the
// box on it, so every dial shows what it does as it moves, and a living one can be tried there.
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { findWallpaper } from "../../state/wallpaper-catalog.ts";
import { allThemes } from "../../state/themes.ts";
import { ThemeGallery } from "./ThemeGallery.tsx";
import { Button } from "@caveman-app/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caveman-app/ui/components/select";
import { Switch } from "@caveman-app/ui/components/switch";
import { Icon, Cancel01Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { EFFECTS, RANGE, type Dial, type EffectId } from "../../wallpaper/look.ts";
import { PAINTINGS, findPainting, type Painting } from "../../wallpaper/paintings.ts";
import {
  removeWallpaperImage,
  resetWallpaper,
  setWallpaper,
  setWallpaperImage,
  useWallpaper,
  useWallpaperImage,
} from "../../wallpaper/store.ts";
import { PaintingThumb, Wallpaper } from "../../wallpaper/Wallpaper.tsx";
import { CONTROL, SettingRow, SettingsCard } from "./rows.tsx";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** The paintings in their two groups: the ones that are a picture, and the ones that are alive. */
const STILL = PAINTINGS.filter((p) => !p.life);
const LIVING = PAINTINGS.filter((p) => p.life);
const TILES = "grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5";

export function WallpaperSettingsCard() {
  const pick = useWallpaper();
  const own = useWallpaperImage();
  const picker = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const colorTheme = useRuntimeSelector((view) => view.settings?.color_theme);
  const artwork = findWallpaper(pick.source) ?? findWallpaper(colorTheme ?? "");
  const source = pick.source;
  const artworkSource = artwork?.id ?? null;
  // In the order the tiles stand, which is the order the arrow keys walk them.
  const sources = [
    "none",
    ...(artworkSource ? [artworkSource] : []),
    ...STILL.map((p) => p.id),
    ...(own ? ["image"] : []),
    ...LIVING.map((p) => p.id),
  ];
  const off = pick.source === "none";
  const painting = findPainting(pick.source);
  const moves = painting?.moves === true;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setNote(null);
    if (file.size > MAX_IMAGE_BYTES) return setNote(`${file.name} is over 30 MB.`);
    await setWallpaperImage(file).catch((cause: unknown) =>
      setNote(cause instanceof Error ? cause.message : "That picture could not be kept."),
    );
  };
  /** Arrow keys move through the pictures and wear each as they land on it (the ARIA radio group pattern). */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const at = sources.indexOf(source);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? sources.length - 1
          : step === undefined
            ? -1
            : (at + step + sources.length) % sources.length;
    if (next < 0) return;
    e.preventDefault();
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
    if (sources[next] !== source) setWallpaper({ source: sources[next]! });
  };
  const paintingTile = (p: Painting) => (
    <Tile
      key={p.id}
      name={p.name}
      checked={pick.source === p.id}
      onSelect={() => setWallpaper({ source: p.id })}
    >
      <PaintingThumb painting={p} className="block size-full object-cover" />
    </Tile>
  );
  const dial = (label: string, name: Dial, unit: string, disabled = off) => (
    <DialRow
      key={name}
      label={label}
      name={name}
      value={pick[name]}
      unit={unit}
      disabled={disabled}
    />
  );

  return (
    <SettingsCard
      title="Wallpaper"
      description="Choose any picture. Theme colors stay."
      actions={
        <>
          <ThemeGallery
            wallpaperOnly
            themes={allThemes()}
            selected={source}
            wanted="dark"
            error={null}
            onSelect={(id) => setWallpaper({ source: id })}
            onRemove={() => undefined}
          />
          <Button variant="ghost" disabled={off} onClick={resetWallpaper}>
            Reset
          </Button>
        </>
      }
    >
      <div className="px-5 pt-4">
        <Wallpaper
          pick={pick}
          showLoadStatus
          className="flex h-[184px] flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border border-border bg-background"
        >
          <span
            data-wallpaper-reads
            aria-hidden
            className="text-[14px] font-medium text-foreground"
          >
            What should we build?
          </span>
          <span
            aria-hidden
            className={cn(
              "h-11 w-1/2 rounded-xl",
              off ? "border border-input bg-card" : "glass composer-glass",
            )}
          />
        </Wallpaper>
      </div>
      <div role="radiogroup" aria-label="Picture" onKeyDown={onKeyDown} className="px-5 py-4">
        <div className={TILES}>
          <Tile name="None" checked={off} onSelect={() => setWallpaper({ source: "none" })}>
            <span className="block size-full bg-background" />
          </Tile>
          {artwork ? (
            <Tile
              name={artwork.name}
              checked={source === artworkSource}
              onSelect={() => setWallpaper({ source: artworkSource! })}
            >
              <img
                src={artwork.thumbnail}
                alt=""
                draggable={false}
                className="block size-full object-cover"
              />
            </Tile>
          ) : null}
          {STILL.map(paintingTile)}
          {own ? (
            <Tile
              name="Your picture"
              checked={pick.source === "image"}
              onSelect={() => setWallpaper({ source: "image" })}
              onRemove={removeWallpaperImage}
            >
              <img src={own} alt="" draggable={false} className="block size-full object-cover" />
            </Tile>
          ) : null}
        </div>
        <p className="px-0.5 pb-2 pt-4 text-[11.5px] leading-5 text-muted-foreground">
          Living. They roam, and scatter from a click.
        </p>
        <div className={TILES}>{LIVING.map(paintingTile)}</div>
      </div>
      <SettingRow
        label="Your picture"
        description={
          note ? (
            <span className="text-destructive">{note}</span>
          ) : (
            "Any image. It stays on this device."
          )
        }
      >
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void choose(e.target.files?.[0]).finally(() => (e.target.value = ""))}
        />
        <Button variant="outline" onClick={() => picker.current?.click()}>
          {own ? "Change…" : "Choose an image…"}
        </Button>
      </SettingRow>
      <SettingRow label="Effect" description={EFFECTS[pick.effect].line}>
        <Select
          value={pick.effect}
          disabled={off}
          onValueChange={(v) => setWallpaper({ effect: v as EffectId })}
        >
          <SelectTrigger aria-label="Effect" className={CONTROL}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(EFFECTS) as EffectId[]).map((id) => (
              <SelectItem key={id} value={id}>
                {EFFECTS[id].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {pick.effect === "none" ? null : [dial("Amount", "amount", "%"), dial("Size", "size", "%")]}
      {dial("Brightness", "brightness", "%")}
      {pick.source === "image" || findWallpaper(pick.source) ? dial("Blur", "blur", "px") : null}
      {dial("Dim", "dim", "%")}
      {dial("Bottom fade", "fade", "%")}
      {dial("Chat box", "box", "%")}
      {moves ? (
        <SettingRow
          id="wallpaper-motion"
          label="Motion"
          description={painting?.life ? "They roam, and mind the pointer." : "It drifts, slowly."}
        >
          <Switch
            id="wallpaper-motion"
            checked={pick.motion}
            onCheckedChange={(motion) => setWallpaper({ motion })}
          />
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}

/** One number of the look: a slider and what it reads. */
function DialRow({
  label,
  name,
  value,
  unit,
  disabled,
}: {
  label: string;
  name: Dial;
  value: number;
  unit: string;
  disabled: boolean;
}) {
  const { min, max } = RANGE[name];
  return (
    <SettingRow label={label}>
      <div className={cn("flex items-center gap-3", CONTROL)}>
        <input
          type="range"
          aria-label={label}
          aria-valuetext={`${value}${unit}`}
          className="range min-w-0 flex-1"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          style={{ "--at": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
          onChange={(e) => setWallpaper({ [name]: Number(e.target.value) })}
        />
        <span className="w-10 shrink-0 text-right text-[12.5px] tabular-nums text-muted-foreground">
          {value}
          {unit}
        </span>
      </div>
    </SettingRow>
  );
}

/** A picture to pick, as it is with nothing over it. */
function Tile({
  name,
  checked,
  onSelect,
  onRemove,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="group/tile relative">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={checked ? undefined : onSelect}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-lg border border-border p-1.5 text-left outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
          checked && "border-foreground/45 bg-accent/60",
        )}
      >
        <span
          aria-hidden
          className="block h-[66px] overflow-hidden rounded-md border border-border bg-background"
        >
          {children}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 px-1 pb-0.5 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {checked ? <Icon icon={Tick02Icon} className="size-3.5 shrink-0" /> : null}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${name.toLowerCase()}`}
          title="Remove"
          onClick={onRemove}
          className="absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-md bg-background/85 text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tile:opacity-100"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
