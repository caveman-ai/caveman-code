import type { ClaudeIdleCompaction, EngineDescriptor, Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Icon, ArrowRight01Icon, MoreHorizontalIcon, SquareLock02Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useId, useState, type ReactNode } from "react";
import { PanelMessage } from "../../components/WorkspacePanels.tsx";
import { thisComputer } from "../../lib/platform.ts";
import { connectsOnce, credentialsOutside, engineReady, setupHereMessage } from "../../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector, useWebWindow } from "../../state/runtime.tsx";
import { EngineAccounts } from "../EngineAccounts.tsx";
import { CavemanProviders } from "./CavemanProviders.tsx";
import { Connecting, useCloudConnectionList, useConnect, useNow } from "./Connections.tsx";
import { UNREACHABLE } from "./computers-model.ts";
import { agentsFromCloud, agentStatus, type AgentAction } from "./connections-model.ts";
import { WebSearchKeys } from "./WebSearchKeys.tsx";
import { FlatList, FlatRow, SettingRow, State, useSaveSettings } from "./rows.tsx";
import { andList } from "../onboarding/model.ts";
import { holdPlaces, localAgents, modelsLine, placesOf, type AgentPlaces } from "./local-agents.ts";

/**
 * Settings > Models & keys: one row per agent, after native integrations list. A row says one thing, in one colour
 * (where what it runs on works, or the one state that needs the person), and has one button; everything else (its
 * plans and keys, its models, its settings) opens on a click. Under the agents: which one new chats start on, and one
 * button that turns on every agent already installed and signed in on this computer (engine.scan).
 *
 * A page with no Mac app behind it (the web on a Cloud computer) signs in to nothing: it offers no scan and no
 * sign-in, and an agent with nothing to run on says where that is connected. A browser window with no computer at
 * all lists what Cloud holds: the plans and keys connected for every computer, by agent.
 */
export function ModelsAndKeysSettings() {
  const engines = useRuntimeSelector((v) => v.engines);
  const { client } = useRuntimeClient();
  const web = useWebWindow() !== null;
  if (web && client === null) return <CloudAgents />;
  if (engines.length === 0) return <PanelMessage>Loading…</PanelMessage>;
  return (
    <>
      <Agents engines={engines} />
      <Compare engines={engines} />
    </>
  );
}

/**
 * The agents a plan connects for, with the plans and keys Cloud holds for each, read from Cloud itself: what a browser
 * window shows with no computer behind it. A computer's own settings (which agent new chats start on, its local
 * subscriptions) are not here.
 */
function CloudAgents() {
  const { list, failed } = useCloudConnectionList();
  if (list === null) return <PanelMessage>{failed ? UNREACHABLE : "Loading…"}</PanelMessage>;
  return (
    <FlatList label="Agents">
      {agentsFromCloud(list).map((e) => (
        <AgentRow key={e.id} engine={e} />
      ))}
    </FlatList>
  );
}

