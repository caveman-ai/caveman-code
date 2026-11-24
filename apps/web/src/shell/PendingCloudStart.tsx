import type { EngineDescriptor, Params } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  chooseRuntime,
  chosenRuntime,
  clearPendingStart,
  discardPendingStart,
  holdPendingStart,
  isLaptop,
  listRuntimes,
  pendingStart,
  pendingStartParams,
  startsByItself,
  type CloudRuntime,
  type PendingStart,
} from "../state/cloud.ts";
import { flushDrafts, keepDraft } from "../state/composer-drafts.ts";
import { engineReady } from "../state/engines.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { startFailure, type StartFailure } from "../routes/start-failure.ts";

/**
 * The Cloud-hosted client, connected to the place Cloud made for a chat New chat started: starts the chat there with
 * the message it was given, once, and opens it. A message that came in a link (from This Mac, or from anyone) waits
 * for the person to read it and press Start. A start that failed says so in one sentence of ours, with Try again and
 * Discard; what failed underneath opens on Details.
 */
export function PendingCloudStart() {
  const { client, status } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const engines = useRuntimeSelector((v) => v.engines);
  const navigate = useNavigate();
  const started = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The start lives in sessionStorage: a change there renders what it holds now.
  const [, setHeld] = useState(0);
  const start = pendingStart(sessionStorage);
  const chosen = chosenRuntime(localStorage);
  const ready = !!start && status === "connected" && !!client && chosen?.computer_id === start.computer_id;
  // A failed start is named on whichever computer the tab is on: a new Cloud start from here would otherwise take its
  // place, and its task with it, without the person ever seeing it.
  const elsewhere = start?.failed !== undefined && chosen?.computer_id !== start.computer_id ? start.computer_id : null;
  const [itsRuntime, setItsRuntime] = useState<CloudRuntime | null>(null);
  useEffect(() => {
    setItsRuntime(null);
    if (elsewhere === null) return;
    let live = true;
    // Cloud lists runtimes newest heartbeat first: a computer's first is its live one. An asleep one wakes once chosen.
    listRuntimes().then(
      (a) => live && a.signedIn && setItsRuntime(a.runtimes.find((r) => r.computer_id === elsewhere && !isLaptop(r)) ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [elsewhere]);
  // Claude Agent and Codex sign in on this computer: until they are, the task waits in the chat's box, not in a turn that fails.
  const engine = engines.find((e) => e.id === start?.engine);
  const signInFirst = (start?.engine === "claude-agent" || start?.engine === "codex") && engine !== undefined && !engineReady(engine);
  const engineKnown = !(start?.engine === "claude-agent" || start?.engine === "codex") || (engine !== undefined && engine.auth.state !== "checking");

  useEffect(() => {
    if (!start || !ready || !engineKnown || started.current) return;
    if (!startsByItself(start) && !confirmed) return;
    // Its first workspace.create failed: it runs again on the person's Try again, never by itself.
    if (start.failed !== undefined) return;
    started.current = true;
    // Until a workspace holds the task, the start is its only copy (the dialog's box is cleared). It stays, confirmed
    // and with its first call, so a reload or Try again sends that same call, byte for byte: the runtime runs a
    // request id once and keeps only a success, so that never makes a second workspace.
    const { from_link: _link, ...confirmedStart } = start;
    const first = { ...confirmedStart, request_id: start.request_id ?? requestId(), with_task: start.with_task ?? !signInFirst };
    holdPendingStart(sessionStorage, first);
    const create = (id: string, further = false) => client!.call("workspace.create", pendingStartParams(start, id, first.with_task, further) as Params<"workspace.create">);
    create(first.request_id)
      .then(
        async (w) => {
          clearPendingStart(sessionStorage);
          if (!first.with_task) {
            keepDraft(`chat:${w.id}`, { text: start.task, refs: [] });
            flushDrafts(`chat:${w.id}`);
          }
          // The other runs go beside the first, each in a worktree of the computer's checkout, as far as its size allows.
          // A pull request's chat is one: its head is one branch.
          let started = 1;
          for (; started < (start.pull_request ? 1 : (start.runs ?? 1)); started++) {
            const refused = await create(requestId(), true).then(
              () => undefined,
              (e: unknown) => (e instanceof Error ? e.message : String(e)),
            );
            if (refused !== undefined) {
              setProblem(`Started ${started} of ${start.runs} runs. ${startFailure(refused, "The next one").line}`);
              break;
            }
          }
          await refresh();
          navigate(`/w/${w.id}`);
        },
        (e: unknown) => {
          holdPendingStart(sessionStorage, { ...first, failed: e instanceof Error ? e.message : String(e) });
          setHeld((n) => n + 1);
        },
      )
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  }, [client, ready, engineKnown, confirmed, attempt, refresh, navigate]);

  if (start && ready && !startsByItself(start) && !confirmed && !started.current) {
    return (
      <StartConfirm
        computer={chosen?.computer_name || chosen?.name || start.computer_id}
        start={start}
        engine={engine}
        onDiscard={() => {
          // Back on the computer this tab was on before the link: the runtime provider switches to it in place.
          discardPendingStart(sessionStorage, localStorage);
          setHeld((n) => n + 1);
        }}
        onStart={() => setConfirmed(true)}
      />
    );
  }
  if (start && elsewhere !== null) {
    return (
      <FailedStart
        start={start}
        computer={itsRuntime ? itsRuntime.computer_name || itsRuntime.name : null}
        onOpen={() => {
          // The runtime provider switches in place.
          if (itsRuntime) chooseRuntime(localStorage, itsRuntime);
          setHeld((n) => n + 1);
        }}
        onDiscard={() => {
          discardPendingStart(sessionStorage, localStorage);
          setHeld((n) => n + 1);
        }}
      />
    );
  }
  if (start?.failed !== undefined && ready) {
    return (
      <FailureCard failure={startFailure(start.failed)}>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            const { failed: _failed, ...again } = start;
            holdPendingStart(sessionStorage, again);
            started.current = false;
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            discardPendingStart(sessionStorage, localStorage);
            setHeld((n) => n + 1);
          }}
        >
          Discard
        </Button>
      </FailureCard>
    );
  }
  if (!problem) return null;
  return (
    <div role="alert" className={cn(CARD, "flex flex-wrap items-center gap-x-3 gap-y-2")}>
      <span className="min-w-0 flex-1">{problem}</span>
      <Button type="button" size="sm" variant="ghost" onClick={() => setProblem(null)}>
        Dismiss
      </Button>
    </div>
  );
}

/** Where a start's card sits: over the page's foot, as wide as a narrow window allows. */
const CARD = "fixed bottom-4 left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 rounded-lg border border-border bg-popover px-4 py-3 text-[13px] leading-5 shadow-[var(--shadow-overlay)]";

/** A start that failed: the sentence, its buttons beside it, and what failed underneath behind Details. */
function FailureCard({ failure, children }: { failure: StartFailure; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div role="alert" className={CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-[220px]">{failure.line}</span>
        <span className="flex shrink-0 items-center gap-1">
          {children}
          {failure.detail ? (
            <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
              Details
            </Button>
          ) : null}
        </span>
      </div>
      {open && failure.detail ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[hsl(var(--foreground)/0.04)] p-2 font-mono text-[11.5px] leading-[1.45] text-muted-foreground">{failure.detail}</pre> : null}
    </div>
  );
}

/**
 * A start that failed, seen from elsewhere: Open goes to where it waits, where Try again is. `computer`: the place it
 * waits in, null while that is not known (no Open then). Its name is never shown: a chat in Cloud names no machine.
 */
export function FailedStart({ start, computer, busy = false, onOpen, onDiscard }: { start: PendingStart; computer: string | null; busy?: boolean; onOpen: () => void; onDiscard: () => void }) {
  return (
    <FailureCard failure={startFailure(start.failed ?? "", `The chat on ${start.repo}`)}>
      {computer !== null ? (
        <Button type="button" size="sm" disabled={busy} onClick={onOpen}>
          Open
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
        Discard
      </Button>
    </FailureCard>
  );
}

/**
 * The card a message from a link waits behind: what would run, and the two choices. Everything the link picked is on
 * it, as Start would send it; `engine` is the link's agent as the place it runs in lists it, for its names. Where it
 * runs is not on it: that is Cloud, and Cloud names no machine (`computer` is taken from its callers and never shown).
 */
export function StartConfirm({ start, engine, onDiscard, onStart }: { computer?: string; start: PendingStart; engine?: EngineDescriptor | undefined; onDiscard: () => void; onStart: () => void }) {
  // A pull request's chat is one run, on its head: no other base and no more runs go with it (pendingStartParams).
  const base = start.pull_request ? undefined : start.base_ref;
  const runs = start.pull_request ? 1 : (start.runs ?? 1);
  const picked = start.options;
  const model = picked?.model ? (engine?.models.find((m) => m.id === picked.model)?.label ?? picked.model) : undefined;
  const turn = [model, picked?.effort && `${picked.effort} effort`, picked?.speed && `${picked.speed} speed`].filter(Boolean).join(", ");
  return (
    <div role="dialog" aria-label="Start this chat?" className={CARD}>
      <p className="font-medium">Start this chat?</p>
      <dl className="mt-2 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>Repository</dt>
        <dd className="truncate text-foreground">{start.repo}</dd>
        {base ? (
          <>
            <dt>Branch</dt>
            <dd className="truncate text-foreground">{base}</dd>
          </>
        ) : null}
        {start.pull_request ? (
          <>
            <dt>On</dt>
            <dd className="truncate text-foreground">Pull request #{start.pull_request}</dd>
          </>
        ) : null}
        <dt>Agent</dt>
        <dd className="truncate text-foreground">{engine?.label ?? start.engine}</dd>
        <dt>Model</dt>
        <dd className="truncate text-foreground">{turn || "Default"}</dd>
        {picked?.mode === "grill" ? (
          <>
            <dt>Mode</dt>
            <dd className="truncate text-foreground">Grill</dd>
          </>
        ) : null}
        {runs > 1 ? (
          <>
            <dt>Runs</dt>
            <dd className="text-foreground">{runs}</dd>
          </>
        ) : null}
        <dt>Message</dt>
        <dd className="max-h-40 overflow-y-auto whitespace-pre-wrap text-foreground">{start.task}</dd>
      </dl>
      <p className="mt-2 text-muted-foreground">It came in a link. Start it only if you made it.</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
        <Button type="button" onClick={onStart}>
          Start
        </Button>
      </div>
    </div>
  );
}
