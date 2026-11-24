// The Automations page's view models: plain functions over the automation.* wire shapes, so every word, cell and
// number the page shows is tested without a runtime (model.test.ts).
import type { AutomationDiagnostic, AutomationExplanation, AutomationRunRecord, AutomationRunSummary, AutomationTemplateSummary, Result } from "@caveman-app/session-protocol";
import { shortModel } from "@caveman-app/ui/components/runner-badge";
import { rowAge } from "../../state/model.ts";
import { THIS_COMPUTER } from "../../lib/platform.ts";

export type Automation = Result<"automation.list">["automations"][number];
export type Delivery = Result<"automation.deliveries">["deliveries"][number];
export type RunRecord = AutomationRunRecord;
export type RunSummary = AutomationRunSummary;
/** `message` (the failure in words) may land with the run engine's fix round; read when present. */
export type Attempt = RunRecord["steps"][number]["attempts"][number] & { readonly message?: string };
/** `workspace_id` on an agent check (its reviewer thread) may land with the run engine's fix round. */
export type Check = Attempt["checks"][number] & { readonly workspace_id?: string };
export type RunStatus = RunRecord["status"];
export type StepStatus = RunRecord["steps"][number]["status"];
export type Day = "worked" | "failed" | "none";
export type Mark = "github" | "schedule" | "webhook" | "manual";
export type Scope = "me" | "project";

export const SCOPE_WORD: Record<Scope, string> = { me: "Me", project: "Project" };
export const SCOPE_HINT: Record<Scope, string> = {
  me: "Only you. Saved in .caveman/local, live as soon as you save.",
  project: "Everyone on the repo. Its triggers start once the file is on the default branch.",
};

// ------------------------------------------------------------ identity

/**
 * A file automation's address, from its id `file:<project_id>:<scope>:<name>`; null for one saved in the app.
 * A project id may hold colons (`caveman-repo:<hash>`); a name never does. Same rule as the runtime's (triggers.ts).
 */
export function fileRef(id: string): { project_id: string; scope: Scope; name: string } | null {
  const m = /^file:(.+):(me|project):([a-z][a-z0-9_-]{0,39})$/.exec(id);
  return m ? { project_id: m[1]!, scope: m[2] as Scope, name: m[3]! } : null;
}

/**
 * Where its files are read and written: the project, or `<project>@<branch>` for a draft, which the runtime reads
 * from that branch's worktree. `project_id` stays the project's own, for its name and its repository.
 */
export const checkoutOf = (a: Automation): string => fileRef(a.id)?.project_id ?? a.project_id;
/** Why a draft does not run on its own, and what turns it on. A Me file never merges: it lives in one checkout. */
export function draftWhy(a: Automation): string {
  const branch = a.worktree?.branch ?? "";
  return a.scope === "me"
    ? `Only in the ${branch} worktree's .caveman/local. Run it by hand there; to keep it, save it as a Me automation in this project.`
    : `Only in the ${branch} worktree so far. Run it by hand now; it turns on once it merges to ${defaultBranch(a)}.`;
}
/** Only in another worktree so far: it runs by hand, and turns on once it merges. */
export const isDraft = (a: Automation): boolean => a.worktree !== undefined;

export const isLegacy = (a: Automation) => a.source === "app";
/** An app-saved automation that a file can carry. Webhook files are not served in Caveman Code yet. */
export const legacyCanBeFile = (a: Automation) => isLegacy(a) && a.trigger.type !== "webhook" && !onCloudSchedule(a);
/** A schedule an agent set to run on a Cloud computer of its own (the runtime's cloud schedules). */
export const onCloudSchedule = (a: Automation) => isLegacy(a) && (a as { host?: unknown }).host === "cloud";
/** It runs on Cloud only once the person allows it (automation.allow). */
export const awaitingAllow = (a: Automation) => a.awaiting_approval === true;
/** A Project file that is not on the default branch yet: its triggers stay off. */
export const offMain = (a: Automation) => a.source === "file" && a.scope === "project" && a.on_default_branch === false;
/** The branch its Project triggers read. */
export const defaultBranch = (a: Automation) => a.default_branch ?? "main";
/** Yours by construction: Me files and the app's own. The wire has no file author yet, so Project files count as everyone's. */
export const isMine = (a: Automation) => isLegacy(a) || a.scope === "me";

// ------------------------------------------------------------ triggers

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAME: Record<string, string> = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };

/** This computer's time zone: a schedule names its own only when it is another. */
export const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A time of day as this computer says it: "9:00 AM" (or "09:00"), from "09:00". */
export function clockWord(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A time zone, briefly: its city ("Europe/Amsterdam" is "Amsterdam"), or the zone itself ("UTC"). */
export const zoneWord = (zone: string) => (zone.split("/").pop() || zone).replace(/_/g, " ");

/** "Every 30 minutes", "Every hour", "Every 2 hours", from a file's `every`. */
export function everyWord(every: string): string {
  const m = /^(\d+)(s|m|h)$/.exec(every);
  if (!m) return `Every ${every}`;
  const n = Number(m[1]);
  const unit = m[2] === "h" ? "hour" : m[2] === "m" ? "minute" : "second";
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

/** Which days, then the time: "Weekdays at 9:00 AM", "Daily at …", "Monday at …", "Mon, Wed at …", and the zone only when it isn't this computer's. */
function atWord(days: ReadonlyArray<string> | "all", hhmm: string, zone: string | undefined, localZone: string): string {
  const set = days === "all" ? [] : [...new Set(days)];
  const key = [...set].sort((a, b) => DAY.indexOf(a) - DAY.indexOf(b)).join();
  const when =
    set.length === 0 || set.length === 7 ? "Daily" : key === "Mon,Tue,Wed,Thu,Fri" ? "Weekdays" : key === "Sun,Sat" ? "Weekends" : set.length === 1 ? DAY_NAME[set[0]!]! : key.split(",").join(", ");
  return `${when} at ${clockWord(hhmm)}${zone && zone !== localZone ? ` (${zoneWord(zone)})` : ""}`;
}

const AT_WORDS = /^(Every day|Weekdays|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:, (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat))*) at (\d{1,2}:\d{2})(?: \(([^)]+)\))?$/;

/**
 * One of a file's trigger words as the page says it. The runtime writes a schedule as "Weekdays at 09:00
 * (Europe/Amsterdam)" and "Every 1h"; those read "Weekdays at 9:00 AM" (with "(Amsterdam)" only on a computer in
 * another zone) and "Every hour". Any other words are the runtime's own.
 */
