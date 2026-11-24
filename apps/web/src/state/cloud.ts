// Caveman Cloud from this client, two ways:
// - Remote control on This Mac: the runtime signs itself in (Cloud's device
//   flow) and holds the link; this client shows the code and opens Cloud's
//   page. The person's Cloud credential never reaches this client.
// - Cloud-hosted: this build served by Cloud at <app host>/code/ reaches the
//   person's runtimes through the relay with their Cloud session cookie (same
//   origin, HttpOnly); no bearer is ever readable by these scripts. Such a
//   window has no computer of its own and nobody picks one (sync/web-window.ts).
import { publicCredits, publicOffer, type AccountSummary, type CloudAccount, type CloudComputerRow, type CloudStatus, type Project } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import type { AccountSource } from "../components/unlock-model.ts";
import { thisComputer } from "../lib/platform.ts";
import { resetLabel } from "../shell/plan-meter-model.ts";
import { CloudError } from "./sync/cloud-api.ts";
import { placedWorkspaceId } from "./sync/message-id.ts";
import type { CallState } from "./sync/wire.ts";

export const HOSTED_CLOUD = "https://app.caveman.so";

/** Whether `cloudUrl` (Settings' cloud_url; absent: the default) is Caveman's hosted Cloud. */
export const isHostedCloud = (cloudUrl: string | undefined): boolean => {
  try {
    return new URL(cloudUrl ?? HOSTED_CLOUD).origin === HOSTED_CLOUD;
  } catch {
    return false;
  }
};

/**
 * Whether Settings offers Caveman credits: Caveman's hosted Cloud sells them; a
 * company's own Cloud only shows them once they are on, which Account offers
 * when that Cloud sells them.
 */
export const offersCredits = (cloudUrl: string | undefined, on: boolean): boolean => on || isHostedCloud(cloudUrl);

// ---------------------------------------------------------- Remote control

export type RemoteStep = "off" | "sign_in" | "not_registered" | "waiting" | "connecting" | "connected" | "sign_in_again" | "replaced";

export interface RemoteView {
  /** The switch's position. */
  readonly on: boolean;
  readonly step: RemoteStep;
  /** One plain line for the Environment card. */
  readonly detail: string;
}

/** "alice@example.com (Acme)": the account Remote control acts as. */
export const accountLabel = (account: CloudAccount) => (account.organization_name ? `${account.email} (${account.organization_name})` : account.email);

/**
 * Signed in, but Caveman did not register this computer (a role without Remote control, Caveman unreachable): the
 * runtime kept the account with no runtime identity and Remote control off. Not signed out: Try again registers it.
 */
export const notRegistered = (status: CloudStatus | null): boolean => status?.account !== undefined && status.runtime_id === undefined && !status.signin;

/** What Remote control looks like for a cloud.status answer and Settings.remote_control. */
export function remoteView(status: CloudStatus | null, wanted: boolean): RemoteView {
  if (status?.signin) return { on: true, step: "waiting", detail: `Approve ${status.signin.user_code} in your browser` };
  if (!status) return { on: wanted, step: wanted ? "connecting" : "off", detail: wanted ? "Connecting" : "Off" };
  if (notRegistered(status)) return { on: false, step: "not_registered", detail: status.signin_error ? `This computer isn't registered yet. ${status.signin_error}` : "This computer isn't registered yet" };
  switch (status.state) {
    case "off":
      // Moves: the link runs for moving chats to Cloud even with Remote control off, and says so.
      if (status.moves === "on") return { on: false, step: "off", detail: "Off. Signed in to Caveman only to move chats to Cloud when the lid closes" };
      return { on: false, step: "off", detail: status.account ? `Off. Signed in as ${accountLabel(status.account)}` : "Off" };
    case "not_enrolled":
      return { on: true, step: "sign_in", detail: status.signin_error ?? "Sign in to Caveman" };
    case "connecting":
      return { on: true, step: "connecting", detail: "Connecting to Caveman" };
    case "connected":
      return { on: true, step: "connected", detail: status.account ? `As ${accountLabel(status.account)}` : "From your other devices" };
    case "unauthorized":
      return { on: true, step: "sign_in_again", detail: `Caveman refused ${thisComputer}. Sign in again.` };
    case "replaced":
      return { on: true, step: "replaced", detail: `Another copy of Caveman Code on ${thisComputer} holds the link` };
  }
}

/** Turning the switch on starts a sign-in when This Mac has no live enrollment. */
export const needsSignIn = (status: CloudStatus | null): boolean =>
  !status?.signin && !notRegistered(status) && (status?.runtime_id === undefined || status.state === "unauthorized");

// ------------------------------------------------------------ Cloud-hosted

const CHOICE_KEY = "caveman.cloud.runtime";

export interface CloudRuntime {
  readonly id: string;
  readonly name: string;
  readonly computer_id: string;
  readonly computer_name: string;
  readonly computer_driver: string;
  readonly last_seen_at: string | null;
}

/** This build is being served by Caveman Cloud (the relay, at /code/), not by a runtime or the desktop shell. */
export function cloudHosted(loc: Pick<Location, "pathname" | "protocol">, desktop: unknown): boolean {
  return !desktop && (loc.protocol === "https:" || loc.protocol === "http:") && loc.pathname.startsWith("/code/");
}

