// ), packages/shared/src/shell.test.ts @ ab3a3cd1; perf from 7f63b10275.
// @effect-diagnostics nodeBuiltinImport:off -- The synchronous shell probe runs real commands with isolated config files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  CommandResolutionCache,
  isCommandAvailable,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  npmShimExecutable,
  preferGitForWindowsBinary,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellAsync,
  readPathFromLaunchctl,
  readWindowsRegistryEnvironment,
  resolveCommandPath,
  resolveKnownWindowsCliDirs,
  resolveSpawnCommand,
  resolveWindowsPath,
  SpawnExecutableResolution,
  type SpawnExecutableResolver,
  windowsRegistryPath,
  withPathDirectoryListings,
  XcodeGitLocation,
} from "./shell.ts";

const nativeProbe = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
  original: undefined as unknown as typeof import("node:child_process").execFile,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  nativeProbe.original = original.execFile;
  return { ...original, execFile: nativeProbe.execFile.mockImplementation(original.execFile) };
});

const recordCommandTrace = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const result = yield* effect.pipe(Effect.withTracer(tracer), Effect.result);
  return { result, spans };
});


/**
 * Runs `effect` as on Windows itself (process.platform, which the current-directory search depends on, not only the
 * host the effect is told of), with this process's own current-directory search on or off.
 */
const withExeSearch =
  (currentDirectory: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const before = { platform: process.platform, value: process.env.NoDefaultCurrentDirectoryInExePath };
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        if (currentDirectory) delete process.env.NoDefaultCurrentDirectoryInExePath;
        else process.env.NoDefaultCurrentDirectoryInExePath = "1";
        return before;
      }),
      () => effect,
      (before) =>
        Effect.sync(() => {
          Object.defineProperty(process, "platform", { value: before.platform, configurable: true });
          if (before.value === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
          else process.env.NoDefaultCurrentDirectoryInExePath = before.value;
        }),
    );

describe("readEnvironmentFromLoginShell probe", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__CAVEMAN_CODE_ENV_PATH_START__\n/a:/b\n__CAVEMAN_CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromLoginShell("/opt/homebrew/bin/fish", ["PATH"], execFile).PATH).toBe(
      "/a:/b",
    );
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__CAVEMAN_CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__CAVEMAN_CODE_ENV_PATH_END__");
    expect(options).toEqual({
      encoding: "utf8",
      timeout: 5000,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      killSignal: "SIGKILL",
    });
  });
});

