// Whether Auto can take Codex. An Auto thread swaps Codex's model provider for the
// app proxy's OpenAI route (CodexAdapterV2's codexThreadRuntimeParams), so it may
// only where Codex already talks to OpenAI's own API: routeCodexLaunch's viaProxy,
// the same reading its launch makes. Azure, Ollama, external tools or a company
// gateway keep their own provider and get no Auto. Not in cavemanRouter.ts:
// EngineEgress loads the adapters, which load that.
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { routeCodexLaunch } from "../secrets/EngineEgress.ts";

export function codexRoutable(input: { readonly configText: string; readonly launchArgs: string | undefined; readonly environment: NodeJS.ProcessEnv }): boolean {
  const routed = routeCodexLaunch({
    egress: { route: (url) => url, owns: () => false },
    configText: input.configText,
    launchArgs: resolveCodexLaunchArgs(input.launchArgs, input.environment),
    environment: input.environment,
  });
  return "args" in routed && routed.viaProxy === true;
}
