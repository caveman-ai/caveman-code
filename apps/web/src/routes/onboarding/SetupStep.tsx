// 2. Your setup (Mac and Windows): the logins every engine answers with, as they answer; which engine new chats start
// on; and what Claude Code, Codex and Cursor have to bring over. With nothing found, the ways in. Cloud is not asked
// here: the offer to use a subscription there comes with the first chat or computer in Cloud
// (components/cloud/CloudOffer.tsx), and Settings > Models & keys has it any time. docs/ "2. Your setup".

import type { AccountSummary, EngineDescriptor } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Checkbox } from "@caveman-app/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { EngineLogo } from "@caveman-app/ui/components/runner-badge";
import { Icon, ArrowDown01Icon } from "@caveman-app/ui/icons/huge";
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { useEffect, useMemo, useRef, useState } from "react";
import { credentialsOutside, engineReady, enginesChecking, onboardingDefault } from "../../state/engines.ts";
import { useEngineScan, type EngineScan } from "../../state/engine-scan.ts";
import { funnelStep } from "../../state/desktop.ts";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { EnginePanel, WaysIn } from "../engines/WaysIn.tsx";
import { ImportDialog } from "../plugins/Import.tsx";
import { offersUnlock, paidPlan, planColumns } from "../../components/unlock-model.ts";
import { planLabel } from "../settings/account-model.ts";
import { andList, bringingLine, foundLogins, importRefs, importSummary, notFound, type Bringing } from "./model.ts";
import { turnOnPlanUsage, useAccount, useImportScan } from "./data.ts";
import { Card, Caveman, FlameMark, Head, Nav, Page, Ready, Row, Working } from "./parts.tsx";
import { ReportButton } from "../../components/ReportButton.tsx";
import { GitTools } from "./GitTools.tsx";
import { IS_WINDOWS } from "../../lib/platform.ts";

const WHY: Record<string, string> = {
  caveman: "Our engine, the cheapest per task.",
  "claude-agent": "On your own Claude login.",
  codex: "On your own ChatGPT login.",
};

/**
 * `plans` is bumped when a plan unlocks: the account is read again. `onBring`: the setup to bring over, started by
 * Continue and left running while the person picks a project (Onboarding shows how it goes).
 */
