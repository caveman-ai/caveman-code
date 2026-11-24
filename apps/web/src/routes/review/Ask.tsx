// Highlight anything on a pull request (guide prose, code, a comment) and a small bar offers Ask, Fix and, on code,
// Comment. On the Review page Ask and Fix start a chat on the pull request's head with the passage and where it came
// from; in a chat's own pull request tab they go to that chat as a message. Comment writes a line comment on GitHub.
// A, F and C do the same from the keyboard while text is selected.
import type { EngineDescriptor, PrDetail, Workspace } from "@caveman-app/session-protocol";
import { Keycap } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, ArrowUp02Icon, Comment01Icon, Wrench01Icon } from "@caveman-app/ui/icons/huge";
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useUseOnCloudPrompt } from "../../components/cloud/trust.tsx";
import { KeptLimitLink } from "../../components/cloud/KeptLimitLink.tsx";
import { THIS_COMPUTER } from "../../lib/platform.ts";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { chooseRuntime, CLOUD_START_ENGINE, placedStart, startLink, startOnNewCloudComputer } from "../../state/cloud.ts";
import { chatEngine, NO_ENGINE } from "../../state/engines.ts";
import { CLOUD_HOSTED, requestId, useChatList, useComputersCloud, useRuntimeClient, useRuntimeSelector, useSyncHub } from "../../state/runtime.tsx";
import { useCloudComputers } from "../../state/useCloudComputers.ts";
import { ASK_HERE, askComputers, askInCloud, chatAskText, cloudEngine, prChatParams, prPendingStart, startOnComputer, type AskComputer, type AskWhere } from "./askWhere.ts";
import { agentTask, agentTitle, type Passage } from "./model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export type AskMode = "ask" | "fix";

/**
 * The chat whose own pull request tab this is: an Ask or Fix there is a message to it (which wakes its place if it
 * sleeps), not a new chat, so the pull request's project need not be on this computer. `running`: a turn is going on,
 * and the message waits behind it.
 */
export interface AskChat {
  readonly sessionId: string;
  readonly running: boolean;
}

/**
 * Start a chat on this pull request's head: the agent reads the code there and, for a fix, pushes to it. `where`:
 * This Mac's project, a Cloud computer of the person's that holds the repository, or a new Cloud computer (it opens
 * on the Cloud page, which starts the chat there: the answer is then null). `dialog` asks before This Mac's secrets
 * for the repository reach a new Cloud computer; render it. With `chat` (a chat's own pull request tab) the ask goes
 * to that chat instead, and the answer is null: there is no new chat to open.
 */
export function useSpawnAgent(detail: PrDetail | undefined, where: AskWhere = ASK_HERE, chat: AskChat | null = null) {
  const { client } = useRuntimeClient();
  const hub = useSyncHub();
  const projects = useRuntimeSelector((v) => v.projects);
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const adopt = useRuntimeSelector((v) => v.adopt);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const useOnCloud = useUseOnCloudPrompt();
  const computersCloud = useComputersCloud();
  const spawn = useCallback(
    async (mode: AskMode, text: string, passage?: Passage): Promise<Workspace | null> => {
      if (!detail) throw new Error("The pull request hasn't loaded yet.");
      // Only This Mac and a chat's own tab need this window's runtime: Cloud starts a chat with none (a window with no Mac).
      if (!client && (chat || where.kind === "here")) throw new Error("Not connected to a runtime.");
      if (chat && client) {
        await client.call("turn.submit", {
          request_id: requestId(),
          session_id: chat.sessionId,
          kind: chat.running ? "queue" : "followup",
          input: { text: chatAskText({ pr: detail, mode, passage, text }) },
        });
        return null;
      }
      // With no runtime to say which agents are set up, a chat in Cloud runs on Cloud's own (as New chat in a browser does).
      const engine = client ? chatEngine(engines, null, settings?.default_engine) : ({ id: CLOUD_START_ENGINE } as const);
      if (!engine) throw new Error(NO_ENGINE);
      const title = agentTitle(mode, text, passage);
      const task = agentTask({ pr: detail, mode, passage, text });
      if (where.kind === "computer") {
        if (!hub) throw new Error("Caveman is not connected on this device.");
        const api = computersCloud ?? hub.cloud();
        const created = await startOnComputer({
          computer: where,
          list: hub.list,
          resume: api ? (computerId) => api.resume(computerId) : undefined,
          create: (runtimeId) => hub.pool.with(runtimeId, (c) => c.call("workspace.create", prChatParams({ pr: detail, engine: engine.id, title, task, requestId: requestId() }))),
        });
        await refresh();
        return created;
      }
      if (where.kind === "new") {
        const input = { title, repo: detail.repo, engine: cloudEngine(engine.id) as EngineDescriptor["id"] };
        if (CLOUD_HOSTED) {
          // This page waits for the new computer's runtime, then starts the chat there (PendingCloudStart).
          await startOnNewCloudComputer(input, (computerId) => prPendingStart(computerId, { pr: detail, engine: engine.id, title, task }), sessionStorage);
          chooseRuntime(localStorage, null);
          window.location.reload();
          return null;
        }
        if (!client) throw new Error("Not connected to a runtime.");
        // Secrets on this Mac only reach the Cloud computer if you say so now.
        await useOnCloud.ask({ url: `https://github.com/${detail.repo}` });
        const made = await client.call("cloud.workspace.create", { request_id: requestId(), ...input });
        // The chat starts on the Cloud page once the computer runs.
        openExternal(startLink(made.open_url, placedStart(prPendingStart(made.computer_id, { pr: detail, engine: engine.id, title, task }), made.workspace_id)));
        return null;
      }
      const project = projects.find((p) => p.id === detail.project_id);
      if (!project || !client) throw new Error("This pull request's project isn't on this computer.");
      const created = await client.call("workspace.create", {
        request_id: requestId(),
        repo: { path: project.path },
        engine: engine.id,
        title,
        task: { text: task },
        // The repository too: one opened through this project from another repository is refused, not read as this
        // checkout's own pull request of that number.
        pull_request: { number: detail.number, repo: detail.repo },
      });
      if (adopt) adopt(created);
      else await refresh();
      return created;
    },
    [client, hub, computersCloud, detail, where, chat, projects, engines, settings, adopt, refresh, useOnCloud],
  );
  return { spawn, dialog: useOnCloud.dialog };
}

