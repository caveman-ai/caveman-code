// The Chief's work, as its Work tab shows it (work.tsx): each board item with its number (CH-12), where it stands,
// and the chats doing it under it. Pure, so the List, the Board and the Library read one model.
import type { ChiefChangeSet, ChiefItem } from "@caveman-app/session-protocol";
import type { PullRequestView, WorkspaceView } from "../../state/model.ts";
import type { AtWork } from "../../state/now.ts";

/**
 * Where a piece of work stands, as the Work tab groups it, in the order it shows them. Needs you: a decision waits on
 * the person (a question, its own red checks, changes requested). Working: a chat of it is running. Blocked: it waits on
 * something else (another item, a free chat slot, its chat's blocked report). Ready to merge: its pull request is green,
 * or red only where its base is red too. Ready for review: there is something to look at that is not mergeable yet.
 */
export type WorkGroup = "needs" | "working" | "blocked" | "ready" | "review" | "queued" | "done";

export const WORK_GROUPS: ReadonlyArray<{ readonly id: WorkGroup; readonly label: string }> = [
  { id: "needs", label: "Needs your decision" },
  { id: "working", label: "Working" },
  { id: "blocked", label: "Blocked" },
  { id: "ready", label: "Ready to merge" },
  { id: "review", label: "Ready for review" },
  { id: "queued", label: "Queued" },
  { id: "done", label: "Done" },
];

type PrFacts = Pick<PullRequestView, "state" | "checks" | "review" | "base_ci">;

/** Every failing check also fails on its base branch: red, but not because of this pull request. */
export const onlyBaseFailing = (pr: Pick<PullRequestView, "checks" | "base_ci"> | undefined): boolean =>
  pr?.checks === "failing" && pr.base_ci !== undefined && pr.base_ci.failing.length > 0 && pr.base_ci.failing.every((name) => pr.base_ci!.on_base.includes(name));

/** Red only as its base was, and the base is green now: a new run (with the base's fix) is all it needs. */
export const baseFixed = (pr: Pick<PullRequestView, "checks" | "base_ci"> | undefined): boolean => onlyBaseFailing(pr) && pr!.base_ci!.base_state === "passing";

/**
 * Where a pull request stands, in a few words for a chip or a hint: "merged", "closed", "CI red on main · not this PR",
 * "main fixed · re-run CI", "CI failing", "changes requested", "CI pending", "approved", "CI passing"; null with nothing
 * to say (open, nothing known of its checks or review).
 */
export function prStatus(pr: PrFacts): string | null {
  if (pr.state === "merged" || pr.state === "closed") return pr.state;
  if (baseFixed(pr)) return `${pr.base_ci!.base} fixed · re-run CI`;
  if (onlyBaseFailing(pr)) return `CI red on ${pr.base_ci!.base} · not this PR`;
  if (pr.checks === "failing") return "CI failing";
  if (pr.review === "changes_requested") return "changes requested";
  if (pr.checks === "pending") return "CI pending";
  if (pr.review === "approved") return pr.checks === "passing" ? "approved, CI passing" : "approved";
  if (pr.checks === "passing") return "CI passing";
  return null;
}

/**
 * A pull request's chip tone: green while open and healthy, amber when it needs the person, plain once merged or closed,
 * and plain while red only because its base is (nothing for the person to fix here).
 */
export function prTone(pr: PrFacts): "pr" | "warn" | undefined {
  if (pr.state === "merged" || pr.state === "closed") return undefined;
  if (onlyBaseFailing(pr)) return undefined;
  return pr.checks === "failing" || pr.review === "changes_requested" ? "warn" : "pr";
}

/**
 * What a piece of work ready for review waits on: your review, or (approved) your merge, with its pull request's checks.
 * Without a pull request, a look at its changes. The board follows the pull request from here (merged: done).
 */
