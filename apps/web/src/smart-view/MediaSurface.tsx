// A picture or a clip in the side panel (Smart View's "media" surface). From a chat's checkout it is the file viewer
// itself, reading through the person's own client; from an address, the page's own <img> or <video>, never a frame.
// An address off this computer the person didn't ask for (`gate`, and every `web` here) waits for their Load: a Chief
// steered by text it read can't make the app fetch an address on its own (session-protocol smartView.ts autoLoads).
import { useState } from "react";
import { QuietButton, SurfaceEmpty } from "../panels/chrome.tsx";
import { useFileContent } from "../panels/files/fileContent.tsx";
import { FileView } from "../panels/files/FileView.tsx";
import type { SurfaceProps } from "../panels/registry.ts";
import { openSurface } from "../panels/store.ts";
import { safeUrl } from "@caveman-app/session-protocol/smart-view";
import { retargetShown } from "./apply.ts";

export default function MediaSurface({ workspaceId, tab }: SurfaceProps<"media">) {
  const { media, url, workspace_id, path, gate } = tab.params;
  const [loaded, setLoaded] = useState(false);
  if (url !== undefined) {
    const safe = safeUrl(url);
    if (!safe) return <SurfaceEmpty title="Nothing to show">{url}</SurfaceEmpty>;
    if (media === "web" || (gate && !loaded)) {
      const what = media === "web" ? "page" : media === "video" ? "clip" : "picture";
      const load = () => {
        if (media !== "web") return setLoaded(true);
        // The page takes this tab's place; Smart View's record follows it, so the gate going is no close.
        retargetShown(tab.id, openSurface(workspaceId, "browser", { url: safe, backend: "local" }, { replace: tab.id }));
      };
      return (
        <SurfaceEmpty title={`Load this ${what} from ${new URL(safe).host}?`} action={<QuietButton onClick={load}>Load</QuietButton>}>
          <span className="break-all">{safe}</span>
          <br />
          Smart View loads addresses off this computer only when you say so.
        </SurfaceEmpty>
      );
    }
    return <FromUrl media={media} url={safe} />;
  }
  if (workspace_id && path) return <FromChat workspaceId={workspace_id} path={path} />;
  return <SurfaceEmpty title="Nothing to show">This preview names no file or address.</SurfaceEmpty>;
}

function FromChat({ workspaceId, path }: { workspaceId: string; path: string }) {
  const { state, retry } = useFileContent(workspaceId, path, undefined, 0);
  return <FileView workspaceId={workspaceId} root={undefined} path={path} state={state} mode="preview" wrap={false} revealLine={undefined} onLink={() => {}} onRetry={retry} />;
}

function FromUrl({ media, url }: { media: "image" | "video"; url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <SurfaceEmpty title={media === "video" ? "Couldn't play this clip" : "Couldn't show this picture"}>{url}</SurfaceEmpty>;
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      {media === "video" ? (
        <video controls preload="metadata" src={url} onError={() => setFailed(true)} className="max-h-[80vh] w-full max-w-3xl rounded-lg border border-border bg-black" />
      ) : (
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-full max-w-full rounded-md object-contain" />
      )}
    </div>
  );
}
