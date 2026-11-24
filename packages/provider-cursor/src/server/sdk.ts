// ), packages/provider-cursor/src/server/sdk.ts @ 13aa882c22.
// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// native Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);

type Sdk = typeof import("@cursor/sdk");
type SqliteSdk = typeof import("@cursor/sdk/sqlite");
let sdk: Sdk | undefined;
let sqlite: SqliteSdk | undefined;

/**
 * The SDK, loaded on first use rather than at the runtime's start: loaded, it adds 25-60 MiB to the runtime, and a
 * runtime that runs no Cursor chat (a warm Cloud computer waiting for its claim, say) never needs it.
 */
export const cursorSdk = (): Sdk => (sdk ??= requireCursorSdk("@cursor/sdk") as Sdk);
/** Its local agent store, on first use too. */
export const cursorSqlite = (): SqliteSdk => (sqlite ??= requireCursorSdk("@cursor/sdk/sqlite") as SqliteSdk);

/**
 * Whether `cause` is one of the SDK's error classes. It never loads the SDK: an error from a
 * failed load is classified without loading it again, and an SDK nobody loaded threw nothing.
 */
export function isCursorSdkError<
  K extends "AuthenticationError" | "ConfigurationError" | "CursorSdkError",
>(cause: unknown, kind: K): cause is InstanceType<Sdk[K]> {
  return sdk !== undefined && cause instanceof sdk[kind];
}
