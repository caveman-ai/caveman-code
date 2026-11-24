// The Chief's board as pure data: Queue items, their transitions, and the board text a Chief
// turn reads (full after a start or a compaction, else only what changed). No I/O here:
// chief/store.ts persists items and logs each change; the runtime publishes chief.board.updated.
import type { ChiefAttachment, ChiefBlock, ChiefItem, ChiefItemState, ChiefUpdates, ProjectSource, PullRequest } from "@caveman-app/session-protocol";
import { onlyBaseFailing, sameBaseCi } from "../session-protocol/pullRequestCi.ts";
import { ago } from "./prompt.ts";

/** A Chief call the runtime refuses: the message is what the model (or the person) reads; `reason` its protocol error. */
export class ChiefError extends Error {
  readonly reason: "not_found" | "invalid_params" | "invalid_state" | undefined;
  constructor(message: string, reason?: "not_found" | "invalid_params" | "invalid_state") {
    super(message);
    this.reason = reason;
  }
}

/** What chat_start drafted for an item it proposed: chief.start starts it from this, with no model call. */
export interface Proposal {
  readonly project_ids: ReadonlyArray<string>;
  /** The sources of its project each chat checks out, by name (workspace.create sources); absent: the project's own repository. */
  readonly sources?: ReadonlyArray<string>;
  readonly brief: string;
  readonly title: string;
  /** Your words the brief carries, verbatim (memory counts them as yours in the chat). */
  readonly quotes: ReadonlyArray<string>;
  readonly tier?: "fast" | "frontier";
  readonly change_set_id?: string;
  /** The Chief turn that drafted it: its chats count toward that turn's limits, even when they start later. */
  readonly run_id?: string;
  /** Images from the person's notes the chat gets with its brief (chief/attachments.ts). */
  readonly attachments?: ReadonlyArray<ChiefAttachment>;
}

/**
 * Where a chat in exactly `named` (its project's sources, in chat_start's order) opens, as workspace.create takes it:
 * the first repository with a checkout here, else the first one cloned from its remote, with the rest beside it
 * (folders linked in). A folder alone is a chat in that folder. A string says why no chat works in exactly those.
 */
export const sourcesPlace = (named: ReadonlyArray<ProjectSource>): { readonly repo: { readonly path: string } | { readonly url: string }; readonly sources: ReadonlyArray<string> } | string => {
  const repos = named.filter((s) => s.kind === "repo");
  const primary = repos.find((s) => s.path !== undefined) ?? repos[0];
  if (primary === undefined) {
    const [only, ...more] = named;
    if (only?.path !== undefined && more.length === 0) return { repo: { path: only.path }, sources: [only.name] };
    return `${named.map((s) => s.name).join(", ")} are plain folders: a chat works in one folder, or in a repository with folders beside it. Start one chat per folder, or name a repository with them.`;
  }
  const repo = primary.path !== undefined ? { path: primary.path } : primary.repository !== undefined ? { url: primary.repository.clone_url } : undefined;
  if (repo === undefined) return `${primary.name} has no checkout on this computer and no remote to clone it from.`;
  return { repo, sources: [primary.name, ...named.filter((s) => s !== primary).map((s) => s.name)] };
};

/** A Queue item as the runtime keeps it: the wire item plus what only the runtime reads. */
export interface Item extends ChiefItem {
  /** When its chats first started; a legacy item without checked_at measures check-ins from here, else creation. */
  readonly started_at?: string;
  /** When its pace was set or its last check-in claimed, persisted before sending so a restart never repeats it. */
  readonly checked_at?: string;
  /** chief.capture mode start (⌘Enter): the Chief starts it without asking; its limits still hold. */
  readonly start: boolean;
  readonly proposal?: Proposal;
  /** The note reached the Chief's conversation (a note captured with no key, or whose delivery failed, is sent again). */
  readonly delivered?: boolean;
  /**
   * The session of the Chief that first heard the note, kept when the item moves to another Chief's board (a Chief
   * removed or retired): the person's words are in that Chief's transcript, not the new one's, so a quote of them is
   * checked there too (store.putQuotes). Absent: not delivered, or an older item
   * that never moved.
   */
  readonly heard_in?: string;
  /** The exact request_id of the latest accepted delivery, including any refusal suffix. Runtime only. */
  readonly sent_as?: string;
  /** The session of the latest accepted delivery, paired with sent_as for reactions. Runtime only. */
  readonly sent_in?: string;
}

