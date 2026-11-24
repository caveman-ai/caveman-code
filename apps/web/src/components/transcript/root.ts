// The chat's own folder (Workspace.root_path), for rows deep in the transcript
// that show or open a file by path: paths inside it read relative to it.
import { createContext, useContext } from "react";

const WorkspaceRoot = createContext<string | null>(null);

export const WorkspaceRootProvider = WorkspaceRoot.Provider;
export const useWorkspaceRoot = () => useContext(WorkspaceRoot);

/** The chat's workspace id, for rows that ask the runtime about themselves (a running command's output). */
const ChatWorkspace = createContext<string | null>(null);

export const ChatWorkspaceProvider = ChatWorkspace.Provider;
export const useChatWorkspace = () => useContext(ChatWorkspace);
