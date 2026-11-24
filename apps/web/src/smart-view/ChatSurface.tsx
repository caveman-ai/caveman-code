// The same session and composer as the chat's own pane, inside any side-panel tab. The tab keeps the Chief's note
// and its way to the full chat; SessionPane owns sending, steering, attachments, questions and the live transcript.
import { Button } from "@caveman-app/ui/components/button";
import { Activity, useCallback } from "react";
import { useNavigate } from "react-router";
import { SessionPane } from "../components/pane/PaneFrame.tsx";
import { SurfaceEmpty } from "../panels/chrome.tsx";
import type { SurfaceProps } from "../panels/registry.ts";
import { SurfaceNavigation } from "../panels/navigation.tsx";
import { windowTabs } from "../panes/store.ts";
import {
  ChatClientScope,
  chatClientFor,
  useChatList,
  useRuntimeSelector,
  useSyncHub,
} from "../state/runtime.tsx";
import { chatElsewhere } from "../state/sync/chats-view.ts";

export default function ChatSurface({ tab, active }: SurfaceProps<"chat">) {
  const client = useRuntimeSelector((v) => v.client);
  const navigate = useNavigate();
  const reveal = useCallback((workspaceId: string) => navigate(windowTabs.openChat(workspaceId)), [navigate]);
  const id = tab.params.workspace_id;
  const local = useRuntimeSelector((v) => v.raw.get(id));
  const detail = useRuntimeSelector((v) => v.workspaces.find((w) => w.id === id)?.detail ?? null);
  // A tab can belong to the Chief or another chat: resolve the named chat's computer, never the tab owner's.
  const hub = useSyncHub();
  const list = useChatList(hub);
  const workspace = chatElsewhere(list, hub?.homeRuntimeId() ?? null, id, local) ?? local;
  const remote =
    hub && workspace && hub.throughHub(workspace.session_id)
      ? chatClientFor(hub, workspace.session_id)
      : null;
  const target = remote ?? client;
  if (!workspace)
    return (
      <SurfaceEmpty title="Chat unavailable">
        This chat is not on any of your computers.
      </SurfaceEmpty>
    );
  if (!target)
    return (
      <SurfaceEmpty title="Not connected">Connect to a runtime to continue this chat.</SurfaceEmpty>
    );
  const body = (
    <SessionPane
      key={workspace.session_id}
      pane={null}
      workspace={workspace}
      client={target}
      focused={active}
      canSplit={false}
      embeddedHeader={
        <div className="flex items-start gap-3 border-b border-border/70 bg-background px-4 pb-3 pt-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-foreground">{workspace.title}</p>
            {tab.params.note ? (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{tab.params.note}</p>
            ) : detail ? (
              <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{detail}</p>
            ) : null}
          </div>
          <Button variant="secondary" size="sm" onClick={() => reveal(id)}>
            Open chat
          </Button>
        </div>
      }
    />
  );
  return (
    <div className="min-h-0 flex-1">
      <SurfaceNavigation.Provider value={reveal}>
        <Activity mode={active ? "visible" : "hidden"}>
          <ChatClientScope client={target}>{body}</ChatClientScope>
        </Activity>
      </SurfaceNavigation.Provider>
    </div>
  );
}
