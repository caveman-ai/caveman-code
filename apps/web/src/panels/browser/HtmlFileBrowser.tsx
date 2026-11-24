// A local HTML document in the Browser surface, on both desktop and web.
// A blob document is deliberately separate from the authenticated app and its webview
// profiles: agent-generated scripts never inherit cookies, storage or preload.
import { Icon, CodeIcon, LinkSquare02Icon, ViewIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CodeView } from "@caveman-app/ui/markdown/CodeView";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton, BarGroup, QuietButton, SurfaceEmpty } from "../chrome.tsx";
import { openInEditor, preferredEditor, useEditors } from "../files/editors.ts";
import { useFilesVersion } from "../files/fileContent.tsx";
import { RevealButton } from "../files/FileMenu.tsx";
import { baseName } from "../files/tree.ts";
import type { SurfaceProps } from "../registry.ts";
import { openSurface } from "../store.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { outsideWorkspace } from "../../state/workspace-paths.ts";
import { BrowserBar, PILL } from "./BrowserBar.tsx";
import { HTML_FILE_SANDBOX, htmlFileDocument, htmlRead } from "./htmlFile.ts";
import { useIsolatedDocumentUrl } from "./isolatedDocument.ts";

export default function HtmlFileBrowser({ workspaceId, tab, path }: SurfaceProps<"browser"> & { path: string }) {
  const { client, connection } = useRuntimeClient();
  const sessionId = usePanelWorkspace()?.session_id ?? null;
  const { version, watch } = useFilesVersion(sessionId, connection);
  const [state, dispatch] = useReducer(htmlRead, { status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const asked = useRef<string | null>(null);
  const [source, setSource] = useState(tab.params.source ?? false);
  useEffect(() => setSource(tab.params.source ?? false), [tab.reveal, tab.params.source]);

  useEffect(() => {
    if (!client || version === null) return;
    let live = true;
    const ask = `${attempt}:${tab.reveal}`;
    dispatch({ read: asked.current === ask ? "again" : "fresh" });
    asked.current = ask;
    client.call("browser.readFile", { workspace_id: workspaceId, path }).then(
      ({ html }) => live && dispatch({ html }),
      (error: unknown) => live && dispatch({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { live = false; };
  }, [client, workspaceId, path, version, attempt, tab.reveal]);
  const document = useMemo(() => state.status === "ready" ? htmlFileDocument(state.html) : "", [state]);
  const page = useIsolatedDocumentUrl(document);
  const reload = () => setAttempt((n) => n + 1);
  // A page outside the chat's folder (a host path) opens in no editor: editor.open takes workspace paths only.
  const outside = outsideWorkspace(path, usePanelWorkspace()?.root_path);
  const editors = useEditors();
  const editor = outside ? null : preferredEditor(editors);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrowserBar
        url={path}
        loading={state.status === "loading"}
        canBack={false}
        canForward={false}
        focusNonce={0}
        onBack={() => {}}
        onForward={() => {}}
        onReload={reload}
        onSubmit={(url) => openSurface(workspaceId, "browser", { url }, { replace: tab.id })}
        external={false}
        actions={<BarGroup className={PILL}>
          <BarButton size="sm" className="rounded-full" label={source ? "Show HTML preview" : "Show HTML source"} pressed={source} onClick={() => setSource((s) => !s)}>
            {source ? <Icon icon={ViewIcon} /> : <Icon icon={CodeIcon} />}
          </BarButton>
          {editor ? (
            <BarButton size="sm" className="rounded-full" label={`Open in ${editor.label}`} onClick={() => void openInEditor(client, workspaceId, path, { line: tab.params.line, editor: editor.id }).catch(() => {})}>
              <Icon icon={LinkSquare02Icon} />
            </BarButton>
          ) : null}
          <RevealButton size="sm" className="rounded-full" workspaceId={workspaceId} path={path} />
        </BarGroup>}
      />
      {state.status === "loading" ? <SurfaceEmpty title="Loading HTML…" /> : state.status === "error" || page.error ? (
        <SurfaceEmpty title="Couldn't open this HTML file" action={<QuietButton onClick={reload}>Retry</QuietButton>}>{state.status === "error" ? state.message : page.error}</SurfaceEmpty>
      ) : source ? <CodeView code={state.html} path={path} wrap revealLine={tab.params.line} className="min-h-0 flex-1" /> : (
        <iframe
          title={`HTML preview: ${baseName(path)}`}
          src={page.url ?? "about:blank"}
          sandbox={HTML_FILE_SANDBOX}
 // Lets the page's video or image viewer take the screen (upstream #21378).
          allow="fullscreen"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
      {watch}
    </div>
  );
}
