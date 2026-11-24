// A chat's actions (docs/computer-config.md "Actions"): the project's commands
// one click away, each with how its last run went. The team's come from the
// chat's checkout ([run] in computer.toml, then .caveman/actions.toml), the
// person's own are the project's on this computer, and package.json scripts
// that no action runs yet are one click from being one. A run starts in the
// background and lives in its terminal tab; clicking the row shows it.

import type { ActionIcon, ProjectAction } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, Cancel01Icon, Delete02Icon, PencilEdit02Icon, PlayIcon, SquareIcon, Tick02Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  actionIcon,
  actionId,
  actionKey,
  runLength,
  savePersonalActions,
  stopAction,
  useActionRuns,
  useActionsList,
  type ActionRun,
  type ListedAction,
} from "../../state/actions.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton, QuietButton, SectionHeader, SurfaceEmpty } from "../chrome.tsx";
import type { SurfaceProps } from "../registry.ts";
import { openSurface } from "../store.ts";
import { runInTerminal } from "../terminal/run.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { ACTION_ICONS, ICON_ORDER } from "./icons.ts";

/** Ctrl-C, or a signal: the person stopped it, which is not a failure. */
const stopped = (run: ActionRun) => run.state === "failed" && (run.code === null || run.code === 130);

/** A clock for the running rows' elapsed time: ticks only while something runs and the tab shows. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

type Editing = { readonly kind: "new" } | { readonly kind: "edit"; readonly id: string } | null;

export default function ActionsSurface({ workspaceId, active }: SurfaceProps<"actions">) {
  const { client } = useRuntimeClient();
  const workspace = usePanelWorkspace();
  const projectId = workspace?.project_id;
  const port = workspace?.ports ? Object.values(workspace.ports)[0] : undefined;
  const { list, failure, reload } = useActionsList(workspaceId, active);
  const { runs, reload: reloadRuns } = useActionRuns(workspaceId);
  const now = useNow(active && [...runs.values()].some((r) => r.state === "running"));
  const [editing, setEditing] = useState<Editing>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (failure && !list) return <SurfaceEmpty title="Couldn't read this chat's actions">{failure}</SurfaceEmpty>;
  if (!list || !client) return null;

  const team = list.actions.filter((a) => a.source !== "personal");
  const personal = list.actions.filter((a) => a.source === "personal");
  const own = personal.map(({ source: _, ...a }): ProjectAction => a);

  const report = (e: unknown) => setProblem(e instanceof Error ? e.message : String(e));
  const run = (a: ListedAction) => {
    setProblem(null);
    runInTerminal(client, workspaceId, a.command, { focus: false }).then(reloadRuns, report);
  };
  const save = (next: ReadonlyArray<ProjectAction>) =>
    projectId === undefined
      ? Promise.resolve()
      : savePersonalActions(client, projectId, next).then(() => {
          setProblem(null);
          setEditing(null);
          reload();
        }, report);
  const openFile = (path: string) => openSurface(workspaceId, "file", { path });
  const taken = new Set(own.map((a) => a.id));

  const row = (a: ListedAction) => {
    if (editing?.kind === "edit" && a.source === "personal" && editing.id === a.id) {
      return (
        <li key={actionKey(a)}>
          <ActionForm initial={a} onCancel={() => setEditing(null)} onSave={(next) => save(own.map((o) => (o.id === a.id ? { ...next, id: a.id } : o)))} />
        </li>
      );
    }
    const latest = runs.get(a.command);
    return (
      <ActionRow
        key={actionKey(a)}
        action={a}
        run={latest}
        now={now}
        port={a.source === "run" ? port : undefined}
        onRun={() => run(a)}
        onStop={latest?.state === "running" ? () => void stopAction(client, workspaceId, latest.terminalId).then(reloadRuns) : undefined}
        // Its tab, attached to this run: also for a run started elsewhere (another window, before a reload).
        onShow={() => latest && openSurface(workspaceId, "terminal", { command: a.command, terminalId: latest.terminalId })}
        onOpenPort={(p) => openSurface(workspaceId, "browser", { url: `http://localhost:${p}` })}
        edit={
          a.source === "personal"
            ? [
                { label: "Edit", icon: PencilEdit02Icon, act: () => setEditing({ kind: "edit", id: a.id }) },
                { label: "Delete", icon: Delete02Icon, act: () => void save(own.filter((o) => o.id !== a.id)) },
              ]
            : [{ label: a.source === "run" ? "Edit in computer.toml" : "Edit in actions.toml", icon: PencilEdit02Icon, act: () => openFile(a.source === "run" ? ".caveman/computer.toml" : ".caveman/actions.toml") }]
        }
      />
    );
  };

  const empty = list.actions.length === 0 && list.suggestions.length === 0 && editing === null && !list.error;
  if (empty) {
    return (
      <SurfaceEmpty
        icon={PlayIcon}
        title="No actions yet"
        action={
          projectId !== undefined ? (
            <QuietButton onClick={() => setEditing({ kind: "new" })}>
              <Icon icon={Add01Icon} /> New action
            </QuietButton>
          ) : undefined
        }
      >
        Save a command you run often, or give the team theirs in .caveman/actions.toml.
      </SurfaceEmpty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1">
      {problem ? (
        <p role="alert" className="mx-1 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {problem}
        </p>
      ) : null}

      {team.length > 0 || list.error ? (
        <Section title="Project" hint={<FileHint path=".caveman/actions.toml" onOpen={openFile} />}>
          {list.error ? (
            <li>
              <button
                type="button"
                onClick={() => openFile(".caveman/actions.toml")}
                className="mb-1 w-full rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-left font-mono text-[11.5px] leading-4 text-destructive outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {list.error}
              </button>
            </li>
          ) : null}
          {team.map(row)}
        </Section>
      ) : null}

      {projectId !== undefined ? (
        <Section
          title="Just me"
          hint={
            <BarButton size="sm" label="New action" onClick={() => setEditing({ kind: "new" })}>
              <Icon icon={Add01Icon} />
            </BarButton>
          }
        >
          {personal.map(row)}
          {editing?.kind === "new" ? (
            <li>
              <ActionForm onCancel={() => setEditing(null)} onSave={(next) => save([...own, { ...next, id: actionId(next.name, taken) }])} />
            </li>
          ) : personal.length === 0 ? (
            <li className="px-2 py-1.5 text-[12.5px] text-muted-foreground">Commands only you run here, kept on this computer.</li>
          ) : null}
        </Section>
      ) : null}

      {projectId !== undefined && list.suggestions.length > 0 ? (
        <Section title="Found in package.json">
          <li className="flex flex-wrap gap-1.5 px-2 pt-0.5">
            {list.suggestions.map((s) => (
              <button
                key={s.command}
                type="button"
                title={`Add ${s.command}`}
                onClick={() => void save([...own, { id: actionId(s.name, taken), name: s.name, command: s.command }])}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-input px-2 font-mono text-[11.5px] text-muted-foreground outline-none transition-colors duration-75 hover:border-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={Add01Icon} className="size-3" strokeWidth={2} /> {s.name}
              </button>
            ))}
          </li>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <SectionHeader className="flex h-8 items-center gap-2 px-2 pb-0 pt-2">
        <span>{title}</span>
        {hint ? <span className="ml-auto flex items-center">{hint}</span> : null}
      </SectionHeader>
      <ul className="space-y-px">{children}</ul>
    </section>
  );
}

function FileHint({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(path)} className="rounded px-1 font-mono text-[11px] text-[hsl(var(--subtle-foreground))] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {path}
    </button>
  );
}

function ActionRow({
  action,
  run,
  now,
  port,
  onRun,
  onStop,
  onShow,
  onOpenPort,
  edit,
}: {
  action: ListedAction;
  run: ActionRun | undefined;
  now: number;
  port: number | undefined;
  onRun: () => void;
  onStop: (() => void) | undefined;
  onShow: () => void;
  onOpenPort: (port: number) => void;
  edit: ReadonlyArray<{ label: string; icon: IconSvgElement; act: () => void }>;
}) {
  const glyph = ACTION_ICONS[actionIcon(action)];
  const failed = run?.state === "failed" && !stopped(run);
  return (
    <li className="group/action relative rounded-md">
      {/* The row shows the last run's output; the buttons sit above that overlay. */}
      {run ? (
        <button
          type="button"
          onClick={onShow}
          aria-label={`Show ${action.name}'s output`}
          className="absolute inset-0 rounded-md outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      ) : null}
      <div className="pointer-events-none relative flex items-center gap-2.5 py-1.5 pl-2 pr-1.5 [&_button]:pointer-events-auto">
        <span
          aria-hidden
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md border bg-secondary/60 [&_svg]:size-3.5",
            failed ? "border-destructive/40 text-destructive" : run?.state === "running" ? "border-success/40 text-success" : "border-border text-muted-foreground",
          )}
        >
          <Icon icon={glyph} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] text-foreground">{action.name}</span>
          <span title={action.command} className="block truncate font-mono text-[11.5px] leading-4 text-muted-foreground">
            {action.command}
          </span>
        </span>
        <RunState run={run} now={now} port={port} onOpenPort={onOpenPort} />
        <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/action:opacity-100">
          {edit.map((e) => (
            <BarButton key={e.label} size="sm" label={e.label} onClick={e.act}>
              <Icon icon={e.icon} />
            </BarButton>
          ))}
        </span>
        {onStop ? (
          <BarButton size="sm" label={`Stop ${action.name}`} onClick={onStop}>
            <Icon icon={SquareIcon} strokeWidth={2} className="!size-3" />
          </BarButton>
        ) : (
          <BarButton size="sm" label={run ? `Run ${action.name} again` : `Run ${action.name}`} onClick={onRun}>
            <Icon icon={PlayIcon} />
          </BarButton>
        )}
      </div>
    </li>
  );
}

