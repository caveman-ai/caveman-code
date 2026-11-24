// What each Chief starts its chats on: the model chip on its chat bar ("theres no model picker
// in a chief which is annoying"). Unpicked, a Chief starts chats on what a new chat starts on (Sheets.tsx
// useChiefPick); once picked it keeps its own, on disk under its own key, so it is still there after a relaunch.
// Settings > About's reset and `?fresh` clear it with every other cc/ key.
import { useSyncExternalStore } from "react";
import { type Effort, type Engine, ENGINE_NAME } from "../board/model";
import { read, write } from "../store/persist";
import type { Pick } from "./Sheets";

const KEY = "cc/v1/chief-picks";
const EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];

/** One Chief's pick off the disk, or null if it doesn't read as one. */
function pickFromDisk(data: unknown): Pick | null {
  if (!data || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  if (typeof p.engine !== "string" || !(p.engine in ENGINE_NAME)) return null;
  if (typeof p.model !== "string" || typeof p.effort !== "string" || !EFFORTS.includes(p.effort)) return null;
  if (p.speed !== undefined && typeof p.speed !== "string") return null;
  return { engine: p.engine as Engine, model: p.model, effort: p.effort as Effort, ...(typeof p.speed === "string" ? { speed: p.speed } : null) };
}

function fromDisk(data: unknown): Record<string, Pick> | null {
  if (!data || typeof data !== "object") return null;
  const out: Record<string, Pick> = {};
  for (const [id, raw] of Object.entries(data as Record<string, unknown>)) {
    const pick = pickFromDisk(raw);
    if (pick) out[id] = pick;
  }
  return out;
}

let picks: Readonly<Record<string, Pick>> = read(KEY, fromDisk) ?? {};
const listeners = new Set<() => void>();

/** A Chief's own pick, or undefined while it starts chats on the new chat's. */
export const getChiefPick = (id: string): Pick | undefined => picks[id];

/** Makes `pick` what the Chief starts its chats on. */
export function setChiefPick(id: string, pick: Pick) {
  picks = { ...picks, [id]: pick };
  write(KEY, () => picks);
  for (const on of listeners) on();
}

/** A Chief's own pick, kept current; undefined while it has none (and for no Chief). */
export function useOwnChiefPick(id: string | undefined): Pick | undefined {
  return useSyncExternalStore(
    (on) => {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    () => (id ? picks[id] : undefined),
  );
}
