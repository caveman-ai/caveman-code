// The line above a chat's composer while it is not live from its runtime (state/sync/lines.ts), and a stop or an
// answer this window queued in Cloud for it. A queued send shows in the transcript itself, as the person's message,
// dimmed, with its status under it (runtime.tsx session stores, transcript.ts `queued`).
import { useEffect, useState } from "react";
import type { MergedView } from "../../state/sync/chats-view.ts";
import type { FeedState } from "../../state/sync/chat-feed.ts";
import { heldFeed, RECONNECT_GRACE_MS, sourceLine } from "../../state/sync/lines.ts";
import { useRuntimeSelector, useSyncHub } from "../../state/runtime.tsx";

const LABEL: Record<string, string> = { "turn.interrupt": "Stop", "ask.respond": "Your answer", "workspace.create": "Your chat" };

export function SyncLine({ workspaceId, sessionId, feed }: { workspaceId: string; sessionId: string; feed: FeedState | null }) {
  const hub = useSyncHub();
  const where = useRuntimeSelector((v) => (v.workspaces.find((w) => w.id === workspaceId) as MergedView | undefined)?.synced?.where);
  const [, setTick] = useState(0);
  useEffect(() => hub?.subscribe(() => setTick((n) => n + 1)), [hub]);
  // A reattach says "Reconnecting" only once it has taken a while (lines.ts RECONNECT_GRACE_MS).
  const reconnecting = feed?.kind === "reconnecting";
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    setOverdue(false);
    if (!reconnecting) return;
    const t = setTimeout(() => setOverdue(true), RECONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [reconnecting]);
  const queued = hub?.queuedCalls(sessionId) ?? [];
  const others = queued.filter((q) => q.text === undefined && q.line !== null);
  // A chat this window just started in Cloud has no computer's copy to be away from yet: its first message says where
  // it waits, and that is its one line.
  const source = hub?.startOf(sessionId)
    ? null
    : sourceLine(
        heldFeed(feed, overdue),
        where,
        queued.some((q) => q.call.status === "queued"),
        hub?.approvalFor(where?.runtimeId) ?? null,
      );
  // The live region stays mounted, empty while there is nothing to say: one that mounts with its words is often never
  // read, so "Asleep. Sending wakes it." and then "Waking …" would go unheard.
  const empty = !source && others.length === 0;
  return (
    <div className={empty ? "sr-only" : "mt-3 flex flex-col gap-1 text-[12px] text-muted-foreground"} role="status" aria-live="polite">
      {source ? <div>{source}</div> : null}
      {others.map((q) => (
        <div key={q.call.request_id}>
          {LABEL[q.call.method] ?? "Your message"}: {q.line}
        </div>
      ))}
    </div>
  );
}
