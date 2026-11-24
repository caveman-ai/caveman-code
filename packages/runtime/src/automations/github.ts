// GitHub triggers on This Mac, by polling: nothing can push to a Mac (the runtime binds 127.0.0.1 and no
// relay exists yet). One poll per repository per minute serves every automation that listens there, and it
// asks only for what those automations need. Every request is conditional (If-None-Match), so a quiet
// repository costs no rate limit. The first poll of an endpoint only takes its bearings: history never fires.
//
// Two halves, both testable on recorded payloads: `pollRepo` turns API answers into normalized events
// (never raw API JSON), and `route` decides what one automation does with one event: nothing (its filters
// don't match), refuse (an outsider, a fork), or fire with the payload a step may see (SEMANTICS §13 rules 2, 3).
import * as path from "node:path";

import { eventsOf, listOf, type GitHubEvent, type GitHubTrigger } from "@caveman-app/automations";

/** One conditional request. `etag` is sent as If-None-Match; a 304 answers `status: 304` and no body. */
export type GitHubApi = (path: string, etag?: string) => Promise<{ readonly status: number; readonly etag?: string | undefined; readonly body?: unknown; readonly resetAt?: number | undefined }>;

/** What the automations on one repository listen for, so the poll asks for nothing else. */
export interface Want {
  readonly issuesOpened: boolean;
  readonly issuesLabeled: boolean;
  readonly pulls: boolean;
  /** Some pull request automation filters on paths: each new or updated pull request's files are read. */
  readonly pullPaths: boolean;
  readonly comments: boolean;
  /** Branches whose pushes fire something: names, or globs (`release/*`). */
  readonly pushBranches: ReadonlyArray<string>;
  readonly runs: boolean;
}

/** Where the poll left off, per repository; kept in the runtime's state, never in the files. */
export interface RepoCursor {
  readonly etags?: Readonly<Record<string, string>>;
  readonly lastIssue?: number;
  readonly lastIssueEvent?: number;
  readonly lastComment?: number;
  readonly lastPull?: number;
  /** The newest open pull request update read (epoch ms): the list sorted by update is read back to it. */
  readonly lastPullUpdate?: number;
  readonly pullHeads?: Readonly<Record<string, string>>;
  readonly branchHeads?: Readonly<Record<string, string>>;
  /** Completed runs already seen (ids rise with creation, not completion, so a set, kept short). */
  readonly runsSeen?: ReadonlyArray<number>;
  /** GitHub asked us to slow down until then (epoch ms). */
  readonly backoffUntil?: number;
}

/** The text of a trigger, normalized: what a step may see in its data blocks. */
export interface GitHubPayload {
  readonly repo: string;
  /** What happened; absent on a manual run's subject, where nothing happened on GitHub. */
  readonly event?: GitHubEvent;
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly author?: string;
  readonly association?: string;
  readonly labels?: ReadonlyArray<string>;
  /** issues.labeled: the label that was added. */
  readonly label?: string;
  /** issues.labeled: who added it, which is who fires the run (D10b); `author` stays the issue's writer. */
  readonly labeled_by?: { readonly login: string; readonly association: string };
  readonly head?: { readonly ref: string; readonly sha: string };
  readonly base?: { readonly ref: string; readonly sha?: string };
  readonly changed_paths?: ReadonlyArray<string>;
  /** pull_request.synchronize: the head before the push. */
  readonly before?: string;
  readonly comment?: { readonly id: number; readonly body: string; readonly author: string; readonly association: string; readonly url: string };
  readonly push?: { readonly branch: string; readonly before: string; readonly after: string; readonly commits: ReadonlyArray<{ readonly sha: string; readonly message: string; readonly author: string }> };
  readonly workflow_run?: { readonly id: number; readonly name: string; readonly conclusion: string; readonly branch: string; readonly sha: string; readonly url: string; readonly event: string };
  /** Text left out because someone outside the repository wrote it (rule 3), in words. */
  readonly withheld?: ReadonlyArray<string>;
}

/** One event, with what the filters and the trust rules need beside the payload. */
export interface GitHubDelivery {
  readonly event: GitHubEvent;
  /** Stable across polls: the run id derives from it, so seeing an event twice starts one run. */
  readonly delivery: string;
  readonly subject: string;
  /** The subject's title for the run view: the issue or pull request's, a run's, a push's last commit subject. */
  readonly title?: string;
  readonly receivedAt: string;
  readonly payload: GitHubPayload;
  /** Who fires it: the issue, pull request or comment author, or who added the label; empty for pushes and runs, which need write access. */
  readonly actor?: { readonly login: string; readonly association: string };
  /** A pull request from a fork, or a run of one. */
  readonly fork?: boolean;
  /** The branch the filters test: a pull request's base, a push's branch, a run's head branch. */
  readonly branch?: string;
  /** Text by a second author (a comment's issue): its association, so `route` can withhold it. */
  readonly context?: { readonly author: string; readonly association: string; readonly title: string; readonly body: string };
  /** A run started by an event anyone can cause (an issue comment, a fork's pull_request_target). */
  readonly openRun?: string;
}

