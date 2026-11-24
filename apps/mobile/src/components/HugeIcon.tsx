// Chrome icons on the web and Android: Hugeicons' free line set, the same glyphs the desktop draws for the same things
// (packages/ui/src/icons/huge.tsx and where apps/web uses each), one deep import per glyph so the bundle never carries
// the catalog. On an iPhone, Icon.ios.tsx draws the same names as SF Symbols and falls back to these. A few are
// drawn here in Hugeicons' format and stroke where the set has nothing that reads at this size. Identity (states,
// engines, nav, folders, tools) is pixel art (Pixel.tsx); never draw one concept both ways on one screen.
//
// Sizes: 20 beside a row's 15 to 16pt label (the desktop's 16 beside 13px), 22 in a top bar's round button, 16 inside a
// small chip or beside 13pt meta. Stroke 1.75 everywhere, the desktop's; 2 only for a check that confirms a choice.
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import AlarmClockIcon from "@hugeicons/core-free-icons/AlarmClockIcon";
import Archive02Icon from "@hugeicons/core-free-icons/Archive02Icon";
import ArchiveRestoreIcon from "@hugeicons/core-free-icons/ArchiveRestoreIcon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowDown02Icon from "@hugeicons/core-free-icons/ArrowDown02Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowLeft02Icon from "@hugeicons/core-free-icons/ArrowLeft02Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import Call02Icon from "@hugeicons/core-free-icons/Call02Icon";
import CallEnd01Icon from "@hugeicons/core-free-icons/CallEnd01Icon";
import Camera01Icon from "@hugeicons/core-free-icons/Camera01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckListIcon from "@hugeicons/core-free-icons/CheckListIcon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import Comment01Icon from "@hugeicons/core-free-icons/Comment01Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import DragDropVerticalIcon from "@hugeicons/core-free-icons/DragDropVerticalIcon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import FileDiffIcon from "@hugeicons/core-free-icons/FileDiffIcon";
import FlashIcon from "@hugeicons/core-free-icons/FlashIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import GitForkIcon from "@hugeicons/core-free-icons/GitForkIcon";
import GitMergeIcon from "@hugeicons/core-free-icons/GitMergeIcon";
import GitPullRequestIcon from "@hugeicons/core-free-icons/GitPullRequestIcon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import InternetIcon from "@hugeicons/core-free-icons/InternetIcon";
import LaptopIcon from "@hugeicons/core-free-icons/LaptopIcon";
import LinkSquare02Icon from "@hugeicons/core-free-icons/LinkSquare02Icon";
import ListFilterIcon from "@hugeicons/core-free-icons/ListFilterIcon";
import Mic02Icon from "@hugeicons/core-free-icons/Mic02Icon";
import MicOff02Icon from "@hugeicons/core-free-icons/MicOff02Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import PinIcon from "@hugeicons/core-free-icons/PinIcon";
import PinOffIcon from "@hugeicons/core-free-icons/PinOffIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import PreferenceHorizontalIcon from "@hugeicons/core-free-icons/PreferenceHorizontalIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Share03Icon from "@hugeicons/core-free-icons/Share03Icon";
import SquareLock02Icon from "@hugeicons/core-free-icons/SquareLock02Icon";
import SquareTerminalIcon from "@hugeicons/core-free-icons/SquareTerminalIcon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import ThumbsDownIcon from "@hugeicons/core-free-icons/ThumbsDownIcon";
import ThumbsUpIcon from "@hugeicons/core-free-icons/ThumbsUpIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import Undo02Icon from "@hugeicons/core-free-icons/Undo02Icon";
import ViewIcon from "@hugeicons/core-free-icons/ViewIcon";
import VolumeHighIcon from "@hugeicons/core-free-icons/VolumeHighIcon";
import AlarmClockOffIcon from "@hugeicons/core-free-icons/AlarmClockOffIcon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import CircleDotIcon from "@hugeicons/core-free-icons/CircleDotIcon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";
import MailOpen01Icon from "@hugeicons/core-free-icons/MailOpen01Icon";
import PanelLeftCloseIcon from "@hugeicons/core-free-icons/PanelLeftCloseIcon";
import PanelLeftOpenIcon from "@hugeicons/core-free-icons/PanelLeftOpenIcon";
import PanelRightCloseIcon from "@hugeicons/core-free-icons/PanelRightCloseIcon";
import PanelRightIcon from "@hugeicons/core-free-icons/PanelRightIcon";
import GitPullRequestDraftIcon from "@hugeicons/core-free-icons/GitPullRequestDraftIcon";
import GitPullRequestClosedIcon from "@hugeicons/core-free-icons/GitPullRequestClosedIcon";
import CallEnd04Icon from "@hugeicons/core-free-icons/CallEnd04Icon";
import DashboardSquareAddIcon from "@hugeicons/core-free-icons/DashboardSquareAddIcon";
import Plug01Icon from "@hugeicons/core-free-icons/Plug01Icon";
import ScanIcon from "@hugeicons/core-free-icons/ScanIcon";
import HourglassIcon from "@hugeicons/core-free-icons/HourglassIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { useTheme } from "../theme";

/** Two lines, the lower one shorter: the sidebar's handle, as compact draws it. */
const MenuIcon: IconSvgElement = [["path", { d: "M4 9h16M4 15h10", stroke: "currentColor", strokeLinecap: "round", key: "0" }]];

/** Three short even lines: the button that shows the sidebar behind the main panel, for clean mobile navigation. */
const SidebarIcon: IconSvgElement = [["path", { d: "M5.5 7h13M5.5 12h13M5.5 17h13", stroke: "currentColor", strokeLinecap: "round", key: "0" }]];