/** The relay's attach URL for a runtime on this origin. */
export function relayUrl(loc: Pick<Location, "protocol" | "host">, runtimeId: string): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/relay/v1/runtimes/${encodeURIComponent(runtimeId)}`;
}

export function chosenRuntime(storage: Pick<Storage, "getItem">): CloudRuntime | null {
  try {
    const value = JSON.parse(storage.getItem(CHOICE_KEY) ?? "null") as CloudRuntime | null;
    return value && typeof value.id === "string" && typeof value.computer_id === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The runtime this window was put on, for a reason: a chat started in Cloud runs there (cloud-wait.ts), a new chat on
 * a Mac reads that Mac's projects, the Chief lives on a Mac. Never a person's pick of a machine, and let go as soon as
 * its computer sleeps (runtime.tsx): the window then uses whatever is on line, or nothing (sync/web-window.ts).
 * RUNTIME_CHOSEN is sent on window when it changes: the runtime provider follows it, no reload.
 */
export const RUNTIME_CHOSEN = "caveman:runtime-chosen";

export function chooseRuntime(storage: Pick<Storage, "setItem" | "removeItem">, runtime: CloudRuntime | null): void {
  if (runtime) storage.setItem(CHOICE_KEY, JSON.stringify(runtime));
  else storage.removeItem(CHOICE_KEY);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(RUNTIME_CHOSEN));
}

/**
 * The runtime a Cloud computer runs as now, when it is not the one this tab remembers. Cloud mints a new runtime id at
 * every wake of a Cloud computer (cloud-computers CONTRACT §5.3) and refuses the old one once the computer has stopped,
 * so a tab that chose `runtime` looks its computer up again by computer id when the relay refuses it or cannot find
 * it. Cloud lists runtimes newest heartbeat first: the computer's first is its live one. Undefined: the same one,
 * none listed yet (the computer is still waking), or a Mac, whose runtime id is its enrolment.
 */
export function runtimeOfComputer(runtime: CloudRuntime, runtimes: ReadonlyArray<CloudRuntime>): CloudRuntime | undefined {
  if (isLaptop(runtime)) return undefined;
  const now = runtimes.find((r) => r.computer_id === runtime.computer_id && !isLaptop(r));
  return now !== undefined && now.id !== runtime.id ? now : undefined;
}

/** A managed computer can be woken; a laptop comes back only when its runtime does. */
export const isLaptop = (runtime: Pick<CloudRuntime, "computer_driver">) => runtime.computer_driver === "local";

/** "Online" within two heartbeats (30 s apart), else when it was last seen. */
export function seenLabel(lastSeen: string | null, now = Date.now()): string {
  if (!lastSeen) return "Never connected";
  const ago = Math.max(0, now - Date.parse(lastSeen));
  if (ago < 75_000) return "Online";
  const min = Math.round(ago / 60_000);
  if (min < 60) return `Last seen ${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `Last seen ${hours} h ago` : `Last seen ${Math.round(hours / 24)} days ago`;
}

/** What a failed call to Caveman says when Caveman gave no sentence of its own: never a status code. */
export const CAVEMAN_PROBLEM = "Caveman had a problem. Try again.";

export type RuntimesAnswer = { readonly signedIn: false } | { readonly signedIn: true; readonly runtimes: ReadonlyArray<CloudRuntime> };

/** The runtimes this person may attach to (GET /api/v1/code/runtimes, their Cloud session). */
export async function listRuntimes(fetchImpl: typeof fetch = fetch): Promise<RuntimesAnswer> {
  const get = () => fetchImpl("/api/v1/code/runtimes", { credentials: "same-origin", headers: { accept: "application/json" } });
  let response = await get();
  if (response.status === 401 && (await renewSession(fetchImpl))) response = await get();
  if (response.status === 401) return { signedIn: false };
  if (response.status === 403) throw new Error("Your role can't use Cloud. Ask your admin.");
  if (!response.ok) throw new Error(CAVEMAN_PROBLEM);
  const body = (await response.json()) as { runtimes?: CloudRuntime[] };
  return { signedIn: true, runtimes: body.runtimes ?? [] };
}

/**
 * Wakes a managed computer the relay reported as not connected (4404). Cookie-authenticated, so it carries the CSRF
 * header. Answers Cloud's status: 404 says the computer is not one of this person's any more.
 */
export async function resumeComputer(computerId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const response = await fetchImpl(`/api/v1/code/computers/${encodeURIComponent(computerId)}/resume`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-cave-csrf": "1", "content-type": "application/json" },
    body: "{}",
  });
  return response.status;
}

/**
 * Renews the person's Cloud session cookie (an install on Cloud's own
 * sign-in keeps the access cookie 15 minutes and renews it from an HttpOnly
 * refresh cookie). False when it cannot: they sign in again.
 */
export async function renewSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "x-cave-csrf": "1" } }).catch(() => undefined);
  return response?.ok === true;
}

export const signInUrl = (next = "/code/") => `/login?next=${encodeURIComponent(next)}`;

// ---------------------------------------------------------- Cloud computers

export type ComputerTone = "ok" | "busy" | "warn" | "idle" | "bad";

/**
 * The reasons Cloud's computers service gives a place on its way that are only progress (the drivers' "booting",
 * "waking", "stopping", a pod's phase or a container being made). Any other reason is what holds it up: no room on a
 * host, a pod that can't be scheduled, an image that won't pull, Cloud's own error on its last try.
 */
const PROGRESS = /^(booting|waking|stopping|deleting|Pending|Running)$|: (ContainerCreating|PodInitializing|ContainersNotReady|ContainersNotInitialized)$/;

/** A start Cloud is still trying, and one it gave up on until the next message asks again (the reason is `detail`). */
export const CLOUD_HELD_UP = "Cloud couldn't start. Trying again.";
export const CLOUD_FAILED = "Cloud couldn't start. Send a message to try again.";

