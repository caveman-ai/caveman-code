// One macOS permission computer use takes, as Settings > Computer use and the
// Computer tab show it: allowed (a check), or not yet.
import type { ComputerAccess } from "@caveman-app/session-protocol";
import { Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";

export function PermissionState({ state }: { state: ComputerAccess["accessibility"] }) {
  return state === "granted" ? (
    <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground">
      <Icon icon={Tick02Icon} className="size-3.5 text-success" aria-hidden />
      Allowed
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      Not allowed
    </span>
  );
}