export function triggerWord(word: string, localZone = LOCAL_ZONE): string {
  // A repeat's bounds trail its words (", from 2026-11-09, until 2026-12-31, 10 runs"); they read as written.
  const tail = /((?:, (?:from|until) \d{4}-\d{2}-\d{2}|, \d+ runs?)+)$/.exec(word);
  const head = tail ? word.slice(0, tail.index) : word;
  const bounds = tail ? boundsWord(tail[1]!) : "";
  const every = /^Every (\d+[smh])$/.exec(head);
  if (every) return everyWord(every[1]!) + bounds;
  const once = /^Once on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})(?: \(([^)]+)\))?$/.exec(head);
  if (once) return onceWord(once[1]!, once[2]!, once[3], localZone);
  const step = /^Every (\d+) (days|weeks)(?: on ([A-Za-z, ]+))? at (\d{1,2}:\d{2})(?: \(([^)]+)\))?$/.exec(head);
  if (step) {
    const [, n, unit, days, hhmm, zone] = step;
    return `Every ${n} ${unit}${days ? ` on ${days}` : ""} at ${clockWord(hhmm!)}${zoneTail(zone, localZone)}${bounds}`;
  }
  const monthly = /^Monthly on the (.+) at (\d{1,2}:\d{2})(?: \(([^)]+)\))?$/.exec(head);
  if (monthly) return `Monthly on the ${monthly[1]} at ${clockWord(monthly[2]!)}${zoneTail(monthly[3], localZone)}${bounds}`;
  const cron = /^Cron (.+?)(?: \(([^)]+)\))?$/.exec(head);
  if (cron) return `Cron ${cron[1]}${zoneTail(cron[2], localZone)}${bounds}`;
  const at = AT_WORDS.exec(head);
  if (!at) return word;
  const [, days, hhmm, zone] = at;
  return atWord(days === "Every day" ? "all" : days === "Weekdays" ? ["Mon", "Tue", "Wed", "Thu", "Fri"] : days!.split(", "), hhmm!, zone, localZone) + bounds;
}

/** " (Amsterdam)" when a schedule keeps another zone's clock; nothing in this computer's. */
const zoneTail = (zone: string | undefined, localZone: string) => (zone && zone !== localZone ? ` (${zoneWord(zone)})` : "");

/** A calendar date as this computer says it: "Mon Nov 9" (with the year when it is not this one). */
export function dateWord(ymd: string, now = new Date()): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  return date
    .toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(y !== now.getFullYear() ? { year: "numeric" } : {}) })
    .replace(/,(?= \d{4}$)/, "")
    .replace(/,/g, "");
}

/** "Once, Mon Nov 9 at 9:00 AM", from a date and a time of day. */
export const onceWord = (ymd: string, hhmm: string, zone: string | undefined, localZone = LOCAL_ZONE) => `Once, ${dateWord(ymd)} at ${clockWord(hhmm)}${zoneTail(zone, localZone)}`;

/** ", from Nov 9, until Dec 31, 10 runs", from the runtime's ", from 2026-11-09, until 2026-12-31, 10 runs". */
function boundsWord(tail: string): string {
  return tail.replace(/(from|until) (\d{4}-\d{2}-\d{2})/g, (_, word: string, ymd: string) => `${word} ${dateWord(ymd)}`);
}

/** Every trigger, each in words. A file's "By hand" is said only when nothing else starts it. */
function triggerWords(trigger: Automation["trigger"], localZone: string): string[] {
  switch (trigger.type) {
    case "file": {
      const words = trigger.words.filter((w) => w !== "By hand");
      return (words.length > 0 ? words : trigger.words.length > 0 ? trigger.words : ["By hand"]).map((w) => triggerWord(w, localZone));
    }
    case "interval": {
      const m = trigger.every_minutes;
      return [(m % 60 === 0 ? (m === 60 ? "Every hour" : `Every ${m / 60} hours`) : `Every ${m} minutes`) + endsWord(trigger)];
    }
    case "daily": {
      // An app-saved schedule is this computer's wall clock unless it names a zone.
      const days = trigger.weekdays && trigger.weekdays.length > 0 ? trigger.weekdays.map((d) => DAY[d]!) : "all";
      if (trigger.every_days !== undefined && trigger.every_days > 1) return [`Every ${trigger.every_days} days at ${clockWord(trigger.time)}${zoneTail(trigger.timezone, localZone)}${endsWord(trigger)}`];
      if (trigger.every_weeks !== undefined && trigger.every_weeks > 1) {
        const named = days === "all" ? "every day" : [...days].sort((a, b) => DAY.indexOf(a) - DAY.indexOf(b)).join(", ");
        return [`Every ${trigger.every_weeks} weeks on ${named} at ${clockWord(trigger.time)}${zoneTail(trigger.timezone, localZone)}${endsWord(trigger)}`];
      }
      return [atWord(days, trigger.time, trigger.timezone, localZone) + endsWord(trigger)];
    }
    case "monthly":
      return [`Monthly on the ${monthDaysWord(trigger.days)} at ${clockWord(trigger.time)}${zoneTail(trigger.timezone, localZone)}${endsWord(trigger)}`];
    case "cron":
      return [`Cron ${trigger.expression}${zoneTail(trigger.timezone, localZone)}${endsWord(trigger)}`];
    case "once": {
      const at = new Date(trigger.run_at);
      return [`Once, ${at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "")} at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`];
    }
    case "webhook":
      return [trigger.signed ? "Webhook, signed" : "Webhook"];
    case "github_mention":
      return [`@caveman in ${trigger.repo}`];
  }
}

const ordinal = (day: number) => {
  if (day === -1) return "last day";
  const tens = day % 100;
  return `${day}${tens >= 11 && tens <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
};

/** "1st, 15th and last day", from month days (-1 is the last). */
export function monthDaysWord(days: ReadonlyArray<number>): string {
  const words = [...new Set(days)].sort((a, b) => (a === -1 ? 32 : a) - (b === -1 ? 32 : b)).map(ordinal);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** ", until Dec 31, 10 runs": an app-saved repeat's bounds, in this computer's time. */
function endsWord(t: { readonly start_at?: string; readonly until?: string; readonly max_runs?: number }): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  const parts = [
    t.start_at !== undefined && Date.parse(t.start_at) > Date.now() ? `from ${day(t.start_at)}` : "",
    t.until !== undefined ? `until ${day(t.until)}` : "",
    t.max_runs !== undefined ? `${t.max_runs} ${t.max_runs === 1 ? "run" : "runs"}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

/** What starts an automation, every trigger in words: "Pull request opened or updated · Weekdays at 9:00 AM". */
export const triggerText = (trigger: Automation["trigger"], localZone = LOCAL_ZONE): string => triggerWords(trigger, localZone).join(" · ");

/** The list row's line: the first trigger, and how many more ("Weekdays at 9:00 AM +1"). */
export function triggerSummary(trigger: Automation["trigger"], localZone = LOCAL_ZONE): string {
  const [first = "By hand", ...rest] = triggerWords(trigger, localZone);
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}

/** The zone a file's schedule keeps, when the runtime's words name one ("Weekdays at 09:00 (Europe/Amsterdam)"). */
export function scheduleZoneOf(trigger: Automation["trigger"]): string | undefined {
  if (trigger.type === "daily") return trigger.timezone;
  if (trigger.type !== "file") return undefined;
  for (const w of trigger.words) {
    const zone = AT_WORDS.exec(w)?.[3] ?? /^(?:Once on|Every|Monthly on|Cron|Weekdays|Sun|Mon|Tue|Wed|Thu|Fri|Sat) .* \(([^)]+)\)(?:,|$)/.exec(w)?.[1];
    if (zone) return zone;
  }
  return undefined;
}

