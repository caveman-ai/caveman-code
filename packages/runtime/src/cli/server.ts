// ), apps/server/src/cli/server.ts @ ab3a3cd1.
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import { markStartup } from "../startupTrace.ts";
import { EXIT_WITH_STDIN_ENV } from "./code.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

/** A write to the gone launcher's pipe is expected during shutdown; anything else still surfaces. */
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) =>
  Effect.gen(function* () {
    // Loaded here, not at the top: every other command (`--version`, `__claude-history`) skips the server's
    // module graph. Before config resolution, which claims a port and creates directories.
    const [{ runServer }, { untilDesktopGone }] = yield* Effect.promise(() =>
      Promise.all([import("../server.ts"), import("../session-protocol/index.ts")]),
    );
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    markStartup("server starting");
    const server = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
    // `caveman code` on Windows asks for the same through the environment (it has no signal to stop us with); the
    // variable goes once read, so nothing we start (an engine, a terminal's shell, a runtime run in it) inherits it.
    const exitWithStdin = process.env[EXIT_WITH_STDIN_ENV] === "1";
    delete process.env[EXIT_WITH_STDIN_ENV];
    if (config.desktopBootstrapToken === undefined && !exitWithStdin) return yield* server;
    // The launcher reads our stdout and stderr too. Once it is gone every log write fails, and Node turns an
    // unhandled stream error into a crash that skips the finalizers below.
    yield* Effect.sync(() => {
      process.stdout.on("error", ignoreClosedLauncherPipe);
      process.stderr.on("error", ignoreClosedLauncherPipe);
    });
    // Started by the desktop (or `caveman code` on Windows): its stdin closing stops the server (every finalizer
    // runs), then the runtime exits 0.
    yield* server.pipe(Effect.raceFirst(untilDesktopGone()));
    // Whatever still holds the event loop (a socket the finalizers missed) gets a moment, then exits with us.
    setTimeout(() => {
      // Named, so a crash on the way out (Windows' 0xC0000409) says what was still running.
      process.stderr.write(
        `runtime: exiting with ${process.getActiveResourcesInfo().join(", ") || "nothing"} still open\n`,
      );
      process.exit(0);
    }, DESKTOP_EXIT_GRACE_MS).unref();
  });

/** After the desktop's stdin closed and the server stopped, how long a lingering handle may keep the process. */
const DESKTOP_EXIT_GRACE_MS = 2_000;

/** Bare words can name existing directories, but must not create typo projects. */
export const runDefaultServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value.trim();
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const explicitPath =
        cwd === "." ||
        cwd === ".." ||
        cwd === "~" ||
        /[/\\]/.test(cwd) ||
        (platform === "win32" && /^[a-z]:/i.test(cwd));
      if (
        !explicitPath &&
        (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")
      ) {
        return yield* new CliError.UserError({
          cause: cwd,
          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "caveman-runtime --help" for commands or an explicit path such as "caveman-runtime ./my-project" for a new directory.`,
        });
      }
    }
    return yield* runServerCommand(flags, { rejectRunningServer: true });
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Caveman Code server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Caveman Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