function RunState({ run, now, port, onOpenPort }: { run: ActionRun | undefined; now: number; port: number | undefined; onOpenPort: (port: number) => void }) {
  if (!run) return null;
  const quiet = "flex shrink-0 items-center gap-1 text-[12px] tabular-nums";
  if (run.state === "running") {
    return (
      <span className={cn(quiet, "text-muted-foreground")}>
        <span aria-hidden className="mr-0.5 size-1.5 animate-pulse rounded-full bg-success" />
        {port !== undefined ? (
          <button type="button" onClick={() => onOpenPort(port)} title={`Open localhost:${port} beside the chat`} className="rounded px-0.5 font-mono outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            :{port}
          </button>
        ) : (
          <span title="Running for">{runLength(now - run.startedAt)}</span>
        )}
      </span>
    );
  }
  const took = runLength(run.endedAt - run.startedAt);
  if (run.state === "passed") {
    return (
      <span className={cn(quiet, "text-muted-foreground")} title={`Passed in ${took}`}>
        <Icon icon={Tick02Icon} className="size-3.5 text-success" strokeWidth={2.25} /> {took}
      </span>
    );
  }
  if (stopped(run)) return <span className={cn(quiet, "text-[hsl(var(--subtle-foreground))]")}>Stopped</span>;
  return (
    <span className={cn(quiet, "text-destructive")} title={`Failed after ${took}`}>
      <Icon icon={Cancel01Icon} className="size-3.5" strokeWidth={2.25} /> exit {run.code}
    </span>
  );
}

/** New or edit, in place: a name, a command, an icon. Enter saves, Escape cancels. */
function ActionForm({ initial, onSave, onCancel }: { initial?: ProjectAction; onSave: (action: Omit<ProjectAction, "id">) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [icon, setIcon] = useState<ActionIcon | undefined>(initial?.icon);
  const shown = icon ?? actionIcon({ name, command });
  const ready = name.trim() !== "" && command.trim() !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSave({ name: name.trim(), command: command.trim(), ...(icon ? { icon } : {}) });
  };
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()} className="mx-1 my-1 flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
      <Input autoFocus aria-label="Name" placeholder="Deploy preview" value={name} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="Command" placeholder="./scripts/deploy.sh staging" value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-[12px]" />
      <div className="flex items-center gap-0.5" role="group" aria-label="Icon">
        {ICON_ORDER.map((k) => {
          const glyph = ACTION_ICONS[k];
          return (
            <BarButton key={k} size="sm" label={k} pressed={shown === k} onClick={() => setIcon(k)}>
              <Icon icon={glyph} />
            </BarButton>
          );
        })}
        <span className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          Save
        </Button>
      </div>
    </form>
  );
}
