// "See your chats on your phone and the web: turn on sync." One quiet line above the page, once someone is settled
//: one press turns sync on, or dismiss, and either answer ends it for good. It
// writes the answer the sync dialog and Settings > Computers write (syncAnswer: sync_chats, and Remote control with it),
// and it never shows beside the dialog or while a chat runs. Sync stays a setting: Settings > Computers has the switch.
import { Button } from "@caveman-app/ui/components/button";
import { useEffect, useState } from "react";
import { useSaveSettings } from "../routes/settings/rows.tsx";
import { CLOUD_HOSTED, useRuntimeSelector } from "../state/runtime.tsx";
import { useSyncAsk } from "../state/sync-ask.ts";
import {
  answerSyncOffer,
  chatCount,
  dayKey,
  inFirstSession,
  noteChats,
  showsSyncOffer,
  useSyncOfferSaved,
} from "../state/sync-offer.ts";
import { Dot } from "./environment/parts.tsx";
import { useRemoteControl } from "./RemoteControl.tsx";
import { syncAnswer } from "./SyncPrompt.tsx";

export const SYNC_OFFER_TEXT = "See your chats on your phone and the web: turn on sync.";

export function SyncOffer({ today: todayProp }: { today?: string }) {
  // The day is read once per mount, not on every render.
  const [today] = useState(() => todayProp ?? dayKey(new Date()));
  const { status } = useRemoteControl();
  const save = useSaveSettings();
  const saved = useSyncOfferSaved();
  const ask = useSyncAsk();
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const syncChats = useRuntimeSelector((v) => v.settings?.sync_chats);
  const connected = useRuntimeSelector((v) => v.status === "connected");
  const chats = chatCount(workspaces);
  // The chats held once the runtime's list has loaded: settled stays settled.
  useEffect(() => {
    if (connected) noteChats(chats);
  }, [connected, chats]);
  const running = workspaces.some((w) => w.state === "working" || w.state === "needs_input");
  const shows = showsSyncOffer({
    saved: { ...saved, chats: Math.max(saved.chats, connected ? chats : 0) },
    firstSession: inFirstSession(),
    today,
    sync: status?.sync,
    syncChats,
    dialogOpen: ask.open,
    running,
    hosted: CLOUD_HOSTED,
  });
  if (!shows) return null;
  const answer = (on: boolean) => {
    // Remembered first: the line is gone for good whatever the save does, and Settings > Computers holds the switch.
    answerSyncOffer(on ? "on" : "off");
    void save(syncAnswer(on, status));
  };
  return (
    <div
      role="group"
      aria-label={SYNC_OFFER_TEXT}
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-4 py-2 text-[13px] leading-5 text-foreground"
    >
      <Dot tone="idle" />
      <span className="min-w-0">{SYNC_OFFER_TEXT}</span>
      <span className="flex flex-wrap items-center gap-1">
        <Button type="button" size="sm" variant="secondary" onClick={() => answer(true)}>
          Turn on sync
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => answer(false)}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}
