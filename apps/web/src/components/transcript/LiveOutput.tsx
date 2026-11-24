// A running command's output as it prints, under its line in the transcript: the first piece of a long
// command's work a person can see, before the command ends. The runtime's CommandOutputHub keeps a bounded,
// normalized tail per running command (Claude Agent's Bash, Codex's commands); `tool.watch` streams it to this
// connection as `tool.live` frames (a whole tail to start or after falling behind, then appends) until it
// settles. Only a row on screen asks for it. The tail is capped like a finished row's output (64 KB), and its
// colours follow the deck's terminal palette, .
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_PALETTES,
  terminalOutputSpans,
  type TerminalOutputState,
} from "@caveman-app/shared/terminalOutput";
import { CodeBlock } from "@caveman-app/ui/ai/code-block";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { LogText } from "./LogText.tsx";

/** Streams one running command's output while `on`; null until the first frame. */
export function useLiveCommandOutput(workspaceId: string | null, itemId: string, on: boolean): TerminalOutputState | null {
  const { client, connection } = useRuntimeClient();
  const [output, setOutput] = useState<TerminalOutputState | null>(null);
  useEffect(() => {
    if (!client || !workspaceId || !on || connection === 0) return;
    let state: TerminalOutputState = EMPTY_TERMINAL_OUTPUT;
    let frame = 0;
    const off = client.on("tool.live", (p) => {
      if (p.workspace_id !== workspaceId || p.item_id !== itemId) return;
      const base = p.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : state;
      state = appendTerminalOutput({ ...base, truncated: base.truncated || p.truncated }, p.text);
      // Frames come at most every 100 ms; render once per animation frame however many arrive.
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setOutput(state);
        });
      }
    });
    const watched = { workspace_id: workspaceId, item_id: itemId };
    void client.call("tool.watch", watched).catch(() => undefined);
    return () => {
      off();
      cancelAnimationFrame(frame);
      void client.call("tool.unwatch", watched).catch(() => undefined);
    };
  }, [client, connection, workspaceId, itemId, on]);
  return output;
}

/** The deck's ANSI palette: the light one reads on the light deck (its dark mapping prints near-white on white). */
const palette = () => (typeof document !== "undefined" && !document.documentElement.classList.contains("dark") ? TERMINAL_PALETTES.light : TERMINAL_PALETTES.dark);

/** True while `ref`'s element is on screen (or near it). */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)), { rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}

/** The output tail of a command that is still running, pinned to its end. It clips rather than scrolls, so a wheel over it scrolls the chat. */
export function LiveOutput({ workspaceId, itemId }: { workspaceId: string | null; itemId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLPreElement>(null);
  const onScreen = useOnScreen(host);
  const output = useLiveCommandOutput(workspaceId, itemId, onScreen);
  const text = output?.text ?? "";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  return (
    <div ref={host} className="pl-3">
      {text.trim() === "" ? null : (
        <CodeBlock size="sm">
          <pre
            ref={scroller}
            aria-label="Output so far"
            aria-live="off"
            className="max-h-40 min-h-0 overflow-hidden whitespace-pre-wrap px-3 py-2 font-mono leading-[19px] text-muted-foreground [overflow-wrap:anywhere]"
          >
            {output?.truncated ? <span className="block italic opacity-70">Earlier output not shown</span> : null}
            {terminalOutputSpans(text, palette()).map((span, index) =>
              // Rebuilt from the text on every update; spans never reorder. A server's address or a file it names links.
              span.style === null ? (
                // oxlint-disable-next-line react/no-array-index-key -- spans never reorder: they are rebuilt from the text on every update.
                <LogText key={index} text={span.text} />
              ) : (
                // oxlint-disable-next-line react/no-array-index-key -- spans never reorder: they are rebuilt from the text on every update.
                <span key={index} style={span.style}>
                  <LogText text={span.text} />
                </span>
              ),
            )}
          </pre>
        </CodeBlock>
      )}
    </div>
  );
}