export function SetupStep({
  onBack,
  onNext,
  onBring,
  bringing = null,
  onUnlock,
  plans,
}: {
  onBack?: (() => void) | undefined;
  onNext: () => void;
  onBring?: ((items: ReturnType<typeof importRefs>, parts: ReadonlyArray<string>) => void) | undefined;
  /** A run already started (Back from the project step): said in the row, never started again. */
  bringing?: Bringing | null;
  onUnlock: () => void;
  plans: number;
}) {
  const { client } = useRuntimeClient();
  const engines = useRuntimeSelector((v) => v.engines);
  const settings = useRuntimeSelector((v) => v.settings);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const sources = useImportScan();
  // What is installed here and signed in through its own CLI (engine.scan: Cursor and the other harnesses, and whether
  // claude and codex are on this computer), read in the background so Your setup never waits for it.
  const scan = useEngineScan(engines.length > 0 && !credentialsOutside(engines));
  const [picked, setPicked] = useState<EngineDescriptor["id"] | null>(null);
  // Off until ticked: each agent already uses its own setup when it runs here, and bringing all of it in turns every
  // plugin and server on for every agent at once, each asking for its sign-in again. Plugins gives them one at a time.
  const [bring, setBring] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [imported, setImported] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by the Choose dialog's import, read when it closes (its callbacks run before the close).
  const importedNow = useRef(false);
  const { account, reload } = useAccount(true);
  useEffect(() => {
    if (plans > 0) reload();
  }, [plans, reload]);
  useEffect(() => funnelStep("setup_shown"), []);

  const checking = engines.length === 0 || enginesChecking(engines);
  const found = foundLogins(engines);
  const missing = notFound(engines);
  const nothing = !checking && found.length === 0;
  const ready = engines.filter(engineReady);
  const fallback = checking ? undefined : onboardingDefault(engines, settings?.default_engine, settings?.default_engine_chosen);
  const engineId = picked ?? fallback;
  const engine = engines.find((e) => e.id === engineId);
  const summary = useMemo(() => importSummary(sources ?? []), [sources]);
  const pose: MascotPose = checking ? "working" : nothing ? "thinking" : "done";

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      // A default the person picked here becomes their choice; an automatic one stays unchosen and follows what is
      // connected. Awaited: the project step's first chat starts on it.
      if (client && picked && picked !== settings?.default_engine) {
        await client.call("settings.set", { request_id: requestId(), settings: { default_engine: picked } });
        void refresh();
      }
      // Never waited for: installing a big setup's plugins takes tens of seconds. It runs while a project is picked.
      if (bring && !imported && !bringing && summary.count > 0 && sources) onBring?.(importRefs(sources), summary.parts);
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      width={540}
      head={
        <Head
          figure={<Caveman pose={pose} />}
          title={checking ? "Looking around" : nothing ? "Nothing to run on yet" : "Here's what you already have"}
          desc={
            checking
              ? "Checking this computer for subscriptions, agents and the setup you've built up."
              : nothing
                ? "Connect one way in to start. You can add more any time in Settings."
                : "Each one runs on your own login."
          }
        />
      }
      foot={
        <Nav
          onBack={onBack}
          onNext={() => void next()}
          disabled={checking || nothing || busy}
          next={busy ? "Saving…" : "Continue"}
          aside={
            error ? (
              <span role="alert" className="flex items-center gap-1 text-destructive">
                {error}
                <ReportButton request={{ surface: "onboarding", error: { name: "SetupFailed", message: error } }} />
              </span>
            ) : nothing ? (
              // Never a dead end: chats wait for an engine, set up any time in Settings > Models & keys.
              <button type="button" className="text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={onNext}>
                Set up later
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="mt-7 flex w-full flex-col gap-3">
        <Card title="Subscriptions" aside={checking || nothing ? undefined : `${found.length} ready`}>
          {found.map((f) => (
            <Row key={`${f.engine}:${f.label}`} icon={<EngineLogo engine={f.engine} />} label={f.label} desc={f.detail} right={<Ready />} />
          ))}
          {!checking ? <PlanUsage account={account} engines={engines} /> : null}
          {checking ? (
            <Row icon={<Working text="" />} label={<span className="text-muted-foreground">Checking {andList(engines.filter((e) => e.auth.state === "checking").slice(0, 3).map((e) => e.label)) || "your engines"}</span>} />
          ) : nothing ? (
            <WaysIn engines={engines} scan={scan} unlock={offersUnlock(account) && account?.offer ? planColumns(account.offer)[0] : undefined} onUnlock={onUnlock} />
          ) : missing.length > 0 ? (
            <>
              <div className="flex min-h-10 items-center gap-2.5 px-2.5 text-[13px]">
                <span className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">Not found: {missing.length > 3 ? `${missing.slice(0, 2).join(", ")} and ${missing.length - 2} more` : andList(missing)}</span>
                <button type="button" className="shrink-0 text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={() => setOpen(open === "more" ? null : "more")} aria-expanded={open === "more"}>
                  {open === "more" ? "Done" : "Add another"}
                </button>
              </div>
              {open === "more" ? <SetUpEach engines={engines.filter((e) => !engineReady(e) && e.auth.state !== "checking")} scan={scan} /> : null}
            </>
          ) : null}
        </Card>

        {/* Git, which projects and chats need: shown when it's missing, and on Windows always (onboarding.md, Your setup). */}
        <GitTools showReady={IS_WINDOWS} />

        {!checking && ready.length > 0 && engine ? (
          <div className="flex min-h-8 items-center gap-2 px-[15px] text-[13px] animate-in fade-in duration-150 ease-snap">
            {/* px-[15px]: a Card's words start 15px in (its 1px edge, p-1, then px-2.5); a line beside the cards starts there too. */}
            <span className="whitespace-nowrap text-muted-foreground">New chats start on</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary">
                  <EngineLogo engine={engine.id} />
                  {engine.label}
                  <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {ready.map((e) => (
                  <DropdownMenuItem key={e.id} onSelect={() => setPicked(e.id)}>
                    <EngineLogo engine={e.id} />
                    {e.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="min-w-0 truncate text-[hsl(var(--subtle-foreground))]">{WHY[engine.id] ?? "Change it per chat any time."}</span>
          </div>
        ) : null}

        {bringing && bringing.state !== "interrupted" ? (
          // Started already (Back from the project step): how it goes, never a second run.
          <div className="animate-in fade-in duration-150 ease-snap">
            <Card>
              <div role="status" aria-live="polite" className="flex min-h-10 w-full items-center gap-2.5 px-2.5 text-[13px]" title={bringingLine(bringing)}>
                <span className="min-w-0 flex-1 truncate">
                  {bringing.state === "running" ? <Working text={bringingLine(bringing)} /> : bringing.state === "done" && bringing.failed.length === 0 ? <Ready text={bringingLine(bringing)} /> : <span className="text-warning">{bringingLine(bringing)}</span>}
                </span>
              </div>
            </Card>
          </div>
        ) : !checking && !nothing && summary.count > 0 ? (
          <div className="animate-in fade-in duration-150 ease-snap">
            <Card>
              <label className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-75 hover:bg-accent/60">
                <span className="grid size-4 shrink-0 place-items-center">
                  {imported ? <Ready text="" /> : <Checkbox checked={bring} onCheckedChange={(v) => setBring(v === true)} aria-label="Bring your setup" />}
                </span>
                <span className="whitespace-nowrap text-foreground">{imported ? "Brought over" : "Bring your setup"}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary.parts.join(", ")}</span>
                <button
                  type="button"
                  className="ml-auto shrink-0 text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    setChoosing(true);
                  }}
                >
                  Choose
                </button>
              </label>
            </Card>
            <p className="mx-[15px] mt-2 text-[12px] leading-[18px] text-[hsl(var(--subtle-foreground))]">
              From {andList(summary.from)}, which keep using it either way. Ticked, every agent gets it; keys stay where they are.
            </p>
          </div>
        ) : null}
      </div>
      <ImportDialog
        open={choosing}
        onOpenChange={(o) => {
          setChoosing(o);
          // Closed without importing: the person looked and chose; Continue brings nothing on its own.
          if (!o && !importedNow.current) setBring(false);
        }}
        onImported={() => {
          importedNow.current = true;
          setImported(true);
          setBring(false);
        }}
      />
    </Page>
  );
}

/** A plan held but its usage not on for the Caveman engine yet (a new computer): one click turns it on. */
function PlanUsage({ account, engines }: { account: AccountSummary | null; engines: ReadonlyArray<EngineDescriptor> }) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [state, setState] = useState<"idle" | "busy" | "on" | string>("idle");
  const sub = paidPlan(account);
  // Once on, the engine reads ready and lists among the logins found.
  if (!sub || !client || state === "on" || account?.credits_on || engineReady(engines.find((e) => e.id === "caveman"))) return null;
  const turnOn = () => {
    setState("busy");
    turnOnPlanUsage(client, refresh).then(
      () => setState("on"),
      (e) => setState(e instanceof Error ? e.message : String(e)),
    );
  };
  const failed = state !== "idle" && state !== "busy" && state !== "on";
  return (
    <Row
      icon={<FlameMark />}
      label={`Caveman ${planLabel(sub.plan, account?.offer)}`}
      desc={failed ? <span className="text-destructive">{state}</span> : "Run the Caveman engine on your plan's usage"}
      right={
        <Button size="sm" variant="secondary" disabled={state === "busy"} onClick={turnOn}>
          {state === "busy" ? "Turning on…" : "Use it"}
        </Button>
      }
    />
  );
}

/** Add another: each engine without a login, set up in place. */
function SetUpEach({ engines, scan }: { engines: ReadonlyArray<EngineDescriptor>; scan: EngineScan }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mt-0.5 border-t border-border/70 pt-0.5">
      {engines.map((e) => (
        <div key={e.id}>
          <Row
            icon={<EngineLogo engine={e.id} />}
            label={e.label}
            desc={e.auth.message ?? e.version}
            right={
              <Button size="sm" variant="ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                {open === e.id ? "Close" : "Set up"}
              </Button>
            }
          />
          {open === e.id ? (
            <div className="mx-2.5 mb-2 pl-[26px] text-[13px]">
              <EnginePanel engine={e} scan={scan} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
