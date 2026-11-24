// Caveman Cloud on the Automations pages: what the runtime's Cloud methods answer (CONTRACT §9, served once the
// runtime is signed in to Cloud) and what the pages say about it. Where an automation runs, what deploying it did,
// Cloud's runs beside This Mac's, a run's approval gate, an agent's published version and the console's pages.
// Plain functions over the automations v2 wire shapes (automation.apply, cloud_list, cloud_runs, cloud_answer,
// approve, agent.publish, agent.published), tested in cloud.test.ts.
import type { CloudAgent, CloudAuthorityDiff, CloudAutomation, CloudAutomationApplied, CloudAutomationRun } from "@caveman-app/session-protocol";
import { ago, REASON, type Automation, type RunRecord, type RunStatus, type RunSummary, type StepStatus } from "./model.ts";
import { thisComputer } from "../../lib/platform.ts";

// ------------------------------------------------------------ the wire

export type Host = "this-mac" | "cloud";
export type AuthorityDiff = CloudAuthorityDiff;
export type AuthorityChange = CloudAuthorityDiff["changes"][number];

/** What `automation.apply` made of one `host: cloud` file, with when this computer sent it (kept here, so never its hook). */
export type Applied = Omit<CloudAutomationApplied, "authority_diff" | "hook"> & {
  /** Absent in Cloud's list for a revision with nothing pending. */
  readonly authority_diff?: AuthorityDiff;
  readonly path?: string;
  readonly enabled?: boolean;
  readonly repo?: string;
  readonly applied_at?: string;
  /** Deployed from this computer (its answer kept here), not read from Cloud's list. */
  readonly from_here?: boolean;
};

/** A Cloud-hosted automation as Cloud holds it (`automation.cloud_list`). */
export type { CloudAutomation };

/** What a Cloud run waits on a person for. */
export type CloudAsk = NonNullable<CloudAutomationRun["requires_action"]>;

/** A Cloud run as the pages read it. */
export interface CloudRun {
  readonly run_id: string;
  readonly automation_id: string;
  /** The automation's name, when Cloud said it. */
  readonly automation?: string;
  readonly repo?: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly trigger: { readonly kind: string; readonly event?: string; readonly subject?: string; readonly subject_title?: string };
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly cost_usd: number | null;
  readonly session_id: string | null;
  readonly requires_action?: CloudAsk;
}

/** One of the org's agents on Cloud (`agent.published`). */
export type PublishedAgent = CloudAgent;

/** The runtime has no such method (an older runtime): the page leaves Cloud out instead of showing an error. */
export const notServed = (e: unknown) => {
  const err = (e as { error?: { code?: number; data?: { reason?: string } } })?.error;
  return err?.code === -32601 || err?.data?.reason === "unsupported";
};

/** Cloud refused the person's sign-in: the fix is to sign in again, in Settings > Account. */
export const signedOut = (e: unknown) => (e as { error?: { data?: { reason?: string } } })?.error?.data?.reason === "cloud_unauthorized";

// ------------------------------------------------------------ where it runs

/** A file's `host:`; This Mac when it names none. */
export const hostOf = (x: object): Host => ((x as { host?: unknown }).host === "cloud" ? "cloud" : "this-mac");
export const isCloud = (a: Automation) => a.source === "file" && hostOf(a) === "cloud";

// ------------------------------------------------------------ deploying

export interface DeployView {
  readonly kind: "none" | "active" | "pending" | "superseded" | "unknown";
  readonly title: string;
  readonly detail: string;
  /** Widening changes first. */
  readonly changes: ReadonlyArray<AuthorityChange>;
}

/** A diff's changes; none when Cloud sent no diff. */
export const changesOf = (diff: AuthorityDiff | undefined): ReadonlyArray<AuthorityChange> => diff?.changes ?? [];

