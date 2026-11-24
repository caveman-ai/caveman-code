import { describe, expect, it } from "vitest";
import { BLANK_DRAFT, blankText, daysWord, draftText, endsWord, everyWord, githubWord, modelWord, nextAt, presetOf, presetSchedule, readForm, scheduleAs, scheduleKindOf, scheduleWord, setBudget, setDescription, setGitHub, setHost, setPrompt, setSchedule, setStepKey, setWebhook, whenWord, type Form, type NewDraft, type Schedule } from "./draft.ts";

const DIGEST = `# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json
version: 1
description: Weekday mornings, a short digest of what changed in this repo since the last working day

on:
  schedule: { at: "09:00", timezone: Europe/Amsterdam, weekdays: [mon, tue, wed, thu, fri] }   # your time zone

budget: $0.50

steps:
  digest:
    prompt: >-
      Summarise what changed in this repository since the start of the last working day.
      Lead with anything that needs me today.
    model: fast
`;

const PIPELINE = `version: 1
description: Issues labelled caveman become draft pull requests
on:
  github:
    event: issues.labeled
    label: caveman
steps:
  triage:
    agent: issue-triage
    model: fast
  implement:
    if: { triage: implement }
    agent: builder
    computer: full
    checks: [pnpm test, { agent: reviewer }]
    retries: 2
outputs:
  github.pull_request: { from: implement, draft: true }
`;

const form = (text: string): Form => {
  const r = readForm(text);
  if ("error" in r) throw new Error(r.error);
  return r.form;
};

describe("reading a file as the form", () => {
  it("a one-step file: its schedule, budget, prompt and model", () => {
    const f = form(DIGEST);
    expect(f.description).toMatch(/^Weekday mornings/);
    expect(f.budget).toBe("$0.50");
    expect(f.triggers).toEqual([{ kind: "schedule", schedule: { at: "09:00", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] } }]);
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]).toMatchObject({ name: "digest", kind: "prompt", model: "fast" });
    expect(f.steps[0]!.prompt).toMatch(/^Summarise .* working day\. Lead with/);
  });

  it("a pipeline: agent steps, their condition, checks and outputs", () => {
    const f = form(PIPELINE);
    expect(f.triggers).toEqual([{ kind: "github", github: { events: ["issues.labeled"], labels: ["caveman"], mention: false } }]);
    expect(f.steps.map((s) => s.kind)).toEqual(["agent", "agent"]);
    expect(f.steps[1]).toMatchObject({ agent: "builder", computer: "full", retries: 2, when: "triage decided implement", checks: ["pnpm test", "agent:reviewer"] });
    expect(f.outputs).toEqual(["github.pull_request"]);
  });

  it("text that does not parse says why", () => {
    expect(readForm("steps:\n  a: [\n")).toHaveProperty("error");
  });

  // yaml reports no error for these, then throws building the values: the Settings form and the page read them as they draw.
  it("an unquoted glob (an alias with no anchor) says why instead of throwing", () => {
    expect(readForm("steps:\n  lint:\n    prompt: Lint the changed files.\n    paths: *.ts\n")).toEqual({ error: expect.stringContaining(".ts") });
    expect(readForm("steps:\n  docs:\n    prompt: Check the docs.\n    paths:\n      - *.md\n")).toEqual({ error: expect.stringContaining(".md") });
  });

  it("aliases that repeat a value past yaml's cap say why instead of throwing", () => {
    const rows = ["a: &a [x, x, x, x, x, x, x, x, x, x]", "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]", "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]", "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]"];
    expect(readForm(`${rows.join("\n")}\nsteps:\n  a:\n    prompt: hi\n`)).toHaveProperty("error");
  });
});

