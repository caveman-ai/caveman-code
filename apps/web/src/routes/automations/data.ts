// The Automations page's reads: one cache for the app (module level), so going from the list to an automation, a run
// and back paints at once while each read refreshes behind it. A read in flight is shared, except after a write
// (`refresh`), which reads again; `patch` shows a change before the runtime answers (an on switch), and the next read
// replaces it. Only the newest read's answer lands: one that started before another, or before a change shown, is dropped.
import type { Client } from "@caveman-app/session-protocol/client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRuntime } from "../../state/runtime.tsx";
import type { AgentTypeInfo } from "@caveman-app/session-protocol";
import { cloudStatus, isAgentFile, localGate, notServed, readCloudRun, sha256, type Applied, type CloudAutomation, type CloudRun, type HookShown, type LocalGateView, type PublishedAgent } from "./cloud.ts";
import { fileRef, isAgentRun, isLive, type Automation, type RunRecord, type RunSummary, type Scope } from "./model.ts";

interface Entry {
  value?: unknown;
  error?: string | undefined;
  inflight?: Promise<unknown> | undefined;
  /** Counts the reads started and the changes shown here; a read's answer lands only while it is still the last. */
  turn?: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};
const versionSnapshot = () => version;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The entry's read in flight, or a new one; `fresh` (after a write) always starts a new one. */
function load<T>(key: string, read: () => Promise<T>, fresh = false): Promise<T> {
  const entry = entries.get(key) ?? {};
  entries.set(key, entry);
  if (entry.inflight && !fresh) return entry.inflight as Promise<T>;
  const turn = (entry.turn = (entry.turn ?? 0) + 1);
  const run = read().then(
    (value) => {
      if (entry.turn === turn) {
        Object.assign(entry, { value, error: undefined, inflight: undefined });
        emit();
      }
      return value;
    },
    (error: unknown) => {
      if (entry.turn === turn) {
        Object.assign(entry, { error: message(error), inflight: undefined });
        emit();
      }
      throw error;
    },
  );
  entry.inflight = run;
  return run;
}

/** A change shown here outdates the read in flight: it may have read the runtime before the write. */
const supersede = (entry: Entry) => {
  entry.turn = (entry.turn ?? 0) + 1;
  entry.inflight = undefined;
};

export const message = (e: unknown) => (e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : String(e));

/** Shows `next` for `key` now; a read started after it replaces it. */
export function patch<T>(key: string, next: (value: T) => T): void {
  const entry = entries.get(key);
  if (entry?.value === undefined) return;
  entry.value = next(entry.value as T);
  supersede(entry);
  emit();
}

export interface Read<T> {
  readonly value: T | undefined;
  readonly error: string | undefined;
  readonly reload: () => Promise<void>;
}

/** A read under `key`, asked again on every mount and every `pollMs(value)` ms while that says a number. */
export function useRead<T>(key: string | null, read: (client: Client) => Promise<T>, pollMs?: (value: T) => number | null): Read<T> {
  const { client } = useRuntime();
  useSyncExternalStore(subscribe, versionSnapshot, versionSnapshot);
  const entry = key ? entries.get(key) : undefined;
  const reload = useCallback(async () => {
    if (client && key) await load(key, () => read(client)).catch(() => undefined);
    // `read` is rebuilt each render; the key names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  useEffect(() => void reload(), [reload]);
  const every = entry?.value !== undefined && pollMs ? pollMs(entry.value as T) : null;
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => void reload(), every);
    return () => clearInterval(timer);
  }, [every, reload]);
  return { value: entry?.value as T | undefined, error: entry?.error, reload };
}

/** Shows `value` under `key` at once, as if a read had answered it (what a write answered). */
export function remember<T>(key: string, value: T): void {
  const entry = entries.get(key) ?? {};
  entries.set(key, Object.assign(entry, { value, error: undefined }));
  supersede(entry);
  emit();
}

/** Reads every entry whose key starts with `prefix` again (after a write). */
export function refresh(client: Client | null, prefix: string): void {
  if (!client) return;
  for (const key of [...entries.keys()]) {
    const reader = key.startsWith(prefix) ? READERS.find(([p]) => key.startsWith(p)) : undefined;
    if (reader) void load(key, () => reader[1](key)(client), true).catch(() => undefined);
  }
}

// ------------------------------------------------------------ the reads

