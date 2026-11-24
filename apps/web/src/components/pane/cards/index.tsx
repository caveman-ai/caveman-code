import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Client } from "@caveman-app/session-protocol/client";
import { hasSeveralSources, projectSources, workspaceSources, type Workspace } from "@caveman-app/session-protocol";
import { cn } from "@caveman-app/ui/lib/cn";
import { openSurface, usePanel, type SurfaceParams } from "../../../panels/store.ts";
import { builderState, SUBAGENT_STATE, WORKSPACE_STATE } from "../../../panels/agents/states.ts";
import { browserSource, computerSource } from "../../../panels/live/source.ts";
import { usePanelWorkspace } from "../../../panels/workspace.ts";
import { rowLine } from "../../../routes/inbox-model.ts";
import { agentsOf, firstLine, type AgentNow } from "../../../state/now.ts";
import { childRunner, runnerFor } from "../../../state/runner.ts";
import { CLOUD_HOSTED, loadedTurn, requestId, useEveryChatSelector, useSession, useRuntimeClient, useRuntimeSelector, useRuntime, useSyncHub } from "../../../state/runtime.tsx";
import { useArtifacts } from "../../artifacts/store.ts";
import { useRemoteControl } from "../../RemoteControl.tsx";
import { serverKey, stopChatServer, useChatServers, type ChatServer } from "../../../state/chat-servers.ts";
import { formerRoot } from "../../../state/sync/chats-view.ts";
import { artifactIcon } from "../../transcript/marks.tsx";
import { AgentsCard, type AgentRowView } from "./AgentsCard.tsx";
import { AgentView } from "./AgentView.tsx";
import { PaneCardsView } from "./PaneCardsView.tsx";
import { ScreenCard } from "./ScreenCard.tsx";
import { ServersCard } from "./ServersCard.tsx";

export { PaneCardsView };

/**
 * The Overview surface's body (panels/surfaces.tsx loads this module):
 * everything around the chat rather than in it. The session's cards, then
 * what changes while it works: the agent's browser or computer as a live
 * thumbnail, and every agent working for it. An agent opens over the
 * Overview with its own transcript; Esc or the back arrow returns. `agent`
 * opens one from outside (the sidebar's subagent rows), once: `onAgentShown`
 * clears the request so a later visit shows the cards.
 */
