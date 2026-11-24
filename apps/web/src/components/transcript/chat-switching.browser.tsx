// Real React Activity + production transcript, no browser-test dependency.
// Run the web dev server and open /src/components/transcript/chat-switching.browser.html.
import { Activity } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { Transcript } from "../Transcript.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import type { Client, Session, SessionEvent } from "@caveman-app/session-protocol";
import { useSession } from "../../state/runtime.tsx";
import "../../styles.css";

const host = document.getElementById("switching")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const runtime = { client: null, engines: [], workspaces: [], raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
const at = new Date().toISOString();
const prompt: Extract<TranscriptItem, { kind: "user" }> = { kind: "user", id: "prompt", text: "Explain the water cycle.", delivery: "message", at };
const answer = (text: string, streaming = true): TranscriptItem => ({ kind: "assistant", id: "answer", text, streaming, at });
let items: TranscriptItem[] = [prompt];
let generation = 0;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function show(active: boolean) {
  flushSync(() => root.render(<MemoryRouter><RuntimeContext.Provider value={runtime}><TooltipProvider>
    <Activity key={generation} mode={active ? "visible" : "hidden"}>
      <section data-chat="a" className="flex h-[360px] flex-col border border-border">
        <Conversation contentClassName="p-5"><Transcript items={items} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running onAnswer={() => undefined} cavemanVersion={null} /></Conversation>
      </section>
    </Activity>
    {!active && <section data-chat="b">Another chat</section>}
  </TooltipProvider></RuntimeContext.Provider></MemoryRouter>));
}
async function run() {
  const checks: Record<string, boolean> = {};
  const fading = (within: Element) => [...within.querySelectorAll<HTMLElement>("[data-word-fade]")].filter((word) => Number(getComputedStyle(word).opacity) < 0.99).length;
  show(true);
  await frame();
  items = [prompt, answer("Clouds form when water vapor cools. ".repeat(12))];
  show(true);
  await delay(100);
  show(false);
  const full = "Clouds form when water vapor cools. ".repeat(100) + "HIDDEN_END";
  items = [prompt, answer(full)];
  show(false);
  await delay(150);
  const started = performance.now();
  show(true);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await frame();
    const response = host.querySelector('[data-slot="response"]')!;
    samples.push({ ms: performance.now() - started, chars: response.textContent?.length ?? 0, complete: response.textContent?.includes("HIDDEN_END") ?? false, fadingWords: fading(response) });
  }
  checks.hiddenBacklogWholeOnFirstFrame = samples.every((sample) => sample.complete);
  checks.returnedTextOpaque = samples.every((sample) => sample.fadingWords === 0);

  items = [prompt, answer(full + " New visible words arrive now. VISIBLE_END ")];
  show(true);
  let newWordsFaded = false;
  for (let i = 0; i < 20; i++) {
    await frame();
    newWordsFaded ||= fading(host) > 0;
  }
  checks.newVisibleDeltaStillFades = newWordsFaded;

  const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-viewport"]')!;
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  viewport.scrollTop = 120;
  viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  await frame();
  const savedTop = viewport.scrollTop;
  show(false);
  items = [prompt, answer(full, false), { ...answer("A reply received while away. ".repeat(30) + "NEW_MESSAGE_END"), id: "away-reply" }];
  show(false);
  await delay(100);
  show(true);
  await frame();
  checks.newMessageWhileAwayShowsWhole = host.textContent?.includes("NEW_MESSAGE_END") ?? false;
  checks.newMessageWhileAwayOpaque = fading(host) === 0;
  checks.readerPositionRetained = Math.abs(viewport.scrollTop - savedTop) <= 1;
  const returnedTop = viewport.scrollTop;
  const awayResponse = host.querySelectorAll('[data-slot="response"]')[1];
  show(false);
  items = [prompt, answer(full, false), { ...answer("A reply received while away. ".repeat(30) + "NEW_MESSAGE_END", false), id: "away-reply" }];
  show(false);
  await delay(80);
  show(true);
  await frame();
  checks.completedWhileHiddenOpaque = fading(host) === 0;
  checks.returnKeepsDom = host.querySelectorAll('[data-slot="response"]')[1] === awayResponse;

  generation++;
  items = [prompt];
  show(false);
  await delay(80);
  items = [prompt, answer(full)];
  show(false);
  await delay(80);
  show(true);
  await frame();
  checks.firstShowAfterHiddenPrewarmWhole = host.textContent?.includes("HIDDEN_END") ?? false;
  checks.firstShowAfterHiddenPrewarmOpaque = fading(host) === 0;

  items = [prompt, answer(full, false), { ...prompt, id: "sent-now", at: new Date().toISOString(), text: "A new prompt from the composer." }, {
    kind: "tool", id: "new-tool", verb: "Running", subject: "Water check", parts: [{ action: "command", subject: "Water check" }], command: "printf rain", status: "running", startedAt: at, finishedAt: null, added: null, removed: null, output: "", name: "command", input: {}, result: null, icon: "run",
  }];
  show(true);
  await frame();
  checks.newVisibleToolEnters = host.querySelector('.work-step[data-entering="true"]') !== null;
  show(false);
  await delay(20);
  show(true);
  await frame();
  const sent = host.querySelector<HTMLElement>('[data-user-message="sent-now"]')!;
  checks.returnedPromptDoesNotRise = getComputedStyle(sent).opacity === "1" && sent.getAnimations().every((animation) => animation.playState !== "running");
  checks.returnedTurnNotHeldBehindPrompt = host.querySelector("[data-prompt-rise]") === null;
  checks.returnedToolDoesNotEnterAgain = host.querySelector('.work-step[data-entering="true"]') === null;
  const feedHost = document.createElement("div");
  host.after(feedHost);
  const feedRoot = createRoot(feedHost);
  const journal: SessionEvent[] = [];
  let receive: ((event: SessionEvent) => void) | null = null;
  let attaches = 0;
  let replayed = false;
  const append = (type: SessionEvent["type"], payload: unknown, item_id?: string) => {
    const event = { session_id: "switch-feed", cursor: journal.length + 1, at, type, payload, ...(item_id ? { item_id } : {}) } as SessionEvent;
    journal.push(event);
    receive?.(event);
  };
  append("message.done", { role: "user", text: "Explain clouds." }, "user");
  append("turn.started", { engine: "claude-agent" });
  append("message.delta", { text: "Already read. " }, "reply");
  const client: Client = {
    call: async () => ({ editors: [], reveal: false } as never), on: () => () => undefined, close: () => undefined,
    hello: () => undefined, onHello: () => () => undefined,
    attach: async (id, cursor, onEvent) => {
      attaches++;
      const backlog = journal.filter((event) => event.cursor > cursor);
      let active = true;
      receive = (event) => { if (active) onEvent(event); };
      setTimeout(() => {
        if (!active) return;
        for (const event of backlog) onEvent(event);
        replayed = true;
      }, 80);
      return { session: { id, head: journal.length, engine: "claude-agent" } as Session, cursor: () => journal.length, epoch: () => 1, detach: async () => { active = false; receive = null; } };
    },
  };
  function FeedChat() {
    const { view, historyVersion } = useSession("switch-feed");
    return view ? <Conversation><Transcript items={view.items} historyVersion={historyVersion} running={view.running} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} onAnswer={() => undefined} cavemanVersion={null} /></Conversation> : <p>Loading</p>;
  }
  const feedShow = (visible: boolean) => flushSync(() => feedRoot.render(<MemoryRouter><RuntimeContext.Provider value={{ ...runtime, client }}><TooltipProvider><Activity mode={visible ? "visible" : "hidden"}><div className="flex h-[360px] flex-col"><FeedChat /></div></Activity></TooltipProvider></RuntimeContext.Provider></MemoryRouter>));
  feedShow(true);
  await delay(130);
  feedShow(false);
  await delay(20);
  append("message.delta", { text: "Clouds condense. ".repeat(100) + "REATTACH_END" }, "reply");
  replayed = false;
  feedShow(true);
  await delay(100);
  await frame();
  const reattachWhole = feedHost.textContent?.includes("REATTACH_END") ?? false;
  checks.delayedReattachWhole = reattachWhole;
  checks.delayedReattachOpaque = fading(feedHost) === 0;
  const passed = Object.values(checks).every(Boolean);
  document.documentElement.dataset.result = passed ? "passed" : "failed";
  result.textContent = JSON.stringify({ passed, checks, expectedChars: full.length, samples, replayed, reattachWhole, attaches, savedTop, returnedTop }, null, 2);
}
void run().catch((error: unknown) => {
  document.documentElement.dataset.result = "failed";
  result.textContent = String(error);
  console.error(error);
});