/** "Paused until Dec 1 · plan used up": a place asleep because its plan ran out, and when the plan starts over. */
export function pausedLabel(resetsAt: string | undefined, now = new Date()): string {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now.getTime()) return "Paused · plan used up";
  const when = new Date(at);
  const sameDay = when.toDateString() === now.toDateString();
  const until = sameDay ? when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Paused until ${until} · plan used up`;
}

/**
 * A place's state in the person's words, one word and one colour each: Running, Asleep, Waking…, or paused by a
 * used-up plan (`resetsAt`: when that plan starts over). A start that is held up or failed says our own sentence;
 * what Cloud's computers service wrote is `detail`, shown only on a click.
 */
export function computerStatus(
  c: Pick<CloudComputerRow, "desired_state" | "observed_state" | "observed_reason" | "sleep_reason">,
  resetsAt?: string,
  now = new Date(),
): { label: string; tone: ComputerTone; detail?: string } {
  const reason = (c.observed_reason ?? "").trim();
  const detail = reason ? { detail: reason } : {};
  if (c.observed_state === "failed") return { label: CLOUD_FAILED, tone: "bad", ...detail };
  if (c.desired_state === "running" && c.observed_state === "running") return { label: "Running", tone: "ok" };
  // Asleep because nothing paid for its time: the plan ran out.
  if (c.desired_state === "suspended" && c.sleep_reason === "usage") return { label: pausedLabel(resetsAt, now), tone: "idle" };
  if (c.desired_state === "deleted") return { label: c.observed_state === "deleted" ? "Deleted" : "Deleting…", tone: c.observed_state === "deleted" ? "idle" : "busy" };
  // On its way up and held up by something it names (m-19): that, never "Waking…" for ever.
  if (c.desired_state === "running") return reason !== "" && !PROGRESS.test(reason) ? { label: CLOUD_HELD_UP, tone: "warn", detail: reason } : { label: "Waking…", tone: "busy" };
  // Put to sleep, or stopped: asleep to a person from the moment it was asked.
  return { label: "Asleep", tone: "idle" };
}

/** A chat Cloud lists on a Cloud computer, as the Delete dialog names it. */
export interface ComputerChat {
  readonly title: string;
  readonly kind: "chat" | "chief" | "builder" | "setup" | "automation";
}

/** A chat as Cloud's chat list has it, as much as chatsOnComputer reads. */
type ListedChat = { readonly session_id: string; readonly computer_id: string; readonly title: string; readonly kind: ComputerChat["kind"]; readonly archived: boolean };

/**
 * The chats on a Cloud computer by Cloud's own lists of the person's chats (`active`: GET /code/chats?archived=false,
 * `archived`: ?archived=true), every kind: what deleting it archives (`on`), and archived chats whose uncommitted work
 * is only on its disk, kept for Restore, which go with it (A-7). A chat on both lists (archived between the two reads)
 * is archived.
 */
export function chatsOnComputer(computerId: string, active: ReadonlyArray<ListedChat>, archived: ReadonlyArray<ListedChat>): { readonly on: ReadonlyArray<ComputerChat>; readonly archived: ReadonlyArray<ComputerChat> } {
  const bySession = new Map<string, ListedChat>();
  for (const c of active) if (c.computer_id === computerId) bySession.set(c.session_id, c);
  for (const c of archived) if (c.computer_id === computerId) bySession.set(c.session_id, { ...c, archived: true });
  const chats = [...bySession.values()];
  const as = (c: ListedChat): ComputerChat => ({ title: c.title.trim() || "Untitled chat", kind: c.kind });
  return { on: chats.filter((c) => !c.archived).map(as), archived: chats.filter((c) => c.archived).map(as) };
}

/**
 * The repository a Cloud computer clones for what the New workspace dialog was given: a GitHub
 * URL or owner/name as is; a folder on this Mac by its project's GitHub link; else null.
 */
export function cloudRepo(input: string, projects: ReadonlyArray<Pick<Project, "path" | "repository">>): string | null {
  const v = input.trim().replace(/\/+$/, "");
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(v)) return v;
  if (/^[\w.-]+\/[\w.-]+$/.test(v) && !v.startsWith(".")) return v;
  const project = projects.find((p) => p.path.replace(/\/+$/, "") === v);
  return project?.repository?.host === "github.com" ? project.repository.full_name : null;
}

/**
 * A workspace started from This Mac on a Cloud computer continues in the Cloud-hosted client: the
 * task travels in the link's fragment (never sent to a server), and that client starts the
 * session once the computer's runtime connects.
 */
export interface PendingStart {
  readonly computer_id: string;
  /**
   * The workspace Caveman Cloud placed on that computer for this start's chat (what its `POST workspaces` answered):
   * the chat's registration takes up that placement and no other, so two chats started at once never swap theirs.
   * Absent on a start from before it.
   */
  readonly workspace_id?: string;
  readonly repo: string;
  readonly base_ref?: string;
  readonly engine: string;
  readonly task: string;
  /** Runs of the task on that computer (x2, x4): the first in its checkout, the rest as worktrees beside it. Absent: one. */
  readonly runs?: number;
  /** A chat on this pull request of the repository (Review's Ask on a new Cloud computer): one run, on its head. */
  readonly pull_request?: number;
  /** The chat's title (a pull request chat names what it asks). */
  readonly title?: string;
  /** The model, effort, speed and mode picked for its first turn; absent, the computer's defaults. */
  readonly options?: StartOptions;
  /**
   * A chat in several sources of the repository's project: every repository it works in by owner/name, `repo`'s own
   * first (workspace.create's `sources`). Absent: a chat in `repo` alone.
   */
  readonly sources?: ReadonlyArray<string>;
  /** It came from a `#start=` link, which anyone can send: the person confirms it before it runs. */
  readonly from_link?: true;
  /** Its first workspace.create's, once this tab sent it: a reload or Try again sends that same call (PendingCloudStart). */
  readonly request_id?: string;
  /** Whether that call carries the task (an engine that must sign in first gets it in the chat's box instead). */
  readonly with_task?: boolean;
  /** That call failed, in these words: the start waits for the person's Try again or Discard, and for no computer. */
  readonly failed?: string;
  /**
   * The session of the chat this window opened at Send, when Cloud queued this start and its computer did not run it
   * from the queue (QueuedStart): the window lets that chat go once this start runs, or is given up.
   */
  readonly session_id?: string;
}
const START_KEY = "caveman.cloud.start";
/** The runtime this tab was on when a link named another computer: Discard goes back to it. */
const PREVIOUS_KEY = "caveman.cloud.start.previous";

