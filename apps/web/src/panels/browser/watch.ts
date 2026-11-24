import type { Client } from "@caveman-app/session-protocol/client";
import { agentUsed, endUse } from "../live/float.ts";
import { browserSource } from "../live/source.ts";
import { openSurface } from "../store.ts";

/**
 * The agent starts using its browser: open the agent browser tab quietly, once per connection. While it uses the
 * browser (the runtime's `active`, or `reveal` when it opens a page to show), the browser reads as in use and floats
 * over the chat (float.ts says when); its turn ending ends that. Keeps listening afterwards so the tab finds the page's
 * last state (URL, title) when it mounts.
 */
export function watchAgentBrowser({ client, workspaceId }: { readonly client: Client; readonly workspaceId: string }): () => void {
  const source = browserSource(client, workspaceId);
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    openSurface(workspaceId, "browser", { backend: "agent" }, { focus: false });
  };
  const offs = [
    source.onFrame(open),
    source.onState((state) => {
      open();
      if (state.reveal || state.active) agentUsed(workspaceId, "browser", state.reveal === true);
    }),
    source.onPointer(open),
    client.on("workspace.changed", (w) => w.id === workspaceId && w.status !== "working" && endUse(workspaceId, "browser")),
  ];
  return () => offs.forEach((off) => off());
}
