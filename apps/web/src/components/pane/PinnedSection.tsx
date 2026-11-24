import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, PinIcon } from "@caveman-app/ui/icons/huge";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { registerDropTarget, useDrag, type DragPayload } from "../../panes/drag.ts";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { pinnedChats } from "../../state/inbox-state.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { useInbox } from "../../shell/InboxItems.tsx";

/**
 * The sidebar's Pinned section. It shows while something is pinned, and
 * during a drag as a drop target ("Drop here") that pins the workspace. Pins live on the runtime (Workspace.inbox),
 * in the order they were pinned.
 */
export function PinnedSection({ workspaces, renderRow }: { workspaces: ReadonlyArray<WorkspaceView>; renderRow: (w: WorkspaceView) => ReactNode }) {
  const { payload, target } = useDrag();
  const inbox = useInbox();
  const rows = pinnedChats(workspaces);
  const dragging = payload !== null && payload.fromPaneId === null && inbox !== null;
  const pin = useStableCallback((p: DragPayload) => inbox?.(p.workspaceId, { do: "pin" }));
  if (rows.length === 0 && !dragging) return null;
  const here = target?.kind === "pin";
  return (
    <section className="mt-3">
      <h2 className="px-2 pb-1 text-[13.5px] font-normal text-muted-foreground">Pinned</h2>
      {dragging ? <DropRow here={here} already={payload !== null && rows.some((w) => w.id === payload.workspaceId)} onDrop={pin} /> : null}
      {rows.map((w) => (
        <div key={w.id}>{renderRow(w)}</div>
      ))}
    </section>
  );
}

function DropRow({ here, already, onDrop }: { here: boolean; already: boolean; onDrop: (payload: DragPayload) => void }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => registerDropTarget(el.current!, { kind: "pin", onDrop }), [onDrop]);
  return (
    <div
      ref={el}
      className={cn(
        "flex h-[34px] items-center gap-2 rounded-lg border border-dashed pl-2 text-[14.5px] transition-colors duration-75",
        here ? "border-target bg-target/10 text-foreground" : "border-sidebar-foreground/30 text-sidebar-foreground",
      )}
    >
      <Icon icon={PinIcon} className="size-[14px]" />
      {already ? "Already pinned" : "Drop here to pin"}
    </div>
  );
}
