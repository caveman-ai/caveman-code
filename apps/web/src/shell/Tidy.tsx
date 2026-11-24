// Tidy: one press in the sidebar's ⋯ menu that archives the old chats (state/inbox-state.ts tidyable), after Arc's
// Tidy. Nothing asks first. Resting on its row sets back the chats that will go; a press fades them out and the list
// closes at once, while the runtime archives them one after another behind it; Undo, at the sidebar's foot for a few
// seconds, puts every one back as it was. The Archived shelf's Restore is the way back after that.

import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenuItem } from "@caveman-app/ui/components/dropdown-menu";
import { arriveMotion } from "@caveman-app/ui/motion";
import { Icon, CleanIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState, useSyncExternalStore } from "react";
import { announce } from "../panes/store.ts";
import type { WorkspaceView } from "../state/model.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import {
  dismissTidy,
  markTidy,
  runTidy,
  subscribeTidy,
  tidyBusy,
  tidyGone,
  tidyMark,
  tidyNotice,
  undoTidy,
  type TidyMark,
  type TidyPort,
} from "./tidy-sweep.ts";

/** What Tidy says of one chat's row, for the row to show (Sidebar useChatRow). */
export const useTidyMark = (id: string): TidyMark | undefined =>
  useSyncExternalStore(subscribeTidy, () => tidyMark(id));

/** The chats Tidy is archiving: the sidebar lists none of them. */
export const useTidyGone = (): ReadonlySet<string> => useSyncExternalStore(subscribeTidy, tidyGone);

/** How long Undo stays once the chats are archived; resting on it holds it. */
const UNDO_MS = 8000;

export interface Tidy {
  /** The chats a press archives. */
  readonly ids: ReadonlyArray<string>;
  /** Archiving or restoring now: no second press until it is over, so its Undo is never replaced under it. */
  readonly busy: boolean;
  readonly run: () => void;
}

/** Tidy over `old` (tidyable's answer for what the sidebar shows); null on a fixture runtime. */
export function useTidy(old: ReadonlyArray<WorkspaceView>): Tidy | null {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const notice = useSyncExternalStore(subscribeTidy, tidyNotice, tidyNotice);
  if (!client) return null;
  const port: TidyPort = {
    archive: (id) =>
      client.call("workspace.archive", { request_id: requestId(), workspace_id: id }),
    restore: (id, keepDone) =>
      client.call("workspace.restore", {
        request_id: requestId(),
        workspace_id: id,
        ...(keepDone ? { keep_done: true } : {}),
      }),
    markDone: (id) =>
      client.call("workspace.inbox", {
        request_id: requestId(),
        workspace_id: id,
        action: { do: "done" },
      }),
    refresh,
    announce,
  };
  return { ids: old.map((w) => w.id), busy: tidyBusy(notice), run: () => void runTidy(port, old) };
}

/** Tidy's row in the sidebar's ⋯ menu, saying how many chats it takes; greyed while nothing is old. */
export function TidyItem({ old }: { old: (now: number) => ReadonlyArray<WorkspaceView> }) {
  // Asked when the menu opens (its rows mount with it): a chat that turned a day old on an idle sidebar counts then.
  const [now] = useState(Date.now);
  const tidy = useTidy(old(now));
  // The pointer or the keyboard rests on it: the rows a press would take sit back, following the list as it changes.
  const [over, setOver] = useState(false);
  const key = tidy?.ids.join(" ") ?? "";
  useEffect(() => {
    if (!over || !key) return;
    const ids = key.split(" ");
    markTidy(ids, "preview");
    return () =>
      markTidy(
        ids.filter((id) => tidyMark(id) === "preview"),
        null,
      );
  }, [over, key]);
  if (!tidy) return null;
  const n = tidy.ids.length;
  return (
    <DropdownMenuItem
      disabled={n === 0 || tidy.busy}
      title="Archive the chats with nothing left for you that sat quiet for a day. Undo brings them back."
      onFocus={() => setOver(true)}
      onBlur={() => setOver(false)}
      onSelect={tidy.run}
    >
      <Icon icon={CleanIcon} /> Tidy
      <span className="ml-auto text-muted-foreground">
        {n === 0 ? "Nothing old" : n === 1 ? "1 old chat" : `${n} old chats`}
      </span>
    </DropdownMenuItem>
  );
}

/** What Tidy just did, at the sidebar's foot, with Undo; it leaves by itself unless the pointer or focus rests on it. */
export function TidyNotice() {
  // The sweep's, not this sidebar's: a sidebar mounted afresh (docked, tucked away, on a phone) shows it still.
  const notice = useSyncExternalStore(subscribeTidy, tidyNotice, tidyNotice);
  const [held, setHeld] = useState(false);
  const sweep = notice?.sweep;
  const settled = notice !== null && !notice.sweep.running && notice.undo !== "running";
  useEffect(() => {
    if (!settled || held) return;
    const timer = setTimeout(dismissTidy, UNDO_MS);
    return () => clearTimeout(timer);
  }, [settled, held, notice]);
  const stage = notice?.undo;
  // Undo leaves from under the pointer without a pointerleave: what held the bar no longer does.
  useEffect(() => setHeld(false), [sweep, stage]);
  if (!notice) return null;
  return (
    <div
      role="status"
      title={notice.why ?? undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onKeyDown={(e) => e.key === "Escape" && dismissTidy()}
      className={cn(
        "mx-3 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-card pl-3 pr-1 text-[13px] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05),0_1px_2px_hsl(0_0%_0%/0.25)]",
        arriveMotion,
      )}
    >
      <span className="min-w-0 flex-1 truncate text-foreground">{notice.text}</span>
      {notice.undo === "offered" ? (
        <Button size="sm" variant="ghost" onClick={undoTidy}>
          Undo
        </Button>
      ) : null}
    </div>
  );
}