export function reviewHint(pr: Pick<PullRequestView, "number" | "state" | "checks" | "review" | "base_ci"> | undefined): string {
  if (!pr) return "Waiting on you to look at its changes";
  if (onlyBaseFailing(pr)) return `Its own checks pass; ${pr.base_ci!.base}'s CI is red${baseFixed(pr) ? " (fixed since: re-run CI)" : ""}. Ready for you to merge #${pr.number}`;
  const waits = pr.review === "approved" ? `Waiting on you to merge #${pr.number}` : `Waiting on your review of #${pr.number}`;
  const checks = pr.checks === "passing" ? " · CI passing" : pr.checks === "pending" ? " · CI pending" : "";
  return `${waits}${checks}`;
}

/** The pull request of a piece of work: its item's (the board's copy), else its one chat's. */
export function workPullRequest(item: Pick<ChiefItem, "pull_request">, chats: ReadonlyArray<Pick<WorkspaceView, "pullRequest">>): PullRequestView | undefined {
  return item.pull_request ?? chats.find((c) => c.pullRequest)?.pullRequest;
}

/** "Checks are failing on #48.": the runtime's own flag (chief Board.pullRequestIssue), which a newer comparison with the base can outdate. */
const CHECKS_FLAG = /^Checks are failing on #\d+\.$/;
/** A chat's report that says it is blocked (the crew contract's `Status: blocked`). */
const blockedReport = (detail: string | undefined): boolean => detail !== undefined && /^Status:\s*blocked\b/i.test(detail);

/** Where a piece of work stands, and why in a few words when that is not plain from its group. */
export interface WorkStatus {
  readonly group: WorkGroup;
  /** "waits on #39", "CI red on main · not this PR", "waits for a free chat slot"; absent when the group says it all. */
  readonly reason?: string | undefined;
}

/**
 * Where a piece of work stands, from its item, its pull request and (when known) its chats. Null for what the board no
 * longer shows (dropped). Done is merged, or closed by the person. A question waiting is a decision. A running chat is
 * working; an item marked started whose chats all finished is judged by what they left (its pull request, else its
 * changes), never left looking busy. `items` names what a blocked item waits on.
 */
export function workStatus(
  item: Pick<ChiefItem, "state" | "asked" | "detail" | "blocked_on" | "pull_request">,
  opts: { readonly chats?: ReadonlyArray<Pick<WorkspaceView, "state" | "pullRequest">>; readonly items?: ReadonlyArray<ChiefItem>; readonly key?: string } = {},
): WorkStatus | null {
  const chats = opts.chats;
  const pr = workPullRequest(item, chats ?? []);
  if (item.state === "dropped") return null;
  if (item.state === "done" || pr?.state === "merged") return { group: "done" };
  if (item.asked) return { group: "needs", reason: "question" };
  if (item.state === "blocked") return { group: "blocked", reason: blockReason(item.blocked_on, opts.items ?? [], opts.key ?? "CH") };
  if (item.state === "unsorted" || item.state === "queued" || item.state === "proposed" || item.state === "scheduled") return { group: "queued" };
  const running = chats === undefined ? item.state === "started" : chats.length === 0 ? item.state === "started" : chats.some((c) => c.state === "working" || c.state === "queued");
  const flagged = item.state === "needs_you" && item.detail !== undefined && CHECKS_FLAG.test(item.detail);
  if (item.state === "needs_you" && !flagged) {
    // The chat stopped on something: a question for the person, or a report that it can't go on.
    if (blockedReport(item.detail)) return { group: "blocked", reason: pr && onlyBaseFailing(pr) ? (prStatus(pr) ?? undefined) : "its chat is blocked" };
    return { group: "needs" };
  }
  if (running) return { group: "working" };
  // Finished (or flagged for its pull request): what it left decides.
  if (!pr || pr.state === "closed") return pr?.state === "closed" ? { group: "needs", reason: "closed without merging" } : { group: "review" };
  if (pr.review === "changes_requested") return { group: "needs", reason: "changes requested" };
  if (onlyBaseFailing(pr)) return { group: "ready", reason: prStatus(pr) ?? undefined };
  if (pr.checks === "failing") return { group: "needs", reason: "its own checks fail" };
  if (pr.state === "draft" || pr.checks === "pending") return { group: "review", ...(pr.checks === "pending" ? { reason: "CI running" } : {}) };
  // Green, or (nothing known of its checks yet) approved: ready. Unknown checks alone wait for the person's look.
  return pr.checks === "passing" || pr.review === "approved" ? { group: "ready" } : { group: "review" };
}

