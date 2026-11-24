// The scroll lab: the production Conversation and Transcript, with live sliders for how the view moves, so the
// latest-turn-at-the-top behaviour (Conversation's room) and the send's arrival can be tuned by feel before they ship.
// No runtime or model: replies stream from a script. Run the web dev server and open
// /src/components/transcript/turn-top.browser.html. "Copy values" gives the numbers to put in conversationTuning.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Conversation, conversationTuning, DEFAULT_TUNING, tune, type ConversationHandle, type ConversationTuning } from "@caveman-app/ui/ai/conversation";
import { Button } from "@caveman-app/ui/components/button";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { SectionHeader } from "../../panels/chrome.tsx";
import { Transcript } from "../Transcript.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import "../../styles.css";

const runtime = { client: null, engines: [], workspaces: [], raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
const KEY = "caveman.scroll-lab.tuning";
const DAY = 24 * 60 * 60 * 1000;

type Mode = "chat" | "chief";
type Length = "line" | "paragraph" | "screen" | "long";
const REPLIES: Record<Length, string> = {
  line: "Test received.",
  paragraph:
    "The current folder isn't a Git repository, so there is nowhere to open a pull request from. Which GitHub repository should I use for the test pull requests?",
  screen: Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1}. The evening carried on: quiet footsteps, distant engines, a bicycle bell, leaves shifting against a wall. Tomorrow would bring more toast, more weather, more misplaced objects.`).join("\n\n"),
  long: Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. Margaret finished the dishes and heard the noise again. This time she opened the cupboard. A small tin had tilted against a stack of plates, and every so often it slipped a fraction farther and tapped the wood.`).join("\n\n"),
};
const ASKS = ["test", "make some pull requests as a test", "what changed since yesterday?", "write me a short story about a cupboard", "and the tests?"];

function history(turns: number, start: number): TranscriptItem[] {
  return Array.from({ length: turns }, (_, t) => {
    const at = new Date(start + t * 60_000).toISOString();
    return [
      { kind: "user", id: `hu${t}`, text: ASKS[t % ASKS.length]!, delivery: "message", at },
      { kind: "assistant", id: `ha${t}`, text: t % 3 === 2 ? REPLIES.screen : REPLIES.paragraph, streaming: false, at },
      { kind: "turn_end", id: `he${t}`, outcome: "completed", at, cursor: t + 1 },
    ] as TranscriptItem[];
  }).flat();
}

function readSaved(): Partial<ConversationTuning> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ConversationTuning>;
  } catch {
    return {};
  }
}
tune(readSaved());

