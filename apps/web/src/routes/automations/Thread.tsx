// A run, read as its thread. One line says how it went (what started it, when, how long, on which model, what it
// cost); then anything waiting on you (an approval, a draft to post) and why it failed; then the step's own chat, in
// the chat's own transcript, live while it runs. A run of several steps picks the step above the thread. The run is
// asked again every 2 s while it runs; its chat streams on its own.
import type { Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { cn } from "@caveman-app/ui/lib/cn";
import { Response } from "@caveman-app/ui/ai/response";
import { Icon, ArrowUpRight01Icon, Cancel01Icon, LinkSquare02Icon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Transcript } from "../../components/Transcript.tsx";
import { peek } from "../../state/peek.ts";
import type { AskReply } from "../../state/grill.ts";
import { requestId, useRuntimeSelector, useSession } from "../../state/runtime.tsx";
import { say, useActions } from "./actions.tsx";
import { gateDeadline, gateWords, localGate } from "./cloud.ts";
import { GateCard } from "./CloudParts.tsx";
import { message, refresh, useRun } from "./data.ts";
import { StateGlyph } from "./marks.tsx";
import { attemptModel, DECISION_WORD, duration, isLive, liveAttempt, money, REASON, RUN_WORD, runWho, span, ago, threadOf, type Check, type RunRecord } from "./model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export function RunThread({ runId }: { runId: string }) {
  const run = useRun(runId);
  const r = run.value;
  const [now, setNow] = useState(Date.now);
  const live = r ? isLive(r.status) : false;
  // A running run's clock ticks each second; a finished one holds still.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!r) return run.error ? <p className="pt-8 text-[13px] text-destructive">{run.error}</p> : <ThreadSkeleton />;
  return <RunBody key={r.run} run={r} now={now} onChanged={run.reload} />;
}