/**
 * When a schedule runs next, in this computer's time: "Next run Mon Oct 26, 9:00 AM". The zone is named ("… PDT")
 * only when the schedule keeps another zone's clock, so the two times never read as one.
 */
export function nextRunWord(at: Date, scheduleZone?: string, localZone = LOCAL_ZONE): string {
  const day = at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "");
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(scheduleZone && scheduleZone !== localZone ? { timeZoneName: "short" } : {}) });
  return `Next run ${day}, ${time}`;
}

/** The mark a row wears: the trigger that says most about it. */
export function triggerMark(trigger: Automation["trigger"]): Mark {
  switch (trigger.type) {
    case "file":
      return trigger.kinds.includes("github") ? "github" : trigger.kinds.includes("schedule") ? "schedule" : trigger.kinds.includes("webhook") ? "webhook" : "manual";
    case "interval":
    case "daily":
    case "monthly":
    case "cron":
    case "once":
      return "schedule";
    case "webhook":
      return "webhook";
    case "github_mention":
      return "github";
  }
}

export const triggerKinds = (a: Automation): ReadonlyArray<Mark> =>
  a.trigger.type === "file" ? (a.trigger.kinds as ReadonlyArray<Mark>) : ["manual", triggerMark(a.trigger)];

/**
 * On, but its triggers do not fire here: what to call it and why. A Project file off its default branch says so (it
 * has its own fix, a pull request); any other reason the runtime gives reads "Triggers off". Null when they fire, when
 * it is off, or when nothing but a person starts it.
 */
export function triggersOff(a: Automation): { label: string; reason: string } | null {
  if (a.source === "file" && a.worktree) return { label: `Draft on ${a.worktree.branch}`, reason: draftWhy(a) };
  if (a.source !== "file" || !triggerKinds(a).some((k) => k !== "manual")) return null;
  if (offMain(a)) return { label: `Not on ${defaultBranch(a)}`, reason: `Project files trigger from ${defaultBranch(a)} only. Merge this one to turn its triggers on.` };
  return a.enabled && a.triggers_off_reason ? { label: "Triggers off", reason: a.triggers_off_reason } : null;
}

/** The list's Last run cell: running, why its triggers are off, or when it last ran. */
export function lastRunView(a: Automation, now: number): { kind: "running" | "off" | "ago"; text: string; title?: string } {
  if ((a.runs_running ?? 0) > 0) return { kind: "running", text: "Running" };
  const off = triggersOff(a);
  if (off) return { kind: "off", text: off.label, title: off.reason };
  return { kind: "ago", text: ago(a.last_run_at, now) };
}

/** How many of its file's problems are errors (only errors keep it from running) and warnings. */
export function problemsOf(a: Automation): { errors: number; warnings: number } {
  const total = a.diagnostics ?? 0;
  // A runtime that predates `errors` counts every problem; treat them all as errors, as it does.
  const errors = Math.min(total, a.errors ?? total);
  return { errors, warnings: total - errors };
}
export const canRun = (a: Automation) => problemsOf(a).errors === 0;

/** Its manual run asks for something first: its inputs, or the issue or pull request it is about. */
export const needsForm = (a: Automation) => (a.inputs?.length ?? 0) > 0 || a.takes_subject !== undefined;

/** Under the name: project, whose, and what starts it. */
export function subline(a: Automation, projectName: string | undefined): string {
  const whose = isLegacy(a) ? "Saved in the app" : SCOPE_WORD[a.scope ?? "project"];
  return [projectName ?? "Missing project", whose, triggerText(a.trigger)].join(" · ");
}

// ------------------------------------------------------------ numbers

/** Exactly 30 cells, oldest first; days the wire leaves out ran nothing. */
export function stripCells(last30: ReadonlyArray<Day> | undefined): Day[] {
  const days = (last30 ?? []).slice(-30);
  return [...Array<Day>(30 - days.length).fill("none"), ...days];
}

