// ), apps/server/src/provider/testUtils/providerRegistryMock.ts @ ab3a3cd1.
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import type { ServerProvider } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@caveman-app/engine-core/server/maintenanceResolver";

const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistry.ProviderRegistry["Service"] => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshAfterUpdate: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const layer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry.ProviderRegistry, makeProviderRegistryMock(providers));

/** The instance registry over the same snapshots: what reads providers through their instances (chat titles' writers). */
export const instanceRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    listInstances: Effect.succeed(
      providers.map(
        (provider) => ({ instanceId: provider.instanceId, snapshot: { getSnapshot: Effect.succeed(provider) } }) as never,
      ),
    ),
  });
