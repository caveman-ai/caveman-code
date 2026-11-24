// New chat on any of your computers, from any device (DESIGN S13): besides the window's own runtime and a new Cloud
// computer, the dialog offers every other runtime of yours that is online in Cloud's list: a Mac (reached through the
// relay, so only once that Mac allowed this device) or a Cloud computer you already have. Its projects come from
// that runtime, and the chat is made there.
import type { Params, Project, Workspace } from "@caveman-app/session-protocol";
import { useEffect, useMemo, useState } from "react";

import { useChatList, useRuntimeClient, useSyncHub } from "../state/runtime.tsx";

export interface RuntimeTarget {
  readonly runtimeId: string;
  /** Its computer, as a move names where a chat goes. */
  readonly computerId: string;
  readonly name: string;
  readonly kind: "laptop" | "cloud";
}

/** Every other runtime of yours that is online now, Macs first, then by name. */
export function otherRuntimes(
  runtimes: ReadonlyArray<{ readonly runtime_id: string; readonly computer_id: string; readonly name: string; readonly kind: "laptop" | "cloud"; readonly online: boolean }>,
  home: ReadonlyArray<string | null | undefined>,
): RuntimeTarget[] {
  const mine = new Set(home.filter((id): id is string => typeof id === "string"));
  return runtimes
    .filter((r) => r.online && !mine.has(r.runtime_id))
    .map((r) => ({ runtimeId: r.runtime_id, computerId: r.computer_id, name: r.name || (r.kind === "laptop" ? "A Mac" : "A Cloud computer"), kind: r.kind }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "laptop" ? -1 : 1));
}

/**
 * The picked other runtime and what the dialog needs from it: the targets to offer, its projects (fetched through
 * the pool when picked), and the call that makes the chat there.
 */
export function useRuntimeTargets(open: boolean) {
  const hub = useSyncHub();
  const list = useChatList(hub);
  const { client } = useRuntimeClient();
  const [ownId, setOwnId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<Project> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The window's own runtime by its Cloud id (the desktop's This Mac), so it is not offered twice.
  useEffect(() => {
    if (!open || !client) return;
    let live = true;
    client.call("cloud.status", {}).then(
      (status) => live && setOwnId(status.runtime_id ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, client]);

  const targets = useMemo(() => otherRuntimes(list ? [...list.runtimes.values()] : [], [hub?.homeRuntimeId(), ownId]), [list, hub, ownId]);
  // A target that went offline is no longer picked.
  useEffect(() => {
    if (target && !targets.some((t) => t.runtimeId === target)) setTarget(null);
  }, [target, targets]);

  useEffect(() => {
    setProjects(null);
    setProblem(null);
    if (!open || !hub || !target) return;
    let live = true;
    hub.pool
      .with(target, (c) => c.call("project.list", {}))
      .then(
        (answer) => live && setProjects(answer.projects),
        (error: unknown) => live && setProblem(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      live = false;
    };
  }, [open, hub, target]);

  const create = async (params: Params<"workspace.create">): Promise<Workspace> => {
    if (!hub || !target) throw new Error("Pick a computer first.");
    return hub.pool.with(target, (c) => c.call("workspace.create", params));
  };

  return { targets, target, setTarget, projects, problem, create };
}
