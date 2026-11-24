// The call on its own, for a phone on a walk: the Chief's name and one button, nothing else on the screen. Save
// it to the home screen (#/call) and a call is one tap. On a call it is the same full-screen stage as the Chief's
// page; the Chief ringing back shows here too.
import { Icon, Call02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState } from "react";
import { useNavigate } from "react-router";
import { CallProblem, CallStage, DISCLOSED_KEY, IncomingCall, STAGE_TOP, STAGE_WAVE } from "../call/CallStage.tsx";
import { clearError, startCall, useCall } from "../call/store.ts";
import { VoiceWave } from "../call/VoiceWave.tsx";
import { useChief } from "../state/chief.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export function CallRoute() {
  const chief = useChief();
  const call = useCall();
  const navigate = useNavigate();
  const [disclosed, setDisclosed] = useState(() => localStorage.getItem(DISCLOSED_KEY) === "1");
  const voice = chief.voice;
  const onCall = call.phase !== "idle" || call.ended !== null;
  const toKey = () => navigate("/settings/chief");
  // One short line under the name: why a call would wait, or nothing when it would not.
  const why =
    chief.status === "loading" ? "" :
    voice === null ? "Calls are not on for this computer" :
    call.elsewhere ? `On a call on ${call.elsewhere.device}` :
    voice.state === "no_key" ? `Calls need Caveman credits or a ${voice.engine_label} key` :
    voice.state === "cap" ? "Today's limit is reached" :
    null;
  const ready = why === null && chief.client !== null;
  const press = () => {
    if (voice?.state === "no_key") return toKey();
    if (!ready || !chief.client) return;
    localStorage.setItem(DISCLOSED_KEY, "1");
    setDisclosed(true);
    void startCall(chief.client);
  };
  if (onCall) return <CallStage state={call} />;
  // The same frame as the stage (CallStage), so the name and the line stay put when the call starts.
  return (
    <main className="call-stage-in fixed inset-0 flex flex-col items-center justify-between bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))] text-center">
      <button
        type="button"
        onClick={() => navigate("/chief")}
        className="absolute left-3 top-[max(0.5rem,env(safe-area-inset-top))] flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Glyph name="chief" />
        Open the Chief
      </button>
      <div className={STAGE_TOP}>
        <div className="flex flex-col items-center gap-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">Chief</h1>
          <p role="status" className="min-h-[22px] text-[15px] text-muted-foreground">{why ?? "Tap to call"}</p>
        </div>
        {/* Where the voice will be: flat until the call starts. */}
        <VoiceWave source={null} rest="flat" className={cn(STAGE_WAVE, "text-muted-foreground opacity-40")} />
      </div>
      {/* Where the call's words show: why the last call did not start, or, before the first, where the voice goes. */}
      <div className="flex w-full max-w-[360px] flex-col items-center">
        <CallProblem state={call} onKey={toKey} onDismiss={() => chief.client && clearError(chief.client)} />
        <p className="max-w-[300px] text-balance text-[13px] leading-5 text-muted-foreground">
          {call.error
            ? ""
            : voice?.state === "no_key"
              ? "Get a Caveman plan or add a key in Settings, then come back."
              : !disclosed && voice
                ? `Your voice goes to ${voice.engine_label}${voice.paid_by === "credits" ? " through Caveman Cloud, and neither keeps any of it" : ", which keeps none of it"}. The transcript stays in the Chief's chat.`
                : ""}
        </p>
      </div>
      <button
        type="button"
        aria-label={voice?.state === "no_key" ? "Add a key" : "Call the Chief"}
        aria-disabled={!ready && voice?.state !== "no_key"}
        onClick={press}
        className={cn(
          "px-play-hover grid size-16 shrink-0 place-items-center rounded-full outline-none transition-[background-color,transform,opacity] duration-150 ease-snap active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          voice?.state === "no_key" ? "bg-accent text-foreground" : "bg-success text-white",
          !ready && voice?.state !== "no_key" && "opacity-40 active:scale-100",
        )}
      >
        <Icon icon={Call02Icon} className="size-7" />
      </button>
      <IncomingCall />
    </main>
  );
}
