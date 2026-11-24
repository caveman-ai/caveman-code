// The first run: Sign in, Your setup, Project, short bars in the title band, and the plan offer any step can open. It
// ends with a project set up; the tour (shell/Tour.tsx) runs only if the person picks Show me around.
// docs/

import { useEffect, useRef, useState } from "react";
import { UnlockPlans } from "../../components/UnlockPlans.tsx";
import { useRuntimeClient, useRuntimeSelector } from "../../state/runtime.tsx";
import { onBringingFinished, startBringing, useBringing } from "../../state/setup-import.ts";
import { useRemoteControl } from "../../components/RemoteControl.tsx";
import { prefetchImportScan } from "./data.ts";
import { resumeStep, type FirstRunEnd } from "./model.ts";
import { Frame } from "./parts.tsx";
import { ProjectStep } from "./ProjectStep.tsx";
import { SetupStep } from "./SetupStep.tsx";
import { SignInStep } from "./SignInStep.tsx";

type Step = "signin" | "setup" | "project";
const LABEL: Record<Step, string> = { signin: "Sign in", setup: "Your setup", project: "Project" };
/** The step this first run is on, so a reload (or a crash's restart) picks up there instead of at sign-in. */
export const STEP_KEY = "caveman.onboarding.step";

/**
 * `onDone(end)`: where the first run ended (FirstRunEnd). `signIn`: required in a packaged app; optional in a
 * development build, the smoke test and E2E; none in the web client Caveman Cloud serves (its session is the account).
 */
export function Onboarding({ onDone, signIn }: { onDone: (end: FirstRunEnd) => void; signIn: "required" | "optional" | "none" }) {
  const steps: ReadonlyArray<Step> = signIn === "none" ? ["setup", "project"] : ["signin", "setup", "project"];
  const [step, setStepState] = useState<Step>(() => resumeStep(localStorage.getItem(STEP_KEY), steps));
  const setStep = (next: Step) => {
    localStorage.setItem(STEP_KEY, next);
    setStepState(next);
  };
  const done = (end: FirstRunEnd) => {
    localStorage.removeItem(STEP_KEY);
    onDone(end);
  };
  const [unlocking, setUnlocking] = useState(false);
  // Bumped when a plan unlocks, so a step showing the plan reads the account again.
  const [plans, setPlans] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const remote = useRemoteControl();
  // The setup coming over (state/setup-import.ts): it outlives this page, and Plugins offers the rest if it didn't finish.
  const bringing = useBringing();
  useEffect(() => onBringingFinished(() => void refresh()), [refresh]);

  // What Claude Code, Codex and Cursor have is read from the first paint, so Your setup opens on the answer.
  useEffect(() => {
    if (client) void prefetchImportScan(client);
  }, [client]);
  // A new step takes focus to its title, so Back and Continue never drop it on the page; never on the first render.
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current !== step) root.current?.querySelector<HTMLElement>("h1")?.focus();
    shown.current = step;
  }, [step]);
  const unlock = () => setUnlocking(true);
  // UnlockPlans turned the plan's usage on before this runs: the steps read the account again.
  const unlocked = () => setPlans((n) => n + 1);

  // Skipping sign-in while a browser sign-in waits drops that sign-in too: left waiting, its code came back on reload.
  const skipSignIn = () => {
    if (remote.status?.signin) void remote.setOn(false);
    setStep("setup");
  };

  // The setup comes over while the person picks a project; the project step's footer says how it goes. Once only:
  // Back then Continue finds it running or done, and starts nothing (startBringing).
  const bring = (items: Parameters<NonNullable<Parameters<typeof SetupStep>[0]["onBring"]>>[0], parts: ReadonlyArray<string>) => {
    if (client) startBringing(client, items, parts);
  };

  return (
    <div ref={root} className="h-full">
      <Frame steps={steps.map((s) => LABEL[s])} step={steps.indexOf(step)}>
        {step === "signin" ? (
          <SignInStep onNext={() => setStep("setup")} onSkip={signIn === "optional" ? skipSignIn : undefined} />
        ) : step === "setup" ? (
          <SetupStep onBack={steps[0] === "signin" ? () => setStep("signin") : undefined} onNext={() => setStep("project")} onBring={bring} bringing={bringing} onUnlock={unlock} plans={plans} />
        ) : (
          <ProjectStep onBack={() => setStep("setup")} onDone={done} onUnlock={unlock} plans={plans} bringing={bringing} />
        )}
      </Frame>
      <UnlockPlans open={unlocking} onOpenChange={setUnlocking} onUnlocked={unlocked} />
    </div>
  );
}
