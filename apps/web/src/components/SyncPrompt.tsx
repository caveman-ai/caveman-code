// Sync is a setting, never a pop-up: this dialog opens only when the person asks for it, from Getting started's
// sync step (openSyncAsk), and never by itself, in the first session or any later one. Turn on sync answers it for good
// (Settings.sync_chats, and remote control with it); Not now just closes it and writes nothing. Nothing leaves this Mac
// until it is turned on. Settings > Computers has the same switch (routes/settings/SyncChats.tsx).
import type { CloudStatus, Settings } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@caveman-app/ui/components/dialog";
import { useRef, useState } from "react";
import { THIS_COMPUTER } from "../lib/platform.ts";
import {
  CLOUD_HOSTED,
  requestId,
  useRuntimeClient,
  useRuntimeSelector,
} from "../state/runtime.tsx";
import { closeSyncAsk, useSyncAsk } from "../state/sync-ask.ts";
import { MascotOnFloor } from "./EmptyState.tsx";
import { useRemoteControl } from "./RemoteControl.tsx";

/**
 * The person's answer, as settings: chats sync and other devices may drive this Mac (each allowed here once), or
 * neither. A lid move still asking (moves: "ask") takes the same answer: the lid hands chats to Cloud only when they sync.
 */
export const syncAnswer = (on: boolean, status: CloudStatus | null): Partial<Settings> => ({
  sync_chats: on,
  remote_control: on,
  ...(status?.moves === "ask" ? { move_to_cloud: on } : {}),
});

/**
 * Whether the prompt is on screen: in the app on This Mac, while its Caveman offers sync and the person has not
 * answered (cloud.status `sync.ask`), and only once something asked for it (`opened`: Getting started's step). It
 * never opens by itself, whatever the session or the tour.
 */
export const showsSyncPrompt = (
  status: CloudStatus | null,
  opened: boolean,
  hosted = CLOUD_HOSTED,
): boolean => !hosted && status?.sync?.ask === true && opened;

export function SyncPrompt() {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const { status } = useRemoteControl();
  const ask = useSyncAsk();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const notNow = useRef<HTMLButtonElement>(null);
  if (!client || !showsSyncPrompt(status, ask.open)) return null;
  // Not now writes nothing: the step stays in Getting started, and Settings > Computers has the switch.
  const later = closeSyncAsk;
  const turnOn = () => {
    setBusy(true);
    setProblem(null);
    void client
      .call("settings.set", { request_id: requestId(), settings: syncAnswer(true, status) })
      .then(refresh)
      .then(closeSyncAsk)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && later()}>
      {/* Focus starts on Not now: copying chats off this Mac takes a deliberate press, never a stray Return. */}
      <DialogContent
        size="sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          notNow.current?.focus();
        }}
      >
        <div className="flex flex-col items-center px-2 pt-3 text-center">
          <MascotOnFloor pose="wave" scale={2} />
          <DialogTitle className="mt-4 text-balance text-[17px] font-semibold leading-6 tracking-[-0.01em]">
            Your chats on every device
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-balance text-[13px] leading-5 text-muted-foreground">
            {`Sync copies ${THIS_COMPUTER}'s chats to Caveman, sealed with your organization's key, so your phone and the web can open them and work in them. A new device asks here first.`}
          </DialogDescription>
        </div>
        {problem ? (
          <p role="alert" className="px-1 text-center text-[12.5px] text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter className="sm:justify-center">
          <Button ref={notNow} variant="ghost" disabled={busy} onClick={later}>
            Not now
          </Button>
          <Button disabled={busy} onClick={turnOn}>
            Turn on sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
