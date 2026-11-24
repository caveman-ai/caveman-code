import { geometry, leaves, type Layout } from "../../panes/tree.ts";
import type { ChatStatus } from "../../state/model.ts";

/**
 * A tab's panes as they sit, in miniature: a split tab's mark in the tab strip, and beside a chat in the sidebar, where
 * it is open. `lit` is the pane picked out (the strip: the focused one; the sidebar: the chat's own), quieter when
 * `faint` (its tab is behind). With `statuses`, one that needs you is amber, one that failed red, so a waiting chat
 * shows from any tab.
 */
export function SplitMap({ layout, lit, faint = false, statuses }: { layout: Layout; lit: string | null; faint?: boolean; statuses?: ReadonlyMap<string, ChatStatus | null> }) {
  const W = 16;
  const H = 12;
  const gap = 1.5;
  const rects = geometry(layout.root).panes;
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0 overflow-visible">
      {leaves(layout.root).map((p) => {
        const r = rects.get(p.id)!;
        const s = p.workspaceId ? statuses?.get(p.workspaceId) : null;
        const fill = s?.action
          ? "fill-warning"
          : s?.id === "failed"
            ? "fill-destructive"
            : p.id === lit
              ? faint
                ? "fill-muted-foreground/75"
                : "fill-foreground/85"
              : faint
                ? "fill-muted-foreground/30"
                : "fill-muted-foreground/45";
        return <rect key={p.id} x={r.x * W + gap / 2} y={r.y * H + gap / 2} width={Math.max(1, r.w * W - gap)} height={Math.max(1, r.h * H - gap)} rx={1} className={fill} />;
      })}
    </svg>
  );
}
