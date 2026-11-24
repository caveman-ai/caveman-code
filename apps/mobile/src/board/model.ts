// The app's shape: chats and their transcripts, Chiefs, projects and devices. The scripted world that fills it is in
// world.ts. Both stand in for the Session Protocol: when the app connects to a runtime, chats and their transcripts
// come from its thread projection (Workspace, SessionEvent), devices from Cloud's computers, and `script` lines from
// each chat's live tool line.

import type { PixelIconName } from "@caveman-app/ui/icons/names";
import type { CastCharacter, SkinTone } from "@caveman-app/ui/mascot/poses";
import type { BoardAction } from "../store/board";
import type { Access } from "../shell/composer/menus";

/** The harnesses the board runs chats on: Caveman, the two first-class connectors, then registry engines. */
export type Engine = "caveman" | "claude" | "codex" | "cursor" | "opencode" | "grok";
/** An effort level, as the engines name them (the catalog's Level); each model offers some of them. */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** Where a chat stands, as the person cares about it: does it need me, can I try it, is it busy, is it over. */
export type Phase = "needs" | "ready" | "working" | "done";

export type Tool = "search" | "read" | "edit" | "run";

/** One thing an engine did, as the transcript's work group lists it. */
export interface Step {
  tool: Tool;
  text: string;
  detail?: string;
}

export interface FileChange {
  path: string;
  add: number;
  del: number;
}

/** Something to look at: what the engine made, and what it says about it. */
export interface Moment {
  headline: string;
  nudge: string;
  branch: string;
  checks: string;
  files: readonly FileChange[];
  changes: readonly string[];
  /** The engine's own closing words, as they land in the transcript. */
  summary: string;
  /**
   * How to try it, when there is something to try (the Ready to try page). "runs" is the drawn Runs page the dark-mode
   * chat built, live in the app; read either through `previewOf`.
   */
  preview?: "runs" | Preview;
}

/** The screens the prototype draws in place of the agent's browser and desktop frames (src/live/views.tsx). */
export type DrawnScreen = "runs" | "onboarding" | "desktop" | "simulator";

/**
 * The pictures the scripted chats name in place of an agent's screenshots. Ready to try drew them; it left with the
 * old Home.
 */
export type DrawnShot = "runs-dark" | "runs-light" | "push-lock" | "usage-tooltip" | "hero" | "email" | "fold";

/**
 * A screenshot the agent took while it checked its work: a runtime's is an image (`uri`); the prototype draws its own
 * (`drawn`). `caption` says what it shows in a word or two ("Light", "Lock screen").
 */
export interface Shot {
  caption: string;
  uri?: string;
  drawn?: DrawnShot;
}

/**
 * Something a chat built that you can try, and how (Session Protocol: the turn's preview and its screenshots). `try` is
 * the agent's one line on what to do with it, in the imperative ("Switch Settings > Appearance to light"). Then what
 * to try it on, any of: `live`, a preview that runs inside the app (the drawn Runs page; a runtime's: its branch's dev
 * server in a web view); `url`, a preview deploy, opened in the browser; `shots`, what it looked like when the agent
 * checked, the one to lead with first.
 */
export interface Preview {
  try: string;
  live?: "runs";
  url?: string;
  shots?: readonly Shot[];
}

/** The Runs page's preview, as "runs" stands for it: live in the app, both themes on film. */
const RUNS_PREVIEW: Preview = {
  try: "Switch Settings > Appearance to light, then back to dark",
  live: "runs",
  shots: [
    { caption: "Dark", drawn: "runs-dark" },
    { caption: "Light", drawn: "runs-light" },
  ],
};

/** How to try a moment, or null when it has nothing to try (an audit, a migration: read it, don't try it). */
export function previewOf(moment: Pick<Moment, "preview"> | undefined | null): Preview | null {
  const preview = moment?.preview;
  if (!preview) return null;
  return preview === "runs" ? RUNS_PREVIEW : preview;
}

/** One way an agent offers to go when it asks you for direction; at most one is the way it would go itself. */
export interface AskOption {
  label: string;
  /** What taking it means, in a few words ("Smallest change, +9 −2"). */
  detail?: string;
  recommended?: boolean;
}

/**
 * What a chat waits on you for (Session Protocol `ask`: upstream approval request, Claude's and Codex's question tool):
 * - `approval`: a command it wants to run, and why, in a few words, when the risk needs saying (Deny or Allow);
 * - `question`: direction it needs, the ways it sees (one recommended), and room to tell it something else.
 * Either way `summary` says in a sentence or two, verb first, what it did so far and what it found, so the ask can be
 * answered without opening the chat; `at` is when it asked, which keeps an ask in its place in every list, and puts it
 * back there after an Undo.
 */
