/**
 * The cast: who plays the mascot's body, and in which skin tone. Settings >
 * Companion picks one for this device (localStorage); every body `<Mascot>`
 * without an explicit `character` follows it. The bust stays the caveman.
 *
 * Each companion's body is its own generated chunk (`./cast/<id>.ts`, from
 * scripts/cast/<id>.py), so the app only ever downloads the one in use. The
 * stored pick starts loading when this module is first imported; until it
 * lands a body mascot holds its space empty, and a chunk that fails to load
 * falls back to the caveman.
 *
 * Companions people made (Settings > Companion > Create) come from the
 * runtime's companions folder: the app reads and draws them
 * (@caveman-app/shared/companion) and hands them over with
 * `setMadeCompanions`. They play the caveman's build with their own head, so
 * they always take a skin tone. A pick of one stays empty until the list
 * lands, then falls back to the caveman if its file is gone.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { CastCharacter, MascotCharacter, MascotPose, SkinTone } from "./poses";
import { MASCOT_SPRITES, type MascotSheet } from "./sprites";

export type MascotBody = Record<MascotPose, MascotSheet>;

/** Settings order: the people, the Ice Age animals, the wrong-era ones, the rock. `skin`: a skin tone shows on it (only the people). */
export type CastMember = { id: MascotCharacter; name: string; line: string; skin: boolean };

export const CAST: ReadonlyArray<CastMember & { id: CastCharacter }> = [
  { id: "caveman", name: "Caveman", line: "The original. Bonks the rock until it works.", skin: true },
  { id: "cavewoman", name: "Cavewoman", line: "Bone in her hair, bone in her hand. Ships first.", skin: true },
  { id: "elder", name: "Elder", line: "Seen ten ice ages. Strokes the beard, then strikes.", skin: true },
  { id: "kid", name: "Cave kid", line: "Small club, big plans.", skin: true },
  { id: "mammoth", name: "Mammoth", line: "Woolly, steady, never forgets a file.", skin: false },
  { id: "sabertooth", name: "Sabertooth", line: "Two long fangs. Bites a bug clean in half.", skin: false },
  { id: "wolf", name: "Wolf pup", line: "The first good boy. Fetches sticks and stack traces.", skin: false },
  { id: "bear", name: "Cave bear", line: "Sleeps all winter, wakes up and refactors.", skin: false },
  { id: "rhino", name: "Woolly rhino", line: "Charges the hardest bug first.", skin: false },
  { id: "sloth", name: "Ground sloth", line: "Slow and sure. Never rushes a merge.", skin: false },
  { id: "glyptodon", name: "Glyptodon", line: "Shell like a boulder. Nothing gets through.", skin: false },
  { id: "bison", name: "Bison", line: "Walked off the cave wall to help.", skin: false },
  { id: "elk", name: "Giant elk", line: "Antlers wider than the diff.", skin: false },
  { id: "boar", name: "Boar", line: "Roots through the logs until the bug turns up.", skin: false },
  { id: "beaver", name: "Giant beaver", line: "Chews big tasks into small sticks.", skin: false },
  { id: "owl", name: "Cave owl", line: "Up all night. Reads every line.", skin: false },
  { id: "bat", name: "Cave bat", line: "Hangs upside down. Works the night shift.", skin: false },
  { id: "dino", name: "Dino", line: "Wrong era. Short arms. Still waves.", skin: false },
  { id: "trike", name: "Triceratops", line: "Three horns, one job. The dino's best friend.", skin: false },
  { id: "ptero", name: "Pterodactyl", line: "Also the wrong era. Sees the whole repo from up here.", skin: false },
  { id: "petrock", name: "Pet rock", line: "Never moves. Never breaks the build.", skin: false },
];

/** Light to dark. The UI shows each as a swatch, never by name. */
export const SKIN_TONES: ReadonlyArray<SkinTone> = ["light", "medium-light", "medium", "medium-dark", "dark"];

export type Companion = { character: MascotCharacter; tone: SkinTone };

export const DEFAULT_COMPANION: Companion = { character: "caveman", tone: "medium-light" };

const LOADERS: Record<Exclude<CastCharacter, "caveman">, () => Promise<{ default: MascotBody }>> = {
  cavewoman: () => import("./cast/cavewoman"),
  elder: () => import("./cast/elder"),
  kid: () => import("./cast/kid"),
  mammoth: () => import("./cast/mammoth"),
  sabertooth: () => import("./cast/sabertooth"),
  wolf: () => import("./cast/wolf"),
  bear: () => import("./cast/bear"),
  rhino: () => import("./cast/rhino"),
  sloth: () => import("./cast/sloth"),
  glyptodon: () => import("./cast/glyptodon"),
  bison: () => import("./cast/bison"),
  elk: () => import("./cast/elk"),
  boar: () => import("./cast/boar"),
  beaver: () => import("./cast/beaver"),
  owl: () => import("./cast/owl"),
  bat: () => import("./cast/bat"),
  dino: () => import("./cast/dino"),
  trike: () => import("./cast/trike"),
  ptero: () => import("./cast/ptero"),
  petrock: () => import("./cast/petrock"),
};

