import { Button } from "@caveman-app/ui/components/button";
import { Input } from "@caveman-app/ui/components/input";
import { lazy, Suspense, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Greeting } from "../components/Greeting.tsx";
import { linkEndpoint, useRuntimeClient, useRuntimeSelector, useWebWindow } from "../state/runtime.tsx";
import { chiefPath } from "../state/chiefs.ts";
import { useNeedsYouTitle, useWorkspaceNotifications } from "../state/notifications.ts";
import { signInUrl } from "../state/cloud.ts";
import { SIGN_IN_LINE } from "../state/sync/web-window.ts";
import { funnelStep } from "../state/desktop.ts";
import { WhatsNew } from "../whats-new/WhatsNew.tsx";
import { RuntimeLinkNotice } from "../shell/RuntimeLinkNotice.tsx";
import { UsageNotice } from "../shell/UsageNotice.tsx";
import { LatencyOverlay } from "../components/LatencyOverlay.tsx";
import { GlobalSearch } from "../shell/GlobalSearch.tsx";
import { ShortcutHelp } from "../shell/ShortcutHelp.tsx";
import { WorkspaceFocus } from "../shell/WorkspaceFocus.tsx";
import { forgetStaleTour, startTour, tourPending, TOUR_EVENTS } from "../shell/tour-state.ts";
import { Offers } from "../components/Offers.tsx";
import { frameMotion } from "@caveman-app/ui/motion";
import { firstRunPath, showsFirstRun, type FirstRunEnd } from "./onboarding/model.ts";

// The first run's screens load only on a first run, and the tour only when it is asked for.
const Onboarding = lazy(() => import("./onboarding/Onboarding.tsx").then((m) => ({ default: m.Onboarding })));
const Tour = lazy(() => import("../shell/Tour.tsx").then((m) => ({ default: m.Tour })));

// The tour never runs on its own: one left unfinished by the last launch is dropped before anything reads it.
forgetStaleTour();

/**
 * The tour, loaded once somebody asks for it (Show me around, Help > Show the Tour: startTour). Mounted, it stays: it
 * starts itself and ends itself (shell/Tour.tsx).
 */
function TourHost() {
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    const check = () => {
      if (tourPending()) setWanted(true);
    };
    check();
    for (const name of TOUR_EVENTS) window.addEventListener(name, check);
    return () => {
      for (const name of TOUR_EVENTS) window.removeEventListener(name, check);
    };
  }, []);
  return wanted ? (
    <Suspense fallback={null}>
      <Tour />
    </Suspense>
  ) : null;
}

const DISMISSED_KEY = "caveman.firstRunDone";

/**
 * Shows the connect screen or the first-run welcome until there is something to work on. A browser window Caveman
 * Cloud serves has neither: signed in, it is the app itself, with every chat the person has and New chat, and nothing
 * asks which computer (state/sync/web-window.ts).
 */