export function stripLabel(cells: ReadonlyArray<Day>): string {
  const worked = cells.filter((c) => c === "worked").length;
  const failed = cells.filter((c) => c === "failed").length;
  if (worked + failed === 0) return "No runs in the last 30 days";
  return `Last 30 days: ${plural(worked, "day")} worked, ${failed} failed`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Measured dollars. "—" when nothing was measured; a sliver under a cent says so instead of rounding to nothing. */
export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

/** 30-day spend: "—" when nothing was spent, so a quiet automation reads as quiet, not as a number. */
export const spendWord = (usd: number | null | undefined) => (usd ? money(usd) : "—");

/** A budget as the file says it: "$6", "$1.50". */
export const budgetWord = (usd: number) => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`);

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const span = (start: string, end: string | null, now: number) => duration((end ? Date.parse(end) : now) - Date.parse(start));

/** "4m ago", "just now", "—" for never. */
export function ago(at: string | null | undefined, now: number): string {
  if (!at) return "—";
  const age = rowAge(at, now);
  return age === "now" ? "just now" : age ? `${age} ago` : "—";
}

// ------------------------------------------------------------ runs

export const RUN_WORD: Record<RunStatus, string> = { queued: "Queued", running: "Running", waiting: "Waiting", succeeded: "Worked", failed: "Failed", cancelled: "Cancelled" };
/** An agent run's one decision, when its agent decides (a review's approve or request_changes). */
export const agentRunDecision = (r: { readonly steps: ReadonlyArray<{ readonly decision?: string | undefined }> }): string | undefined =>
  r.steps.find((s) => s.decision !== undefined)?.decision;
/** What an agent run's row says: a review that asked for changes says so, not "Worked". */
export const agentRunWord = (r: { readonly status: RunStatus; readonly steps: ReadonlyArray<{ readonly decision?: string | undefined }> }): string => {
  const decision = r.status === "succeeded" ? agentRunDecision(r) : undefined;
  if (decision === "request_changes") return "Asked for changes";
  if (decision === "approve") return "Approved";
  return decision !== undefined ? `Decided ${decision.replace(/[_-]/g, " ")}` : RUN_WORD[r.status];
};
export const STEP_WORD: Record<StepStatus, string> = { pending: "Not yet", running: "Running", waiting: "Waiting", succeeded: "Worked", failed: "Failed", skipped: "Skipped", cancelled: "Stopped" };
export const isLive = (s: RunStatus | StepStatus) => s === "queued" || s === "running" || s === "waiting";

/** Why a run, step or attempt ended as it did, said plainly. */
export const REASON: Record<NonNullable<RunRecord["reason"]>, string> = {
  condition_false: "Its condition was false",
  need_not_succeeded: "An earlier step didn't work",
  need_skipped: "An earlier step was skipped",
  need_failed: "An earlier step failed",
  run_cancelled: "Stopped with the run",
  checks_failed: "Checks failed",
  review_rejected: "The reviewer asked for changes",
  agent_error: "The agent stopped with an error",
  timeout: "Ran out of time",
  result_invalid: "Ended without a valid decision",
  budget_exhausted: "Hit its budget",
  cancelled: "Cancelled",
  superseded: "A newer event took its place",
  policy_denied: "A policy refused it",
  deadline: "Hit the 2 hour run limit",
  approval_rejected: "Approval was refused",
  approval_expired: "Approval timed out",
  engine_unavailable: "Its engine isn't available here",
  output_failed: "An output couldn't be written",
  skipped_overlap: "A run on the same subject was still going",
  pick_invalid: "Its pick was invalid",
  not_home: "This repo's automations trigger in GitHub Actions",
  needs_isolation: "Needs an isolated computer",
  outcome_unmet: "Fell short of its rubric",
  start_failed: "Could not start on its computer",
  not_picked: "Another attempt was picked",
};

const EVENT_WORDS: Record<string, string> = {
  "issues.opened": "issue opened",
  "issues.labeled": "issue labelled",
  "pull_request.opened": "pull request opened",
  "pull_request.synchronize": "pull request updated",
  "issue_comment.created": "comment",
  push: "push to the default branch",
  "workflow_run.completed": "CI run finished",
};

/** What started a run, in a few words. */
export function startedBy(trigger: RunRecord["trigger"]): string {
  if (trigger.kind === "manual") return "started by hand";
  if (trigger.kind === "schedule") return "on schedule";
  return (trigger.event && EVENT_WORDS[trigger.event]) ?? trigger.event?.replace(/[._]/g, " ") ?? trigger.kind;
}

/** An agent check's decision in words. */
export const DECISION_WORD: Record<string, string> = { approve: "approved", request_changes: "asked for changes" };

export interface SubjectView {
  /** "#12", "#12 · comment", "ci @ main", "9e04c1a", "By hand". */
  readonly label: string;
  /** The issue or pull request title, commit subject or workflow, when the runtime knew it. */
  readonly title?: string;
  readonly repo?: string;
  readonly url?: string;
}

const REPO = "([\\w.-]+\\/[\\w.-]+)";

/** A trigger subject in words, with its title and its page on GitHub when there is one. */
export function subjectView(subject: string, title?: string, url?: string): SubjectView {
  const view = (label: string, repo?: string, page?: string): SubjectView => ({
    label,
    ...(title ? { title } : {}),
    ...(repo ? { repo } : {}),
    ...((url ?? page) ? { url: (url ?? page)! } : {}),
  });
  let m = new RegExp(`^github:${REPO}#(\\d+)/comment/(\\d+)$`).exec(subject);
  if (m) return view(`#${m[2]} · comment`, m[1], `https://github.com/${m[1]}/issues/${m[2]}#issuecomment-${m[3]}`);
  m = new RegExp(`^github:${REPO}#(\\d+)$`).exec(subject);
  if (m) return view(`#${m[2]}`, m[1], `https://github.com/${m[1]}/issues/${m[2]}`);
  m = new RegExp(`^github:${REPO}@([0-9a-f]{7,40})$`).exec(subject);
  if (m) return view(m[2]!.slice(0, 7), m[1], `https://github.com/${m[1]}/commit/${m[2]}`);
  m = new RegExp(`^github:${REPO}/actions/(\\d+)$`).exec(subject);
  if (m) return view(`CI run ${m[2]}`, m[1], `https://github.com/${m[1]}/actions/runs/${m[2]}`);
  m = new RegExp(`^github:${REPO}/actions/(.+)@(.+)$`).exec(subject);
  if (m) return view(`${m[2]!.replace(/\.ya?ml$/, "")} @ ${m[3]}`, m[1], `https://github.com/${m[1]}/actions`);
  // Cloud's triggers: a Slack thread, a Linear or Jira issue.
  m = /^slack:(#[\w.-]+)/.exec(subject);
  if (m) return view(`Slack ${m[1]}`);
  m = /^(linear|jira):([A-Z][A-Z0-9]*-\d+)$/.exec(subject);
  if (m) return view(m[2]!);
  if (subject === "manual" || subject.startsWith("manual:")) return view("By hand");
  if (subject.startsWith("schedule:")) return view("On schedule");
  return view(subject);
}

/** The inputs a manual run was given, when the runtime says (`trigger.inputs`, not on the wire yet): "issue=1850". */
export function inputsWord(trigger: object): string | null {
  const inputs = (trigger as { inputs?: unknown }).inputs;
  if (!inputs || typeof inputs !== "object") return null;
  const pairs = Object.entries(inputs as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v !== "");
  return pairs.length > 0 ? pairs.map(([k, v]) => `${k}=${String(v)}`).join(", ") : null;
}

/** A subject and its title on one line: "#1841 · Fix the off-by-one". */
export const subjectLine = (v: SubjectView) => (v.title ? `${v.label} · ${v.title}` : v.label);

/** One-step runs of an agent (`caveman-runtime agent run`) belong to an `agent-<name>` automation that has no file. */
export const isAgentRun = (automation: string) => automation.startsWith("agent-");
export const agentOfRun = (automation: string) => automation.slice("agent-".length);

/** What a run is about, as its page's heading: the subject and its title, else what kind of run it was. */
export function runHeading(r: Pick<RunRecord, "automation" | "trigger">): string {
  const v = subjectView(r.trigger.subject, r.trigger.subject_title, r.trigger.subject_url);
  if (isAgentRun(r.automation)) return v.title ?? `${agentOfRun(r.automation)}, run by hand`;
  if (v.repo || v.title) return subjectLine(v);
  return r.trigger.kind === "schedule" ? "A scheduled run" : r.trigger.kind === "manual" ? "A run by hand" : v.label;
}

/** The Attempts tile's note: how many were retries, and how many moved up a class. */
export function attemptsNote(r: Pick<RunRecord, "steps">): string {
  const tried = r.steps.filter((s) => s.attempts.length > 0).length;
  const retries = r.steps.reduce((n, s) => n + s.attempts.length, 0) - tried;
  const up = r.steps.reduce((n, s) => n + s.attempts.filter((a) => a.model.via === "escalate").length, 0);
  if (tried === 0) return "none yet";
  if (retries === 0) return tried === 1 ? "first try" : "each step on its first try";
  return `${retries === 1 ? "1 retry" : `${retries} retries`}${up > 0 ? `, ${up} moved up a class` : ""}`;
}

export const TAKES_WORD = { issue: "issue", pull_request: "pull request", issue_or_pull_request: "issue or pull request" } as const;

/**
 * The subject a manual run names, from what the person typed: "12", "#12", "owner/repo#12" or the issue's or pull
 * request's link. `repo` is the project's own (owner/name). Null for nothing typed.
 */
export function subjectFrom(text: string, repo: string | undefined): { subject: string; number: string } | { error: string } | null {
  const t = text.trim();
  if (!t) return null;
  let m = /^#?(\d+)$/.exec(t);
  if (m) return repo ? { subject: `github:${repo}#${m[1]}`, number: m[1]! } : { error: "This project has no GitHub repository here. Type it as owner/repo#12." };
  m = new RegExp(`^${REPO}#(\\d+)$`).exec(t) ?? new RegExp(`^https?://github\\.com/${REPO}/(?:issues|pull)/(\\d+)\\b`).exec(t);
  if (m) return { subject: `github:${m[1]}#${m[2]}`, number: m[2]! };
  return { error: "Type its number, like 12, or paste its link." };
}

/** The attempt whose chat a step's thread shows: its newest one that has a chat. Null for a step with none (a command). */
export function threadOf<A extends { readonly workspace_id?: string | undefined }>(step: { readonly attempts: ReadonlyArray<A> }): A | null {
  for (let i = step.attempts.length - 1; i >= 0; i--) if (step.attempts[i]!.workspace_id) return step.attempts[i]!;
  return null;
}

/** What started a run, as its line says it: the issue or pull request and its title, else "By hand" or "On schedule". */
export function runWho(r: { readonly automation: string; readonly trigger: { readonly kind: string; readonly event?: string | undefined; readonly subject: string; readonly subject_title?: string | undefined; readonly subject_url?: string | undefined } }): string {
  const v = subjectView(r.trigger.subject, r.trigger.subject_title, r.trigger.subject_url);
  if (v.repo || v.title) return subjectLine(v);
  if (r.trigger.kind === "manual") return isAgentRun(r.automation) ? "Agent run" : "By hand";
  if (r.trigger.kind === "schedule") return "On schedule";
  const said = startedBy(r.trigger as RunRecord["trigger"]);
  return said[0]!.toUpperCase() + said.slice(1);
}

/** The model an attempt asked for and got: "Sonnet 5.5", with its class when it asked for one. */
export function attemptModel(a: Attempt): { cls?: string; model: string; escalated: boolean } {
  const cls = /^(fast|base|frontier|auto)$/.test(a.model.asked) ? a.model.asked : undefined;
  return { ...(cls ? { cls } : {}), model: shortModel(undefined, a.model.resolved) || a.model.resolved, escalated: a.model.via === "escalate" };
}

/** The attempt the person would take over: the newest one of the step that runs now. */
export function liveAttempt(run: RunRecord): { step: string; attempt: Attempt } | null {
  for (const s of run.steps) {
    const last = s.attempts[s.attempts.length - 1];
    if (isLive(s.status) && last) return { step: s.name, attempt: last };
  }
  return null;
}

// ------------------------------------------------------------ list filters

export type Who = "mine" | "all";
export type Where = "this_mac" | "github_actions" | "cloud";
export type State = "on" | "off" | "triggers_off" | "failing" | "errors" | "off_main";
export interface ListFilter {
  readonly query: string;
  readonly who: Who;
  readonly projects: ReadonlyArray<string>;
  readonly triggers: ReadonlyArray<Mark>;
  readonly where: ReadonlyArray<Where>;
  readonly states: ReadonlyArray<State>;
}
export const NO_FILTER: ListFilter = { query: "", who: "all", projects: [], triggers: [], where: [], states: [] };
export const WHERE_WORD: Record<Where, string> = { this_mac: THIS_COMPUTER, github_actions: "GitHub Actions", cloud: "Cloud" };

/** Where its triggers fire: Cloud for a file with `host: cloud`, else This Mac unless the runtime says GitHub Actions. */
export const whereOf = (a: Automation): Where => ((a as { host?: unknown }).host === "cloud" ? "cloud" : (a.runs_on ?? "this_mac"));

export function statesOf(a: Automation): State[] {
  return [
    a.enabled ? "on" : "off",
    ...(triggersOff(a) && !offMain(a) ? (["triggers_off"] as const) : []),
    ...(a.last_status === "failed" ? (["failing"] as const) : []),
    ...(problemsOf(a).errors > 0 ? (["errors"] as const) : []),
    ...(offMain(a) ? (["off_main"] as const) : []),
  ];
}

/** Any of the picked values within a group, every group at once, then the words typed. */
export function filterAutomations(list: ReadonlyArray<Automation>, f: ListFilter, projectName: (id: string) => string | undefined): Automation[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((a) => {
    if (f.who === "mine" && !isMine(a)) return false;
    if (f.projects.length > 0 && !f.projects.includes(a.project_id)) return false;
    if (f.triggers.length > 0 && !triggerKinds(a).some((k) => f.triggers.includes(k) && (k !== "manual" || triggerKinds(a).length === 1))) return false;
    if (f.where.length > 0 && !f.where.includes(whereOf(a))) return false;
    if (f.states.length > 0 && !statesOf(a).some((s) => f.states.includes(s))) return false;
    // The runtime's own words too, so "09:00" finds what the row calls "9:00 AM".
    const raw = a.trigger.type === "file" ? a.trigger.words.join(" ") : "";
    return !q || `${a.title} ${a.description ?? ""} ${a.path ?? ""} ${subline(a, projectName(a.project_id))} ${raw}`.toLowerCase().includes(q);
  });
}

// ------------------------------------------------------------ explain

export interface ModelView {
  readonly cls?: string;
  /** The model's short name ("Sonnet 5.5"), or what stands for it ("auto", "the engine's default"). */
  readonly model: string;
  readonly detail?: string;
}
export interface Lever {
  readonly label: string;
  readonly on: boolean;
  readonly evidence: string;
  /** One of the levers under the engine's harness row (explain's `lever` rows), shown behind Show levers. */
  readonly detail?: true;
}
export interface StepCard {
  readonly name: string;
  readonly source: string;
  readonly agent: { readonly name: string; readonly from?: string; readonly prompt?: string };
  readonly engine: string;
  readonly model: ModelView;
  readonly escalate?: ModelView & { readonly when: string };
  readonly effort?: string;
  readonly computer: { readonly kind: "none" | "readonly" | "full"; readonly words: string };
  readonly attempts: string;
  readonly checks: ReadonlyArray<string>;
  readonly runsIf?: string;
  readonly outputs: ReadonlyArray<string>;
  readonly levers: ReadonlyArray<Lever>;
  /** What it decides: "implement or needs_info". */
  readonly decides?: string;
  /** Each agent check's model, by check: reviewer is "base · Sonnet 5.5" or "the step's model". */
  readonly checkers: Readonly<Record<string, string>>;
}

export const COMPUTER_WORDS = { none: "No checkout", readonly: "Read-only copy", full: "Edits its branch" } as const;

/** A model row's value: "anthropic/claude-sonnet-5-5 (base)", "auto", "fast" when no model is set for the class here. */
/**
 * A model row's value: "base · anthropic/claude-sonnet-5-5" (class first), or the older
 * "anthropic/claude-sonnet-5-5 (base)"; "fast" when no model is set for the class here; "auto".
 */
export function modelView(row: { value: string; detail?: string | undefined } | undefined): ModelView {
  if (!row) return { model: "the engine's default" };
  const short = (id: string) => shortModel(undefined, id) || id;
  const first = /^(fast|base|frontier|auto) · (.+)$/.exec(row.value);
  if (first) return { cls: first[1]!, model: short(first[2]!) };
  const last = /^(.+) \((fast|base|frontier)\)$/.exec(row.value);
  if (last) return { cls: last[2]!, model: short(last[1]!) };
  const unset = /^(fast|base|frontier)(?: \((.+)\))?$/.exec(row.value);
  if (unset) return { cls: unset[1]!, model: unset[2] ? "set when it runs" : "not set here", ...((row.detail ?? unset[2]) ? { detail: (row.detail ?? unset[2])! } : {}) };
  if (row.value === "auto") return { cls: "auto", model: "Caveman Auto" };
  return { model: row.value.includes("/") ? shortModel(undefined, row.value) || row.value : row.value };
}

/** A lever row: "Cache-stable prefix: on" with its evidence as the source. Any key that starts with "lever" counts. */
const lever = (r: { key: string; value: string; source?: string | undefined }): Lever | null => {
  if (!r.key.startsWith("lever")) return null;
  const m = /^(.+?): (on|off)\b\s*(?:[·—,-]\s*(.+))?$/.exec(r.value);
  return m ? { label: m[1]!, on: m[2] === "on", evidence: r.source ?? m[3] ?? "", ...(r.key === "lever" ? { detail: true as const } : {}) } : null;
};

/** explain's "3, at most 30m each" as "Up to 3, 30m each". */
export function attemptsWords(value: string): string {
  const m = /^(\d+), at most (\S+) each$/.exec(value);
  if (!m) return value || "Once";
  return m[1] === "1" ? `Once, up to ${m[2]}` : `Up to ${m[1]}, ${m[2]} each`;
}

/** explain's step rows as the strip's cards. */
export function stepCards(e: AutomationExplanation): StepCard[] {
  return e.steps.map((s) => {
    const row = (key: string) => s.rows.find((r) => r.key === key);
    const agent = row("agent");
    const computer = (row("computer")?.value.split(":")[0] ?? "readonly") as StepCard["computer"]["kind"];
    const escalate = row("escalate");
    const effort = row("effort")?.value;
    const checks = row("checks")?.value;
    return {
      name: s.name,
      source: s.source,
      agent:
        agent?.value === "inline prompt"
          ? { name: "Inline prompt", ...(agent.detail ? { prompt: agent.detail.replace(/^"|"$/g, "") } : {}) }
          : { name: agent?.value ?? "?", ...(agent?.source ? { from: agent.source } : {}) },
      engine: row("engine")?.value ?? "caveman",
      model: modelView(row("model")),
      ...(escalate ? { escalate: { ...modelView(escalate), when: /Attempts [\d-]+/.exec(escalate.detail ?? "")?.[0] ?? escalate.detail ?? "" } } : {}),
      ...(effort && effort !== "engine default" ? { effort } : {}),
      computer: { kind: computer, words: COMPUTER_WORDS[computer] ?? computer },
      attempts: attemptsWords(row("attempts")?.value ?? ""),
      checks: checks ? checks.split(", ").map((c) => c.replace(/^agent:/, "")) : [],
      ...(row("runs if") ? { runsIf: `if ${row("runs if")!.value}` } : {}),
      outputs: s.rows.filter((r) => r.key === "outputs").map((r) => r.value),
      levers: s.rows.map(lever).filter((l): l is Lever => l !== null),
      ...(row("decides") ? { decides: row("decides")!.value } : {}),
      checkers: Object.fromEntries(
        s.rows.flatMap((r) => {
          const c = r.key === "checker" ? /^([^:]+): (.+)$/.exec(r.value) : null;
          if (!c) return [];
          const m = modelView({ value: c[2]! });
          return [[c[1]!, r.source === "the step's model" ? "the step's model" : m.cls ? `${m.cls} · ${m.model}` : m.model]];
        }),
      ),
    };
  });
}

/** explain's header: what the Overview states once, above the steps. */
export function headerFacts(e: AutomationExplanation) {
  const row = (key: string) => e.header.find((r) => r.key === key);
  return {
    description: row("description")?.value,
    triggers: row("triggers")?.value ?? "",
    runsOn: row("runs on")?.value ?? "",
    runsOnDetail: row("runs on")?.detail,
    budget: row("budget")?.value ?? "",
    budgetDetail: row("budget")?.detail,
    worstCase: row("worst case")?.value ?? "",
    worstDetail: row("worst case")?.detail,
    levers: e.header.map(lever).filter((l): l is Lever => l !== null),
  };
}

/** The run budget in dollars from explain's budget row ("$6.00 per run, all attempts"); undefined with none. */
export function budgetUsd(e: AutomationExplanation | undefined): number | undefined {
  const m = /^\$([\d.]+)/.exec(e?.header.find((r) => r.key === "budget")?.value ?? "");
  return m ? Number(m[1]) : undefined;
}

/** "triage decided implement and lint failed" as the connector's parts. */
export function conditionParts(runsIf: string): Array<{ step: string; value: string }> {
  return runsIf
    .replace(/^if /, "")
    .split(" and ")
    .map((c) => /^(\S+) (?:decided (\S+)|(failed))$/.exec(c))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ step: m[1]!, value: m[2] ?? m[3]! }));
}

