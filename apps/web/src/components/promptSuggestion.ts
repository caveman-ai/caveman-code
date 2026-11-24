// The engine's guess at the person's next message, ): after a completed Caveman
// engine, Claude Agent or Codex turn the runtime holds one per chat, and `suggestion.watch` streams it to this connection as
// `suggestion.live` frames (null once the chat sends again). The empty composer shows it in grey; Tab takes it,
// Escape puts it away. Settings > General turns it off (prompt_suggestions).
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";

// Put away with Escape, per chat and run, for every composer of this window and across remounts: the next turn's guess
// shows even when its words are the same.
let dismissed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => dismissed;
const keyOf = (workspaceId: string, runId: string) => `${workspaceId}\u0000${runId}`;

/** Tab is the only way to take one: a device with no fine pointer (a phone) has no Tab key to press. */
const finePointer = () =>
  typeof matchMedia === "undefined" || matchMedia("(any-pointer: fine)").matches;

/** The chat's suggested next message while there is one and it was not put away; null otherwise. */
export function usePromptSuggestion(workspaceId: string | undefined): {
  readonly suggestion: string | null;
  readonly dismiss: () => void;
} {
  const { client, connection } = useRuntimeClient();
  // Settings turned off: a guess made before shows no more.
  const on = useRuntimeSelector((v) => v.settings?.prompt_suggestions === true);
  const [live, setLive] = useState<{
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly text: string | null;
  } | null>(null);
  useEffect(() => {
    if (!client || !workspaceId || connection === 0 || !finePointer()) return;
    const off = client.on("suggestion.live", (p) => {
      if (p.workspace_id === workspaceId) setLive({ workspaceId, runId: p.run_id, text: p.text });
    });
    const watched = { workspace_id: workspaceId };
    // An older runtime has no suggestions: nothing shows.
    void client.call("suggestion.watch", watched).catch(() => undefined);
    return () => {
      off();
      setLive(null);
      void client.call("suggestion.unwatch", watched).catch(() => undefined);
    };
  }, [client, connection, workspaceId]);
  const put = useSyncExternalStore(subscribe, read);
  const shown =
    on && live && live.workspaceId === workspaceId && live.text && live.runId
      ? { text: live.text, runId: live.runId }
      : null;
  return {
    suggestion:
      shown && workspaceId && !put.has(keyOf(workspaceId, shown.runId)) ? shown.text : null,
    dismiss: () => {
      if (!shown || !workspaceId) return;
      dismissed = new Set(dismissed).add(keyOf(workspaceId, shown.runId));
      for (const listener of listeners) listener();
    },
  };
}
