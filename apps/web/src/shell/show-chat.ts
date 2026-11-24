// Opening a chat from a list (a sidebar row, a board's card, a chat named in another): apart from tab-nav.ts, which
// the boot-time key handler and window-less tests import, so the pane store loads only with what shows chats.
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { chatPath, panes, windowTabs } from "../panes/store.ts";
import { useTabNav } from "./tab-nav.ts";

/**
 * Opens a chat as a sidebar row does: panes.show never duplicates it, so one open in another tab (or given a tab of
 * its own, as a full split keeps its chats) brings that tab to the front, and the route goes there replacing the entry,
 * so Back stays inside the tab; otherwise it is a plain navigation.
 */
export function useShowChat(): (workspaceId: string) => void {
  const navigate = useNavigate();
  const go = useTabNav();
  return useCallback(
    (workspaceId: string) => {
      const before = windowTabs.get().active;
      panes.show(workspaceId);
      if (windowTabs.get().active !== before) go(chatPath(workspaceId));
      else navigate(chatPath(workspaceId));
    },
    [navigate, go],
  );
}
