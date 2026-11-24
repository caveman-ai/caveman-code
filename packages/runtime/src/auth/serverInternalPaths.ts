// ), apps/server/src/auth/serverInternalPaths.ts @ 6eef6811c3.
// @effect-diagnostics nodeBuiltinImport:off - Effect's realPath keeps the requested letter case.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";

/**
 * The rest of the state dir that holds this runtime's own credentials: the Session Protocol
 * token (session-protocol/server.ts), the app proxy's sign-in (router/proxyLauncher.ts), the
 * Cloud link identity (cloudLink), a Claude Agent sign-in made on a Cloud computer
 * (ClaudeAdapterV2), and what the broker attaches to plugins (plugins/PluginRegistry.ts).
 */
const CREDENTIAL_ENTRIES = [
  "session-protocol.token",
  "proxy",
  "cloud-link",
  "claude-env",
  "plugin-credentials",
] as const;

export interface ServerInternalRoots {
  /** Real paths, as native realpath gives them (on-disk letter case). */
  readonly stateDir: string;
  readonly secretsDir: string;
}

const isWithin = (candidate: string, root: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

/** Whether a real path is the runtime's own state, which no client file read serves. */
export const isServerInternalRealPath = (file: string, roots: ServerInternalRoots): boolean =>
  isWithin(file, roots.secretsDir) ||
  (NodePath.dirname(file) === roots.stateDir && NodePath.basename(file).includes(".sqlite")) ||
  CREDENTIAL_ENTRIES.some((entry) => isWithin(file, NodePath.join(roots.stateDir, entry))) ||
  (process.platform !== "win32" &&
    // macOS does not resolve `/dev/fd/N` to the open file's path, and Linux's /proc
    // holds this process's environment and memory.
    (isWithin(file, "/dev/fd") || isWithin(file, "/proc")));

// Native realpath returns the on-disk letter case. A path that does not exist (yet)
// resolves through its parent; one whose parent is missing too is taken as given.
const realPathSync = (value: string) => {
  try {
    return NodeFS.realpathSync.native(value);
  } catch {
    try {
      return NodePath.join(
        NodeFS.realpathSync.native(NodePath.dirname(value)),
        NodePath.basename(value),
      );
    } catch {
      return NodePath.resolve(value);
    }
  }
};

const realPath = (value: string) =>
  NodeFSP.realpath(value).catch(() =>
    NodeFSP.realpath(NodePath.dirname(value)).then(
      (parent) => NodePath.join(parent, NodePath.basename(value)),
      () => NodePath.resolve(value),
    ),
  );

/**
 * The same check for code outside Effect services (Session Protocol handlers). Build it per
 * request: the state dirs resolve once, then every path asked about resolves on its own.
 */
export const makeServerInternalPathCheck = (
  config: Pick<ServerConfig.ServerConfig["Service"], "stateDir" | "secretsDir">,
) => {
  const roots = {
    stateDir: realPathSync(config.stateDir),
    secretsDir: realPathSync(config.secretsDir),
  };
  return (filePath: string) => isServerInternalRealPath(realPathSync(filePath), roots);
};

/** Builds a check for the server's own state files, which client file reads do not serve. */
export const makeIsServerInternalPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const resolve = (value: string) => Effect.promise(() => realPath(value));
  return Effect.fn("ServerInternalPaths.isServerInternalPath")(function* (filePath: string) {
    const [file, stateDir, secretsDir] = yield* Effect.all(
      [resolve(filePath), resolve(config.stateDir), resolve(config.secretsDir)],
      { concurrency: "unbounded" },
    );
    return isServerInternalRealPath(file, { stateDir, secretsDir });
  });
});
