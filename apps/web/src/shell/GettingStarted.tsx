// Getting started: a checklist at the foot of the sidebar for everyone, onboarded or not, until every step is done
// or they hide it. Ticked from what the runtime
// says (state/getting-started.ts). Only the steps, no art; a step
// still to do goes where it gets done.
//
// It is also where what the person put off waits ("if they click not now we move it towards the
// onboarding section in the bottom left"): syncing chats, and a device still waiting to be allowed. Those lead the
// card with the amber dot, keep it open, and stay after the setup steps are done or hidden.
//
// A browser window with no computer behind it has the same card for the one thing it lacks: the person's Mac
// (MacSteps, from state/sync/web-window.ts macSteps). Off a Mac, with no Mac of theirs signed in, it holds what the web
// app itself does instead (webSteps): nobody is pointed at a Mac they may not have.

import type { PluginSummary } from "@caveman-app/session-protocol";
import { Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useId, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { askDevicesAgain, hideDevicesPutOff, useDevicesPutOff } from "../components/Devices.tsx";
import { useLastProject } from "../components/ProjectPicker.tsx";
import { UnlockPlans } from "../components/UnlockPlans.tsx";
import { useFree } from "../components/WebStartCard.tsx";
import { useRemoteControl } from "../components/RemoteControl.tsx";
import { isPhone } from "../lib/screen.ts";
import { hostedAccount } from "../state/cloud.ts";
import { engineReady, enginesChecking } from "../state/engines.ts";
import { cardFolded, cardSteps, hasConnection, readCardState, saveCardState, setupDone, SYNC_STEP, type CardState, type Progress } from "../state/getting-started.ts";
import { useRuntimeClient, useRuntimeSelector, useWebWindow } from "../state/runtime.tsx";
import { answerSyncAsk, openSyncAsk, useSyncAsk } from "../state/sync-ask.ts";
import { canGetMacHere, DOWNLOAD_URL, macNext, macSteps, webSteps } from "../state/sync/web-window.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export function GettingStarted() {
  const { client } = useRuntimeClient();
  const web = useWebWindow();
  // A browser window with no computer to ask: the way to the person's Mac instead.
  if (web !== null && client === null) return <MacSteps />;
  return <Checklist />;
}

type Reads = { readonly plugins: ReadonlyArray<PluginSummary>; readonly automation: boolean };

/** Where each setup step gets done, and what its row says to a screen reader. */
const GO: Record<string, { readonly to: string; readonly label: string }> = {
  engine: { to: "/settings/models", label: "Set up an engine in Settings" },
  connections: { to: "/plugins", label: "Add connections in Plugins" },
  task: { to: "/new", label: "Start a new chat" },
  automation: { to: "/automations", label: "Open Automations" },
};