/** Every lever the steps run with, once each: the header's when one engine runs everything, else the steps'. */
export function leversOf(e: AutomationExplanation): Lever[] {
  const all = [...headerFacts(e).levers, ...stepCards(e).flatMap((s) => s.levers)];
  return all.filter((l, i) => all.findIndex((x) => x.label === l.label) === i);
}

/**
 * "Optimizations here": the one harness row (the engine's every-lever-on summary) by default, its levers as detail
 * behind a disclosure; an engine with no summary row shows its levers as they are. `steps` names the steps they apply
 * to when engines differ (null: every step).
 */
export function leverView(e: AutomationExplanation): { main: Lever[]; detail: Lever[]; steps: string[] | null } {
  const levers = leversOf(e);
  // explain marks the levers under the harness row (`lever`); an older one only names the harness row.
  const main = levers.some((l) => l.detail) ? levers.filter((l) => !l.detail) : levers.filter((l) => /harness/i.test(l.label));
  const everyStep = headerFacts(e).levers.length > 0;
  return {
    main: main.length > 0 ? main : levers,
    detail: main.length > 0 ? levers.filter((l) => !main.includes(l)) : [],
    steps: everyStep ? null : stepCards(e).filter((c) => c.levers.length > 0).map((c) => c.name),
  };
}

