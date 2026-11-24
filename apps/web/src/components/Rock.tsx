import rockUrl from "@caveman-app/ui/assets/rock.svg";
import { cn } from "@caveman-app/ui/lib/cn";

/** The pixel Caveman Rock: the Caveman engine's face and its working indicator. */
export function Rock({ size = 16, working = false, className }: { size?: number; working?: boolean; className?: string }) {
  return (
    <img
      src={rockUrl}
      alt=""
      aria-hidden
      draggable={false}
      width={Math.round(size * 1.75)}
      height={size}
      className={cn("shrink-0 select-none [image-rendering:pixelated]", working && "animate-rock-hop motion-reduce:animate-none", className)}
      style={{ height: size, width: "auto" }}
    />
  );
}