const MENTION = /(^|[^\w@])@caveman\b/i;
/** A body longer than this is cut: a step reads the rest itself if it needs it. */
const MAX_TEXT = 16_000;
const cut = (text: string | null | undefined) => {
  const t = text ?? "";
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters]` : t;
};
/** Runs from these events need write access to the repository; anything else can be caused from outside. */
const CLOSED_RUN_EVENTS = new Set(["push", "pull_request", "schedule", "workflow_dispatch", "merge_group", "release"]);
const MAX_SEEN_RUNS = 200;
/** Pages of a list one poll reads back toward its cursor; past them the oldest are skipped, and the poll says so. */
const MAX_PAGES = 10;
/** Repository roles that can add a label (triage and up). */
const LABELLER_ROLES = new Set(["admin", "maintain", "write", "triage"]);
/** How long a labeller's access, once looked up, is believed. */
const ACCESS_TTL_MS = 60 * 60_000;
/** A labeller whose access could not be looked up: never trusted, never cached. */
export const UNKNOWN_ACCESS = "UNKNOWN";

type Json = Record<string, any>;

const numberOf = (item: Json) => Number(item.number);
const idOf = (item: Json) => Number(item.id);
const updatedOf = (item: Json) => Date.parse(String(item.updated_at ?? ""));
/** Items at or below `last` (by `key`) were read by an earlier poll; undefined when there was none. */
const upTo = (last: number | undefined, key: (item: Json) => number) => (last === undefined ? undefined : (item: Json) => key(item) <= last);

/** Every file a pull request changes, page by page (GitHub lists at most 3000); undefined when a page could not be read. */
async function pullFiles(repo: string, number: number, page: (url: string) => Promise<unknown>): Promise<string[] | undefined> {
  const names: string[] = [];
  for (let n = 1; n <= 30; n++) {
    const files = await page(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${n}`);
    if (!Array.isArray(files)) return undefined;
    names.push(...files.map((f: Json) => String(f.filename)));
    if (files.length < 100) break;
  }
  return names;
}

/** A list the poll reads, by the want it serves. */
export type ListWant = Exclude<keyof Want, "pushBranches" | "pullPaths">;

export interface PollResult {
  readonly cursor: RepoCursor;
  readonly deliveries: ReadonlyArray<GitHubDelivery>;
  /** Why this poll fell short, one sentence each, saying what to do; the next poll that reads cleanly mends it. */
  readonly problems: ReadonlyArray<string>;
  /** What a gap longer than one poll reads back skipped for good, by the list it was on; one sentence each, saying what to do. */
  readonly skipped: ReadonlyArray<{ readonly want: ListWant; readonly message: string }>;
}

/** What one automation's trigger needs from the poll. */
export function wantOf(trigger: GitHubTrigger, defaultBranch: string): Want {
  const events = eventsOf(trigger);
  const has = (e: GitHubEvent) => events.includes(e);
  return {
    issuesOpened: has("issues.opened"),
    issuesLabeled: has("issues.labeled"),
    pulls: has("pull_request.opened") || has("pull_request.synchronize"),
    pullPaths: (has("pull_request.opened") || has("pull_request.synchronize")) && listOf(trigger.paths).length > 0,
    comments: has("issue_comment.created"),
    pushBranches: has("push") ? (listOf(trigger.branches).length > 0 ? listOf(trigger.branches) : [defaultBranch]) : [],
    runs: has("workflow_run.completed"),
  };
}

export const mergeWants = (wants: ReadonlyArray<Want>): Want => ({
  issuesOpened: wants.some((w) => w.issuesOpened),
  issuesLabeled: wants.some((w) => w.issuesLabeled),
  pulls: wants.some((w) => w.pulls),
  pullPaths: wants.some((w) => w.pullPaths),
  comments: wants.some((w) => w.comments),
  pushBranches: [...new Set(wants.flatMap((w) => w.pushBranches))],
  runs: wants.some((w) => w.runs),
});

/** Whether a branch is one of a trigger's `branches`: named, or matched by a glob (`release/*`). */
const onBranch = (branches: ReadonlyArray<string>, branch: string) => branches.some((b) => branch === b || path.posix.matchesGlob(branch, b));

const labelsOf = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels.map((l: Json | string) => (typeof l === "string" ? l : String(l?.name ?? ""))).filter(Boolean) : []);
const login = (user: Json | null | undefined) => String(user?.login ?? "ghost");

