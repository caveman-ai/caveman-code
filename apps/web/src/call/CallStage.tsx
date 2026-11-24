// What a call looks like: in the Chief's box, which becomes the call (CallBox); on a phone, the whole screen
// (CallStage); the pill in the sidebar while you are elsewhere; and the card when the Chief rings you back. One focal
// point, the voice as a line; the rest is chrome: a timer, what is happening, the last words said, two buttons.
import type { ChiefVoice, VoiceShowing } from "@caveman-app/session-protocol";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@caveman-app/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { Icon, ArrowDown01Icon, Call02Icon, CallEnd01Icon, Cancel01Icon, Mic02Icon, MicOff02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatChord, isTypingTarget } from "../panels/chrome.tsx";
import { requestId, useRuntimeClient, useRuntimeSelector } from "../state/runtime.tsx";
import { MUTE_OPTIONS, muteLabel, muteSettings, ringMute, unmuteSettings, type MuteOption } from "./mute.ts";
import { answerIncoming, callSignal, clearMissed, declineIncoming, endCall, endedLine, holdToTalk, setMuted, startCall, useCall, type CallSignal, type CallState } from "./store.ts";
import { callChief, useChiefs } from "../state/chiefs.ts";
import { VoiceWave } from "./VoiceWave.tsx";
import type { WaveRest } from "./wave.ts";
import { clock } from "./clock.ts";
import "./call.css";

/** What a call is doing, as its line shows it. */
export type CallMode = "ringing" | "listening" | "hearing" | "thinking" | "speaking" | "muted" | "ended" | "idle";

export function callMode(state: CallState): CallMode {
  if (state.phase === "calling" || (state.phase === "live" && !state.answered)) return "ringing";
  if (state.phase === "ending" || (state.phase === "idle" && state.ended)) return "ended";
  if (state.phase !== "live") return "idle";
  if (state.speaking === "chief") return "speaking";
  if (state.muted && !state.talking) return "muted";
  if (state.speaking === "person") return "hearing";
  return state.thinking ? "thinking" : "listening";
}

/**
 * What the stage's line draws in each mode: whose sound, what it does in a silence, and its ink (`bright`: the
 * Chief's side of the call, its voice and its ring; soft: yours). It draws the microphone whenever the Chief isn't
 * talking, so it answers your first word before the engine says you are speaking.
 */
export function waveOf(mode: CallMode): { readonly source: "voice" | "mic" | "sounds" | null; readonly rest: WaveRest; readonly bright: boolean } {
  switch (mode) {
    case "ringing":
      return { source: "sounds", rest: "drift", bright: true };
    case "speaking":
      return { source: "voice", rest: "drift", bright: true };
    case "thinking":
      return { source: "mic", rest: "think", bright: false };
    case "hearing":
    case "listening":
      return { source: "mic", rest: "drift", bright: false };
    // The hang-up plays out on the line, then it lies flat.
    case "ended":
      return { source: "sounds", rest: "flat", bright: false };
    case "muted":
    case "idle":
      return { source: null, rest: "flat", bright: false };
  }
}

/** The key held to talk while muted, named the way Settings > Keyboard names keys. */
const TALK_KEY = formatChord("space");

/** The status under the name: one short line. */
export function statusLine(state: CallState, now: number, keyboard: boolean): string {
  if (state.phase === "calling" || (state.phase === "live" && !state.answered)) return "Calling…";
  if (state.phase === "ending" || (state.phase === "idle" && state.ended)) return state.ended ? `${endedLine(state.ended.reason)} · ${clock(state.ended.ms)}` : "Hanging up…";
  if (state.handedAt !== null && now - state.handedAt < 4_000) return "Handed to the Chief";
  if (state.talking) return "Talking";
  if (state.muted) return keyboard ? `Muted · hold ${TALK_KEY} to talk` : "Muted";
  if (state.speaking === "chief") return "Speaking";
  if (state.speaking === "person") return "Listening";
  return state.thinking ? "Thinking" : "Listening";
}

const useNow = (on: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return now;
};

/**
 * Mute and hang up: the kit's keys (globals.css `.key`) that Send wears, squared off as Send is (a radius near a third
 * of the side). Mute is the raised card, the white key while muted; hang up is the red key.
 */