/** Item sources whose text is the person's own words (typed, or said on a call and transcribed). */
export const TYPED_SOURCES: ReadonlySet<ChiefItem["source"]> = new Set(["composer", "capture", "cli", "voice"]);

export const OPEN_STATES: ReadonlySet<ChiefItemState> = new Set(["unsorted", "queued", "proposed", "blocked", "scheduled"]);
export const RUNNING_STATES: ReadonlySet<ChiefItemState> = new Set(["started", "review", "needs_you"]);
export const CLOSED_STATES: ReadonlySet<ChiefItemState> = new Set(["done", "dropped"]);

export const toWire = (item: Item): ChiefItem => {
  const { start: _start, proposal: _proposal, delivered: _delivered, heard_in: _heardIn, started_at: _startedAt, checked_at: _checkedAt, sent_as: _sentAs, sent_in: _sentIn, ...wire } = item;
  return wire;
};

/** Queue order: rank, then age. */
export const byRank = (a: Item, b: Item) => a.rank - b.rank || a.created_at.localeCompare(b.created_at);

const touch = (item: Item, patch: Partial<Item>, now: string): Item => ({ ...item, ...patch, updated_at: now });
const without = <K extends keyof Item>(item: Item, ...keys: ReadonlyArray<K>): Item => {
  const next = { ...item };
  for (const key of keys) delete next[key];
  return next;
};

/** A mission's proof and pace: absent fields stay; empty proof or null pace clears that field. */
export const mission = (item: Item, input: { readonly done_when?: string | undefined; readonly check_in?: ChiefItem["check_in"] | null }, now: string): Item => {
  let next = item;
  if (input.done_when !== undefined) next = input.done_when.trim() === "" ? without(next, "done_when") : { ...next, done_when: input.done_when.trim() };
  if (input.check_in !== undefined) next = input.check_in === null ? without(next, "check_in") : { ...next, check_in: input.check_in, checked_at: now };
  return next === item ? item : touch(next, {}, now);
};

const CHECK_IN_STATES: ReadonlySet<ChiefItemState> = new Set(["unsorted", "queued", "started", "review"]);

/**
 * A mission that checks in at its pace. Items waiting on purpose and closed items never do, nor one whose question to
 * the person waits for an answer (asked): its Chief has nothing to do there until it comes.
 */
export const checkInOpen = (item: Item): boolean => item.check_in !== undefined && item.asked === undefined && CHECK_IN_STATES.has(item.state);

/** Due at the exact pace boundary, counted from its last check-in, else its start, else its making. */
export const checkInDue = (item: Item, now: number): boolean =>
  checkInOpen(item) && now - Date.parse(item.checked_at ?? item.started_at ?? item.created_at) >= (item.check_in === "day" ? 1 : 7) * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------- transitions

export interface NewItem {
  readonly id: string;
  /** The Chief whose board it goes on. */
  readonly chief_id?: string;
  readonly text: string;
  readonly source: Item["source"];
  readonly state?: "unsorted" | "queued";
  readonly title?: string;
  readonly project_ids?: ReadonlyArray<string>;
  readonly start?: boolean;
  readonly attachments?: ReadonlyArray<ChiefAttachment>;
}

/** A new item at the end of the Queue. */
export const add = (items: ReadonlyArray<Item>, input: NewItem, now: string): Item => ({
  id: input.id,
  ...(input.chief_id === undefined ? {} : { chief_id: input.chief_id }),
  text: input.text,
  ...(input.title ? { title: input.title } : {}),
  state: input.state ?? "unsorted",
  rank: items.reduce((max, item) => Math.max(max, item.rank), 0) + 1,
  pinned: false,
  project_ids: [...(input.project_ids ?? [])],
  source: input.source,
  workspace_ids: [],
  ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
  start: input.start === true,
  created_at: now,
  updated_at: now,
});