/** One poll of one repository: the deliveries since the cursor, and the cursor to keep. */
export async function pollRepo(input: {
  readonly api: GitHubApi;
  readonly repo: string;
  readonly want: Want;
  readonly cursor: RepoCursor;
  readonly now: number;
  /** Labellers' access already looked up (`<repo>:<login>`), kept by the caller across polls. */
  readonly access?: Map<string, { readonly association: string; readonly at: number }>;
}): Promise<PollResult> {
  const { api, repo, want, now } = input;
  if (input.cursor.backoffUntil !== undefined && input.cursor.backoffUntil > now) return { cursor: input.cursor, deliveries: [], problems: [], skipped: [] };
  const etags: Record<string, string> = { ...input.cursor.etags };
  let cursor: { -readonly [K in keyof RepoCursor]: RepoCursor[K] } = { ...input.cursor, etags };
  delete cursor.backoffUntil;
  const deliveries: GitHubDelivery[] = [];
  const problems: string[] = [];
  const skipped: Array<PollResult["skipped"][number]> = [];
  const at = new Date(now).toISOString();
  let stopped = false;
  const asked = new Set<string>();

  /**
   * A conditional GET: the body when it changed, `unchanged` (304), `absent` or `failed`. `one` is a single thing
   * (a branch, an issue, a comparison) whose 404 means it is not there, not that the repository is out of reach.
   */
  const ask = async (url: string, conditional = true, one = false): Promise<{ readonly body: unknown } | "unchanged" | "absent" | "failed"> => {
    if (stopped) return "failed";
    asked.add(url);
    let answer: Awaited<ReturnType<GitHubApi>>;
    try {
      answer = await api(url, conditional ? etags[url] : undefined);
    } catch (error) {
      problems.push(`Could not reach GitHub for ${repo} (${(error as Error).message}); Caveman tries again in a minute.`);
      stopped = true;
      return "failed";
    }
    if (answer.status === 304) return "unchanged";
    if (answer.status === 403 || answer.status === 429) {
      cursor.backoffUntil = answer.resetAt ?? now + 15 * 60_000;
      problems.push(`GitHub's rate limit for ${repo} is used up; Caveman waits until ${new Date(cursor.backoffUntil).toISOString()} and polls again.`);
      stopped = true;
      return "failed";
    }
    if (answer.status === 404 && one) return "absent";
    if (answer.status === 404 || answer.status === 401) {
      problems.push(`GitHub answered ${answer.status} for ${repo}; check that the GitHub account in Settings can see this repository.`);
      stopped = true;
      return "failed";
    }
    if (answer.status < 200 || answer.status >= 300) {
      problems.push(`GitHub answered ${answer.status} for ${repo}; Caveman tries again in a minute.`);
      return "failed";
    }
    if (conditional && answer.etag) etags[url] = answer.etag;
    return { body: answer.body };
  };
  /** The body when it changed; undefined when it did not, is not there, or failed. */
  const get = async (url: string, conditional = true, one = false): Promise<unknown> => {
    const answer = await ask(url, conditional, one);
    return typeof answer === "object" ? answer.body : undefined;
  };
  /**
   * The association a labeller acts with (D10b). The issue-events API names who added a label but not their
   * association, so it comes from their repository role, once per login an hour: triage and up label as a
   * collaborator, the repository's owner as the owner, anyone else as none. A lookup that fails is UNKNOWN and fires nothing.
   */
  const accessOf = async (who: string): Promise<string> => {
    if (who.toLowerCase() === repo.split("/")[0]!.toLowerCase()) return "OWNER";
    const key = `${repo}:${who.toLowerCase()}`;
    const known = input.access?.get(key);
    if (known !== undefined && now - known.at < ACCESS_TTL_MS) return known.association;
    let association: string;
    try {
      const answer = await api(`/repos/${repo}/collaborators/${encodeURIComponent(who)}/permission`);
      const body = answer.body as Json | undefined;
      if (answer.status === 404) association = "NONE";
      else if (answer.status !== 200 || body === undefined) return UNKNOWN_ACCESS;
      // ponytail: write-or-better access reads as collaborator, so `actors: [member]` refuses an org member's label; look up org membership if that bites.
      else association = LABELLER_ROLES.has(String(body.role_name)) || ["admin", "write"].includes(String(body.permission)) ? "COLLABORATOR" : "NONE";
    } catch {
      return UNKNOWN_ACCESS;
    }
    input.access?.set(key, { association, at: now });
    return association;
  };
  /** Every file a pull request changes: an exclusion must not skip a large one on its first page. */
  const filesOf = (number: number) => pullFiles(repo, number, (url) => get(url, false, true));
  /**
   * A list GitHub serves newest first, read page by page back to the page that holds an item an earlier poll read
   * (`read`), so a gap between polls longer than a page (the Mac asleep, a backoff) loses nothing. Undefined when its
   * first page did not change, or when any page could not be read: the cursor then stays, and the list is read again next poll.
   */
  const newest = async (
    url: string,
    perPage: number,
    key: (item: Json) => number,
    read: ((item: Json) => boolean) | undefined,
    what: string,
    list: ListWant,
    itemsOf: (body: unknown) => unknown = (body) => body,
  ): Promise<Json[] | undefined> => {
    const items = itemsOf(await get(url));
    if (!Array.isArray(items)) return undefined;
    for (let page = 2, last: Json[] = items; read !== undefined && last.length === perPage && !last.some(read); page++) {
      if (page > MAX_PAGES) {
        skipped.push({
          want: list,
          message: `More than ${MAX_PAGES * perPage} ${what} arrived on ${repo} since the last poll; Caveman read the newest and skipped the rest, so run any automation they should have started by hand.`,
        });
        break;
      }
      const more = itemsOf(await get(`${url}&page=${page}`, false));
      if (!Array.isArray(more)) {
        delete etags[url];
        return undefined;
      }
      items.push(...more);
      last = more;
    }
    // Something new shifts the pages while they are read, so a page can repeat the end of the one before.
    return [...new Map(items.map((item) => [key(item), item])).values()];
  };

  if (want.issuesOpened) {
    const items = await newest(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=30`, 30, numberOf, upTo(cursor.lastIssue, numberOf), "issues and pull requests", "issuesOpened");
    if (items !== undefined) {
      const top = Math.max(0, ...items.map((i) => Number(i.number)));
      if (cursor.lastIssue !== undefined) {
        for (const issue of items.filter((i) => Number(i.number) > cursor.lastIssue! && i.pull_request === undefined).sort((a, b) => a.number - b.number)) {
          deliveries.push(issueDelivery(repo, "issues.opened", issue, `gh:${repo}:issues.opened:${issue.number}`, at));
        }
      }
      cursor.lastIssue = Math.max(cursor.lastIssue ?? 0, top);
    }
  }

  if (want.issuesLabeled) {
    const events = await newest(`/repos/${repo}/issues/events?per_page=50`, 50, idOf, upTo(cursor.lastIssueEvent, idOf), "issue events", "issuesLabeled");
    if (events !== undefined) {
      const top = Math.max(0, ...events.map((e) => Number(e.id)));
      if (cursor.lastIssueEvent !== undefined) {
        const fresh = events.filter((e) => Number(e.id) > cursor.lastIssueEvent! && e.event === "labeled" && e.issue && e.issue.pull_request === undefined);
        for (const event of fresh.sort((a, b) => a.id - b.id)) {
          const base = issueDelivery(repo, "issues.labeled", event.issue, `gh:${repo}:issues.labeled:${event.id}`, at);
          // D10b: whoever added the label fires the run; the issue's text stays data, whoever wrote it.
          const labeller = login(event.actor);
          const association = labeller.toLowerCase() === base.payload.author?.toLowerCase() ? (base.payload.association ?? "NONE") : await accessOf(labeller);
          deliveries.push({
            ...base,
            actor: { login: labeller, association },
            payload: { ...base.payload, label: String(event.label?.name ?? ""), labeled_by: { login: labeller, association } },
          });
        }
      }
      cursor.lastIssueEvent = Math.max(cursor.lastIssueEvent ?? 0, top);
    }
  }

  if (want.pulls) {
    const url = `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`;
    // Anything opened or pushed to since the last poll was updated after the newest update it read; an older update is
    // one it judged. Ties in the same second are read again.
    const lastUpdate = cursor.lastPullUpdate;
    const pulls = await newest(url, 30, numberOf, lastUpdate === undefined ? undefined : (p) => updatedOf(p) < lastUpdate, "pull request updates", "pulls");
    if (pulls !== undefined) {
      const heads: Record<string, string> = { ...cursor.pullHeads };
      const top = Math.max(0, ...pulls.map(numberOf));
      const known = cursor.lastPull !== undefined;
      // The lowest new pull request whose files could not be read: lastPull stays below it, so a later poll opens it.
      let unread: number | undefined;
      // The oldest update of a pull request left unjudged: the next poll reads back to it.
      let waiting: number | undefined;
      for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
        const number = Number(pr.number);
        const sha = String(pr.head?.sha ?? "");
        const before = heads[number];
        // A head already kept above lastPull is one that opened while a lower one waited for its files.
        const event: GitHubEvent | undefined = !known ? undefined : before === undefined ? (number > cursor.lastPull! ? "pull_request.opened" : undefined) : before !== sha ? "pull_request.synchronize" : undefined;
        const paths = event !== undefined && want.pullPaths ? await filesOf(number) : undefined;
        if (event !== undefined && want.pullPaths && paths === undefined) {
          // Judged without its files, a paths filter would let it go by for good: its head stays, and the list is read again next poll.
          if (event === "pull_request.opened") unread ??= number;
          waiting = Math.min(waiting ?? Infinity, updatedOf(pr));
          delete etags[url];
          continue;
        }
        heads[number] = sha;
        if (event === undefined) continue;
        const delivery = pullDelivery(repo, event, pr, event === "pull_request.opened" ? `gh:${repo}:pull_request.opened:${number}` : `gh:${repo}:pull_request.synchronize:${number}:${sha}`, at, paths);
        // The head before this push, as GitHub's synchronize event carries it.
        deliveries.push(event === "pull_request.synchronize" && before !== undefined ? { ...delivery, payload: { ...delivery.payload, before } } : delivery);
      }
      // The newest few hundred pull requests' heads: an old one that wakes up again is seen from then on.
      cursor.pullHeads = Object.fromEntries(Object.entries(heads).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 300));
      cursor.lastPull = Math.max(cursor.lastPull ?? 0, unread === undefined ? top : unread - 1);
      const lastPullUpdate = waiting ?? Math.max(lastUpdate ?? -Infinity, ...pulls.map(updatedOf).filter(Number.isFinite));
      if (Number.isFinite(lastPullUpdate)) cursor.lastPullUpdate = lastPullUpdate;
      else delete cursor.lastPullUpdate;
    }
  }

  if (want.comments) {
    const comments = await newest(`/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=50`, 50, idOf, upTo(cursor.lastComment, idOf), "comments", "comments");
    if (comments !== undefined) {
      const top = Math.max(0, ...comments.map((c) => Number(c.id)));
      if (cursor.lastComment !== undefined) {
        for (const comment of comments.filter((c) => Number(c.id) > cursor.lastComment!).sort((a, b) => a.id - b.id)) {
          const number = Number(String(comment.issue_url ?? "").split("/").pop());
          const issue = ((await get(`/repos/${repo}/issues/${number}`, false, true)) as Json | undefined) ?? {};
          // A11: a comment on a pull request runs on that pull request's code, so a fork's is refused like the pull request
          // itself; one whose head cannot be read counts as a fork.
          const onPull = issue.pull_request !== undefined || /\/pull\/\d+/.test(String(comment.html_url ?? ""));
          const head = onPull ? ((await get(`/repos/${repo}/pulls/${number}`, false, true)) as Json | undefined) : undefined;
          deliveries.push({
            event: "issue_comment.created",
            delivery: `gh:${repo}:issue_comment.created:${comment.id}`,
            subject: `github:${repo}#${number}/comment/${comment.id}`,
            ...(issue.title ? { title: String(issue.title) } : {}),
            receivedAt: at,
            ...(onPull ? { fork: String(head?.head?.repo?.full_name ?? "") !== repo } : {}),
            actor: { login: login(comment.user), association: String(comment.author_association ?? "NONE") },
            context: { author: login(issue.user), association: String(issue.author_association ?? "NONE"), title: String(issue.title ?? ""), body: cut(issue.body) },
            payload: {
              repo,
              event: "issue_comment.created",
              number,
              url: String(comment.html_url ?? ""),
              labels: labelsOf(issue),
              comment: { id: Number(comment.id), body: cut(comment.body), author: login(comment.user), association: String(comment.author_association ?? "NONE"), url: String(comment.html_url ?? "") },
            },
          });
        }
      }
      cursor.lastComment = Math.max(cursor.lastComment ?? 0, top);
    }
  }

  // Each pushed branch's head, and the request that read it: a named branch on its own, a glob (`release/*`) from the
  // branches under its literal part, matched as `route` matches them (git refuses `*` in a name, so asking for one is a 404).
  const pushed = new Map<string, { readonly sha: string; readonly url: string }>();
  for (const entry of want.pushBranches) {
    const glob = /[*?[{(]/.exec(entry);
    if (glob === null) {
      const url = `/repos/${repo}/branches/${encodeURIComponent(entry)}`;
      const info = (await get(url, true, true)) as Json | undefined;
      if (info?.commit?.sha !== undefined && !pushed.has(entry)) pushed.set(entry, { sha: String(info.commit.sha), url });
      continue;
    }
    const prefix = entry.slice(0, entry.lastIndexOf("/", glob.index) + 1);
    const url = `/repos/${repo}/git/matching-refs/heads/${prefix.split("/").map(encodeURIComponent).join("/")}`;
    const refs = (await get(url, true, true)) as Json[] | undefined;
    for (const ref of Array.isArray(refs) ? refs : []) {
      const branch = String(ref.ref ?? "").replace(/^refs\/heads\//, "");
      if (ref.object?.sha !== undefined && onBranch([entry], branch) && !pushed.has(branch)) pushed.set(branch, { sha: String(ref.object.sha), url });
    }
  }
  for (const [branch, { sha, url }] of pushed) {
    const before = cursor.branchHeads?.[branch];
    if (before === sha) continue;
    if (before === undefined) {
      cursor.branchHeads = { ...cursor.branchHeads, [branch]: sha };
      continue;
    }
    const answer = await ask(`/repos/${repo}/compare/${before}...${sha}`, false, true);
    if (answer === "failed") {
      // Without its changed paths a paths filter would let the push go by for good: the head stays, and the branch is read again next poll.
      delete etags[url];
      continue;
    }
    // A comparison GitHub cannot make (history rewritten past `before`) never will be: the push goes by with what is known.
    cursor.branchHeads = { ...cursor.branchHeads, [branch]: sha };
    const compare = ((typeof answer === "object" ? answer.body : undefined) as Json | undefined) ?? {};
    const commits = Array.isArray(compare.commits) ? compare.commits : [];
    const last = commits.at(-1);
    deliveries.push({
      event: "push",
      delivery: `gh:${repo}:push:${branch}:${sha}`,
      subject: `github:${repo}@${sha}`,
      ...(last?.commit?.message ? { title: String(last.commit.message).split("\n")[0] } : {}),
      receivedAt: at,
      branch,
      payload: {
        repo,
        event: "push",
        url: String(compare.html_url ?? `https://github.com/${repo}/compare/${before}...${sha}`),
        changed_paths: Array.isArray(compare.files) ? compare.files.map((f: Json) => String(f.filename)) : [],
        push: {
          branch,
          before,
          after: sha,
          commits: commits.slice(-50).map((c: Json) => ({ sha: String(c.sha), message: cut(c.commit?.message), author: login(c.author ?? { login: c.commit?.author?.name }) })),
        },
      },
    });
  }

  if (want.runs) {
    // Run ids rise with creation: read back to the newest run an earlier poll saw complete.
    const runs = await newest(
      `/repos/${repo}/actions/runs?status=completed&per_page=30`,
      30,
      idOf,
      cursor.runsSeen === undefined ? undefined : upTo(Math.max(0, ...cursor.runsSeen), idOf),
      "completed CI runs",
      "runs",
      (body) => (body as Json | undefined)?.workflow_runs,
    );
    if (runs !== undefined) {
      const seen = new Set(cursor.runsSeen ?? []);
      if (cursor.runsSeen !== undefined) {
        for (const run of runs.filter((r) => !seen.has(Number(r.id))).sort((a, b) => a.id - b.id)) {
          const fork = String(run.head_repository?.full_name ?? "") !== repo;
          // B20: one subject per workflow and branch, so another failure replaces the run (and its branch and pull request).
          const workflow = run.path ? path.posix.basename(String(run.path).replace(/@.*$/, "")) : String(run.workflow_id ?? run.name ?? "workflow");
          deliveries.push({
            event: "workflow_run.completed",
            delivery: `gh:${repo}:workflow_run.completed:${run.id}`,
            subject: `github:${repo}/actions/${workflow}@${String(run.head_branch ?? "")}`,
            ...(run.display_title ? { title: String(run.display_title) } : {}),
            receivedAt: at,
            branch: String(run.head_branch ?? ""),
            fork,
            ...(CLOSED_RUN_EVENTS.has(String(run.event)) ? {} : { openRun: String(run.event) }),
            payload: {
              repo,
              event: "workflow_run.completed",
              url: String(run.html_url ?? ""),
              title: String(run.display_title ?? ""),
              workflow_run: { id: Number(run.id), name: String(run.name ?? ""), conclusion: String(run.conclusion ?? ""), branch: String(run.head_branch ?? ""), sha: String(run.head_sha ?? ""), url: String(run.html_url ?? ""), event: String(run.event ?? "") },
            },
          });
        }
      }
      cursor.runsSeen = [...new Set([...runs.map((r) => Number(r.id)), ...(cursor.runsSeen ?? [])])].slice(0, MAX_SEEN_RUNS);
    }
  }

  // A cursor means something only while it is polled: one for an endpoint nobody asked for this time is dropped (its etag too),
  // so whoever listens there next takes fresh bearings and history never fires (A12).
  if (!want.issuesOpened) delete cursor.lastIssue;
  if (!want.issuesLabeled) delete cursor.lastIssueEvent;
  if (!want.pulls) {
    delete cursor.lastPull;
    delete cursor.lastPullUpdate;
    delete cursor.pullHeads;
  }
  if (!want.comments) delete cursor.lastComment;
  if (!want.runs) delete cursor.runsSeen;
  if (cursor.branchHeads !== undefined) cursor.branchHeads = Object.fromEntries(Object.entries(cursor.branchHeads).filter(([b]) => onBranch(want.pushBranches, b)));
  if (!stopped) cursor.etags = Object.fromEntries(Object.entries(etags).filter(([url]) => asked.has(url)));
  return { cursor, deliveries, problems, skipped };
}

/** A manual run's subject (F-6): the issue or pull request, fetched and normalized exactly like a trigger's payload. */
export async function subjectPayload(
  api: GitHubApi,
  repo: string,
  number: number,
): Promise<{ readonly kind: "issue" | "pull_request"; readonly payload: GitHubPayload; readonly title: string; readonly url: string } | { readonly problem: string }> {
  const read = async (url: string) => {
    const answer = await api(url);
    if (answer.status === 404) throw new Error(`${repo}#${number} does not exist, or the GitHub account in Settings cannot see it.`);
    if (answer.status !== 200 || answer.body === undefined) throw new Error(`GitHub answered ${answer.status} for ${repo}#${number}; try again in a minute.`);
    return answer.body as Json;
  };
  try {
    const issue = await read(`/repos/${repo}/issues/${number}`);
    const pull = issue.pull_request === undefined ? undefined : await read(`/repos/${repo}/pulls/${number}`);
    const files = pull === undefined ? undefined : await pullFiles(repo, number, read);
    const { event: _event, ...payload } = pull === undefined ? issueDelivery(repo, "issues.opened", issue, "", "").payload : pullDelivery(repo, "pull_request.opened", pull, "", "", files).payload;
    return { kind: pull === undefined ? "issue" : "pull_request", payload, title: payload.title ?? "", url: payload.url ?? "" };
  } catch (error) {
    return { problem: (error as Error).message.startsWith(`${repo}#`) || (error as Error).message.startsWith("GitHub answered") ? (error as Error).message : `Could not reach GitHub for ${repo}#${number} (${(error as Error).message}); try again.` };
  }
}

function issueDelivery(repo: string, event: GitHubEvent, issue: Json, delivery: string, at: string): GitHubDelivery {
  return {
    event,
    delivery,
    subject: `github:${repo}#${issue.number}`,
    title: String(issue.title ?? ""),
    receivedAt: at,
    actor: { login: login(issue.user), association: String(issue.author_association ?? "NONE") },
    payload: {
      repo,
      event,
      number: Number(issue.number),
      title: String(issue.title ?? ""),
      body: cut(issue.body),
      url: String(issue.html_url ?? ""),
      author: login(issue.user),
      association: String(issue.author_association ?? "NONE"),
      labels: labelsOf(issue),
    },
  };
}

function pullDelivery(repo: string, event: GitHubEvent, pr: Json, delivery: string, at: string, paths: ReadonlyArray<string> | undefined): GitHubDelivery {
  const headRepo = pr.head?.repo?.full_name;
  return {
    event,
    delivery,
    subject: `github:${repo}#${pr.number}`,
    title: String(pr.title ?? ""),
    receivedAt: at,
    actor: { login: login(pr.user), association: String(pr.author_association ?? "NONE") },
    fork: headRepo !== repo,
    branch: String(pr.base?.ref ?? ""),
    payload: {
      repo,
      event,
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      body: cut(pr.body),
      url: String(pr.html_url ?? ""),
      author: login(pr.user),
      association: String(pr.author_association ?? "NONE"),
      labels: labelsOf(pr),
      head: { ref: String(pr.head?.ref ?? ""), sha: String(pr.head?.sha ?? "") },
      base: { ref: String(pr.base?.ref ?? ""), sha: String(pr.base?.sha ?? "") },
      ...(paths === undefined ? {} : { changed_paths: paths }),
    },
  };
}

// ------------------------------------------------------------------ routing

const ASSOCIATION: Readonly<Record<string, string>> = { OWNER: "owner", MEMBER: "member", COLLABORATOR: "collaborator" };
const DEFAULT_ACTORS = ["owner", "member", "collaborator"] as const;

/** Who may fire an automation: its actors, by GitHub author association (default owner, member, collaborator). */
const actorsOf = (trigger: GitHubTrigger): ReadonlyArray<string> | "any" => trigger.actors === "any" ? "any" : (trigger.actors ?? DEFAULT_ACTORS);
/** Whose text counts as trusted (rule 3): the actors, never wider than owner, member and collaborator. */
const trustedAssociation = (association: string, actors: ReadonlyArray<string> | "any") => {
  const as = ASSOCIATION[association];
  return as !== undefined && (actors === "any" ? true : actors.includes(as));
};
const describe = (d: GitHubDelivery) =>
  d.event === "push" ? `the push to ${d.branch}` : d.event === "workflow_run.completed" ? `CI run ${d.payload.workflow_run?.id}` : `${d.payload.repo}#${d.payload.number}`;
const accessWords = (association: string) => (association === UNKNOWN_ACCESS ? "access Caveman could not check" : association.toLowerCase().replace(/_/g, " "));

/** Who fired a delivery, for its record: `maya (member)`, and for a label, who wrote the issue too (B2). */
export function byOf(d: GitHubDelivery): string | undefined {
  if (d.actor === undefined) return undefined;
  const actor = `${d.actor.login} (${accessWords(d.actor.association)})`;
  const author = d.payload.author;
  if (d.event !== "issues.labeled" || author === undefined || author === d.actor.login) return actor;
  return `labelled by ${actor}; the issue is by ${author} (${accessWords(d.payload.association ?? "NONE")})`;
}

export type Route =
  /** Not for this automation: an event it does not listen to, or a filter that does not match. No delivery is recorded. */
  | { readonly kind: "skip" }
  | { readonly kind: "refuse"; readonly reason: "policy_denied"; readonly message: string }
  | { readonly kind: "fire"; readonly payload: GitHubPayload; readonly trusted: boolean };

/**
 * Whether a changed file passes a paths filter: it matches an include glob (or there are only exclusions) and no
 * `!` exclusion. `!docs/**` and `!*.md` fire on every change but a docs-only one, before any model runs.
 */
export function pathMatches(globs: ReadonlyArray<string>, file: string): boolean {
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return (include.length === 0 || include.some((g) => path.posix.matchesGlob(file, g))) && !exclude.some((g) => path.posix.matchesGlob(file, g));
}

/** What one automation does with one event (SEMANTICS §13 rules 2 and 3; filters per the package README). */
export function route(trigger: GitHubTrigger, d: GitHubDelivery, defaultBranch: string): Route {
  if (!eventsOf(trigger).includes(d.event)) return { kind: "skip" };
  const labels = listOf(trigger.label);
  if (labels.length > 0) {
    const has = d.event === "issues.labeled" ? [d.payload.label ?? ""] : (d.payload.labels ?? []);
    if (!labels.some((l) => has.includes(l))) return { kind: "skip" };
  }
  const branches = listOf(trigger.branches);
  if (d.event === "push" || d.event === "workflow_run.completed") {
    if (!onBranch(branches.length > 0 ? branches : [defaultBranch], d.branch ?? "")) return { kind: "skip" };
  } else if (branches.length > 0 && (d.event === "pull_request.opened" || d.event === "pull_request.synchronize")) {
    if (!onBranch(branches, d.branch ?? "")) return { kind: "skip" };
  }
  const paths = listOf(trigger.paths);
  if (paths.length > 0 && d.event !== "issues.opened" && d.event !== "issues.labeled" && d.event !== "issue_comment.created" && d.event !== "workflow_run.completed") {
    const changed = d.payload.changed_paths ?? [];
    if (!changed.some((file) => pathMatches(paths, file))) return { kind: "skip" };
  }
  if (trigger.mention === true && d.event === "issue_comment.created" && !MENTION.test(d.payload.comment?.body ?? "")) return { kind: "skip" };
  if (trigger.conclusion !== undefined && d.event === "workflow_run.completed" && d.payload.workflow_run?.conclusion !== trigger.conclusion) return { kind: "skip" };

  // Rule 2: fork pull requests and outsiders never fire.
  if (d.fork === true) {
    return { kind: "refuse", reason: "policy_denied", message: `${describe(d)} comes from a fork, and fork pull requests never start automations; a maintainer can run it by hand.` };
  }
  if (d.openRun !== undefined) {
    return { kind: "refuse", reason: "policy_denied", message: `${describe(d)} was started by a ${d.openRun} event, which anyone can cause; only runs from pushes, this repository's pull requests, schedules and manual dispatches start automations, so dispatch it by hand to fix it.` };
  }
  const actors = actorsOf(trigger);
  if (d.actor !== undefined && actors !== "any" && !trustedAssociation(d.actor.association, actors)) {
    return {
      kind: "refuse",
      reason: "policy_denied",
      message: `${describe(d)} ${d.event === "issues.labeled" ? "was labelled" : "is"} by ${d.actor.login} (${accessWords(d.actor.association)}), who is not among this automation's actors (${actors.join(", ")}); outsiders never start automations, so a maintainer can run it by hand instead.`,
    };
  }
  // Rule 3: text by someone outside the trusted set is withheld from the payload, and says so.
  // Pushes and runs carry no actor: writing to a branch of the repository needs write access.
  const textActors = actors === "any" ? DEFAULT_ACTORS : actors;
  const trusted = d.actor === undefined || trustedAssociation(d.actor.association, textActors);
  let payload = d.payload;
  if (d.context !== undefined) {
    payload = trustedAssociation(d.context.association, textActors)
      ? { ...payload, title: d.context.title, body: d.context.body, author: d.context.author, association: d.context.association }
      : { ...payload, author: d.context.author, association: d.context.association, withheld: [`the title and description of #${d.payload.number}: ${d.context.author} is not an owner, member or collaborator`] };
  }
  return { kind: "fire", payload, trusted };
}