/** The agents a file uses, steps' and agent checks', once each. */
export function agentsUsed(e: AutomationExplanation): Array<{ name: string; from?: string }> {
  const out = new Map<string, string | undefined>();
  for (const card of stepCards(e)) {
    if (card.agent.name !== "Inline prompt") out.set(card.agent.name, card.agent.from);
  }
  for (const s of e.steps) {
    const checks = s.rows.find((r) => r.key === "checks")?.value ?? "";
    for (const c of checks.split(", ")) if (c.startsWith("agent:") && !out.has(c.slice(6))) out.set(c.slice(6), undefined);
  }
  return [...out].map(([name, from]) => ({ name, ...(from ? { from } : {}) }));
}

// ------------------------------------------------------------ files

export const SCHEMA_LINE = "# yaml-language-server: $schema=https://caveman.so/schemas/automation-v1.json";
export const NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const agentPath = (name: string) => `.caveman/agents/${name}.md`;
export const automationPath = (scope: Scope, name: string) => `${scope === "me" ? ".caveman/local/automations" : ".caveman/automations"}/${name}.yaml`;

/** An automation file keeps its schema line at the top, so editors check it as it is typed. */
export function withSchemaLine(path: string, text: string): string {
  if (!path.endsWith(".yaml") || text.includes("$schema=")) return text;
  return `${SCHEMA_LINE}\n${text}`;
}

