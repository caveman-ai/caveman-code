// Writes schema/automation-v1.json from the Effect Schema. `node scripts/json-schema.ts --write`
// rewrites it; test/schema.test.ts fails when it is stale.
import { writeFileSync } from "node:fs";

import { buildAutomationJsonSchema } from "../src/jsonSchema.ts";

export const schemaPath = new URL("../schema/automation-v1.json", import.meta.url);
export const buildSchemaText = (): string => `${JSON.stringify(buildAutomationJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--write")) writeFileSync(schemaPath, buildSchemaText());
