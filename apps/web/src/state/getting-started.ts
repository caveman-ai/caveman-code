// Getting started (shell/GettingStarted.tsx): the sidebar's checklist, ticked
// from what the runtime says is set up, never from what the person clicked.
// It also holds what the person put off: syncing chats (Not now on its prompt)
// and a device still waiting to be allowed.

import type { PluginSummary } from "@caveman-app/session-protocol";

export type StepId = "engine" | "connections" | "task" | "automation";

/** In order: an engine first (nothing runs without one), then connections, the step every person is nudged to. */
export const STEPS: ReadonlyArray<{ readonly id: StepId; readonly label: string }> = [
  { id: "engine", label: "Set up an engine" },
  { id: "connections", label: "Add connections" },
  { id: "task", label: "Start your first task" },
  { id: "automation", label: "Add an automation" },
];

export type Progress = Readonly<Record<StepId, boolean>>;

/** A plugin that signs in to a service (Linear, Slack, GitHub), installed and signed in. */
export function hasConnection(plugins: ReadonlyArray<Pick<PluginSummary, "installed" | "needs_connect" | "includes">>): boolean {
  return plugins.some((p) => p.installed && p.includes.connections > 0 && !p.needs_connect);
}

/**
 * Open, folded to its header, or without its setup steps: hidden by the person, or done (every setup step ticked).
 * Kept on this device.
 */
export type CardState = "open" | "folded" | "hidden" | "done";

const KEY = "caveman.gettingStarted";

/** What the person last chose here, or null when they never touched it (the card then decides: cardFolded). */
export function readCardState(): CardState | null {
  const saved = localStorage.getItem(KEY);
  return saved === "open" || saved === "folded" || saved === "hidden" || saved === "done" ? saved : null;
}

export function saveCardState(state: CardState): void {
  localStorage.setItem(KEY, state);
}

/**
 * Whether the card shows only its header. The person's own choice stands; untouched, it opens until the first task is
 * done, then folds to one line, so the steps stop taking the sidebar from the chats once there are chats. A step that
 * waits on the person now (`urgent`) keeps an untouched card open.
 */
export function cardFolded(chosen: CardState | null, taskDone: boolean, urgent = false): boolean {
  return chosen === "folded" || (chosen !== "open" && taskDone && !urgent);
}

/** The person's word on Getting started's sync step on this device ("never": hidden), until Settings holds an answer (state/sync-ask.ts). */
export type SyncAsk = "later" | "never" | null;

export const SYNC_STEP = "sync";
export const SYNC_LABEL = "Sync chats to your devices";
export const deviceStep = (deviceId: string) => `device:${deviceId}`;

export interface CardStep {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  /** It waits on the person now (a device asking, sync put off): marked, and it keeps the card open. Sync offered and not yet put off is a step, not an urgency. */
  readonly urgent?: true;
}

/**
 * What the card lists, in order: a device waiting to be allowed first (someone is holding it), then an engine, then
 * syncing chats while this Mac's Caveman offers it (the prompt never opens by itself), then the rest of setup. A card hidden or done keeps only what
 * still waits on the person; with nothing to list there is no card.
 * `sync`: offered and unanswered ("ask"), on, or neither. `progress`: null until the runtime has said what is set up.
 */
export function cardSteps(input: {
  readonly card: CardState | null;
  readonly progress: Progress | null;
  readonly sync: "ask" | "on" | null;
  readonly syncAsk: SyncAsk;
  readonly devices: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}): CardStep[] {
  const setup = input.card !== "hidden" && input.card !== "done" && input.progress !== null;
  const devices = input.devices.map((d): CardStep => ({ id: deviceStep(d.id), label: `Allow ${d.name}`, done: false, urgent: true }));
  const sync: CardStep[] =
    input.sync === "ask" && input.syncAsk !== "never"
      ? [{ id: SYNC_STEP, label: SYNC_LABEL, done: false, ...(input.syncAsk === "later" ? { urgent: true as const } : {}) }]
      : input.sync === "on" && setup
        ? [{ id: SYNC_STEP, label: SYNC_LABEL, done: true }]
        : [];
  if (!setup || input.progress === null) return [...devices, ...sync];
  const progress = input.progress;
  const [engine, ...rest] = STEPS.map((s): CardStep => ({ id: s.id, label: s.label, done: progress[s.id] }));
  return [...devices, engine!, ...sync, ...rest];
}

/** Every setup step is ticked: the card is done with them for good. */
export const setupDone = (progress: Progress | null): boolean => progress !== null && STEPS.every((s) => progress[s.id]);