/** What a Cloud start may pick for its chat (TurnOptions): never its permissions, nor a login. */
export interface StartOptions {
  readonly model?: string;
  readonly effort?: string;
  readonly speed?: string;
  readonly mode?: "default" | "grill";
}
/** A start's picks as a link may carry them: model, effort and speed as names, a known mode, nothing else. */
function linkOptions(raw: unknown): StartOptions | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const name = (k: "model" | "effort" | "speed") => {
    const v = r[k];
    return typeof v === "string" && v.trim() ? { [k]: v.slice(0, 200) } : {};
  };
  const picked: StartOptions = { ...name("model"), ...name("effort"), ...name("speed"), ...(r.mode === "default" || r.mode === "grill" ? { mode: r.mode } : {}) };
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** A start's sources as a link may carry them: a few repositories by owner/name, nothing else. */
function linkSources(raw: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const named = raw.filter((v): v is string => typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v)).slice(0, MAX_LINK_SOURCES);
  return named.length > 1 ? named : undefined;
}
/** More repositories than any project's chat works in; a link naming more is cut here. */
const MAX_LINK_SOURCES = 16;

/**
 * What a chat started on Cloud takes from the turn picked for it: model, effort, speed and mode. Its permissions
 * would ride in a #start link, which anyone can send, so a start that picked them is refused, not run on others; a
 * login of this computer's stays here, as a Cloud computer signs its engines in itself.
 */
export function cloudStartOptions(turn: { readonly model?: string; readonly effort?: string; readonly speed?: string; readonly mode?: string; readonly access?: string }): StartOptions | undefined {
  if (turn.access !== undefined) throw new Error(`Permissions picked here can't go with a chat started on Cloud: it starts with your default ones there. Start it on ${thisComputer} to use them.`);
  return linkOptions(turn);
}

export const startLink = (openUrl: string, start: PendingStart) =>
  `${openUrl}#start=${btoa(unescape(encodeURIComponent(JSON.stringify(start)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

/**
 * Moves a `#start=` link's task into this tab's storage (before the hash router reads the URL). A chosen
 * runtime on another computer is let go (and kept, for Discard): the window asks before it connects to the
 * link's computer (cloud-wait.ts), so a link alone never moves this tab onto a computer someone else picked.
 */
export function adoptPendingStart(win: Pick<Window, "location" | "history" | "sessionStorage" | "localStorage">): void {
  const m = /^#start=([A-Za-z0-9_-]+)$/.exec(win.location.hash);
  if (!m) return;
  try {
    const raw = decodeURIComponent(escape(atob(m[1]!.replace(/-/g, "+").replace(/_/g, "/"))));
    const start = JSON.parse(raw) as Partial<PendingStart>;
    if (typeof start.computer_id === "string" && typeof start.repo === "string" && typeof start.engine === "string" && typeof start.task === "string") {
      const base = typeof start.base_ref === "string" && start.base_ref ? { base_ref: start.base_ref } : {};
      const runs = typeof start.runs === "number" && Number.isInteger(start.runs) && start.runs > 1 && start.runs <= 4 ? { runs: start.runs } : {};
      const pr = typeof start.pull_request === "number" && Number.isInteger(start.pull_request) && start.pull_request > 0 ? { pull_request: start.pull_request } : {};
      const title = typeof start.title === "string" && start.title.trim() ? { title: start.title.trim().slice(0, 200) } : {};
      const options = linkOptions(start.options);
      // An id only: Cloud reads a workspace that is not on the link's computer as absent, and the chat then starts as one with none.
      const placed = typeof start.workspace_id === "string" && /^[0-9a-f-]{36}$/i.test(start.workspace_id) ? { workspace_id: start.workspace_id } : {};
      const named = linkSources(start.sources);
      // The request id of a start Cloud queued, which the computer did not run from the queue (the desktop's hand-over):
      // its call here is that same call, so the two can only ever make one chat. It names a call, and runs nothing.
      const request = typeof start.request_id === "string" && /^[\w:.-]{1,150}$/.test(start.request_id) ? { request_id: start.request_id } : {};
      const adopted: PendingStart = { computer_id: start.computer_id, ...placed, repo: start.repo, ...base, engine: start.engine, task: start.task, ...runs, ...pr, ...title, ...(options ? { options } : {}), ...(named ? { sources: named } : {}), ...request, from_link: true };
      win.sessionStorage.setItem(START_KEY, JSON.stringify(adopted));
      const before = chosenRuntime(win.localStorage);
      if (before && before.computer_id !== start.computer_id) {
        win.sessionStorage.setItem(PREVIOUS_KEY, JSON.stringify(before));
        chooseRuntime(win.localStorage, null);
      }
    }
  } catch {
    // A damaged link starts nothing.
  }
  win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}#/chief`);
}

export function pendingStart(storage: Pick<Storage, "getItem">): PendingStart | null {
  try {
    return JSON.parse(storage.getItem(START_KEY) ?? "null") as PendingStart | null;
  } catch {
    return null;
  }
}

/** Sent on window when what this tab waits for in Cloud changes (a start held or gone, a moved chat): state/cloud-wait.ts looks again. */
export const CLOUD_WAIT_CHANGED = "caveman:cloud-wait";
const waitChanged = () => {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(CLOUD_WAIT_CHANGED));
};

