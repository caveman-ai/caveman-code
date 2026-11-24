// The Chief's board as the page reads it: the Queue's order, the line that
// says what changed while you were away, and the cards its tool calls become
// in its transcript. Pure, so chief-model.test.ts pins it.

import type { ChiefItem, ChiefItemState, Params, Result } from "@caveman-app/session-protocol";
import type { ChatStatus, SidebarRow, WorkspaceState, WorkspaceView } from "./model.ts";
import type { ToolItem } from "./transcript-model.ts";
import { IS_MAC } from "../lib/platform.ts";

export type { ChiefItem };
export type ChiefPickerOption = NonNullable<Result<"chief.get">["picker"]>[number];
export type ChiefModel = NonNullable<Result<"chief.get">["model"]>;

type PickerModel = { readonly id: string; readonly label: string; readonly efforts: readonly string[]; readonly default_effort?: string; readonly legacy?: boolean; readonly description?: string };
type PickerEngine = { readonly id: string; readonly label: string; readonly models: readonly PickerModel[]; readonly hint?: string; readonly harness?: string; readonly account?: string };
type KnownEngine = PickerEngine & { readonly auth?: { readonly accounts: ReadonlyArray<{ readonly id: string; readonly label: string }> } };

/**
 * The Chief's picker: the composer's, over what the runtime says is connected (chief.get's `picker`): the Caveman
 * engine's models, then each Claude Agent and Codex login's. Each engine's own descriptor names and orders its models;
 * a connected model it does not list still shows. An option on a login is a section of its own, `engine#account`,
 * headed by the login's name where its engine has several (two Claude plans, a plan and a key).
 */
export function chiefPickerEngines(options: ReadonlyArray<ChiefPickerOption>, engines: ReadonlyArray<KnownEngine>): PickerEngine[] {
  return options.flatMap((option) => {
    const known = engines.find((e) => e.id === option.engine);
    const models = option.models.map((id): PickerModel => known?.models.find((m) => m.id === id) ?? { id, label: id.slice(id.lastIndexOf("/") + 1), efforts: [] });
    if (models.length === 0) return [];
    const several = options.filter((o) => o.engine === option.engine && o.models.length > 0).length > 1;
    const account = several ? known?.auth?.accounts.find((a) => a.id === option.account_id)?.label : undefined;
    const login = option.account_id ? { id: `${option.engine}#${option.account_id}`, harness: option.engine, ...(account ? { account } : {}) } : { id: option.engine };
    return [{ ...login, label: option.label ?? known?.label ?? option.engine, models, ...(option.hint ? { hint: option.hint } : {}) }];
  });
}

/** The picker section a Chief pick sits in: its login's where it names one. */
const sectionOfPick = (model: ChiefModel) => (model.account_id ? `${model.engine}#${model.account_id}` : model.engine);

/** What the picker shows as chosen: the pick, else Auto (the first engine's first model, which the runtime lists first). */
export function chiefPickerValue(model: ChiefModel | null, engines: ReadonlyArray<PickerEngine>): { engine: string; model: string } | null {
  if (model) {
    // A pick from before logins were named sits in its engine's first section.
    const section = engines.find((e) => e.id === sectionOfPick(model)) ?? (model.account_id ? undefined : engines.find((e) => (e.harness ?? e.id) === model.engine));
    if (section?.models.some((m) => m.id === model.model)) return { engine: section.id, model: model.model };
  }
  const first = engines[0];
  return first && first.models[0] ? { engine: first.id, model: first.models[0].id } : null;
}

/** settings.set's chief_model for a pick (a section id, `engine#account` for a login's): null for the Caveman engine's Auto, the default. */
export const chiefModelSetting = (section: string, model: string, effort?: string): ChiefModel | null => {
  const [engine, account] = section.split("#") as [string, string | undefined];
  return engine === "caveman" && model === "auto" ? null : { engine, model, ...(effort ? { effort } : {}), ...(account ? { account_id: account } : {}) };
};
export type ChiefAvailability = Result<"chief.get">["availability"];
/** Enter: the Chief decides. ⌥Enter: queue only, no model call. ⌘Enter: start now. */
export type CaptureMode = Params<"chief.capture">["mode"];