function Checklist() {
  // A phone's drawer is short: the card opens folded there, and a tap unfolds it.
  const [chosen, setChosen] = useState<CardState | null>(() => {
    const kept = readCardState();
    return kept === null || kept === "open" ? (isPhone() ? "folded" : kept) : kept;
  });
  const change = (next: CardState) => {
    saveCardState(next);
    setChosen(next);
  };
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const anyChat = useRuntimeSelector((v) => v.workspaces.length > 0);
  const navigate = useNavigate();
  // Plugins and automations send no events: read them again whenever the page changes, so leaving Plugins or
  // Automations, where they change, ticks the step.
  const section = useLocation().pathname.split("/")[1] ?? "";
  const cwd = useLastProject().project?.path ?? undefined;
  const [reads, setReads] = useState<Reads | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void Promise.all([
      client.call("plugin.list", cwd ? { cwd } : {}).then((r) => r.plugins, () => []),
      client.call("automation.list", {}).then((r) => r.automations.length > 0, () => false),
    ]).then(([plugins, automation]) => live && setReads({ plugins, automation }));
    return () => {
      live = false;
    };
  }, [client, section, cwd]);
  // What the person put off: sync where this Mac's Caveman offers it, and devices whose question they closed.
  const { status } = useRemoteControl();
  const syncAsk = useSyncAsk().answer;
  const devices = useDevicesPutOff();

  // Nothing of setup shows until every answer is in, so a done step never flashes as one to do.
  const progress: Progress | null =
    reads && engines.length > 0 && !enginesChecking(engines)
      ? { engine: engines.some(engineReady), connections: hasConnection(reads.plugins), task: anyChat, automation: reads.automation }
      : null;
  const finished = chosen !== "hidden" && chosen !== "done" && setupDone(progress);
  useEffect(() => {
    if (finished) change("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` is a fresh function each render; only finishing saves.
  }, [finished]);
  // Setup hidden or done: the card holds only what was put off, and its fold is this window's, never the kept choice.
  const gone = chosen === "hidden" || chosen === "done" || finished;
  const [restFolded, setRestFolded] = useState(false);
  const steps = cardSteps({
    card: finished ? "done" : chosen,
    progress,
    sync: status?.sync?.ask === true ? "ask" : status?.sync?.on === true ? "on" : null,
    syncAsk,
    devices,
  });
  if (steps.length === 0) return null;
  const urgent = steps.some((s) => s.urgent && !s.done);
  const go = (id: string) => {
    if (id === SYNC_STEP) return openSyncAsk();
    if (id.startsWith("device:")) return askDevicesAgain();
    const to = GO[id]?.to;
    if (to) navigate(to);
  };
  return (
    <ChecklistCard
      title="Getting started"
      steps={steps.map((s) => ({ ...s, ...(s.done ? {} : { go: () => go(s.id), goLabel: GO[s.id]?.label ?? s.label }) }))}
      folded={gone ? restFolded : cardFolded(chosen, progress?.task ?? true, urgent)}
      onFold={(folded) => (gone ? setRestFolded(folded) : change(folded ? "folded" : "open"))}
      onHide={() => {
        // Hidden takes what was put off with it: sync is not offered here again, and the devices wait in Settings.
        if (steps.some((s) => s.id === SYNC_STEP && !s.done)) answerSyncAsk("never");
        hideDevicesPutOff();
        if (!gone) change("hidden");
      }}
    />
  );
}

const MAC_CARD = "caveman.macSteps";

/**
 * In a browser window with no computer behind it: the three steps to the person's Mac, ticked from Cloud's list and
 * what the Mac said. The step this browser can do itself is a button (the download, connecting to a Mac on line).
 */
function MacSteps() {
  const web = useWebWindow();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(MAC_CARD));
  const [plans, setPlans] = useState(false);
  const change = (next: "open" | "folded" | "hidden") => {
    localStorage.setItem(MAC_CARD, next);
    setChosen(next);
  };
  // Off a Mac with no Mac of theirs: the web app's own steps. Cloud is asked about the plan only then.
  const offMac = web !== null && web.mac.kind === "none" && !canGetMacHere();
  const free = useFree(offMac && web.window.kind === "app");
  if (!web || web.window.kind !== "app" || chosen === "hidden" || web.mac.kind === "ready") return null;
  const mac = web.mac;
  const own = webSteps(mac, web.window, web.places.cloud, free);
  if (own !== null) {
    if (own.every((s) => s.done)) return null;
    return (
      <>
        <ChecklistCard
          title="Getting started"
          steps={own.map((s) => ({
            ...s,
            ...(s.done ? {} : s.id === "plan" ? { go: () => setPlans(true), goLabel: "See plans" } : { go: () => navigate("/new"), goLabel: "Start a chat in Cloud" }),
          }))}
          folded={chosen === "folded" || (chosen === null && isPhone())}
          onFold={(folded) => change(folded ? "folded" : "open")}
          onHide={() => change("hidden")}
        />
        <UnlockPlans open={plans} onOpenChange={setPlans} source={hostedAccount} />
      </>
    );
  }
  // The download is for a Mac. A browser on another computer (macNext offers it no download) never sees the "Get
  // Caveman Code for Mac" step while it is still to do: a row that says Mac with nothing to press still offers a Mac
  // download it cannot use, and the page says the desktop app is Mac only today. Once a Mac of theirs is signed in the
  // step is done and shows ticked, as it is true wherever they read it.
  const canDownload = macNext(mac)?.action?.kind === "download";
  const steps = macSteps(mac)
    .filter((s) => s.id !== "get" || s.done || canDownload)
    .map((s) => ({
      ...s,
      ...(s.done
        ? {}
        : s.id === "get"
          ? // Still to do and not filtered out above: this browser is on a Mac.
            { go: () => void window.open(DOWNLOAD_URL, "_blank", "noopener"), goLabel: "Download Caveman Code for Mac" }
          : s.id === "allow" && mac.kind === "ask"
            ? // oxlint-disable-next-line react/hooks -- usePlace is the window's own method, not a React hook.
              { go: () => web.usePlace(mac.place), goLabel: `Connect to ${mac.name}` }
            : {}),
      ...(s.id === "allow" && mac.kind === "waiting" ? { urgent: true as const } : {}),
    }));
  return (
    <ChecklistCard
      title="Connect your Mac"
      steps={steps}
      folded={chosen === "folded" || (chosen === null && isPhone())}
      onFold={(folded) => change(folded ? "folded" : "open")}
      onHide={() => change("hidden")}
    />
  );
}

