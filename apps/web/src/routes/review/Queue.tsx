// The Review queue: every open pull request across this computer's projects, grouped by what it asks of you or,
// across several repositories, by repository (a section each, its header held at the top while you scroll it, folded
// with a click; the choice and the folds are kept on this computer). Rows warm their pull request on hover, so opening one paints at once. The filter bar (components/FilterBar.tsx,
// facets in filter.ts) searches and narrows the rows and keeps its state for the session; a pasted pull request
// URL opens it.
import type { PrSummary } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { Icon, ArrowRight01Icon, RefreshCwIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ActiveFilters, FilterMenu, FilterSearch, Highlight, useStoredFilters } from "../../components/FilterBar.tsx";
import { isFiltering, offered } from "../../lib/facets.ts";
import { isComposing } from "../../panels/chrome.tsx";
import { rowAge } from "../../state/model.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { prefetchPr, useQueue } from "./data.ts";
import { filterPrs, prChips, type PrMatch, SORT_KEYS, SORTS } from "./filter.ts";
import { asksYou, groupByRepo, groupQueue, prKey, prPath, summaryAddress, type QueueGroupId, type QueueGrouping, type RepoGroup } from "./model.ts";
import { Avatar, ChecksGlyph, REVIEW_WORD, Stat, StateIcon } from "./parts.tsx";
import { reveal } from "./scroll.ts";
import { CONNECT_GITHUB, connectGitHub, useReviewSource } from "./source.ts";
import { SectionHeader } from "../../panels/chrome.tsx";
import { PageBar } from "../../shell/PageBar.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const GROUPING_KEY = "review.grouping";
const FOLDED_KEY = "review.folded-repos";

