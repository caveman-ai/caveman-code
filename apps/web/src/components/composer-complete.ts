// The composer's autocomplete (README: Composer). "/" at the start of a
// message offers the app's commands (Codex's big ones, run here and never
// sent to an engine), then skills; "/" after a space offers skills only; "@"
// offers files, folders, chats, skills and plugins. One scorer ranks every list, the
// rows picked lately win ties, and the best row's rest shows as ghost text the
// person takes with Tab or →. Everything here is synchronous: the lists are
// in memory, so a keystroke re-ranks within the frame.

import type { EngineCommand, Result } from "@caveman-app/session-protocol";
import { type IconSvgElement, Analytics01Icon, Archive02Icon, AtIcon, Attachment01Icon, Bookmark01Icon, BrowserIcon, BubbleChatAddIcon, CleanIcon, Copy01Icon, DashboardSquare01Icon, Download04Icon, FileAddIcon, FileTextIcon, FireIcon, FlashIcon, FoldVerticalIcon, GitCompareIcon, GitForkIcon, GitPullRequestIcon, Image01Icon, Key01Icon, KeyboardIcon, Logout01Icon, McpServerIcon, PaintBoardIcon, PencilEdit02Icon, PuzzleIcon, NoteAddIcon, Route01Icon, Search01Icon, Settings01Icon, ShieldKeyIcon, SquareTerminalIcon, Target02Icon, Undo02Icon, UserGroupIcon } from "@caveman-app/ui/icons/huge";
import type { ThreadRef } from "./thread-refs.ts";
import { tildify } from "../lib/paths.ts";

type SkillInfo = Result<"skill.list">["skills"][number];

export type CommandId =
  | "model"
  | "permissions"
  | "review"
  | "new"
  | "clear"
  | "compact"
  | "init"
  | "diff"
  | "status"
  | "goal"
  | "grill"
  | "fork"
  | "undo"
  | "rename"
  | "resume"
  | "mention"
  | "attach"
  | "image"
  | "copy"
  | "export"
  | "agents"
  | "terminal"
  | "browser"
  | "skills"
  | "record-skill"
  | "plugins"
  | "mcp"
  | "memory"
  | "automations"
  | "archive"
  | "models"
  | "usage"
  | "logout"
  | "theme"
  | "keymap"
  | "settings";

export interface SlashCommand {
  readonly id: CommandId;
  /** What follows "/": the first is its name, the rest aliases (Codex's and Claude Code's words for it). */
  readonly names: readonly [string, ...string[]];
  readonly icon: IconSvgElement;
  readonly description: string;
  /** What it takes after its name: the ghost hint in the box. `required`: picking it waits for them. */
  readonly args?: { readonly hint: string; readonly required?: boolean };
}

