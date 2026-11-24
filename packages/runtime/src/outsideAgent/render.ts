// What the outside agent reads: chats, a digest, a transcript page, engines, projects and diffs as plain text lines
// (docs/ §3 "The digest", "Rules every tool follows"). Usage and cost never
// appear: `usage` events are dropped and engines' quota windows are left out. Every "Next:" holds a valid call.
import { createHash } from "node:crypto";
import type {
  AskUser as AskUserSchema,
  EngineDescriptor,
  FileChange as FileChangeSchema,
  OutsideAgentLevel,
  Project,
  SessionEvent,
  TurnFile,
  Workspace,
  WorkspaceDigest,
} from "@caveman-app/session-protocol";

import { ACCESS_LABEL, LEVEL_LABEL, LEVEL_MEANS, accessCeiling, canStartOn, engineHonours, isConnected } from "./names.ts";

export type AskUser = typeof AskUserSchema.Type;
export type QuestionCard = Extract<AskUser, { kind: "question" }>;
type FileChange = typeof FileChangeSchema.Type;

/** One tool call, as the agent would write it. */
export const call = (tool: string, args: Record<string, unknown>) => `${tool} ${JSON.stringify(args)}`;

/** Model and tool text may carry terminal escapes: keep \n and \t, drop every other C0 and C1 control. */
export const printable = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneLine = (text: string) => printable(text).replace(/\s+/g, " ").trim();

