// The Settings sections, as words only: Settings.tsx draws them (each id has
// its page there) and ⌘K finds them without loading any settings code.
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { matches } from "../../lib/search.ts";

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly icon: PixelIconName;
  /** A few words on what is in it, for ⌘K's row and the filters. */
  readonly description: string;
  /** Extra words the filters match. */
  readonly keywords?: string;
  /** A list page: it fills the pane, its rows on hairlines under the page's title (rows.tsx SettingsPage). */
  readonly wide?: true;
}

/**
 * The nav, top to bottom: the app's own basics with no heading, then a heading per group, never more than seven
 * under one. A section keeps its id for good: the runtime's messages point people at "Settings > Models & keys" and
 * the like. Add a section here, then its page in Settings.tsx.
 */
export const SETTINGS_SECTIONS = [
  {
    label: "",
    sections: [
      { id: "general", label: "General", icon: "settings", description: "New chats, notifications, the inbox and this app", keywords: "git snooze updates chat titles naming rename permissions command line co-author usage stats keep awake" },
      { id: "appearance", label: "Appearance", icon: "engine-caveman", description: "Theme, wallpaper, text and your companion", keywords: "theme dark light font density companion wallpaper background image dither effect" },
      { id: "keyboard", label: "Keyboard", icon: "keyboard", description: "The send key and every shortcut", keywords: "shortcuts keys" },
      {
        id: "computer-use",
        label: "Computer use",
        icon: "computer-this-mac",
        description: "Let agents use the apps on this Mac",
        keywords: "desktop apps accessibility screen recording macos privacy allowed blocked agent-desktop take over pointer cursor background",
      },
      {
        id: "reports",
        label: "Problem reports",
        icon: "state-failed",
        description: "Tell the team what broke, with the logs you've read",
        keywords: "bug report problem feedback crash error logs support help delete",
      },
    ],
  },
  {
    label: "You",
    sections: [
      {
        id: "account",
        label: "Account",
        icon: "account",
        description: "Your Caveman account, team and Platform, and what Caveman holds",
        keywords:
          "sign in sign out team members organization held by caveman secrets access log who read delete service accounts code:run keys code policy automations board agents unattended console",
      },
      {
        id: "plan",
        label: "Plan",
        icon: "plan",
        description: "Your plan, credits and free months to give",
        keywords: "billing subscription upgrade pricing price pro max credits top up limits gift gifts invite friends trial free month stripe invoice",
        wide: true,
      },
      { id: "usage", label: "Usage", icon: "context", description: "What your engines used", keywords: "spend cost tokens measured plan limits" },
    ],
  },
  {
    label: "Agents",
    sections: [
      {
        id: "models",
        label: "Models & keys",
        icon: "key",
        description: "The plans, keys and agents your chats run on",
        keywords: "engines agents subscriptions plans chatgpt copilot supergrok claude codex cursor openai anthropic api key providers ollama web search",
        wide: true,
      },
      {
        id: "secret-providers",
        label: "Secret providers",
        icon: "secret",
        description: "Read keys and source control tokens from 1Password",
        keywords: "1password op secret manager vault reference tokens github bitbucket engine keys paste",
      },
      { id: "chief", label: "Chiefs", icon: "chief", description: "Your Chiefs and their limits", keywords: "chiefs soul character model permissions projects limits rules capture calls voice deepgram call" },
      { id: "agents", label: "Subagents", icon: "tool-subagent", description: "Limits and models for delegated agents", keywords: "subagents agents delegated role pins task kinds classifier by task new chats prefer always agent types" },
      { id: "memory", label: "Memory", icon: "bookmark", description: "What agents remember across chats", keywords: "notes remember memories forget pin" },
      {
        id: "caveman-mcp",
        label: "Caveman MCP",
        icon: "tool-mcp",
        description: "Let other agents on this Mac run Caveman Code",
        keywords: "outside agents mcp server install connect grok build claude code codex cursor vs code vscode opencode goose operate api external bot disconnect",
      },
      { id: "import", label: "Import", icon: "attach", description: "Your Claude Code, Codex and Cursor setup", keywords: "plugins skills mcp claude codex cursor marketplace folders" },
    ],
  },
  {
    label: "Code",
    sections: [
      {
        id: "projects",
        label: "Projects",
        icon: "repo",
        description: "Each project's sources, permissions, instructions and secrets",
        keywords: "repository repositories sources folders multi repo permissions instructions secrets env ignore hidden paths",
      },
      {
        id: "review",
        label: "Review",
        icon: "review",
        description: "Pull request guides: when, how deep, which model",
        keywords: "pull request pr guide tldr summary short threshold model prewarm code review",
      },
      { id: "archived", label: "Archived chats", icon: "state-sleeping", description: "Restore a chat you archived", keywords: "archive archived restore unarchive deleted chats" },
    ],
  },
  {
    label: "Cloud",
    sections: [
      { id: "computers", label: "Computers", icon: "computer-cloud", description: "Your Macs and Cloud, and what happens when this Mac sleeps", keywords: "cloud computer mac chats workspaces lid sleep asleep running delete", wide: true },
      {
        id: "devices",
        label: "Devices",
        icon: "remote",
        description: "Remote control, and what may control this computer",
        keywords: "remote control phone browser mac pair code approve allow block sign in caveman server",
      },
      {
        id: "environments",
        label: "Environments",
        icon: "customize",
        description: "The setup each repository's chats in Cloud start from",
        keywords: "cloud environments setup snapshot computer.toml repos repository github prepare warm",
        wide: true,
      },
    ],
  },
] as const satisfies ReadonlyArray<{ label: string; sections: ReadonlyArray<SettingsSection> }>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["sections"][number]["id"];