describe("editing keeps what the form does not show", () => {
  it("a new time keeps the comment, the quotes and the rest of the line", () => {
    const out = setSchedule(DIGEST, { at: "10:30", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] });
    expect(out).toContain('schedule: { at: "10:30", timezone: Europe/Amsterdam, weekdays: [mon, tue, wed, thu, fri] }   # your time zone');
    expect(out).toContain("# your time zone");
    expect(out).toContain("budget: $0.50");
    expect(form(out).steps[0]!.prompt).toBe(form(DIGEST).steps[0]!.prompt);
  });

  it("everything the edit does not touch stays byte for byte", () => {
    expect(setBudget(DIGEST, "1")).toBe(DIGEST.replace("budget: $0.50", "budget: $1"));
    expect(setStepKey(DIGEST, "digest", "model", "base")).toBe(DIGEST.replace("model: fast", "model: base"));
    expect(setStepKey(DIGEST, "digest", "effort", "high")).toBe(DIGEST.replace("    model: fast\n", "    model: fast\n    effort: high\n"));
    expect(setBudget(DIGEST, "")).toBe(DIGEST.replace("budget: $0.50\n\n", ""));
  });

  it("a folded prompt edited in one paragraph stays folded", () => {
    const out = setPrompt(DIGEST, "digest", "Summarise what changed since Friday.");
    expect(out).toContain("    prompt: >-\n      Summarise what changed since Friday.\n    model: fast");
  });

  it("every day drops weekdays; an interval drops at and the zone", () => {
    expect(setSchedule(DIGEST, { at: "09:00", timezone: "Europe/Amsterdam", weekdays: [] })).not.toContain("weekdays");
    const every = form(setSchedule(DIGEST, { every: "2h" })).triggers[0];
    expect(every).toEqual({ kind: "schedule", schedule: { every: "2h" } });
  });

  it("removing the last trigger removes on:", () => {
    const out = setSchedule(DIGEST, null);
    expect(out).not.toMatch(/^on:/m);
    expect(form(out).triggers).toEqual([]);
  });

  it("a trigger added to a file with none lands above steps:", () => {
    const bare = "version: 1\nsteps:\n  work:\n    prompt: hi\n";
    const out = setWebhook(bare, true);
    expect(out.indexOf("on:")).toBeLessThan(out.indexOf("steps:"));
    expect(form(out).triggers).toEqual([{ kind: "webhook" }]);
    expect(form(setWebhook(out, false)).triggers).toEqual([]);
  });

  it("GitHub: one event bare, more as a list; a label; a mention only on comments", () => {
    const one = setGitHub(PIPELINE, { events: ["issues.labeled"], labels: ["bug", "caveman"], mention: true });
    expect(form(one).triggers[0]).toEqual({ kind: "github", github: { events: ["issues.labeled"], labels: ["bug", "caveman"], mention: false } });
    const two = setGitHub(PIPELINE, { events: ["issue_comment.created", "issues.opened"], labels: [], mention: true });
    expect(form(two).triggers[0]).toEqual({ kind: "github", github: { events: ["issue_comment.created", "issues.opened"], labels: [], mention: true } });
    expect(two).not.toContain("label:");
  });

  it("a prompt with line breaks becomes a literal block and reads back exactly", () => {
    const text = "Review recent commits.\n\nFocus on:\n- data loss\n- silent failures";
    const out = setPrompt(DIGEST, "digest", text);
    expect(out).toContain("prompt: |-");
    expect(form(out).steps[0]!.prompt).toBe(text);
    expect(form(setPrompt(out, "digest", "One line.")).steps[0]!.prompt).toBe("One line.");
  });

  it("model, effort, computer and retries set and clear", () => {
    let out = setStepKey(DIGEST, "digest", "model", "frontier");
    out = setStepKey(out, "digest", "effort", "high");
    out = setStepKey(out, "digest", "computer", "full");
    expect(form(out).steps[0]).toMatchObject({ model: "frontier", effort: "high", computer: "full" });
    expect(form(setStepKey(out, "digest", "effort", undefined)).steps[0]!.effort).toBeUndefined();
  });

  it("budget, description and host", () => {
    expect(form(setBudget(DIGEST, "6")).budget).toBe("$6");
    expect(form(setBudget(DIGEST, "")).budget).toBeUndefined();
    expect(form(setDescription(DIGEST, "Mornings\nonly")).description).toBe("Mornings only");
    const cloud = setHost(DIGEST, "cloud");
    expect(form(cloud).host).toBe("cloud");
    expect(cloud.indexOf("host:")).toBeLessThan(cloud.indexOf("description:"));
    expect(form(setHost(cloud, "this-mac")).host).toBe("this-mac");
  });

  it("text that does not parse is never rewritten", () => {
    const broken = "steps:\n  a: [\n";
    expect(setBudget(broken, "5")).toBe(broken);
  });
});

