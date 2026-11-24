import type { Client } from "@caveman-app/session-protocol/client";
import { openSurface } from "../store.ts";
import { agentUsed, endUse } from "./float.ts";
import { computerSource } from "./source.ts";

/**
 * The agent starts using the workspace computer's screen: open the Computer tab quietly, once per connection. While it
 * acts there (the runtime's `active`; `reveal` on its first action since the desktop started), the screen reads as in
 * use and floats over the chat (float.ts says when); its turn ending ends that. Keeps listening afterwards so the tab
 * finds the screen's last state when it mounts.
 */
export function watchComputer({ client, workspaceId }: { readonly client: Client; readonly workspaceId: string }): () => void {
  const source = computerSource(client, workspaceId);
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    openSurface(workspaceId, "computer", {}, { focus: false });
  };
  const offs = [
    source.onFrame(open),
    source.onState((state) => {
      open();
      if (state.reveal || state.active) agentUsed(workspaceId, "computer", state.reveal === true);
    }),
    client.on("workspace.changed", (w) => w.id === workspaceId && w.status !== "working" && endUse(workspaceId, "computer")),
  ];
  return () => offs.forEach((off) => off());
}
