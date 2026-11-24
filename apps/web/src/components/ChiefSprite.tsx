import type { ChiefAvatar } from "@caveman-app/session-protocol";
import type { MascotCharacter, MascotPose } from "@caveman-app/ui/mascot/poses";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";

/** A runtime from before several Chiefs has no profile: its one Chief is the caveman. */
export const DEFAULT_AVATAR: ChiefAvatar = { character: "caveman", tone: "medium-light" };

/**
 * A Chief's pixel character: the mascot's body (24x24 a scale) played by its pick of the cast, in its skin tone.
 * Still unless `animate`; held still inside a `.px-play-hover` row, it waves once on hover (STYLE.md 10).
 */
export function ChiefSprite({ avatar, pose = "wave", scale = 1, animate = false, label, className }: { avatar: ChiefAvatar | null; pose?: MascotPose; scale?: 1 | 2 | 3 | 4; animate?: boolean; label?: string; className?: string }) {
  const { character, tone } = avatar ?? DEFAULT_AVATAR;
  return <Mascot cut="body" character={character as MascotCharacter} tone={tone} pose={pose} scale={scale} animate={animate} {...(label ? { label } : {})} {...(className ? { className } : {})} />;
}