describe("hand-written shapes the templates don't use", () => {
  const BLOCKY = `on:
  schedule:
    at: "09:00"
    timezone: Europe/Amsterdam
  github:
    event: issues.labeled
    label:
      - bug
      - caveman
    mention: false
budget: { usd: 6, turns: 40 }
steps:
  work:
    model: fast
  review: { prompt: Review it, checks: [pnpm test, { agent: reviewer }], escalate: [{ model: frontier }] }
`;

  it("a block-style schedule changes key by key and the file still reads", () => {
    const out = setSchedule(BLOCKY, { at: "10:30", timezone: "Europe/Amsterdam" });
    expect(form(out).triggers[0]).toEqual({ kind: "schedule", schedule: { at: "10:30", timezone: "Europe/Amsterdam" } });
    expect(out).toContain('    at: "10:30"\n    timezone: Europe/Amsterdam\n  github:');
  });

  it("a block list of labels is replaced on its key's line, the next key untouched", () => {
    const out = setGitHub(BLOCKY, { events: ["issues.labeled"], labels: ["bug"], mention: false });
    expect(out).toContain("    label: bug\n    mention: false\n");
    expect(form(out).triggers[1]).toEqual({ kind: "github", github: { events: ["issues.labeled"], labels: ["bug"], mention: false } });
    expect(form(setGitHub(BLOCKY, { events: ["issues.labeled", "issues.opened"], labels: ["a", "b"], mention: false })).triggers[1]).toEqual({
      kind: "github",
      github: { events: ["issues.labeled", "issues.opened"], labels: ["a", "b"], mention: false },
    });
  });

  it("a key left empty takes a value under it, not beside it", () => {
    const emptied = setStepKey(BLOCKY, "work", "model", undefined);
    expect(emptied).toContain("  work:\n  review:");
    const out = setPrompt(emptied, "work", "R");
    expect(form(out).steps[0]).toMatchObject({ name: "work", prompt: "R" });
    const on = setSchedule(setGitHub(setSchedule(BLOCKY, null), null), null);
    expect(form(setSchedule("on:\nsteps:\n  a: { prompt: x }\n", { every: "2h" })).triggers).toEqual([{ kind: "schedule", schedule: { every: "2h" } }]);
    expect(form(on).triggers).toEqual([]);
  });

  it("a flow step keeps its agent check and escalation when its model changes", () => {
    const out = setStepKey(BLOCKY, "review", "model", "base");
    expect(form(out).steps[1]).toMatchObject({ model: "base", checks: ["pnpm test", "agent:reviewer"] });
    expect(out).toContain("escalate: [{ model: frontier }]");
  });

  it("a budget map keeps its other limits", () => {
    expect(setBudget(BLOCKY, "7")).toContain("budget: { usd: 7, turns: 40 }");
    expect(setBudget(BLOCKY, "")).toContain("budget: { turns: 40 }");
  });

  it("a file with no map at the top: an error, and edits leave it alone", () => {
    for (const t of ["", "# only a comment\n", "hello\n", "- a\n"]) {
      expect(readForm(t)).toHaveProperty("error");
      expect(setBudget(t, "5")).toBe(t);
      expect(setWebhook(t, true)).toBe(t);
    }
  });

  it("CRLF stays CRLF", () => {
    const crlf = DIGEST.replace(/\n/g, "\r\n");
    const out = setBudget(crlf, "");
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).not.toContain("\r\n\r\n\r\n");
    expect(form(out).budget).toBeUndefined();
  });
});

