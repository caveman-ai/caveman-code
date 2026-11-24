// One pull request: Guide (default), Discussion, Files, under one bar holding its checks, the agents working on
// it, and the calls to make (Ask, Review, Merge). Highlighting anything anywhere offers Ask / Fix / Comment.
// Esc goes back to the queue. `embedded`: the same page in a chat's side panel (review/surface.tsx), where the
// tab is its own and the bar's first button expands to the Review page instead of going back.
import type { PrDetail, PrDiscussionItem } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowExpand01Icon, ArrowLeft02Icon, GitMergeIcon, LinkSquare02Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useSearchParams } from "react-router";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { StatusMark } from "../../components/StatusMark.tsx";
import { chatStatus, rowAge } from "../../state/model.ts";
import { requestId, useRuntimeSelector, useSession } from "../../state/runtime.tsx";
import { usePanelWorkspace } from "../../panels/workspace.ts";
import { CloudOffer } from "../../components/cloud/CloudOffer.tsx";
import { OpenWakeLine, useOpenWake } from "../../components/cloud/OpenWake.tsx";
import { AskWhereSelect, SelectionBar, useAskPlaces, useSpawnAgent, type AskMode } from "./Ask.tsx";
import { ASK_HERE, askInCloud, type AskWhere } from "./askWhere.ts";
import { filesReadAt, invalidatePr, prRef, usePrDetail, usePrDiff, usePrDiscussion, usePrGuide } from "./data.ts";
import { Discussion } from "./Discussion.tsx";
import { Files, type FilesProps } from "./Files.tsx";
import { Guide } from "./Guide.tsx";
import { blobUrl, DEFAULT_SHORT_LINES, fileUrl, guideDepth, guideLines, isShortChange, METHOD_LABEL, prKey, prPath, type PrAddress, type Passage } from "./model.ts";
import { Avatar, ChecksBar, SizePill, Stat, StatePill } from "./parts.tsx";
import { ThreadsMenu } from "./ThreadsMenu.tsx";
import { reveal } from "./scroll.ts";
import { CONNECT_GITHUB, connectGitHub, useReviewSource } from "./source.ts";
import { isComposing, keysText } from "../../panels/chrome.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

type Tab = "guide" | "discussion" | "files";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "guide", label: "Guide" },
  { id: "discussion", label: "Discussion" },
  { id: "files", label: "Files" },
];