/** Sorted: a title, its projects, and queued. */
export const sort = (item: Item, input: { readonly title?: string; readonly project_ids?: ReadonlyArray<string> }, now: string): Item =>
  touch(item, { ...(input.title ? { title: input.title } : {}), ...(input.project_ids ? { project_ids: [...input.project_ids] } : {}), state: item.state === "unsorted" ? "queued" : item.state }, now);

/** Blocked on something else than a question (`ask` is how an item waits on the person): any question about it is settled. */
export const block = (item: Item, on: ChiefBlock, now: string): Item => touch(without(item, "asked"), { state: "blocked", blocked_on: on }, now);

export const schedule = (item: Item, at: string, now: string): Item => touch(without(item, "blocked_on", "asked"), { state: "scheduled", not_before: at }, now);

/** What the Chief asked the person about an item (its `ask` tool). */
export type Asked = NonNullable<ChiefItem["asked"]>;
/**
 * The Chief asked the person about it. An unsorted or queued item waits on them; any other keeps its state and what it
 * waits on (a chat that waits on the answer, a draft, another item, a free slot), with the question beside it.
 */
export const ask = (item: Item, asked: Asked, now: string): Item =>
  item.state === "unsorted" || item.state === "queued" ? touch(item, { state: "blocked", blocked_on: { kind: "you", reason: asked.question }, asked }, now) : touch(item, { asked }, now);
/** Its question is settled (answered, or gone ahead with): an item that waited only on it goes back to the Queue. */
export const settle = (item: Item, now: string): Item =>
  item.asked === undefined
    ? item
    : item.state === "blocked" && item.blocked_on?.kind === "you"
      ? touch(without(item, "asked", "blocked_on"), { state: "queued" }, now)
      : touch(without(item, "asked"), {}, now);

/** The Chief suggests it and waits for you (the Suggested card): chief.start starts it from `proposal`. */
export const propose = (item: Item, proposal: Proposal, now: string): Item =>
  touch(without(item, "blocked_on", "asked"), { state: "proposed", proposal, project_ids: [...new Set(proposal.project_ids)], title: item.title ?? proposal.title }, now);

/** Its chats started: they run, and the watcher moves it on from here. */
export const start = (item: Item, workspaceIds: ReadonlyArray<string>, now: string): Item =>
  touch(without(item, "blocked_on", "detail", "proposal", "not_before", "asked"), {
    state: "started",
    started_at: item.started_at ?? now,
    start: false,
    workspace_ids: [...new Set([...item.workspace_ids, ...workspaceIds])],
  }, now);

/** What a chat it started did, as the watcher saw it. */
export type Outcome =
  | { readonly kind: "working" }
  | { readonly kind: "needs_you"; readonly detail: string }
  | { readonly kind: "review" }
  | { readonly kind: "done" };

/**
 * What an item's chats did, as one: a chat that needs the person first, then one still at work, then work to review,
 * else `otherwise` (every chat done). So the first chat to finish can't close an item while a sibling works.
 */
export const combine = (outcomes: ReadonlyArray<Outcome>, otherwise: Outcome): Outcome =>
  outcomes.find((o) => o.kind === "needs_you") ?? outcomes.find((o) => o.kind === "working") ?? outcomes.find((o) => o.kind === "review") ?? otherwise;

/**
 * started -> review / needs_you / done, and back to started when a chat works again: a done item too (its Chief or the
 * person sent its chat more work). Only items whose chats run, or finished, move; a dropped one stays dropped. A chat
 * that finishes settles any question about the item. The same outcome again (the startup replay of a chat's latest
 * turn) returns the item itself, so it is no move and wakes no one: a finished report is heard once (item #13). Ready
 * for review with a pull request that needs the person (recorded while the chat was left to fix its own checks) needs
 * the person, as pullRequest would move a review item; only the pull request's sync unflags it.
 */
