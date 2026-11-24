// The production transcript and scroller on a long chat, no browser-test dependency: reading up a chat's history
// keeps what is read where it is and never freezes, and a sent message brings the view to it on a spring.
// Run the web dev server and open /src/components/transcript/history-scroll.browser.html.
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Conversation, type ConversationHandle } from "@caveman-app/ui/ai/conversation";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { Transcript } from "../Transcript.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import "../../styles.css";

const host = document.getElementById("chat")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const runtime = { client: null, engines: [], workspaces: [], raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
// History: sent long before the page opened, so nothing in it plays an entrance.
const then = "2026-11-01T10:00:00.000Z";
const code = (turn: number) => "```ts\n" + Array.from({ length: 30 }, (_, line) => `export const step${turn}_${line} = (input: number) => input * ${line + 1} + ${turn};`).join("\n") + "\n```";
const reply = (turn: number) =>
  [`Turn ${turn}: the scheduler drains its **priority queue** on every tick, so a slow job never starves the ones behind it.`, `## What changed in turn ${turn}`, Array.from({ length: 6 }, (_, n) => `${n + 1}. Case ${n} of turn ${turn} still holds, the *empty* input included.`).join("\n"), turn % 2 ? code(turn) : `A closing remark on turn ${turn}, long enough to wrap onto a second line of the reading column.`].join("\n\n");
const turns = (count: number): TranscriptItem[] =>
  Array.from({ length: count }, (_, turn) => [
    { kind: "user", id: `u${turn}`, text: `Question ${turn}: what does the scheduler do on a tick?`, delivery: "message", at: then },
    { kind: "assistant", id: `a${turn}`, text: reply(turn), streaming: false, at: then },
  ] as TranscriptItem[]).flat();
let items = turns(90);
const handle = createRef<ConversationHandle>();
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function show() {
  flushSync(() =>
    root.render(
      <MemoryRouter>
        <RuntimeContext.Provider value={runtime}>
          <TooltipProvider>
            <section className="flex flex-col border border-border" style={{ height: 520 }}>
              <Conversation handle={handle} contentClassName="pl-14 pr-6 pt-4">
                <Transcript items={items} sessionId="history-scroll" engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={false} onAnswer={() => undefined} cavemanVersion={null} />
              </Conversation>
            </section>
          </TooltipProvider>
        </RuntimeContext.Provider>
      </MemoryRouter>,
    ),
  );
}

async function run() {
  const checks: Record<string, boolean> = {};
  // Sizes read as the chat mounts: a long message or code block rests at a CSS size and reads none.
  const read = Element.prototype.getBoundingClientRect;
  let previewReads = 0;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains("stream-preview")) previewReads++;
    return read.call(this);
  };
  show();
  await frame();
  await frame();
  Element.prototype.getBoundingClientRect = read;
  const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-viewport"]')!;
  const rows = () => host.querySelectorAll("[data-transcript-rows] > [data-row]").length;
  const previews = host.querySelectorAll(".stream-preview").length;
  checks.previewsRestWithoutMeasuring = previews > 0 && previewReads === 0;
  checks.railShows = host.querySelector(".sticky") !== null;
  await delay(300);

  // Reading up the history: each frame the view moves by the scroll and nothing else, while rows lay out for the
  // first time above it and older ones mount.
  const box = viewport.getBoundingClientRect();
  const read1 = () => {
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const row = hit?.closest("[data-transcript-rows] > [data-row]");
    return row && hit !== row ? hit : null;
  };
  const mountedAtOpen = rows();
  const STEP = 90;
  let jumps = 0;
  let worstJump = 0;
  let worstFrame = 0;
  let tracked = 0;
  let mark = read1();
  let markAt = mark?.getBoundingClientRect().top ?? 0;
  let last = await frame();
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -STEP }));
  for (let n = 0; n < 420 && viewport.scrollTop > 0; n++) {
    viewport.scrollTop -= STEP;
    const now = await frame();
    worstFrame = Math.max(worstFrame, now - last);
    last = now;
    if (mark?.isConnected) {
      tracked++;
      const off = Math.abs(mark.getBoundingClientRect().top - markAt - STEP);
      if (off > 2) jumps++;
      worstJump = Math.max(worstJump, off);
    }
    mark = read1();
    markAt = mark?.getBoundingClientRect().top ?? 0;
  }
  checks.olderRowsMounted = rows() > mountedAtOpen;
  checks.readingHoldsStill = tracked > 100 && jumps === 0;
  checks.noFrozenFrame = worstFrame < 60;

  // A message sent from a little way up: the view follows again and reaches it, easing out of rest, never back.
  const flight = async (act: () => void, ms: number) => {
    const tops = [viewport.scrollTop];
    act();
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await frame();
      tops.push(viewport.scrollTop);
    }
    return tops;
  };
  const sent = (id: string): TranscriptItem => ({ kind: "user", id, text: "A new prompt from the composer.", delivery: "message", at: new Date().toISOString() });
  viewport.scrollTop = viewport.scrollHeight;
  await delay(400);
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -300 }));
  viewport.scrollTop -= 300;
  await delay(400);
  const near = await flight(() => {
    handle.current!.arrive();
    items = [...items, sent("sent-near")];
    show();
  }, 900);
  const steps = near.slice(1).map((top, i) => top - near[i]!);
  const travel = near.at(-1)! - near[0]!;
  const gapAfter = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  checks.sendArrivesAtTheEnd = travel >= 300 && gapAfter < 1;
  checks.sendEasesOutOfRest = steps.find((step) => step > 0.5)! < travel * 0.12 && Math.max(...steps) < travel * 0.3;
  checks.sendNeverGoesBack = steps.every((step) => step > -0.5);

  // From far up the chat: it starts most of a screen from the end, and still arrives.
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -4000 }));
  viewport.scrollTop -= 4000;
  await delay(400);
  const far = await flight(() => {
    handle.current!.arrive();
    items = [...items, sent("sent-far")];
    show();
  }, 900);
  const farSteps = far.slice(1).map((top, i) => top - far[i]!);
  checks.farSendArrives = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1;
  checks.farSendTravelsTheLastStretch = farSteps.filter((step) => step > 0.5).length > 8;

  // A Chief capture can take longer than the send spring; a queued note can start without a composer send.
  // Both new turns must ease out of rest when the reader is following, rather than take the first 20% at once.
  const arrivals: Record<string, { travel: number; first: number; commit: number; steps: number[] }> = {};
  for (const requested of [true, false]) {
    const name = requested ? "delayedSend" : "queuedTurn";
    viewport.scrollTop = viewport.scrollHeight;
    await delay(800);
    if (requested) {
      handle.current!.arrive();
      await delay(800);
    }
    const beforeCommit = viewport.scrollTop;
    let commit = 0;
    const motion = await flight(() => {
      items = [...items, sent(name)];
      show();
      commit = viewport.scrollTop - beforeCommit;
    }, 900);
    const travel = motion.at(-1)! - motion[0]!;
    const first = motion.slice(1).map((top, i) => top - motion[i]!).find((step) => step > 0.5) ?? 0;
    arrivals[name] = { travel: Math.round(travel), first: Math.round(first), commit, steps: motion.slice(1, 10).map((top, i) => Math.round(top - motion[i]!)) };
    checks[`${name}EasesOutOfRest`] = travel > 80 && first < travel * 0.12;
    checks[`${name}Arrives`] = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1;
  }

  // An automatically started turn must not take the view from someone reading history.
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -300 }));
  viewport.scrollTop -= 300;
  await delay(400);
  const reading = viewport.scrollTop;
  const queuedAway = await flight(() => {
    items = [...items, sent("queued-away")];
    show();
  }, 500);
  checks.queuedTurnLeavesReaderAlone = Math.abs(queuedAway.at(-1)! - reading) < 1;

  // Sent while the reader is scrolling: the view stays in their hands.
  viewport.scrollTop -= 600;
  await delay(400);
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));
  viewport.scrollTop -= 40;
  const before = viewport.scrollTop;
  const mid = await flight(() => {
    handle.current!.arrive();
    items = [...items, sent("sent-mid-scroll")];
    show();
  }, 500);
  checks.sendMidScrollLeavesTheView = Math.abs(mid.at(-1)! - before) < 1;

  const passed = Object.values(checks).every(Boolean);
  document.documentElement.dataset.result = passed ? "passed" : "failed";
  result.textContent = JSON.stringify({ passed, checks, previews, previewReads, rows: { atOpen: mountedAtOpen, after: rows() }, scroll: { tracked, jumps, worstJump: Math.round(worstJump), worstFrameMs: Math.round(worstFrame) }, send: { travel: Math.round(travel), steps: steps.slice(0, 30).map(Math.round) }, arrivals }, null, 2);
}
void run().catch((error: unknown) => {
  document.documentElement.dataset.result = "failed";
  result.textContent = String(error instanceof Error ? error.stack : error);
});
