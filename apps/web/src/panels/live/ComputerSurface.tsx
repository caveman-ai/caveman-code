// The workspace computer's screen, streamed: watch the agent work, take over,
// hand it back. The live view is the same one the agent's browser uses. A
// Cloud computer has a Linux desktop; it starts when the agent or the person
// first uses it, so an untouched one shows an honest empty state, not a black
// screen. On This Mac the screen is the window of the app the chat's agent
// used last (computer use, the runtime's `desktop` tool): watching takes the
// two macOS permissions, which the tab asks for first, and taking over pauses
// the agent and brings its app forward for the person's own mouse, so the
// view never sends input. Setup shows the repo's Cloud setup
// (components/environment); on a Mac that can't run computer use it is the
// tab's body.

import type { ComputerAccess } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, HandIcon, CloudIcon, LaptopIcon } from "@caveman-app/ui/icons/huge";
import { memo, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PermissionState } from "../../components/ComputerPermission.tsx";
import { allowed, PERMISSIONS, useComputerAccess, type ComputerAccessState } from "../../state/computer-access.ts";
import { useComputersCloud, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { BarButton, BarGroup, QuietButton, SurfaceBar, SurfaceEmpty } from "../chrome.tsx";
import type { SurfaceProps } from "../registry.ts";
import { usePanelWorkspace } from "../workspace.ts";
import { EnvironmentPanel } from "../../components/environment/EnvironmentPanel.tsx";
import { LiveView, useLive, type Live } from "./LiveView.tsx";
import { OlderImage } from "./OlderImage.tsx";
import { computerSource, type ComputerState } from "./source.ts";

// The workspace is read here only; the screen below is memoized on the few values it takes from it.
export default function ComputerSurface({ workspaceId, active }: SurfaceProps<"computer">) {
  const engines = useRuntimeSelector((v) => v.engines);
  const workspace = usePanelWorkspace();
  const engine = engines.find((e) => e.id === workspace?.engine)?.label ?? "The agent";
  if (workspace?.computer.kind === "this_mac") {
    return <ThisMac workspaceId={workspaceId} projectId={workspace.project_id ?? null} active={active} engine={engine} computer={workspace.computer.label} />;
  }
  // Cloud's list shows a chat on another Mac as a "pool" computer: not a Cloud computer, and not this Mac's screen.
  if (workspace && workspace.computer.kind !== "caveman_cloud") {
    return (
      <>
        <SurfaceBar className="gap-2 pl-3">
          <span className="shrink-0 text-[13px] font-medium text-foreground">Computer</span>
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{workspace.computer.label}</span>
        </SurfaceBar>
        <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
          The desktop is on Cloud computers: there, Caveman can use a Linux desktop, and you can watch it or take over here. This repo's Cloud setup:
        </p>
        <EnvironmentPanel workspaceId={workspaceId} projectId={workspace.project_id ?? null} />
      </>
    );
  }
  return (
    <Computer
      workspaceId={workspaceId}
      projectId={workspace?.project_id ?? null}
      active={active}
      engine={engine}
      computer={workspace?.computer.label}
      computerId={workspace?.computer.kind === "caveman_cloud" ? workspace.computer.id : undefined}
    />
  );
}

/**
 * This Mac: the window of the app the chat's agent is using, once the Mac allows it (Accessibility to use apps,
 * Screen Recording to see them). A Mac without computer use keeps the Cloud setup as the tab's body.
 */
const ThisMac = memo(function ThisMac({ workspaceId, projectId, active, engine, computer }: { workspaceId: string; projectId: string | null; active: boolean; engine: string; computer: string }) {
  const { client, connection } = useRuntimeClient();
  const turnedOff = useRuntimeSelector((v) => v.settings?.computer_use === false);
  const access = useComputerAccess(active);
  const a = access.access;
  const watchable = a?.supported === true && !turnedOff && allowed(a, "accessibility") && allowed(a, "screen_recording");
  const source = useMemo(() => (client ? computerSource(client, workspaceId) : null), [client, workspaceId]);
  // Taking over brings the agent's app forward over this window: the person keeps control while it is hidden.
  const live = useLive(source, active && watchable, connection, { holdWhenHidden: true });
  const [fit, setFit] = useState<"contain" | "actual">("contain");
  const [setup, setSetup] = useState(false);
  const app = live.state?.app?.name;

  if (a && !a.supported) {
    return (
      <>
        <SurfaceBar className="gap-2 pl-3">
          <span className="shrink-0 text-[13px] font-medium text-foreground">Computer</span>
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{computer}</span>
        </SurfaceBar>
        <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-[18px] text-muted-foreground">
          The desktop is on Cloud computers: there, Caveman can use a Linux desktop, and you can watch it or take over here. This repo's Cloud setup:
        </p>
        <EnvironmentPanel workspaceId={workspaceId} projectId={projectId} />
      </>
    );
  }

  const controls = watchable && live.status === "live" && !setup;
  return (
    <>
      <SurfaceBar className="gap-2 pl-3">
        <span className="shrink-0 text-[13px] font-medium text-foreground">Computer</span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground">{app ?? computer}</span>
        <BarButton label={setup ? "Show the screen" : "Cloud setup"} pressed={setup} onClick={() => setSetup(!setup)} className={cn("w-auto px-1", !controls && "ml-auto")}>
          <span className="px-0.5 text-[12px]">Setup</span>
        </BarButton>
        {controls ? <ScreenControls live={live} engine={engine} fit={fit} setFit={setFit} /> : null}
      </SurfaceBar>
      {setup ? (
        <EnvironmentPanel workspaceId={workspaceId} projectId={projectId} />
      ) : !a ? (
        access.error ? (
          <SurfaceEmpty title="Couldn't check computer use" action={<QuietButton onClick={access.retry}>Try again</QuietButton>}>
            {access.error}
          </SurfaceEmpty>
        ) : (
          // Until the runtime answers, it isn't known whether this Mac can show anything.
          <div className="flex-1" />
        )
      ) : turnedOff ? (
        <TurnedOff />
      ) : !allowed(a, "accessibility") ? (
        <Onboarding access={a} state={access} />
      ) : !allowed(a, "screen_recording") ? (
        <SurfaceEmpty icon={LaptopIcon} title="Screen Recording is off" action={<GuideButton state={access} quiet />}>
          {engine} can still use apps. Allow Screen Recording to see their windows here.
        </SurfaceEmpty>
      ) : live.status === "error" ? (
        <SurfaceEmpty title="The screen stopped streaming" action={<QuietButton onClick={live.retry}>Try again</QuietButton>}>
          The runtime didn't answer. It may be restarting.
        </SurfaceEmpty>
      ) : live.status === "unavailable" ? (
        <SurfaceEmpty title="App windows can't be shown here" action={<QuietButton onClick={live.retry}>Try again</QuietButton>}>
          The runtime can't stream this Mac's windows right now.
        </SurfaceEmpty>
      ) : source ? (
        <LiveView source={source} live={live} engine={engine} fit={fit} interactive={false} {...(app ? { using: app } : {})} placeholder={<MacWaiting live={live} engine={engine} />} />
      ) : null}
    </>
  );
});

/** Before the first frame on This Mac: no app used in this chat yet, or one whose window isn't showing. */
function MacWaiting({ live, engine }: { live: Live<ComputerState>; engine: string }) {
  if (live.status !== "live") return <div className="flex-1" />;
  if (live.controller === "none") {
    return (
      <SurfaceEmpty icon={LaptopIcon} title="No app in use yet">
        When {engine} uses an app on this Mac, its window shows here. You can watch and take over.
      </SurfaceEmpty>
    );
  }
  const app = live.state?.app?.name;
  return <SurfaceEmpty title={app ? `Waiting for ${app}'s window` : "Waiting for the app's window"}>It shows here once the app has a window open.</SurfaceEmpty>;
}

/** First run on This Mac: what computer use is, the two permissions, and the way to System Settings. */
function Onboarding({ access, state }: { access: ComputerAccess; state: ComputerAccessState }) {
  return (
    <SurfaceEmpty
      icon={LaptopIcon}
      title="Let agents use apps on this Mac"
      action={
        <div className="flex w-[300px] max-w-full flex-col items-center gap-3">
          <ul aria-label="Permissions" className="w-full divide-y divide-border/60 rounded-lg border border-border text-left">
            {PERMISSIONS.map((p) => (
              <li key={p.key} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-foreground">{p.label}</div>
                  <div className="text-[12px] leading-[17px] text-muted-foreground">{p.description}</div>
                </div>
                <PermissionState state={access[p.key]} />
              </li>
            ))}
          </ul>
          <GuideButton state={state} />
        </div>
      }
    >
      They work in the background and never move your pointer. Each new app asks you first.
    </SurfaceEmpty>
  );
}

/** Open System Settings at the first missing permission; then say this view waits on the person there. */
function GuideButton({ state, quiet }: { state: ComputerAccessState; quiet?: boolean }) {
  const label = state.guiding ? "Opening System Settings…" : "Open System Settings";
  return (
    <div className="flex flex-col items-center gap-2">
      {quiet ? (
        <QuietButton disabled={state.guiding} onClick={state.guide}>
          {label}
        </QuietButton>
      ) : (
        <Button size="sm" disabled={state.guiding} onClick={state.guide}>
          {label}
        </Button>
      )}
      <span aria-live="polite" className={cn("min-h-[17px] text-center text-[12px] leading-[17px]", state.guideError ? "text-destructive" : "text-[hsl(var(--subtle-foreground))]")}>
        {state.guideError ??
          (state.awaitsReopen
            ? "macOS turns on Screen Recording once Caveman Code reopens."
            : state.guided
              ? "Allow Caveman Code there. This updates on its own."
              : "")}
      </span>
      {state.awaitsReopen && state.reopen ? (
        <QuietButton onClick={state.reopen}>Reopen Caveman Code</QuietButton>
      ) : state.guided && !state.awaitsReopen ? (
        <QuietButton onClick={state.added}>I added it</QuietButton>
      ) : null}
    </div>
  );
}

/** Computer use turned off in Settings: the way back to it. */
function TurnedOff() {
  const navigate = useNavigate();
  return (
    <SurfaceEmpty icon={LaptopIcon} title="Computer use is off" action={<QuietButton onClick={() => navigate("/settings/computer-use")}>Open Settings</QuietButton>}>
      Agents can't use apps on this Mac until you turn it on.
    </SurfaceEmpty>
  );
}

/** Who drives, Fit or 100%, and Take over: the bar's end while the screen streams. */
function ScreenControls({ live, engine, fit, setFit }: { live: Live<unknown>; engine: string; fit: "contain" | "actual"; setFit: (fit: "contain" | "actual") => void }) {
  const driving = live.holding && live.controller === "user";
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Driver live={live} engine={engine} />
      <BarGroup>
        {(["contain", "actual"] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={fit === f}
            disabled={!live.frame}
            onClick={() => setFit(f)}
            className={cn(
              "h-6 rounded-md px-2 text-[12px] tabular-nums outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40",
              fit === f ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f === "contain" ? "Fit" : "100%"}
          </button>
        ))}
      </BarGroup>
      <BarButton label={driving ? "Hand back" : "Take over"} pressed={driving} disabled={!live.frame} onClick={() => live.control(driving ? "agent" : "user")}>
        <Icon icon={HandIcon} />
      </BarButton>
    </div>
  );
}

