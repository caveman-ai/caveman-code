// A chat on its way to Cloud from a browser window (state/cloud-wait.ts): one line over the page, with its seconds
// and Cancel, while its place wakes; our own sentence when the place cannot start (Cloud's reason behind a click); and
// the card a start that came in a link waits behind. What the Cloud-hosted client's front door used to hold up the
// whole window for.
import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import {
  CLOUD_WAIT_CHANGED,
  chooseRuntime,
  listComputers,
  listRuntimes,
  RUNTIME_CHOSEN,
  setComputer,
} from "../state/cloud.ts";
import {
  CLOUD_FAILED_LINE,
  CLOUD_WAKING,
  CloudWait,
  type CloudWaitView,
} from "../state/cloud-wait.ts";
import { flushDrafts, keepDraft } from "../state/composer-drafts.ts";
import { waitLine } from "../state/sync/web-window.ts";
import { StartConfirm } from "./PendingCloudStart.tsx";

/** The window's wait for a chat started in Cloud, and its line: at the head of the shell's panel in a browser window Cloud serves. */
export function CloudWaitLine() {
  const navigate = useNavigate();
  const [wait] = useState(
    () =>
      new CloudWait({
        session: sessionStorage,
        local: localStorage,
        runtimes: listRuntimes,
        computers: listComputers,
        run: (id) => setComputer(id, "running"),
        choose: (r) => chooseRuntime(localStorage, r),
      }),
  );
  useEffect(() => {
    wait.start();
    window.addEventListener(RUNTIME_CHOSEN, wait.kick);
    window.addEventListener(CLOUD_WAIT_CHANGED, wait.kick);
    return () => {
      window.removeEventListener(RUNTIME_CHOSEN, wait.kick);
      window.removeEventListener(CLOUD_WAIT_CHANGED, wait.kick);
      wait.stop();
    };
  }, [wait]);
  const view = useSyncExternalStore(wait.subscribe, wait.get);
  /** Giving a start up never loses its words: they go back in New chat's box. */
  const giveUp = () => {
    const start = wait.discard();
    if (!start?.task.trim()) return;
    keepDraft("new-chat", { text: start.task, refs: [] });
    flushDrafts("new-chat");
    navigate("/new");
  };
  // A link's start is someone's words, maybe not the person's: Discard drops them.
  return (
    <CloudWaitStatus
      view={view}
      onCancel={giveUp}
      onStart={() => wait.confirm()}
      onDiscard={() => void wait.discard()}
    />
  );
}

/** What the wait shows; `now` is fixed on a fixture page. */
export function CloudWaitStatus({
  view,
  onCancel,
  onStart,
  onDiscard,
  now,
}: {
  view: CloudWaitView;
  onCancel: () => void;
  onStart: () => void;
  onDiscard: () => void;
  now?: number;
}) {
  if (view.linked)
    return (
      <StartConfirm
        computer="Cloud"
        start={view.linked.start}
        onDiscard={onDiscard}
        onStart={onStart}
      />
    );
  // The live region stays mounted, empty with nothing to say, so the line is read when it appears.
  return (
    <div
      role="status"
      aria-live="polite"
      className={view.waiting ? "shrink-0 border-b border-border" : "sr-only"}
    >
      {view.waiting ? (
        <Waiting since={view.waiting.since} failed={view.failed} onCancel={onCancel} now={now} />
      ) : null}
    </div>
  );
}

function Waiting({
  since,
  failed,
  onCancel,
  now,
}: {
  since: number;
  failed: string | null;
  onCancel: () => void;
  now: number | undefined;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [why, setWhy] = useState(false);
  useEffect(() => {
    if (now !== undefined || failed !== null) return;
    const timer = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [now, failed]);
  return (
    <div className="px-4 py-1 text-[13px] text-foreground">
      <div className="flex min-h-7 items-center gap-2">
        <span
          aria-hidden
          className={
            failed === null
              ? "size-1.5 shrink-0 animate-pulse rounded-full bg-warning motion-reduce:animate-none"
              : "size-1.5 shrink-0 rounded-full bg-destructive"
          }
        />
        <span className="min-w-0 flex-1 tabular-nums">
          {failed === null ? waitLine(CLOUD_WAKING, since, now ?? tick) : CLOUD_FAILED_LINE}
        </span>
        {failed !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={why}
            onClick={() => setWhy(!why)}
          >
            See why
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {failed !== null && why ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words pb-1.5 pl-3.5 font-mono text-[12px] leading-5 text-muted-foreground">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