/** Voice mode: a short waveform, five bars. */
const VoiceIcon: IconSvgElement = [["path", { d: "M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3", stroke: "currentColor", strokeLinecap: "round", key: "0" }]];

/** Stop: the desktop's send button while a turn runs holds a small filled square (Composer.tsx, SquareIcon filled). */
const StopIcon: IconSvgElement = [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2.5", fill: "currentColor", stroke: "currentColor", key: "0" }]];

const glyphs = {
  add: Add01Icon,
  alert: Alert02Icon,
  archive: Archive02Icon,
  // The scroll-to-newest arrow (conversation.tsx ScrollButton).
  arrowDown: ArrowDown02Icon,
  // A page's way back to its list, an arrow with a shaft (Settings' "All settings", ArrowLeft02Icon).
  arrowBack: ArrowLeft02Icon,
  attachFile: File01Icon,
  back: ArrowLeft01Icon,
  branch: GitBranchIcon,
  call: Call02Icon,
  callEnd: CallEnd01Icon,
  camera: Camera01Icon,
  check: Tick02Icon,
  checklist: CheckListIcon,
  chevronDown: ArrowDown01Icon,
  chevronLeft: ArrowLeft01Icon,
  chevronRight: ArrowRight01Icon,
  chevronUp: ArrowUp01Icon,
  close: Cancel01Icon,
  code: CodeIcon,
  comment: Comment01Icon,
  compose: PencilEdit02Icon,
  copy: Copy01Icon,
  delete: Delete02Icon,
  diff: FileDiffIcon,
  filter: ListFilterIcon,
  folder: Folder01Icon,
  fork: GitForkIcon,
  grip: DragDropVerticalIcon,
  home: Home01Icon,
  info: InformationCircleIcon,
  laptop: LaptopIcon,
  link: LinkSquare02Icon,
  lock: SquareLock02Icon,
  menu: MenuIcon,
  merge: GitMergeIcon,
  mic: Mic02Icon,
  micOff: MicOff02Icon,
  more: MoreHorizontalIcon,
  open: ArrowUpRight01Icon,
  pause: PauseIcon,
  photos: Image01Icon,
  pin: PinIcon,
  play: PlayIcon,
  pullRequest: GitPullRequestIcon,
  /** Review's state marks for a draft and a closed pull request (review/parts.tsx STATE). */
  pullRequestDraft: GitPullRequestDraftIcon,
  pullRequestClosed: GitPullRequestClosedIcon,
  rename: PencilEdit02Icon,
  restore: ArchiveRestoreIcon,
  retry: Refresh01Icon,
  search: Search01Icon,
  send: ArrowUp02Icon,
  settings: Settings01Icon,
  share: Share03Icon,
 /** The chat's settings in the composer (the sliders glyph alone, ). */
  sliders: PreferenceHorizontalIcon,
  snooze: AlarmClockIcon,
  speak: VolumeHighIcon,
  /** A speed past standard (speed.tsx): the bolt, grey outline at standard, filled in `speed` when on. */
  speed: FlashIcon,
  star: StarIcon,
  stop: StopIcon,
  terminal: SquareTerminalIcon,
  thumbsDown: ThumbsDownIcon,
  thumbsUp: ThumbsUpIcon,
  undo: Undo02Icon,
  unpin: PinOffIcon,
  view: ViewIcon,
  voice: VoiceIcon,
  web: InternetIcon,
  /** Mark a chat done (InboxItems: CheckmarkCircle02). */
  markDone: CheckmarkCircle02Icon,
  /** Mark read and Mark unread (InboxItems: MailOpen01, Mail01). */
  markRead: MailOpen01Icon,
  markUnread: Mail01Icon,
  /** Hide the sidebar (SidebarToggle: PanelLeftClose). */
  sidebarClose: PanelLeftCloseIcon,
  /** Bring back the sidebar that stands beside the panel (the Duo unfolded; SidebarToggle: PanelLeftOpen). */
  sidebarOpen: PanelLeftOpenIcon,
  /** Open and close the inspector beside the panel (the desktop's side panel: PanelRight, PanelRightClose). */
  panel: PanelRightIcon,
  panelClose: PanelRightCloseIcon,
  /** Show the sidebar behind the main panel: a root screen's top left (shell/DrawerLayout.tsx). */
  sidebar: SidebarIcon,
  /** Wake a snoozed chat now: the menu's dot (InboxItems: CircleDot), the queue row's alarm off. */
  wake: CircleDotIcon,
  wakeNow: AlarmClockOffIcon,
  /** Connect: plugins, apps and MCP servers (Home's second circle). */
  connect: DashboardSquareAddIcon,
  /** Up to a subagent's parent. */
  parent: ArrowUp02Icon,
  /** Hang up a voice chat: the handset alone (CallEnd04's first path; its second is the cross). */
  hangUp: [CallEnd04Icon[0]!] as unknown as typeof CallEnd04Icon,
  /** A plugin or an MCP server. */
  plug: Plug01Icon,
  /** Screenshots. */
  scan: ScanIcon,
  /** The sidebar's queue mode (the desktop's hourglass): chats sorted by their state. */
  hourglass: HourglassIcon,
  /** The sidebar's Recent. */
  clock: Clock01Icon,
};

export type IconName = keyof typeof glyphs;

/** One chrome glyph. `filled` fills its shape in the same colour (a starred model, the bolt while a speed is on). */
export function HugeIcon({ name, size = 20, color, stroke = 1.75, filled = false }: { name: IconName; size?: number; color?: string; stroke?: number; filled?: boolean }) {
  const { c } = useTheme();
  const ink = color ?? c.text;
  return <HugeiconsIcon icon={glyphs[name]} size={size} color={ink} strokeWidth={stroke} {...(filled ? { fill: ink } : {})} />;
}
