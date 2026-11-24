// A chat embedded in another pane has no panel of its own on screen. User actions that open its files, changes or
// artifacts first reveal that chat, then use its normal panel, workspace and runtime. Background opens stay quiet.
import { createContext, useCallback, useContext } from "react";
import { openFile } from "./openFile.ts";
import { openSurface } from "./store.ts";

export const SurfaceNavigation = createContext<((workspaceId: string) => void) | null>(null);

export function useOpenSurface(): typeof openSurface {
  const reveal = useContext(SurfaceNavigation);
  return useCallback<typeof openSurface>(
    (workspaceId, kind, params, options) => {
      if (options?.focus !== false) reveal?.(workspaceId);
      return openSurface(workspaceId, kind, params, options);
    },
    [reveal],
  );
}

export function useOpenFile(): typeof openFile {
  const reveal = useContext(SurfaceNavigation);
  return useCallback<typeof openFile>(
    (workspaceId, path, line, options) => {
      if (options?.focus !== false) reveal?.(workspaceId);
      return openFile(workspaceId, path, line, options);
    },
    [reveal],
  );
}
