// The dev servers a chat started (upstream #22542): the ones workspace.servers
// attributes to this chat's terminals or its agent. An agent's server stays
// listed after its turn ends, so a chat that left `pnpm dev` running says so
// in its Overview until someone stops it.

import { SessionProtocolError, type Result } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { useEffect, useState } from "react";
import { stopAction } from "./actions.ts";
import { requestId } from "./runtime.tsx";

export interface ChatServer {
  readonly port: number;
  readonly url: string;
  readonly pid: number;
  readonly startedBy: "terminal" | "agent";
  readonly processName: string | null;
  readonly terminalId: string | null;
}

export interface ChatServers {
  readonly servers: ReadonlyArray<ChatServer>;
  /** False on a Windows computer or a runtime too old to stop one. */
  readonly canStop: boolean;
}

const NONE: ChatServers = { servers: [], canStop: false };

/** How often an open Overview asks again: the runtime's scanner polls on the same beat. */
export const CHAT_SERVERS_POLL_MS = 3_000;

/** This chat's own servers from a workspace.servers answer, by port. */
export function chatServers(result: Result<"workspace.servers">): ChatServers {
  const servers = result.servers
    .flatMap((s): ChatServer[] =>
      s.started_by !== undefined && s.pid !== undefined
        ? [{ port: s.port, url: s.url, pid: s.pid, startedBy: s.started_by, processName: s.process_name ?? null, terminalId: s.terminal_id ?? null }]
        : [],
    )
    .sort((a, b) => a.port - b.port);
  return { servers, canStop: result.can_stop === true };
}

/** "Agent · node", "Terminal": who started it, then its process when known. */
export function serverMeta(server: ChatServer): string {
  return [server.startedBy === "agent" ? "Agent" : "Terminal", server.processName].filter(Boolean).join(" · ");
}

export const serverKey = (server: Pick<ChatServer, "pid" | "port">) => `${server.pid}:${server.port}`;

/**
 * The chat's servers while `active` (its Overview shows), asked again every few seconds and right after `refresh`
 * changes. A failed read keeps the last list: a scan that timed out once is not every server gone.
 */
export function useChatServers(client: Client | null, workspaceId: string, active: boolean, refresh = 0): ChatServers {
  const [state, setState] = useState<ChatServers>(NONE);
  useEffect(() => {
    setState(NONE);
  }, [workspaceId]);
  useEffect(() => {
    if (!client || !active) return;
    let live = true;
    const read = () =>
      client.call("workspace.servers", { workspace_id: workspaceId }).then(
        (r) => live && setState(chatServers(r)),
        () => undefined,
      );
    void read();
    const timer = setInterval(read, CHAT_SERVERS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, workspaceId, active, refresh]);
  return state;
}

/**
 * Ends the server's job on the runtime (workspace.servers.stop); throws the runtime's reason when it can't. A
 * terminal's server the runtime won't signal on its own shares the terminal's process group: an action's command is
 * the terminal's own process (its shell exec'd it). That one stops as the Actions tab stops a run, with Ctrl-C to its
 * terminal.
 */
export async function stopChatServer(
  client: Client,
  workspaceId: string,
  server: Pick<ChatServer, "pid" | "port" | "startedBy" | "terminalId">,
  stopRun: (client: Client, workspaceId: string, terminalId: string) => Promise<void> = stopAction,
): Promise<void> {
  try {
    await client.call("workspace.servers.stop", { request_id: requestId(), workspace_id: workspaceId, pid: server.pid, port: server.port });
  } catch (e) {
    const sharesTerminal = e instanceof SessionProtocolError && e.error.data?.reason === "invalid_state" && server.startedBy === "terminal" && server.terminalId !== null;
    if (!sharesTerminal) throw e;
    await stopRun(client, workspaceId, server.terminalId!);
  }
}