export const clearPendingStart = (storage: Pick<Storage, "removeItem">) => {
  storage.removeItem(START_KEY);
  waitChanged();
};

/** The pending start a computer is awaited for (cloud-wait.ts): none once its first workspace.create failed. */
export function awaitedStart(storage: Pick<Storage, "getItem">): PendingStart | null {
  const start = pendingStart(storage);
  return start?.failed === undefined ? start : null;
}

/** The pending start whose first workspace.create failed: its task's only copy, until the person's Try again or Discard. */
export function failedStart(storage: Pick<Storage, "getItem">): PendingStart | null {
  const start = pendingStart(storage);
  return start?.failed === undefined ? null : start;
}

/** Only a start this tab made runs by itself; one from a link waits for the person's click. */
export const startsByItself = (start: PendingStart) => start.from_link !== true;

/** The person pressed Start on a link's task: it runs once its computer connects. */
export function confirmPendingStart(session: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  const start = pendingStart(session);
  if (start) {
    // adoptPendingStart kept only what a link may carry; the click ends just the wait.
    const { from_link: _, ...confirmed } = start;
    holdPendingStart(session, confirmed);
  }
  session.removeItem(PREVIOUS_KEY);
}

/** The person discarded a link's task: drops it and goes back to the runtime the tab was on. True when there was one. */
export function discardPendingStart(session: Pick<Storage, "getItem" | "removeItem">, local: Pick<Storage, "setItem" | "removeItem">): boolean {
  clearPendingStart(session);
  const previous = chosenRuntime({ getItem: () => session.getItem(PREVIOUS_KEY) });
  session.removeItem(PREVIOUS_KEY);
  if (previous) chooseRuntime(local, previous);
  return previous !== null;
}

/** A GitHub URL for owner/name; a URL as is. */
export const repoUrl = (repo: string) => (repo.startsWith("https://") ? repo : `https://github.com/${repo}`);

/** Cloud's error envelope (`{ error: { code, message, details } }`) as a CloudError in Cloud's own words. */
export async function cloudError(response: Response): Promise<CloudError> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null;
  const e = body?.error;
  const message = typeof e?.message === "string" && e.message.trim() ? e.message : CAVEMAN_PROBLEM;
  const details = e?.details && typeof e.details === "object" && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : undefined;
  return new CloudError(response.status, typeof e?.code === "string" ? e.code : undefined, message, details);
}

/** This person's own computers on this origin (the Cloud-hosted client, its session cookie). */
export async function listComputers(fetchImpl: typeof fetch = fetch): Promise<{ available: boolean; computers: CloudComputerRow[] }> {
  const response = await fetchImpl("/api/v1/code/computers?mine=true", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!response.ok) throw await cloudError(response);
  const body = (await response.json()) as { computers?: CloudComputerRow[]; cloud_computers?: boolean };
  return { available: body.cloud_computers === true, computers: body.computers ?? [] };
}