function RunBody({ run: r, now, onChanged }: { run: RunRecord; now: number; onChanged: () => void }) {
  const threads = r.steps.filter((s) => threadOf(s) !== null);
  // The step shown: the one at work, else the last that has a chat.
  const [picked, setPicked] = useState<string | null>(null);
  const shown = r.steps.find((s) => s.name === picked) ?? liveStep(r) ?? threads[threads.length - 1] ?? r.steps[r.steps.length - 1];
  const failed = r.steps.flatMap((s) => s.attempts.slice(-1).flatMap((at) => at.checks.filter((c) => !passed(c) && !pendingCheck(c))));
  const at = shown ? threadOf(shown) : null;
  return (
    <div className="mt-8">
      <RunLine run={r} now={now} workspaceId={at?.workspace_id ?? null} onChanged={onChanged} />
      <Gate run={r} />
      {r.status === "failed" ? <Why run={r} /> : null}
      {failed.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          {failed.map((c, i) => (
            <CheckRow key={`${c.check}:${i}`} check={c} />
          ))}
        </div>
      ) : null}
      {r.outputs.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {r.outputs.map((o) => (
            <OutputCard key={o.key} output={o} runId={r.run} onApplied={onChanged} />
          ))}
        </div>
      ) : null}
      {r.steps.length > 1 ? (
        <div role="tablist" aria-label="Steps" className="mt-6 flex flex-wrap items-center gap-1">
          {r.steps.map((s) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={s === shown}
              onClick={() => setPicked(s.name)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
                s === shown ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <StateGlyph status={s.status} />
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-6">
        {at?.workspace_id ? (
          <StepChat key={at.workspace_id} workspaceId={at.workspace_id} />
        ) : shown?.summary ? (
          <Response className="text-[14px] leading-[22px] text-foreground [&_p]:my-0 [&_p+*]:mt-2">{shown.summary}</Response>
        ) : (
          <p className="text-[13px] text-muted-foreground">{shown ? (shown.status === "pending" ? `${shown.name} hasn't started.` : `${shown.name} has no chat to show.`) : "This run has no steps."}</p>
        )}
      </div>
    </div>
  );
}

const liveStep = (r: RunRecord) => r.steps.find((s) => isLive(s.status) && threadOf(s) !== null);
const passed = (c: Check) => (c.check.startsWith("agent:") ? c.decision === "approve" : c.exit === 0);
const pendingCheck = (c: Check) => (c.check.startsWith("agent:") ? c.decision === undefined && c.ms === undefined : c.exit === undefined);

/**
 * The run in one line: its state, what started it, when, how long, the model it got and what it cost. At the right,
 * the full chat; while it runs, Cancel and Take over instead.
 */
function RunLine({ run: r, now, workspaceId, onChanged }: { run: RunRecord; now: number; workspaceId: string | null; onChanged: () => void }) {
  const client = useRuntimeSelector((v) => v.client);
  const openStep = useOpenStep();
  const [confirm, setConfirm] = useState<"cancel" | "takeover" | null>(null);
  const live = isLive(r.status);
  const gate = localGate(r);
  const last = r.steps.flatMap((s) => s.attempts).at(-1);
  const model = last ? attemptModel(last).model : null;
  const word = gate ? "Waiting for approval" : RUN_WORD[r.status];
  const cancel = async () => {
    if (!client) return;
    try {
      await client.call("automation.run_cancel", { request_id: requestId(), run_id: r.run });
      onChanged();
      refresh(client, "list");
    } catch (e) {
      say(`Couldn't cancel the run: ${message(e)}`, "error");
    }
  };
  const takeOver = async () => {
    const at = liveAttempt(r);
    await cancel();
    if (at?.attempt.workspace_id) await openStep(at.attempt.workspace_id, true);
    else say("The run stopped, but its step has no chat to open.", "error");
  };
  const parts: ReactNode[] = [
    runWho(r),
    <span key="at" title={new Date(r.started_at).toLocaleString()}>
      {ago(r.started_at, now)}
    </span>,
    <span key="took" className="tabular-nums">
      {span(r.started_at, r.ended_at, now)}
    </span>,
    ...(model ? [model] : []),
    // A run on a plan's login has no per-token price: no cost is said rather than a $0 that reads as free.
    ...(r.budget.spent_usd > 0
      ? [
          <span key="cost" className="tabular-nums" title={`${r.budget.label} cost${r.budget.limit_usd ? `, of a ${money(r.budget.limit_usd)} budget` : ""}`}>
            {money(r.budget.spent_usd)}
          </span>,
        ]
      : []),
  ];
  return (
    <div className="flex min-h-8 items-center gap-3 border-b border-border/70 pb-3">
      <StateGlyph status={r.status} />
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-muted-foreground">
        <span className={cn("font-medium", r.status === "failed" ? "text-destructive" : gate ? "text-warning" : live ? "lucy-shimmer text-foreground" : "text-foreground")}>{word}</span>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">
              ·
            </span>
            {p}
          </span>
        ))}
      </p>
      {live ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setConfirm("cancel")}>
            Cancel run
          </Button>
          {liveAttempt(r)?.attempt.workspace_id ? (
            <Button size="sm" variant="secondary" onClick={() => setConfirm("takeover")} title="Stop the run and carry on in its chat yourself">
              Take over
            </Button>
          ) : null}
        </span>
      ) : workspaceId ? (
        <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void openStep(workspaceId)} title="Open this run's chat in a pane of its own">
          Open chat
          <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Cancel this run?"
        description="Its steps stop and its unapplied outputs are dropped. The branch and what it committed stay."
        confirmLabel="Cancel run"
        cancelLabel="Keep it running"
        destructive
        onConfirm={() => void cancel()}
      />
      <ConfirmDialog
        open={confirm === "takeover"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Take over ${liveAttempt(r)?.step ?? "the step"}?`}
        description="The run stops, and you carry on in that step's chat on the same branch. Nothing it wrote is lost."
        confirmLabel="Take over"
        cancelLabel="Not now"
        onConfirm={() => void takeOver()}
      />
    </div>
  );
}

/** Where a failed command's message (runtime commandFailure) turns from what to do into what it printed. */
const OUTPUT_MARK = "\n\nThe end of its output:\n";

/** Why a failed run stopped, in one line, with the failing step's own words when it has them, and what a command printed. */
function Why({ run: r }: { run: RunRecord }) {
  const step = r.steps.find((s) => s.status === "failed");
  const at = step?.attempts.at(-1);
  // A command step (`run`) has no agent: its error is the command's.
  const command = at?.model.resolved === "none";
  const reason = command && r.reason === "agent_error" ? "The command failed" : r.reason ? REASON[r.reason] : "It failed.";
  const [words, output] = at?.message && at.message !== reason ? at.message.split(OUTPUT_MARK) : [];
  return (
    <div className="mt-3">
      <p className="text-[13px] leading-5 text-destructive">
        {reason}
        {step ? ` in ${step.name}` : ""}
        {words ? <span className="text-muted-foreground">. {words}</span> : null}
      </p>
      {output ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-foreground/[0.05] px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">{output}</pre>
      ) : null}
    </div>
  );
}

/** A step's chat, read the way its own pane reads it. Answering an ask here answers it in the chat. */
function StepChat({ workspaceId }: { workspaceId: string }) {
  const client = useRuntimeSelector((v) => v.client);
  const engines = useRuntimeSelector((v) => v.engines);
  const [w, setW] = useState<Result<"workspace.get"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    let gone = false;
    client.call("workspace.get", { workspace_id: workspaceId }).then(
      (got) => !gone && setW(got),
      (e) => !gone && setError(message(e)),
    );
    return () => void (gone = true);
  }, [client, workspaceId]);
  const { view, historyVersion } = useSession(w?.session_id ?? null);
  const answer = async (askId: string, response: AskReply) => {
    if (!client || !w) return;
    try {
      await client.call("ask.respond", { request_id: requestId(), session_id: w.session_id, ask_id: askId, response });
    } catch (e) {
      say(`Couldn't answer: ${message(e)}`, "error");
    }
  };
  if (error) return <p className="text-[13px] text-muted-foreground">Its chat isn't here any more: {error}</p>;
  if (!w || !view) return <ThreadSkeleton />;
  const engine = engines.find((e) => e.id === w.engine);
  return (
    <Transcript
      items={view.items}
      historyVersion={historyVersion}
      engine={w.engine}
      engineLabel={engine?.label ?? w.engine}
      engineIsCaveman={w.engine === "caveman"}
      running={view.running}
      onAnswer={answer}
      cavemanVersion={null}
      root={w.root_path ?? null}
    />
  );
}