export const watched = (item: Item, outcome: Outcome, now: string): Item => {
  if (!RUNNING_STATES.has(item.state) && !(item.state === "done" && outcome.kind === "working")) return item;
  if (outcome.kind === "working") return item.state === "started" ? item : touch(without(item, "detail"), { state: "started" }, now);
  if (outcome.kind === "needs_you") return item.state === "needs_you" && item.detail === outcome.detail ? item : touch(item, { state: "needs_you", detail: outcome.detail }, now);
  const issue = outcome.kind === "review" ? pullRequestIssue(item.pull_request) : undefined;
  if (issue !== undefined) return item.state === "needs_you" && item.detail === issue && item.asked === undefined ? item : touch(without(item, "asked"), { state: "needs_you", detail: issue }, now);
  if (item.state === outcome.kind && item.detail === undefined && item.asked === undefined) return item;
  return touch(without(item, "detail", "asked"), { state: outcome.kind }, now);
};

/**
 * Why a pull request needs the person, in one line; undefined while it is open and healthy (or merged). Checks that
 * fail only where its base fails too (base_ci) are the base's to fix, not the person's here: no issue.
 */
export const pullRequestIssue = (pr: PullRequest | undefined): string | undefined => {
  if (pr === undefined || pr.state === "merged") return undefined;
  if (pr.state === "closed") return `Its pull request #${pr.number} was closed without merging.`;
  if (pr.checks === "failing" && !onlyBaseFailing(pr.base_ci)) return `Checks are failing on #${pr.number}.`;
  if (pr.review === "changes_requested") return `Changes were requested on #${pr.number}.`;
  return undefined;
};

/**
 * Its chat's pull request moved on the host (the runtime synced it): the item records it and follows it. Merged moves a
 * running item to done, with nobody touching it, once none of its `chats` (where the item's other chats stand, and the
 * merged one while it still works) needs the person, works or has work to review; until then the item stays open for
 * them, and drops a flag this pull request raised. Closed without merging, failing checks or changes requested move a
 * review item to needs_you (its `detail` says which); an item that waits on the person for that goes back to review
 * once the pull request is healthy again. A chat's own question or failure (needs_you for another reason) is kept; a
 * started chat is left to fix its own checks. Any other item only records the pull request.
 */
export const pullRequest = (item: Item, pr: PullRequest | undefined, now: string, chats: ReadonlyArray<Outcome> = []): Item => {
  if (pr === undefined) return item;
  const recorded: Item =
    pr.number === item.pull_request?.number && pr.state === item.pull_request.state && pr.checks === item.pull_request.checks && pr.review === item.pull_request.review && sameBaseCi(pr.base_ci, item.pull_request.base_ci)
      ? item
      : touch(item, { pull_request: pr }, now);
  if (!RUNNING_STATES.has(item.state)) return recorded;
  const flaggedByPullRequest = item.state === "needs_you" && pullRequestIssue(item.pull_request) !== undefined && item.detail === pullRequestIssue(item.pull_request);
  if (pr.state === "merged") {
    const standing = combine(chats, { kind: "done" });
    if (standing.kind === "done") return touch(without(recorded, "detail", "asked"), { state: "done" }, now);
    return flaggedByPullRequest ? watched(without(recorded, "detail"), standing, now) : recorded;
  }
  const issue = pullRequestIssue(pr);
  if (issue !== undefined) {
    if (item.state === "review" || flaggedByPullRequest) return item.detail === issue && item.state === "needs_you" ? recorded : touch(recorded, { state: "needs_you", detail: issue }, now);
    return recorded;
  }
  return flaggedByPullRequest ? touch(without(recorded, "detail"), { state: "review" }, now) : recorded;
};

/** An open pull request with nothing running or red on it: the work is ready for the person. */
const settled = (pr: PullRequest | undefined) => pr?.state === "open" && pr.checks !== "pending" && pr.checks !== "failing";