export function FirstRunGate() {
  const status = useRuntimeSelector((v) => v.status);
  const chats = useRuntimeSelector((v) => v.workspaces.length);
  const web = useWebWindow();
  useWorkspaceNotifications();
  useNeedsYouTitle();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "1");
  // Once begun it runs to its end: the first task's chat must not cut it short.
  const [begun, setBegun] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { client } = useRuntimeClient();
  // Where the first run ends: the first task's chat; else the project's own Chief (made the first time it is asked for,
  // chief.get project_id), where the tour starts; else New chat, since with no project there is no Chief to open.
  const openFirstRunEnd = async (end: FirstRunEnd) => {
    const chief = end !== null && "project" in end ? await client?.call("chief.get", { project_id: end.project }).then((r) => r.chief, () => undefined) : undefined;
    navigate(firstRunPath(end, chief ? chiefPath(chief) : undefined));
  };
  useEffect(() => {
    if (status === "connected" && chats > 0) funnelStep("first_workspace");
  }, [status, chats]);
  // Served by Caveman Cloud: one line and one button while nobody is signed in, then the app. No computer is picked,
  // and none is needed to open it.
  if (web?.window.kind === "signed_out") return <SignedOut />;
  if (web?.window.kind === "loading") return <Loading />;
  if (!web && status === "unconfigured") return <ConnectScreen />;
  // A desktop with nothing kept from an earlier launch opens on it while its runtime starts, never the empty shell
  // (model.ts). Settings stays reachable from the first run: an engine that needs setup is set up there. The first run
  // is a computer's own (what is signed in there, its folders): a browser window opens on New chat instead.
  const desktop = window.cavemanDesktop?.runtime !== undefined;
  const firstRun = !web && showsFirstRun({ status, desktop, chats, begun, done: dismissed }) && !pathname.startsWith("/settings");
  // Latched on the runtime's answer only: before it, a runtime that already has chats may still send the shell.
  if (firstRun && !begun && status === "connected") setBegun(true);
  if (firstRun)
    return (
      <Suspense fallback={null}>
        <Onboarding
          // A packaged app requires the account; a development build, the smoke test and E2E may skip it.
          signIn={window.cavemanDesktop?.packaged === true ? "required" : "optional"}
          onDone={(end) => {
            localStorage.setItem(DISMISSED_KEY, "1");
            // Start on a first task opens its chat and nothing more; the tour runs only for Show me around (a project).
            if (end !== null && "project" in end) startTour();
            setDismissed(true);
            void openFirstRunEnd(end);
          }}
        />
      </Suspense>
    );
  // What's new, ⌘K, the ? sheet and the runtime's link notice sit above the shell and Settings alike.
  return (
    <>
      <Outlet />
      <WhatsNew />
      <GlobalSearch />
      <WorkspaceFocus />
      <ShortcutHelp />
      <TourHost />
      <Offers />
      <RuntimeLinkNotice />
      <UsageNotice />
      <LatencyOverlay />
    </>
  );
}

/** A browser window with nobody signed in to Caveman: one line and one button. */
export function SignedOut() {
  return (
    <div className="dashboard-scope grid h-full place-items-center bg-background px-6 text-foreground">
      <div className={`flex flex-col items-center gap-4 ${frameMotion}`}>
        <p className="text-[13px] font-semibold tracking-[-0.01em]">
          Caveman <span className="font-normal text-muted-foreground">Code</span>
        </p>
        <p className="text-[13px] text-muted-foreground">{SIGN_IN_LINE}</p>
        <Button asChild size="lg">
          <a href={signInUrl()}>Sign in</a>
        </Button>
      </div>
    </div>
  );
}

/** Before Cloud has said who is signed in, or sent the person's chats: nothing for a moment, then one word. */
export function Loading({ after = 400 }: { after?: number }) {
  const [shown, setShown] = useState(after <= 0);
  useEffect(() => {
    if (after <= 0) return;
    const timer = setTimeout(() => setShown(true), after);
    return () => clearTimeout(timer);
  }, [after]);
  return (
    <div role="status" className="dashboard-scope grid h-full place-items-center bg-background text-[13px] text-muted-foreground">
      {shown ? "Loading…" : null}
    </div>
  );
}

function ConnectScreen() {
  const [link, setLink] = useState("");
  const connect = () => {
    try {
      const endpoint = linkEndpoint(link.trim());
      if (endpoint) {
        localStorage.setItem("caveman.runtime", JSON.stringify(endpoint));
        window.location.replace(`${window.location.pathname}${window.location.hash}`);
      }
    } catch {
      // Not a URL: leave the field as it is.
    }
  };
  return (
    <div className="dashboard-scope grid h-full place-items-center bg-background px-6 text-foreground">
      <div className={`flex w-full max-w-[560px] flex-col items-center gap-6 ${frameMotion}`}>
        <Greeting line="Caveman need runtime. Start runtime. Paste link." />
        <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.012em]">Connect to Caveman Code</h1>
        <div className="w-full rounded-xl border border-border bg-card p-4 text-[13px] leading-6 text-muted-foreground">
          In a terminal, run
          <pre className="my-2 rounded-md bg-background px-3 py-2 font-mono text-[12.5px] text-foreground">caveman-code</pre>
          It starts the runtime on this computer and prints a link. Open it, or paste it here. The Caveman Code app installs the command from Settings &gt; General.
        </div>
        <form
          className="flex w-full gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            aria-label="The link caveman-code printed"
            spellCheck={false}
            autoComplete="off"
            placeholder="http://127.0.0.1:…/?runtime=ws://127.0.0.1:…#token=…"
            className="h-9 min-w-0 flex-1 font-mono text-[12.5px] placeholder:font-sans"
          />
          <Button type="submit" size="lg">
            Connect
          </Button>
        </form>
      </div>
    </div>
  );
}
