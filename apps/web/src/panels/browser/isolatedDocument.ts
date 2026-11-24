// A URL for untrusted HTML that is not the app's: agent-written scripts never
// inherit the app's cookies, storage or preload. Frame it with HTML_FILE_SANDBOX.
import { useEffect, useState } from "react";

/**
 * The document at its own URL, released when it changes or the caller unmounts. In a browser, a blob: unlike srcDoc
 * it has its own document URL, so #anchors stay in the page instead of resolving to (and navigating into) the app.
 * On the desktop the app's strict CSP would carry over to a blob or srcDoc, so its dedicated non-app protocol host
 * serves the page with its own sandboxing policy. `url` is null while it is being made and for an empty document.
 */
export function useIsolatedDocumentUrl(document: string): {
  url: string | null;
  error: string | null;
} {
  const [page, setPage] = useState<{ document: string; url: string } | null>(null);
  const [failed, setFailed] = useState<{ document: string; message: string } | null>(null);
  useEffect(() => {
    if (!document) return;
    const desktop = window.cavemanDesktop?.htmlPreview;
    let live = true;
    let url: string | null = null;
    const release = (url: string) => (desktop ? desktop.release(url) : URL.revokeObjectURL(url));
    void (
      desktop
        ? desktop.create(document)
        : Promise.resolve(
            URL.createObjectURL(new Blob([document], { type: "text/html;charset=utf-8" })),
          )
    )
      .then((value) => {
        if (!value) throw new Error("The HTML preview could not be created. Try reloading it.");
        url = value;
        if (live) setPage({ document, url });
        else release(url);
      })
      .catch((error: unknown) => {
        if (live)
          setFailed({ document, message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
      if (url) release(url);
    };
  }, [document]);
  return {
    url: document && page?.document === document ? page.url : null,
    error: document && failed?.document === document ? failed.message : null,
  };
}
