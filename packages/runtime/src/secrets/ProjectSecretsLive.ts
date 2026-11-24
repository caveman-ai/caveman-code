/**
 * The runtime's ProjectSecrets, on its secret store (`<stateDir>/secrets`,
 * 0600 files) like the credential broker's grants, keyed by repository (see
 * `keyOf`). Each value is sealed with AES-256-GCM, its repository key and
 * name in the associated data, under a random key in the same store. Never
 * the OS keychain, as Codex keeps `auth.json`: a keychain item trusts only
 * the binary that made it, so every node that ran the runtime asked macOS for
 * the login password, and the read froze the runtime while it asked. An index
 * holds names, update times and the hidden flag, never a value. Values are
 * decrypted once at start into memory: the scrubber needs every one of them
 * anyway.
 *
 * Secrets an older runtime sealed under a key it kept in the keychain are
 * dropped at start, names and files: the person adds them again. An index
 * that cannot be read at start is set aside, named in a warning, and the
 * runtime starts without the secrets it named.
 *
 * A replaced or deleted value stays in the scrubber until the runtime exits:
 * processes started before the change still hold it in their env.
 *
 * A checkout's repository key is pinned the first time it is derived (by
 * the main checkout's real path, in the index); when its origin later names
 * another repository, keyOf withholds it until the person repins (M3: the
 * origin is a repo-local claim an agent can rewrite).
 *
 * Spec: docs/
 *
 * @module ProjectSecretsLive
 */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createScrubber, isHiddenSecret, repositoryKey, type Repo, type SecretEntry, type SecretInfo } from "@caveman-app/session-protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProjectSecrets, ProjectSecretsError, type SecretsChanged } from "./ProjectSecrets.ts";

const INDEX = "project-secrets-index";
const KEY = "project-secrets-key";

/** Store name of one value: fixed length, and the repository and name stay off the file system. */
export const repositorySecretKey = (repository: string, name: string) =>
  `project-secret-${createHash("sha256").update(`${repository}\0${name}`).digest("hex").slice(0, 32)}`;

interface Index {
  /** Set by an older runtime: `keychain` when it sealed the values under a key in the OS keychain (dropped at start). */
  key?: "keychain" | "store";
  /** Repository key -> name -> metadata. */
  repositories: Record<string, Record<string, { readonly updated_at: string; readonly hidden: boolean }>>;
  /** Main checkout real path -> the repository key it was pinned to at first use. */
  pins?: Record<string, string>;
}

/** What every runtime writes as the index; extra fields are kept. */
const isIndex = Schema.is(
  Schema.Struct({
    key: Schema.optionalKey(Schema.Literals(["keychain", "store"])),
    repositories: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Struct({ updated_at: Schema.String, hidden: Schema.Boolean }))),
    pins: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

/** The index `bytes` hold, or undefined when they hold none. */
const readIndex = (bytes: Uint8Array): Index | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  return isIndex(parsed) ? parsed : undefined;
};

const aad = (repository: string, name: string) => Buffer.from(`${repository}\0${name}`);

/** iv (12) | tag (16) | ciphertext. */
export const seal = (key: Uint8Array, repository: string, name: string, value: string): Uint8Array => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(repository, name));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
};

export const unseal = (key: Uint8Array, repository: string, name: string, sealed: Uint8Array): string => {
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)).setAAD(aad(repository, name));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
};

const storeError = (error: { readonly message: string }) => new ProjectSecretsError({ message: error.message });
const notARepository = (message: string) => new ProjectSecretsError({ message, reason: "not_a_repository" });

/** A git command's trimmed stdout, or undefined when it fails. */
const gitOut = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(
    () => new Promise<string | undefined>((resolve) => execFile("git", ["-C", cwd, ...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()))),
  );

/**
 * What a Repo is keyed by right now: a URL by `repositoryKey`; a path by its
 * checkout's origin, else `local:` and the main checkout's real path (so its
 * worktrees share the key). `main` is that checkout, for pinning; none for a
 * URL. A path outside git fails.
 */