const Computer = memo(function Computer({
  workspaceId,
  projectId,
  active,
  engine,
  computer,
  computerId,
}: {
  workspaceId: string;
  projectId: string | null;
  active: boolean;
  engine: string;
  computer: string | undefined;
  computerId: string | undefined;
}) {
  const { client, connection } = useRuntimeClient();
  const cloudApi = useComputersCloud();
  const source = useMemo(() => (client ? computerSource(client, workspaceId) : null), [client, workspaceId]);
  const live = useLive(source, active, connection);
  const [fit, setFit] = useState<"contain" | "actual">("contain");
  const [setup, setSetup] = useState(false);

  return (
    <>
      <SurfaceBar className="gap-2 pl-3">
        <span className="shrink-0 text-[13px] font-medium text-foreground">Computer</span>
        {computer ? <span className="min-w-0 truncate text-[13px] text-muted-foreground">{computer}</span> : null}
        <BarButton label={setup ? "Show the screen" : "Cloud setup"} pressed={setup} onClick={() => setSetup(!setup)} className={cn("w-auto px-1", !(live.status === "live" && !setup) && "ml-auto")}>
          <span className="px-0.5 text-[12px]">Setup</span>
        </BarButton>
        {live.status === "live" && !setup ? <ScreenControls live={live} engine={engine} fit={fit} setFit={setFit} /> : null}
      </SurfaceBar>
      {setup ? (
        <EnvironmentPanel workspaceId={workspaceId} projectId={projectId} />
      ) : live.status === "unavailable" ? (
        <OlderImage computerId={computerId} update={cloudApi ? (id) => cloudApi.update(id) : undefined} />
      ) : live.status === "error" ? (
        <SurfaceEmpty title="The screen stopped streaming" action={<QuietButton onClick={live.retry}>Try again</QuietButton>}>
          The runtime didn't answer. It may be restarting.
        </SurfaceEmpty>
      ) : source ? (
        <LiveView source={source} live={live} engine={engine} fit={fit} placeholder={<Waiting live={live} />} />
      ) : null}
    </>
  );
});