/** How long ago `iso` was: 12s, 4m, 3h, 2d. Empty when it can't be read. */
export function ago(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(1, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------- states

/** A chat's state in agent words: the `chats` filter values, and parked and archived. */
/** `idle`: no turn has finished yet (a chat just made, or one made without a task); never "finished". */
export type ChatState = "working" | "can_answer" | "needs_you" | "finished" | "failed" | "idle" | "parked" | "archived";

export function stateOf(w: Workspace): ChatState {
  switch (w.status) {
    case "starting":
    case "working":
    case "waiting":
      return "working";
    case "needs_input":
      return w.activity?.ask?.kind === "question" ? "can_answer" : "needs_you";
    case "failed":
      return "failed";
    case "parked":
      return "parked";
    case "archived":
      return "archived";
    case "idle":
      return w.activity?.last_outcome === undefined ? "idle" : w.activity.last_outcome === "failed" ? "failed" : "finished";
  }
}

/** Unread in the person's inbox: never seen, or changed since they last looked. */
export const isUnread = (w: Workspace) => {
  const seen = w.inbox?.visited_at;
  return seen === undefined || Date.parse(seen) < Date.parse(w.updated_at);
};

/** In the default `chats` list: everything but finished chats the person has read, marked done or snoozed. */
export function shownByDefault(w: Workspace, now: number): boolean {
  const state = stateOf(w);
  if (state === "archived") return false;
  if (state !== "finished") return true;
  const snoozed = w.inbox?.snoozed_until !== undefined && Date.parse(w.inbox.snoozed_until) > now;
  return isUnread(w) && w.inbox?.done_at === undefined && !snoozed;
}

const ASK_WORDS: Record<"question" | "approval" | "secret" | "tool", string> = {
  question: "a question",
  approval: "an approval",
  secret: "a secret",
  tool: "a custom tool's result",
};

/** The state with how long it has lasted: "working for 3m", "finished 5m ago". */
export function stateWords(w: Workspace, now: number, since?: string): string {
  const state = stateOf(w);
  const at = since ?? (state === "working" ? (w.activity?.turn_started_at ?? w.updated_at) : w.updated_at);
  const age = ago(at, now);
  const forAge = age ? ` for ${age}` : "";
  const agoAge = age ? ` ${age} ago` : "";
  switch (state) {
    case "working":
      return `working${forAge}`;
    case "can_answer":
      return `asks a question you can answer${forAge ? `, waiting${forAge}` : ""}`;
    case "needs_you":
      return `waits for the person (${ASK_WORDS[w.activity?.ask?.kind ?? "approval"]})${forAge}`;
    case "finished":
      return `finished${agoAge}`;
    case "failed":
      return `failed${agoAge}`;
    case "idle":
      return "idle, no turn finished yet";
    case "parked":
      return "parked (moved or asleep)";
    case "archived":
      return "archived";
  }
}

// ------------------------------------------------------------------- labels

export interface Labels {
  readonly projects: ReadonlyArray<Project>;
  readonly engines: ReadonlyArray<EngineDescriptor>;
}

export function projectLabel(w: Workspace, labels: Labels): string {
  const project = w.project_id === undefined ? undefined : labels.projects.find((p) => p.id === w.project_id);
  if (project) return project.name;
  if ("path" in w.repo) return w.repo.path.split(/[\\/]/).filter(Boolean).pop() ?? w.repo.path;
  return w.repo.url.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?$/, "$1");
}

export const engineLabel = (id: string, labels: Labels) => labels.engines.find((e) => e.id === id)?.label ?? id;

// -------------------------------------------------------------------- chats

/** `[id] title · project · state · engine · by Grok · PR #12 · asks: "…"`, one line. */
export function chatLine(w: Workspace, labels: Labels, now: number): string {
  const parts = [`[${w.id}] ${oneLine(w.title) || "Untitled"}`, projectLabel(w, labels), stateWords(w, now), engineLabel(w.engine, labels)];
  if (w.started_by) parts.push(`by ${oneLine(w.started_by.agent)}`);
  if (w.pull_request) parts.push(`PR #${w.pull_request.number} ${w.pull_request.state}`);
  if (w.activity?.ask && w.status === "needs_input") parts.push(`asks: "${clip(oneLine(w.activity.ask.prompt), 120)}"`);
  if (w.activity?.todos && stateOf(w) === "working") parts.push(`todos ${w.activity.todos.done}/${w.activity.todos.total}`);
  return parts.join(" · ");
}

/** The short form errors list a chat in: `[id] title · project · state · age`. */
export function chatRef(w: Workspace, labels: Labels, now: number): string {
  return `[${w.id}] ${oneLine(w.title) || "Untitled"} · ${projectLabel(w, labels)} · ${stateOf(w).replace("_", " ")} · ${ago(w.updated_at, now) || "?"}`;
}

/**
 * Chats newest first, builders folded under their lead (indented below it when the lead is listed), with a line of
 * matched text under a search hit.
 */
export function chatList(
  chats: ReadonlyArray<Workspace>,
  labels: Labels,
  now: number,
  passages: ReadonlyMap<string, string> = new Map(),
): Array<string> {
  const ids = new Set(chats.map((w) => w.id));
  const children = new Map<string, Array<Workspace>>();
  const tops: Array<Workspace> = [];
  for (const w of chats) {
    if (w.parent_workspace_id !== undefined && ids.has(w.parent_workspace_id)) {
      const list = children.get(w.parent_workspace_id) ?? [];
      list.push(w);
      children.set(w.parent_workspace_id, list);
    } else tops.push(w);
  }
  const lines: Array<string> = [];
  const emit = (w: Workspace, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${depth > 0 ? "↳ " : ""}${chatLine(w, labels, now)}`);
    const passage = passages.get(w.id);
    if (passage) lines.push(`${"  ".repeat(depth + 1)}"${clip(oneLine(passage), 200)}"`);
    for (const child of children.get(w.id) ?? []) emit(child, depth + 1);
  };
  for (const w of tops) emit(w, 0);
  return lines;
}

// ---------------------------------------------------------------------- asks

/** Whether only the person can answer this ask: everything but a plain question card, and every grill round. */
export const personOnly = (ask: AskUser) => ask.kind !== "question" || ask.round !== undefined;

/**
 * The short name an ask goes by in answers: an engine's request id runs to hundreds of characters, which an agent would
 * read three times a card. chat_answer takes it or the full id (askMatches).
 */
export const askHandle = (askId: string) => (askId.length <= 12 ? askId : `a${createHash("sha256").update(askId).digest("hex").slice(0, 7)}`);
/** Whether what the agent passed names this ask: its short name or its full id. */
export const askMatches = (passed: string, askId: string) => passed === askId || passed === askHandle(askId);

/** `ask a1 · q1 "Which store?" [pg] Postgres (recommended) [sqlite] SQLite · one pick, words ok`, a line per question. */
export function askCard(askId: string, ask: QuestionCard): Array<string> {
  const handle = askHandle(askId);
  const lines = ask.questions.map((q) => {
    const options = q.options.map((o) => `[${o.id}] ${oneLine(o.label)}${o.id === q.recommended ? " (recommended)" : ""}${o.description ? ` — ${clip(oneLine(o.description), 160)}` : ""}`);
    const how = `${q.multi_select ? "several picks" : "one pick"}${q.allow_text ? ", words ok" : ""}`;
    const head = q.header ? `${oneLine(q.header)}: ` : "";
    const detail = q.detail ? `\n    ${clip(printable(q.detail).trim(), 1_000).replace(/\n/g, "\n    ")}` : "";
    return `${q.id} "${head}${oneLine(q.prompt)}"${options.length ? ` ${options.join(" ")}` : ""} · ${options.length ? how : "words only"}${detail}`;
  });
  if (lines.length === 1) return [`ask ${handle} · ${lines[0]}`];
  return [`ask ${handle}, ${lines.length} questions:`, ...lines.map((line) => `  ${line}`)];
}

/** What only the person answers, in the words the agent passes on: "approve `pnpm i`". */
export function personAsk(ask: AskUser): string {
  switch (ask.kind) {
    case "approval":
      return `approve \`${clip(oneLine(ask.title), 200)}\``;
    case "secret":
      return `the secret ${ask.name} (${clip(oneLine(ask.reason), 200)})`;
    case "tool":
      return `the result of the custom tool ${ask.name}`;
    case "question":
      return `grill round ${ask.round ?? 1} (${plural(ask.questions.length, "question")})`;
  }
}

/** The person-only instruction: tell your user, then wait. */
export const tellYourUser = (w: Workspace) =>
  `Tell your user: "${oneLine(w.title) || "A chat"} waits for you in Caveman Code". Then ${call("chat_wait", { chats: [w.id] })}.`;

/** A valid chat_answer for this card: the recommended picks when every question has one, else the first options. */
export function answerExample(chatId: string, askId: string, ask: QuestionCard): string {
  const handle = askHandle(askId);
  if (ask.questions.every((q) => q.recommended !== undefined)) return call("chat_answer", { chat: chatId, ask_id: handle, recommended: true });
  const answers = ask.questions.map((q) => {
    const pick = q.options[0];
    const question = ask.questions.length > 1 ? { question: q.id } : {};
    return pick ? { ...question, pick: [pick.id] } : { ...question, text: "…" };
  });
  return call("chat_answer", { chat: chatId, ask_id: handle, answers });
}

// -------------------------------------------------------------------- digest

/** A Caveman-engine chat that ended its turn on a question asks in its answer, not with a card. */
const askedInAnswer = (d: WorkspaceDigest) =>
  d.workspace.engine === "caveman" && d.workspace.status === "idle" && d.ask === undefined && /\?\s*$/.test(d.latest ?? "");

const fileList = (files: ReadonlyArray<TurnFile>, max = 12) => {
  const shown = files.slice(0, max).map((f) => `${f.path} +${f.additions} −${f.deletions}`);
  return `${shown.join(", ")}${files.length > max ? `, and ${files.length - max} more` : ""}`;
};

export interface DigestOptions {
  readonly labels: Labels;
  readonly now: number;
}

/** SPEC §3 "The digest": a chat in plain lines, ending with a `Next:` call. */
export function digestText(d: WorkspaceDigest, { labels, now }: DigestOptions): string {
  const w = d.workspace;
  const lines: Array<string> = [`[${w.id}] ${oneLine(w.title) || "Untitled"}`];
  const options = d.options;
  const engine = engineLabel(options?.engine ?? w.engine, labels);
  const facts = [`Project: ${projectLabel(w, labels)}`, `Engine: ${engine}`];
  if (options?.model) facts.push(`model ${options.model}`);
  if (options?.effort) facts.push(`effort ${options.effort}`);
  if (options?.access) facts.push(`access ${options.access} (${ACCESS_LABEL[options.access]})`);
  facts.push(w.started_by ? `started by ${oneLine(w.started_by.agent)}` : "started by the person");
  lines.push(facts.join(" · "));

  const state = stateOf(w);
  const status = [`State: ${stateWords(w, now, d.since)}`];
  if (d.step && state === "working") status.push(`now: ${clip(oneLine(d.step), 200)}`);
  if (state === "failed" && d.error) status.push(`error: ${clip(oneLine(d.error), 600)}`);
  lines.push(status.join(" · "));
  const work: Array<string> = [];
  if (w.activity?.todos) work.push(`Todos: ${w.activity.todos.done} of ${w.activity.todos.total} done`);
  if (d.queued > 0) work.push(`${plural(d.queued, "message")} queued`);
  if (work.length) lines.push(work.join(" · "));

  if (d.goal) lines.push(`Task: ${clip(printable(d.goal).trim(), 1_200)}`);
  if (d.latest) {
    lines.push("Latest answer:", printable(d.latest).trim());
    if (d.latest_clipped) lines.push(`(cut at 2,000 characters; the rest: ${call("chat_read", { chat: w.id, view: "transcript" })})`);
  }

  if (d.ask) {
    if (personOnly(d.ask.ask)) lines.push(`Waits on: the person in Caveman Code: ${personAsk(d.ask.ask)}`);
    else lines.push(...askCard(d.ask.ask_id, d.ask.ask as QuestionCard).map((line, i) => (i === 0 ? `Waits on: ${line}` : line)));
  } else if (askedInAnswer(d)) lines.push("Waits on: it asked in its answer; reply with chat_send");

  if (d.files?.length) lines.push(`Files changed in the latest turn: ${fileList(d.files)}`);
  const where = [`Branch: ${w.branch || "none"}`];
  if (w.root_path) where.push(`Worktree: ${w.root_path}`);
  if (w.pull_request) where.push(`PR #${w.pull_request.number} ${w.pull_request.state}: ${w.pull_request.url}`);
  lines.push(where.join(" · "));
  if (w.head !== undefined) lines.push(`Head cursor: ${w.head}`);
  lines.push(`Next: ${nextFor(d)}`);
  return lines.join("\n");
}

/** The call that moves this chat on, from where it stands. */
export function nextFor(d: WorkspaceDigest): string {
  const w = d.workspace;
  if (d.ask) {
    if (personOnly(d.ask.ask)) return tellYourUser(w);
    return answerExample(w.id, d.ask.ask_id, d.ask.ask as QuestionCard);
  }
  switch (stateOf(w)) {
    case "working":
      return call("chat_wait", { chats: [w.id] });
    case "needs_you":
    case "can_answer":
      return call("chat_read", { chat: w.id });
    case "failed":
      return `${call("chat_read", { chat: w.id, view: "transcript" })} to see why, then ${call("chat_send", { chat: w.id, text: "…" })} to try again`;
    case "parked":
      return `${call("chat_send", { chat: w.id, text: "…" })} once it is back; the person sees where it went in Caveman Code`;
    case "archived":
      return "it is archived; the person can restore it in Caveman Code";
    case "idle":
      return call("chat_send", { chat: w.id, text: "…" });
    case "finished":
      return askedInAnswer(d)
        ? call("chat_send", { chat: w.id, text: "…" })
        : `${call("chat_send", { chat: w.id, text: "…" })} to continue, or ${call("chat_diff", { chat: w.id })} to see what changed`;
  }
}

// ---------------------------------------------------------------- transcript

const STEP_LIMIT = 300;
const MESSAGE_LIMIT = 8_000;

/** One journal event as transcript lines; most events (deltas, output, usage, context) say nothing here. */
export function eventLines(e: SessionEvent, chatId: string): Array<string> {
  switch (e.type) {
    case "turn.started": {
      const run = [e.payload.model, e.payload.effort && `effort ${e.payload.effort}`].filter(Boolean).join(", ");
      return [`--- turn started${run ? ` (${run})` : ""} ---`];
    }
    case "message.done": {
      const p = e.payload;
      const text = printable(p.text).trim();
      const body = text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}… (cut, ${Math.round(text.length / 1000)} KB in all)` : text;
      const images = (p.attachments ?? []).filter((a) => a.type === "image").length;
      const attached = images ? ` [${plural(images, "image")} attached: ${call("chat_read", { chat: chatId, view: "images" })}]` : "";
      if (p.role === "assistant") return [`Agent: ${body}`];
      const who = p.from?.agent ? `From ${oneLine(p.from.title)} · outside agent` : p.from ? `From ${oneLine(p.from.title)}` : "The person";
      const how = p.delivery === "steer" ? " (steered in)" : p.delivery === "queue" ? " (from the queue)" : "";
      return [`${who}${how}: ${body}${attached}`];
    }
    case "tool.started":
      return [`  · ${clip(oneLine(e.payload.title) || e.payload.name, STEP_LIMIT)}`];
    case "tool.done":
      return e.payload.status === "completed" ? [] : [`    ${e.payload.status}${e.payload.error ? `: ${clip(oneLine(e.payload.error), STEP_LIMIT)}` : ""}`];
    case "plan.updated": {
      const done = e.payload.steps.filter((s) => s.status === "completed").length;
      const now = e.payload.steps.find((s) => s.status === "in_progress");
      return [`  todos ${done}/${e.payload.steps.length}${now ? `, now: ${clip(oneLine(now.text), 160)}` : ""}`];
    }
    case "ask.user":
      return [`? asks: ${personOnly(e.payload) ? `the person: ${personAsk(e.payload)}` : e.payload.kind === "question" ? e.payload.questions.map((q) => `"${clip(oneLine(q.prompt), 200)}"`).join(" ") : ""}`];
    case "ask.resolved":
      return [`  (ask ${e.payload.outcome})`];
    case "grill.finished":
      return [`grill finished: ${clip(oneLine(e.payload.summary), 600)} (${e.payload.doc_path})`];
    case "subagent.started":
      return [`  ↳ subagent: ${clip(oneLine(e.payload.title), STEP_LIMIT)}${e.payload.workspace_id ? ` [${e.payload.workspace_id}]` : ""}`];
    case "subagent.done":
      return [`  ↳ subagent ${e.payload.status}${e.payload.summary ? `: ${clip(oneLine(e.payload.summary), 600)}` : ""}`];
    case "checkpoint.created":
      return e.payload.files?.length ? [`  changed ${plural(e.payload.files.length, "file")}: ${fileList(e.payload.files, 6)}`] : [];
    case "checkpoint.resolved":
      return [`  changes ${e.payload.resolution}`];
    case "session.restored":
      return ["(rewound to an earlier turn)"];
    case "goal.updated":
      return [e.payload.objective === null ? "(goal cleared)" : `goal: ${clip(oneLine(e.payload.objective), 400)}`];
    case "session.parked":
      return ["(parked)"];
    case "session.resumed":
      return e.payload.move_failed ? [`(resumed here: ${oneLine(e.payload.move_failed)})`] : ["(resumed)"];
    case "turn.done":
      return [`--- turn ${e.payload.status}${e.payload.error ? `: ${clip(oneLine(e.payload.error), 600)}` : ""} ---`];
    case "notification":
      return e.payload.memory ? [] : [`! ${clip(oneLine(e.payload.title), 200)}${e.payload.body ? `: ${clip(oneLine(e.payload.body), 400)}` : ""}`];
    case "error":
      return e.payload.retry ? [] : [`error: ${clip(oneLine(e.payload.message), 600)}`];
    default:
      // usage, context.updated, deltas, tool output, queue and diff updates, model routing, engine status, voice.
      return [];
  }
}

export const TRANSCRIPT_BYTES = 24 * 1024;

export interface TranscriptPage {
  readonly text: string;
  /** The cursor of the oldest event shown: pass it as `before` for the page before. */
  readonly from: number | undefined;
  /** Earlier events exist (in this page, cut for size, or before it). */
  readonly more: boolean;
}

/**
 * A page of events (oldest first) as transcript text: the newest events that fit in `maxBytes` (or `limit` entries),
 * in order. `more` from the runtime says events exist before the page.
 */
export function transcriptPage(
  events: ReadonlyArray<SessionEvent>,
  pageFrom: number,
  more: boolean,
  { chatId, maxBytes = TRANSCRIPT_BYTES, limit }: { readonly chatId: string; readonly maxBytes?: number; readonly limit?: number | undefined },
): TranscriptPage {
  const picked: Array<{ cursor: number; lines: Array<string> }> = [];
  let bytes = 0;
  let cut = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const lines = eventLines(event, chatId);
    if (lines.length === 0) continue;
    const size = Buffer.byteLength(lines.join("\n")) + 1;
    if ((picked.length > 0 && bytes + size > maxBytes) || (limit !== undefined && picked.length >= limit)) {
      cut = true;
      break;
    }
    picked.unshift({ cursor: event.cursor, lines });
    bytes += size;
  }
  const from = picked[0]?.cursor ?? (events.length ? pageFrom : undefined);
  return { text: picked.flatMap((p) => p.lines).join("\n"), from, more: more || cut };
}

// ------------------------------------------------------------------- images

export type ImageRef =
  | { readonly kind: "inline"; readonly mime: string; readonly data: string; readonly label: string; readonly cursor: number }
  | { readonly kind: "path"; readonly path: string; readonly label: string; readonly cursor: number }
  /** An image the chat holds whose bytes the page doesn't carry whole: too large to show. */
  | { readonly kind: "withheld"; readonly label: string; readonly cursor: number };

/** The raster types MCP clients show as image content. */
export const RASTER = /^image\/(png|jpeg|gif|webp)$/;
const RASTER_PATH = /\.(png|jpe?g|gif|webp)$/i;
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.+)$/is;
// workspace.digest cuts each long string of an event too large for a page on its own and says so after the cut
// ("… (N more characters)"). It keeps bytes it knows for an image whole; base64 holding anything outside its alphabet
// is one it cut all the same, the start of an image.
const NOT_BASE64 = /[^A-Za-z0-9+/=_\s-]/;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const mimeOf = (mime: string) => (mime.toLowerCase() === "image/jpg" ? "image/jpeg" : mime.toLowerCase());

/** Images a tool returned: MCP image blocks, Claude's base64 sources, Codex's data URLs, a browser's own shape, saved files. */
function toolImages(result: unknown, label: string, cursor: number): Array<ImageRef> {
  const out: Array<ImageRef> = [];
  const r = record(result);
  const content = r.content;
  const blocks: ReadonlyArray<unknown> = Array.isArray(result) ? result : Array.isArray(content) ? content : [result];
  for (const block of blocks) {
    const b = record(block);
    const url = str(b.imageUrl) ?? str(b.url);
    const data = url ? DATA_URL.exec(url) : null;
    if (data) out.push({ kind: "inline", mime: mimeOf(data[1]!), data: data[2]!.replace(/\s/g, ""), label, cursor });
    if (b.type !== "image") continue;
    const source = b.source === undefined ? undefined : record(b.source);
    if (source && source.type !== "base64") continue;
    const mime = str(source ? source.media_type : b.mimeType) ?? str(b.mime_type);
    const bytes = str(source ? source.data : b.data);
    if (mime && bytes) out.push({ kind: "inline", mime: mimeOf(mime), data: bytes, label, cursor });
  }
  for (const shape of [r, record(r.screenshot), record(r.image)]) {
    const mime = str(shape.mime_type) ?? str(shape.mimeType);
    const bytes = str(shape.image_base64) ?? (mime?.startsWith("image/") ? str(shape.data) : undefined);
    if (bytes) out.push({ kind: "inline", mime: mimeOf(mime ?? "image/png"), data: bytes, label, cursor });
    for (const key of ["saved_path", "savedPath", "path", "screenshot_path"]) {
      const path = str(shape[key]);
      if (path && RASTER_PATH.test(path)) out.push({ kind: "path", path, label, cursor });
    }
  }
  const saved = r.saved_paths;
  if (Array.isArray(saved)) for (const path of saved) if (typeof path === "string" && RASTER_PATH.test(path)) out.push({ kind: "path", path, label, cursor });
  return out;
}

/**
 * The image items of a page of events, newest first: attachments, screenshots and tools' image output (SPEC §4
 * `media.read`: only images named by an image item; a path written in an answer doesn't count). Raster only.
 */
export function imageRefs(events: ReadonlyArray<SessionEvent>): Array<ImageRef> {
  const out: Array<ImageRef> = [];
  const titles = new Map<string, string>();
  for (const e of events) {
    if (e.type === "tool.started" && e.item_id !== undefined) {
      titles.set(e.item_id, e.payload.title || e.payload.name);
      const input = record(e.payload.input);
      const path = str(input.path) ?? str(input.file_path);
      if (e.payload.name === "view_image" && path && RASTER_PATH.test(path)) out.push({ kind: "path", path, label: `Viewed ${path.split(/[\\/]/).pop()}`, cursor: e.cursor });
    } else if (e.type === "tool.done" && e.payload.status === "completed") {
      out.push(...toolImages(e.payload.result, (e.item_id && titles.get(e.item_id)) || "Screenshot", e.cursor));
    } else if (e.type === "message.done") {
      for (const a of e.payload.attachments ?? []) {
        if (a.type !== "image" || !RASTER.test(mimeOf(a.mime_type))) continue;
        const label = a.name || "Attached image";
        // The journal keeps an image over 1 MB by name only (session-protocol/attachments.ts INLINE_IMAGE_MAX_BYTES).
        out.push(a.data === "" ? { kind: "withheld", label, cursor: e.cursor } : { kind: "inline", mime: mimeOf(a.mime_type), data: a.data, label, cursor: e.cursor });
      }
    }
  }
  const seen = new Set<string>();
  return out
    .filter((ref) => (ref.kind === "path" ? RASTER_PATH.test(ref.path) : ref.kind === "withheld" || RASTER.test(ref.mime)))
    .reverse()
    .filter((ref) => {
      if (ref.kind === "withheld") return true;
      const key = ref.kind === "path" ? `p:${ref.path}` : `d:${ref.data.length}:${ref.data.slice(0, 64)}:${ref.data.slice(-64)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((ref): ImageRef => (ref.kind === "inline" && NOT_BASE64.test(ref.data) ? { kind: "withheld", label: ref.label, cursor: ref.cursor } : ref));
}

// --------------------------------------------------------- engines, projects

/** Engines with what each runs, the access modes it honours, and whether this agent can start chats on it. */
export function enginesText(engines: ReadonlyArray<EngineDescriptor>, level: OutsideAgentLevel, defaultEngine: string | undefined): string {
  const ceiling = accessCeiling(level);
  const connected = engines.filter(isConnected);
  const others = engines.filter((e) => !isConnected(e));
  const lines: Array<string> = [
    ceiling === undefined
      ? `Your level is ${LEVEL_LABEL[level]}: you can't start chats on any engine.`
      : level === "full"
        ? `Your level is ${LEVEL_LABEL[level]}: you can start chats on every connected engine, at any access.`
        : `Your level is ${LEVEL_LABEL[level]} (${LEVEL_MEANS[level]}): you can start chats on the engines that honour "${ceiling}".`,
  ];
  if (connected.length === 0) lines.push("No engine is connected. The person connects one in Caveman Code > Settings.");
  for (const e of connected) {
    const facts = [`${e.label} [${e.id}]`, e.auth.state === "api_key" ? "API key" : "signed in"];
    if (e.id === defaultEngine) facts.push("the default");
    facts.push(`access modes: ${(e.access_modes ?? ["ask", "auto", "review", "full"]).join(", ")}`);
    facts.push(canStartOn(e, level) ? "you can start chats on it" : ceiling && !engineHonours(e, ceiling) ? `you can't: it doesn't honour "${ceiling}"` : "you can't start chats");
    lines.push(facts.join(" · "));
    if (e.default_model) lines.push(`  default model: ${e.default_model}`);
    const models = e.models.filter((m) => !m.legacy);
    for (const m of models.slice(0, 20)) {
      const efforts = m.efforts.length ? ` · efforts ${m.efforts.join(", ")}${m.default_effort ? ` (default ${m.default_effort})` : ""}` : "";
      lines.push(`  - ${m.id}${m.label && m.label !== m.id ? ` "${oneLine(m.label)}"` : ""}${efforts}`);
    }
    const hidden = e.models.length - Math.min(models.length, 20);
    if (hidden > 0) lines.push(`  (${plural(hidden, "more model")}: older or less common; any of them can be passed as model)`);
  }
  if (others.length) {
    const why = (e: EngineDescriptor) => (e.auth.state === "checking" ? "checking" : e.auth.state === "unavailable" ? "not installed" : "signed out");
    lines.push(`Not connected: ${others.map((e) => `${e.label} [${e.id}] (${why(e)})`).join(", ")}. The person connects engines in Caveman Code > Settings.`);
  }
  return lines.join("\n");
}

export function projectsText(projects: ReadonlyArray<Project>, labels: Labels, here: string | undefined, defaultEngine: string | undefined): string {
  if (projects.length === 0) return `No projects yet. Add one: ${call("project_add", { path: "/path/to/repo" })} (Full access), or the person adds it in Caveman Code.`;
  const lines = [`${plural(projects.length, "project")}:`];
  for (const p of projects) {
    const facts = [`[${p.id}] ${oneLine(p.name)}`, p.path];
    if (p.repository) facts.push(p.repository.full_name);
    if (defaultEngine) facts.push(`default engine: ${engineLabel(defaultEngine, labels)}`);
    if (p.default_access) facts.push(`default access: ${p.default_access}`);
    if (p.id === here) facts.push("holds your working folder (the default)");
    lines.push(facts.join(" · "));
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- diffs

const STATUS_MARK: Record<FileChange["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

export function diffFiles(files: ReadonlyArray<FileChange | TurnFile>): Array<string> {
  return files.map((f) => {
    const status = "status" in f ? STATUS_MARK[f.status] : "M";
    const from = "old_path" in f && f.old_path ? ` (from ${f.old_path})` : "";
    return `${status} ${f.path}${from} +${f.additions} −${f.deletions}`;
  });
}
