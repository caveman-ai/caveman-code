// Settings > Computers as one flat list: the person's Macs and Cloud, each with how many chats run there and one
// state, then Cloud's projects under its row. A person never meets a machine here: no name of one, no size, nothing
// to wake or put to sleep (docs/ a chat runs on a Mac of theirs or in Cloud).
// Pure, so computers.test.ts pins every state.
import type { CloudComputerRow, Project } from "@caveman-app/session-protocol";
import { computerStatus, type ComputerChat, type ComputerTone } from "../../state/cloud.ts";
import type { WorkspaceView } from "../../state/model.ts";
import type { ChatsOnComputer, CloudComputersView } from "../../state/useCloudComputers.ts";

type Chat = Pick<WorkspaceView, "computer" | "state" | "projectId" | "repo"> & {
  readonly automationStep?: boolean;
};
/** The chats a row counts: every chat that is not archived, an automation's steps left out. */
const counts = (w: Chat) => w.state !== "archived" && w.automationStep !== true;

export const chatsWord = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;

export interface PlaceState {
  readonly label: string;
  readonly tone: ComputerTone;
  /** What Cloud's own service wrote about a start that is held up or failed: shown only on a click. */
  readonly detail?: string;
}

export interface MacRow {
  readonly key: string;
  /** "This Mac" on that Mac; the Mac's own name anywhere else. */
  readonly name: string;
  readonly chats: number;
  /** Online or Asleep; absent when Caveman has not said (signed out of Caveman). */
  readonly state?: PlaceState;
}

const ONLINE: PlaceState = { label: "Online", tone: "ok" };
const ASLEEP: PlaceState = { label: "Asleep", tone: "idle" };

/** A Mac as Cloud lists it: its name and whether it was heard from lately. */
export interface ListedMac {
  readonly runtime_id: string;
  readonly name: string;
  readonly online: boolean;
}

/**
 * The person's Macs: the one this window is on first (`here`: its name on this page, null on the web, which is on
 * no Mac), then each other Mac by its own name, from the chats on it and from Cloud's list of the person's Macs
 * (`listed`, with this window's own left out by `ownRuntimeId`).
 */
export function macRows(input: {
  readonly here: string | null;
  readonly workspaces: ReadonlyArray<Chat>;
  readonly lives: (w: Chat) => boolean;
  readonly listed?: ReadonlyArray<ListedMac> | undefined;
  readonly ownRuntimeId?: string | null | undefined;
}): ReadonlyArray<MacRow> {
  const rows: MacRow[] = [];
  if (input.here !== null)
    rows.push({
      key: "here",
      name: input.here,
      chats: input.workspaces.filter((w) => input.lives(w) && counts(w)).length,
      state: ONLINE,
    });
  const others = new Map<string, { chats: number; online?: boolean }>();
  for (const w of input.workspaces) {
    if (input.lives(w) || w.computer.kind === "caveman_cloud" || w.computer.kind === "pool")
      continue;
    const at = others.get(w.computer.label) ?? { chats: 0 };
    others.set(w.computer.label, { ...at, chats: at.chats + (counts(w) ? 1 : 0) });
  }
  for (const mac of input.listed ?? []) {
    if (mac.runtime_id === input.ownRuntimeId) continue;
    const at = others.get(mac.name) ?? { chats: 0 };
    // Two of its runtimes (an app restarted): online if either is.
    others.set(mac.name, { ...at, online: at.online === true || mac.online });
  }
  for (const [name, at] of [...others].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({
      key: `mac:${name}`,
      name,
      chats: at.chats,
      ...(at.online === undefined ? {} : { state: at.online ? ONLINE : ASLEEP }),
    });
  }
  return rows;
}

export interface CloudProject {
  /** Cloud's id for what holds the project there: what Delete names to Cloud, never shown. */
  readonly id: string;
  /** The project's name: from the chats that run there, else Cloud's own name for it. */
  readonly name: string;
  readonly chats: number;
  readonly state: PlaceState;
}

export interface CloudRow {
  readonly chats: number;
  readonly state: PlaceState;
  /** What the row's one button does where Cloud cannot be used yet. */
  readonly action?: "sign_in";
  /** One line per project, under the row once it is opened. */
  readonly projects: ReadonlyArray<CloudProject>;
}

/** How much of the month's plan Cloud has used, and when the plan starts over: all a plan ever shows. */
export interface CloudUsage {
  readonly pct?: number | undefined;
  readonly resetsAt?: string | undefined;
}

const short = (repo: string) => repo.replace(/\/+$/, "").split("/").at(-1) || repo;

/** What a project in Cloud is called: its project's name here, else its repository's, else Cloud's own word. */
function projectName(
  c: CloudComputerRow,
  on: ReadonlyArray<Chat>,
  projects: ReadonlyArray<Pick<Project, "id" | "name">>,
): string {
  for (const w of on) {
    const project = projects.find((p) => p.id === w.projectId);
    if (project) return project.name;
  }
  const repo = on.find((w) => w.repo)?.repo;
  return repo ? short(repo) : c.name || "Project";
}

/** "2 running · 12% of this month's plan": the share is said only beside a plain state. */
const withUsage = (label: string, usage: CloudUsage) =>
  usage.pct === undefined ? label : `${label} · ${Math.floor(usage.pct)}% of this month's plan`;

