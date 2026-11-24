// ), apps/server/src/provider/Drivers/ClaudeExecutable.test.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { SpawnExecutableResolution } from "@caveman-app/shared/shell";
import * as Effect from "effect/Effect";

import {
  ClaudeExecutableCheck,
  ClaudeExecutableFileCheck,
  isExecutableFile,
  resolveClaudeCliPath,
  resolveClaudeSdkExecutablePath,
  resolvePosixClaudeExecutablePath,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("returns the configured path when PATH has no claude on non-Windows platforms", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("must not resolve on non-Windows platforms");
          }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("skips cmux's shim first on PATH for the real CLI on non-Windows platforms", () =>
    Effect.gen(function* () {
      const executables = new Set([
        "/tmp/cmux-cli-shims/A/claude",
        "/opt/cmux-shim/claude",
        "/home/dev/.local/bin/claude",
      ]);
      for (const env of [
        { PATH: "/tmp/cmux-cli-shims/A:/usr/bin:/home/dev/.local/bin" },
        // cmux also names its shim directory in the environment.
        { PATH: "/opt/cmux-shim:/home/dev/.local/bin", CMUX_CLAUDE_WRAPPER_SHIM_ROOT: "/opt/cmux-shim" },
      ]) {
        for (const resolve of [resolveClaudeSdkExecutablePath, resolveClaudeCliPath]) {
          expect(
            yield* resolve("claude", env).pipe(
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(ClaudeExecutableCheck, (file) => executables.has(file)),
            ),
          ).toBe("/home/dev/.local/bin/claude");
        }
      }
    }),
  );

  it.effect("returns the resolved absolute path for native Windows executables", () =>
    Effect.gen(function* () {
      const nativeBinary = "C:\\Users\\dev\\.local\\bin\\claude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: nativeBinary }),
        ),
      ).toBe(nativeBinary);
    }),
  );

  it.effect("follows an npm launcher shim to the packaged native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE, NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("follows .bat and .ps1 launcher shims the same way", () =>
    Effect.gen(function* () {
      for (const shim of [`${NPM_DIR}\\claude.bat`, `${NPM_DIR}\\claude.ps1`]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [NPM_PACKAGE_EXE],
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }
    }),
  );

  it.effect("normalizes mixed-case shim extensions before matching", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: `${NPM_DIR}\\claude.CMD`,
            existingFiles: [NPM_PACKAGE_EXE],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("falls back to cli.js when the package ships no native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_CLI);
    }),
  );

  it.effect("returns the configured path when a shim has no known package entry", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("returns the configured path when command resolution finds nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: undefined }),
        ),
      ).toBe("claude");
    }),
  );
});

// Skipped on Windows: POSIX PATH lookup (`:`, exec mode bits, Mach-O and shebang heads); Windows resolves
// claude through PATHEXT and its .cmd shim instead (the withWindowsResolution tests above).
describe.skipIf(process.platform === "win32")("resolvePosixClaudeExecutablePath on a real filesystem", () => {
  const withTree = (run: (root: string) => void) => {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-exe-")));
    try {
      run(root);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };
  const write = (file: string, contents: string | Buffer) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, contents, { mode: 0o755 });
  };
  // The first bytes of a 64-bit Mach-O binary.
  const NATIVE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);

  it("checks executables through symlinks and skips missing or non-executable files", () =>
    withTree((root) => {
      write(`${root}/versions/2.1.300`, NATIVE);
      NodeFS.mkdirSync(`${root}/bin`);
      NodeFS.symlinkSync(`${root}/versions/2.1.300`, `${root}/bin/claude`);
      write(`${root}/noexec/claude`, NATIVE);
      NodeFS.chmodSync(`${root}/noexec/claude`, 0o644);
      NodeFS.mkdirSync(`${root}/dir/claude`, { recursive: true });

      expect(isExecutableFile(`${root}/bin/claude`)).toBe(true);
      expect(isExecutableFile(`${root}/noexec/claude`)).toBe(false);
      expect(isExecutableFile(`${root}/dir/claude`)).toBe(false);
      expect(isExecutableFile(`${root}/nowhere/claude`)).toBe(false);
      const PATH = [`${root}/noexec`, `${root}/dir`, `${root}/nowhere`, `${root}/bin`].join(":");
      expect(resolvePosixClaudeExecutablePath("claude", { PATH })).toBe(`${root}/bin/claude`);
    }));

  it("follows PATH past cmux's shim to the symlinked native install", () =>
    withTree((root) => {
      const shimRoot = `${root}/T/cmux-cli-shims/CF659CC7`;
      write(`${shimRoot}/claude`, '#!/usr/bin/env bash\nexec "$cmux_wrapper" "$@"\n');
      write(`${root}/versions/2.1.300`, NATIVE);
      NodeFS.mkdirSync(`${root}/local-bin`);
      NodeFS.symlinkSync(`${root}/versions/2.1.300`, `${root}/local-bin/claude`);
      const PATH = [shimRoot, `${root}/empty`, `${root}/local-bin`].join(":");

      // The SDK spawns the link; the CLI finds its own install from it.
      expect(resolvePosixClaudeExecutablePath("claude", { PATH })).toBe(`${root}/local-bin/claude`);
    }));

  it("keeps PATH's first claude when it is another launcher script (pnpm, asdf, nix)", () =>
    withTree((root) => {
      write(`${root}/pnpm/claude`, '#!/bin/sh\nexec node "$basedir/../claude-code/cli.js" "$@"\n');
      write(`${root}/older/claude`, NATIVE);
      const PATH = `${root}/pnpm:${root}/older`;
      expect(resolvePosixClaudeExecutablePath("claude", { PATH })).toBe(`${root}/pnpm/claude`);
    }));

  it("uses cmux's shim when PATH has nothing else, and keeps explicit paths", () =>
    withTree((root) => {
      write(`${root}/cmux-cli-shims/A/claude`, "#!/bin/bash\nexec foo\n");
      write(`${root}/b/claude`, "#!/bin/bash\nexec foo\n");
      const PATH = `${root}/cmux-cli-shims/A`;
      expect(resolvePosixClaudeExecutablePath("claude", { PATH })).toBe(
        `${root}/cmux-cli-shims/A/claude`,
      );
      expect(resolvePosixClaudeExecutablePath(`${root}/b/claude`, { PATH })).toBe(`${root}/b/claude`);
      expect(resolvePosixClaudeExecutablePath("claude", {})).toBe("claude");
    }));
});
