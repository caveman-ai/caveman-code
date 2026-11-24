// Review's pull requests, as the desktop's queue reads them (apps/web/src/routes/review/model.ts). The prototype has no
// host to ask, so a few stand in for teammates' and yours, and the board's own chats add theirs: a chat that is
// ready to look at has opened one on its branch, with its guide ready to read, and a merged one says so in its line.
// Each knows its head (what it changed, hashed), so a guide written for another head reads as stale, and a scripted
// pull request with a written diff (review/guides.ts) takes its files from that diff, so the counts always agree.
import { type Chat, type Engine, type FileChange, totals } from "../../board/model";
import { headOf } from "../../review/fixture";
import { reviewedAt } from "../../review/guides";
import { keep } from "./keep";

export type PrState = "open" | "draft" | "merged" | "closed";
export type Checks = "passing" | "failing" | "pending";
export type Verdict = "approved" | "changes_requested";

export interface Pr {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  state: PrState;
  author: string;
  mine: boolean;
  /** Its author asked you to review it. */
  asksYou: boolean;
  /** Its review guide is written and waiting to be read. */
  guideReady: boolean;
  checks?: Checks;
  review?: Verdict;
  branch: string;
  base: string;
  files: readonly FileChange[];
  commits: number;
  openedAt: number;
  updatedAt: number;
  /** The guide's one line, when it has one. */
  tldr?: string;
  /** A chat of yours on its branch. */
  chat?: string;
  /** The commit it is at now. */
  head: string;
  /** What its checks said, in words ("31 tests pass", "vitest fails"). */
  checksLine?: string;
  /** The agent that made it, for one of your chats: its harness and model, and the Chief that watches it. */
  agent?: { engine: Engine; model: string; chief: string | null };
  /** What its author wrote: the chat's closing words for a chat's, the description for anyone's. */
  body?: string;
  /** What the change does, a line each (a chat's moment's changes), for a guide written on the phone. */
  about?: readonly string[];
}

/** A pull request as the scripted host knows it, before its head is worked out. */
type Seed = Omit<Pr, "head">;

/** Its head, and its files from its written diff when there is one, so every count reads the same. */
function settle(seed: Seed): Pr {
  const diff = reviewedAt(seed.repo, seed.branch);
  const files = diff && !seed.chat ? diff.files.map((f) => ({ path: f.path, add: f.additions, del: f.deletions })) : seed.files;
  // A chat's pull request counts as having its guide only once a tour is written for it; its chat's own TL;DR isn't one.
  const guideReady = seed.chat ? !!diff : seed.guideReady;
  return { ...seed, files, guideReady, head: headOf(files) };
}

/** The numbers the scripted host gave the pull requests the board's chats open, by branch; the rest get one from their id. */
const NUMBERS: Record<string, number> = { "chief-push": 491, "dark-runs": 494, "usage-tooltips": 233, "hero-phone": 92 };