describe("prompts read back exactly as typed", () => {
  const STEP = "steps:\n  work:\n    prompt: |\n      Look at it.\n    model: fast\n";
  const typed = (text: string, value: string) => form(setPrompt(text, "work", value)).steps[0]!.prompt;

  it("a newline typed at the end stays, and Enter never piles up blank lines", () => {
    let text = STEP;
    for (const v of ["Review", "Review\n", "Review\n\n", "Review\n\nNext"]) {
      text = setPrompt(text, "work", v);
      expect(form(text).steps[0]!.prompt).toBe(v);
    }
    expect(text).toContain("    prompt: |-\n      Review\n\n      Next\n    model: fast\n");
  });

  it("a | prompt edited in place keeps its last newline", () => {
    expect(typed(STEP, "Look at it again.\n")).toBe("Look at it again.\n");
  });

  it("text starting with spaces, a blank first line, #, quotes and colons", () => {
    for (const v of ["  indented\nnext", "\n  x", "# not a comment\nok", 'say "hi": now', "   ", "a\n\n\n"]) expect(typed(STEP, v)).toBe(v);
  });

  it("a folded prompt keeps long words and double spaces", () => {
    const url = `See https://example.com/${"a".repeat(100)} then  check it`;
    expect(form(setPrompt(DIGEST, "digest", url)).steps[0]!.prompt).toBe(url);
  });
});

describe("a new file", () => {
  it("starts as a weekday schedule in this zone and one auto prompt step", () => {
    const f = form(blankText("Europe/Amsterdam"));
    expect(f.triggers).toEqual([{ kind: "schedule", schedule: { at: "09:00", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] } }]);
    expect(f.steps).toEqual([{ name: "work", kind: "prompt", prompt: "", model: "auto", checks: [] }]);
  });
});