/** A choice kept on this computer across launches (localStorage), read once. */
function useKept<T>(key: string, read: (raw: string | null) => T, write: (value: T) => string | null): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => read(localStorage.getItem(key)));
  useEffect(() => {
    const raw = write(value);
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  }, [key, value, write]);
  return [value, setValue];
}
const readGrouping = (raw: string | null): QueueGrouping => (raw === "repo" ? "repo" : "status");
const writeGrouping = (value: QueueGrouping) => (value === "repo" ? "repo" : null);
const readFolded = (raw: string | null): ReadonlySet<string> => {
  try {
    const list: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
};
const writeFolded = (value: ReadonlySet<string>) => (value.size === 0 ? null : JSON.stringify([...value]));

const PR_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/(?:pull|pulls|merge_requests|-\/merge_requests)\/(\d+)/;

export function ReviewQueue() {
  // This Mac's runtime, or Cloud when a browser window has no Mac (source.ts): the same page either way.
  const { client, from } = useReviewSource();
  const projects = useRuntimeSelector((v) => v.projects);
  const queue = useQueue(client);
  const navigate = useNavigate();
  const [filters, setFilters] = useStoredFilters("review.filters", SORT_KEYS);
  const query = filters.query;
  const setQuery = (q: string) => setFilters((f) => ({ ...f, query: q }));
  const listRef = useRef<HTMLDivElement>(null);
  const now = Date.now();

  const prs = useMemo(() => queue.value?.prs ?? [], [queue.value]);
  // A pasted URL is for opening, not for narrowing the rows.
  const searching = useMemo(() => (PR_URL.test(query.trim()) ? { ...filters, query: "" } : filters), [filters, query]);
  const chips = useMemo(() => prChips(prs, searching), [prs, searching]);
  const applied = useMemo(() => offered(searching, chips), [searching, chips]);
  const kept = useMemo(() => filterPrs(prs, applied), [prs, applied]);
  const matches = useMemo(() => new Map(kept.map((s) => [prKey(s.pr), s.match])), [kept]);
  const shown = useMemo(() => kept.map((s) => s.pr), [kept]);
  const groups = useMemo(() => groupQueue(shown), [shown]);
  const narrowed = isFiltering(applied);
  // One repository everywhere: saying it on every row is noise, and sections by repository would be one.
  const manyRepos = useMemo(() => new Set((queue.value?.prs ?? []).map((pr) => pr.repo)).size > 1, [queue.value]);
  const [grouping, setGrouping] = useKept(GROUPING_KEY, readGrouping, writeGrouping);
  const byRepo = manyRepos && grouping === "repo";
  const repoGroups = useMemo(() => (byRepo ? groupByRepo(shown) : []), [byRepo, shown]);
  const [folded, setFolded] = useKept(FOLDED_KEY, readFolded, writeFolded);
  const fold = (repo: string) => {
    const next = new Set(folded);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    setFolded(next);
  };
  /** The index strip's pill: open that repository's section and bring its header to the top. */
  const jump = (repo: string) => {
    if (folded.has(repo)) fold(repo);
    requestAnimationFrame(() => reveal(document.getElementById(repoSectionId(repo)), { block: "start" }));
  };

  /** A pasted pull request URL: open it through the project on that repository, else any project on its host. */
  const openUrl = (text: string): boolean => {
    const m = PR_URL.exec(text.trim());
    if (!m) return false;
    const [, host, repo, num] = m;
    const own = projects.find((p) => p.repository?.full_name.toLowerCase() === repo!.toLowerCase());
    const via = own ?? projects.find((p) => p.repository?.host === host);
    if (!via) return false;
    navigate(`${prPath({ project_id: via.id, number: Number(num) })}${own ? "" : `?repo=${encodeURIComponent(repo!)}&host=${encodeURIComponent(host!)}`}`);
    return true;
  };

  // j/k and the arrows walk the rows; Enter opens (the rows are links).
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || (event.target as HTMLElement).tagName === "INPUT") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-pr-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    // Focus without the browser scrolling the shell; the row is brought into view in its own list.
    const row = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    row?.focus({ preventScroll: true });
    const box = row?.getBoundingClientRect();
    const frame = listRef.current?.getBoundingClientRect();
    if (row && box && frame && (box.top < frame.top || box.bottom > frame.bottom)) reveal(row, { block: "center", smooth: false });
    event.preventDefault();
  };

  // GitHub connects in another tab: coming back here reads the queue again, with nothing to press.
  const notConnected = queue.value?.github === "not_connected";
  const reload = queue.reload;
  useEffect(() => {
    if (!notConnected) return;
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [notConnected, reload]);

  const needs = groups.find((g) => g.id === "needs_you")?.prs.length ?? 0;
  const first = queue.value === undefined && !queue.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <PageBar icon="review" title="Review">
        {needs > 0 ? <span className="whitespace-nowrap text-[13px] text-muted-foreground max-md:hidden">{needs === 1 ? "1 waits on you" : `${needs} wait on you`}</span> : null}
        <FilterSearch
          value={query}
          onChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isComposing(e) && openUrl(query)) setQuery("");
          }}
          placeholder="Search, or paste a pull request URL"
          label="Search pull requests"
          className="ml-auto w-[300px] max-md:w-auto max-md:min-w-0 max-md:flex-1"
        />
        {manyRepos ? <GroupingSwitch value={grouping} onChange={setGrouping} /> : null}
        {queue.value && !queue.value.unavailable ? <FilterMenu groups={chips} filters={applied} onChange={setFilters} sorts={SORTS} /> : null}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" title="Refresh" onClick={queue.reload}>
          <Icon icon={RefreshCwIcon} className={cn("size-3.5", queue.loading && "animate-spin")} />
        </Button>
      </PageBar>
      <div ref={listRef} data-review-scroller className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[1080px]">
          {queue.value && !queue.value.unavailable ? <ActiveFilters className="px-3 pt-3" groups={chips} filters={applied} onChange={setFilters} shown={shown.length} total={prs.length} /> : null}
          {queue.value?.github === "not_connected" ? (
            <Empty title="GitHub isn't connected" line={queue.value.unavailable ?? CONNECT_GITHUB}>
              <Button size="sm" variant="secondary" onClick={() => connectGitHub(queue.value?.connect_url)}>
                Connect GitHub
              </Button>
            </Empty>
          ) : queue.value?.unavailable ? (
            <Empty
              title="Sign in to GitHub"
              line={queue.value.unavailable}
              hint={
                <>
                  Sign in with <span className="font-mono">gh auth login</span>, then refresh.
                </>
              }
            >
              <Button size="sm" variant="secondary" onClick={queue.reload}>
                Refresh
              </Button>
            </Empty>
          ) : queue.error && !queue.value ? (
            <Empty title={from === "cloud" ? "Can't reach Cloud" : "Can't reach the runtime"} line={queue.error} hint={from === "cloud" ? "Cloud could not list pull requests." : "The runtime could not list pull requests."} pose="error">
              <Button size="sm" variant="secondary" onClick={queue.reload}>
                Try again
              </Button>
            </Empty>
          ) : first ? (
            <Skeleton />
          ) : groups.length === 0 ? (
            narrowed ? (
              <Empty title="No match" line={applied.query.trim() ? `Nothing here matches “${applied.query.trim()}”${Object.keys(applied.picked).length > 0 ? " with those filters" : ""}.` : "Nothing here fits those filters."} pose="thinking">
                <Button size="sm" variant="secondary" onClick={() => setFilters((f) => ({ ...f, query: "", picked: {} }))}>
                  Clear filters
                </Button>
              </Empty>
            ) : (
              <Empty title="All clear" line="No open pull requests in your projects." hint="New ones show here as agents open them." pose="sleeping" />
            )
          ) : byRepo ? (
            <>
              {repoGroups.length > 1 ? <RepoIndex groups={repoGroups} onJump={jump} /> : null}
              {repoGroups.map((group) => (
              <RepoSection key={group.repo} group={group} folded={folded.has(group.repo)} onFold={() => fold(group.repo)}>
                {group.prs.map((pr) => (
                  <Row key={prKey(pr)} pr={pr} match={matches.get(prKey(pr))} now={now} group={pr.state === "merged" || pr.state === "closed" ? "closed" : "others"} showRepo={false} asks={asksYou(pr)} />
                ))}
              </RepoSection>
              ))}
            </>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="pt-4">
                <SectionHeader as="h2" count={group.prs.length} className="h-8 px-3 pb-0">
                  {group.id === "needs_you" ? <span className="size-1.5 rounded-full bg-warning" aria-hidden /> : null}
                  {group.label}
                </SectionHeader>
                {group.prs.map((pr) => (
                  <Row key={prKey(pr)} pr={pr} match={matches.get(prKey(pr))} now={now} group={group.id} showRepo={manyRepos} />
                ))}
              </section>
            ))
          )}
          {queue.value && queue.value.errors.length > 0 ? (
            <p className="px-3 pt-6 text-[12.5px] text-muted-foreground">
              Could not read {queue.value.errors.map((e) => e.repo ?? projects.find((p) => p.id === e.project_id)?.name ?? e.project_id).join(", ")}: {queue.value.errors[0]!.message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Status or Repository: how the queue is cut. Offered once the queue spans more than one repository. */
function GroupingSwitch({ value, onChange }: { value: QueueGrouping; onChange: (next: QueueGrouping) => void }) {
  const options: ReadonlyArray<{ value: QueueGrouping; label: string }> = [
    { value: "status", label: "Status" },
    { value: "repo", label: "Repository" },
  ];
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const next = value === "status" ? "repo" : "status";
    onChange(next);
    (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Group by" onKeyDown={step} className="flex h-8 shrink-0 items-center gap-0.5 rounded-[9px] border border-border/70 p-0.5 max-md:hidden">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-[26px] rounded-[7px] px-2.5 text-[12.5px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
            o.value === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const repoSectionId = (repo: string) => `repo-${repo.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** The owner's mark, square to tell it from the round author avatars; GitHub serves one per owner. */
function OwnerMark({ group, size }: { group: RepoGroup; size: number }) {
  if (!group.owner) return null;
  const github = group.prs[0]!.host === "github.com";
  return <Avatar actor={{ login: group.owner, ...(github ? { avatar_url: `https://github.com/${group.owner}.png?size=48` } : {}) }} size={size} className="rounded-[4px]" />;
}

/** Every repository in the queue as one pill each (its count, an amber dot where one waits on you): where to jump. */
function RepoIndex({ groups, onJump }: { groups: ReadonlyArray<RepoGroup>; onJump: (repo: string) => void }) {
  return (
    <nav aria-label="Repositories" className="flex flex-wrap gap-1.5 px-2 pt-3">
      {groups.map((group) => (
        <button
          key={group.repo}
          type="button"
          onClick={() => onJump(group.repo)}
          title={group.repo}
          className="flex h-7 items-center gap-1.5 rounded-full border border-input pl-1.5 pr-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <OwnerMark group={group} size={16} />
          <span className="text-foreground/90">{group.name}</span>
          <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{group.prs.length}</span>
          {group.needsYou > 0 ? <span className="size-1.5 rounded-full bg-warning" aria-label={`${group.needsYou} waiting on you`} /> : null}
        </button>
      ))}
    </nav>
  );
}

/**
 * One repository's section: a header held at the top of the list while its rows scroll under it (fold, the owner's
 * mark, owner / name, the count, then what waits: reviews asked of you and failing checks), then its rows.
 */
function RepoSection({ group, folded, onFold, children }: { group: RepoGroup; folded: boolean; onFold: () => void; children: ReactNode }) {
  const section = repoSectionId(group.repo);
  const rows = `${section}-rows`;
  return (
    <section id={section} className="scroll-mt-0 pt-4" aria-label={group.repo}>
 {/* The panel behind the band hides rows scrolling under it; the band is the card step, as minimal group rows. */}
      <h2 className="sticky top-0 z-10 bg-background pb-1 pt-1">
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={rows}
          onClick={onFold}
          className="flex h-10 w-full items-center gap-2.5 rounded-[10px] border border-border/70 bg-card px-3 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap", !folded && "rotate-90")} />
          <OwnerMark group={group} size={18} />
          <span className="min-w-0 truncate text-[13.5px]">
            {group.owner ? (
              <>
                <span className="text-muted-foreground">{group.owner}</span>
                <span className="px-1 text-[hsl(var(--subtle-foreground))]">/</span>
              </>
            ) : null}
            <span className="font-semibold text-foreground">{group.name}</span>
          </span>
          <span className="shrink-0 text-[12.5px] tabular-nums text-[hsl(var(--subtle-foreground))]">{group.prs.length}</span>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground">
            {group.needsYou > 0 ? (
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                <span className="tabular-nums text-foreground/90">{group.needsYou}</span> {group.needsYou === 1 ? "needs you" : "need you"}
              </span>
            ) : null}
            {group.failing > 0 ? (
              <span className="flex items-center gap-1.5">
                <ChecksGlyph checks="failing" />
                <span className="tabular-nums text-foreground/90">{group.failing}</span> failing
              </span>
            ) : null}
          </span>
        </button>
      </h2>
      {folded ? null : (
        <div id={rows} className="pb-1">
          {children}
        </div>
      )}
    </section>
  );
}

function Row({ pr, match, now, group, showRepo, asks = false }: { pr: PrSummary; match: PrMatch | undefined; now: number; group: QueueGroupId; showRepo: boolean; asks?: boolean }) {
  const { client } = useReviewSource();
  const projects = useRuntimeSelector((v) => v.projects);
  const address = summaryAddress(pr, projects);
  const warm = useRef<ReturnType<typeof setTimeout> | null>(null);
  const review = pr.review && pr.review !== "review_required" ? REVIEW_WORD[pr.review] : null;
  return (
    <Link
      to={prPath(address)}
      data-pr-row
      onPointerEnter={() => (warm.current = setTimeout(() => prefetchPr(client, address), 90))}
      onPointerLeave={() => warm.current && clearTimeout(warm.current)}
      onFocus={() => prefetchPr(client, address)}
      className={cn(
        // Keyed by pull request: a row that arrives with a new filter fades in (the kit's row-in); one that stays is left alone.
        "group flex min-h-[54px] items-center gap-3 rounded-[10px] px-3 py-2 outline-none transition-colors duration-75 animate-row-in motion-reduce:animate-none max-md:gap-2.5 max-md:px-2",
        "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <StateIcon state={pr.state} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[14px] font-medium", group === "closed" ? "text-muted-foreground" : "text-foreground")}>
            <Highlight text={pr.title} ranges={match?.ranges[0]} />
          </span>
          <span className="shrink-0 text-[13px] tabular-nums text-[hsl(var(--subtle-foreground))]">#{pr.number}</span>
          <ChecksGlyph checks={pr.checks} />
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
          {/* Sections by repository no longer say what waits on you: the row does. */}
          {asks ? (
            <>
              <span className="flex shrink-0 items-center gap-1.5 text-warning">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                Needs you
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="shrink-0">{rowAge(pr.updated_at, now)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{pr.author?.login ?? "unknown"}</span>
          {showRepo ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">{pr.repo}</span>
            </>
          ) : null}
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">
            <Highlight text={pr.head_branch} ranges={match?.ranges[1]} />
          </span>
        </span>
      </span>
      {pr.workspace_id ? (
        <span className="hidden shrink-0 items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11.5px] text-muted-foreground ring-1 ring-inset ring-foreground/10 sm:inline-flex" title="A chat of yours is on this branch">
          <Glyph name="engine-caveman" className="size-3" />
          chat
        </span>
      ) : null}
      {review ? <span className={cn("shrink-0 text-[12.5px] font-medium", review.tone)}>{review.word}</span> : null}
      {/* On a phone the title needs the room: the counts take only their own width, and the author is named under it. */}
      <Stat additions={pr.additions} deletions={pr.deletions} className="w-[88px] text-right max-md:w-auto" />
      <Avatar actor={pr.author} size={20} className="max-md:hidden" />
    </Link>
  );
}

/** The queue's page-level empty state: what the page has (or what went wrong), the line under it, and its hint. */
function Empty({ title, line, hint, pose = "idle", children }: { title: string; line: string; hint?: ReactNode; pose?: MascotPose; children?: ReactNode }) {
  return (
    <EmptyState pose={pose} title={title} action={children} className="py-20">
      <p>{line}</p>
      {hint ? <p>{hint}</p> : null}
    </EmptyState>
  );
}

function Skeleton() {
  return (
    <div className="pt-12" aria-busy aria-label="Loading pull requests">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-[54px] items-center gap-3 px-3">
          <span className="size-4 rounded-full bg-foreground/[0.06]" />
          <span className="flex-1">
            <span className="block h-3 rounded bg-foreground/[0.07]" style={{ width: `${62 - i * 6}%` }} />
            <span className="mt-2 block h-2.5 w-1/3 rounded bg-foreground/[0.04]" />
          </span>
        </div>
      ))}
    </div>
  );
}