export type Need =
  | { kind: "approval"; command: string; why?: string; summary: string; at: number }
  | { kind: "question"; question: string; options: readonly AskOption[]; summary: string; at: number };

/**
 * A picture that went with your message, kept with the chat as plain JSON: a library asset (`ph://…`), a file the
 * picker or the camera gave back (copied where the system won't clear it), a blob on the web; or, on the web build, one
 * of the prototype's drawn screenshots (`shot`, Thumbs.tsx SHOTS), which has no `uri` to load and is drawn instead.
 */
export interface SentImage {
  uri: string;
  width?: number;
  height?: number;
  shot?: string;
}

/**
 * The transcript, item by item. Text streams in from `at`, so reopening a chat never replays it.
 * - `you`: your message. `steer`: sent while a turn ran, so it joined that turn (the desktop's "Steered"); `state`:
 *   "sending" until the engine has it (a send is shown at once, Session Protocol `turn.submit` with a request id);
 *   "failed" when it was refused: what you typed stays in the thread, marked "Not sent · Send again".
 *   `images`: the pictures that went with it, shown over the words (and, with no words, alone).
 * - `text`: the engine's words. `phase` is Codex's: "commentary" while it works, "final" for the answer that ends the
 *   turn; without it, a turn's last text is its answer.
 * - `agents`: the subagents this turn spawned, by chat id (each is a chat of its own whose `parent` is this one).
 * - `stop`: you stopped the turn there.
 */
export type Item =
  | { kind: "you"; id: string; text: string; at: number; steer?: boolean; state?: "sending" | "sent" | "failed"; images?: readonly SentImage[] }
  | { kind: "text"; id: string; text: string; at: number; phase?: "commentary" | "final" }
  | { kind: "work"; id: string; steps: readonly Step[]; startedAt: number; endedAt?: number }
  | { kind: "changes"; id: string; moment: Moment }
  /**
   * What it waits on, while it waits: a command to allow, or (with `question`, `command` empty) direction. An approval
   * keeps its answer ("Allowed pnpm db:migrate"); a question, once answered, gives way to your answer as your message.
   */
  | { kind: "ask"; id: string; command: string; answer?: "allowed" | "denied"; question?: string; /** You answered, and its computer has not heard yet: what the line says meanwhile ("Allow queued · waking Cloud"). */ pending?: string }
  | { kind: "agents"; id: string; children: readonly string[] }
  | { kind: "stop"; id: string; at: number; /** A computer's chat: its runtime does not say who stopped the turn (you, here or on another device, or the computer itself), so the line does not either. */ unowned?: true };

/**
 * The script's stand-in for a turn in flight: the board actions it lands next, each a pause after the one before.
 * It is data on the chat, persisted with it, so a relaunch picks the turn up at `next` instead of losing its timers.
 */
export interface Plan {
  steps: readonly { ms: number; actions: readonly BoardAction[] }[];
  next: number;
}

