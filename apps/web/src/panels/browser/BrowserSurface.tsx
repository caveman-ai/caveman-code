// A browser tab: one chrome over two backends.
//   agent: the runtime's browser on the workspace computer, streamed through
//          the live view; the agent drives and the user can take over.
//   local: a page this client loads itself: a <webview> in the desktop app,
//          a sandboxed frame in a browser.
// A workspace on This Mac defaults to local; anywhere else, to the agent's.

import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { Icon, Camera01Icon, HandIcon, BrowserIcon } from "@caveman-app/ui/icons/huge";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { livesHere, requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { BarButton, BarGroup, matchesChord, QuietButton, SurfaceEmpty } from "../chrome.tsx";
import { LiveView, useLive } from "../live/LiveView.tsx";
import { blobOf, browserSource } from "../live/source.ts";
import type { SurfaceProps } from "../registry.ts";
import { openSurface, updateTab } from "../store.ts";
import { defaultBackend, usePanelWorkspace } from "../workspace.ts";
import { BrowserBar, CHORDS, isWeb, PILL, splitUrl } from "./BrowserBar.tsx";
import { BrowserDialog } from "./BrowserDialog.tsx";
import { BrowserHome, Unreachable, type Unreached } from "./BrowserHome.tsx";
import { remember } from "./recents.ts";
import { download } from "../../lib/download.ts";
import HtmlFileBrowser from "./HtmlFileBrowser.tsx";

const PROBE_TIMEOUT_MS = 8000;
/** A navigation the agent's browser never reports stops spinning after this. */
const PENDING_MS = 15_000;
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
const BAR_CHORDS = Object.values(CHORDS);

// The workspace is read here only; the backends below take what they need as props and are memoized, so a change
// elsewhere in the list doesn't re-render a live page.
export default function BrowserSurface(props: SurfaceProps<"browser">) {
  const engines = useRuntimeSelector((v) => v.engines);
  const workspace = usePanelWorkspace();
  const backend = props.tab.params.backend ?? defaultBackend(workspace);
  // A bare open ({} from the launcher) that resolves to the agent's browser becomes its one tab.
  if (props.tab.params.path) return <HtmlFileBrowser key={props.tab.params.path} {...props} path={props.tab.params.path} />;
  if (backend === "agent" && props.tab.params.backend === undefined) return <ToAgentTab {...props} />;
  if (backend === "agent") return <AgentBrowser {...props} engine={engines.find((e) => e.id === workspace?.engine)?.label ?? "The agent"} onThisMac={workspace ? livesHere(workspace) : false} />;
  if (backend === "local") {
    const partition = window.cavemanDesktop?.browser?.partition;
    return partition ? <DesktopBrowser {...props} partition={partition} /> : <LocalBrowser {...props} />;
  }
  // The workspace hasn't loaded yet: don't guess a backend and swap it under the user.
  return null;
}

function ToAgentTab({ workspaceId, tab }: SurfaceProps<"browser">) {
  useEffect(() => {
    openSurface(workspaceId, "browser", { backend: "agent", ...(tab.params.url ? { url: tab.params.url } : {}) }, { replace: tab.id });
  }, []);
  return null;
}

/** Name the tab after the page, once it settles. */
function useTabTitle(workspaceId: string, tabId: string, title: string) {
  useEffect(() => {
    if (!title) return;
    const timer = setTimeout(() => updateTab(workspaceId, tabId, { title }), 250);
    return () => clearTimeout(timer);
  }, [workspaceId, tabId, title]);
}

/** The bar's shortcuts, while focus is anywhere in the tab. */
function chords(a: { back: () => void; forward: () => void; reload: (hard: boolean) => void; address: () => void }) {
  return (e: KeyboardEvent) => {
    const n = e.nativeEvent;
    const run = matchesChord(n, CHORDS.address)
      ? a.address
      : matchesChord(n, CHORDS.hardReload)
        ? () => a.reload(true)
        : matchesChord(n, CHORDS.reload)
          ? () => a.reload(false)
          : matchesChord(n, CHORDS.back)
            ? a.back
            : matchesChord(n, CHORDS.forward)
              ? a.forward
              : null;
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };
}

function Cover({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col bg-background">{children}</div>;
}

// ------------------------------------------------------------------- agent

async function pngOf(image: { readonly mime_type: string; readonly data: string }): Promise<Blob> {
  const blob = blobOf(image);
  if (image.mime_type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}

const AgentBrowser = memo(function AgentBrowser({ workspaceId, tab, active, engine, onThisMac }: SurfaceProps<"browser"> & { engine: string; onThisMac: boolean }) {
  const { client, connection } = useRuntimeClient();
  const source = useMemo(() => (client ? browserSource(client, workspaceId) : null), [client, workspaceId]);
  const live = useLive(source, active, connection);
  const state = live.state;
  const driving = live.holding && live.controller === "user";
  const unavailable = live.status === "unavailable";
  // The address the user asked for, shown until the agent's browser settles.
  const [pending, setPending] = useState<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [focusNonce, setFocusNonce] = useState(0);
  const [flash, setFlash] = useState({ text: "", open: false });
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sent = useRef<string | null>(null);

  const shown = pending ?? state?.url ?? "";
  const page = shown === "about:blank" ? "" : shown;
  const [host] = splitUrl(page);

  useEffect(
    () => () => {
      clearTimeout(pendingTimer.current);
      clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (state && (!state.loading || state.url === pending)) setPending(null);
    // Only a new state settles it; `pending` changing is the user asking.
  }, [state]);

  const navigate = (url: string) => {
    if (!client) return;
    setPending(url);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => setPending((p) => (p === url ? null : p)), PENDING_MS);
    void client.call("browser.navigate", { request_id: requestId(), workspace_id: workspaceId, url }).catch(() => setPending(null));
  };
  const history = (action: "back" | "forward" | "reload", hard = false) => void client?.call("browser.history", { request_id: requestId(), workspace_id: workspaceId, action, ...(hard ? { ignore_cache: true } : {}) }).catch(() => undefined);

  // A tab opened on an address (the launcher, a local server) sends the agent's browser there, once.
  useEffect(() => {
    const url = tab.params.url;
    const key = `${url}#${tab.reveal}`;
    if (!url || !client || sent.current === key) return;
    sent.current = key;
    navigate(url);
    updateTab(workspaceId, tab.id, { params: { url: undefined } });
  }, [tab.params.url, tab.reveal, client]);

  useTabTitle(workspaceId, tab.id, state?.title || host);
  useEffect(() => {
    if (state && !state.loading) remember(workspaceId, state.url, state.title);
  }, [workspaceId, state?.url, state?.loading, state?.title]);

  const say = (text: string) => {
    setFlash({ text, open: true });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash((f) => ({ ...f, open: false })), 1400);
  };
  const screenshot = () => {
    if (!client) return;
    const png = client.call("browser.snapshot", { workspace_id: workspaceId }).then((s) => pngOf(s.image));
    const save = () =>
      png.then(
        (b) => {
          download(b, `${host || "page"}.png`);
          say("Saved as a file");
        },
        () => say("Couldn't take a screenshot"),
      );
    try {
      // The promise keeps the click's permission to write while the snapshot is taken.
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => say("Copied"), save);
    } catch {
      void save();
    }
  };

  // The agent's browser is on the workspace computer: its localhost is only this device's when that computer is this one.
  const external = isWeb(page) && (onThisMac || !LOOPBACK.test(new URL(page).hostname));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={chords({
        back: () => state?.can_go_back && history("back"),
        forward: () => state?.can_go_forward && history("forward"),
        reload: (hard) => page && history("reload", hard),
        address: () => setFocusNonce((n) => n + 1),
      })}
    >
      <BrowserBar
        url={page}
        loading={!unavailable && (pending !== null || !!state?.loading)}
        canBack={!!state?.can_go_back}
        canForward={!!state?.can_go_forward}
        disabled={unavailable || !client}
        focusNonce={focusNonce}
        onBack={() => history("back")}
        onForward={() => history("forward")}
        onReload={(hard) => history("reload", hard)}
        onSubmit={navigate}
        external={external}
        actions={
          <BarGroup className={PILL}>
            <Tooltip open={flash.open}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <BarButton size="sm" className="rounded-full" label="Copy screenshot" disabled={!live.frame} onClick={screenshot}>
                    <Icon icon={Camera01Icon} />
                  </BarButton>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{flash.text}</TooltipContent>
            </Tooltip>
            <BarButton size="sm" className="rounded-full" label={driving ? "Hand back" : "Take over"} pressed={driving} disabled={!live.frame} onClick={() => live.control(driving ? "agent" : "user")}>
              <Icon icon={HandIcon} />
            </BarButton>
          </BarGroup>
        }
      />
      {unavailable ? (
        <SurfaceEmpty icon={BrowserIcon} title="The agent's browser isn't running">It opens here when the agent checks a page.</SurfaceEmpty>
      ) : live.status === "error" ? (
        <SurfaceEmpty title="The browser stopped streaming" action={<QuietButton onClick={live.retry}>Try again</QuietButton>}>
          The runtime didn't answer. It may be restarting.
        </SurfaceEmpty>
      ) : source ? (
        <LiveView
          source={source}
          live={live}
          engine={engine}
          align="top"
          chords={BAR_CHORDS}
          onHistory={(action) => (action === "back" ? state?.can_go_back : state?.can_go_forward) && history(action)}
          placeholder={page ? undefined : <BrowserHome workspaceId={workspaceId} onOpen={navigate} hint="Enter an address and the agent's browser opens it. Servers on its computer show up here." />}
          overlay={state?.dialog ? <BrowserDialog dialog={state.dialog} driving={driving} source={source} /> : null}
        />
      ) : null}
    </div>
  );
});

