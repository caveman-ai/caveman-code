// The prototype's Settings: what the runtime's Settings would hold (session-protocol `settings.get`), scripted and
// kept for as long as the app runs, so a section shows what you left it on when you come back to it. A control moves
// at once, as the desktop's useSaveSettings does; nothing is sent anywhere until the phone talks to a runtime.
//
// The model a new chat starts on is the picker's part of Settings (board/catalog.ts Choices): the default engine and
// its model are Home's Default, and each model's effort and speed are its start. Settings writes those there, so New
// chat, the picker's Default tag and Settings read one thing. Here are only each other engine's model for new chats.
import { useSyncExternalStore } from "react";
import { CATALOG, type Choices, type Entry, entryKey, setChoices } from "../../board/catalog";
import type { Access } from "../composer/menus";

export type Patience = "quick" | "normal" | "patient";

export interface Values {
  /** General > New chats: the composer's Permissions for a new chat (shell/composer/menus.tsx ACCESS). */
  default_access: Access;
  /**
   * Each engine's model for new chats, by harness id (Settings.engines[id].model). The default engine's own lives in
   * the catalog's defaultModel while it leads; this keeps the others'.
   */
  engine_models: Readonly<Record<string, string>>;
  /** General > Inbox. */
  inbox_done_on_merge: boolean;
  inbox_done_after_days: number | null;
  inbox_keep_pull_requests: boolean;
  inbox_archive_done_after_days: number | null;
  /** General > Git. */
  git_co_author: boolean;
  /** Notifications. */
  notify_needs_input: boolean;
  notify_turn_done: boolean;
  live_activity: boolean;
  /** Appearance: the gallery's pick (light or dark is AppearanceContext; the companion is the cast's own store). */
  color_theme: string;
  /** Chiefs > Limits, shared by every Chief. */
  chief_max_concurrent: number;
  chief_ask_above_chats: number;
  chief_ask_wait_minutes: number;
  chief_daily_cap_usd: number;
  chief_daily_turns: number;
  /** Chiefs > Calls. */
  chief_voice_key: string | null;
  chief_voice_name: string;
  chief_voice_patience: Patience;
  chief_voice_ring_back: boolean;
  /** Computers. */
  move_to_cloud: boolean;
  move_other_engines: boolean;
}

let values: Values = {
  default_access: "full",
  engine_models: { "claude-agent": "claude-opus-5-5", codex: "gpt-5-5" },
  inbox_done_on_merge: true,
  inbox_done_after_days: 3,
  inbox_keep_pull_requests: false,
  inbox_archive_done_after_days: null,
  git_co_author: true,
  notify_needs_input: true,
  notify_turn_done: true,
  live_activity: true,
  color_theme: "caveman",
  chief_max_concurrent: 0,
  chief_ask_above_chats: 3,
  chief_ask_wait_minutes: 15,
  chief_daily_cap_usd: 0,
  chief_daily_turns: 0,
  chief_voice_key: "…4f2a",
  chief_voice_name: "flux-cliff-en",
  chief_voice_patience: "normal",
  chief_voice_ring_back: true,
  move_to_cloud: true,
  move_other_engines: true,
};

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => values;
/** Settings as they stand, outside React. */
export const settingsNow = () => values;

/** Settings as they stand, and the way to change some of them (`settings.set`'s patch). */
export function useSettings(): [Values, (patch: Partial<Values>) => void] {
  const now = useSyncExternalStore(subscribe, read, read);
  return [now, save];
}

function save(patch: Partial<Values>) {
  values = { ...values, ...patch };
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- what new chats start on

/**
 * The model new chats on `harness` start on (the desktop's settingModel): the default's own while that engine leads,
 * else the one kept for it, else its first current model.
 */
export function newChatModel(harness: string, kept: Values["engine_models"], choices: Choices): Entry | undefined {
  const engine = CATALOG.find((e) => e.id === harness);
  const id = choices.defaultModel.engine === harness ? choices.defaultModel.model : kept[harness];
  const model = engine && (engine.models.find((m) => m.id === id) ?? engine.models.find((m) => !m.legacy) ?? engine.models[0]);
  return engine && model ? { engine, model } : undefined;
}

/** General's model for an engine (withDefaultModel): kept for it, and Home's Default too while that engine leads. */
export function setNewChatModel(harness: string, model: string) {
  save({ engine_models: { ...values.engine_models, [harness]: model } });
  setChoices((was) => (was.defaultModel.engine === harness ? { ...was, defaultModel: { engine: harness, model } } : was));
}

/** Models & keys' "New chats start on" (default_engine): that engine on its own model; the one it leaves keeps its. */
export function setNewChatEngine(harness: string, choices: Choices) {
  const was = choices.defaultModel;
  if (was.engine === harness) return;
  const next = newChatModel(harness, values.engine_models, choices);
  if (!next) return;
  save({ engine_models: { ...values.engine_models, [was.engine]: was.model } });
  setChoices((now) => ({ ...now, defaultModel: { engine: harness, model: next.model.id } }));
}

/** Where a model starts (withModelStart): its effort where it has a choice of levels, its speed where it has a faster one. */
export function setModelStart(entry: Entry, start: { effort?: string; speed?: string }) {
  const { efforts, speeds } = entry.model;
  setChoices((was) => ({
    ...was,
    starts: { ...was.starts, [entryKey(entry)]: { ...(start.effort && efforts.length > 1 ? { effort: start.effort } : {}), ...(start.speed && speeds?.length ? { speed: start.speed } : {}) } },
  }));
}
