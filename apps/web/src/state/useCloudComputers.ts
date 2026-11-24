import type { CloudComputerRow } from "@caveman-app/session-protocol";
import { useCallback, useEffect, useState } from "react";
import { chatsOnComputer, deleteComputer, listComputers, setComputer, type ComputerChat } from "./cloud.ts";
import { requestId, useComputersCloud, useRuntimeClient, useSyncHub, useWebWindow } from "./runtime.tsx";
import type { CloudApi } from "./sync/cloud-api.ts";

export type CloudComputersView =
  | { readonly state: "loading" | "signed_out" | "off" }
  | { readonly state: "error"; readonly error: string }
  /** `error`: the last poll failed; the list is the last good one (m-20). */
  | { readonly state: "ready"; readonly computers: ReadonlyArray<CloudComputerRow>; readonly error?: string };

/** Cloud's list of the person's computers as Move to and Settings show it: its Cloud computers (a Mac is a runtime there). */
export const cloudComputersView = (out: { readonly available: boolean; readonly computers: ReadonlyArray<CloudComputerRow> }): CloudComputersView =>
  out.available ? { state: "ready", computers: out.computers.filter((c) => c.driver !== "local") } : { state: "off" };

/**
 * A poll that failed (m-20): the last good list stays, with what went wrong said above it, so one blip never empties
 * the list nor closes a dialog open on one of its rows; before any list, the error alone.
 */
export const failedView = (before: CloudComputersView, error: string): CloudComputersView =>
  before.state === "ready" ? { state: "ready", computers: before.computers, error } : { state: "error", error };

/**
 * This person's own Cloud computers, kept fresh while mounted: through the runtime's Cloud
 * sign-in on This Mac, or with the Cloud session on the Cloud-hosted client. `openUrl` is the
 * Cloud-hosted client, where a Cloud computer's sessions open.
 */
export function useCloudComputers({ every = 4_000, enabled = true }: { every?: number; enabled?: boolean } = {}) {
  const { client } = useRuntimeClient();
  // A browser window Cloud serves asks Cloud itself, on its session there, whether or not it uses a computer.
  const web = useWebWindow() !== null;
  const [view, setView] = useState<CloudComputersView>({ state: "loading" });
  const [openUrl, setOpenUrl] = useState<string | null>(web ? `${window.location.origin}/code/` : null);
  /** The runtime this client is on, by its Cloud id (cloud.status), so a list of the person's runtimes can leave it out. */
  const [runtimeId, setRuntimeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (web) {
        if (client)
          void client.call("cloud.status", {}).then(
            (status) => setRuntimeId(status.runtime_id ?? null),
            () => undefined,
          );
        const out = await listComputers();
        setView(cloudComputersView(out));
        return;
      }
      if (!client) return;
      const status = await client.call("cloud.status", {});
      setRuntimeId(status.runtime_id ?? null);
      if (!status.runtime_id || !status.cloud_url) return setView({ state: "signed_out" });
      setOpenUrl(`${status.cloud_url}/code/`);
      const out = await client.call("cloud.computers", {});
      setView(cloudComputersView(out));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setView((before) => failedView(before, error));
    }
  }, [client, web]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), every);
    return () => clearInterval(timer);
  }, [load, every, enabled]);

  const set = useCallback(
    async (computerId: string, state: "running" | "suspended") => {
      if (web) await setComputer(computerId, state);
      else await client?.call("cloud.computer.set", { request_id: requestId(), computer_id: computerId, state });
      await load();
    },
    [client, load, web],
  );

  /** Deletes one (C3): its chats are archived and its disk goes. */
  const remove = useCallback(
    async (computerId: string) => {
      if (web) await deleteComputer(computerId);
      else await client?.call("cloud.computer.delete", { request_id: requestId(), computer_id: computerId });
      await load();
    },
    [client, load, web],
  );

  return { view, openUrl, runtimeId, set, remove, reload: load };
}

/**
 * What the Delete dialog says is on a Cloud computer (A-7): `listed`, by Cloud's own lists of the person's chats, every
 * kind, archived ones apart; `unlisted` when this window can't read them (no Cloud routes here, or Cloud failed), so
 * the dialog says it can't name every chat rather than that there is none.
 */
export type ChatsOnComputer =
  | { readonly state: "loading" }
  | { readonly state: "listed"; readonly on: ReadonlyArray<ComputerChat>; readonly archived: ReadonlyArray<ComputerChat> }
  | { readonly state: "unlisted"; readonly why: string };

/** Reads both of Cloud's chat lists, active and archived, and keeps the chats on `computerId`. */
export async function readChatsOnComputer(api: Pick<CloudApi, "list">, computerId: string): Promise<ChatsOnComputer> {
  const [active, archived] = await Promise.all([api.list(false), api.list(true)]);
  return { state: "listed", ...chatsOnComputer(computerId, active.chats, archived.chats) };
}

/** The chats on `computerId` while it is set (the Delete dialog open on it), read each time it opens. */
export function useChatsOnComputer(computerId: string | null): ChatsOnComputer {
  // The person's chat routes: the cookie on the web Cloud serves, the desktop's token, else the sync hub's once it has them.
  const computers = useComputersCloud();
  const hub = useSyncHub();
  const api = computers ?? hub?.cloud() ?? null;
  // Kept with the computer it is for and dropped on close: another computer's, or the last open's, never shows.
  const [out, setOut] = useState<{ readonly id: string; readonly chats: ChatsOnComputer } | null>(null);
  useEffect(() => {
    if (computerId === null) return setOut(null);
    if (api === null) return setOut({ id: computerId, chats: { state: "unlisted", why: "this window can't read Caveman's list of your chats" } });
    let live = true;
    readChatsOnComputer(api, computerId).then(
      (chats) => live && setOut({ id: computerId, chats }),
      (e: unknown) => live && setOut({ id: computerId, chats: { state: "unlisted", why: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      live = false;
    };
  }, [computerId, api]);
  return computerId !== null && out?.id === computerId ? out.chats : { state: "loading" };
}
