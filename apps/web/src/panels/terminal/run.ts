// The one way to run a command in a terminal tab: an action, the pane menu's
// Run, ⌘K, a CLI's sign-in. The caller starts the process and the tab
// attaches to it, so a run never waits for its tab to be shown (the Actions
// tab stays in front) and one press never starts the command twice. Running
// a command again ends the last run of it first, like pressing Run again.

import type { Client } from "@caveman-app/session-protocol/client";
import { requestId } from "../../state/runtime.tsx";
import { getTabs, openSurface, type Tab } from "../store.ts";

/** The command's tab, if it has one (the terminal kind names a command's tab after it), in its panel or a pane of its own. */
export const commandTab = (workspaceId: string, command: string): Tab<"terminal"> | undefined =>
  getTabs(workspaceId).find((t): t is Tab<"terminal"> => t.kind === "terminal" && (t as Tab<"terminal">).params.command === command);

/** Runs still starting, by workspace and command: a second press joins the first instead of starting a copy no row shows. */
const starting = new Map<string, Promise<string>>();

/** Starts `command` in the workspace and shows it in its tab (in front unless `focus` is false). Resolves to the terminal's id. */
export function runInTerminal(client: Client, workspaceId: string, command: string, options: { readonly focus?: boolean } = {}): Promise<string> {
  const key = `${workspaceId}\n${command}`;
  const pending = starting.get(key);
  if (pending) return pending;
  const focus = options.focus ?? true;
  const previous = commandTab(workspaceId, command)?.params.terminalId;
  if (previous) void client.call("term.close", { request_id: requestId(), terminal_id: previous }).catch(() => undefined);
  // The tab sizes the process to its grid when it attaches.
  const run = client.call("term.open", { request_id: requestId(), workspace_id: workspaceId, cols: 120, rows: 30, command }).then(
    ({ terminal_id }) => {
      openSurface(workspaceId, "terminal", { command, terminalId: terminal_id }, { focus });
      return terminal_id;
    },
    (error: unknown) => {
      // In front, the tab starts it itself and says why when that fails too ("The terminal didn't start").
      if (focus) openSurface(workspaceId, "terminal", { command, terminalId: undefined }, { focus });
      throw error;
    },
  );
  starting.set(key, run);
  const done = () => void starting.delete(key);
  run.then(done, done);
  return run;
}

/**
 * A Run button on a shell block (a reply, a document): each press runs the command again. Not connected, the last
 * run can't be ended, so its tab only comes forward with it (no second copy beside it once connected); a command
 * with no run yet gets a tab that starts it once there is a connection.
 */
export function pressRun(client: Client | null, workspaceId: string, command: string): void {
  if (client) void runInTerminal(client, workspaceId, command).catch(() => undefined);
  else openSurface(workspaceId, "terminal", { command });
}
