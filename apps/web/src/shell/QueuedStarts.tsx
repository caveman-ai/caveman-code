import { useEffect, useRef } from "react";
import { useMatch, useNavigate } from "react-router";
import { openExternal } from "../panels/browser/BrowserBar.tsx";
import { CLOUD_WAIT_CHANGED, holdPendingStart, pendingStart, startLink } from "../state/cloud.ts";
import { CLOUD_HOSTED, useSyncHub } from "../state/runtime.tsx";

/**
 * Chats this window started in Cloud whose computer did not run their start from Cloud's queue (state/sync/hub.ts
 * `startsFailed`: a computer on a runtime from before the queue, or a start that failed there). Each is run the way
 * starts ran before the queue, under the request id Cloud queued it with, so the two can only ever make one chat:
 *
 * - a browser window holds it as the tab's pending start (one at a time: a tab holds one), which the window's wait
 *   and PendingCloudStart carry to its computer. The chat stays open with its message meanwhile, and is let go once
 *   that start ran or the person gave it up;
 * - the desktop app hands it to the Cloud-hosted client, as it handed every start before.
 *
 * A chat its computer made under another id than the one this window opened it under is followed there.
 */
export function QueuedStarts() {
  const hub = useSyncHub();
  const navigate = useNavigate();
  const open = useMatch("/w/:workspaceId")?.params.workspaceId;
  /** The starts this tab runs itself now, by session: each is let go when the tab's pending start is no longer it. */
  const live = useRef(new Set<string>());
  useEffect(() => {
    if (!hub) return;
    const tend = () => {
      const held = CLOUD_HOSTED ? pendingStart(sessionStorage) : null;
      for (const failed of hub.startsFailed()) {
        if (!CLOUD_HOSTED) {
          if (failed.open_url) openExternal(startLink(failed.open_url, failed.start));
          hub.startSettled(failed.session_id);
          if (open === failed.workspace_id) navigate("/", { replace: true });
          continue;
        }
        // The tab's one pending start is another chat's: this one waits its turn. Its own (a reload): carried on.
        if (held !== null && held.session_id !== failed.session_id) continue;
        live.current.add(failed.session_id);
        if (held === null)
          holdPendingStart(sessionStorage, { ...failed.start, session_id: failed.session_id });
        hub.startLive(failed.session_id);
        break;
      }
      const now = CLOUD_HOSTED ? pendingStart(sessionStorage) : null;
      for (const sessionId of [...live.current]) {
        if (now?.session_id === sessionId) continue;
        live.current.delete(sessionId);
        hub.startSettled(sessionId);
      }
      const moved = open === undefined ? undefined : hub.startMoved(open);
      if (moved !== undefined) navigate(`/w/${encodeURIComponent(moved)}`, { replace: true });
    };
    tend();
    const off = hub.subscribe(tend);
    window.addEventListener(CLOUD_WAIT_CHANGED, tend);
    return () => {
      off();
      window.removeEventListener(CLOUD_WAIT_CHANGED, tend);
    };
  }, [hub, open, navigate]);
  return null;
}
