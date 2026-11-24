// What explain and check know about where they run: This Mac, the engines the runtime has and whether
// each can run, the class table each resolves fast, base and frontier with (classes.ts, the one table the
// step launcher uses too), what the Caveman engine's harness does in every session, and where Project triggers fire.
import type { EnvSnapshot } from "@caveman-app/automations";
import type { ServerProvider } from "@caveman-app/protocol";
import { HARNESS_LEVERS, type HarnessLever } from "@caveman-app/provider-caveman/levers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DEFAULT_RUN_USD } from "./budget.ts";
import { classTable, familyOf } from "./classes.ts";

/**
 * Measured once for the whole harness against the classic engine it replaced (the app's own connector runner, three
 * working days of 15-17 requests each, k=1); shown verbatim beside its one row.
 */
export const LEVER_EVIDENCE = "vs the classic engine: Opus 5.5 at 0.47x the cost over three working days, 48/48 steps done against 44/48 (measured in the app's own runner, one run)";

export const SERVED_TRIGGERS = ["manual", "schedule", "github"] as const;

export interface EngineFacts {
  readonly id: string;
  /** The engine's provider snapshot, when the runtime has one. */
  readonly provider?: ServerProvider | undefined;
  /** The engine's own default model (never Auto): what its class table is read beside. */
  readonly defaultModel?: string | undefined;
}

const reasonOf = (p: ServerProvider | undefined): string | undefined => {
  if (p === undefined) return "it is not set up in Caveman Code";
  if (p.availability === "unavailable") return p.unavailableReason ?? "its driver is missing";
  if (!p.enabled || p.status === "disabled") return "it is turned off in Settings";
  if (!p.installed) return "it is not installed";
  if (p.auth.status === "unauthenticated") return "it is not signed in";
  if (p.status === "error") return p.message ?? "it reports an error";
  return undefined;
};

/** The snapshot explain and check use, from what the runtime knows about its engines. */
export function envSnapshot(input: {
  readonly defaultEngine: string;
  readonly engines: ReadonlyArray<EngineFacts>;
  readonly triggerHome?: "code" | "github-actions" | undefined;
}): EnvSnapshot {
  const classes: Record<string, ReturnType<typeof classTable>> = {};
  const engines = input.engines.map((e) => {
    const reason = reasonOf(e.provider);
    if (e.provider !== undefined) {
      // The class table reads the family of the engine's own model; Auto has none, so fall back to a listed model's.
      const model = e.defaultModel !== undefined && familyOf(e.defaultModel) !== undefined ? e.defaultModel : e.provider.models.find((m) => familyOf(m.slug) !== undefined)?.slug;
      if (model !== undefined) classes[e.id] = classTable({ provider: e.provider, model });
    }
    const subscription = e.id !== "caveman" && e.provider?.auth.status === "authenticated" && e.provider.auth.type !== undefined && e.provider.auth.type !== "apiKey";
    return { id: e.id, available: reason === undefined, ...(reason === undefined ? {} : { reason }), ...(subscription ? { subscription: true } : {}) };
  });
  const levers = [
    // One measured row for the harness, then what it does (provider-caveman levers.ts): none is a switch, all always on.
    { engine: "caveman", id: "all", label: "Caveman harness", on: true, evidence: LEVER_EVIDENCE },
    ...(Object.keys(HARNESS_LEVERS) as Array<HarnessLever>).map((id) => ({ engine: "caveman", id, label: HARNESS_LEVERS[id], on: true, evidence: "" })),
    ...input.engines
      .filter((e) => e.id !== "caveman")
      .map((e) => ({ engine: e.id, id: "none", label: "Caveman's harness levers", on: false, evidence: "they run on the caveman engine only" })),
  ];
  return {
    host: "this-mac",
    defaultEngine: input.defaultEngine,
    engines,
    classes,
    levers,
    ...(input.triggerHome ? { triggerHome: input.triggerHome } : {}),
    servedTriggers: [...SERVED_TRIGGERS],
    defaultBudgetUsd: DEFAULT_RUN_USD,
  };
}

/** Without a runtime (the offline CLI): no engines to ask, so classes say they resolve when Caveman Code runs. */
export const offlineEnv = (triggerHome?: "code" | "github-actions"): EnvSnapshot => ({
  ...envSnapshot({ defaultEngine: "the new-chat default", engines: [], triggerHome }),
  offline: true,
});

/** The new-chat default engine when Settings name none, as workspace.create picks it. */
const DEFAULT_ENGINE = "claude-agent";

/** Reads the runtime's engines as engine.list sees them, for explain and check; the services are found once, here. */
export const makeEnvReader = Effect.gen(function* () {
  // Imported here, not at the top: the offline CLI uses this module's snapshot and must not load the server's modules.
  const [{ ProviderRegistry }, { defaultModelSlug, engineIdForInstance, instanceForEngine }, { SessionStore }] = yield* Effect.promise(() =>
    Promise.all([import("../provider/ProviderRegistry.ts"), import("../session-protocol/projector.ts"), import("../session-protocol/store.ts")]),
  );
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const store = yield* Effect.serviceOption(SessionStore);
  return (triggerHome?: "code" | "github-actions"): Effect.Effect<EnvSnapshot> =>
    Effect.gen(function* () {
      const snapshots = Option.isSome(registry) ? yield* registry.value.getProviders : [];
      const raw = Option.isSome(store) ? yield* store.value.kvGet("settings") : undefined;
      let defaultEngine = DEFAULT_ENGINE;
      try {
        defaultEngine = (raw === undefined ? undefined : (JSON.parse(raw) as { default_engine?: string }).default_engine) ?? DEFAULT_ENGINE;
      } catch {}
      // Without the provider registry nothing is known about engines, so none is called unavailable.
      if (Option.isNone(registry)) return envSnapshot({ defaultEngine, engines: [], triggerHome });
      const ids = [...new Set(snapshots.map((p) => engineIdForInstance(p.instanceId)))];
      if (!ids.includes(defaultEngine)) ids.unshift(defaultEngine);
      const engines = ids.map((id): EngineFacts => {
        const own = instanceForEngine(id);
        const provider = snapshots.find((p) => p.instanceId === own) ?? snapshots.find((p) => engineIdForInstance(p.instanceId) === id);
        return { id, provider, defaultModel: provider === undefined ? undefined : defaultModelSlug(snapshots, [own, provider.instanceId]) };
      });
      return envSnapshot({ defaultEngine, engines, triggerHome });
    });
});