/** Wakes or puts to sleep a Cloud computer on this origin. */
export async function setComputer(computerId: string, state: "running" | "suspended", fetchImpl: typeof fetch = fetch): Promise<CloudComputerRow> {
  const response = await fetchImpl(`/api/v1/code/computers/${encodeURIComponent(computerId)}/${state === "running" ? "resume" : "sleep"}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-cave-csrf": "1", "content-type": "application/json" },
    body: "{}",
  });
  // A wake nothing pays for is a 402, a plan with no room awake a 409: Cloud's words, for refusalView.
  if (!response.ok) throw await cloudError(response);
  return (await response.json()) as CloudComputerRow;
}

/** Deletes one of the person's Cloud computers on this origin (C3): its chats are archived and its disk goes. */
export async function deleteComputer(computerId: string, fetchImpl: typeof fetch = fetch): Promise<CloudComputerRow> {
  const response = await fetchImpl(`/api/v1/code/computers/${encodeURIComponent(computerId)}`, { method: "DELETE", credentials: "same-origin", headers: { "x-cave-csrf": "1", accept: "application/json" } });
  if (!response.ok) throw await cloudError(response);
  return (await response.json()) as CloudComputerRow;
}

/** What Cloud answers for a chat it placed: the workspace and its computer, and for a start it queued, the chat's session and that call. */
export interface PlacedWorkspace {
  readonly workspace_id: string;
  readonly computer_id: string;
  readonly session_id?: string;
  readonly start?: CallState;
}

/** A Cloud from before queued starts refuses the field it does not know, by its strict decode: the same request goes again without it. */
const startUnknown = (error: CloudError) => error.status === 400 && error.code === "cave_bad_request" && error.message === "Invalid JSON.";

/**
 * A workspace on a new Cloud computer, from the Cloud-hosted client (its session cookie). With `start`, Cloud queues
 * the chat's own start with the placement (CONTRACT §6.8): workspace.create's params without the workspace Cloud
 * places, under the request id a live call for the same start would carry. A Cloud that queues none answers neither
 * `session_id` nor `start`.
 */
export async function createCloudWorkspace(
  input: {
    readonly title: string;
    readonly repo: string;
    readonly base_branch?: string;
    readonly engine: string;
    readonly checkouts?: ReadonlyArray<{ readonly repo: string }>;
    readonly start?: { readonly request_id: string; readonly params: Readonly<Record<string, unknown>> };
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PlacedWorkspace> {
  const post = (start: typeof input.start) =>
    fetchImpl("/api/v1/code/workspaces", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-cave-csrf": "1", "content-type": "application/json", accept: "application/json" },
      // `checkouts`: the other repositories of the project the chat works in, as the runtime's cloud.workspace.create
      // sends them; absent for a chat in one repository, whose request is as it was.
      body: JSON.stringify({
        title: input.title.slice(0, 200),
        repo: input.repo,
        base_branch: input.base_branch ?? "",
        engine: input.engine,
        computer: { kind: "cloud" },
        ...(input.checkouts && input.checkouts.length > 0 ? { checkouts: input.checkouts.map((c) => ({ repo: c.repo })) } : {}),
        ...(start ? { start } : {}),
      }),
    });
  let response = await post(input.start);
  if (!response.ok) {
    const refused = await cloudError(response);
    if (input.start === undefined || !startUnknown(refused)) throw refused;
    response = await post(undefined);
    if (!response.ok) throw await cloudError(response);
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string; computer_id?: string; session_id?: string; start?: CallState };
  if (!body.id || !body.computer_id) throw new CloudError(response.status, undefined, "Cloud made no place for this chat.");
  const queued = typeof body.session_id === "string" && body.session_id !== "" && typeof body.start?.status === "string" ? { session_id: body.session_id, start: body.start } : {};
  return { workspace_id: body.id, computer_id: body.computer_id, ...queued };
}

/** Keeps a pending start in this tab (the Cloud-hosted client waits for the computer, then starts it). */
export function holdPendingStart(storage: Pick<Storage, "setItem">, start: Omit<PendingStart, "from_link">): void {
  storage.setItem(START_KEY, JSON.stringify(start));
  waitChanged();
}

/**
 * A workspace on a new Cloud computer from the Cloud-hosted client, and the pending start this tab opens on it once its
 * runtime is up. Refused before Cloud makes the computer while this tab holds a start that failed: that start would
 * take its place, and with it the only copy of its task.
 */
export async function startOnNewCloudComputer(
  input: Parameters<typeof createCloudWorkspace>[0],
  pending: (computerId: string) => Omit<PendingStart, "from_link">,
  session: Pick<Storage, "getItem" | "setItem">,
  fetchImpl: typeof fetch = fetch,
): Promise<PendingStart> {
  const failed = failedStart(session);
  if (failed) throw new Error(`Your chat on ${failed.repo} didn't start. Try it again or discard it first.`);
  const made = await createCloudWorkspace(input, fetchImpl);
  const start = placedStart(pending(made.computer_id), made.workspace_id);
  holdPendingStart(session, start);
  return start;
}

/** A pending start naming the workspace Cloud placed for it. */
export const placedStart = <S extends Omit<PendingStart, "from_link">>(start: S, workspaceId: string): S & { readonly workspace_id: string } => ({ ...start, workspace_id: workspaceId });

/**
 * workspace.create on the Cloud computer a pending start names: its repository, base and engine, the task unless
 * the engine must sign in first (it waits in the chat's box), and a pull request's head when it names one. The
 * start's first chat names the workspace Cloud placed for it; `further`, a run beside the first, says Cloud placed
 * none for it. A start from before the placement was carried says neither.
 */
export function pendingStartParams(start: PendingStart, requestId: string, withTask: boolean, further = false) {
  return {
    request_id: requestId,
    ...(start.workspace_id === undefined ? {} : { placed_workspace_id: further ? "" : start.workspace_id }),
    repo: { url: repoUrl(start.repo) },
    ...(start.base_ref && !start.pull_request ? { base_ref: start.base_ref } : {}),
    engine: start.engine,
    ...(start.title ? { title: start.title } : {}),
    // A start with no task: its chat opens empty, ready for the first message.
    ...(withTask && start.task.trim() ? { task: { text: start.task } } : {}),
    ...(start.pull_request ? { pull_request: { number: start.pull_request } } : {}),
    ...(start.options ? { options: start.options } : {}),
    // A chat in several sources names them by repository; a pull request's chat is in its repository alone.
    ...(start.sources && start.sources.length > 1 && !start.pull_request ? { sources: [...start.sources] } : {}),
  };
}

/**
 * A chat whose start Cloud queued with its placement (CONTRACT §6.8): Cloud holds the start from Send, its computer
 * runs it when it links, and this window shows the chat meanwhile (sync/hub.ts `startQueued`).
 */
export interface QueuedStart {
  /** The session Cloud placed: the chat's own once its computer starts it. */
  readonly session_id: string;
  /** The id that computer gives the chat (sync/message-id.ts placedWorkspaceId): its route in this window from Send. */
  readonly workspace_id: string;
  /** Cloud's call for the start, as it last said of it. */
  readonly call: CallState;
  /**
   * What was sent, with its request id and the workspace Cloud placed: the same call as a pending start, for a
   * computer that does not run a start from Cloud's queue (shell/QueuedStarts.tsx).
   */
  readonly start: PendingStart & { readonly workspace_id: string; readonly request_id: string };
  /** From the desktop app: the Cloud-hosted client, where such a start carries on. */
  readonly open_url?: string;
}

/**
 * What Cloud queues as a start: the params of the workspace.create a pending start sends, without the request id (the
 * call's own) and the workspace Cloud places (which Cloud sets). The live call for the same start is these params
 * with those two, so a computer that got both runs one (its receipt answers the other).
 */
export function queuedStartParams(start: Omit<PendingStart, "workspace_id">): Record<string, unknown> {
  const { request_id: _request, ...params } = pendingStartParams(start, "", true);
  return params;
}

/** A start Cloud placed and queued, as this window opens it; null where the chat's id cannot be told here (no WebCrypto). */
export async function queuedStart(made: PlacedWorkspace, start: Omit<PendingStart, "from_link" | "workspace_id">, requestId: string): Promise<QueuedStart | null> {
  if (made.session_id === undefined || made.start === undefined) return null;
  const workspaceId = await placedWorkspaceId(made.workspace_id);
  if (workspaceId === null) return null;
  return { session_id: made.session_id, workspace_id: workspaceId, call: made.start, start: { ...placedStart(start, made.workspace_id), request_id: requestId, with_task: true } };
}

export type CloudStartOutcome = { readonly queued: QueuedStart } | { readonly held: PendingStart };

/**
 * Send, for a chat in Cloud from a browser window: one request, and Cloud holds the start from then on. `queued`: the
 * chat opens now. `held`: this Cloud placed the chat and queued no start (one from before the field), or the chat's
 * id cannot be told here: the start waits in this tab for its computer as it always did (startOnNewCloudComputer),
 * under the same request id where Cloud did queue it, so the two make one chat.
 */
export async function sendCloudStart(
  input: Omit<Parameters<typeof createCloudWorkspace>[0], "start">,
  pending: (computerId: string) => Omit<PendingStart, "from_link" | "workspace_id">,
  requestId: string,
  session: Pick<Storage, "getItem" | "setItem">,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudStartOutcome> {
  const failed = failedStart(session);
  if (failed) throw new Error(`Your chat on ${failed.repo} didn't start. Try it again or discard it first.`);
  const made = await createCloudWorkspace({ ...input, start: { request_id: requestId, params: queuedStartParams(pending("")) } }, fetchImpl);
  const start = pending(made.computer_id);
  const queued = await queuedStart(made, start, requestId);
  if (queued) return { queued };
  const held = { ...placedStart(start, made.workspace_id), ...(made.start ? { request_id: requestId, with_task: true } : {}) };
  holdPendingStart(session, held);
  return { held };
}

// ---------------------------------- what a browser window asks Cloud itself, with no runtime

/** Where the person sees their plan and buys credits, on Cloud's own pages (same origin as this client, outside /code,
 * which the relay serves). */
export const BILLING_PATH = "/billing";
/** Where a repository is connected to Caveman Cloud's GitHub App (Cloud's own connect page for the signed-in person,
 * code GithubConnectPath). The one constant for it: Review (routes/review/source.ts) and the new chat's repo menu
 * both read it, and the mobile app's pulls/model.ts names the same path. */
export const GITHUB_CONNECT_PATH = "/cave-agent/code";

/**
 * The person's Caveman account read from Caveman Cloud on this origin, for a browser window with no runtime to ask
 * (the Unlock sheet, Settings > Account and Plan): who they are (GET /api/v1/auth/me), the plan and credits
 * (/code/credits) and the offer (/code/plans), the answers the runtime's account.get reads; checkout is POST
 * /code/plan/checkout, as the runtime's.
 */
export const hostedAccount: AccountSource = {
  get: async () => {
    const get = (path: string) => fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
    const [me, credits, plans] = await Promise.all([get("/api/v1/auth/me"), get("/api/v1/code/credits"), get("/api/v1/code/plans")]);
    if (!me.ok) throw await cloudError(me);
    const user = ((await me.json()) as { user?: { email?: string; role?: string } }).user;
    const c = credits.ok ? ((await credits.json()) as AccountSummary["credits"]) : null;
    const o = plans.ok ? ((await plans.json()) as { plans?: unknown }) : null;
    // Only what the protocol carries about a plan: a percent and a reset, the price and the headline (docs/ section 9).
    return {
      signed_in: true,
      ...(user?.email ? { email: user.email } : {}),
      ...(user?.role ? { role: user.role } : {}),
      credits: c ? publicCredits(c) : null,
      offer: o && Array.isArray(o.plans) ? publicOffer(o as unknown as NonNullable<AccountSummary["offer"]>) : null,
    } as AccountSummary;
  },
  checkout: async (plan, interval) => {
    const r = await fetch("/api/v1/code/plan/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-cave-csrf": "1", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ plan, interval, seats: 1 }),
    });
    if (!r.ok) throw await cloudError(r);
    const { url } = (await r.json()) as { url?: unknown };
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("Caveman sent no checkout page.");
    return { url };
  },
};


