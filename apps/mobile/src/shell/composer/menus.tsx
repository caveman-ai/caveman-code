// What the box's modes and settings are, as the desktop names them (apps/web/src/components/Composer.tsx,
// packages/ui access-picker.tsx, chat-settings.tsx). `+` opens its menu in the keyboard's place (ContextPanel.tsx): Mode is one of
// Plan, Grill me and Goal; the chat's settings are the desktop's rows, each a name, its value in grey and a chevron,
// the choices opening in place. Permissions is always there; a screen adds its own rows above it and below it (a
// Chief's projects, then after a rule its settings).
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { View } from "react-native";
import type { Chat } from "../../board/model";
import { PixelIcon } from "../../components/Pixel";
import type { MenuEntry } from "../../components/ui/Menu";

export interface Mode {
  icon: PixelIconName;
  /** The chip's word: "Plan", "Grill me", "Goal". */
  label: string;
}

/** A chat `+` can reference. */
export type ChatRef = Pick<Chat, "id" | "title" | "engine" | "repo">;

export const PLAN: Mode = { icon: "plan", label: "Plan" };
export const GRILL: Mode = { icon: "grill-mode", label: "Grill me" };
export const GOAL: Mode = { icon: "goal", label: "Goal" };

/** What `+` attaches: the desktop's files and images, and a photo taken there and then. */
export type Attach = "Files" | "Images" | "Camera";

/** What the engine may do without asking (Session Protocol AccessMode, upstream modes and words). */
export type Access = "ask" | "auto" | "review" | "full";
export const ACCESS: Record<Access, { label: string; line: string; icon: PixelIconName }> = {
  ask: { label: "Supervised", line: "Ask before commands and file changes", icon: "secret" },
  auto: { label: "Auto-accept edits", line: "Auto-approve edits, ask before other actions", icon: "tool-edit" },
  review: { label: "Auto", line: "Supported engines approve routine actions; others still ask", icon: "approve" },
  full: { label: "Full access", line: "Allow commands and edits without prompts", icon: "unlocked" },
};
const ACCESS_MODES = Object.keys(ACCESS) as Access[];

/**
 * The chat's settings: the screen's own rows, Permissions, then what the screen adds below it (a Chief's Projects, a
 * rule, its settings), as the desktop's ChatSettings stacks them. A Chief's
 * chats can take what a new chat would ("Same as new chats", null), as its box offers on the desktop (chief-sheet.tsx
 * ChiefBoxSettings); the row's value then reads what that resolves to, `newChats` (Settings > General).
 */
export function settingsEntries({ rows = [], after = [], access, onAccess, chief, newChats }: { rows?: readonly MenuEntry[]; after?: readonly MenuEntry[]; access: Access | null; onAccess: (access: Access | null) => void; chief: boolean; newChats: Access }): MenuEntry[] {
  const choices: MenuEntry[] = ACCESS_MODES.map((m) => ({ label: ACCESS[m].label, description: ACCESS[m].line, under: true, icon: <PixelIcon name={ACCESS[m].icon} />, checked: access === m, onPress: () => onAccess(m) }));
  if (chief) choices.unshift({ label: "Same as new chats", description: ACCESS[newChats].label, under: true, icon: <View style={{ width: 16 }} />, checked: access === null, onPress: () => onAccess(null) });
  const permissions: MenuEntry = { label: "Permissions", icon: "lock", value: ACCESS[access ?? newChats].label, submenu: choices };
  return [...rows, permissions, ...after];
}
