// Settings > Secret providers (secret_provider.*, secret_slot.set): the secret managers this runtime reads from
// (1Password), and the credential settings that point at them instead of holding a pasted value: engine accounts'
// environment variables and source control host tokens.
//
// What lives where: providers and references in the runtime's settings file (`secretProviders`, an environment
// variable's `secret`, a host token's reference); a service account's token sealed in the secret store
// (SecretProviderTokens); values only in memory, read at use time by SecretResolver, which also puts each into the
// egress scrub. Nothing here returns, logs or journals a value or a token: replies carry names, references and
// one-sentence reasons only.
//
// Claude Agent's settings are never offered and never written: it runs on the person's own login (CLAUDE.md).
//
// On a Cloud computer whose person's credentials stay outside it (insideComputer.ts) no secret manager is connected
// and no setting is pointed at one: a service account's token would be kept there, and every value it reads would
// be read into a computer whose agent is root. What an earlier run connected can still be listed, checked and
// removed, and a setting taken off it.
import {
  isSecretReference,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ProviderInstanceConfig,
  type SecretReference,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@caveman-app/protocol";
import type {
  Params,
  SecretProviderInfo,
  SecretSlot,
  SecretSlotTarget,
} from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ONE_PASSWORD_KIND } from "../secrets/OnePasswordSecretProvider.ts";
import { secretReadFailureMessage } from "../secrets/secretProviderDriver.ts";
import { SecretProviderTokens } from "../secrets/SecretProviderTokens.ts";
import { SecretResolver } from "../secrets/SecretResolver.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { sourceControlHostSecretReferences } from "../sourceControl/sourceControlHostSecrets.ts";
import { OUTSIDE_SECRET_MANAGER } from "../cloudLink/credentialRule.ts";
import { type Handler, ProtocolError } from "./handlers.ts";
import { HARNESSES, harnessEngineOf } from "./harnesses.ts";
import { makeInsideComputer } from "./insideComputer.ts";

type SecretProviderMethod =
  | "secret_provider.list"
  | "secret_provider.save"
  | "secret_provider.remove"
  | "secret_provider.check"
  | "secret_provider.refresh"
  | "secret_slot.set";

/** Claude Agent runs on the person's own `claude` login; none of its settings take a reference. */
const CLAUDE_AGENT = "claudeAgent";
const DRIVER_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  caveman: "Caveman engine",
};
/** Source control credentials that take a reference: GitHub's per-host token and Bitbucket's two tokens. */
const HOST_FIELDS: ReadonlyArray<{
  readonly host: string;
  readonly field: string;
  readonly label: string;
  readonly perServerHost: boolean;
}> = [
  { host: "github", field: "tokens", label: "GitHub token", perServerHost: true },
  {
    host: "bitbucket",
    field: "accessToken",
    label: "Bitbucket access token",
    perServerHost: false,
  },
  { host: "bitbucket", field: "apiToken", label: "Bitbucket API token", perServerHost: false },
];

const fail = (
  reason: "invalid_params" | "not_found" | "engine_unavailable" | "internal",
  message: string,
) => Effect.fail(new ProtocolError({ reason, message }));

