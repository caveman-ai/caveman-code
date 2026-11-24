import type { EngineDescriptor, Settings } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@caveman-app/ui/components/select";
import { Icon, ArrowRight01Icon, MoreHorizontalIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useId, useRef, useState } from "react";
import { NavLink } from "react-router";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";
import { refusalView, type RefusalView } from "../../state/cloud.ts";
import { useAccountRead } from "../../state/account.ts";
import { livesHere, useComputersCloud, useRuntimeClient, useRuntimeSelector, useSyncHub, useWebWindow } from "../../state/runtime.tsx";
import { useChatsOnComputer, useCloudComputers } from "../../state/useCloudComputers.ts";
import { chatsWord, cloudChanges, cloudRow, deleteWords, macRows, type CloudProject, type CloudRow, type CloudUsage, type ListedMac, type MacRow, type PlaceState } from "./computers-model.ts";
import { Connecting, useConnect } from "./Connections.tsx";
import { connectLabel } from "./connections-model.ts";
import { LID_SUMMARY_REFRESH_MS, lidLines, lidMoves, lidMovesWrite, lidSummaryKey, type LidLine, type LidSummary } from "./lid-summary.ts";
import { FlatList, FlatRow, State, useSaveSettings } from "./rows.tsx";
import { SyncChatsSettings } from "./SyncChats.tsx";

/**
 * Settings > Computers, one flat list after minimal settings lists: this Mac, each other Mac of the person's by its
 * name, and Cloud, each with how many chats run there and one state. Cloud opens to one line per project, whose menu
 * deletes it. Under the list: what happens to chats when this Mac sleeps, one dropdown, and under it only the chats
 * that will not carry on, each with why in a few words and its button.
 */
export function ComputersSettings() {
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const projects = useRuntimeSelector((v) => v.projects);
  const settings = useRuntimeSelector((v) => v.settings);
  const engines = useRuntimeSelector((v) => v.engines);
  const save = useSaveSettings();
  const cloud = useCloudComputers();
  const usage = useCloudUsage();
  const listed = useListedMacs();
  // A browser window is no Mac: it lists the person's Macs by name and Cloud, from Cloud alone when it uses no computer.
  const web = useWebWindow() !== null;
  const macs = macRows({ here: web ? null : THIS_COMPUTER, workspaces, lives: livesHere, listed, ownRuntimeId: cloud.runtimeId });
  const row = cloudRow({ view: cloud.view, workspaces, projects, usage });
  const known = (id: string) => workspaces.filter((w) => w.computer.id === id && w.state !== "archived").map((w) => w.title);
  return (
    <>
      <ComputersList macs={macs} cloud={row} known={known} onDelete={cloud.remove} />
      {web ? null : <SyncChatsSettings />}
      {!web && cloud.view.state === "ready" ? <WhenThisMacSleeps settings={settings} engines={engines} onSave={(patch) => void save(patch)} /> : null}
    </>
  );
}