/** What the Cloud panel says about one automation: not deployed, running a revision, or holding one for approval. */
export function deployView(cloud: Applied | CloudAutomation | undefined, now: number): DeployView {
  const changes = [...changesOf(cloud?.authority_diff)].sort((a, b) => Number(b.widens) - Number(a.widens));
  if (!cloud) {
    return {
      kind: "none",
      title: "Not on Cloud yet",
      detail: `Deploy sends this file and the agents it names. Cloud then fires its triggers and runs it on its own computers, with ${thisComputer} closed.`,
      changes: [],
    };
  }
  const appliedAt = "applied_at" in cloud ? cloud.applied_at : undefined;
  const when = appliedAt ? `deployed${"from_here" in cloud && cloud.from_here ? " from here" : ""} ${ago(appliedAt, now)}` : "";
  const rev = cloud.revision_id ? `Revision ${shortRevision(cloud.revision_id)}${when ? `, ${when}` : ""}` : when ? when.charAt(0).toUpperCase() + when.slice(1) : "Deployed";
  if (cloud.state === "pending_approval") {
    return {
      kind: "pending",
      title: "Waiting for approval",
      detail: `${rev}. It can do more than the version Cloud runs now, so its owner approves it in Caveman Platform first. Until then Cloud keeps the last approved version.`,
      changes,
    };
  }
  if (cloud.state === "superseded") return { kind: "superseded", title: "Replaced", detail: `${rev}. A newer revision took its place.`, changes };
  if (cloud.state === "removed") return { kind: "none", title: "Stopped on Cloud", detail: "The last deploy no longer carried this file, so Cloud stopped it. Deploy sends it again.", changes: [] };
  if (cloud.state === "unchanged") return { kind: "active", title: "On Cloud", detail: `${rev}. Cloud already runs these exact files.`, changes };
  return { kind: "active", title: "On Cloud", detail: changes.length > 0 ? `${rev}. Nothing it may do grew, so it runs as deployed.` : `${rev}.`, changes };
}

/** Nothing was deployed from here and this runtime cannot list Cloud's automations: Cloud may hold it (a merge applies it). */
export function unlistedView(branch: string): DeployView {
  return {
    kind: "unknown",
    title: "Runs on Cloud",
    detail: `Cloud takes it in when it reaches ${branch}. Deploy sends it now and shows what Cloud did with it.`,
    changes: [],
  };
}

/** Cloud's list did not answer and nothing was deployed from here: what Cloud holds is not known, so not "not deployed". */
export function unreadView(error: string): DeployView {
  return { kind: "unknown", title: "Can't see Cloud's copy", detail: `${error} Deploy still works once Cloud answers.`, changes: [] };
}

/** `rev_01jc2k…` as its last 7 characters, a sha256 as its first 7. */
export function shortRevision(id: string): string {
  const hex = /^(?:sha256:)?([0-9a-f]{12,})$/.exec(id);
  if (hex) return hex[1]!.slice(0, 7);
  return id.length > 10 ? id.slice(-7) : id;
}

/** An authority key in words: `on.github` is "Trigger: github", `steps.implement.engine` is "implement's engine". */
export function authorityWord(key: string): string {
  const step = /^steps\.([^.]+)\.(engine|agent|model)$/.exec(key);
  if (step) return `${step[1]}'s ${step[2]}`;
  const head = /^(on|outputs)\.(.+)$/.exec(key);
  if (head) return `${head[1] === "on" ? "Trigger" : "Output"}: ${head[2]}`;
  const words: Record<string, string> = { host: "Runs on", secrets: "Secrets", budget: "Budget", on: "Triggers", outputs: "Outputs" };
  return words[key] ?? key;
}

/** What one change did, in words: "added", "removed", or the value it had. */
export const beforeWord = (c: AuthorityChange) => c.before ?? "none";
export const afterWord = (c: AuthorityChange) => c.after ?? "removed";

/** The apply result for one automation: by file path when Cloud says it, else by name. */
export function appliedFor(list: ReadonlyArray<Applied>, a: Pick<Automation, "path" | "title">, name: string): Applied | undefined {
  return list.find((x) => (x.path && a.path ? x.path === a.path : x.name === name));
}

/** Cloud's copy of one of this repo's automations. */
export const cloudFor = (list: ReadonlyArray<CloudAutomation>, repo: string | undefined, name: string) =>
  list.find((x) => x.name === name && (!repo || !x.repo || x.repo.toLowerCase() === repo.toLowerCase()));

