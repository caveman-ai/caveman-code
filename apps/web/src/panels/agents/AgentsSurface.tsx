// Who is working for this workspace: its lead (when this one is a builder),
// the builders it split off, and the session's subagents. A pure read of
// state the app already has; rows 
// (MIT, apps/web/src/components/chat/ThreadRelationshipsControl.tsx @ ab3a3cd1).

import type { Workspace } from "@caveman-app/session-protocol";
import { cn } from "@caveman-app/ui/lib/cn";
import { Button } from "@caveman-app/ui/components/button";
import { Icon, SquareIcon, UserGroupIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PickLabel, pickCopy, RunnerMark, RunnerModel, runnerEdge, type Runner } from "@caveman-app/ui/components/runner-badge";
import { chatClientFor, livesHere, loadedTurn, requestId, useEveryChatSelector, useSession, useRuntimeSelector, useSyncHub } from "../../state/runtime.tsx";
import { agentsOf } from "../../state/now.ts";
import { childRunner, runnerFor } from "../../state/runner.ts";
import { SectionHeader, SurfaceEmpty } from "../chrome.tsx";
import type { SurfaceProps } from "../registry.ts";
import { openSurface } from "../store.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { builderRow, MARK, short, SUBAGENT_STATE, WORKSPACE_STATE, workspaceClock, type RowState } from "./states.ts";

/** Which of a lead's builders the tab lists (the result row's click: the ones left out), by id where known, else by title. */
export function onlyThese<T extends Pick<Workspace, "id" | "title">>(builders: ReadonlyArray<T>, only: { readonly ids: ReadonlyArray<string>; readonly titles: ReadonlyArray<string> } | undefined): ReadonlyArray<T> {
  if (!only) return builders;
  return builders.filter((b) => only.ids.includes(b.id) || only.titles.includes(b.title));
}

/** Where a builder runs, said only when it is not This Mac: "Cloud", or another Mac by its own name; never a Cloud computer's. */
export const builderPlace = (w: Pick<Workspace, "computer">): string | undefined => (livesHere(w) ? undefined : w.computer.kind === "this_mac" ? w.computer.label : "Cloud");