export function PaneCards({ workspaceId, active = true, agent, onAgentShown }: { workspaceId: string; active?: boolean; agent?: string | undefined; onAgentShown?: () => void }) {
  const { client } = useRuntimeClient();
  // Its builders on whichever computer they run (a chat on a Cloud computer this runtime never held).
  const chats = useEveryChatSelector(useSyncHub(), (all) => all);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const engines = useRuntimeSelector((v) => v.engines);
  const navigate = useNavigate();
  const workspace = usePanelWorkspace();
  // The chat's project: what names the repository of each source it works in.
  const project = useRuntimeSelector((v) => (workspace?.project_id ? v.projects.find((p) => p.id === workspace.project_id) : undefined));
  const { view, model, context } = useSession(workspace?.session_id ?? null);
  const artifacts = useArtifacts(workspace?.session_id ?? null);
  const connectors = useConnectors(client);
  const remote = useRemoteControl();
  const panel = usePanel(workspaceId);
  const list = useRef<HTMLDivElement>(null);
  const [pr, setPr] = useState<{ busy: boolean; url: string | null; error: string | null; list?: ReadonlyArray<{ source: string; number: number; url: string }> }>({ busy: false, url: null, error: null });
  const [open, setOpen] = useState<{ key: string; closing: boolean } | null>(null);
  const [heard, setHeard] = useState<Readonly<Record<string, Heard>>>({});
  const hear = useCallback((id: string, h: Heard) => setHeard((m) => (m[id]?.line?.text === h.line?.text && m[id]?.line?.live === h.line?.live && m[id]?.since === h.since ? m : { ...m, [id]: h })), []);
  useEffect(() => {
    if (!agent) return;
    setOpen({ key: agent, closing: false });
    onAgentShown?.();
  }, [agent]);
  // The dev servers this chat started, asked again right after a Stop.
  const [serversRead, setServersRead] = useState(0);
  const chatServers = useChatServers(client, workspaceId, active, serversRead);
  const [stopping, setStopping] = useState<string | null>(null);
  const [serverProblem, setServerProblem] = useState<string | null>(null);

  const builders = useMemo(
    () => [...chats.values()].filter((w) => w.parent_workspace_id === workspaceId && w.status !== "archived").sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [chats, workspaceId],
  );
  // A delegated agent already listed with the builders is not listed twice.
  const agents = useMemo(() => (view ? agentsOf(view.items) : []), [view]);
  const subagents = useMemo(() => agents.filter((s) => s.workspaceId === null || !builders.some((b) => b.id === s.workspaceId)), [agents, builders]);
  const anyLive = builders.some((b) => LIVE_STATUS.includes(b.status)) || subagents.some((s) => s.status === "running");
  const at = useClock(active && anyLive);

  // A closed agent hands focus back to its row, or to the first row in view when its own is folded away.
  const closed = (key: string) => {
    setOpen(null);
    requestAnimationFrame(() => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-agent-key]") ?? [])].filter((el) => !el.closest("[inert]"));
      (rows.find((el) => el.dataset.agentKey === key) ?? rows[0])?.focus({ preventScroll: true });
    });
  };

  if (!client || !workspace) return <p className="p-4 text-[13px] text-muted-foreground">This workspace is not on this runtime.</p>;

  const changes = model?.changes ?? [];
  const totals = changes.reduce((t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 });
  const createPr = async () => {
    setPr({ busy: true, url: null, error: null });
    try {
      const res = await client.call("git.pr", { request_id: requestId(), workspace_id: workspace.id, title: workspace.title });
      // A chat in several sources: one pull request per source it changed, listed for the person to open (never a tab each).
      const list = res.pull_requests?.map((r) => ({ source: r.source, number: r.number, url: r.url }));
      setPr({ busy: false, url: res.url, error: null, ...(list ? { list } : {}) });
      if (!list) window.open(res.url, "_blank", "noopener");
    } catch (e) {
      setPr({ busy: false, url: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const stopServer = async (server: ChatServer) => {
    if (stopping !== null) return;
    setStopping(serverKey(server));
    setServerProblem(null);
    try {
      await stopChatServer(client, workspace.id, server);
    } catch (e) {
      setServerProblem(e instanceof Error ? e.message : String(e));
    }
    setStopping(null);
    setServersRead((n) => n + 1);
  };

  // Every agent once: a builder from the workspace list, a subagent from this transcript.
  const entries: Entry[] = [
    ...builders.map((b): Entry => ({ kind: "workspace", workspace: b, row: builderRow(b, engines, client, heard[b.id], agents.find((s) => s.workspaceId === b.id)?.status) })),
    ...subagents.map((s): Entry => ({ kind: "subagent", agent: s, row: subagentRow(s, engines, workspace.engine) })),
  ];
  // The pager walks them as the card shows them: at work first, then finished.
  const ordered = [...entries.filter((e) => isLive(e.row)), ...entries.filter((e) => !isLive(e.row))];
  const index = open ? ordered.findIndex((e) => e.row.key === open.key) : -1;
  const shown = index >= 0 ? ordered[index]! : null;
  const agentTab = panel.tabs.some((t) => t.kind === "browser" && (t.params as SurfaceParams["browser"]).backend === "agent");
  const computerTab = panel.tabs.some((t) => t.kind === "computer");
  const browsing = agentTab || browserSource(client, workspaceId).state !== null;
  const onComputer = computerTab || computerSource(client, workspaceId).state !== null;
  const engineLabel = engines.find((e) => e.id === workspace.engine)?.label ?? workspace.engine;
  const repoLabel = workspaces.find((w) => w.id === workspace.id)?.repo ?? workspace.title;
  // A chat in several sources: each by name, with its repository as the project knows it (a plain folder says so).
  const known = project ? projectSources(project) : [];
  const sources = hasSeveralSources(workspace)
    ? workspaceSources(workspace).map((s) => ({
        name: s.name,
        line: s.folder ? "Folder" : (s.repository?.full_name ?? known.find((k) => k.name === s.name)?.repository?.full_name ?? ""),
        ...(s.folder ? { folder: true } : {}),
      }))
    : null;
  // An agent asked for before this transcript names it (still loading, or gone) leaves the cards in place.
  const away = open !== null && !open.closing && shown !== null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={list}
        inert={away}
        className={cn("min-h-0 flex-1 overflow-y-auto p-3 transition-[transform,opacity] duration-300 ease-drawer motion-reduce:transition-none", away && "-translate-x-3 opacity-40")}
      >
        <div className="flex flex-col gap-2">
          <PaneCardsView
            env={{
              repo: repoLabel,
              path: "path" in workspace.repo ? workspace.repo.path : null,
              branch: workspace.branch,
              computer: workspace.computer,
              ports: workspace.ports && Object.keys(workspace.ports).length > 0 ? workspace.ports : null,
              ...(sources ? { sources } : {}),
            }}
            context={context ? { used: context.used_tokens, window: context.window_tokens } : null}
            cacheReport={model?.cacheReport ?? null}
            connectors={connectors}
            outputs={artifacts.map((a) => ({ id: a.id, title: a.title, meta: a.meta, icon: artifactIcon(a.kind, a.kind === "file" ? { change: a.change, path: a.path } : undefined) }))}
            changes={totals}
            pr={pr}
            onOpenOutput={(artifactId) => openSurface(workspaceId, "artifact", { artifactId })}
            onShowOutputs={() => openSurface(workspaceId, "artifact", {})}
            onShowChanges={() => openSurface(workspaceId, "diff", {})}
            onCreatePr={() => void createPr()}
            // A Cloud computer is always linked: no switch there.
            {...(workspace.computer.kind !== "caveman_cloud"
              ? {
                  remote: {
                    on: remote.view.on,
                    detail: remote.view.detail,
                    // Turning it off from a client that came in through Cloud would cut that client off.
                    busy: remote.busy || CLOUD_HOSTED,
                    onChange: (on: boolean) => void remote.setOn(on),
                    ...(remote.view.step === "sign_in" || remote.view.step === "sign_in_again" ? { action: { label: "Sign in", onClick: () => void remote.signIn() } } : {}),
                    ...(remote.view.step === "not_registered" ? { action: { label: "Try again", onClick: () => void remote.signIn() } } : {}),
                  },
                }
              : {})}
          />
          <ServersCard
            servers={chatServers.servers}
            canStop={chatServers.canStop}
            stopping={stopping}
            problem={serverProblem}
            onOpen={(server) => openSurface(workspaceId, "browser", { url: server.url })}
            onStop={(server) => void stopServer(server)}
          />
          {browsing ? (
            <ScreenCard title="Browser" source={browserSource(client, workspaceId)} active={active && !away} engine={engineLabel} onOpen={() => openSurface(workspaceId, "browser", { backend: "agent" })} />
          ) : null}
          {onComputer ? <ScreenCard title="Computer" source={computerSource(client, workspaceId)} active={active && !away} engine={engineLabel} onOpen={() => openSurface(workspaceId, "computer", {})} /> : null}
          {entries.length > 0 ? <AgentsCard rows={entries.map((e) => e.row)} at={at} onOpen={(key) => setOpen({ key, closing: false })} /> : null}
          {builders.filter((b) => LIVE_STATUS.includes(b.status)).map((b) => (
            <BuilderWatch key={b.id} workspace={b} onHeard={hear} />
          ))}
        </div>
      </div>

      {open && shown ? (
        <AgentPage
          entry={shown}
          lead={workspace}
          index={index}
          count={ordered.length}
          closing={open.closing}
          at={at}
          engineLabel={engineLabel}
          onBack={() => setOpen({ key: open.key, closing: true })}
          onStep={(by) => {
            const next = ordered[index + by];
            if (next) setOpen({ key: next.row.key, closing: false });
          }}
          onClosed={() => closed(open.key)}
        />
      ) : null}
    </div>
  );
}

type Entry = { readonly row: AgentRowView } & ({ readonly kind: "workspace"; readonly workspace: Workspace } | { readonly kind: "subagent"; readonly agent: AgentNow });

const LIVE_STATUS: ReadonlyArray<Workspace["status"]> = ["starting", "working", "needs_input"];
const isLive = (r: AgentRowView) => r.state.mark === "working" || r.state.mark === "needs";

type Engines = ReturnType<typeof useRuntime>["engines"];

function subagentRow(s: AgentNow, engines: Engines, leadEngine: string): AgentRowView {
  return {
    key: s.id,
    title: s.title,
    state: s.asking ? WORKSPACE_STATE.needs_input : SUBAGENT_STATE[s.status],
    runner: runnerFor(engines, { engine: s.engine ?? leadEngine, runner: s.runner }),
    line: s.step ?? (s.summary ? { text: firstLine(s.summary), live: false } : null),
    startedAt: s.startedAt || null,
    finishedAt: s.finishedAt,
    depth: s.depth,
  };
}

/** What a working builder's own session says: its line now and when its turn began. */
type Heard = { readonly line: { readonly text: string; readonly live: boolean } | null; readonly since: string | null };

function builderRow(w: Workspace, engines: Engines, client: Client, heard: Heard | undefined, ended: AgentNow["status"] | undefined): AgentRowView {
  const turn = loadedTurn(client, w.session_id);
  const live = LIVE_STATUS.includes(w.status);
  return {
    key: w.id,
    title: w.title,
    state: builderState(w.status, ended),
    runner: runnerFor(engines, { engine: w.engine, model: turn?.model, effort: turn?.effort, runner: childRunner(w) }),
    line: live ? (heard?.line ?? null) : null,
    startedAt: live ? (heard?.since ?? null) : w.created_at,
    finishedAt: live ? null : w.updated_at,
    depth: 1,
  };
}

/**
 * Listens to a working builder's session (attached only while it works; the
 * store is shared with its chat, so opening it is instant) and reports what
 * it is doing, so its row in the Agents card can say.
 */
function BuilderWatch({ workspace: w, onHeard }: { workspace: Workspace; onHeard: (id: string, h: Heard) => void }) {
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const { view } = useSession(w.session_id);
  const wv = workspaces.find((x) => x.id === w.id);
  const line = wv && view ? rowLine(wv, view) : null;
  const since = view?.items.findLast((i) => i.kind === "user")?.at ?? null;
  useEffect(() => onHeard(w.id, { line, since }), [w.id, line?.text, line?.live, since, onHeard]);
  return null;
}

/**
 * An agent opened over the Overview. A builder or a delegated agent shows its
 * own session (attached while open, shared with its chat); an engine's
 * native subagent shows its part of this chat's transcript.
 */
function AgentPage({
  entry,
  lead,
  index,
  count,
  closing,
  at,
  engineLabel,
  onBack,
  onStep,
  onClosed,
}: {
  entry: Entry;
  lead: Workspace;
  index: number;
  count: number;
  closing: boolean;
  at: number;
  engineLabel: string;
  onBack: () => void;
  onStep: (by: -1 | 1) => void;
  onClosed: () => void;
}) {
  const { client } = useRuntimeClient();
  const raw = useRuntimeSelector((v) => v.raw);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const navigate = useNavigate();
  const own = entry.kind === "workspace" ? entry.workspace : entry.agent.workspaceId ? raw.get(entry.agent.workspaceId) : undefined;
  const { view } = useSession(own?.session_id ?? null);
  const items = own ? (view?.items ?? []) : entry.kind === "subagent" ? entry.agent.items : [];
  const running = own ? (view?.running ?? LIVE_STATUS.includes(own.status)) : entry.kind === "subagent" && entry.agent.status === "running";
  const sessionId = own?.session_id ?? lead.session_id;
  const ownView = own ? workspaces.find((w) => w.id === own.id) : undefined;
  // A builder's row learns what it does now from its session, once it is open.
  const row = own && entry.kind === "workspace" && ownView && view ? { ...entry.row, line: rowLine(ownView, view) } : entry.row;
  return (
    <AgentView
      row={row}
      items={items}
      running={running}
      summary={entry.kind === "subagent" ? entry.agent.summary : null}
      engineLabel={engineLabel}
      root={(own ?? lead).root_path ?? null}
      formerRoot={formerRoot(own ?? lead)}
      index={index}
      count={count}
      closing={closing}
      at={at}
      onBack={onBack}
      onStep={onStep}
      onClosed={onClosed}
      onAnswer={async (askId, response) => {
        await client?.call("ask.respond", { request_id: requestId(), session_id: sessionId, ask_id: askId, response });
      }}
      {...(own
        ? {
            onOpenChat: () => navigate(`/w/${own.id}`),
            onOpenArtifact: () => navigate(`/w/${own.id}`),
            ...(own.status === "working" || own.status === "starting" ? { onStop: () => void client?.call("turn.interrupt", { request_id: requestId(), session_id: own.session_id }).catch(() => undefined) } : {}),
          }
        : { workspaceId: lead.id })}
    />
  );
}

/** Epoch ms, ticking each second while `on` (an agent works and the tab shows); still otherwise. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

type Connectors = { servers: string[]; plugins: Array<{ name: string; description: string | null }> };
const connectorCache = new WeakMap<Client, Promise<Connectors>>();

/** plugin.list once per connection, shared by every pane. */
function useConnectors(client: Client | null): Connectors | null {
  const [value, setValue] = useState<Connectors | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    let p = connectorCache.get(client);
    if (!p) {
      p = client.call("plugin.list", {}).then((r) => {
        const on = r.plugins.filter((x) => x.enabled);
        return { servers: on.flatMap((x) => [...x.mcp_servers]), plugins: on.map((x) => ({ name: x.name, description: x.description ?? null })) };
      });
      connectorCache.set(client, p);
      p.catch(() => connectorCache.delete(client));
    }
    p.then(
      (v) => live && setValue(v),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return value;
}
