// The "artifact" side panel surface: one tab per workspace showing this
// session's artifacts, the list or the one picked. Registered on import (the
// transcript imports it, so the kind exists wherever artifacts can be opened).
import { useEffect } from "react";
import { loadable } from "../../lib/loadable.ts";
import { defineSurface, type SurfaceProps } from "../../panels/registry.ts";
import { openSurface, updateTab } from "../../panels/store.ts";
import { usePanelWorkspace } from "../../panels/workspace.ts";
import { Icon } from "../transcript/marks.tsx";
import { useArtifacts } from "./store.ts";
import { Layers01Icon } from "@caveman-app/ui/icons/huge";

declare module "../../panels/store.ts" {
  interface SurfaceParams {
    /** This session's artifacts; `artifactId` shows one, absent shows the list. */
    artifact: { artifactId?: string };
  }
}

const ArtifactPanel = loadable(() => import("./ArtifactPanel.tsx").then((m) => ({ default: m.ArtifactPanel })));

function ArtifactSurface({ workspaceId, tab }: SurfaceProps<"artifact">) {
  const sessionId = usePanelWorkspace()?.session_id ?? null;
  const shown = useArtifacts(sessionId).find((a) => a.id === tab.params.artifactId);
  // The tab names what it shows: "retry.go", or "Artifacts" for the list.
  useEffect(() => updateTab(workspaceId, tab.id, { title: shown?.title ?? "Artifacts" }), [workspaceId, tab.id, shown?.title]);
  if (!sessionId) return null;
  return (
    <ArtifactPanel
      sessionId={sessionId}
      workspaceId={workspaceId}
      selected={tab.params.artifactId ?? null}
      onSelect={(artifactId) => openSurface(workspaceId, "artifact", artifactId ? { artifactId } : {})}
    />
  );
}

defineSurface({
  kind: "artifact",
  label: "Artifacts",
  description: "Files, pages, code, tables and links from this chat",
  icon: ({ className }) => <Icon icon={Layers01Icon} {...(className ? { className } : {})} />,
  identity: "one",
  title: () => "Artifacts",
  component: ArtifactSurface,
});