/**
 * The Cloud row and its projects from Cloud's list. One state for the whole place: a start that failed or is held
 * up first (it needs the person's eye), then how many projects are running, then waking, then paused by the plan,
 * else asleep.
 */
export function cloudRow(input: {
  readonly view: CloudComputersView;
  readonly workspaces: ReadonlyArray<Chat>;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "name">>;
  readonly usage?: CloudUsage;
  readonly now?: Date;
}): CloudRow {
  const usage = input.usage ?? {};
  const inCloud = input.workspaces.filter((w) => w.computer.kind === "caveman_cloud" && counts(w));
  const none = { chats: inCloud.length, projects: [] as CloudProject[] };
  switch (input.view.state) {
    case "loading":
      return { ...none, state: { label: "Loading…", tone: "busy" } };
    case "signed_out":
      return { ...none, state: { label: "Not signed in", tone: "idle" }, action: "sign_in" };
    case "off":
      return { ...none, state: { label: "Turned off by your admin", tone: "idle" } };
    case "error":
      return { ...none, state: { label: UNREACHABLE, tone: "warn", detail: input.view.error } };
  }
  const projects = input.view.computers
    .filter((c) => c.desired_state !== "deleted" || c.observed_state !== "deleted")
    .map((c): CloudProject => {
      const on = input.workspaces.filter((w) => w.computer.id === c.id);
      return {
        id: c.id,
        name: projectName(c, on, input.projects),
        chats: on.filter(counts).length,
        state: computerStatus(c, usage.resetsAt, input.now),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const chats = Math.max(
    inCloud.length,
    projects.reduce((n, p) => n + p.chats, 0),
  );
  const is = (label: string) => projects.filter((p) => p.state.label === label).length;
  const trouble =
    projects.find((p) => p.state.tone === "bad") ?? projects.find((p) => p.state.tone === "warn");
  const paused = projects.find((p) => p.state.label.startsWith("Paused"));
  const state: PlaceState = input.view.error
    ? { label: UNREACHABLE, tone: "warn", detail: input.view.error }
    : trouble
      ? trouble.state
      : is("Running") > 0
        ? { label: withUsage(`${is("Running")} running`, usage), tone: "ok" }
        : is("Waking…") > 0
          ? { label: withUsage("Waking…", usage), tone: "busy" }
          : paused && projects.every((p) => p.state.label.startsWith("Paused"))
            ? paused.state
            : { label: withUsage("Asleep", usage), tone: "idle" };
  return { chats, state, projects };
}

/** Cloud's list could not be read; it is read again every few seconds by itself. */
export const UNREACHABLE = "Can't reach Caveman. Trying again.";

/**
 * What changed in Cloud between two polls, in one line for a screen reader ("acme: Asleep."), so asleep, waking and
 * gone are heard as they happen, not only seen. The first list says nothing.
 */
export function cloudChanges(
  before: ReadonlyMap<string, { readonly name: string; readonly label: string }> | null,
  projects: ReadonlyArray<CloudProject>,
): string {
  if (before === null) return "";
  const out: string[] = [];
  const now = new Set<string>();
  for (const p of projects) {
    now.add(p.id);
    const was = before.get(p.id);
    if (was !== undefined && was.label !== p.state.label)
      out.push(`${p.name}: ${p.state.label}`.replace(/\.?$/, "."));
  }
  for (const [id, was] of before) if (!now.has(id)) out.push(`${was.name}: Deleted.`);
  return out.join(" ");
}

const named = (chats: ReadonlyArray<ComputerChat>) => {
  const titles = chats.map((c) => c.title);
  return titles.length <= 3
    ? titles.join(", ")
    : `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more`;
};

/**
 * The one question before a project leaves Cloud, which cannot be undone: what it archives, by name, and that
 * uncommitted work there is lost. Read from Cloud's own lists of the person's chats; while they are read the answer
 * waits, and when they cannot be read it says so rather than that nothing is there.
 */
export function deleteWords(
  name: string,
  chats: ChatsOnComputer,
  known: ReadonlyArray<string> = [],
): {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly waiting: boolean;
} {
  const title = `Delete ${name} from Cloud?`;
  const confirm = "Delete";
  if (chats.state === "loading")
    return { title, description: "Looking for its chats…", confirm, waiting: true };
  const on =
    chats.state === "listed"
      ? chats.on
      : known.map((t): ComputerChat => ({ title: t, kind: "chat" }));
  const archived = chats.state === "listed" ? chats.archived : [];
  const parts = [
    chats.state === "unlisted" ? "Couldn't list its chats." : null,
    on.length > 0
      ? `Archives ${on.length === 1 ? "1 chat" : `${on.length} chats`}: ${named(on)}.`
      : null,
    archived.length > 0
      ? `${named(archived)} ${archived.length === 1 ? "is" : "are"} archived and ${archived.length === 1 ? "loses its" : "lose their"} uncommitted work.`
      : null,
    "Uncommitted work there is lost. Chat history is kept.",
  ];
  return { title, description: parts.filter(Boolean).join(" "), confirm, waiting: false };
}
