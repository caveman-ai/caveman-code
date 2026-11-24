// What the opened automation and agent pages say, off the screen: a run's one line (its title, its live words, the one
// thing wrong, else its first sentence), which run shows open, the status line's rest, what starts it, the version
// Cloud runs and what Publish would make, and an agent's activity, gathered from the automations that run it and the
// chats that used it, newest first.
import { describe, expect, it } from "vitest";
import { activityOf, cloudOf, openRunOf, published, type Run, runHeadline, startingAgents, startingAutomations, statusOf, statusRest, triggerKind } from "./automations-model";

const NOW = new Date(2026, 10, 7, 12, 0).getTime();
const run = (over: Partial<Run>): Run => ({ id: "r", status: "succeeded", who: "On schedule", startedAt: NOW, model: "Opus 5.5", steps: [], ...over });

describe("runHeadline", () => {
  it("leads with the run's own title, running or done", () => {
    expect(runHeadline(run({ status: "running", title: "Reviewing #479", live: "Reading archived.ts" }))).toBe("Reviewing #479");
    expect(runHeadline(run({ title: "Reviewed #476", summary: "Left a review on #476." }))).toBe("Reviewed #476");
  });

  it("says its live words while it runs without a title", () => {
    expect(runHeadline(run({ status: "running", live: "Reading archived.ts" }))).toBe("Reading archived.ts");
    expect(runHeadline(run({ status: "queued" }))).toBe("Queued");
  });

  it("says the one thing wrong when it failed", () => {
    expect(runHeadline(run({ status: "failed", why: { reason: "The command failed", words: "pnpm install exited 1" } }))).toBe("pnpm install exited 1");
    expect(runHeadline(run({ status: "failed", why: { reason: "The command failed" } }))).toBe("The command failed");
    expect(runHeadline(run({ status: "failed" }))).toBe("Failed");
  });

  it("takes the first sentence of its closing words, as plain words", () => {
    expect(runHeadline(run({ summary: "Quiet night: one merge, nothing waits on you." }))).toBe("Quiet night: one merge, nothing waits on you");
    expect(runHeadline(run({ summary: "Three merges, and the relay test flaked twice. Nothing else." }))).toBe("Three merges, and the relay test flaked twice");
    expect(runHeadline(run({ summary: "**2 merged** and `main` is green\n\nMore below." }))).toBe("2 merged and main is green");
    expect(runHeadline(run({ summary: "Good morning. Overnight:" }))).toBe("Good morning");
  });

  it("falls back on how it went", () => {
    expect(runHeadline(run({}))).toBe("Worked");
    expect(runHeadline(run({ status: "cancelled" }))).toBe("Cancelled");
  });
});

describe("openRunOf", () => {
  const runs = [run({ id: "a" }), run({ id: "b" })];

  it("opens the newest until you pick one", () => {
    expect(openRunOf(runs, undefined)).toBe("a");
    expect(openRunOf([], undefined)).toBeNull();
  });

  it("keeps the one you picked while it is there, else the newest", () => {
    expect(openRunOf(runs, "b")).toBe("b");
    expect(openRunOf(runs, "gone")).toBe("a");
  });

  it("stays folded once you fold it", () => {
    expect(openRunOf(runs, null)).toBeNull();
  });
});

describe("statusRest", () => {
  const all = startingAutomations(NOW);
  const of = (id: string) => all.find((a) => a.id === id)!;
  const when = () => "Mon 9:00 AM";

  it("says when a schedule runs next", () => {
    expect(statusRest(of("dependency-check"), when)).toBe("Next run Mon 9:00 AM");
  });

  it("says what starts one an event starts", () => {
    expect(statusRest(of("pr-review"), when)).toBe("Pull request opened or updated");
  });

  it("says Run now still works once paused, and that its triggers wait when they're off", () => {
    expect(statusRest(of("flaky-watch"), when)).toBe("Run now still works");
    expect(statusRest(of("release-notes"), when)).toBe("Its triggers wait");
  });
});

describe("statusOf", () => {
  const all = startingAutomations(NOW);
  const of = (id: string) => all.find((a) => a.id === id)!;

  it("says Active, Paused, or why its triggers are off", () => {
    expect(statusOf(of("morning-summary"))).toEqual({ word: "Active", tone: "success" });
    expect(statusOf(of("flaky-watch"))).toEqual({ word: "Paused", tone: "muted" });
    expect(statusOf(of("release-notes"))).toMatchObject({ word: "Not on main", tone: "warning" });
  });

  it("says its newest run failed, in red, rather than a green Active", () => {
    expect(statusOf(of("dependency-check"))).toEqual({ word: "Last run failed", tone: "destructive" });
    const paused = { ...of("dependency-check"), enabled: false };
    expect(statusOf(paused).word).toBe("Paused");
  });
});

describe("triggerKind", () => {
  it("tells GitHub's events, schedules and by hand apart", () => {
    expect(triggerKind("Pull request opened or updated")).toBe("github");
    expect(triggerKind("On new issues")).toBe("github");
    expect(triggerKind("Every night at 2:00 AM")).toBe("schedule");
    expect(triggerKind("Weekdays at 8:30 AM")).toBe("schedule");
    expect(triggerKind("By hand only")).toBe("manual");
    expect(triggerKind("When CI fails twice")).toBe("event");
  });
});

describe("cloudOf and published", () => {
  const [reviewer, triage, writer] = startingAgents(NOW);

  it("names the version Cloud runs and what Publish would make", () => {
    expect(cloudOf(reviewer!)).toEqual({ label: "v3", tone: "same", action: null });
    expect(cloudOf(triage!)).toEqual({ label: "v1, changed here", tone: "changed", action: "Publish v2" });
    expect(cloudOf(writer!)).toEqual({ label: "Not published", tone: "none", action: "Publish" });
  });

  it("makes the next version, the same as the file here", () => {
    expect(cloudOf(published(triage!))).toEqual({ label: "v2", tone: "same", action: null });
    expect(cloudOf(published(writer!))).toEqual({ label: "v1", tone: "same", action: null });
  });
});

describe("activityOf", () => {
  const all = startingAutomations(NOW);
  const [reviewer, triage, writer] = startingAgents(NOW);

  it("gathers the runs of the automations that run it and the chats that used it, newest first", () => {
    const seen = activityOf(reviewer!, all);
    expect(seen.map((x) => x.title)).toEqual(["Reviewing #479", "Reviewed #476", "Approved #471", "Second look at #468"]);
    expect(seen[0]).toMatchObject({ status: "running", via: "Review new pull requests", automation: "pr-review" });
    expect(seen[3]).toMatchObject({ via: "adm-zip under onnxruntime" });
    expect(seen[3]!.automation).toBeUndefined();
  });

  it("takes only its own project's automations", () => {
    const elsewhere = all.map((a) => (a.id === "pr-review" ? { ...a, project: "Caveman Cloud" } : a));
    expect(activityOf(reviewer!, elsewhere).map((x) => x.id)).toEqual(["c-rv-1"]);
  });

  it("is empty for an agent nothing has used", () => {
    expect(activityOf(writer!, all)).toEqual([]);
    expect(activityOf(triage!, all)).toHaveLength(3);
  });
});