/** The Chief's thread never shows as a chat: workspace.list leaves it out, and so does every list here. */
export function withoutChief<T extends { readonly kind?: string }>(workspaces: ReadonlyArray<T>): T[] {
  return workspaces.filter((w) => w.kind !== "chief");
}

const IN_QUEUE: ReadonlySet<ChiefItemState> = new Set(["unsorted", "queued", "proposed", "blocked", "scheduled"]);

const byRank = (a: ChiefItem, b: ChiefItem) => a.rank - b.rank || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/** The Queue: everything captured but not started, in rank order. Started work moves up into Running. */
export function queueItems(items: ReadonlyArray<ChiefItem>): ChiefItem[] {
  return items.filter((i) => IN_QUEUE.has(i.state)).sort(byRank);
}

const IN_TRAY: ReadonlySet<ChiefItemState> = new Set(["queued", "blocked", "scheduled"]);

/**
 * The tray on the Chief's box: notes waiting to go, in Queue order, whatever is running. Queued (⌥Enter, or put back),
 * and those held back (a limit, a time: itemNote says which), so a held note never looks lost. A note the Chief asked
 * you about waits on you: it is on the strip under the tray (chiefAtWork), not in it too. Unsorted notes are in the
 * conversation already; Suggested ones are cards there.
 */
export function queuedNotes(items: ReadonlyArray<ChiefItem>): ChiefItem[] {
  return queueItems(items).filter((i) => IN_TRAY.has(i.state) && !i.asked);
}

/**
 * A move in the tray (`id` before `before`, null: to its end) as a move on the whole Queue, which also holds notes the
 * tray hides (unsorted, Suggested). The note lands right after the tray row it now follows (before the first row when
 * it leads), so a hidden note never slides between two of yours, and nothing hidden moves.
 */
export function trayMove(items: ReadonlyArray<ChiefItem>, id: string, before: string | null): string | null {
  const tray = queuedNotes(items).filter((i) => i.id !== id);
  const at = before === null ? tray.length : tray.findIndex((i) => i.id === before);
  if (at <= 0) return tray[0]?.id ?? null;
  const all = queueItems(items).filter((i) => i.id !== id);
  const after = all.findIndex((i) => i.id === tray[at - 1]!.id);
  return all[after + 1]?.id ?? null;
}

const imagesLabel = (n: number) => (n === 1 ? "1 image" : `${n} images`);

/**
 * A note as its tray row shows it: its words (an image-only note, its images: "1 image"), and after them why it waits
 * and the images it carries. `edited`: the words to save from an edit of that row, or null when nothing changed (an
 * image-only note's label saved as it was is not its words).
 */
export function trayEntry(item: ChiefItem, items: ReadonlyArray<ChiefItem>, now = new Date()): { id: string; text: string; status?: string } {
  const images = item.attachments?.length ?? 0;
  const text = item.text.trim() === "" && images > 0 ? imagesLabel(images) : item.text;
  const status = [itemNote(item, items, now), item.text.trim() !== "" && images > 0 ? imagesLabel(images) : null].filter(Boolean).join(" · ");
  return { id: item.id, text, ...(status ? { status } : {}) };
}
export function trayEdit(item: ChiefItem, text: string): string | null {
  const shown = trayEntry(item, []).text;
  return text === shown || text === item.text ? null : text;
}

/** Items not done or dropped: waiting or with chats running. Removing their Chief hands them to the home Chief. */
export const openItemCount = (items: ReadonlyArray<ChiefItem>) => items.filter((i) => i.state !== "done" && i.state !== "dropped").length;

/**
 * You moved `id` before `beforeId` (null: to the end), shown at once while
 * chief.items.reorder goes out. The moved item takes a rank between its new
 * neighbours and is pinned, so the Chief leaves it there; no other item moves.
 */
export function moveItem(items: ReadonlyArray<ChiefItem>, id: string, beforeId: string | null): ChiefItem[] {
  const queue = queueItems(items).filter((i) => i.id !== id);
  const at = beforeId === null ? queue.length : queue.findIndex((i) => i.id === beforeId);
  if (at < 0) return [...items];
  const prev = queue[at - 1]?.rank;
  const next = queue[at]?.rank;
  const rank = prev === undefined ? (next ?? 0) - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
  return items.map((i) => (i.id === id ? { ...i, rank, pinned: true } : i));
}