/** What a blocked item waits on, in a few words. */
function blockReason(on: ChiefItem["blocked_on"], items: ReadonlyArray<ChiefItem>, key: string): string {
  if (!on) return "blocked";
  if (on.kind === "item") {
    const other = items.find((i) => i.id === on.item_id);
    const pr = other?.pull_request;
    return pr && pr.state !== "merged" ? `waits on #${pr.number}` : other?.number !== undefined ? `waits on ${key}-${other.number}` : "waits on another item";
  }
  if (on.kind === "you") return `waits on you: ${on.reason}`;
  if (on.kind === "capacity") return "waits for a free chat slot";
  return "waits for tomorrow's cap";
}

/** Its group from the item alone (refs, counts), or null for what the board no longer shows (dropped). */
export function groupOf(item: Pick<ChiefItem, "state" | "asked" | "detail" | "blocked_on" | "pull_request">): WorkGroup | null {
  return workStatus(item)?.group ?? null;
}

/**
 * The Chief's work under way, for the strip on its box (WaitingOn, as a chat's agents): what waits on you first, then
 * what works. One entry per piece of work: its title, since its first chat started, and its line (the Chief's question
 * or trouble when it waits on you, else its chat's one-line detail).
 */
export function chiefAtWork(items: ReadonlyArray<ChiefItem>, workspaces: ReadonlyArray<WorkspaceView>): AtWork[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const live = items.filter((i) => groupOf(i) === "needs" || groupOf(i) === "working");
  const ordered = [...live.filter((i) => groupOf(i) === "needs"), ...live.filter((i) => groupOf(i) === "working")];
  return ordered.map((item) => {
    const chats = item.workspace_ids.flatMap((id) => byId.get(id) ?? []);
    const asking = groupOf(item) === "needs";
    const started = chats.map((c) => c.createdAt).sort()[0];
    const line = asking ? (item.asked?.question ?? item.detail ?? null) : (chats.find((c) => c.state === "working" && c.detail)?.detail ?? null);
    // What waits on you is the line the strip shows (WaitingOn picks the newest activityAt): a question carries when it
    // was asked, and work's lines carry none, so the question always wins over a chat's step.
    const at = asking && line !== null ? (item.asked?.asked_at ?? item.updated_at) : "";
    return { id: item.id, title: workTitle(item), startedAt: started ?? item.updated_at, asking, activity: line, activityAt: at };
  });
}

/**
 * The prefix of a Chief's numbers: CH for the home Chief, else the first three letters of its name (Ugg's UGG-4).
 * Shown only; the runtime keeps the number alone.
 */
export function workKey(chief: { readonly name: string; readonly home: boolean } | null): string {
  if (!chief || chief.home) return "CH";
  return chief.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "CH";
}

/** "CH-12", or null for an item from a runtime before numbers. */
export const workId = (key: string, item: Pick<ChiefItem, "number">): string | null => (item.number === undefined ? null : `${key}-${item.number}`);

/** What a piece of work is called: the Chief's title, else your words. */
export const workTitle = (item: Pick<ChiefItem, "title" | "text">): string => item.title ?? item.text.replace(/\s+/g, " ").trim();