export interface Chat {
  id: string;
  title: string;
  repo: string;
  /** The device it runs on (a Device id). */
  device: string;
  /** A subagent: the chat that spawned it. Subagents never show as rows; their asks light up the parent. */
  parent?: string;
  /**
   * The Chief that started it and watches it, set once when it is made; null for a chat you started yourself (from
   * Home's bar, a workspace or a device), which Home counts under "Your chats". A Chief's rows, capsule, sheets and
   * Search chips all read it; nothing guesses it from the repo.
   */
  chief?: string | null;
  engine: Engine;
  model: string;
  /**
   * A builder on a real computer: what became of it, as the computer its lead runs on says, in its row's words
   * ("Merged", "Left out: conflicts in a.ts", "Paused until 11:08 PM") and that state's one colour (live/builders.ts).
   */
  fate?: { words: string; tone: "quiet" | "warn" | "bad" };
  /** What its next turn runs at, once it is picked in this chat; absent, its model's own start. */
  effort?: Effort;
  speed?: string;
  /** What it may do without asking, as it started or its composer last set it; absent, Settings' for new chats. */
  access?: Access;
  phase: Phase;
  /** One line: what it is doing now (working), what it asks (needs), how it ended (done). */
  line: string;
  /** Working only: the lines it plays next, in a loop (the stand-in for the live stream). */
  script?: readonly string[];
  step?: number;
  /** Needs only: what it waits on you for, an approval or a question, with what it did so far. */
  need?: Need;
  /** Needs only: an approval's command, kept beside `need` for the readers that know only commands. */
  ask?: string;
  /** Ready only: what to look at. */
  moment?: Moment;
  /**
   * Scripted only: the agent's screens as the runtime would report them (Session Protocol browser.state and
   * computer.state, src/live/protocol.ts): the page its browser last showed, and its computer once it used it (a Cloud
   * computer's desktop, or on a Mac the `app` it used last); each with the drawing that stands in for the screen's
   * frames (src/live/views.tsx).
   */
  screens?: { browser?: { url: string; title: string; view: DrawnScreen }; computer?: { view: DrawnScreen; app?: { name: string; bundle_id?: string } } };
  /** Scripted only: the screen the agent works on during the turn it is playing (what the runtime's `active` notices say). */
  using?: "browser" | "computer";
  items: readonly Item[];
  pinned?: boolean;
  /**
   * A real computer's chat only: nothing runs yet. What it waits for, in one line (its place waking, its Mac, the
   * network), and since when: its own message says it, and nothing on screen says "Working" meanwhile.
   */
  wait?: { words: string; since: number };
  startedAt: number;
  /** When something last happened in it: a message, a step, a new phase. Lists sort the quiet ones by it. */
  updatedAt: number;
  /** Scripted only: the turn it is playing out, picked back up after a relaunch. */
  plan?: Plan;
}

/** A line in a Chief's chat: yours, the Chief's (`[[chat-id]]` marks a chat it names), or where a call ended. */
export interface Said {
  id: number;
  chief: string;
  who: "chief" | "you" | "call";
  text: string;
  at: number;
  /** Your line's pictures, when you sent some (the box's photos, a share). */
  images?: readonly SentImage[];
  /** A Chief's line about something it decided on its own, without asking you (Home's "While you were away"). */
  decided?: boolean;
}

/**
 * A Chief: its name, its pixel character from the mascot cast (what tells one Chief's chat from another's), and the
 * projects it sees (null is every project). Each chat sits on one Chief's board: the first whose projects hold its
 * repo, else the home Chief's. The runtime's `chief_profiles` (docs/chief.md, "Its profile").
 */
export interface Chief {
  id: string;
  name: string;
  character: CastCharacter;
  tone: SkinTone;
  projects: readonly string[] | null;
}

/** The Chiefs every board starts with. */
const SEEDED: readonly Chief[] = [
  { id: "home", name: "Chief", character: "caveman", tone: "medium-light", projects: null },
  { id: "oona", name: "Oona", character: "cavewoman", tone: "medium", projects: ["marketing"] },
  { id: "grug", name: "Grug", character: "elder", tone: "medium-dark", projects: ["Caveman Cloud"] },
];
const ALL: Chief[] = [...SEEDED];

/**
 * Every Chief, in the order they were made: the seeded ones, then the ones made on the phone (New Chief), which the
 * board keeps (`BoardState.chiefs`) and hands here as it changes (`adoptChiefs`), so every reader sees one list.
 */
export const CHIEFS: readonly Chief[] = ALL;

/** The board's own Chiefs after the seeded ones, in the order they were made. */
export function adoptChiefs(made: readonly Chief[]) {
  const seeded = new Set(SEEDED.map((c) => c.id));
  ALL.splice(0, ALL.length, ...SEEDED, ...made.filter((c) => !seeded.has(c.id)));
}

export const HOME_CHIEF = "home";

/** The Chief a chat is on: the one that started it, or null for one of your own. */
export function chiefOf(chat: Pick<Chat, "chief">): string | null {
  return chat.chief ?? null;
}

/**
 * The Chief that watches a workspace: the first whose projects hold it, else the home Chief. Only for where a Chief
 * would start its chat, and for chats from before `Chat.chief` (read back from disk); never for counting.
 */
export function chiefForRepo(repo: string): string {
  return CHIEFS.find((chief) => chief.projects?.includes(repo))?.id ?? HOME_CHIEF;
}

export const chiefById = (id: string): Chief => CHIEFS.find((chief) => chief.id === id) ?? (CHIEFS[0] as Chief);

export interface Toast {
  id: number;
  text: string;
  tone: "done" | "info";
  /** The Chief that says it in its own chat too; that Chief's screen skips the toast. */
  chief?: string;
  /** The chat it is about, so the toast can open it. */
  chat?: string;
}