describe.skipIf(process.platform === "win32")("readEnvironmentFromLoginShellAsync", () => {
  it("reads the login environment from its own session, away from the caller's terminal", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-probe-"));
    try {
      // A stand-in login shell: `$2` is the capture command. PROBE_GROUP is "<pgid>-<pid>",
      // equal halves only when the probe leads its own process group (spawned detached).
      const shell = NodePath.join(dir, "shell");
      NodeFS.writeFileSync(
        shell,
        [
          "#!/bin/sh",
          'PATH="/probe/bin:$PATH"; export PATH',
          'PROBE_GROUP="$(ps -o pgid= -p $$ | tr -d \' \')-$$"; export PROBE_GROUP',
          'exec /bin/sh -c "$2"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const environment = await readEnvironmentFromLoginShellAsync(shell, ["PATH", "PROBE_GROUP"]);
      expect(environment.PATH?.startsWith("/probe/bin:")).toBe(true);
      const [group, pid] = (environment.PROBE_GROUP ?? "").split("-");
      expect(group).toBe(pid);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A stand-in login shell whose rc leaves a job running on the probe's stdout, as `nohup agent &`
  // or `some-daemon &` in a user's ~/.zshrc does. The job's pid is recorded so the test can end it.
  const withBackgroundJobShell = async (
    script: ReadonlyArray<string>,
    run: (shell: string) => Promise<void>,
  ) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-probe-"));
    const jobPid = NodePath.join(dir, "job.pid");
    const shell = NodePath.join(dir, "shell");
    NodeFS.writeFileSync(
      shell,
      ["#!/bin/sh", `sleep 60 & echo $! > '${jobPid}'`, ...script, ""].join("\n"),
      { mode: 0o755 },
    );
    try {
      await run(shell);
    } finally {
      try {
        process.kill(Number(NodeFS.readFileSync(jobPid, "utf8").trim()), "SIGKILL");
      } catch {}
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  const outcomeWithin = async (probe: Promise<Partial<Record<string, string>>>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe.then(
          (environment) => ({ path: environment.PATH }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(`still waiting after ${ms} ms`), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  it("answers with what the shell printed once it exits, while a job its rc started holds the output open", async () => {
    await withBackgroundJobShell(
      ['PATH="/probe/bin:$PATH"; export PATH', 'exec /bin/sh -c "$2"'],
      async (shell) => {
        const outcome = await outcomeWithin(readEnvironmentFromLoginShellAsync(shell, ["PATH"]), 6_000);
        expect(outcome).toEqual({ path: expect.stringMatching(/^\/probe\/bin:/) });
      },
    );
  }, 15_000);

  it("says how the shell exited when its rc fails, while a job the rc started holds the output open", async () => {
    await withBackgroundJobShell(["exit 3"], async (shell) => {
      const outcome = await outcomeWithin(readEnvironmentFromLoginShellAsync(shell, ["PATH"]), 6_000);
      expect(outcome).toEqual({ error: `${shell} exited with 3` });
    });
  }, 15_000);

  it("gives up at its 5 s bound on a shell that ignores SIGTERM and never finishes", async () => {
    await withBackgroundJobShell(["trap '' TERM", "wait"], async (shell) => {
      const outcome = await outcomeWithin(readEnvironmentFromLoginShellAsync(shell, ["PATH"]), 6_000);
      expect(outcome).toEqual({ error: `${shell} timed out reading the login environment` });
    });
  }, 15_000);

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readPid = (file: string) => Number(NodeFS.readFileSync(file, "utf8").trim());
  const waitUntilGone = async (pid: number) => {
    // A killed process is reaped (by us or by init) a moment after it dies.
    for (let tries = 0; tries < 40 && isAlive(pid); tries++) await new Promise((r) => setTimeout(r, 50));
    return !isAlive(pid);
  };

  it("kills a shell that ignores SIGTERM, and what it started, when the read times out", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-probe-"));
    try {
      // An rc file that hangs: the shell ignores SIGTERM, and a background child holds stdout.
      const shell = NodePath.join(dir, "shell");
      NodeFS.writeFileSync(
        shell,
        [
          "#!/bin/sh",
          "trap '' TERM",
          `echo $$ > '${dir}/shell.pid'`,
          "sleep 60 &",
          `echo $! > '${dir}/child.pid'`,
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const started = Date.now();
      await expect(readEnvironmentFromLoginShellAsync(shell, ["PATH"], 500)).rejects.toThrow(/timed out/);
      // Settled when the killed group closed stdout, not at the give-up deadline.
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await waitUntilGone(readPid(NodePath.join(dir, "shell.pid")))).toBe(true);
      expect(await waitUntilGone(readPid(NodePath.join(dir, "child.pid")))).toBe(true);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives up by a second after the timeout when something outside the shell's group holds stdout", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-probe-"));
    const escapedPidFile = NodePath.join(dir, "escaped.pid");
    try {
      // A grandchild that leaves the shell's process group keeps the pipe open after the group is
      // killed, the same as a process stuck in the kernel that SIGKILL can't end: no `close` comes.
      const shell = NodePath.join(dir, "shell");
      NodeFS.writeFileSync(
        shell,
        [
          "#!/bin/sh",
          "trap '' TERM",
          `perl -e 'setpgrp(0, 0); open(my $f, ">", $ARGV[0]); print $f $$; close $f; sleep 60' '${escapedPidFile}' &`,
          `while [ ! -s '${escapedPidFile}' ]; do sleep 0.05; done`,
          "while :; do sleep 1; done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const started = Date.now();
      await expect(readEnvironmentFromLoginShellAsync(shell, ["PATH"], 1000)).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - started;
      // The killed shell's exit settles it at the timeout; the pipe the escaped grandchild holds open is not waited for,
      // and the grace second is the most it waits when no exit comes either.
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
      expect(isAlive(readPid(escapedPidFile))).toBe(true);
    } finally {
      if (NodeFS.existsSync(escapedPidFile)) {
        try {
          process.kill(readPid(escapedPidFile), "SIGKILL");
        } catch {}
      }
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  // Opt in with an explicit binary, like the provider live probes; CI need not install Nu.
  it.runIf(process.env.T3_TEST_NU_PATH !== undefined)(
    "captures Nushell PATH and multiline values without external tools",
    () => {
      const shell = process.env.T3_TEST_NU_PATH!;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nu-env-"));
      try {
        const toolPath = NodePath.join(home, "nu tools", "bin");
        const extraToolPath = NodePath.join(home, "extra-tools", "bin");
        NodeFS.mkdirSync(toolPath, { recursive: true });
        NodeFS.mkdirSync(extraToolPath, { recursive: true });
        const config = NodePath.join(home, "config.nu");
        const envConfig = NodePath.join(home, "env.nu");
        NodeFS.writeFileSync(envConfig, "");
        NodeFS.writeFileSync(
          config,
          [
            `$env.PATH = [${JSON.stringify(toolPath)}, "~/extra-tools/bin", "rel/dir", ""]`,
            '$env.CUSTOM_VAR = "  first\\nsecond  "',
            '$env.EMPTY_VAR = ""',
            'print "startup noise"',
          ].join("\n"),
        );

        expect(
          readEnvironmentFromLoginShell(
            shell,
            ["MISSING_VAR", "PATH", "EMPTY_VAR", "CUSTOM_VAR"],
            (file, args, options) =>
              NodeChildProcess.execFileSync(
                file,
                ["--no-history", "--config", config, "--env-config", envConfig, ...args],
                {
                  ...options,
                  env: { HOME: home, XDG_CONFIG_HOME: home, PATH: toolPath },
                },
              ),
          ),
        ).toEqual({
          PATH: `${toolPath}:${extraToolPath}:rel/dir:`,
          CUSTOM_VAR: "  first\nsecond  ",
        });
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  // Startup reads the fallback shells synchronously, so a hung rc must not outlast the probe's timeout. The rc goes in a
  // scratch HOME, so only shells whose login profile keeps the HOME it is given: CI's Blacksmith runners reset it to the
  // runner's own (/etc/profile.d/blacksmith.sh), and there the macOS job runs this file.
  const keepsHome = (shell: string) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-home-"));
    try {
      const said = NodeChildProcess.execFileSync(shell, ["-lc", 'printf %s "$HOME"'], {
        encoding: "utf8",
        timeout: 5000,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      });
      return said === home;
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  };
  it.each(["/bin/zsh", "/bin/bash"].filter((shell) => NodeFS.existsSync(shell) && keepsHome(shell)))(
    "gives up on %s when its rc hangs instead of waiting for the rc to finish",
    (shell) => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-shell-probe-"));
      try {
        const rcFinished = NodePath.join(home, "rc-finished");
        const rc = `sleep 4; touch '${rcFinished}'\n`;
        NodeFS.writeFileSync(NodePath.join(home, ".zshrc"), rc);
        NodeFS.writeFileSync(NodePath.join(home, ".bash_profile"), rc);

        expect(() =>
          readEnvironmentFromLoginShell(shell, ["PATH"], (file, args, options) =>
            NodeChildProcess.execFileSync(file, args, {
              ...options,
              timeout: 1000,
              env: { HOME: home, PATH: "/usr/bin:/bin" },
            }),
          ),
        ).toThrow(/ETIMEDOUT/);
        expect(NodeFS.existsSync(rcFinished)).toBe(false);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__CAVEMAN_CODE_ENV_PATH_START__",
        "/a:/b",
        "__CAVEMAN_CODE_ENV_PATH_END__",
        "__CAVEMAN_CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__CAVEMAN_CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("/bin/zsh", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__CAVEMAN_CODE_ENV_PATH_START__",
        "/a:/b",
        "__CAVEMAN_CODE_ENV_PATH_END__",
        "__CAVEMAN_CODE_ENV_SSH_AUTH_SOCK_START__",
        "__CAVEMAN_CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves multiline values and surrounding whitespace", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__CAVEMAN_CODE_ENV_CUSTOM_VAR_START__",
        "  first\nsecond  ",
        "__CAVEMAN_CODE_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  first\nsecond  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });
});

/** What WINDOWS_REGISTRY_ENVIRONMENT_SCRIPT prints for `values`. */
const registryAnswer = (values: unknown) =>
  Buffer.from(JSON.stringify(values), "utf8").toString("base64");

describe("readWindowsRegistryEnvironment", () => {
  const run = (answer: Option.Option<string>, env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" }) => {
    const execFile = vi.fn(
      (_file: string, _args: ReadonlyArray<string>, _options: { encoding: "utf8"; timeout: number }) =>
        Effect.succeed(answer),
    );
    return readWindowsRegistryEnvironment(execFile).pipe(
      Effect.provideService(HostProcess.Environment, env),
      Effect.map((values) => ({ values, execFile })),
    );
  };

  effectIt.effect("runs Windows PowerShell by full path without a profile, and keeps non-ASCII folders", () =>
    Effect.gen(function* () {
      const machine = { Path: "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd" };
      const user = { Path: "C:\\Users\\José Ñ\\.local\\bin;%NVM_HOME%", NVM_HOME: "C:\\Users\\José Ñ\\nvm" };
      const { values, execFile } = yield* run(Option.some(`${registryAnswer({ machine, user })}\r\n`), {
        systemroot: "D:\\Win",
      });
      expect(values).toEqual({ machine, user });
      const [file, args, options] = execFile.mock.calls[0]!;
      expect(file).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      // Node quotes an argument holding `"` in a way powershell.exe misreads.
      expect(args[4]).not.toContain('"');
      expect(args[4]).toContain("DoNotExpandEnvironmentNames");
      expect(args[4]).toContain("ToBase64String");
      expect(options).toEqual({ encoding: "utf8", timeout: 10_000 });
    }),
  );

  effectIt.effect("reads nothing when PowerShell fails or prints anything but its answer", () =>
    Effect.gen(function* () {
      expect((yield* run(Option.none())).values).toBeUndefined();
      expect((yield* run(Option.some("Loading personal profile...\r\nQUJD"))).values).toBeUndefined();
      expect((yield* run(Option.some(registryAnswer({ machine: {} })))).values).toBeUndefined();
      expect((yield* run(Option.some(""))).values).toBeUndefined();
    }),
  );

  effectIt.effect("kills the PowerShell child on interruption", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const kill = vi.fn(() => true);
      const child = { kill, unref: vi.fn() } as unknown as ReturnType<typeof import("node:child_process").execFile>;
      const execFile = nativeProbe.execFile;
      execFile.mockClear();
      execFile.mockImplementationOnce(() => {
        started.resolve();
        return child;
      });
      try {
        const fiber = yield* readWindowsRegistryEnvironment().pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(fiber);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(execFile).toHaveBeenCalledTimes(1);
        expect(execFile.mock.calls[0]?.[0]).toMatch(/powershell\.exe$/);
      } finally {
        execFile.mockClear();
      }
    }),
  );

  effectIt.effect("gives up on a PowerShell that survives the kill and holds stdout open", () =>
    Effect.gen(function* () {
      const stdout = { destroy: vi.fn() };
      const unref = vi.fn();
      const child = { kill: vi.fn(() => true), stdout, unref } as unknown as ReturnType<
        typeof import("node:child_process").execFile
      >;
      const execFile = nativeProbe.execFile;
      execFile.mockClear();
      execFile.mockImplementation(() => child);
      try {
        const fiber = yield* readWindowsRegistryEnvironment().pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("12 seconds");
        expect(yield* Fiber.join(fiber)).toBeUndefined();
        expect(execFile).toHaveBeenCalledTimes(1);
        expect(stdout.destroy).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledTimes(1);
      } finally {
        execFile.mockReset();
        execFile.mockImplementation(nativeProbe.original);
      }
    }),
  );
});

describe("windowsRegistryPath", () => {
  it("joins the Machine Path before the User Path, expanding references with the registry's own variables", () => {
    expect(
      windowsRegistryPath(
        {
          machine: {
            Path: "%SystemRoot%\\system32;C:\\Program Files\\nodejs\\",
            TOOLS: "%SystemDrive%\\Tools",
          },
          user: {
            PATH: "%USERPROFILE%\\.local\\bin;%NVM_HOME%;%NVM_SYMLINK%;%tools%\\bin;%UNSET%\\bin",
            NVM_HOME: "%APPDATA%\\nvm",
            NVM_SYMLINK: "C:\\nvm4w\\nodejs",
          },
        },
        {
          SystemRoot: "C:\\Windows",
          SystemDrive: "C:",
          USERPROFILE: "C:\\Users\\José Ñ",
          APPDATA: "C:\\Users\\José Ñ\\AppData\\Roaming",
          // A stale value this process started with: the registry's wins.
          NVM_SYMLINK: "C:\\old\\nodejs",
        },
      ),
    ).toBe(
      [
        "C:\\Windows\\system32",
        "C:\\Program Files\\nodejs\\",
        "C:\\Users\\José Ñ\\.local\\bin",
        "C:\\Users\\José Ñ\\AppData\\Roaming\\nvm",
        "C:\\nvm4w\\nodejs",
        "C:\\Tools\\bin",
        "%UNSET%\\bin",
      ].join(";"),
    );
  });

  it("expands as ExpandEnvironmentStrings does around a lone percent sign", () => {
    expect(
      windowsRegistryPath(
        { machine: {}, user: { Path: "C:\\100%\\bin;%HOME_DIR%\\bin;50%;%%" } },
        { HOME_DIR: "C:\\Home" },
      ),
    ).toBe("C:\\100%\\bin;C:\\Home\\bin;50%;%%");
  });

  it("is undefined when neither key holds a Path", () => {
    expect(windowsRegistryPath({ machine: { TEMP: "C:\\Temp" }, user: {} }, {})).toBeUndefined();
  });
});

describe("mergePathValues", () => {
  it("sanitizes and dedupes Windows entries while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      "C:\\Users\\testuser\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  });

  it("removes stray quotes from Windows entries", () => {
    expect(
      mergePathValues(
        'C:\\Windows\\System32;C:\\cloudflared.exe;C:";C:\\Program Files\\nodejs',
        undefined,
        "win32",
      ),
    ).toBe("C:\\Windows\\System32;C:\\cloudflared.exe;C:;C:\\Program Files\\nodejs");
  });

  it("dedupes Windows entries that differ only by a trailing separator", () => {
    expect(
      mergePathValues("C:\\Program Files\\nodejs\\;C:\\", "c:\\program files\\NODEJS;C:\\Git/", "win32"),
    ).toBe("C:\\Program Files\\nodejs\\;C:\\;C:\\Git/");
  });

  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
  });
});

describe("resolveKnownWindowsCliDirs", () => {
  it("returns known Windows CLI install directories in priority order", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
        ProgramFiles: "C:\\Program Files",
      }),
    ).toEqual([
      "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\testuser\\AppData\\Local\\pnpm",
      "C:\\Users\\testuser\\.local\\bin",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
      "C:\\Users\\testuser\\AppData\\Local\\Microsoft\\WinGet\\Links",
      "C:\\Users\\testuser\\AppData\\Roaming\\fnm\\aliases\\default",
      "C:\\Program Files\\nodejs",
      "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\GitHub CLI",
    ]);
  });

  it("takes fnm's folder from FNM_DIR when set", () => {
    expect(resolveKnownWindowsCliDirs({ FNM_DIR: "D:\\fnm" })).toEqual(["D:\\fnm\\aliases\\default"]);
  });
});

effectIt.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect.each(["win32", "linux"] as const)(
    "records missing optional commands as successful lookups on %s",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
        const env = { PATH: cwd, PATHEXT: ".CMD" };
        const checks = [
          isCommandAvailable("missing", { env }),
          isCommandAvailable("missing", { env }),
          isCommandAvailable("missing", { env: { ...env, PATH: "" } }),
          isCommandAvailable(path.join(cwd, "missing.cmd"), { env }),
        ];
        for (const check of checks) {
          const { result, spans } = yield* recordCommandTrace(check);
          expect(Result.getOrThrow(result)).toBe(false);
          expect(spans.length).toBeGreaterThan(0);
          for (const span of spans) {
            expect(span.status._tag).toBe("Ended");
            if (span.status._tag === "Ended") {
              expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
            }
          }
        }
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(CommandResolutionCache, new Map()),
      ),
  );

  // Not "linux" on a Windows host: its files have no execute bits, which that lookup requires.
  it.effect.each(process.platform === "win32" ? (["win32"] as const) : (["win32", "linux"] as const))(
    "records available commands as successful lookups on %s",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-trace-" });
        const executable = path.join(cwd, platform === "win32" ? "available.cmd" : "available");
        yield* fs.writeFileString(executable, "");
        yield* fs.chmod(executable, 0o700);
        const env = { PATH: cwd, PATHEXT: ".CMD" };
        for (const command of ["available", executable]) {
          const { result, spans } = yield* recordCommandTrace(isCommandAvailable(command, { env }));
          expect(Result.getOrThrow(result)).toBe(true);
          expect(spans.length).toBeGreaterThan(0);
          for (const span of spans) {
            expect(span.status._tag).toBe("Ended");
            if (span.status._tag === "Ended") {
              expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
            }
          }
        }
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(CommandResolutionCache, new Map()),
      ),
  );

  it.effect("returns false when PATH is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* isCommandAvailable("definitely-not-installed", {
          env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
      ).toBe(false);
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveCommandPath", (it) => {
  it.effect("records a successful lookup when a command is missing", () =>
    Effect.gen(function* () {
      const { result, spans } = yield* recordCommandTrace(
        resolveCommandPath("missing", { env: { PATH: "" } }),
      );
      expect(Result.getOrThrow(result)).toBeNull();
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.status._tag).toBe("Ended");
        if (span.status._tag === "Ended") {
          expect(Exit.isSuccess(span.status.exit), span.name).toBe(true);
        }
      }
    }),
  );

  it.effect("returns null when PATH is empty", () =>
    Effect.gen(function* () {
      const result = yield* resolveCommandPath("definitely-not-installed", {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(result).toBeNull();
    }),
  );

  // Records every path the scan stats, without ever reporting a match, so the
  // walk runs to exhaustion and the probe set can be inspected. Assertions
  // below count probes rather than naming paths: `Path` is the host's, so the
  // separator differs between a Windows and a Linux CI runner.
  const recordProbes = (env: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const probed: Array<string> = [];
      const result = yield* resolveCommandPath("definitely-not-installed", { env }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provide(
          FileSystem.layerNoop({
            stat: (filePath) =>
              Effect.sync(() => {
                probed.push(filePath);
                return { type: "Directory" } as FileSystem.File.Info;
              }),
          }),
        ),
      );

      expect(result).toBeNull();
      return probed;
    });

  it.effect("visits a repeated PATH directory only once", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin;C:\\other;C:\\bin;C:\\other",
        PATHEXT: ".COM;.EXE",
      });

      // Two directories, two extensions, upper and lowercase spellings.
      expect(probed).toHaveLength(8);
      expect(new Set(probed).size).toBe(probed.length);
    }),
  );

  it.effect("still visits a PATH entry that differs only in case", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin;C:\\BIN",
        PATHEXT: ".COM;.EXE",
      });

      // Deliberately not folded together. Windows 10+ can mark a directory
      // case-sensitive, so the two spellings are not provably one directory and
      // skipping the second could hide a command that is really there.
      expect(probed).toHaveLength(8);
    }),
  );

  it.effect.each(["audit-command", "audit-command.CMD"])(
    "resolves lowercase executable files for %s in a case-sensitive Windows PATH directory",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-case-sensitive-path-" });
        const executable = path.join(cwd, "audit-command.cmd");
        yield* fs.writeFileString(executable, "@echo off\n");

        const resolved = yield* resolveCommandPath(command, {
          env: { PATH: cwd, PATHEXT: ".CMD" },
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(CommandResolutionCache, new Map()),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            // Keep this case-sensitive fixture portable to case-insensitive hosts.
            stat: (filePath) =>
              fs.stat(filePath === executable ? filePath : path.join(cwd, "missing")),
          }),
        );

        expect(resolved).toBe(executable);
      }),
  );

  it.effect("keeps cached misses until expiry while allowing explicit paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-path-cache-" });
      const executable = path.join(cwd, "appeared.CMD");
      const options = { env: { PATH: `${cwd};${cwd}`, PATHEXT: ".CMD" } };

      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      yield* fs.writeFileString(executable, "@echo off\n");
      expect(yield* resolveCommandPath("appeared", options)).toBeNull();
      expect(yield* resolveCommandPath(executable, options)).toBe(executable);
      yield* TestClock.adjust("30 seconds");
      expect(yield* resolveCommandPath("appeared", options)).toBe(executable);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    ),
  );

  it.effect("keeps upper and lowercase PATHEXT candidates", () =>
    Effect.gen(function* () {
      const probed = yield* recordProbes({
        PATH: "C:\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });

      expect(probed).toHaveLength(8);
      expect(probed.filter((filePath) => /\.(COM|EXE|BAT|CMD)$/.test(filePath))).toHaveLength(4);
      expect(probed.filter((filePath) => /\.(com|exe|bat|cmd)$/.test(filePath))).toHaveLength(4);
    }),
  );

  it.effect("probes only listed PATH names and relists a directory that changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* fs.makeTempDirectoryScoped();
      const second = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(first, "cursor.CMD"), "");
      yield* fs.writeFileString(path.join(second, "cursor.EXE"), "");
      const env = { PATH: `${first};${second}`, PATHEXT: ".EXE;.CMD" };
      const probed: Array<string> = [];
      yield* Effect.gen(function* () {
        expect(yield* resolveCommandPath("cursor", { env })).toBe(path.join(first, "cursor.CMD"));
        expect(yield* isCommandAvailable("absent", { env })).toBe(false);
        yield* fs.writeFileString(path.join(second, "late.EXE"), "");
        yield* fs.utimes(second, 4_102_444_800, 4_102_444_800); // seconds: 2100-01-01
        expect(yield* resolveCommandPath("late", { env })).toBe(path.join(second, "late.EXE"));
      }).pipe(
        withPathDirectoryListings,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => {
            // Record candidate probes, not the per-lookup directory mtime checks.
            if (file !== first && file !== second) probed.push(file);
            return fs.stat(file);
          },
        }),
      );
      expect(probed).toEqual([path.join(first, "cursor.CMD"), path.join(second, "late.EXE")]);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(CommandResolutionCache, new Map()),
    ),
  );
});