/**
 * A pull request change worth telling the Chief: the item moved to done or to needs_you, or what it needs changed; or a
 * review item's pull request is ready now (its checks went through or green again) where it was not. Never an
 * unchanged poll, and never the first sight of a pull request. Whether the Chief is woken for it is its level's
 * (chief/updates.ts gate).
 */
export const pullRequestNews = (before: Item, after: Item): boolean =>
  after !== before &&
  (((after.state === "done" || after.state === "needs_you") && (after.state !== before.state || after.detail !== before.detail)) ||
    (after.state === "review" && before.pull_request !== undefined && settled(after.pull_request) && !settled(before.pull_request)));

/** How much the person hears about this item's chats ("tell me everything about this one"); null: its Chief's level again. */
export const followUpdates = (item: Item, level: ChiefUpdates | null, now: string): Item =>
  (level ?? undefined) === item.updates ? item : level === null ? touch(without(item, "updates"), {}, now) : touch(item, { updates: level }, now);

export const drop = (item: Item, now: string): Item => touch(without(item, "blocked_on", "proposal", "asked"), { state: "dropped" }, now);
export const done = (item: Item, now: string): Item => touch(without(item, "blocked_on", "proposal", "asked"), { state: "done" }, now);
/** Back to waiting its turn (from blocked, proposed, scheduled). */
export const requeue = (item: Item, now: string): Item => touch(without(item, "blocked_on", "not_before", "asked"), { state: "queued" }, now);

/**
 * The person rewrote a note (chief.items.update text). A draft made from its old words would start the old task, so it
 * goes (with the title it gave), and a note waiting on that draft (Suggested, or blocked on a limit) waits in the Queue
 * to be drafted again from the new words. A scheduled note keeps its time.
 */
export const rewritten = (item: Item, text: string, now: string): Item => (text === item.text ? item : touch(undraft(item, now), { text }, now));

/**
 * Its draft gone (with the title it gave), when it can no longer start as drafted: a note waiting on it (Suggested, or
 * blocked on a limit) waits in the Queue to be drafted again; a scheduled note keeps its time.
 */
export const undraft = (item: Item, now: string): Item => {
  if (item.proposal === undefined) return item;
  const undrafted = without(item, "proposal", ...(item.title === item.proposal.title ? (["title"] as const) : []));
  return item.state === "proposed" || item.state === "blocked" ? requeue(undrafted, now) : touch(undrafted, {}, now);
};

/**
 * A gone Chief's open or running item, as it lands on another Chief's board (one that works in its project, when a
 * Chief is removed). A running item (its chats still work, wait for review or need you) stays as it is,
 * but for a question the gone Chief asked the person: the new Chief watches its chats from now on, and never goes
 * ahead on a question it did not ask. A note it never sorted (unsorted) stays one and is not delivered, so the new
 * Chief hears and sorts it; queued and scheduled items keep their place and time; a proposed or blocked item drops its
 * draft (the gone Chief's, with its permissions and turn) and waits in the Queue to be drafted again. Queued,
 * scheduled and redrafted items say where they came from (`detail`).
 */
export const handedTo = (item: Item, detail: string, at: string): Item => {
  if (RUNNING_STATES.has(item.state)) return touch(without(item, "asked"), {}, at);
  if (item.state === "unsorted") return { ...item, delivered: false, updated_at: at };
  if (item.state === "queued" || item.state === "scheduled") return { ...item, detail, updated_at: at };
  const { proposal: _draft, ...requeued } = requeue(item, at);
  return { ...requeued, detail, start: false };
};

/**
 * You moved `itemId` before `beforeId` (null: to the end), and it is pinned there: the Chief
 * never moves it. Returns every item whose rank changed.
 */