function numberFor(chat: Chat, branch: string): number {
  const known = NUMBERS[branch];
  if (known) return known;
  let h = 0;
  for (const ch of chat.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 500 + (h % 400);
}

/** The number of the pull request a ready chat has open, which its ship merges under; null when it has none. */
export const prNumberFor = (chat: Chat): number | null => (chat.moment ? numberFor(chat, chat.moment.branch) : null);

/** Whose login the board's own chats open pull requests as. */
export const ME = "jb";
const OWNER = "caveman-ai";

const minute = 60_000;

/** The teammates' and your own, besides what the board's chats opened. */
function others(now: number): Seed[] {
  return [
    {
      repo: `${OWNER}/Caveman Cloud`,
      number: 612,
      title: "Relay: back off on reconnect storms",
      state: "open",
      author: "tessa",
      mine: false,
      asksYou: true,
      guideReady: true,
      checks: "passing",
      branch: "relay-backoff",
      base: "main",
      files: [
        { path: "relay/reconnect.go", add: 48, del: 12 },
        { path: "relay/reconnect_test.go", add: 61, del: 0 },
        { path: "relay/metrics.go", add: 6, del: 1 },
      ],
      commits: 3,
      openedAt: now - 190 * minute,
      updatedAt: now - 25 * minute,
      tldr: "Reconnects wait longer each time a relay drops, up to 30 seconds, so one flapping relay stops pulling every computer down with it.",
      checksLine: "5 of 5 checks pass",
      body: "Every computer redials a dropped relay every 500 ms, all at once, which is what kept relay-3 down on Tuesday. This backs off with jitter up to 30 s and only resets once a connection has held for 10 s.\n\nThe flapping test reproduces Tuesday: a relay that accepts and drops in 50 ms.",
    },
    {
      repo: `${OWNER}/caveman-code`,
      number: 479,
      title: "Settings: archive after a quiet week",
      state: "open",
      author: "mkern",
      mine: false,
      asksYou: true,
      guideReady: false,
      checks: "pending",
      branch: "auto-archive",
      base: "main",
      files: [
        { path: "apps/web/src/routes/settings/Archive.tsx", add: 72, del: 4 },
        { path: "apps/web/src/state/archived.ts", add: 31, del: 9 },
      ],
      commits: 2,
      openedAt: now - 300 * minute,
      updatedAt: now - 70 * minute,
      checksLine: "3 of 5 checks running",
      body: "Chats nobody opened for a week move to the archive on their own. Settings > Chats has the switch, on by default.",
    },
    {
      repo: `${OWNER}/caveman-code`,
      number: 476,
      title: "Composer: paste images from the clipboard",
      state: "draft",
      author: ME,
      mine: true,
      asksYou: false,
      guideReady: false,
      checks: "failing",
      branch: "paste-images",
      base: "main",
      files: [
        { path: "apps/web/src/components/Composer.tsx", add: 84, del: 18 },
        { path: "apps/web/src/components/composer/paste.ts", add: 34, del: 4 },
      ],
      commits: 4,
      openedAt: now - 26 * 60 * minute,
      updatedAt: now - 140 * minute,
      checksLine: "vitest fails: 2 of 41",
      body: "Paste an image into the composer and it attaches, like a dropped file. Still a draft: two paste tests fail on the web build.",
    },
    {
      repo: `${OWNER}/marketing`,
      number: 88,
      title: "Pricing: the Cloud beta line",
      state: "open",
      author: "lena",
      mine: false,
      asksYou: false,
      guideReady: false,
      checks: "passing",
      review: "approved",
      branch: "cloud-beta-line",
      base: "main",
      files: [{ path: "src/pages/pricing.astro", add: 12, del: 7 }],
      commits: 1,
      openedAt: now - 8 * 60 * minute,
      updatedAt: now - 3 * 60 * minute,
      checksLine: "2 of 2 checks pass",
      body: "Cloud is in beta and free until launch, so the pricing page says so. The button joins the beta instead of starting a trial.",
    },
  ];
}

/** Where each of the board's chats lives on the host. */
const repoOf = (chat: Chat) => `${OWNER}/${chat.repo}`;

/** The pull requests the board's chats opened: one per ready chat (its moment's branch), one per merged chat. */
function fromChats(chats: readonly Chat[], now: number): Seed[] {
  const prs: Seed[] = [];
  chats.forEach((chat) => {
    if (chat.phase === "ready" && chat.moment) {
      const m = chat.moment;
      prs.push({
        repo: repoOf(chat),
        number: numberFor(chat, m.branch),
        title: chat.title,
        state: "open",
        author: ME,
        mine: true,
        asksYou: false,
        guideReady: true,
        checks: /fail/i.test(m.checks) ? "failing" : /pass|clean|green/i.test(m.checks) ? "passing" : "pending",
        branch: m.branch,
        base: "main",
        files: m.files,
        commits: 1,
        openedAt: chat.startedAt,
        updatedAt: now - minute / 2,
        tldr: m.changes[0],
        about: m.changes,
        chat: chat.id,
        checksLine: m.checks,
        agent: { engine: chat.engine, model: chat.model, chief: chat.chief ?? null },
        body: m.summary,
      });
    }
    const merged = chat.phase === "done" ? /Merged #(\d+)/.exec(chat.line) : null;
    if (merged) {
      prs.push({
        repo: repoOf(chat),
        number: Number(merged[1]),
        title: chat.title,
        state: "merged",
        author: ME,
        mine: true,
        asksYou: false,
        guideReady: false,
        checks: "passing",
        branch: chat.id,
        base: "main",
        files: [],
        commits: 1,
        openedAt: chat.startedAt,
        updatedAt: chat.startedAt + 40 * minute,
        chat: chat.id,
        agent: { engine: chat.engine, model: chat.model, chief: chat.chief ?? null },
      });
    }
  });
  return prs;
}

/** A review you sent (PrPage.tsx ReviewMenu): its verdict, its note, and when. */
export interface Sent {
  verdict: "approve" | "request_changes" | "comment";
  body: string;
  at: number;
}

/**
 * The reviews you sent, by pull request, oldest first: kept while the app runs, so leaving Review keeps them, and the
 * sidebar's count reads the same record the page does.
 */
export const reviews = keep<Readonly<Record<string, readonly Sent[]>>>(() => ({}));

export function sendReview(pr: Pick<Pr, "repo" | "number">, sent: Sent) {
  reviews.set((all) => ({ ...all, [prKey(pr)]: [...(all[prKey(pr)] ?? []), sent] }));
}

/**
 * What was done to a pull request from this phone that the host would now report: merged, or a draft marked ready.
 * A chat's own pull request merges through its chat (the board's ship), so only the rest land here.
 */
export const settled = keep<Readonly<Record<string, "merged" | "ready">>>(() => ({}));

export function settlePr(pr: Pick<Pr, "repo" | "number">, to: "merged" | "ready") {
  settled.set((all) => ({ ...all, [prKey(pr)]: to }));
}

/**
 * Every pull request the queue shows, with what you sent applied: any review answers the ask (as on GitHub, where a
 * review takes you off the requested reviewers), and the newest verdict that isn't a comment is the one it shows.
 */
export function queueOf(chats: readonly Chat[], sent: Readonly<Record<string, readonly Sent[]>>, now: number): Pr[] {
  const done = settled.get();
  return [...fromChats(chats, now), ...others(now)].map(settle).map((was) => {
    const to = done[prKey(was)];
    const pr: Pr = to === "merged" ? { ...was, state: "merged", updatedAt: Math.max(was.updatedAt, now - 1000) } : to === "ready" && was.state === "draft" ? { ...was, state: "open" } : was;
    const mine = sent[prKey(pr)];
    if (!mine?.length) return pr;
    const verdict = [...mine].reverse().find((r) => r.verdict !== "comment")?.verdict;
    return { ...pr, asksYou: false, review: verdict === "approve" ? "approved" : verdict === "request_changes" ? "changes_requested" : pr.review };
  });
}

/** How many wait on your review: the sidebar's amber count and the page's "2 wait on you". */
export const waitingOnYou = (prs: readonly Pr[]) => prs.filter((pr) => pr.state === "open" && pr.asksYou && !pr.mine).length;

export const prKey = (pr: Pick<Pr, "repo" | "number">) => `${pr.repo}#${pr.number}`;
export const repoName = (repo: string) => repo.split("/").pop() ?? repo;
export const sizeOf = (pr: Pr) => totals(pr.files);

export type GroupId = "needs_you" | "guides_ready" | "yours" | "drafts" | "others" | "closed";

const GROUP_LABEL: Record<GroupId, string> = {
  needs_you: "Needs your review",
  guides_ready: "Guides ready",
  yours: "Yours",
  drafts: "Drafts",
  others: "Everything else open",
  closed: "Merged and closed",
};

/** One group per pull request, first match wins (model.ts groupQueue); empty groups drop. */
export function groupQueue(prs: readonly Pr[]): { id: GroupId; label: string; prs: Pr[] }[] {
  const by: Record<GroupId, Pr[]> = { needs_you: [], guides_ready: [], yours: [], drafts: [], others: [], closed: [] };
  for (const pr of prs) {
    const id: GroupId = pr.state === "merged" || pr.state === "closed" ? "closed" : pr.state === "draft" ? "drafts" : pr.asksYou && !pr.mine ? "needs_you" : pr.guideReady ? "guides_ready" : pr.mine ? "yours" : "others";
    by[id].push(pr);
  }
  return (Object.keys(by) as GroupId[]).filter((id) => by[id].length > 0).map((id) => ({ id, label: GROUP_LABEL[id], prs: by[id] }));
}

/** One section per repository, in the order they first appear, with what waits in each. */
export function groupByRepo(prs: readonly Pr[]): { repo: string; prs: Pr[]; needsYou: number; failing: number }[] {
  const order: string[] = [];
  const by = new Map<string, Pr[]>();
  for (const pr of prs) {
    if (!by.has(pr.repo)) {
      order.push(pr.repo);
      by.set(pr.repo, []);
    }
    by.get(pr.repo)!.push(pr);
  }
  return order.map((repo) => {
    const list = by.get(repo)!;
    return { repo, prs: list, needsYou: list.filter((p) => p.asksYou && !p.mine && p.state === "open").length, failing: list.filter((p) => p.checks === "failing" && (p.state === "open" || p.state === "draft")).length };
  });
}

export type Sort = "updated" | "created" | "title" | "size";
export const SORTS: Record<Sort, string> = { updated: "Last updated", created: "Newest", title: "Title", size: "Biggest change" };

export function sortPrs(prs: readonly Pr[], sort: Sort): Pr[] {
  const size = (p: Pr) => sizeOf(p).add + sizeOf(p).del;
  const by: Record<Sort, (a: Pr, b: Pr) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.openedAt - a.openedAt,
    title: (a, b) => a.title.localeCompare(b.title),
    size: (a, b) => size(b) - size(a),
  };
  return [...prs].sort(by[sort]);
}

/** Title, branch, author, repository and number: what the search box reads. */
export const matches = (pr: Pr, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || `${pr.title} ${pr.branch} ${pr.author} ${pr.repo} #${pr.number}`.toLowerCase().includes(q);
};