/** How many items wait unsorted: with Running's Needs you, the sidebar's count. */
export const unsortedCount = (items: ReadonlyArray<ChiefItem>) => items.filter((i) => i.state === "unsorted").length;

/**
 * A project waits on you (its folded sidebar row wears the amber dot): a chat of it, or a builder under one, asks
 * something (model.ts chatStatus `action`). What a Chief needs shows on the Chief's own row. `rows`: every chat of the
 * project, its pinned ones too.
 */
export function projectWaitsOnYou(rows: ReadonlyArray<SidebarRow>, statusOf: (w: WorkspaceView) => ChatStatus | null): boolean {
  return rows.some((r) => [r.workspace, ...r.children].some((w) => statusOf(w)?.action === true));
}

/** An item's grey second line in the Queue: what it waits on, when it starts, or that it is not sorted yet. */
export function itemNote(item: ChiefItem, items: ReadonlyArray<ChiefItem>, now = new Date()): string | null {
  if (item.state === "unsorted") return "Not sorted yet";
  if (item.state === "proposed") return "Suggested: start it when you are ready";
  if (item.state === "scheduled" && item.not_before) return `Starts ${when(item.not_before, now)}`;
  if (item.state !== "blocked" || !item.blocked_on) return null;
  const on = item.blocked_on;
  switch (on.kind) {
    case "capacity":
      return "Waits for a free chat";
    case "cap":
      return "Waits: today's cap is reached";
    case "you": {
      const asked = on.reason ? `Waits on you: ${on.reason}` : "Waits on you";
      return item.asked?.go_ahead_at ? `${asked} · goes ahead ${when(item.asked.go_ahead_at, now)}` : asked;
    }
    case "item": {
      const other = items.find((i) => i.id === on.item_id);
      return other ? `After ${other.title ?? other.text}` : "After another item";
    }
  }
}

function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `at ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

// ------------------------------------------------------------ while you were away

/** What the board looked like when you last left the Chief page. */
export interface BoardSnapshot {
  readonly at: string;
  readonly states: Readonly<Record<string, WorkspaceState>>;
}

export const snapshotOf = (workspaces: ReadonlyArray<WorkspaceView>, now = new Date()): BoardSnapshot => ({
  at: now.toISOString(),
  states: Object.fromEntries(workspaces.filter((w) => w.state !== "archived").map((w) => [w.id, w.state])),
});

/**
 * "While you were away: 4 done, 2 need you, 1 failed", from the board's
 * change since your last visit and no model call. Null when nothing moved.
 */
export function awayLine(before: BoardSnapshot | null, workspaces: ReadonlyArray<WorkspaceView>): string | null {
  if (!before) return null;
  const became = (state: WorkspaceState) => workspaces.filter((w) => w.state === state && before.states[w.id] !== state).length;
  const started = workspaces.filter((w) => w.state !== "archived" && !(w.id in before.states) && w.createdAt > before.at).length;
  const parts = [
    [became("completed"), "done"],
    [became("needs_input"), "need you"],
    [became("failed"), "failed"],
    [started, "started"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${n === 1 && label === "need you" ? "needs you" : label}`);
  return said.length > 0 ? `While you were away: ${said.join(", ")}` : null;
}

// ------------------------------------------------------------------- tool cards

/** The Chief's tools reach the transcript as tool items; the name may carry a server prefix (mcp__chief__chat_start). */
export const chiefTool = (name: string) => name.split(/__|\.|:/).pop() ?? name;

/** Every tool a Chief has (packages/runtime/src/chief/tools.ts): a run of only these draws as the Chief's cards. */
export const CHIEF_TOOLS: ReadonlySet<string> = new Set(["chat_start", "chat_send", "chat_digest", "chat_stop", "chat_answer", "remember", "ask", "memory_sql", "schedule", "queue_add", "queue_update", "queue_drop", "queue_order", "view_open", "view_close", "view_list", "chat_search", "playbook", "react"]);

export interface StartedChat {
  readonly workspaceId: string;
  readonly title: string;
}
export interface SuggestedChat {
  readonly itemId: string | null;
  readonly title: string;
  readonly projects: ReadonlyArray<string>;
  /** The first line of the brief the chat would get. */
  readonly brief: string | null;
  /** The Chief was not sure which project this is for (chat_start's guess). */
  readonly guess: boolean;
  /** Why the runtime proposed instead of starting, in its words. */
  readonly reason: string | null;
}

