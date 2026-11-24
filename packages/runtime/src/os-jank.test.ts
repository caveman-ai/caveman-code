// ), apps/server/src/os-jank.test.ts @ ab3a3cd1.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { WindowsRegistryEnvironment, type WindowsRegistryEnvironmentValues } from "@caveman-app/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeOS from "node:os";
import { assert, describe, it, vi } from "vitest";

import { fixPath, hydratePosixHome, makePathRefresh, prefetchLoginShellEnvironment } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect.each(["darwin", "linux"] as const)(
  "keeps the prepared PATH and still hydrates HOME on %s",
  (platform) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFileSync")),
      (probe) =>
        Effect.gen(function* () {
          probe.mockImplementation(() => {
            throw new Error("The prepared environment must not launch another shell");
          });
          const env: NodeJS.ProcessEnv = { PATH: "/prepared/bin:/usr/bin" };

          yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(probe.mock.calls.length, 0);
          assert.equal(env.PATH, "/prepared/bin:/usr/bin");
          assert.equal(env.HOME, NodeOS.userInfo().homedir);
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("reads no login shell on a Cloud computer, whose tools run in their own container", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({
      sync: vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation(() => {
        throw new Error("a Cloud computer's runtime must not launch a login shell");
      }),
      async: vi.spyOn(NodeChildProcess, "spawn").mockImplementation((() => {
        throw new Error("a Cloud computer's runtime must not launch a login shell");
      }) as never),
    })),
    (probes) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin", HOME: "/opt/caveman/home", CAVEMAN_RUNTIME_TOOLS_ADDRESS: "127.0.0.1:47917" };
        prefetchLoginShellEnvironment(env, "linux");

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probes.async.mock.calls.length, 0);
        assert.equal(probes.sync.mock.calls.length, 0);
        assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
      }),
    (probes) => Effect.sync(() => (probes.sync.mockRestore(), probes.async.mockRestore())),
  ),
);

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__CAVEMAN_CODE_ENV_PATH_START__\n/opt/tools/bin\n__CAVEMAN_CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("takes the login shell read bin.ts started instead of blocking on another", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => ({
      sync: vi.spyOn(NodeChildProcess, "execFileSync").mockReturnValue(""),
      // The prefetch spawns the shell detached (shared/shell.ts readEnvironmentFromLoginShellAsync).
      async: vi.spyOn(NodeChildProcess, "spawn").mockImplementation((() => {
        const child = Object.assign(new NodeEvents.EventEmitter(), {
          stdout: NodeStream.Readable.from(["__CAVEMAN_CODE_ENV_PATH_START__\n/opt/early/bin\n__CAVEMAN_CODE_ENV_PATH_END__\n"]),
          kill: () => true,
        });
        child.stdout.on("end", () => queueMicrotask(() => child.emit("close", 0, null)));
        return child;
      }) as never),
    })),
    (probes) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin", HOME: "/home/me" };
        prefetchLoginShellEnvironment(env, "linux");

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probes.async.mock.calls.length, 1);
        assert.equal(probes.sync.mock.calls.length, 0);
        assert.equal(env.PATH, "/opt/early/bin:/usr/bin");
      }),
    (probes) => Effect.sync(() => (probes.sync.mockRestore(), probes.async.mockRestore())),
  ),
);

effectIt.effect("keeps a user-chosen PATH ahead of the login shell's", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__CAVEMAN_CODE_ENV_PATH_START__",
            "/opt/homebrew/bin:/usr/bin:/home/me/.fnm/bin",
            "__CAVEMAN_CODE_ENV_PATH_END__",
            "__CAVEMAN_CODE_ENV___MISE_DIFF_START__",
            "login-shell-diff",
            "__CAVEMAN_CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/bash",
          PATH: "/home/me/wrapper:/home/me/.fnm/bin:/usr/bin",
          __MISE_DIFF: "terminal-diff",
        };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.PATH, "/home/me/wrapper:/home/me/.fnm/bin:/usr/bin:/opt/homebrew/bin");
        assert.equal(env.__MISE_DIFF, "terminal-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("lets the login shell lead a GUI PATH that only adds Homebrew", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          ["__CAVEMAN_CODE_ENV_PATH_START__", "/home/me/.fnm/bin:/opt/homebrew/bin", "__CAVEMAN_CODE_ENV_PATH_END__"].join(
            "\n",
          ),
        ),
    ),
    () =>
      Effect.gen(function* () {
        // `launchctl config user path` with Homebrew: still launchd's PATH, not the user's order.
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/opt/homebrew/bin:/usr/bin:/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.PATH, "/home/me/.fnm/bin:/opt/homebrew/bin:/usr/bin:/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__CAVEMAN_CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__CAVEMAN_CODE_ENV_PATH_END__",
            "__CAVEMAN_CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__CAVEMAN_CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

const windowsProfile = {
  APPDATA: "C:\\Users\\José Ñ\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\José Ñ\\AppData\\Local",
  USERPROFILE: "C:\\Users\\José Ñ",
  ProgramFiles: "C:\\Program Files",
};

/** Spies on every way to start a process, for a test that must start none. */
const spawnProbes = () => ({
  execFile: vi.spyOn(NodeChildProcess, "execFile"),
  execFileSync: vi.spyOn(NodeChildProcess, "execFileSync"),
  spawn: vi.spyOn(NodeChildProcess, "spawn"),
  spawnSync: vi.spyOn(NodeChildProcess, "spawnSync"),
});
type SpawnProbes = ReturnType<typeof spawnProbes>;
const callsOf = (probes: SpawnProbes) => Object.values(probes).reduce((count, probe) => count + probe.mock.calls.length, 0);
const restore = (probes: SpawnProbes) => Effect.sync(() => Object.values(probes).forEach((probe) => probe.mockRestore()));

// Before the server listens: nothing slow, so no process at all, even when node is nowhere on PATH.
effectIt.effect("starts no process for Windows PATH, adding the known CLI folders even when the desktop marks it prepared", () =>
  Effect.acquireUseRelease(Effect.sync(spawnProbes), (probes) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { ...windowsProfile, PATH: "C:\\Windows" };

      yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(WindowsRegistryEnvironment, () => Effect.die("startup must not read the registry")),
      );

      assert.equal(callsOf(probes), 0);
      const path = env.PATH!.split(";");
      assert.equal(path[0], "C:\\Windows");
      assert.includeMembers(path, [
        "C:\\Users\\José Ñ\\AppData\\Roaming\\npm",
        "C:\\Users\\José Ñ\\AppData\\Local\\Microsoft\\WinGet\\Links",
        "C:\\Program Files\\nodejs",
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\GitHub CLI",
      ]);
    }),
    restore,
  ),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
    );

    assert.deepEqual(env, { PATH: "C:\\Windows" });
  }),
);

