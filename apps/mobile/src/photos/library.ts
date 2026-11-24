// The phone's own photos, newest first, for the `+` menu's strip and its See all grid (docs/,
// "Photos under +"). Screenshots are photos too, so they come in with the rest, marked as screenshots for
// VoiceOver. One list for the app, read a page at a time through expo-media-library's Query (its metadata only, which
// iOS reads without touching the files), so the strip and the grid show the same photos and a page the grid loaded is
// there for the strip next time.
//
// Access is asked for in context, never on launch: until something on screen asks (`useRecentPhotos`), nothing here
// runs, and asking for access waits for a tap on the strip's tile. Limited access ("Selected Photos") shows the photos
// given; the system's own chooser adds more, and the library telling us it changed brings them in. While anything shows
// the library, a new photo or screenshot (or access changed in Settings, coming back to the app) shows at once.
//
// The web build has no library: `access` is "web" there and the strip draws the prototype's screenshots instead.
import { addListener, AssetField, type AssetMetadata, getPermissionsAsync, MediaSubtype, MediaType, presentPermissionsPicker, Query, requestPermissionsAsync } from "expo-media-library";
import { useEffect } from "react";
import { AppState, Linking, Platform } from "react-native";
import { createStore, useSelector } from "../store/core";

/**
 * What the app may see of the library: "web" (no library at all), "checking" (not known yet), "ask" (not asked yet,
 * or asked and may ask again), "limited" (the photos given), "all", "denied" (only Settings can change it), or
 * "unavailable" (the library failed to answer; the system picker still works).
 */
export type PhotoAccess = "web" | "checking" | "ask" | "limited" | "all" | "denied" | "unavailable";

export interface Photo {
  /** The asset's `ph://` id, which is also what shows it: expo-image loads it at the size it is drawn. */
  id: string;
  width: number;
  height: number;
  /** When it was taken, in ms. */
  at: number;
  screenshot: boolean;
}

interface Library {
  access: PhotoAccess;
  photos: readonly Photo[];
  /** Every photo there is has been read. */
  end: boolean;
}

const NATIVE = Platform.OS === "ios" || Platform.OS === "android";
/** The first read: enough for the strip and the grid's first screen. */
const FIRST = 36;
/** Each read after it, as the grid scrolls toward its end. */
const PAGE = 60;

const store = createStore<Library, Partial<Library>>({ access: NATIVE ? "checking" : "web", photos: [], end: !NATIVE }, (s, patch) => ({ ...s, ...patch }));
const set = (patch: Partial<Library>) => store.dispatch(patch);

export const canSee = (access: PhotoAccess) => access === "all" || access === "limited";

/** Times come in milliseconds; an older module said seconds, so a small number is read as seconds. */
const ms = (t: number | null) => (!t ? 0 : t < 1e12 ? t * 1000 : t);
const toPhoto = (m: AssetMetadata): Photo => ({
  id: m.id,
  width: m.width ?? 0,
  height: m.height ?? 0,
  at: ms(m.creationTime ?? m.modificationTime),
  screenshot: !!m.mediaSubtypes?.includes(MediaSubtype.SCREENSHOT),
});

/** One page of the library's pictures, newest first. */
async function read(offset: number, limit: number): Promise<Photo[]> {
  const rows = await new Query().eq(AssetField.MEDIA_TYPE, MediaType.IMAGE).orderBy({ key: AssetField.CREATION_TIME, ascending: false }).offset(offset).limit(limit).exeForMetadata();
  return rows.map(toPhoto);
}

async function accessNow(): Promise<PhotoAccess> {
  const p = await getPermissionsAsync(false, ["photo"]);
  if (p.granted) return p.accessPrivileges === "limited" ? "limited" : "all";
  if (p.status === "undetermined") return "ask";
  return p.canAskAgain ? "ask" : "denied";
}

// A later read wins: a refresh started while a page was coming in drops that page.
let generation = 0;
let paging = false;

/** Reads access again, then the newest photos: as many as were loaded, so an open grid keeps its place. */
async function refresh() {
  if (!NATIVE) return;
  const gen = ++generation;
  try {
    const access = await accessNow();
    if (gen !== generation) return;
    if (!canSee(access)) return set({ access, photos: [], end: true });
    hearChanges();
    const want = Math.max(FIRST, store.get().photos.length);
    const photos = await read(0, want);
    if (gen !== generation) return;
    set({ access, photos, end: photos.length < want });
  } catch {
    if (gen === generation) set({ access: "unavailable", photos: [], end: true });
  }
}

/** The next page, for the grid nearing its end. */
export async function morePhotos() {
  const now = store.get();
  if (paging || now.end || !canSee(now.access)) return;
  paging = true;
  const gen = generation;
  try {
    const next = await read(now.photos.length, PAGE);
    if (gen !== generation) return;
    const have = store.get().photos;
    const seen = new Set(have.map((p) => p.id));
    set({ photos: [...have, ...next.filter((p) => !seen.has(p.id))], end: next.length < PAGE });
  } catch {
    // The grid simply ends where it is; the next refresh tries again.
  } finally {
    paging = false;
  }
}

/** The strip's "Show your recent photos here": the system asks, and the strip fills with what it's given. */
export async function askForPhotos() {
  try {
    await requestPermissionsAsync(false, ["photo"]);
  } catch {
    // Nothing to ask with: refresh says so.
  }
  await refresh();
}

/** "Choose more", with limited access: the system's own chooser. The library's change event brings the new ones in. */
export async function chooseMorePhotos() {
  try {
    await presentPermissionsPicker(["photo"]);
  } catch {
    // iOS 14 and older Android have no chooser; Settings does it there.
    void Linking.openSettings();
  }
}

/** Denied: only Settings can turn photos back on. Coming back to the app reads access again. */
export const openPhotoSettings = () => void Linking.openSettings();

// While something shows the library: hear it change (a new screenshot, a choice in the limited chooser) and the app
// coming back (from Settings), and read again a beat after, once for a burst.
let users = 0;
let stop: (() => void) | null = null;
let soon: ReturnType<typeof setTimeout> | null = null;
const refreshSoon = () => {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => {
    soon = null;
    void refresh();
  }, 250);
};
/**
 * The library's changes are heard only once it may be seen: listening fetches from it natively, which would raise iOS's
 * own access prompt before anyone tapped "Show your recent photos here".
 */
let changes: { remove: () => void } | null = null;
function hearChanges() {
  if (changes || !users) return;
  try {
    changes = addListener(refreshSoon);
  } catch {
    changes = null;
  }
}
function watch() {
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") refreshSoon();
  });
  return () => {
    changes?.remove();
    changes = null;
    app.remove();
    if (soon) clearTimeout(soon);
    soon = null;
  };
}

/**
 * The library as the strip and the grid show it. The first thing to show it reads access (which never asks) and the
 * newest photos; the photos already read show at once meanwhile.
 */
export function useRecentPhotos(): Library {
  useEffect(() => {
    if (!NATIVE) return;
    users++;
    if (users === 1) stop = watch();
    void refresh();
    return () => {
      users--;
      if (users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
  return useSelector(store, (s) => s);
}

if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, photos: { state: () => store.get(), refresh, more: morePhotos } };
}