/** A proposed chat as the board has it now: still waiting on you, started, dismissed, or gone from the board. */
export type SuggestedStatus = "waiting" | "started" | "dismissed" | "gone";

const STARTED: ReadonlySet<ChiefItemState> = new Set(["started", "review", "needs_you", "done"]);

/**
 * Both the inline card and the Queue read one item: starting or dismissing
 * from either place moves the same state (chief.items), never a copy.
 */
export function suggestedStatus(chat: SuggestedChat, items: ReadonlyArray<ChiefItem>): SuggestedStatus {
  const item = chat.itemId ? items.find((i) => i.id === chat.itemId) : undefined;
  if (!item) return "gone";
  if (item.state === "proposed") return "waiting";
  if (item.state === "dropped") return "dismissed";
  if (STARTED.has(item.state)) return "started";
  // queued (you took it back), blocked, scheduled: the Queue holds it; the card has nothing left to do.
  return "gone";
}

/**
 * A Suggested card has nothing left to do: none of its chats still waits on you (each started, dismissed or taken
 * back into the Queue). Such a card leaves the page (chief-cards.tsx Suggested); the Queue and the Work tab hold the work.
 */
export const suggestedSettled = (chats: ReadonlyArray<SuggestedChat>, items: ReadonlyArray<ChiefItem>): boolean => chats.every((chat) => suggestedStatus(chat, items) !== "waiting");

/** The brief's first sentence or line (headings skipped), short enough for one row of a card. */
export function briefLine(brief: string | null, max = 140): string | null {
  const first = (brief ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))
    .map((l) => l.replace(/^[\s*-]+/, "").trim())
    .find(Boolean);
  if (!first) return null;
  const sentence = first.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? first;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** FRESH_MS after it lands, a Suggested card (and its Queue row) is new enough to draw the eye; the page's own history is not. */
export const FRESH_MS = 30_000;
export const arrivedJustNow = (at: string | null, now = Date.now()) => at !== null && now - Date.parse(at) >= 0 && now - Date.parse(at) < FRESH_MS;

export type ChiefCard =
  /** chat_start that started chats (the DelegatedAgent look), or is still starting. */
  | { readonly kind: "started"; readonly id: string; readonly running: boolean; readonly title: string; readonly projects: ReadonlyArray<string>; readonly chats: ReadonlyArray<StartedChat> }
  /** chat_start calls the Chief only proposed, folded into one list with Start all. `at`: when the last one landed. */
  | { readonly kind: "suggested"; readonly id: string; readonly at: string; readonly chats: ReadonlyArray<SuggestedChat> }
  /** remember: the note, and what Undo needs. */
  | { readonly kind: "remembered"; readonly id: string; readonly text: string; readonly noteId: string | null; readonly vid: string | null; readonly failed: boolean; readonly reason: string | null }
  /** ask: `itemId`, the board item it holds up, whose `asked` says when the Chief goes ahead without you. */
  | { readonly kind: "ask"; readonly id: string; readonly question: string; readonly recommended: string | null; readonly itemId: string | null }
  /** Everything else: one quiet line. `workspaceId` names the chat it touched. */
  | { readonly kind: "line"; readonly id: string; readonly tool: string; readonly text: string; readonly workspaceId: string | null; readonly failed: boolean };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Text blocks: MCP's (`text`) and Codex's dynamic tool content items (`inputText`). */
const TEXT_BLOCKS: ReadonlySet<unknown> = new Set(["text", "inputText"]);

/**
 * The text of content blocks (`[{type: "text", text}]`, alone or as a CallToolResult's `content`; Codex's
 * `[{type: "inputText", text}]`); undefined for anything else.
 */
function blocksText(value: unknown): string | undefined {
  const blocks = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content) ? (value as { content: unknown[] }).content : undefined;
  if (blocks === undefined || blocks.length === 0) return undefined;
  const texts = blocks.map((b) => (b && typeof b === "object" && TEXT_BLOCKS.has((b as { type?: unknown }).type) && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : undefined));
  return texts.every((x) => x !== undefined) ? texts.join("\n") : undefined;
}