describe("preferGitForWindowsBinary", () => {
  const files =
    (...paths: Array<string>) =>
    (filePath: string) =>
      paths.includes(filePath);

  it("runs the git.exe Git for Windows' launcher would start", () => {
    // 2.56+ on x64. The PATHEXT scan returns the extension in PATHEXT's case.
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.EXE",
        {},
        files(
          "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        ),
      ),
    ).toBe("C:\\Program Files\\Git\\ucrt64\\bin\\git.exe");
    // Before 2.56, and the portable build's bin launcher.
    expect(
      preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        files("D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        {},
        files("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe");
  });

  it("keeps the launcher when MSYSTEM is set", () => {
    // The real git.exe only adds its own folders to PATH when MSYSTEM is unset;
    // without them a `#!/bin/sh` hook cannot start.
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        { MSYSTEM: "MINGW64" },
        files("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("keeps the launcher when no git.exe sits beside it", () => {
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\git.exe", {}, () => false)).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
  });

  it("leaves other gits and other launchers alone", () => {
    const everything = () => true;
    expect(preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, everything)).toBe(
      "C:\\Users\\me\\scoop\\shims\\git.exe",
    );
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\gitk.exe", {}, everything)).toBe(
      "C:\\Program Files\\Git\\cmd\\gitk.exe",
    );
  });
});

