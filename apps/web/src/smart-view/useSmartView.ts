// Smart View on the Chief's page: follows what this Chief put in the sidebar (chief.view.get, then
// chief.view.updated) and applies it to the Chief's side panel (apply.ts). What arrived while the page was away waits
// behind, pulsing. Mounted once by the Chief's page (routes/Chief.tsx).
import type { ChiefView } from "@caveman-app/session-protocol";
import { useEffect, useRef } from "react";
import { usePanel } from "../panels/store.ts";
import { requestId, useRuntimeClient } from "../state/runtime.tsx";
import { applyView, type ApplyContext } from "./apply.ts";
import { watchTouches } from "./sidebar.ts";
import "./surfaces.tsx";

export function useSmartView(chiefId: string | null, panelId: string | null, narrow: boolean): void {
  const { client } = useRuntimeClient();
  const tabs = usePanel(panelId ?? "").tabs;
  /** The list as last heard, and how to apply it, for the pass a tab change runs. */
  const last = useRef<{ view: ChiefView; ctx: Omit<ApplyContext, "visible"> } | null>(null);
  useEffect(() => watchTouches(), []);
  useEffect(() => {
    last.current = null;
    if (!client || !chiefId || !panelId) return;
    let live = true;
    let away = true;
    const ctx = {
      panelId,
      narrow,
      dismiss: (id: string) => void client.call("chief.view.dismiss", { request_id: requestId(), chief_id: chiefId, id }).catch(() => undefined),
    };
    const apply = (view: ChiefView) => {
      if (!live || view.chief_id !== chiefId) return;
      last.current = { view, ctx };
      applyView(view, { ...ctx, visible: !away && document.visibilityState === "visible" });
      away = false;
    };
    const off = client.on("chief.view.updated", apply);
    client.call("chief.view.get", { chief_id: chiefId }).then(apply, () => undefined);
    return () => {
      live = false;
      off();
    };
  }, [client, chiefId, panelId, narrow]);
  // The panel's tabs changed (its strip, or a tab in a pane of its own: the view is new either way): a Smart View tab
  // the person closed is told to the runtime; nothing else moves.
  useEffect(() => {
    if (last.current) applyView(last.current.view, { ...last.current.ctx, visible: false });
  }, [tabs]);
}
