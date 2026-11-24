import { cn } from "@caveman-app/ui/lib/cn";
import { PixelText } from "@caveman-app/ui/components/pixel-text";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import type { MascotCharacter, MascotPose, SkinTone } from "@caveman-app/ui/mascot/poses";
import { arriveMotion } from "@caveman-app/ui/motion";
import { useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";

const BONKS = ["BONK!", "OOF!", "UGH!", "OOGA!", "BOOGA!"];
const POP_MS = 720;

/**
 * The mascot standing on a dithered floor (STYLE.md sections 6 and 10). The body sprite is 24 px wide.
 * Click him and he gets bonked: a whole-pixel squash and a retro word that pops up and blinks out.
 */
export function MascotOnFloor({ pose, scale, character, tone, floor = true }: { pose: MascotPose; scale: 2 | 3 | 4; character?: MascotCharacter; tone?: SkinTone; floor?: boolean }) {
  const body = useRef<HTMLSpanElement>(null);
  const next = useRef(0);
  const [pops, setPops] = useState<{ id: number; word: string; dx: number }[]>([]);

  const bonk = () => {
    const id = next.current++;
    const word = BONKS[Math.floor(Math.random() * BONKS.length)]!;
    // Whole-pixel drift so stacked pops don't sit on top of each other.
    const dx = (Math.floor(Math.random() * 5) - 2) * 2 * scale;
    setPops((p) => [...p, { id, word, dx }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), POP_MS);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const px = (n: number) => `translateY(${n * scale}px)`;
      body.current?.animate([{ transform: px(2) }, { transform: px(-1) }, { transform: px(0) }], {
        duration: 240,
        easing: "steps(1, jump-end)",
      });
    }
  };

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        aria-label="Bonk the caveman"
        onClick={bonk}
        className="relative cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span ref={body} className="flex">
          <Mascot pose={pose} scale={scale} {...(character ? { character } : {})} {...(tone ? { tone } : {})} />
        </span>
        {pops.map((p) => (
          <span
            key={p.id}
            aria-hidden
            className="mascot-bonk pointer-events-none absolute bottom-full left-1/2 text-[hsl(var(--id-tunic))]"
            style={{ "--dx": `${p.dx}px`, "--rise": `${-6 * scale}px` } as CSSProperties}
          >
            <PixelText text={p.word} scale={Math.max(2, scale - 1)} shadow />
          </span>
        ))}
      </button>
      {floor ? <span aria-hidden className="px-dither-50 block text-[hsl(var(--subtle-foreground))]" style={{ width: 24 * scale + 8 * scale, height: scale * 2 }} /> : null}
    </div>
  );
}

/** The page-level title and line, for a caller that needs its own elements for them (a dialog's Title and Description). */
export const emptyTitle = "text-balance text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground";
export const emptyLine = "max-w-[340px] text-balance text-[13px] leading-5 text-[hsl(var(--subtle-foreground))]";

/**
 * The page-level empty state, for a whole page or main column with nothing in it: the mascot at 2x on its floor (the
 * view's one pixel focal point, STYLE.md sections 1 and 10), a 17px sentence-case title, one line on what will appear
 * and how, and the one real next step under it (`action`: a small `<Button>`). A side panel, a card or a list inside a
 * page uses SurfaceEmpty (panels/chrome.tsx) instead.
 * `avatar`: who stands there instead of your companion (a Chief, as its character).
 * `titleAs` / `lineAs`: the elements for the title and the line (a dialog passes its Title and Description).
 */
export function EmptyState({
  pose,
  title,
  children,
  action,
  className,
  avatar,
  titleAs: Title = "h2",
  lineAs: Line = "div",
}: {
  pose: MascotPose;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  avatar?: { readonly character: string; readonly tone: SkinTone } | null;
  titleAs?: ElementType;
  lineAs?: ElementType;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", arriveMotion, className)}>
      <MascotOnFloor pose={pose} scale={2} {...(avatar ? { character: avatar.character as MascotCharacter, tone: avatar.tone } : {})} />
      <Title className={cn("mt-4", emptyTitle)}>{title}</Title>
      {children ? <Line className={cn("mt-1", emptyLine)}>{children}</Line> : null}
      {action ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
