// Archived chats. The live list leaves them out (workspace.list without include_archived), so the queue's Archived
// shelf and Settings > Archived chats ask the runtime for them, and ask again when a chat is archived or restored
// anywhere: by a person, or by the runtime's auto-archive sweep.

import type { Workspace } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { requestId, useRuntimeClient, useRuntimeSelector } from "./runtime.tsx";

export interface ArchivedChats {
  /** Newest archive first; null until they first load. */
  readonly chats: ReadonlyArray<Workspace> | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  /** Its worktree and uncommitted work come back and it returns to the list; rejects with the runtime's refusal. */
  readonly restore: (id: string) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The archived chats, loaded while `on` (a folded shelf asks for nothing). */
export function useArchivedChats(on = true): ArchivedChats {
  const { client, connection } = useRuntimeClient();
  const raw = useRuntimeSelector((v) => v.raw);
  const refresh = useRuntimeSelector((v) => v.refresh);
  // Only archiving or restoring changes the archive, and either changes which chats are live.
  const live = useMemo(() => [...raw.values()].flatMap((w) => (w.status === "archived" ? [] : [w.id])).sort().join(" "), [raw]);
  const [chats, setChats] = useState<ReadonlyArray<Workspace> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      const { workspaces } = await client.call("workspace.list", { include_archived: true });
      setChats(workspaces.filter((w) => w.status === "archived" && w.kind !== "chief").sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [client]);
  useEffect(() => {
    if (on) void reload();
  }, [on, reload, live, connection]);
  const restore = async (id: string) => {
    if (!client) return;
    await client.call("workspace.restore", { request_id: requestId(), workspace_id: id });
    await Promise.all([refresh(), reload()]);
  };
  return { chats, error, reload, restore };
}
