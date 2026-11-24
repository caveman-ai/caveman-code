import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { engineReady } from "../../state/engines.ts";

/** What engine.scan found for one engine; absent before a scan ran. */
export type LocalFound = "ready" | "signed_out" | "not_found";

/** Always on, so their own probe already says whether they are on this computer. */
const ALWAYS_ON = new Set(["claude-agent", "codex"]);

/**
 * Settings > Models & keys' agents: `here`, the ones on this computer (ready first, then the ones signed
 * out, which offer their sign-in), and `rest`, the ones to set up by hand. Before a scan only what an engine
 * already says counts: a harness nobody connected answers signed_out without having looked.
 */
export function localAgents(
  engines: ReadonlyArray<EngineDescriptor>,
  found: ReadonlyMap<string, LocalFound> | null,
): { readonly here: EngineDescriptor[]; readonly rest: EngineDescriptor[] } {
  const isHere = (e: EngineDescriptor) =>
    engineReady(e) ||
    e.auth.accounts.length > 0 ||
    (found?.get(e.id) ?? "not_found") !== "not_found" ||
    (ALWAYS_ON.has(e.id) && (e.auth.state === "signed_out" || e.auth.state === "checking"));
  const here = engines.filter(isHere);
  return {
    here: [...here.filter(engineReady), ...here.filter((e) => !engineReady(e))],
    rest: engines.filter((e) => !isHere(e)),
  };
}

/** Where each agent sat when the page first laid them out: ids in order, per group. */
export type AgentPlaces = {
  readonly here: ReadonlyArray<string>;
  readonly rest: ReadonlyArray<string>;
};

export const placesOf = (view: ReturnType<typeof localAgents>): AgentPlaces => ({
  here: view.here.map((e) => e.id),
  rest: view.rest.map((e) => e.id),
});

/**
 * `view` with every agent kept where `places` put it, in the same order: connecting one from More agents, signing
 * it in or removing its last account changes its status, never its place, so its open row and its sign-in steps
 * stay in front of the person. An agent `places` never saw goes where `view` puts it, after the held ones.
 */
export function holdPlaces(
  view: ReturnType<typeof localAgents>,
  places: AgentPlaces,
): { readonly here: EngineDescriptor[]; readonly rest: EngineDescriptor[] } {
  const byId = new Map<string, EngineDescriptor>(
    [...view.here, ...view.rest].map((e) => [e.id, e]),
  );
  const held = new Set<string>([...places.here, ...places.rest]);
  const group = (ids: ReadonlyArray<string>, fresh: ReadonlyArray<EngineDescriptor>) => [
    ...ids.flatMap((id) => byId.get(id) ?? []),
    ...fresh.filter((e) => !held.has(e.id)),
  ];
  return { here: group(places.here, view.here), rest: group(places.rest, view.rest) };
}

/** How many model names the Models row spells out; the rest are a count (Pi and OpenCode list hundreds). */
const MODELS_SHOWN = 6;

/** The Models row's line: the first few names, then how many more the model picker has. */
export function modelsLine(models: EngineDescriptor["models"]): string {
  const current = models.filter((m) => !m.legacy);
  const shown = current.slice(0, MODELS_SHOWN).map((m) => m.label);
  const more = models.length - shown.length;
  if (more === 0) return shown.join(", ");
  return shown.length > 0
    ? `${shown.join(", ")} and ${more} more in the picker`
    : `${more} in the picker`;
}
