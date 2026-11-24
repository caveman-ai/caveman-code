import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind, VcsProcessSpawnError } from "@caveman-app/protocol";
import type * as SourceControlHost from "@caveman-app/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const INSTALL_DETAIL =
  "Install Forgejo CLI (`fj` 0.6 or later) or Gitea CLI (`tea` 0.16 or later) and retry.";
const REMOTE_URL = "https://forgejo.local/maria/project.git";

/** The error the server's process runner reports when the real spawner cannot start a CLI. */
const realSpawnFailure = (
  command: string,
  options: { readonly cwd: string; readonly path?: string },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cause = yield* Effect.scoped(
      spawner.spawn(
        ChildProcess.make(command, ["version"], {
          cwd: options.cwd,
          ...(options.path === undefined ? {} : { env: { PATH: options.path } }),
        }),
      ),
    ).pipe(Effect.flip, Effect.orDie);
    return new VcsProcessSpawnError({
      operation: "ForgejoCli.execute",
      command,
      cwd: options.cwd,
      argumentCount: 1,
      cause,
    });
  }).pipe(Effect.provide(NodeServices.layer));

const withTempDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-cli-test-"))),
    use,
    (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
  );

/** fj's keys file, holding a token for forgejo.local when `fjSignedIn`. */
const fjStorage = (fjSignedIn: boolean) =>
  FileSystem.makeNoop({
    exists: () => Effect.succeed(fjSignedIn),
    readFileString: () =>
      Effect.succeed(
        encodeJson({ hosts: { "forgejo.local": { type: "Application", token: "test-token" } } }),
      ),
  });

const noHttp = HttpClient.make(() => {
  throw new Error("no HTTP request is expected before a CLI starts");
});

const listPulls = (cwd: string) =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    return yield* cli
      .api({
        cwd,
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo / Gitea",
            baseUrl: "https://forgejo.local",
          },
          remoteName: "origin",
          remoteUrl: REMOTE_URL,
        },
        path: "repos/maria/project/pulls",
      })
      .pipe(Effect.flip);
  });

const spawnFailingHost = (
  commands: string[],
  fail: (
    input: Parameters<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>[0],
  ) => Effect.Effect<VcsProcessSpawnError>,
) =>
  TestSourceControlHost.layer({
    process: {
      run: (input) => {
        commands.push(input.command);
        return fail(input).pipe(Effect.flatMap(Effect.fail));
      },
    },
  });

it.effect("still reports the Forgejo CLI as missing when neither fj nor tea is on PATH", () =>
  withTempDirectory((directory) => {
    const commands: string[] = [];
    return Effect.gen(function* () {
      const error = yield* listPulls(directory);

      assert.strictEqual(error.reason, "missing-cli");
      assert.strictEqual(error.detail, INSTALL_DETAIL);
      assert.deepStrictEqual(commands, ["tea"]);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fjStorage(false)),
      Effect.provideService(HttpClient.HttpClient, noHttp),
      Effect.provide(
        spawnFailingHost(commands, (input) =>
          realSpawnFailure(input.command, { cwd: directory, path: directory }),
        ),
      ),
    );
  }),
);

it.effect.each([
  { cli: "tea", fjSignedIn: false },
  { cli: "fj", fjSignedIn: true },
] as const)(
  "does not tell a person to install $cli when the checkout folder was moved away",
  ({ cli, fjSignedIn }) =>
    withTempDirectory((directory) => {
      const movedCheckout = path.join(directory, "moved-checkout");
      const commands: string[] = [];
      return Effect.gen(function* () {
        const error = yield* listPulls(movedCheckout);

        assert.strictEqual(error.reason, undefined);
        assert.notStrictEqual(error.detail, INSTALL_DETAIL);
        assert.strictEqual(error.command, cli);
        // An fj that is installed but cannot start here must not hand the request to tea.
        assert.deepStrictEqual(commands, [cli]);
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fjStorage(fjSignedIn)),
        Effect.provideService(HttpClient.HttpClient, noHttp),
        Effect.provide(
          spawnFailingHost(commands, (input) =>
            realSpawnFailure(input.command, { cwd: movedCheckout }),
          ),
        ),
      );
    }),
);

it.effect(
  "does not show install the Forgejo CLI on a pull request when the system refuses to start tea",
  () => {
    const commands: string[] = [];
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provideServiceEffect(ForgejoCli.ForgejoCli, ForgejoCli.make),
      );
      const summary = provider.getChangeRequestSummary;
      if (summary === undefined) return yield* Effect.die("pull request summary read missing");
      const error = yield* summary({
        cwd: "/repo",
        repository: "maria/project",
        host: "forgejo.local",
        number: 42,
      }).pipe(Effect.flip);

      assert.strictEqual(error.reason, "failed");
      assert.notStrictEqual(error.detail, INSTALL_DETAIL);
      assert.deepStrictEqual(commands, ["git", "tea"]);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fjStorage(false)),
      Effect.provideService(HttpClient.HttpClient, noHttp),
      Effect.provide(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              commands.push(input.command);
              if (input.command === "git")
                return Effect.succeed(
                  TestSourceControlHost.processOutput(`origin\t${REMOTE_URL} (fetch)`),
                );
              return Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  argumentCount: input.args.length,
                  cause: PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "spawn",
                    syscall: `spawn ${input.command}`,
                    pathOrDescriptor: `${input.command} ${input.args.join(" ")}`,
                    cause: Object.assign(new Error(`spawn ${input.command} EMFILE`), {
                      code: "EMFILE",
                    }),
                  }),
                }),
              );
            },
          },
        }),
      ),
    );
  },
);