export const LIST = "list";
const readList = (c: Client) => c.call("automation.list", {}).then((r) => r.automations);
const readTemplates = (c: Client) => c.call("automation.templates", {}).then((r) => r.templates);
const readExplain = (id: string) => (c: Client) => {
  const ref = fileRef(id);
  if (!ref) return Promise.reject(new Error("Only automation files explain themselves."));
  return c.call("automation.explain", { project_id: ref.project_id, name: ref.name, scope: ref.scope });
};
const readRuns = (projectId: string, name: string, scope: Scope) => (c: Client) => c.call("automation.runs", { project_id: projectId, name, scope, limit: 50 }).then((r) => r.runs);
/** `caveman-runtime agent run` work: the newest runs of every project's `agent-<name>` automations. */
const readAgentRuns = (c: Client) =>
  // A runtime from before `agent_runs` ignores it and answers its newest runs.
  c.call("automation.runs", { agent_runs: true, limit: 100 }).then((r) => r.runs.filter((x) => isAgentRun(x.automation)).slice(0, 6));
const readRun = (runId: string) => (c: Client) => c.call("automation.run_get", { run_id: runId }).then((r) => r.run);
const readDeliveries = (id: string) => (c: Client) => c.call("automation.deliveries", { id }).then((r) => r.deliveries);
const readFile = (projectId: string, path: string) => (c: Client) => c.call("automation.file_read", { project_id: projectId, path }).then((r) => r.text);
/** This Mac runs stopped at an approval gate, oldest first: the Inbox asks for them every 30 s. */
export interface GateRow {
  readonly run_id: string;
  readonly automation_id: string;
  readonly automation: string;
  readonly started_at: string;
  readonly gate: LocalGateView;
  readonly trigger: RunRecord["trigger"];
}
const readGates = (c: Client): Promise<ReadonlyArray<GateRow>> =>
  c.call("automation.runs", { status: "waiting", limit: 200 }).then(async (r) => {
    // A runtime from before `status` ignores it and answers its newest runs.
    const waiting = r.runs.filter((x) => x.status === "waiting");
    const records = await Promise.all(waiting.map((x) => c.call("automation.run_get", { run_id: x.run_id }).then((y) => y.run, () => null)));
    return records
      .flatMap((rec, i) => {
        const gate = rec ? localGate(rec) : null;
        const x = waiting[i]!;
        return gate && rec ? [{ run_id: x.run_id, automation_id: x.automation_id, automation: x.automation, started_at: x.started_at, gate, trigger: rec.trigger }] : [];
      })
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  });

/** A Cloud read; null when this runtime does not serve it, so the page leaves Cloud out. */
const orNull = <T>(read: Promise<T>): Promise<T | null> => read.catch((e: unknown) => (notServed(e) ? null : Promise.reject(e)));
const readCloudList = (c: Client) => orNull(c.call("automation.cloud_list", {}).then((r) => r.automations));
const readCloudRuns = (c: Client) => orNull(c.call("automation.cloud_runs", { limit: 100 }).then((r) => r.runs.map(readCloudRun)));
const readPublished = (c: Client) => orNull(c.call("agent.published", {}).then((r) => r.agents));
const readSha = (projectId: string, path: string) => (c: Client) => readFile(projectId, path)(c).then(sha256);
/** Every project's own agent files (`.caveman/agents/*.md`), in project order. */
const readAgentFiles = (projectIds: ReadonlyArray<string>) => (c: Client) =>
  Promise.all(projectIds.map((id) => c.call("agent.types", { project_id: id }).then((r) => r.types.filter(isAgentFile).map((t) => ({ ...t, project_id: id }))))).then((all) => all.flat());

/** How `refresh` reads a key again, by its prefix. */
const READERS: ReadonlyArray<readonly [string, (key: string) => (c: Client) => Promise<unknown>]> = [
  [LIST, () => readList],
  ["templates", () => readTemplates],
  ["explain:", (k) => readExplain(k.slice(8))],
  ["runs:", (k) => readRuns(...(k.slice(5).split("\n") as [string, string, Scope]))],
  ["agent-runs", () => readAgentRuns],
  ["run:", (k) => readRun(k.slice(4))],
  ["deliveries:", (k) => readDeliveries(k.slice(11))],
  ["file:", (k) => readFile(...(k.slice(5).split("\n") as [string, string]))],
  ["gates", () => readGates],
  ["cloud-list", () => readCloudList],
  ["cloud-runs", () => readCloudRuns],
  ["published", () => readPublished],
  ["sha:", (k) => readSha(...(k.slice(4).split("\n") as [string, string]))],
  ["types:", (k) => (c: Client) => c.call("agent.types", { project_id: k.slice(6) }).then((r) => r.types)],
  ["agent-files:", (k) => readAgentFiles(k.slice(12).split("\n").filter(Boolean))],
];

const LIVE_POLL_MS = 2000;
const LIST_POLL_MS = 5000;