function CallKey({ label, onClick, tone = "plain", pressed, children, size = "md" }: { label: string; onClick: () => void; tone?: "plain" | "end"; pressed?: boolean; children: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      data-tone={tone === "end" ? "end" : pressed ? "lit" : "card"}
      className={cn(
        "key px-play-hover grid shrink-0 place-items-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        tone !== "end" && !pressed && "text-foreground",
        size === "sm" ? "size-7 rounded-[9px]" : size === "lg" ? "size-16 rounded-[20px]" : "size-8 rounded-[10px]",
      )}
    >
      {children}
    </button>
  );
}

/** Space held while muted talks; M mutes and unmutes. Outside text fields only. */
function useCallKeys(state: CallState) {
  const { client } = useRuntimeClient();
  useEffect(() => {
    if (!client || state.phase !== "live") return;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target as HTMLElement | null)) return;
      if (e.code === "Space" && state.muted) {
        e.preventDefault();
        if (!e.repeat) holdToTalk(client, true);
      } else if (e.key.toLowerCase() === "m" && !e.repeat) {
        e.preventDefault();
        setMuted(client, !state.muted);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") holdToTalk(client, false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [client, state.phase, state.muted]);
}

/** What both faces of a call read: its clock, what it is doing, and its line (whose sound, in whose ink, dimmed while muted or over). */
function useCallFace(state: CallState, given: CallSignal | undefined) {
  const { client } = useRuntimeClient();
  const own = useMemo(() => callSignal(client), [client]);
  const now = useNow(state.phase === "live" || state.handedAt !== null);
  useCallKeys(state);
  const mode = callMode(state);
  const wave = waveOf(mode);
  const line = {
    source: wave.source ? (given ?? own)[wave.source] : null,
    rest: wave.rest,
    className: cn("transition-[color,opacity] duration-200 ease-out", wave.bright ? "text-foreground" : "text-muted-foreground", (mode === "muted" || mode === "ended") && "opacity-40"),
  };
  return { client, now, mode, line, live: state.phase === "live" && state.answered };
}

/** The dot, the clock and what is happening: one short line. */
function CallStatus({ state, now, live, keyboard, className }: { state: CallState; now: number; live: boolean; keyboard: boolean; className?: string }) {
  return (
    <p role="status" aria-live="polite" className={cn("flex items-center gap-1.5 text-muted-foreground", className)}>
      {live ? <span aria-hidden className="call-live-dot size-1.5 rounded-full bg-success" /> : null}
      {live && state.liveAt !== null ? <span className="tabular-nums text-foreground/80">{clock(now - state.liveAt)}</span> : null}
      {live ? <span aria-hidden>·</span> : null}
      <span>{statusLine(state, now, keyboard)}</span>
    </p>
  );
}

/**
 * The call in the Chief's box. It is the box with its words above its controls (the Composer's compact frame, as a
 * long note lays it out): where the words go, the voice as a line across the box; on the controls' row, the clock and
 * what is happening, the last words said, then mute and hang up where the mic and Send were.
 */
export function CallBox({ state, name = "Chief", signal: given }: { state: CallState; /** The Chief on the call. */ name?: string; /** The call's sound; absent, this client's own call. */ signal?: CallSignal }) {
  const { client, now, mode, line, live } = useCallFace(state, given);
  const keyboard = typeof window !== "undefined" && (window.matchMedia?.("(pointer: fine)").matches ?? false);
  const caption = state.caption;
  return (
    <section aria-label={`Call with ${name}`} className="relative rounded-xl border border-input bg-card p-1.5">
      <div className="call-box-in">
        <VoiceWave source={line.source} rest={line.rest} className={cn("block h-14 w-full", line.className)} />
        <div className="mt-1 flex h-8 items-center gap-3 pl-2.5 text-[13px]">
          <CallStatus state={state} now={now} live={live} keyboard={keyboard} className="shrink-0" />
          <p key={caption?.text ?? ""} className={cn("call-caption-in min-w-0 flex-1 truncate", caption?.who === "person" ? "text-muted-foreground" : "text-foreground")}>
            {caption ? (caption.who === "person" ? `“${caption.text}”` : caption.text) : ""}
          </p>
          {/* Hung up: the buttons go quiet in place while "Call ended" shows, so nothing jumps before the box comes back. */}
          <div inert={mode === "ended"} className={cn("flex shrink-0 items-center gap-1 transition-opacity duration-200 ease-out", mode === "ended" && "opacity-0")}>
            <CallKey label={state.muted ? "Unmute (M)" : "Mute (M)"} pressed={state.muted} onClick={() => client && setMuted(client, !state.muted)}>
              <Icon icon={state.muted ? MicOff02Icon : Mic02Icon} className="size-4" />
            </CallKey>
            <CallKey label="Hang up" tone="end" onClick={() => client && endCall(client)}>
              <Icon icon={CallEnd01Icon} className="size-4" />
            </CallKey>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The stage's name and line, and the line's box: the page a call starts from (routes/Call.tsx) lays out the same, so neither moves when it rings. */
export const STAGE_TOP = "mt-[12vh] flex w-full flex-col items-center gap-10";
export const STAGE_WAVE = "h-32 w-full max-w-[400px]";

/**
 * The call as the whole screen, for a phone: the Chief's name, the voice as a line, the last words said and two
 * buttons a thumb finds, inside the safe areas.
 */
export function CallStage({ state, name = "Chief", signal: given }: { state: CallState; /** The Chief on the call. */ name?: string; /** The call's sound; absent, this client's own call. */ signal?: CallSignal }) {
  const { client, now, mode, line, live } = useCallFace(state, given);
  const caption = state.caption;
  return (
    <section aria-label={`Call with ${name}`} className="call-stage-in fixed inset-0 z-50 flex flex-col items-center justify-between bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))] text-center">
      <div className={STAGE_TOP}>
        <div className="flex flex-col items-center gap-1">
          <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-foreground">{name}</h2>
          <CallStatus state={state} now={now} live={live} keyboard={false} className="text-[15px]" />
        </div>
        <VoiceWave source={line.source} rest={line.rest} className={cn(STAGE_WAVE, line.className)} />
      </div>
      {/* A line kept for the words before any are said, so the first one moves nothing. */}
      <p key={caption?.text ?? ""} className={cn("call-caption-in line-clamp-3 min-h-7 max-w-[560px] text-balance text-[19px] leading-7", caption?.who === "person" ? "text-muted-foreground" : "text-foreground")}>
        {caption ? (caption.who === "person" ? `“${caption.text}”` : caption.text) : null}
      </p>
      {/* Hung up: the buttons go quiet in place while "Call ended" shows, so nothing jumps before the screen comes back. */}
      <div inert={mode === "ended"} className={cn("flex items-center gap-10 transition-opacity duration-200 ease-out", mode === "ended" && "opacity-0")}>
        <CallKey label={state.muted ? "Unmute (M)" : "Mute (M)"} pressed={state.muted} onClick={() => client && setMuted(client, !state.muted)} size="lg">
          <Icon icon={state.muted ? MicOff02Icon : Mic02Icon} className="size-7" />
        </CallKey>
        <CallKey label="Hang up" tone="end" onClick={() => client && endCall(client)} size="lg">
          <Icon icon={CallEnd01Icon} className="size-7" />
        </CallKey>
      </div>
    </section>
  );
}

/** In the sidebar while the call goes on and the Chief's page is not open: the timer, mute and hang up. */
export function CallPill({ onOpen, name }: { onOpen: () => void; /** The Chief on the call, by name; absent, "the Chief". */ name?: string }) {
  const { client } = useRuntimeClient();
  const state = useCall();
  const now = useNow(state.phase === "live");
  if (state.phase !== "live" && state.phase !== "calling") return null;
  return (
    <div className="call-pill-in mx-3 mb-1 flex h-9 items-center gap-1 rounded-[10px] border border-success/30 bg-success/10 pl-2 pr-1">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Back to the call">
        <span aria-hidden className="call-live-dot size-1.5 shrink-0 rounded-full bg-success" />
        <span className="truncate text-[13px] font-medium text-foreground">{state.answered ? (name ? `On a call with ${name}` : "On a call") : `Calling ${name ?? "the Chief"}…`}</span>
        {state.answered && state.liveAt !== null ? <span className="ml-auto pr-1 text-[12px] tabular-nums text-muted-foreground">{clock(now - state.liveAt)}</span> : null}
      </button>
      <CallKey label={state.muted ? "Unmute" : "Mute"} pressed={state.muted} onClick={() => client && setMuted(client, !state.muted)} size="sm">
        <Icon icon={state.muted ? MicOff02Icon : Mic02Icon} className="size-3.5" />
      </CallKey>
      <CallKey label="Hang up" tone="end" onClick={() => client && endCall(client)} size="sm">
        <Icon icon={CallEnd01Icon} className="size-3.5" />
      </CallKey>
    </div>
  );
}

/** While a call shows work on this screen: what it is, the voice's last words as its caption, and the way back to the call. */
export function NowShowing({ showing, caption, onCall }: { showing: VoiceShowing; caption: string | null; onCall: (() => void) | null }) {
  return (
    <div role="status" aria-live="polite" className="call-pill-in flex h-9 shrink-0 items-center gap-2.5 border-b-[0.5px] border-border bg-success/[0.06] px-3 text-[12.5px]">
      <span aria-hidden className="call-live-dot size-1.5 shrink-0 rounded-full bg-success" />
      <span className="shrink-0 font-semibold text-foreground">Showing</span>
      <span className="shrink-0 truncate text-foreground">{showing.caption}</span>
      {caption ? (
        <span key={caption} className="call-caption-in min-w-0 flex-1 truncate text-muted-foreground">
          {caption}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {onCall ? (
        <button type="button" onClick={onCall} className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Back to the call
        </button>
      ) : null}
    </div>
  );
}

const quietButton = "h-7 rounded-[9px] px-3 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground";

/**
 * The ring-back card: answer, later, or mute the Chief's rings for a while. `who`: the Chief whose work rang.
 * `inline`: in the flow (the style page) instead of the corner.
 */
export function IncomingCallCard({ who = "The Chief", line, onAnswer, onLater, onMute, inline = false }: { who?: string; line: string; onAnswer: () => void; onLater: () => void; onMute: (option: MuteOption) => void; inline?: boolean }) {
  return (
    <div
      role="alertdialog"
      aria-label={`${who} is calling`}
      className={cn("call-incoming-in w-[360px] rounded-2xl border border-border bg-popover p-3.5 shadow-[0_12px_40px_-12px_hsl(0_0%_0%/0.6)]", !inline && "fixed right-4 top-4 z-50")}
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-foreground">{who} is calling</p>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[17px] text-muted-foreground">{line}</p>
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            autoFocus={!inline}
            onClick={onAnswer}
            data-tone="answer"
            className="key px-play-hover flex h-7 items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={Call02Icon} className="size-3.5" />
            Answer
          </button>
          <button type="button" onClick={onLater} className={quietButton}>
            Later
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`Mute ${who}'s calls for a while`} className={cn(quietButton, "flex items-center gap-1 pr-2")}>
                Mute for…
                <Icon icon={ArrowDown01Icon} className="size-3" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[220px]">
              {MUTE_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => onMute(o.id)}>
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** A Chief ringing back with work that is ready: answer, and it walks you through it; or mute its rings for a while. */
export function IncomingCall() {
  const { client } = useRuntimeClient();
  const state = useCall();
  const incoming = state.incoming;
  // The Chief whose work rang (chief_id; none from a one-Chief runtime: home).
  const chiefs = useChiefs();
  const who = callChief(chiefs.chiefs, incoming?.chief_id).name ?? "The Chief";
  if (!incoming || state.phase !== "idle" || !client) return null;
  return (
    <IncomingCallCard
      who={who}
      line={incoming.line}
      onAnswer={() => answerIncoming(client)}
      onLater={() => declineIncoming(client)}
      onMute={(option) => {
        // On the runtime, so every device goes quiet and it holds across a relaunch; this ring is declined.
        void client.call("settings.set", { request_id: requestId(), settings: muteSettings(option, new Date()) }).catch(() => undefined);
        declineIncoming(client);
      }}
    />
  );
}

/** Once a minute, for a label that names a time. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** In the Chief's header while its rings are muted: until when, what arrived quietly, and one click to unmute. */
export function RingMutedPillView({ label, missed, onUnmute }: { label: string; missed: number; onUnmute: () => void }) {
  return (
    <div role="status" className="call-pill-in flex h-7 shrink-0 items-center gap-2 rounded-full border border-border bg-card pl-2.5 pr-1 text-[12px]">
      <Icon icon={MicOff02Icon} className="size-3.5 text-muted-foreground" />
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      {missed > 0 ? <span className="rounded-full bg-foreground px-1.5 text-[11px] font-semibold leading-[16px] text-background">{missed} missed</span> : null}
      <button type="button" onClick={onUnmute} className="h-5 rounded-full px-2 text-[12px] font-medium text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        Unmute
      </button>
    </div>
  );
}

export function RingMutedPill() {
  const { client } = useRuntimeClient();
  const settings = useRuntimeSelector((v) => v.settings);
  const state = useCall();
  const now = useMinute();
  const mute = ringMute(settings, new Date(now));
  if (!mute || !client) return null;
  return (
    <RingMutedPillView
      label={muteLabel(mute, new Date(now))}
      missed={state.missed.length}
      onUnmute={() => {
        void client.call("settings.set", { request_id: requestId(), settings: unmuteSettings() }).catch(() => undefined);
        clearMissed(client);
      }}
    />
  );
}

/** Set once the first call has said where the voice goes. */
export const DISCLOSED_KEY = "caveman.chief.call.disclosed";

/**
 * Call the Chief: beside Send in its box. The first call says once where the voice goes. Without a key it says so
 * and points at Settings; on a call elsewhere, or past today's limit, it says why it waits.
 */
export function CallButton({
  voice,
  onNeedsKey,
  chief,
  ring = false,
  onRang,
}: {
  voice: ChiefVoice | null;
  onNeedsKey: () => void;
  /** Which Chief it calls; absent, the home Chief. */
  chief?: { readonly id: string; readonly name: string };
  /** Press it once as it mounts (Call from a Chief's ⋯ menu): the first call still asks first. */
  ring?: boolean;
  onRang?: () => void;
}) {
  const who = chief?.name ?? "the Chief";
  const target = chief ? { chief_id: chief.id } : {};
  const { client } = useRuntimeClient();
  const state = useCall();
  const [asking, setAsking] = useState(false);
  // Every hook runs before the early return below: `voice` arrives after chief.get, so it starts null.
  const why = state.elsewhere ? `On a call on ${state.elsewhere.device}` : voice?.state === "cap" ? "Today's limit is reached" : null;
  const call = () => {
    if (!client || !voice) return;
    if (voice.state === "no_key") return onNeedsKey();
    if (localStorage.getItem(DISCLOSED_KEY) !== "1") return setAsking(true);
    void startCall(client, target);
  };
  useEffect(() => {
    if (!ring || !voice || !client) return;
    onRang?.();
    if (why === null) call();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` and `why` are rebuilt each render; ring once per ring, voice and client.
  }, [ring, voice !== null, client]);
  if (!voice) return null;
  return (
    <Popover open={asking} onOpenChange={setAsking}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={why ?? `Call ${who}`}
              aria-disabled={why !== null}
              onClick={() => why === null && call()}
              data-tone="ghost"
              className={cn(
                "key composer-key px-play-hover ml-1 grid size-8 shrink-0 place-items-center rounded-[10px] outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                why !== null && "cursor-default opacity-40",
              )}
            >
              <Icon icon={Call02Icon} className="size-4" />
            </button>
          </TooltipTrigger>
        </PopoverAnchor>
        <TooltipContent side="top">{why ?? (voice.state === "no_key" ? `Calls need Caveman credits or a ${voice.engine_label} key` : `Call ${who}`)}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[280px] p-3.5">
        <p className="text-[13px] font-semibold text-foreground">Call {who}</p>
        <p className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">
          Talk, and it hands what you ask to {who}. Your voice goes to {voice.engine_label}{voice.paid_by === "credits" ? " through Caveman Cloud, and neither keeps any of it" : ", which keeps none of it"}; the transcript stays in this chat.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setAsking(false)} className="h-7 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              localStorage.setItem(DISCLOSED_KEY, "1");
              setAsking(false);
              if (client) void startCall(client, target);
            }}
            className="px-play-hover flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-semibold text-primary-foreground outline-none active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={Call02Icon} className="size-3.5" />
            Call
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Why the last call could not start, with the one thing that fixes it. */
export function CallProblem({ state, onKey, onDismiss }: { state: CallState; onKey: () => void; onDismiss: () => void }) {
  if (!state.error || state.phase !== "idle") return null;
  return <VoiceProblem error={state.error} icon="call" onKey={onKey} onDismiss={onDismiss} />;
}

/** Why voice could not start (a call, or talking to type), with the one thing that fixes it: a key, or the microphone. */
export function VoiceProblem({ error, icon, onKey, onDismiss }: { error: { readonly text: string; readonly fix?: "mic" | "key" }; icon: "call" | "mic"; onKey: () => void; onDismiss: () => void }) {
  const mic = window.cavemanDesktop?.microphone;
  return (
    <div role="alert" className="call-pill-in mb-2 flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-[12.5px]">
      <Icon icon={error.fix === "mic" ? MicOff02Icon : icon === "call" ? Call02Icon : Mic02Icon} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-foreground">{error.text}</span>
      {error.fix === "key" ? (
        <button type="button" onClick={onKey} className="shrink-0 rounded-md px-2 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          Add a key
        </button>
      ) : error.fix === "mic" && mic ? (
        <button type="button" onClick={() => mic.openSettings()} className="shrink-0 rounded-md px-2 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          Open System Settings
        </button>
      ) : null}
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded-md px-1.5 py-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <Icon icon={Cancel01Icon} className="size-3.5" />
      </button>
    </div>
  );
}
