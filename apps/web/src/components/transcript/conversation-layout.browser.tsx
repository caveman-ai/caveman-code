// Neutral replay through production components. No runtime/model call.
// /src/components/transcript/conversation-layout.browser.html (?gallery for the multi-turn view).
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router";
import { Conversation } from "@caveman-app/ui/ai/conversation";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { Transcript } from "../Transcript.tsx";
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import type { Artifact, ToolItem, TranscriptItem } from "../../state/transcript-model.ts";
import { ChiefActionsProvider, ChiefToolCards, isChiefTool, type ChiefActions } from "../../routes/chief-cards.tsx";
import { chiefCards } from "../../state/chief-model.ts";
import { DISCLOSURE_MS } from "@caveman-app/ui/ai/disclosure";
import { setLiveSteps } from "../../state/live-steps.ts";
import "../../styles.css";

const host = document.getElementById("layout")!;
const result = document.getElementById("result")!;
const root = createRoot(host);
const runtime = { client: null, engines: [], workspaces: [], raw: new Map(), editors: [], refresh: async () => undefined } as unknown as RuntimeContextValue;
const chiefActions: ChiefActions = { workspaces: [], items: [], projectName: () => "Water", answered: new Set(), open: () => {}, startAll: async () => {}, dismiss: () => {}, setProjects: async () => {}, reply: async () => {}, undo: async () => "undone", name: "Chief" };
const stamp = (s: number) => new Date(Date.parse("2026-11-06T10:00:00Z") + s * 1000).toISOString();
const user = (id = "user", delivery: "message" | "steer" = "message"): Extract<TranscriptItem, { kind: "user" }> => ({ kind: "user", id, text: delivery === "steer" ? "Keep the example short, please." : "Explain the water cycle and check the example.", delivery, at: stamp(0) });
const say = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, text, streaming: false, at: stamp(20) });
const tool = (id: string, status: ToolItem["status"] = "done"): ToolItem => ({ kind: "tool", id, name: "command", verb: status === "running" ? "Running" : "Ran", subject: `water-check-${id}`, command: "printf 'Clouds form as water cools.'", parts: [{ action: "command", subject: "water check" }], status, startedAt: stamp(2), finishedAt: status === "running" ? null : stamp(8), output: "Clouds form as water cools.\nWATER_CHECK_PASSED", input: {}, result: null, added: null, removed: null, icon: "run" });
const end = (id = "end", outcome: "completed" | "interrupted" = "completed"): TranscriptItem => ({ kind: "turn_end", id, outcome, at: stamp(24), cursor: 24 });
type Case = { id: string; items: TranscriptItem[]; running: boolean; chief?: boolean };
let cases: Case[] = [];
let pictures: Artifact[] = [];
function draw() {
  flushSync(() => root.render(<MemoryRouter><RuntimeContext.Provider value={runtime}><TooltipProvider><ChiefActionsProvider value={chiefActions}>
    <div style={{ display: "grid", gridTemplateColumns: cases.length > 1 ? "repeat(3,minmax(0,1fr))" : "minmax(0,760px)", gap: 16, justifyContent: "center" }}>
      {cases.map((c) => <section key={c.id} data-case={c.id} className="flex flex-col rounded-xl border border-border bg-background" style={{ height: cases.length > 1 ? 390 : 940 }}>
        <div className="border-b border-border px-5 py-3 text-[13px] text-muted-foreground">{c.chief ? "Chief · Water" : c.id === "gallery" ? "Water cycle · Claude Agent" : c.id}</div>
        <Conversation contentClassName="px-6 py-5"><Transcript sessionId={c.id} items={c.items} artifacts={c.id === "pictures" ? pictures : []} engine="claude-agent" engineLabel="Claude Agent" engineIsCaveman={false} running={c.running} onAnswer={() => {}} cavemanVersion={null}
          {...(c.chief ? { workedLines: true, toolCards: (tools: ReadonlyArray<ToolItem>) => tools.every(isChiefTool) ? <ChiefToolCards tools={tools} /> : null, keepCards: (tools: ReadonlyArray<ToolItem>) => tools.every(isChiefTool) && chiefCards(tools).some((card) => card.kind === "ask" || card.kind === "suggested") } : {})}
        /></Conversation>
      </section>)}
    </div>
  </ChiefActionsProvider></TooltipProvider></RuntimeContext.Provider></MemoryRouter>));
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const area = (id: string) => host.querySelector<HTMLElement>(`[data-case="${id}"]`)!;
const row = (id: string, rowId: string) => area(id).querySelector<HTMLElement>(`[data-row="${rowId}"]`);
const trigger = (id: string) => area(id).querySelector<HTMLButtonElement>('[data-slot="trace-collapsible-trigger"]')!;
const folded = (id: string) => area(id).querySelector('[data-row-kind="fold"]') !== null;
// The steps close in place (the disclosure's motion), then the fold takes their place.
const settled = () => delay(DISCLOSURE_MS + 400);
async function run() {
  const checks: Record<string, boolean> = {};
  // The layout checks watch the steps; whether they show is the person's choice (live-steps.ts), checked at the end.
  setLiveSteps(true);
  // History to scroll back through: a long earlier turn, there from the first draw (so it never streams in).
  const before = (id: string): TranscriptItem[] => (id === "history" ? [user("older"), say("older-answer", "Checking the example.\n\n".repeat(28)), end("older-end")] : []);
  cases = ["settle", "manual", "selection", "history", "focus", "approval", "pictures"].map((id) => ({ id, items: [...before(id), user(), tool("first", "running")], running: true }));
  draw();
  await delay(180);
  checks.singleOutputStartsClosed = trigger("manual").getAttribute("aria-expanded") === "false";
  trigger("manual").click();
  await delay(220);
  for (const c of cases) c.items = [...before(c.id), user(), tool("first"), tool("second", "running")];
  draw();
  await delay(220);
  checks.manyCallsStartCollapsed = area("settle").querySelector('[data-work-disclosure] > button')?.getAttribute("aria-expanded") === "false";
  checks.currentActivityNamed = area("settle").textContent?.includes("Running water-check-second") ?? false;
  // C (2026-11-09): the run's line says what it has done, the step running now has a line of its own under it.
  checks.currentStepHasItsOwnLine =
    (area("settle").querySelector('[data-work-disclosure] > button')?.textContent?.includes("Ran water-check-first") ?? false) &&
    (area("settle").querySelector(".rolling")?.textContent?.includes("Running water-check-second") ?? false);
  checks.openOutputSurvivesOneToMany = trigger("manual").getAttribute("aria-expanded") === "true" && area("manual").querySelector('[data-work-disclosure] > button')?.getAttribute("aria-expanded") === "true";
  // What holds a turn's steps open as it ends happens while it runs: text selected in a step, the reader scrolled back
  // from the end, a keyboard's focus on a step (focus-visible).
  const range = document.createRange();
  range.selectNodeContents(row("selection", "first")!);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const history = area("history").querySelector<HTMLElement>('[data-slot="conversation-viewport"]')!;
  history.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
  // A little way back, off the end, with the turn's work still in view. (Work wholly out of view folds anyway,
  // without moving what is read.)
  history.scrollTop = history.scrollHeight - history.clientHeight - 40;
  history.dispatchEvent(new Event("scroll", { bubbles: true }));
  area("focus").querySelector<HTMLButtonElement>('[data-work-disclosure] > button')!.focus({ preventScroll: true });
  await delay(100);
  for (const c of cases) {
    // The history case's turn leaves its progress line out, to fit its view whole: its work stays in view.
    c.items = [...before(c.id), user(), tool("first"), tool("second"), ...(c.id === "history" ? [] : [say("progress", "Checking the example.")]), say("answer", "Water evaporates, condenses into clouds, then falls as rain. FINAL_ANSWER"), end()];
    c.running = false;
  }
  cases.find((c) => c.id === "approval")!.items.splice(-2, 0, { kind: "ask", id: "ask", askKind: "approval", prompt: "Allow the water check?", options: [], resolution: null, questions: [], round: null, answers: null });
  // A picture the progress reply showed stays in view once it folds.
  const shot = (id: string, itemId: string): Artifact => ({ id, itemId, title: "water.png", meta: "", kind: "image", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", alt: "water", line: null });
  pictures = [shot("progress-shot", "progress")];
  draw();
  await delay(60);
  // The end closes the steps in place at once, before the fold takes their place.
  checks.settlingStartsAtOnce = !folded("settle") && area("settle").querySelector("[data-step-row][data-shut]") !== null;
  await settled();
  checks.completedWorkSettles = folded("settle");
  checks.finalAnswerStaysVisible = row("settle", "answer")?.textContent?.includes("FINAL_ANSWER") ?? false;
  // The turn is the message, its line and the answer: the progress reply folds with the steps.
  checks.progressFoldsWithWork = row("settle", "progress") === null;
  checks.foldedPicturesStayInView = folded("pictures") && area("pictures").querySelectorAll('[data-row-kind="fold"] img').length === 1;
  // Opened, the fold shows the reply it holds without its picture again: that stays once, under the line.
  area("pictures").querySelector<HTMLButtonElement>('[data-row-kind="fold"] button[aria-expanded]')!.click();
  await delay(300);
  checks.openedFoldShowsPicturesOnce = area("pictures").querySelector('[data-row-kind="fold"] [data-find-id="progress"]') !== null && area("pictures").querySelectorAll('[data-row-kind="fold"] img').length === 1;
  checks.manualDetailProtectsWork = !folded("manual") && trigger("manual").getAttribute("aria-expanded") === "true";
  checks.selectionProtectsWork = !folded("selection");
  checks.historyScrollingProtectsWork = !folded("history") && history.scrollTop > 0;
  checks.keyboardFocusProtectsWork = !folded("focus");
  checks.pendingApprovalStaysVisible = row("approval", "ask") !== null && area("approval").textContent!.includes("Allow the water check?");
  window.getSelection()!.removeAllRanges();
  (document.activeElement as HTMLElement)?.blur();
  await settled();
  checks.clearingSelectionAllowsSettle = folded("selection");
  checks.leavingFocusAllowsSettle = folded("focus");
  checks.explicitOpeningStillKept = !folded("manual");

  const chiefAsk = { ...tool("chief-ask"), name: "ask", input: { question: "Which water example should we keep?", options: ["Rain", "Snow"] } };
  cases = [{ id: "steering", running: false, items: [user(), tool("first"), say("progress", "I will check the example."), user("steer", "steer"), tool("second"), say("answer", "A shorter example. FINAL_ANSWER"), end(), user("next"), say("next-answer", "The next answer."), end("next-end")] },
    { id: "interrupted", running: false, items: [user(), tool("first"), end("stop", "interrupted")] },
    { id: "chief", chief: true, running: false, items: [user(), { ...tool("chief-digest"), name: "chat_digest" }, say("progress", "I checked the water project."), chiefAsk, say("answer", "The example is ready. FINAL_ANSWER"), end()] }];
  draw();
  await delay(250);
  checks.steeringStaysInTurn = row("steering", "steer")?.dataset.steering === "true" && area("steering").textContent!.includes("You added · this turn");
  checks.newTurnHasBreathingRoom = parseFloat(getComputedStyle(row("steering", "next")!).paddingTop) === 32;
  checks.interruptionStaysVisible = area("interrupted").textContent!.includes("Stopped");
  checks.chiefToolsFoldWordsStay = folded("chief") && row("chief", "progress") !== null;
  checks.steeringFoldsEachPart = row("steering", "progress") !== null && row("steering", "answer") !== null && area("steering").querySelectorAll('[data-row-kind="fold"]').length >= 2;
  checks.chiefQuestionStaysVisible = area("chief").textContent!.includes("Which water example should we keep?");

  // Steps hidden (the default): the turn is its line, its words and the step running now, named at its live end. Opening
  // them grows the steps under the line, which stays where it was clicked while they open (Conversation's hold).
  setLiveSteps(false);
  cases = [{ id: "hidden", running: true, items: [...before("history"), user(), tool("first"), tool("second", "running")] }];
  draw();
  await delay(400);
  const hidden = area("hidden");
  checks.hiddenStepsTakeNoRoom = hidden.querySelector("[data-work-disclosure]") === null;
  // Calmer (2026-11-09): the kind of work, no shell; its line one block with the working line, 8px under it, its mark
  // under the engine's mark and its words under the line's.
  checks.liveEndNamesTheStep = hidden.querySelector("[data-live-end]")?.textContent?.includes("Running a command") ?? false;
  {
    const head = hidden.querySelector<HTMLElement>('[role="status"] button')!;
    const mark = head.querySelector("svg, img")!.getBoundingClientRect();
    const words = [...head.querySelectorAll("span")].find((s) => s.children.length === 0 && /working/.test(s.textContent ?? ""))?.getBoundingClientRect();
    const live = hidden.querySelector<HTMLElement>("[data-live-end] .rolling > div:last-child > span")!;
    const icon = live.firstElementChild!.getBoundingClientRect();
    const said = live.lastElementChild!.firstElementChild!.getBoundingClientRect();
    const gap = said.top - head.getBoundingClientRect().bottom;
    checks.stepLineUnderWorkingLine = Math.abs(icon.left - mark.left) < 1 && words != null && Math.abs(said.left - words.left) < 1 && gap >= 6 && gap <= 10;
  }
  {
    // Find in chat stepped to a folded step: that step shows while it is the match, and folds again when the find
    // closes; the person's choice to keep steps folded stands.
    const shown = () => [...hidden.querySelectorAll("[data-step-row]:not([data-shut])")].some((r) => r.textContent?.includes("water-check-first"));
    window.getSelection()!.removeAllRanges();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: mac, ctrlKey: !mac, bubbles: true }));
    await delay(150);
    const input = hidden.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "water-check-first");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(400);
    const revealed = shown();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await delay(400);
    checks.findRevealsFoldedStep = revealed && !shown() && hidden.querySelector("[data-work-disclosure]") === null;
  }
  const line = hidden.querySelector<HTMLButtonElement>('[role="status"] button[aria-expanded]')!;
  const top = line.getBoundingClientRect().top;
  let drift = 0;
  line.click();
  const clicked = performance.now();
  while (performance.now() - clicked < 180) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    drift = Math.max(drift, Math.abs(line.getBoundingClientRect().top - top));
  }
  checks.openingStepsKeepsTheLineStill = drift < 1 && line.getAttribute("aria-expanded") === "true";
  await delay(400);
  checks.openedStepsShowSummaryAndCurrent =
    (hidden.querySelector("[data-work-disclosure] > button")?.textContent?.includes("Ran water-check-first") ?? false) &&
    (hidden.querySelector(".rolling")?.textContent?.includes("Running water-check-second") ?? false);
  {
    // The person opened a step's output, then hid the steps: hiding them closed it, so the turn folds the moment it
    // ends. (Find above opened the run to show its match.)
    const buttons = () => [...hidden.querySelectorAll<HTMLButtonElement>("[data-work-disclosure] > button")];
    if (buttons()[0]?.getAttribute("aria-expanded") !== "true") buttons()[0]?.click();
    await delay(250);
    buttons()[1]?.click();
    await delay(250);
    const opened = buttons()[1]?.getAttribute("aria-expanded") === "true";
    hidden.querySelector<HTMLButtonElement>('[role="status"] button[aria-expanded]')!.click();
    await delay(400);
    cases[0]!.items = [...before("history"), user(), tool("first"), tool("second"), say("answer", "Water evaporates, condenses, then falls. FINAL_ANSWER"), end()];
    cases[0]!.running = false;
    draw();
    await delay(250);
    checks.hiddenStepsFoldWhenTurnEnds = opened && folded("hidden");
  }
  {
    // A hidden step's picture still shows, and the live end sits under it, not over it.
    const picture: ToolItem = { ...tool("picture", "running"), name: "image_generation", parts: [{ action: "image_generation", subject: "" }] };
    cases = [{ id: "pictures", running: true, items: [user(), tool("first"), picture] }];
    draw();
    await delay(400);
    const step = area("pictures").querySelector("[data-image-generation]")?.closest("[data-row]")?.getBoundingClientRect();
    const live = area("pictures").querySelector("[data-live-end]")?.getBoundingClientRect();
    checks.liveEndUnderHiddenPictures = step != null && live != null && live.top >= step.bottom;
  }
  setLiveSteps(true);
  const report = { passed: Object.values(checks).every(Boolean), checks };
  result.textContent = JSON.stringify(report, null, 2);
  document.documentElement.dataset.result = report.passed ? "passed" : "failed";
}
function gallery() {
  cases = [{ id: "gallery", running: false, items: [user(), tool("read"), say("opening", "I will read the example, then check it."), tool("tests"), user("steer", "steer"), tool("short"), say("answer", "## The water cycle\n\nWater moves through three stages:\n\n1. **Evaporation.** Sunlight warms water, turning it into vapor.\n2. **Condensation.** Vapor cools and forms clouds.\n3. **Precipitation.** Water falls as rain or snow.\n\nThe example passes its checks."), end(), { ...user("followup"), text: "And what changes in winter?" }, tool("winter"), say("winter-answer", "Cold air slows evaporation. Water may fall as snow and remain frozen until spring.\n\nThe same cycle continues, with more water stored as ice."), end("winter-end")] }];
  result.textContent = "Neutral multi-turn replay · production Transcript";
  draw();
}
if (location.search.includes("gallery")) gallery();
else void run().catch((error: unknown) => { result.textContent = String(error); document.documentElement.dataset.result = "failed"; });
