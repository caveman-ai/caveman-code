// Each Chief's face as the Lock Screen and the widget show it: its pixel character from the mascot cast, idle, in its
// skin tone, drawn into a PNG in the App Group the widget extension shares with the app (expo-widgets'
// `widgetsDirectory`), since the extension can't run the app's SVG. One file per character and tone, written once.
import { loadBody } from "@caveman-app/ui/mascot/cast";
import type { CastCharacter, SkinTone } from "@caveman-app/ui/mascot/poses";
import { chiefById } from "../board/model";
import { PALETTE, SKIN } from "../components/Sprite";
import { CELLS, cellsOf, gridPng } from "./png";

/** 8 pixels a cell keeps a face crisp when the Lock Screen scales it. */
const SCALE = 8;

/** A character's idle face as PNG bytes. */
export async function facePng(character: CastCharacter, tone: SkinTone): Promise<Uint8Array> {
  const body = await loadBody(character);
  const grid = cellsOf(body.idle.paths, { ...PALETTE, ...SKIN[tone] });
  return gridPng(CELLS, SCALE, (x, y) => grid[y * CELLS + x] ?? null);
}

const written = new Map<string, Promise<string>>();

/**
 * The file URL of a Chief's face in `dir` (the App Group's widgets directory, a file:// URL ending in "/"), writing
 * it the first time it is asked for. Empty when it can't be written; the layouts then draw the flame.
 */
export function faceOf(dir: string, chief: string): Promise<string> {
  if (!dir || !chief) return Promise.resolve("");
  const { character, tone } = chiefById(chief);
  const name = `face-${character}-${tone}.png`;
  const had = written.get(name);
  if (had) return had;
  const job = (async () => {
    try {
      const { File } = await import("expo-file-system");
      const file = new File(dir, name);
      if (!file.exists) await file.write(await facePng(character, tone));
      return file.uri;
    } catch {
      written.delete(name);
      return "";
    }
  })();
  written.set(name, job);
  return job;
}