interface Step {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly urgent?: true;
  /** Where it gets done; without it the row only says what to do (it is done somewhere this window cannot reach). */
  readonly go?: () => void;
  readonly goLabel?: string;
}

/** The card: a header that folds it, with how far along it is, and one row a step. */
function ChecklistCard({ title, steps, folded, onFold, onHide }: { title: string; steps: ReadonlyArray<Step>; folded: boolean; onFold: (folded: boolean) => void; onHide: () => void }) {
  const id = useId();
  const done = steps.filter((s) => s.done).length;
  const urgent = steps.some((s) => s.urgent && !s.done);
  return (
    <section aria-labelledby={`${id}-title`} className="mx-3 mb-2 shrink-0 rounded-xl border border-border bg-card p-1.5 text-foreground shadow-elevated">
      <div className="group/gs relative flex h-9 items-center">
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={`${id}-steps`}
          onClick={() => onFold(!folded)}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-2.5 pr-3 text-left outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch:pr-9"
        >
          <Glyph name="rocket" className="text-muted-foreground" />
          <span id={`${id}-title`} className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.005em]">
            {title}
          </span>
          {/* Folded, a step that waits on the person still shows: the dot. */}
          {urgent && folded ? <span role="img" aria-label="Needs you" title="Needs you" className="size-2 shrink-0 rounded-full bg-warning" /> : null}
          {steps.length > 1 ? (
            <span className="text-[13px] tabular-nums text-muted-foreground transition-opacity duration-75 group-hover/gs:opacity-0 group-focus-within/gs:opacity-0 touch:!opacity-100">
              {done} of {steps.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label={`Hide ${title}`}
          title="Hide"
          onClick={onHide}
          className="absolute right-1.5 grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/gs:opacity-100 group-focus-within/gs:opacity-100 touch:opacity-100"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      </div>
      {folded ? null : (
        <ol id={`${id}-steps`} aria-label="Steps">
          {steps.map((step) =>
            step.done ? (
              <li key={step.id} className="flex h-8 items-center gap-2.5 px-2.5 text-[14px] text-muted-foreground">
                <Glyph name="state-done" className="[--px-accent:hsl(var(--target))]" />
                <span className="truncate line-through decoration-muted-foreground/60">{step.label}</span>
                <span className="sr-only">, done</span>
              </li>
            ) : step.go ? (
              <li key={step.id}>
                <button
                  type="button"
                  aria-label={step.goLabel ?? step.label}
                  onClick={step.go}
                  className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <TodoMark urgent={step.urgent === true} />
                  <span className="truncate">{step.label}</span>
                </button>
              </li>
            ) : (
              <li key={step.id} className="flex h-8 items-center gap-2.5 px-2.5 text-[14px]">
                <TodoMark urgent={step.urgent === true} />
                <span className="truncate">{step.label}</span>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

/** A step still to do: eight dots round a ring, darkest at twelve o'clock and fading clockwise. One that waits on the person now is the amber dot. */
const DOTS = [[7, 1], [11, 3], [13, 7], [11, 11], [7, 13], [3, 11], [1, 7], [3, 3]] as const;

function TodoMark({ urgent }: { urgent: boolean }) {
  if (urgent)
    return (
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        <span className={cn("size-2 rounded-full bg-warning")} />
      </span>
    );
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} shapeRendering="crispEdges" aria-hidden className="shrink-0 text-foreground">
      {DOTS.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={2} height={2} fill="currentColor" fillOpacity={1 - i * 0.11} />
      ))}
    </svg>
  );
}
