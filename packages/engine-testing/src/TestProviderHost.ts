// ), packages/provider-testing/src/TestProviderHost.ts @ ab3a3cd1.
/**
 * A `ProviderHost.ProviderHost` for driver and adapter tests. Its directories live in a
 * scoped temp directory, settings are fixed, and background work always runs
 * unless the test says otherwise.
 *
 * @module provider-testing/TestProviderHost
 */
import { type ChatAttachment, DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@caveman-app/protocol";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface TestProviderHostOptions {
  /** Session fallback cwd. Defaults to the test process cwd. */
  readonly cwd?: string;
  /** A Cloud computer's Caveman credits key, as the runtime holds it (ProviderHost.credits). Defaults to none. */
  readonly credits?: ProviderHost.CreditsCredentialSource;
  /** A Cloud computer's key connections (ProviderHost.connections). Defaults to none. */
  readonly connections?: ProviderHost.ConnectionKeySource;
  /** Initial settings. A test changes them through `TestProviderHostSettings`. */
  readonly settings?: ServerSettings;
  /** Whether background work such as status probes may run. Defaults to `true`. */
  readonly runBackgroundWork?: boolean;
  /**
   * The attachments directory the host reports and resolves against. Defaults to one under the scoped temp dir.
   * An integration test that writes attachments through the runtime passes the runtime's own, so the engine reads
   * the files the runtime wrote (as production shares one directory).
   */
  readonly attachmentsDir?: string;
  /**
   * How a stored attachment's absolute path is found. Defaults to the flat-by-id layout adapter tests write by
   * hand; an integration test passes the production resolver so ids with an extension suffix read `{id}.ext`.
   */
  readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | null;
}

/** Lets a test change the settings its `layer` reports. */
export class TestProviderHostSettings extends Context.Service<
  TestProviderHostSettings,
  { readonly set: (settings: ServerSettings) => Effect.Effect<void> }
>()("@caveman-app/engine-testing/TestProviderHost/TestProviderHostSettings") {}

export const layer = (
  options: TestProviderHostOptions = {},
): Layer.Layer<
  ProviderHost.ProviderHost | TestProviderHostSettings,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-provider-host-" })
        .pipe(Effect.orDie);
      const stateDir = path.join(baseDir, "userdata");
      const providerStatusCacheDir = path.join(baseDir, "caches");
      const attachmentsDir = options.attachmentsDir ?? path.join(stateDir, "attachments");
      for (const directory of [stateDir, providerStatusCacheDir, attachmentsDir]) {
        yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
      }
      const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
      const credentials = new Map<string, Uint8Array>();
      const host = ProviderHost.ProviderHost.of({
        ...(options.credits === undefined ? {} : { credits: options.credits }),
        ...(options.connections === undefined ? {} : { connections: options.connections }),
        paths: {
          cwd: options.cwd ?? process.cwd(),
          baseDir,
          stateDir,
          providerStatusCacheDir,
          attachmentsDir,
        },
        settings: {
          get: Ref.get(settings),
          withSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
        },
        shouldRunBackgroundWork: () => Effect.succeed(options.runBackgroundWork ?? true),
        // Tests store attachments flat under the attachments directory by id, unless the test passes the runtime's
        // own resolver (an integration test whose attachments the runtime wrote with an extension).
        resolveAttachmentPath: options.resolveAttachmentPath ?? ((attachment) => path.join(attachmentsDir, attachment.id)),
        // Credentials live in memory for the layer's lifetime.
        credentials: (namespace, bindingId) =>
          Effect.sync(() => {
            const key = `${namespace}:${bindingId}`;
            return {
              binding: { owner: "t3" as const, key },
              get: Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
              set: (value: Uint8Array) => Effect.sync(() => void credentials.set(key, value)),
              remove: Effect.sync(() => void credentials.delete(key)),
            };
          }),
      });
      return Context.make(ProviderHost.ProviderHost, host).pipe(
        Context.add(TestProviderHostSettings, {
          set: (next) => Ref.set(settings, next),
        }),
      );
    }),
  );
