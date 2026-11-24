import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { buildSchemaText, schemaPath } from "../scripts/json-schema.ts";
import { AUTOMATION_SCHEMA_URL, automationJsonSchema } from "../src/index.ts";

test("committed JSON Schema matches the Effect Schema (run `pnpm schema` to update)", () => {
  expect(readFileSync(schemaPath, "utf8")).toBe(buildSchemaText());
  expect(automationJsonSchema.$id).toBe(AUTOMATION_SCHEMA_URL);
});

test("every object in the schema is closed, so editors flag unknown keys", () => {
  const open: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === "object" && record.additionalProperties !== false && typeof record.additionalProperties !== "object") open.push(path);
    for (const [key, value] of Object.entries(record)) visit(value, `${path}/${key}`);
  };
  visit(automationJsonSchema, "#");
  expect(open).toEqual([]);
  const properties = automationJsonSchema.properties as Record<string, unknown>;
  expect(Object.keys(properties)).toEqual(["version", "host", "description", "on", "inputs", "budget", "steps", "outputs"]);
});