/** Every automation, asked again every 5 s while one of them runs. */
/** Connections already following automation.changed: one listener each, however many readers are mounted. */
const following = new WeakSet<Client>();
export const useAutomations = () => {
  const { client } = useRuntime();
  // A file saved anywhere (an editor, an agent in another worktree) or a merge: the runtime says so, and the list,
  // what explains that project's automations and their open files (its drafts' too) are read again. An open editor
  // keeps its unsaved edits (useFileBuffer).
  useEffect(() => {
    if (!client || following.has(client)) return;
    following.add(client);
    client.on("automation.changed", ({ project_id }) => {
      refresh(client, LIST);
      refresh(client, `explain:file:${project_id}`);
      refresh(client, `file:${project_id}`);
    });
  }, [client]);
  return useRead<ReadonlyArray<Automation>>(LIST, readList, (list) => (list.some((a) => (a.runs_running ?? 0) > 0) ? LIST_POLL_MS : null));
};
export const useTemplates = () => useRead("templates", readTemplates);
export const useExplain = (id: string | null) => useRead(id && fileRef(id) ? `explain:${id}` : null, readExplain(id ?? ""));
export const runsKey = (projectId: string, name: string, scope: Scope) => `runs:${projectId}\n${name}\n${scope}`;
export const useRuns = (ref: { project_id: string; name: string; scope: Scope } | null, live: boolean) =>
  useRead(ref ? runsKey(ref.project_id, ref.name, ref.scope) : null, readRuns(ref?.project_id ?? "", ref?.name ?? "", ref?.scope ?? "project"), () => (live ? LIVE_POLL_MS : null));
/** Agent runs for the list, asked again every 5 s while one runs. */
export const useAgentRuns = () => useRead<ReadonlyArray<RunSummary>>("agent-runs", readAgentRuns, (runs) => (runs.some((r) => isLive(r.status)) ? LIST_POLL_MS : null));
/** One run, asked again every 2 s until it ends. */
export const useRun = (runId: string) => useRead<RunRecord>(`run:${runId}`, readRun(runId), (run) => (isLive(run.status) ? LIVE_POLL_MS : null));
export const useDeliveries = (id: string | null) => useRead(id ? `deliveries:${id}` : null, readDeliveries(id ?? ""));
export const fileKey = (projectId: string, path: string) => `file:${projectId}\n${path}`;
export const useFileText = (projectId: string | null, path: string | null) => useRead(projectId && path ? fileKey(projectId, path) : null, readFile(projectId ?? "", path ?? ""));

// ------------------------------------------------------------ Cloud

const CLOUD_LIVE_MS = 5000;
/** How often the Inbox asks Cloud for runs that wait on someone. */
export const CLOUD_INBOX_MS = 30_000;

/** This Mac runs waiting on an approval, for the Inbox. */
export const useLocalGates = () => useRead<ReadonlyArray<GateRow>>("gates", readGates, () => CLOUD_INBOX_MS);

/** Cloud's copies of this org's automations (null: this runtime serves no Cloud). */
export const useCloudList = (on = true) => useRead<ReadonlyArray<CloudAutomation> | null>(on ? "cloud-list" : null, readCloudList);
/** Runs on Cloud, asked again every 5 s while one runs (or every `everyMs`, for the Inbox). Not asked at all when `on` is false. */
export const useCloudRuns = ({ on = true, everyMs }: { on?: boolean; everyMs?: number } = {}) =>
  useRead<ReadonlyArray<CloudRun> | null>(on ? "cloud-runs" : null, readCloudRuns, (runs) =>
    runs === null ? null : (everyMs ?? (runs.some((r) => isLive(cloudStatus(r.status))) ? CLOUD_LIVE_MS : null)),
  );
/** What the last Deploy of a project's files answered, kept on this computer so it shows after a restart too. */
export const appliedKey = (projectId: string) => `applied:${projectId}`;
const APPLIED_STORE = "caveman.automations.applied";

function storedApplied(): Record<string, ReadonlyArray<Applied>> {
  try {
    const v = JSON.parse(localStorage.getItem(APPLIED_STORE) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ReadonlyArray<Applied>>) : {};
  } catch {
    return {};
  }
}

/** Cloud automation ids this computer deployed, to their names; rebuilt after each Deploy. */
let appliedNames: ReadonlyMap<string, string> | null = null;
const NO_APPLIED: ReadonlyArray<Applied> = [];

/** Keeps a Deploy's answer for its project: shown at once, and kept on this computer. */
export function rememberApplied(projectId: string, applied: ReadonlyArray<Applied>): void {
  try {
    localStorage.setItem(APPLIED_STORE, JSON.stringify({ ...storedApplied(), [projectId]: applied }));
  } catch {
    // Storage full or off: the answer still shows for this session.
  }
  appliedNames = null;
  remember(appliedKey(projectId), applied);
}