/** Before the first frame: a desktop nobody has used yet, one starting, or a start that failed. */
function Waiting({ live }: { live: Live<unknown> }) {
  if (live.controlError) {
    return (
      <SurfaceEmpty title="The desktop didn't start" action={<QuietButton onClick={() => live.control("user")}>Try again</QuietButton>}>
        <span className="line-clamp-4 font-mono text-[11.5px]">{live.controlError.replace(/^The desktop didn't start:\s*/, "")}</span>
      </SurfaceEmpty>
    );
  }
  // Until the runtime answers, it isn't known whether the desktop is up.
  if (live.status !== "live") return <div className="flex-1" />;
  if (live.holding || live.controller !== "none") return <SurfaceEmpty title="Starting the desktop" />;
  return (
    <SurfaceEmpty icon={CloudIcon} title="No desktop yet" action={<QuietButton onClick={() => live.control("user")}>Take over</QuietButton>}>
      The desktop starts when Caveman or you use it.
    </SurfaceEmpty>
  );
}

/** Who drives the screen, as a quiet pill in the bar. */
export function Driver({ live, engine }: { live: Live<unknown>; engine: string }) {
  const text = live.controller === "agent" ? `${engine} is driving` : live.controller === "user" ? (live.holding ? "You're driving" : live.moved ? "Control moved elsewhere" : "Driven from another window") : "Idle";
  return (
    <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-secondary/60 px-2 text-[12px] text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", live.controller === "none" ? "bg-muted-foreground/50" : "bg-foreground")} />
      <span className="truncate">{text}</span>
    </span>
  );
}
