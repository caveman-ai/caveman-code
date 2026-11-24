// Icons by role (STYLE.md section 7, ): what you act on or
// read is chrome, a Hugeicon; who or what is acting is identity, pixel art.
// `Glyph` takes any name from the set (names.ts) and draws it the right way:
// a chrome name as its Hugeicon, an engine or a state as its pixel drawing.
// A new chrome name won't compile until it has a Hugeicon here.
import { cn } from "../lib/cn";
import {
  Icon,
  Activity01Icon,
  Analytics01Icon,
  Attachment01Icon,
  Bookmark01Icon,
  BrowserIcon,
  BubbleChatAddIcon,
  Call02Icon,
  CallEnd01Icon,
  CheckListIcon,
  CheckmarkBadge01Icon,
  CloudIcon,
  CodeIcon,
  CommandLineIcon,
  CreditCardIcon,
  CrownIcon,
  DashboardSquare01Icon,
  FileAddIcon,
  FileDiffIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  File01Icon,
  FireIcon,
  FlashIcon,
  Folder01Icon,
  FolderOpenIcon,
  GiftIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  Globe02Icon,
  Image01Icon,
  InboxIcon,
  Key01Icon,
  KeyboardIcon,
  LaptopIcon,
  Layers01Icon,
  LayoutTwoColumnIcon,
  LinkSquare02Icon,
  LockPasswordIcon,
  McpServerIcon,
  Mic02Icon,
  MicOff02Icon,
  NoteAddIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlugSocketIcon,
  PreferenceHorizontalIcon,
  PuzzleIcon,
  RadioTowerIcon,
  Rocket01Icon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  SourceCodeIcon,
  SquareTerminalIcon,
  SquareUnlock02Icon,
  Target02Icon,
  UserCircleIcon,
  UserGroupIcon,
  Wrench01Icon,
  type IconSvgElement,
} from "./huge";
import type { PixelIconName, PixelIconProps } from "./names";
import { PixelIcon } from "./PixelIcon";

/** Names that stay pixel art: who is working (engines) and how it's going (states, the ring's family). */
type IdentityName = Extract<PixelIconName, `engine-${string}` | `state-${string}`>;
export type ChromeName = Exclude<PixelIconName, IdentityName>;

/** Every chrome name's Hugeicon: the one map from a concept to its glyph. */
export const CHROME_ICON: Record<ChromeName, IconSvgElement> = {
  chief: CrownIcon,
  inbox: InboxIcon,
  runs: Activity01Icon,
  spaces: PuzzleIcon,
  customize: PreferenceHorizontalIcon,
  automations: FlashIcon,
  rocket: Rocket01Icon,
  review: GitPullRequestIcon,
  settings: Settings01Icon,
  search: Search01Icon,
  new: BubbleChatAddIcon,

  "tool-search": Search01Icon,
  "tool-read": FileSearchIcon,
  "tool-edit": PencilEdit02Icon,
  "tool-create": FileAddIcon,
  "tool-run": CommandLineIcon,
  "tool-web": Globe02Icon,
  "tool-mcp": McpServerIcon,
  "tool-browser": BrowserIcon,
  "tool-subagent": UserGroupIcon,
  "tool-other": Wrench01Icon,

  "computer-this-mac": LaptopIcon,
  "computer-cloud": CloudIcon,
  "computer-vpc": ServerStack01Icon,

  "artifact-file": File01Icon,
  "artifact-markdown": FileTextIcon,
  "artifact-diff": FileDiffIcon,
  "artifact-plan": CheckListIcon,
  "artifact-image": Image01Icon,
  "artifact-table": FileSpreadsheetIcon,
  "artifact-terminal": SquareTerminalIcon,
  "artifact-link": LinkSquare02Icon,
  "artifact-pr": GitPullRequestIcon,
  "artifact-code": CodeIcon,

  attach: Attachment01Icon,
  goal: Target02Icon,
  "grill-mode": FireIcon,
  "record-skill": NoteAddIcon,
  space: PuzzleIcon,
  approve: CheckmarkBadge01Icon,
  unlocked: SquareUnlock02Icon,
  "split-view": LayoutTwoColumnIcon,
  call: Call02Icon,
  "call-end": CallEnd01Icon,
  mic: Mic02Icon,
  "mic-off": MicOff02Icon,

  overview: DashboardSquare01Icon,
  repo: SourceCodeIcon,
  folder: Folder01Icon,
  branch: GitBranchIcon,
  remote: RadioTowerIcon,
  context: Analytics01Icon,
  connector: PlugSocketIcon,
  outputs: Layers01Icon,
  changes: GitCompareIcon,
  bookmark: Bookmark01Icon,
  plan: CreditCardIcon,
  gift: GiftIcon,
  secret: LockPasswordIcon,
  actions: PlayIcon,
  account: UserCircleIcon,
  keyboard: KeyboardIcon,
  key: Key01Icon,
};

const isChrome = (name: PixelIconName): name is ChromeName => name in CHROME_ICON;

const SIZE = { 1: "size-4", 2: "size-8", 3: "size-12" } as const;

/** A name from the icon set, drawn by its role: a 16px (x scale) Hugeicon for chrome, the pixel drawing for identity. */
export function Glyph({ name, scale = 1, label, className, play }: PixelIconProps) {
  if (!isChrome(name))
    return <PixelIcon name={name} scale={scale} label={label} className={className} play={play} />;
  return (
    <Icon
      icon={CHROME_ICON[name]}
      className={cn(SIZE[scale], "shrink-0", className)}
      {...(label ? { "aria-label": label } : {})}
    />
  );
}

/** A folder, open or shut: chrome, so the Hugeicon pair (PixelFolder is the pixel one, kept for the style page). */
export function FolderGlyph({
  open,
  className,
}: {
  open: boolean;
  className?: string | undefined;
}) {
  return (
    <Icon
      icon={open ? FolderOpenIcon : Folder01Icon}
      className={cn("size-4 shrink-0", className)}
    />
  );
}