const KEY = "caveman.companion";
const isMade = (id: MascotCharacter): id is `custom:${string}` => id.startsWith("custom:");
const isCharacter = (v: unknown): v is MascotCharacter =>
  CAST.some((c) => c.id === v) || (typeof v === "string" && /^custom:[a-z0-9][a-z0-9-]{0,39}$/.test(v));
const isTone = (v: unknown): v is SkinTone => SKIN_TONES.includes(v as SkinTone);

/** The stored pick, with anything unknown (an old or hand-edited value) back to the default. */
export function parseCompanion(raw: string | null): Companion {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<Companion> | null;
    return {
      character: isCharacter(v?.character) ? v.character : DEFAULT_COMPANION.character,
      tone: isTone(v?.tone) ? v.tone : DEFAULT_COMPANION.tone,
    };
  } catch {
    return DEFAULT_COMPANION;
  }
}

const hasStorage = typeof localStorage !== "undefined";
let companion = hasStorage ? parseCompanion(localStorage.getItem(KEY)) : DEFAULT_COMPANION;
const bodies = new Map<MascotCharacter, MascotBody>([["caveman", MASCOT_SPRITES.body]]);
const failed = new Set<MascotCharacter>();
const loading = new Set<MascotCharacter>();
/** The made companions, in folder order; null until the runtime's list lands. */
let made: ReadonlyArray<CastMember> | null = null;
let everyone: ReadonlyArray<CastMember> = CAST;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Starts loading a companion's body; a no-op once it is loaded, loading or failed. */
export function preloadBody(id: MascotCharacter): void {
  if (isMade(id)) return; // drawn by the app and handed over with setMadeCompanions
  if (id === "caveman" || bodies.has(id) || failed.has(id) || loading.has(id)) return;
  loading.add(id);
  LOADERS[id]().then(
    (m) => bodies.set(id, m.default),
    () => failed.add(id),
  ).finally(() => {
    loading.delete(id);
    emit();
  });
}

/**
 * The companions in the runtime's companions folder, drawn (`body`: every pose,
 * as @caveman-app/shared/companion composes it). Replaces the last list.
 */
export function setMadeCompanions(list: ReadonlyArray<{ id: string; name: string; line: string; body: Readonly<Record<string, MascotSheet>> }>): void {
  for (const c of made ?? []) bodies.delete(c.id);
  made = list.map((c) => ({ id: `custom:${c.id}` as const, name: c.name, line: c.line, skin: true }));
  // The composer plays every pose of the plan and the gaze, so the sheet covers each MascotPose.
  list.forEach((c) => bodies.set(`custom:${c.id}`, c.body as MascotBody));
  everyone = [...CAST, ...made];
  emit();
}

export function setCompanion(next: Partial<Companion>): void {
  companion = { ...companion, ...next };
  if (hasStorage) localStorage.setItem(KEY, JSON.stringify(companion));
  failed.delete(companion.character); // picking it again retries a chunk that failed
  preloadBody(companion.character);
  emit();
}

if (typeof window !== "undefined") {
  preloadBody(companion.character);
}
// Another window of the app picked someone else. React Native has a `window` but no events on it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    companion = parseCompanion(e.newValue);
    preloadBody(companion.character);
    emit();
  });
}

/** The cast, then the made companions: who Settings > Companion offers. */
export function useCast(): ReadonlyArray<CastMember> {
  return useSyncExternalStore(subscribe, () => everyone, () => CAST);
}

export function useCompanion(): Companion {
  return useSyncExternalStore(subscribe, () => companion, () => DEFAULT_COMPANION);
}

/**
 * A character's body sheets outside React (the phone draws each Chief's face into a picture for its Lock Screen):
 * once loaded, the caveman's if its chunk fails or a made companion is gone.
 */
export async function loadBody(id: MascotCharacter): Promise<MascotBody> {
  const have = bodies.get(id);
  if (have) return have;
  if (isMade(id)) return MASCOT_SPRITES.body;
  try {
    const body = (await LOADERS[id as Exclude<CastCharacter, "caveman">]()).default;
    bodies.set(id, body);
    return body;
  } catch {
    return MASCOT_SPRITES.body;
  }
}

/** A character's body sheets: null while its chunk (or the made list) loads, the caveman's if it failed or is gone. */
export function useBody(id: MascotCharacter): MascotBody | null {
  const read = () => bodies.get(id) ?? (failed.has(id) || (isMade(id) && made !== null) ? MASCOT_SPRITES.body : null);
  const body = useSyncExternalStore(subscribe, read, read);
  useEffect(() => preloadBody(id), [id]);
  return body;
}
