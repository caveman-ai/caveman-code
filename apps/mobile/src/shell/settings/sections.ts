// The Settings sections, as words only, in the desktop's groups and order (apps/web/src/routes/settings/sections.ts):
// You, App, Work. A phone keeps the ones that make sense in a hand. Keyboard is gone (a phone prints no keys),
// Notifications stands on its own (on the desktop a card in General, here what reaches your pocket), and About closes
// the list with the version and What's new, which the desktop keeps in General's app card.
//
// A board that is the person's own lists only what is real there: Account, Appearance, Models & keys, Computers and
// About. General, Notifications, Chiefs and Caveman MCP are the scripted world's until the phone can send what they
// set to a computer (`scriptedOnly`): a control that changes nothing is not shown.
import type { PixelIconName } from "@caveman-app/ui/icons/names";

export type SectionId = "account" | "general" | "notifications" | "appearance" | "chief" | "models" | "caveman-mcp" | "computers" | "about";

export interface SettingsSection {
  readonly id: SectionId;
  readonly label: string;
  readonly icon: PixelIconName;
  /** One line under the page's title. */
  readonly description: string;
  /** Extra words the search matches. */
  readonly keywords?: string;
  /** The scripted world's alone: what it sets reaches no computer yet, so a person's own board does not list it. */
  readonly scriptedOnly?: true;
}

export const SETTINGS_GROUPS: readonly { label: string | null; sections: readonly SettingsSection[] }[] = [
  {
    label: "You",
    sections: [{ id: "account", label: "Account", icon: "account", description: "Your Caveman account and plan.", keywords: "sign in sign out email plan used resets limit week month" }],
  },
  {
    label: "App",
    sections: [
      { id: "general", label: "General", icon: "settings", description: "How Caveman Code behaves on your computer.", keywords: "permissions model new chats inbox done archive git co-author", scriptedOnly: true },
      { id: "notifications", label: "Notifications", icon: "inbox", description: "What reaches you while Caveman Code is in the background.", keywords: "alerts push live activity lock screen island", scriptedOnly: true },
      { id: "appearance", label: "Appearance", icon: "customize", description: "Home's briefing, theme and your companion.", keywords: "theme dark light gallery companion skin tone mascot home briefing while you were away minimal tags" },
    ],
  },
  {
    label: "Work",
    sections: [
      { id: "chief", label: "Chiefs", icon: "chief", description: "Your Chiefs, and the limits they all work within.", keywords: "chiefs limits calls voice deepgram ring back pause", scriptedOnly: true },
      {
        id: "models",
        label: "Models & keys",
        icon: "key",
        description: "The plans and keys your agents run on.",
        keywords: "agents plans keys chatgpt copilot supergrok claude agent codex cursor api key sign in new chats start on engines subscriptions accounts",
      },
      {
        id: "caveman-mcp",
        label: "Caveman MCP",
        icon: "tool-mcp",
        description: "Let any agent on your Mac start chats here, follow them and answer their questions.",
        keywords: "outside agents mcp install connect grok codex cursor vs code disconnect",
        scriptedOnly: true,
      },
      { id: "computers", label: "Computers", icon: "computer-this-mac", description: "Where your chats run.", keywords: "this mac cloud computer sleep wake move" },
    ],
  },
  {
    label: null,
    sections: [{ id: "about", label: "About", icon: "rocket", description: "The version on your Mac, and what's new.", keywords: "version update release notes what's new" }],
  },
];

export const SECTIONS = SETTINGS_GROUPS.flatMap((g) => g.sections);

/** Whether a board lists a section: every one on the scripted board, and on a person's own only what is real there. */
export const listed = (section: Pick<SettingsSection, "scriptedOnly">, scripted: boolean): boolean => scripted || section.scriptedOnly !== true;

/** The groups a board lists, each with the sections it shows; a group left with none goes. */
export const groupsFor = (scripted: boolean): typeof SETTINGS_GROUPS => SETTINGS_GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => listed(s, scripted)) })).filter((g) => g.sections.length > 0);

/** Sections a board lists whose name, line or keywords hold every word of the query. */
export function findSettings(query: string, scripted = true): readonly SettingsSection[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SECTIONS.filter((s) => {
    if (!listed(s, scripted)) return false;
    const hay = `${s.label} ${s.description} ${s.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
