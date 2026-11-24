// Automations and agent files, as the desktop's pages read them from the runtime (apps/web/src/routes/automations/
// model.ts and cloud.ts). The prototype has no runtime, so these stand in: a few automations in each state the list
// draws (running, failing, waiting for main, at rest, paused), each with its runs, and the agent files beside them,
// each with its tools, its instructions and the chats that used it. What a page says about either comes from the
// functions here, so the list, the opened page, the sidebar's count and Home's tile never disagree.
import type { Effort, Engine, Step } from "../../board/model";

export type RunStatus = "running" | "succeeded" | "failed" | "queued" | "cancelled";

/** How a run went, in the desktop's words (RUN_WORD). */
export const RUN_WORD: Record<RunStatus, string> = { queued: "Queued", running: "Running", succeeded: "Worked", failed: "Failed", cancelled: "Cancelled" };

export interface Run {
  id: string;
  status: RunStatus;
  /** What started it: "On schedule", "By hand", "#479 updated". */
  who: string;
  startedAt: number;
  /** How long it took, once it ended. */
  took?: number;
  model: string;
  steps: readonly Step[];
  /** The live line while it runs. */
  live?: string;
  /** What it does or did, in a few words, as a run list names a run ("Reviewing #479", "Reviewed #476"). */
  title?: string;
  /** Its closing words. */
  summary?: string;
  /**
   * Why it failed (Thread.tsx Why): the reason, the step it failed in, that step's own words, what it printed, and the
   * one thing that fixes it, which starts a chat in the automation's project to do it.
   */
  why?: { reason: string; step?: string; words?: string; output?: string; fix?: { label: string; prompt: string } };
}

export interface Automation {
  id: string;
  title: string;
  /** The line under its name: what it does. */
  description: string;
  project: string;
  path: string;
  engine: Engine;
  model: string;
  enabled: boolean;
  /** What starts it, in words, the first trigger; `more` counts the rest. */
  trigger: string;
  more?: number;
  whose: "me" | "project";
  /** Your Mac or a Cloud computer, named by board/places.ts runsOnName. */
  where: "mac" | "cloud";
  nextRunAt?: number;
  /** On, but nothing fires it yet, and why (triggersOff). */
  off?: { label: string; reason: string };
  /** What it was told to do. */
  prompt: string;
  /** The agent file its step runs, by name, in its own project's `.caveman/agents`. */
  agent?: string;
  runs: readonly Run[];
}

const minute = 60_000;
const hour = 60 * minute;

