// A page an agent showed with `html_render` (upstream HtmlRenderFrame and
// HtmlRenderDocument, MIT, adapted): drawn in the chat where it was shown,
// sized to the page, and kept in view when the turn's work folds away. It
// opens at full size as an artifact in the side panel.
//
// The page is agent output, not the app. It is read over the Session Protocol
// (htmlRender.read: this chat's pages only) and framed at a URL that is not
// the app's, sandboxed without allow-same-origin, so its scripts never reach
// the app's session or storage. It speaks to the app only by postMessage: its
// height, and links the reader clicks (opened in the browser, never in the
// frame). The app hands it the chat's theme the same way.
import { Button } from "@caveman-app/ui/components/button";
import { Skeleton } from "@caveman-app/ui/components/skeleton";
import { Icon as HugeIcon, ArrowExpand01Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderReference,
} from "@caveman-app/shared/htmlRender";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openExternal } from "../../panels/browser/BrowserBar.tsx";
import { HTML_FILE_SANDBOX, htmlFileDocument } from "../../panels/browser/htmlFile.ts";
import { useIsolatedDocumentUrl } from "../../panels/browser/isolatedDocument.ts";
import { QuietButton } from "../../panels/chrome.tsx";
import { pageOf, useAppTheme } from "../../state/html-render.ts";
import { useRuntimeClient } from "../../state/runtime.tsx";
import type { ToolItem } from "../../state/transcript-model.ts";
import type { CardActions } from "./ArtifactCards.tsx";
import { useChatWorkspace } from "./root.ts";

/** The artifact id of a tool call's page (state/transcript-artifacts.ts makes it). */
export const pageArtifactId = (toolId: string): string => `${toolId}:page`;

/** The pages a run's tools showed, each where its turn shows it: under the run, or under the folded work. */
export function HtmlPages({
  tools,
  onOpen,
  openId,
}: { tools: ReadonlyArray<ToolItem> } & CardActions) {
  const workspaceId = useChatWorkspace();
  if (workspaceId === null) return null;
  return tools.map((tool) => {
    const page = pageOf(tool);
    if (!page) return null;
    const id = pageArtifactId(tool.id);
    return (
      <div key={tool.id} className="my-2">
        <HtmlPage
          workspaceId={workspaceId}
          page={page}
          onOpen={onOpen ? () => onOpen(id) : undefined}
          open={openId === id}
        />
      </div>
    );
  });
}

type Read =
  | { status: "loading" }
  | { status: "ready"; document: string }
  | { status: "error"; message: string };

export function HtmlPage({
  workspaceId,
  page,
  fill = false,
  onOpen,
  open = false,
}: {
  workspaceId: string;
  page: HtmlRenderReference;
  /** Fill the parent (the side panel), the page scrolling inside, rather than fit the page's height. */
  fill?: boolean;
  onOpen?: (() => void) | undefined;
  /** It is the artifact open in the side panel. */
  open?: boolean;
}) {
  const { client } = useRuntimeClient();
  const box = useRef<HTMLDivElement>(null);
  // Read only once it comes near the view: a long chat's pages don't all load at once.
  const [near, setNear] = useState(fill);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth || HTML_RENDER_COLUMN_WIDTH);
    const resize = new ResizeObserver(
      ([entry]) => entry && entry.contentRect.width > 0 && setWidth(entry.contentRect.width),
    );
    resize.observe(el);
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && setNear(true), {
      rootMargin: "800px 0px",
    });
    seen.observe(el);
    return () => {
      resize.disconnect();
      seen.disconnect();
    };
  }, []);

  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!near || !client) return;
    let live = true;
    setRead({ status: "loading" });
    client
      .call("htmlRender.read", { workspace_id: workspaceId, attachment_id: page.attachmentId })
      .then(
        ({ html }) => live && setRead({ status: "ready", document: htmlFileDocument(html) }),
        (error: unknown) =>
          live &&
          setRead({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [near, client, workspaceId, page.attachmentId, attempt]);
  const isolated = useIsolatedDocumentUrl(read.status === "ready" ? read.document : "");

  // Measured by the page itself once it loads (the app's fonts can wrap it taller than the runtime measured it).
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(page, width, contentHeight);
  const failed = read.status === "error" ? read.message : isolated.error;
  return (
    <div
      ref={box}
      // No card around it: the page sits on the thread like the reply's own text (its layout rules say so to the agent).
      className={cn(
        "group/page relative bg-background",
        fill ? "min-h-0 flex-1" : "w-full",
        open && "rounded-sm ring-1 ring-ring ring-offset-4 ring-offset-background",
      )}
      style={fill ? undefined : { height }}
    >
      {failed ? (
        <div
          role="alert"
          className="flex size-full flex-col items-center justify-center gap-3 px-5 text-center text-[12.5px] text-muted-foreground"
        >
          <span>
            Couldn't show {page.title}. {failed}
          </span>
          <QuietButton onClick={() => setAttempt((n) => n + 1)}>Try again</QuietButton>
        </div>
      ) : isolated.url ? (
        <PageFrame
          key={isolated.url}
          url={isolated.url}
          title={page.title}
          onContentHeight={setContentHeight}
        />
      ) : (
        <Skeleton
          className={cn("size-full", fill ? "rounded-none" : "rounded-xl")}
          aria-label={`Loading ${page.title}`}
        />
      )}
      {onOpen && !fill ? (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/page:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={`Open ${page.title} in the side panel`}
            title="Open in the side panel"
            onClick={onOpen}
          >
            <HugeIcon icon={ArrowExpand01Icon} className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The frame, on the URL it first loaded: a theme change is posted to the page, never a reload. */
function PageFrame({
  url,
  title,
  onContentHeight,
}: {
  url: string;
  title: string;
  onContentHeight: (height: number) => void;
}) {
  const theme = useAppTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  // The theme rides in the fragment too, so the first paint already wears it; later ones are posted, never a reload.
  const [src] = useState(() => `${url}${htmlRenderThemeFragment(theme)}`);
  const postTheme = () =>
    frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  useEffect(postTheme, [theme]);
  const report = useRef(onContentHeight);
  report.current = onContentHeight;
  // At commit, not after paint: a quick page can post its height before passive effects run.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const el = frame.current;
      if (!el || event.source !== el.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) return report.current(height);
      // A page can ask by script, so a link opens only from the reader's own click in it.
      if (document.activeElement !== el || navigator.userActivation?.isActive === false) return;
      const link = readHtmlRenderLinkRequest(event.data);
      if (link === undefined) return;
      openExternal(link.url);
      el.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      src={src}
      title={title}
      // Never allow-same-origin: the page's opaque origin keeps it out of the app's session.
      sandbox={HTML_FILE_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoaded(true);
        postTheme();
      }}
      // The blank document matches the light scheme until the page paints, then follows the app: no white flash.
      className="block size-full border-0"
      style={
        loaded ? { colorScheme: theme.appearance } : { colorScheme: "light", visibility: "hidden" }
      }
    />
  );
}
