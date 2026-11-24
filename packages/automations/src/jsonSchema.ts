import * as Schema from "effect/Schema";

import { AUTOMATION_SCHEMA_URL, AutomationFile } from "./format.ts";

/** The automation file's JSON Schema (draft 2020-12), closed everywhere so editors flag unknown keys. */
export function buildAutomationJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(AutomationFile, { onExcessProperty: "error" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: AUTOMATION_SCHEMA_URL,
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  };
}

/** Also committed as schema/automation-v1.json (drift-tested). */
export const automationJsonSchema: Record<string, unknown> = buildAutomationJsonSchema();
