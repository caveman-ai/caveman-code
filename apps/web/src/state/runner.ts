// Who runs an agent, for RunnerBadge (packages/ui/src/components/runner-badge.tsx): the runtime's
// SubagentRunner where it sends one, else the workspace's engine, the model its latest turn
// started on and the engine's active login.
import type { EngineDescriptor, SubagentRunner, Workspace } from "@caveman-app/session-protocol";
import type { PickerEngine } from "@caveman-app/ui/components/model-picker";
import type { Runner } from "@caveman-app/ui/components/runner-badge";
import { pickableLogins } from "./accounts.ts";

type EngineLike = {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string; readonly legacy?: boolean }>;
  readonly auth: { readonly state: string; readonly accounts: ReadonlyArray<{ readonly id: string; readonly active: boolean; readonly tag?: string; readonly where?: "everywhere" | "cloud" | "this_mac" }> };
};

/** Who runs a delegated agent, as the runtime sends it (subagent.started, a child Workspace). */
export type WireRunner = SubagentRunner;

export function runnerFor(
  engines: ReadonlyArray<EngineLike>,
  src: {
    readonly engine: string;
    readonly model?: string | null | undefined;
    readonly effort?: string | null | undefined;
    readonly runner?: WireRunner | null | undefined;
    /** The login its latest turn started on (turn.started account_id). */
    readonly account_id?: string | undefined;
  },
): Runner {
  const r = src.runner;
  const id = r?.engine ?? src.engine;
  const engine = engines.find((e) => e.id === id);
  const model = r?.model ?? src.model ?? undefined;
  // The runner's own login, else the one its turn started on; else only an engine's one and only login (an honest blank beats a guess).
  const accounts = engine?.auth.accounts ?? [];
  const named = r?.instance_id ?? src.account_id;
  const account = named !== undefined ? accounts.find((a) => a.id === named) : accounts.length === 1 ? accounts[0] : undefined;
  return {
    engine: id,
    engineLabel: engine?.label,
    model,
    modelLabel: model ? engine?.models.find((m) => m.id === model)?.label : undefined,
    tag: r?.account_tag ?? account?.tag,
    effort: r?.effort ?? src.effort ?? undefined,
    // `options`: the runtime's count of what Auto picked among; no count, no number.
    pick: r ? { by: r.pick.by, kind: r.pick.kind, task: r.pick.task, fallback: r.pick.fallback, options: r.pick.options } : undefined,
  };
}

/** A child Workspace's runner, where the runtime sends one. */
export function childRunner(workspace: Workspace | undefined): WireRunner | null {
  return workspace?.runner ?? null;
}

/**
 * Every ready engine for a picker that pins a login: an engine with several logins becomes one
 * section per login (`<engine>#<account>`, headed by the login's name), so both Claude Agent logins
 * show. `instanceOf` reads the account back from a picked section id. Only this computer's own logins
 * are sections (pickableLogins): a connection is never picked, the person's order decides which runs.
 */
export function loginEngines(engines: ReadonlyArray<EngineDescriptor>): PickerEngine[] {
  return engines.flatMap((e): PickerEngine[] => {
    const accounts = pickableLogins(e.auth.accounts);
    // The Caveman engine's accounts are provider keys, on its models (withModelSources), not logins.
    // Its `auto` is a router, not a model a pin can name.
    if (e.id === "caveman") return [{ id: e.id, label: e.label, models: e.models.filter((m) => m.id !== "auto") }];
    if (accounts.length <= 1) return [{ id: e.id, label: e.label, models: e.models }];
    return accounts.map((a) => ({ id: `${e.id}#${a.id}`, harness: e.id, label: e.label, account: a.label, models: e.models }));
  });
}

/**
 * A login section id back to its engine and account: the engine's active or first login of its own when the section
 * names none; an engine that runs on connections alone, its active account.
 */
export function instanceOf(engines: ReadonlyArray<EngineLike>, sectionId: string): { engine: string; instance_id: string } | null {
  const [engine, account] = sectionId.split("#") as [string, string | undefined];
  const all = engines.find((x) => x.id === engine)?.auth.accounts ?? [];
  const own = pickableLogins(all);
  const from = own.length > 0 ? own : all;
  const id = account ?? from.find((a) => a.active)?.id ?? from[0]?.id;
  return id ? { engine, instance_id: id } : null;
}

/**
 * A pin's section id in loginEngines (and the composer's chatPickerEngines). The Caveman engine is one section
 * however many keys it holds: its accounts are provider keys, not logins.
 */
export function sectionOf(engines: ReadonlyArray<EngineLike>, pin: { readonly engine: string; readonly instance_id: string }): string {
  const e = engines.find((x) => x.id === pin.engine);
  return e && e.id !== "caveman" && pickableLogins(e.auth.accounts).length > 1 ? `${pin.engine}#${pin.instance_id}` : pin.engine;
}