/** In the order a bare "/" lists them: the ones used most first (Codex's rule). */
export const COMMANDS: readonly SlashCommand[] = [
  { id: "model", names: ["model"], icon: Route01Icon, description: "Choose the model and effort", args: { hint: "model" } },
  { id: "permissions", names: ["permissions", "approvals"], icon: ShieldKeyIcon, description: "Choose what it may do without asking", args: { hint: "mode" } },
  { id: "review", names: ["review"], icon: GitPullRequestIcon, description: "Review your changes and find issues", args: { hint: "what to focus on" } },
  { id: "new", names: ["new", "clear"], icon: BubbleChatAddIcon, description: "Start fresh in a new chat; this one stays in the sidebar" },
  { id: "compact", names: ["compact"], icon: FoldVerticalIcon, description: "Summarize the conversation to free up context" },
  { id: "init", names: ["init"], icon: FileAddIcon, description: "Write an AGENTS.md with instructions for this repo" },
  { id: "diff", names: ["diff", "changes"], icon: GitCompareIcon, description: "What changed, untracked files too" },
  { id: "status", names: ["status", "context"], icon: DashboardSquare01Icon, description: "Context used, environment and outputs" },
  { id: "goal", names: ["goal"], icon: Target02Icon, description: "Set a goal to keep pursuing", args: { hint: "objective" } },
  { id: "grill", names: ["grill"], icon: FireIcon, description: "Answer its questions first, then build" },
  { id: "fork", names: ["fork", "branch"], icon: GitForkIcon, description: "Carry on in a copy of this chat" },
  { id: "undo", names: ["undo", "rewind"], icon: Undo02Icon, description: "Take back the last turn: its files and its messages" },
  { id: "rename", names: ["rename", "title"], icon: PencilEdit02Icon, description: "Rename this chat", args: { hint: "new title", required: true } },
  { id: "resume", names: ["resume", "chats"], icon: Search01Icon, description: "Go to another chat" },
  { id: "mention", names: ["mention"], icon: AtIcon, description: "Add a file, folder, chat, skill or plugin" },
  { id: "attach", names: ["attach", "files"], icon: Attachment01Icon, description: "Attach files from your computer" },
  { id: "image", names: ["image", "screenshot"], icon: Image01Icon, description: "Attach screenshots and pictures" },
  { id: "copy", names: ["copy"], icon: Copy01Icon, description: "Copy the last answer" },
  { id: "export", names: ["export"], icon: Download04Icon, description: "Save this chat as a Markdown file" },
  { id: "agents", names: ["agents", "subagents"], icon: UserGroupIcon, description: "The agents this chat started" },
  { id: "terminal", names: ["terminal", "shell"], icon: SquareTerminalIcon, description: "Open a terminal in this workspace" },
  { id: "browser", names: ["browser"], icon: BrowserIcon, description: "Open the browser beside the chat" },
  { id: "skills", names: ["skills"], icon: FileTextIcon, description: "Browse and edit skills" },
  { id: "record-skill", names: ["record-skill"], icon: NoteAddIcon, description: "Save this session as a skill" },
  { id: "plugins", names: ["plugins", "marketplace"], icon: PuzzleIcon, description: "Browse and manage plugins" },
  { id: "mcp", names: ["mcp"], icon: McpServerIcon, description: "MCP servers and their tools" },
  { id: "memory", names: ["memory", "memories"], icon: Bookmark01Icon, description: "What engines remember between chats" },
  { id: "automations", names: ["automations"], icon: FlashIcon, description: "Work Caveman runs on a schedule or a GitHub event" },
  { id: "archive", names: ["archive"], icon: Archive02Icon, description: "Archive this chat" },
  { id: "models", names: ["keys", "login", "accounts"], icon: Key01Icon, description: "Engines, accounts and provider keys" },
  { id: "usage", names: ["usage"], icon: Analytics01Icon, description: "What the engines reported using" },
  { id: "logout", names: ["logout", "signout"], icon: Logout01Icon, description: "Sign this computer out of Caveman" },
  { id: "theme", names: ["theme", "appearance"], icon: PaintBoardIcon, description: "Theme, text and your companion" },
  { id: "keymap", names: ["keymap", "shortcuts"], icon: KeyboardIcon, description: "The send key and every shortcut" },
  { id: "settings", names: ["settings", "config"], icon: Settings01Icon, description: "Every setting" },
];

/** The Chief's box runs only these: what is typed there is a note for the Chief, and a chat's commands are a chat's. */
export const CHIEF_COMMANDS: readonly SlashCommand[] = [
  { id: "clear", names: ["clear"], icon: CleanIcon, description: "Clear the view and start a fresh section; the earlier conversation is kept" },
];

export const commandById = (id: CommandId): SlashCommand => [...COMMANDS, ...CHIEF_COMMANDS].find((c) => c.id === id)!;

// ---------------------------------------------------------------------------
// Scoring

export interface Match {
  readonly score: number;
  /** Indexes of the target's characters the query matched, for the highlight. */
  readonly hits: readonly number[];
}

const BOUNDARY = /[\s\-_:/.]/;
const span = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/**
 * How well `query` names `target`, or null. Best first: the whole name, its
 * start, the start of a word in it ("comm" in caveman-commit), anywhere in
 * it, then its letters in order, word starts first ("cc" in caveman-commit).
 * Matches of one kind tie, so the order a list is given in (commands by use)
 * and what was picked lately decide among them.
 */
export function score(query: string, target: string): Match | null {
  if (query === "") return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return { score: 1000, hits: span(0, q.length) };
  if (t.startsWith(q)) return { score: 900, hits: span(0, q.length) };
  for (let i = 1; i < t.length; i++) {
    if (BOUNDARY.test(t[i - 1]!) && t.startsWith(q, i)) return { score: 700 - i, hits: span(i, q.length) };
  }
  const at = t.indexOf(q);
  if (at > 0) return { score: 500 - at, hits: span(at, q.length) };
  // In order: each letter at the next word start if one is coming, else the next place it appears.
  const hits: number[] = [];
  let from = 0;
  for (const ch of q) {
    let i = -1;
    for (let k = from; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if (k === 0 || BOUNDARY.test(t[k - 1]!)) {
        i = k;
        break;
      }
      if (i === -1) i = k;
    }
    if (i === -1) return null;
    hits.push(i);
    from = i + 1;
  }
  // Under three letters, scattered letters are noise ("re" in frontend) unless they start at a word.
  if (q.length < 3 && hits[0] !== 0 && !BOUNDARY.test(t[hits[0]! - 1]!)) return null;
  const starts = hits.filter((i) => i === 0 || BOUNDARY.test(t[i - 1]!)).length;
  return { score: 300 + starts * 20 - (hits.at(-1)! - hits[0]!) - hits[0]!, hits };
}

