// ), packages/provider-pi/src/settings.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/**
 * Caveman engine instance settings. Shared by the server driver and the
 * client settings form, so it holds only browser-safe schema code. API keys
 * are not settings: they live in the runtime's secret store (see
 * `server/credentials.ts`).
 *
 * @module provider-caveman/settings
 */
import { CustomModelSetting, makeProviderSettingsSchema } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CavemanSettings = makeProviderSettingsSchema(
  {
    // On by default: the Caveman engine is the app's own engine. It reports
    // "needs an API key" until one is stored.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Keep decoding legacy values, but compression is no longer configurable.
    optimization: Schema.Literals(["auto", "off"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("off" as const)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: [] },
);
export type CavemanSettings = typeof CavemanSettings.Type;