export interface Work {
  readonly item: ChiefItem;
  readonly id: string | null;
  readonly title: string;
  readonly group: WorkGroup;
  /** Why it stands there, when the group alone doesn't say (WorkStatus.reason). */
  readonly reason?: string | undefined;
  /** Its pull request (workPullRequest). */
  readonly pr?: PullRequestView | undefined;
  /** Why queued work cannot start yet, visible in both list and board. */
  readonly waiting: string | null;
  /** The chats doing it, oldest first; absent ones (archived, on another computer) are left out. */
  readonly chats: ReadonlyArray<WorkspaceView>;
  /** Its chats that finished, of all of them: "1 of 2". */
  readonly done: number;
  readonly changeSet: ChiefChangeSet | null;
}

/** The Chief's work in its groups, each in Queue order (the board's). Groups with nothing in them are left out. */
export function workGroups(
  items: ReadonlyArray<ChiefItem>,
  workspaces: ReadonlyArray<WorkspaceView>,
  changeSets: ReadonlyArray<ChiefChangeSet>,
  key: string,
): ReadonlyArray<{ readonly group: WorkGroup; readonly label: string; readonly work: ReadonlyArray<Work> }> {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const sets = new Map(changeSets.map((c) => [c.id, c]));
  const all: Work[] = [];
  for (const item of items) {
    const chats = item.workspace_ids.flatMap((id) => byId.get(id) ?? []);
    const status = workStatus(item, { chats, items, key });
    // Dropped, or a note the Chief handled without a chat (done with none): not work.
    if (status === null || (status.group === "done" && item.workspace_ids.length === 0)) continue;
    const { group } = status;
    all.push({
      item,
      id: workId(key, item),
      title: workTitle(item),
      group,
      reason: status.reason,
      pr: workPullRequest(item, chats),
      waiting: workWaiting(item, items),
      chats,
      done: chats.filter((c) => c.state === "completed").length,
      changeSet: item.change_set_id ? (sets.get(item.change_set_id) ?? null) : null,
    });
  }
  return WORK_GROUPS.flatMap(({ id, label }) => {
    const work = all.filter((w) => w.group === id);
    return work.length > 0 ? [{ group: id, label, work }] : [];
  });
}

export function workWaiting(item: ChiefItem, items: ReadonlyArray<ChiefItem>): string | null {
  if (item.state !== "blocked") return null;
  const on = item.blocked_on;
  if (on?.kind === "item") {
    const dependency = items.find((i) => i.id === on.item_id);
    return dependency ? `Waiting for ${workTitle(dependency)}` : "Waiting for earlier work";
  }
  if (on?.kind === "capacity") return "Waiting for a free chat slot";
  return item.detail || "Blocked";
}

/**
 * The chats under way in a Chief's projects (none listed: every project) that no Chief's board follows: the person's
 * own, which one click puts on this Chief's board (chief.attach). Only this runtime's own top-level chats, since it
 * attaches only those: not a chat only Cloud's list knows, a builder under its lead or an automation's step. Under way
 * is working, waiting on the person, or about to run (a parked chat sleeps). Newest first.
 */