export const reorderByUser = (items: ReadonlyArray<Item>, itemId: string, beforeId: string | null, now: string): ReadonlyArray<Item> => {
  const sorted = [...items].sort(byRank).filter((i) => i.id !== itemId);
  const moving = items.find((i) => i.id === itemId);
  if (!moving) return [];
  const at = beforeId === null ? sorted.length : sorted.findIndex((i) => i.id === beforeId);
  if (at < 0) return [];
  const prev = sorted[at - 1]?.rank;
  const next = sorted[at]?.rank;
  const rank = prev === undefined ? (next === undefined ? 1 : next - 1) : next === undefined ? prev + 1 : (prev + next) / 2;
  // Midpoint ranks; when a gap is too small to split, every item is respaced 1, 2, 3... in the new order.
  if (prev !== undefined && next !== undefined && next - prev < 1e-9) {
    const order = [...sorted.slice(0, at), moving, ...sorted.slice(at)];
    return order.flatMap((item, i) =>
      item.id === itemId ? [touch(item, { rank: i + 1, pinned: true }, now)] : item.rank === i + 1 ? [] : [touch(item, { rank: i + 1 }, now)],
    );
  }
  return [touch(moving, { rank, pinned: true }, now)];
};

/**
 * The Chief's order for the items it names: unpinned ones take the unpinned slots in that order
 * (named first, the rest after in their order); pinned items keep their rank. Returns changed items.
 */
export const orderByChief = (items: ReadonlyArray<Item>, ids: ReadonlyArray<string>, now: string): ReadonlyArray<Item> => {
  const free = [...items].filter((i) => !i.pinned).sort(byRank);
  const slots = free.map((i) => i.rank);
  const named = ids.flatMap((id) => free.filter((i) => i.id === id));
  const order = [...new Set([...named, ...free])];
  return order.flatMap((item, i) => (item.rank === slots[i] ? [] : [touch(item, { rank: slots[i]! }, now)]));
};

// ------------------------------------------------------------------ render

/** A chat on the board as a Chief turn sees it. */
export interface ChatLine {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly status: string;
  readonly latest?: string;
  /** The item it was started for. */
  readonly item_id?: string;
  /** When the chat was made (ISO): the board says how long it has run, since no chat update carries a time. */
  readonly started_at?: string;
  /** Its key terms, from its own words (about.ts keyTerms): what it is about when its title does not say. */
  readonly about?: ReadonlyArray<string>;
  /** Running, waiting on someone, or its item is: always on the full board, in full. Else it is idle and listed compact. */
  readonly active?: boolean;
  /** The sources it works in, its primary first, when its project has several (Chief.ts chatRepos). */
  readonly repos?: ReadonlyArray<string>;
}

/** ≤1,500 tokens at 4 characters each. */
export const BOARD_BUDGET_CHARS = 6_000;
const TOP_ITEMS = 20;
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** "14:05" in the runtime's local time: when a question goes ahead, as the Chief tells the person. */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const askedText = (asked: Asked | undefined) =>
  asked === undefined ? "" : ` · asked the person${asked.go_ahead_at ? ` (goes ahead at ${clock(asked.go_ahead_at)})` : " (waits for them)"}: ${clip(asked.question, 120)}`;

const blockText = (on: ChiefBlock | undefined, asked: Asked | undefined) =>
  on === undefined || (on.kind === "you" && asked !== undefined) ? "" : on.kind === "item" ? ` · after ${on.item_id}` : on.kind === "you" ? ` · on you: ${clip(on.reason, 80)}` : on.kind === "capacity" ? " · waits for a free chat slot" : " · waits for tomorrow's cap";

/**
 * One item as a Chief turn reads it. `chats`: the board's chats by id, so each of its chats is said on this line (one
 * line per piece of work, never an item line and a chat line for the same chat): its id, and its status and how long
 * it has run while it is not idle (an idle chat's state is the item's).
 */
