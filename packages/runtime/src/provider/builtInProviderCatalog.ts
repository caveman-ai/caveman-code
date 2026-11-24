// ), apps/server/src/provider/builtInProviderCatalog.ts @ ab3a3cd1.
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@caveman-app/protocol";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@caveman-app/engine-core/server/snapshot";

export type ProviderSnapshotSource = {
  /**
   * Routing key — uniquely identifies this instance in the aggregated
   * snapshot list. Two different snapshot sources may share the same
   * driver kind (multiple instances of the same driver).
   */
  readonly instanceId: ProviderInstanceId;
  /** Driver implementation kind. */
  readonly driverKind: ProviderDriverKind;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
