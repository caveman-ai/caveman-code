// The mic beside Send (docs/chief.md "Dictation"): press it, or its shortcut, and talk; the words land in the box.
// Pressed, it grows into a raised pill, a stop square and your voice as a line (VoiceWave), drawn from the microphone once
// a frame without touching React. The line lies flat until the microphone is open, and under reduced motion.
import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { Icon, Mic02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { VoiceWave } from "../call/VoiceWave.tsx";
import type { WaveSource } from "../call/wave.ts";
import { ariaChord, formatChord } from "../panels/chrome.tsx";
import { micSource, type DictationPhase } from "./store.ts";

export function MicButton({ phase, shortcut, blocked, onToggle, source = micSource }: { phase: DictationPhase; shortcut: string; blocked?: string | null; onToggle: () => void; /** What it hears; absent, the dictation's own microphone. */ source?: WaveSource }) {
  const live = phase === "live";
  // The pill is there from the click, so the box moves once: the line comes alive in it when the microphone opens.
  const open = live || phase === "starting";
  const label = blocked ?? (phase === "idle" ? "Talk to type" : phase === "starting" ? "Getting ready to listen" : phase === "live" ? "Stop listening" : "Finishing the last words");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The box keeps focus: the words land where the caret was.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => !blocked && onToggle()}
          aria-label={label}
          aria-pressed={phase !== "idle"}
          aria-disabled={blocked ? true : undefined}
          aria-keyshortcuts={ariaChord(shortcut)}
          data-tone={phase === "idle" ? "ghost" : "card"}
          className={cn(
            // the kit's `.key`: a ghost key at rest, the raised card while it listens, beside Send's white key.
            "key composer-key ml-1 flex h-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] outline-none motion-reduce:transition-none",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            open ? "w-[84px] text-foreground" : "w-8",
            blocked && "cursor-default opacity-40",
          )}
        >
          {open ? (
            <span aria-hidden className="flex shrink-0 items-center gap-2 animate-in fade-in-0 duration-150 motion-reduce:animate-none">
              <span className="size-2 shrink-0 rounded-[2px] bg-current" />
              <VoiceWave source={live ? source : null} rest={live ? "drift" : "flat"} layers={3} className={cn("h-5 w-12 transition-opacity duration-200 ease-out", !live && "opacity-50")} />
            </span>
          ) : (
            <Icon icon={Mic02Icon} className={cn("size-4", phase === "finishing" && "animate-pulse")} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {blocked ? null : <span className="ml-1.5 text-muted-foreground">{formatChord(shortcut)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