describe("words", () => {
  it("days, intervals, GitHub and models", () => {
    expect(daysWord(["mon", "tue", "wed", "thu", "fri"])).toBe("Every weekday");
    expect(daysWord(undefined)).toBe("Every day");
    expect(daysWord(["sun", "sat"])).toBe("Weekends");
    expect(daysWord(["wed", "mon"])).toBe("Mon, Wed");
    expect(daysWord(["mon"])).toBe("Mondays");
    expect(everyWord("30m")).toBe("Every 30 minutes");
    expect(everyWord("1h")).toBe("Every hour");
    expect(githubWord({ events: ["issues.labeled"], labels: ["caveman"], mention: false })).toBe("An issue is labelled caveman");
    expect(githubWord({ events: ["issue_comment.created", "push"], labels: [], mention: true })).toBe("Someone comments mentioning @caveman (+1)");
    expect(modelWord("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(modelWord(undefined)).toBe("Default");
  });

  it("the next run, in this zone only", () => {
    // Friday 2026-10-23 10:00 local: the next weekday 09:00 is Monday.
    const fri = new Date(2026, 9, 23, 10, 0);
    const next = nextAt({ at: "09:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] }, fri, "Europe/Amsterdam");
    expect(next?.getDay()).toBe(1);
    expect(next?.getHours()).toBe(9);
    expect(nextAt({ at: "09:00", timezone: "America/Los_Angeles" }, fri, "Europe/Amsterdam")).toBeNull();
  });
});

describe("schedules beyond days and hours", () => {
  const schedule = (text: string): Schedule => {
    const t = form(text).triggers[0];
    if (t?.kind !== "schedule") throw new Error("no schedule");
    return t.schedule;
  };
  const round = (s: Schedule) => schedule(setSchedule(DIGEST, s));

  it("writes each kind as the file format has it, and reads it back", () => {
    const once = setSchedule(DIGEST, { once: "2026-11-09 09:00", timezone: "Europe/Amsterdam" });
    expect(once).toContain('schedule: { timezone: Europe/Amsterdam, once: "2026-11-09 09:00" }');
    expect(schedule(once)).toEqual({ once: "2026-11-09 09:00", timezone: "Europe/Amsterdam" });
    expect(round({ at: "18:00", timezone: "UTC", monthdays: ["last", 1] })).toEqual({ at: "18:00", timezone: "UTC", monthdays: [1, "last"] });
    expect(round({ cron: "0 9 * * 1-5", timezone: "UTC" })).toEqual({ cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(round({ at: "10:00", timezone: "UTC", weekdays: ["thu", "mon"], every: "2w", start: "2026-11-09" })).toEqual({
      at: "10:00",
      timezone: "UTC",
      weekdays: ["mon", "thu"],
      every: "2w",
      start: "2026-11-09",
    });
    expect(round({ at: "07:00", timezone: "UTC", every: "3d", weekdays: ["mon"], start: "2026-11-09" })).toEqual({ at: "07:00", timezone: "UTC", every: "3d", start: "2026-11-09" });
    expect(round({ every: "6h", until: "2026-12-31", count: 5, timezone: "UTC" })).toEqual({ every: "6h", timezone: "UTC", until: "2026-12-31", count: 5 });
    // An interval with no days to bound names no zone; a once takes no bounds.
    expect(round({ every: "6h", timezone: "UTC" })).toEqual({ every: "6h" });
    expect(round({ once: "2026-11-09 09:00", timezone: "UTC", count: 3, until: "2026-12-01" })).toEqual({ once: "2026-11-09 09:00", timezone: "UTC" });
  });

  it("switches kind keeping the time and zone, and starts a once tomorrow", () => {
    const now = new Date(2026, 10, 5, 12, 0);
    const days = { at: "08:30", timezone: "Europe/Amsterdam", weekdays: ["mon"] } as const;
    expect(scheduleAs("once", days, now)).toEqual({ once: "2026-11-06 08:30", timezone: "Europe/Amsterdam" });
    expect(scheduleAs("monthly", days, now)).toEqual({ at: "08:30", timezone: "Europe/Amsterdam", monthdays: [1] });
    expect(scheduleAs("cron", days, now)).toEqual({ cron: "30 8 * * 1-5", timezone: "Europe/Amsterdam" });
    expect(scheduleKindOf(scheduleAs("interval", days, now))).toBe("interval");
    expect(presetSchedule("once", "09:00", now)).toMatchObject({ once: "2026-11-06 09:00" });
    expect(presetOf(presetSchedule("monthly", "09:00", now))).toBe("monthly");
  });

  it("says each kind in words, and how a repeat ends", () => {
    const clock = (h: number, m: number) => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(scheduleWord({ at: "18:00", monthdays: [1, "last"] })).toBe(`Monthly on the 1st and last day at ${clock(18, 0)}`);
    expect(scheduleWord({ at: "10:00", weekdays: ["mon"], every: "2w" })).toBe(`Every 2 weeks, Mondays at ${clock(10, 0)}`);
    expect(scheduleWord({ at: "07:00", every: "3d" })).toBe(`Every 3 days at ${clock(7, 0)}`);
    expect(scheduleWord({ once: "2026-11-09 09:00" })).toMatch(/^Once, \w+ Nov 9/);
    expect(endsWord({ every: "1h" })).toBe("No end");
    expect(endsWord({ every: "1h", count: 3 })).toBe("After 3 runs");
    expect(endsWord({ every: "1h", until: "2026-12-31" })).toMatch(/^Until \w+ Dec 31/);
  });

  it("works out a once's and a month day's next run in this zone", () => {
    const now = new Date(2027, 0, 31, 10, 0);
    expect(nextAt({ once: "2027-02-03 09:00" }, now, "Europe/Amsterdam")?.getDate()).toBe(3);
    expect(nextAt({ once: "2027-01-03 09:00" }, now, "Europe/Amsterdam")).toBeNull();
    // The 31st skips February; the last day does not.
    expect(nextAt({ at: "09:00", monthdays: [31] }, now, "Europe/Amsterdam")?.getMonth()).toBe(2);
    expect(nextAt({ at: "09:00", monthdays: ["last"] }, now, "Europe/Amsterdam")?.getDate()).toBe(28);
    // A cron, or a repeat with a start, comes from the runtime.
    expect(nextAt({ cron: "0 9 * * *" }, now, "Europe/Amsterdam")).toBeNull();
    expect(nextAt({ at: "09:00", every: "2w", weekdays: ["mon"], start: "2027-01-04" }, now, "Europe/Amsterdam")).toBeNull();
  });
});

describe("New automation's box", () => {
  const draft = (over: Partial<NewDraft> = {}): NewDraft => ({ ...BLANK_DRAFT, title: "Readme check", prompt: "Read the README.\nSay if it is stale.", ...over });

  it("writes the file its choices make, and the file reads back as the form", () => {
    const text = draftText(draft({ model: "fast", when: { kind: "schedule", schedule: { at: "09:00", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] } } }));
    const read = readForm(text);
    if (!("form" in read)) throw new Error(read.error);
    expect(read.form.description).toBe("Readme check");
    expect(read.form.steps).toMatchObject([{ name: "work", kind: "prompt", prompt: "Read the README.\nSay if it is stale.", model: "fast" }]);
    expect(read.form.steps[0]?.computer).toBeUndefined();
    expect(read.form.triggers).toEqual([{ kind: "schedule", schedule: { at: "09:00", timezone: "Europe/Amsterdam", weekdays: ["mon", "tue", "wed", "thu", "fri"] } }]);
  });

  it("an hourly schedule, a GitHub event, or no trigger at all", () => {
    const hourly = readForm(draftText(draft({ when: { kind: "schedule", schedule: { every: "1h" } } })));
    expect("form" in hourly && hourly.form.triggers).toEqual([{ kind: "schedule", schedule: { every: "1h" } }]);
    const mention = readForm(draftText(draft({ when: { kind: "github", event: "mention" }, computer: "full" })));
    expect("form" in mention && mention.form.triggers).toEqual([{ kind: "github", github: { events: ["issue_comment.created"], labels: [], mention: true } }]);
    expect("form" in mention && mention.form.steps[0]?.computer).toBe("full");
    const manual = draftText(draft({ when: { kind: "manual" } }));
    expect(manual).not.toMatch(/^on:/m);
    expect("form" in readForm(manual) && (readForm(manual) as { form: Form }).form.triggers).toEqual([]);
  });

  it("says when it runs as the chip does", () => {
    const clock = (h: number, m: number) => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(whenWord(BLANK_DRAFT.when)).toBe(`Weekdays at ${clock(9, 0)}`);
    expect(whenWord({ kind: "schedule", schedule: { at: "18:30", weekdays: [] } })).toBe(`Daily at ${clock(18, 30)}`);
    expect(whenWord({ kind: "schedule", schedule: { at: "09:00", weekdays: ["wed"] } })).toBe(`Wednesdays at ${clock(9, 0)}`);
    expect(whenWord({ kind: "schedule", schedule: { every: "1h" } })).toBe("Every hour");
    expect(whenWord({ kind: "github", event: "pull_request" })).toBe("On new pull requests");
    expect(whenWord({ kind: "manual" })).toBe("By hand only");
    expect(presetOf({ at: "09:00", weekdays: ["mon"] })).toBe("weekly");
  });
});