/** The choices of where the chat runs, for this pull request's repository (askWhere.ts). */
export function useAskPlaces(detail: PrDetail | undefined, open: boolean) {
  const hub = useSyncHub();
  const list = useChatList(hub);
  const cloud = useCloudComputers({ every: 15_000, enabled: open });
  const computers = useMemo(() => (detail ? askComputers(list, detail.repo, [hub?.homeRuntimeId()]) : []), [detail, list, hub]);
  return { computers, canMakeOne: cloud.view.state === "ready" && detail?.host === "github.com" };
}

/**
 * Where the chat runs: This Mac or Cloud, bare (words.md: a person never picks, names or wakes a Cloud computer; which
 * one holds the repository is askInCloud's to say). Only when Cloud can take it. `cloudOnly`: a window with no Mac, where
 * Cloud is the one place, said and not offered.
 */
export function AskWhereSelect({ where, onChange, computers, canMakeOne, cloudOnly = false }: { where: AskWhere; onChange: (where: AskWhere) => void; computers: ReadonlyArray<AskComputer>; canMakeOne: boolean; cloudOnly?: boolean }) {
  const cloud = askInCloud(computers, canMakeOne);
  if (!cloud) return null;
  if (cloudOnly) return <span className="text-[11.5px] text-muted-foreground">in Cloud</span>;
  const value = where.kind === "here" ? "here" : "cloud";
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
      On
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label={`Where the chat runs: ${askPlaceLabel(value)}`} className="h-6 gap-1 px-1.5 text-[11.5px] text-foreground">
            {askPlaceLabel(value)}
            <Icon icon={ArrowDown01Icon} className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[140px]">
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v === "cloud" ? cloud : ASK_HERE)}>
            {ASK_PLACES.map((place) => (
              <DropdownMenuRadioItem key={place} value={place}>
                {askPlaceLabel(place)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** The two places an Ask on the Review page runs, bare: never a computer's name, an asleep note or a new computer. */
export const ASK_PLACES = ["here", "cloud"] as const;
export const askPlaceLabel = (place: (typeof ASK_PLACES)[number]): string => (place === "here" ? THIS_COMPUTER : "Cloud");

interface Picked {
  readonly passage: Passage;
  /** The code line under the selection's end, when it is code: a line comment goes there. */
  readonly line: { readonly path: string; readonly line: number; readonly side: "new" | "old" } | null;
  /** Where the bar sits, in viewport px: above the selection's end. */
  readonly x: number;
  readonly y: number;
}

/** What the selection inside `root` is, or null. */
function readSelection(root: HTMLElement): Picked | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = sel.toString().trim();
  if (quote.length < 2) return null;
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  if (!el || !root.contains(el) || el.closest("input, textarea, [contenteditable]")) return null;
  const where = el.closest<HTMLElement>("[data-passage]")?.dataset.passage ?? "the pull request";
  const endEl = sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement;
  const row = endEl?.closest<HTMLElement>("[data-line]");
  const line = row?.dataset.path && row.dataset.line ? { path: row.dataset.path, line: Number(row.dataset.line), side: (row.dataset.side === "old" ? "old" : "new") as "new" | "old" } : null;
  const rects = range.getClientRects();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  // A long code line runs past what its scroller shows: anchor at the visible part.
  const clip = (endEl?.closest(".overflow-x-auto") ?? root).getBoundingClientRect();
  return { passage: { where: line ? `${line.path}:${line.line}` : where, quote }, line, x: Math.min(last.right, clip.right - 24), y: last.top };
}

export function SelectionBar({
  root,
  canComment,
  canAsk = true,
  inChat = false,
  onSpawn,
  onComment,
}: {
  root: RefObject<HTMLElement | null>;
  canComment: boolean;
  /** Ask and Fix can start a chat from here (from Cloud: when Cloud can take one). */
  canAsk?: boolean;
  /** A chat's own pull request tab: Ask and Fix go to that chat, so nothing says an agent starts. */
  inChat?: boolean;
  onSpawn: (mode: AskMode, text: string, passage: Passage) => Promise<unknown>;
  onComment: (line: NonNullable<Picked["line"]>, body: string) => Promise<unknown>;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [mode, setMode] = useState<AskMode | "comment" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** Why it failed, as thrown: a refusal at the kept-computer limit links to Settings > Computers (m-21). */
  const [error, setError] = useState<unknown>(null);
  const writing = mode !== null;
  const writingRef = useRef(false);
  writingRef.current = writing;
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => setBarWidth(barRef.current?.offsetWidth ?? 0), [picked, mode, error]);

  // Follow the selection while nothing is being written; a write keeps the passage it started from.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (writingRef.current || !root.current) return;
        setPicked(readSelection(root.current));
      });
    };
    document.addEventListener("selectionchange", update);
    // The page scrolls under a fixed bar: follow the selection (a bar being written in stays put).
    const scroller = root.current;
    scroller?.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      scroller?.removeEventListener("scroll", update);
    };
  }, [root]);

  const close = useCallback(() => {
    setMode(null);
    setText("");
    setError(null);
    setPicked(null);
  }, []);

  const start = useCallback((next: AskMode | "comment") => {
    setMode(next);
    setError(null);
  }, []);

  // A, F, C while a passage is selected and no field has focus.
  useEffect(() => {
    if (!picked || writing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const key = e.key.toLowerCase();
      if ((canAsk && (key === "a" || key === "f")) || (key === "c" && canComment && picked.line)) {
        e.preventDefault();
        start(key === "a" ? "ask" : key === "f" ? "fix" : "comment");
      } else if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        setPicked(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked, writing, canComment, canAsk, start]);

  if (!picked || (!canAsk && !(canComment && picked.line))) return null;
  const submit = async () => {
    if (!mode || busy) return;
    if (mode === "comment" && !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "comment") await onComment(picked.line!, text.trim());
      else await onSpawn(mode, text, picked.passage);
      window.getSelection()?.removeAllRanges();
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const left = Math.max(12, Math.min(window.innerWidth - barWidth - 12, picked.x - barWidth / 2));
  const top = Math.max(12, picked.y - (writing ? 74 : 44));
  const placeholder = selectionPlaceholder(mode, inChat);

  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label="Act on the selection"
      style={{ left, top, ...(writing ? { width: 380 } : {}) }}
      // Keep the selection: pressing a button must not clear it.
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== "INPUT" && e.preventDefault()}
      className="fixed z-50 w-max rounded-[12px] border border-border bg-popover p-1 text-popover-foreground shadow-overlay animate-in fade-in-0 zoom-in-95 duration-150 ease-snap"
    >
      {writing ? (
        <p className="truncate px-2 pb-1 pt-0.5 text-[11.5px] text-muted-foreground" title={picked.passage.quote}>
          About {picked.passage.where}
        </p>
      ) : null}
      {writing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-center gap-1.5"
        >
          <Glyph name={mode === "comment" ? "artifact-pr" : "engine-caveman"} className="ml-1.5 shrink-0" />
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}
            placeholder={placeholder}
            aria-label={placeholder}
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={busy || (mode === "comment" && !text.trim())}
            aria-label={mode === "comment" ? "Comment" : inChat ? "Send to this chat" : "Start agent"}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity duration-75 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={ArrowUp02Icon} className={cn("size-3.5", busy && "animate-pulse")} strokeWidth={2.25} />
          </button>
        </form>
      ) : (
        <div className="flex items-center">
          {canAsk ? <BarButton onClick={() => start("ask")} label="Ask" k="A" icon={<Glyph name="engine-caveman" className="size-3.5" />} /> : null}
          {canAsk ? <BarButton onClick={() => start("fix")} label="Fix" k="F" icon={<Icon icon={Wrench01Icon} className="size-3.5" />} /> : null}
          {canComment && picked.line ? <BarButton onClick={() => start("comment")} label="Comment" k="C" icon={<Icon icon={Comment01Icon} className="size-3.5" />} /> : null}
        </div>
      )}
      {error !== null ? (
        <div role="alert" className="flex flex-col gap-1 px-2 pb-1 pt-1.5 text-[12px]">
          <p className="text-destructive">{error instanceof Error ? error.message : String(error)}</p>
          <KeptLimitLink error={error} onGo={close} />
        </div>
      ) : null}
    </div>
  );
}

/** The selection bar's field: in a chat's own tab what is asked goes to the chat; elsewhere Enter starts an agent. */
export function selectionPlaceholder(mode: AskMode | "comment" | null, inChat: boolean): string {
  if (mode === "comment") return "Comment on this line";
  if (inChat) return mode === "fix" ? "What should change? Enter sends it to this chat" : "Ask about this. Enter sends it to this chat";
  return mode === "fix" ? "What should change? Enter starts an agent" : "Ask about this. Enter starts an agent";
}

function BarButton({ onClick, label, k, icon }: { onClick: () => void; label: string; k: string; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
      <Keycap className="bg-transparent">{k}</Keycap>
    </button>
  );
}