/** The next weekday at hh:mm, or the next of the given weekdays (0 is Sunday). */
export function next(now: number, hh: number, mm: number, days = [1, 2, 3, 4, 5]): number {
  const at = new Date(now);
  at.setHours(hh, mm, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (at.getTime() > now && days.includes(at.getDay())) return at.getTime();
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

export function startingAutomations(now: number): Automation[] {
  return [
    {
      id: "pr-review",
      title: "Review new pull requests",
      description: "Reads each new pull request and leaves a first review before anyone looks.",
      project: "caveman-code",
      path: ".caveman/automations/pr-review.md",
      engine: "claude",
      model: "Sonnet 5.5",
      enabled: true,
      trigger: "Pull request opened or updated",
      whose: "project",
      where: "mac",
      prompt: "Read the pull request and its checks. Leave one review: what it changes, anything that looks wrong, and what to test.",
      agent: "reviewer",
      runs: [
        {
          id: "r-pr-3",
          status: "running",
          who: "#479 updated",
          startedAt: now - 2 * minute,
          model: "Sonnet 5.5",
          steps: [
            { tool: "read", text: "Read the pull request", detail: "#479 Settings: archive after a quiet week" },
            { tool: "read", text: "Read 2 files", detail: "Archive.tsx, archived.ts" },
          ],
          live: "Reading apps/web/src/state/archived.ts",
          title: "Reviewing #479",
        },
        {
          id: "r-pr-2",
          status: "succeeded",
          who: "#476 opened",
          startedAt: now - 3 * hour,
          took: 3 * minute + 12_000,
          model: "Sonnet 5.5",
          steps: [
            { tool: "read", text: "Read the pull request", detail: "#476 Paste images into the box" },
            { tool: "read", text: "Read 3 files", detail: "Composer.tsx, paste.ts, paste.test.ts" },
            { tool: "run", text: "Ran pnpm vitest run paste", detail: "4 passed" },
          ],
          title: "Reviewed #476",
          summary: "Left a review on #476: the paste handler drops the file name; the test covers one image, not several.",
        },
        {
          id: "r-pr-1",
          status: "succeeded",
          who: "#471 updated",
          startedAt: now - 9 * hour,
          took: 2 * minute + 41_000,
          model: "Sonnet 5.5",
          steps: [],
          title: "Approved #471",
          summary: "One note on the rail's empty state: it should say what to do next, not only that nothing is there.",
        },
      ],
    },
    {
      id: "dependency-check",
      title: "Dependency check",
      description: "Looks for outdated and vulnerable packages and opens one pull request for the safe bumps.",
      project: "Caveman Cloud",
      path: ".caveman/automations/dependency-check.md",
      engine: "codex",
      model: "GPT-5.5",
      enabled: true,
      trigger: "Every night at 2:00 AM",
      whose: "me",
      where: "mac",
      nextRunAt: next(now, 2, 0, [0, 1, 2, 3, 4, 5, 6]),
      prompt: "Check every package for updates and advisories. Bump what is safe in one pull request; list the rest.",
      runs: [
        {
          id: "r-dep-2",
          status: "failed",
          who: "On schedule",
          startedAt: now - 6 * hour,
          took: 48_000,
          model: "GPT-5.5",
          steps: [
            { tool: "run", text: "Ran pnpm outdated", detail: "14 packages behind" },
            { tool: "run", text: "Ran pnpm install", detail: "exit 1" },
          ],
          title: "The lockfile is out of date",
          why: {
            reason: "The command failed",
            step: "install",
            words: "pnpm install exited 1: the lockfile is out of date with package.json",
            output: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
            fix: {
              label: "Update the lockfile",
              prompt:
                "Dependency check failed last night: pnpm install exited 1 because pnpm-lock.yaml is out of date with package.json. Run pnpm install, commit the new lockfile on a branch, and open a pull request.",
            },
          },
        },
        {
          id: "r-dep-1",
          status: "succeeded",
          who: "On schedule",
          startedAt: now - 30 * hour,
          took: 4 * minute + 5_000,
          model: "GPT-5.5",
          steps: [
            { tool: "run", text: "Ran pnpm outdated", detail: "9 packages behind" },
            { tool: "edit", text: "Edited package.json and pnpm-lock.yaml", detail: "6 bumps" },
            { tool: "run", text: "Ran pnpm test", detail: "212 passed" },
          ],
          title: "Opened #607 with 6 safe bumps",
          summary: "Six patch and minor bumps, tests green. Two majors wait for you: **zod 4** and **vitest 4**.",
        },
      ],
    },
    {
      id: "morning-summary",
      title: "Morning summary",
      description: "What changed overnight, what waits on you, and what's next, in one note.",
      project: "caveman-code",
      path: ".caveman/automations/morning-summary.md",
      engine: "caveman",
      model: "Auto",
      enabled: true,
      trigger: "Weekdays at 8:30 AM",
      whose: "me",
      where: "mac",
      nextRunAt: next(now, 8, 30),
      prompt: "Read what merged, what failed and what waits on me since yesterday. Write it as one short note, most pressing first.",
      runs: [
        {
          id: "r-ms-3",
          status: "succeeded",
          who: "On schedule",
          startedAt: now - 3 * hour,
          took: 72_000,
          model: "Opus 5.5",
          steps: [
            { tool: "search", text: "Searched merged pull requests", detail: "6 results" },
            { tool: "read", text: "Read the CI history", detail: "caveman-code, Caveman Cloud" },
            { tool: "read", text: "Read 5 chats", detail: "the board" },
          ],
          title: "2 merged, 1 waits on you",
          summary:
            "Good morning. Overnight:\n\n- **2 pull requests merged**: Chief rail redesign (#471) and adm-zip under onnxruntime (#468)\n- **Usage table migration** waits on you: it wants to run on staging\n- CI stayed green on main all night\n\nNext: Dark mode for Runs should be ready to look at before lunch.",
        },
        { id: "r-ms-2", status: "succeeded", who: "On schedule", startedAt: now - 27 * hour, took: 64_000, model: "Opus 5.5", steps: [], summary: "Quiet night: one merge, nothing waits on you." },
        { id: "r-ms-1", status: "succeeded", who: "By hand", startedAt: now - 50 * hour, took: 81_000, model: "Opus 5.5", steps: [], summary: "Three merges, and the relay test flaked twice." },
      ],
    },
    {
      id: "release-notes",
      title: "Release notes",
      description: "Writes what changed for the people using the app, from the merged pull requests.",
      project: "caveman-code",
      path: ".caveman/automations/release-notes.md",
      engine: "caveman",
      model: "Auto",
      enabled: true,
      trigger: "Fridays at 4:00 PM",
      more: 1,
      whose: "project",
      where: "mac",
      off: { label: "Not on main", reason: "Project files trigger from main only. Merge this one to turn its triggers on; Run now works already." },
      prompt: "Read the pull requests merged since the last release. Write releases/<version>.md for the people using the app: what they can do now, in plain words.",
      runs: [],
    },
    {
      id: "flaky-watch",
      title: "Flaky test watch",
      description: "When a test fails twice on main, finds out why and opens a fix.",
      project: "Caveman Cloud",
      path: ".caveman/automations/flaky-watch.md",
      engine: "claude",
      model: "Opus 5.5",
      enabled: false,
      trigger: "When CI fails twice",
      whose: "me",
      where: "mac",
      prompt: "Find the test that failed twice, run it 50 times, and fix what makes it flaky.",
      runs: [
        {
          id: "r-fw-1",
          status: "succeeded",
          who: "CI failed twice",
          startedAt: now - 4 * 24 * hour,
          took: 11 * minute,
          model: "Opus 5.5",
          steps: [
            { tool: "run", text: "Ran go test ./relay -run Reconnect -count 50", detail: "7 failed" },
            { tool: "edit", text: "Edited relay/reconnect_test.go", detail: "a fake clock" },
            { tool: "run", text: "Ran go test ./relay -run Reconnect -count 50", detail: "50 passed" },
          ],
          title: "Opened #598 with a fake clock",
          summary: "The relay reconnect test raced its own timer. With a fake clock it passed 50 runs in a row.",
        },
      ],
    },
  ];
}

/** The ring's tone in the list: running, something wrong (red), on but not firing (amber), or at rest. */
export type Tone = "running" | "error" | "warn" | "idle";

export function toneOf(a: Automation): Tone {
  if (a.runs[0]?.status === "running") return "running";
  if (a.enabled && a.runs[0]?.status === "failed") return "error";
  if (a.enabled && a.off) return "warn";
  return "idle";
}

/**
 * Its status for the opened page (Detail.tsx statusOf): the word, its dot's colour key, and a note on why. On, with its
 * newest run failed, it says so in red, as its row in the list does, rather than a green Active over a red run.
 */
export function statusOf(a: Automation): { word: string; tone: "success" | "warning" | "muted" | "destructive"; note?: string } {
  if (!a.enabled) return { word: "Paused", tone: "muted" };
  if (a.off) return { word: a.off.label, tone: "warning", note: a.off.reason };
  if (a.runs[0]?.status === "failed") return { word: "Last run failed", tone: "destructive" };
  return { word: "Active", tone: "success" };
}

/**
 * What the opened page says under its name, after the status word: when it runs next, or what starts it when an event
 * does, or why it doesn't. Paused, it says Run now still works, since that is the one thing that still does.
 */
export function statusRest(a: Automation, when: (at: number) => string = whenWord): string {
  if (!a.enabled) return "Run now still works";
  if (a.off) return "Its triggers wait";
  if (a.nextRunAt) return `Next run ${when(a.nextRunAt)}`;
  return a.more ? `${a.trigger} +${a.more}` : a.trigger;
}

/** "Mon Oct 26, 9:00 AM" (nextRunWord). */
export function whenWord(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "");
  return `${day}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Markdown down to its words: no emphasis, code ticks, links or list marks. */
const plain = (text: string) =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();

/**
 * What a run did, in one line, as a CI list names a run: its title ("Reviewing #479", "Reviewed #476"), else its live
 * words while it runs, else the one thing wrong when it failed, else the first sentence of its closing words, else how
 * it went.
 */
export function runHeadline(r: Run): string {
  if (r.title) return r.title;
  if (r.status === "running" || r.status === "queued") return r.live ?? RUN_WORD[r.status];
  if (r.status === "failed") return r.why?.words ?? r.why?.reason ?? RUN_WORD.failed;
  if (r.summary) {
    const words = plain(r.summary).split("\n")[0]!;
    const sentence = words.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? words;
    if (sentence) return sentence.replace(/[.:]$/, "");
  }
  return RUN_WORD[r.status];
}

/**
 * The run that shows open on the page: the one tapped, while it is still there, else the newest. Tapping the open one
 * again folds it, which `null` keeps.
 */
export function openRunOf(runs: readonly Run[], picked: string | null | undefined): string | null {
  if (picked === null) return null;
  if (picked && runs.some((r) => r.id === picked)) return picked;
  return runs[0]?.id ?? null;
}

/**
 * What Delete says before and after (model.ts deleteWords): a project's file stays on main until the deletion merges;
 * yours goes at once. Either way its runs stay in the record.
 */
export function deleteWords(a: Automation): { confirm: string; done: string } {
  if (a.whose === "project")
    return {
      confirm: `This deletes ${a.path} from your checkout. main's copy stays, and keeps it in this list, until you merge the deletion. Its runs stay in the record.`,
      done: "Deleted here. main's copy stays until you merge the deletion.",
    };
  return { confirm: `This deletes ${a.path}. Its runs stay in the record.`, done: `Deleted ${a.path}.` };
}