/** A description answers too, at the bottom: a word in it starting with the query (two letters or more). */
const describes = (query: string, description: string | undefined) =>
  query.length >= 2 && (description ?? "").toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(query.toLowerCase()));

export interface Ranked<T> {
  readonly item: T;
  /** The name that matched best (a command's alias when you typed it). */
  readonly name: string;
  readonly score: number;
  readonly hits: readonly number[];
}

/**
 * Items whose names (or description) match `query`, best first; the ones
 * picked lately win ties, then the given order. An empty query keeps every
 * item, recent first.
 */
export function rank<T>(items: readonly T[], query: string, names: (t: T) => readonly string[], key: (t: T) => string, description?: (t: T) => string | undefined): Ranked<T>[] {
  const used = recentOrder();
  const out: Array<Ranked<T> & { at: number; recent: number }> = [];
  items.forEach((item, at) => {
    let best: (Match & { name: string }) | null = null;
    for (const name of names(item)) {
      const m = score(query, name);
      if (m && (!best || m.score > best.score)) best = { ...m, name };
    }
    if (!best && describes(query, description?.(item))) best = { score: 100, hits: [], name: names(item)[0]! };
    if (!best) return;
    const r = used.indexOf(key(item));
    out.push({ item, name: best.name, score: best.score, hits: best.hits, at, recent: r === -1 ? Infinity : r });
  });
  out.sort((a, b) => b.score - a.score || a.recent - b.recent || a.at - b.at);
  return out.map(({ at: _at, recent: _recent, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Recency: what was picked lately, newest first, on this computer.

const RECENT_KEY = "caveman.composer.recent";
const RECENT_MAX = 24;
let recentCache: string[] | null = null;

export function recentOrder(): readonly string[] {
  if (recentCache) return recentCache;
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? "[]");
    recentCache = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    recentCache = [];
  }
  return recentCache;
}

/** Remember a pick ("cmd:model", "skill:caveman-commit") so it ranks first next time. */
export function noteUse(key: string): void {
  recentCache = [key, ...recentOrder().filter((k) => k !== key)].slice(0, RECENT_MAX);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(recentCache));
  } catch {
    // Storage full or off: recency lasts this session only.
  }
}

// ---------------------------------------------------------------------------
// Triggers

/**
 * The "/" being typed at the caret (at the start or after whitespace), or
 * null. `commands`: it opens the message, so commands are offered; later in
 * the text only skills are. A "/" inside a pill opens nothing.
 */
