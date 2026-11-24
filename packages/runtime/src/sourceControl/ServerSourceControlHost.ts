// ), apps/server/src/sourceControl/ServerSourceControlHost.ts @ ab3a3cd1.
// Ports upstream 81899ce04c (#27746): `getWithSecrets` reads a host's credential references.
/**
 * The server's implementation of `SourceControlHost.SourceControlHost`, the only server surface
 * source control provider packages may use.
 *
 * @module sourceControl/ServerSourceControlHost
 */
import * as SourceControlHost from "@caveman-app/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SecretResolver from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    // Without a resolver (tests, a runtime without a secret store) a reference reads as unset.
    const secrets = yield* Effect.serviceOption(SecretResolver.SecretResolver);
    return SourceControlHost.SourceControlHost.of({
      settings: {
        get: serverSettings.getSettings,
        getWithSecrets: (kind) =>
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              secrets._tag === "None"
                ? Effect.succeed(settings)
                : resolveSourceControlHostSecrets(
                    secrets.value,
                    settings.sourceControlHosts,
                    kind,
                  ).pipe(
                    Effect.map((sourceControlHosts) =>
                      sourceControlHosts === settings.sourceControlHosts
                        ? settings
                        : { ...settings, sourceControlHosts },
                    ),
                  ),
            ),
          ),
      },
      process: { run: process.run },
      git: {
        execute: git.execute,
        resolveCommit: git.resolveCommit,
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: git.readConfigValue,
        resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
        ensureRemote: git.ensureRemote,
        listLocalBranchNames: git.listLocalBranchNames,
        fetchRemoteBranch: git.fetchRemoteBranch,
        fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
        setBranchUpstream: git.setBranchUpstream,
        createBranch: git.createBranch,
        writeConfigValue: git.writeConfigValue,
        switchRef: git.switchRef,
      },
    });
  }),
);