export const itemLine = (item: Item, projectName: (id: string) => string, chats?: ReadonlyMap<string, ChatLine>, now = Date.now()) =>
  `- ${item.id}${item.number === undefined ? "" : ` #${item.number}`} [${item.state}${item.pinned ? ", pinned" : ""}${item.start ? ", start now" : ""}] ${item.title ? `"${clip(item.title, 80)}"` : `note: "${clip(item.text, 160)}"`}` +
  (item.project_ids.length > 0 ? ` · ${item.project_ids.map(projectName).join(", ")}` : "") +
  (item.done_when ? ` · done when: ${clip(item.done_when, 280)}` : "") +
  (item.check_in ? ` · check in: ${item.check_in}` : "") +
  blockText(item.blocked_on, item.asked) +
  askedText(item.asked) +
  (item.not_before ? ` · not before ${item.not_before}` : "") +
  (item.workspace_ids.length > 0 ? ` · chats ${item.workspace_ids.map((id) => chatState(id, chats?.get(id), now)).join(", ")}` : "") +
  (item.pull_request ? ` · PR #${item.pull_request.number} ${pullRequestStatus(item.pull_request)}` : "") +
  (item.detail ? ` · ${clip(item.detail, 120)}` : "");

/**
 * "merged", "closed", "open, checks failing", "open, checks failing only as main does (not this PR)", "open, changes
 * requested", "open, checks pending", "open, approved", "draft".
 */
export const pullRequestStatus = (pr: PullRequest): string => {
  if (pr.state === "merged" || pr.state === "closed") return pr.state;
  const failing = onlyBaseFailing(pr.base_ci)
    ? `checks failing only as ${pr.base_ci!.base} does${pr.base_ci!.base_state === "passing" ? " (fixed there since: re-run)" : ""} (not this PR)`
    : "checks failing";
  const notes = [
    ...(pr.checks === "failing" ? [failing] : pr.checks === "pending" ? ["checks pending"] : []),
    ...(pr.review === "changes_requested" ? ["changes requested"] : pr.review === "approved" ? ["approved"] : []),
  ];
  return notes.length > 0 ? `${pr.state}, ${notes.join(", ")}` : pr.state;
};

const aboutText = (about: ReadonlyArray<string> | undefined, max: number) => (about?.length ? ` · about: ${about.slice(0, max).join(", ")}` : "");
const reposText = (repos: ReadonlyArray<string> | undefined) => (repos?.length ? `in ${repos.join(" + ")}` : "");

/** An item's chat on its line: "w1" when idle, else "w1 (working, started 25 minutes ago)"; "w1 (in cloud)" in a project of several sources. */
const chatState = (id: string, chat: ChatLine | undefined, now: number) => {
  const facts = [
    ...(chat === undefined || chat.status === "idle" ? [] : [`${chat.status}${chat.started_at ? `, started ${ago(chat.started_at, now)}` : ""}`]),
    ...(chat?.repos?.length ? [reposText(chat.repos)] : []),
  ];
  return facts.length === 0 ? id : `${id} (${facts.join(", ")})`;
};

/** A chat no item of this Chief holds (one the person runs in its projects). */
export const chatLine = (chat: ChatLine, now = Date.now()) =>
  `- ${chat.id} "${clip(chat.title, 80)}" ${chat.project}${chat.repos?.length ? ` ${reposText(chat.repos)}` : ""} ${chat.status}${chat.item_id ? ` (for ${chat.item_id})` : ""}${chat.started_at ? ` · started ${ago(chat.started_at, now)}` : ""}${aboutText(chat.about, 6)}${chat.latest ? `: ${clip(chat.latest, 160)}` : ""}`;

/** An idle chat in a few tokens: its id, a short title, its repos when its project has several, its status and its first key terms. */
export const compactChatLine = (chat: ChatLine) => `- ${chat.id} "${clip(chat.title, 40)}"${chat.repos?.length ? ` ${reposText(chat.repos)}` : ""} ${chat.status}${aboutText(chat.about, 4)}`;