function ThreadSkeleton() {
  return (
    <div aria-busy aria-label="Loading the run" className="mt-8">
      <div className="h-4 w-2/3 rounded bg-foreground/[0.06]" />
      <div className="ml-auto mt-8 h-16 w-1/2 rounded-xl bg-foreground/[0.05]" />
      <div className="mt-8 flex flex-col gap-2.5">
        {[92, 84, 60].map((w) => (
          <div key={w} className="h-3.5 rounded bg-foreground/[0.05]" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** The step that waits for approval, answered here as in the Inbox (automation.approve). */
function Gate({ run: r }: { run: RunRecord }) {
  const actions = useActions();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const gate = localGate(r);
  if (!gate) return null;
  const deadline = gateDeadline(gate.expires_at, Date.now());
  return (
    <div className="mt-4">
      <GateCard
        title={gateWords({ step: gate.step, by: gate.by })}
        detail={`Approve and the run goes on from ${gate.step}. Reject and it stops there; what earlier steps did stays.${deadline ? ` ${deadline}` : ""}`}
        where="this_mac"
        busy={busy}
        onAnswer={(d) => {
          setBusy(d);
          void actions.answerLocal(gate, d, r.run).finally(() => setBusy(null));
        }}
      />
    </div>
  );
}

/**
 * Opens a step's or check's workspace. The runtime archives it when its step ends, and the live list leaves archived
 * chats out, so it is read and shown like an archived chat opened from search (peek); Take over restores it instead.
 */
export function useOpenStep() {
  const client = useRuntimeSelector((v) => v.client);
  const navigate = useNavigate();
  return async (workspaceId: string, restore = false) => {
    try {
      if (!client) throw new Error("no runtime");
      const w = restore
        ? await client.call("workspace.restore", { request_id: requestId(), workspace_id: workspaceId })
        : await client.call("workspace.get", { workspace_id: workspaceId });
      if (w.status === "archived") peek(w);
    } catch {
      // Still live (it is in the list), or gone: the pane says which.
    }
    navigate(`/w/${encodeURIComponent(workspaceId)}`);
  };
}

/** Text that may run long: its first `lines`, faded, with Show all. */
function Clamp({ lines, lineHeight, className, children }: { lines: number; lineHeight: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 2);
  }, [children, open]);
  return (
    <div className={className}>
      <div ref={ref} style={open ? undefined : { maxHeight: lines * lineHeight }} className={cn("overflow-hidden", !open && over && "[mask-image:linear-gradient(180deg,#000_55%,transparent)]")}>
        {children}
      </div>
      {over ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 rounded text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/** A check that failed: what it was, its exit or decision, and what it said, clamped. */
function CheckRow({ check: c }: { check: Check }) {
  const openStep = useOpenStep();
  const agent = c.check.startsWith("agent:");
  const ok = passed(c);
  const said = ok ? (agent ? c.summary : undefined) : (c.text ?? c.summary);
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 text-[13px]">
        {ok ? <Icon icon={Tick02Icon} className="size-3.5 text-success" strokeWidth={2.5} aria-label="passed" /> : <Icon icon={Cancel01Icon} className="size-3.5 text-destructive" strokeWidth={2.5} aria-label="failed" />}
        {agent ? (
          <span className="flex items-center gap-1.5 text-foreground">
            <Glyph name="tool-subagent" className="size-3.5" />
            {c.check.slice(6)}
            {c.decision ? <span className={ok ? "text-success" : "text-destructive"}>{DECISION_WORD[c.decision] ?? c.decision}</span> : null}
          </span>
        ) : (
          <span className="font-mono text-[12.5px] text-foreground">{c.check}</span>
        )}
        {!agent && c.exit !== undefined ? <span className="font-mono text-[12px] text-destructive">exit {c.exit}</span> : null}
        <span className="ml-auto flex items-center gap-3 tabular-nums text-muted-foreground">
          {c.ms !== undefined ? duration(c.ms) : null}
          {agent && c.workspace_id ? (
            <Button size="sm" variant="ghost" className="-my-1 h-6 px-2" onClick={() => void openStep(c.workspace_id!)}>
              Open chat
            </Button>
          ) : null}
        </span>
      </div>
      {said ? (
        <Clamp lines={agent ? 4 : 8} lineHeight={agent ? 19 : 17} className="ml-[22px] mt-1.5">
          {agent ? (
            <Response className="text-[12.5px] leading-[19px] text-foreground [&_p]:my-0 [&_p+*]:mt-1.5">{said}</Response>
          ) : (
            <pre className="overflow-x-auto rounded-lg bg-foreground/[0.04] px-3 py-2 font-mono text-[11.5px] leading-[17px] text-foreground ring-1 ring-inset ring-foreground/[0.06]">{said}</pre>
          )}
        </Clamp>
      ) : null}
    </div>
  );
}

/**
 * A comment or pull request the run wrote, or (a run by hand) would write once you apply it; a routine's report it
 * handed to the project's Chief (a run by hand hands it over too).
 */
function OutputCard({ output: o, runId, onApplied }: { output: RunRecord["outputs"][number]; runId: string; onApplied: () => void }) {
  const client = useRuntimeSelector((v) => v.client);
  const [busy, setBusy] = useState(false);
  const pr = o.kind === "github.pull_request";
  const chief = o.kind === "chief";
  const apply = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await client.call("automation.run_apply", { request_id: requestId(), run_id: runId, key: o.key });
      onApplied();
      say(pr ? "Pull request created." : "Comment posted.");
    } catch (e) {
      say(`Couldn't apply it: ${message(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card", o.status === "failed" ? "border-destructive/30" : "border-border")}>
      <div className="flex items-center gap-2.5 py-2 pl-3.5 pr-2">
        <Glyph name={pr ? "artifact-pr" : "artifact-markdown"} className="text-muted-foreground" />
        <span className="text-[13px] text-foreground">{pr ? "Pull request" : chief ? "Report to the Chief" : "Comment"}</span>
        <span className={cn("min-w-0 truncate text-[12.5px]", o.status === "applied" ? "text-success" : o.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {o.status === "applied" ? (chief ? "Handed over" : "Posted") : o.status === "dry_run" ? "Waits for you: a run by hand posts nothing yet" : o.status === "pending" ? "Posts when the run ends" : o.status === "failed" ? "Failed" : "Dropped with the run"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {o.url ? (
            <Button size="sm" variant="ghost" asChild>
              <a href={o.url} target="_blank" rel="noreferrer">
                Open
                <Icon icon={LinkSquare02Icon} className="size-3" />
              </a>
            </Button>
          ) : null}
          {o.status === "dry_run" ? (
            <Button size="sm" disabled={busy} onClick={() => void apply()}>
              {busy ? "Posting…" : pr ? "Create the pull request" : "Post the comment"}
            </Button>
          ) : null}
        </span>
      </div>
      {o.error ? <p className="border-t border-border/60 px-3.5 py-2 text-[12.5px] text-destructive">{o.error}</p> : null}
      {o.preview && o.status !== "applied" ? (
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-border/60 px-3.5 py-3 font-mono text-[12px] leading-[18px] text-foreground">{o.preview}</pre>
      ) : null}
    </div>
  );
}