/**
 * The sections that hold the person's own settings, the ones that reach every computer of theirs (the runtime's
 * cloudLink/personSettings.ts PERSON_KEYS). Models & keys says its own, with what it connects.
 */
const PERSONAL: ReadonlySet<SettingsSectionId> = new Set(["general", "appearance", "keyboard", "chief", "agents", "review", "memory"]);

/** Cloud, where it keeps nothing of its person's, sends no setting on: one changed there holds there. */
export const HOLDS_HERE = "Changes here stay in Cloud. Change a setting on your Mac to change it everywhere.";

/** What a section says after its line on such a computer (`outside`: state/engines.ts credentialsOutside); null anywhere else. */
export const holdsHere = (section: string, outside: boolean): string | null => (outside && (PERSONAL as ReadonlySet<string>).has(section) ? HOLDS_HERE : null);

/** Sections whose name, line or keywords hold every word of the query; none for an empty query. */
export function findSettings(query: string): ReadonlyArray<SettingsSection> {
  if (!query.trim()) return [];
  return SETTINGS_SECTIONS.flatMap((g) => g.sections as ReadonlyArray<SettingsSection>).filter((s) => matches(query, `${s.label} ${s.description} ${s.keywords ?? ""}`));
}

/** The pages Cloud alone answers: a browser window shows them with no computer behind it. */
const CLOUDS_OWN: ReadonlySet<string> = new Set<SettingsSectionId>(["account", "plan", "models", "computers"]);

/** The computer a browser window uses now, by a name a page may say; null: none (state/runtime.tsx useWebWindow). */
export type WebHome = { readonly kind: "mac" | "cloud"; readonly name: string } | null;

/** Whose pages the rest are, over them in a browser window: "On Studio", "In Cloud". */
export const homeLabel = (home: NonNullable<WebHome>) => (home.kind === "cloud" ? "In Cloud" : `On ${home.name}`);

/**
 * The sections a window lists. The app (`home` undefined): all of them, as grouped. A browser window: Cloud's own
 * pages first, and a computer's pages only while the window uses one, under whose they are.
 */
export function settingsGroups(home?: WebHome): ReadonlyArray<{ readonly label: string; readonly sections: ReadonlyArray<SettingsSection> }> {
  if (home === undefined) return SETTINGS_SECTIONS;
  const all = SETTINGS_SECTIONS.flatMap((g) => g.sections as ReadonlyArray<SettingsSection>);
  const own = { label: "You", sections: all.filter((s) => CLOUDS_OWN.has(s.id)) };
  return home === null ? [own] : [own, { label: homeLabel(home), sections: all.filter((s) => !CLOUDS_OWN.has(s.id)) }];
}

/** Where Settings opens: General in the app; in a browser window Computers, which Cloud alone answers. */
export const settingsHome = (home?: WebHome) => (home === undefined ? "/settings/general" : "/settings/computers");

/** Section ids from before the regrouping, so old links still land. */
const MOVED: Readonly<Record<string, string>> = {
  engines: "/settings/models",
  spend: "/settings/usage",
  companion: "/settings/appearance",
  // Remote control and Devices have a page of their own.
  remote: "/settings/devices",
  // Held by Caveman is a fold under Account, and the Platform console a card on it.
  cloud: "/settings/account#held",
  "cloud-console": "/settings/account",
  secrets: "/settings/projects",
  spaces: "/plugins/yours",
  sources: "/plugins/yours",
  "outside-agents": "/settings/caveman-mcp",
};

/**
 * Where /settings/<id> should go instead: a moved section's new home; where Settings opens for an id that never was,
 * and for a computer's page in a browser window that uses no computer; else null.
 */
export function settingsRedirect(id: string, home?: WebHome): string | null {
  if (Object.hasOwn(MOVED, id)) return MOVED[id]!;
  return settingsGroups(home).some((g) => g.sections.some((s) => s.id === id)) ? null : settingsHome(home);
}
