/**
 * The Caveman engine's modules, imported on first use rather than at the runtime's start: the harness (one bundle with
 * its Pi packages) and the plugin and skill loader. Their graph was most of what a woken Cloud computer's runtime
 * loaded before it linked, and the link, an adopt and a tool call need none of it (Caveman Cloud the spec addendum
 * 2026-10-24). `@caveman-ai/agent/durable` stays a static import: a dozen files, and a move's journal reads it.
 *
 * Everything here runs once a chat runs the engine; `prefetchCavemanEngine` starts the import early, once the
 * runtime has linked, so a first turn finds it loaded.
 *
 * @module provider-caveman/server/engine
 */
import type * as Harness from "@caveman-ai/harness";
import type * as Plugins from "@caveman-ai/agent/plugins";
import * as Effect from "effect/Effect";

import { loadHarness } from "./harness.ts";

export interface CavemanEngine {
  readonly harness: typeof Harness;
  readonly plugins: typeof Plugins;
}

let loading: Promise<CavemanEngine> | undefined;

/** The engine's modules: the first call imports them, every later one shares that import. */
export const loadCavemanEngine = (): Promise<CavemanEngine> =>
  (loading ??= Promise.all([loadHarness(), import("@caveman-ai/agent/plugins")]).then(
    ([harness, plugins]) => ({ harness, plugins }),
  ));

/** The same, in an effect. The engine ships inside the runtime, so a failed import is a defect, as it was at start. */
export const cavemanEngine: Effect.Effect<CavemanEngine> = Effect.promise(loadCavemanEngine);

/** Starts the import without waiting on it; a failure surfaces at the first use. */
export const prefetchCavemanEngine = (): void => {
  loadCavemanEngine().catch(() => undefined);
};
