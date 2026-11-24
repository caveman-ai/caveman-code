/**
 * `check`: every automation and agent file in a project, loaded or reported
 * (never skipped silently), then the rules that need more than one file:
 * agents that exist, `if` on real decisions, outputs from real fields,
 * triggers that can fire where the automation runs.
 *
 * @module check
 */
import { closest, diagnostic, didYouMean, hiddenCharacters, quoteList, sha256Hex, type Diagnostic, type SourceFile } from "./diagnostics.ts";
import type { EnvSnapshot } from "./explain.ts";
import { Cron } from "croner";

import {
  CLOUD_GITHUB_EVENTS,
  CLOUD_OUTPUTS,
  CLOUD_TRIGGERS,
  MAX_APPROVAL_MS,
  MAX_WAIT_MS,
  MIN_EVERY_MS,
  NAME_PATTERN,
  NAME_RULE,
  NEWS_DECISION,
  RESERVED_DECISIONS,
  REVIEW_DECISIONS,
  RUN_DEADLINE_MS,
  budgetOf,
  calendarStep,
  civilDate,
  computerOf,
  durationMs,
  eventsOf,
  formatDuration,
  hostOf,
  isClaudeAlias,
  isEngine,
  isGraph,
  outputSource,
  outsiderTriggers,
  writingSteps,
  rungsOf,
  stepKindOf,
  type AutomationFile,
  type GitHubEvent,
  type ScheduleTrigger,
} from "./format.ts";
import { parseAgentSource, parseAutomationSource, type AgentInfo, type YamlSource } from "./parse.ts";

/** Where the automation will run: Caveman Code on This Mac, a CI runner, or Caveman Cloud. */
export type Target = "code" | "ci" | "cloud";
export type Scope = "me" | "project";

export interface LoadedAutomation {
  readonly name: string;
  readonly scope: Scope;
  readonly path: string;
  readonly file: AutomationFile;
  /** sha256 of the file text: the revision a run is pinned to. */
  readonly digest: string;
  readonly text: string;
}

