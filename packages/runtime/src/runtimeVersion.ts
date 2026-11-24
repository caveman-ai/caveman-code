// Which build this runtime is, for everything that says so: `--version`, server-runtime.json, runtime.hello, Cloud's
// heartbeat, the moves copy, the database guard, and the names it gives itself to MCP servers and the web.
import packageJson from "../package.json" with { type: "json" };

/** Set by the bundle step (scripts/bundle.ts); absent when the runtime runs from source. */
declare const __CAVEMAN_RUNTIME_VERSION__: string | undefined;

/**
 * This runtime's build: the desktop app's version for the runtime it bundles, the npm package's for `caveman-code`, the
 * release's for a Cloud computer image (each from CAVEMAN_APP_VERSION when the bundle is built). From source, or a
 * bundle built without one, package.json's 0.0.0, which readers treat as unknown.
 */
export const RUNTIME_VERSION: string =
  typeof __CAVEMAN_RUNTIME_VERSION__ === "string"
    ? __CAVEMAN_RUNTIME_VERSION__
    : packageJson.version;

/**
 * Features of this runtime a client or Caveman Cloud gates on (runtime.hello and the heartbeat), never on its version.
 * None yet: every feature clients gate on today predates runtime.hello and keeps its -32601 or `unsupported` fallback.
 * The next feature a peer must know of before using it adds its name here (the moves design's `blob_refs` is the
 * first one expected, docs/ §7.7).
 */
export const RUNTIME_CAPABILITIES: ReadonlyArray<string> = [];
