// Which model `agent exec` runs: --model, else the agent file's, else `auto`. A class (fast, base, frontier), `auto` or
// a Claude alias resolves in the runtime's one resolver (mcp/delegationPolicy.ts, the class table in
// automations/classes.ts) within the family of the endpoint CAVEMAN_MODEL_BASE_URL points at, so a class never moves
// the work to another vendor. An endpoint of unknown family (a gateway or proxy) takes only a model id, sent as given.
import { ENDPOINT_FAMILIES, familyAutoModel, familySlugs, type EndpointFamily } from "@caveman-app/provider-caveman/exec";

import { isModelClass } from "../automations/classes.ts";
import { resolveChildSelection } from "../mcp/delegationPolicy.ts";

const ALIASES = new Set(["haiku", "sonnet", "opus"]);
const AUTO = new Set(["auto", "default", "inherit"]);

/** The model id to run (a slug of the family, or an id as given), or why it cannot be resolved. */
export function resolveExecModel(asked: string | undefined, family: EndpointFamily | undefined): { readonly model: string } | { readonly error: string } {
  const wanted = asked?.trim() || "auto";
  const needsFamily = AUTO.has(wanted) || isModelClass(wanted) || ALIASES.has(wanted);
  if (!needsFamily) return { model: wanted };
  if (family === undefined) {
    return {
      error: `model ${wanted} is resolved within the endpoint's provider family, and CAVEMAN_MODEL_BASE_URL's is unknown; set CAVEMAN_MODEL_PROVIDER to ${ENDPOINT_FAMILIES.join(", ")}, or pass --model <provider>/<model>`,
    };
  }
  const anchor = familyAutoModel(family);
  if (anchor === undefined) return { error: `the Caveman engine has no default model for ${family}; pass --model ${family}/<model>` };
  if (AUTO.has(wanted)) return { model: anchor };
  const resolved = resolveChildSelection({ provider: { models: familySlugs(family).map((slug) => ({ slug })) as never }, parentModel: anchor, sameEngine: true, wanted });
  return resolved === undefined ? { error: `no ${family} model is ${wanted}; pass --model ${family}/<model>` } : { model: resolved };
}