/** One sentence after Deploy: what Cloud did with the files it got. */
export function deployedWords(list: ReadonlyArray<Applied>): string {
  if (list.length === 0) return "Cloud found no host: cloud automations in this repo.";
  if (list.every((x) => x.state === "unchanged")) return list.length === 1 ? `Cloud already runs this version of ${list[0]!.name}.` : "Cloud already runs these versions.";
  const removed = list.filter((x) => x.state === "removed");
  if (removed.length === list.length) return `Cloud stopped ${list.map((x) => x.name).join(", ")}: this deploy no longer carries ${removed.length === 1 ? "its file" : "their files"}.`;
  const pending = list.filter((x) => x.state === "pending_approval");
  const names = (xs: ReadonlyArray<Applied>) => xs.map((x) => x.name).join(", ");
  if (pending.length === 0) return list.length === 1 ? `Deployed ${list[0]!.name} to Cloud.` : `Deployed ${list.length} automations to Cloud: ${names(list)}.`;
  if (pending.length === list.length) return `${names(pending)} ${pending.length === 1 ? "waits" : "wait"} for approval in Caveman Platform.`;
  return `Deployed ${names(list.filter((x) => x.state !== "pending_approval"))}. ${names(pending)} ${pending.length === 1 ? "waits" : "wait"} for approval.`;
}

/** A webhook trigger Cloud just made: where a sender posts, and the secret it signs each body with. Shown once. */
export interface HookShown {
  readonly automation: string;
  readonly url: string;
  readonly secret: string;
}

/**
 * A Deploy's answer in two parts: what this computer keeps about each automation, with no secret in it, and each new
 * webhook's URL and secret, which Cloud says this once and the page shows until it is closed.
 */
export function readApplied(
  answer: { readonly repo: string; readonly automations: ReadonlyArray<CloudAutomationApplied> },
  at: string,
  consoleBase: string,
): { readonly kept: ReadonlyArray<Applied>; readonly hooks: ReadonlyArray<HookShown> } {
  const kept: Applied[] = [];
  const hooks: HookShown[] = [];
  for (const { hook, ...x } of answer.automations) {
    kept.push({ ...x, applied_at: at, from_here: true, repo: answer.repo });
    if (hook) hooks.push({ automation: x.name, url: consoleUrl(consoleBase, hook.path), secret: hook.secret });
  }
  return { kept, hooks };
}

// ------------------------------------------------------------ runs, merged

/** A Cloud run's status: a This Mac run's, or `skipped` (a trigger fired while its last run on the subject still went). */
export type CloudRunStatus = RunStatus | "skipped";

const RUN_STATUSES: ReadonlyArray<CloudRunStatus> = ["queued", "running", "waiting", "succeeded", "failed", "cancelled", "skipped"];

/** A Cloud run's status in this page's words; a session's own words map onto them. */
export function cloudStatus(s: string): CloudRunStatus {
  if ((RUN_STATUSES as ReadonlyArray<string>).includes(s)) return s as CloudRunStatus;
  if (s === "requires_action" || s === "pending_approval") return "waiting";
  if (s === "starting") return "queued";
  if (s === "idle" || s === "completed") return "succeeded";
  if (s === "terminated" || s === "error") return "failed";
  if (s === "interrupted") return "cancelled";
  return "running";
}

/** A run as the runtime sent it, in the pages' terms: its trigger split, its times and cost settled. */
export function readCloudRun(w: CloudAutomationRun): CloudRun {
  const dot = w.trigger.indexOf(".");
  return {
    run_id: w.id,
    automation_id: w.automation_id,
    ...(w.name ? { automation: w.name } : {}),
    ...(w.repo ? { repo: w.repo } : {}),
    status: w.status,
    outcome: w.outcome,
    trigger: dot < 0 ? { kind: w.trigger } : { kind: w.trigger.slice(0, dot), event: w.trigger.slice(dot + 1) },
    started_at: w.started_at ?? w.finished_at ?? "",
    ended_at: w.finished_at,
    cost_usd: w.cost_usd,
    session_id: w.session_id,
    ...(w.requires_action ? { requires_action: w.requires_action } : {}),
  };
}