/** When it runs, as New automation offers it (draft.ts PRESET, GITHUB): the chip's words and when that next comes. */
export const WHEN = {
  weekdays: { label: "Every weekday", chip: "Weekdays at 9:00 AM", next: (now: number) => next(now, 9, 0) },
  daily: { label: "Every day", chip: "Daily at 9:00 AM", next: (now: number) => next(now, 9, 0, [0, 1, 2, 3, 4, 5, 6]) },
  weekly: { label: "Every Monday", chip: "Mondays at 9:00 AM", next: (now: number) => next(now, 9, 0, [1]) },
  pull_request: { label: "A pull request opens", chip: "On new pull requests", next: null },
  issue: { label: "An issue opens", chip: "On new issues", next: null },
  manual: { label: "By hand only", chip: "By hand only", next: null },
} as const satisfies Record<string, { label: string; chip: string; next: ((now: number) => number) | null }>;
export type When = keyof typeof WHEN;

/** Where a trigger comes from, for its mark: GitHub for its events, the clock for a schedule, a hand for Run now only. */
export function triggerKind(trigger: string): "github" | "schedule" | "manual" | "event" {
  if (/pull request|issue|#\d/i.test(trigger)) return "github";
  if (/by hand/i.test(trigger)) return "manual";
  if (/\d:\d\d|daily|weekly|every|weekdays|mondays|fridays/i.test(trigger)) return "schedule";
  return "event";
}

// ---------------------------------------------------------------- agent files

/** One thing an agent may do (its file's `tools:`), as a kind with a mark, its name, and what it covers. */
export interface AgentTool {
  kind: "read" | "search" | "edit" | "run" | "web" | "mcp";
  label: string;
  /** What it covers: the commands it may run, the files it may write, what a connector lets it do. */
  detail?: string;
  /** A connector's vendor, whose logo it wears (GitHub, Linear). */
  brand?: "github" | "linear" | "slack";
}

/** A chat that used an agent, outside any automation. */
export interface AgentChat {
  id: string;
  status: RunStatus;
  /** What it did there, in a few words. */
  title: string;
  /** The chat it was in, by its title. */
  chat: string;
  at: number;
  took?: number;
}

export interface AgentFile {
  name: string;
  description: string;
  project: string;
  path: string;
  /** The harness, as the engines name it ("claude-agent", "codex", "caveman"). */
  engine: string;
  model: string;
  effort?: Effort;
  /** The version Caveman Cloud runs (none until it is published), and whether the file here has changed since. */
  cloud: { version?: number; changed?: boolean };
  tools: readonly AgentTool[];
  /** The file's body: what it is told, in its own Markdown. */
  instructions: string;
  /** The words its last line may end with; steps after it run on them. */
  decides?: readonly string[];
  chats: readonly AgentChat[];
}

export function startingAgents(now: number): AgentFile[] {
  return [
    {
      name: "reviewer",
      description: "Reviews a pull request the way the team does: correctness first, then tests, then names.",
      project: "caveman-code",
      path: ".caveman/agents/reviewer.md",
      engine: "claude-agent",
      model: "Sonnet 5.5",
      effort: "high",
      cloud: { version: 3 },
      tools: [
        { kind: "read", label: "Read", detail: "Any file in the repo" },
        { kind: "search", label: "Search", detail: "The code and its history" },
        { kind: "run", label: "Run", detail: "git diff, pnpm vitest" },
        { kind: "mcp", label: "GitHub", detail: "Read pull requests, leave reviews", brand: "github" },
      ],
      instructions:
        "Review the pull request you are given.\n\n1. **Correctness first**: does it do what its description says, and nothing else?\n2. **Tests**: is the new behaviour covered, and does a failing test say why?\n3. **Names**: would a newcomer understand each new name without reading its body?\n\nLeave one review. Say what to change and why, never how it would look if you'd written it.",
      chats: [{ id: "c-rv-1", status: "succeeded", title: "Second look at #468", chat: "adm-zip under onnxruntime", at: now - 26 * hour, took: 2 * minute + 5_000 }],
    },
    {
      name: "triage",
      description: "Reads a new issue, finds where it lives, and labels it.",
      project: "Caveman Cloud",
      path: ".caveman/agents/triage.md",
      engine: "caveman",
      model: "Auto",
      cloud: { version: 1, changed: true },
      tools: [
        { kind: "read", label: "Read", detail: "Any file in the repo" },
        { kind: "search", label: "Search", detail: "The code" },
        { kind: "mcp", label: "GitHub", detail: "Read issues, add labels", brand: "github" },
      ],
      instructions:
        "Read the issue. Find the package it is about and say so in one line. Label it with its area and one of bug, feature or question. End on that word alone.",
      decides: ["bug", "feature", "question"],
      chats: [
        { id: "c-tr-3", status: "succeeded", title: "Labelled #1841 relay, bug", chat: "Triage this morning's issues", at: now - 70 * minute, took: 38_000 },
        { id: "c-tr-2", status: "succeeded", title: "Labelled #1838 docs, question", chat: "Triage this morning's issues", at: now - 72 * minute, took: 41_000 },
        { id: "c-tr-1", status: "failed", title: "GitHub refused the label: no write access", chat: "Label the backlog", at: now - 2 * 24 * hour, took: 12_000 },
      ],
    },
    {
      name: "release-writer",
      description: "Turns merged pull requests into notes for the people using the app.",
      project: "marketing",
      path: ".caveman/agents/release-writer.md",
      engine: "codex",
      model: "GPT-5.5",
      effort: "medium",
      cloud: {},
      tools: [
        { kind: "read", label: "Read", detail: "Any file in the repo" },
        { kind: "edit", label: "Edit", detail: "releases/*.md" },
        { kind: "mcp", label: "GitHub", detail: "Read merged pull requests", brand: "github" },
      ],
      instructions: "Read the pull requests merged since the last release. Write what the people using the app can do now, in plain words, one line each. Leave out what they can't see.",
      chats: [],
    },
  ];
}

/** The version Cloud runs, in words, its tone, and what Publish would make ("Publish v2"); null when Cloud has this file. */
export function cloudOf(f: AgentFile): { label: string; tone: "same" | "changed" | "none"; action: string | null } {
  const v = f.cloud.version;
  if (!v) return { label: "Not published", tone: "none", action: "Publish" };
  if (f.cloud.changed) return { label: `v${v}, changed here`, tone: "changed", action: `Publish v${v + 1}` };
  return { label: `v${v}`, tone: "same", action: null };
}

/** The file once Publish has sent it: Cloud runs it as the next version. */
export function published(f: AgentFile): AgentFile {
  return { ...f, cloud: { version: (f.cloud.version ?? 0) + 1, changed: false } };
}

/** One thing an agent did, in an automation's run or in a chat. */
export interface Activity {
  id: string;
  status: RunStatus;
  title: string;
  /** Where it did it: the automation's name, or the chat's. */
  via: string;
  /** The automation, by id, when it was one: its row opens it. */
  automation?: string;
  at: number;
  took?: number;
}

/**
 * What an agent has been doing, newest first: every run of the automations in its project whose step runs it, and the
 * chats that used it.
 */
export function activityOf(f: AgentFile, all: readonly Automation[]): Activity[] {
  const runs: Activity[] = all
    .filter((a) => a.agent === f.name && a.project === f.project)
    .flatMap((a) => a.runs.map((r) => ({ id: r.id, status: r.status, title: runHeadline(r), via: a.title, automation: a.id, at: r.startedAt, ...(r.took !== undefined ? { took: r.took } : null) })));
  const chats: Activity[] = f.chats.map((u) => ({ id: u.id, status: u.status, title: u.title, via: u.chat, at: u.at, ...(u.took !== undefined ? { took: u.took } : null) }));
  return [...runs, ...chats].sort((x, y) => y.at - x.at);
}
