// ), packages/provider-core/src/server/ProviderHost.ts @ ab3a3cd1.
/**
 * ProviderHost — what a provider package may ask of the server it runs in.
 *
 * Drivers and adapters run inside a T3 server but must not import it. The
 * server provides this one service; everything a provider needs from its
 * environment (directories, server settings, background demand, attachment
 * files) goes through it, so a provider package depends only on
 * `@caveman-app/engine-core` and its own protocol code.
 *
 * @module provider-core/server/host
 */
import type {
  BackgroundScope,
  ChatAttachment,
  ServerSettings,
  ServerSettingsError,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderCredentialError } from "./errors.ts";

export interface ProviderHostPaths {
  /** Directory the server was started in; the fallback cwd for sessions without a project. */
  readonly cwd: string;
  /** T3 home. */
  readonly baseDir: string;
  /** Server-owned state directory under the T3 home. */
  readonly stateDir: string;
  /** Scratch space for provider probes and generated helper files. */
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

/** One opaque credential blob in the server's secret store. Only the provider decodes it. */
export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

/** Runtime-owned paid Auto credential; providers never mint or persist it. */
export interface RoutingCredentialSource {
  readonly get: () => Promise<{ readonly key: string; readonly url: string } | undefined>;
  /**
   * Whether Auto can be asked here, for a model list or a status probe: where the credential is minted on demand (a
   * Cloud computer's credits key) this asks Cloud nothing, as `get` would. Absent: `get` says.
   */
  readonly offered?: () => Promise<boolean>;
  readonly rejected: (key: string, status: number, remint?: boolean) => Promise<void>;
}

/**
 * Runtime-owned Caveman credits key of a Cloud computer's person: Cloud mints it short-lived for the computer's
 * runtime, which holds it in memory only and renews it. Providers never mint or persist it. `available` and `peek` ask
 * Cloud nothing (a status probe, a model list); `get` is for a request that sends it now, so only a request mints, and
 * a long turn outlives the key it started with. `gateway` is where it runs, when its Cloud named one.
 */
export interface CreditsCredentialSource {
  /** Whether credits may pay here now (Cloud has not said otherwise): asks Cloud nothing. */
  readonly available: () => boolean;
  /** The key held now, while it still runs: asks Cloud nothing. */
  readonly peek: () => { readonly key: string; readonly gateway?: string } | undefined;
  /** The key to send now: asks Cloud only when none is held that still runs. */
  readonly get: () => Promise<{ readonly key: string; readonly gateway?: string } | undefined>;
}

/**
 * The Caveman engine's own-key slots on a Cloud computer whose person's credentials stay outside it: the person's
 * key connections, held by Cloud. `keys` answers one slot per provider with a stand-in for its key (worth nothing
 * outside the runtime's egress scrub, which sends such a request to Cloud's data plane), or undefined where the rule
 * does not apply and the stored keys count as before. `headers` name a chat's requests to the scrub, so what the
 * data plane says about one reaches its chat.
 */
export interface ConnectionKeySource {
  readonly keys: () => Promise<
    ReadonlyArray<{ readonly provider: string; readonly key: string }> | undefined
  >;
  readonly headers: (threadId: string) => Readonly<Record<string, string>>;
}

export class ProviderHost extends Context.Service<
  ProviderHost,
  {
    readonly paths: ProviderHostPaths;
    readonly routing?: RoutingCredentialSource;
    /** A Cloud computer's Caveman credits key (CreditsCredentialSource); absent off a Cloud computer. */
    readonly credits?: CreditsCredentialSource;
    /** A Cloud computer's key connections (ConnectionKeySource); absent off a Cloud computer. */
    readonly connections?: ConnectionKeySource;
    readonly settings: {
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
      /** Runs `use` on a settings snapshot that no settings write can change until it finishes. */
      readonly withSnapshot: <A, E, R>(
        use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | ServerSettingsError, R>;
      /** Every settings change after subscription, starting with the next one. */
      readonly changes: Stream.Stream<ServerSettings>;
      /** Changes buffered from the moment the scoped subscription is acquired. */
      readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    };
    /** Whether background work for `scope` should run now (client demand and host power). */
    readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    /**
     * Brings this process's environment up to date before an engine is probed: on Windows, PATH as the registry holds
     * it now, so a CLI installed since the server started is found. Absent: nothing to bring up to date.
     */
    readonly refreshEnvironment?: Effect.Effect<void>;
    /**
     * Absolute path of a stored chat attachment, or `null` when its id does not
     * resolve inside the attachments directory.
     */
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    /** The text extracted from a stored document attachment at `path`, when the runtime has read one. */
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    /** The credentials stored for `bindingId`, usually an instance id, under a provider-chosen namespace. */
    readonly credentials: (
      namespace: string,
      bindingId: string,
    ) => Effect.Effect<ProviderCredentials>;
  }
>()("@caveman-app/engine-core/server/ProviderHost") {}