/** The clock the elapsed times read: one interval for the list, stopped while the tab is hidden. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export default function AgentsSurface({ workspaceId, active, tab }: SurfaceProps<"agents">) {
  // This window's own runtime, not the chat client of the pane this panel is in: each row talks to its own chat's computer.
  const client = useRuntimeSelector((v) => v.client);
  const hub = useSyncHub();
  // Its lead and builders on whichever computer they run (a chat on a Cloud computer this runtime never held).
  const chats = useEveryChatSelector(hub, (all) => all);
  const engines = useRuntimeSelector((v) => v.engines);
  const navigate = useNavigate();
  const now = useNow(active);
  const me = usePanelWorkspace();
  const { view } = useSession(me?.session_id ?? null);

  const leadId = me?.parent_workspace_id ?? chats.get(workspaceId)?.parent_workspace_id;
  const lead = leadId ? chats.get(leadId) : undefined;
  const every = [...chats.values()].filter((w) => w.parent_workspace_id === workspaceId && w.status !== "archived").sort((a, b) => a.created_at.localeCompare(b.created_at));
  // The result row opens this tab on the agents left out; "Show all" lists them all again.
  const only = tab.params.only;
  const shown = onlyThese(every, only);
  // An agent with a chat of its own is listed once, as that chat; the engine's own subagents come from this transcript.
  const agents = view ? agentsOf(view.items) : [];
  const subagents = only ? [] : agents.filter((s) => s.workspaceId === null || !every.some((b) => b.id === s.workspaceId));
  // How each one's run ended, as this chat's transcript saw it.
  const ended = (id: string) => agents.find((s) => s.workspaceId === id)?.status;

  if (!lead && every.length === 0 && subagents.length === 0) {
    return <SurfaceEmpty icon={UserGroupIcon} title="No agents yet">When the agent hands part of the work to another agent, it shows up here.</SurfaceEmpty>;
  }

  const workspaceRow = (w: Workspace) => {
    const place = builderPlace(w);
    const state = w.id === lead?.id ? WORKSPACE_STATE[w.status] : builderRow(w, ended(w.id));
    // A chat on another computer is stopped there (Sidebar's rowClient); this runtime's parked copy of it would ignore Stop.
    const rowClient = hub && hub.throughHub(w.session_id) ? chatClientFor(hub, w.session_id) : client;
    const turn = loadedTurn(rowClient, w.session_id);
    return (
      <AgentRow
        key={w.id}
        title={w.title}
        state={state}
        runner={runnerFor(engines, { engine: w.engine, model: turn?.model, effort: turn?.effort, runner: childRunner(w) })}
        time={workspaceClock(w, now).time}
        timeTitle={workspaceClock(w, now).title}
        // Where it runs, once that is not This Mac: Cloud, or another Mac by its own name.
        {...(place ? { where: place } : {})}
        onOpen={() => navigate(`/w/${w.id}`)}
        // Stop on one agent stops it and the agents under it, nothing else.
        onStop={rowClient && (w.status === "working" || w.status === "starting") ? () => void rowClient.call("turn.interrupt", { request_id: requestId(), session_id: w.session_id }) : undefined}
      />
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1">
      {lead ? (
        <Section title="Lead">
          {workspaceRow(lead)}
        </Section>
      ) : null}
      {only ? (
        <div role="status" className="flex min-h-8 items-center gap-2 px-2 pt-2 text-[12.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            Left out: {shown.length} of {every.length}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => openSurface(workspaceId, "agents", { only: undefined })}>
            Show all
          </Button>
        </div>
      ) : null}
      {/* One list, one kind, in the order they started. */}
      {shown.length + subagents.length > 0 ? (
        <Section title="Agents">
          {[
            ...shown.map((w) => ({ at: w.created_at, row: workspaceRow(w) })),
            ...subagents.map((s) => ({
              at: s.startedAt,
              row: (
                <AgentRow
                  key={s.id}
                  title={s.title}
                  state={SUBAGENT_STATE[s.status]}
                  runner={runnerFor(engines, { engine: s.engine ?? me?.engine ?? "acp", runner: s.runner })}
                  time={short((s.status === "running" ? now : s.finishedAt ? Date.parse(s.finishedAt) : now) - Date.parse(s.startedAt))}
                  timeTitle={s.status === "running" ? "Running for" : "Took"}
                  {...(s.workspaceId ? { onOpen: () => navigate(`/w/${s.workspaceId}`) } : {})}
                />
              ),
            })),
          ]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((entry) => entry.row)}
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeader className="px-2 pb-1 pt-3">{title}</SectionHeader>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

function AgentRow({
  title,
  state,
  runner,
  time,
  timeTitle,
  where,
  onOpen,
  onStop,
}: {
  title: string;
  state: RowState;
  runner: Runner;
  time: string | null;
  timeTitle: string;
  /** The computer it runs on, when that is worth saying. */
  where?: string;
  onOpen?: () => void;
  onStop?: (() => void) | undefined;
}) {
  const body = (
    <>
      <RunnerMark runner={runner} size={20} className="w-7" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px] text-foreground">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0", MARK[state.mark])} />
          {/* A long why ("Left out: conflicts in a.ts, b.ts") gives way before the rest of the line does; hover has it whole. */}
          <span title={state.hint ? `${state.label} · ${state.hint}` : state.label} className={cn("min-w-0 truncate", state.label.length <= 12 && "shrink-0", state.mark === "working" && "lucy-shimmer")}>
            {state.label}
          </span>
          <Dot />
          {runner.model || runner.effort ? <RunnerModel runner={runner} aria-hidden className="shrink-0" /> : <span aria-hidden className="shrink-0">{runner.engineLabel ?? "Agent"}</span>}
          {pickCopy(runner) ? (
            <>
              <Dot />
              <PickLabel runner={runner} />
            </>
          ) : null}
          {where ? (
            <>
              <Dot />
              <span className="min-w-0 truncate">{where}</span>
            </>
          ) : null}
        </span>
      </span>
      {time ? (
        <span title={timeTitle} className="shrink-0 self-start text-[12px] leading-[18px] tabular-nums text-[hsl(var(--subtle-foreground))]">
          {time}
        </span>
      ) : null}
    </>
  );
  const row = "flex w-full items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-2 text-left";
  const edge = runnerEdge(runner.engine, state.mark === "working");
  return (
    <li {...edge} className={cn(edge.className, "group/agent rounded-md")}>
      {onStop ? (
        <button
          type="button"
          aria-label={`Stop ${title}`}
          title="Stop"
          onClick={onStop}
          className="absolute right-2 top-1/2 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-md bg-accent text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/agent:opacity-100"
        >
          <Icon icon={SquareIcon} className="size-3" strokeWidth={2} />
        </button>
      ) : null}
      {/* The whole row opens it through an overlay button, so the pick label's tooltip trigger is never inside a button. */}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${title}`}
          className="absolute inset-0 rounded-md outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      ) : null}
      <div className={cn(row, "pointer-events-none relative [&_[tabindex]]:pointer-events-auto")}>{body}</div>
    </li>
  );
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-[hsl(var(--subtle-foreground))]">
      ·
    </span>
  );
}
