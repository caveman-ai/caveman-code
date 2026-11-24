import library from "./wallpaper-library.json";

// Super Visuals artwork by Ahmed Hassan, CC BY 4.0. See assets/wallpapers/ATTRIBUTION.md.
export const WALLPAPER_CREDIT = {
  author: "Ahmed Hassan",
  authorUrl: "https://www.figma.com/@supervisuals",
  collection: "Super Visuals",
  sourceUrl:
    "https://www.figma.com/community/file/1626392436817658229/super-visuals-50-stunning-backgrounds-v1",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export interface WallpaperCredit {
  readonly author: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly collection?: string;
}

export interface WallpaperArtwork {
  readonly id: string;
  readonly slug: string;
  readonly tags: string;
  readonly name: string;
  readonly category: string;
  readonly light: number;
  readonly dark: boolean;
  readonly width: number;
  readonly height: number;
  readonly colors: readonly [string, string, string];
  readonly image: string;
  readonly thumbnail: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly credit: WallpaperCredit;
}

export const WALLPAPER_IMAGE_ORIGIN =
  import.meta.env.VITE_WALLPAPER_IMAGE_ORIGIN ?? "https://download.caveman.so/code/wallpapers/v1/";

// Only small thumbnails enter the app build. Full artwork is an immutable, on-demand asset pack.
export const WALLPAPERS: ReadonlyArray<WallpaperArtwork> = library.map((art) => ({
  ...art,
  colors: [art.colors[0]!, art.colors[1]!, art.colors[2]!] as const,
  dark: art.tags.split(/\s+/).includes("dark") || art.light < 0.3,
  image: `${WALLPAPER_IMAGE_ORIGIN}${art.file}`,
  thumbnail: new URL(`../assets/wallpapers/${art.slug}-thumb.webp`, import.meta.url).href,
}));

export function findWallpaper(source: string): WallpaperArtwork | undefined {
  return WALLPAPERS.find((art) => art.id === source);
}