/**
 * A Chief tool's answer. The Caveman engine hands the runtime's answer back as text (JSON for
 * objects, plain words for a few tools and every refusal); on Claude Agent it comes back as the
 * MCP content blocks Claude Code returns, on Codex as its dynamic tool's content items, whose text
 * is that same answer.
 */
function answerOf(t: ToolItem): { readonly fields: Record<string, unknown>; readonly words: string } {
  const text = typeof t.result === "string" ? t.result : blocksText(t.result);
  if (text === undefined) return { fields: obj(t.result), words: t.output.trim() };
  try {
    return { fields: obj(JSON.parse(text)), words: "" };
  } catch {
    return { fields: {}, words: text.trim() || t.output.trim() };
  }
}

/** A chat_start's outcome: started (with its chats), proposed (an item to start), or still running. */
function startOutcome(t: ToolItem): { status: "running" | "started" | "proposed" | "blocked" | "failed"; chats: StartedChat[]; itemId: string | null } {
  if (t.status === "running") return { status: "running", chats: [], itemId: null };
  if (t.status !== "done") return { status: "failed", chats: [], itemId: null };
  // The runtime answers {state, item_id, reason?, chats?: [{workspace_id, title, project_id}]} (runtime chief/Chief.ts admit).
  const r = answerOf(t).fields;
  const title = str(obj(t.input).title) ?? "Chat";
  const chats = (Array.isArray(r.chats) ? r.chats : []).map(obj).flatMap((w) => (str(w.workspace_id) ? [{ workspaceId: str(w.workspace_id)!, title: str(w.title) ?? title }] : []));
  const itemId = str(r.item_id);
  if (r.state === "proposed" || r.state === "blocked") return { status: r.state, chats: [], itemId };
  return { status: chats.length > 0 ? "started" : "failed", chats, itemId };
}

const quoted = (s: string | null) => (s ? `“${s}”` : "");

/** What a view_open shows, when it names no title: #12, a chat, a picture, a clip, or the page's host. */
function viewSubject(input: Record<string, unknown>): string {
  switch (input.kind) {
    case "pr":
      return typeof input.number === "number" ? `#${input.number}` : "a pull request";
    case "chat":
      return "";
    case "image":
      return "a picture";
    case "video":
      return "a clip";
    default: {
      const url = str(input.url);
      try {
        return url ? new URL(url).host : "a page";
      } catch {
        return "a page";
      }
    }
  }
}

