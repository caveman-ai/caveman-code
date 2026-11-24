// A shell (or one command: an action, Run) in the workspace, on xterm.js,
// edge to edge like Codex's terminal tab. A command's run starts elsewhere
// (run.ts) and its tab attaches to it. The runtime owns the process:
// leaving the tab, the workspace or the page only detaches; reopening
// attaches and replays the scrollback. Only the user closing the tab (the
// registry's onClose) or Kill ends it. The floating action pill follows
// upstream ThreadTerminalDrawer (MIT, apps/web/src/components/
// ThreadTerminalDrawer.tsx @ ab3a3cd1).
//
// Two effects: the view (one xterm per mount and Restart) and the link (open
// or attach, once per connection). A reconnect re-attaches into the same
// xterm, so focus, size and the hidden tabs' grids survive it.

import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { cn } from "@caveman-app/ui/lib/cn";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Icon, Add01Icon, Delete02Icon, EraserIcon, Undo02Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { requestId, useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton, IS_MAC, matchesChord, QuietButton, SurfaceEmpty } from "../chrome.tsx";
import { launcherSurfaces, surfaceDef, type SurfaceProps } from "../registry.ts";
import { closeTab, getTabs, openSurface, updateTab, type Tab } from "../store.ts";
import { deckTheme } from "./theme.ts";
import { chord } from "../../state/keybindings.ts";
import { tabDigit } from "../../shell/tab-nav.ts";
import { baseName } from "../../lib/paths.ts";

type Status = { kind: "live" } | { kind: "exited"; code: number | null; signal?: string } | { kind: "gone" } | { kind: "error"; message: string };

/** Output after this much quiet, in a hidden tab, flags it. */
const IDLE_MS = 4_000;
const FONT_SIZE = 12.5;
/** The code font and size from Settings > Appearance (the root size scales it like every other text). */
const fontFamilyNow = () => getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() || "ui-monospace, monospace";
const fontSizeNow = () => (FONT_SIZE * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)) / 16;

/**
 * The app's chords (the window's tabs, SidePanel's and each surface's), so xterm doesn't act on them too. Off the Mac
 * the panel leaves the shell its Ctrl keys, all but Ctrl+`.
 */
const forPanel = (e: KeyboardEvent) =>
  IS_MAC
    ? tabDigit(e) !== null ||
      [chord("app.newTab"), chord("app.nextTab"), chord("app.previousTab"), chord("app.reopenTab"), chord("app.openFile"), chord("app.sidePanel"), ...launcherSurfaces().flatMap((d) => (d.chord ? [d.chord] : []))].some((c) => matchesChord(e, c))
    : matchesChord(e, chord("app.terminal"));


/** Tab ids repeat across workspaces (`terminal:run:<command>`); module-wide maps key by both. */
const tabKey = (workspaceId: string, tabId: string) => `${workspaceId}\n${tabId}`;

/** One term.open per tab, even when StrictMode (or a fast remount) runs the effect twice. */
const opening = new Map<string, Promise<string>>();

function openOnce(client: Client, workspaceId: string, tab: Tab<"terminal">, size: { cols: number; rows: number }): Promise<string> {
  const key = tabKey(workspaceId, tab.id);
  const pending = opening.get(key);
  if (pending) return pending;
  const p = client
    .call("term.open", { request_id: requestId(), workspace_id: workspaceId, ...size, ...(tab.params.command ? { command: tab.params.command } : {}) })
    .then(({ terminal_id }) => {
      const now = getTabs(workspaceId).find((t) => t.id === tab.id) as Tab<"terminal"> | undefined;
      // The tab closed while the shell started: nothing will ever attach to it.
      if (!now) {
        void client.call("term.close", { request_id: requestId(), terminal_id }).catch(() => undefined);
        throw new Error("The tab closed.");
      }
      // A run started elsewhere (run.ts) got the tab first: show that one, end this.
      if (now.params.terminalId && now.params.terminalId !== terminal_id) {
        void client.call("term.close", { request_id: requestId(), terminal_id }).catch(() => undefined);
        return now.params.terminalId;
      }
      updateTab(workspaceId, tab.id, { params: { terminalId: terminal_id } });
      return terminal_id;
    });
  opening.set(key, p);
  const done = () => void opening.delete(key);
  p.then(done, done);
  return p;
}