describe("makePathRefresh", () => {
  const refreshWith = (
    env: NodeJS.ProcessEnv,
    read: () => WindowsRegistryEnvironmentValues | undefined,
    platform: NodeJS.Platform = "win32",
  ) =>
    Effect.gen(function* () {
      const refresh = yield* makePathRefresh;
      // Past the launch, when the PATH the runtime was given is still the registry's.
      yield* TestClock.adjust("16 seconds");
      return refresh.pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(WindowsRegistryEnvironment, () => Effect.sync(read)),
      );
    });

  effectIt.effect("adds what was installed since the runtime started, after its own PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        ...windowsProfile,
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Windows\\system32;C:\\Tools",
      };
      // Git for Windows and nvm-windows installed while the app was open: nvm sets NVM_HOME and a Path that names it.
      const read = vi.fn(() => ({
        machine: { Path: "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd\\" },
        user: { Path: "%NVM_HOME%;%USERPROFILE%\\.local\\bin", NVM_HOME: "%APPDATA%\\nvm" },
      }));

      yield* yield* refreshWith(env, read);

      const path = env.PATH!.split(";");
      assert.deepEqual(path.slice(0, 4), [
        "C:\\Windows\\system32",
        "C:\\Tools",
        "C:\\Program Files\\Git\\cmd\\",
        "C:\\Users\\José Ñ\\AppData\\Roaming\\nvm",
      ]);
      assert.include(path, "C:\\Users\\José Ñ\\.local\\bin");
      // The known folder is not listed again for want of a trailing separator.
      assert.notInclude(path, "C:\\Program Files\\Git\\cmd");
      assert.equal(read.mock.calls.length, 1);
    }),
  );

  effectIt.effect("reads the registry once for a refresh of every engine, and again once the moment has passed", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const refresh = yield* makePathRefresh;
      yield* TestClock.adjust("16 seconds");
      const run = refresh.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(WindowsRegistryEnvironment, () =>
          Effect.sync(() => ++reads).pipe(
            Effect.tap(() => Deferred.await(release)),
            Effect.map((read) => ({ machine: { Path: `C:\\Read${read}` }, user: {} })),
          ),
        ),
      );

      const engines = yield* Effect.all([run, run, run], { concurrency: "unbounded" }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(engines);
      assert.equal(reads, 1);
      assert.equal(env.PATH, "C:\\Windows;C:\\Read1");

      yield* TestClock.adjust("6 seconds");
      yield* run;
      assert.equal(reads, 2);
      assert.equal(env.PATH, "C:\\Windows;C:\\Read1;C:\\Read2");
    }),
  );

  effectIt.effect("reads nothing right after launch, when the PATH the runtime was given is the registry's", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      const read = vi.fn(() => ({ machine: { Path: "C:\\Tools" }, user: {} }));
      const refresh = (yield* makePathRefresh).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(WindowsRegistryEnvironment, () => Effect.sync(read)),
      );
      yield* refresh;
      yield* TestClock.adjust("10 seconds");
      yield* refresh;
      assert.equal(read.mock.calls.length, 0);
      yield* TestClock.adjust("6 seconds");
      yield* refresh;
      assert.equal(read.mock.calls.length, 1);
      assert.equal(env.PATH, "C:\\Windows;C:\\Tools");
    }),
  );

  effectIt.effect("leaves PATH as it was when the registry cannot be read", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      yield* yield* refreshWith(env, () => undefined);
      assert.deepEqual(env, { PATH: "C:\\Windows" });
    }),
  );

  effectIt.effect.each(["darwin", "linux"] as const)("does nothing on %s", (platform) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const read = vi.fn(() => ({ machine: { Path: "C:\\Tools" }, user: {} }));
      yield* yield* refreshWith(env, read, platform);
      assert.equal(read.mock.calls.length, 0);
      assert.deepEqual(env, { PATH: "/usr/bin" });
    }),
  );
});