/** A name a file can have, from words: "Fix flaky tests" is fix-flaky-tests. */
export function slug(words: string): string {
  const s = words.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40).replace(/-+$/, "");
  return s || "automation";
}

/** The first of name-copy, name-copy-2, … that isn't taken; the name gets shorter, not the suffix, to stay within 40. */
export function copyName(name: string, taken: ReadonlySet<string | undefined>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const candidate = name.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

const YAML_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A date in `zone` ("YYYY-MM-DD"), from an instant. */
function dayIn(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** A repeat's bounds as file keys: `, start: "…", until: "…", count: n`. */
function yamlEnds(t: { readonly start_at?: string; readonly until?: string; readonly max_runs?: number }, zone: string): string {
  return [
    t.start_at !== undefined ? `, start: "${dayIn(t.start_at, zone)}"` : "",
    t.until !== undefined ? `, until: "${dayIn(t.until, zone)}"` : "",
    t.max_runs !== undefined ? `, count: ${t.max_runs}` : "",
  ].join("");
}

/** An app-saved automation as a one-step file: the same prompt, trigger and project; the model follows the default. */
export function legacyToYaml(a: Automation, timezone: string): string {
  const t = a.trigger;
  const zone = "timezone" in t && t.timezone !== undefined ? t.timezone : timezone;
  const on =
    t.type === "daily"
      ? `on:\n  schedule: { at: "${t.time}", timezone: ${zone}${t.weekdays && t.weekdays.length > 0 && t.weekdays.length < 7 ? `, weekdays: [${[...t.weekdays].sort().map((d) => YAML_WEEKDAYS[d]).join(", ")}]` : ""}${t.every_days !== undefined && t.every_days > 1 ? `, every: ${t.every_days}d` : t.every_weeks !== undefined && t.every_weeks > 1 ? `, every: ${t.every_weeks}w` : ""}${yamlEnds(t, zone)} }\n\n`
      : t.type === "interval"
        ? `on:\n  schedule: { every: ${t.every_minutes % 60 === 0 ? `${t.every_minutes / 60}h` : `${t.every_minutes}m`}${t.start_at !== undefined || t.until !== undefined ? `, timezone: ${zone}` : ""}${yamlEnds(t, zone)} }\n\n`
        : t.type === "monthly"
        ? `on:\n  schedule: { at: "${t.time}", timezone: ${zone}, monthdays: [${t.days.map((d) => (d === -1 ? "last" : String(d))).join(", ")}]${yamlEnds(t, zone)} }\n\n`
        : t.type === "cron"
        ? `on:\n  schedule: { cron: "${t.expression}", timezone: ${zone}${yamlEnds(t, zone)} }\n\n`
        : t.type === "once"
        ? `on:\n  schedule: { once: "${dayIn(t.run_at, zone)} ${new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t.run_at))}", timezone: ${zone} }\n\n`
        : t.type === "github_mention"
          ? `on:\n  github: { event: issue_comment.created, mention: true }\n\n`
          : t.type === "webhook"
            ? "on:\n  webhook: {}\n\n"
            : "";
  const prompt = a.prompt.trim().split("\n").map((l) => `      ${l}`.trimEnd()).join("\n");
  // A JSON string is a YAML double-quoted one, so any title reads back as written.
  return `${SCHEMA_LINE}
version: 1
description: ${JSON.stringify(a.title.trim())}

${on}steps:
  run:
    prompt: |
${prompt}
    computer: full
`;
}

/** 0-based offset of a 1-based line and column in `text`, clamped to the text. */
export function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  const end = text.indexOf("\n", at);
  return Math.min(at + Math.max(0, column - 1), end < 0 ? text.length : end);
}

export function problemCounts(d: ReadonlyArray<AutomationDiagnostic>): { errors: number; warnings: number } {
  const errors = d.filter((x) => x.severity === "error").length;
  return { errors, warnings: d.length - errors };
}

export const problemsWord = (d: ReadonlyArray<AutomationDiagnostic>) => countsWord(problemCounts(d));

/** "2 errors, 1 warning"; "No problems". */
export function countsWord({ errors, warnings }: { errors: number; warnings: number }): string {
  if (errors + warnings === 0) return "No problems";
  return [errors ? plural(errors, "error") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(", ");
}

// ------------------------------------------------------------ deliveries

export type DeliveryTone = "admitted" | "refused" | "ignored";
export interface DeliveryView {
  readonly tone: DeliveryTone;
  /** What happened, in words. */
  readonly words: string;
  /** The runtime's sentence: why, and what to do. */
  readonly detail?: string;
  readonly runId?: string;
  readonly subject?: SubjectView;
  /** "issue labelled", "schedule". */
  readonly event?: string;
}

/** A refused or skipped event's reason (the run reasons, as a trigger meets them), in words. */
const DELIVERY_REASON: Partial<Record<NonNullable<RunRecord["reason"]>, { tone: DeliveryTone; words: string }>> = {
  policy_denied: { tone: "refused", words: "Refused by a safety rule" },
  needs_isolation: { tone: "refused", words: "Refused: it needs an isolated computer" },
  engine_unavailable: { tone: "refused", words: "Refused: its engine isn't available here" },
  budget_exhausted: { tone: "refused", words: "Refused: its budget is used up" },
  not_home: { tone: "ignored", words: "Left to GitHub Actions" },
  skipped_overlap: { tone: "ignored", words: "Skipped: its last run was still going" },
  superseded: { tone: "ignored", words: "Replaced by a newer event" },
};

/** App-saved webhook automations' outcome codes. */
const LEGACY_OUTCOME: Record<string, { tone: DeliveryTone; words: string }> = {
  admitted: { tone: "admitted", words: "Started a run" },
  accepted: { tone: "admitted", words: "Started a run" },
  duplicate: { tone: "ignored", words: "Already handled" },
  // Held with an earlier request; their run uses the latest payload.
  coalesced: { tone: "ignored", words: "Folded into a waiting run" },
  // The runtime's error line names the filter that didn't match.
  filtered: { tone: "ignored", words: "Skipped by its filters" },
  disabled: { tone: "ignored", words: "Ignored: the automation was off" },
  not_home: { tone: "ignored", words: "Left to GitHub Actions" },
  expired: { tone: "refused", words: "Dropped: it waited too long" },
  rate_limited: { tone: "refused", words: "Refused: too many runs at once" },
  rejected_signature: { tone: "refused", words: "Refused: the signature didn't match" },
  dispatch_failed: { tone: "refused", words: "Couldn't start a run" },
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What happened to an event that arrived: a started one links its run, a refused one says why in words (the runtime's
 * sentence beneath), a skipped one is quiet. Reads `status`/`reason`/`run_id`, else the older `started r_…` and
 * `refused: <reason>` outcomes, else an app-saved webhook's outcome code.
 */
export function deliveryView(d: Pick<Delivery, "outcome" | "error"> & Partial<Pick<Delivery, "status" | "reason" | "run_id" | "event" | "subject" | "subject_title">>): DeliveryView {
  const started = /^started(?: (\S+))?$/.exec(d.outcome);
  const refused = /^refused: (\S+)$/.exec(d.outcome);
  const status = d.status ?? (started ? "started" : refused ? "refused" : undefined);
  const reason = d.reason ?? refused?.[1];
  const extra = {
    ...(d.error ? { detail: d.error } : {}),
    ...(d.subject ? { subject: subjectView(d.subject, d.subject_title) } : {}),
    ...(d.event ? { event: d.event === "schedule" ? "schedule" : (EVENT_WORDS[d.event] ?? d.event.replace(/[._]/g, " ")) } : {}),
  };
  if (status === "started") {
    const runId = d.run_id ?? started?.[1];
    return { tone: "admitted", words: "Started a run", ...extra, ...(runId ? { runId } : {}) };
  }
  if (status === "refused" || status === "skipped") {
    const known = reason ? DELIVERY_REASON[reason as keyof typeof DELIVERY_REASON] : undefined;
    if (known) return { ...known, ...extra };
    const runWord = reason && reason in REASON ? REASON[reason as keyof typeof REASON].toLowerCase() : undefined;
    if (status === "skipped") return { tone: "ignored", words: runWord ? `Skipped: ${runWord}` : "Skipped", ...extra };
    // A reason this page has no words for: the runtime's own sentence (outcome) when it sent one.
    return { tone: "refused", words: runWord ? `Refused: ${runWord}` : d.status ? d.outcome : "Refused", ...extra };
  }
  if (LEGACY_OUTCOME[d.outcome]) return { ...LEGACY_OUTCOME[d.outcome]!, ...extra };
  // An outcome this page doesn't know yet: its verb alone when it leads with one (the error line says why), else its words.
  const verb = /^(refused|rejected|denied|ignored|skipped)(?:_|$)/.exec(d.outcome)?.[1];
  if (verb) return { tone: /^(ignored|skipped)$/.test(verb) ? "ignored" : "refused", words: capital(verb), ...extra };
  return { tone: "ignored", words: capital(d.outcome.replace(/_/g, " ")), ...extra };
}

// ------------------------------------------------------------ notices

/** What `automation.create` renamed because the name was taken, as one sentence; null when nothing was. */
export function renamedWords(renamed: ReadonlyArray<{ from: string; to: string }> | undefined): string | null {
  if (!renamed || renamed.length === 0) return null;
  const base = (p: string) => p.split("/").pop() ?? p;
  if (renamed.length === 1) return `${base(renamed[0]!.from)} was taken, so this one is ${base(renamed[0]!.to)}.`;
  return `Some names were taken, so these got new ones: ${renamed.map((r) => base(r.to)).join(", ")}.`;
}

/** What deleting it does: the confirm's sentence, and the notice once it is done. */
export function deleteWords(a: Automation): { confirm: string; done: string } {
  if (onCloudSchedule(a)) return { confirm: "It stops on its Cloud computer. What its runs said in the chat stays.", done: `Deleted ${a.title}.` };
  if (!a.path) return { confirm: "It stops running. Chats it started stay.", done: `Deleted ${a.title}.` };
  if (a.scope === "project" && a.on_default_branch !== false) {
    const branch = defaultBranch(a);
    return {
      confirm: `This deletes ${a.path} from your checkout. ${branch}'s copy stays, and keeps it in this list, until you merge the deletion. Its runs stay in the record.`,
      done: `Deleted here. ${branch}'s copy stays until you merge the deletion.`,
    };
  }
  return { confirm: `This deletes ${a.path}. Its runs stay in the record.`, done: `Deleted ${a.path}.` };
}

// ------------------------------------------------------------ templates

export const TEMPLATE_ORDER = ["Review", "Issues and PRs", "Monitoring", "Chores and reports"] as const;

/** The known categories in their order, then any other a newer runtime sends, in the order it first appears. */
function categories(list: ReadonlyArray<AutomationTemplateSummary>): string[] {
  const known: ReadonlyArray<string> = TEMPLATE_ORDER;
  return [...known, ...new Set(list.map((t) => t.category as string).filter((c) => !known.includes(c)))];
}

/** All, then each category that has templates, with counts. */
export function templateTabs(list: ReadonlyArray<AutomationTemplateSummary>): Array<{ value: string; label: string; count: number }> {
  return [
    { value: "all", label: "All", count: list.length },
    ...categories(list).map((c) => ({ value: c, label: c, count: list.filter((t) => t.category === c).length })).filter((t) => t.count > 0),
  ];
}

/** Where the gallery's templates run: anywhere, This Mac or Cloud (a template's `host`). */
export type TemplateHost = "any" | "this-mac" | "cloud";
const templateHost = (t: AutomationTemplateSummary): "this-mac" | "cloud" => ((t as { host?: unknown }).host === "cloud" ? "cloud" : "this-mac");
export const isCloudTemplate = (t: AutomationTemplateSummary) => templateHost(t) === "cloud";

export function filterTemplates(list: ReadonlyArray<AutomationTemplateSummary>, tab: string, query: string, host: TemplateHost = "any"): AutomationTemplateSummary[] {
  const q = query.trim().toLowerCase();
  const order = categories(list);
  return [...list]
    .filter((t) => (tab === "all" || t.category === tab) && (host === "any" || templateHost(t) === host) && (!q || `${t.title} ${t.summary} ${t.chips.join(" ")}`.toLowerCase().includes(q)))
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}
