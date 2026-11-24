// What the Chief's tool calls look like in its transcript (state/chief-model.ts
// chiefCards): a started chat you can open, Suggested chats with Start all, a
// remembered note with a guarded Undo, a question with its recommended answer,
// and one quiet line for everything else. No card shows cost (AGENTS.md).
import { Button } from "@caveman-app/ui/components/button";
import type { ChiefItem } from "@caveman-app/session-protocol";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@caveman-app/ui/ai/trace";
import { StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { COMPUTER_KIND_ICON, type PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ProjectBadge, ProjectPicker } from "../components/ProjectPicker.tsx";
import { EngineMark } from "../components/transcript/marks.tsx";
import { arrivedJustNow, CHIEF_TOOLS, chiefCards, chiefTool, suggestedSettled, suggestedStatus, type ChiefCard, type SuggestedChat, type SuggestedStatus } from "../state/chief-model.ts";
import type { WorkspaceView } from "../state/model.ts";
import type { ToolItem } from "../state/transcript-model.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";
import { useFresh } from "./inbox-parts.tsx";
import { PrMark } from "./review/parts.tsx";
import { openSurface } from "../panels/store.ts";
import "./review/surface.tsx";
import "./inbox.css";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** What the cards reach without threading props: the board, the chats, and the moves a card can make. */
export interface ChiefActions {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly items: ReadonlyArray<ChiefItem>;
  readonly projectName: (projectId: string) => string;
  /** ask tool ids you have answered since (a message of yours came after). */
  readonly answered: ReadonlySet<string>;
  readonly open: (workspaceId: string) => void;
  /** chief.start: the same call the Queue's Start makes, so a chat started here is started there too. */
  readonly startAll: (itemIds: ReadonlyArray<string>) => Promise<void>;
  /** Drops a proposed item (the Queue's Drop, with its Undo). */
  readonly dismiss: (itemId: string) => void;
  /** The project a proposed chat is for, when the Chief's was a guess. */
  readonly setProjects: (itemId: string, projectIds: ReadonlyArray<string>) => Promise<void>;
  readonly reply: (text: string) => Promise<void>;
  /** memory.undo, only while the note's head is still `vid`. */
  readonly undo: (noteId: string, vid: string) => Promise<"undone" | "changed">;
  /** The Chief these cards are from, by name ("the Chief" on a runtime without names). */
  readonly name: string;
}

const ChiefActionsContext = createContext<ChiefActions | null>(null);
export const ChiefActionsProvider = ChiefActionsContext.Provider;
export const useActions = () => {
  const a = useContext(ChiefActionsContext);
  if (!a) throw new Error("Chief cards outside ChiefActionsProvider");
  return a;
};

/** The names the Chief's runtime gives its tools; anything else renders as a normal tool run. */
export const isChiefTool = (t: ToolItem) => CHIEF_TOOLS.has(chiefTool(t.name));

/** One run of the Chief's tool calls as its cards. */
export function ChiefToolCards({ tools }: { tools: ReadonlyArray<ToolItem> }) {
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {chiefCards(tools).map((card) => (
        <Card key={card.id} card={card} />
      ))}
    </div>
  );
}

function Card({ card }: { card: ChiefCard }) {
  switch (card.kind) {
    case "started":
      return <Started card={card} />;
    case "suggested":
      return <Suggested chats={card.chats} at={card.at} />;
    case "remembered":
      return <Remembered card={card} />;
    case "ask":
      return <Ask card={card} />;
    case "line":
      return <QuietLine card={card} />;
  }
}

const STATE: Record<WorkspaceView["state"], { icon: PixelIconName; label: string }> = {
  needs_input: { icon: "state-needs-input", label: "Needs you" },
  working: { icon: "state-working", label: "Working" },
  queued: { icon: "state-queued", label: "Waiting" },
  completed: { icon: "state-done", label: "Done" },
  failed: { icon: "state-failed", label: "Failed" },
  archived: { icon: "state-done", label: "Archived" },
};

