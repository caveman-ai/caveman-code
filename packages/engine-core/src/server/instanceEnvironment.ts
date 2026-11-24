// ), packages/provider-core/src/server/instanceEnvironment.ts @ ab3a3cd1.
import type { ProviderInstanceEnvironment } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider
 // (upstream 97e35bcf23, #27115).
    if (typeof variable.value !== "string") continue;
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/** Host variables a process needs to run that carry no secret. */
const HOST_PROCESS_ENV = new Set([
  "PATH",
  "LANG",
  "TERM",
  "TMPDIR",
  // Windows cannot start a process without these.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
]);

export const isHostProcessEnvName = (name: string): boolean =>
  HOST_PROCESS_ENV.has(name.toUpperCase()) || name.startsWith("LC_");

/**
 * Variables only the runtime reads: its config and tokens (CAVEMAN_CODE_*,
 * among them the dev auth token and OTLP headers), the desktop's launch
 * plumbing (CAVEMAN_RUNTIME_*, ELECTRON_RUN_AS_NODE) and the dev server's
 * URL (VITE_DEV_SERVER_URL; a user's own VITE_* stay). The Session Protocol
 * token is a file, never a variable. On a Cloud computer, where the computers
 * service mounted the runtime's Cloud identity and checkout
 * (CAVEMAN_CLOUD_LINK_DIR, CAVEMAN_WORKSPACE_ROOT). Not the session's own MCP
 * endpoint and credential the runtime hands an engine (CAVEMAN_CODE_MCP_*,
 * CAVEMAN_CODE_ACP_MCP_*, CAVEMAN_CODE_PI_*): those are set for that engine.
 */
const RUNTIME_ONLY_ENV = /^(?:CAVEMAN_CODE_(?!(?:MCP|ACP_MCP|PI)_)\w*|CAVEMAN_RUNTIME_\w*|CAVEMAN_CLOUD_LINK_DIR|CAVEMAN_WORKSPACE_ROOT|VITE_DEV_SERVER_URL|ELECTRON_RUN_AS_NODE)$/i;

/**
 * An engine CLI's environment: the host's, like a CLI run by hand, never the
 * runtime's own variables. Each is set undefined rather than deleted, so a
 * spawn that also merges `process.env` (extendEnv) drops it too.
 */
export function withoutRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of [...Object.keys(process.env), ...Object.keys(env)]) {
    if (RUNTIME_ONLY_ENV.test(name)) out[name] = undefined;
  }
  return out;
}