/** One tool run of the Chief's, as the cards its transcript shows. Consecutive proposals fold into one Suggested card. */
export function chiefCards(tools: ReadonlyArray<ToolItem>): ChiefCard[] {
  const out: ChiefCard[] = [];
  for (const t of tools) {
    const name = chiefTool(t.name);
    const input = obj(t.input);
    const { fields: result, words } = answerOf(t);
    const failed = t.status === "failed" || t.status === "denied";
    const subject = str(input.title) ?? str(input.text) ?? null;
    const line = (text: string, workspaceId: string | null = null) => out.push({ kind: "line", id: t.id, tool: name, text, workspaceId, failed });
    // What it did, or, when the call failed, what it could not do: a failed update never reads "Updated".
    const did = (done: string, attempt: string, workspaceId: string | null = null) => line(failed ? `Could not ${attempt}` : done, workspaceId);
    switch (name) {
      case "chat_start": {
        const o = startOutcome(t);
        const title = str(input.title) ?? "Chat";
        const projects = strs(input.project_ids);
        if (o.status === "proposed") {
          const chats = [{ itemId: o.itemId, title, projects, brief: briefLine(str(input.brief)), guess: input.guess === true, reason: str(result.reason) }];
          const last = out[out.length - 1];
          const at = t.finishedAt ?? t.startedAt;
          if (last?.kind === "suggested") out[out.length - 1] = { ...last, at, chats: [...last.chats, ...chats] };
          else out.push({ kind: "suggested", id: t.id, at, chats });
        } else if (o.status === "blocked") line(`Queued ${quoted(title)}: no free chat yet`);
        else if (o.status === "failed") line(`Could not start ${quoted(title)}${words ? `: ${words.split("\n")[0]}` : ""}`);
        else out.push({ kind: "started", id: t.id, running: o.status === "running", title, projects, chats: o.chats });
        break;
      }
      case "remember":
        out.push({ kind: "remembered", id: t.id, text: str(input.text) ?? "", noteId: str(result.id), vid: str(result.vid), failed: failed || (t.status === "done" && !str(result.id)), reason: words || null });
        break;
      case "ask":
        out.push({ kind: "ask", id: t.id, question: str(input.question) ?? t.subject, recommended: str(input.recommended), itemId: str(input.item_id) });
        break;
      case "queue_add":
        did(`Queued ${quoted(subject)}`, `queue ${quoted(subject) || "it"}`);
        break;
      case "queue_update":
        did(`Updated ${quoted(subject) || "an item"}`, `update ${quoted(subject) || "an item"}`);
        break;
      case "queue_drop":
        did(`Dropped ${quoted(subject) || "an item"}`, `drop ${quoted(subject) || "an item"}`);
        break;
      case "queue_order":
        did("Reordered the Queue", "reorder the Queue");
        break;
      case "schedule":
        did(str(input.at) ? `Scheduled for ${new Date(str(input.at)!).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Scheduled", "schedule it");
        break;
      case "chat_send":
        did(input.mode === "queue" ? "Queued a note for" : "Steered", input.mode === "queue" ? "queue a note for" : "steer", str(input.workspace_id));
        break;
      case "chat_digest":
        did("Read", "read", str(input.workspace_id));
        break;
      case "chat_stop":
        did("Stopped", "stop", str(input.workspace_id));
        break;
      case "chat_answer":
        did("Answered the question of", "answer the question of", str(input.workspace_id));
        break;
      case "memory_sql":
        did("Looked in memory", "look in memory");
        break;
      // Smart View: a quiet line for what it opened beside the person; what the rules held back says nothing here
      // (the Chief says it in words when it matters).
      case "view_open": {
        const what = str(input.title) ?? viewSubject(input);
        if (failed) line(`Could not open ${what || "a chat"}`);
        // A chat's line ends with its title, as a link (QuietLine).
        else if (result.opened === true) line(what ? `Opened ${what} beside you` : "Opened beside you:", input.kind === "chat" ? str(input.workspace_id) : null);
        break;
      }
      case "view_close":
        did("Tidied up beside you", "tidy up beside you");
        break;
      // Nothing to draw here: a look at its open views, a search of the chats, a playbook, and a reaction (its badge
      // sits on the person's bubble).
      case "view_list":
      case "chat_search":
      case "playbook":
      case "react":
        break;
      default:
        line(`${t.verb} ${t.subject}`.trim());
    }
  }
  return out;
}

// -------------------------------------------------------------- capture shortcut

export const DEFAULT_CAPTURE_SHORTCUT = "Control+Alt+Space";

const CODE_KEYS: Readonly<Record<string, string>> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

/**
 * A key press as an Electron accelerator ("Control+Alt+Space"), for the
 * capture shortcut. Null until it holds ⌃, ⌥ or ⌘ (Ctrl, Alt or the Windows
 * key) and a key: a bare key would fire in every app. The Windows key is Super
 * there: Electron's Command is the Mac's alone.
 */
export function acceleratorFrom(e: { readonly code: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }, mac: boolean = IS_MAC): string | null {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : CODE_KEYS[e.code];
  if (!key || !(e.ctrlKey || e.altKey || e.metaKey)) return null;
  return [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && (mac ? "Command" : "Super"), key].filter(Boolean).join("+");
}

/** "Control+Alt+Space" as a Mac shows it, ⌃⌥Space, or as Windows does, Ctrl+Alt+Space. */
export function formatAccelerator(accelerator: string, mac: boolean = IS_MAC): string {
  const MAC_MOD: Readonly<Record<string, string>> = { Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Super: "⌘", Meta: "⌘" };
  const MOD: Readonly<Record<string, string>> = { Control: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Option: "Alt", AltGr: "AltGr", Shift: "Shift", Command: "Win", Cmd: "Win", CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Super: "Win", Meta: "Win" };
  const parts = accelerator.split("+");
  return mac ? parts.map((p) => MAC_MOD[p] ?? p).join("") : parts.map((p) => MOD[p] ?? p).join("+");
}
