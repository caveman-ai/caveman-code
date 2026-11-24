/**
 * The pixel icon set: every name the app may ask for. A contract between
 * lanes (STYLE.md "Icons"): ui-icons draws each name, everyone else only
 * renders names from this list. Adding a name is a STYLE.md change.
 *
 * Grid: 16x16 at 1x, shown at 16, 32 or 48 px (integer scale only).
 * `label` is the default accessible name and the visible label wherever the
 * icon stands alone (nav rows, legends). An icon is never the only carrier of
 * meaning: it sits next to its label or carries `aria-label`.
 */

export type PixelIconGroup =
  | "nav"
  | "engine"
  | "tool"
  | "state"
  | "computer"
  | "artifact"
  | "action"
  | "panel";

type Entry = { group: PixelIconGroup; label: string };

export const PIXEL_ICONS = {
  // Nav: the special buttons (STYLE.md "Special nav buttons").
  chief: { group: "nav", label: "Chief" }, // the tribe chief: a bearded caveman head under a bone crown
  inbox: { group: "nav", label: "Inbox" },
  runs: { group: "nav", label: "Runs" },
  spaces: { group: "nav", label: "Plugins" }, // the Plugins page (was Spaces): four blocks, four shapes
  customize: { group: "nav", label: "Customize" }, // three sliders
  automations: { group: "nav", label: "Automations" }, // a bolt
  rocket: { group: "nav", label: "Getting started" }, // the sidebar checklist's header
  review: { group: "nav", label: "Review" }, // the pull-request mark
  settings: { group: "nav", label: "Settings" },
  search: { group: "nav", label: "Search" },
  new: { group: "nav", label: "New workspace" },

  // Engines: our own tiles. Never a vendor logo, never a robot.
  "engine-caveman": { group: "engine", label: "Caveman" }, // the mascot bust
  "engine-claude-agent": { group: "engine", label: "Claude Agent" }, // clay monogram tile
  "engine-codex": { group: "engine", label: "Codex" }, // paper monogram tile
  "engine-acp": { group: "engine", label: "ACP agent" }, // sky monogram tile

  // Tool kinds (tool.started.kind; the verb is rendered from the kind).
  "tool-search": { group: "tool", label: "Search" },
  "tool-read": { group: "tool", label: "Read" },
  "tool-edit": { group: "tool", label: "Edit" },
  "tool-create": { group: "tool", label: "Create" },
  "tool-run": { group: "tool", label: "Run" },
  "tool-web": { group: "tool", label: "Web" },
  "tool-mcp": { group: "tool", label: "Connector" },
  "tool-browser": { group: "tool", label: "Browser" },
  "tool-subagent": { group: "tool", label: "Agent" }, // a tiny caveman, never a robot
  "tool-other": { group: "tool", label: "Tool" },

  // States: shape carries the meaning, state colour (--warning, --success,
  // --destructive) only reinforces it.
  "state-needs-input": { group: "state", label: "Needs input" },
  "state-needs-you": { group: "state", label: "Needs you" }, // a chat row's dot: it waits on you
  "state-working": { group: "state", label: "Working" },
  "state-agents": { group: "state", label: "Agents at work" },
  "state-agents-3": { group: "state", label: "Three agents at work" },
  "state-agents-4": { group: "state", label: "Four or more agents at work" },
  "state-stopped": { group: "state", label: "Stopped" },
  "state-done": { group: "state", label: "Done" },
  "state-finished": { group: "state", label: "Finished" }, // a chat row's green dot: its turn ended
  "state-connected": { group: "state", label: "Connected" }, // a check: the Plugins plus flips into it
  "state-failed": { group: "state", label: "Failed" },
  "state-sleeping": { group: "state", label: "Sleeping" },
  "state-queued": { group: "state", label: "Queued" },
  // The agent's states in a transcript line (glyphs.ts STATE_STRIPS).
  "state-thinking": { group: "state", label: "Thinking" },
  "state-compacting": { group: "state", label: "Compacting" },
  "state-compacted": { group: "state", label: "Compacted" },
  "state-routed": { group: "state", label: "Routed" },
  "state-retrying": { group: "state", label: "Retrying" },

  // Computers.
  "computer-this-mac": { group: "computer", label: "This Mac" },
  "computer-cloud": { group: "computer", label: "Cloud computer" },
  "computer-vpc": { group: "computer", label: "Your VPC" },

  // Artifacts: the type badge on every artifact card and side-panel header.
  "artifact-file": { group: "artifact", label: "File" },
  "artifact-markdown": { group: "artifact", label: "Document" },
  "artifact-diff": { group: "artifact", label: "Diff" },
  "artifact-plan": { group: "artifact", label: "Plan" },
  "artifact-image": { group: "artifact", label: "Image" },
  "artifact-table": { group: "artifact", label: "Table" },
  "artifact-terminal": { group: "artifact", label: "Terminal" },
  "artifact-link": { group: "artifact", label: "Link" },
  "artifact-pr": { group: "artifact", label: "Pull request" },
  "artifact-code": { group: "artifact", label: "Code" },

  // Composer "+" / "@" menu (STYLE.md "Visual hierarchy").
  attach: { group: "action", label: "Files and folders" },
  goal: { group: "action", label: "Goal" },
  "grill-mode": { group: "action", label: "Grill mode" }, // a kettle grill, flames up
  "record-skill": { group: "action", label: "Record a skill" },
  space: { group: "action", label: "Plugin" },
  approve: { group: "action", label: "Permissions" },
  unlocked: { group: "action", label: "Full access" }, // the padlock open: nothing asks first
  "split-view": { group: "action", label: "Split view" },
  // Calls with the Chief.
  call: { group: "action", label: "Call the Chief" }, // a handset
  "call-end": { group: "action", label: "Hang up" }, // the handset put down
  mic: { group: "action", label: "Mute" },
  "mic-off": { group: "action", label: "Unmute" },

  // Pane right panel cards.
  overview: { group: "panel", label: "Overview" },
  repo: { group: "panel", label: "Repository" },
  folder: { group: "panel", label: "Folder" },
  branch: { group: "panel", label: "Worktree branch" },
  remote: { group: "panel", label: "Remote access" },
  context: { group: "panel", label: "Context" },
  connector: { group: "panel", label: "Connectors" },
  outputs: { group: "panel", label: "Outputs" },
  changes: { group: "panel", label: "Changes" },
  bookmark: { group: "panel", label: "Bookmark" },
  plan: { group: "panel", label: "Plan" }, // stone money: the plan and its billing
  gift: { group: "panel", label: "Gift" }, // a free month to give a friend
  secret: { group: "panel", label: "Secrets" }, // a padlock: values stored, never shown
  actions: { group: "panel", label: "Actions" }, // a play mark: the project's commands, one click away
  account: { group: "panel", label: "Account" }, // a head and shoulders: you
  keyboard: { group: "panel", label: "Keyboard" }, // three rows of keys and the space bar
  key: { group: "panel", label: "Keys" }, // a key: the subscriptions and API keys chats run on
} as const satisfies Record<string, Entry>;