const CLOUD_EVENT_WORDS: Record<string, string> = {
  "issues.opened": "issue opened",
  "issues.labeled": "issue labelled",
  "issue_comment.created": "comment",
  "pull_request.opened": "pull request opened",
  "pull_request.synchronize": "pull request updated",
  "pull_request.labeled": "pull request labelled",
  "pull_request.closed": "pull request merged",
  "check_suite.completed": "checks failed",
  app_mention: "mention",
};

/** What started a Cloud run, in a few words, when it names no subject: "Slack mention", "on schedule". */
export function cloudTriggerWords(t: CloudRun["trigger"]): string {
  if (t.kind === "schedule") return "On schedule";
  if (t.kind === "manual") return "By hand";
  const vendor = ({ github: "GitHub", slack: "Slack", linear: "Linear", jira: "Jira", webhook: "Webhook" } as Record<string, string>)[t.kind] ?? t.kind;
  const event = t.event ? (CLOUD_EVENT_WORDS[t.event] ?? t.event.replace(/[._]/g, " ")) : "";
  return event ? `${vendor} ${event}` : vendor;
}

/** A row of the Runs tab: a This Mac run opens its page here, a Cloud run its session in Cloud's console. */
export interface RunRow {
  readonly where: "this_mac" | "cloud";
  readonly run_id: string;
  readonly status: CloudRunStatus;
  /** Why a Cloud run ended as it did, when Cloud said: "A run on the same subject was still going". */
  readonly why?: string;
  readonly trigger: { readonly kind: string; readonly event?: string | undefined; readonly subject: string; readonly subject_title?: string | undefined };
  /** A Cloud run that names no subject: what started it, in words. */
  readonly label?: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  /** Measured; null when Cloud has not counted it yet. */
  readonly spent_usd: number | null;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly status: StepStatus }>;
  /** A Cloud run's session in the console. */
  readonly console?: string;
  /** A Cloud run waiting on a person. */
  readonly ask?: CloudAsk;
}

/** This Mac's runs and Cloud's, newest first. */
export function mergeRuns(local: ReadonlyArray<RunSummary>, cloud: ReadonlyArray<CloudRun>, consoleBase: string): RunRow[] {
  const rows: RunRow[] = [
    ...local.map((r): RunRow => ({ where: "this_mac", run_id: r.run_id, status: r.status, trigger: r.trigger, started_at: r.started_at, ended_at: r.ended_at, spent_usd: r.spent_usd, steps: r.steps })),
    ...cloud.map((r): RunRow => {
      const status = cloudStatus(r.status);
      const page = consoleUrl(consoleBase, r.session_id ? CONSOLE.session(r.session_id) : CONSOLE.automation(r.automation_id));
      return {
        where: "cloud",
        run_id: r.run_id,
        status,
        trigger: { ...r.trigger, subject: r.trigger.subject ?? "" },
        ...(r.trigger.subject ? {} : { label: cloudTriggerWords(r.trigger) }),
        started_at: r.started_at,
        ended_at: r.ended_at,
        spent_usd: r.cost_usd,
        steps: [],
        ...(r.outcome && Object.hasOwn(REASON, r.outcome) ? { why: REASON[r.outcome as NonNullable<RunRecord["reason"]>] } : {}),
        console: page,
        ...(r.requires_action && status === "waiting" ? { ask: r.requires_action } : {}),
      };
    }),
  ];
  return rows.sort((a, b) => b.started_at.localeCompare(a.started_at) || a.run_id.localeCompare(b.run_id));
}

/** Cloud's runs of one automation: its Cloud id when this computer knows it, else its file's name in this repository. */
export const cloudRunsOf = (runs: ReadonlyArray<CloudRun>, repo: string | undefined, name: string, cloudId?: string | undefined) =>
  runs.filter((r) => (cloudId !== undefined && r.automation_id === cloudId) || (r.automation === name && (!repo || !r.repo || r.repo.toLowerCase() === repo.toLowerCase())));

/** Runs on Cloud that wait on a person's approval and say which ask, oldest first: the ones answerable from here. */
export const waitingApprovals = (runs: ReadonlyArray<CloudRun>) =>
  runs.filter((r) => cloudStatus(r.status) === "waiting" && r.requires_action?.kind === "approval").sort((a, b) => a.started_at.localeCompare(b.started_at));

