// ), apps/server/src/secrets/settingsSecretValue.ts @ 84537c4dd9 (#27756).
import { secretReferencesInSettings, withSettingsSecrets } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import type { SecretResolver } from "./SecretResolver.ts";

/**
 * Replaces each reference in the slots `schema` declares as `SettingsSecretValue` with the secret
 * it names, read in one batch. An unreadable secret comes back as `""`, so it behaves as unset.
 */
export const resolveSettingsSecrets = Effect.fn("SettingsSecrets.resolve")(function* <
  Settings extends Readonly<Record<string, unknown>>,
>(resolver: SecretResolver["Service"], schema: Schema.Top, settings: Settings) {
  const pending = secretReferencesInSettings(schema, settings);
  if (pending.length === 0) return settings;
  const values = yield* resolver.read(pending.map(({ reference }) => reference));
  return withSettingsSecrets(
    settings,
    pending.map((slot, index) => ({ ...slot, value: values[index] ?? "" })),
  );
});