/** A refusal in the person's words, and whether the plan or credits, or deleting a Cloud computer, are the way past it. */
export interface RefusalView {
  readonly text: string;
  readonly billing: boolean;
  /** The person keeps as many Cloud computers as they may: Settings > Computers deletes one (C3). */
  readonly computers: boolean;
}

/** Cloud's refusals that deleting a kept Cloud computer gets past. */
const KEPT_LIMITS = new Set(["cave_code_computer_limit_person_total", "cave_code_computer_limit_plan_kept", "cave_code_computer_limit_organization"]);

/**
 * What to show for a wake or a start in Cloud that Cloud refused: Cloud's own sentence, never a status code. Nothing
 * paid for the time (402 cave_code_credits_exhausted, a wake needs the plan or credits to cover a first stretch)
 * or the plan keeps no more (409 cave_code_computer_limit_plan_*) points at the plan and billing page.
 */
export function refusalView(e: unknown, now = new Date()): RefusalView {
  if (e instanceof CloudError) {
    const money = (e.status === 402 && e.code === "cave_code_credits_exhausted") || (e.code?.startsWith("cave_code_computer_limit_plan_") ?? false);
    const resets = typeof e.details?.resets_at === "string" ? resetLabel(e.details.resets_at, now) : undefined;
    return { text: e.status === 402 && resets ? `${e.message} ${resets}.` : e.message, billing: money, computers: KEPT_LIMITS.has(e.code ?? "") };
  }
  // Through This Mac's runtime (its cloudCall), Cloud's code rides on the protocol error (RpcError data.cloud_code, m-21).
  const code = e instanceof SessionProtocolError ? e.error.data?.cloud_code : undefined;
  if (code !== undefined) {
    const money = code === "cave_code_credits_exhausted" || code.startsWith("cave_code_computer_limit_plan_");
    return { text: (e as Error).message, billing: money, computers: KEPT_LIMITS.has(code) };
  }
  return { text: e instanceof Error ? e.message : String(e), billing: false, computers: false };
}

