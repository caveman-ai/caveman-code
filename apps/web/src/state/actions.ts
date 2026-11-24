// A chat's actions (docs/computer-config.md "Actions"): what actions.list reads
// from its checkout, and how each one's last run went, from term.list and
// term.exit. A command's terminal ends with it, so its exit code is the
// command's. Runs go through panels/terminal/run.ts.

import type { ActionIcon, ProjectAction, Result } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { useCallback, useEffect, useState } from "react";
import { requestId, useRuntimeClient } from "./runtime.tsx";

export type ActionsList = Result<"actions.list">;
export type ListedAction = ActionsList["actions"][number];

export type ActionRun =
  | { readonly state: "running"; readonly terminalId: string; readonly startedAt: number }
  | { readonly state: "passed" | "failed"; readonly terminalId: string; readonly startedAt: number; readonly endedAt: number; readonly code: number | null };

/** The icon an action shows: its own, else a guess from its name and command. */
export function actionIcon(action: { readonly icon?: ActionIcon; readonly id?: string; readonly name: string; readonly command: string }): ActionIcon {
  if (action.icon) return action.icon;
  const words = `${action.id ?? ""} ${action.name} ${action.command}`.toLowerCase();
  if (/\b(test|spec|e2e|vitest|jest|pytest)\b/.test(words)) return "test";
  if (/\b(lint|typecheck|tsc|check|fmt|format|eslint|biome)\b/.test(words)) return "lint";
  if (/\b(build|compile|bundle|package)\b/.test(words)) return "build";
  if (/\b(debug|inspect)\b/.test(words)) return "debug";
  if (/\b(setup|install|migrate|seed|config|bootstrap)\b/.test(words)) return "configure";
  return "play";
}

/** One key per listed action: ids repeat across the repo's and the person's own. */
export const actionKey = (a: Pick<ListedAction, "source" | "id">) => `${a.source}:${a.id}`;

/** The workspace's actions, read again whenever `active` turns true. `null` until the first answer, and for another workspace's. */
export function useActionsList(workspaceId: string, active = true): { readonly list: ActionsList | null; readonly failure: string | null; readonly reload: () => void } {
  const { client, connection } = useRuntimeClient();
  // Kept with the workspace it is for: ⌘K follows the focused chat and must never offer one chat's actions in another.
  const [read, setRead] = useState<{ readonly workspaceId: string; readonly list: ActionsList | null; readonly failure: string | null } | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!client || connection === 0 || !active) return;
    let gone = false;
    client.call("actions.list", { workspace_id: workspaceId }).then(
      (list) => !gone && setRead({ workspaceId, list, failure: null }),
      (e: unknown) => !gone && setRead({ workspaceId, list: null, failure: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      gone = true;
    };
  }, [client, connection, workspaceId, active, reloads]);
  const mine = read?.workspaceId === workspaceId ? read : null;
  return { list: mine?.list ?? null, failure: mine?.failure ?? null, reload: useCallback(() => setReloads((n) => n + 1), []) };
}

/** Each command's latest run in the workspace, by command. Follows term.exit while mounted. */
export function useActionRuns(workspaceId: string): { readonly runs: ReadonlyMap<string, ActionRun>; readonly reload: () => void } {
  const { client, connection } = useRuntimeClient();
  const [runs, setRuns] = useState<ReadonlyMap<string, ActionRun>>(new Map());
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!client || connection === 0) return;
    let gone = false;
    const read = () =>
      void client.call("term.list", { workspace_id: workspaceId }).then(
        ({ terminals }) => !gone && setRuns(latestRuns(terminals)),
        () => undefined,
      );
    read();
    const off = client.on("term.exit", read);
    return () => {
      gone = true;
      off();
    };
  }, [client, connection, workspaceId, reloads]);
  return { runs, reload: useCallback(() => setReloads((n) => n + 1), []) };
}

/** Runs the person stopped. Many tools exit 0 or 1 on Ctrl-C, and that is neither a pass nor a failure. */
const stoppedRuns = new Set<string>();

export function latestRuns(terminals: Result<"term.list">["terminals"]): Map<string, ActionRun> {
  const runs = new Map<string, ActionRun>();
  for (const t of [...terminals].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!t.command) continue;
    const startedAt = Date.parse(t.created_at);
    if (!t.exited) runs.set(t.command, { state: "running", terminalId: t.terminal_id, startedAt });
    else {
      // Ended by a signal, or stopped here: no code of its own, which reads Stopped.
      const code = t.signal || stoppedRuns.has(t.terminal_id) ? null : (t.exit_code ?? null);
      runs.set(t.command, { state: code === 0 ? "passed" : "failed", terminalId: t.terminal_id, startedAt, endedAt: t.exited_at ? Date.parse(t.exited_at) : startedAt, code });
    }
  }
  return runs;
}

/** "4.2s", "18s", "2m 05s", "1h 3m": a run's length, short. */
export function runLength(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Ctrl-C to the run, as if typed, so the command can clean up and its terminal ends with it. A second one
 * after a moment (bash goes on to the next command of a chain), then the terminal is closed if it still runs.
 */
export async function stopAction(client: Client, workspaceId: string, terminalId: string): Promise<void> {
  stoppedRuns.add(terminalId);
  const interrupt = () => client.call("term.write", { request_id: requestId(), terminal_id: terminalId, data: "\u0003" }).catch(() => undefined);
  const running = async () =>
    (await client.call("term.list", { workspace_id: workspaceId }).catch(() => ({ terminals: [] }))).terminals.some((t) => t.terminal_id === terminalId && !t.exited);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await interrupt();
  await wait(1_500);
  if (!(await running())) return;
  await interrupt();
  await wait(3_000);
  if (await running()) await client.call("term.close", { request_id: requestId(), terminal_id: terminalId }).catch(() => undefined);
}

/** Replaces the person's own actions for the project (project.update). */
export const savePersonalActions = (client: Client, projectId: string, actions: ReadonlyArray<ProjectAction>) =>
  client.call("project.update", { request_id: requestId(), project_id: projectId, actions: [...actions] });

/** A free id for a new action named `name`: "Deploy preview" → "deploy-preview", "deploy-preview-2", … */
export function actionId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "action";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
