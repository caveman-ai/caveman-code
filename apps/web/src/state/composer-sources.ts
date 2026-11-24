// What the composer's "/" and "@" menus offer from the runtime, held for
// every composer and transcript: the skills the engines load (skill.list) and
// each chat's engine's own commands (engine.commands). Menus open on what is
// already here and refresh behind it, so a keystroke never waits on the
// runtime.
import type { EngineCommand, Result } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { useEffect, useSyncExternalStore } from "react";

type SkillInfo = Result<"skill.list">["skills"][number];

/** Read this recently, a list is fresh enough: opening a menu again reads nothing. */
const FRESH_MS = 5_000;
/** An engine still reading its commands is asked again after this. */
const AGAIN_MS = 1_500;

/** One runtime list per key, loaded once, refreshed at most every few seconds. */
function cachedList<T>(load: (client: Client, key: string) => Promise<{ readonly value: ReadonlyArray<T>; readonly again?: boolean }>) {
  const EMPTY: ReadonlyArray<T> = [];
  let owner: Client | null = null;
  const held = new Map<string, { value: ReadonlyArray<T>; at: number }>();
  const loading = new Set<string>();
  const listeners = new Set<() => void>();
  const reload = (client: Client, key: string, force = false) => {
    if (owner !== client) {
      owner = client;
      held.clear();
      loading.clear();
    }
    const fresh = held.get(key);
    if (loading.has(key) || (!force && fresh && Date.now() - fresh.at < FRESH_MS)) return;
    loading.add(key);
    load(client, key)
      .then(
        ({ value, again }) => {
          if (owner !== client) return;
          held.set(key, { value, at: Date.now() });
          listeners.forEach((l) => l());
          if (again) setTimeout(() => reload(client, key, true), AGAIN_MS);
        },
        () => undefined,
      )
      .finally(() => loading.delete(key));
  };
  const use = (client: Client | null, key: string | undefined): ReadonlyArray<T> => {
    const snapshot = () => (client && key !== undefined && owner === client ? (held.get(key)?.value ?? EMPTY) : EMPTY);
    const value = useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      snapshot,
      snapshot,
    );
    useEffect(() => {
      if (client && key !== undefined) reload(client, key);
    }, [client, key]);
    return value;
  };
  return { reload, use };
}

const skills = cachedList<SkillInfo>((client) => client.call("skill.list", {}).then((r) => ({ value: r.skills })));
/** The skills every engine can load, loading them the first time. */
export const useSkills = (client: Client | null) => skills.use(client, "");
export const reloadSkills = (client: Client) => skills.reload(client, "");

const commands = cachedList<EngineCommand>((client, workspaceId) =>
  client.call("engine.commands", { workspace_id: workspaceId }).then((r) => ({ value: r.commands, again: r.pending === true })),
);
/** The chat's engine's own slash commands (Claude Agent's /security-review, a repository's .claude/commands). None without a chat. */
export const useEngineCommands = (client: Client | null, workspaceId: string | undefined) => commands.use(client, workspaceId);
export const reloadEngineCommands = (client: Client, workspaceId: string) => commands.reload(client, workspaceId);