/** A provider id from its name: stable and readable in the settings file, so re-adding one under the same name restores its references. */
export const secretProviderIdFromName = (name: string): string | undefined => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrUndefined(Schema.decodeOption(SecretProviderId)(slug));
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const makeSecretProviderHandlers = Effect.gen(function* () {
  const settingsService = yield* Effect.serviceOption(ServerSettingsService.ServerSettingsService);
  const resolver = yield* Effect.serviceOption(SecretResolver);
  const tokens = yield* Effect.serviceOption(SecretProviderTokens);
  const mutator = yield* Effect.serviceOption(
    ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  );
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  /** Whether a secret manager may be connected, or a setting pointed at one, on this computer. */
  const insideComputer = yield* makeInsideComputer;

  const need = <A>(service: Option.Option<A>): Effect.Effect<A, ProtocolError> =>
    Option.isSome(service)
      ? Effect.succeed(service.value)
      : fail(
          "engine_unavailable",
          "This runtime has no settings or secret store for secret providers.",
        );

  const settingsNow = Effect.gen(function* () {
    const service = yield* need(settingsService);
    return yield* service.getSettings.pipe(
      Effect.mapError(
        () => new ProtocolError({ reason: "internal", message: "Could not read settings." }),
      ),
    );
  });

  const update = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const service = yield* need(settingsService);
      yield* service
        .updateSettings(patch)
        .pipe(
          Effect.mapError(
            () => new ProtocolError({ reason: "internal", message: "Could not save settings." }),
          ),
        );
    });

  const problemOf = (reference: SecretReference, label: string) =>
    Option.isNone(resolver)
      ? Effect.succeed(undefined)
      : Effect.map(resolver.value.explain(reference), (failure) =>
          failure === undefined ? undefined : secretReadFailureMessage(failure, label),
        );

  const providerLabel = (settings: ServerSettings, id: string) =>
    Object.hasOwn(settings.secretProviders, id)
      ? settings.secretProviders[id as SecretProviderId]!.label
      : id;

  const providerInfos = (settings: ServerSettings) =>
    Effect.forEach(Object.entries(settings.secretProviders), ([id, entry]) =>
      Effect.gen(function* () {
        const config = isRecord(entry.config) ? entry.config : {};
        const serviceAccount = entry.kind === ONE_PASSWORD_KIND && config.serviceAccount === true;
        const info: SecretProviderInfo = {
          id,
          kind: entry.kind,
          label: entry.label,
          supported: entry.kind === ONE_PASSWORD_KIND,
          ...(typeof config.account === "string" ? { account: config.account } : {}),
          ...(serviceAccount
            ? {
                service_account: true,
                has_token: Option.isSome(tokens) ? yield* tokens.value.has(id) : false,
              }
            : {}),
        };
        return info;
      }),
    );

  const instanceLabel = (instanceId: string, entry: ProviderInstanceConfig) => {
    const engine = harnessEngineOf(instanceId) ?? entry.driver;
    const base =
      entry.displayName ??
      HARNESSES.get(engine)?.client.label ??
      DRIVER_LABELS[entry.driver] ??
      entry.driver;
    return instanceId === engine || instanceId === entry.driver ? base : `${base} (${instanceId})`;
  };

  /** Every credential setting that can point at a secret manager, with where it reads from now. */
  const slots = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const out: Array<SecretSlot> = [];
      const withRef = (
        slot: Omit<SecretSlot, "ref" | "problem">,
        ref: SecretReference | undefined,
      ) =>
        Effect.gen(function* () {
          if (ref === undefined) return out.push(slot);
          const problem = yield* problemOf(ref, providerLabel(settings, ref.provider));
          return out.push({
            ...slot,
            ref: { provider: ref.provider, reference: ref.reference },
            ...(problem === undefined ? {} : { problem }),
          });
        });
      for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
        if (entry.driver === CLAUDE_AGENT) continue;
        const harness = HARNESSES.get(harnessEngineOf(instanceId) ?? entry.driver);
        const environment = entry.environment ?? [];
        const names = new Set(
          environment.filter((v) => v.sensitive || typeof v.value !== "string").map((v) => v.name),
        );
        if (harness?.keyEnv !== undefined && entry.enabled !== false) names.add(harness.keyEnv);
        for (const name of names) {
          const variable = environment.find((v) => v.name === name);
          const ref =
            variable !== undefined && typeof variable.value !== "string"
              ? variable.value
              : undefined;
          yield* withRef(
            {
              target: { kind: "engine_env", instance_id: instanceId, name },
              label: `${instanceLabel(instanceId, entry)} · ${name}`,
              group: "engine",
              has_value:
                variable !== undefined &&
                typeof variable.value === "string" &&
                (variable.value !== "" || variable.valueRedacted === true),
            },
            ref,
          );
        }
      }
      for (const { host, field, label, perServerHost } of HOST_FIELDS) {
        const fields = isRecord(settings.sourceControlHosts[host])
          ? settings.sourceControlHosts[host]
          : {};
        const refs = sourceControlHostSecretReferences(settings.sourceControlHosts, host).filter(
          (r) => r.field === field,
        );
        if (perServerHost) {
          const values = isRecord(fields[field]) ? fields[field] : {};
          const serverHosts = new Set([
            "github.com",
            ...Object.keys(values).map((h) => h.trim().toLowerCase()),
          ]);
          for (const serverHost of serverHosts) {
            const value = Object.entries(values).find(
              ([h]) => h.trim().toLowerCase() === serverHost,
            )?.[1];
            yield* withRef(
              {
                target: { kind: "source_control", host, field, server_host: serverHost },
                label: `${label} · ${serverHost}`,
                group: "source_control",
                has_value: typeof value === "string" && value.trim() !== "",
              },
              refs.find((r) => r.key?.trim().toLowerCase() === serverHost)?.reference,
            );
          }
        } else {
          const value = fields[field];
          yield* withRef(
            {
              target: { kind: "source_control", host, field },
              label,
              group: "source_control",
              has_value: typeof value === "string" && value.trim() !== "",
            },
            refs.find((r) => r.key === undefined)?.reference,
          );
        }
      }
      return out;
    });

  const view = Effect.gen(function* () {
    const settings = yield* settingsNow;
    return { providers: yield* providerInfos(settings), slots: yield* slots(settings) };
  });

  /** A reference a client sent: a provider that exists here, in syntax it reads. */
  const checkedReference = (
    settings: ServerSettings,
    ref: { readonly provider: string; readonly reference: string },
  ) =>
    Effect.gen(function* () {
      const reference = {
        provider: ref.provider.trim(),
        reference: ref.reference.trim(),
      } as SecretReference;
      if (!isSecretReference(reference))
        return yield* fail("invalid_params", "That is not a secret reference.");
      if (!Object.hasOwn(settings.secretProviders, reference.provider))
        return yield* fail("not_found", `No secret provider named ${reference.provider}.`);
      const accepted = Option.isSome(resolver)
        ? yield* resolver.value.accepts(reference)
        : undefined;
      if (accepted === undefined)
        return yield* fail(
          "invalid_params",
          `${providerLabel(settings, reference.provider)} is not a kind this runtime reads.`,
        );
      if (!accepted)
        return yield* fail(
          "invalid_params",
          "Use a 1Password reference like op://vault/item/field.",
        );
      return reference;
    });

  /** Rebuilds engines whose references changed and refreshes the provider list. */
  const reloadEngines = Effect.gen(function* () {
    if (Option.isSome(mutator)) yield* mutator.value.reloadSecrets();
    if (Option.isSome(providers)) yield* providers.value.refresh().pipe(Effect.ignore);
  });

  const setSlot = (p: Params<"secret_slot.set">) =>
    Effect.gen(function* () {
      const settings = yield* settingsNow;
      const ref = p.ref === null ? null : yield* checkedReference(settings, p.ref);
      const target: SecretSlotTarget = p.target;
      if (target.kind === "engine_env") {
        const instanceId = ProviderInstanceId.make(target.instance_id);
        const entry = Object.hasOwn(settings.providerInstances, instanceId)
          ? settings.providerInstances[instanceId]
          : undefined;
        if (entry === undefined)
          return yield* fail("not_found", `No engine account ${target.instance_id}.`);
        if (entry.driver === CLAUDE_AGENT)
          return yield* fail("invalid_params", secretReadFailureMessage("refused"));
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.name))
          return yield* fail("invalid_params", "That is not an environment variable name.");
        const environment = (entry.environment ?? []).filter((v) => v.name !== target.name);
        const next =
          ref === null
            ? environment
            : [...environment, { name: target.name, value: ref, sensitive: true }];
        const service = yield* need(settingsService);
        yield* service
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: { ...entry, environment: next },
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProtocolError({
                  reason: "internal",
                  message: "Could not save the engine account.",
                }),
            ),
          );
        if (ref !== null && Option.isSome(resolver)) yield* resolver.value.invalidate([ref]);
        return yield* view;
      }
      const spec = HOST_FIELDS.find((f) => f.host === target.host && f.field === target.field);
      if (spec === undefined)
        return yield* fail(
          "invalid_params",
          `${target.host} ${target.field} does not take a secret reference.`,
        );
      const current = isRecord(settings.sourceControlHosts[target.host])
        ? settings.sourceControlHosts[target.host]!
        : {};
      let value: unknown;
      if (spec.perServerHost) {
        const serverHost = target.server_host?.trim().toLowerCase();
        if (!serverHost || !/^[a-z0-9.-]+(?::\d+)?$/.test(serverHost))
          return yield* fail("invalid_params", "Name the server host, such as github.com.");
        const values = Object.fromEntries(
          Object.entries(
            isRecord(current[target.field])
              ? (current[target.field] as Record<string, unknown>)
              : {},
          ).filter(([h]) => h.trim().toLowerCase() !== serverHost),
        );
        value = ref === null ? values : { ...values, [serverHost]: ref };
      } else {
        value = ref === null ? "" : ref;
      }
      yield* update({ sourceControlHosts: { [target.host]: { [target.field]: value } } });
      if (ref !== null && Option.isSome(resolver)) yield* resolver.value.invalidate([ref]);
      return yield* view;
    });

  const save = (p: Params<"secret_provider.save">) =>
    Effect.gen(function* () {
      const settings = yield* settingsNow;
      const label = p.label.trim();
      const id = p.id === undefined ? secretProviderIdFromName(label) : p.id;
      if (id === undefined)
        return yield* fail("invalid_params", "The name needs at least one letter or digit.");
      const exists = Object.hasOwn(settings.secretProviders, id);
      if (p.id === undefined && exists)
        return yield* fail("invalid_params", "A secret provider with this name exists.");
      if (p.id !== undefined && !exists)
        return yield* fail("not_found", `No secret provider ${p.id}.`);
      const serviceAccount = p.service_account === true;
      const account = p.account?.trim() || undefined;
      if (serviceAccount === (account !== undefined))
        return yield* fail(
          "invalid_params",
          "Enter the 1Password account, or use a service account.",
        );
      if (
        serviceAccount &&
        p.service_account_token === undefined &&
        !(Option.isSome(tokens) && (yield* tokens.value.has(id)))
      ) {
        return yield* fail("invalid_params", "Paste the service account's token.");
      }
      const config = serviceAccount ? { serviceAccount: true } : { account };
      const service = yield* need(settingsService);
      yield* service
        .updateSettings({
          secretProviders: {
            [id]: { kind: SecretProviderKind.make(ONE_PASSWORD_KIND), label, config },
          },
        } as ServerSettingsPatch)
        .pipe(
          Effect.mapError(
            (error) =>
              new ProtocolError({
                reason: "invalid_params",
                // A rejected config says which field; it never holds a credential.
                message:
                  error.operation === "write-secret-provider"
                    ? "1Password account must be a shorthand, sign-in address, or ID with no spaces."
                    : "Could not save the secret provider.",
              }),
          ),
        );
      if (p.service_account_token !== undefined) {
        const store = yield* need(tokens);
        yield* store
          .set(id, Redacted.make(p.service_account_token.trim()))
          .pipe(
            Effect.mapError((e) => new ProtocolError({ reason: "internal", message: e.message })),
          );
      } else if (!serviceAccount && Option.isSome(tokens)) {
        yield* tokens.value.remove(id);
      }
      // Another account or token reads every reference again.
      if (Option.isSome(resolver)) yield* resolver.value.invalidate();
      if (exists) yield* reloadEngines;
      return yield* view;
    });

  const remove = (p: Params<"secret_provider.remove">) =>
    Effect.gen(function* () {
      const settings = yield* settingsNow;
      if (!Object.hasOwn(settings.secretProviders, p.id)) return yield* view;
      yield* update({ secretProviders: { [p.id]: null } } as ServerSettingsPatch);
      if (Option.isSome(tokens)) yield* tokens.value.remove(p.id);
      if (Option.isSome(resolver)) yield* resolver.value.invalidate();
      return yield* view;
    });

  const check = (p: Params<"secret_provider.check">) =>
    Effect.gen(function* () {
      const settings = yield* settingsNow;
      if (!Object.hasOwn(settings.secretProviders, p.id))
        return yield* fail("not_found", `No secret provider ${p.id}.`);
      const service = yield* need(resolver);
      const label = providerLabel(settings, p.id);
      if (p.reference === undefined) {
        const outcome = yield* service.check(p.id);
        return outcome.failure === undefined
          ? { ok: true, message: `${label} is signed in.` }
          : { ok: false, message: secretReadFailureMessage(outcome.failure, label) };
      }
      const reference = yield* checkedReference(settings, {
        provider: p.id,
        reference: p.reference,
      });
      // A check reads afresh, so a fixed vault shows at once; the value stays in the resolver.
      yield* service.invalidate([reference]);
      const [value] = yield* service.read([reference]);
      if (value !== undefined) return { ok: true, message: `Read ${reference.reference}.` };
      const failure = yield* service.explain(reference);
      return { ok: false, message: secretReadFailureMessage(failure ?? "failed", label) };
    });

  const handlers: { readonly [M in SecretProviderMethod]: Handler<M> } = {
    "secret_provider.list": () => view,
    "secret_provider.save": (p) =>
      insideComputer(OUTSIDE_SECRET_MANAGER).pipe(Effect.andThen(save(p))),
    "secret_provider.remove": remove,
    "secret_provider.check": check,
    "secret_provider.refresh": () =>
      Effect.gen(function* () {
        if (Option.isSome(resolver)) yield* resolver.value.invalidate();
        yield* reloadEngines;
        return yield* view;
      }),
    // Taking a setting off a secret manager (`ref: null`) brings nothing in: that stays.
    "secret_slot.set": (p) =>
      p.ref === null
        ? setSlot(p)
        : insideComputer(OUTSIDE_SECRET_MANAGER).pipe(Effect.andThen(setSlot(p))),
  };

  /** engine.account.add's key_ref: the environment variable a harness account reads its key from. */
  const keyRefVariable = (
    keyEnv: string,
    ref: { readonly provider: string; readonly reference: string },
  ) =>
    Effect.gen(function* () {
      const reference = yield* checkedReference(yield* settingsNow, ref);
      return { name: keyEnv, value: reference, sensitive: true } as const;
    });

  return { handlers, keyRefVariable };
});