/** How much of this month's plan Cloud has used and when the plan starts over (account.get): a percent and a day, never an amount. */
function useCloudUsage(): CloudUsage {
  const read = useAccountRead();
  const [usage, setUsage] = useState<CloudUsage>({});
  useEffect(() => {
    if (!read) return;
    let live = true;
    read().then(
      (account) => {
        const credits = account.credits;
        if (!live || !credits) return;
        const month = credits.windows.find((w) => w.window === "month") ?? credits.windows.at(-1);
        // The share is of a plan: one with no usage of its own (Free) has none to show.
        setUsage({ pct: credits.windows.length > 0 ? credits.computers?.used_pct : undefined, resetsAt: month?.resets_at });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);
  return usage;
}

/** The person's Macs as Cloud lists them, for the ones other than this: by name, and whether each was heard from lately. */
function useListedMacs(): ReadonlyArray<ListedMac> | undefined {
  const computers = useComputersCloud();
  const hub = useSyncHub();
  const api = computers ?? hub?.cloud() ?? null;
  const [macs, setMacs] = useState<ReadonlyArray<ListedMac> | undefined>(undefined);
  useEffect(() => {
    if (api === null) return;
    let live = true;
    const read = () =>
      api.list(false).then(
        (list) => live && setMacs(list.runtimes.filter((r) => r.kind === "laptop").map((r) => ({ runtime_id: r.runtime_id, name: r.name, online: r.online }))),
        () => undefined,
      );
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  return macs;
}

const OPENER = "rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";
const COUNT = "w-20 shrink-0 tabular-nums";

/** A state and, for a start that is held up or failed, what Cloud's own service wrote, behind a click. */
function PlaceLine({ state }: { state: PlaceState }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <State tone={state.tone}>{state.label}</State>
        {state.detail ? (
          <button type="button" aria-expanded={shown} onClick={() => setShown(!shown)} className={cn(OPENER, "text-[12.5px] underline underline-offset-2 hover:text-foreground")}>
            {shown ? "Hide details" : "Details"}
          </button>
        ) : null}
      </span>
      {shown && state.detail ? <span className="break-words pl-3.5 text-[12px]">{state.detail}</span> : null}
    </span>
  );
}

/** The list itself, from the model: Macs, then Cloud and, opened, its projects. Exported for its test and fixture. */
export function ComputersList({
  macs,
  cloud,
  known,
  onDelete,
  open: startOpen = false,
}: {
  macs: ReadonlyArray<MacRow>;
  cloud: CloudRow;
  /** The chats this window knows on a project in Cloud, for the delete question when Cloud's own lists can't be read. */
  known: (id: string) => ReadonlyArray<string>;
  onDelete: (id: string) => Promise<void>;
  /** Cloud's row opened at first (the fixture's states that show its projects). */
  open?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [asking, setAsking] = useState<CloudProject | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlyMap<string, RefusalView>>(new Map());
  const said = useChanges(cloud.projects);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const remove = async (p: CloudProject) => {
    // Its word flips at the press, not when Cloud answers; a refusal lands on its own line.
    setDeleting((now) => new Set(now).add(p.id));
    setRefused((now) => new Map([...now].filter(([id]) => id !== p.id)));
    try {
      await onDelete(p.id);
      // Its line (and the menu focus was on) is gone: focus goes to Cloud's row, not the page's top.
      opener.current?.focus();
    } catch (e) {
      setRefused((now) => new Map(now).set(p.id, refusalView(e)));
    } finally {
      setDeleting((now) => new Set([...now].filter((id) => id !== p.id)));
    }
  };
  return (
    <FlatList label="Computers">
      {macs.map((mac) => (
        <FlatRow key={mac.key} name={mac.name}>
          <span className={COUNT}>{chatsWord(mac.chats)}</span>
          {mac.state ? <State tone={mac.state.tone}>{mac.state.label}</State> : null}
        </FlatRow>
      ))}
      <FlatRow
        name={
          cloud.projects.length > 0 ? (
            <button ref={opener} type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className={cn(OPENER, "flex items-center gap-1")}>
              Cloud
              <Icon icon={ArrowRight01Icon} className={cn("size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            </button>
          ) : (
            "Cloud"
          )
        }
        action={
          cloud.action === "sign_in" ? (
            <Button asChild size="sm" variant="secondary">
              <NavLink to="/settings/account">Sign in</NavLink>
            </Button>
          ) : null
        }
      >
        <span className={COUNT}>{chatsWord(cloud.chats)}</span>
        <PlaceLine state={cloud.state} />
      </FlatRow>
      {open && cloud.projects.length > 0 ? (
        <div id={panel} className="divide-y divide-border/60">
          {cloud.projects.map((p) => {
            const refusal = refused.get(p.id);
            return (
              <div key={p.id}>
                <FlatRow
                  indent
                  name={p.name}
                  action={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`${p.name} in Cloud: options`} disabled={deleting.has(p.id)}>
                          <Icon icon={MoreHorizontalIcon} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[180px]">
                        <DropdownMenuItem onSelect={() => setAsking(p)}>Delete…</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                >
                  <span className={COUNT}>{chatsWord(p.chats)}</span>
                  {deleting.has(p.id) ? <State tone="busy">Deleting…</State> : <PlaceLine state={p.state} />}
                </FlatRow>
                {refusal ? (
                  <p role="alert" className="pb-2.5 pl-6 text-[12.5px] text-destructive">
                    {refusal.text}{" "}
                    {refusal.billing ? (
                      <NavLink to="/settings/plan" className={cn(OPENER, "text-foreground underline underline-offset-2")}>
                        See plans
                      </NavLink>
                    ) : null}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {/* Every change of state in Cloud, said once to a screen reader; mounted before anything changes, so it is heard. */}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      <DeleteProject asking={asking} known={known} onCancel={() => setAsking(null)} onConfirm={(p) => void remove(p)} />
    </FlatList>
  );
}

/** What the last poll changed (cloudChanges), kept until the next change. */
function useChanges(projects: ReadonlyArray<CloudProject>): string {
  const before = useRef<Map<string, { readonly name: string; readonly label: string }> | null>(null);
  const [said, setSaid] = useState("");
  const key = projects.map((p) => `${p.id}:${p.state.label}`).join("|");
  useEffect(() => {
    const line = cloudChanges(before.current, projects);
    before.current = new Map(projects.map((p) => [p.id, { name: p.name, label: p.state.label }]));
    if (line) setSaid(line);
    // Read again only when a project's state changed: the list itself is a new array at every poll.
  }, [key]);
  return said;
}

/** The one question on this screen: deleting a project from Cloud cannot be undone. The chats it archives are read from Cloud as it opens. */
function DeleteProject({ asking, known, onCancel, onConfirm }: { asking: CloudProject | null; known: (id: string) => ReadonlyArray<string>; onCancel: () => void; onConfirm: (p: CloudProject) => void }) {
  const chats = useChatsOnComputer(asking?.id ?? null);
  if (asking === null) return null;
  const words = deleteWords(asking.name, chats, known(asking.id));
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      title={words.title}
      description={words.description}
      confirmLabel={words.confirm}
      destructive
      // Nothing is deleted before the person has read what is in it (or that Cloud couldn't say).
      confirmDisabled={words.waiting}
      onConfirm={() => onConfirm(asking)}
    />
  );
}

/**
 * When this Mac sleeps: one dropdown, off until chosen ("Pause them" is what happens until then), and under it, while
 * chats keep going in Cloud, only the ones that will not. The runtime's own summary (cloud.lid.summary) is read again
 * as the settings or the chats change.
 */
function WhenThisMacSleeps({ settings, engines, onSave }: { settings: Settings | null; engines: ReadonlyArray<EngineDescriptor>; onSave: (patch: Partial<Settings>) => void }) {
  const { client } = useRuntimeClient();
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const projects = useRuntimeSelector((v) => v.projects);
  const [summary, setSummary] = useState<LidSummary | null>(null);
  // Each chat's state and last change too (m-18): a chat that starts working, stops or moves reads as it now is.
  const key = lidSummaryKey(settings, workspaces);
  const on = lidMoves(settings) === "on";
  useEffect(() => {
    if (!client || !on) return setSummary(null);
    let live = true;
    // A runtime from before the summary answers nothing here.
    const read = () =>
      client.call("cloud.lid.summary", {}).then(
        (out) => live && setSummary(out),
        () => live && setSummary(null),
      );
    void read();
    // And every 30 s while it shows: Cloud's side of it changes on its own.
    const timer = setInterval(() => void read(), LID_SUMMARY_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, key, on]);
  const bySession = new Map(workspaces.map((w) => [w.sessionId, w]));
  const lines =
    summary === null
      ? []
      : lidLines(summary, (id) => {
          const w = bySession.get(id);
          return w ? { title: w.title, engine: w.engine, sources: w.sources, folder: projects.find((p) => p.id === w.projectId)?.no_git === true } : undefined;
        });
  return <LidList settings={settings} lines={lines} engines={engines} onSave={onSave} />;
}

/** The block itself: the dropdown, and the exceptions only while chats keep going in Cloud. Exported for its test and fixture. */
export function LidList({ settings, lines, engines, onSave }: { settings: Pick<Settings, "sync_chats" | "move_to_cloud"> | null | undefined; lines: ReadonlyArray<LidLine>; engines: ReadonlyArray<EngineDescriptor>; onSave: (patch: Partial<Settings>) => void }) {
  const id = useId();
  const lid = lidMoves(settings);
  return (
    <FlatList label={`When ${thisComputer} sleeps`}>
      <FlatRow
        stack
        name={<label htmlFor={id}>When {thisComputer} sleeps</label>}
        action={
          <Select value={lid === "on" ? "on" : "off"} disabled={!settings} onValueChange={(v) => onSave(lidMovesWrite(v === "on"))}>
            <SelectTrigger id={id} className="h-8 w-[230px]">
              <SelectValue>{lid === "on" ? "Keep chats going in Cloud" : "Pause them"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on">Keep chats going in Cloud</SelectItem>
              <SelectItem value="off">Pause them</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {lid === "on" ? lines.map((line) => <LidRow key={line.session_id} line={line} engines={engines} onSave={onSave} />) : null}
    </FlatList>
  );
}

/** One chat that will not carry on: "Pauses · Claude isn't connected", and the button that fixes it where one click does. */
function LidRow({ line, engines, onSave }: { line: LidLine; engines: ReadonlyArray<EngineDescriptor>; onSave: (patch: Partial<Settings>) => void }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const fix = line.fix;
  const engine = fix?.kind === "connect" ? engines.find((e) => e.id === fix.engine) : undefined;
  const connect = useConnect(engine, client, refresh);
  // Only where this window can start the sign-in: anywhere else the button goes to where it is made.
  const here = engine?.auth.everywhere === "available";
  return (
    <FlatRow
      indent
      name={line.title}
      action={
        fix === undefined ? null : fix.kind === "connect" ? (
          connect.pending ? (
            connect.mine ? (
              <Button size="sm" variant="ghost" onClick={connect.cancel}>
                Cancel
              </Button>
            ) : null
          ) : here ? (
            <Button size="sm" variant="secondary" disabled={!client} onClick={() => connect.start()}>
              {connectLabel(fix.engine)}
            </Button>
          ) : (
            <Button asChild size="sm" variant="secondary">
              <NavLink to="/settings/models">Models & keys</NavLink>
            </Button>
          )
        ) : fix.kind === "agents_on" ? (
          <Button size="sm" variant="secondary" onClick={() => onSave({ move_other_engines: true })}>
            Turn on
          </Button>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <NavLink to={fix.kind === "sign_in" ? "/settings/account" : "/settings/plan"}>{fix.kind === "sign_in" ? "Sign in" : "See plans"}</NavLink>
          </Button>
        )
      }
    >
      {connect.pending ? (
        <State tone="busy">
          <Connecting connect={connect} codex={fix?.kind === "connect" && fix.engine === "codex"} />
        </State>
      ) : (
        <State tone={line.tone === "pauses" ? "warn" : "idle"}>
          <span title={line.detail}>
            {line.what} · {connect.failed ?? line.why}
          </span>
        </State>
      )}
    </FlatRow>
  );
}
