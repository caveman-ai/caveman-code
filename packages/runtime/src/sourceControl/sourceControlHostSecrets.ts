// ), apps/server/src/sourceControl/sourceControlHostSecrets.ts @ ab3a3cd1.
// Ports upstream 81899ce04c (#27746) and 84537c4dd9 (#27756): a secret field may hold a secret
// provider reference, which is stored as written and read only when a host needs the credential.
/**
 * Which source control host settings fields hold secrets, read from each built-in host's client
 * definition. `serverSettings` keeps those values in the secret store and redacts them for
 * clients, the same way for every host.
 *
 * A secret field holds a string, or a string per server host such as GitHub's `tokens`.
 *
 * @module sourceControl/sourceControlHostSecrets
 */
import {
  isSecretReference,
  secretReferencesInSettings,
  secretSettingsFields,
  type SecretReference,
  type ServerSettings,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as AzureDevOps from "@caveman-app/source-control-azure-devops/client/definition";
import * as Bitbucket from "@caveman-app/source-control-bitbucket/client/definition";
import type { SourceControlClientDefinition } from "@caveman-app/source-control-core/client/definition";
import * as Forgejo from "@caveman-app/source-control-forgejo/client/definition";
import * as GitHub from "@caveman-app/source-control-github/client/definition";
import * as GitLab from "@caveman-app/source-control-gitlab/client/definition";

import type { SecretResolver } from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";

const definitions: ReadonlyArray<SourceControlClientDefinition> = [
  GitHub.definition,
  GitLab.definition,
  AzureDevOps.definition,
  Bitbucket.definition,
  Forgejo.definition,
];

/** Secret field names per host kind; a host with none is absent. */
export const SOURCE_CONTROL_HOST_SECRET_FIELDS: ReadonlyMap<
  string,
  ReadonlyArray<string>
> = new Map(
  definitions.flatMap((definition) => {
    const fields = definition.settings ? secretSettingsFields(definition.settings) : [];
    return fields.length > 0 ? [[definition.kind, fields] as const] : [];
  }),
);

/** One stored secret: a host's field, and the server host it is for when the field is per host. */
export interface SourceControlHostSecretSlot {
  readonly kind: string;
  readonly field: string;
  readonly serverHost: string | null;
}

/** The secret store entry for one slot; names stay stable across releases. */
export function sourceControlHostSecretName(slot: SourceControlHostSecretSlot): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return slot.serverHost === null
    ? `source-control-${encode(slot.kind)}-${encode(slot.field)}`
    : `source-control-${encode(slot.kind)}-${encode(slot.field)}-${encode(slot.serverHost.trim().toLowerCase())}`;
}

/** The string values a secret field holds, keyed by server host, or `null` for a plain string. */
export function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (typeof value === "string") return [[null, value]];
  if (isSecretReference(value)) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
  );
}

/** A secret field's value rebuilt from per-slot values, in the shape it was read from. */
export function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (typeof original === "string") return values[0]?.[1] ?? "";
  if (isSecretReference(original)) return original;
  const sources =
    original !== null && typeof original === "object" && !Array.isArray(original)
      ? Object.entries(original).flatMap(([serverHost, entry]) =>
          isSecretReference(entry) ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
        )
      : [];
  return Object.fromEntries([
    ...sources,
    ...values.map(([serverHost, value]) => [serverHost ?? "", value] as const),
  ]);
}

type SourceControlHostsSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const hostSettingsSchemas = new Map(
  definitions.flatMap((definition) =>
    definition.settings ? [[definition.kind as string, definition.settings] as const] : [],
  ),
);

/** Every secret provider reference held in any host kind's credential fields. */
export function collectSourceControlHostSecretReferences(
  hosts: SourceControlHostsSettings,
): ReadonlyArray<SecretReference> {
  return [...hostSettingsSchemas].flatMap(([kind, schema]) =>
    secretReferencesInSettings(schema, hosts[kind]).map(({ reference }) => reference),
  );
}

/** Each reference slot of one host kind: the field, the server host for a per-host field, and the reference. */
export function sourceControlHostSecretReferences(
  hosts: SourceControlHostsSettings,
  kind: string,
): ReadonlyArray<{
  readonly field: string;
  readonly key: string | undefined;
  readonly reference: SecretReference;
}> {
  const schema = hostSettingsSchemas.get(kind);
  return schema === undefined ? [] : secretReferencesInSettings(schema, hosts[kind]);
}

/** Replaces each secret provider reference in one host kind's credential fields with the secret it names. */
export const resolveSourceControlHostSecrets = Effect.fn("SourceControlHost.resolveSecrets")(
  function* (resolver: SecretResolver["Service"], hosts: SourceControlHostsSettings, kind: string) {
    const schema = hostSettingsSchemas.get(kind);
    const fields = hosts[kind];
    if (schema === undefined || fields === undefined) return hosts;
    const resolved = yield* resolveSettingsSecrets(resolver, schema, fields);
    return resolved === fields ? hosts : { ...hosts, [kind]: resolved };
  },
);

/** Settings that cannot be read clear every cached secret, so a refresh never keeps a stale one. */
export const invalidateSettingsSecrets = Effect.fn("SettingsSecrets.invalidate")(function* <E>(
  resolver: SecretResolver["Service"],
  settings: Effect.Effect<Pick<ServerSettings, "sourceControlHosts">, E>,
) {
  const references = yield* settings.pipe(
    Effect.map((current) => collectSourceControlHostSecretReferences(current.sourceControlHosts)),
    Effect.orElseSucceed(() => undefined),
  );
  yield* resolver.invalidate(references);
});