/** A chat the Chief started: the card is the chat; it opens it. */
function Started({ card }: { card: Extract<ChiefCard, { kind: "started" }> }) {
  const { workspaces, projectName, open } = useActions();
  if (card.running)
    return (
      <Trace>
        <TraceLine status="running">
          <TraceIcon>
            <StateMark name="state-working" animate />
          </TraceIcon>
          <TraceTitle>
            Starting <span className="text-secondary-foreground">{card.title}</span>
          </TraceTitle>
        </TraceLine>
      </Trace>
    );
  return (
    <div className="flex flex-col gap-1">
      {card.chats.map((chat) => {
        const w = workspaces.find((x) => x.id === chat.workspaceId);
        const state = w ? STATE[w.state] : null;
        const where = card.projects.map(projectName).join(", ") || w?.repo || "";
        return (
          <button
            key={chat.workspaceId}
            type="button"
            disabled={!w}
            onClick={() => open(chat.workspaceId)}
            className="group flex h-10 w-full max-w-[560px] items-center gap-2.5 rounded-lg border border-border bg-card px-3 text-left outline-none transition-colors duration-75 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <EngineMark engine={w?.engine.id ?? "caveman"} className="shrink-0" />
            <span className="min-w-0 shrink truncate text-[13px] text-foreground">{w?.title ?? chat.title}</span>
            {where ? <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{where}</span> : <span className="flex-1" />}
            {w?.pullRequest ? (
              <PrMark
                pr={w.pullRequest}
                projectId={w.projectId}
                // The chat opens with its review beside it.
                onOpen={(pr) => {
                  openSurface(chat.workspaceId, "pr", pr);
                  open(chat.workspaceId);
                }}
              />
            ) : null}
            {w ? <Glyph name={COMPUTER_KIND_ICON[w.computer.kind] ?? "computer-this-mac"} label={w.computer.label} className="shrink-0 text-muted-foreground" /> : null}
            {state ? (
              <span className={cn("flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground", w?.state === "needs_input" && "text-warning")}>
                <Glyph name={state.icon} />
                {state.label}
              </span>
            ) : (
              <span className="shrink-0 text-[12px] text-muted-foreground">Not on this computer</span>
            )}
            <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover:translate-x-0.5" />
          </button>
        );
      })}
    </div>
  );
}

const SUGGESTED_ICON: Record<SuggestedStatus, PixelIconName> = { waiting: "state-needs-input", started: "state-working", dismissed: "state-done", gone: "state-queued" };
const SUGGESTED_WORD: Record<SuggestedStatus, string> = { waiting: "", started: "Started", dismissed: "Dismissed", gone: "In the Queue" };

/** How long a settled Suggested card takes to leave (inbox.css chief-suggested-out), before it renders nothing. */
export const SUGGESTED_LEAVE_MS = 220;

/**
 * Chats the Chief would start and asks you about first, right where it said so.
 * Each one starts or is dismissed on its own (Start all when there are several),
 * and a guessed project can be changed first. The card reads the board, so it
 * and the Queue's row always agree: there is one item, in one state. Once none
 * of them waits on you any more, the card fades out and leaves the page: the
 * Queue and the Work tab hold the work from then on.
 */
