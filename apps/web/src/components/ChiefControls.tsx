import type { ChiefAutonomyLevel, ChiefProfile, Settings } from "@caveman-app/session-protocol";
import { StepSlider } from "@caveman-app/ui/components/effort";

export type Autonomy = ChiefAutonomyLevel;

/** How much a Chief does without asking (its autonomy). The runtime's default is 2. */
export const AUTONOMY: ReadonlyArray<{ id: Autonomy; label: string }> = [
  { id: 1, label: "Ask" },
  { id: 2, label: "Start" },
  { id: 3, label: "Manage" },
];

export const DEFAULT_AUTONOMY: Autonomy = 2;

type Levels = {
  readonly autonomy: (typeof AUTONOMY)[number];
};

/**
 * A Chief's levels in force: its own (its profile), else Settings' (every Chief that picked none), else the defaults.
 * What the person hears is fixed (docs/chief.md "Its screen"), so `updates` on a profile or in Settings is never read.
 */
export function levelsOf(
  profile: Pick<ChiefProfile, "autonomy"> | null | undefined,
  settings: Pick<Settings, "chief_autonomy"> | null | undefined,
): Levels {
  const autonomy = profile?.autonomy ?? settings?.chief_autonomy ?? DEFAULT_AUTONOMY;
  return { autonomy: AUTONOMY.find((a) => a.id === autonomy) ?? AUTONOMY[1]! };
}

/**
 * One of a Chief's levels as the model picker's effort slider draws it (StepSlider): a stop per level, a notched pixel
 * thumb that glides between them, and the level's name after the track.
 */
export function LevelSlider<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const byKey = new Map(options.map((o) => [String(o.id), o]));
  return (
    <StepSlider
      label={label}
      levels={options.map((o) => String(o.id))}
      value={String(value)}
      labelOf={(key) => byKey.get(key)?.label ?? key}
      onChange={(key) => {
        const next = byKey.get(key);
        if (next) onChange(next.id);
      }}
      className="w-[280px]"
      wordClassName="min-w-[76px]"
    />
  );
}