// ------------------------------------------------------------------- local

type Load = { readonly phase: "probing" | "loading" | "loaded" } | { readonly phase: "unreachable"; readonly error: string; readonly why: Unreached };

function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return true;
  }
}

const LocalBrowser = memo(function LocalBrowser({ workspaceId, tab }: SurfaceProps<"browser">) {
  // ponytail: back and forward walk the addresses entered here; a link clicked inside a cross-origin page can't be
  // seen, so it adds no entry and doesn't change the address. The desktop's webview (DesktopBrowser) has neither ceiling.
  const [nav, setNav] = useState<{ entries: ReadonlyArray<string>; index: number }>(() => (tab.params.url ? { entries: [tab.params.url], index: 0 } : { entries: [], index: -1 }));
  const url = nav.entries[nav.index] ?? "";
  // Each visit (a navigation or a reload) probes the address, then loads it in a fresh frame.
  const [visit, setVisit] = useState({ n: 0, hard: false });
  const [load, setLoad] = useState<Load>({ phase: "probing" });
  const [frame, setFrame] = useState<{ src: string; key: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [host] = splitUrl(url);

  const reload = (hard: boolean) => url && setVisit((v) => ({ n: v.n + 1, hard }));
  const go = (delta: -1 | 1) => setNav((n) => (n.entries[n.index + delta] ? { ...n, index: n.index + delta } : n));
  const push = (next: string) => {
    if (next === url) return reload(false);
    setNav((n) => ({ entries: [...n.entries.slice(0, n.index + 1), next], index: n.index + 1 }));
  };

  // Opened again on another address (the tab's params changed under it).
  useEffect(() => {
    const next = tab.params.url;
    if (next && next !== url) push(next);
  }, [tab.params.url, tab.reveal]);

  useEffect(() => {
    if (url) updateTab(workspaceId, tab.id, { params: { url } });
  }, [workspaceId, tab.id, url]);
  useTabTitle(workspaceId, tab.id, host);

  useEffect(() => {
    if (!url) return;
    if (!isWeb(url)) return setLoad({ phase: "unreachable", why: "not_web", error: "" });
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, PROBE_TIMEOUT_MS);
    setLoad({ phase: "probing" });
    // An opaque answer is enough: something is listening. A hard reload refetches the document past the cache.
    fetch(url, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", signal: abort.signal, ...(visit.hard ? { cache: "reload" } : { method: "HEAD", cache: "no-store" }) })
      .then(
        () => {
          setLoad({ phase: "loading" });
          setFrame((f) => ({ src: url, key: (f?.key ?? 0) + 1 }));
        },
        (error: unknown) => {
          if (abort.signal.aborted && !timedOut) return;
          setLoad({ phase: "unreachable", why: timedOut ? "timeout" : "refused", error: timedOut ? `No answer in ${PROBE_TIMEOUT_MS / 1000}s` : error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [url, visit]);

  const loading = !!url && (load.phase === "probing" || load.phase === "loading");
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={chords({ back: () => go(-1), forward: () => go(1), reload, address: () => setFocusNonce((n) => n + 1) })}>
      <BrowserBar
        url={url}
        loading={loading}
        canBack={nav.index > 0}
        canForward={nav.index < nav.entries.length - 1}
        focusNonce={focusNonce}
        onBack={() => go(-1)}
        onForward={() => go(1)}
        onReload={reload}
        onSubmit={push}
        external={isWeb(url)}
      />
      <div className="relative min-h-0 flex-1">
        {frame ? (
          <iframe
            key={frame.key}
            src={frame.src}
            title={splitUrl(frame.src).join("")}
            // A page from the app's own origin never gets allow-same-origin: with scripts it could reach into the app.
            // ponytail: a page that forbids framing (X-Frame-Options, frame-ancestors) shows the browser's own error; the frame can't tell us.
            sandbox={`allow-scripts allow-forms allow-popups allow-downloads${sameOrigin(frame.src) ? "" : " allow-same-origin"}`}
 // A page's video can go full screen, as in a browser tab (upstream #21378).
            allow="fullscreen"
            referrerPolicy="no-referrer"
            className="absolute inset-0 size-full border-0 bg-white"
            onLoad={() => {
              if (frame.src !== url) return;
              setLoad({ phase: "loaded" });
              remember(workspaceId, url);
            }}
          />
        ) : null}
        {!url ? (
          <Cover>
            <BrowserHome workspaceId={workspaceId} onOpen={push} hint="Enter an address above, or start a dev server. Servers listening on this computer show up here." />
          </Cover>
        ) : load.phase === "unreachable" ? (
          <Cover>
            <Unreachable url={url} error={load.error} why={load.why} onReload={() => reload(false)} />
          </Cover>
        ) : null}
      </div>
    </div>
  );
});

// ----------------------------------------------------------------- desktop

/** The <webview> methods used here (Electron's WebviewTag). They throw until the guest's first dom-ready. */
interface Webview extends HTMLWebViewElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
}
type GuestEvent = Event & { url?: string; isMainFrame?: boolean; title?: string; errorCode?: number; errorDescription?: string; validatedURL?: string };

/** Chromium's net errors for a server that never answered in time (net_error_list.h); -3 is a navigation replaced by another. */
const TIMED_OUT = new Set([-7, -118]);
const ABORTED = -3;

// A page of its own (apps/desktop/src/browser.ts), not a frame: sites that refuse framing open, and its history is the
// guest's, links included.
const DesktopBrowser = memo(function DesktopBrowser({ workspaceId, tab, partition }: SurfaceProps<"browser"> & { partition: string }) {
  const view = useRef<Webview>(null);
  const ready = useRef(false);
  // The address this tab last wrote to its params: the guest's own navigation, not a request to open one.
  const written = useRef<string | undefined>(undefined);
  const first = tab.params.url ?? "";
  // The first web address mounts the guest; after that it navigates itself.
  const [src, setSrc] = useState(() => (isWeb(first) ? first : ""));
  const [page, setPage] = useState({ url: first, title: "", loading: false, back: false, forward: false });
  const [failed, setFailed] = useState<{ why: Unreached; error: string } | null>(() => (first && !isWeb(first) ? { why: "not_web", error: "" } : null));
  const [focusNonce, setFocusNonce] = useState(0);
  const [host] = splitUrl(page.url);

  const open = (url: string) => {
    if (!isWeb(url)) {
      setPage((p) => ({ ...p, url }));
      return setFailed({ why: "not_web", error: "" });
    }
    setFailed(null);
    // A failure arrives as did-fail-load.
    if (ready.current && view.current) void view.current.loadURL(url).catch(() => undefined);
    else setSrc(url);
  };
  const reload = (hard: boolean) => {
    const v = view.current;
    if (!page.url) return;
    // A load that failed never committed: reload() would repeat the page before it.
    if (failed || !v || !ready.current) return open(page.url);
    if (hard) v.reloadIgnoringCache();
    else v.reload();
  };
  // The shell asks first; a cleared browser reloads the page signed out.
  const clearData = window.cavemanDesktop?.browser?.clearData;
  const back = () => page.back && view.current?.goBack();
  const forward = () => page.forward && view.current?.goForward();

  const mounted = src !== "";
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const history = () => setPage((p) => ({ ...p, back: v.canGoBack(), forward: v.canGoForward() }));
    const on: Record<string, (e: GuestEvent) => void> = {
      "dom-ready": () => {
        ready.current = true;
        // The desktop replays the app's chords pressed in this page here (apps/desktop src/guestKeys.ts).
        v.dataset.guestId = String(v.getWebContentsId());
        history();
      },
      "did-start-loading": () => setPage((p) => ({ ...p, loading: true })),
      "did-stop-loading": () => {
        setPage((p) => ({ ...p, loading: false }));
        history();
      },
      "did-navigate": (e) => {
        setFailed(null);
        setPage((p) => ({ ...p, url: e.url ?? p.url }));
        history();
      },
      "did-navigate-in-page": (e) => {
        if (!e.isMainFrame) return;
        setPage((p) => ({ ...p, url: e.url ?? p.url }));
        history();
      },
      "page-title-updated": (e) => setPage((p) => ({ ...p, title: e.title ?? "" })),
      "did-fail-load": (e) => {
        if (!e.isMainFrame || e.errorCode === ABORTED) return;
        setPage((p) => ({ ...p, url: e.validatedURL || p.url }));
        setFailed({ why: TIMED_OUT.has(e.errorCode ?? 0) ? "timeout" : "refused", error: e.errorDescription ?? "" });
      },
      // Ported from T3: a click in the guest reaches this document only as focus on the webview, so an open menu
      // never sees the outside press that would close it.
      focus: () => v.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })),
    };
    for (const [name, fn] of Object.entries(on)) v.addEventListener(name, fn as EventListener);
    return () => {
      for (const [name, fn] of Object.entries(on)) v.removeEventListener(name, fn as EventListener);
    };
  }, [mounted]);

  // Opened again on another address (the tab's params changed under it).
  useEffect(() => {
    const next = tab.params.url;
    if (next && next !== page.url && next !== written.current) open(next);
  }, [tab.params.url, tab.reveal]);

  useEffect(() => {
    if (!page.url) return;
    written.current = page.url;
    updateTab(workspaceId, tab.id, { params: { url: page.url } });
  }, [workspaceId, tab.id, page.url]);
  useTabTitle(workspaceId, tab.id, page.title || host);
  useEffect(() => {
    if (!page.loading && !failed) remember(workspaceId, page.url, page.title);
  }, [workspaceId, page.url, page.loading, page.title, failed]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={chords({ back, forward, reload, address: () => setFocusNonce((n) => n + 1) })}>
      <BrowserBar
        url={page.url}
        loading={page.loading && !failed}
        canBack={page.back}
        canForward={page.forward}
        focusNonce={focusNonce}
        onBack={back}
        onForward={forward}
        onReload={reload}
        onSubmit={open}
        external={isWeb(page.url)}
        onClearData={clearData ? () => void clearData().then((cleared) => cleared && reload(false)) : undefined}
      />
      <div className="relative min-h-0 flex-1">
        {mounted ? (
          <webview
            ref={view}
            src={src}
            partition={partition}
            // Without it window.open returns null in the guest and target=_blank links do nothing; main opens them in
            // this tab. An attribute Electron reads on attach, which react-dom drops as a boolean (as in T3).
            {...({ allowpopups: "true" } as object)}
            className="absolute inset-0 size-full bg-white"
          />
        ) : null}
        {!page.url ? (
          <Cover>
            <BrowserHome workspaceId={workspaceId} onOpen={open} hint="Enter an address above, or start a dev server. Servers listening on this computer show up here." />
          </Cover>
        ) : failed ? (
          <Cover>
            <Unreachable url={page.url} error={failed.error} why={failed.why} onReload={() => reload(false)} />
          </Cover>
        ) : null}
      </div>
    </div>
  );
});
