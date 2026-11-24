// The workspace a side panel's surfaces belong to, as their pane shows it. PaneFrame shows a chat on another computer
// from Cloud's list, whether or not this window's runtime ever held it, and over the parked record this runtime keeps
// of a chat it let go; the window's own list only says where its own chats run.

import type { Workspace } from "@caveman-app/session-protocol";
import { createContext, useContext } from "react";
import { livesHere } from "../state/runtime.tsx";

/** Provided by SidePanel: the workspace its pane shows. */
export const PanelWorkspace = createContext<Workspace | null>(null);

/** The workspace of the side panel this surface is in. */
export function usePanelWorkspace(): Workspace | undefined {
  return useContext(PanelWorkspace) ?? undefined;
}

/** A page opened without a backend: a chat on this computer loads it here; anywhere else, in its agent's browser. Null until the workspace is known. */
export const defaultBackend = (workspace: Workspace | undefined): "local" | "agent" | null =>
  workspace ? (livesHere(workspace) ? "local" : "agent") : null;