export type PixelIconName = keyof typeof PIXEL_ICONS;

export const PIXEL_ICON_NAMES = Object.keys(PIXEL_ICONS) as PixelIconName[];

/** Props every PixelIcon implementation takes (lane ui-icons). */
export type PixelIconProps = {
  name: PixelIconName;
  /** Integer scale of the 16px grid: 1 = 16px, 2 = 32px, 3 = 48px. */
  scale?: 1 | 2 | 3;
  /**
   * Accessible name. Omit when a visible label sits next to the icon (it is
   * then aria-hidden); pass it when the icon stands alone.
   */
  label?: string | undefined;
  className?: string | undefined;
  /**
   * Draw the toy (toys.ts) so hover and press play it. By default only inside
   * a `.px-play-hover` host; `false` keeps an icon still even there.
   */
  play?: boolean | undefined;
};

// Protocol value -> icon. Keyed by the Session Protocol v1 literals as plain
// strings so this package needs no protocol dependency.

/** tool.started.kind -> icon. "create" and "subagent" come from the tool name. */
export const TOOL_KIND_ICON: Record<string, PixelIconName> = {
  command: "tool-run",
  read: "tool-read",
  edit: "tool-edit",
  search: "tool-search",
  web: "tool-web",
  mcp: "tool-mcp",
  browser: "tool-browser",
  other: "tool-other",
};

/** Workspace.status -> icon. */
export const WORKSPACE_STATUS_ICON: Record<string, PixelIconName> = {
  starting: "state-queued",
  working: "state-working",
  needs_input: "state-needs-input",
  waiting: "state-queued",
  idle: "state-done",
  parked: "state-sleeping",
  archived: "state-sleeping",
  failed: "state-failed",
};

/** Computer.kind -> icon. */
export const COMPUTER_KIND_ICON: Record<string, PixelIconName> = {
  this_mac: "computer-this-mac",
  laptop: "computer-this-mac",
  caveman_cloud: "computer-cloud",
  pool: "computer-vpc",
};

/** EngineId -> icon. Unknown engines (any ACP agent) get the ACP tile. */
export function engineIcon(engine: string): PixelIconName {
  if (engine === "caveman") return "engine-caveman";
  if (engine === "claude-agent") return "engine-claude-agent";
  if (engine === "codex") return "engine-codex";
  return "engine-acp";
}