/** Whether a failed Cloud call is a kept-computer limit, which deleting one in Settings > Computers gets past. */
export const atKeptLimit = (e: unknown): boolean => refusalView(e).computers;

/** owner/name for a GitHub repository as Cloud lists it (owner/name, or a github.com URL); null for anything else. */
export function githubRepo(value: string): string | null {
  const v = value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^(?:https:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+)$/i.exec(v);
  return m && !m[1]!.startsWith(".") && !m[2]!.startsWith(".") ? `${m[1]}/${m[2]}` : null;
}

/**
 * The GitHub repositories Caveman Cloud sees for this person, most recently worked on first: the repos of the
 * organization's Code workspaces, the repos connected to its Cloud projects through the GitHub App (what a Cloud
 * computer may clone and push to), and the repos with a Cloud setup (Settings, Environments). Each source that
 * fails or is off is skipped: an empty list means Cloud sees none, and New chat says where to connect GitHub.
 */
export async function listCloudRepos(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const get = (path: string) =>
    fetchImpl(path, { credentials: "same-origin", headers: { accept: "application/json" } }).then(
      (r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null),
      () => null,
    );
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const [workspaces, projects, environments] = await Promise.all([get("/api/v1/code/workspaces"), get("/api/v1/projects"), get("/api/v1/code/environments/all")]);
  // A Cloud project holds one repository binding; an organization has a handful, so this asks for at most 20.
  const bindings = await Promise.all(
    list(projects?.data)
      .flatMap((p) => (typeof p.id === "string" ? [p.id] : []))
      .slice(0, 20)
      .map((id) => get(`/api/v1/projects/${encodeURIComponent(id)}/github`)),
  );
  const at = (v: unknown) => (typeof v === "string" ? Date.parse(v) || 0 : 0);
  const named = [
    ...list(workspaces?.workspaces)
      .sort((a, b) => at(b.updated_at) - at(a.updated_at))
      .map((w) => w.repo),
    ...bindings.map((b) => (b?.status === "active" && typeof b.repo_owner === "string" && typeof b.repo_name === "string" ? `${b.repo_owner}/${b.repo_name}` : null)),
    ...list(environments?.environments)
      .sort((a, b) => at(b.updated_at) - at(a.updated_at))
      .map((e) => e.repo),
  ];
  const out = new Map<string, string>();
  for (const name of named) {
    const repo = typeof name === "string" ? githubRepo(name) : null;
    if (repo && !out.has(repo.toLowerCase())) out.set(repo.toLowerCase(), repo);
  }
  return [...out.values()];
}

/** The agent a chat started in Cloud with none named runs on: the one New workspace picks on Caveman Cloud. */
export const CLOUD_START_ENGINE = "caveman";

/**
 * A chat in Cloud on a repository, from a browser window with no runtime to ask: the same path New workspace takes
 * on this client (Cloud places a workspace on the project's computer and wakes it, then a pending start this tab opens
 * once its runtime is up, cloud-wait.ts). `task` is its first message; with none, the chat opens empty on the repository.
 */
export function startCloudComputer(repo: string, session: Pick<Storage, "getItem" | "setItem">, fetchImpl: typeof fetch = fetch, start: { readonly task?: string; readonly engine?: string } = {}): Promise<PendingStart> {
  const engine = start.engine ?? CLOUD_START_ENGINE;
  const task = start.task ?? "";
  const title = task.split("\n")[0]!.slice(0, 80) || repo;
  return startOnNewCloudComputer({ title, repo, engine }, (computerId) => ({ computer_id: computerId, repo, engine, task }), session, fetchImpl);
}

// ------------------------------------------------------------ moves

/** A chat that moved to a Cloud computer: this tab goes there once that computer's runtime connects (cloud-wait.ts). */
export interface PendingFollow {
  readonly computer_id: string;
  readonly workspace_id: string;
}
const FOLLOW_KEY = "caveman.cloud.follow";

/** Open in Cloud from This Mac: the Cloud-hosted client, at the chat on its Cloud computer. */
export const followLink = (openUrl: string, follow: PendingFollow) => `${openUrl}#follow=${follow.computer_id}/${follow.workspace_id}`;

/** This tab lets go of its runtime and opens the chat when its computer's runtime is up. */
export function holdFollow(win: Pick<Window, "sessionStorage" | "localStorage">, follow: PendingFollow): void {
  win.sessionStorage.setItem(FOLLOW_KEY, JSON.stringify(follow));
  chooseRuntime(win.localStorage, null);
}

/**
 * Takes a `#follow=` link (before the hash router reads the URL) and opens the chat's route. Opening a chat on one of the
 * person's own computers runs nothing, so unlike `#start=` it asks nothing first.
 */
export function adoptFollow(win: Pick<Window, "location" | "history" | "sessionStorage" | "localStorage">): void {
  const m = /^#follow=([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(win.location.hash);
  if (!m) return;
  const follow = { computer_id: m[1]!, workspace_id: m[2]! };
  win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}#/w/${follow.workspace_id}`);
  if (chosenRuntime(win.localStorage)?.computer_id !== follow.computer_id) holdFollow(win, follow);
}

export function pendingFollow(storage: Pick<Storage, "getItem">): PendingFollow | null {
  try {
    const value = JSON.parse(storage.getItem(FOLLOW_KEY) ?? "null") as PendingFollow | null;
    return value && typeof value.computer_id === "string" && typeof value.workspace_id === "string" ? value : null;
  } catch {
    return null;
  }
}

export const clearPendingFollow = (storage: Pick<Storage, "removeItem">) => {
  storage.removeItem(FOLLOW_KEY);
  waitChanged();
};