/** A Cloud run's name for a person: its automation's, else the one this computer deployed under that id. */
export const cloudRunName = (r: CloudRun, names: ReadonlyMap<string, string>) => r.automation ?? names.get(r.automation_id) ?? "A Cloud automation";

/** What an approval gate asks, in one line: "implement waits for your approval". */
export function gateWords(ask: { readonly step?: string | undefined; readonly by?: "owner" | "members" | undefined; readonly question?: string | undefined }): string {
  if (ask.question) return ask.question;
  const what = ask.step;
  const who = ask.by === "members" ? "a member's" : "the owner's";
  return what ? `${what} waits for ${who} approval` : `Waits for ${who} approval`;
}

/** A This Mac run's approval gate: its `approve:` step waits for an answer (automation.approve). */
export interface LocalGateView {
  readonly step: string;
  readonly by: "owner" | "members";
  readonly expires_at?: string;
}

/** The step of a This Mac run that waits for approval now; null when none waits. */
export function localGate(run: { readonly steps: ReadonlyArray<{ readonly name: string; readonly status: string }> }): LocalGateView | null {
  for (const s of run.steps) {
    const ap = (s as { approval?: { by?: "owner" | "members"; expires_at?: string; decision?: string } }).approval;
    if (s.status === "waiting" && ap && ap.decision === undefined) return { step: s.name, by: ap.by ?? "owner", ...(ap.expires_at ? { expires_at: ap.expires_at } : {}) };
  }
  return null;
}

/** How long a gate still waits: "It waits 23h more, then fails"; null with no deadline. */
export function gateDeadline(expiresAt: string | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return "Its time to answer is up.";
  const h = Math.floor(left / 3_600_000);
  const m = Math.max(1, Math.round((left % 3_600_000) / 60_000));
  return `It waits ${h > 0 ? `${h}h${h < 10 && m < 60 ? ` ${m}m` : ""}` : `${m}m`} more, then the step fails.`;
}

// ------------------------------------------------------------ agents

export interface AgentFileView {
  /** "Not published", "v3", "v3, changed here". */
  readonly label: string;
  readonly tone: "none" | "published" | "changed";
  /** The button: "Publish", "Publish v4"; null when Cloud holds this exact file. */
  readonly action: string | null;
}

/** An agent file beside its published version: unpublished, the same, or changed here since (by sha256). */
export function agentView(localSha: string | null | undefined, published: PublishedAgent | undefined): AgentFileView {
  if (!published) return { label: "Not published", tone: "none", action: "Publish" };
  const v = `v${published.latest_version}`;
  if (!localSha || !published.file_sha256) return { label: v, tone: "published", action: "Publish" };
  if (localSha === published.file_sha256.replace(/^sha256:/, "")) return { label: v, tone: "published", action: null };
  return { label: `${v}, changed here`, tone: "changed", action: `Publish v${published.latest_version + 1}` };
}

/** The repo's own agent files (`.caveman/agents/*.md`), not a plugin's, a built-in or `.claude/agents`. */
export const isAgentFile = (t: { source: string; path?: string | undefined }) => t.source === "project" && /^\.caveman\/agents\/[^/]+\.md$/.test(t.path ?? "");

/** Hex sha256 of a file's text, as Cloud stores `file_sha256`. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------ the console

/** Pages of Caveman Cloud's console these pages link to, on the signed-in Cloud. */
export const CONSOLE = {
  session: (id: string) => `/code-sessions/${encodeURIComponent(id)}`,
  agents: "/code-agents",
  agent: (id: string) => `/code-agents/${encodeURIComponent(id)}`,
  automations: "/code-automations",
  automation: (id: string) => `/code-automations/${encodeURIComponent(id)}`,
  board: "/code-automations?view=board",
  serviceAccounts: "/settings?section=service-accounts",
  policy: "/settings?section=code-policy",
} as const;

/** A console page on the Cloud this runtime signs in to. */
export const consoleUrl = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

/** "app.caveman.so": where a console link goes, for its tooltip. */
export function consoleHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