export const deriveKey = (repo: Repo) =>
  Effect.gen(function* () {
    if ("url" in repo) {
      const key = repositoryKey(repo.url);
      if (key === undefined) return yield* notARepository(`${repo.url} is not a repository URL`);
      return { key, main: undefined };
    }
    const top = path.isAbsolute(repo.path) ? yield* gitOut(repo.path, ["rev-parse", "--show-toplevel"]) : undefined;
    if (!top) return yield* notARepository(`${repo.path} is not a git repository`);
    const common = yield* gitOut(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const main = fs.realpathSync(common && path.basename(common) === ".git" ? path.dirname(common) : top);
    const remote = yield* gitOut(top, ["config", "--get", "remote.origin.url"]);
    return { key: (remote ? repositoryKey(remote) : undefined) ?? `local:${main}`, main };
  });

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore;

  const indexBytes = yield* store.get(INDEX).pipe(Effect.mapError(storeError));
  const read = Option.isSome(indexBytes) ? readIndex(indexBytes.value) : undefined;
  const index: Index = read ?? { repositories: {} };
  const namesOf = (repository: string) => (Object.hasOwn(index.repositories, repository) ? Object.keys(index.repositories[repository]!) : []);
  const persist = (next: Index) => store.set(INDEX, new TextEncoder().encode(JSON.stringify(next))).pipe(Effect.mapError(storeError));
  const writeIndex = Effect.suspend(() => persist(index));

  if (Option.isSome(indexBytes) && read === undefined) {
    // Torn by a crash (the store renames a write into place without syncing it) or edited by hand. The values it named
    // stay sealed beside it, so it is kept to repair rather than overwritten, and the runtime starts without them.
    const aside = `${INDEX}-unreadable-${yield* Clock.currentTimeMillis}`;
    yield* store.set(aside, indexBytes.value).pipe(Effect.mapError(storeError));
    yield* writeIndex;
    yield* Effect.logWarning("The project secrets index could not be read, so it was set aside and its secrets were dropped: add them again, or repair the file and put it back", {
      file: path.join(store.directory ?? "", `${aside}.bin`),
    });
  }

  if (index.key === "keychain") {
    const dropped = Object.entries(index.repositories).flatMap(([repository, names]) => Object.keys(names).map((name) => ({ repository, name })));
    for (const { repository, name } of dropped) yield* store.remove(repositorySecretKey(repository, name)).pipe(Effect.mapError(storeError));
    index.repositories = {};
    delete index.key;
    yield* writeIndex;
    yield* Effect.logWarning("Project secrets an older runtime sealed with a key in the OS keychain were dropped: add them again", { secrets: dropped.length });
  }
  const key = yield* store.getOrCreateRandom(KEY, 32).pipe(Effect.mapError(storeError));

  /** Repository key -> name -> value. */
  const values = new Map<string, Map<string, string>>();
  /** Values replaced or deleted since start: running processes may still hold them, so they stay scrubbed. */
  const retired: Array<SecretEntry> = [];
  // Every stored value, decrypted; one that does not open is dropped from the index.
  for (const [repository, names] of Object.entries(index.repositories)) {
    for (const name of Object.keys(names)) {
      const sealed = yield* store.get(repositorySecretKey(repository, name)).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      let value: string | undefined;
      try {
        value = Option.isSome(sealed) ? unseal(key, repository, name, sealed.value) : undefined;
      } catch {
        value = undefined;
      }
      if (value === undefined) {
        yield* Effect.logWarning("A project secret could not be read and was dropped", { repository, name });
        delete names[name];
        continue;
      }
      if (!values.has(repository)) values.set(repository, new Map());
      values.get(repository)!.set(name, value);
    }
  }

  const all = (): Array<SecretEntry> => [
    ...[...values.values()].flatMap((names) => [...names].map(([name, value]) => ({ name, value }))),
    ...retired,
  ];
  let scrubber = createScrubber(all());
  const lane = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<SecretsChanged>();
  const changeOf = (repository: string): SecretsChanged => ({ repository, names: namesOf(repository).sort() });

  const infos = (repository: string, only?: ReadonlyArray<string>): Array<SecretInfo> =>
    Object.entries(Object.hasOwn(index.repositories, repository) ? index.repositories[repository]! : {})
      .filter(([name]) => only === undefined || only.includes(name))
      .map(([name, meta]) => ({ name, repository, updated_at: meta.updated_at, hidden: meta.hidden }))
      .sort((a, b) => a.name.localeCompare(b.name));

  /** Makes `taken` resolvable, keeping each value it replaces scrubbed, and rebuilds the scrubber in the same step. */
  const take = (repository: string, taken: ReadonlyArray<SecretEntry>) => {
    if (!values.has(repository)) values.set(repository, new Map());
    const held = values.get(repository)!;
    for (const { name, value } of taken) {
      const before = held.get(name);
      if (before !== undefined && before !== value) retired.push({ name, value: before });
      held.set(name, value);
    }
    scrubber = createScrubber(all());
  };

  /** Writes the index, rebuilds the scrubber and tells subscribers; inside the lane. */
  const commit = (repository: string) =>
    writeIndex.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          scrubber = createScrubber(all());
          return PubSub.publish(changes, changeOf(repository));
        }),
      ),
    );

  /** Pins `main` to `repository` once the index that says so is written: a pin the disk refused is not one a restart reads. */
  const pin = (main: string, repository: string) => {
    const pins = { ...index.pins, [main]: repository };
    return persist({ ...index, pins }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          index.pins = pins;
        }),
      ),
    );
  };

  const keyOf = (repo: Repo) =>
    Effect.gen(function* () {
      const { key: derived, main } = yield* deriveKey(repo);
      if (main === undefined) return derived;
      // First use pins the checkout (a racing first use may win the pin; then it is compared like any other).
      if (index.pins?.[main] === undefined) {
        yield* lane.withPermits(1)(
          Effect.suspend(() => (index.pins?.[main] !== undefined ? Effect.void : pin(main, derived))),
        );
      }
      const pinned = index.pins![main]!;
      if (pinned === derived) return derived;
      return yield* new ProjectSecretsError({
        message: `${main}: origin changed from ${pinned} to ${derived}; secrets withheld. Accept it in Settings.`,
        reason: "origin_changed",
      });
    });

  return ProjectSecrets.of({
    keyOf,
    repin: (repo) =>
      Effect.gen(function* () {
        const { key: derived, main } = yield* deriveKey(repo);
        if (main === undefined) return derived;
        yield* lane.withPermits(1)(Effect.suspend(() => pin(main, derived)));
        yield* Effect.logInfo("A checkout's repository key was repinned", { checkout: main, repository: derived });
        return derived;
      }),
    list: (repository) => Effect.sync(() => infos(repository)),
    set: (repository, entries) =>
      lane.withPermits(1)(
        Effect.gen(function* () {
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          const stored = new Set(namesOf(repository));
          const meta: Index["repositories"][string] = {};
          const added: Array<SecretEntry> = [];
          // Memory changes as the store does, so a write that fails partway leaves resolve and list saying what a
          // restart reads, all of it scrubbed: a stored name's new value once its file is written, a new name once the
          // index names it.
          for (const { name, value } of entries) {
            const plain = Redacted.value(value);
            yield* store.set(repositorySecretKey(repository, name), seal(key, repository, name, plain)).pipe(Effect.mapError(storeError));
            meta[name] = { updated_at: at, hidden: isHiddenSecret(name, plain) };
            if (stored.has(name)) take(repository, [{ name, value: plain }]);
            else added.push({ name, value: plain });
          }
          const names = { ...(Object.hasOwn(index.repositories, repository) ? index.repositories[repository] : {}), ...meta };
          yield* persist({ ...index, repositories: { ...index.repositories, [repository]: names } });
          index.repositories[repository] = names;
          take(repository, added);
          yield* PubSub.publish(changes, changeOf(repository));
          return infos(repository, entries.map((e) => e.name));
        }),
      ),
    remove: (repository, name) =>
      lane.withPermits(1)(
        Effect.gen(function* () {
          if (!namesOf(repository).includes(name)) return;
          yield* store.remove(repositorySecretKey(repository, name)).pipe(Effect.mapError(storeError));
          delete index.repositories[repository]![name];
          const before = values.get(repository)?.get(name);
          if (before !== undefined) retired.push({ name, value: before });
          values.get(repository)?.delete(name);
          if (namesOf(repository).length === 0) {
            delete index.repositories[repository];
            values.delete(repository);
          }
          yield* commit(repository);
        }),
      ),
    resolve: (repository) => Effect.sync(() => [...(values.get(repository) ?? [])].map(([name, value]) => ({ name, value }))),
    has: (repository) => Effect.sync(() => namesOf(repository).length > 0),
    scrubber: Effect.sync(() => scrubber),
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(ProjectSecrets, make);