/** Lines into `budget`, the rest as one count line. */
const fit = (head: string, lines: ReadonlyArray<string>, budget: number, more: (n: number) => string) => {
  const kept: string[] = [];
  let used = head.length;
  for (const [i, line] of lines.entries()) {
    const tail = i < lines.length - 1 ? more(lines.length - i).length + 1 : 0;
    if (used + line.length + 1 + tail > budget) {
      kept.push(more(lines.length - i));
      return [head, ...kept];
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [head, ...kept];
};

/**
 * The whole board: the top of the Queue, under half the budget; then every running item with its chats on its line, and
 * every other active chat in full, whatever they take (a chat the Chief cannot see is a chat it cannot route a note to);
 * then idle chats, compact, while the budget lasts. Idle chats past it are counted on a line that says chat_search finds
 * them: never dropped silently.
 */
export const renderFull = (items: ReadonlyArray<Item>, chats: ReadonlyArray<ChatLine>, projectName: (id: string) => string, budget = BOARD_BUDGET_CHARS, now = Date.now()) => {
  const open = items.filter((i) => !CLOSED_STATES.has(i.state)).sort(byRank);
  const queue = open.filter((i) => OPEN_STATES.has(i.state));
  const running = open.filter((i) => RUNNING_STATES.has(i.state));
  const closedToday = items.length - open.length;
  const byId = new Map(chats.map((c) => [c.id, c]));
  const held = new Set(running.flatMap((i) => i.workspace_ids));
  const loose = chats.filter((c) => !held.has(c.id));
  const half = Math.floor((budget - 40) / 2);
  const queueLines = fit(
    `Queue (${queue.length} waiting${queue.length > TOP_ITEMS ? `, top ${TOP_ITEMS}` : ""}):`,
    queue.slice(0, TOP_ITEMS).map((i) => itemLine(i, projectName)),
    half,
    (n) => `- and ${n} more`,
  );
  if (queue.length > TOP_ITEMS) queueLines.push(`- and ${queue.length - TOP_ITEMS} more`);
  const active = loose.filter((c) => c.active !== false);
  const idle = loose.filter((c) => c.active === false);
  const runningLines = [
    `Running (${running.length}), done or dropped today (${closedToday}):`,
    ...running.map((i) => itemLine(i, projectName, byId, now)),
    ...(active.length === 0 ? [] : [`Other chats (${active.length}):`]),
    ...active.map((c) => chatLine(c, now)),
  ];
  const left = budget - [...queueLines, ...runningLines].reduce((n, line) => n + line.length + 1, 0) - 40;
  const idleLines = idle.length === 0 ? [] : fit(`Idle chats (${idle.length}):`, idle.map(compactChatLine), left, (n) => `- ${n} older idle chats not listed: chat_search finds any chat by what it is about`);
  return ["<board>", ...queueLines, ...runningLines, ...idleLines, "</board>"].join("\n");
};

/** The chats a rendered delta has a line for: one cut for the budget is not told yet, and goes in a later delta. */
export const shownChats = (text: string, chats: ReadonlyArray<ChatLine>) => chats.filter((c) => text.includes(`\n- ${c.id} `)).map((c) => c.id);

/** Only what changed since the Chief's last turn: the items touched (or removed), and chats it has not been told of yet. */
export const renderDelta = (
  changed: ReadonlyArray<Item>,
  removed: ReadonlyArray<string>,
  chats: ReadonlyArray<ChatLine>,
  projectName: (id: string) => string,
  budget = BOARD_BUDGET_CHARS,
  person: ReadonlyArray<string> = [],
) => {
  if (changed.length === 0 && removed.length === 0 && chats.length === 0) return "";
  const lines = fit(
    "<board_changes>",
    // A chat here is new to the Chief: one the person started, or put on its board (Chief.ts introduced).
    [...[...changed].sort(byRank).map((i) => `${itemLine(i, projectName)}${person.includes(i.id) ? ' · by="person"' : ""}`), ...removed.map((id) => `- ${id} removed${person.includes(id) ? ' · by="person"' : ""}`), ...chats.map((c) => `${chatLine(c)} · new to you`)],
    budget - 20,
    (n) => `- and ${n} more changes`,
  );
  return [...lines, "</board_changes>"].join("\n");
};