// The Chief's day separator, as routes/Chief.tsx draws it: a new day starts the turn with its date.
function dayDivider(at: string, prev: string | undefined): ReactNode {
  if (prev !== undefined && new Date(at).toDateString() === new Date(prev).toDateString()) return null;
  const d = new Date(at);
  return (
    <div className="flex items-center gap-3 pb-1 pt-6 text-[12.5px] [color:hsl(var(--subtle-foreground))]">
      <span className="h-px flex-1 bg-border" />
      <span>
        <b className="font-medium text-muted-foreground">{d.toLocaleDateString(undefined, { weekday: "long" })}</b> {d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Lab() {
  const [mode, setMode] = useState<Mode>("chat");
  const [height, setHeight] = useState(720);
  const [length, setLength] = useState<Length>("line");
  const [speed, setSpeed] = useState(3);
  const [turns, setTurns] = useState(6);
  // A clock the lab moves: "Next day" puts the next message a day later, as coming back tomorrow does.
  const clock = useRef(Date.now() - 2 * 60 * 60 * 1000);
  const [items, setItems] = useState<TranscriptItem[]>(() => history(6, clock.current - turns * 60_000));
  const [running, setRunning] = useState(false);
  const [opened, setOpened] = useState(0);
  const [draft, setDraft] = useState("make some pull requests as a test");
  const [values, setValues] = useState<ConversationTuning>({ ...conversationTuning });
  const handle = useRef<ConversationHandle>(null);
  const stream = useRef<ReturnType<typeof setInterval> | null>(null);
  // The beat before a reply's first words: a reset or a new send cancels it, so an old reply never streams in later.
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (stream.current) clearInterval(stream.current);
    if (beat.current) clearTimeout(beat.current);
    stream.current = beat.current = null;
  };
  useEffect(() => stop, []);
  const pane = useRef<HTMLDivElement>(null);
  const [readout, setReadout] = useState("");

  const set = <K extends keyof ConversationTuning>(k: K, v: ConversationTuning[K]) => {
    tune({ [k]: v });
    setValues({ ...conversationTuning });
    localStorage.setItem(KEY, JSON.stringify(conversationTuning));
  };
  const resetTuning = () => {
    tune(DEFAULT_TUNING);
    setValues({ ...conversationTuning });
    localStorage.removeItem(KEY);
  };

  const reset = (n = turns) => {
    stop();
    setRunning(false);
    clock.current = Date.now() - 2 * 60 * 60 * 1000;
    setItems(history(n, clock.current - n * 60_000));
    setOpened((o) => o + 1);
  };

  const send = (text: string, at = new Date()) => {
    stop();
    const id = `u${Date.now()}`;
    const iso = at.toISOString();
    setItems((xs) => [...xs.map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)), { kind: "user", id, text, delivery: "message", at: iso }]);
    setRunning(true);
    // As the pane's send does: the view goes to the message on its spring, unless the reader is scrolling.
    handle.current?.arrive();
    const words = REPLIES[length].split(/(\s+)/);
    let shown = 0;
    const replyId = `a${id}`;
    // A beat of "working" before the first words, as an engine has.
    beat.current = setTimeout(() => {
      beat.current = null;
      stream.current = setInterval(() => {
        shown = Math.min(words.length, shown + speed * 2);
        const done = shown >= words.length;
        setItems((xs) => {
          const rest = xs.filter((x) => x.id !== replyId);
          const reply: TranscriptItem = { kind: "assistant", id: replyId, text: words.slice(0, shown).join(""), streaming: !done, at: iso };
          return done ? [...rest, reply, { kind: "turn_end", id: `e${id}`, outcome: "completed", at: new Date(at.getTime() + 6000).toISOString(), cursor: rest.length + 2 }] : [...rest, reply];
        });
        if (done) {
          clearInterval(stream.current!);
          stream.current = null;
          setRunning(false);
        }
      }, 50);
    }, 700);
  };

  // What the scroller is doing, a few times a second: the room under the turn and where the view is.
  useEffect(() => {
    const t = setInterval(() => {
      const v = pane.current?.querySelector<HTMLElement>('[data-slot="conversation-viewport"]');
      const room = pane.current?.querySelector<HTMLElement>('[data-slot="conversation-room"]');
      const anchor = pane.current?.querySelector<HTMLElement>("[data-conversation-anchor]");
      if (!v) return;
      const fromTop = anchor ? Math.round(anchor.getBoundingClientRect().top - v.getBoundingClientRect().top) : null;
      setReadout(`room ${room?.offsetHeight ?? 0}px · from end ${Math.round(v.scrollHeight - v.clientHeight - v.scrollTop)}px · latest turn ${fromTop === null ? "not mounted" : `${fromTop}px from top`}`);
    }, 200);
    return () => clearInterval(t);
  }, []);

  const chief = mode === "chief";
  return (
    <div className="flex h-screen gap-4 bg-background p-4 text-foreground">
      <aside className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto text-[13px]">
        <h1 className="text-[15px] font-medium">Scroll lab</h1>
        <Group title="How it moves (live)">
          <Toggle label="Latest turn to the top" on={values.room} onChange={(v) => set("room", v)} />
          <Slider label="Most empty room" hint="share of the screen" value={values.maxRoom} min={0} max={1} step={0.05} onChange={(v) => set("maxRoom", v)} />
          <Slider label="Gap above the turn" hint="px past the top padding" value={values.inset} min={-40} max={200} step={4} onChange={(v) => set("inset", v)} />
          <Slider label="Send spring" hint="higher is snappier (1/s)" value={values.arriveRate} min={4} max={40} step={1} onChange={(v) => set("arriveRate", v)} />
          <Slider label="Far send starts after" hint="screens from the end" value={values.arriveFar} min={0.5} max={5} step={0.25} onChange={(v) => set("arriveFar", v)} />
          <Slider label="Far send travels" hint="screens" value={values.arriveFrom} min={0.1} max={2} step={0.05} onChange={(v) => set("arriveFrom", v)} />
          <Slider label="Follow glide" hint="share per frame while streaming" value={values.glide} min={0.05} max={1} step={0.05} onChange={(v) => set("glide", v)} />
          <div className="flex gap-2">
            <LabButton onClick={resetTuning}>Reset to shipped</LabButton>
            <LabButton onClick={() => void navigator.clipboard.writeText(JSON.stringify(conversationTuning, null, 2))}>Copy values</LabButton>
          </div>
        </Group>
        <Group title="The chat">
          <Choice label="Kind" value={mode} options={["chat", "chief"]} onChange={(v) => setMode(v as Mode)} />
          <Choice label="Reply" value={length} options={["line", "paragraph", "screen", "long"]} onChange={(v) => setLength(v as Length)} />
          <Slider label="Stream speed" hint="words per frame" value={speed} min={1} max={20} step={1} onChange={setSpeed} />
          <Slider label="History" hint="earlier turns" value={turns} min={0} max={40} step={1} onChange={(v) => { setTurns(v); reset(v); }} />
          <Slider label="Window height" hint="px" value={height} min={420} max={1100} step={20} onChange={setHeight} />
        </Group>
        <Group title="Moments">
          <LabButton onClick={() => setOpened((o) => o + 1)}>Go away and come back (reopen)</LabButton>
          <LabButton onClick={() => { clock.current += DAY; send("good morning, what's left from yesterday?", new Date(Math.max(Date.now(), clock.current))); }}>Next day: send a message</LabButton>
          <LabButton onClick={() => reset()}>Reset the chat</LabButton>
        </Group>
        <p className="text-[12px] leading-[18px] text-muted-foreground">{readout}</p>
        <p className="text-[12px] leading-[18px] text-muted-foreground">Values stay in this browser. Scroll up and send to feel a far arrival; the rail on the left jumps between your messages.</p>
      </aside>
      <section ref={pane} className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background" style={{ height, ["--pane-top" as string]: chief ? "0px" : "44px" }}>
        {/* A chat's tab strip floats over its conversation (the pane's --pane-top); a Chief's bar sits above it. */}
        <header className={chief ? "flex h-11 shrink-0 items-center px-4 text-[14px] font-medium" : "absolute inset-x-0 top-0 z-20 flex h-11 items-center bg-background/80 px-4 text-[14px] backdrop-blur"}>
          {chief ? "Chief" : "Testing"}
        </header>
        <MemoryRouter>
          <RuntimeContext.Provider value={runtime}>
            <TooltipProvider>
              <Conversation key={`${mode}-${opened}`} handle={handle} className="pane-conversation min-h-0 flex-1" contentClassName={chief ? "pl-14 pr-6 pt-2" : "pl-14 pr-6 pt-[calc(var(--pane-top)+12px)]"}>
                <div className={chief ? "mx-auto max-w-[760px] pb-6" : "mx-auto max-w-[760px]"}>
                  <Transcript
                    items={items}
                    sessionId={`lab-${mode}`}
                    running={running}
                    onAnswer={() => undefined}
                    cavemanVersion={null}
                    {...(chief
                      ? { engine: "caveman", engineLabel: "Chief", engineIsCaveman: true, speaker: { name: "Chief", avatar: null }, workedLines: true, divider: dayDivider }
                      : { engine: "codex", engineLabel: "Codex", engineIsCaveman: false })}
                  />
                </div>
              </Conversation>
            </TooltipProvider>
          </RuntimeContext.Provider>
        </MemoryRouter>
        <form
          className="shrink-0 px-6 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) send(draft.trim());
          }}
        >
          <div className="mx-auto flex max-w-[792px] items-center gap-2 rounded-xl border border-border bg-card p-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask anything" className="min-w-0 flex-1 bg-transparent px-2 text-[14px] outline-none" />
            <LabButton type="submit">Send</LabButton>
          </div>
        </form>
      </section>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <SectionHeader as="h2" className="px-0 pb-0">{title}</SectionHeader>
      {children}
    </div>
  );
}

function Slider({ label, hint, value, min, max, step, onChange }: { label: string; hint: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={undefined} />
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between">
      <span>{label}</span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="flex gap-1">
        {options.map((o) => (
          <Button key={o} variant="ghost" size="sm" aria-pressed={o === value} onClick={() => onChange(o)} className={o === value ? "bg-accent text-foreground" : undefined}>
            {o}
          </Button>
        ))}
      </span>
    </div>
  );
}

function LabButton({ children, type = "button", ...props }: React.ComponentProps<"button">) {
  return (
    <Button type={type} variant="secondary" size="sm" {...props}>
      {children}
    </Button>
  );
}

createRoot(document.getElementById("lab")!).render(<Lab />);
