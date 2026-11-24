// Builds schema/session-protocol.v1.json from the Effect schemas.
// `node scripts/json-schema.ts --write` rewrites the committed file;
// test/protocol.test.ts fails when it is stale.
import { writeFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import {
  ErrorCodes,
  Methods,
  Notifications,
  RpcFailure,
  RpcNotification,
  RpcRequest,
  RpcSuccess,
} from "../src/protocol.ts";

export const schemaPath = new URL("../schema/session-protocol.v1.json", import.meta.url);

export const buildJsonSchema = (): string => {
  const defs: Record<string, unknown> = {};
  const toJson = (schema: Schema.Top) => {
    const doc = Schema.toJsonSchemaDocument(schema);
    for (const [name, def] of Object.entries(doc.definitions)) {
      if (name in defs && JSON.stringify(defs[name]) !== JSON.stringify(def)) {
        throw new Error(`two different schemas share the identifier ${name}`);
      }
      defs[name] = def;
    }
    return doc.schema;
  };
  const mapValues = <T>(record: Record<string, T>, f: (value: T) => unknown) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]));

  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Caveman Session Protocol v1",
    description: "Generated from @caveman-app/session-protocol. Do not edit; run `pnpm schema`.",
    envelopes: mapValues({ RpcRequest, RpcSuccess, RpcFailure, RpcNotification }, toJson),
    error_codes: ErrorCodes,
    methods: mapValues(Methods, (method) => ({
      params: toJson(method.params),
      result: toJson(method.result),
    })),
    notifications: mapValues(Notifications, toJson),
    $defs: {} as Record<string, unknown>,
  };
  document.$defs = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(document, null, 2)}\n`;
};

if (process.argv.includes("--write")) {
  writeFileSync(schemaPath, buildJsonSchema());
}