/** The last Deploy's answer for a project: this session's, else the one kept on this computer. */
export function useApplied(projectId: string | null): ReadonlyArray<Applied> {
  // The answer itself is the snapshot, so a Deploy redraws every reader.
  const read = () => (projectId ? ((entries.get(appliedKey(projectId))?.value as ReadonlyArray<Applied> | undefined) ?? storedFor(projectId)) : NO_APPLIED);
  return useSyncExternalStore(subscribe, read, read);
}

/** One project's kept answer, read once and then held, so the snapshot stays the same array until the next Deploy. */
function storedFor(projectId: string): ReadonlyArray<Applied> {
  const key = appliedKey(projectId);
  const entry = entries.get(key) ?? {};
  if (entry.value === undefined) {
    entry.value = storedApplied()[projectId] ?? NO_APPLIED;
    entries.set(key, entry);
  }
  return entry.value as ReadonlyArray<Applied>;
}

/** Cloud automation ids this computer deployed, to their names: how a Cloud run that names none finds its automation. */
export function useAppliedNames(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, namesSnapshot, namesSnapshot);
}

function namesSnapshot(): ReadonlyMap<string, string> {
  if (appliedNames) return appliedNames;
  const all: Record<string, ReadonlyArray<Applied>> = { ...storedApplied() };
  for (const [key, entry] of entries) if (key.startsWith("applied:") && entry.value) all[key.slice(8)] = entry.value as ReadonlyArray<Applied>;
  appliedNames = new Map(Object.values(all).flatMap((list) => list.map((x) => [x.id, x.name] as const)));
  return appliedNames;
}

/** The webhook URLs and secrets the last Deploy made: in memory only, until the person closes them, never on disk. */
const NO_HOOKS: ReadonlyArray<HookShown> = [];
let hooksShown = NO_HOOKS;
export function showHooks(hooks: ReadonlyArray<HookShown>): void {
  hooksShown = hooks.length > 0 ? hooks : NO_HOOKS;
  emit();
}
export const forgetHooks = () => showHooks(NO_HOOKS);
const hooksSnapshot = () => hooksShown;
export const useShownHooks = (): ReadonlyArray<HookShown> => useSyncExternalStore(subscribe, hooksSnapshot, hooksSnapshot);

/** The org's agents on Cloud with their versions (null: this runtime serves no Cloud). */
export const usePublished = () => useRead<ReadonlyArray<PublishedAgent> | null>("published", readPublished);
/** The sha256 of an agent file as it is in the project now. */
export const shaKey = (projectId: string, path: string) => `sha:${projectId}\n${path}`;
export const useFileSha = (projectId: string, path: string | undefined) => useRead(path ? shaKey(projectId, path) : null, readSha(projectId, path ?? ""));

export type AgentFile = AgentTypeInfo & { readonly project_id: string };
/** The agent files of these projects. */
export const useAgentFiles = (projectIds: ReadonlyArray<string>) =>
  useRead<ReadonlyArray<AgentFile>>(projectIds.length > 0 ? `agent-files:${projectIds.join("\n")}` : null, readAgentFiles(projectIds));

/** The agents a project's steps can name, with where each comes from. */
export const useAgentTypes = (projectId: string | null) =>
  useRead(projectId ? `types:${projectId}` : null, (c: Client) => c.call("agent.types", { project_id: projectId! }).then((r) => r.types));

/** A row the pointer rests on: its explain and runs read ahead, so its page paints whole (as Review warms a pull request). */
export function warm(client: Client | null, a: Automation): void {
  const ref = fileRef(a.id);
  if (!client || !ref) return;
  const reads: Array<readonly [string, (c: Client) => Promise<unknown>]> = [
    [`explain:${a.id}`, readExplain(a.id)],
    [runsKey(ref.project_id, ref.name, ref.scope), readRuns(ref.project_id, ref.name, ref.scope)],
  ];
  for (const [key, read] of reads) if (entries.get(key)?.value === undefined) void load(key, () => read(client)).catch(() => undefined);
}

/** The list's copy of one automation, so its page paints from the list it was opened from. */
export function useAutomation(id: string): { automation: Automation | undefined; loading: boolean; error: string | undefined } {
  const list = useAutomations();
  // A draft that merged is the project's own automation now: its open page follows it there.
  const ref = fileRef(id);
  const at = ref?.project_id.indexOf("@") ?? -1;
  const merged = ref && at > 0 ? `file:${ref.project_id.slice(0, at)}:${ref.scope}:${ref.name}` : id;
  const automation = list.value?.find((a) => a.id === id) ?? (merged === id ? undefined : list.value?.find((a) => a.id === merged));
  return { automation, loading: list.value === undefined && !list.error, error: list.error };
}