// Byte for byte what `npm install -g opencode-ai` writes as `opencode.cmd`.
const NPM_OPENCODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

describe("npmShimExecutable", () => {
  const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd";
  const executable =
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const exists = (filePath: string) => filePath === executable;

  it("finds the executable npm's shim runs", () => {
    expect(npmShimExecutable(shimPath, () => NPM_OPENCODE_SHIM, exists)).toBe(executable);
    expect(
      npmShimExecutable(shimPath.replace(".cmd", ".CMD"), () => NPM_OPENCODE_SHIM, exists),
    ).toBe(executable);
  });

  it("keeps a shim that does more than run the executable", () => {
    const withSetting = NPM_OPENCODE_SHIM.replace(
      "SETLOCAL",
      "SETLOCAL\r\nSET OPENCODE_CONFIG=C:\\x",
    );
    expect(npmShimExecutable(shimPath, () => withSetting, exists)).toBeUndefined();
    const nodeScript = NPM_OPENCODE_SHIM.replace(
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
    );
    expect(
      npmShimExecutable(
        shimPath,
        () => nodeScript,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps a shim CMD would read differently", () => {
    // CMD keeps trailing characters in an unquoted `SET` value, so these point
    // `dp0`, and with it the executable, somewhere else.
    for (const suffix of ["\u00a0", "\t", " "]) {
      const altered = NPM_OPENCODE_SHIM.replace("SET dp0=%~dp0", `SET dp0=%~dp0${suffix}`);
      expect(
        npmShimExecutable(
          shimPath,
          () => altered,
          () => true,
        ),
      ).toBeUndefined();
    }
    const nonBreakingSeparator = NPM_OPENCODE_SHIM.replace(
      'opencode.exe"   %*',
      'opencode.exe"\u00a0%*',
    );
    expect(
      npmShimExecutable(
        shimPath,
        () => nonBreakingSeparator,
        () => true,
      ),
    ).toBeUndefined();
    const indented = NPM_OPENCODE_SHIM.replace("SETLOCAL", "  SETLOCAL");
    expect(
      npmShimExecutable(
        shimPath,
        () => indented,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("keeps the shim when its executable is missing or it is not a .cmd", () => {
    expect(
      npmShimExecutable(
        shimPath,
        () => NPM_OPENCODE_SHIM,
        () => false,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath,
        () => undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      npmShimExecutable(
        shimPath.replace(".cmd", ".bat"),
        () => NPM_OPENCODE_SHIM,
        () => true,
      ),
    ).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect("runs Windows executables directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("node.exe", ["script.js", "hello & goodbye"], {
        env: { PATH: "C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(SpawnExecutableResolution, () => "C:\\nodejs\\node.exe"),
      );

      expect(command).toEqual({
        command: "C:\\nodejs\\node.exe",
        args: ["script.js", "hello & goodbye"],
        shell: false,
      });
    }),
  );

  it.effect.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs the executable behind an npm shim directly when asked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const prefix = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-shim-" });
          const shim = path.join(prefix, "opencode.cmd");
          const executable = path.join(
            prefix,
            "node_modules",
            "opencode-ai",
            "bin",
            "opencode.exe",
          );
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "");
          yield* fs.writeFileString(shim, NPM_OPENCODE_SHIM);
          const resolve = (bypassNpmShim: boolean) =>
            resolveSpawnCommand("opencode", ["serve", "--port=4096"], {
              env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
              bypassNpmShim,
            }).pipe(
              Effect.provideService(HostProcess.Platform, "win32"),
              Effect.provideService(CommandResolutionCache, new Map()),
              Effect.provideService(SpawnExecutableResolution, () => shim),
            );

          expect(yield* resolve(true)).toEqual({
            command: executable,
            args: ["serve", "--port=4096"],
            shell: false,
          });
          expect((yield* resolve(false)).shell).toBe(true);
        }),
      ),
  );

  it.effect("builds one escaped cmd.exe line for Windows command shims", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(
        "vp",
        [
          "run",
          "value & calc",
          "%PATH%",
          'quote"value',
          "C:\\dir with space\\",
          'slash\\"quote',
          "x|y<z>^",
        ],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );

      // No args alongside `shell: true`: Node prints DEP0190 for that pairing.
      expect(command).toEqual({
        command: [
          String.raw`^"C:\Program^ Files\npm^ ^&^ tools\vp.cmd^"`,
          String.raw`^"run^"`,
          String.raw`^"value^ ^&^ calc^"`,
          String.raw`^"^%PATH^%^"`,
          String.raw`^"quote\^"value^"`,
          String.raw`^"C:\dir^ with^ space\\^"`,
          String.raw`^"slash\\\^"quote^"`,
          String.raw`^"x^|y^<z^>^^^"`,
        ].join(" "),
        args: [],
        shell: true,
      });
    }),
  );

  it.effect("resolves against the effective environment when extending host env", () =>
    Effect.gen(function* () {
      let resolvedEnvironment: NodeJS.ProcessEnv | undefined;
      yield* resolveSpawnCommand("codex", ["app-server"], {
        env: { CODEX_HOME: "C:\\Users\\tester\\.codex" },
        extendEnv: true,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(HostProcess.Environment, {
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
          resolvedEnvironment = env;
          return "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
        }),
      );

      expect(resolvedEnvironment).toEqual({
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CODEX_HOME: "C:\\Users\\tester\\.codex",
      });
    }),
  );

  describe("macOS git", () => {
    // Files that exist, the git first on PATH, and what `xcrun --find git` prints.
    const setup = (options: {
      readonly platform?: NodeJS.Platform;
      readonly gitOnPath: string;
      readonly xcrunGit: string | undefined;
    }) => {
      const files = new Set([options.gitOnPath, ...(options.xcrunGit ? [options.xcrunGit] : [])]);
      const host = { xcrunGit: options.xcrunGit, xcrunCalls: 0 };
      const resolve = resolveSpawnCommand("git", ["status"], { env: { PATH: "/fake/bin" } }).pipe(
        Effect.map((resolved) => resolved.command),
        Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "git" ? options.gitOnPath : files.has(command) ? command : undefined,
        ),
        Effect.provideService(XcodeGitLocation, () => {
          host.xcrunCalls += 1;
          return host.xcrunGit;
        }),
      );
      return { files, host, resolve };
    };

    const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

    it.effect("runs the git behind the xcrun shim and looks it up once", () =>
      Effect.gen(function* () {
        const { host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(host.xcrunCalls).toBe(1);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when PATH has another git or the host is not macOS", () =>
      Effect.gen(function* () {
        const homebrew = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* homebrew.resolve).toBe("git");
        expect(homebrew.host.xcrunCalls).toBe(0);

        const linux = setup({ platform: "linux", gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* linux.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when xcrun fails or names a missing file", () =>
      Effect.gen(function* () {
        const failed = setup({ gitOnPath: "/usr/bin/git", xcrunGit: undefined });
        expect(yield* failed.resolve).toBe("git");

        const missing = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        missing.files.delete(XCODE_GIT);
        expect(yield* missing.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("looks again when the resolved git disappears", () =>
      Effect.gen(function* () {
        const betaGit = "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git";
        const { files, host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);

        files.delete(XCODE_GIT);
        files.add(betaGit);
        host.xcrunGit = betaGit;
        expect(yield* resolve).toBe(betaGit);
        expect(host.xcrunCalls).toBe(2);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );
  });

  it.effect("scans PATH once per command until the search environment changes", () =>
    Effect.gen(function* () {
      const scans: Array<string> = [];
      const scan: SpawnExecutableResolver = (name, _platform, env) => {
        scans.push(`${name}@${env.PATH}`);
        return name === "missing" ? undefined : `${env.PATH}\\${name}.exe`;
      };
      const resolve = (command: string, path: string, resolver = scan) =>
        resolveSpawnCommand(command, [], { env: { PATH: path, PATHEXT: ".EXE" } }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, resolver),
          // As the runtime runs: a miss goes on to the spawn, which reports it (searchesPathOnly).
          withExeSearch(false),
        );

      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      // A failed spawn is how a provider reports "not installed", so a miss
      // must clear the moment the binary appears.
      yield* resolve("missing", "C:\\one");
      yield* resolve("missing", "C:\\one");
      expect((yield* resolve("git", "C:\\two")).command).toBe("C:\\two\\git.exe");
      // Callers probe explicit paths they may have just written.
      yield* resolve("C:\\tools\\git.exe", "C:\\one");
      yield* resolve("C:\\tools\\git.exe", "C:\\one");
      expect(scans).toEqual([
        "git@C:\\one",
        "missing@C:\\one",
        "missing@C:\\one",
        "git@C:\\two",
        "C:\\tools\\git.exe@C:\\one",
        "C:\\tools\\git.exe@C:\\one",
      ]);

      yield* TestClock.adjust("31 seconds");
      yield* resolve("git", "C:\\one");
      expect(scans).toHaveLength(7);

      // Another resolver sharing the cache gets its own answer, not the cached one.
      const elsewhere = yield* resolve("git", "C:\\one", () => "D:\\elsewhere\\git.exe");
      expect(elsewhere.command).toBe("D:\\elsewhere\\git.exe");
      expect((yield* resolve("git", "C:\\one")).command).toBe("C:\\one\\git.exe");
      expect(scans).toHaveLength(7);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  it.effect("keeps launcher swaps apart for environments with and without MSYSTEM", () =>
    Effect.gen(function* () {
      let scans = 0;
      const scan: SpawnExecutableResolver = () => {
        scans++;
        return "C:\\Git\\cmd\\git.exe";
      };
      const resolve = (env: NodeJS.ProcessEnv) =>
        resolveSpawnCommand("git", [], {
          env: { PATH: "C:\\Git\\cmd", PATHEXT: ".EXE", ...env },
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, scan),
        );

      yield* resolve({});
      yield* resolve({});
      expect(scans).toBe(1);
      // A swap made without MSYSTEM must not reach a child that has it set.
      yield* resolve({ MSYSTEM: "MINGW64" });
      expect(scans).toBe(2);
    }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
  );

  // Never a shell. The bare name only where Windows looks for it on PATH alone; else it would look in the child's
  // working directory too.
  it.effect("fails as the spawn would for a Windows command PATH does not hold, unless Windows searches PATH alone", () =>
    Effect.gen(function* () {
      const resolve = (currentDirectory: boolean, PATH: string) =>
        resolveSpawnCommand("missing & calc", ["unsafe & value"], { env: { PATH, PATHEXT: ".COM;.EXE;.BAT;.CMD" } }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(CommandResolutionCache, new Map()),
          withExeSearch(currentDirectory),
        );
      const error = yield* Effect.flip(resolve(true, "C:\\Windows\\System32"));
      expect(error.reason).toMatchObject({ _tag: "NotFound", module: "ChildProcess", method: "spawn", pathOrDescriptor: "missing & calc" });
      expect(error.message).toContain("spawn missing & calc ENOENT");
      // This process turned the current-directory search off and every PATH entry is absolute: the spawn reports it.
      expect(yield* resolve(false, "")).toEqual({ command: "missing & calc", args: ["unsafe & value"], shell: false });
      expect(yield* resolve(false, '"C:\\Program Files\\x";;\\\\server\\tools;D:/bin')).toEqual({ command: "missing & calc", args: ["unsafe & value"], shell: false });
      // A relative entry is looked up under the child's working directory: fail.
      for (const PATH of ["C:\\Windows;.", "bin;C:\\Windows", " C:\\Windows", "C:relative"]) {
        expect((yield* Effect.flip(resolve(false, PATH))).reason._tag).toBe("NotFound");
      }
      // A path is the caller's own, tried as given.
      const explicit = yield* resolveSpawnCommand("C:\\tools\\missing.exe", [], { env: { PATH: "", PATHEXT: ".EXE" } }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(CommandResolutionCache, new Map()),
      );
      expect(explicit).toEqual({ command: "C:\\tools\\missing.exe", args: [], shell: false });
    }),
  );
});

describe("resolveWindowsPath", () => {
  const env = {
    APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
    USERPROFILE: "C:\\Users\\testuser",
    ProgramFiles: "C:\\Program Files",
  };
  const knownDirs = resolveKnownWindowsCliDirs(env);

  it("starts from this process's PATH, then the known CLI folders", () => {
    expect(resolveWindowsPath({ ...env, Path: "C:\\Windows\\System32;C:\\Users\\testuser\\.local\\bin" })).toBe(
      [
        "C:\\Windows\\System32",
        "C:\\Users\\testuser\\.local\\bin",
        ...knownDirs.filter((dir) => dir !== "C:\\Users\\testuser\\.local\\bin"),
      ].join(";"),
    );
  });

  it("appends what the registry adds after this process's entries, ignoring case and trailing separators", () => {
    expect(
      resolveWindowsPath(
        { ...env, PATH: "C:\\Tools;C:\\Windows\\System32" },
        "C:\\WINDOWS\\system32\\;C:\\Program Files\\Git\\cmd;C:\\Users\\José Ñ\\bin;C:\\Program Files\\nodejs\\",
      ),
    ).toBe(
      [
        "C:\\Tools",
        "C:\\Windows\\System32",
        "C:\\Program Files\\Git\\cmd",
        "C:\\Users\\José Ñ\\bin",
        "C:\\Program Files\\nodejs\\",
        ...knownDirs.filter(
          (dir) => dir !== "C:\\Program Files\\Git\\cmd" && dir !== "C:\\Program Files\\nodejs",
        ),
      ].join(";"),
    );
  });

  it("is the known folders alone for an environment without PATH", () => {
    expect(resolveWindowsPath(env)).toBe(knownDirs.join(";"));
    expect(resolveWindowsPath({})).toBeUndefined();
  });
});
