// Session Protocol's revisions (README: Versioning). No Effect here: client.ts reads them.
import type { RuntimeHello } from "./protocol.ts";

/**
 * The Session Protocol revision this build speaks: an integer that rises only when a change needs both sides to know
 * it. An additive change does not raise it, and a feature a peer must check before using gets a capability instead.
 * A runtime from before runtime.hello reads as revision 0.
 */
export const PROTOCOL_REVISION = 1;
/** The lowest client revision a runtime of this build serves (runtime.hello's `min_client_revision`). */
export const MIN_CLIENT_REVISION = 0;
/** The lowest runtime revision a client of this build works with; below it the client asks for the runtime's update. */
export const MIN_RUNTIME_REVISION = 0;

/** What a client takes a runtime without runtime.hello (it answers -32601) to be. */
export const LEGACY_RUNTIME: RuntimeHello = {
  version: "",
  protocol_revision: 0,
  min_client_revision: 0,
  capabilities: [],
};

export type VersionSkew = "runtime_older" | "client_older";

/**
 * How this client and a runtime stand: `runtime_older` when the runtime speaks an older revision than this client
 * needs, `client_older` when the runtime needs a newer client than this one, null when they work together.
 */
export function versionSkew(
  hello: RuntimeHello,
  client: { readonly revision: number; readonly minRuntime: number } = {
    revision: PROTOCOL_REVISION,
    minRuntime: MIN_RUNTIME_REVISION,
  },
): VersionSkew | null {
  if (hello.protocol_revision < client.minRuntime) return "runtime_older";
  if (hello.min_client_revision > client.revision) return "client_older";
  return null;
}
