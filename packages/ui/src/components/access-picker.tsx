import { Icon, CheckmarkBadge01Icon, PencilEdit02Icon, SquareLock02Icon, SquareUnlock02Icon, type IconSvgElement } from "../icons/huge";
import { SettingRow } from "./chat-settings";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./dropdown-menu";
import { menuDescription } from "./menu";

/*
 * Permissions: what the engine may do without asking (Session Protocol
 * AccessMode, upstream runtime modes and labels). A row of the chat's
 * settings (chat-settings.tsx), behind the sliders on the composer's bottom
 * bar: "Permissions  Full access ›", the modes beside it, only those the engine
 * offers, each with one plain line. A pick applies to that chat; new chats
 * start from Settings > General. Each mode wears its own glyph on its row
 * (compact padlock, pencil, shield): Supervised the padlock shut, Full
 * access the padlock open.
 */

export type AccessMode = "ask" | "auto" | "review" | "full";
export const ACCESS_MODES: readonly AccessMode[] = ["ask", "auto", "review", "full"];

export const ACCESS: Record<AccessMode, { label: string; line: string; icon: IconSvgElement }> = {
  ask: { label: "Supervised", line: "Ask before commands and file changes", icon: SquareLock02Icon },
  auto: { label: "Auto-accept edits", line: "Auto-approve edits, ask before other actions", icon: PencilEdit02Icon },
  review: { label: "Auto", line: "Supported engines approve routine actions; others still ask", icon: CheckmarkBadge01Icon },
  full: { label: "Full access", line: "Allow commands and edits without prompts", icon: SquareUnlock02Icon },
};

/** upstream initial default for new chats. */
export const DEFAULT_ACCESS: AccessMode = "full";

/**
 * The mode a chat runs in: the wanted one if the engine offers it; a wanted
 * mode it does not offer runs Supervised (as the runtime runs it); with none
 * wanted, full access. Else the engine's first.
 */
export function pickAccess(modes: readonly AccessMode[] | undefined, wanted?: AccessMode): AccessMode {
  const allowed = modes && modes.length ? modes : ACCESS_MODES;
  const choice = wanted === undefined ? DEFAULT_ACCESS : allowed.includes(wanted) ? wanted : "ask";
  return allowed.includes(choice) ? choice : allowed[0]!;
}

export function AccessSetting({
  modes,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  /** EngineDescriptor.access_modes; absent means all four. */
  modes: readonly AccessMode[] | undefined;
  value: AccessMode;
  onChange: (mode: AccessMode) => void;
  /** Opened from outside (the composer's /permissions); left out, the row keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const allowed = modes && modes.length ? modes : ACCESS_MODES;
  return (
    <SettingRow label="Permissions" value={ACCESS[value].label} className="min-w-[420px]" {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as AccessMode)}>
        {allowed.map((mode) => (
          <DropdownMenuRadioItem key={mode} value={mode}>
            <Icon icon={ACCESS[mode].icon} className="size-4 shrink-0" />
            <span className="shrink-0">{ACCESS[mode].label}</span>
            <span className={menuDescription}>{ACCESS[mode].line}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </SettingRow>
  );
}
