/**
 * The environment an ACP agent runs in. ACP agents are third-party code (often
 * a binary downloaded from the registry), so they never inherit the runtime's
 * own environment and the API keys and tokens in it. They get what a process
 * needs to run, a home of their own under the runtime's state dir (their
 * logins and caches live there), and the variables configured on their
 * provider instance, which is how credentials reach an agent.
 *
 * @module provider-acp-registry/server/agentEnvironment
 */
import type { ProviderInstanceEnvironment } from "@caveman-app/protocol";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import {
  isHostProcessEnvName,
  mergeProviderInstanceEnvironment,
} from "@caveman-app/engine-core/server/instanceEnvironment";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const acpAgentEnvironment = Effect.fn("acpAgentEnvironment")(function* (
  instanceId: string,
  environment: ProviderInstanceEnvironment | undefined,
) {
  const { paths } = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* HostProcess.Environment;
  const home = path.join(paths.stateDir, "acp-homes", instanceId);
  yield* fileSystem.makeDirectory(home, { recursive: true });

  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && isHostProcessEnvName(name)) {
      base[name] = value;
    }
  }
  Object.assign(base, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  });
  return yield* mergeProviderInstanceEnvironment(environment, base);
});
