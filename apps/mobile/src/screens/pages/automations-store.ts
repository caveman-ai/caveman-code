// What the Automations pages keep while the app runs (keep.ts), and what they do to it: the automations and their
// runs, the agent files and the version Cloud runs of each. Run now, Cancel, Pause and Publish change these, and every
// reader (the list, the opened pages, the sidebar's failed count, Home's tile) sees the change at once. The prototype
// has no runtime, so a run started here works a few seconds and lands, as the scripted board's chats do.
import { haptic } from "../../motion";
import { type AgentFile, type Automation, published, type Run, startingAgents, startingAutomations } from "./automations-model";
import { keep } from "./keep";

/** The automations, kept while the app runs. */
export const automations = keep(() => startingAutomations(Date.now()));
/** The agent files beside them. */
export const agents = keep(() => startingAgents(Date.now()));

/** The timers of the runs Run now started, by run, so Cancel can stop one. */
const finishing = new Map<string, ReturnType<typeof setTimeout>>();

export const change = (id: string, f: (a: Automation) => Automation) => automations.set((all) => all.map((a) => (a.id === id ? f(a) : a)));
const changeRun = (id: string, runId: string, f: (r: Run) => Run) => change(id, (a) => ({ ...a, runs: a.runs.map((r) => (r.id === runId ? f(r) : r)) }));

/** Pause or Resume: paused, nothing starts it; Run now still does. */
export function setEnabled(a: Automation, enabled: boolean) {
  haptic.tap();
  change(a.id, (x) => ({ ...x, enabled }));
}

/**
 * Run now: a run starts at the top of its runs, reads, works a few seconds, and lands (the prototype's stand-in for a
 * real run). Returns its id, so the page can open it.
 */
export function runNow(a: Automation): string {
  haptic.thud();
  const id = `run-${Date.now()}`;
  const started = Date.now();
  const run: Run = {
    id,
    status: "running",
    who: "By hand",
    startedAt: started,
    model: a.model === "Auto" ? "Opus 5.5" : a.model,
    steps: [{ tool: "read", text: "Read the automation file", detail: a.path }],
    live: "Reading what changed since the last run",
    title: "Checking what changed",
  };
  change(a.id, (x) => ({ ...x, runs: [run, ...x.runs] }));
  // Halfway, it moves on to its second step, so a watched run reads as work going on.
  finishing.set(
    `${id}:step`,
    setTimeout(() => {
      finishing.delete(`${id}:step`);
      changeRun(a.id, id, (r) => (r.status === "running" ? { ...r, steps: [...r.steps, { tool: "search", text: "Searched what changed since the last run", detail: "nothing new" }], live: "Writing what it found" } : r));
    }, 2800),
  );
  finishing.set(
    id,
    setTimeout(() => {
      finishing.delete(id);
      haptic.done();
      changeRun(a.id, id, (r) =>
        r.status === "running" ? { ...r, status: "succeeded", took: Date.now() - started, live: undefined, title: "Nothing new since the last run", summary: "Done. Nothing new needed your attention since the last run." } : r,
      );
    }, 6000),
  );
  return id;
}

/** Cancel run: its steps stop where they are; what it did stays, and its line says what it was doing ("Stopped reviewing #479"). */
export function cancelRun(a: Automation, run: Run) {
  for (const key of [run.id, `${run.id}:step`]) {
    clearTimeout(finishing.get(key));
    finishing.delete(key);
  }
  const title = run.title ? `Stopped ${run.title.charAt(0).toLowerCase()}${run.title.slice(1)}` : "Cancelled by you";
  changeRun(a.id, run.id, (r) => ({ ...r, status: "cancelled", took: Date.now() - r.startedAt, live: undefined, title }));
}

/** Publish: Cloud gets the file as it is here and runs it as the next version. Lands after a moment, as a send does. */
export function publish(f: AgentFile, done: (f: AgentFile) => void) {
  haptic.tap();
  setTimeout(() => {
    haptic.done();
    let made = f;
    agents.set((all) => all.map((x) => (x.name === f.name && x.project === f.project ? (made = published(x)) : x)));
    done(made);
  }, 1400);
}