export const ENGINE_NAME: Record<Engine, string> = { caveman: "Caveman", claude: "Claude Agent", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", grok: "Grok" };

export const PROJECTS = ["caveman-code", "Caveman Cloud", "marketing", "caveman-agent-sdk"] as const;

/**
 * A computer chats run on: a Mac with the runtime (this one or another of yours) or a Cloud computer (Session
 * Protocol `Computer`, Cloud's RuntimeState). `lastSeen` is when it last answered; `about` is its one line.
 */
export interface Device {
  id: string;
  name: string;
  kind: "mac" | "cloud";
  status: "online" | "asleep" | "offline" | "starting";
  lastSeen: number;
  about: string;
  /** The Mac this phone is paired with (it drives it through Remote control). Called by its name like the rest. */
  self?: boolean;
  /** A Mac's shape, for its glyph: a laptop (a MacBook) or a desktop (a Mac mini, a Studio). */
  form?: "laptop" | "desktop";
}

/** Where a chat runs unless it says otherwise. */
export const THIS_MAC = "mbp";

const minuteAgo = (n: number) => Date.now() - n * 60_000;
/**
 * The scripted world's computers, in the words a person's own are said in (live/words.ts): a Mac by its own name,
 * Online; Cloud as the one place it is, Running, never a machine with a name or a number.
 */
const SCRIPTED_DEVICES: readonly Device[] = [
  { id: THIS_MAC, name: "Julius's MacBook Pro", kind: "mac", status: "online", lastSeen: minuteAgo(0), about: "Online", self: true, form: "laptop" },
  { id: "studio", name: "Studio", kind: "mac", status: "online", lastSeen: minuteAgo(0), about: "Online", form: "desktop" },
  { id: "cloud", name: "Cloud", kind: "cloud", status: "online", lastSeen: minuteAgo(0), about: "Running" },
];
const ALL_DEVICES: Device[] = [...SCRIPTED_DEVICES];

/** Your computers: the scripted world's, or the person's real ones once the phone follows one (`adoptDevices`). */
export const DEVICES: readonly Device[] = ALL_DEVICES;

/**
 * Where a new chat can start on a board that is a computer's own, when that is not every computer: the person's Macs
 * and one Cloud (`CLOUD`), never a list of machines, since which Cloud computer a chat gets is Caveman's choice.
 */
let starts: readonly Device[] | null = null;

/** Cloud as a place to start a chat: Caveman picks the project's Cloud computer, or makes one. */
export const CLOUD: Device = { id: "live:cloud", name: "Cloud", kind: "cloud", status: "online", lastSeen: 0, about: "" };

/**
 * The person's real computers take the scripted ones' place (live/link.ts, from Caveman Cloud's list); null puts the
 * scripted ones back. `startOn`: where a new chat can start, when not on each of them.
 */
export function adoptDevices(real: readonly Device[] | null, startOn: readonly Device[] | null = null) {
  ALL_DEVICES.splice(0, ALL_DEVICES.length, ...(real ?? SCRIPTED_DEVICES));
  starts = real ? startOn : null;
}

/** The computers a new chat can start on. */
export const startDevices = (): readonly Device[] => starts ?? DEVICES;

// With no computer listed (a person's own board before Caveman's list is read, or with none of theirs yet) an id
// stands for Cloud: the one place there always is.
export const deviceById = (id: string): Device => DEVICES.find((d) => d.id === id) ?? starts?.find((d) => d.id === id) ?? DEVICES[0] ?? CLOUD;

/**
 * What a picker calls a device: its name, the paired Mac's too. A phone is not a computer, so nothing on it says
 * "This Mac".
 */
export const deviceLabel = (d: Device) => d.name;

/** The Environment pickers' rows, from DEVICES as they are now. */
export const computerRows = (): readonly { id: string; name: string; about: string; icon: PixelIconName }[] =>
  startDevices().map((d) => ({
    id: d.id,
    name: deviceLabel(d),
    about: d.about,
    icon: d.kind === "cloud" ? "computer-cloud" : "computer-this-mac",
  }));

/** A device by what a picker calls it ("Julius's MacBook Pro", "Studio"), for a pick made by name. */
export const deviceByLabel = (label: string): Device | undefined => startDevices().find((d) => deviceLabel(d) === label) ?? DEVICES.find((d) => deviceLabel(d) === label);

/** A moment in one line: what changed, whether it holds, where it lives. */
export const factsOf = (m: Moment) => `${m.files.length} files · ${m.checks} · ${m.branch}`;

export const totals = (files: readonly FileChange[]) => files.reduce((sum, f) => ({ add: sum.add + f.add, del: sum.del + f.del }), { add: 0, del: 0 });

/** Which tool a live line comes from, so it gets the same mark as the steps it joins. */
export function toolOf(line: string): Tool {
  if (/^(Edit|Writ|Rewrit|Trimm|Darken|Apply|Backfill)/i.test(line)) return "edit";
  if (/^(Read)/i.test(line)) return "read";
  if (/(test|vitest|CI |pnpm|go |Taking screenshots|Checking row)/i.test(line)) return "run";
  return "search";
}

export const DARK_RUNS_MOMENT: Moment = {
  headline: "Dark mode for Runs is ready",
  nudge: "Take a look, play around with it.",
  branch: "dark-runs",
  checks: "8 tests pass",
  files: [
    { path: "src/runs/RunsPage.tsx", add: 24, del: 9 },
    { path: "src/runs/RunRow.tsx", add: 8, del: 2 },
    { path: "src/styles/runs.css", add: 5, del: 1 },
    { path: "src/runs/RunsPage.test.tsx", add: 1, del: 0 },
  ],
  changes: [
    "Runs follows the app's theme, dark by default",
    "Status dots keep their meaning in both themes",
    "Row hover is one step up, not a border",
  ],
  summary:
    "Runs now follows the app's theme and starts dark. A few things to know:\n\n- Status dots keep their meaning in both themes\n- Rows lift one step on hover instead of drawing a border\n- All **8 tests** pass, screenshots included\n\nTake a look and play with it. Tell me to ship it, or what to change.",
  preview: "runs",
};

export const DARKER_MOMENT: Moment = {
  ...DARK_RUNS_MOMENT,
  headline: "Darker Runs is ready",
  files: [
    { path: "src/styles/runs.css", add: 3, del: 3 },
    { path: "src/runs/RunRow.tsx", add: 2, del: 1 },
  ],
  changes: ["The page is one step darker, the shell's own black", "Rows lift on hover instead of tinting", "Nothing else moved"],
  summary: "Done: the page is one step darker now, the shell's own black, and rows lift on hover instead of tinting. Nothing else moved.",
};

// Ids carry when this launch began, so ids made after a relaunch never collide with ones restored from disk.
const launch = Date.now().toString(36);
let seq = 0;
export const itemId = () => `i${launch}-${(++seq).toString(36)}`;
/** A new chat's id: unique even for two chats a Chief starts in the same millisecond. */
export const chatId = (prefix = "ask") => `${prefix}-${launch}-${(++seq).toString(36)}`;

/** What a chat that started on the phone makes, in the prototype: a small change on its own branch. */
export function momentFor(title: string): Moment {
  const branch = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "change";
  return {
    headline: `${title} is ready`,
    nudge: "Take a look.",
    branch,
    checks: "14 tests pass",
    files: [
      { path: `src/${branch}/index.ts`, add: 18, del: 4 },
      { path: `src/${branch}/index.test.ts`, add: 6, del: 2 },
    ],
    changes: ["The change itself, kept small", "A test that would have caught it"],
    summary: `Done. I made the change on \`${branch}\` and kept it small, with a test that would have caught it. All **14 tests** pass.\n\nHave a look, then tell me to ship it or what to change.`,
  };
}

/** What the person meant by a reply to a moment. The real Chief reads the words; the prototype guesses from them. */
export function intentOf(text: string): "ship" | "tweak" | "later" {
  if (/\b(not now|later|wait|hold)\b/i.test(text)) return "later";
  if (/\b(darker|lighter|change|tweak|fix|bigger|smaller|instead|but)\b/i.test(text)) return "tweak";
  return "ship";
}

/** A short chat title from the person's own words: the first few of the first clause, capitalised. */
export function titleFrom(text: string): string {
  const clause = text.split(/[:.!?\n]/)[0] ?? text;
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 5);
  // Never end on a word that leads somewhere ("Add a loading skeleton to").
  while (words.length > 2 && /^(a|an|the|to|for|of|in|on|at|and|or|with|from|into)$/i.test(words.at(-1) ?? "")) words.pop();
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The word a search would start from: the longest one. */
export function keywordOf(text: string): string {
  return text.split(/[^A-Za-z0-9_.-]+/).reduce((best, word) => (word.length > best.length ? word : best), "");
}
