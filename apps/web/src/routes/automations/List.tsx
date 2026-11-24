// The Automations list column: + New automation, then every automation across this computer's projects in two quiet
// groups, Active and Paused. A row is its state as one ring, its name, and one line: what starts it, or the one thing
// wrong with it. The newest agent runs follow, once there are some. The open one is lit; j/k and the arrows walk it.
import { StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import { useRef } from "react";
import { useMatch } from "react-router";
import { QuietButton } from "../../panels/chrome.tsx";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { usePhone } from "../../lib/screen.ts";
import { detailPath, runPath } from "./actions.tsx";
import { useAgentRuns, useAutomations, warm } from "./data.ts";
import { ColumnEmpty, ColumnSkeleton, ListAdd, ListGroup, ListRow, useRowWalk } from "../../components/ListFrame.tsx";
import { StateGlyph } from "./marks.tsx";
import { agentOfRun, ago, awaitingAllow, countsWord, problemsOf, triggersOff, triggerSummary, type Automation } from "./model.ts";
import { useNewAutomation } from "./New.tsx";

export function AutomationsColumn() {
  const projects = useRuntimeSelector((v) => v.projects);
  const list = useAutomations();
  const open = useMatch("/automations/:id/*")?.params.id;
  const openNew = useNewAutomation();
  const phone = usePhone();
  const listRef = useRef<HTMLElement>(null);
  const all = list.value ?? [];
  // A project's name on each row only once there is more than one to tell apart.
  const many = new Set(all.map((a) => a.project_id)).size > 1;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Missing project";
  // A draft is a file only in another worktree (a chat's, a branch): listed apart until it merges.
  const drafts = all.filter((a) => a.worktree);
  // What an agent set to run on Cloud waits for the person, first.
  const waiting = all.filter((a) => !a.worktree && awaitingAllow(a));
  const active = all.filter((a) => a.enabled && !a.worktree && !awaitingAllow(a));
  const paused = all.filter((a) => !a.enabled && !a.worktree && !awaitingAllow(a));

  // j/k and the arrows walk the rows.
  useRowWalk(listRef);

  const row = (a: Automation) => (
    <Row key={a.id} automation={a} selected={open !== undefined && decodeURIComponent(open) === a.id} project={many ? projectName(a.project_id) : null} />
  );

  return (
    <nav ref={listRef} aria-label="Automations" aria-busy={list.value === undefined} className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-1 [scrollbar-gutter:stable]">
      <ListAdd label="New automation" onClick={() => openNew()} />
      {list.error && !list.value ? (
        <ColumnEmpty title="Couldn't read your automations" action={<QuietButton onClick={() => void list.reload()}>Try again</QuietButton>}>
          {list.error}
        </ColumnEmpty>
      ) : list.value === undefined ? (
        <div className="pt-4">
          <ColumnSkeleton n={3} />
        </div>
      ) : (
        <>
          {/* On a phone the page beside the list, which explains an empty one, is not on screen: the list says it. */}
          {all.length === 0 && phone ? (
            <ColumnEmpty title="No automations yet" action={<QuietButton onClick={() => openNew("template")}>Use a template</QuietButton>}>
              Make one that runs on a schedule or when something happens.
            </ColumnEmpty>
          ) : null}
          {waiting.length > 0 ? <ListGroup title="Waiting for you">{waiting.map(row)}</ListGroup> : null}
          {active.length > 0 ? <ListGroup title="Active">{active.map(row)}</ListGroup> : null}
          {paused.length > 0 ? <ListGroup title="Paused">{paused.map(row)}</ListGroup> : null}
          {drafts.length > 0 ? <ListGroup title="Drafts">{drafts.map(row)}</ListGroup> : null}
          <AgentRuns />
        </>
      )}
    </nav>
  );
}

/** What the ring says: running, something wrong (red), on but not firing (amber), or at rest. */
type Tone = "running" | "error" | "warn" | "idle";

function Row({ automation: a, selected, project }: { automation: Automation; selected: boolean; project: string | null }) {
  const client = useRuntimeSelector((v) => v.client);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const problems = problemsOf(a);
  const off = a.enabled || a.worktree ? triggersOff(a) : null;
  const failed = a.enabled && a.last_status === "failed";
  const waiting = awaitingAllow(a);
  const tone: Tone = (a.runs_running ?? 0) > 0 ? "running" : problems.errors > 0 || failed ? "error" : off || waiting ? "warn" : "idle";
  const line =
    waiting ? (
      <span className="text-warning">Runs on Cloud once you allow it</span>
    ) : tone === "running" ? (
      <span className="lucy-shimmer text-foreground">Running</span>
    ) : problems.errors > 0 ? (
      <span className="text-destructive">{countsWord({ errors: problems.errors, warnings: 0 })}</span>
    ) : off ? (
      <span className="text-warning">{off.label}</span>
    ) : failed ? (
      <span className="text-destructive">Last run failed {ago(a.last_run_at, Date.now())}</span>
    ) : (
      triggerSummary(a.trigger)
    );
  return (
    <ListRow
      to={detailPath(a.id)}
      selected={selected}
      onPointerEnter={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => warm(client, a), 90);
      }}
      onFocus={() => warm(client, a)}
      glyph={<Ring tone={tone} paused={!a.enabled && !a.worktree} />}
      title={a.title}
      line={
        project ? (
          <>
            {project}
            <span aria-hidden className="px-1 text-[hsl(var(--subtle-foreground))]">
              ·
            </span>
            {line}
          </>
        ) : (
          line
        )
      }
    />
  );
}

/** The row's state in one mark: an open ring at rest (dashed when paused), the working mark while it runs. */
function Ring({ tone, paused }: { tone: Tone; paused: boolean }) {
  if (tone === "running") return <StateMark name="state-working" animate />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-3.5 rounded-full border-[1.5px]",
        tone === "error" ? "border-destructive" : tone === "warn" ? "border-warning" : paused ? "border-dashed border-muted-foreground" : "border-muted-foreground",
      )}
    />
  );
}

/** The newest `caveman-runtime agent run` work, each opening its run. Shown only once there is some. */
function AgentRuns() {
  const runs = useAgentRuns().value ?? [];
  const open = useMatch("/automations/:id/runs/:runId")?.params.runId;
  const now = Date.now();
  if (runs.length === 0) return null;
  return (
    <ListGroup title="Agent runs">
      {runs.map((r) => (
        <ListRow
          key={r.run_id}
          to={runPath(r.automation_id || `file:${r.project_id}:me:${r.automation}`, r.run_id)}
          selected={open === r.run_id}
          glyph={<StateGlyph status={r.status} />}
          title={agentOfRun(r.automation)}
          line={ago(r.started_at, now)}
        />
      ))}
    </ListGroup>
  );
}