export interface ProjectCheck {
  /** Every automation whose shape parsed. One with an error diagnostic on its path must not run. */
  readonly automations: ReadonlyArray<LoadedAutomation>;
  /** The registry steps resolve against: the files' agents first, then the ones passed in. */
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export const AUTOMATION_DIRS: Readonly<Record<string, Scope>> = {
  ".caveman/automations/": "project",
  ".caveman/local/automations/": "me",
};
export const AGENTS_DIR = ".caveman/agents/";

/** The repo-relative path an automation of this name and scope lives at. */
export const automationPath = (name: string, scope: Scope): string =>
  `${scope === "me" ? ".caveman/local/automations/" : ".caveman/automations/"}${name}.yaml`;

const AT_START = { line: 1, column: 1 };
/** The most names a message lists: a file can hold thousands of steps or decisions. */
const LISTED = 8;
/**
 * How many names one file's typo suggestions compare in all. Each suggestion reads every candidate, so thousands of
 * mistyped names in a file of thousands of steps would otherwise cost their product.
 */
const COMPARED = 10_000;

/** quoteList with at most LISTED values, then "and more". */
const someOf = (values: ReadonlyArray<string>, last = "or"): string =>
  values.length > LISTED ? `${values.slice(0, LISTED).join(", ")} and more` : quoteList(values, last);

const ALIAS_CLASS: Readonly<Record<string, string>> = { haiku: "fast", sonnet: "base", opus: "frontier" };
/** Which events carry each GitHub filter. */
const FILTER_EVENTS: Readonly<Record<string, ReadonlyArray<GitHubEvent>>> = {
  label: ["issues.opened", "issues.labeled", "pull_request.opened", "pull_request.synchronize", "pull_request.labeled", "pull_request.closed"],
  paths: ["pull_request.opened", "pull_request.synchronize", "pull_request.labeled", "pull_request.closed", "push"],
  branches: ["pull_request.opened", "pull_request.synchronize", "pull_request.labeled", "pull_request.closed", "push", "workflow_run.completed", "check_suite.completed"],
  mention: ["issue_comment.created"],
  conclusion: ["workflow_run.completed", "check_suite.completed"],
  merged: ["pull_request.closed"],
};

/** What check needs to know about one `if: { ref: value }` of a graph step whose ref is a step. */
interface IfFacts {
  /** ref is among the step's needs, or theirs: what an `if` in a graph may test (SEMANTICS §1.5). */
  readonly needed: boolean;
  /**
   * For `ref: failed`, when the step can never run: its needs that wait on a step ref's failure skips, at most LISTED +
   * 1 of them, and the skipped steps nearest those needs, in file order.
   */
  readonly blocked?: { readonly skipped: ReadonlyArray<string>; readonly through: ReadonlyArray<string> };
}

interface NeedsGraph {
  /** The steps a `needs` cycle runs through, from the first one a walk in file order meets, or an empty list. */
  readonly cycle: ReadonlyArray<string>;
  /** By step, then by ref: each `if` entry that names a step. */
  readonly ifs: ReadonlyMap<string, ReadonlyMap<string, IfFacts>>;
  /**
   * For a step whose if tests a failure, when it can never run: `through`, at most LISTED + 1 of its needs, run only
   * when `failing` fails (each tests `failing: failed`, or waits on a step that does), and `failing`'s failure skips the
   * step. A failure the step tests itself is left out: that test's own if-failed-never-runs says so.
   */
  readonly conflictOf: (step: string) => { readonly failing: string; readonly through: ReadonlyArray<string> } | undefined;
  /** A step's needs and theirs, each need before its own needs, at most `limit` of them. */
  readonly needsOf: (step: string, limit: number) => ReadonlyArray<string>;
}

/**
 * A graph's needs, worked out for every `if` at once. The runtime checks each project's files on its one event loop
 * every scheduler tick, so no step's full set of needs is built (for a long chain, the square of its length in time and
 * memory). Each pass over the steps answers 32 refs at once, one bit each, in memory the size of the file.
 *
 * A failure handler `if: { ref: failed }` never runs when a step between it and ref (one it needs, directly or not,
 * that needs ref) is skipped by ref's failure. Such a step starts only after ref has ended, so it is skipped
 * `need_failed` unless its if tests a failure (§2.2), and `need_not_succeeded` if it needs ref itself without testing
 * it (§1.3). Either skip carries on down needs to the handler (§1.4). A step whose if tests a decision of ref is
 * skipped by ref's failure too (§1.5). `ifLost` steps had their if rejected: they may have tested a failure, so they
 * are not counted as skipped.
 *
 * A handler also never runs when it waits on a step that tests another step x with `failed`, and x's failure skips it:
 * that step runs only when x fails (§1.3, §1.5), and then the handler is skipped.
 */
function needsGraph(file: AutomationFile, ifLost: (step: string) => boolean): NeedsGraph {
  const names = Object.keys(file.steps);
  const count = names.length;
  const index = new Map(names.map((name, i) => [name, i]));
  // A step that needs itself is reported as needs-unknown-step; here it is left out, as the needs-cycle rule leaves it.
  const needs = names.map((name, i) => [...new Set((file.steps[name]!.needs ?? []).flatMap((need) => index.get(need) ?? []))].filter((need) => need !== i));

  // One depth-first walk in file order (Tarjan's) splits the steps into parts that need each other round a circle, each
  // part done after every part it needs, and meets the first circle the way the needs-cycle message names it.
  const part = new Int32Array(count).fill(-1);
  const parts: number[][] = [];
  let cycle: ReadonlyArray<string> = [];
  {
    const order = new Int32Array(count).fill(-1);
    const low = new Int32Array(count);
    const onPath = new Uint8Array(count);
    const open: number[] = [];
    let visits = 0;
    for (let root = 0; root < count; root++) {
      if (order[root] !== -1) continue;
      const path = [root];
      const next = [0];
      order[root] = low[root] = visits++;
      onPath[root] = 1;
      open.push(root);
      while (path.length > 0) {
        const top = path.length - 1;
        const step = path[top]!;
        const need = needs[step]![next[top]!];
        if (need !== undefined) {
          next[top]!++;
          if (order[need] === -1) {
            order[need] = low[need] = visits++;
            onPath[need] = 1;
            open.push(need);
            path.push(need);
            next.push(0);
          } else if (part[need] === -1) {
            low[step] = Math.min(low[step]!, order[need]!);
            if (cycle.length === 0 && onPath[need] === 1) cycle = path.slice(path.indexOf(need)).map((i) => names[i]!);
          }
          continue;
        }
        path.pop();
        next.pop();
        onPath[step] = 0;
        if (top > 0) low[path[top - 1]!] = Math.min(low[path[top - 1]!]!, low[step]!);
        if (low[step] !== order[step]) continue;
        const members: number[] = [];
        for (let member = open.pop()!; ; member = open.pop()!) {
          part[member] = parts.length;
          members.push(member);
          if (member === step) break;
        }
        parts.push(members);
      }
    }
  }

  // Every step an `if` names gets a bit: bit k of pass p is the ref numbered 32p + k.
  const refNumber = new Map<number, number>();
  const refs: number[] = [];
  const asked: Array<Array<{ readonly step: number; readonly ref: number; readonly k: number; readonly failed: boolean }>> = [];
  names.forEach((name, step) => {
    for (const [refName, value] of Object.entries(file.steps[name]!.if ?? {})) {
      const ref = index.get(refName);
      if (ref === undefined) continue;
      if (!refNumber.has(ref)) {
        refNumber.set(ref, refs.length);
        refs.push(ref);
      }
      const n = refNumber.get(ref)!;
      (asked[n >> 5] ??= []).push({ step, ref, k: n & 31, failed: value === "failed" });
    }
  });
  const handlers = cycle.length === 0;
  const handles = names.map((name) => !ifLost(name) && Object.values(file.steps[name]!.if ?? {}).includes("failed"));
  // The steps whose failure skips a step, where it needs them: with an if that tests no failure, any step it needs,
  // directly or not (undefined); with one that tests a failure, its own needs that it does not test, and the steps its
  // if tests for a decision.
  const skippedBy = names.map((name, i): ReadonlyArray<number> | undefined => {
    const tests = file.steps[name]!.if ?? {};
    if (ifLost(name)) return [];
    if (!handles[i]) return undefined;
    const decided = Object.entries(tests).flatMap(([ref, value]) => (value === "failed" ? [] : (index.get(ref) ?? [])));
    return [...needs[i]!.filter((need) => tests[names[need]!] !== "failed"), ...decided];
  });
  const conflicts = new Array<{ readonly failing: string; readonly through: ReadonlyArray<string> } | undefined>(count);
  // For a pass, by step: the bits of the refs its if tests with `failed`.
  const fails = new Int32Array(count);

  const ifs = new Map<string, Map<string, IfFacts>>();
  const own = new Int32Array(count);
  const partOwn = new Int32Array(parts.length);
  const reach = new Int32Array(parts.length);
  // With no circle every part is one step. By part: the bits of the refs whose failure skips its step (§1.3, §2.2), and
  // of those whose failure skips it or a step it needs, directly or not.
  const skip = new Int32Array(parts.length);
  const poison = new Int32Array(parts.length);
  // By part: the bits of the refs that it or a step it needs, directly or not, tests with `failed`, where it needs them.
  const failTested = new Int32Array(parts.length);
  // For a pass's failure handlers, by part: the refs' bits it is asked about, and for each the skipped step it waits on
  // nearest it, through the first of its needs that waits on one. Bits with the same answer share a group, so a long run
  // of steps that all of them go through shares one list of groups, where one walk a bit took the run's length a ref.
  const asking = new Int32Array(parts.length);
  const nearest = new Array<ReadonlyArray<{ readonly bits: number; readonly step: number }> | undefined>(parts.length);

  for (let pass = 0; pass < asked.length; pass++) {
    const block = refs.slice(pass * 32, pass * 32 + 32);
    let from = parts.length;
    block.forEach((ref, k) => {
      own[ref] = 1 << k;
      from = Math.min(from, part[ref]!);
    });
    // A part comes after every part it needs, so none before the first ref's can need a ref.
    for (const bits of [partOwn, reach, skip, poison, failTested]) bits.fill(0, 0, from);
    const entries = asked[pass] ?? [];
    for (const { step, k, failed } of entries) if (failed) fails[step] = fails[step]! | (1 << k);
    for (let p = from; p < parts.length; p++) {
      const members = parts[p]!;
      let bits = 0;
      if (members.length === 1) {
        const step = members[0]!;
        let after = 0;
        let below = 0;
        for (const need of needs[step]!) {
          const q = part[need]!;
          bits |= reach[q]! | partOwn[q]!;
          after |= poison[q]!;
          below |= failTested[q]!;
        }
        reach[p] = bits;
        partOwn[p] = own[step]!;
        if (!handlers) continue;
        const by = skippedBy[step];
        let skipped = by === undefined ? bits : 0;
        if (by !== undefined) for (const ref of by) skipped |= own[ref]! & bits;
        skip[p] = skipped;
        poison[p] = after | skipped;
        failTested[p] = below | (fails[step]! & bits);
        const dead = poison[p]! & below & ~fails[step]!;
        if (dead !== 0 && handles[step] && conflicts[step] === undefined) {
          const bit = dead & -dead;
          const through: string[] = [];
          for (const need of needs[step]!) if ((failTested[part[need]!]! & bit) !== 0 && through.push(names[need]!) > LISTED) break;
          conflicts[step] = { failing: names[block[31 - Math.clz32(bit)]!]!, through };
        }
        continue;
      }
      // The steps of a circle each need every one of them.
      let mine = 0;
      for (const step of members) {
        mine |= own[step]!;
        for (const need of needs[step]!) if (part[need] !== p) bits |= reach[part[need]!]! | partOwn[part[need]!]!;
      }
      reach[p] = bits | mine;
      partOwn[p] = mine;
    }
    // With no circle (every part one step), each step's `failed` tests of this pass's refs that it needs, as bits.
    const handling = new Map<number, number>();
    if (handlers) {
      for (const { step, k, failed } of entries) {
        if (failed && (reach[part[step]!]! & (1 << k)) !== 0) handling.set(step, (handling.get(step) ?? 0) | (1 << k));
      }
    }
    // By handler, then by bit: its needs that wait on a step the failure skips, at most LISTED + 1 of them, so a step
    // that needs and tests a whole chain costs its needs once a pass, not once a ref.
    const through = new Map<number, number[][]>();
    let last = -1;
    for (const [step, bits] of handling) {
      const lists: number[][] = [];
      let open = bits;
      for (const need of needs[step]!) {
        const q = part[need]!;
        const hit = poison[q]! & open;
        if (hit === 0) continue;
        asking[q] = asking[q]! | hit;
        last = Math.max(last, q);
        for (let rest = hit; rest !== 0; rest &= rest - 1) {
          const k = 31 - Math.clz32(rest & -rest);
          if ((lists[k] ??= []).push(need) > LISTED) open &= ~(1 << k);
        }
        if (open === 0) break;
      }
      through.set(step, lists);
    }
    // Going back from the last part asked: a bit a part is not skipped by goes on to the first of its needs that waits on
    // a step the bit's failure skips. Only later parts ask a part, so it has been asked everything before its turn.
    for (let p = last; p >= from; p--) {
      let rest = asking[p]! & ~skip[p]!;
      for (const need of needs[parts[p]![0]!]!) {
        if (rest === 0) break;
        const go = rest & poison[part[need]!]!;
        asking[part[need]!] = asking[part[need]!]! | go;
        rest &= ~go;
      }
    }
    // Then forward, each part's answers from its needs', worked out before it. One need taking every bit lends its own.
    for (let p = from; p <= last; p++) {
      const bits = asking[p]!;
      if (bits === 0) continue;
      const step = parts[p]![0]!;
      const here = bits & skip[p]!;
      const groups = here === 0 ? [] : [{ bits: here, step }];
      let lent: (typeof nearest)[number];
      let rest = bits & ~here;
      for (const need of needs[step]!) {
        if (rest === 0) break;
        const q = part[need]!;
        const go = rest & poison[q]!;
        if (go === 0) continue;
        rest &= ~go;
        if (go === bits) {
          lent = nearest[q];
          break;
        }
        for (const group of nearest[q]!) if ((group.bits & go) !== 0) groups.push({ bits: group.bits & go, step: group.step });
      }
      nearest[p] = lent ?? groups;
    }
    const nearestTo = (need: number, bit: number) => nearest[part[need]!]!.find((group) => (group.bits & bit) !== 0)!.step;
    for (const { step, ref, k, failed } of entries) {
      const bit = 1 << k;
      const needed = (reach[part[step]!]! & bit) !== 0;
      const stands = failed ? through.get(step)?.[k] : undefined;
      let facts = ifs.get(names[step]!);
      if (facts === undefined) ifs.set(names[step]!, (facts = new Map()));
      facts.set(names[ref]!, stands === undefined ? { needed } : {
        needed,
        blocked: {
          skipped: [...new Set(stands.map((need) => nearestTo(need, bit)))].sort((a, b) => a - b).map((i) => names[i]!),
          through: stands.map((need) => names[need]!),
        },
      });
    }
    for (const ref of block) own[ref] = 0;
    for (const { step } of entries) fails[step] = 0;
    asking.fill(0, from, last + 1);
    nearest.fill(undefined, from, last + 1);
  }

  const needsOf = (step: string, limit: number): ReadonlyArray<string> => {
    const start = index.get(step);
    if (start === undefined) return [];
    const out: string[] = [];
    const seen = new Set<number>();
    const path = [start];
    const next = [0];
    while (path.length > 0 && out.length < limit) {
      const top = path.length - 1;
      const need = needs[path[top]!]![next[top]!];
      if (need === undefined) {
        path.pop();
        next.pop();
        continue;
      }
      next[top]!++;
      if (seen.has(need)) continue;
      seen.add(need);
      out.push(names[need]!);
      path.push(need);
      next.push(0);
    }
    return out;
  };
  return { cycle, ifs, conflictOf: (step) => conflicts[index.get(step) ?? -1], needsOf };
}

const validTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const timeZones = (): ReadonlyArray<string> => (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);

type Report = (path: ReadonlyArray<PropertyKey>, code: Parameters<typeof diagnostic>[2], message: string, part?: "key" | "value", always?: boolean) => void;

/**
 * on.schedule: one of at (a time of day, with weekdays, monthdays or every 2d/2w), every (an interval), once (a
 * date and time) or cron; start, until and count bound a repeat. A rejected value was still written: the rules
 * about which keys go together count it, so a bad at and a bad timezone, or a bad every and weekdays, are all
 * reported in one pass.
 */
function checkSchedule(schedule: ScheduleTrigger, lost: (...prefix: ReadonlyArray<string>) => boolean, report: Report): void {
  const at = ["on", "schedule"];
  const has = (k: keyof ScheduleTrigger) => schedule[k] !== undefined || lost("on", "schedule", k);
  const step = calendarStep(schedule.every);
  const interval = has("every") && step === undefined;
  const kinds = [has("at") ? "at" : null, interval && !has("at") ? "every" : null, has("once") ? "once" : null, has("cron") ? "cron" : null].filter((k) => k !== null);
  if (has("at") && interval && schedule.every !== undefined) {
    report([...at, "every"], "schedule-shape", `With at, every counts days or weeks, like every: 2d or every: 2w; every ${schedule.every} is an interval, so remove at or write days or weeks.`, "key", true);
  } else if (kinds.length > 1) {
    report([...at, kinds[1]!], "schedule-shape", `A schedule has one of at (a time of day), every (an interval), once (a date and time) or cron; this one has ${quoteList(kinds, "and")}. Remove all but one.`, "key", true);
  } else if (kinds.length === 0 && !(step !== undefined && !has("at"))) {
    report(at, "schedule-shape", 'A schedule needs at, like at: "09:00", every, like every: 6h, once, like once: "2026-11-09 09:00", or cron.', "key");
  }
  if (step !== undefined && !has("at")) {
    report([...at, "every"], "schedule-every-invalid",
      step.unit === "day"
        ? `every is "${schedule.every}"; write ${step.n * 24}h for an interval, or add at: "09:00" to run at a time every ${step.n === 1 ? "day" : `${step.n} days`}.`
        : `every is "${schedule.every}"; for every ${step.n === 1 ? "week" : `${step.n} weeks`}, add at: "09:00" with weekdays: [mon].`);
  }
  if (has("weekdays") && !has("at")) {
    report([...at, "weekdays"], "schedule-shape", 'weekdays goes with at; with every, the schedule runs every day. For certain days, use at: "09:00" with weekdays.', "key", true);
  }
  if (has("monthdays") && !has("at")) {
    report([...at, "monthdays"], "schedule-shape", 'monthdays goes with at, like at: "09:00" with monthdays: [1, 15, last].', "key", true);
  }
  if (has("monthdays") && has("weekdays")) {
    report([...at, "monthdays"], "schedule-shape", "A schedule runs on weekdays or on monthdays, not both; for both, write cron.", "key", true);
  }
  if (has("monthdays") && step !== undefined) {
    report([...at, "every"], "schedule-shape", "every 2d or 2w goes with weekdays or every day, not monthdays; for every other month, write cron, like \"0 9 1 */2 *\".", "key", true);
  }
  if (step?.unit === "day" && has("weekdays") && has("at")) {
    report([...at, "weekdays"], "schedule-shape", `every ${schedule.every} counts days, so it takes no weekdays; for certain days every few weeks, write every: ${step.n}w.`, "key", true);
  }
  if (step?.unit === "week" && has("at") && !has("weekdays")) {
    report([...at, "every"], "schedule-shape", `every ${schedule.every} runs on weekdays; add them, like weekdays: [mon].`, "key", true);
  }
  if (step !== undefined && step.n > 1 && has("at") && !has("start")) {
    report([...at, "every"], "schedule-start-missing", `every ${schedule.every} counts from a first day; add start, like start: "2026-11-09".`, "key");
  }
  if (has("once") && (has("start") || has("until") || has("count"))) {
    const extra = (["start", "until", "count"] as const).find((k) => has(k))!;
    report([...at, extra], "schedule-shape", `once runs one time, so it takes no ${extra}; remove it.`, "key", true);
  }
  if ((has("at") || has("once") || has("cron") || has("start") || has("until")) && !has("timezone")) {
    report(at, "schedule-timezone-missing", "Add timezone, like timezone: Europe/Amsterdam; the machine that runs this may not be in your time zone.", "key");
  }
  if (schedule.timezone !== undefined && !validTimeZone(schedule.timezone)) {
    report([...at, "timezone"], "schedule-timezone-invalid",
      `timezone "${schedule.timezone}" is not an IANA time zone.${didYouMean(schedule.timezone, timeZones())} Write a name like Europe/Amsterdam or America/New_York.`);
  }
  const every = interval && schedule.every !== undefined ? durationMs(schedule.every) : undefined;
  if (every !== undefined && every < MIN_EVERY_MS) {
    report([...at, "every"], "schedule-every-invalid", `every is ${schedule.every}; the shortest interval is 5m.`);
  }
  for (const key of ["once", "start", "until"] as const) {
    const value = schedule[key];
    if (value !== undefined && civilDate(value) === undefined) {
      report([...at, key], "schedule-date-invalid", `${key} is "${value}"; that day is not in the calendar. Write a real date, like "2026-11-09".`);
    }
  }
  if (schedule.start !== undefined && schedule.until !== undefined && schedule.until < schedule.start) {
    report([...at, "until"], "schedule-date-invalid", `until is ${schedule.until}, before start (${schedule.start}); nothing would run.`);
  }
  if (schedule.cron !== undefined) {
    const problem = cronProblem(schedule.cron);
    if (problem !== undefined) report([...at, "cron"], "schedule-cron-invalid", `cron is "${schedule.cron}"; ${problem} Write five fields: minute hour day-of-month month day-of-week, like "0 9 * * 1-5".`);
  }
}

/** Why croner cannot read a five-field cron expression, or undefined. */
function cronProblem(expression: string): string | undefined {
  try {
    new Cron(expression, { mode: "5-part" });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /[.!?]$/.test(message) ? message : `${message}.`;
  }
}

interface Context {
  readonly scope: Scope;
  readonly file: AutomationFile;
  readonly source: YamlSource;
  readonly agents: ReadonlyMap<string, AgentInfo>;
  /** Agent files that did not load, by the name a step would use (the file name): their own problem is reported there. */
  readonly broken: ReadonlyMap<string, string>;
  /** Field names an agent's returns schema declares, when its file was in the check. */
  readonly returnsFields: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly target: Target;
  readonly env: EnvSnapshot | undefined;
  /** Parts that had a rejected value; their follow-on problems are left out. */
  readonly tainted: ReadonlyArray<ReadonlyArray<string>>;
}

function checkAutomation(ctx: Context): Diagnostic[] {
  const { file, source, agents } = ctx;
  const out: Diagnostic[] = [];
  // A file with rejected values is checked without them; leave out what follows from their absence.
  // Asked of every step, so by key: a file with a rejected value on each of many steps would otherwise take their square.
  const keyOf = (path: ReadonlyArray<PropertyKey>) => JSON.stringify(path.map(String));
  const taintedPaths = new Set(ctx.tainted.map(keyOf));
  const taintedPrefixes = new Set(ctx.tainted.flatMap((t) => t.map((_, i) => keyOf(t.slice(0, i + 1)))));
  const inside = (path: ReadonlyArray<PropertyKey>) => taintedPaths.size > 0 && Array.from({ length: path.length + 1 }, (_, i) => path.slice(0, i)).some((p) => taintedPaths.has(keyOf(p)));
  const lost = (...prefix: ReadonlyArray<string>) => taintedPrefixes.has(keyOf(prefix));
  const stepLost = (name: string, key: string) => inside(["steps", name, key]);
  /** `always`: a problem of its own, even where a value beside it was rejected. */
  const report = (path: ReadonlyArray<PropertyKey>, code: Parameters<typeof diagnostic>[2], message: string, part: "key" | "value" = "value", always = false) => {
    if (always || !inside(path)) out.push(diagnostic(source.path, source.at(path, part), code, message));
  };
  const stepNames = Object.keys(file.steps);
  const host = hostOf(file);
  /** Runs in Caveman Code: a This Mac file checked for Code, and Me files always. A cloud file runs in Caveman Cloud. */
  const onCode = ctx.scope === "me" || (host === "this-mac" && ctx.target === "code");
  /** Fires in Caveman Cloud: host cloud, or a check for the cloud target. */
  const onCloud = ctx.scope !== "me" && (host === "cloud" || ctx.target === "cloud");
  const graph = isGraph(file);
  const stepIndex = new Map(stepNames.map((name, i) => [name, i]));
  // A step whose if was rejected may have tested a failure: it is not counted as skipped.
  const needsInfo = graph ? needsGraph(file, (name) => lost("steps", name, "if")) : undefined;
  const cycle = needsInfo?.cycle ?? [];
  if (host === "cloud" && ctx.scope === "me" && !lost("host")) {
    report(["host"], "host-me-cloud", "A Me file lives only on this Mac, so Cloud never sees it; move it to .caveman/automations/ to run it on Cloud, or remove host.");
  }
  if (cycle.length > 0) {
    report(["steps", cycle[0]!, "needs"], "needs-cycle", `needs go round in a circle (${[...cycle, cycle[0]!].join(", then ")}), so none of them could start; remove one of those needs.`, "key");
  }
  /** What a step may decide: its agent's decides, or a prompt step's own. */
  const decidesOf = (stepName: string) => {
    const step = file.steps[stepName];
    return step?.agent === undefined ? step?.decides : agents.get(step.agent)?.decides;
  };
  let compared = 0;
  /** closest, while this file's suggestions have compared fewer than COMPARED names. */
  const closestOf = (word: string, candidates: () => ReadonlyArray<string>): string | undefined => {
    if (compared >= COMPARED) return undefined;
    const all = candidates();
    compared += all.length;
    return closest(word, all);
  };
  const suggest = (word: string, candidates: () => ReadonlyArray<string>): string => {
    const match = closestOf(word, candidates);
    return match === undefined ? "" : ` Did you mean "${match}"?`;
  };
  /** For a name that is not a step: a suggestion, or ` <lead>: a, b and c.` from `candidates`. */
  const notAStep = (word: string, lead: string, candidates: (limit: number) => ReadonlyArray<string>): string => {
    const suggestion = suggest(word, () => candidates(Infinity));
    if (suggestion !== "") return suggestion;
    const listed = candidates(LISTED + 1);
    return listed.length === 0 ? "" : ` ${lead}: ${someOf(listed, "and")}.`;
  };
  const unknownAgent = (agentName: string) => unknownAgentMessage(agentName, agents, ctx.broken, () => closestOf(agentName, () => [...agents.keys()]));
  const decisionSets = new WeakMap<ReadonlyArray<string>, ReadonlySet<string>>();
  /** decides holds value: asked for each if, and an agent may declare thousands. */
  const decided = (decides: ReadonlyArray<string>, value: string) => {
    let set = decisionSets.get(decides);
    if (set === undefined) decisionSets.set(decides, (set = new Set(decides)));
    return set.has(value);
  };

  stepNames.forEach((name, index) => {
    const step = file.steps[name]!;
    const at = ["steps", name];
    if (!NAME_PATTERN.test(name)) {
      report(at, "name-invalid", `Step name "${name}" must be ${NAME_RULE}, like fix-tests.`, "key");
    }
    const kinds = (["agent", "prompt", "run", "wait"] as const).filter((k) => step[k] !== undefined || stepLost(name, k));
    if (kinds.length !== 1 && !(kinds.length === 0 && (stepLost(name, "agent") || stepLost(name, "prompt")))) {
      report(at, "step-agent-or-prompt",
        kinds.length === 0
          ? `Step "${name}" needs agent: <name>, prompt: <instructions>, run: <command> or wait: <duration>.`
          : `Step "${name}" has ${quoteList(kinds, "and")}; keep one.`, "key");
    }
    const kind = stepKindOf(step);
    if (kind !== "agent") {
      // A run step decides too: its command's last line says the value.
      const unused = (["model", "effort", "escalate", ...(kind === "wait" ? (["decides", "checks", "computer", "retries", "parallel", "pick"] as const) : ([] as const))] as const).filter(
        (k) => step[k] !== undefined,
      );
      if (unused.length > 0) {
        report([...at, unused[0]!], "step-key-unused",
          `${quoteList(unused, "and")} ${unused.length === 1 ? "does" : "do"} nothing on a ${kind} step${kind === "run" ? ", which runs its command with no model" : ", which only waits"}; remove ${unused.length === 1 ? "it" : "them"}.`, "key");
      }
      if (step.outcome !== undefined) {
        report([...at, "outcome"], "outcome-not-agent", `outcome needs an agent to send the grader's feedback to, and step "${name}" ${kind === "run" ? "runs a command" : "only waits"}; give the rubric to an agent step.`, "key");
      }
    }
    for (const need of step.needs ?? []) {
      if (need === name || file.steps[need] === undefined) {
        const others = (limit: number) => {
          const out: string[] = [];
          for (let i = 0; i < stepNames.length && out.length < limit; i++) if (i !== index) out.push(stepNames[i]!);
          return out;
        };
        report([...at, "needs"], "needs-unknown-step",
          need === name ? `Step "${name}" needs itself; remove "${need}" from its needs.` : `needs names "${need}", which is not a step.${notAStep(need, "Steps", others)}`);
      }
    }
    if (step.parallel !== undefined && (step.checks ?? []).length === 0 && !stepLost(name, "checks")) {
      report([...at, "parallel"], "parallel-needs-check",
        `parallel: ${step.parallel} starts ${step.parallel} attempts, and only a check can tell which ones worked; add checks, like checks: [pnpm test].`, "key");
    }
    if (step.pick !== undefined && step.parallel === undefined && !stepLost(name, "parallel")) {
      report([...at, "pick"], "pick-without-parallel", `pick chooses among parallel attempts, and step "${name}" makes one at a time; add parallel: 2, or remove pick.`, "key");
    }
    const approval = step.approve?.timeout === undefined ? undefined : durationMs(step.approve.timeout);
    if (approval !== undefined && approval > MAX_APPROVAL_MS) {
      report([...at, "approve", "timeout"], "approve-timeout-too-long", `approve.timeout is ${formatDuration(approval)}; an approval waits 336h (14 days) at most.`);
    }
    const wait = step.wait === undefined ? undefined : durationMs(step.wait);
    if (wait !== undefined && wait > MAX_WAIT_MS) {
      report([...at, "wait"], "wait-invalid", `wait is ${formatDuration(wait)}; a step waits 168h (a week) at most. For longer, use a schedule.`);
    }
    rungsOf(step.escalate).forEach((rung, i) => {
      if (rung.engine !== undefined && !isEngine(rung.engine)) {
        report([...at, "escalate", i, "engine"], "engine-unknown",
          `engine "${rung.engine}" is not an engine.${rung.engine === "claude-code" ? ' Use "claude-agent".' : didYouMean(rung.engine, ["caveman", "claude-agent", "codex"]) || " Use caveman, claude-agent, codex or acp:<id>."}`);
      }
    });
    if (step.agent !== undefined && !agents.has(step.agent)) {
      report([...at, "agent"], "agent-unknown", unknownAgent(step.agent));
    }
    if (step.decides !== undefined && step.agent !== undefined) {
      report([...at, "decides"], "step-decides-agent",
        `Step "${name}" uses agent "${step.agent}", and an agent's decisions are set in its file; remove decides here, or use a prompt step.`, "key");
    } else if (step.decides !== undefined) {
      const reserved = step.decides.filter((d) => (RESERVED_DECISIONS as ReadonlyArray<string>).includes(d));
      if (reserved.length > 0) report([...at, "decides"], "decides-reserved", `decides lists ${quoteList(reserved, "and")}, which the runtime uses for step status; pick another word.`);
    }
    const agent = step.agent === undefined ? undefined : agents.get(step.agent);

    const ifFacts = needsInfo?.ifs.get(name);
    // Asked for each failure handler: a step may need and test thousands of steps.
    let directNeeds: ReadonlySet<string> | undefined;
    for (const [ref, value] of Object.entries(step.if ?? {})) {
      const refIndex = stepIndex.get(ref) ?? -1;
      if (stepLost(ref, "agent")) continue;
      if (refIndex === -1) {
        const earlier = (limit: number) => (needsInfo === undefined ? stepNames.slice(0, Math.min(index, limit)) : needsInfo.needsOf(name, limit));
        report([...at, "if", ref], "if-unknown-step", `if names "${ref}", which is not a step.${notAStep(ref, `Steps ${graph ? `"${name}" needs` : `before "${name}"`}`, earlier)}`, "key");
      } else if (graph && ifFacts?.get(ref)?.needed !== true) {
        report([...at, "if", ref], "if-not-a-need",
          ref === name
            ? `if names this step; test a step that "${name}" needs.`
            : `if names "${ref}", and "${name}" does not need it, so "${ref}" may not have finished; add "${ref}" to needs.`, "key");
      } else if (!graph && refIndex >= index) {
        report([...at, "if", ref], "if-not-earlier",
          refIndex === index
            ? `if names this step; test a step that runs before "${name}".`
            : `if names "${ref}", which runs after "${name}"; steps run in file order, so move "${ref}" above "${name}".`, "key");
      } else if (value !== "failed") {
        const refAgent = file.steps[ref]!.agent;
        // A mistyped agent is reported once, as agent-unknown: what it would decide is not known.
        if ((refAgent !== undefined && !agents.has(refAgent)) || stepLost(ref, "decides")) continue;
        const decides = decidesOf(ref);
        if (decides === undefined) {
          report([...at, "if", ref], "if-no-decides",
            refAgent === undefined
              ? `if: { ${ref}: ${value} }: ${stepKindOf(file.steps[ref]!) === "run" ? "run" : "prompt"} step "${ref}" declares no decides, so if can only test ${ref}: failed. Add decides: [${value}, ...] to "${ref}", or test failed.`
              : `if: { ${ref}: ${value} }: agent "${refAgent}" declares no decides, so if can only test ${ref}: failed. Add decides to the agent, or test failed.`);
        } else if (!decided(decides, value)) {
          report([...at, "if", ref], "if-unknown-value", `if: { ${ref}: ${value} }: "${ref}" decides ${someOf(decides)}, or failed.${suggest(value, () => decides)}`);
        }
      } else if (graph && cycle.length === 0 && !lost("steps", name, "needs")) {
        const blocked = ifFacts?.get(ref)?.blocked;
        const conflict = needsInfo?.conflictOf(name);
        const quote = (names: ReadonlyArray<string>) => someOf(names.map((n) => `"${n}"`), "and");
        if (blocked !== undefined) {
          const { skipped, through } = blocked;
          report([...at, "if", ref], "if-failed-never-runs",
            `"${name}" never runs when "${ref}" fails: ${quote(skipped)} ${skipped.length === 1 ? "is" : "are"} skipped then, and so is every step after ${skipped.length === 1 ? "it" : "them"}. ${
              (directNeeds ??= new Set(step.needs)).has(ref) ? `Remove ${quote(through)} from the needs of "${name}".` : `Have "${name}" need "${ref}" instead of ${quote(through)}.`}`, "key");
        } else if (conflict !== undefined) {
          const { failing, through } = conflict;
          report([...at, "if", ref], "if-failed-never-runs",
            `"${name}" never runs when "${ref}" fails: it waits on ${quote(through)}, which ${through.length === 1 ? "runs" : "run"} only when "${failing}" fails, and "${name}" is skipped when "${failing}" fails.`, "key");
        }
      }
    }

    const computer = computerOf(step);
    const commands = (step.checks ?? []).filter((c): c is string => typeof c === "string");
    if (commands.length > 0 && (computer === "none" || computer === "code") && !stepLost(name, "computer")) {
      report([...at, "computer"], "checks-need-computer",
        `Step "${name}" has command checks and computer: ${computer}, so there is no checkout to run them in. Use computer: readonly or full.`);
    }
    (step.checks ?? []).forEach((check, i) => {
      if (typeof check === "string") return;
      const checker = agents.get(check.agent);
      if (checker === undefined) {
        report([...at, "checks", i, "agent"], "agent-unknown", unknownAgent(check.agent));
      } else if (!sameSet(checker.decides ?? [], REVIEW_DECISIONS)) {
        report([...at, "checks", i, "agent"], "check-agent-decides",
          `Agent check "${check.agent}" must decide exactly approve and request_changes; ${checker.decides ? `it decides ${someOf(checker.decides)}` : "it declares no decides"}. ${checker.source === "builtin" ? "Use reviewer, or an agent file that declares decides: [approve, request_changes]." : "Add decides: [approve, request_changes] to its file."}`);
      }
    });

    const model = step.model ?? agent?.model;
    const modelPath = step.model === undefined ? at : [...at, "model"];
    if (isClaudeAlias(model)) {
      report(modelPath, "model-alias", `model: ${model} pins a Claude model by its alias; use the class ${ALIAS_CLASS[model!]} so this step works on every engine.`);
    } else if (model === "auto" && (computer === "none" || computer === "code") && !stepLost(name, "computer")) {
      report(modelPath, "model-auto-no-computer", `model: auto is trained on coding work and step "${name}" has computer: ${computer}; pick a class, like model: fast.`);
    }
    if (step.escalate !== undefined && (step.retries ?? 0) === 0 && !stepLost(name, "retries")) {
      report([...at, "escalate"], "escalate-without-retries", "escalate applies to attempts 2 and later, and retries is 0; add retries: 1 or more, or remove escalate.");
    }
    const timeout = step.timeout === undefined ? undefined : durationMs(step.timeout);
    if (timeout !== undefined && timeout > RUN_DEADLINE_MS) {
      report([...at, "timeout"], "timeout-too-long",
        `timeout is ${formatDuration(timeout)}, longer than the ${formatDuration(RUN_DEADLINE_MS)} a whole run may take in v1, so the run would stop first; use ${formatDuration(RUN_DEADLINE_MS)} or less.`);
    }
    if (ctx.env !== undefined) {
      const engine = agent?.engine ?? ctx.env.defaultEngine;
      const info = ctx.env.engines.find((e) => e.id === engine);
      if (info !== undefined && !info.available) {
        report(step.agent === undefined ? at : [...at, "agent"], "engine-unavailable", `Step "${name}" runs on ${engine}, which is not available here${info.reason ? `: ${info.reason}` : ""}.`);
      }
    }
  });

  // SECURITY M1: in Cloud, text from outside the org reaches a step that can write only after the owner approves.
  const outsiders = outsiderTriggers(file);
  const writers = writingSteps(file);
  if (onCloud && outsiders.length > 0 && writers.length > 0) {
    report(outsiders[0]!.split("."), "outsider-approval",
      `This run can start from text anyone may write (${outsiders.join(", ")}), so ${writers.length === 1 ? `step "${writers[0]}" waits` : `steps ${writers.map((w) => `"${w}"`).join(", ")} wait`} for the owner's approval each time, before ${writers.length === 1 ? "it runs" : "they run"}.`, "key");
  }

  // Outputs
  const outputs = file.outputs ?? {};
  const hasGitHub = file.on?.github !== undefined || lost("on", "github");
  for (const kind of ["github.comment", "github.pull_request", ...CLOUD_OUTPUTS, "chief"] as const) {
    const value = outputs[kind];
    if (value === undefined) continue;
    const { step, field } = outputSource(value);
    if ((CLOUD_OUTPUTS as ReadonlyArray<string>).includes(kind)) {
      if (!onCloud) {
        report(["outputs", kind], "output-needs-cloud", `Only Cloud posts ${kind}; this file runs on This Mac. Set host: cloud at the top, or remove ${kind}.`, "key");
      }
      const trigger = kind === "slack.message" ? "slack" : kind === "linear.comment" ? "linear" : "jira";
      const channel = kind === "slack.message" && typeof value !== "string" && (value as { channel?: string }).channel !== undefined;
      if (file.on?.[trigger] === undefined && !lost("on", trigger) && !channel) {
        report(["outputs", kind], "output-needs-trigger",
          kind === "slack.message"
            ? "slack.message replies in the thread that fired the run, and nothing here comes from Slack; add on.slack, or post to a channel: { from: <step>, channel: \"#ops\" }."
            : `${kind} comments on the ${trigger === "linear" ? "Linear" : "Jira"} issue that fired the run; add on.${trigger}, or remove ${kind}.`, "key");
      }
    }
    const at = typeof value === "string" ? ["outputs", kind] : ["outputs", kind, "from"];
    const source = file.steps[step];
    if (stepLost(step, "agent")) continue;
    if (source === undefined) {
      report(at, "output-unknown-step", `${kind} reads step "${step}", which does not exist.${didYouMean(step, stepNames)}`);
      continue;
    }
    const agentName = source.agent;
    const fields = ["summary", ...(agentName === undefined ? [] : (ctx.returnsFields.get(agentName) ?? []))];
    // An agent that is missing, or whose returns file was not in this check, may return anything.
    const unknownReturns = agentName !== undefined && (!agents.has(agentName) || (agents.get(agentName)!.returns !== undefined && !ctx.returnsFields.has(agentName)));
    if (!fields.includes(field) && !unknownReturns) {
      report(typeof value === "string" ? at : ["outputs", kind, "field"], "output-unknown-field",
        fields.length === 1
          ? `${kind} reads ${step}.${field}, and "${step}" returns only summary; use ${step}.summary, or give its agent a returns schema.`
          : `${kind} reads ${step}.${field}, and "${step}" returns ${quoteList(fields)}.${didYouMean(field, fields)}`);
    }
    if (kind === "github.pull_request" && computerOf(source) !== "full" && !stepLost(step, "computer")) {
      report(at, "pull-request-needs-full", `github.pull_request reads step "${step}", which is computer: ${computerOf(source)}, so it has no changes to propose. Set computer: full on "${step}".`);
    }
    if (kind === "chief" && !stepLost(step, "decides") && !(decidesOf(step) ?? []).includes(NEWS_DECISION) && !(source.agent !== undefined && !agents.has(source.agent))) {
      report(["outputs", kind], "chief-never-news",
        `chief reads step "${step}", which never decides ${NEWS_DECISION}, so its runs only update the routine's row and never wake the Chief. ${source.agent === undefined ? `Add decides: [${NEWS_DECISION}, quiet] to "${step}"` : `Add ${NEWS_DECISION} to agent "${source.agent}"'s decides`}, and end its output with decision: ${NEWS_DECISION} when it found something.`, "key");
    }
    if (kind === "github.comment" && !hasGitHub) {
      report(["outputs", kind], "comment-needs-github",
        file.on?.schedule !== undefined || lost("on", "schedule")
          ? "A scheduled run has no issue or pull request to comment on; it posts only when you run it by hand on one."
          : "A run by hand posts this comment only when you run it on an issue or pull request; add on.github to post on every one.",
        "key");
    }
  }

  // Triggers
  const github = file.on?.github;
  if (github !== undefined) {
    const events = eventsOf(github);
    // With a rejected event, what the trigger listens to is not known; its filters are judged once it is fixed.
    const eventsKnown = !lost("on", "github", "event");
    for (const [filter, carriers] of Object.entries(FILTER_EVENTS)) {
      const set = (github as Record<string, unknown>)[filter];
      if (set === undefined || set === false || !eventsKnown) continue;
      if (!events.some((e) => carriers.includes(e))) {
        report(["on", "github", filter], "github-filter-mismatch",
          `${filter} only applies to ${quoteList([...carriers])}; this trigger listens to ${quoteList([...events], "and")}.`, "key");
      }
    }
    const unlabelled = events.filter((e) => e === "push" || e === "workflow_run.completed");
    if (github.label !== undefined && eventsKnown && unlabelled.length > 0 && events.some((e) => FILTER_EVENTS.label!.includes(e))) {
      const names = unlabelled.map((e) => (e === "push" ? "pushes" : "finished CI runs"));
      report(["on", "github", "label"], "github-label-never-matches",
        `With label set, ${quoteList(names, "and")} never fire: they carry no label. Remove label, or give ${unlabelled.length === 1 ? (unlabelled[0] === "push" ? "push" : "workflow_run.completed") : "them"} an automation of ${unlabelled.length === 1 ? "its" : "their"} own.`, "key");
    }
    if (!onCloud && eventsKnown) {
      const cloudOnly = events.filter((e) => (CLOUD_GITHUB_EVENTS as ReadonlyArray<string>).includes(e));
      if (cloudOnly.length > 0) {
        report(["on", "github", "event"], "trigger-needs-cloud",
          `${quoteList(cloudOnly, "and")} ${cloudOnly.length === 1 ? "is" : "are"} heard only by Caveman's GitHub app; This Mac polls and cannot see ${cloudOnly.length === 1 ? "it" : "them"}. Set host: cloud at the top.`);
      }
    }
    if (github.actors === "any" && onCode) {
      report(["on", "github", "actors"], "github-actors-any",
        "actors: any would let outsiders fire this on This Mac, and Caveman Code only runs GitHub text from owners, members and collaborators. Remove actors to use those three.");
    }
  }
  const schedule = file.on?.schedule;
  if (schedule !== undefined) checkSchedule(schedule, lost, report);
  for (const trigger of CLOUD_TRIGGERS) {
    if (file.on?.[trigger] === undefined || onCloud) continue;
    const name = trigger === "slack" ? "Slack" : trigger === "linear" ? "Linear" : "Jira";
    report(["on", trigger], "trigger-needs-cloud", `${name} can only reach Cloud, never this Mac, so on.${trigger} needs host: cloud at the top of the file.`, "key");
  }
  if (file.on?.webhook !== undefined && onCode) {
    report(["on", "webhook"], "webhook-not-served", "Caveman Code does not serve webhook triggers for files yet, so this would never fire; use github or schedule, or remove webhook.", "key");
  }
  if (ctx.env !== undefined) {
    for (const kind of ["github", "schedule", "webhook", ...CLOUD_TRIGGERS] as const) {
      if (file.on?.[kind] === undefined || ctx.env.servedTriggers.includes(kind) || (kind === "webhook" && onCode)) continue;
      report(["on", kind], "trigger-not-served", `${kind} triggers are not served where this check ran; the automation still runs by hand.`, "key");
    }
  }

  // Budget
  const budget = budgetOf(file.budget);
  if (budget !== undefined) {
    if (budget.usd === undefined && budget.tokens === undefined && budget.turns === undefined) {
      report(["budget"], "budget-invalid", "budget names no limit; add usd, tokens or turns, like { usd: 6 }.");
    } else if (budget.usd !== undefined && !(budget.usd > 0)) {
      report(["budget"], "budget-invalid", `budget is $${budget.usd}; write a positive amount like $6.`);
    }
  }
  return out;
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && b.every((x) => a.includes(x));

/** `closestAgent`: the agent name closest to `name`, if any. */
function unknownAgentMessage(name: string, agents: ReadonlyMap<string, AgentInfo>, broken: ReadonlyMap<string, string>, closestAgent: () => string | undefined): string {
  const file = broken.get(name);
  if (file !== undefined) return `Agent "${name}" is ${file}, which does not load; fix the problem reported there first.`;
  const match = closestAgent();
  const known: string[] = [];
  for (const agent of agents.keys()) if (known.push(agent) > 8) break;
  return `No agent "${name}". ${match ? `Did you mean "${match}"?` : `Add .caveman/agents/${name}.md, or use one of ${quoteList(known.slice(0, 8))}${known.length > 8 ? " (and more)" : ""}.`}`;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const normalize = (path: string) => path.replace(/^\.\//, "").replace(/\/\.\//g, "/");

/**
 * Check a project's `.caveman/` files. `files` are repo-relative (unsaved
 * editor text included); `agents` is the registry the runtime resolves
 * (project, user, plugin, built-in), which the files' own agents shadow.
 */
export function checkProject(input: {
  readonly files: ReadonlyArray<SourceFile>;
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly target?: Target;
  readonly env?: EnvSnapshot;
}): ProjectCheck {
  const target = input.target ?? "code";
  const diagnostics: Diagnostic[] = [];
  // One at a time: push(...found) throws once a file has more problems than a call takes arguments (about 100,000).
  const add = (found: ReadonlyArray<Diagnostic>) => {
    for (const d of found) diagnostics.push(d);
  };
  const files = input.files.map((f) => ({ ...f, path: normalize(f.path) })).sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const automationFiles: Array<{ file: SourceFile; scope: Scope; name: string }> = [];
  const agentFiles: SourceFile[] = [];
  const jsonFiles = new Set<string>();

  for (const file of files) {
    const dir = Object.keys(AUTOMATION_DIRS).find((d) => file.path.startsWith(d));
    if (dir !== undefined) {
      const rest = file.path.slice(dir.length);
      if (!rest.includes("/") && rest.endsWith(".yaml")) automationFiles.push({ file, scope: AUTOMATION_DIRS[dir]!, name: rest.slice(0, -5) });
      else {
        add(hiddenCharacters(file.path, file.text));
        diagnostics.push(diagnostic(file.path, AT_START, "file-unrecognized",
          rest.includes("/")
            ? `Subfolders of ${dir} are not read; move this file up to ${dir}.`
            : rest.endsWith(".yml")
              ? `Only .yaml files load as automations; rename this to ${rest.slice(0, -4)}.yaml.`
              : `Only <name>.yaml files load from ${dir}; this file is not an automation.`));
      }
    } else if (file.path.startsWith(AGENTS_DIR)) {
      const rest = file.path.slice(AGENTS_DIR.length);
      if (!rest.includes("/") && rest.endsWith(".md")) agentFiles.push(file);
      else if (!rest.includes("/") && rest.endsWith(".json")) jsonFiles.add(file.path);
      else {
        add(hiddenCharacters(file.path, file.text));
        diagnostics.push(diagnostic(file.path, AT_START, "file-unrecognized",
          rest.includes("/") ? `Subfolders of ${AGENTS_DIR} are not read; move this file up to ${AGENTS_DIR}.` : `Only <name>.md agents, and the JSON Schema files they name in returns, load from ${AGENTS_DIR}.`));
      }
    } else if (file.path.startsWith(".caveman/")) {
      add(hiddenCharacters(file.path, file.text));
    }
  }

  // Agents: the files first (they shadow the registry), then the registry.
  const registry = new Map<string, AgentInfo>();
  const broken = new Map<string, string>();
  const returnsFields = new Map<string, ReadonlyArray<string>>();
  const referenced = new Set<string>();
  for (const file of agentFiles) {
    const parsed = parseAgentSource(file, "project");
    add(parsed.diagnostics);
    const agent = parsed.agent;
    if (agent === undefined) broken.set(file.path.slice(file.path.lastIndexOf("/") + 1, -3), file.path);
    if (agent === undefined || registry.has(agent.name)) continue;
    const { instructions: _instructions, ignoredKeys, ...info } = agent;
    registry.set(agent.name, ignoredKeys.length > 0 ? { ...info, ignoredKeys } : info);
    if (agent.returns === undefined) continue;
    const schemaPath = normalize(dirOf(file.path) + agent.returns);
    referenced.add(schemaPath);
    const at = parsed.yaml?.at(["returns"]) ?? AT_START;
    const schemaFile = byPath.get(schemaPath);
    if (schemaFile === undefined) {
      diagnostics.push(diagnostic(file.path, at, "returns-missing", `returns names ${agent.returns}, which is not next to this agent; add ${schemaPath}.`));
      continue;
    }
    let properties: unknown;
    try {
      properties = (JSON.parse(schemaFile.text) as { properties?: unknown }).properties;
    } catch {
      properties = undefined;
    }
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      diagnostics.push(diagnostic(file.path, at, "returns-invalid", `${agent.returns} must be a JSON Schema object with properties, like {"type":"object","properties":{"risk":{"type":"string"}}}.`));
    } else returnsFields.set(agent.name, Object.keys(properties));
  }
  for (const path of jsonFiles) {
    if (referenced.has(path)) continue;
    diagnostics.push(diagnostic(path, AT_START, "file-unrecognized", `No agent names ${path.slice(AGENTS_DIR.length)} in returns, so it is not read.`));
  }
  for (const agent of input.agents) if (!registry.has(agent.name)) registry.set(agent.name, agent);

  const automations: LoadedAutomation[] = [];
  for (const { file, scope, name } of automationFiles) {
    if (!NAME_PATTERN.test(name)) {
      diagnostics.push(diagnostic(file.path, AT_START, "name-invalid",
        `Automation name "${name}" (the file name) must be ${NAME_RULE}; rename the file, like ${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 40) || "my-automation"}.yaml.`));
    }
    const parsed = parseAutomationSource(file);
    add(parsed.diagnostics);
    if (parsed.source === undefined) continue;
    const context = { scope, source: parsed.source, agents: registry, broken, returnsFields, target, env: input.env };
    if (parsed.file !== undefined) {
      automations.push({ name, scope, path: file.path, file: parsed.file, digest: sha256Hex(file.text), text: file.text });
      add(checkAutomation({ ...context, file: parsed.file, tainted: [] }));
    } else if (parsed.salvaged !== undefined) {
      // Everything wrong in one pass: the rules across files run on what is left, and the file does not load.
      add(checkAutomation({ ...context, ...parsed.salvaged }));
    }
  }
  return { automations, agents: [...registry.values()], diagnostics };
}
