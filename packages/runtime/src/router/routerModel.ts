// The Caveman router's model id, without the router's imports (provider-caveman's adapter among them), so the model
// resolvers (mcp/delegationPolicy.ts) load in commands that must start fast (`agent exec`). cavemanRouter.ts re-exports it.

/** The model id the proxy routes. Claude Code takes it as `caveman-auto[1m]`. */
export const ROUTER_MODEL = "caveman-auto";

/** True for the Auto model id, with or without Claude's context suffix. */
export const isRouterModel = (model: string | null | undefined): boolean =>
  model === ROUTER_MODEL || model === `${ROUTER_MODEL}[1m]`;