export function untrackedChats(
  workspaces: ReadonlyArray<WorkspaceView>,
  local: { readonly has: (id: string) => boolean },
  board: ReadonlyArray<Pick<ChiefItem, "workspace_ids">>,
  projectIds: ReadonlyArray<string>,
): ReadonlyArray<WorkspaceView> {
  const tracked = new Set(board.flatMap((i) => i.workspace_ids));
  const underWay = (w: WorkspaceView) => w.state === "working" || w.state === "needs_input" || (w.state === "queued" && !w.asleep);
  const inScope = (w: WorkspaceView) => projectIds.length === 0 || (w.projectId !== null && projectIds.includes(w.projectId));
  return workspaces
    .filter((w) => local.has(w.id) && w.parentId === null && !w.automationStep && underWay(w) && inScope(w) && !tracked.has(w.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The documents the Chief's work produced, for the Library: each pull request's review guide and each change set's
 * contract, under the work they belong to, in its project. Newest work first.
 */
export type WorkDoc =
  | { readonly kind: "guide"; readonly key: string; readonly title: string; readonly projectId: string; readonly number: number; readonly at: string }
  | { readonly kind: "contract"; readonly key: string; readonly title: string; readonly changeSetId: string; readonly at: string };

export function workDocs(groups: ReturnType<typeof workGroups>): ReadonlyArray<{ readonly work: Work; readonly docs: ReadonlyArray<WorkDoc> }> {
  const out: Array<{ work: Work; docs: WorkDoc[] }> = [];
  for (const { work } of groups)
    for (const w of work) {
      const docs: WorkDoc[] = [];
      if (w.changeSet && w.changeSet.contract.trim())
        docs.push({ kind: "contract", key: `contract:${w.changeSet.id}`, title: "Contract", changeSetId: w.changeSet.id, at: w.changeSet.updated_at });
      for (const chat of w.chats)
        if (chat.pullRequest && chat.projectId)
          docs.push({ kind: "guide", key: `guide:${chat.projectId}:${chat.pullRequest.number}`, title: `Review guide · #${chat.pullRequest.number}`, projectId: chat.projectId, number: chat.pullRequest.number, at: chat.updatedAt });
      if (docs.length > 0) out.push({ work: w, docs });
    }
  return out.sort((a, b) => b.work.item.updated_at.localeCompare(a.work.item.updated_at));
}

/** A [[12]] the Chief wrote: the item it names on this board, if there is one. */
export function itemByRef(ref: string, items: ReadonlyArray<ChiefItem>): ChiefItem | null {
  const named = /^\[\[(\d+|ci-[a-f\d]{8})\]\]$/.exec(ref)?.[1];
  if (!named) return null;
  return items.find((i) => named.startsWith("ci-") ? i.id === named : i.number === Number(named)) ?? null;
}

const UUID = "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";
/** Numeric work refs, explicit chat refs, and IDs emitted by older Chief turns. */
export const WORK_REF_PATTERN = new RegExp(`\\[\\[(?:\\d+|ci-[a-f\\d]{8}|(?:chat:)?${UUID})\\]\\]`);

/** A chat reference resolves only inside this Chief's board, never another project's arbitrary workspace. */
/** A chat ref, [[chat:<id>]] (or an older turn's bare id): its workspace id. */
export const CHAT_REF = new RegExp(`^\\[\\[(?:chat:)?(${UUID})\\]\\]$`);

export function chatByRef(ref: string, items: ReadonlyArray<ChiefItem>, chats: ReadonlyArray<WorkspaceView>): WorkspaceView | null {
  const id = CHAT_REF.exec(ref)?.[1];
  return id && items.some((i) => i.workspace_ids.includes(id)) ? chats.find((w) => w.id === id) ?? null : null;
}

/** The Chief's words with each [[12]] as its title, for places that show plain text (a notification, a spoken line). */
export function plainRefs(text: string, items: ReadonlyArray<ChiefItem>, chats: ReadonlyArray<WorkspaceView> = []): string {
  return text.replace(new RegExp(WORK_REF_PATTERN.source, "g"), (ref) => {
    const chat = chatByRef(ref, items, chats);
    if (chat) return chat.title;
    const item = itemByRef(ref, items);
    return item ? workTitle(item) : ref;
  });
}

// ------------------------------------------------------------------ what a card says

/** One labelled line of a chat's report: Status, PR, Branch, Check, Left, Question (the Chief's crew contract). */
export interface ReportRow {
  readonly label: string;
  readonly value: string;
}

/**
 * A chat's report as the runtime keeps it on its item (`detail`, chief/prompt.ts reportOf: its lines joined with " · "),
 * back in its rows; null for anything else (a question, a pull request's trouble, a plain line).
 */
export function reportRows(text: string): ReadonlyArray<ReportRow> | null {
  if (!/^Status:\s/.test(text)) return null;
  return text.split(/\s·\s(?=(?:Status|PR|Branch|Check|Left|Question):\s)/).flatMap((part) => {
    const at = part.indexOf(":");
    const value = part.slice(at + 1).trim();
    return value ? [{ label: part.slice(0, at), value }] : [];
  });
}

/** A piece of a line: plain text, or a link ([words](url) or a bare url), so a card shows links as links, never raw. */
export type LinePart = { readonly text: string; readonly href?: string };

export function lineParts(text: string): ReadonlyArray<LinePart> {
  const parts: LinePart[] = [];
  const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)\]]+[^\s)\].,;:!?])/g;
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    const href = m[2] ?? m[3]!;
    parts.push({ text: m[1] ?? shortUrl(href), href });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** A url as a card names it: a pull request or an issue as its repo#number, anything else without its scheme. */
