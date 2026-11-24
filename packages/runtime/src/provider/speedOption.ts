/**
 * Speed: how fast a model answers, under each engine's own option: Claude Agent's `fastMode` (a boolean; on is
 * "fast") and Codex's `serviceTier` (a select whose "default" is standard). The Session Protocol shows one list per
 * model, the speeds past standard (EngineDescriptor model `speeds`), and a turn names one (TurnOptions.speed), so
 * engine.list, a turn's options and turn.started read and write it the same way here.
 *
 * Codex's catalog calls its Fast tier "priority" (the deprecated `additionalSpeedTiers` said "fast"): the protocol says
 * "fast" and the runtime sends Codex its own id. Its "flex" tier is slower and cheaper, not faster, so it is never one
 * of a model's speeds.
 */
export const STANDARD_SPEED = "standard";

const FAST_MODE = "fastMode";
const SERVICE_TIER = "serviceTier";
/** Codex's standard tier, as its catalog and `serviceTierForTurn` name it. */
const DEFAULT_TIER = "default";
const SLOWER_TIERS: ReadonlySet<string> = new Set(["flex"]);
/** A Codex tier's speed: its "default" is standard and its "priority" is fast; the rest keep their ids. */
const speedOfTier = (tier: string): string => (tier === DEFAULT_TIER ? STANDARD_SPEED : tier === "priority" ? "fast" : tier);

interface DescriptorLike {
  readonly id: string;
  readonly type: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly isDefault?: boolean | undefined }> | undefined;
  readonly currentValue?: unknown;
}

const speedDescriptorOf = <D extends DescriptorLike>(descriptors: ReadonlyArray<D> | undefined): D | undefined =>
  descriptors?.find((d) => (d.type === "boolean" && d.id === FAST_MODE) || (d.type === "select" && d.id === SERVICE_TIER));

/** A model's speeds past standard, slowest first, and the one it runs at when a turn names none (absent: standard). */
export function speedsOf(descriptors: ReadonlyArray<DescriptorLike> | undefined): { speeds: string[]; defaultSpeed?: string } {
  const d = speedDescriptorOf(descriptors);
  if (d === undefined) return { speeds: [] };
  if (d.type === "boolean") return { speeds: ["fast"], ...(d.currentValue === true ? { defaultSpeed: "fast" } : {}) };
  const speeds = [...new Set((d.options ?? []).map((o) => o.id).filter((id) => id !== DEFAULT_TIER && !SLOWER_TIERS.has(id)).map(speedOfTier))];
  const tier = d.options?.find((o) => o.isDefault)?.id ?? (typeof d.currentValue === "string" ? d.currentValue : undefined);
  const fallback = tier === undefined || SLOWER_TIERS.has(tier) ? undefined : speedOfTier(tier);
  return { speeds, ...(fallback !== undefined && speeds.includes(fallback) ? { defaultSpeed: fallback } : {}) };
}

/**
 * `speed` as the model's own option. Undefined when the model has no speed to set; an error message when it offers
 * no such speed. Standard is said out loud (fastMode off, Codex's "default" tier): Codex keeps a thread's tier until a
 * turn names another.
 */
export function speedOptionFor(
  descriptors: ReadonlyArray<DescriptorLike> | undefined,
  speed: string,
): { readonly option?: { readonly id: string; readonly value: string | boolean }; readonly error?: string } {
  const d = speedDescriptorOf(descriptors);
  if (d === undefined) return speed === STANDARD_SPEED ? {} : { error: `has no speed "${speed}"` };
  if (speed !== STANDARD_SPEED && !speedsOf(descriptors).speeds.includes(speed)) return { error: `has no speed "${speed}"` };
  if (d.type === "boolean") return { option: { id: FAST_MODE, value: speed !== STANDARD_SPEED } };
  if (speed === STANDARD_SPEED) return { option: { id: SERVICE_TIER, value: DEFAULT_TIER } };
  const tier = d.options!.find((o) => !SLOWER_TIERS.has(o.id) && speedOfTier(o.id) === speed)!.id;
  return { option: { id: SERVICE_TIER, value: tier } };
}

/** The speed a model selection's options name, if any (for turn.started and to keep a chat's own). */
export function speedValueOf(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const o of options as ReadonlyArray<{ readonly id?: unknown; readonly value?: unknown }>) {
    if (typeof o !== "object" || o === null) continue;
    if (o.id === FAST_MODE && typeof o.value === "boolean") return o.value ? "fast" : STANDARD_SPEED;
    if (o.id === SERVICE_TIER && typeof o.value === "string" && o.value.length > 0) {
      return SLOWER_TIERS.has(o.value) ? undefined : speedOfTier(o.value);
    }
  }
  return undefined;
}