/**
 * Which attach owns each terminal's flow on this connection. A late answer to an older attach
 * (a resend after a reconnect) must not detach the newer one: detach is per connection, not per call.
 */
const owners = new Map<string, object>();

/** What the view effect and the link effect share for one xterm. */
interface View {
  readonly term: Terminal;
  /** Resolves once the xterm is in the DOM (after the font loads). */
  ready: Promise<void>;
  id: string | null;
  /** The terminal this view shows: the tab's when it mounted, or the one it opened. Another one in the tab is a new run to show. */
  target: string | null;
  /** term.attach answered on this connection: output from here on is new (the rest is in the scrollback). */
  attached: boolean;
  /** The host has had a real size. Until then the grid is xterm's 80x24 guess and is never sent to the process. */
  fitted: boolean;
  /** The process's size as last told or reported. */
  pty: { cols: number; rows: number } | null;
  /** Tell the process the grid's size, if it has a real one that differs. Debounced. */
  syncSize: () => void;
  /** Set while attached: fetch the scrollback again after term.resync (this window fell behind and output was dropped). */
  resync: (() => Promise<void>) | null;
  /** Output that arrives while a resync waits for its scrollback: it comes after it. */
  held: string[] | null;
}

export default function TerminalSurface({ workspaceId, tab, active }: SurfaceProps<"terminal">) {
  const { client, connection } = useRuntimeClient();
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const exitBar = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "live" });
  // Bumped by Restart and Retry: a new xterm and a new process (or the same one again, for Retry).
  const [generation, setGeneration] = useState(0);
  const tabRef = useRef(tab);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    tabRef.current = tab;
    activeRef.current = active;
  });

  // The view: one xterm, its addons, input, output and sizing.
  useEffect(() => {
    const el = host.current;
    if (!client || !el) return;
    const fontFamily = fontFamilyNow();
    const term = new Terminal({
      fontFamily,
      fontSize: fontSizeNow(),
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      scrollback: 5000,
      macOptionClickForcesSelection: true,
      theme: deckTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // A server's URL opens beside the terminal, not in a new window.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openSurface(workspaceId, "browser", { url: uri });
      }),
    );
    term.attachCustomKeyEventHandler((e) => !forPanel(e));

    let disposed = false;
    let lastOutput = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const v: View = {
      term,
      ready: Promise.resolve(),
      id: null,
      target: tabRef.current.params.terminalId ?? null,
      attached: false,
      fitted: false,
      pty: null,
      resync: null,
      held: null,
      syncSize: () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const { id, pty } = v;
          if (!v.attached || !id || !v.fitted || (pty && pty.cols === term.cols && pty.rows === term.rows)) return;
          v.pty = { cols: term.cols, rows: term.rows };
          void client.call("term.resize", { request_id: requestId(), terminal_id: id, cols: term.cols, rows: term.rows }).catch(() => undefined);
        }, 80);
      },
    };
    view.current = v;

    const flag = () => {
      if (!activeRef.current) updateTab(workspaceId, tabRef.current.id, { attention: true });
    };
    const offOutput = client.on("term.output", (p) => {
      if (!v.attached || p.terminal_id !== v.id) return;
      if (v.held) {
        v.held.push(p.data);
        return;
      }
      term.write(p.data);
      const now = Date.now();
      if (now - lastOutput > IDLE_MS) flag();
      lastOutput = now;
    });
    // The runtime dropped output this window was too slow for: its scrollback replaces the screen.
    const offResync = client.on("term.resync", (p) => {
      if (p.terminal_id === v.id) void v.resync?.();
    });
    const offExit = client.on("term.exit", (p) => {
      if (p.terminal_id !== v.id) return;
      setStatus({ kind: "exited", code: p.exit_code, ...(p.signal ? { signal: p.signal } : {}) });
      flag();
    });
    const input = term.onData((data) => {
      if (v.attached && v.id) void client.call("term.write", { request_id: requestId(), terminal_id: v.id, data }).catch(() => undefined);
    });
    // Hidden tabs are display:none (zero-sized): fitting them would shrink the grid to nothing.
    const refit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      v.fitted = true;
      v.syncSize();
    };
    const ro = new ResizeObserver(refit);
    const themeWatch = new MutationObserver(() => {
      term.options.theme = deckTheme();
      const [family, size] = [fontFamilyNow(), fontSizeNow()];
      if (term.options.fontFamily === family && term.options.fontSize === size) return;
      term.options.fontFamily = family;
      term.options.fontSize = size;
      refit();
    });

    // xterm measures the font once at open; measuring a fallback face misplaces every cell.
    v.ready = document.fonts
      .load(`${fontSizeNow()}px ${fontFamily}`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        term.open(el);
        refit();
        ro.observe(el);
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-surface", "style"] });
        if (!tabRef.current.params.terminalId && activeRef.current) term.focus();
      });

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      ro.disconnect();
      themeWatch.disconnect();
      offOutput();
      offResync();
      offExit();
      input.dispose();
      term.dispose();
      view.current = null;
    };
  }, [client, generation]);

  // The link: open the process if there is none, then attach, once per connection.
  useEffect(() => {
    const v = view.current;
    // Before the socket first opens, a call only queues; attaching then races the attach the open triggers.
    if (!client || !v || connection === 0) return;
    const token = {};
    let disposed = false;
    // Detach only the flow this run owns. Never close: the process outlives the view.
    const release = (id: string) => {
      if (owners.get(id) !== token) return;
      owners.delete(id);
      void client.call("term.detach", { terminal_id: id }).catch(() => undefined);
    };

    v.target = tabRef.current.params.terminalId ?? null;
    const run = async () => {
      await v.ready;
      if (disposed) return;
      const { term } = v;
      try {
        const id = tabRef.current.params.terminalId ?? (await openOnce(client, workspaceId, tabRef.current, { cols: term.cols, rows: term.rows }));
        if (disposed) return;
        v.id = id;
        v.target = id;
        owners.set(id, token);
        const attached = await client.call("term.attach", { terminal_id: id });
        if (disposed) return release(id);
        // The scrollback is the whole screen: start over (a re-attach after a reconnect) and keep what the user had selected.
        const sel = term.getSelectionPosition();
        term.reset();
        term.write(attached.scrollback, () => {
          if (sel) term.select(sel.start.x, sel.start.y, (sel.end.y - sel.start.y) * term.cols + sel.end.x - sel.start.x);
        });
        v.attached = true;
        v.resync = async () => {
          if (v.held) return;
          v.held = [];
          try {
            const again = await client.call("term.attach", { terminal_id: id });
            if (disposed) return;
            term.reset();
            term.write(again.scrollback + v.held.join(""));
          } catch {
            // The next reconnect attaches it again.
          } finally {
            v.held = null;
          }
        };
        v.pty = { cols: attached.cols, rows: attached.rows };
        v.syncSize();
        // A re-attach can also bring a "didn't start" view back to life.
        setStatus((s) => (attached.exited ? (s.kind === "exited" ? s : { kind: "exited", code: null }) : s.kind === "live" ? s : { kind: "live" }));
        // Name the tab after the shell's directory, and learn an exit code that happened while away.
        const { terminals } = await client.call("term.list", { workspace_id: workspaceId });
        const info = terminals.find((t) => t.terminal_id === id);
        if (disposed || !info) return;
        // The runtime reports a cwd inside the workspace ("." is its root, which keeps the "Terminal" name).
        const dir = baseName(info.cwd);
        if (!tabRef.current.params.command && dir !== ".") updateTab(workspaceId, tabRef.current.id, { title: dir });
        if (info.exited) setStatus({ kind: "exited", code: info.exit_code ?? null, ...(info.signal ? { signal: info.signal } : {}) });
      } catch (e) {
        if (disposed) return;
        if (e instanceof SessionProtocolError && e.error.data?.reason === "not_found") setStatus({ kind: "gone" });
        else setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };
    void run();

    return () => {
      disposed = true;
      v.attached = false;
      v.resync = null;
      v.held = null;
      if (v.id) release(v.id);
    };
  }, [client, connection, generation]);

  // An ended process takes no input and stops blinking; Restart takes the focus the shell had.
  useEffect(() => {
    const term = view.current?.term;
    if (!term) return;
    const ended = status.kind !== "live";
    term.options.disableStdin = ended;
    term.options.cursorBlink = !ended;
    if (status.kind === "exited" && activeRef.current && root.current?.contains(document.activeElement)) exitBar.current?.querySelector("button")?.focus();
  }, [status, generation]);

  /** A fresh shell (or the same command again) in this tab. The old process is closed if it still exists. */
  const restart = () => {
    const { terminalId: old, ...params } = tab.params;
    if (client && old) void client.call("term.close", { request_id: requestId(), terminal_id: old }).catch(() => undefined);
    updateTab(workspaceId, tab.id, { params: { terminalId: undefined } });
    tabRef.current = { ...tab, params };
    setStatus({ kind: "live" });
    setGeneration((g) => g + 1);
  };

  // A run started elsewhere (run.ts: an action, Run, ⌘K) opens this tab again with its new terminal: show that
  // one. One that could not start clears the terminal: the tab starts the command itself, so a failure says why.
  useEffect(() => {
    const v = view.current;
    const id = tab.params.terminalId ?? null;
    if (!v || id === v.target) return;
    setStatus({ kind: "live" });
    setGeneration((g) => g + 1);
  }, [tab.reveal]);

  const kill = () => {
    surfaceDef("terminal")?.onClose?.({ client, workspaceId, tab });
    closeTab(workspaceId, tab.id);
  };

  return (
    <div ref={root} className="group/term relative flex min-h-0 flex-1 flex-col bg-background">
      {/* The actions and the exit bar come before xterm in the DOM: xterm keeps Tab, so they must be reachable before it. */}
      <div
        role="toolbar"
        aria-label="Terminal actions"
        className={cn(
          "absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-elevated",
          "opacity-0 transition-opacity duration-150 ease-snap focus-within:opacity-100 group-hover/term:opacity-100",
        )}
      >
        <BarButton size="sm" label="New terminal" onClick={() => openSurface(workspaceId, "terminal", {})}>
          <Icon icon={Add01Icon} />
        </BarButton>
        <BarButton size="sm" label="Clear" onClick={() => view.current?.term.clear()}>
          <Icon icon={EraserIcon} />
        </BarButton>
        <BarButton size="sm" label="Kill terminal" onClick={kill}>
          <Icon icon={Delete02Icon} />
        </BarButton>
      </div>

      {status.kind === "exited" ? (
        <div ref={exitBar} role="status" className="order-last flex h-9 shrink-0 items-center gap-2 border-t border-border pl-3.5 pr-2 text-[12px] text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.signal || (status.code ?? 0) !== 0 ? "bg-destructive" : "bg-muted-foreground")} />
          <span className="min-w-0 flex-1 truncate tabular-nums">{status.signal ? `Exited (${status.signal})` : status.code === null ? "Exited" : `Exited with code ${status.code}`}</span>
          <QuietButton onClick={restart}>
            <Icon icon={Undo02Icon} />
            Restart
          </QuietButton>
        </div>
      ) : null}

      {/* The padding sits outside xterm's host: FitAddon sizes the grid to the host. */}
      <div className="min-h-0 flex-1 pb-1 pl-3.5 pr-1 pt-2.5">
        <div ref={host} className="h-full w-full [&_.xterm-viewport]:[scrollbar-color:hsl(var(--foreground)/0.15)_transparent] [&_.xterm-viewport]:[scrollbar-width:thin] [&_.xterm]:h-full" />
      </div>

      {status.kind === "gone" || status.kind === "error" ? (
        <div className="absolute inset-0 z-20 flex bg-background">
          {status.kind === "gone" ? (
            <SurfaceEmpty title="This terminal ended" action={<QuietButton onClick={restart}>New terminal</QuietButton>}>
              Its process is no longer running on this computer.
            </SurfaceEmpty>
          ) : (
            <SurfaceEmpty
              title="The terminal didn't start"
              action={
                <QuietButton
                  onClick={() => {
                    setStatus({ kind: "live" });
                    setGeneration((g) => g + 1);
                  }}
                >
                  Retry
                </QuietButton>
              }
            >
              {status.message}
            </SurfaceEmpty>
          )}
        </div>
      ) : null}
    </div>
  );
}