function Suggested({ chats, at }: { chats: ReadonlyArray<SuggestedChat>; at: string }) {
  const { items, workspaces, projectName, open, startAll, dismiss, setProjects, name } = useActions();
  const githubProjects = useRuntimeSelector((v) => v.projects.filter((p) => p.repository?.host === "github.com").map((p) => p.id).join(" "));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = chats.map((chat) => ({ chat, item: chat.itemId ? items.find((i) => i.id === chat.itemId) : undefined, status: suggestedStatus(chat, items) }));
  const waiting = rows.flatMap((r) => (r.status === "waiting" && r.chat.itemId ? [r.chat.itemId] : []));
  // Settled while on screen, it leaves with a short fade; settled before the page opened, it was never here. The
  // effect keys on `settled` alone: the fade's own re-render must not re-run it, or its cleanup would cancel the
  // unmount timer and the card would linger invisible.
  const settled = suggestedSettled(chats, items);
  const [phase, setPhase] = useState<"here" | "leaving" | "gone">(() => (settled ? "gone" : "here"));
  useEffect(() => {
    if (!settled) return;
    setPhase((p) => (p === "here" ? "leaving" : p));
    const t = window.setTimeout(() => setPhase("gone"), SUGGESTED_LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [settled]);
  // It just landed and still waits on you: it arrives with its glow. Reopening the page later shows it calm.
  const { fresh, seen } = useFresh(waiting.length > 0 && arrivedJustNow(at));
  const run = (key: string, work: Promise<void>) => {
    setBusy(key);
    setProblem(null);
    work.then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  if (phase === "gone") return null;
  return (
    <section
      aria-label="Suggested chats"
      data-fresh={fresh || undefined}
      data-leaving={phase === "leaving" || undefined}
      onPointerEnter={seen}
      onFocus={seen}
      className={cn(
        "w-full max-w-[560px] rounded-xl border bg-card transition-[box-shadow,background-color] duration-300",
        waiting.length > 0 ? "border-warning/50" : "border-border",
        fresh && "chief-suggested-in chief-fresh",
        phase === "leaving" && "chief-suggested-out",
      )}
    >
      <header className="flex h-9 items-center gap-2 px-3 text-[12px] text-muted-foreground">
        <Glyph name={waiting.length > 0 ? "state-needs-input" : "tool-subagent"} className={cn(waiting.length > 0 && "text-warning")} />
        <span className={waiting.length > 0 ? "text-foreground" : undefined}>{waiting.length > 0 ? "Suggested: start when you are ready" : "Suggested chats"}</span>
        <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{chats.length}</span>
      </header>
      <ul className="flex flex-col border-t border-border/60 py-1">
        {rows.map(({ chat, item, status }, i) => {
          const projects = item?.project_ids ?? chat.projects;
          const where = projects.map(projectName).join(", ");
          const chatOf = item?.workspace_ids.map((id) => workspaces.find((w) => w.id === id)).find(Boolean);
          const id = chat.itemId;
          return (
            <li key={id ?? i} className="flex flex-col gap-0.5 px-3 py-2">
              <div className="flex h-7 items-center gap-2">
                <Glyph name={SUGGESTED_ICON[status]} className={cn("shrink-0", status === "waiting" ? "text-warning" : "text-muted-foreground")} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", status === "dismissed" ? "text-muted-foreground line-through decoration-muted-foreground/60" : "text-foreground")} title={item?.text}>
                  {item?.title ?? chat.title}
                </span>
                {status === "waiting" && id ? (
                  <>
                    <Button type="button" disabled={busy !== null} onClick={() => run(id, startAll([id]))} size="sm" className="shrink-0">
                      Start
                    </Button>
                    <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => dismiss(id)} size="sm" className="shrink-0">
                      Dismiss
                    </Button>
                  </>
                ) : status === "started" && chatOf ? (
                  <Button type="button" variant="ghost" onClick={() => open(chatOf.id)} size="sm" className="shrink-0">
                    Open
                  </Button>
                ) : (
                  <span className="shrink-0 text-[12px] text-muted-foreground">{SUGGESTED_WORD[status]}</span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[12px] text-muted-foreground">
                {status === "waiting" && id && projects.length === 1 ? (
                  <ProjectPicker value={projects[0]!} onChange={(next) => run(`${id}:project`, setProjects(id, [next]))}>
                    <button type="button" disabled={busy !== null} className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 -ml-1.5 outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      <ProjectBadge github={githubProjects.split(" ").includes(projects[0]!)} />
                      <span className="truncate underline decoration-border underline-offset-2">{where}</span>
                      <Icon icon={ArrowRight01Icon} className="size-3 shrink-0 rotate-90 opacity-60" />
                    </button>
                  </ProjectPicker>
                ) : (
                  <span className="truncate">{where || "No project"}</span>
                )}
                {chat.guess && status === "waiting" ? <span className="shrink-0 text-warning">· the project is a guess</span> : null}
              </div>
              {chat.brief ? (
                <p className="truncate pl-[22px] text-[12px] text-muted-foreground" title={chat.brief}>
                  {chat.brief}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem || waiting.length > 1 ? (
        <footer className="flex h-11 items-center gap-2 border-t border-border/60 px-3">
          {problem ? <span className="min-w-0 flex-1 truncate text-[12px] text-destructive">{problem}</span> : <span className="flex-1 text-[12px] text-muted-foreground">Or tell {name} what to change</span>}
          {waiting.length > 1 ? (
            <Button type="button" disabled={busy !== null} onClick={() => run("all", startAll(waiting))} size="sm" className="shrink-0">
              Start all
            </Button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

/** "Remembered: …  Undo". Undo goes through only while the note is still what the Chief wrote. */
function Remembered({ card }: { card: Extract<ChiefCard, { kind: "remembered" }> }) {
  const { undo } = useActions();
  const [state, setState] = useState<"kept" | "busy" | "undone" | "changed" | "error">("kept");
  if (card.failed)
    return (
      <Line icon="bookmark" tone="error">
        <span className="min-w-0 truncate">
          Could not remember <span className="text-secondary-foreground">“{card.text}”</span>
          {card.reason ? `: ${card.reason}` : null}
        </span>
      </Line>
    );
  const after: Record<typeof state, ReactNode> = {
    kept: null,
    busy: null,
    undone: <span className="text-muted-foreground">Undone</span>,
    changed: (
      <Link to="/settings/memory" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
        Changed since: open in Memory
      </Link>
    ),
    error: <span className="text-destructive">Undo failed</span>,
  };
  return (
    <Line icon="bookmark">
      <span className={cn("min-w-0 truncate", state === "undone" && "line-through decoration-muted-foreground/60")} title={card.text}>
        Remembered <span className="text-foreground">{card.text}</span>
      </span>
      {card.noteId && card.vid && (state === "kept" || state === "busy") ? (
        <button
          type="button"
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            undo(card.noteId!, card.vid!).then(setState, () => setState("error"));
          }}
          className="ml-1 h-6 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Undo
        </button>
      ) : (
        <span className="ml-1 shrink-0 text-[12px]">{after[state]}</span>
      )}
    </Line>
  );
}

/** One question with the Chief's recommended answer. Your reply, or the recommendation, is the next note. */
function Ask({ card }: { card: Extract<ChiefCard, { kind: "ask" }> }) {
  const { answered, reply, name: asker, items } = useActions();
  const done = answered.has(card.id);
  // While it waits: when the Chief goes ahead with its recommendation by itself, unless you answer first.
  const asked = card.itemId === null ? undefined : items.find((i) => i.id === card.itemId)?.asked;
  const goesAhead = !done && asked?.question === card.question && asked.go_ahead_at ? new Date(asked.go_ahead_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label={`${asker} asks`} className={cn("w-full max-w-[560px] rounded-xl border bg-card px-4 py-3", done ? "border-border opacity-70" : "border-warning/40")}>
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Glyph name="state-needs-input" />
        {done ? "Answered" : `${asker} asks`}
      </div>
      <p className="mt-1.5 text-[14px] leading-[21px] text-foreground">{card.question}</p>
      {card.recommended ? (
        <div className="mt-2.5 flex items-center gap-3 rounded-lg bg-secondary px-3 py-2">
          <span className="min-w-0 flex-1 text-[13px] leading-5">
            <span className="text-muted-foreground">Recommended </span>
            <span className="text-foreground">{card.recommended}</span>
          </span>
          {done ? null : (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                reply(card.recommended!).finally(() => setBusy(false));
              }}
              variant="secondary"
              size="sm"
              className="shrink-0"
            >
              Use this
            </Button>
          )}
        </div>
      ) : null}
      {done ? null : (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {goesAhead ? `${asker} goes ahead with the recommendation at ${goesAhead} unless you answer. ` : ""}Or answer in your own words below.
        </p>
      )}
    </section>
  );
}

const LINE_ICON: Record<string, PixelIconName> = {
  chat_start: "state-queued",
  queue_add: "state-queued",
  queue_update: "state-queued",
  queue_drop: "state-queued",
  queue_order: "state-queued",
  schedule: "state-sleeping",
  chat_send: "tool-subagent",
  chat_digest: "tool-read",
  chat_stop: "tool-subagent",
  chat_answer: "tool-subagent",
  memory_sql: "bookmark",
  view_open: "tool-browser",
  view_close: "tool-browser",
};

function QuietLine({ card }: { card: Extract<ChiefCard, { kind: "line" }> }) {
  const { workspaces, open } = useActions();
  const w = card.workspaceId ? workspaces.find((x) => x.id === card.workspaceId) : undefined;
  return (
    <Line icon={LINE_ICON[card.tool] ?? "tool-other"} tone={card.failed ? "error" : undefined}>
      <span className="min-w-0 truncate" title={card.text}>
        {card.text}
      </span>
      {w ? (
        <button type="button" onClick={() => open(w.id)} className="ml-1 min-w-0 truncate text-secondary-foreground underline-offset-2 outline-none hover:underline focus-visible:underline">
          {w.title}
        </button>
      ) : null}
    </Line>
  );
}

function Line({ icon, tone, children }: { icon: PixelIconName; tone?: "error" | undefined; children: ReactNode }) {
  return (
    <Trace>
      <TraceLine status={tone}>
        <TraceIcon>
          <Glyph name={icon} />
        </TraceIcon>
        <span className="flex min-w-0 items-center">{children}</span>
      </TraceLine>
    </Trace>
  );
}