function shortUrl(url: string): string {
  const gh = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)\/?$/.exec(url);
  return gh ? `${gh[1]}#${gh[2]}` : url.replace(/^https?:\/\/(www\.)?/, "");
}

/** A line as plain words: links as their words, bare urls gone. */
const plainLine = (text: string): string =>
  lineParts(text)
    .map((p) => (p.href && p.text === shortUrl(p.href) ? "" : p.text))
    .join("")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Its first sentence: a card's summary, never a paragraph. */
const firstSentence = (text: string): string => text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)[0]!.trim();

/**
 * What a card says under its title. Folded (the default): `label` (a word in the state's colour: Blocked, Question) and
 * one short line of what is needed. Unfolded: the whole of it, as `rows` (a report) or `text`; `more` says there is more
 * to show than the summary. Null with nothing to say (it is under way, or done).
 */
export interface WorkNote {
  readonly label?: string;
  readonly summary: string;
  readonly rows?: ReadonlyArray<ReportRow>;
  readonly more: boolean;
}

export function workNote(work: Pick<Work, "item" | "group" | "reason">, pr: Pick<PullRequestView, "number" | "state" | "checks" | "review" | "base_ci"> | undefined): WorkNote | null {
  const { item, group } = work;
  if (item.asked) {
    const rows = [
      { label: "Question", value: item.asked.question },
      ...(item.asked.recommended.trim() ? [{ label: "Recommended", value: item.asked.recommended }] : []),
    ];
    const summary = firstSentence(plainLine(item.asked.question));
    return { label: "Question", summary, rows, more: true };
  }
  if (group === "done") return null;
  // The runtime's "Checks are failing" flag says less than the chip does once the base's CI is known: the chip speaks.
  const detail = item.detail !== undefined && CHECKS_FLAG.test(item.detail) && group !== "needs" ? undefined : item.detail;
  if ((group === "review" || group === "ready") && !detail) return { summary: reviewHint(pr), more: false };
  if (group === "blocked" && !detail) return { label: "Blocked", summary: work.reason ?? "", more: false };
  if (group === "needs" && !detail && work.reason) return { label: "Needs you", summary: work.reason, more: false };
  if (!detail) return null;
  const rows = reportRows(detail);
  if (!rows) {
    // A chat's question reaches the board as the question alone (chief/watch.ts), so a line that asks is a Question.
    const summary = firstSentence(plainLine(detail));
    const label = group === "blocked" ? "Blocked" : group !== "needs" ? undefined : summary.endsWith("?") ? "Question" : "Needs you";
    return { ...(label ? { label } : {}), summary, more: summary !== detail.trim() };
  }
  const value = (label: string) => rows.find((r) => r.label === label)?.value;
  const status = (value("Status") ?? "").toLowerCase().split(/[\s|.,;:]+/)[0] ?? "";
  const label = status === "blocked" ? "Blocked" : status === "question" ? "Question" : undefined;
  const why = value("Question") ?? value("Left") ?? value("Check") ?? "";
  return { ...(label ? { label } : {}), summary: why ? firstSentence(plainLine(why)) : "", rows: rows.filter((r) => r.label !== "Status"), more: true };
}