/** The agent new chats start on: any that is ready, and the current one even while it is not. */
function DefaultEngine({ engines }: { engines: ReadonlyArray<EngineDescriptor> }) {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const id = useId();
  const current = engines.find((e) => e.id === settings?.default_engine);
  const choices = engines.filter((e) => engineReady(e) || e.id === current?.id);
  const pick = (next: string) => {
    if (next !== current?.id) void save({ default_engine: next as EngineDescriptor["id"] });
  };
  return (
    <FlatRow
      stack
      name={<label htmlFor={id}>New chats start on</label>}
      action={
        <Select value={current?.id ?? ""} onValueChange={(v) => pick(String(v))} disabled={choices.length === 0}>
          <SelectTrigger id={id} className="h-8 w-[200px]">
            <SelectValue placeholder="Nothing set up yet" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                <span className="flex items-center gap-2">
                  <EngineLogo engine={e.id} size={16} />
                  {e.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {/* Said only when the pick cannot start a chat: the agents are the rows above it. */}
      {current && !engineReady(current) ? <span className="text-warning">{defaultNotReady(current.label, choices.length > 1)}</span> : null}
    </FlatRow>
  );
}

/** What the default's row says while the agent picked cannot start a chat. */
export const defaultNotReady = (label: string, others: boolean) => (others ? `${label} isn't set up. Pick another.` : `${label} isn't set up.`);

type Found = Result<"engine.scan">["engines"][number]["found"];

/**
 * The agents, one row each: the ones on this computer, our Caveman agent, the rest under one line, then the default
 * and the scan (engine.scan turns on every agent installed and signed in here).
 */
function Agents({ engines }: { engines: ReadonlyArray<EngineDescriptor> }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [found, setFound] = useState<ReadonlyMap<string, Found> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [places, setPlaces] = useState<AgentPlaces | null>(null);
  const scan = async () => {
    if (!client) return;
    setScanning(true);
    setError(null);
    try {
      const res = await client.call("engine.scan", { request_id: requestId() });
      setFound(new Map(res.engines.map((e) => [e.engine, e.found])));
      await refresh();
      // The person asked for this sort: what it found moves up.
      setPlaces(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };
  const caveman = engines.find((e) => e.id === "caveman");
  const sorted = localAgents(engines.filter((e) => e.id !== "caveman"), found);
  // Agents stay where the page first put them (holdPlaces) until a scan sorts them again.
  const view = places === null ? sorted : holdPlaces(sorted, places);
  // React's adjust-while-rendering: the first layout (and the one after a scan) becomes the held one.
  if (places === null) setPlaces(placesOf(sorted));
  const label = (ids: ReadonlyArray<string>) => andList(ids.map((id) => engines.find((e) => e.id === id)?.label ?? id));
  const ready = found ? [...found].filter(([, f]) => f === "ready").map(([id]) => id) : [];
  const signIn = found ? [...found].filter(([, f]) => f === "signed_out").map(([id]) => id) : [];
  // A Cloud computer keeps nothing of its person's: nothing to find on it, and no agent is set up there.
  const outside = credentialsOutside(engines);
  return (
    <div className="flex flex-col gap-3">
      <FlatList label="Agents">
        {view.here.map((e) => (
          <AgentRow key={e.id} engine={e} />
        ))}
        {caveman ? (
          <AgentRow engine={caveman}>
            <CavemanProviders engine={caveman} />
            <WebSearchKeys />
          </AgentRow>
        ) : null}
        {!outside && view.rest.length > 0 ? (
          <>
            <FlatRow
              name={
                <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className={OPENER}>
                  More agents
                </button>
              }
              action={<Opener open={more} label="More agents" onClick={() => setMore(!more)} />}
            >
              <span className="min-w-0 truncate">{label(view.rest.map((e) => e.id))}</span>
            </FlatRow>
            {more ? view.rest.map((e) => <AgentRow key={e.id} engine={e} />) : null}
          </>
        ) : null}
        <DefaultEngine engines={engines} />
      </FlatList>
      {outside ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button size="sm" variant="secondary" disabled={!client || scanning} onClick={() => void scan()}>
            {scanning ? `Looking on ${thisComputer}…` : "Add local subscriptions"}
          </Button>
          {error || found !== null ? (
            <p role="status" className={cn("min-w-0 text-[12.5px]", error ? "text-destructive" : "text-muted-foreground")}>
              {error ?? (ready.length === 0 && signIn.length === 0 ? `Nothing signed in on ${thisComputer} yet.` : [ready.length > 0 ? `In use: ${label(ready)}.` : null, signIn.length > 0 ? `Sign in to use ${label(signIn)}.` : null].filter(Boolean).join(" "))}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

const OPENER = "rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** What opens a row when it has no button of its own: the quiet ⋯, or a chevron for a fold. */
function Opener({ open, label, controls, more, onClick }: { open: boolean; label: string; controls?: string; more?: boolean; onClick: () => void }) {
  return (
    <Button size="icon-sm" variant="ghost" aria-expanded={open} aria-controls={controls} aria-label={open ? `Close ${label}` : `Open ${label}`} onClick={onClick}>
      <Icon icon={more ? MoreHorizontalIcon : ArrowRight01Icon} className={cn(!more && "transition-transform motion-reduce:transition-none", !more && open && "rotate-90")} />
    </Button>
  );
}

const ACTION_LABEL: Record<AgentAction, string> = { use_everywhere: "Use everywhere", connect: "Sign in", reconnect: "Reconnect", sign_in: "Sign in", set_up: "Set up" };

/**
 * One agent: its status (agentStatus) and its one button. A plan's sign-in starts at the click, in the browser, with
 * no sheet in between, and shows on the row while it waits; the row opens onto the agent's plans, keys and settings.
 * `children`: what the row opens onto in place of the agent's accounts (the Caveman agent's own page).
 */
export function AgentRow({ engine: e, children }: { engine: EngineDescriptor; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const now = useNow();
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const connect = useConnect(e, client, refresh);
  const status = agentStatus(e, now);
  const act = (action: AgentAction) => {
    if (action === "use_everywhere" || action === "connect") connect.start();
    else if (action === "reconnect") connect.start({ replaces: status.account });
    else setOpen(true);
  };
  return (
    <>
      <FlatRow
        icon={<EngineLogo engine={e.id} size={20} />}
        name={
          <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className={OPENER}>
            {e.label}
          </button>
        }
        action={
          connect.pending ? (
            // Only the window that started a sign-in ends it: any other watches it.
            connect.mine ? (
              <Button size="sm" variant="ghost" onClick={connect.cancel}>
                Cancel
              </Button>
            ) : null
          ) : connect.failed !== undefined ? (
            <Button size="sm" variant="secondary" disabled={!client} onClick={() => connect.start(status.account ? { replaces: status.account } : {})}>
              Try again
            </Button>
          ) : status.action && !(open && (status.action === "sign_in" || status.action === "set_up")) ? (
            <Button size="sm" variant="secondary" disabled={!client} onClick={() => act(status.action!)}>
              {ACTION_LABEL[status.action]}
            </Button>
          ) : (
            <Opener open={open} label={e.label} controls={panel} more onClick={() => setOpen(!open)} />
          )
        }
      >
        {connect.pending ? (
          <State tone="busy">
            <Connecting connect={connect} codex={e.id === "codex"} />
          </State>
        ) : connect.failed !== undefined ? (
          <State tone="bad">
            <span role="alert">{connect.failed}</span>
          </State>
        ) : (
          <State tone={status.tone}>{status.text}</State>
        )}
      </FlatRow>
      {open ? (
        <div id={panel} className="mb-3 ml-2 divide-y divide-border/60 border-l border-border/60 pl-6">
          {children ?? (
            <>
              {e.auth.message && !engineReady(e) && e.auth.no_sign_in_here !== true ? <p className="py-2.5 text-[12.5px] text-muted-foreground">{setupHereMessage(e.auth.message)}</p> : null}
              {e.upgrade ? <p className="py-2.5 text-[12.5px] text-warning">{e.upgrade.hint}</p> : null}
              <EngineAccounts engine={e} rows />
              <EngineFacts engine={e} />
              {/* A computer's setting: not on a page with no computer behind it. */}
              {e.id === "claude-agent" && client ? <ClaudeIdleCompactionRow /> : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

const IDLE_COMPACTION: ReadonlyArray<{ readonly value: ClaudeIdleCompaction; readonly label: string }> = [
  { value: "on_return", label: "When you come back" },
  { value: "before_cache_expires", label: "Before the cache expires (beta)" },
  { value: "off", label: "Never" },
];

/** Claude Agent: when a long idle chat is compacted (Settings' claude_idle_compaction). */
function ClaudeIdleCompactionRow() {
  const settings = useRuntimeSelector((v) => v.settings);
  const save = useSaveSettings();
  const id = useId();
  return (
    <SettingRow
      id={id}
      label="Compact idle chats"
    >
      <Select
        disabled={!settings}
        value={settings?.claude_idle_compaction ?? "on_return"}
        onValueChange={(mode) => void save({ claude_idle_compaction: mode as ClaudeIdleCompaction })}
      >
        <SelectTrigger id={id} aria-label="Compact idle Claude Agent chats" className="h-8 w-[220px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {IDLE_COMPACTION.map((mode) => (
            <SelectItem key={mode.value} value={mode.value}>
              {mode.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/** An engine's plan use as it reports it, and its models: rows under its accounts. */
function EngineFacts({ engine: e }: { engine: EngineDescriptor }) {
  return (
    <>
      {e.usage_limits && e.usage_limits.length > 0 ? (
        <SettingRow label="Plan used" description={e.usage_on_credits ? "Now running on credits." : undefined}>
          <span className="text-[13px] tabular-nums text-muted-foreground">{e.usage_limits.map((w) => `${w.label} ${Math.round(w.used_percent)}%`).join(" · ")}</span>
        </SettingRow>
      ) : null}
      {/* One line however narrow the pane: what does not fit is in its tooltip and the picker. */}
      {e.models.length > 0 ? <SettingRow label="Models" description={<span title={modelsLine(e.models)} className="block truncate">{modelsLine(e.models)}</span>} /> : null}
    </>
  );
}

/** What each agent can do, folded away under one line: most people never need it. */
function Compare({ engines }: { engines: ReadonlyArray<EngineDescriptor> }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon icon={ArrowRight01Icon} className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Compare what each agent can do
      </summary>
      <div className="overflow-x-auto border-y border-border/60">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[12px] text-muted-foreground">
              <th className="h-10 text-left font-normal" />
              {engines.map((e) => (
                <th key={e.id} scope="col" title={e.label} className="h-10 px-2 text-center font-normal">
                  <span className="inline-flex justify-center">
                    <EngineLogo engine={e.id} size={16} label={e.label} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_ROWS.map((row) => (
              <tr key={row.label} className="border-t border-border/60">
                <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                  {row.label}
                </th>
                {engines.map((e) => (
                  <td key={e.id} className="px-2 py-2.5 text-center text-[12px] text-muted-foreground">
                    {row.cell(e)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-2 py-3 text-[12.5px] text-muted-foreground">
        <Icon icon={SquareLock02Icon} className="size-3.5 shrink-0" />
        {connectsOnce(engines) ? (
          <span>
            Claude Agent runs the official <code className="font-mono">claude</code> on your plan's limits. Caveman never reads {thisComputer}'s own Claude login.
          </span>
        ) : (
          <span>
            Claude Agent runs your installed <code className="font-mono">claude</code> on its own login and your plan's limits. Caveman never reads the token.
          </span>
        )}
      </p>
    </details>
  );
}

const yes = <Icon icon={Tick02Icon} className="mx-auto size-3.5 text-success" aria-label="Yes" />;
const no = <span aria-label="No">—</span>;
const CAPABILITY_ROWS: ReadonlyArray<{ label: string; cell: (e: EngineDescriptor) => React.ReactNode }> = [
  { label: "Structured transcript, diff and terminal", cell: (e) => (e.capabilities.structured ? yes : no) },
  { label: "Move between computers", cell: (e) => (e.capabilities.resume_across_machines ? yes : "handoff brief") },
  { label: "Steer mid-turn", cell: (e) => (e.capabilities.steer ? yes : "queue") },
  { label: "Fork a chat", cell: (e) => (e.capabilities.fork ? yes : no) },
  { label: "Approvals and questions", cell: (e) => (e.capabilities.approvals ? yes : no) },
  { label: "Plans and todos", cell: (e) => (e.capabilities.plans ? yes : no) },
  { label: "Subagents", cell: (e) => (e.capabilities.subagents ? yes : no) },
  { label: "Images", cell: (e) => (e.capabilities.images ? yes : no) },
  { label: "Spaces: skills, MCP servers, rules", cell: (e) => (e.capabilities.mcp ? yes : no) },
  { label: "Tool hooks", cell: (e) => (e.capabilities.tool_hooks ? yes : no) },
];
