// A chat's inbox actions in its row menu: pin, done, snooze and read (upstream thread action menu,
// threadActionMenu.logic.ts @ 13aa882c22). The runtime keeps the state on the chat's thread; the row
// moves at once (RuntimeContextValue.inbox) and a refusal is said aloud.

import { Button } from "@caveman-app/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Input } from "@caveman-app/ui/components/input";
import type { InboxAction } from "@caveman-app/session-protocol";
import { Icon, AlarmClockIcon, CheckmarkCircle02Icon, CircleDotIcon, Mail01Icon, MailOpen01Icon, PinIcon, PinOffIcon, Undo02Icon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";
import { announce } from "../panes/store.ts";
import { canSnooze, customSnooze, isSnoozed, pickSnooze, snoozePresets, DEFAULT_SNOOZE_OPTIONS } from "../state/inbox-state.ts";
import type { WorkspaceView } from "../state/model.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";

/** The runtime's inbox action, its refusal announced; null on a fixture runtime. */
export function useInbox(): ((workspaceId: string, action: InboxAction) => void) | null {
  const inbox = useRuntimeSelector((v) => v.inbox);
  if (!inbox) return null;
  return (id, action) => void inbox(id, action).catch((e: unknown) => announce(e instanceof Error ? e.message : String(e)));
}

/** Pin, Done, Snooze and Mark unread for a chat's menu; `onCustomSnooze` opens the date and time picker. */
export function InboxItems({ workspace, onCustomSnooze }: { workspace: WorkspaceView; onCustomSnooze: () => void }) {
  const inbox = useInbox();
 // The person's own Snooze choices (Settings > General > Inbox), else upstream.
  const options = useRuntimeSelector((v) => v.settings?.inbox_snooze_options) ?? DEFAULT_SNOOZE_OPTIONS;
  if (!inbox || workspace.state === "archived") return null;
  const act = (action: InboxAction) => inbox(workspace.id, action);
  const pinned = Boolean(workspace.inbox?.pinnedAt);
  const done = Boolean(workspace.inbox?.doneAt);
  const snoozed = isSnoozed(workspace);
  const presets = snoozed ? [] : snoozePresets(new Date(), options);
  return (
    <>
      <DropdownMenuItem onSelect={() => act({ do: pinned ? "unpin" : "pin" })}>
        {pinned ? <Icon icon={PinOffIcon} /> : <Icon icon={PinIcon} />} {pinned ? "Unpin" : "Pin"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => act({ do: done ? "reopen" : "done" })}>
        {done ? <Icon icon={Undo02Icon} /> : <Icon icon={CheckmarkCircle02Icon} />} {done ? "Not done" : "Mark done"}
      </DropdownMenuItem>
      {snoozed ? (
        <DropdownMenuItem onSelect={() => act({ do: "wake" })}>
          <Icon icon={CircleDotIcon} /> Wake now
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          {/* A chat that asks something, or a message waiting to start, cannot be snoozed (the runtime refuses). */}
          <DropdownMenuSubTrigger disabled={!canSnooze(workspace)}>
            <Icon icon={AlarmClockIcon} /> Snooze
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[220px]">
            {presets.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => act({ do: "snooze", until: pickSnooze(p, new Date(), options) })}>
                <span className="flex-1">{p.label}</span>
                <span className="text-muted-foreground">{p.when}</span>
              </DropdownMenuItem>
            ))}
            {presets.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={onCustomSnooze}>Pick a date and time…</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem onSelect={() => act(workspace.unread ? { do: "seen", through: workspace.updatedAt } : { do: "unread" })}>
        {workspace.unread ? <Icon icon={MailOpen01Icon} /> : <Icon icon={Mail01Icon} />} {workspace.unread ? "Mark read" : "Mark unread"}
      </DropdownMenuItem>
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Snooze until a date and time the person picks, in their own time zone (upstream CustomSnoozeDialog). */
export function CustomSnoozeDialog({ workspace, open, onOpenChange }: { workspace: WorkspaceView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const inbox = useInbox();
  const [date, setDate] = useState(() => tomorrowDate());
  const [time, setTime] = useState("09:00");
  const until = customSnooze(date, time, new Date());
  const submit = () => {
    if (!until || !inbox) return;
    inbox(workspace.id, { do: "snooze", until });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Snooze “{workspace.title}”</DialogTitle>
          <DialogDescription>It comes back then, or sooner if it asks you something, fails or finishes a turn.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.currentTarget.value)} className="flex-1" />
          <Input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.currentTarget.value)} className="w-[120px]" />
        </form>
        {until ? null : <p className="text-[13px] text-destructive">Pick a time that is still ahead.</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!until} onClick={submit}>
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function tomorrowDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
