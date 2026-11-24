// ), packages/shared/src/nodeRuntime.ts @ ab3a3cd1.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "./HostProcess.ts";
import { CommandResolutionCache, resolveCommandPath } from "./shell.ts";

const NodeRuntimeFeature = Schema.Literals([
  "Local device support",
  "Device automation",
  "Antigravity",
  "Antigravity sign-in",
]);

export const nodeRuntimeUnavailableMessage = (feature: typeof NodeRuntimeFeature.Type): string =>
  `${feature} requires Node.js. Install Node.js and make sure node is on PATH, then retry.`;

export class NodeRuntimeUnavailableError extends Schema.TaggedError<NodeRuntimeUnavailableError>()(
  "NodeRuntimeUnavailableError",
  { feature: NodeRuntimeFeature, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return nodeRuntimeUnavailableMessage(this.feature);
  }
}

export interface SelfInvocation {
  /** The binary to spawn: Node, Electron (with `ELECTRON_RUN_AS_NODE`), or the packaged T3. */
  readonly command: string;
  /**
   * The absolute entrypoint script to place before the subcommand, or
   * undefined for the packaged binary, which dispatches subcommands from
   * argv[2] and treats a leading path as the subcommand itself.
   */
  readonly entrypoint: string | undefined;
}

/**
 * How another process runs this T3 install's CLI, for hidden subcommands the
 * server hands to children such as `acp-mcp-bridge`. `process.execPath` plus
 * `argv[1]` only works for a script run by Node; the single-executable has no
 * entrypoint script (Node repeats the binary at argv[1]), so callers must not
 * assemble the pair themselves.
 */
export const resolveSelfInvocation = Effect.fn("nodeRuntime.resolveSelfInvocation")(function* () {
  const command = yield* HostProcess.ExecutablePath;
  if (yield* HostProcess.IsExecutable)
    return { command, entrypoint: undefined } satisfies SelfInvocation;
  const path = yield* Path.Path;
  const entry = (yield* HostProcess.Arguments)[1];
  // Children spawn from their own working directory, so the script path must be absolute.
  return {
    command,
    entrypoint: entry === undefined ? undefined : path.resolve(entry),
  } satisfies SelfInvocation;
});

/**
 * `[--disable-sigusr1, entrypoint, ...args]`: the argv that runs `args`
 * against this install. The child (the ACP bridge holds the runtime's MCP
 * credential) must not open an inspector when another process sends it
 * SIGUSR1. The packaged binary takes no Node flags.
 */
export const selfInvocationArgs = (
  invocation: SelfInvocation,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  invocation.entrypoint === undefined ? args : ["--disable-sigusr1", invocation.entrypoint, ...args];

/**
 * `dev:ino`, exact, or undefined when the file cannot be read or has no id. Read as bigints: an NTFS file id is 64 bits
 * (its index and a reuse count), past what a number holds exactly for 6 of 25 files made on a windows-2025 runner,
 * and a rounded id could match another file's.
 */
const fileIdentity = (file: string) =>
  Effect.promise(() =>
    NodeFS.promises.stat(file, { bigint: true }).then(
      (info) => (info.ino > 0n ? `${info.dev}:${info.ino}` : undefined),
      () => undefined,
    ),
  );

/** A standalone T3 binary runs its embedded CLI, regardless of script arguments. */
export const resolveNodeExecutable = Effect.fn("nodeRuntime.resolveNodeExecutable")(function* (
  feature: typeof NodeRuntimeFeature.Type,
  environment?: NodeJS.ProcessEnv,
) {
  const executablePath = yield* HostProcess.ExecutablePath;
  if (!(yield* HostProcess.IsExecutable)) return executablePath;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const env = environment ?? (yield* HostProcess.Environment);
  const resolvedNodePath = yield* resolveCommandPath(platform === "win32" ? "node.exe" : "node", {
    // Batch wrappers require a shell; helper callers launch the runtime directly.
    env: platform === "win32" ? { ...env, PATHEXT: ".EXE" } : env,
  }).pipe(
    // Refresh immediately after the user installs Node and retries setup.
    Effect.provideService(CommandResolutionCache, new Map()),
  );
  if (resolvedNodePath === null) return yield* new NodeRuntimeUnavailableError({ feature });
  const nodePath = path.resolve(resolvedNodePath);
  // A launcher or symlink named node must not point back at the standalone app.
  const resolvedPath = yield* fs
    .realPath(nodePath)
    .pipe(Effect.mapError((cause) => new NodeRuntimeUnavailableError({ feature, cause })));
  if (resolvedPath === executablePath) return yield* new NodeRuntimeUnavailableError({ feature });
  // A hard link named node is the same file: the same device and file id.
  const [hostId, nodeId] = yield* Effect.all([fileIdentity(executablePath), fileIdentity(nodePath)]);
  if (hostId !== undefined && hostId === nodeId) return yield* new NodeRuntimeUnavailableError({ feature });
  // Launchers such as Vite+ dispatch by argv[0]; keep the node name intact.
  return nodePath;
});
