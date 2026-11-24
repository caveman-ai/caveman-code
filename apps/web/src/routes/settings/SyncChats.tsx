// Settings > Computers, Sync chats: the one place the sync setting is a switch. Sync is off until the person
// turns it on, and the prompt never opens by itself (components/SyncPrompt.tsx), so this is always where to do it. It
// answers the way the prompt's Turn on sync does: Settings.sync_chats, and Remote control with it (syncAnswer).
import type { CloudStatus } from "@caveman-app/session-protocol";
import { Switch } from "@caveman-app/ui/components/switch";
import { useId } from "react";
import { useRemoteControl } from "../../components/RemoteControl.tsx";
import { syncAnswer } from "../../components/SyncPrompt.tsx";
import { THIS_COMPUTER } from "../../lib/platform.ts";
import { FlatList, FlatRow, useSaveSettings } from "./rows.tsx";

/** Where the switch stands: null where this Caveman offers no sync (signed out, or a Cloud that keeps no copy). */
export function syncSwitch(status: CloudStatus | null): { readonly on: boolean } | null {
  return status?.sync?.available === true ? { on: status.sync.on } : null;
}

export function SyncChatsSettings() {
  const { status } = useRemoteControl();
  const save = useSaveSettings();
  const id = useId();
  const sync = syncSwitch(status);
  if (!sync) return null;
  return (
    <FlatList label="Sync">
      <FlatRow
        name={<label htmlFor={id}>Sync chats</label>}
        action={
          <Switch
            id={id}
            checked={sync.on}
            onCheckedChange={(on) => void save(syncAnswer(on, status))}
          />
        }
      >
        {`Copies ${THIS_COMPUTER}'s chats to Caveman for your other devices. Remote control goes with it.`}
      </FlatRow>
    </FlatList>
  );
}
