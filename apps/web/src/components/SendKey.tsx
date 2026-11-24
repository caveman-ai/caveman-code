// The composer's keys (STYLE.md "Composer keys"): Send at the end of the bar, and Stop beside it while typing over a
// running turn. Send is one key that morphs: a grey squircle with nothing to send, the white key with its word ("Send",
// "Steer", "Queue") once there is, and Stop while the chat works and the box is empty. Its width follows its content,
// so the word slides out of the squircle; the chevron's arms swing upright and close into Stop's square. The kit's
// `.key` draws them.
import { useLayoutEffect, useRef, useState } from "react";
import { Icon, SquareIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";

export type SendKeyMode = "idle" | "send" | "stop";

// A double click on Send, whose draft empties as it goes, lands the second click on the Stop it turned into.
const STOP_AFTER_SEND_MS = 500;

export function SendKey({
  mode,
  label,
  ariaLabel,
  onSend,
  onStop,
}: {
  mode: SendKeyMode;
  label: string;
  ariaLabel: string;
  onSend: () => void;
  onStop: () => void;
}) {
  const content = useRef<HTMLSpanElement>(null);
  const sentAt = useRef(0);
  const [width, setWidth] = useState<number | null>(null);
  const worded = mode === "send";
  // Measured, not `width: auto`, so the width eases in every browser; it follows the font loading and the word changing.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <button
      type="button"
      aria-label={mode === "stop" ? "Stop" : ariaLabel}
      disabled={mode === "idle"}
      data-mode={mode}
      onClick={() => {
        if (mode === "send") {
          sentAt.current = performance.now();
          onSend();
        } else if (mode === "stop" && performance.now() - sentAt.current > STOP_AFTER_SEND_MS)
          onStop();
      }}
      style={width === null ? undefined : { width }}
      className="key composer-key ml-1 size-8 shrink-0 overflow-hidden rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      data-tone={mode === "idle" ? "rest" : "lit"}
    >
      <span
        ref={content}
        className={cn("relative flex h-full w-max items-center pl-2", worded ? "pr-3" : "pr-2")}
      >
        {/* One glyph, two bars: tilted, the chevron; upright side by side, Stop's square (styles.css `.send-glyph`). */}
        <span aria-hidden className="send-glyph" data-glyph={mode === "stop" ? "stop" : "send"}>
          <span />
          <span />
        </span>
        {/* Out of the flow when hidden, at the place it sits in it: it fades where it stands as the key closes over it. */}
        <span
          key={label}
          aria-hidden
          className={cn(
            "composer-key-word whitespace-nowrap text-[13px] font-semibold leading-none",
            worded ? "ml-1.5 max-w-[140px] truncate" : "absolute left-[30px]",
          )}
          data-on={worded}
        >
          {label}
        </span>
      </span>
    </button>
  );
}

/** Stop while there is something typed over a running turn: Send is busy steering, so Stop stands beside it. */
export function StopKey({ onStop }: { onStop: () => void }) {
  return (
    <button
      type="button"
      aria-label="Stop"
      onClick={onStop}
      data-tone="card"
      className="key composer-key composer-key-in ml-1 grid size-8 shrink-0 place-items-center rounded-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
    >
      <Icon icon={SquareIcon} className="size-3 fill-current" />
    </button>
  );
}