export function slashTrigger(text: string, caret: number, refs: ReadonlyArray<ThreadRef> = []): { start: number; query: string; commands: boolean } | null {
  const m = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
 // A word with a second slash is a path (/tmp/build.sh), not a command, wherever the caret sits in it (upstream #19671).
  if (/^[^\s]*\//.test(text.slice(caret))) return null;
  const start = caret - m[1]!.length - 1;
  if (refs.some((r) => start >= r.start && start < r.end)) return null;
  return { start, query: m[1]!, commands: text.slice(0, start).trim() === "" && !refs.some((r) => r.end <= start) };
}

/**
 * The command a message opens with ("/rename Auth fix"): the command, where
 * its name ends and what follows it. Null when the first word is no command
 * of ours (a skill pill, or an engine's own command such as Claude's
 * /security-review, which is sent as typed).
 */
export function leadingCommand(
  text: string,
  refs: ReadonlyArray<ThreadRef> = [],
  commands: readonly SlashCommand[] = COMMANDS,
): { command: SlashCommand; start: number; end: number; args: string } | null {
  const word = leadingSlash(text, refs);
  const command = word && commands.find((c) => c.names.includes(word.name.toLowerCase()));
  return word && command ? { command, start: word.start, end: word.end, args: word.args } : null;
}

/** The "/word" a message opens with (ours or an engine's, "/plugin:command" too), or null; a pill there is not one. */
export function leadingSlash(text: string, refs: ReadonlyArray<ThreadRef> = []): { name: string; start: number; end: number; args: string } | null {
  const m = /^(\s*)\/([a-z0-9][a-z0-9:_-]*)(?=\s|$)/i.exec(text);
  if (!m) return null;
  const start = m[1]!.length;
  if (refs.some((r) => r.start === start)) return null;
  return { name: m[2]!, start, end: m[0].length, args: text.slice(m[0].length).trim() };
}

/**
 * The engine's own commands the "/" menu lists under it: not ones ours
 * answer to (our /compact, /review and /init run here) and not its skills,
 * which Claude Agent reports as commands too and Skills already lists.
 */
export function engineCommandsFor(commands: ReadonlyArray<EngineCommand>, skillTokens: ReadonlySet<string>): EngineCommand[] {
  const ours = new Set(COMMANDS.flatMap((c) => c.names));
  const seen = new Set<string>();
  return commands.flatMap((c) => {
    const name = c.name.replace(/^\//, "");
    if (!name || ours.has(name.toLowerCase()) || skillTokens.has(name) || seen.has(name)) return [];
    seen.add(name);
    return [{ ...c, name }];
  });
}

// ---------------------------------------------------------------------------
// Skills

/**
 * What a skill is called in a message for `engine`, sent as `$token`: Claude
 * Agent runs a home or repository skill by its folder's name (ClaudeSkillDispatch
 * turns `$name` into `/name`), Codex by its declared name. Only the
 * characters a mention can hold.
 */
export function skillToken(skill: Pick<SkillInfo, "name" | "path" | "scope">, engine: string | undefined): string {
  const folder = skill.path.split(/[\\/]/).at(-2) ?? skill.name;
  const name = engine === "claude-agent" && (skill.scope === "me" || skill.scope === "project") ? folder : skill.name;
  return name.replace(/[^a-zA-Z0-9:_-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "") || "skill";
}

/** The skills a chat on `engine` in `projectId` can run: on, loaded by that engine, and a repository's only in its own project. One per token. */
export function skillsFor(skills: ReadonlyArray<SkillInfo>, engine: string | undefined, projectId: string | null): Array<SkillInfo & { readonly token: string }> {
  const seen = new Set<string>();
  const out: Array<SkillInfo & { readonly token: string }> = [];
  for (const s of skills) {
    if (!s.enabled || !engine || !s.engines.some((e) => e === engine)) continue;
    if (s.scope === "project" && s.project_id !== projectId) continue;
    const token = skillToken(s, engine);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ ...s, token });
  }
  return out;
}

/** Where a skill comes from, as its row's grey tag. */
export function skillSource(s: Pick<SkillInfo, "scope" | "plugin_id" | "marketplace">): string {
  if (s.scope === "me") return "Yours";
  if (s.scope === "project") return "This repo";
  return s.plugin_id ? s.plugin_id.split("@")[0]! : "Plugin";
}

/** A path with its home folder as "~" (macOS, Linux and Windows homes). */
export const tildePath = (p: string) => tildify(p, false);

/** `$token` mentions of the given skills in sent text: where each is, for the transcript's pills. */
export function skillMentions(text: string, tokens: ReadonlySet<string>): Array<{ start: number; end: number; token: string }> {
  if (tokens.size === 0 || !text.includes("$")) return [];
  const out: Array<{ start: number; end: number; token: string }> = [];
  for (const m of text.matchAll(/(^|\s)\$(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g)) {
    if (!tokens.has(m[2]!)) continue;
    const start = m.index + m[1]!.length;
    out.push({ start, end: start + m[2]!.length + 1, token: m[2]! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the prompt commands send

/** /review: the engine reviews what changed and edits nothing. */
export const reviewPrompt = (focus: string) =>
  [
    "Review the changes in this workspace: uncommitted edits and the commits on this branch.",
    "Report concrete problems, most severe first: bugs, regressions, security issues, missing tests. Give each a file:line and a fix.",
    "Change no files.",
    focus ? `Focus on: ${focus}` : "",
  ]
    .filter(Boolean)
    .join(" ");

/** /init: an AGENTS.md every engine can read. */
export const INIT_PROMPT =
  "Write an AGENTS.md at the repository root for agents working here. Read the code first. Cover: what the project is, how it is laid out, the commands to build, test and lint it, the conventions the code follows, and anything that is easy to get wrong. Keep it short and specific to this repository; no generic advice. If an AGENTS.md exists, improve it instead.";