export function PrPage({ pr: address, embedded = false, initialTab }: { pr: PrAddress; embedded?: boolean; /** Embedded: where it opens; default the guide. */ initialTab?: Tab | undefined }) {
  // This Mac's runtime, or Cloud when a browser window has no Mac (source.ts): Cloud draws no guide, ready, viewed or
  // resolve, which it cannot do.
  const { client, from, offers } = useReviewSource(address);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const settings = useRuntimeSelector((v) => v.settings);
  const navigate = useNavigate();
  const [chosenTab, setTabState] = useTabState(embedded, initialTab);
  const [params] = useSearchParams();

  // Settings > Review: guides off leaves Discussion and Files; a short change's guide is its TL;DR and the diff.
  const guidesOn = settings?.review_guides !== false && offers.guide;
  const tab: Tab = !guidesOn && chosenTab === "guide" ? "files" : chosenTab;
  const limit = settings?.review_short_lines ?? DEFAULT_SHORT_LINES;
  const detail = usePrDetail(client, address);
  const lines = detail.value ? guideLines(detail.value.files) : 0;
  const short = detail.value ? isShortChange(lines, limit) : null;
  // Cloud runs no guide (source.ts): it is not even read there.
  const guide = usePrGuide(offers.guide ? client : null, address, { enabled: guidesOn, short });
  const depth = guideDepth(guide.value?.guide, short === true);
  // Write the full tour, pressed on a short change: shown as writing until the tour lands.
  const [tourAsked, setTourAsked] = useState(false);
  useEffect(() => {
    if (guide.value?.guide?.depth === "tour" || guide.value?.failed) setTourAsked(false);
  }, [guide.value]);
  const diff = usePrDiff(client, address);
  const discussion = usePrDiscussion(client, address);
  // A chat's own pull request tab: Ask goes to that chat, and opening the tab wakes its Cloud computer if it sleeps,
  // one line counting the wait; what it reads loads by itself once Cloud answers.
  const chatHere = usePanelWorkspace();
  const ownChat = embedded ? (chatHere ?? null) : null;
  const { view: chatView } = useSession(ownChat?.session_id ?? null);
  const askChat = useMemo(() => (ownChat ? { sessionId: ownChat.session_id, running: chatView?.running === true } : null), [ownChat, chatView?.running]);
  const { asleep, wait } = useOpenWake(ownChat?.session_id ?? null);
  const wasAsleep = useRef(asleep);
  useEffect(() => {
    if (wasAsleep.current && !asleep) for (const r of [detail, diff, discussion, guide]) r.reload();
    wasAsleep.current = asleep;
    // The reads are rebuilt each render; only the waking matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asleep]);
  // Where Ask and Fix start their chat (This Mac, a Cloud computer that holds the repository, or a new one).
  const [where, setWhere] = useState<AskWhere>(ASK_HERE);
  const [askOpen, setAskOpen] = useState(false);
  // From Cloud there is no This Mac to run on: Ask runs in Cloud, so where it can is known before Ask is drawn.
  const places = useAskPlaces(detail.value, askOpen || from === "cloud");
  const askWhere = from === "cloud" && where.kind === "here" ? askInCloud(places.computers, places.canMakeOne) : where;
  const canAsk = askChat !== null || askWhere !== null;
  // A computer that went offline is no longer the choice.
  useEffect(() => {
    if (where.kind === "computer" && !places.computers.some((c) => c.runtimeId === where.runtimeId)) setWhere(ASK_HERE);
    if (where.kind === "new" && !places.canMakeOne) setWhere(ASK_HERE);
  }, [where, places]);
  const { spawn, dialog: cloudSecrets } = useSpawnAgent(detail.value, askWhere ?? ASK_HERE, askChat);
  const root = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ path: string; line?: number; side?: "new" | "old" } | null>(null);
  const [toast, setToast] = useState<{ id: string; title: string } | null>(null);

  const files = useMemo(() => new Map<string, DiffFile>((diff.value?.files ?? []).map((f) => [f.path, f])), [diff.value]);
  const d = detail.value;
  const head = guide.value?.guide?.head_sha ?? d?.head_sha ?? "";
  const read = useReadMarks(`${prKey(address)}@${head}`);

  // Chats on this pull request's head branch: the agents working on it.
  const agents = useMemo(
    () => (d ? workspaces.filter((w) => w.projectId === d.project_id && w.branch === d.head_branch && w.state !== "archived" && !w.parentId) : []),
    [workspaces, d],
  );

  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      root.current?.scrollTo({ top: 0 });
    },
    [setTabState],
  );
  const openFile = useCallback(
    (path: string, line?: number, side?: "new" | "old") => {
      setFocus(line ? { path, line, ...(side ? { side } : {}) } : { path });
      setTab("files");
    },
    [setTab],
  );
  // Files' "Read in the guide": the stop, on the Guide tab.
  const openStop = useCallback(
    (stop: number) => {
      setTab("guide");
      // The tour draws on the next frames; reveal the stop once it is there.
      let tries = 0;
      const find = () => {
        const el = document.getElementById(`stop-${stop}`);
        if (el) reveal(el, { smooth: false });
        else if (tries++ < 30) requestAnimationFrame(find);
      };
      requestAnimationFrame(find);
    },
    [setTab],
  );
  // A call showing one file (?file=, the shell's NowShowing): open it in Files, once per file. Only the routed page reads the URL.
  const fileParam = embedded ? null : params.get("file");
  const shownFile = useRef<string | null>(null);
  useEffect(() => {
    if (fileParam === null || shownFile.current === fileParam) return;
    shownFile.current = fileParam;
    openFile(fileParam);
  }, [fileParam, openFile]);

  const started = (created: { id: string; title: string } | null) => {
    // On a new Cloud computer the chat starts on the Cloud page once the computer runs.
    if (created === null) return;
    setToast({ id: created.id, title: created.title });
    setTimeout(() => setToast((t) => (t?.id === created.id ? null : t)), 6000);
  };
  const onSpawn = async (mode: AskMode, text: string, passage?: Passage) => started(await spawn(mode, text, passage));

  const write = async <M extends "pr.comment" | "pr.resolve" | "pr.review" | "pr.merge" | "pr.ready" | "pr.viewed" | "pr.post_guide">(method: M, extra: Record<string, unknown>, ...kinds: Array<"detail" | "discussion" | "diff" | "guide">) => {
    if (!client) throw new Error("Not connected to a runtime.");
    // Each method's own fields come from its caller; the address and request id are added here.
    await (client.call as (m: string, p: unknown) => Promise<unknown>)(method, { request_id: requestId(), ...prRef(address), ...extra });
    invalidatePr(client, address, ...kinds);
  };

  // Esc: back to the queue, unless something else holds it (a field, a selection, a menu). Not in a panel: its Esc is the pane's.
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      if (!window.getSelection()?.isCollapsed) return;
      navigate("/review");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, embedded]);

  const threads = discussion.value ?? [];
  const openThreads = threads.filter((t) => t.type === "thread" && !t.resolved).length;
  // The tour's stops lay out Files; a short change's TL;DR has none.
  const tourStops = guide.value?.guide && (guide.value.guide.depth ?? "tour") === "tour" ? guide.value.guide.stops : null;
  type Thread = Extract<PrDiscussionItem, { type: "thread" }>;
  const filesProps = (pr: PrDetail): Omit<FilesProps, "focus"> => ({
    detail: pr,
    address,
    ...filesReadAt(diff.value),
    files: diff.value?.files ?? [],
    omitted: diff.value?.omitted ?? [],
    loading: diff.loading,
    error: diff.error,
    threads,
    stops: tourStops,
    canComment: pr.can.comment,
    onViewed: (path, viewed) => write("pr.viewed", { paths: [path], viewed }, "detail"),
    onComment: (a, body) => write("pr.comment", { body, path: a.path, line: a.line, side: a.side }, "discussion"),
    onReply: (t: Thread, body) => write("pr.comment", { body, thread_id: t.id }, "discussion"),
    onResolve: (t: Thread, resolved) => write("pr.resolve", { thread_id: t.id, resolved }, "discussion"),
    onFix: (passage, text) => onSpawn("fix", text, passage),
    fileUrl: (path, line) => fileUrl(pr, path, line),
    blobUrl: (commit, path, line) => blobUrl(pr.url, commit, path, line),
    onOpenStop: guidesOn ? openStop : undefined,
  });
  const stops = guide.value?.guide?.stops.length ?? 0;
  const counts: Record<Tab, string | number | null> = { guide: stops > 0 ? `${read.marks.size}/${stops}` : null, discussion: discussion.value ? threads.length : null, files: d ? d.files.length : null };

  const bar = useRef<HTMLElement>(null);
  const tabList = useRef<HTMLElement>(null);
  // What the bar holds: when a control comes or goes (a draft merged, a chat started), it fits again from the top.
  const barContent = [d?.state, d?.can.merge, d?.can.ready, d?.can.review, d?.mergeable, d?.checks_list.length, agents.length, discussion.value?.length, Object.values(counts).join(",")].join("|");
  const fit = useFit(bar, tabList, barContent);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        ref={bar}
        data-fit={fit}
        // Wrapped, its gaps are set per axis: twMerge would let gap-y-1 drop a plain gap-1.5's columns.
        className={cn("flex shrink-0 items-center border-b border-border/70 pl-2 pr-3", fit === FIT_ROWS ? "flex-wrap gap-x-1.5 gap-y-1 py-1.5" : embedded ? "h-10 gap-1.5" : "h-12 gap-1.5")}
      >
        {embedded ? (
          <Button variant="ghost" size="icon-sm" aria-label="Open in Review" title="Open in Review (the full page)" onClick={() => navigate(prPath(address))}>
            <Icon icon={ArrowExpand01Icon} className="size-3.5" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="Back to Review" title="Back to Review (Esc)" onClick={() => navigate("/review")}>
            <Icon icon={ArrowLeft02Icon} className="size-4" />
          </Button>
        )}
        <nav ref={tabList} role="tablist" aria-label="Pull request" className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {TABS.filter((t) => guidesOn || t.id !== "guide").map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {t.label}
              {counts[t.id] && fit < FIT_BARE ? <span className={cn("text-[11.5px] tabular-nums", t.id === "discussion" && openThreads > 0 ? "text-warning" : "text-[hsl(var(--subtle-foreground))]")}>{counts[t.id]}</span> : null}
            </button>
          ))}
        </nav>
        <div className={cn("ml-auto flex items-center whitespace-nowrap", fit === FIT_ROWS ? "min-w-0 flex-wrap justify-end gap-x-1.5 gap-y-1" : "shrink-0 gap-1.5")}>
          {discussion.value ? <ThreadsMenu items={discussion.value} onOpen={(t) => (t.line ? openFile(t.path, t.line, t.side) : setTab("discussion"))} /> : null}
          {d ? <ChecksMenu detail={d} fit={fit} /> : null}
          {agents.length > 0 ? <AgentsMenu agents={agents} /> : null}
          {d ? (
            <>
              {canAsk ? (
                <AskMenu
                  long={fit === FIT_ALL}
                  onSpawn={(mode, text) => onSpawn(mode, text)}
                  onOpenChange={setAskOpen}
                  inChat={askChat !== null}
                  cloudStart={askWhere?.kind === "new"}
                  place={askChat ? null : <AskWhereSelect where={askWhere ?? where} onChange={setWhere} computers={places.computers} canMakeOne={places.canMakeOne} cloudOnly={from === "cloud"} />}
                />
              ) : null}
              {cloudSecrets}
              {d.can.review ? <ReviewMenu onSubmit={(verdict, body) => write("pr.review", { verdict, ...(body ? { body } : {}) }, "detail", "discussion")} /> : null}
              {offers.ready && d.can.ready && d.state === "draft" ? <ReadyButton onReady={() => write("pr.ready", {}, "detail")} /> : null}
              {d.can.merge && (d.state === "open" || d.state === "draft") ? <MergeButton detail={d} long={fit === FIT_ALL} onMerge={(method) => write("pr.merge", { method, ...(from === "cloud" && d.head_sha ? { head_sha: d.head_sha } : {}) }, "detail")} /> : null}
              <Button variant="ghost" size="icon-sm" asChild title="Open on GitHub">
                <a href={d.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub">
                  <Icon icon={LinkSquare02Icon} className="size-3.5" />
                </a>
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <div ref={root} data-review-scroller data-diff-scroller className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className={cn("mx-auto", tab === "files" ? "max-w-[1560px]" : "max-w-[1240px]", embedded ? "px-4 pt-4" : "px-6 pt-7 min-[900px]:pl-14 max-md:px-4 max-md:pt-5")}>
          {d ? <TitleBlock detail={d} /> : asleep && wait ? <OpenWakeLine wait={wait} className="px-0" /> : detail.error === CONNECT_GITHUB ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[13.5px] text-muted-foreground">{CONNECT_GITHUB}</p>
              <Button size="sm" variant="secondary" onClick={() => connectGitHub()}>
                Connect GitHub
              </Button>
            </div>
          ) : detail.error ? <Problem text={detail.error} /> : <TitleSkeleton />}
          {d && guidesOn ? <Tldr guide={guide.value} /> : null}
          <div className={depth === "tldr" && tab === "guide" ? "pt-5" : "pt-7"}>
            {!d ? null : tab === "guide" ? (
              <Guide
                detail={d}
                guide={guide.value}
                guideError={guide.error}
                files={files}
                diffLoading={diff.loading || !diff.value}
                read={read.marks}
                onRead={read.set}
                onGenerate={() => guide.generate()}
                onPost={() => write("pr.post_guide", {}, "guide", "discussion")}
                onOpenFile={openFile}
                onAsk={(passage, question) => onSpawn("ask", question, passage)}
                depth={depth}
                lines={lines}
                limit={limit}
                diff={
                  depth === "tldr" ? (
                    <Files {...filesProps(d)} focus={null} inline />
                  ) : null
                }
                onWriteTour={() => {
                  setTourAsked(true);
                  guide.generate({ full: true });
                }}
                tourAsked={tourAsked}
              />
            ) : tab === "discussion" ? (
              <Discussion
                pr={d}
                items={discussion.value}
                loading={discussion.loading}
                error={discussion.error}
                canComment={d.can.comment}
                onComment={(body) => write("pr.comment", { body }, "discussion")}
                onReply={(t, body) => write("pr.comment", { body, thread_id: t.id }, "discussion")}
                onResolve={(t, resolved) => write("pr.resolve", { thread_id: t.id, resolved }, "discussion")}
                onFix={(passage, text) => onSpawn("fix", text, passage)}
                onOpenGuide={guidesOn ? () => setTab("guide") : undefined}
              />
            ) : (
              <Files {...filesProps(d)} focus={focus} />
            )}
          </div>
        </div>
      </div>

      <SelectionBar
        root={root}
        canComment={Boolean(d?.can.comment)}
        canAsk={canAsk}
        inChat={askChat !== null}
        onSpawn={(mode, text, passage) => onSpawn(mode, text, passage)}
        onComment={(line, body) => write("pr.comment", { body, path: line.path, line: line.line, side: line.side }, "discussion")}
      />
      {toast ? (
        <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[12px] border border-border bg-popover py-1.5 pl-3 pr-1.5 text-[13px] shadow-overlay animate-in fade-in-0 slide-in-from-bottom-2 duration-200 ease-snap">
          <Glyph name="engine-caveman" />
          <span className="max-w-[360px] truncate text-foreground">{toast.title}</span>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/w/${encodeURIComponent(toast.id)}`)}>
            Open
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The tab showing: in the URL on the Review page (shareable, survives reload); the panel's own in a side panel. */
function useTabState(embedded: boolean, initial: Tab | undefined): [Tab, (next: Tab) => void] {
  const [params, setParams] = useSearchParams();
  const [own, setOwn] = useState<Tab>(initial ?? "guide");
  const fromUrl = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "guide") as Tab;
  const setUrl = useCallback(
    (next: Tab) => {
      const p = new URLSearchParams(params);
      if (next === "guide") p.delete("tab");
      else p.set("tab", next);
      setParams(p, { replace: true });
    },
    [params, setParams],
  );
  return embedded ? [own, setOwn] : [fromUrl, setUrl];
}

function TitleBlock({ detail: d }: { detail: PrDetail }) {
  return (
    <div data-passage="the pull request's title">
      <h1 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.015em] text-foreground">
        {d.title} <span className="font-normal text-[hsl(var(--subtle-foreground))]">#{d.number}</span>
      </h1>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted-foreground">
        <StatePill state={d.state} />
        <span className="flex items-center gap-1.5">
          <Avatar actor={d.author} size={18} />
          <span className="text-foreground/90">{d.author?.login ?? "unknown"}</span>
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono text-[12px]">
          {d.base_branch} <span className="text-[hsl(var(--subtle-foreground))]">←</span> {d.head_branch}
        </span>
        <span aria-hidden>·</span>
        <span>{d.repo}</span>
        <span aria-hidden>·</span>
        <span>opened {ago(d.created_at)}</span>
        <span aria-hidden>·</span>
        <span>
          {plural(d.files.length, "file")}, {plural(d.commits, "commit")}
        </span>
        <Stat additions={d.additions} deletions={d.deletions} atLeast={d.diff_stat_truncated === true} />
        <SizePill lines={guideLines(d.files)} />
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ago = (at: string) => {
  const age = rowAge(at, Date.now());
  return age === "now" ? "just now" : `${age} ago`;
};

/** The whole pull request in a terse line or two, on every tab; the bust says who wrote it. */
function Tldr({ guide }: { guide: import("@caveman-app/session-protocol").PrGuideResult | undefined }) {
  const line = guide?.guide?.tldr;
  if (!line && !guide?.running) return null;
  return (
    <div className="mt-5 flex max-w-[880px] items-start gap-3 rounded-xl bg-foreground/[0.04] px-4 py-3 ring-1 ring-inset ring-foreground/[0.06]" data-passage="the guide's TL;DR">
      <Glyph name="engine-caveman" className="mt-0.5 shrink-0" />
      <p className="min-w-0 text-[15px] leading-6">
        <span className="mr-2 text-[12px] text-muted-foreground">TL;DR</span>
        {line ? <span className="text-foreground">{line}</span> : <span className="lucy-shimmer text-muted-foreground">Caveman is reading the change…</span>}
      </p>
    </div>
  );
}

function TitleSkeleton() {
  return (
    <div aria-busy aria-label="Loading the pull request">
      <div className="h-6 w-2/3 rounded bg-foreground/[0.07]" />
      <div className="mt-3 h-4 w-1/2 rounded bg-foreground/[0.05]" />
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return <p className="rounded-lg bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive ring-1 ring-inset ring-destructive/20">{text}</p>;
}

/**
 * How much the bar gives up to fit its width (a side panel's or the page's, never the window's): everything; then the
 * shorter labels (Checks' word, "Ask agent", the merge method); then the tab counts and the checks' track; last, its
 * actions wrap to a second row. The actions are never cut off.
 */
const FIT_ALL = 0;
const FIT_SHORT = 1;
const FIT_BARE = 2;
const FIT_ROWS = 3;
type Fit = typeof FIT_ALL | typeof FIT_SHORT | typeof FIT_BARE | typeof FIT_ROWS;

/**
 * The bar's fit: after each render, one step further while it overflows; from the top again whenever its width or
 * `content` (what it holds: a key of its controls and counts) changes, so a control that goes gives its room back.
 */
function useFit(bar: RefObject<HTMLElement | null>, tabs: RefObject<HTMLElement | null>, content: string): Fit {
  const [fit, setFit] = useState<Fit>(FIT_ALL);
  // Bumped on every resize, so the bar is measured again even when it was showing everything already (setFit(FIT_ALL)
  // alone would not re-render then, and a narrowed bar would stay clipped).
  const [, setMeasure] = useState(0);
  const width = useRef(0);
  const held = useRef(content);
  useLayoutEffect(() => {
    if (held.current === content) return;
    held.current = content;
    setFit(FIT_ALL);
    setMeasure((n) => n + 1);
  }, [content]);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || fit === FIT_ROWS) return;
    const over = (e: HTMLElement | null) => e !== null && e.scrollWidth > e.clientWidth + 1;
    if (over(el) || over(tabs.current)) setFit((fit + 1) as Fit);
  });
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    width.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === width.current) return;
      width.current = w;
      // Measured again from everything shown, before this frame paints: the bar never shows clipped.
      flushSync(() => {
        setFit(FIT_ALL);
        setMeasure((n) => n + 1);
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar]);
  return fit;
}

function ChecksMenu({ detail, fit }: { detail: PrDetail; fit: Fit }) {
  if (detail.checks_list.length === 0) return null;
  const order = { failed: 0, pending: 1, passed: 2, skipped: 3 } as const;
  const sorted = [...detail.checks_list].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent">
          {fit === FIT_ALL ? <span>Checks</span> : null}
          <ChecksBar checks={detail.checks_list} bar={fit < FIT_BARE} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-1.5">
        <div className="max-h-[360px] overflow-y-auto">
          {sorted.map((c) => (
            <a
              key={c.name}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span className={cn("size-2 shrink-0 rounded-full", c.status === "passed" ? "bg-success" : c.status === "failed" ? "bg-destructive" : c.status === "pending" ? "bg-warning" : "bg-muted-foreground/50")} />
              <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">{c.status}</span>
            </a>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentsMenu({ agents }: { agents: ReadonlyArray<import("../../state/model.ts").WorkspaceView> }) {
  const navigate = useNavigate();
  const live = agents.filter((w) => w.state === "working" || w.state === "needs_input").length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent">
          {live > 0 ? <span className="size-1.5 rounded-full bg-warning" aria-hidden /> : null}
          {agents.length === 1 ? "1 chat" : `${agents.length} chats`}
          <Icon icon={ArrowDown01Icon} className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[320px]">
        {agents.map((w) => {
          const status = chatStatus(w);
          return (
            <DropdownMenuItem key={w.id} onSelect={() => navigate(`/w/${encodeURIComponent(w.id)}`)}>
              {status ? <StatusMark status={status} compact /> : <Glyph name="engine-caveman" />}
              <span className="min-w-0 flex-1 truncate">{w.title}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">{status?.label ?? ""}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Ask about, or fix, the whole pull request: a chat on its head with the person's words. */
/** `inChat`: a chat's own pull request tab, where what is asked goes to that chat (no place to pick, no new chat). */
/** `long`: "Ask agent" where the bar has room (PrPage's fit), else "Ask". */
/** `cloudStart`: the chat starts on a new Cloud computer, so the one-time offer to use a subscription there shows above Fix and Ask. */
export function AskMenu({ onSpawn, onOpenChange, place, inChat = false, long = true, cloudStart = false }: { onSpawn: (mode: AskMode, text: string) => Promise<unknown>; onOpenChange: (open: boolean) => void; place: ReactNode; inChat?: boolean; long?: boolean; cloudStart?: boolean }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
  };
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (mode: AskMode) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSpawn(mode, text);
      setOpen(false);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" title={inChat ? "Ask this chat about its pull request" : "Start a chat on this pull request's head"}>
          <Glyph name="engine-caveman" className="size-3.5" />
          {inChat || !long ? "Ask" : "Ask agent"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-2">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || isComposing(e)) return;
            e.preventDefault();
            void go(e.metaKey || e.ctrlKey ? "fix" : "ask");
          }}
          rows={3}
          placeholder="Ask about this pull request, or say what to fix"
          aria-label={inChat ? "Ask this chat" : "Ask an agent"}
          className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error ? <p className="px-1 pt-1 text-[12px] text-destructive">{error}</p> : null}
        {/* Asked at a chat starting on a new Cloud computer; opening and closing this popover uses nothing up, only an answer does. It never holds the start (components/cloud/CloudOffer.tsx). */}
        {cloudStart && !inChat ? (
          // Yes and No sit on the right, lined up with Fix and Ask below.
          <CloudOffer
            countShown={false}
            className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-1 text-[13px] leading-5 text-foreground [&>span:last-child]:ml-auto [&>span:last-child]:gap-1.5"
          />
        ) : null}
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <span className="mr-auto flex min-w-0 items-center gap-2 pl-1 text-[11.5px] text-muted-foreground">
            <span className="shrink-0">{inChat ? "Goes to this chat" : "Starts a chat on its branch"}</span>
            {place}
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void go("fix")} title={keysText("⌘↩", "mod+enter")}>
            Fix
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void go("ask")} title="↩">
            Ask
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A draft's one call: mark it ready for review. The host's refusal shows in place. */
function ReadyButton({ onReady }: { onReady: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      title={error ?? "Mark this draft ready for review"}
      className={cn(error && "text-destructive")}
      onClick={async () => {
        setBusy(true);
        setError(null);
        try {
          await onReady();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Glyph name="state-done" className="size-3.5" />
      {error ? "Couldn't mark ready" : busy ? "Marking ready…" : "Mark ready"}
    </Button>
  );
}

type Verdict = "approve" | "request_changes" | "comment";
const VERDICTS: ReadonlyArray<{ id: Verdict; label: string; hint: string }> = [
  { id: "approve", label: "Approve", hint: "Ship it" },
  { id: "request_changes", label: "Request changes", hint: "Send it back" },
  { id: "comment", label: "Comment", hint: "No verdict" },
];

export function ReviewMenu({ onSubmit }: { onSubmit: (verdict: Verdict, body: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>("approve");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One review at a time: the note's ⌘↩ reaches submit while the button is disabled, and a ref holds before `busy` is drawn.
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current) return;
    if (verdict !== "approve" && !body.trim()) return setError("Say what should change.");
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(verdict, body.trim());
      setOpen(false);
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          Review
          <Icon icon={ArrowDown01Icon} className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-2">
        <div role="radiogroup" aria-label="Verdict" className="grid grid-cols-3 gap-1">
          {VERDICTS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={verdict === v.id}
              onClick={() => setVerdict(v.id)}
              className={cn(
                "rounded-lg px-2 py-1.5 text-left outline-none ring-1 ring-inset transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
                verdict === v.id ? "bg-accent ring-foreground/20" : "ring-transparent hover:bg-accent/60",
              )}
            >
              <span className="block text-[13px] text-foreground">{v.label}</span>
              <span className="block text-[11.5px] text-muted-foreground">{v.hint}</span>
            </button>
          ))}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
          rows={3}
          placeholder={verdict === "approve" ? "Optional note" : "What should change?"}
          aria-label="Review note"
          className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="mt-1.5 flex items-center justify-end gap-2">
          {error ? <p className="mr-auto text-[12px] text-destructive">{error}</p> : null}
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy ? "Sending…" : "Submit review"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type MergeMethod = "squash" | "merge" | "rebase";
const mergeMethods = (d: PrDetail): ReadonlyArray<MergeMethod> => (d.can.merge_methods.length > 0 ? d.can.merge_methods : ["squash"]);

/** `long`: the merge method's name where the bar has room (PrPage's fit), else "Merge". */
export function MergeButton({ detail: d, onMerge, long = true }: { detail: PrDetail; onMerge: (method: MergeMethod) => Promise<unknown>; long?: boolean }) {
  const [method, setMethod] = useState(mergeMethods(d)[0]!);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failing = d.checks_list.some((c) => c.status === "failed");
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await onMerge(method);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <MergeControl detail={d} method={method} onMethod={setMethod} busy={busy} error={error} long={long} onOpen={() => setConfirm(true)} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`${METHOD_LABEL[method]} #${d.number}?`}
        description={`${d.head_branch} into ${d.base_branch} on ${d.repo}.${failing ? " Some checks fail." : ""}${error ? ` Last try: ${error}` : ""}`}
        confirmLabel={METHOD_LABEL[method]}
        destructive={failing}
        onConfirm={() => void merge()}
      />
    </>
  );
}

/** Merge and its method menu. The host's refusal shows in place, as ReadyButton's does: the dialog closed as it was confirmed. */
function MergeControl({ detail: d, method, onMethod, busy, error, long, onOpen }: { detail: PrDetail; method: MergeMethod; onMethod: (method: MergeMethod) => void; busy: boolean; error: string | null; long: boolean; onOpen: () => void }) {
  const methods = mergeMethods(d);
  const failing = d.checks_list.some((c) => c.status === "failed");
  const blocked = d.state === "draft" || d.mergeable === "conflicting" || d.mergeable === "blocked";
  const why = d.state === "draft" ? "Draft" : d.mergeable === "conflicting" ? "Conflicts" : d.mergeable === "blocked" ? "Blocked" : null;
  const label: ReactNode = why ?? (busy ? "Merging…" : error ? "Couldn't merge" : (
    <>
      <Icon icon={GitMergeIcon} className="size-3.5" />
      {long ? METHOD_LABEL[method] : "Merge"}
    </>
  ));
  return (
    <div className="flex items-center">
      <Button size="sm" variant={failing || blocked || error ? "secondary" : "default"} disabled={blocked || busy} onClick={onOpen} className={cn(methods.length > 1 && "rounded-r-none", error && "text-destructive")} title={error ?? (failing ? "Some checks fail" : undefined)}>
        {label}
      </Button>
      {methods.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant={failing || blocked || error ? "secondary" : "default"} disabled={blocked || busy} aria-label="Merge method" className="rounded-l-none border-l border-primary-foreground/15 px-1.5">
              <Icon icon={ArrowDown01Icon} className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {methods.map((m) => (
              <DropdownMenuItem key={m} onSelect={() => onMethod(m)}>
                {METHOD_LABEL[m]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** Which stops the person marked read, per pull request head, on this device. */
function useReadMarks(key: string) {
  const storageKey = `caveman.review.read.${key}`;
  const [marks, setMarks] = useState<ReadonlySet<number>>(() => load(storageKey));
  useEffect(() => setMarks(load(storageKey)), [storageKey]);
  const set = useCallback(
    (stop: number, read: boolean) =>
      setMarks((prev) => {
        const next = new Set(prev);
        if (read) next.add(stop);
        else next.delete(stop);
        localStorage.setItem(storageKey, JSON.stringify([...next]));
        // On to the next stop once the check has drawn itself (~350 ms), so the mark is seen landing.
        if (read) setTimeout(() => reveal(document.getElementById(`stop-${stop + 1}`)), 450);
        return next;
      }),
    [storageKey],
  );
  return { marks, set };
}

function load(key: string): ReadonlySet<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}
